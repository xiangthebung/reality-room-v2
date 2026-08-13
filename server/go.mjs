import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `npm run go` — the dev server, the signalling server, and (unless
 * `--no-tunnel`) a Cloudflare quick tunnel, together.
 *
 * Written by hand rather than pulling in `concurrently` for two reasons. The
 * dependency is a hundred kilobytes to run two processes, and — the part that
 * actually matters on this machine — every shell-based runner quotes its
 * arguments differently, and this project lives in a directory whose path
 * contains a space. Spawning each child on an absolute path (or, for
 * `cloudflared`, its bare name resolved by the OS's own PATH search) with
 * `shell: false` has no quoting to get wrong on any platform.
 *
 * `net` and `web` are FATAL to each other: either one exiting kills the rest,
 * because a Vite server left running after the signalling server crashed is a
 * game that silently drops to single-player and gives no clue why. The tunnel
 * is not fatal — losing it just means there's no public link, and the two of
 * you sitting at this machine can still play.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

// Must match `DEV_PORT` in vite.config.js — that's the origin the tunnel has
// to point at, because it's the one that serves the page AND proxies /api and
// /ws through to the signalling server. Pointing the tunnel at the signalling
// port directly would hand friends a page-less JSON endpoint.
const DEV_PORT = 5180;

const NO_TUNNEL = process.argv.includes('--no-tunnel');

/**
 * Find `cloudflared` ourselves rather than trusting the OS to.
 *
 * `spawn(..., { shell: false })` is supposed to search PATH, and for `node`,
 * `git` and `yt-dlp` on this machine it does. For `cloudflared` — installed to
 * `%LOCALAPPDATA%\cloudflared`, present in PATH, spelled with no space or odd
 * character — the same call returns ENOENT, while the identical spawn with the
 * absolute path runs fine. Whatever the cause, the symptom is the expensive
 * one: `[tun] failed to start: spawn cloudflared ENOENT` scrolls past among
 * twenty lines of successful startup, the tunnel is deliberately non-fatal, so
 * the game comes up looking perfectly healthy with no public link — and the
 * message it prints blames a missing install that is right there.
 *
 * So: an explicit override first, then a hand-rolled PATH walk, then the
 * standard Windows install directory, then the bare name so a machine where
 * the OS search DOES work is no worse off than before.
 */
function findCloudflared() {
  const override = process.env.CLOUDFLARED;
  if (override && fs.existsSync(override)) return override;

  const names = process.platform === 'win32' ? ['cloudflared.exe', 'cloudflared'] : ['cloudflared'];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    dirs.push(path.join(process.env.LOCALAPPDATA, 'cloudflared'));
  }
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return 'cloudflared';
}

const children = [];
let shuttingDown = false;

function run(label, command, args, colour, { fatal = true, onLine } = {}) {
  const child = spawn(command, args, {
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
      for (const line of lines) {
        process.stdout.write(prefix + line + '\n');
        onLine?.(line);
      }
    });
  }
  child.on('error', (err) => {
    process.stdout.write(`${prefix}failed to start: ${err.message}\n`);
    if (fatal) stop(1);
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(`${prefix}exited (${signal ?? code})\n`);
    if (fatal) stop(code ?? 1);
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

run('[net]', process.execPath, [path.join(here, 'index.js')], '35');
run('[web]', process.execPath, [viteBin], '36');

if (!NO_TUNNEL) {
  let announced = false;
  run(
    '[tun]',
    findCloudflared(),
    ['tunnel', '--url', `http://127.0.0.1:${DEV_PORT}`],
    '33',
    {
      fatal: false,
      onLine(line) {
        if (announced) return;
        const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (!match) return;
        announced = true;
        process.stdout.write(
          '\n' +
            `\x1b[32m>> Open this yourself first: ${match[0]}\x1b[0m\n` +
            '   Then press J in-game — the invite link it shows you will start with\n' +
            '   that address, and that exact link (not this bare one) is what you\n' +
            '   send your friends: it carries the room code AND this world\'s seed.\n\n'
        );
      },
    }
  );
  // cloudflared not on PATH: keep the game running locally and say so once,
  // rather than dying — same reasoning as `fatal: false` above.
  setTimeout(() => {
    if (!announced && !shuttingDown) {
      process.stdout.write(
        '\x1b[33m[tun] no tunnel link yet — if this never appears, cloudflared may not be\n' +
          '      installed. Playing locally still works; see .env.example under\n' +
          '      "Going live" for manual tunnel setup, or run with --no-tunnel to\n' +
          '      silence this.\x1b[0m\n'
      );
    }
  }, 12_000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));
