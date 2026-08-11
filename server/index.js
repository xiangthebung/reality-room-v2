import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RoomRegistry, randomCode, normalizeCode } from './rooms.js';
import { attachSignaling } from './signaling.js';
import { createIceProvider } from './ice.js';
import { createYoutubeService, proxyAudio } from './youtube.js';

/**
 * The signalling server.
 *
 * NO EXPRESS, AND THE REASON IS NOT MINIMALISM FOR ITS OWN SAKE. This server has
 * two JSON endpoints, one WebSocket path and — only in `--prod` — a static
 * directory with maybe a dozen files in it. Express earns its place when there
 * is routing worth expressing, middleware worth ordering, or a body worth
 * parsing; none of those are true here, and every one of its ~50 transitive
 * dependencies would be running on the same box as the microphone permissions.
 * `ws` is the one dependency that cannot be replaced by twenty lines, because
 * the WebSocket framing, masking and close handshake genuinely are fiddly. So
 * the runtime dependency list for the whole project is `three` and `ws`.
 *
 * Node reads `.env` natively as of 20.6, so there is no dotenv either.
 */
try {
  process.loadEnvFile();
} catch {
  /* No .env. Everything below has a default, and STUN-only still works. */
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const distRoot = path.join(projectRoot, 'dist');

const isProd = process.argv.includes('--prod') || process.env.NODE_ENV === 'production';
/**
 * `SIGNALLING_PORT` first, `PORT` as a fallback, and the order is the fix.
 *
 * `PORT` alone was the whole configuration and it collided with the universal
 * convention that `PORT` is the port whichever process reads it should listen
 * on. In development two processes read it — this one and Vite, which needed it
 * to find this one — so any launcher that set `PORT` meaning "Vite's port" made
 * Vite proxy `/api` and `/ws` back to itself and multiplayer silently died. See
 * the long note in vite.config.js.
 *
 * `PORT` is kept here, second, because in production this process is the only
 * one running and a PaaS that sets `PORT` is using the word correctly.
 */
const PORT = Number(process.env.SIGNALLING_PORT) || Number(process.env.PORT) || 5181;
const HOST = process.env.HOST || '0.0.0.0';

/**
 * Eight, not twelve.
 *
 * A full mesh means every player uploads their voice to every other player, so
 * upstream cost is (N-1) × ~48 kbit/s. At eight that is about 340 kbit/s, which
 * a domestic connection carries without thinking about it. At twelve it is over
 * half a megabit and the first person on a bad wifi link starts dropping
 * packets for everybody they are talking to. The cap is a bandwidth fact, not a
 * game-design one — raise it only after replacing the mesh with an SFU.
 */
const MAX_ROOM_SIZE = clampInt(process.env.MAX_ROOM_SIZE, 2, 16, 8);

const ice = createIceProvider(process.env);
const registry = new RoomRegistry({ maxRoomSize: MAX_ROOM_SIZE });
const youtube = createYoutubeService();

const server = http.createServer(async (req, res) => {
  // The mic is the whole point, and getUserMedia is gated on a permissions
  // policy as well as on a secure origin. Framing is denied because a room you
  // did not knowingly open is a room you did not knowingly speak into.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=(self)');

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, { error: 'bad request' });
  }

  if (url.pathname === '/healthz') {
    return send(res, 200, { ok: true, ...registry.stats(), uptime: Math.round(process.uptime()) });
  }

  /**
   * Everything the browser needs to join, in one request.
   *
   * `iceServers` is the interesting field: short-lived credentials minted from a
   * long-lived API token that stays in this process. The browser is handed a
   * two-hour lease and nothing that could produce another one.
   */
  if (url.pathname === '/api/config') {
    return send(res, 200, {
      iceServers: ice.getIceServers(),
      hasTurn: ice.hasTurn,
      maxRoomSize: MAX_ROOM_SIZE,
      tickHz: 18,
    });
  }

  // A fresh invite code. GET rather than POST because it creates nothing — the
  // room springs into existence when the first person actually connects to it,
  // so this is a random-number generator with an alphabet, not a mutation.
  if (url.pathname === '/api/room') {
    return send(res, 200, { room: randomCode() });
  }

  /**
   * What is behind a code, before committing to it.
   *
   * The main menu asks this the moment somebody finishes typing a lobby code, so
   * that "3 of 8 already there" and "nobody has used that code" are answers you
   * get while still in the menu rather than after the world has been built.
   *
   * `seed` is the load-bearing field and the reason this endpoint now matters. A
   * typed code has no room to carry a forest the way an invite link does, so the
   * menu takes the wood from here and opens the page at `?room=…&seed=…`, which
   * is byte for byte the invitation the host would have sent. Null means nobody
   * is in there, in which case the joiner's own world becomes the room's — see
   * `Room.seed`.
   *
   * Creates nothing. A code that has never been used reads as an empty room,
   * which is exactly what it is: rooms spring into existence when somebody
   * connects, so peeking at one cannot be a way to fill this process with them.
   */
  if (url.pathname === '/api/room/peek') {
    const code = normalizeCode(url.searchParams.get('room'));
    if (!code) return send(res, 400, { error: 'bad code' });
    const room = registry.get(code);
    return send(res, 200, {
      room: code,
      here: room?.size ?? 0,
      maxSize: MAX_ROOM_SIZE,
      full: room ? room.isFull : false,
      seed: room?.seed ?? null,
    });
  }

  /**
   * The jukebox's paste-a-link feature. `resolve` is the only route that
   * spawns yt-dlp; `audio` is a pure cache lookup + streaming proxy against
   * whatever `resolve` already put in the cache. See server/youtube.js's
   * header for why they're split that way.
   */
  if (url.pathname === '/api/youtube/resolve') {
    const target = url.searchParams.get('url');
    if (!target) return send(res, 400, { error: 'missing url' });
    try {
      // `codecs` is what the browser says it can decode, not what we guess it
      // can — see the AUDIO_FORMATS comment in server/youtube.js. Passed
      // through unvalidated on purpose: `pickVariant` there is a whitelist of
      // exactly two strings, so anything else already means "the default".
      const result = await youtube.resolve(target, url.searchParams.get('codecs'));
      return send(res, 200, result);
    } catch (err) {
      return send(res, err.status ?? 500, { error: err.message || 'failed to resolve that link' });
    }
  }

  if (url.pathname === '/api/youtube/audio') {
    const id = url.searchParams.get('id');
    return proxyAudio(youtube, req, res, id);
  }

  if (isProd) return serveStatic(req, res, url);
  return send(res, 404, { error: 'not found' });
});

attachSignaling(server, registry, { getIceServers: ice.getIceServers, exclusive: true });

// Fetch the relay credential before opening the door, so the very first person
// to arrive already has TURN rather than STUN-only for their first minute.
await ice.prime();
// Same idea for yt-dlp: know at boot whether the jukebox's paste-a-link
// feature can actually work, rather than finding out from the first player's
// mystery 500.
const ytDlpVersion = await youtube.checkVersion();

server.listen(PORT, HOST, banner);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    ice.stop();
    registry.stop();
    youtube.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

// ---------------------------------------------------------------------------

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * `--prod` serves the built client from the same origin as the socket.
 *
 * That single origin is not a convenience, it is the deployment. `getUserMedia`
 * only works on a secure origin, so going live means putting one HTTPS name in
 * front of this process; if the page came from somewhere else the WebSocket
 * would be cross-origin and the invite link would have two halves to explain.
 *
 * There are no binary assets in this project — the whole world is generated at
 * runtime — so "static file serving" is a handful of text files and this is the
 * entire implementation.
 */
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });

  const requested = decodeURIComponent(url.pathname);
  let filePath = path.join(distRoot, requested);
  // path.join collapses `..`, but only resolve() gives an absolute answer that
  // can be compared. Anything that lands outside dist is a traversal attempt.
  const resolved = path.resolve(filePath);
  if (resolved !== distRoot && !resolved.startsWith(distRoot + path.sep)) {
    return send(res, 403, { error: 'nope' });
  }
  filePath = resolved;

  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    /* falls through to index.html below */
  }
  // Anything that is not a real file is the app itself: an invite link is
  // `/?room=abc-def-ghi`, which is index.html, and so is every path a future
  // router might invent.
  if (!stat || stat.isDirectory()) filePath = path.join(distRoot, 'index.html');

  const ext = path.extname(filePath);
  const headers = {
    'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    // Vite fingerprints everything under assets/, so those may be cached
    // forever; index.html must never be, or a deploy is invisible.
    'Cache-Control': filePath.includes(`${path.sep}assets${path.sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  };
  fs.createReadStream(filePath)
    .on('open', () => res.writeHead(200, headers))
    .on('error', () => {
      if (!res.headersSent) send(res, 404, { error: 'not found' });
      else res.end();
    })
    .pipe(res);
}

function clampInt(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function localAddresses() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

function banner() {
  const lines = [
    '',
    '  Reality Room — signalling',
    `  ${isProd ? 'production' : 'development'}, port ${PORT}`,
    '',
    `  ICE:    ${ice.describe()}`,
    `  Rooms:  up to ${MAX_ROOM_SIZE} people, voice peer-to-peer`,
    `  ${ytDlpVersion ? `YouTube: yt-dlp ${ytDlpVersion} found — jukebox links enabled` : 'YouTube: yt-dlp NOT FOUND — the jukebox’s paste-a-link feature is disabled'}`,
    '',
  ];
  if (isProd) {
    lines.push(`  Local:  http://localhost:${PORT}`);
    for (const address of localAddresses()) lines.push(`  LAN:    http://${address}:${PORT}`);
  } else {
    lines.push('  Open the Vite dev server (http://127.0.0.1:5180), not this port.');
    lines.push('  It proxies /api and /ws here — see vite.config.js.');
  }
  lines.push('');
  lines.push('  Browsers only grant microphone access on a secure origin.');
  lines.push('  localhost counts, so two tabs on this machine work right now;');
  lines.push('  anyone else needs HTTPS in front of this process.');
  lines.push('');
  console.log(lines.join('\n'));
}
