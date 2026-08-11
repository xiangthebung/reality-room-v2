import { createHmac } from 'node:crypto';

/**
 * Where the browser's ICE servers come from.
 *
 * Voice is a peer-to-peer mesh, so two people only ever hear each other if their
 * browsers can find a path between them. STUN alone finds one in most domestic
 * cases: it tells each side what its public address looks like from the outside,
 * and the two then punch a hole through their own routers. It fails on symmetric
 * NAT, on a lot of mobile carriers and on essentially every corporate firewall,
 * because those rewrite the port per destination so the address one peer learned
 * is not the address the other should send to. For those, TURN — a relay that
 * both sides can reach outbound — is the only answer.
 *
 * THE FAILURE MODE IS WHY THIS FILE EXISTS AT ALL. Without a relay, the affected
 * player joins the room, sees everyone walking about, and hears silence. Nothing
 * errors. Nothing logs. It looks exactly like everybody else being quiet, which
 * is the single hardest bug to report and the reason TURN is configured before
 * anyone outside your own network is invited rather than after they complain.
 *
 * Three sources, in priority order:
 *
 *   1. Cloudflare Realtime   CF_TURN_KEY_ID + CF_TURN_API_TOKEN
 *   2. coturn, ephemeral     TURN_URL + TURN_SECRET
 *   3. coturn, static        TURN_URL + TURN_USERNAME + TURN_CREDENTIAL
 *
 * THE API TOKEN NEVER LEAVES THIS PROCESS. A TURN credential is necessarily
 * handed to the browser — the browser is the thing that authenticates to the
 * relay — so whatever the browser holds is public the moment one player opens
 * devtools. That is survivable for a credential that expires in two hours and
 * catastrophic for the long-lived API token that can mint unlimited new ones on
 * your bill. Options 1 and 2 both exist to keep the long-lived secret on the
 * server and put only a short-lived derivative on the wire. Option 3 does not,
 * and is listed last for that reason.
 */

const DEFAULT_STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

const CF_ENDPOINT = 'https://rtc.live.cloudflare.com/v1/turn/keys';

/**
 * Two hours.
 *
 * Long enough that nobody's credential expires mid-conversation — a session that
 * outruns its TURN credential loses the relay on the next ICE restart, which is
 * the silent-voice failure again — and short enough that a leaked one is worth
 * very little. WebRTC only consults its ICE servers while a connection is being
 * established, so an expiry during a call is harmless right up until something
 * needs to renegotiate.
 */
const TURN_TTL_SECONDS = 60 * 60 * 2;

/**
 * Refresh at three quarters of the lifetime, not at the end of it.
 *
 * The refresh is a network call to a third party and it can fail. Starting half
 * an hour early means a failure has time for several retries before the cached
 * credential actually goes stale, so a Cloudflare blip never produces a window
 * in which new joiners get STUN only.
 */
const CF_REFRESH_RATIO = 0.75;
const CF_RETRY_MS = 60_000;
const CF_TIMEOUT_MS = 10_000;

function parseList(value, fallback) {
  if (!value) return fallback;
  const list = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : fallback;
}

export function createIceProvider(env = process.env) {
  const stunUrls = parseList(env.STUN_URLS, DEFAULT_STUN);
  const turnUrls = parseList(env.TURN_URL, []);
  const turnSecret = env.TURN_SECRET?.trim();
  const turnUsername = env.TURN_USERNAME?.trim();
  const turnCredential = env.TURN_CREDENTIAL?.trim();

  const cfKeyId = env.CF_TURN_KEY_ID?.trim();
  const cfToken = env.CF_TURN_API_TOKEN?.trim();

  const hasCloudflare = Boolean(cfKeyId && cfToken);
  const hasEphemeralTurn = turnUrls.length > 0 && Boolean(turnSecret);
  const hasStaticTurn = turnUrls.length > 0 && Boolean(turnUsername && turnCredential);

  /**
   * Minted once and cached, not once per player.
   *
   * The obvious implementation mints a fresh credential for each connection, and
   * it is wrong in two ways. It puts a round trip to a third-party API in the
   * critical path of every join — so if Cloudflare is slow, walking into the
   * forest is slow — and it turns a room of eight people reconnecting after a
   * server restart into eight simultaneous API calls, which is how you meet a
   * rate limit you did not know existed. One credential shared by everyone who
   * connects inside its window is no less short-lived; it is simply not
   * re-derived for each of them.
   */
  let cache = null;
  let timer = null;
  let lastError = null;

  async function refresh() {
    if (!hasCloudflare) return false;
    try {
      const response = await fetch(`${CF_ENDPOINT}/${cfKeyId}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
        signal: AbortSignal.timeout(CF_TIMEOUT_MS),
      });
      if (!response.ok) {
        // The body is the useful half of a Cloudflare error (a 401 says whether
        // the token is wrong or merely lacks the Realtime permission), but it is
        // also the half most likely to echo something sensitive, so it is
        // truncated rather than dumped.
        throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
      }
      const payload = await response.json();
      if (!Array.isArray(payload?.iceServers) || payload.iceServers.length === 0) {
        throw new Error('response contained no iceServers');
      }
      cache = { iceServers: payload.iceServers, fetchedAt: Date.now() };
      lastError = null;
      schedule(TURN_TTL_SECONDS * CF_REFRESH_RATIO * 1000);
      return true;
    } catch (err) {
      lastError = err?.message ?? String(err);
      console.error(`[ice] Cloudflare TURN mint failed: ${lastError}`);
      // Deliberately keeps serving the previous credential. A stale relay that
      // still has an hour on it beats no relay at all.
      schedule(CF_RETRY_MS);
      return false;
    }
  }

  function schedule(delayMs) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => refresh(), delayMs);
    timer.unref?.();
  }

  /**
   * @param {string} playerId only used by the coturn HMAC scheme, which bakes a
   *   name into the credential so a relay operator can see who is using it.
   */
  function getIceServers(playerId = 'guest') {
    // Cloudflare returns its own STUN alongside the relay, so ours would be
    // redundant paths for ICE to gather and then discard.
    if (hasCloudflare && cache) return cache.iceServers;

    const servers = [{ urls: stunUrls }];
    if (hasEphemeralTurn) {
      // coturn's REST convention with `use-auth-secret`: the username is
      // "<unix expiry>:<name>" and the password is the base64 HMAC-SHA1 of that
      // username under the shared secret. coturn recomputes it and checks the
      // expiry, so no state is shared between this process and the relay.
      const expiry = Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS;
      const username = `${expiry}:${playerId}`;
      const credential = createHmac('sha1', turnSecret).update(username).digest('base64');
      servers.push({ urls: turnUrls, username, credential });
    } else if (hasStaticTurn) {
      servers.push({ urls: turnUrls, username: turnUsername, credential: turnCredential });
    }
    return servers;
  }

  return {
    getIceServers,

    /** Called once at boot so the first arrival already has a relay in hand. */
    async prime() {
      if (hasCloudflare) await refresh();
    },

    describe() {
      if (hasCloudflare) {
        return cache
          ? 'Cloudflare Realtime TURN (short-lived, refreshed automatically)'
          : `Cloudflare TURN configured but UNAVAILABLE — ${lastError ?? 'not fetched yet'}`;
      }
      if (hasEphemeralTurn) return `STUN ×${stunUrls.length} + coturn (ephemeral credentials)`;
      if (hasStaticTurn) return `STUN ×${stunUrls.length} + TURN (static credentials)`;
      return `STUN ×${stunUrls.length} only — no relay, so anyone behind strict NAT will hear silence`;
    },

    get hasTurn() {
      return Boolean((hasCloudflare && cache) || hasEphemeralTurn || hasStaticTurn);
    },

    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
