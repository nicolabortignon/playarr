import type { Track } from '@playarr/shared';
import { useEffect, useRef } from 'react';
import { sized } from '../lib/api';
import { extractAccent } from '../lib/color';
import { setFaviconAccent } from '../lib/favicon';
import { usePrefs } from '../lib/prefs';
import { toast } from '../lib/toast';
import { canSetVolume, fadeCurve, fadeSeconds, levelGain, silentClip, upNext } from './decks';
import { useDownloads } from './downloads';
import { healQueue } from './healQueue';
import { loadLevels, useLevels } from './levels';
import { useLoadAhead } from './loadAhead';
import { useOffline } from './offline';
import { playTracker } from './playTracker';
import { useAutoplay } from './radio';
import { sleepGain, sleepsAtSongEnd, useSleep, useSleepTimer } from './sleep';
import { currentTrack, useClock, useCurrentTrack, usePlayer } from './store';

const DEFAULT_ACCENT = '#ff7a1a';
/** Have the next song loaded this long before the current one ends. */
const PRELOAD_S = 30;
/** Start the next song this much early, for the moment it takes to start. */
const LEAD_MS = 30;

interface Fade {
  out: HTMLAudioElement;
  in: HTMLAudioElement;
  seconds: number;
}

/**
 * Owns the two <audio> elements and bridges them to the player store and the OS media controls. One
 * plays; the other loads the song that comes next and starts it right as the first ends (no gap), or
 * a little before, fading one into the other (Settings → Playback → Crossfade).
 */
export function AudioEngine() {
  const a = useRef<HTMLAudioElement>(null);
  const b = useRef<HTMLAudioElement>(null);
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

  function load(deck: HTMLAudioElement, t: Track) {
    loaded.current.set(deck, t);
    deck.dataset.fileId = String(t.fileId);
    deck.src = t.streamUrl;
  }

  const holds = (deck: HTMLAudioElement | null, t: Track | undefined) => !!deck && !!t && deck.dataset.fileId === String(t.fileId);

  /** Each element's volume: the volume set, the song's level, and where it is in a fade. */
  function applyVolumes() {
    const s = usePlayer.getState();
    const { levelVolume } = usePrefs.getState();
    const { levels } = useLevels.getState();
    const settable = canSetVolume();
    for (const deck of [a.current, b.current]) {
      if (!deck) continue;
      deck.muted = s.muted;
      const t = loaded.current.get(deck);
      let v = s.volume * s.volume * sleepGain(); // perceptual curve; fading out for the sleep timer
      if (settable && levelVolume && t) v *= levelGain(t, levels[t.recordingId], s);
      const f = fade.current;
      if (f?.out === deck) v *= fadeCurve(remaining(deck) / f.seconds);
      else if (f?.in === deck) v *= fadeCurve(deck.currentTime / f.seconds);
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
    if (!out || !incoming || !holds(incoming, next) || handedOff.current !== null || handoffFailed.current) return false;
    handedOff.current = next!.fileId;
    swap();
    if (seconds > 0) {
      fade.current = { out, in: incoming, seconds };
      fadeTimer.current = setInterval(tickFade, 100);
    }
    incoming.currentTime = 0;
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
    const seconds = canSetVolume() ? fadeSeconds(loaded.current.get(deck), next, usePrefs.getState().crossfade) : 0;
    const wait = left - seconds;
    if (wait > 1.5) return;
    clearTimeout(handoffTimer.current);
    handoffTimer.current = setTimeout(() => {
      const now = active();
      if (now === deck && !deck.paused && usePlayer.getState().playing && !useSleep.getState().endOfSong) handOff(seconds);
    }, Math.max(0, wait * 1000 - LEAD_MS));
  }

  // Refresh tracks from a queue saved by an older version (adds fields like recordingId).
  useEffect(() => {
    void healQueue();
  }, []);

  useLoadAhead();
  useDownloads();
  useAutoplay();
  useSleepTimer(applyVolumes);

  // Phones only let an element make sound after a tap on it: the first tap anywhere readies both,
  // so the next song can start on its own later (with the screen off, say).
  useEffect(() => {
    const ready = () => {
      for (const deck of [a.current, b.current]) {
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
      for (const d of [a.current, b.current]) {
        if (!d) continue;
        d.pause();
        d.removeAttribute('src');
        delete d.dataset.fileId;
        d.load();
      }
      useClock.setState({ time: 0, duration: 0, buffered: 0, error: null });
      return;
    }
    void loadLevels([track, upNext(usePlayer.getState())]);

    // Started early by the engine (no gap, or a crossfade): already playing.
    if (handedOff.current === track.fileId) {
      handedOff.current = null;
      playTracker.finish('ended');
      playTracker.start(track);
      useClock.setState({ time: deck.currentTime, duration: track.duration, buffered: 0, error: null });
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
        other.currentTime = resume;
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
      deck.currentTime = 0;
      useClock.setState({ time: 0 });
    }
    applyVolumes();
    if (usePlayer.getState().playing) void play(playOn);
  }, [track?.fileId, restartToken]);

  useEffect(() => {
    const deck = active();
    if (!deck || !deck.getAttribute('src')) return;
    if (playing && deck.paused) void play(deck);
    if (!playing) {
      clearTimeout(handoffTimer.current);
      if (!deck.paused) deck.pause();
      if (fade.current) endFade();
    }
  }, [playing]);

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
          if (fade.current) endFade();
          deck.currentTime = s.seekRequest.time;
          updatePositionState(deck);
        }
      }),
    [],
  );

  // Remember the position so a reload resumes where you left off.
  useEffect(() => {
    const save = () => {
      const deck = active();
      if (deck?.getAttribute('src')) usePlayer.getState().setResumeAt(deck.currentTime);
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
      const deck = active();
      if (deck) useClock.getState().seek(Math.max(0, Math.min(deck.duration || 0, deck.currentTime + delta)));
    };
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => p().setPlaying(true)],
      ['pause', () => p().setPlaying(false)],
      ['stop', () => p().setPlaying(false)],
      ['nexttrack', () => p().next()],
      ['previoustrack', () => p().prev(active()?.currentTime ?? 0)],
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
  // and not while it plays the silent clip that readies it.
  const isActive = (e: { currentTarget: HTMLAudioElement }) => e.currentTarget === active() && !!e.currentTarget.dataset.fileId;
  const deckProps: React.AudioHTMLAttributes<HTMLAudioElement> = {
    preload: 'auto',
    onTimeUpdate: (e) => {
      if (!isActive(e)) return tickFade();
      const deck = e.currentTarget;
      useClock.setState({ time: deck.currentTime });
      if (!deck.paused) playTracker.tick(deck.currentTime);
      approachEnd(deck);
      tickFade();
    },
    onSeeking: (e) => isActive(e) && playTracker.pause(),
    onDurationChange: (e) => {
      if (!isActive(e)) return;
      const d = e.currentTarget.duration;
      if (Number.isFinite(d)) useClock.setState({ duration: d });
      updatePositionState(e.currentTarget);
    },
    onProgress: (e) => {
      if (!isActive(e)) return;
      const buffered = e.currentTarget.buffered;
      if (buffered.length) useClock.setState({ buffered: buffered.end(buffered.length - 1) });
    },
    onWaiting: (e) => isActive(e) && useClock.setState({ loading: true }),
    onPlaying: (e) => {
      if (!isActive(e)) return;
      switching.current = false;
      useClock.setState({ loading: false, error: null });
      updatePositionState(e.currentTarget);
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

  return (
    <>
      <audio ref={a} {...deckProps} />
      <audio ref={b} {...deckProps} />
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

function updatePositionState(audio: HTMLAudioElement) {
  if (!('mediaSession' in navigator) || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      position: Math.min(audio.currentTime, audio.duration),
      playbackRate: audio.playbackRate,
    });
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
