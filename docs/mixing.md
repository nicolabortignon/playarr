# How Playarr mixes songs

This is the whole DJ-mix pipeline, from measuring a song to the moment the next one takes over. It covers what each step decides, the numbers it decides with, and why. The code lives in `packages/mix` (analysis, planner, renderer), `apps/server/src/analysis` and `apps/server/src/transitions` (running them), and `apps/web/src/player` (playing the result).

It runs in four stages:

1. **Analysis**: once per song, on the server. It produces a *mix map*: tempo, beat grid, bars, phrases, key, intro, outro, how steady the beat is phrase by phrase, and where the sound starts and ends.
2. **Planning**: for each pair of songs, from the two mix maps. It produces a *plan*: the style, where each song is cut, how fast B plays, and the gain and EQ curves. The planner is pure and deterministic, so the server and the browser always agree on a plan.
3. **Rendering**: on the server, in the background. It turns the plan and the two songs' audio into a transition file.
4. **Playback**: in the browser. The player plays A, then the transition file, then B, and joins each file to the next without a gap.

---

## 1. Analysis: the mix map

`analyzeMix` (`packages/mix/src/analysis/mixMap.ts`) measures a song. The server decodes it once with ffmpeg at 22 050 Hz mono:

- the first 7 minutes (`MIX_HEAD_SECONDS = 420`; all of a shorter song);
- for a longer song, also its last 3 minutes (`MIX_TAIL_SECONDS = 180`), because that's where it gets mixed out. The tail is placed in the song to the sample, since the beat grid is carried from the head to the tail with only 25 ms of tolerance.

Two analyses run on that audio.

- **The beat model.** [Beat This!](https://github.com/CPJKU/beat_this) is a small neural beat tracker (ONNX, run with onnxruntime-web's WebAssembly build). It gives, every 20 ms, how likely a beat and a downbeat are there. It hears the beat the way people do, so it doesn't lock onto off-beat hi-hats, doesn't count a song at half or double its tempo, and knows where bars start.
- **The onset analysis** (`onset.ts`, at 11 025 Hz) gives per-frame loudness, bass energy, mid/high energy and onset strength. It provides the precision the model lacks: tempo to 0.01 BPM, and beats placed on the transients.

### 1.1 Tempo and grid (`neuralGrid.ts`, `beatGrid.ts`)

1. **Beats.** The model's peaks above even odds, located to a fraction of a frame.
2. **Tempo.** The median gap between those beats, doubled below 70 BPM and halved above 200. It is then refined to 0.01 BPM by a comb over the onset envelope, searching within 2% of that value. Precision matters: at 0.1 BPM off, two songs' kicks drift ~25 ms apart within 30 s, which is audible.
3. **Phase.** Where the model's beats fall on that period, taken as their circular mean, so a few stray beats in a breakdown barely move it. The phase is then nudged up to 40 ms onto the onset comb, if the comb has a clear peak.
4. **Confidence** (`beatConfidence`). The share of grid beats with a model beat within 70 ms.
5. **Stability** (`gridStable`).
   - Confidence must be at least 0.35.
   - Every 30-second window's beats must sit within 25 ms of the song's.
   - For a long song, the tail's beats re-fit the head's grid. The tail may correct the tempo's last digits by up to 0.01 BPM. If the tail still strays by more than 25 ms, the song's tempo drifts and the grid isn't stable.

Without the model (it failed to run), `beatGrid` does everything from onsets alone: autocorrelation for a rough tempo, a bass-based check for which tempo octave is right, then the same comb refinement. The map records which path was used in `beatsFrom: 'model' | 'onsets'`.

### 1.2 Bars and phrases (`sections.ts`: `checkBar`, `choosePhrase`)

Dance music is built in 4-beat bars and 16-beat phrases (4 bars). A DJ starts and ends a blend on a phrase line, so the planner needs to know where those lines are.

- **The bar.** Of the four grid positions a bar could start on, the one with the most downbeat in the model's answer wins. How clearly it wins is `barConfidence`; a 50% margin over the runner-up is "fully sure". Without the model, the bass accents decide instead (`downbeats.ts`).
- **Section changes check the bar.** A section change is a bar-to-bar loudness step of at least 1.5×.
  - Changes that land on the chosen bar's phrase lines raise the confidence, up to 70% of the way to 1.
  - Changes on another position's phrase lines lower it, by up to 50%.
  - With the onset analysis only, a weak bar (bass confidence under 0.5) can be moved to where the changes clearly sit.
- **The phrase.** Of the four downbeats a phrase could start on, the winner is the one most section changes land 16 beats apart from. With no such evidence, the music's first downbeat wins: fully trusted if the music starts cleanly, half trusted if it fades or creeps in.
- **`downbeatConfidence`** = bar confidence × phrase confidence. Below **0.4** (`MIN_DOWNBEAT_CONFIDENCE`) the planner treats bar and phrase lines as a guess.

The map's grid is counted from the music's first phrase start: `firstBeat` is up to three beats before it and `downbeatOffset` says how many. This makes phrase line *k* at `firstBeat + (downbeatOffset + 16k) × 60/bpm`. After leading silence, a phrase counted from the grid's first beat could cut the music's phrases in half.

### 1.3 Intro, outro and the song's shape (`sections.ts`)

The intro is where B can be brought in under A. The outro is where A can be left. A DJ looks for **a steady beat with little else**: the drums before the bass line and chords arrive, and after they leave. Every grid beat is measured:

| measure | what it is |
|---|---|
| `loudness` | full-band RMS from the beat to the next one |
| `kick` | peak bass power at the beat |
| `bass` | bass power in the beat's second half, after the kick has died away: the bass line |
| `fill` | mid/high power between the kicks: chords, pads, vocals |
| `attack` | the strongest onset in the beat: whether anything starts in it |

Each beat then gets a kind:

- **sparse**: it has a kick but under 35% of the song's full fill;
- **edge**: no kick, and either quieter than full sound or with nothing starting in it (a pad before the beat, a chord ringing out);
- **full**: anything else.

"Full" levels are the song's upper quartile, not its median, because in a club edit the intro and outro can be half the song.

The phrases are then judged in two complementary ways.

1. **Dense or sparse.** A phrase that is at least 75% sparse beats (edge beats not counted), or has fewer than 4 beats that count, is intro or outro material.
2. **Groove.** Each phrase's median kick, bass and loudness are compared with the song's **main groove**: each level at the 80th percentile of the phrases.
   - A phrase is **in the main groove** when its kick and bass are within 6 dB of the main groove's and its loudness within 4 dB.
   - A phrase is **mixable** (beat-led, but not the main groove) when it is out of the main groove and its kick is within 12 dB of the main groove's. This catches intros and outros that have chords or pads but a lighter, filtered kick or no bass line yet. A phrase with less kick than that (a piano or vocal opening) is music to hear, not to mix over.
   - At most 4 such phrases (64 beats, a club intro's length) count as intro or outro. More than that is a pop or disco song whose verses are simply lighter than its choruses.

**The intro ends** at whichever reaches further: the first dense phrase, or the end of the leading mixable phrases.

**The outro starts** at whichever comes earlier: after the last dense phrase, or the start of the trailing mixable phrases. Before looking for those, the song's **ending** is set aside. An ending is the last phrases when they are either:

- more than 12 dB quieter than the main groove (a fade out, a last hit ringing), or
- quieter than the main groove with their kick gone.

The ending isn't a groove, so the outro is looked for in the phrases before it, and runs on through it. A song that fades out can always be left from where the fade begins, at the latest: the next song comes in as it fades. Without this rule, a song whose last phrase is a fading pad looked as if its "outro" were only that fade, and the blend was squeezed into its last seconds.

The section analysis also finds these:

- **`firstDrop`**: the first phrase louder than the one before by at least 35% of the loudest phrase.
- **`coldStart`**: the first sounding beat is already full sound (no intro, no fade-in).
- **`coldEnd`**: the last sounding beat is full sound and the song doesn't fade to it; it ends abruptly. A fade-out is the last 4 bars falling to 85% or less, bar after bar.
- **`soundStart` / `soundEnd`**: where the music starts and stops, before and after any silence.
- **`phraseEnergy`**: each phrase's loudness, 0–1 relative to the loudest. It covers the first 7 minutes and is shown in Stats for nerds.

For a long song, the outro, cold end and sound end come from the tail, analysed on the head's grid and phrase lines and measured against the **head's** main groove (the tail is mostly the song's end, so its own "main groove" would be outro material).

### 1.4 Is the beat steady where it will be mixed? (`withDrift` in `mixMap.ts`, `drift.ts`)

A blend plays two songs' kicks together for up to a minute. If one song's beat wanders from its grid by more than ~25 ms there, the kicks flam: you hear two kicks instead of one. Many songs are perfectly steady in their outro but wander in a breakdown, or the other way round. So steadiness is judged **phrase by phrase**, and the planner only looks at the phrases the blend actually covers.

For each 16-beat phrase, `phraseDrift[k]` is the median offset (ms) of the model's beats from the grid, relative to the song's median offset. It is `null`, meaning no verdict, in two cases:

- the phrase has fewer than 8 of the model's beats (a breakdown with no beat at all);
- **its kick is more than 12 dB below the song's** (the song's kick is its phrases' median kicks at the 80th percentile).

The second rule matters. With no kick, the model has little to go by, and its beats wander even when the music doesn't. More to the point, with no kick there is nothing for the other song's kick to flam against. A kick-less outro such as Into the Trees' last minute used to read as "drifting". That pushed the blend to the song's last 30 seconds, when a DJ would happily blend over it.

`beatHolds(song, from, to)` is true when every phrase overlapping that span drifts by at most `DRIFT_LIMIT_MS = 25` ms, or has no verdict. `edgesStable` says whether the beat holds over the first 64 beats before the intro ends and the 64 from the outro start. Mixes and radio use it (falling back to `gridStable`) when choosing songs that blend well.

### 1.5 Key (`key.ts`, `camelot.ts`)

The classic Krumhansl–Schmuckler method:

1. A chromagram measures how much of each of the 12 pitch classes the song contains. It reads 80 Hz–2 kHz, plus sustained sub-bass notes from 40 Hz, so a sine bass still spells the tonic but a kick doesn't pass for a note.
2. Noisy frames (by spectral flatness) and silence don't count.
3. That profile is matched against the 24 major and minor key profiles.

The best key becomes a **Camelot code**, with a confidence. On the Camelot wheel, one step is a fifth, and the same number with the other letter is the relative major or minor.

### 1.6 Loudness

Measured separately (EBU R128 via ffmpeg). Every song is streamed at −14 LUFS: loud songs turned down, quiet ones up as far as their peak allows. Transitions are rendered at the same levels (see 3.3).

### 1.7 Hand-set cues

*Edit mix points* in the song menu sets `cues.mixIn` and `cues.mixOut`. They always win over the detected intro end and outro start, and the planner never overrules a hand-set mix-out point.

---

## 2. Planning: how A hands over to B (`plan.ts`)

`planTransition` takes both mix maps, the queue's mix mode (Auto, Party or No mixing), whether B follows A on the same album in order, where A is now, and the listener's fade length. It returns a plan with:

- `style`;
- `aStart` (when the transition starts in A);
- `bStart` (where B comes in);
- `length`;
- `bResume` (where B's own playback picks up after the transition);
- `switchAt` (when the display flips from A to B);
- curves over transition time: `bRate`, `aGain`, `bGain`, `aLowDb`, `bLowDb`, `aHighPassHz`;
- a human-readable `reason`, shown in Now Playing and Stats for nerds.

### 2.1 Facts about the pair

- **Tempo ratio.** B's playback rate that matches A: `a.bpm / b.bpm`, doubled or halved if that is closer to 1, so 174 mixes with 87. When the tempos are so close that over 64 beats B would drift under 2 ms, the ratio is snapped to exactly 1: no stretch, no ease-back.
- **Tempo gap.** How far the ratio is from 1.
- **Where A may leave** (`leaveFrom`): the hand-set mix-out, else the outro start, and never sooner than 5 s from now (time to render and load).
- **Room**, in A's beats:
  - *outro room*: from A's first phrase line at or after `leaveFrom` to where A's sound ends;
  - *intro room*: from B's first downbeat to its mix-in point, converted to A's beats via the ratio.

  Section times can sit a hair past their phrase line (they're placed before the tempo's last digits settle), so "at or after" allows 10 ms of slack.
- **Bars sure**: each song's `downbeatConfidence` ≥ 0.4.
- **Keys**: compared only when both are detected with at least 0.3 confidence.
  - *compatible*: ≤ 1 step on the wheel;
  - *close*: 2 steps;
  - *clash*: 3 or more.

### 2.2 Choosing the style

The rules run in order; the first that has something to say decides.

1. **No mixing wanted.** Mixing off, or B follows A on the same album in order → **straight**: the album's own gaps are kept.
2. **No steady beat.** Either song has no usable tempo or `beatConfidence` < 0.35 → **fade**. If A ends cold or B starts cold → **straight** instead: fading into or out of an abrupt edge sounds like a mistake.
3. **Abrupt edges at different tempos.** A ends cold, B starts cold, and the tempos are more than 8% apart → **straight**.
4. **Unsure bars.** Either song's bar starts are unsure. Phrases can't be matched, so there's no long blend: its whole point is phrases meeting.
   - If both beats are sure (confidence ≥ 0.5) and both hold where a quick mix would join them → **quick mix**, landing on a beat.
   - Otherwise → **fade**, or **straight** at an abrupt edge.

   This is the "Neither song's bar starts are sure: quick mix" message.
5. **Tempos too far apart.** More than 8% apart: stretching B that much is audible.
   - With sure beats → **quick mix**.
   - Otherwise → **fade**, or **straight** at an abrupt edge.
6. **Long blend or quick mix.** The blend length is the longest of **64, 32 or 16 beats** that fits both rooms.
   - Auto stops at 32 beats unless both songs have 128 beats of room; Party always takes the longest that fits.
   - With no room even for 16 → **quick mix**.
   - Keys that clash cap the blend at 32 beats. The blend covers A's outro and B's intro only (mostly drums, the bass swapped), not the longest. Keys two steps apart blend as usual: that's an energy boost DJs use on purpose.

   A key clash used to force a quick mix. That felt rushed, while 32 beats over drums doesn't clash audibly.

### 2.3 Long blend

A leaves from a phrase line in its outro; B's phrase line lands on that same downbeat. For each candidate length (the chosen one, then shorter ones):

1. **A's first line**: the first phrase line at or after `leaveFrom`, and the overlap must end before A's sound does.
2. **B's start**: B's phrase line nearest to *mix-in point − overlap × ratio*, so its intro ends about when the overlap does (and not before its first downbeat).
3. **B's beat must hold** over the part of its intro the overlap covers (`beatHolds`). If not, try a shorter blend.
4. **A's beat must hold** over the overlap. If it doesn't from the first line, the next phrase lines are tried, *later in the outro*, as long as the blend still fits before A's sound ends. If no line holds, try a shorter blend.
5. **B's rate**: matched to A for the overlap, then a straight ramp back to its own tempo, then 0.1 s at exactly 1. Together the ramp and the hold cover 16 of B's own bars (64 beats), so B resumes on one of its bar lines. The time-stretch only reproduces its input exactly at rate 1, and the transition must end on exactly the sample where B's own playback picks up.
6. **B mustn't resume inside its own outro**: that's where the next mix begins. If it would, the ease-back is dropped (only for tempos within 3%, since B then snaps to its own tempo). If it still doesn't fit, try shorter.

If nothing fits, it falls back to a quick mix, with the reason: "A's beat drifts in its outro", "B's beat drifts in its intro", "Both beats drift where they'd blend", "B's outro comes too soon for a blend", or "Too close to the end for a blend". When a shorter or later blend was used, the reason says so, e.g. "(shorter and later in the outro, where the beat holds)".

**The moves in a long blend**, over an overlap of *N* beats:

- **Bass swap** at the bar line nearest the middle (`switchAt`). Each bass is cut with a 250 Hz low shelf at −24 dB.
  - A's bass is full until one beat before the swap, then cut by the swap's downbeat.
  - B's bass is cut until then, then comes up over the same beat.
- **B fades in** on an equal-power curve (sin) over the first half; **A fades out** (cos) over the second half. Equal power keeps the loudness steady through the crossfade.

### 2.4 Quick mix

A short, decisive change over 4–8 beats with a high-pass sweep on A, exponential from 20 Hz to 800 Hz, up to a landing downbeat. Where it lands:

- **In A** (`quickPlacement`), in order of preference:
  1. a phrase line, with the lead-in starting no earlier than `leaveFrom`;
  2. the next downbeat after `leaveFrom` that allows it;
  3. without a hand-set mix-out only: A's last phrase line that fits, at most a phrase before the outro.

  With unsure bars, beats stand in for phrase lines.
- **In B**: its phrase line nearest the mix-in point if one is within half a phrase, else its nearest bar line (beat, with unsure bars). Never so late that B would resume inside its outro.

How it sounds depends on the tempo gap:

- **Tempos within 2%**: B is stretched to A, and the two crossfade over the last 2 beats, finishing on the landing.
- **Further apart**: B plays at its own speed, so their beats would flam. It's a **cut**: B is silent until the landing, then comes in within 20 ms. A rings on for one beat, filtered, fading out.

### 2.5 Fade and straight

- **Fade**: an equal-power crossfade as long as the listener's fade length (8 s by default, kept between 1 and 30 s), ending where A's sound ends. B starts where its sound starts, at its own speed. Too little room → straight.
- **Straight**: A plays to where its sound ends and B starts where its sound starts, so neither song's silence is heard. With mixing off or within an album, both play as recorded, silences included.

### 2.6 Skips (`skipPlan`)

When the listener presses Next, A is left as soon as possible, mid-song if need be. Outros, keys and the same-album rule don't count, but No mixing still does.

- **Both beats sure** → a quick mix landing on A's next bar line with a 4-beat lead-in, or 2 beats if that lands a bar sooner. The cut comes under 6 beats after the press.
- **Otherwise** → a 2.5 s crossfade, or straight if B starts cold.

### 2.7 What this looks like: Into the Trees → Hung Up

Into the Trees (Trentemøller) ends with about a minute and a half of beat without its main groove. The last of it has no kick at all.

- **Before the fixes**, the beat model's beats wandered in that kick-less minute. Those phrases read as "drifting", and the planner pushed the blend to the last phrase that held: 32 beats from 6:52.
- **Now**, kick-less phrases have no drift verdict, and the outro is found before the ending, at 6:00. Both songs have the room, so the plan is a 64-beat blend (30 s at 128 BPM) from 6:00, where a DJ would start it. Both songs are the same tempo, so Hung Up isn't stretched.

---

## 3. Rendering the transition (`render/transition.ts`, server `transitions.ts`)

### 3.1 When and where

While A plays (after 5 s of it, and 2 s after the queue settles), the player asks `POST /api/transitions` for A→B.

- **The plan** is made at once. It is remembered per pair (500 pairs, kept on disk beside the audio) and reused while it still starts at least 5 s ahead. It is made afresh when either map, the mode, the cues or `PLANNER_VERSION` changes.
- **The audio** is rendered in the background, one transition at a time, with at most 3 waiting. It is cached on disk by `RENDERER_VERSION` + both files + plan, up to `TRANSITIONS_CACHE_MB` (1 GB). So the same plan between the same files is rendered once.
- The player polls (every 3 s, then every 10 s) until the answer is "ready". Until then the answer says how far the render has got: its step (waiting, decoding, mixing, saving, saving the rest of the next song) and the share done, which Stats for nerds shows as "Making".

### 3.2 The render

1. **Decode the excerpts.** A from 2 s before `aStart` (the lead) until it's silent, B from `bStart` to `bResume` plus a 3 s tail, each with 0.25 s of margin. Decodes start on a 10 ms grid, so the start asked for is the start decoded, to the sample.
2. **A** plays at its own tempo, through the high-pass sweep (quick mix) and the bass shelf. The filters are redesigned every 128 samples from their curves, in state-variable form, so moving cutoffs don't burst.
3. **B** is time-stretched with **WSOLA**. It keeps pitch and keeps kicks sharp (a phase vocoder smears them), and it is exact at rate 1. B is placed by where it must *end*, so the transition's last sample runs exactly into B's sample at `bResume`.
4. **Gains** are applied per sample from the curves.
5. **Limiter.** Two loud masters together can reach +6 dB. A look-ahead limiter (5 ms look-ahead, 1 s hold so it doesn't pump on every kick, 0.15 s release) keeps the sum no louder than the louder song alone, or −1 dBFS. Where only one song plays, the audio is that song sample for sample.
6. **The lead and the tail.** 2 s of A as it is come before the transition in the same file, and 3 s of B as it is follow it, so the player can switch between the transition file and each song's own file while both hold the very same sound, sample for sample.

### 3.3 Levels, and B's remainder

- **Levels.** The transition is rendered with each song at the gain its levelled stream plays at, so the volume doesn't jump at either join.
- **B's remainder.** An MP3 can't be started at an exact sample. When B is an MP3, the server also writes B's remainder from `bResume` as its own file. It is decoded in one streaming pass where the source allows, otherwise in 30 s chunks. The player can then continue from it without seeking in the MP3.

---

## 4. Playing it (`apps/web/src/player`)

- **The handoffs.** No browser starts a file at an exact moment, so each takeover is done **in step**, and only where the two files hold the same sound:
  1. 2 s before `aStart`, the player starts the transition file (its lead is A as it is) silenced, while A's own file plays on. At the transition's end, it starts B's own file (or its remainder) silenced, while the transition's tail (B as it is) plays on.
  2. The new file plays slightly faster or slower until both are at the same moment. It goes by the median of the last 5 measurements, every 4 ms, because an element's reported time jitters by a millisecond or so. It asks for 1 ms, loosening to 5 ms as the shared sound runs out.
  3. Then it takes over: a 15 ms equal-gain fade on desktop (two copies of one sound, so the level holds), an instant switch on iPhone (where volume is fixed in hardware).

  **On desktop the changeover is lined up on the sound itself** (`joinGraph.ts`). An element's reported time isn't the sample being heard, so two files that agree to a millisecond by their times can still be a few apart as heard. After the first click or key press (when browsers let Web Audio start), every `<audio>` element plays through one Web Audio graph: element → delay → gain → speakers.

  At a join, once the new file plays, the graph records both outputs together (a script processor sees both in the same block). It then finds the gap by cross-correlation over ±300 ms, done by FFT so the wide range costs little. It correlates each signal's sample-to-sample change, which weighs hats and attacks over a bass line whose cycles all look alike, and refuses to answer if two lags match almost equally.

  - A new file behind the old one (a delay can't bring it forward), or more than 150 ms ahead, jumps to 20 ms ahead and is measured again.
  - Otherwise it's held back by exactly the gap with a delay node, checked within ±10 ms (and corrected once more if it's still off by more than a sample), then cross-faded over 20 ms on the audio clock.
  - Every wait goes by the audio clock, not the page's timers, which a hidden window slows down.
  - If the sound can't be measured (silence, a pure tone), the changeover falls back to the elements' times.

  Stats for nerds shows each join ("Mix in", "Mix out") and, for one not measured on the sound, why.

  Both changeovers finish before anything changes: before B comes in at `aStart`, and in B's tail after the transition. Before the lead, the switch into the transition had to happen after `aStart`, with B already coming in. A late switch then brought B in with a small step in its level, and the 5 ms allowed between the two copies let a kick's low end partly cancel. Both were heard as a bump. Stats for nerds shows how close the last changeover came ("Last join").
- **Giving up.** If the transition isn't ready 20 s before `aStart`, the player gives up on it and the pair plays the usual way. A render that takes too long ends up there.
- **Fallback: a cut on the beat** (`beatCut`). With no transition, DJ mix still joins the songs on the beat: A stops on its last downbeat before its sound ends (at most 20 s early), and B comes in on its first downbeat. If B's intro is longer than 8 bars, B comes in a bar before the intro ends.
- **Live mix on desktop** (`liveMix.ts`). When the listener skips and no server transition is ready, a desktop browser can mix one itself. It fetches and decodes both songs around the mix, plans and renders a quick mix in a worker, and plays it through Web Audio. It has 1.5 s to do so, otherwise the song switches straight away.
- **What the listener sees.** Lock screen, seek bar and history only ever show the two songs. The transition's time maps to A's until `switchAt`, then to B's (following B's stretched clock).
- **Downloads** keep their transitions for offline listening.

---

## 5. Choosing songs that blend (`blend.ts`)

Mixes and radio order songs so neighbours blend well. `blendScore(a, b)` is the product of three parts, each 0–1:

- **Tempo closeness.** 1 at the same tempo, 0.8 at the planner's 8% limit, then halving every 3% further apart (never below 0.1). The score is trusted less for unsure beats, and half as much when a beat wanders where songs are mixed (`edgesStable`, else `gridStable`).
- **Key compatibility.** 1 for compatible keys, 0.8 for two steps, 0.6 for a clash, weighted by key confidence.
- **Energy continuity.** 1 minus the energy jump, never below 0.4.

Whatever isn't known counts as 0.8 ("fine, not a match"), so it neither jumps the queue nor sinks to the end.

---

## 6. Versions and caches

| constant | where | bump it when |
|---|---|---|
| `MIX_MAP_VERSION` (now 7) | `packages/mix/src/types.ts` | the analysis would measure a song differently: stored maps are re-measured in the background. Maps from version 2 on stay usable meanwhile. |
| `PLANNER_VERSION` (now 3) | `plan.ts` | the planner would plan the same two maps differently: remembered plans are made afresh. |
| `RENDERER_VERSION` (now 3) | server `transitions.ts` | the rendered audio would differ for the same plan: cached files are made again. |

Settings → Analysis shows how much of the library has a current mix map. It can analyse the songs left, or the whole collection again. After a restart, the background analysis picks up where it left off, if its switch is on.

## 7. Seeing it

Settings → Appearance → **Stats for nerds** shows, for the song playing:

- tempo, key, the bar and phrase it's at;
- the beat's confidence and whether it holds where it's mixed;
- each phrase's drift;
- the section it's in, intro end, outro start and first drop;
- an energy strip with lines where the intro ends and the outro starts;
- the next transition's style, timing, B's rate, levels and the planner's reason.
