import { useEffect, useRef } from 'react';
import { sized } from '../lib/api';
import { extractAccent } from '../lib/color';
import { setFaviconAccent } from '../lib/favicon';
import { toast } from '../lib/toast';
import { healQueue } from './healQueue';
import { useClock, useCurrentTrack, usePlayer } from './store';

const DEFAULT_ACCENT = '#ff7a1a';

/** Owns the single <audio> element and bridges it to the player store and the OS media controls. */
export function AudioEngine() {
  const ref = useRef<HTMLAudioElement>(null);
  const track = useCurrentTrack();
  const playing = usePlayer((s) => s.playing);
  const restartToken = usePlayer((s) => s.restartToken);
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const firstLoad = useRef(true);
  // True while a new source is loading; some browsers fire "pause" during a src swap.
  const switching = useRef(false);

  // Refresh tracks from a queue saved by an older version (adds fields like recordingId).
  useEffect(() => {
    void healQueue();
  }, []);

  // Load a new source when the track changes, or restart the current one.
  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    if (!track) {
      audio.removeAttribute('src');
      audio.load();
      useClock.setState({ time: 0, duration: 0, buffered: 0, error: null });
      return;
    }
    const resume = firstLoad.current ? usePlayer.getState().resumeAt : 0;
    firstLoad.current = false;

    if (audio.dataset.fileId !== String(track.fileId)) {
      audio.dataset.fileId = String(track.fileId);
      switching.current = true;
      audio.src = track.streamUrl;
      useClock.setState({ time: resume, duration: track.duration, buffered: 0, error: null });
      if (resume > 0) {
        audio.addEventListener('loadedmetadata', () => (audio.currentTime = resume), { once: true });
      }
    } else {
      audio.currentTime = 0;
      useClock.setState({ time: 0 });
    }
    if (usePlayer.getState().playing) void play(audio);
  }, [track?.fileId, restartToken]);

  useEffect(() => {
    const audio = ref.current;
    if (!audio || !audio.src) return;
    if (playing && audio.paused) void play(audio);
    if (!playing && !audio.paused) audio.pause();
  }, [playing]);

  useEffect(() => {
    if (ref.current) ref.current.volume = volume * volume; // perceptual curve
  }, [volume]);

  useEffect(() => {
    if (ref.current) ref.current.muted = muted;
  }, [muted]);

  // Seek requests from the UI.
  useEffect(
    () =>
      useClock.subscribe((s, prev) => {
        const audio = ref.current;
        if (audio && s.seekRequest && s.seekRequest !== prev.seekRequest) {
          audio.currentTime = s.seekRequest.time;
          updatePositionState(audio);
        }
      }),
    [],
  );

  // Remember the position so a reload resumes where you left off.
  useEffect(() => {
    const save = () => {
      const audio = ref.current;
      if (audio?.src) usePlayer.getState().setResumeAt(audio.currentTime);
    };
    const id = setInterval(save, 5000);
    window.addEventListener('pagehide', save);
    return () => {
      clearInterval(id);
      window.removeEventListener('pagehide', save);
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
      const audio = ref.current;
      if (audio) useClock.getState().seek(Math.max(0, Math.min(audio.duration || 0, audio.currentTime + delta)));
    };
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => p().setPlaying(true)],
      ['pause', () => p().setPlaying(false)],
      ['stop', () => p().setPlaying(false)],
      ['nexttrack', () => p().next()],
      ['previoustrack', () => p().prev(ref.current?.currentTime ?? 0)],
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

  // Tab title, accent color and favicon follow the current track.
  useEffect(() => {
    document.title = track ? `${track.title} · ${track.artistName}` : 'Playarr';
    const apply = (color: string) => {
      document.documentElement.style.setProperty('--accent', color);
      setFaviconAccent(color);
    };
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
  }, [track]);

  return (
    <audio
      ref={ref}
      preload="auto"
      onTimeUpdate={(e) => useClock.setState({ time: e.currentTarget.currentTime })}
      onDurationChange={(e) => {
        const d = e.currentTarget.duration;
        if (Number.isFinite(d)) useClock.setState({ duration: d });
        updatePositionState(e.currentTarget);
      }}
      onProgress={(e) => {
        const b = e.currentTarget.buffered;
        if (b.length) useClock.setState({ buffered: b.end(b.length - 1) });
      }}
      onWaiting={() => useClock.setState({ loading: true })}
      onPlaying={(e) => {
        switching.current = false;
        useClock.setState({ loading: false, error: null });
        updatePositionState(e.currentTarget);
      }}
      onCanPlay={() => {
        switching.current = false;
        useClock.setState({ loading: false });
      }}
      // Keep the store in sync when the OS/browser pauses or resumes on its own.
      onPlay={() => !usePlayer.getState().playing && usePlayer.getState().setPlaying(true)}
      onPause={(e) => {
        if (switching.current || e.currentTarget.ended) return;
        if (usePlayer.getState().playing) usePlayer.getState().setPlaying(false);
      }}
      onEnded={() => usePlayer.getState().next(true)}
      onError={(e) => {
        switching.current = false;
        void reportError(e.currentTarget);
      }}
    />
  );
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
