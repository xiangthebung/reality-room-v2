/**
 * The voice mesh: one RTCPeerConnection from you to every other person in the
 * room, carrying exactly one audio track each way.
 *
 * WHY A MESH RATHER THAN A CONFERENCE SERVER. A conference server mixes the room
 * into a single downstream, and mixing is the one operation that cannot be
 * undone: once four voices are summed into one signal there is no way to put
 * them in four different places in the forest. Proximity voice *is* the feature,
 * so the audio has to arrive as separate streams, and separate streams from a
 * server means an SFU — which is a large thing to run and still adds a hop of
 * latency to every word. A mesh has the lowest mouth-to-ear latency physically
 * available, which is what makes people interrupt each other naturally instead
 * of taking walkie-talkie turns.
 *
 * The price is upload: your voice goes out N-1 times. That is why rooms are
 * capped at eight (see server/index.js) and why the encoder is pinned to a
 * bitrate rather than left to negotiate.
 */

/**
 * 48 kbit/s per stream.
 *
 * Opus is transparent for speech well below this; the headroom above ~24k buys
 * the fricatives and transients that carry intelligibility, and those are
 * precisely what the spatial chain destroys — a voice at thirty metres has been
 * through a distance low-pass at about 900 Hz, so anything the encoder threw
 * away up top is gone twice over. Paying for consonants at the source is much
 * cheaper than trying to reconstruct them at the panner.
 */
const AUDIO_MAX_BITRATE = 48_000;

/**
 * SHARED VIDEO, AND WHY IT IS CAPPED SO HARD.
 *
 * A mesh sends your stream once per other person. That is a rounding error for
 * 48 kbit/s of speech and it is the whole design constraint for video: at eight
 * people, every megabit of encode is seven megabits of upload. A 1080p60 screen
 * share left to negotiate freely will happily ask for 8 Mbit/s, which is 56
 * Mbit/s up — more than most home connections have, and the way it fails is the
 * cruellest kind. The uplink saturates, the bufferbloat lands on the same queue
 * as everybody's voice, and the room concludes that *the voice chat* is broken.
 *
 * So the ceiling is 2.2 Mbit/s and the frame rate is 30. Text on a shared
 * editor is legible at that; a film is fine at that; and seven of them is 15
 * Mbit/s, which is a normal home upstream. The far more important half is that
 * this is a MAXIMUM rather than a target — WebRTC's congestion control will sit
 * well below it on a bad link, and the point of the cap is only to stop it
 * aiming somewhere it can never arrive.
 *
 * A second stream would double all of that, so only one person presents at a
 * time on the big screen (see share.js) — but the transceiver exists on every
 * peer either way, idle and free, so nobody has to renegotiate to take a turn.
 */
const VIDEO_MAX_BITRATE = 2_200_000;
const VIDEO_MAX_FRAMERATE = 30;

/**
 * Screen audio — a film's soundtrack, a video's dialogue — gets more than speech
 * does and is still cheap next to the picture.
 *
 * Stereo, unlike voice, because this one is not spatialised by an HRTF panner
 * that would downmix it anyway: it is played through a panner standing at the
 * screen, and what arrives at that panner should be the mix the sharer is
 * hearing. 96k stereo Opus is transparent enough for a film.
 */
const MEDIA_AUDIO_MAX_BITRATE = 96_000;

/**
 * How long the polite peer waits for the impolite one to offer first.
 *
 * Both sides construct their Peer within a few milliseconds of each other and
 * both would like to offer. Perfect negotiation can resolve that collision, but
 * resolving it costs a rollback and a second round trip, so it is cheaper to
 * simply not have it: one side hesitates. The timer is the safety net for the
 * case where the impolite side never offers at all (it crashed, or its
 * negotiationneeded never fired), and 2.5 s is long enough that it never fires
 * on a working connection.
 */
const POLITE_GRACE_MS = 2500;

/**
 * Raise Opus out of its telephone posture.
 *
 *   stereo=0            we spatialise a mono source ourselves; an HRTF panner
 *                       downmixes its input anyway, so a stereo channel would be
 *                       bitrate spent on something that is discarded
 *   usedtx=0            discontinuous transmission saves bandwidth by not
 *                       sending during silence, and clips the onset of every
 *                       quiet word — which is exactly the speech that matters
 *                       when someone is talking to you from twenty metres away
 *   useinbandfec=1      recovers isolated loss without a retransmission round
 *                       trip, which at conversational latency is the only kind
 *                       of recovery worth having
 *   maxaveragebitrate   the default is around 32k
 */
/**
 * TWO AUDIO m-LINES NOW, AND THEY WANT DIFFERENT THINGS.
 *
 * The first is speech and the second is whatever is playing on somebody's
 * screen. They are both Opus and they are both mono, and past that they have
 * almost nothing in common: speech wants every bit spent on consonants and
 * would rather clip a silence than delay a word, while a soundtrack wants
 * headroom for music and does not care about 20 ms.
 *
 * Payload type numbers repeat across m-lines in the same session description,
 * so patching by payload type alone — which is what this function used to do,
 * correctly, when there was one audio m-line — would give the film speech's
 * budget. Hence the section walk: SDP is a flat list of lines divided into
 * sections by `m=`, and the nth audio section corresponds to the nth audio
 * transceiver in creation order. Both peers construct theirs in the same order
 * in the same constructor, so "the second audio section" means the same thing
 * on both machines.
 */
const OPUS_VOICE = [
  'stereo=0',
  'sprop-stereo=0',
  `maxaveragebitrate=${AUDIO_MAX_BITRATE}`,
  'maxplaybackrate=48000',
  'useinbandfec=1',
  // Discontinuous transmission clips the onset of every quiet word.
  'usedtx=0',
];

const OPUS_MEDIA = [
  /**
   * Mono, and it is not a compromise: this track is played through an HRTF
   * PannerNode standing at the screen, and a panner downmixes its input. A
   * stereo channel would be bitrate spent on a second channel that is summed
   * away a few nodes later.
   */
  'stereo=0',
  'sprop-stereo=0',
  `maxaveragebitrate=${MEDIA_AUDIO_MAX_BITRATE}`,
  'maxplaybackrate=48000',
  'useinbandfec=1',
  /**
   * DTX ON here, where it is off for speech. A film has real digital silence in
   * it — between scenes, before the titles — and unlike a pause between words
   * that silence is not carrying anything. Not sending it is free.
   */
  'usedtx=1',
];

function tuneOpus(sdp) {
  const sections = sdp.split(/\r\n|\n/).reduce(
    (acc, line) => {
      if (line.startsWith('m=')) acc.push([]);
      acc[acc.length - 1].push(line);
      return acc;
    },
    [[]]
  );
  let audioIndex = -1;
  return sections
    .map((lines) => {
      if (!lines[0]?.startsWith('m=audio')) return lines.join('\r\n');
      audioIndex += 1;
      return tuneOpusSection(lines, audioIndex === 0 ? OPUS_VOICE : OPUS_MEDIA);
    })
    .join('\r\n');
}

function tuneOpusSection(lines, wanted) {
  const opus = new Set();
  const hasFmtp = new Set();

  /**
   * Two passes, and the reason is subtle enough to be worth stating: in real
   * SDP the `a=fmtp` line comes *after* its `a=rtpmap`. A single pass that
   * inserted a new fmtp on seeing the rtpmap would then walk into the original
   * one and patch that too, leaving two fmtp lines for one payload type. That
   * is malformed, and a browser is entitled to reject the entire session
   * description over it — which presents as a peer that never connects, with no
   * useful error anywhere.
   */
  for (const line of lines) {
    const rtpmap = /^a=rtpmap:(\d+)\s+opus\/48000/i.exec(line);
    if (rtpmap) opus.add(rtpmap[1]);
    const fmtp = /^a=fmtp:(\d+)\s/.exec(line);
    if (fmtp) hasFmtp.add(fmtp[1]);
  }
  if (opus.size === 0) return lines.join('\r\n');

  const out = [];
  for (const line of lines) {
    const fmtp = /^a=fmtp:(\d+)\s+(.*)$/.exec(line);
    if (fmtp && opus.has(fmtp[1])) {
      const params = new Map();
      for (const pair of fmtp[2].split(';')) {
        const [k, v] = pair.split('=');
        if (k?.trim()) params.set(k.trim(), v);
      }
      for (const entry of wanted) {
        const [k, v] = entry.split('=');
        params.set(k, v);
      }
      out.push(
        `a=fmtp:${fmtp[1]} ${[...params]
          .map(([k, v]) => (v === undefined ? k : `${k}=${v}`))
          .join(';')}`
      );
      continue;
    }
    out.push(line);
    const rtpmap = /^a=rtpmap:(\d+)\s+opus\/48000/i.exec(line);
    if (rtpmap && !hasFmtp.has(rtpmap[1])) {
      out.push(`a=fmtp:${rtpmap[1]} ${wanted.join(';')}`);
      hasFmtp.add(rtpmap[1]);
    }
  }
  return out.join('\r\n');
}

/**
 * Write encoding parameters onto a sender, tolerantly.
 *
 * Every field here is optional in the spec and at least one of them is
 * unimplemented in some shipping engine, so a rejected `setParameters` has to
 * leave the connection working with defaults rather than throw into the
 * negotiation chain. There is nothing to fall back to and nothing to report:
 * the defaults are worse, not broken.
 */
async function tuneEncodings(sender, fields) {
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    for (const encoding of params.encodings) Object.assign(encoding, fields);
    await sender.setParameters(params);
  } catch {
    /* not every engine allows every field; the defaults are acceptable */
  }
}

class Peer {
  constructor(id, mesh) {
    this.id = id;
    this.mesh = mesh;
    this.closed = false;
    /**
     * Perfect-negotiation roles, derived from the two ids rather than assigned.
     * Both sides compute the same answer from data they already have, so there
     * is no handshake to agree on who leads and no state to get out of step.
     */
    this.polite = mesh.selfId < id;
    this.makingOffer = false;
    this.ignoringOffer = false;
    this.hasRemote = false;
    this.pendingCandidates = [];
    this.stats = { state: 'new', rtt: 0, loss: 0, bytes: 0, bitrate: 0 };
    this._lastInbound = null;
    /** The lowest audio m-line seen from this peer. See `_audioChannel`. */
    this._voiceMid = null;

    /**
     * Every operation that touches signalling state goes through this promise
     * chain.
     *
     * Signalling messages arrive on a socket callback and applying one is
     * asynchronous — setRemoteDescription, then createAnswer, then
     * setLocalDescription. Without serialising, a second message landing inside
     * that window starts a concurrent sequence and the two interleave. The
     * result is not a clean failure: it is a connection that reports itself
     * `connected` with a transceiver that never got associated with the remote
     * m-line, so one side hears nothing and everything else looks fine.
     */
    this._chain = Promise.resolve();

    this.pc = new RTCPeerConnection({
      iceServers: mesh.iceServers,
      // One transport for everything. Fewer ports to punch, fewer candidate
      // pairs to gather, and TURN is billed per allocation.
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 2,
    });

    /**
     * The transceiver is created here, empty, rather than by addTrack later.
     *
     * That fixes the m-line for the life of the connection, which makes muting,
     * unmuting and swapping microphone a `replaceTrack()` — no renegotiation, no
     * gap in the audio, and no chance of a mid-call offer collision across a
     * mesh of eight peers. A sender with no track costs one idle m-line and
     * sends no packets, so the empty case is free.
     *
     * It also means the mesh can be built before the microphone exists at all,
     * which it always is: `attachMultiplayer` runs before anyone has clicked
     * "Enter the forest", so there is no AudioContext yet, let alone a mic.
     */
    this.audioTx = this.pc.addTransceiver('audio', { direction: 'sendrecv' });

    /**
     * THE SCREEN, AND ITS SOUND, RESERVED UP FRONT AND USUALLY EMPTY.
     *
     * Exactly the same argument as the voice transceiver above, and it pays off
     * far more here. A screen share is something a person starts and stops
     * repeatedly during an evening; doing that by adding and removing tracks
     * would renegotiate the connection every time, across a mesh where seven
     * other people are doing the same thing, with a rollback for every offer
     * collision. Fixing all three m-lines at construction turns every one of
     * those events into a `replaceTrack()`: no offer, no answer, no glare, and
     * no window in which somebody's voice can be interrupted because somebody
     * else pressed a key.
     *
     * An idle transceiver costs one m-line in a session description that is
     * already a few kilobytes, and sends nothing at all. That is the entire
     * price of never having to renegotiate.
     *
     * ORDER IS THE CONTRACT. Both peers run this constructor, so both create
     * voice, then screen sound, then picture. `tuneOpus` identifies the two
     * audio streams by that order, and `_routeTrack` identifies incoming ones by
     * transceiver identity, which the negotiation establishes from the same
     * order. Insert a fourth transceiver anywhere but the end and both break.
     */
    this.mediaAudioTx = this.pc.addTransceiver('audio', { direction: 'sendrecv' });
    this.videoTx = this.pc.addTransceiver('video', { direction: 'sendrecv' });

    this._wire();
    this.applyLocalTrack();
    this.applyShareTracks();
    this._tuneSender();

    if (this.polite) {
      this._graceTimer = setTimeout(() => {
        this._graceTimer = null;
        if (!this.hasRemote && !this.closed) this._negotiate();
      }, POLITE_GRACE_MS);
    }
  }

  _enqueue(label, task) {
    // Both arms run the task: a rejection earlier in the chain must not stop
    // later work, or one dropped candidate would wedge the peer forever.
    this._chain = this._chain.then(
      () => (this.closed ? undefined : task()),
      () => (this.closed ? undefined : task())
    );
    return this._chain.catch((err) => {
      console.warn(`[net] ${label} failed for ${this.id}:`, err?.message ?? err);
    });
  }

  _wire() {
    const { pc } = this;

    pc.addEventListener('negotiationneeded', () => {
      if (this.polite && !this.hasRemote && this._graceTimer) return;
      this._negotiate();
    });

    pc.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) this.mesh.socket.signal(this.id, { candidate: candidate.toJSON() });
    });

    /**
     * Three tracks arrive on this connection, and telling them apart is harder
     * than it looks.
     *
     * `track.kind` answers the video question and not the audio one: a voice and
     * a film's soundtrack are both `audio`, and putting a film through the
     * proximity-voice chain — mono, gated, low-passed to a whisper at thirty
     * metres, dry because speech must stay intelligible — sounds like a fault
     * rather than like a film. The other way round is worse: a voice routed to
     * the screen is a person nobody can hear.
     *
     * THE OBVIOUS DISCRIMINATOR IS `event.transceiver === this.audioTx`, AND IT
     * IS WRONG. It relies on negotiation having ASSOCIATED our locally created
     * transceivers with the remote description's m-lines, and that association
     * is not guaranteed. Measured on this very mesh: both peers ended up with
     * their own three transceivers on mids 3–5, `sendonly`, receiving on mids
     * 0–2 that they never created. `event.transceiver` was then an implicitly
     * created object equal to none of ours, both audio tracks fell through to
     * the same branch, and the second — the silent screen-audio one — overwrote
     * the voice. Everything reported healthy: a peer connection `connected`,
     * tens of kilobytes received, a spatial source attached. And silence.
     *
     * So they are told apart by m-line ORDER, which is the thing both peers
     * genuinely agree on: this file creates voice, then screen sound, then
     * picture, in that order, in a constructor both sides run. The lowest audio
     * mid on the connection is therefore the voice, whatever object carried it.
     * Mids are strings that are ordinarily "0", "1", … and the numeric compare
     * falls back to arrival order for an engine that hands us something else,
     * preferring to treat an unknown audio track as a voice — the failure that
     * leaves people able to talk.
     */
    pc.addEventListener('track', (event) => {
      const track = event.track;
      const channel = track.kind === 'video' ? 'video' : this._audioChannel(event.transceiver);

      if (channel === 'voice') {
        // Remembered as well as announced. A track can arrive before the avatar
        // it belongs to has been created, and a voice dropped here would be
        // silent for the rest of the session with nothing in any log about it.
        this.mesh.tracks.set(this.id, track);
        this.mesh.emit('voice-track', this.id, track);
        return;
      }

      /**
       * A share track is live for as long as the transceiver is, and goes
       * `muted`/`unmuted` as the far side replaces it — so the surface has to
       * follow the track's own events rather than assume that receiving it once
       * means it is showing something. `ended` fires when the far side leaves.
       */
      const store = channel === 'video' ? this.mesh.shareVideo : this.mesh.shareAudio;
      store.set(this.id, track);
      const announce = () => this.mesh.emit('share-track', this.id, channel, track);
      track.addEventListener('mute', announce);
      track.addEventListener('unmute', announce);
      track.addEventListener('ended', () => {
        if (store.get(this.id) === track) store.delete(this.id);
        this.mesh.emit('share-track', this.id, channel, null);
      });
      announce();
    });

    pc.addEventListener('connectionstatechange', () => {
      this.stats.state = pc.connectionState;
      this.mesh.emit('peer-state', this.id, pc.connectionState);
      if (pc.connectionState === 'failed') this._recover();
    });

    pc.addEventListener('iceconnectionstatechange', () => {
      if (pc.iceConnectionState === 'failed') this._recover();
    });
  }

  /**
   * Which of the two audio streams this is. See the `track` listener.
   *
   * Remembers the lowest audio mid seen so far and calls that one the voice. The
   * out-of-order case — a higher mid arriving first — cannot happen while
   * m-lines are processed in order, but it is handled rather than assumed: the
   * previous claimant is demoted and re-announced as screen sound, because
   * getting this wrong silently is the whole failure this replaced.
   */
  _audioChannel(transceiver) {
    const mid = Number(transceiver?.mid);
    if (!Number.isFinite(mid)) return this._voiceMid === null ? 'voice' : 'media-audio';

    if (this._voiceMid === null || mid < this._voiceMid) {
      const displaced = this._voiceMid;
      this._voiceMid = mid;
      if (displaced !== null) {
        const wrong = this.mesh.tracks.get(this.id);
        if (wrong) {
          this.mesh.tracks.delete(this.id);
          this.mesh.shareAudio.set(this.id, wrong);
          this.mesh.emit('share-track', this.id, 'media-audio', wrong);
        }
      }
      return 'voice';
    }
    return 'media-audio';
  }

  _recover() {
    if (this.closed) return;
    try {
      // Re-gathers candidates against the current network. This is what
      // survives a laptop moving from wifi to a phone hotspot mid-conversation.
      this.pc.restartIce();
    } catch {
      /* older engines: connectionstatechange will keep reporting the failure */
    }
  }

  _negotiate() {
    return this._enqueue('offer', async () => {
      if (this.pc.signalingState !== 'stable') return;
      try {
        this.makingOffer = true;
        const offer = await this.pc.createOffer();
        offer.sdp = tuneOpus(offer.sdp);
        // Re-checked after the await: anything could have landed while
        // createOffer was running, and setLocalDescription on a non-stable
        // connection throws.
        if (this.pc.signalingState !== 'stable') return;
        await this.pc.setLocalDescription(offer);
        this.mesh.socket.signal(this.id, { description: this.pc.localDescription });
      } finally {
        this.makingOffer = false;
      }
    });
  }

  handleSignal(data) {
    if (this.closed || !data) return;
    this._enqueue('signal', async () => {
      const { pc } = this;

      if (data.description) {
        const collision =
          data.description.type === 'offer' &&
          (this.makingOffer || pc.signalingState !== 'stable');
        // The impolite side wins and drops the incoming offer; the polite side
        // accepts it, which rolls its own back implicitly.
        this.ignoringOffer = !this.polite && collision;
        if (this.ignoringOffer) return;

        await pc.setRemoteDescription(data.description);
        this.hasRemote = true;
        if (this._graceTimer) {
          clearTimeout(this._graceTimer);
          this._graceTimer = null;
        }
        for (const candidate of this.pendingCandidates.splice(0)) {
          await pc.addIceCandidate(candidate).catch(() => {});
        }
        if (data.description.type === 'offer') {
          const answer = await pc.createAnswer();
          answer.sdp = tuneOpus(answer.sdp);
          await pc.setLocalDescription(answer);
          this.mesh.socket.signal(this.id, { description: pc.localDescription });
          this._tuneSender();
        }
        return;
      }

      if (data.candidate) {
        // Candidates routinely outrun the description that gives them meaning,
        // because the relay is fast and setRemoteDescription is not. Holding
        // them for a moment is the difference between connecting on the first
        // try and connecting after an ICE restart.
        if (!this.hasRemote) {
          if (this.pendingCandidates.length < 64) this.pendingCandidates.push(data.candidate);
          return;
        }
        await pc.addIceCandidate(data.candidate).catch(() => {});
      }
    });
  }

  applyLocalTrack() {
    this.audioTx.sender.replaceTrack(this.mesh.localTrack ?? null).catch(() => {});
  }

  /**
   * Publish (or stop publishing) whatever is on this machine's screen.
   *
   * Two `replaceTrack` calls and nothing else — see the transceiver comment in
   * the constructor. The bitrate is re-applied after every change because
   * `getParameters().encodings` is reset when a sender's track changes shape,
   * and an uncapped encoder is the one failure mode that takes the room's voice
   * down with it.
   */
  applyShareTracks() {
    this.videoTx.sender
      .replaceTrack(this.mesh.shareVideoTrack ?? null)
      .then(() => this._tuneVideoSender())
      .catch(() => {});
    this.mediaAudioTx.sender
      .replaceTrack(this.mesh.shareAudioTrack ?? null)
      .then(() => this._tuneMediaSender())
      .catch(() => {});
  }

  async _tuneSender() {
    await tuneEncodings(this.audioTx.sender, {
      maxBitrate: AUDIO_MAX_BITRATE,
      // There is nothing else on this connection to lose to, but the hints
      // also reach the OS network stack, and on a congested uplink shared
      // with a game download that is where they matter.
      priority: 'high',
      networkPriority: 'high',
    });
  }

  async _tuneMediaSender() {
    /**
     * Explicitly LOWER priority than speech, which is the whole point of
     * setting it at all.
     *
     * When the uplink runs out — and with seven copies of a screen share going
     * out it will — something has to give, and the answer must always be the
     * film rather than the conversation. A dropped frame of a film is a dropped
     * frame of a film. A dropped 20 ms of speech is a syllable, and three of
     * them in a sentence is a person nobody can understand.
     */
    await tuneEncodings(this.mediaAudioTx.sender, {
      maxBitrate: MEDIA_AUDIO_MAX_BITRATE,
      priority: 'medium',
      networkPriority: 'medium',
    });
  }

  async _tuneVideoSender() {
    await tuneEncodings(this.videoTx.sender, {
      maxBitrate: VIDEO_MAX_BITRATE,
      maxFramerate: VIDEO_MAX_FRAMERATE,
      /**
       * The lowest priority on the connection, and it yields first.
       *
       * `low` here does not mean the picture is unimportant — it means that of
       * the three things sharing one uplink, this is the one whose degradation
       * a room can absorb. WebRTC will scale the resolution down before it
       * starts dropping frames, so a saturated link produces a soft picture and
       * an intact conversation rather than a sharp picture and a broken one.
       */
      priority: 'low',
      networkPriority: 'low',
    });
  }

  async pollStats() {
    if (this.closed || this.pc.connectionState !== 'connected') return;
    try {
      const report = await this.pc.getStats();
      let inbound = null;
      let selectedPairId = null;
      const pairs = new Map();
      report.forEach((entry) => {
        if (entry.type === 'inbound-rtp' && entry.kind === 'audio') inbound = entry;
        if (entry.type === 'transport' && entry.selectedCandidatePairId) {
          selectedPairId = entry.selectedCandidatePairId;
        }
        if (entry.type === 'candidate-pair') pairs.set(entry.id, entry);
      });
      // The transport's own pointer, not a scan for a nominated pair: after ICE
      // reselects a route, scanning can land on a superseded pair and report a
      // frozen round-trip time forever.
      const pair = selectedPairId ? pairs.get(selectedPairId) : null;
      if (pair?.currentRoundTripTime != null) this.stats.rtt = pair.currentRoundTripTime * 1000;
      if (inbound) {
        this.stats.bytes = inbound.bytesReceived ?? 0;
        const prev = this._lastInbound;
        if (prev && inbound.timestamp > prev.timestamp) {
          const dt = (inbound.timestamp - prev.timestamp) / 1000;
          const got = (inbound.packetsReceived ?? 0) - (prev.packetsReceived ?? 0);
          const lost = (inbound.packetsLost ?? 0) - (prev.packetsLost ?? 0);
          this.stats.loss = got + lost > 0 ? Math.max(0, lost / (got + lost)) : 0;
          this.stats.bitrate = dt > 0 ? ((this.stats.bytes - (prev.bytesReceived ?? 0)) * 8) / dt : 0;
        }
        this._lastInbound = { ...inbound };
      }
    } catch {
      /* stats are advisory */
    }
  }

  close() {
    this.closed = true;
    if (this._graceTimer) clearTimeout(this._graceTimer);
    try {
      for (const sender of this.pc.getSenders()) sender.replaceTrack(null).catch(() => {});
      this.pc.close();
    } catch {
      /* already gone */
    }
  }
}

export class PeerMesh {
  constructor({ socket }) {
    this.socket = socket;
    this.peers = new Map();
    /** id -> the remote MediaStreamTrack, kept for subscribers that arrive late. */
    this.tracks = new Map();
    /** id -> their shared picture / their shared sound. Same lateness argument. */
    this.shareVideo = new Map();
    this.shareAudio = new Map();
    this.localTrack = null;
    this.shareVideoTrack = null;
    this.shareAudioTrack = null;
    this.iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
    this._handlers = new Map();

    socket.on('welcome', (msg) => {
      if (msg.iceServers?.length) this.iceServers = msg.iceServers;
    });
    socket.on('signal', (msg) => {
      // Creating on demand is what makes the impolite-offers-first rule work:
      // the polite side may hear an offer before it has been told anyone joined.
      const peer = this.peers.get(msg.from) ?? this.connect(msg.from);
      peer?.handleSignal(msg.data);
    });

    this._statsTimer = setInterval(() => {
      for (const peer of this.peers.values()) peer.pollStats();
    }, 1000);
  }

  on(event, fn) {
    let set = this._handlers.get(event);
    if (!set) this._handlers.set(event, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  emit(event, ...args) {
    for (const fn of this._handlers.get(event) ?? []) {
      try {
        fn(...args);
      } catch (err) {
        console.warn(`[net] ${event} listener threw`, err);
      }
    }
  }

  get selfId() {
    return this.socket.selfId ?? '';
  }

  connect(id) {
    if (!id || id === this.selfId) return null;
    const existing = this.peers.get(id);
    if (existing) return existing;
    const peer = new Peer(id, this);
    this.peers.set(id, peer);
    return peer;
  }

  disconnect(id) {
    this.tracks.delete(id);
    this.shareVideo.delete(id);
    this.shareAudio.delete(id);
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.close();
    this.peers.delete(id);
  }

  /**
   * Publish (or stop publishing) the microphone.
   *
   * `replaceTrack` on an already-negotiated sender, so this is instant across
   * the whole mesh and nothing renegotiates. Passing null is a real mute at the
   * transport: no packets leave this machine.
   */
  setLocalTrack(track) {
    this.localTrack = track ?? null;
    for (const peer of this.peers.values()) peer.applyLocalTrack();
  }

  /**
   * Publish (or stop publishing) a screen.
   *
   * Both tracks move together because they are one thing to the person who
   * pressed the key, and passing null for the audio is normal — a shared window
   * has no sound, only a shared tab or a shared file does.
   */
  setShareTracks(video, audio) {
    this.shareVideoTrack = video ?? null;
    this.shareAudioTrack = audio ?? null;
    for (const peer of this.peers.values()) peer.applyShareTracks();
  }

  statsFor(id) {
    return this.peers.get(id)?.stats ?? null;
  }

  dispose() {
    clearInterval(this._statsTimer);
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.tracks.clear();
    this.shareVideo.clear();
    this.shareAudio.clear();
    this._handlers.clear();
  }
}
