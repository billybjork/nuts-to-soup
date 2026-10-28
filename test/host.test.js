import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { frame, frameReader, lineReader, MAX_TO_CHROME } from '../tui/protocol.js';
import { connect } from '../tui/client.js';

const HOST = new URL('../tui/host.js', import.meta.url).pathname;

test('frames survive any chunking, and oversized frames are refused', () => {
  const got = [];
  const read = frameReader((m) => got.push(m));
  const msgs = [{ a: 1 }, { type: 'state', data: { é: 'ü'.repeat(1000) } }, []];
  const bytes = Buffer.concat(msgs.map(frame));
  for (let i = 0; i < bytes.length; i += 7) read(bytes.subarray(i, i + 7));
  assert.deepEqual(got, msgs);
  read(bytes); // all at once
  assert.deepEqual(got.slice(3), msgs);
  assert.equal(frame({}).readUInt32LE(), 2);

  assert.throws(() => frame({ s: 'x'.repeat(MAX_TO_CHROME) }), /1 MB/);
  const big = Buffer.alloc(4);
  big.writeUInt32LE(100);
  assert.throws(() => frameReader(() => {}, 99)(big), /over the limit/);
});

test('lines split across chunks and blank lines are skipped', () => {
  const got = [];
  const read = lineReader((m) => got.push(m), 64);
  read(Buffer.from('{"a":1}\n\n{"b"'));
  read(Buffer.from(':2}\n{"c":3}'));
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }]);
  read(Buffer.from('\n'));
  assert.deepEqual(got.at(-1), { c: 3 });
  assert.throws(() => read(Buffer.from('x'.repeat(65))), /over the limit/);
});

// Runs tui/host.js as Chrome would, with `chrome` standing in for the browser
// on its stdio.
async function host(t, sock) {
  const proc = spawn(process.execPath, [HOST], { env: { ...process.env, NTS_SOCKET: sock } });
  const chrome = { got: [], proc, send: (m) => proc.stdin.write(frame(m)) };
  const waiters = [];
  proc.stdout.on(
    'data',
    frameReader((m) => {
      chrome.got.push(m);
      waiters.splice(0).forEach((w) => w());
    }),
  );
  chrome.next = async () => {
    while (!chrome.got.length) await new Promise((r) => waiters.push(r));
    return chrome.got.shift();
  };
  proc.exited = once(proc, 'exit');
  t.after(() => proc.kill());
  // Ready once it accepts connections (a stale socket file may already exist).
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise((resolve) =>
      net
        .connect(sock)
        .once('connect', function () {
          this.destroy();
          resolve(true);
        })
        .once('error', () => resolve(false)),
    );
    if (ok) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return chrome;
}

function tempSocket(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.NTS_SOCKET = path.join(dir, 'bridge.sock');
  return process.env.NTS_SOCKET;
}

test('the host relays commands and replies, and replays state with deltas to subscribers', async (t) => {
  const sock = tempSocket(t);
  const chrome = await host(t, sock);
  assert.equal(fs.statSync(sock).mode & 0o777, 0o600);

  const early = await connect({ launch: false });
  t.after(() => early.close());
  const first = early.subscribe();
  chrome.send({ type: 'state', data: { queue: [{ alias: 'a' }], 'p:a': { pos: 1 } } });
  assert.deepEqual((await first).queue, [{ alias: 'a', addedAt: 0 }]);
  const changed = once(early, 'change');
  chrome.send({ type: 'delta', set: { 'p:a': { pos: 6, dur: 10 } }, removed: ['queue'] });
  assert.deepEqual((await changed)[0], ['p:a', 'queue']);
  assert.equal(early.state.progress.a.pos, 6);
  assert.deepEqual(early.state.queue, []);

  // A late subscriber gets the state as it is now.
  const late = await connect({ launch: false });
  t.after(() => late.close());
  const s = await late.subscribe();
  assert.equal(s.progress.a.pos, 6);
  assert.equal(late.raw.queue, undefined);

  // Each client's reply goes back to it, under its own id.
  const one = early.request({ type: 'skip' });
  const two = assert.rejects(late.request({ type: 'toggle', play: true }), /No NTS tab/);
  const [a, b] = [await chrome.next(), await chrome.next()];
  assert.deepEqual(a.msg, { type: 'skip' });
  assert.deepEqual(b.msg, { type: 'toggle', play: true });
  assert.notEqual(a.id, b.id);
  chrome.send({ id: b.id, ok: false, error: 'No NTS tab' });
  chrome.send({ id: a.id, ok: true, value: { started: true } });
  assert.deepEqual(await one, { started: true });
  await two;
});

test('a second host exits while the first is serving, and the first cleans up on disconnect', async (t) => {
  const sock = tempSocket(t);
  const chrome = await host(t, sock);
  const second = spawn(process.execPath, [HOST], { env: { ...process.env, NTS_SOCKET: sock } });
  const [code] = await once(second, 'exit');
  assert.equal(code, 0);

  const client = await connect({ launch: false });
  const pending = assert.rejects(client.request({ type: 'poll' }), /Chrome disconnected/);
  await chrome.next();
  chrome.proc.stdin.end(); // Chrome closes the port
  await pending;
  const [exit] = await chrome.proc.exited;
  assert.equal(exit, 0);
  assert.equal(fs.existsSync(sock), false);
  await assert.rejects(connect({ launch: false }), /not installed|did not connect/);
});

test('a stale socket left by a killed host is replaced', async (t) => {
  const sock = tempSocket(t);
  const stale = spawn(process.execPath, [
    '-e',
    `require('net').createServer().listen(${JSON.stringify(sock)}, () => console.log('up'))`,
  ]);
  await once(stale.stdout, 'data');
  stale.kill('SIGKILL');
  await once(stale, 'exit');
  assert.equal(fs.existsSync(sock), true);

  const chrome = await host(t, sock);
  chrome.send({ type: 'state', data: { now: { alias: 'x', pos: 3 } } });
  const client = await connect({ launch: false });
  t.after(() => client.close());
  assert.equal((await client.subscribe()).now.alias, 'x');
});
