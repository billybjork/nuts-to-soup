// A connection to the native host's socket, for the CLI and the TUI.
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { line, lineReader, applyDelta } from './protocol.js';
import { socketPath, HOST_MANIFEST } from './paths.js';
import { normalize } from '../lib/store.js';

const gone = (error) => ['ENOENT', 'ECONNREFUSED'].includes(error.code);

function open(path) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

// Chrome isn't running (or the extension hasn't connected yet): start it in
// the background and wait for the host's socket.
async function launch(path, timeout) {
  spawn('open', ['-g', '-a', 'Google Chrome'], { stdio: 'ignore', detached: true }).on('error', () => {});
  const until = Date.now() + timeout;
  for (;;) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      return await open(path);
    } catch (error) {
      if (!gone(error) || Date.now() > until) throw error;
    }
  }
}

function explain(error) {
  if (!gone(error)) return error;
  if (!fs.existsSync(HOST_MANIFEST))
    return new Error('The native host is not installed. Run `npm run install-host` in tui/.');
  return new Error(
    'Chrome started, but Nuts to Soup did not connect. Reload the extension at chrome://extensions.',
  );
}

// `launch`: start Chrome if nothing is listening. `wait`: how long for.
export async function connect({ launch: start = true, wait = 10_000 } = {}) {
  const path = socketPath();
  let socket;
  try {
    socket = await open(path);
  } catch (error) {
    if (!gone(error)) throw error;
    if (!start) throw explain(error);
    try {
      socket = await launch(path, wait);
    } catch (e) {
      throw explain(e);
    }
  }
  return new Client(socket);
}

// Emits 'state' with the normalized store on the first snapshot and after
// every change ('change' gets the changed keys too), and 'close'.
export class Client extends EventEmitter {
  #socket;
  #replies = new Map();
  #nextId = 1;
  raw = null;
  #state = null;

  constructor(socket) {
    super();
    this.#socket = socket;
    const read = lineReader((m) => this.#receive(m));
    socket.on('data', (chunk) => {
      try {
        read(chunk);
      } catch (error) {
        socket.destroy(error);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      for (const [, r] of this.#replies) r.reject(new Error('Lost the connection to Chrome'));
      this.#replies.clear();
      this.emit('close');
    });
  }

  // The normalized store, as lib/store.js's load() would give it.
  get state() {
    return (this.#state ??= this.raw && normalize(this.raw));
  }

  #receive(m) {
    if (m.type === 'reply') {
      const r = this.#replies.get(m.id);
      if (!r) return;
      this.#replies.delete(m.id);
      if (m.ok) r.resolve(m.value);
      else r.reject(new Error(m.error || 'Command failed'));
    } else if (m.type === 'state' || m.type === 'delta') {
      if (m.type === 'state') this.raw = m.data;
      else if (this.raw) applyDelta(this.raw, m);
      else return;
      this.#state = null;
      const keys = m.type === 'state' ? null : [...Object.keys(m.set || {}), ...(m.removed || [])];
      this.emit('change', keys);
      this.emit('state', this.state);
    }
  }

  // Sends one of the panel's commands; resolves with its value.
  request(msg, timeout = 60_000) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#replies.delete(id);
        reject(new Error('Chrome did not answer in time'));
      }, timeout);
      const done = (fn) => (v) => {
        clearTimeout(timer);
        fn(v);
      };
      this.#replies.set(id, { resolve: done(resolve), reject: done(reject) });
      this.#socket.write(line({ type: 'cmd', id, msg }));
    });
  }

  // Starts state updates; resolves with the first snapshot.
  subscribe(timeout = 10_000) {
    if (this.raw) return Promise.resolve(this.state);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome sent no state')), timeout);
      this.once('state', (s) => {
        clearTimeout(timer);
        resolve(s);
      });
      this.#socket.write(line({ type: 'subscribe' }));
    });
  }

  close() {
    this.#socket.end();
  }
}
