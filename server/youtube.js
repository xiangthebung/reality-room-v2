import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

/**
 * A YouTube link, resolved and proxied.
 *
 * THE SHAPE, AND WHY. `resolve()` spawns `yt-dlp --dump-single-json` once per
 * link, which returns (among other things) a direct, signed googlevideo.com
 * media URL good for a few hours. That URL is cached here, keyed by video id.
 * `proxyAudio()` never touches yt-dlp — it looks the id up in the cache and
 * `fetch()`s the cached URL itself, forwarding the browser's Range header and
 * piping the response straight through.
 *
 * This is deliberately NOT "spawn `yt-dlp -o -` and pipe stdout per request".
 * A live pipe cannot serve a Range request — there is no way to seek into it
 * without killing and re-extracting — so the `<audio>` element could never
 * scrub. It also means one Python process stays alive for the entire length of
 * every listener's playback rather than for the few seconds extraction takes.
 * Splitting the two means the fragile, YouTube-shaped part (extraction) has a
 * clean success/failure boundary, and the streaming part is a boring generic
 * proxy whose only failure mode is "upstream returned non-2xx".
 *
 * THE SERVER FETCHES THE SIGNED URL, THE BROWSER NEVER DOES. Not just for
 * same-origin/CORS reasons (see external-track.js) — googlevideo's signed URLs
 * are sometimes sensitive to being fetched from a different network path than
 * the one that requested them. Because this process both mints the URL (via
 * yt-dlp) and fetches it (via proxyAudio), that invariant holds automatically;
 * handing the signed URL to the browser to fetch directly would not have it.
 *
 * `/api/youtube/audio` is a PURE CACHE LOOKUP and never resolves on demand —
 * see `get()`. If it fell back to extracting on a cache miss, it would be a
 * second, unvalidated entry point into spawning yt-dlp.
 */

/**
 * Exact hostnames only — never a substring/regex test, which
 * `youtube.com.evil.example` would pass.
 */
const ALLOWED_HOSTS = new Set([
  'www.youtube.com',
  'youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

/**
 * WHICH AUDIO STREAM TO ASK FOR, AND WHY IT IS NOT m4a.
 *
 * YouTube offers the same track in two useful encodings: itag 140, AAC-LC in
 * an m4a container at 44.1 kHz, and itag 251, Opus in webm at 48 kHz. Both sit
 * near 128 kbps — measured on a real video, 129.5 for the AAC and 128.9 for
 * the Opus — so this is NOT a bitrate upgrade, and anyone expecting one from
 * the numbers will be disappointed. It is a codec upgrade at equal bitrate,
 * which Opus wins comfortably at this rate on exactly the material people
 * notice: cymbals, hi-hats and reverb tails, where AAC-LC at 128 has audible
 * swishing and Opus does not.
 *
 * The sample rate is the other half and is the part with no judgement in it.
 * The AudioContext runs at 48 kHz, so the m4a path is resampled from 44.1 on
 * every single sample and the Opus path is not.
 *
 * This used to read `bestaudio[ext=m4a]/bestaudio`, which pinned itag 140. That
 * filter was not selecting the best audio, it was actively excluding it: bare
 * `bestaudio` would already have picked Opus, because yt-dlp's default sort
 * ranks the codec above AAC and the bitrate is higher too.
 *
 * m4a is still reachable, because Opus-in-webm is not universal — older Safari
 * and iOS cannot decode it in an `<audio>` element. The browser tells us which
 * it can play (see `canPlayOpus` in src/audio/external-track.js) and that
 * choice arrives here as the `codecs` parameter; it is never inferred from a
 * User-Agent. Anything other than the literal 'm4a' means Opus.
 */
const AUDIO_FORMATS = {
  opus: 'bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
  m4a: 'bestaudio[ext=m4a]/bestaudio',
};

function pickVariant(requested) {
  return requested === 'm4a' ? 'm4a' : 'opus';
}

/**
 * THE CACHE IS KEYED BY VIDEO **AND** VARIANT, NOT BY VIDEO.
 *
 * Two people in the same room can be on two browsers with different codec
 * support, and `/api/youtube/audio` re-reads this cache on every Range request
 * rather than holding a URL open. Keyed by bare video id, the second person to
 * paste a link would overwrite the first person's entry with a different
 * encoding, and the first person's next Range request would be served bytes
 * from a different container mid-stream. So the key carries the variant, and
 * the `id` handed back to the browser is that composite key — opaque to the
 * client, which only ever passes it straight back.
 */
function cacheKey(videoId, variant) {
  return `${videoId}~${variant}`;
}

/**
 * Reject anything longer than this rather than pin a process to a 10-hour
 * link. A deployer's policy choice, not an implementation detail — unlike the
 * rest of the tuning in this file, so it alone is env-configurable, matching
 * how `server/index.js` treats `MAX_ROOM_SIZE`.
 */
const MAX_DURATION_S = Number(process.env.YOUTUBE_MAX_DURATION_S) > 0
  ? Number(process.env.YOUTUBE_MAX_DURATION_S)
  : 15 * 60;

/**
 * googlevideo URLs carry their own `expire=<unix seconds>` — parsed and used
 * when present (see `parseExpiry`). This is only the fallback for the rare
 * case that query param is missing.
 */
const DEFAULT_TTL_S = 4 * 60 * 60;

const REAP_INTERVAL_MS = 60_000;
const RESOLVE_WINDOW_MS = 10_000;
const RESOLVE_MAX_IN_WINDOW = 6;
const RESOLVE_TIMEOUT_MS = 20_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validateYoutubeUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    throw new HttpError(400, 'That is not a URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new HttpError(400, 'That is not a URL.');
  }
  // A userinfo component (`user:pass@host`) is a classic way to smuggle a
  // different real target past a casual hostname check.
  if (parsed.username || parsed.password) {
    throw new HttpError(400, 'That is not a URL.');
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new HttpError(400, 'Only youtube.com / youtu.be links are supported.');
  }
  return parsed;
}

/**
 * Bare `'yt-dlp'` resolves fine on most installs. It is override-able because
 * it did not on this project's own dev machine: a WinGet install landed at a
 * long, dotted `%LOCALAPPDATA%\Microsoft\WinGet\Packages\...` path that
 * Windows' own PATH search (`where.exe`) and even a re-spawned `node` both
 * resolved without issue, but Node's `child_process.spawn` PATH search did
 * not — a narrow libuv-on-Windows quirk, not anything wrong with the install.
 * Rather than depend on that resolving itself, an explicit path sidesteps it
 * entirely and is one line to set.
 */
const YTDLP_BIN = process.env.YOUTUBE_YTDLP_PATH?.trim() || 'yt-dlp';

/**
 * Spawned with an argv array and `shell: false`, never a command string.
 * `server/go.mjs` makes the same choice for the same reason (this project's
 * own path contains a space) — it matters more here, because the untrusted
 * input is the pasted URL itself, going straight into argv.
 */
function runYtDlp(args, { timeoutMs = RESOLVE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(YTDLP_BIN, args, { shell: false, windowsHide: true });
    } catch (err) {
      reject(new HttpError(500, `yt-dlp is not available: ${err.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new HttpError(504, 'Timed out talking to yt-dlp.'));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new HttpError(500, `yt-dlp is not available: ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        // The tail of stderr, not the head: yt-dlp's actual "unsupported URL" /
        // "video unavailable" verdict is the last line or two, everything above
        // it is usually warnings.
        reject(new HttpError(422, stderr.trim().slice(-400) || `yt-dlp exited ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseExpiry(directUrl) {
  try {
    const secs = Number(new URL(directUrl).searchParams.get('expire'));
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  } catch {
    /* fall through to the default */
  }
  return Date.now() + DEFAULT_TTL_S * 1000;
}

function contentTypeFor(ext) {
  if (ext === 'm4a' || ext === 'mp4') return 'audio/mp4';
  if (ext === 'webm') return 'audio/webm';
  if (ext === 'opus' || ext === 'ogg') return 'audio/ogg';
  return 'application/octet-stream';
}

export function createYoutubeService() {
  /** video id -> { directUrl, title, duration, contentType, expiresAt } */
  const cache = new Map();
  /** raw url string -> in-flight resolve() promise, so two near-simultaneous
   *  pastes of the same link share one yt-dlp invocation instead of racing two. */
  const inFlight = new Map();
  let windowStart = 0;
  let inWindow = 0;

  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of cache) if (entry.expiresAt < now) cache.delete(id);
  }, REAP_INTERVAL_MS);
  reaper.unref?.();

  function checkRate() {
    const now = Date.now();
    if (now - windowStart > RESOLVE_WINDOW_MS) {
      windowStart = now;
      inWindow = 0;
    }
    inWindow += 1;
    if (inWindow > RESOLVE_MAX_IN_WINDOW) {
      throw new HttpError(429, 'Too many links at once — try again in a few seconds.');
    }
  }

  async function resolveOnce(rawUrl, variant) {
    checkRate();
    const parsed = validateYoutubeUrl(rawUrl);

    const stdout = await runYtDlp([
      '--dump-single-json',
      '--no-playlist',
      '--playlist-items',
      '1',
      '-f',
      AUDIO_FORMATS[variant],
      parsed.toString(),
    ]);

    let info;
    try {
      info = JSON.parse(stdout);
    } catch {
      throw new HttpError(502, "Couldn't read that video.");
    }

    // `--no-playlist` only prefers the single video when a URL names both a
    // video and a playlist; a URL that IS a playlist/mix has no single video
    // for it to prefer, so it can still come back playlist-shaped.
    if (info._type === 'playlist' || Array.isArray(info.entries)) {
      throw new HttpError(400, 'Playlists are not supported — paste a single video link.');
    }
    if (info.is_live) {
      throw new HttpError(400, 'Live streams are not supported.');
    }
    if (typeof info.duration === 'number' && info.duration > MAX_DURATION_S) {
      throw new HttpError(400, `Too long — the limit is ${Math.round(MAX_DURATION_S / 60)} minutes.`);
    }
    if (!info.url) {
      throw new HttpError(502, 'No playable audio found for that video.');
    }
    if (!info.id) {
      throw new HttpError(502, "Couldn't identify that video.");
    }

    const entry = {
      directUrl: info.url,
      title: String(info.title || 'Untitled').slice(0, 200),
      duration: typeof info.duration === 'number' ? info.duration : null,
      contentType: contentTypeFor(info.ext),
      expiresAt: parseExpiry(info.url),
    };
    const key = cacheKey(info.id, variant);
    cache.set(key, entry);
    return { id: key, title: entry.title, duration: entry.duration };
  }

  function resolve(rawUrl, codecs) {
    const variant = pickVariant(codecs);
    // The in-flight key carries the variant for the same reason the cache key
    // does: two browsers pasting the same link at the same moment want two
    // different encodings, and sharing one promise would hand one of them the
    // other's answer. The newline cannot appear in a variant, so it cannot be
    // used to forge a collision with a URL.
    const key = `${variant}\n${String(rawUrl)}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const p = resolveOnce(String(rawUrl), variant).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  }

  /** Pure cache lookup — never resolves on demand. Returns null past expiry. */
  function get(id) {
    const entry = cache.get(id);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      cache.delete(id);
      return null;
    }
    return entry;
  }

  function evict(id) {
    cache.delete(id);
  }

  /** Boot-time presence check. Resolves to a version string, or null if yt-dlp isn't on PATH. */
  async function checkVersion() {
    try {
      const out = await runYtDlp(['--version'], { timeoutMs: 5000 });
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  return {
    resolve,
    get,
    evict,
    checkVersion,
    stop() {
      clearInterval(reaper);
    },
  };
}

/**
 * Streams the cached track to `res`, forwarding Range so the browser's
 * `<audio>` element can seek. `id` must already be resolved and cached —
 * see the header comment on why this never extracts on a miss.
 */
export async function proxyAudio(service, req, res, id) {
  const entry = id ? service.get(id) : null;
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Unknown or expired track — paste the link again.' }));
    return;
  }

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const upstreamHeaders = {};
  if (req.headers.range) upstreamHeaders.range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(entry.directUrl, { headers: upstreamHeaders, signal: controller.signal });
  } catch {
    // Most commonly the client aborting (seek/pause/navigate) racing the
    // fetch — nothing to respond to once that happens.
    if (controller.signal.aborted) return;
    service.evict(id);
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Lost the connection to that track — paste the link again.' }));
    return;
  }

  if (!upstream.ok && upstream.status !== 206) {
    // The signed URL almost certainly expired; the TTL was an estimate.
    service.evict(id);
    res.writeHead(upstream.status === 404 ? 404 : 502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'That link expired — paste it again.' }));
    return;
  }

  const outHeaders = {
    'Content-Type': entry.contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  const contentLength = upstream.headers.get('content-length');
  const contentRange = upstream.headers.get('content-range');
  if (contentLength) outHeaders['Content-Length'] = contentLength;
  if (contentRange) outHeaders['Content-Range'] = contentRange;

  res.writeHead(upstream.status === 206 ? 206 : 200, outHeaders);

  if (!upstream.body) {
    res.end();
    return;
  }
  // `fetch()`'s body is a WHATWG ReadableStream, not a Node stream — it has no
  // `.pipe()`. `serveStatic` in index.js streams from the filesystem, not from
  // a second `fetch()`, so there is no existing precedent for this line.
  const nodeStream = Readable.fromWeb(upstream.body);
  nodeStream.on('error', () => {
    try {
      res.end();
    } catch {
      /* response already gone */
    }
  });
  nodeStream.pipe(res);
}
