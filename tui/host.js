// Native messaging host. Chrome starts it when the extension calls
// connectNative, and talks to it over stdio. It serves terminal clients (the
// nts CLI and TUI) on a Unix socket, relaying their commands to the extension
// and the extension's state to them.
//
// Socket protocol, one JSON object per line:
//   → {type: 'cmd', id, msg}      ← {type: 'reply', id, ok, value | error}
//   → {type: 'subscribe'}         ← {type: 'state', data}, then {type: 'delta', set, removed}…
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { frame, frameReader, line, lineReader, applyDelta, MAX_TO_CHROME } from './protocol.js';
import { socketPath, LOG } from './paths.js';

const logFile = process.env.NTS_SOCKET ? null : LOG;
function log(...args) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${args.join(' ')}\n`);
  } catch {}
}

let sock;
const clients = new Set();
const pending = new Map(); // id sent to Chrome -> {client, id}
let nextId = 1;
let snapshot = null; // the extension's chrome.storage.local, kept current
let server = null;
let closing = false;

function send(client, msg) {
  if (!client.socket.destroyed) client.socket.write(typeof msg === 'string' ? msg : line(msg));
}

function broadcast(msg) {
  const text = line(msg);
  for (const c of clients) if (c.subscribed) send(c, text);
}

function toChrome(msg) {
  process.stdout.write(frame(msg));
}

function fromChrome(m) {
  if (m?.type === 'state') {
    snapshot = m.data && typeof m.data === 'object' ? m.data : {};
    broadcast({ type: 'state', data: snapshot });
  } else if (m?.type === 'delta') {
    if (!snapshot) return; // the state comes first; nothing to apply this to
    applyDelta(snapshot, m);
    broadcast(m);
  } else if (m && 'id' in m) {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    send(p.client, {
      type: 'reply',
      id: p.id,
      ok: !!m.ok,
      ...(m.ok ? { value: m.value } : { error: m.error }),
    });
  }
}

function onRequest(client, m) {
  if (m?.type === 'subscribe') {
    client.subscribed = true;
    if (snapshot) send(client, { type: 'state', data: snapshot });
  } else if (m?.type === 'cmd' && m.msg && typeof m.msg === 'object') {
    const id = nextId++;
    try {
      toChrome({ id, msg: m.msg });
      pending.set(id, { client, id: m.id });
    } catch (error) {
      send(client, { type: 'reply', id: m.id, ok: false, error: error.message });
    }
  } else {
    send(client, { type: 'reply', id: m?.id, ok: false, error: 'Unknown request' });
  }
}

function onClient(socket) {
  const client = { socket, subscribed: false };
  clients.add(client);
  const read = lineReader((m) => onRequest(client, m), MAX_TO_CHROME);
  socket.on('data', (chunk) => {
    try {
      read(chunk);
    } catch (error) {
      send(client, { type: 'reply', ok: false, error: `Bad request: ${error.message}` });
      socket.end();
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => clients.delete(client));
}

// Whether another host is already serving the socket.
const live = (p) =>
  new Promise((resolve) => {
    const c = net.connect(p);
    c.once('connect', () => {
      c.destroy();
      resolve(true);
    });
    c.once('error', () => resolve(false));
  });

function listen() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(onClient);
    s.once('error', reject);
    s.listen(sock, () => resolve(s));
  });
}

async function start() {
  sock = socketPath();
  fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
  process.umask(0o077); // the socket is created owner-only, never briefly open
  try {
    server = await listen();
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    if (await live(sock)) {
      // Another Chrome profile's host has it. This one has nothing to do.
      log('socket in use by another host; exiting');
      process.exit(0);
    }
    fs.rmSync(sock, { force: true }); // stale, from a host that didn't clean up
    server = await listen();
  }
  fs.chmodSync(sock, 0o600);
  log('listening on', sock);
}

function shutdown(why) {
  if (closing) return;
  closing = true;
  log('exiting:', why);
  for (const [, p] of pending)
    send(p.client, { type: 'reply', id: p.id, ok: false, error: 'Chrome disconnected' });
  for (const c of clients) c.socket.end();
  if (server) {
    server.close();
    try {
      fs.unlinkSync(sock);
    } catch {}
  }
  setImmediate(() => process.exit(0));
}

const readChrome = frameReader(fromChrome);
process.stdin.on('data', (chunk) => {
  try {
    readChrome(chunk);
  } catch (error) {
    shutdown(`bad message from Chrome: ${error.message}`);
  }
});
process.stdin.on('end', () => shutdown('Chrome closed the port'));
process.stdout.on('error', () => shutdown('stdout closed'));
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(sig));

start().catch((error) => {
  log('failed to start:', error.message);
  process.exit(1);
});
