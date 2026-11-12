// Cover art for the TUI: fetched once into a cache on disk, decoded to RGBA
// by macOS's sips at the size asked for, and kept in memory for a while.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ART_CACHE } from './paths.js';
import { decodeBMP } from './pixels.js';

const run = promisify(execFile);

// NTS serves the same image from several hosts, and any one of them may be
// slow or 503 for a while (see lib/nts.js).
const MIRRORS = ['media', 'media2', 'media3'];
export function mirrors(url) {
  const m = /^https:\/\/(media\d?)\.ntslive\.co\.uk\//.exec(url);
  if (!m) return [url];
  return [m[1], ...MIRRORS.filter((h) => h !== m[1])].map((h) => url.replace(m[1], h));
}

// Runs at most `n` of the given async jobs at once.
export function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

export function createArt({ dir = ART_CACHE, fetch = globalThis.fetch, timeout = 8000, keep = 80 } = {}) {
  const files = new Map(); // url -> Promise<path>
  const decoded = new Map(); // `${url}@${px}` -> Promise<image>, most recent last
  const net = limiter(6);
  const cpu = limiter(4);
  let ready;

  // Drops cached files nobody has used for a month.
  async function prune() {
    const cutoff = Date.now() - 30 * 864e5;
    for (const name of await fs.readdir(dir).catch(() => [])) {
      const file = path.join(dir, name);
      const st = await fs.stat(file).catch(() => null);
      if (st && st.atimeMs < cutoff && st.mtimeMs < cutoff) await fs.rm(file, { force: true });
    }
  }

  function file(url) {
    if (!url) return Promise.reject(new Error('No image'));
    if (files.has(url)) return files.get(url);
    const p = (async () => {
      ready ??= fs.mkdir(dir, { recursive: true }).then(() => void prune().catch(() => {}));
      await ready;
      const ext = path.extname(new URL(url).pathname) || '.jpg';
      const target = path.join(dir, crypto.createHash('sha1').update(url).digest('hex') + ext);
      try {
        await fs.access(target);
        return target;
      } catch {}
      return net(async () => {
        for (const u of mirrors(url)) {
          try {
            const res = await fetch(u, { signal: AbortSignal.timeout(timeout) });
            if (!res.ok) continue;
            const tmp = `${target}.${process.pid}.tmp`;
            await fs.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
            await fs.rename(tmp, target);
            return target;
          } catch {}
        }
        throw new Error(`Couldn't fetch ${url}`);
      });
    })();
    files.set(url, p);
    // A failure is retried next time it's asked for, not straight away.
    p.catch(() => setTimeout(() => files.delete(url), 60_000).unref());
    return p;
  }

  // The image at url as RGBA, px x px (NTS covers are square).
  function image(url, px) {
    const key = `${url}@${px}`;
    let p = decoded.get(key);
    if (p) {
      decoded.delete(key);
      decoded.set(key, p);
      return p;
    }
    p = file(url).then((src) =>
      cpu(async () => {
        const out = path.join(os.tmpdir(), `nts-art-${process.pid}-${crypto.randomUUID()}.bmp`);
        try {
          // A stuck decode would hold its slot for good, and every image behind it.
          await run('sips', ['-s', 'format', 'bmp', '-z', String(px), String(px), src, '--out', out], {
            timeout: 10_000,
          });
          return decodeBMP(await fs.readFile(out));
        } finally {
          await fs.rm(out, { force: true });
        }
      }),
    );
    decoded.set(key, p);
    p.catch(() => decoded.delete(key));
    while (decoded.size > keep) decoded.delete(decoded.keys().next().value);
    return p;
  }

  return { file, image };
}
