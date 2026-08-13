import { defineConfig } from 'vite';

/**
 * The signalling server runs as its own process (`npm run server`, or both at
 * once with `npm run go`), and Vite proxies `/api` and `/ws` through to it.
 *
 * WHY A PROXY RATHER THAN A SECOND ORIGIN. The client never configures a host:
 * it opens `/ws` on whatever origin the page came from, which is the same line
 * of code in development and in production. That is what makes an invite link a
 * complete invitation — there is no second address to also get right, and no
 * way to end up on a page that loads but cannot talk.
 *
 * WHY THE SIGNALLING SERVER IS NOT SIMPLY MOUNTED INSIDE VITE. It was, in the
 * previous project, and it cost an evening. A `ws` server attached to an HTTP
 * server with a `path` option answers **400 to every upgrade that does not
 * match that path** — including Vite's own HMR socket. The symptom is not an
 * error: it is the page reloading every few seconds, because the HMR client
 * sees its connection rejected and concludes the dev server has died. Two
 * processes cannot have that problem. (`server/signaling.js` still takes
 * upgrades manually and can share a port; see the comment there.)
 *
 * With no server running, both entries fail: `/api/room` returns a proxy error
 * and `/ws` refuses to upgrade. Both are handled on the client as "there is no
 * server", which is a supported state — see src/net/index.js.
 */
/**
 * Read `.env` here as well as in the server.
 *
 * Both processes have to agree on the port, and the port is written down in
 * exactly one place — `.env`. Vite's own env handling only exposes `VITE_`-
 * prefixed variables to the client and does not put anything into
 * `process.env`, so without this a user who changed the port would get a server
 * on one port and a proxy pointed at another, with the only symptom being that
 * multiplayer quietly never connects.
 */
try {
  process.loadEnvFile();
} catch {
  /* no .env; the default below is the same one server/index.js uses */
}

/**
 * `SIGNALLING_PORT`, AND EMPHATICALLY NOT `PORT`. This line read
 * `process.env.PORT` and it cost an afternoon.
 *
 * `PORT` means, universally, "the port the process reading it should listen on".
 * Docker sets it, every PaaS sets it, and the Claude Code preview harness sets
 * it — all of them telling *Vite* where to listen. Vite then took it as the
 * address of the signalling server and proxied `/api` and `/ws` **straight back
 * to itself**.
 *
 * The symptom is the worst kind. Both pages load, build their forest, report the
 * room in their URL, and never see each other. No error, no failed request that
 * looks unusual, nothing in the console — the block comment above this one even
 * predicts "the only symptom being that multiplayer quietly never connects"
 * without noticing it had caused exactly that. Both net tests failed at "they
 * can see each other", which reads as broken netcode, and the first hour went
 * into WebRTC.
 *
 * So the two processes now agree on a name that can only mean one thing. An
 * ambient `PORT` is deliberately IGNORED here: in development it is somebody
 * else's variable, and in production Vite is not running at all — the server
 * serves the built client from one origin and there is no proxy to configure.
 * `server/index.js` still honours `PORT` as a fallback for exactly that case.
 *
 * Diagnosing the old failure, if it ever comes back in another form:
 * `curl 127.0.0.1:<vite>/api/room` against `curl 127.0.0.1:5181/api/room`. A 500
 * from the first with the second fine is a proxy pointed somewhere wrong.
 */
const SIGNALLING_PORT = Number(process.env.SIGNALLING_PORT) || 5181;
/**
 * The dev server's own port, so the guard below has something to compare.
 * 5180 because the thirty-eight scripts in scripts/ all point at it.
 */
const DEV_PORT = 5180;
/**
 * Fail loudly rather than serve a page that cannot connect.
 *
 * If these two are ever the same number the proxy is a loop, and a loop is
 * invisible from inside the browser — which is the whole reason the bug above
 * survived as long as it did. One line at startup is worth an afternoon.
 */
if (SIGNALLING_PORT === DEV_PORT) {
  throw new Error(
    `SIGNALLING_PORT is ${SIGNALLING_PORT}, which is the dev server's own port — ` +
      '/api and /ws would proxy back to Vite and multiplayer would silently never ' +
      'connect. Set SIGNALLING_PORT to the port server/index.js listens on.'
  );
}

/**
 * IS THE PERFORMANCE INSTRUMENT IN THIS BUILD?
 *
 * `src/dev/perf/` is a measuring instrument bolted to the frame loop: it pins
 * the resolution, freezes the clock, drives `pipeline.render` outside rAF and
 * wraps batches of frames in GPU timer queries. None of that has any business
 * being downloaded by a player, so it is compiled out — and "compiled out" here
 * means the code is never in the bundle at all, not that a flag is false at
 * runtime.
 *
 * The mechanism is a `define` plus a DYNAMIC import behind `if (__PERF__)` in
 * main.js. esbuild folds `__PERF__` to the literal `false`, drops the dead
 * branch, and Rollup then has no reachable reference to the module — so the
 * chunk is never emitted. A static import would not do this: the module would
 * be inlined and only its unused *exports* shaken, which for a module that
 * exists to have side effects is nothing.
 *
 * Three build modes, and the middle one is the point:
 *
 *   npm run dev          __PERF__ true   — unminified, instrumented
 *   npm run build:perf   __PERF__ true   — MINIFIED, instrumented. What the perf
 *                                          suite measures, so the numbers come
 *                                          from production code paths rather
 *                                          than from dev-server module graph.
 *   npm run build        __PERF__ false  — what ships. Verified to contain none
 *                                          of it by `npm run check:perfstrip`.
 *
 * The flag is deliberately NOT `import.meta.env.DEV`: that would tie the
 * instrument to the dev server and make the middle mode impossible, and the
 * whole reason for the middle mode is that a dev build and a minified build do
 * not have the same shader compile behaviour or the same GC pressure.
 */
const PERF = process.env.RR_PERF === '1';

export default defineConfig(({ command }) => ({
  root: '.',
  define: {
    // `command === 'serve'` is `npm run dev`, where the instrument is always
    // available — that is what the console handle `RR.perf` is for.
    __PERF__: JSON.stringify(PERF || command === 'serve'),
  },
  server: {
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true,
    /**
     * `npm run go` points a Cloudflare quick tunnel at this port, and the
     * request arrives carrying `Host: <random-words>.trycloudflare.com`. Since
     * Vite 6 an unrecognised Host is answered with "Blocked request. This host
     * is not allowed." — a plain-text page, HTTP 200-shaped enough to look like
     * the tunnel is fine, so the failure lands entirely on the friend who was
     * sent the link and reads as "your game is broken".
     *
     * A leading dot allows the subdomains of that domain, which is the only
     * form that works here: the quick-tunnel hostname is minted fresh on every
     * run and cannot be listed ahead of time.
     */
    allowedHosts: ['.trycloudflare.com'],
    // Disabled so background edits don't reload/HMR the page out from under
    // a manual test session — refresh yourself when you want the changes.
    hmr: false,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${SIGNALLING_PORT}`,
        changeOrigin: false,
      },
      '/ws': {
        target: `ws://127.0.0.1:${SIGNALLING_PORT}`,
        ws: true,
        changeOrigin: false,
      },
    },
  },
  /**
   * The perf build is previewed on 5182, clear of the dev server on 5180 — the
   * thirty-eight scripts in scripts/ all point at 5180 and none of them should
   * ever accidentally measure or photograph a different build.
   */
  preview: {
    host: '127.0.0.1',
    port: PERF ? 5182 : 5183,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
    /**
     * The perf build goes to its own directory so it can never be mistaken for
     * the shipping one, and so `check:perfstrip` can hold both at once and
     * compare them. Without this, proving the instrument is absent from `dist/`
     * would mean building twice over the same folder and trusting the order.
     */
    outDir: PERF ? 'dist-perf' : 'dist',
  },
}));
