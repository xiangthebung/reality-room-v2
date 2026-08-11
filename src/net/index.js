import * as THREE from 'three';
import { RoomSocket } from './socket.js';
import { PeerMesh } from './mesh.js';
import { Share } from './share.js';
import { Microphone, PeerVoice } from './voice.js';
import { Avatar } from '../player/avatar.js';
import { ScreenGlow, ShareScreen } from '../world/video-surface.js';
import { aimGround } from '../world/aim.js';
import { tripUniforms } from '../trip/living.js';
import { quality } from '../core/quality.js';
import { worldHearsKey } from '../core/keys.js';
import { worldSeed } from '../core/world-seed.js';
import { adoptWorldAge } from '../core/world-clock.js';
import { dayOrigin, setDayOrigin } from '../world/daylight.js';
import { cleanHue, cleanName, playerHue, playerName, setPlayerHue, setPlayerName } from '../core/identity.js';
import {
  FLAG_GROUNDED,
  FLAG_MOVING,
  FLAG_MUTED,
  FLAG_PRESENTING,
  FLAG_SPEAKING,
  TICK_MS,
  decodeRow,
  hueOf,
  sanitizePlacement,
} from './protocol.js';

/**
 * Other people in the forest.
 *
 * ┌── this file ──────────────────────────────────────────────────────────┐
 * │  socket.js   membership, signalling relay, 18 Hz transforms, chat     │
 * │  mesh.js     one RTCPeerConnection each: voice, screen, screen sound  │
 * │  voice.js    the microphone chain, and a PannerNode per person        │
 * │  share.js    getDisplayMedia, films dropped on the window, and where  │
 * │              a screen is standing                                     │
 * │  avatar.js   a body, replayed two ticks behind live                   │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * SCREENS ARE OBJECTS NOW, WHICH DELETED A WHOLE CATEGORY OF PROBLEM.
 *
 * There used to be exactly one fourteen-metre screen, bolted to one clearing,
 * and this file arbitrated it: a monotonic claim counter, a most-recent-wins
 * rule, a rule for the claimant who left without retracting, a rule for the
 * person displaced, and a full recompute after every event because the events
 * arrive out of order and some go missing. Sixty lines to decide which of eight
 * people got the one piece of furniture.
 *
 * A share is now a screen its owner stands where they like, at whatever size
 * fits the clearing, and every one of those rules is gone with it — because
 * there is nothing to arbitrate. Two screens in a clearing is the same situation
 * as two people in a clearing, and the world has always allowed that. What is
 * left is one `ShareScreen` per person who is sharing and a recompute that just
 * reads the roster.
 *
 * There was briefly a middle stage — a share began in your hands and `O` put it
 * down — and it is gone at the user's request. The deletion is worth as much as
 * the first one: a screen is now somewhere, always, so there is no per-frame
 * work to position one, no second body-relative coordinate system, and no state
 * in which a peer's screen exists but its location has to be inferred from an
 * avatar two ticks behind live.
 *
 * This file still does not know anything about the world it is putting screens
 * in, with one exception it cannot avoid: `aimGround`, so a screen stands on the
 * ground instead of in it. That is the whole of its geography, and it is now one
 * import rather than a terrain march written out here — `world/aim.js` owns it,
 * because the speakers are placed by the same gesture and the rule for how far
 * in front of you a thing may land is about arms and eyesight rather than about
 * screens.
 *
 * THE GOVERNING CONSTRAINT: THIS IS A SINGLE-PLAYER GAME THAT SOMETIMES HAS
 * OTHER PEOPLE IN IT.
 *
 * Nothing here may block, delay or break a walk in the woods. There is no lobby,
 * no sign-in and no connecting screen, and — the part that took the most care —
 * **nothing on this path touches the network at all unless it was asked to.**
 * With no `?room=` in the URL and no key pressed, `attachMultiplayer` builds a
 * few objects, wires four key handlers and returns; there is no socket, no
 * fetch, no retry timer and nothing to time out. That is stronger than "handles
 * the server being down", because a failure that is never attempted cannot have
 * a slow path, a console error, or a state you can get stuck in.
 *
 * When it *is* asked to, every remaining failure — no server, refused
 * connection, full room, no microphone, no permission — ends in exactly the same
 * place: no peers, one quiet line of HUD text, and a forest that carries on.
 *
 * AUDIO ARRIVES LATE, AND THAT IS NORMAL. `attachMultiplayer` is called during
 * module evaluation in main.js, and the AudioContext does not exist until
 * somebody clicks "Enter the forest" — a browser will not start one before a
 * gesture. So the socket, the mesh and the avatars all come up without audio,
 * and the voice half attaches itself the first frame `audio.ready` turns true.
 * You can see people walking about before you can hear them, which is the right
 * order for something you might be watching through a window before you commit.
 */

const KEY_TALK = 'KeyV';
const KEY_MUTE = 'KeyX';
const KEY_MODE = 'KeyC';
const KEY_JOIN = 'KeyJ';
/** Start sharing a screen, or stop. */
const KEY_SHARE = 'KeyP';
/** Move the screen to the patch of ground you are looking at. */
const KEY_PLACE = 'KeyO';

/**
 * How often a resize is allowed to reach the room, in milliseconds.
 *
 * A wheel produces events as fast as the mouse can send them and the screen has
 * to follow every one of them LOCALLY — a resize that lags the wheel is not a
 * resize, it is a stutter. Nobody else needs that fidelity: they need to end up
 * with the right screen. So the local object is written on every event and the
 * room is told on a trailing timer, which turns a hundred messages into six and
 * is invisible at the far end because the last one is always correct.
 */
const RESIZE_ANNOUNCE_MS = 160;

/**
 * Who you are now lives in `core/identity.js`, and the move is not cosmetic.
 *
 * The name used to be invented right here, at module-evaluation time — which is
 * before the main menu has been drawn, let alone typed into. Anything the player
 * chose afterwards was chosen too late to reach this file. Reading the identity
 * at JOIN time instead means the menu, the invite link and the J key all arrive
 * at the same answer, and `identify()` below covers the one case that is still
 * later than that: changing your mind while already in a room.
 */

/**
 * @param {object} deps
 * @param {THREE.Scene} deps.scene
 * @param {THREE.PerspectiveCamera} deps.camera
 * @param {import('../player/controller.js').Controller} deps.controller
 * @param {import('../audio/engine.js').AudioEngine} deps.audio may not be started yet
 * @param {import('../ui/hud.js').Hud} deps.hud only ever used for toast()
 * @returns {{update(dt: number): void, dispose(): void, peers: object[]}}
 */
export function attachMultiplayer({ scene, camera, controller, audio, hud }) {
  const say = (text, ms) => {
    try {
      hud?.toast?.(text, ms);
    } catch {
      /* the HUD is decoration; never let it take the net layer down */
    }
  };

  /**
   * @type {Map<string, {avatar: Avatar, voice: PeerVoice|null, screen: ShareScreen|null,
   *   present: import('./protocol.js').Placement|null}>}
   */
  const people = new Map();

  /**
   * 1 at noon, 0 at midnight. Pushed in by main.js; see `setDaylight`.
   *
   * A screen with nothing on it yet is painted canvas rather than a switched-off
   * television (see video-surface.js), and painted canvas has to know what time
   * it is or it is a glowing white slab in the dark. The old panel never got
   * told, which barely showed because a panel appeared and went live in the same
   * second. A PLACED screen can stand empty in a clearing for as long as its
   * owner takes to find the right window, and at night that was a lamp.
   */
  let daylight = 1;

  /**
   * Where the log goes, and why this layer does not own it.
   *
   * Chat is a UI concern and `src/ui/social.js` draws it, so this module holds a
   * list of subscribers rather than a DOM node — which is what keeps
   * `attachMultiplayer` testable from `server/test/two-player.mjs`, where there
   * is no chat panel and the assertion is about what arrived.
   */
  const listeners = new Set();
  /**
   * Subscribers to the speakers moving, kept apart from the chat listeners
   * above for the same reason those exist at all: this module must not know
   * what a speaker is. `main.js` subscribes and does the moving. See
   * `onSpeakers`.
   */
  const speakerListeners = new Set();
  /** Subscribers to the jukebox changing. Same boundary argument as above. */
  const musicListeners = new Set();
  /** Subscribers to a mushroom being eaten. Same boundary argument again. */
  const eatListeners = new Set();
  const emitSpeakers = (at) => {
    for (const fn of speakerListeners) {
      try {
        fn(at);
      } catch (err) {
        console.warn('[net] speaker listener threw', err);
      }
    }
  };
  const emitMusic = (state) => {
    for (const fn of musicListeners) {
      try {
        fn(state);
      } catch (err) {
        console.warn('[net] music listener threw', err);
      }
    }
  };
  const emitEat = (id) => {
    for (const fn of eatListeners) {
      try {
        fn(id);
      } catch (err) {
        console.warn('[net] eat listener threw', err);
      }
    }
  };
  const emit = (event) => {
    for (const fn of listeners) {
      try {
        fn(event);
      } catch (err) {
        console.warn('[net] chat listener threw', err);
      }
    }
  };

  let socket = null;
  let mesh = null;
  /** @type {Microphone|null} */
  let mic = null;
  let micRequested = false;
  let status = 'off'; // off | joining | live | alone
  let sendAccumulator = 0;
  let disposed = false;
  /** Set from outside each frame. See the note where it is used. */
  let poseFlags = 0;

  const _head = new THREE.Vector3();
  const _forward = new THREE.Vector3();

  /**
   * What this machine is showing everybody else.
   *
   * Built unconditionally, like everything else here, and it touches nothing
   * until somebody asks it to: constructing a `Share` allocates one small object
   * and reads no device. `getDisplayMedia` is only reached from a key press.
   */
  const share = new Share({
    publish: (video, audioTrack) => mesh?.setShareTracks(video, audioTrack),
    /**
     * The only geography this layer hands out, and the only geography `share.js`
     * is allowed to know: a patch of ground, on demand. `world/aim.js` does the
     * march; the body it marches from is the one thing this closure has that the
     * module cannot know.
     */
    where: () => aimGround(controller),
    announce: (at) => {
      socket?.sendPresent(at);
      /**
       * Show yourself your own share, immediately, without waiting to hear it
       * back from the server.
       *
       * This is the one place the optimistic path is right: it is your own
       * screen and there is no ordering question, and a round trip's delay
       * between pressing the key and seeing anything appear is exactly long
       * enough to make a person press it again.
       *
       * Only the local screen, not the whole routing. Under the old wall this
       * had to recompute everybody, because claiming the big screen displaced
       * whoever had it; nothing you do to your own screen can now affect
       * anybody else's, so there is nothing else to recompute.
       */
      applyLocalScreen();
    },
    say,
  });

  /**
   * The screen that shows your own share back to you.
   *
   * Made lazily, because most sessions never share anything and a `<video>`
   * element plus a texture is not free. It is the same object everybody else
   * sees, standing in the same place at the same size — which is the cheapest
   * possible way to know what you are actually transmitting, and the reason
   * there is no preview window anywhere in this project.
   *
   * @type {ShareScreen|null}
   */
  let selfScreen = null;
  /** Trailing timer for wheel resizes. See RESIZE_ANNOUNCE_MS. */
  let resizeTimer = 0;

  /**
   * Whether your own shared screen is played back to you from the world.
   *
   * A preference rather than a fact about the stream, so the decision lives in
   * the settings registry and this is only where its value comes to rest. What
   * it costs and why it is off by default is on the knob in core/quality.js;
   * the one line it changes is `localShareAudio` below.
   *
   * REGISTERING APPLIES IT IMMEDIATELY, which is the only way a choice made in
   * a previous session reaches this variable at all — `register` pushes the
   * current value into a setter the moment the knob is claimed. The
   * `applyLocalScreen` call that follows is a no-op until something is being
   * shared, so it costs nothing at startup, and afterwards it is the whole of
   * the live path: flipping the switch mid-share re-runs `setTracks`, which
   * binds or unbinds the audio node and leaves the picture alone. Nobody has to
   * stop sharing and start again to change their mind.
   */
  let hearOwnShare = false;
  const unregisterHearOwnShare = quality.register('hearOwnShare', (on) => {
    hearOwnShare = Boolean(on);
    applyLocalScreen();
  });

  /**
   * The light every screen in the room throws, which is one light.
   *
   * BUILT NOW, WHEN NOTHING IS BEING SHARED AND MOST SESSIONS NEVER WILL BE, and
   * that is the whole reason it is here rather than beside the lazy
   * `ShareScreen` construction it belongs with. `attachMultiplayer` is called
   * from main.js well before the shader pre-warm; a `PointLight` reaching the
   * scene after that point changes `NUM_POINT_LIGHTS` and invalidates the
   * compiled program of every material in the world. See the class.
   */
  const screenGlow = new ScreenGlow();
  scene.add(screenGlow.light);

  /**
   * Every screen currently drawn, rebuilt from scratch each frame for the glow.
   *
   * Reused rather than allocated, and recomputed rather than maintained: the
   * list is at most eight entries and the events that would have to patch it —
   * a share starting, a placement arriving, somebody leaving — are the same ones
   * `routeShares` refuses to patch incrementally, for the same reason. A stale
   * entry here is a light standing at a disposed screen.
   */
  const drawnScreens = [];

  // ------------------------------------------------------------------- rooms

  function roomInUrl() {
    try {
      return new URLSearchParams(location.search).get('room');
    } catch {
      return null;
    }
  }

  /**
   * The invitation, which has to carry the WORLD as well as the room.
   *
   * A room code alone is not enough now that every session gets its own forest.
   * Rooms are minted lazily — nothing touches the network until somebody presses
   * J — so by the time a code exists the host has been walking around their
   * world for minutes, and there is no way to derive that world from a code
   * invented afterwards. Send the seed with it and the guest builds the same
   * wood before they ever open a socket.
   *
   * Without this the failure is quiet and horrible: two people in one room, each
   * in a different forest, their avatars walking through trees that are not
   * there and standing at the wrong height on identical coordinates. Nothing
   * errors. It just looks like the netcode is broken.
   *
   * See `src/core/world-seed.js` for why the seed lives in the URL rather than
   * being derived from the room code.
   */
  function inviteUrl(code) {
    const url = new URL(location.href);
    url.searchParams.set('room', code);
    url.searchParams.set('seed', worldSeed());
    url.hash = '';
    return url.toString();
  }

  /**
   * Ask the server for a fresh invite code.
   *
   * Minted server-side rather than rolled here so both halves agree on the
   * alphabet — the code has to survive being read aloud, which is a property of
   * `server/rooms.js` and would silently drift if two implementations existed.
   * It doubles as the liveness probe: if this fetch does not come back, there is
   * no point opening a socket, and the user gets one line instead of a retry
   * loop they cannot see.
   */
  async function mintRoom() {
    try {
      const response = await fetch('/api/room', { cache: 'no-store' });
      if (!response.ok) return null;
      const body = await response.json();
      return typeof body?.room === 'string' ? body.room : null;
    } catch {
      return null;
    }
  }

  /**
   * Open a socket onto a room.
   *
   * The identity is read HERE rather than when this module was evaluated, which
   * is the whole reason the main menu can affect anything: the world is built
   * during module evaluation and the menu is typed into long afterwards. By the
   * time anybody joins — a key press, a click through the gate, or an invite link
   * the moment the page settles — `playerName()` and `playerHue()` are whatever
   * the player last decided.
   *
   * The seed goes with them so the room can learn which forest it is. See
   * `RoomSocket.url` and the note on `Room.seed` in server/rooms.js.
   */
  function join(code) {
    if (disposed || socket) return;
    status = 'joining';
    socket = new RoomSocket({
      room: code,
      name: playerName(),
      hue: playerHue(),
      seed: worldSeed(),
      /**
       * What hour this session is having, as an age. A thunk, not a value: the
       * URL is rebuilt on every reconnect attempt and the answer has moved by
       * however long the socket was down. See `RoomSocket.url`.
       */
      dayAge: () => {
        const origin = dayOrigin();
        return origin === 0 ? null : Date.now() - origin;
      },
    });
    mesh = new PeerMesh({ socket });
    wire();
    socket.connect();
  }

  /**
   * Go into a room, and make the address bar the invitation to it.
   *
   * Split out of `toggleRoom` so the main menu can hand over a code it already
   * has. The menu mints its own — it shows the player the code before they enter,
   * which means it has to exist before this is called — and the two paths must
   * not differ in what happens afterwards: the URL becomes true, the socket
   * opens, and the link is on screen and on the clipboard.
   */
  function openRoom(code) {
    if (!code || socket) return false;
    if (roomInUrl() !== code) {
      // The URL *is* the invitation, so it has to be true before anyone copies
      // it. replaceState rather than pushState: joining a room is not a page
      // the back button should return from.
      history.replaceState(null, '', inviteUrl(code));
    }
    join(code);
    const link = inviteUrl(code);
    say(`Others can find you at ${link}`, 9000);
    // Best effort and deliberately silent. Both callers are inside a user
    // gesture — a key press or the click through the gate — so this is allowed;
    // if the browser or the permission says no, the link is still on screen.
    navigator.clipboard?.writeText?.(link).catch(() => {});
    return true;
  }

  async function toggleRoom() {
    if (socket) {
      leave();
      status = 'off';
      say('You are on your own again.');
      return;
    }
    const code = roomInUrl() ?? (await mintRoom());
    if (!code) {
      say('Nobody answers. The wood is yours alone.', 5000);
      return;
    }
    openRoom(code);
  }

  /**
   * Tear the room down. Deliberately does NOT set `status`, because the two
   * callers mean different things by it — walking out on purpose is 'off' and
   * discovering there is no server is 'alone' — and having this function pick
   * one silently overwrote the other for an afternoon.
   */
  function leave() {
    socket?.close();
    mesh?.dispose();
    socket = null;
    mesh = null;
    for (const id of [...people.keys()]) forget(id);
    /**
     * The microphone is released too, not merely disconnected.
     *
     * Nothing would be transmitted either way — the mesh is gone — but the
     * browser keeps its "this tab is recording you" indicator lit for as long
     * as a live capture exists, and leaving that on after somebody has walked
     * out of a room is exactly the sort of thing that makes a person never open
     * the page again.
     */
    mic?.close();
    mic = null;
    micRequested = false;
  }

  // ------------------------------------------------------------------ people

  function remember(peer) {
    if (people.has(peer.id) || peer.id === socket?.selfId) return;
    // `h` is the dye they chose, and is absent for anybody who never opened the
    // menu — which `Avatar` resolves through `hueOf` into the colour their id
    // gives them. See the note on `Player.hue` in server/rooms.js.
    const avatar = new Avatar({ id: peer.id, name: peer.name, hue: peer.h });
    if (Array.isArray(peer.p)) {
      avatar.push({
        x: peer.p[0],
        y: peer.p[1],
        z: peer.p[2],
        yaw: peer.r?.[0] ?? 0,
        pitch: peer.r?.[1] ?? 0,
        voice: 0,
        trip: 0,
        flags: peer.f | 0,
      });
    }
    scene.add(avatar.group);
    /**
     * The roster carries `present` for anybody who was already sharing when we
     * arrived — see the note on `Player.present` in server/rooms.js. Without
     * this, walking into a room where a film is already on gives you a blank
     * clearing and four people watching it.
     *
     * Sanitised on the way in even though the server sanitises on the way out.
     * The cost is a handful of `Number.isFinite` calls once per arrival, and
     * what it buys is that a placement can never reach a matrix as NaN — which
     * does not fail loudly, it propagates into the projection and takes the
     * whole frame black.
     */
    const entry = {
      avatar,
      voice: null,
      screen: null,
      present: sanitizePlacement(peer.present),
    };
    people.set(peer.id, entry);
    attachVoice(peer.id, entry);
    mesh?.connect(peer.id);
    if (entry.present) routeShares();
  }

  /**
   * Somebody has gone, and so has their screen.
   *
   * A PLACED SCREEN LEAVES WITH ITS OWNER even though it is standing on the
   * ground and nobody is holding it, and that is the one place this design has
   * to say no to the obvious thing. A screen that outlived the person sharing it
   * would be a rectangle in a clearing with no pixels arriving at it, that
   * nobody in the room can move or clear, for the rest of the evening — the
   * WebRTC track died with the connection, so there is nothing to show on it and
   * no owner left to take it away.
   */
  function forget(id) {
    const entry = people.get(id);
    if (!entry) return;
    entry.voice?.dispose();
    entry.screen?.dispose();
    entry.avatar.dispose();
    people.delete(id);
    mesh?.disconnect(id);
  }

  /**
   * Give a person a voice, if there is an audio graph yet to hang one on.
   *
   * Called from three places — when somebody joins, when their track arrives,
   * and on the first frame after the AudioContext starts — because those three
   * can happen in any order and the one that happens last is the one that has
   * to do the work.
   */
  function attachVoice(id, entry = people.get(id)) {
    if (!entry || !audio?.ready) return;
    if (!entry.voice) {
      entry.voice = new PeerVoice(audio, entry.avatar.headWorldPosition(_head));
    }
    const track = mesh?.tracks.get(id);
    if (track) entry.voice.setTrack(track);
  }

  // ------------------------------------------------------------------ screens

  /**
   * Give everybody who is sharing a screen, and point their picture at it.
   *
   * Recomputed from scratch whenever anything changes rather than patched
   * incrementally. There are at most eight sources, so "work out the whole
   * answer again" is a few dozen operations and it cannot drift — which the
   * incremental version demonstrably can, because the events that drive it (a
   * track arriving, a placement announcement, somebody leaving) arrive in any
   * order and some of them go missing.
   *
   * A SCREEN IS ONLY EVER DESTROYED BY ITS OWNER LEAVING. Moving one, resizing
   * it and stopping the share all leave the object alive — the first two are a
   * transform on it (see the note on `ShareScreen`) and the last merely hides
   * it. That is deliberate on both counts: a placement change must not throw
   * away a decoder in the middle of whatever the room was watching, and somebody
   * who stops and starts again a minute later should not pay to build one twice.
   * A hidden screen costs nothing per frame — `update` is not even called on it,
   * and `_maybeUpload` would refuse anyway.
   */
  function routeShares() {
    for (const [id, entry] of people) {
      if (!entry.present) {
        entry.screen?.setPlacement(null);
        entry.screen?.setTracks(null, null);
        continue;
      }
      if (!entry.screen) {
        entry.screen = new ShareScreen();
        entry.screen.attachAudio(audio);
        entry.screen.setDaylight(daylight);
        scene.add(entry.screen.group);
      }
      entry.screen.setPlacement(entry.present);
      entry.screen.setTracks(
        mesh?.shareVideo.get(id) ?? null,
        mesh?.shareAudio.get(id) ?? null,
        id
      );
    }

    applyLocalScreen();
  }

  /**
   * Your own soundtrack, and the one case where the world is allowed to play it
   * back to you.
   *
   * A FILM'S ELEMENT IS MUTED HERE ON PURPOSE (see `startFile`), so the world is
   * the only place its sound exists and you must hear it from your own screen or
   * not at all. A shared SCREEN is the opposite: capturing a tab does not
   * silence it, and the thing you are showing carries on playing out of your own
   * speakers the entire time — so routing that track here too would arrive at
   * your ears twice, once flat and immediate from the operating system and once
   * through an HRTF panner a few metres away with the room send on it. The
   * second copy is late by the graph's latency plus the convolution, and later
   * in one ear than the other, because that is precisely what an HRTF is for. It
   * does not read as a doubled sound. It reads as an echo off to one side.
   *
   * Everyone else hears both kinds from the screen either way: their copy comes
   * over the network and their speakers are not playing your tab.
   *
   * THIS USED TO BE KEYED ON THE BIG SCREEN and silently swallowed a film you
   * had not put there. A film on your own panel got no audio at all, on a rule
   * written as "you hear your own share only from the big screen, where the
   * element genuinely is silent" — true of a film wherever it is, and the reason
   * a dropped film was silent in any world that had no commons. The rule is
   * about the SOURCE, not about the surface, which is why it survived both
   * rewrites of the surface without changing.
   *
   * AND IT IS NOW A RULE WITH AN OFF SWITCH, at the player's request. The echo
   * above is a consequence of your tab still playing out of your own speakers,
   * and muting the tab at source deletes it — leaving one copy, coming from the
   * screen, which is the copy everybody else has. That is a real thing to want:
   * it is the only way to hear whether your soundtrack is actually going out,
   * and it puts you in the same clearing as the people you are showing it to.
   *
   * The app cannot mute your tab for you and has no way to tell that you have,
   * so it cannot make this safe — it can only stop deciding for you. Hence a
   * setting that is off by default and says on the tin what it costs. See the
   * `hearOwnShare` knob in core/quality.js.
   *
   * A FILM IS UNCONDITIONAL EITHER WAY. Its element is muted by construction, so
   * there is no second copy for the switch to be about, and gating it behind one
   * would only recreate the silent-dropped-film bug the paragraph above is about.
   */
  function localShareAudio() {
    if (share.kind === 'film') return share.audioTrack;
    return hearOwnShare ? share.audioTrack : null;
  }

  /** Your own share, on your own screen, wherever you have put it. */
  function applyLocalScreen() {
    if (!share.active) {
      selfScreen?.setPlacement(null);
      selfScreen?.setTracks(null, null);
      return;
    }
    if (!selfScreen) {
      // Prefixed rather than a different word, so main.js's `screens` isolate
      // switch catches yours and everybody else's with one `startsWith`.
      selfScreen = new ShareScreen({ name: 'share-screen:own' });
      selfScreen.attachAudio(audio);
      selfScreen.setDaylight(daylight);
      scene.add(selfScreen.group);
    }
    selfScreen.setPlacement(share.placement);
    selfScreen.setTracks(share.videoTrack, localShareAudio(), socket?.selfId ?? 'you');
  }

  /* ------------------------------------------------------------ putting it down */

  /**
   * Move the screen to the patch of ground you are looking at.
   *
   * ONE VERB, AND IT USED TO BE THREE. This was a toggle — put down, pick up,
   * put down again — because a share started in your hands. With the held stage
   * gone there is nothing to toggle between: the screen is somewhere, and this
   * makes it somewhere else. Pressing it where the screen already is is a no-op
   * that costs one placement message, which is the correct amount of ceremony
   * for a key you can press by accident.
   */
  function moveScreen() {
    if (!share.active) {
      say('No screen to move. <kbd>P</kbd> puts one up.', 4000);
      return;
    }
    share.place(aimGround(controller));
    say(`Screen here, ${share.width.toFixed(1)} m across. Scroll to resize.`, 5200);
  }

  /** Make the screen bigger or smaller. */
  function onWheel(event) {
    if (!share.active) return;
    /**
     * ONLY WHEN THE WHEEL IS OVER THE WORLD, and the test is what the event
     * landed on rather than a list of panels to exclude.
     *
     * `#ui` is `pointer-events: none`, so a wheel over the forest arrives with
     * the canvas or the document as its target; anything else means the pointer
     * was over a piece of chrome that asked for events — the settings body and
     * the debug panel both scroll, and both are `pointer-events: auto`. This
     * handler calls `preventDefault`, so without the test a share being up made
     * those two panels unscrollable, with the screen quietly resizing behind
     * them instead. Stating it as "was this over the world" rather than naming
     * the two panels means the next scrollable thing anybody adds is already
     * handled.
     */
    const over = event.target;
    if (
      over !== document.body &&
      over !== document.documentElement &&
      !(over instanceof HTMLCanvasElement)
    ) {
      return;
    }
    /**
     * `deltaMode` is not always pixels — a Firefox mouse wheel reports LINE and
     * a page-scroll gesture reports PAGE, and taking the raw number in all three
     * cases makes the same wheel a hundred times weaker on one browser.
     */
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
    /**
     * About 10% per notch, which is roughly a browser's zoom step and puts the
     * whole 1.2–16 m range at some twenty-seven of them — two flicks of a wheel.
     *
     * The first version used twice this and crossed the entire range in eight
     * notches, which is not a size control, it is a switch between "tiny" and
     * "enormous" with nothing usable in between: a single flick of a free-
     * spinning wheel took a screen from a metre to the clamp.
     */
    if (!share.resize(Math.exp(-event.deltaY * unit * 0.0008))) return;
    event.preventDefault();
    applyLocalScreen();
    if (!resizeTimer) {
      resizeTimer = setTimeout(() => {
        resizeTimer = 0;
        share.reannounce();
      }, RESIZE_ANNOUNCE_MS);
    }
  }

  // ----------------------------------------------------------------- signals

  function wire() {
    socket.on('welcome', (msg) => {
      status = 'live';
      /**
       * Start from nothing every time, including on a reconnect.
       *
       * A reconnect gets a brand-new player id from the server, so every peer
       * connection we were holding is addressed by an id that nobody in the
       * room recognises any more, and the polite/impolite roles in mesh.js were
       * derived from the id we no longer have. Reconciling that is possible and
       * pointless; tearing down and rebuilding from the fresh roster costs one
       * renegotiation and cannot be subtly wrong.
       */
      for (const id of [...people.keys()]) forget(id);
      for (const peer of msg.peers ?? []) remember(peer);
      /**
       * Re-announce your own share.
       *
       * A reconnect gets a brand-new player id and the server has no memory of
       * the one that dropped, so a person who was mid-film comes back as
       * somebody the room has never heard of — with a video track flowing and
       * nothing to say what it is for. One message fixes it, and sending it
       * unconditionally is right: `present` is idempotent server-side and the
       * common case is null, which the server drops.
       */
      if (share.active) socket.sendPresent(share.placement);
      const others = msg.peers?.length ?? 0;
      say(
        others === 0
          ? `Room ${msg.room}. Nobody here yet.`
          : `Room ${msg.room}. ${others === 1 ? 'Someone is' : `${others} people are`} already out there.`,
        6000
      );
      /**
       * THE BACKSTOP FOR BEING IN THE RIGHT ROOM AND THE WRONG WOOD.
       *
       * A forest is built during module evaluation, so by the time this message
       * arrives it is far too late to fix — which is exactly why it is worth
       * saying out loud. Two people in one room with two different seeds walk
       * through each other's trees and stand at different heights on identical
       * coordinates, and nothing throws: it simply looks like the netcode is
       * broken, and it has cost this project hours before.
       *
       * The main menu asks `/api/room/peek` before it ever opens a socket and
       * arrives already in the right wood, so this should never fire for anybody
       * who typed a code. It is here for the J key, which mints a room out of a
       * world that already exists, and for a link somebody edited by hand.
       *
       * A line of text rather than a reload. Reloading would throw away whatever
       * the player was doing on the strength of a mismatch they may not care
       * about — they can see each other, they can talk — and the address is the
       * whole fix, so it is handed over rather than acted on.
       */
      const sameWood = !msg.seed || msg.seed === worldSeed();
      if (!sameWood) {
        say(
          `You are in room ${msg.room} but a different wood. Open <b>?room=${msg.room}&seed=${msg.seed}</b> to stand in theirs.`,
          12_000
        );
      }

      /**
       * ADOPT THE ROOM'S CLOCK AND ITS HOUR.
       *
       * Unlike the seed above, both of these ARE fixable from here, and that is
       * the whole reason they are numbers rather than choices. A forest is
       * geometry built once during module evaluation; a clock is an argument
       * every animation is re-evaluated against on the next frame. So a seed
       * mismatch can only be reported, and these two simply take effect — the
       * water and the wind step once, silently, and from then on this client is
       * in the same weather as everybody else.
       *
       * Both arrive as AGES rather than instants so that two machines with
       * different ideas of what time it is still land on the same world. See
       * `adoptWorldAge` and `sanitizeDayAge`.
       */
      adoptWorldAge(msg.clockElapsedMs, msg._at);

      /**
       * And where the furniture is — INCLUDING WHEN THE ANSWER IS NOWHERE.
       *
       * `null` is passed on rather than swallowed, because it is a question as
       * much as an answer: it says the room has no opinion about the speakers,
       * which is the one moment a client that has moved its own should teach
       * the room where they are.
       *
       * That case is not exotic. Stand a speaker somewhere on a solitary walk,
       * then press `J` to open a room — without this the room starts empty of
       * furniture, and the first guest walks into a clearing where the music is
       * coming from somewhere the host cannot see. It is the same rule the seed
       * follows one screen up: the first person in teaches the room the world
       * they are already standing in.
       */
      emitSpeakers(msg.speakers ?? null);
      /**
       * And what is on the jukebox — WITH THE ABSENT CASE LEFT ABSENT.
       *
       * `msg.music` is passed through undefined rather than normalised to null,
       * because the two mean opposite things and the difference decides whether
       * a clearing has music in it:
       *
       *   undefined   the room has no opinion. Nobody has touched the jukebox
       *               since it opened, so whoever is arriving should start
       *               their default record and TEACH the room what is on.
       *   null        somebody turned the music off. Arriving into that must
       *               not start it again for the seven people who wanted quiet.
       *
       * Collapsing them made the first person into every room silence
       * themselves: the room legitimately had nothing to say, the client read
       * that as "silence, deliberately", and stopped a record that had not
       * started yet. Same three-state distinction as `pendingMusic` in main.js,
       * one layer further out.
       */
      emitMusic(msg.music);
      /**
       * And which mushrooms are already gone.
       *
       * REPLAYED ONE AT A TIME rather than handed over as a list, so that the
       * arrival path and the somebody-just-ate-one path are the same line of
       * code on the far side of this boundary. There is no ordering to preserve
       * and no state to reconcile — eating is cumulative and idempotent, which
       * is what lets a whole history be caught up on by replaying it at all.
       *
       * THE ONLY FIELD IN THIS MESSAGE GATED ON THE SEED, and the only one that
       * needs to be. A patch id names a place in a particular wood — `under:2,-2`
       * is a sector of the grid, and what grows there is a function of the seed.
       * Everything else here survives a mismatch, because a clock is a clock and
       * an hour is an hour whatever forest you are standing in; replaying these
       * into the wrong one would clear mushrooms at random, off a list that only
       * grows, in a session that is already confusing enough. So it travels in
       * neither direction until the two woods are the same wood.
       */
      if (sameWood) {
        for (const id of msg.eaten ?? []) emitEat(id);
        /**
         * Then `null`, meaning THAT WAS ALL OF THEM — tell me anything I missed.
         *
         * The same convention `emitSpeakers(null)` uses one screen up, for the
         * same case: somebody who ate mushrooms before there was a room to tell.
         * Press `J` after a solitary walk and the forest you are standing in
         * becomes the room's forest, seed and all, so the patches cleared on that
         * walk are real patches in everybody's world — and without this they are
         * the one part of it that does not travel, standing again for the first
         * guest while the person who ate them looks at bare ground.
         *
         * Sent whatever the list held rather than only when it was empty, because
         * the two sets can both be non-empty and disjoint: you ate three on the
         * way here and the room has eaten five of its own.
         */
        emitEat(null);
      }
      /**
       * Null means the room is on the true wall clock, and `setDayOrigin(0)` is
       * how that is expressed — not "leave it alone". A guest who picked dusk
       * in the menu and joined a room that did not has to be moved onto the
       * shared default, or the two of them are in one wood at two hours, which
       * is the failure this whole path exists to prevent.
       */
      setDayOrigin(
        msg.dayAgeMs === null || msg.dayAgeMs === undefined
          ? 0
          : (msg._at ?? Date.now()) - msg.dayAgeMs
      );
    });

    /**
     * A better estimate of the room's clock than `welcome` could give.
     *
     * `welcome` anchors it approximately, so the world is roughly right from
     * the first frame; this corrects it once the page is idle enough for a
     * round trip to be honest. The correction is a step rather than a slew,
     * which is affordable because of when it lands: a few seconds after
     * arriving, while you are still getting your bearings, and worth at most
     * the second of wave phase that the load block cost. See the `pong` case in
     * socket.js for why only the best round trip is allowed to move it.
     */
    socket.on('clock', (msg) => adoptWorldAge(msg.elapsed));

    /** Somebody moved the speakers. `main.js` owns what that means. */
    socket.on('speakers', (msg) => emitSpeakers(msg.at));

    /** Somebody changed the record. `main.js` owns what that means. */
    socket.on('music', (msg) => emitMusic(msg.state ?? null));

    /** Somebody ate a mushroom. `main.js` owns which one that is. */
    socket.on('eat', (msg) => emitEat(msg.id));

    socket.on('join', (msg) => {
      remember(msg.peer);
      say(`${msg.peer.name} is here somewhere.`);
    });

    socket.on('leave', (msg) => {
      const gone = people.get(msg.id)?.avatar.name;
      forget(msg.id);
      if (gone) say(`${gone} has gone.`);
    });

    socket.on('look', (msg) => people.get(msg.id)?.avatar.setLook(msg.name, msg.hue));

    socket.on('S', (msg) => {
      if (!Array.isArray(msg.d)) return;
      for (const row of msg.d) {
        const sample = decodeRow(row);
        if (sample.id === socket.selfId) continue;
        // A row for somebody we were never told about: the join message and the
        // first tick can race, and the tick is the one carrying real data.
        let entry = people.get(sample.id);
        if (!entry) {
          remember({ id: sample.id, name: 'Someone', p: [sample.x, sample.y, sample.z] });
          entry = people.get(sample.id);
          if (!entry) continue;
        }
        entry.avatar.push(sample);
      }
    });

    socket.on('down', () => {
      // Peer connections do not survive the control channel: they can neither
      // renegotiate nor ICE-restart without a relay to carry the signalling.
      if (status === 'live') status = 'joining';
    });

    socket.on('gave-up', (why) => {
      leave();
      status = 'alone';
      say(why ?? 'Nobody answers. The wood is yours alone.', 5000);
    });

    socket.on('chat', (msg) => {
      if (typeof msg.text !== 'string') return;
      emit({ kind: 'chat', id: msg.id, name: msg.name, text: msg.text });
      /**
       * A word makes the speaker's aura flash.
       *
       * `avatar.js` refuses nameplates, so without this a line of chat is
       * completely disconnected from the body that produced it — you would have
       * to match a colour in the log against a colour in the wood, in a wood
       * full of things that are already that colour. A pulse on the one object
       * that is definitely the person closes the loop, and it uses the channel
       * that already means "this person is producing something", which is the
       * same channel speech uses.
       */
      people.get(msg.id)?.avatar.pulse?.();
    });

    socket.on('note', (msg) => {
      if (typeof msg.text !== 'string') return;
      emit({ kind: 'note', id: msg.id, name: msg.name, text: msg.text });
    });

    socket.on('present', (msg) => {
      const entry = people.get(msg.id);
      if (!entry) return;
      const was = entry.present;
      entry.present = sanitizePlacement(msg.at);
      routeShares();
      /**
       * Announced when a screen APPEARS, and only then.
       *
       * Putting one up is somebody saying "come and look at this" and is worth a
       * line; moving it four metres to the left and every intermediate width of
       * a resize are not. Keying on the transition rather than on the state is
       * what keeps a scroll wheel from writing a paragraph — resizes arrive as a
       * short burst of placements, and only the first of them would ever have
       * been news.
       */
      if (entry.present && !was) say(`${entry.avatar.name} puts a screen up.`, 5200);
    });

    mesh.on('voice-track', (id, track) => {
      const entry = people.get(id);
      if (!entry) return;
      attachVoice(id, entry);
      entry.voice?.setTrack(track);
    });

    /**
     * A picture, or the loss of one. Both go through the same recompute: a track
     * arriving is not enough on its own to know where it belongs, because the
     * presence announcement that says *where* travels on a different path and
     * routinely arrives after it.
     */
    mesh.on('share-track', () => routeShares());
  }

  // ------------------------------------------------------------------- input

  function onKeyDown(event) {
    if (event.target instanceof HTMLInputElement) return;
    /**
     * Push-to-talk is the one key in this app that WANTS auto-repeat — holding
     * it is the gesture — so it is the exception `allowRepeat` exists for, and
     * the switch below still reads `mic.talking = true` on every repeat.
     *
     * What this adds is the modifier check these keys never had, and this file
     * held the worst of it: `Ctrl+P` opened the browser's print dialog AND
     * started sharing your screen, and `Ctrl+J` opened the downloads list AND
     * opened a room and wrote an invite link to the clipboard. Two of the most
     * reflexive chords on a keyboard, each doing something to a room full of
     * people that nobody asked for.
     */
    if (!worldHearsKey(event, { allowRepeat: event.code === KEY_TALK })) return;
    switch (event.code) {
      case KEY_JOIN:
        toggleRoom();
        break;
      case KEY_TALK:
        if (mic) mic.talking = true;
        break;
      case KEY_MUTE:
        if (!mic) break;
        mic.muted = !mic.muted;
        say(mic.muted ? 'Microphone off.' : 'Microphone on.');
        break;
      case KEY_MODE:
        if (!mic) break;
        mic.mode = mic.mode === 'ptt' ? 'open' : 'ptt';
        say(mic.mode === 'ptt' ? 'Hold V to talk.' : 'Open microphone.');
        break;
      case KEY_SHARE:
        toggleShare();
        break;
      case KEY_PLACE:
        moveScreen();
        break;
      default:
        break;
    }
  }

  /**
   * TWO KEYS, TWO VERBS, AND THE SPLIT IS ALONG THE RIGHT SEAM.
   *
   * The old pair was `P` for "share on a panel" and `O` for "share on the big
   * screen", which meant every key was both a source decision and a destination
   * decision, pressing the one you were already using stopped the share, and
   * pressing the other one moved it. Three meanings per key, and the reason it
   * needed a paragraph of explanation is that it was three meanings per key.
   *
   * Now `P` is entirely about whether you are sharing and `O` is entirely about
   * where the screen is. Neither can do the other's job, so neither has a case
   * to explain: this one starts and stops, and that is all of it. `O` is not
   * even needed to get a screen standing up — `P` alone gives you a working
   * share in a clearing, and `O` is the adjustment.
   *
   * Sharing outside a room is allowed and shows only to you. It would be easy to
   * refuse — there is nobody to show — and it would be wrong: putting your own
   * second monitor on a screen in a forest to watch something while you walk
   * about is a completely reasonable thing to want, and the machinery for it is
   * already here. The announcement simply goes nowhere.
   */
  async function toggleShare() {
    if (share.active) {
      share.stop();
      say('You stop sharing.');
      return;
    }
    if (await share.startScreen()) {
      say(`A screen, ${share.width.toFixed(1)} m across. <kbd>O</kbd> moves it, scroll resizes it.`, 6000);
    }
  }

  /**
   * A film, dropped on the window.
   *
   * The whole of the "watch something together" feature's user interface. There
   * is no file picker, no button and no menu — a person who wants to put a film
   * on drags it onto the world, which is the one gesture that needs no
   * explaining, and the browser's own drag handling does the rest.
   *
   * It stands up in front of whoever dropped it, rather than being thrown at
   * whatever surface the world happened to have. That is a real improvement and
   * not just a consequence: dropping a film used to put it on the big screen in
   * a clearing that could be two hundred metres away, so the gesture that meant
   * "let's watch this" started by sending the picture somewhere you were not.
   * Now it is on, where you are, in one gesture and no keys at all.
   */
  function onDrop(event) {
    const file = [...(event.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('video/'));
    if (!file) return;
    event.preventDefault();
    share.startFile(file).then((ok) => {
      if (ok) say(`Putting on ${file.name}. <kbd>O</kbd> moves the screen.`, 6000);
    });
  }

  function onKeyUp(event) {
    if (event.code === KEY_TALK && mic) mic.talking = false;
  }

  // Releasing the talk key while the window is not focused never fires a keyup,
  // so without this a tabbed-away player transmits their room until they come
  // back and press V again.
  function onBlur() {
    if (mic) mic.talking = false;
  }

  // `dragover` must be cancelled or the browser navigates to the file instead
  // of offering it, which loses the session.
  const onDragOver = (event) => {
    if ([...(event.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) {
      event.preventDefault();
    }
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('drop', onDrop);
  // Not passive: a resize consumes the wheel, and without the option Chrome
  // treats the listener as passive on window and warns that preventDefault did
  // nothing — which is true, and the page scrolls the chat log under your feet.
  window.addEventListener('wheel', onWheel, { passive: false });

  // ------------------------------------------------------------------- audio

  /**
   * The microphone is only asked for once we are actually in a room.
   *
   * Not when the module loads, and not when a socket object is constructed —
   * `getUserMedia` puts a permission prompt in front of somebody's face, and
   * doing that while still failing to reach a server that turns out not to
   * exist is the rudest possible version of this feature.
   */
  async function openMicrophone() {
    if (micRequested || !audio?.ready) return;
    micRequested = true;
    const microphone = new Microphone(audio);
    mic = microphone;
    const ok = await microphone.open();
    // The permission prompt can sit there for as long as the user likes, and
    // they may well have left the room while it was up. Without this the
    // capture stays open with nothing to feed.
    if (mic !== microphone) {
      microphone.close();
      return;
    }
    if (!ok) {
      // Not fatal and not even unusual: plenty of people join to listen.
      say(microphone.error, 5000);
      return;
    }
    mesh?.setLocalTrack(microphone.track);
    say('Open microphone. <kbd>X</kbd> mutes, <kbd>C</kbd> switches to push-to-talk.', 6000);
  }

  // -------------------------------------------------------------------- frame

  function update(dt) {
    if (disposed) return;

    // The AudioContext can start at any moment, and everything voice-shaped is
    // waiting for it.
    if (audio?.ready) {
      if (status === 'live' && !micRequested) openMicrophone();
      for (const [id, entry] of people) {
        if (!entry.voice) attachVoice(id, entry);
        /**
         * Screens too, and this is a retry rather than a belt-and-braces call.
         *
         * `attachAudio` returns immediately if the engine is not ready yet, and
         * `routeShares` — the only other place that calls it — runs on a
         * presence event, which can perfectly well land before somebody has
         * clicked through the gate. A share that arrived in that window used to
         * get a screen with a picture and no soundtrack, permanently, with
         * nothing anywhere to say why. The method is idempotent, so calling it
         * every frame costs one property test per person.
         */
        entry.screen?.attachAudio(audio);
      }
      selfScreen?.attachAudio(audio);
    }

    const envelope = mic ? mic.update(dt) : 0;

    drawnScreens.length = 0;

    for (const entry of people.values()) {
      const { avatar, voice, screen } = entry;
      // The glow is driven by what actually arrived where a peer connection has
      // formed, and by the broadcast number until it has. See PeerVoice.
      avatar.update(dt, voice?.hasAudio ? voice.envelope : null);
      /**
       * A screen is not moved from here any more — it stands where its owner
       * put it, so the only per-frame work is the texture gate and the panner.
       * The avatar's transform used to be an input to this line, which meant a
       * screen's position was downstream of an interpolator; it is now
       * downstream of nothing.
       */
      if (screen?.group.visible) {
        screen.update(dt, camera);
        drawnScreens.push(screen);
      }
      if (!voice) continue;
      avatar.headWorldPosition(_head);
      avatar.headForward(_forward);
      voice.update(dt, _head, _forward, camera.position.distanceTo(_head));
    }

    if (selfScreen?.group.visible) {
      selfScreen.update(dt, camera);
      drawnScreens.push(selfScreen);
    }

    /**
     * After every surface's own update, because the glow reads world positions
     * and `VideoSurface.update` is where `updateMatrixWorld` is flushed — and
     * your own screen counts, so this comes after that line rather than inside
     * the loop over other people.
     */
    screenGlow.update(dt, camera, drawnScreens);

    if (!socket?.connected) return;

    /**
     * Outbound transforms on the same fixed tick the server fans out on.
     *
     * The accumulator is decremented rather than zeroed so the average rate is
     * exactly 18 Hz on any frame rate — zeroing it would round every interval up
     * to a whole frame, which on a 144 Hz monitor is a 6% slow drift and on a
     * heavily loaded frame is much worse.
     */
    sendAccumulator += dt * 1000;
    if (sendAccumulator < TICK_MS) return;
    sendAccumulator = Math.min(sendAccumulator - TICK_MS, TICK_MS);

    let flags = 0;
    if (controller.speed > 0.4) flags |= FLAG_MOVING;
    if (controller.onGround) flags |= FLAG_GROUNDED;
    if (mic?.muted) flags |= FLAG_MUTED;
    if (mic?.speaking) flags |= FLAG_SPEAKING;
    if (share.active) flags |= FLAG_PRESENTING;
    /**
     * The pose bits are contributed by whoever owns the pose — main.js sets
     * `net.pose` from the sitting and fishing modules — rather than being read
     * from here. This layer is deliberately not given the seat registry, the
     * rod, or the director, for the same reason it is not given the director's
     * trip level: it reads the one shared uniform block instead.
     */
    flags |= poseFlags;

    socket.sendState(
      controller.position.x,
      // Feet, not eyes. `controller.position` is the eye — see controller.js,
      // where the body's y is ground + EYE — and the avatar's origin is the
      // floor. Converting here, using the controller's own constant, means the
      // number is right without avatar.js having to mirror a value it cannot
      // import.
      controller.position.y - controller.eyeHeight,
      controller.position.z,
      controller.yaw,
      controller.pitch,
      envelope,
      flags,
      // The trip level, read from the live shared uniform block rather than
      // from the director — `attachMultiplayer` is deliberately not given the
      // director, and this is the same number the whole world is drawn with.
      tripUniforms.uLevel.value
    );
  }

  function dispose() {
    disposed = true;
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('dragover', onDragOver);
    window.removeEventListener('drop', onDrop);
    window.removeEventListener('wheel', onWheel);
    // The registry outlives this module across an HMR update, and a setter
    // closing over a disposed net layer would keep answering the switch with a
    // call into a screen that is gone.
    unregisterHearOwnShare();
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = 0;
    share.stop();
    selfScreen?.dispose();
    selfScreen = null;
    screenGlow.dispose();
    drawnScreens.length = 0;
    leave();
    status = 'off';
  }

  /**
   * Autojoin, but only when the URL says so.
   *
   * An invite link is `/?room=pxk-mwe-q7t`, and clicking one should put you in
   * the room without a second act of consent — you already consented by opening
   * it. Everything else waits for J.
   */
  const initial = roomInUrl();
  if (initial) join(initial);

  return {
    update,
    dispose,

    /** A read-only view for the console and for test scripts. */
    get peers() {
      const out = [];
      for (const [id, entry] of people) {
        out.push({
          id,
          name: entry.avatar.name,
          /** Resolved: what they chose, or what their id gave them. See `hueOf`. */
          hue: entry.avatar.hue,
          position: entry.avatar.position,
          speaking: entry.avatar.speaking,
          trip: entry.avatar.trip,
          /** The raw pose bits, so a test can ask whether somebody is sitting. */
          flags: entry.avatar.flags,
          distance: camera.position.distanceTo(entry.avatar.position),
          voice: entry.voice?.hasAudio ?? false,
          /** Their placement, or null. See `sanitizePlacement` in protocol.js. */
          present: entry.present,
          /** True once pixels are actually arriving, not merely announced. */
          picture: Boolean(mesh?.shareVideo.get(id)),
          connection: mesh?.statsFor(id) ?? null,
        });
      }
      return out;
    },

    /**
     * Say something to the room. Returns false when there was nobody to say it
     * to, which the UI turns into a line of its own rather than swallowing.
     */
    say(text) {
      return socket?.connected ? socket.sendChat(text) : false;
    },

    /** A thing that happened — a fish, an arrival. Same channel, different voice. */
    note(text) {
      return socket?.connected ? socket.sendNote(text) : false;
    },

    /** Subscribe to chat and notes. Returns an unsubscribe. */
    onMessage(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /**
     * Tell the room where the speaker cabinets are now standing.
     *
     * A PAIR OF HOOKS RATHER THAN THIS FILE MOVING THE SPEAKERS ITSELF, and the
     * boundary is deliberate. The whole of this module's geography is one
     * import of `aimGround`, because a net layer that reaches into the world is
     * a net layer you cannot test without one. Speakers are `main.js`'s to move
     * — it already owns the four things a placement touches, three of which are
     * audio nodes this file has no business knowing about — so what crosses the
     * boundary is a placement, in both directions.
     *
     * Silently a no-op outside a room, like `chat` and `note`: standing a
     * speaker somewhere on a solitary walk is a thing that works, and it must
     * not become a thing that needs a server.
     */
    sendSpeakers(at) {
      return socket?.connected ? socket.sendSpeakers(at) : false;
    },

    /**
     * Put a record on for the whole room, or take it off with null.
     *
     * Same boundary as `sendSpeakers`: what crosses is a description, and
     * `main.js` owns every audio node it implies. Silently a no-op outside a
     * room, so pressing E on a solitary walk is what it always was.
     */
    sendMusic(state) {
      return socket?.connected ? socket.sendMusic(state) : false;
    },

    /** Subscribe to the room's jukebox changing. Returns an unsubscribe. */
    onMusic(fn) {
      musicListeners.add(fn);
      return () => musicListeners.delete(fn);
    },

    /**
     * Tell the room you ate a mushroom, so it does not grow back for anybody.
     *
     * The lightest thing this API sends: one id, on a keypress, and never again
     * for that patch. Same boundary as the two above — this file has no idea
     * what a mushroom is, and `main.js` owns both the removal and the dose.
     * Silently a no-op outside a room.
     */
    sendEat(id) {
      return socket?.connected ? socket.sendEat(id) : false;
    },

    /**
     * Subscribe to a mushroom being eaten, by anybody, ever. Returns an
     * unsubscribe.
     *
     * Fires once per id on a `welcome`, catching a late arrival up on the whole
     * history, and then once per keypress. It is also called with `null` at the
     * end of that catch-up, which means "that was everything the room knows" —
     * the cue to teach it anything you ate before you got here. See the
     * `welcome` handler, and `onSpeakers` for the same convention.
     */
    onEat(fn) {
      eatListeners.add(fn);
      return () => eatListeners.delete(fn);
    },

    /**
     * Subscribe to somebody else moving the speakers. Returns an unsubscribe.
     *
     * Fires on a `welcome` too, which is what makes a late joiner walk into a
     * clearing with the speakers where everybody else can already see them
     * rather than back at their built-in spot.
     */
    onSpeakers(fn) {
      speakerListeners.add(fn);
      return () => speakerListeners.delete(fn);
    },

    /** Pose bits contributed by the sitting and fishing modules. See `poseFlags`. */
    setPose(flags) {
      poseFlags = flags | 0;
    },

    /**
     * Change who you are, from the menu or from a console.
     *
     * Writes storage first and tells the room second, and both are needed for
     * different reasons: the storage write is what a future session and a future
     * reconnect read, and the message is what the seven people who are already
     * looking at you need. `sendLook` updates the socket's own fields too, so a
     * change made while the connection is down still travels on the next
     * reconnect rather than being lost between the two.
     *
     * Safe to call before, during and after a room — outside one it is simply a
     * preference being remembered.
     */
    identify({ name, hue } = {}) {
      const cleanedName = cleanName(name);
      if (cleanedName) setPlayerName(cleanedName);
      const cleanedHue = cleanHue(hue);
      if (cleanedHue !== null) setPlayerHue(cleanedHue);
      socket?.sendLook(playerName(), playerHue());
      return { name: playerName(), hue: playerHue() };
    },

    /**
     * What colour somebody is, for anything outside the world that has to agree
     * with the body — which today is `ui/social.js`, and is the whole reason this
     * is exposed rather than left inside the avatars.
     *
     * The chat log is the only place a name appears anywhere in this game
     * (`avatar.js` refuses nameplates and explains why at length), so the colour
     * of that name is the single thread tying a sentence to a person standing in
     * a clearing. A log that kept computing `hueFromId` while the wood used a
     * chosen dye would cut that thread for exactly the people who cared enough to
     * pick a colour.
     *
     * Falls back to the id's own hue for anybody not in the room — your own lines
     * before you have joined, a name with no id — which is what the log did for
     * everybody before there was anything to choose.
     */
    hueFor(id) {
      const known = people.get(id)?.avatar.hue;
      if (known !== undefined) return known;
      if (socket?.selfId && id === socket.selfId) return playerHue();
      return hueOf(String(id ?? ''), null);
    },

    /**
     * You, as the room sees you.
     *
     * `id` is null until a socket has said welcome, and that is honest rather
     * than awkward: outside a room you genuinely have no id, because ids are
     * minted per connection. The name and the dye are always real, because they
     * are yours before anybody else has heard of you.
     */
    get me() {
      return { id: socket?.selfId ?? null, name: playerName(), hue: playerHue() };
    },

    /**
     * The peer mesh itself, read-only in practice.
     *
     * Exposed for the console and for tests that need to ask a question the
     * peers view cannot answer — "which transceiver did that track arrive on",
     * "what does getStats say per m-line". Diagnosing a silent voice needs
     * exactly that: a track can be attached and audible-looking from every
     * summary this module publishes while being the wrong track.
     */
    get mesh() {
      return mesh;
    },

    share,
    get sharing() {
      return share.active ? { kind: share.kind, title: share.title, width: share.width } : null;
    },

    /**
     * 1 at noon, 0 at midnight, pushed in from main.js on the frame loop.
     *
     * The net layer is not given the atmosphere or the daylight curve — it is
     * given the one number, the same way it is given the trip level through a
     * shared uniform rather than through the director. See `daylight`.
     */
    setDaylight(v) {
      daylight = v;
      for (const entry of people.values()) entry.screen?.setDaylight(v);
      selfScreen?.setDaylight(v);
    },

    /**
     * Somebody's screen object itself, `''` for your own. Null if they have none.
     *
     * Exposed for the same reason `mesh` is: the `peers` view is a snapshot of
     * plain values, and the questions worth asking about a screen are about the
     * live object — has the crossfade finished, what did `uFit` settle on, is
     * the texture actually being uploaded. A test that asserted on the snapshot
     * would be asserting that this module can copy its own fields.
     */
    screenFor(id) {
      if (id === '' || (socket?.selfId && id === socket.selfId)) return selfScreen;
      return people.get(id)?.screen ?? null;
    },

    /**
     * The one light every screen in the room shares, for the same reason
     * `screenFor` is exposed: the questions worth asking about it — which screen
     * is it standing at, what colour has it settled on, is it off in daylight —
     * are about the live object, and a snapshot of them would be this module
     * asserting that it can copy its own fields.
     */
    screenGlow,

    get status() {
      return status;
    },
    get room() {
      return socket?.room ?? null;
    },
    get latency() {
      return socket?.latency ?? 0;
    },
    get microphone() {
      return mic;
    },
    /** Programmatic equivalent of pressing J, for scripts. */
    joinRoom: (code) => join(code),

    /**
     * Join a room and make the URL the invitation to it — the whole of what
     * pressing J does, minus the leaving half and minus minting a code.
     *
     * What the main menu calls when somebody chose their company before they
     * chose to go in. `joinRoom` above is deliberately the barer version: a test
     * script wants a socket and nothing else, and would be surprised by a
     * clipboard write and a rewritten address bar.
     */
    openRoom: (code) => openRoom(code),
  };
}
