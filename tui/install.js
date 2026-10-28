// Installs (or with --uninstall, removes) the native messaging host for
// Chrome, and an `nts` command.
//
//   node tui/install.js [--bin DIR] [--force]
//   node tui/install.js --uninstall [--bin DIR]
//
// Chrome starts native hosts with a minimal environment, and version
// managers' node shims need theirs, so the wrappers run this node by its
// absolute path. Run this again after changing node versions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DIR, HOST_NAME, HOST_MANIFEST } from './paths.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const MARK = '# Installed by nuts-to-soup';
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const binDir = option('--bin') || path.join(os.homedir(), '.local', 'bin');
const hostWrapper = path.join(DIR, 'host');
const ntsWrapper = path.join(binDir, 'nts');

// Chrome derives an unpacked extension's ID from its manifest `key`: the
// first 32 hex digits of the key's SHA-256, written with a-p for 0-f.
export function extensionId(key) {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const sh = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
const wrapper = (script) =>
  `#!/bin/sh\n${MARK}\nexec ${sh(process.execPath)} ${sh(path.join(here, script))} "$@"\n`;
const ours = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').includes(MARK);
  } catch {
    return false;
  }
};

function install() {
  const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'manifest.json'), 'utf8'));
  const id = extensionId(manifest.key);

  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(hostWrapper, wrapper('host.js'), { mode: 0o755 });
  fs.mkdirSync(path.dirname(HOST_MANIFEST), { recursive: true });
  const host = {
    name: HOST_NAME,
    description: 'Nuts to Soup terminal bridge',
    path: hostWrapper,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${id}/`],
  };
  fs.writeFileSync(HOST_MANIFEST, `${JSON.stringify(host, null, 2)}\n`);
  console.log(`Host manifest: ${HOST_MANIFEST}`);
  console.log(`Extension ID:  ${id}`);

  if (fs.existsSync(ntsWrapper) && !ours(ntsWrapper) && !flag('--force')) {
    console.error(`${ntsWrapper} exists and isn't ours. Pass --force to replace it, or --bin DIR.`);
    process.exitCode = 1;
  } else {
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(ntsWrapper, wrapper('cli.js'), { mode: 0o755 });
    console.log(`Command:       ${ntsWrapper}`);
    if (!process.env.PATH.split(':').includes(binDir)) console.log(`(${binDir} is not on your PATH)`);
  }
  console.log('Reload the extension at chrome://extensions to connect.');
}

function uninstall() {
  fs.rmSync(HOST_MANIFEST, { force: true });
  if (ours(ntsWrapper)) fs.rmSync(ntsWrapper);
  fs.rmSync(DIR, { recursive: true, force: true }); // the host wrapper, its log and socket
  console.log('Removed the host manifest, the nts command and', DIR);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (flag('--uninstall')) uninstall();
  else install();
}
