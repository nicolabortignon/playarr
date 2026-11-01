# Beatmatched transitions — design

Status: approved 2026-11-01. Implementation plan: `2026-11-01-beatmatching.md`.

## Goal

Songs flow into each other the way a DJ would mix them, deciding each transition from the two songs:
a long beatmatched blend, a quick mix, or straight after (gapless). It sits next to the current crossfade
option and works on every device, a locked iPhone included. The phone always shows two songs, never a third
"transition" track.

## Decisions

| Question | Decision |
|---|---|
| Who picks the style | Automatic per transition, plus a per-queue override (Auto · Party · No mixing) |
| Where mixing happens | Server renders each transition (ffmpeg + our own DSP); desktop browsers also mix live for skips |
| Audio path on iPhone | No Web Audio needed: rendered transitions are ordinary audio, so they play with the screen locked |
| First version includes | Harmonic mixing, mix-friendly ordering for radio/mixes, a transition view, manual cue points |

## 1. The mix map (server analysis)

The analyzer gains a **mix map** per recording, stored next to the existing audio features
(`ANALYSIS_VERSION` bump; songs are re-measured in the background, one at a time, as now).

- **Whole song.** Long songs are measured at both ends (the outro is where you mix out), not just the first 7 minutes.
- **Beat grid.** Tempo to 0.01 BPM, the first beat's time, every beat (a constant grid with a drift check),
  downbeats (bar starts) and phrase starts (8/16/32 beats). `gridStable: false` for songs whose tempo wanders
  (live drummers); those never get long blends.
- **Key.** From a chromagram matched against major/minor key profiles, as a Camelot code (8A, 9B…) with a confidence.
- **Mix points.** Intro (opening with steady beat and little else, a good place to bring the song in), outro
  (the same at the end, a good place to leave), first drop (first big rise in energy), cold start/end versus
  fade-in/fade-out, and an energy value per phrase.
- **Manual cue points.** Optional per-recording in/out overrides (stored by recording, so they survive
  re-matching), which win over the detected ones.

Requires ffmpeg and `ANALYSIS=on`, as now. A song without a map transitions the way it does today
(crossfade or gapless).

## 2. The planner (one shared function)

`planTransition(a, b, context) → TransitionPlan`, pure and deterministic, in a new package `packages/mix`
used by both the server renderer and the desktop live mixer, so the two always agree.

**Style**

- **Straight (gapless):** an album played in order, ambient or beatless music, a cold end into a cold start,
  or the queue set to *No mixing*.
- **Long blend (16–64 beats):** both grids stable, tempos within ~8% (or half/double time), compatible keys,
  and enough intro/outro room on both sides. *Party* prefers longer blends.
- **Quick mix (4–8 beats, or a downbeat cut with a short echo/filter):** tempos roughly compatible but keys
  clash, or no room for a long blend.
- **Fade:** no usable beat on either side: today's crossfade, aligned to phrase ends.

**Placement.** A leaves on a phrase boundary inside its outro, and B's phrase start lands on that same downbeat.

**Tempo.** B is stretched to A's tempo during the blend, pitch kept, then eases back to its own tempo over
16–32 bars, never more than ~8% off; beyond that, quick mix or fade.

**EQ.** A long blend brings B in with its lows cut, swaps the bass on a phrase line halfway, then fades A out.
A quick mix sweeps a high-pass filter over A.

**Settings.** Settings → Playback → *Transitions*: Off · Crossfade (seconds) · DJ mix. The per-queue override
lives in Now Playing and the queue.

## 3. Rendering and playback

**Shared renderer** (`packages/mix`, no dependencies): PCM of A's outro and B's intro + the plan → mixed PCM:
time-stretch (WSOLA, pitch kept), biquad EQ and filters, gain automation, mixing. The server runs it on its
DSP worker thread; desktop browsers run it in a Web Worker.

**Server: transition files.** While A plays, the player asks for A→B. The server decodes the two sections
with ffmpeg (stereo, 44.1 kHz), renders them, and stores a **FLAC** file (lossless, sample-exact, plays in every
browser including iOS). Files are cached by (A, B, mode, analysis version, cue points), rendered at low
priority one at a time, and kept to a size cap like the artwork cache. A long blend includes B's tempo ease-back
(1–2 minutes); a quick mix is a few seconds. When B is a format that can't seek sample-exactly (VBR MP3), the
server also stores B's remainder as FLAC, so the join can't land off the beat.

**Player: three audio elements.** A plays up to the mix point → the transition file → B from the matching
position. Joins fall on downbeats with a 15 ms overlap, where the kick masks them.

**The phone sees two songs.** The transition is internal: never a queue item, never a lock-screen track.
Lock screen and Media Session show A, then B, switching once at the middle of the blend (the bass swap). The
seek bar shows B's own timeline. History counts A up to its mix point and B from the transition. Next during a
transition jumps into B; previous behaves as today. Seeking during a transition abandons it and continues B at
the matching point. The sleep timer, radio and downloads keep working.

**Fallbacks.**
- Skip, reorder, or a transition not ready yet → desktop: the live mixer renders a quick mix in a Web Worker
  (B's start is loaded ahead anyway) and plays it through Web Audio, beat-locked to A. Phones: an on-the-beat
  cut, or the plain crossfade where the volume can be set.
- No mix map → today's crossfade/gapless.
- Downloads also fetch the transition files for their own song order, so mixed playback works offline.

## 4. Extras

- **Harmonic mixing.** Key compatibility in the planner (Camelot neighbours for long blends, else a quick mix).
  A low-confidence key never blocks a blend on its own.
- **Mix-friendly ordering** (radio, autoplay, generated mixes; your own queue is never reordered). The pickers
  gain a "blends well" term (tempo distance, key compatibility, energy flow), and mixes are ordered so that
  neighbours blend and energy builds and settles.
- **Transition view.** Now Playing (and the queue) show the next transition: style, length in bars, both
  tempos and keys, a compact energy/beat picture of both songs with the mix region, and the per-queue override.
- **Manual cue points.** Song menu → *Edit mix points*: energy and beat grid with draggable in/out markers that
  snap to bars, plus a reset. Stored per recording on the server, shared, and they invalidate cached transitions.

## 5. Testing

- **Analysis:** synthetic songs with known tempo, beats, downbeats, key and intro/outro, checked against what's
  detected; a real-music sanity pass on a few files.
- **Planner:** table-driven tests for each style decision and each fallback.
- **Renderer:** sample-accurate beat alignment in the output, stretch accuracy, the bass swap, seamless joins.
- **Player:** the fake-audio harness extended to three elements; the lock screen switches once; skip, seek,
  sleep timer and downloads during a transition.
- **Server:** render jobs, caching, the size cap.
- **Real ears:** a listening pass on the NAS, which tests can't replace.

## Risks

- **Beat and downbeat detection on real music** is the hardest part; mistakes produce flams or off-phrase
  mixes. Mitigations: conservative style choice (low confidence → quick mix or fade), the grid-stability check,
  manual cue points.
- **Server load** of rendering: low priority, one at a time, cached, rendered only for the upcoming
  transition. Disk use is capped.
- **Join precision** between audio elements (±10–30 ms): joins on downbeats with a short overlap; the
  content on both sides of a join is identical, so an error is a few milliseconds skipped or repeated, not a flam.
- **Mobile data:** transition files are FLAC (~5 MB/min); quick mixes are tiny, long blends cost a few MB.
