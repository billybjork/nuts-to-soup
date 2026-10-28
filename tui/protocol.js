// The bridge's two wire formats. Chrome talks to the native host in
// length-prefixed JSON over stdio; terminal clients talk to it in
// newline-delimited JSON over a Unix socket.
import os from 'node:os';

// Chrome refuses a message over 1 MB from the host, and sends up to 64 MiB.
export const MAX_TO_CHROME = 1024 * 1024;
export const MAX_FROM_CHROME = 64 * 1024 * 1024;

const LE = os.endianness() === 'LE'; // Chrome uses native byte order

export function frame(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  if (body.length > MAX_TO_CHROME) throw new Error('Message is over the 1 MB Chrome accepts');
  const head = Buffer.alloc(4);
  if (LE) head.writeUInt32LE(body.length);
  else head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

// Collects chunks until a whole piece is there, without copying on every chunk.
function buffer() {
  let chunks = [];
  let size = 0;
  return {
    get size() {
      return size;
    },
    push(chunk) {
      chunks.push(chunk);
      size += chunk.length;
    },
    take(n) {
      const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
      const rest = all.subarray(n);
      chunks = rest.length ? [rest] : [];
      size = rest.length;
      return all.subarray(0, n);
    },
  };
}

// Returns a function to feed stdio chunks to; calls onMessage per message.
// Throws on a length over `max`, after which the stream can't be trusted.
export function frameReader(onMessage, max = MAX_FROM_CHROME) {
  const buf = buffer();
  let need = -1;
  return (chunk) => {
    buf.push(chunk);
    for (;;) {
      if (need < 0) {
        if (buf.size < 4) return;
        const head = buf.take(4);
        need = LE ? head.readUInt32LE() : head.readUInt32BE();
        if (need > max) throw new Error(`Message of ${need} bytes is over the limit`);
      }
      if (buf.size < need) return;
      const body = buf.take(need);
      need = -1;
      onMessage(JSON.parse(body.toString('utf8')));
    }
  };
}

export const line = (msg) => `${JSON.stringify(msg)}\n`;

// Same, for newline-delimited JSON. Throws on a line longer than `max`.
export function lineReader(onMessage, max = Infinity) {
  const buf = buffer();
  return (chunk) => {
    let start = 0;
    for (let i; (i = chunk.indexOf(10, start)) !== -1; start = i + 1) {
      buf.push(chunk.subarray(start, i));
      const text = buf.take(buf.size).toString('utf8');
      if (text.trim()) onMessage(JSON.parse(text));
    }
    if (start < chunk.length) buf.push(chunk.subarray(start));
    if (buf.size > max) throw new Error('Line is over the limit');
  };
}

// Applies a storage delta from the extension to a raw store snapshot.
export function applyDelta(raw, { set = {}, removed = [] }) {
  Object.assign(raw, set);
  for (const k of removed) delete raw[k];
  return raw;
}
