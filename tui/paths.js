// Where the bridge's files live. NTS_SOCKET overrides the socket (for tests).
import os from 'node:os';
import path from 'node:path';

export const HOST_NAME = 'com.billybjork.nuts_to_soup';
export const DIR = path.join(os.homedir(), 'Library', 'Application Support', 'nuts-to-soup');
export const LOG = path.join(DIR, 'host.log');
export const CHROME_HOSTS = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Google',
  'Chrome',
  'NativeMessagingHosts',
);
export const HOST_MANIFEST = path.join(CHROME_HOSTS, `${HOST_NAME}.json`);

// macOS caps a Unix socket path at 104 bytes, including the terminating NUL.
const MAX_SOCKET_PATH = 103;

export function socketPath() {
  const p = process.env.NTS_SOCKET || path.join(DIR, 'bridge.sock');
  if (Buffer.byteLength(p) > MAX_SOCKET_PATH) throw new Error(`Socket path is too long for macOS: ${p}`);
  return p;
}
