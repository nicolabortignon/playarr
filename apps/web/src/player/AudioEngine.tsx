import { valueAt } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { useEffect, useRef } from 'react';
import { sized } from '../lib/api';
import { extractAccent } from '../lib/color';
import { setFaviconAccent } from '../lib/favicon';
import { crossfadeSeconds, usePrefs } from '../lib/prefs';
import { toast } from '../lib/toast';
import { canSetVolume, fadeCurve, fadeSeconds, levelGain, silentClip, upNext } from './decks';
import { useDownloads } from './downloads';
import { healQueue } from './healQueue';
import { loadLevels, useLevels } from './levels';
import { useLoadAhead } from './loadAhead';
import { bridgeEntry, bridgeGain, bTimeAt, songTimeDuring, transitionTimeFor } from './mixSequence';
import { useOffline } from './offline';
import { playTracker } from './playTracker';
import { useAutoplay } from './radio';
import { sleepGain, sleepsAtSongEnd, useSleep, useSleepTimer } from './sleep';
import { currentTrack, useClock, useCurrentTrack, usePlayer } from './store';
import { readyTransition, type ReadyTransition, useTransition, useUpcomingTransition } from './transitions';

const DEFAULT_ACCENT = '#ff7a1a';
/** Have the next song loaded this long before the current one ends. */
const PRELOAD_S = 30;
/** Start the next song this much early, for the moment it takes to start. */
const LEAD_MS = 30;
/** Where the files of a DJ transition join, the old one plays on this long under the new one (the kick masks it). */
const OVERLAP_MS = 15;
/** The transition hasn't started this long after asking it to: A plays on (it never stopped). */
const START_WATCH_MS = 250;
/** The transition stuck loading this long: on with a song's own file instead. */
const STALL_MS = 4000;
/** Seeking flushes what's buffered: an element already this close (in seconds) to the time isn't moved. */
const SEEK_SLACK_S = 0.005;

interface Fade {
  out: HTMLAudioElement;
  in: HTMLAudioElement;
  seconds: number;
}

/** Two files of a DJ transition joining: the new one fades in as the old one fades out, then the old one stops. */
interface Overlap {
  out: HTMLAudioElement;
  in: HTMLAudioElement;
  /** When (performance.now()) the new one started playing; until then it's silent. */
  startedAt: number | null;
  /** The transition ending into B: its level still applies as it fades out. */
  ending?: Mix;
}

/** A level across a short overlap: equal gain, as both files hold nearly the same sound there. */
const evenGain = (x: number) => Math.max(0, Math.min(1, x));

/** A DJ transition from the song playing into the next: loaded ahead, then playing. */
interface Mix {
  transition: ReadyTransition;
  from: Track;
  to: Track;
  /** The transition file plays (the first song's file has stopped at the mix point). */
  bridging: boolean;
  /** Past the switch: the store, the lock screen and the history have moved on to the next song. */
  switched: boolean;
  /** The sleep timer was to stop at the end of A, which ended at the switch: stop where the transition ends. */
  sleepAtLanding?: boolean;
}

/**
 * Owns the <audio> elements and bridges them to the player store and the OS media controls. One plays;
 * another loads the song that comes next and starts it right as the first ends (no gap), or a little
 * before, fading one into the other (Settings → Playback → Crossfade).
 *
 * With DJ mix, a third element (the bridge) plays the transition the server rendered between the two
 * songs: the first song's file stops at the mix point, the transition plays, and the next song's file
 * goes on from where the transition leaves it. The transition is never a song of its own: the store,
 * the lock screen and the history see the first song, then the next one from the middle of the blend.
 * Anything that goes wrong with it falls back to the two-element way.
 */
export function AudioEngine() {
  const a = useRef<HTMLAudioElement>(null);
  const b = useRef<HTMLAudioElement>(null);
  const bridge = useRef<HTMLAudioElement>(null);
  const activeIdx = useRef(0);
  /** The song each element has loaded. */
  const loaded = useRef(new WeakMap<HTMLAudioElement, Track>());
  /** A song started early by the engine, which the store moves to next. */
  const handedOff = useRef<number | null>(null);
  /** Starting the next song early didn't work (autoplay rules): it's loaded the usual way. */
  const handoffFailed = useRef(false);
  const handoffTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fade = useRef<Fade | null>(null);
  const fadeTimer = useRef<ReturnType<typeof setInterval>>(undefined);
  const mix = useRef<Mix | null>(null);
  /** Starts the transition at the mix point, or the next song at the transition's end. */
  const bridgeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Moves the store on to B at the switch (timeupdate alone comes only every quarter second or so). */
  const switchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Gives up on a transition that doesn't start, or stays stuck loading. */
  const startWatch = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stallTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** The transition asked to start, not playing yet. */
  const starting = useRef<Mix | null>(null);
  /** When the lock screen's position was last set during a transition. */
  const positionAt = useRef(0);
  const overlap = useRef<Overlap | null>(null);
  const overlapTimer = useRef<ReturnType<typeof setInterval>>(undefined);
  /** Transition files that wouldn't play: not tried again. */
  const failedBridges = useRef(new Set<string>());
  const track = useCurrentTrack();
  const accent = usePrefs((s) => s.accent);
  const playing = usePlayer((s) => s.playing);
  const restartToken = usePlayer((s) => s.restartToken);
  const firstLoad = useRef(true);
  // True while a new source is loading; some browsers fire "pause" during a src swap.
  const switching = useRef(false);

  const active = () => (activeIdx.current === 0 ? a.current : b.current);
  const standby = () => (activeIdx.current === 0 ? b.current : a.current);
  const swap = () => (activeIdx.current ^= 1);
  /** The transition playing, if one is. */
  const bridging = () => (mix.current?.bridging ? mix.current : null);
  /** The element making the sound: the transition's while one plays. */
  const playingDeck = () => (bridging() ? bridge.current : active());

  function load(deck: HTMLAudioElement, t: Track) {
    loaded.current.set(deck, t);
    deck.dataset.fileId = String(t.fileId);
    delete deck.dataset.offset;
    deck.src = t.streamUrl;
  }

  /**
   * Load a song's remainder, rendered after a DJ transition: a file starting `offset` seconds into the
   * song (some formats can't seek exactly to a beat).
   */
  function loadRemainder(deck: HTMLAudioElement, t: Track, url: string, offset: number) {
    loaded.current.set(deck, t);
    deck.dataset.fileId = String(t.fileId);
    deck.dataset.offset = String(offset);
    deck.src = url;
  }

  const holds = (deck: HTMLAudioElement | null, t: Track | undefined) => !!deck && !!t && deck.dataset.fileId === String(t.fileId);
  /** Where the deck's file starts in its song: 0, or later for a song's remainder. */
  const offsetOf = (deck: HTMLAudioElement) => Number(deck.dataset.offset ?? 0);
  const songTime = (deck: HTMLAudioElement) => offsetOf(deck) + deck.currentTime;

  /**
   * Where the transition shows its song: A's time until the switch, B's after. (The switch can come a
   * moment before switchAt, from its timer: B's time is shown from then.)
   */
  const shownTime = (m: Mix, transitionTime: number) =>
    m.switched ? bTimeAt(m.transition.plan, transitionTime) : m.transition.plan.aStart + transitionTime;

  /** Where the song shown is now, wherever it plays from. */
  function currentSongTime(): number {
    const m = bridging();
    if (m && bridge.current) return shownTime(m, bridge.current.currentTime);
    const deck = active();
    return deck ? songTime(deck) : 0;
  }

  /** Set an element's time, unless it's there already: seeking flushes its buffer, a stutter at a join. */
  function setTime(deck: HTMLAudioElement, time: number) {
    if (Math.abs(deck.currentTime - time) > SEEK_SLACK_S) deck.currentTime = time;
  }

  /** Set an element's time, again once it knows its file: a time set before that may be ignored (Safari). */
  function setTimeOnLoad(deck: HTMLAudioElement, time: number) {
    setTime(deck, time);
    if (deck.readyState >= 1 /* HAVE_METADATA */) return;
    const file = deck.getAttribute('src');
    deck.addEventListener('loadedmetadata', () => deck.getAttribute('src') === file && setTime(deck, time), { once: true });
  }

  /**
   * Move a deck to a time in its song. Before a remainder file starts, that means the song's own file:
   * true then, as the deck has stopped to load it.
   */
  function seekSong(deck: HTMLAudioElement, time: number): boolean {
    const offset = offsetOf(deck);
    const t = loaded.current.get(deck);
    if (time >= offset || !t) {
      setTimeOnLoad(deck, Math.max(0, time - offset));
      return false;
    }
    switching.current = true;
    load(deck, t);
    setTimeOnLoad(deck, time);
    return true;
  }

  /** Have a deck hold this song at this time, loading it if it doesn't. True if it loaded (so it stopped). */
  function cue(deck: HTMLAudioElement, t: Track, time: number) {
    if (holds(deck, t)) return seekSong(deck, time);
    load(deck, t);
    setTimeOnLoad(deck, time);
    return true;
  }

  /** The end of what an element has loaded, in its song's time. */
  function bufferedEnd(deck: HTMLAudioElement) {
    const buffered = deck.buffered;
    return buffered?.length ? buffered.end(buffered.length - 1) + offsetOf(deck) : 0;
  }

  /** Each element's volume: the volume set, the song's level, and where it is in a fade. */
  function applyVolumes() {
    const s = usePlayer.getState();
    const { levelVolume } = usePrefs.getState();
    const { levels } = useLevels.getState();
    const settable = canSetVolume();
    const level = (t: Track | undefined) => (settable && levelVolume && t ? levelGain(t, levels[t.recordingId], s) : 1);
    const o = overlap.current;
    const m = mix.current ?? o?.ending;
    const joined = o?.startedAt == null ? 0 : (performance.now() - o.startedAt) / OVERLAP_MS;
    for (const deck of [a.current, b.current, bridge.current]) {
      if (!deck) continue;
      deck.muted = s.muted;
      let v = s.volume * s.volume * sleepGain(); // perceptual curve; fading out for the sleep timer
      // The transition holds both songs at their own levels: it takes each one's level as it's heard.
      if (deck === bridge.current) v *= m ? bridgeGain(m.transition.plan, deck.currentTime, level(m.from), level(m.to)) : 1;
      else v *= level(loaded.current.get(deck));
      const f = fade.current;
      if (f?.out === deck) v *= fadeCurve(remaining(deck) / f.seconds);
      else if (f?.in === deck) v *= fadeCurve(deck.currentTime / f.seconds);
      if (o?.out === deck) v *= evenGain(1 - joined);
      else if (o?.in === deck) v *= evenGain(joined);
      deck.volume = Math.max(0, Math.min(1, v));
    }
  }

  function remaining(deck: HTMLAudioElement) {
    const duration = Number.isFinite(deck.duration) ? deck.duration : (loaded.current.get(deck)?.duration ?? 0);
    return Math.max(0, duration - deck.currentTime) / (deck.playbackRate || 1);
  }

  function endFade() {
    clearInterval(fadeTimer.current);
    const f = fade.current;
    fade.current = null;
    if (f && f.out !== active()) f.out.pause();
    applyVolumes();
  }

  function tickFade() {
    const f = fade.current;
    if (!f) return;
    if (f.out.ended || f.out.paused || f.in.currentTime >= f.seconds) endFade();
    else applyVolumes();
  }

  /** Load the song that comes next into the other element. */
  function prepareNext() {
    const s = usePlayer.getState();
    const next = upNext(s);
    const deck = standby();
    if (!next || !deck || next.fileId === currentTrack(s)?.fileId || fade.current?.out === deck) return;
    if (!holds(deck, next)) {
      deck.preload = 'auto';
      load(deck, next);
    }
    void loadLevels([next]);
  }

  /** Start the next song (already loaded) now: the store moves to it once it plays. */
  function handOff(seconds: number, onFail: () => void = () => {}) {
    const out = active();
    const next = upNext(usePlayer.getState());
    const incoming = standby();
    if (!out || !incoming || !holds(incoming, next) || handedOff.current !== null || handoffFailed.current || bridging()) return false;
    handedOff.current = next!.fileId;
    swap();
    if (seconds > 0) {
      fade.current = { out, in: incoming, seconds };
      fadeTimer.current = setInterval(tickFade, 100);
    }
    seekSong(incoming, 0);
    applyVolumes();
    incoming.play().then(
      () => usePlayer.getState().next(true),
      () => {
        // Couldn't start it early (autoplay rules on some phones): back to one element.
        swap();
        handedOff.current = null;
        handoffFailed.current = true;
        endFade();
        onFail();
      },
    );
    return true;
  }

  /** Close to the end: have the next song ready, and start it on time. */
  function approachEnd(deck: HTMLAudioElement) {
    const s = usePlayer.getState();
    const left = remaining(deck);
    // The sleep timer stops at the end of this song: nothing to start.
    if (deck.paused || !s.playing || left > PRELOAD_S || !deck.duration || useSleep.getState().endOfSong) return;
    prepareNext();
    const next = upNext(s);
    if (!holds(standby(), next) || handedOff.current !== null || handoffFailed.current) return;
    const seconds = canSetVolume() ? fadeSeconds(loaded.current.get(deck), next, crossfadeSeconds(usePrefs.getState())) : 0;
    const wait = left - seconds;
    if (wait > 1.5) return;
    clearTimeout(handoffTimer.current);
    handoffTimer.current = setTimeout(() => {
      const now = active();
      if (now === deck && !deck.paused && usePlayer.getState().playing && !useSleep.getState().endOfSong) handOff(seconds);
    }, Math.max(0, wait * 1000 - LEAD_MS));
  }

  // DJ transitions: the first song (A) → the transition file (the bridge) → the next song (B).

  /**
   * Load the transition ready for the song playing into the next (as long before its mix point as the
   * next song before an end), and B where the transition leaves it. A transition for another pair of
   * songs, or one no longer ready, is dropped.
   */
  function prepareBridge() {
    const m = mix.current;
    if (m?.bridging) return;
    const s = usePlayer.getState();
    const deck = active();
    const next = standby();
    const r = readyTransition(useTransition.getState());
    const from = currentTrack(s);
    const to = upNext(s);
    const usable =
      !!r && !!deck && !!next && !!bridge.current && !!from && !!to && r.fromFileId === from.fileId && r.toFileId === to.fileId && holds(deck, from);
    const aTime = deck ? songTime(deck) : 0;
    // Not wanted (the sleep timer, a failed file), not yet near the mix point, or past it (a seek).
    const wanted =
      usable &&
      !failedBridges.current.has(r.url) &&
      !useSleep.getState().endOfSong &&
      fade.current?.out !== next &&
      aTime >= r.plan.aStart - PRELOAD_S &&
      (bridgeEntry(r.plan, aTime, false) !== null || aTime < r.plan.aStart);
    if (!wanted) return dropPrepared();
    if (m && m.transition.url === r.url && m.from.fileId === from.fileId && m.to.fileId === to.fileId) return;
    dropPrepared();
    const br = bridge.current!;
    br.preload = 'auto';
    br.dataset.url = r.url;
    br.src = r.url;
    next.preload = 'auto';
    if (r.continuationUrl) loadRemainder(next, to, r.continuationUrl, r.plan.bResume);
    else cue(next, to, r.plan.bResume);
    void loadLevels([to]);
    mix.current = { transition: r, from, to, bridging: false, switched: false };
  }

  /** Forget a transition loaded ahead (the queue changed, a skip, a failure): the songs follow each other the usual way. */
  function dropPrepared() {
    const m = mix.current;
    if (!m || m.bridging) return;
    mix.current = null;
    clearTimeout(bridgeTimer.current);
    clearBridge();
    clearRemainder(standby());
  }

  function clearBridge() {
    const br = bridge.current;
    if (!br?.getAttribute('src') || br.getAttribute('src') === silentClip()) return;
    br.pause();
    br.removeAttribute('src');
    delete br.dataset.url;
    br.load();
  }

  /** B's remainder can't play B from its start: the deck loads B's own file when its turn comes. */
  function clearRemainder(deck: HTMLAudioElement | null) {
    if (!deck || !offsetOf(deck)) return;
    deck.pause();
    deck.removeAttribute('src');
    delete deck.dataset.fileId;
    delete deck.dataset.offset;
    deck.load();
  }

  /** Close to the mix point: start the transition on time. True while one is coming (no gapless start then). */
  function approachBridge(deck: HTMLAudioElement): boolean {
    prepareBridge();
    const m = mix.current;
    if (!m || m.bridging) return !!m;
    if (deck.paused || !usePlayer.getState().playing) return true;
    const wait = (m.transition.plan.aStart - songTime(deck)) / (deck.playbackRate || 1);
    if (wait > 1.5) return true;
    clearTimeout(bridgeTimer.current);
    bridgeTimer.current = setTimeout(() => {
      if (mix.current === m && active() === deck && !deck.paused && usePlayer.getState().playing) startBridge(m, deck);
    }, Math.max(0, wait * 1000 - LEAD_MS));
    return true;
  }

  /**
   * The mix point: the transition takes over from A's file, which stops after a short overlap. If the
   * transition doesn't start promptly, A plays on: where the volume can be set, A only stops once the
   * transition plays, so that's seamless. iPhones stop A as the transition is asked to start (a late start
   * is then a short gap, not a stretch of A heard twice) and play A on from there if it doesn't.
   */
  function startBridge(m: Mix, out: HTMLAudioElement) {
    const br = bridge.current;
    const entry = bridgeEntry(m.transition.plan, songTime(out), useSleep.getState().endOfSong);
    if (!br || entry === null) return dropPrepared();
    // Not loaded enough by now (a slow connection): A plays on. iPhones don't load ahead (they also fix
    // the volume), so there knowing the file is enough.
    const settable = canSetVolume();
    if (br.readyState < (settable ? 3 /* HAVE_FUTURE_DATA */ : 1) /* HAVE_METADATA */) {
      failedBridges.current.add(m.transition.url);
      return dropPrepared();
    }
    m.bridging = true;
    starting.current = m;
    clearTimeout(handoffTimer.current);
    if (fade.current) endFade();
    setTime(br, entry);
    const o: Overlap | null = settable ? { out, in: br, startedAt: null } : null;
    overlap.current = o;
    applyVolumes();
    clearTimeout(startWatch.current);
    startWatch.current = setTimeout(() => starting.current === m && cancelStart(m, true), START_WATCH_MS);
    const started = br.play();
    if (!settable) out.pause();
    started.then(
      () => {
        if (starting.current !== m) return;
        starting.current = null;
        clearTimeout(startWatch.current);
        if (o) startOverlap(o);
        else out.pause();
      },
      () => {
        // Paused meanwhile: dealt with there.
        if (starting.current !== m || !usePlayer.getState().playing) return;
        // Couldn't start it (autoplay rules on some phones): A plays on, then B the usual way.
        cancelStart(m, true);
      },
    );
  }

  /**
   * The transition didn't start: back to A, which plays on from where it is (it stopped only on iPhones).
   * A failed transition isn't tried again; one paused while starting starts again when played.
   */
  function cancelStart(m: Mix, failed: boolean) {
    clearTimeout(startWatch.current);
    cancelStall();
    if (starting.current === m) starting.current = null;
    if (overlap.current?.in === bridge.current) {
      clearInterval(overlapTimer.current);
      overlap.current = null;
    }
    // Not playing the transition any more before its element stops, so its pause isn't taken for the listener's.
    m.bridging = false;
    bridge.current?.pause();
    if (failed) {
      failedBridges.current.add(m.transition.url);
      dropPrepared();
    }
    const deck = active();
    if (deck && usePlayer.getState().playing && deck.paused) void play(deck);
    applyVolumes();
  }

  /** Both files of a join play: fade across (where the volume can be set), then stop the old one. */
  function startOverlap(o: Overlap) {
    if (overlap.current !== o) return;
    // iPhones fix the volume: no fade there, the old file just stops.
    if (!canSetVolume()) return endOverlap();
    o.startedAt = performance.now();
    clearInterval(overlapTimer.current);
    overlapTimer.current = setInterval(() => (performance.now() - o.startedAt! >= OVERLAP_MS ? endOverlap() : applyVolumes()), 4);
    applyVolumes();
  }

  function endOverlap() {
    clearInterval(overlapTimer.current);
    const o = overlap.current;
    overlap.current = null;
    if (o) {
      o.out.pause();
      // The transition is over: its file isn't needed any more.
      if (o.out === bridge.current && !bridging()) clearBridge();
    }
    applyVolumes();
  }

  /** The transition plays on: the clock and the history follow the song shown, and B starts on time. */
  function onBridgeTime() {
    const m = bridging();
    const br = bridge.current;
    if (!m || !br) return;
    if (!m.switched && songTimeDuring(m.transition.plan, br.currentTime).song === 'b') switchToB(m);
    if (bridging() !== m) return;
    const time = shownTime(m, br.currentTime);
    useClock.setState({ time });
    // Not while the store moves on to B (the history starts B then).
    if (!br.paused && handedOff.current === null) playTracker.tick(time);
    // B's time runs at B's rate in the transition: the lock screen's position is kept close.
    if (m.switched && performance.now() - positionAt.current >= 1000) updatePosition();
    applyVolumes();
    approachSwitch(m, br);
    approachLanding(m, br);
  }

  /** Close to the switch: move on to B on time. */
  function approachSwitch(m: Mix, br: HTMLAudioElement) {
    clearTimeout(switchTimer.current);
    if (m.switched || br.paused || !usePlayer.getState().playing) return;
    const wait = (m.transition.plan.switchAt - br.currentTime) / (br.playbackRate || 1);
    if (wait > 1.5) return;
    switchTimer.current = setTimeout(() => {
      if (bridging() === m && !m.switched && !br.paused && usePlayer.getState().playing) switchToB(m);
    }, Math.max(0, wait * 1000));
  }

  /** The middle of the blend: the store (and so the lock screen and the history) moves on to B, already playing. */
  function switchToB(m: Mix) {
    const s = usePlayer.getState();
    // The queue changed under the transition: A again, followed by the new next song.
    if (currentTrack(s)?.fileId !== m.from.fileId || upNext(s)?.fileId !== m.to.fileId) return abandonToA(m, currentSongTime());
    clearTimeout(switchTimer.current);
    m.switched = true;
    // The sleep timer, set during the transition, stops at the end of A: A ends here, but the blend plays
    // out, and the music stops where B would go on alone.
    if (sleepsAtSongEnd()) m.sleepAtLanding = true;
    handedOff.current = m.to.fileId;
    s.next(true);
    useClock.setState({ time: currentSongTime(), duration: m.to.duration });
    updatePosition();
  }

  /** Close to the transition's end: start B's file on time. */
  function approachLanding(m: Mix, br: HTMLAudioElement) {
    if (br.paused || !usePlayer.getState().playing) return;
    const left = (m.transition.plan.length - br.currentTime) / (br.playbackRate || 1);
    if (left > 1.5) return;
    clearTimeout(bridgeTimer.current);
    bridgeTimer.current = setTimeout(() => {
      if (bridging() === m && !br.paused && usePlayer.getState().playing) land(m);
    }, Math.max(0, left * 1000 - LEAD_MS));
  }

  /** The transition's end: B's file takes over where the transition leaves B, as a gapless start. */
  function land(m: Mix) {
    if (!m.switched) switchToB(m);
    const br = bridge.current;
    const incoming = standby();
    if (bridging() !== m || !br || !incoming) return;
    const { plan, continuationUrl } = m.transition;
    mix.current = null;
    clearTimeout(bridgeTimer.current);
    cancelStall();
    swap();
    cue(incoming, m.to, plan.bResume);
    const duration = Number.isFinite(incoming.duration) ? incoming.duration + offsetOf(incoming) : m.to.duration;
    useClock.setState({ time: plan.bResume, duration, buffered: bufferedEnd(incoming) });
    if (m.sleepAtLanding) {
      // The sleep timer: B waits here, paused, for when you're back.
      br.pause();
      clearBridge();
      applyVolumes();
      usePlayer.getState().setPlaying(false);
      return;
    }
    const o: Overlap = { out: br, in: incoming, startedAt: null, ending: m };
    overlap.current = o;
    applyVolumes();
    incoming.play().then(
      () => startOverlap(o),
      () => {
        if (overlap.current === o) {
          clearInterval(overlapTimer.current);
          overlap.current = null;
        }
        // Paused meanwhile: B plays when played again.
        if (active() !== incoming || !usePlayer.getState().playing) return;
        // Couldn't start it on its own (autoplay rules on some phones): B goes on in the element that
        // played A, which has played before. Its end follows the usual way too.
        swap();
        const deck = active()!;
        handoffFailed.current = true;
        if (continuationUrl) loadRemainder(deck, m.to, continuationUrl, plan.bResume);
        else cue(deck, m.to, plan.bResume);
        if (usePlayer.getState().playing) void play(deck);
      },
    );
  }

  /** Leave the transition playing; the caller says what plays instead. */
  function stopBridge(m: Mix) {
    if (mix.current === m) mix.current = null;
    if (starting.current === m) starting.current = null;
    clearTimeout(bridgeTimer.current);
    clearTimeout(switchTimer.current);
    clearTimeout(startWatch.current);
    cancelStall();
    if (overlap.current) {
      clearInterval(overlapTimer.current);
      overlap.current = null;
    }
    clearBridge();
  }

  /** Back to A's own file at `time` (a seek elsewhere in A, a failure, the queue changed); B follows the usual way. */
  function abandonToA(m: Mix, time: number) {
    stopBridge(m);
    clearRemainder(standby());
    const deck = active();
    if (!deck) return;
    seekSong(deck, time);
    if (usePlayer.getState().playing && deck.paused) void play(deck);
    useClock.setState({ time });
    updatePosition();
    applyVolumes();
  }

  /** On to B's own file at `time` (next, a seek past the transition, a failure after the switch). */
  function abandonToB(m: Mix, time: number) {
    stopBridge(m);
    const out = active();
    const incoming = standby();
    if (!incoming) return;
    swap();
    out?.pause();
    cue(incoming, m.to, time);
    if (usePlayer.getState().playing) void play(incoming);
    useClock.setState({ time });
    updatePosition();
    applyVolumes();
  }

  /** A seek during the transition: within it if it shows that time, else out of it to the song's own file. */
  function seekInBridge(m: Mix, time: number) {
    const { plan } = m.transition;
    const br = bridge.current!;
    const intoA = time - plan.aStart;
    const t = m.switched ? transitionTimeFor(plan, time) : intoA >= 0 && intoA < plan.switchAt ? intoA : null;
    if (t !== null) {
      clearTimeout(switchTimer.current);
      br.currentTime = t;
      updatePosition();
    } else if (m.switched) abandonToB(m, time);
    else abandonToA(m, time);
  }

  /** The transition stuck loading: on with the song's own file, B's if it's shown or loaded, else A's. */
  function onBridgeStall() {
    const m = bridging();
    if (!m || stallTimer.current !== undefined) return;
    stallTimer.current = setTimeout(() => {
      stallTimer.current = undefined;
      const br = bridge.current;
      if (bridging() !== m || !br) return;
      if (!m.switched && (standby()?.readyState ?? 0) < 3 /* HAVE_FUTURE_DATA */) return abandonToA(m, currentSongTime());
      const time = bTimeAt(m.transition.plan, br.currentTime);
      const moveOn = !m.switched;
      abandonToB(m, time);
      if (moveOn) {
        // B shows from here: A has ended, as at the switch.
        handedOff.current = m.to.fileId;
        usePlayer.getState().next(true);
      }
    }, STALL_MS);
  }

  function cancelStall() {
    clearTimeout(stallTimer.current);
    stallTimer.current = undefined;
  }

  /** The OS media controls' seek bar: the song shown, wherever it plays from. */
  function updatePosition() {
    const m = bridging();
    if (m && bridge.current) {
      positionAt.current = performance.now();
      const t = bridge.current.currentTime;
      return updatePositionState(currentSongTime(), useClock.getState().duration, m.switched ? valueAt(m.transition.plan.bRate, t) : 1);
    }
    const deck = active();
    if (deck) updatePositionState(songTime(deck), deck.duration + offsetOf(deck), deck.playbackRate);
  }

  // Refresh tracks from a queue saved by an older version (adds fields like recordingId).
  useEffect(() => {
    void healQueue();
  }, []);

  useLoadAhead();
  useDownloads();
  useAutoplay();
  useSleepTimer(applyVolumes);
  useUpcomingTransition();

  // Phones only let an element make sound after a tap on it: the first tap anywhere readies both,
  // so the next song can start on its own later (with the screen off, say).
  useEffect(() => {
    const ready = () => {
      for (const deck of [a.current, b.current, bridge.current]) {
        if (!deck || deck.getAttribute('src')) continue;
        deck.src = silentClip();
        deck.play().then(
          () => {
            if (deck.src === silentClip()) {
              deck.pause();
              deck.removeAttribute('src');
              deck.load();
            }
          },
          () => {},
        );
      }
      window.removeEventListener('pointerdown', ready, true);
      window.removeEventListener('keydown', ready, true);
    };
    window.addEventListener('pointerdown', ready, true);
    window.addEventListener('keydown', ready, true);
    return () => {
      window.removeEventListener('pointerdown', ready, true);
      window.removeEventListener('keydown', ready, true);
    };
  }, []);

  // Load a new source when the track changes, or restart the current one.
  useEffect(() => {
    const deck = active();
    if (!deck) return;
    clearTimeout(handoffTimer.current);
    if (!track) {
      playTracker.finish('changed');
      endFade();
      if (mix.current) stopBridge(mix.current);
      mix.current = null;
      for (const d of [a.current, b.current, bridge.current]) {
        if (!d) continue;
        d.pause();
        d.removeAttribute('src');
        delete d.dataset.fileId;
        delete d.dataset.offset;
        delete d.dataset.url;
        d.load();
      }
      useClock.setState({ time: 0, duration: 0, buffered: 0, error: null });
      return;
    }
    void loadLevels([track, upNext(usePlayer.getState())]);

    const m = bridging();
    if (m && handedOff.current === track.fileId) {
      // The transition reached its switch: B plays already, inside the transition.
      handedOff.current = null;
      playTracker.finish('ended');
      playTracker.start(track);
      useClock.setState({ time: currentSongTime(), duration: track.duration, buffered: 0, error: null });
      applyVolumes();
      return;
    }
    if (m && track.fileId === m.to.fileId) {
      // Next during the transition: B, where the transition had it. Past the switch, B played again from the start.
      const again = m.switched;
      const time = again ? 0 : bTimeAt(m.transition.plan, bridge.current!.currentTime);
      handedOff.current = null;
      playTracker.finish(again ? 'ended' : 'changed');
      playTracker.start(track);
      abandonToB(m, time);
      useClock.setState({ time, duration: track.duration, buffered: 0, error: null });
      return;
    }
    // Any other song (previous, one picked from the queue): the transition stops, the song loads as usual.
    if (m) {
      stopBridge(m);
      clearRemainder(standby());
    }
    dropPrepared();

    // Started early by the engine (no gap, or a crossfade): already playing.
    if (handedOff.current === track.fileId) {
      handedOff.current = null;
      playTracker.finish('ended');
      playTracker.start(track);
      useClock.setState({ time: songTime(deck), duration: track.duration, buffered: 0, error: null });
      applyVolumes();
      return;
    }
    handedOff.current = null;
    // After a failed early start, the other element may not be allowed to play on its own.
    const mayUseOther = !handoffFailed.current;
    handoffFailed.current = false;
    endFade();

    const resume = firstLoad.current ? usePlayer.getState().resumeAt : 0;
    firstLoad.current = false;
    let playOn = deck;
    if (!holds(deck, track)) {
      // The listening history: the song that was playing is reported, the new one starts counting.
      playTracker.finish('changed');
      playTracker.start(track);
      const other = standby();
      if (mayUseOther && other && holds(other, track) && other.readyState >= 2 /* HAVE_CURRENT_DATA */) {
        // Already loaded (it was next, or just before): switch to it.
        swap();
        deck.pause();
        playOn = other;
        seekSong(other, resume);
        useClock.setState({ time: resume, duration: track.duration, buffered: 0, error: null });
      } else {
        switching.current = true;
        load(deck, track);
        useClock.setState({ time: resume, duration: track.duration, buffered: 0, error: null });
        if (resume > 0) {
          deck.addEventListener('loadedmetadata', () => (deck.currentTime = resume), { once: true });
        }
      }
    } else {
      // Played again from the start (repeat one, "previous" near the start): it counts as heard through.
      playTracker.finish('ended');
      playTracker.start(track);
      seekSong(deck, 0);
      useClock.setState({ time: 0 });
    }
    applyVolumes();
    if (usePlayer.getState().playing) void play(playOn);
  }, [track?.fileId, restartToken]);

  useEffect(() => {
    // Paused as the transition was starting: A again, where it stopped; the transition starts again when played.
    const m = bridging();
    if (!playing && m && starting.current === m) cancelStart(m, false);
    const deck = playingDeck();
    if (!deck || !deck.getAttribute('src')) return;
    if (playing && deck.paused) void play(deck);
    if (!playing) {
      clearTimeout(handoffTimer.current);
      clearTimeout(bridgeTimer.current);
      clearTimeout(switchTimer.current);
      // Still loading when played again, it says so again.
      cancelStall();
      if (!deck.paused) deck.pause();
      if (overlap.current) endOverlap();
      if (fade.current) endFade();
    }
  }, [playing]);

  // Nothing left to happen once the player is gone.
  useEffect(
    () => () => {
      for (const timer of [handoffTimer, bridgeTimer, switchTimer, startWatch, stallTimer]) clearTimeout(timer.current);
      clearInterval(overlapTimer.current);
      clearInterval(fadeTimer.current);
    },
    [],
  );

  // A transition loads ahead once ready for the songs playing next, and is dropped when they change.
  useEffect(() => {
    const offTransition = useTransition.subscribe(prepareBridge);
    const offSleep = useSleep.subscribe(prepareBridge);
    const offQueue = usePlayer.subscribe((s, prev) => {
      if (s.queue === prev.queue && s.order === prev.order && s.pos === prev.pos && s.repeat === prev.repeat) return;
      const m = bridging();
      // The next song changed during the transition, before it showed: A again, followed by the new next song.
      if (m && !m.switched && currentTrack(s)?.fileId === m.from.fileId && upNext(s)?.fileId !== m.to.fileId) abandonToA(m, currentSongTime());
      prepareBridge();
    });
    return () => {
      offTransition();
      offSleep();
      offQueue();
    };
  }, []);

  // Volume, mute, levels and the level setting: every element follows.
  useEffect(() => {
    applyVolumes();
    const offPlayer = usePlayer.subscribe((s, prev) => {
      if (s.volume !== prev.volume || s.muted !== prev.muted || s.order !== prev.order) applyVolumes();
    });
    const offLevels = useLevels.subscribe(applyVolumes);
    const offPrefs = usePrefs.subscribe((s, prev) => s.levelVolume !== prev.levelVolume && applyVolumes());
    return () => {
      offPlayer();
      offLevels();
      offPrefs();
    };
  }, []);

  // Seek requests from the UI.
  useEffect(
    () =>
      useClock.subscribe((s, prev) => {
        const deck = active();
        if (deck && s.seekRequest && s.seekRequest !== prev.seekRequest) {
          clearTimeout(handoffTimer.current);
          clearTimeout(bridgeTimer.current);
          if (fade.current) endFade();
          const m = bridging();
          if (m) return seekInBridge(m, s.seekRequest.time);
          if (seekSong(deck, s.seekRequest.time) && usePlayer.getState().playing) void play(deck);
          updatePosition();
        }
      }),
    [],
  );

  // Remember the position so a reload resumes where you left off.
  useEffect(() => {
    const save = () => {
      const deck = active();
      if (deck?.getAttribute('src')) usePlayer.getState().setResumeAt(currentSongTime());
    };
    // Closing the app reports the song so far (never as a skip); it counts afresh if the page comes back.
    const close = () => {
      save();
      playTracker.finish('closed');
      const current = currentTrack(usePlayer.getState());
      if (current) playTracker.start(current);
    };
    const id = setInterval(save, 5000);
    window.addEventListener('pagehide', close);
    return () => {
      clearInterval(id);
      window.removeEventListener('pagehide', close);
    };
  }, []);

  // OS media controls: metadata.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artistName,
      album: track.albumTitle,
      artwork: track.coverUrl
        ? [256, 512].map((s) => ({
            src: new URL(`${track.coverUrl}${track.coverUrl!.includes('?') ? '&' : '?'}size=${s}`, location.href).href,
            sizes: `${s}x${s}`,
            type: 'image/webp',
          }))
        : [],
    });
  }, [track]);

  // OS media controls: actions.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const p = usePlayer.getState;
    const seekBy = (delta: number) => {
      const { duration, seek } = useClock.getState();
      if (playingDeck()) seek(Math.max(0, Math.min(duration || 0, currentSongTime() + delta)));
    };
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => p().setPlaying(true)],
      ['pause', () => p().setPlaying(false)],
      ['stop', () => p().setPlaying(false)],
      ['nexttrack', () => p().next()],
      ['previoustrack', () => p().prev(currentSongTime())],
      ['seekbackward', (d) => seekBy(-(d.seekOffset ?? 10))],
      ['seekforward', (d) => seekBy(d.seekOffset ?? 10)],
      ['seekto', (d) => d.seekTime !== undefined && useClock.getState().seek(d.seekTime)],
    ];
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // Unsupported action on this browser.
      }
    }
  }, []);

  useEffect(() => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }, [playing]);

  // Tab title follows the current track; so do the accent color and favicon, unless Settings → Appearance fixes the color.
  useEffect(() => {
    document.title = track ? `${track.title} · ${track.artistName}` : 'Playarr';
    const apply = (color: string) => {
      document.documentElement.style.setProperty('--accent', color);
      setFaviconAccent(color);
    };
    if (accent !== 'album') {
      apply(accent);
      return;
    }
    if (!track?.coverUrl) {
      apply(DEFAULT_ACCENT);
      return;
    }
    let cancelled = false;
    void extractAccent(sized(track.coverUrl, 96)!).then((color) => {
      if (!cancelled) apply(color ?? DEFAULT_ACCENT);
    });
    return () => {
      cancelled = true;
    };
  }, [track, accent]);

  // Events only count from the element playing the current song (the other is loading or fading out),
  // not while it plays the silent clip that readies it, nor while a transition plays instead.
  const isActive = (e: { currentTarget: HTMLAudioElement }) => e.currentTarget === active() && !!e.currentTarget.dataset.fileId && !bridging();
  const deckProps: React.AudioHTMLAttributes<HTMLAudioElement> = {
    preload: 'auto',
    onTimeUpdate: (e) => {
      if (!isActive(e)) return tickFade();
      const deck = e.currentTarget;
      useClock.setState({ time: songTime(deck) });
      if (!deck.paused) playTracker.tick(songTime(deck));
      if (!approachBridge(deck)) approachEnd(deck);
      tickFade();
    },
    onSeeking: (e) => isActive(e) && playTracker.pause(),
    onDurationChange: (e) => {
      if (!isActive(e)) return;
      const d = e.currentTarget.duration;
      if (Number.isFinite(d)) useClock.setState({ duration: d + offsetOf(e.currentTarget) });
      updatePosition();
    },
    onProgress: (e) => {
      if (!isActive(e)) return;
      const buffered = e.currentTarget.buffered;
      if (buffered.length) useClock.setState({ buffered: buffered.end(buffered.length - 1) + offsetOf(e.currentTarget) });
    },
    onWaiting: (e) => isActive(e) && useClock.setState({ loading: true }),
    onPlaying: (e) => {
      if (!isActive(e)) return;
      switching.current = false;
      useClock.setState({ loading: false, error: null });
      updatePosition();
    },
    onCanPlay: (e) => {
      if (!isActive(e)) return;
      switching.current = false;
      useClock.setState({ loading: false });
    },
    // Keep the store in sync when the OS/browser pauses or resumes on its own.
    onPlay: (e) => isActive(e) && !usePlayer.getState().playing && usePlayer.getState().setPlaying(true),
    onPause: (e) => {
      if (!isActive(e)) return;
      playTracker.pause();
      clearTimeout(handoffTimer.current);
      if (switching.current || e.currentTarget.ended) return;
      if (usePlayer.getState().playing) usePlayer.getState().setPlaying(false);
    },
    onEnded: (e) => {
      if (!isActive(e)) return tickFade();
      playTracker.finish('ended');
      if (sleepsAtSongEnd()) {
        // The sleep timer: on to the next song, paused, for when you're back.
        const p = usePlayer.getState();
        p.next(true);
        p.setPlaying(false);
        return;
      }
      // The next song is loaded but wasn't started early (timers are slowed in the background): start it now.
      if (!handOff(0, () => usePlayer.getState().next(true))) usePlayer.getState().next(true);
    },
    onError: (e) => {
      const deck = e.currentTarget;
      if (!isActive(e)) {
        // The next song didn't load: it loads again the usual way when its turn comes.
        if (deck.getAttribute('src') !== silentClip()) delete deck.dataset.fileId;
        return;
      }
      switching.current = false;
      if (skipToKept()) return;
      void reportError(deck);
    },
  };

  // The transition's element: its events count while it plays the transition.
  const isBridging = (e: { currentTarget: HTMLAudioElement }) => e.currentTarget === bridge.current && !!bridging();
  const bridgeProps: React.AudioHTMLAttributes<HTMLAudioElement> = {
    preload: 'auto',
    onTimeUpdate: (e) => isBridging(e) && onBridgeTime(),
    onSeeking: (e) => isBridging(e) && playTracker.pause(),
    onWaiting: (e) => {
      if (!isBridging(e)) return;
      useClock.setState({ loading: true });
      onBridgeStall();
    },
    onStalled: (e) => isBridging(e) && onBridgeStall(),
    onPlaying: (e) => {
      if (!isBridging(e)) return;
      cancelStall();
      useClock.setState({ loading: false, error: null });
      updatePosition();
    },
    onCanPlay: (e) => isBridging(e) && useClock.setState({ loading: false }),
    onPlay: (e) => isBridging(e) && !usePlayer.getState().playing && usePlayer.getState().setPlaying(true),
    onPause: (e) => {
      if (!isBridging(e)) return;
      playTracker.pause();
      clearTimeout(bridgeTimer.current);
      if (!e.currentTarget.ended && usePlayer.getState().playing) usePlayer.getState().setPlaying(false);
    },
    // B wasn't started on time (timers are slowed in the background): start it now.
    onEnded: (e) => {
      const m = isBridging(e) ? bridging() : null;
      if (m) land(m);
    },
    onError: (e) => {
      const url = e.currentTarget.dataset.url;
      if (!url || e.currentTarget.getAttribute('src') === silentClip()) return;
      // The transition can't play (not found, offline, unreadable): the songs follow each other the usual way.
      failedBridges.current.add(url);
      const m = mix.current;
      if (m?.transition.url !== url) return;
      if (!m.bridging) return dropPrepared();
      const time = shownTime(m, e.currentTarget.currentTime);
      if (m.switched) abandonToB(m, time);
      else abandonToA(m, time);
    },
  };

  return (
    <>
      <audio ref={a} {...deckProps} />
      <audio ref={b} {...deckProps} />
      <audio ref={bridge} {...bridgeProps} />
    </>
  );
}

/** Offline, a song not on this device can't play: go on to the next one that is. */
function skipToKept(): boolean {
  if (navigator.onLine) return false;
  const s = usePlayer.getState();
  const { songs } = useOffline.getState();
  for (let p = s.pos + 1; p < s.order.length; p++) {
    if (s.queue[s.order[p]!]!.fileId in songs) {
      s.jumpTo(p);
      toast('Offline: skipped songs that aren’t on this device');
      return true;
    }
  }
  return false;
}

async function play(audio: HTMLAudioElement) {
  try {
    useClock.setState({ loading: true });
    await audio.play();
  } catch (err) {
    useClock.setState({ loading: false });
    // Autoplay blocked (e.g. after a reload): wait for the user to press play.
    if ((err as DOMException).name === 'NotAllowedError') usePlayer.getState().setPlaying(false);
  }
}

function updatePositionState(position: number, duration: number, playbackRate: number) {
  if (!('mediaSession' in navigator) || !Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({ duration, position: Math.max(0, Math.min(position, duration)), playbackRate: playbackRate || 1 });
  } catch {
    // Ignore invalid state during source changes.
  }
}

/** <audio> errors carry no detail, so ask the server why the stream failed. */
async function reportError(audio: HTMLAudioElement) {
  if (!audio.src) return;
  let message = 'Playback failed';
  try {
    const res = await fetch(audio.src, { headers: { Range: 'bytes=0-1' } });
    if (!res.ok) message = ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? message;
    else message = 'This file format is not supported by your browser';
  } catch {
    message = 'Cannot reach the Playarr server';
  }
  useClock.setState({ loading: false, error: message });
  usePlayer.getState().setPlaying(false);
  toast(message, 'error');
}
