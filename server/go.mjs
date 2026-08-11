import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `npm run go` — the dev server and the signalling server, together.
 *
 * Written by hand rather than pulling in `concurrently` for two reasons. The
 * dependency is a hundred kilobytes to run two processes, and — the part that
 * actually matters on this machine — every shell-based runner quotes its
 * arguments differently, and this project lives in a directory whose path
 * contains a space. Spawning `node` on an absolute path to Vite's own bin
 * script, with `shell: false`, has no quoting to get wrong on any platform.
 *
 * Both children are killed when either one exits, because a Vite server left
 * running after the signalling server crashed is a game that silently drops to
 * single-player and gives no clue why.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

const children = [];
let shuttingDown = false;

function run(label, args, colour) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const prefix = `\x1b[${colour}m${label}\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    let carry = '';
    stream.on('data', (chunk) => {
      const lines = (carry + chunk).split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(prefix + line + '\n');
    });
  }
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(`${prefix}exited (${signal ?? code})\n`);
    stop(code ?? 1);
  });
  children.push(child);
  return child;
}

function stop(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 150).unref();
}

run('[net]', [path.join(here, 'index.js')], '35');
run('[web]', [viteBin], '36');

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));
