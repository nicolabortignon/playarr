# Generated playlist covers

Every playlist gets artwork drawn from how its songs sound, not a collage of album art. The same songs always give the same cover. This page covers what is measured, how a playlist's character becomes a picture, and how a cover is kept, changed and served.

The code lives in `apps/server/src/analysis` (measuring songs, tags, style families), `apps/server/src/cover` (DNA, palettes, layouts, title, rendering), `apps/server/src/playlists.ts` (pinning) and `apps/server/src/routes/playlists.ts` (the image routes).

It runs in four steps:

1. **Listen**: once per song, sound analysis measures the audio; beat analysis supplies the tempo.
2. **Read**: once per song, ListenBrainz tags place it in style families.
3. **DNA**: per playlist, the songs' measurements are summed up into one description.
4. **Draw**: the DNA picks a layout and a palette, and the server renders an SVG, then WebP.

---

## 1. Listen: sound analysis

The `Analyzer` (`analysis/analyzer.ts`) works through the library in the background, one song at a time, and stores everything in SQLite, so each song is measured once. Songs someone is waiting for (a playlist being opened, the song playing) go ahead of the backlog. Settings → Analysis calls this *sound analysis*.

ffmpeg runs where the files are (over SSH on the NAS, under `nice -n 10`) and decodes the first 7 minutes as mono PCM at 22 050 Hz (`MIX_HEAD_SECONDS`, all of a shorter song). The same decode feeds beat analysis for DJ mixes ([../mixing.md](../mixing.md)). A decode stuck for 5 minutes fails, and a failed song is tried again a day later.

`analyzePcm` (`analysis/dsp.ts`) measures at 11 025 Hz, in plain TypeScript, in the DSP worker thread (`analysis/dspThread.ts`, `dspWorker.ts`), which it shares with transition rendering. If no worker can start, the work runs on the main thread. Every value is scaled to 0–1 over the non-silent frames (quieter than −60 dB is silence):

| Feature | Measures | Scale |
|---|---|---|
| `loudness` | mean RMS level | −28 → −9 dBFS |
| `dynamics` | range between the 10th and 95th percentile frame | 4 → 30 dB |
| `brightness` | energy-weighted spectral centroid | 500 → 1800 Hz |
| `busyness` | onsets per second | 1 → 4 |
| `bass` | share of energy below 150 Hz | 0.15 → 0.7 |
| `envelope` | loudness over the song, 48 points, lightly smoothed | −50 → −6 dB |

The raw measurements are stored beside the scaled ones in `track_features`, so the scales can be recalibrated without decoding again. `ANALYSIS_VERSION` (currently 1) is bumped when the measurement changes.

**Tempo and pulse come from beat analysis**, the song's mix map, so covers, mood mixes and DJ mixes share one tempo. `Analyzer.features()` adds `bpm` (the mix map's tempo) and `pulse` (its beat confidence, 0 for ambient, near 1 for four-on-the-floor). Until a song has a mix map, both are 0 and the cover draws it with a stand-in (below).

`ANALYSIS=off` in `.env` turns analysis off; `FFMPEG_PATH` points at another ffmpeg.

## 2. Read: tags and style families

Tags come from ListenBrainz's `metadata/recording` endpoint, in batches of 25, paced by its rate-limit headers, stored in `track_meta` and refreshed after 30 days. Only songs with a MusicBrainz recording id can be looked up. `toMeta` weighs crowd tags by where they're attached (recording ×1, release group ×0.6, artist ×0.4), each scaled to its strongest tag, and keeps the top 16 with the first-release year. The song's Lidarr artist genres are always added, at weight 0.5 each, and the library's album year is used when ListenBrainz has none.

`styleProfile` (`analysis/styles.ts`) maps tags to 13 style families: electronic, ambient, rock, metal, pop, hip hop, soul & funk, jazz, classical, soundtrack, folk, world and experimental. Each has a hue (OKLCH degrees) and a lean towards paper or night. Families with under 12% of a song's tag weight are noise and dropped. Mood words nudge `warmth` (happy, summer… against dark, melancholic…) and `calm` (mellow, relaxing, sleep…).

## 3. DNA (`cover/dna.ts`)

`buildDna` turns the playlist into one `Dna`: a *glyph* per song (each recording once, in playlist order) and a summary.

- **Glyph**: the song's features, length, main style family, year, and an `intensity` blend (0.4 loudness, 0.25 busyness, 0.2 tempo drive, 0.15 brightness). A song not measured yet, or without beat analysis, takes a neutral stand-in seeded from its id (90–130 BPM, pulse 0.4, mid values), so the cover doesn't flicker while songs arrive.
- **Tempo**: the median BPM of songs with pulse above 0.35; `tempoSpread` from the interquartile range.
- **Means** of pulse, intensity, brightness, dynamics, busyness and bass; `organic` from loose beat, dynamics and little bass.
- **Styles**: family weights summed over all songs.
- **Diversity**: 0.65 × the entropy of each song's *main* style, plus 0.35 × the spread of intensity, brightness and pulse. Counting only the main style matters: averaging every tag made focused playlists look eclectic.
- **Era**: median, first and last year.
- **Seed**: a hash of the sorted recording ids, so the same songs give the same cover.

## 4. Draw: layouts (`cover/layouts.ts`, `currents.ts`, `colonies.ts`)

Six layouts exist, each drawing every song as its own element. `chooseLayout` (`cover/render.ts`) scores them from the DNA, adds seeded jitter of ±0.12 for close calls, and takes the best. An empty playlist gets Grooves. Long playlists merge neighbouring songs (Ridges 36, Grooves 24, Blocks 16, Horizon 8).

| Layout | Favoured by | Each song is… |
|---|---|---|
| **Currents** (flow field, the default) | most playlists; legato, organic music | ribbons packed through a flow field: laminar for a steady beat, swirling in free time. Louder songs run wider, legato songs longer. A coarse pass lays long ribbons, a fine pass fills gaps with thin ones. Finishes: solid, *beats* (cut into the song's beats, steady playlists) or hollow *tubes* (organic ones) |
| **Colonies** (multi-species Physarum) | eclectic mixes | a member of its style's species (up to four; one style is split into calmer and louder songs). Speed from tempo, vein tightness from beat. A 440² simulation over 260 steps, yielding to the event loop, embedded as a PNG |
| **Ridges** (after *Unknown Pleasures*) | driving, bright, focused | a band of lines tracing its loudness, rippling with tempo and busyness |
| **Grooves** (a record) | heavy steady low end, older music | a band of grooves as wide as the song is long, wobbling with its loudness; faster playlists cut finer grooves |
| **Blocks** (Bauhaus grid) | older and varied playlists | a tile sized by length, its shape from how it sounds (rings, stripes, disc, half or quarter circle, dots, or its loudness as a wave) |
| **Horizon** | calm, beatless music | a hill whose ridge is its loudness; slower music gives a bigger sun, cut into stripes if there's a beat |

**Palette** (`cover/palette.ts`). The playlist *chooses* one of chromotome's curated palettes (Kjetil Golid et al., MIT) rather than computing one. Every palette with a background and at least two colours is a candidate, and light ones are also offered inverted (darkest ink as night). The score weighs hue match to the style hues, paper against night (from intensity, brightness, calm and the styles' lean), vividness against energy (muted for older eras), and having about as many colours as the diversity needs. Each style gets the palette colour nearest its hue; the older the playlist's median year (fully at 1962, nothing from 1992), the more its colours fade and warm and gets more print grain (`feTurbulence`).

## 5. Rendering and caching

`drawArt` produces the artwork once per (DNA, layout, variant); `composeCover` adds the background, the title layer and the grain. `PlaylistCovers` (`cover/index.ts`) keeps 40 drawn artworks in memory and 300 images, and writes every WebP to `.cache/covers/` (some layouts take seconds). sharp rasterises the SVG at one of the snapped sizes 64–1024 px (default 600, so 768), quality 86. Rendering happens on the server so every app shows the same pixels.

The URL is `/art/playlist/:id?v=<version>`, where the version hashes `RENDER_VERSION`, the layout, variant, DNA and the name. A versioned URL is cached as immutable for a year; the bare one revalidates. `?format=svg` returns the source. **Bump `RENDER_VERSION`** (currently 2, in `cover/render.ts`) whenever the artwork changes, or old images stay cached.

## 6. Lifecycle: pinned covers and the picker

A cover is drawn once and then kept, like Apple Music's chosen artwork rather than its live mosaic.

- **Provisional.** While any song still waits for sound analysis or tags, the playlist shows a live cover from the songs as they are, and the apps poll every 4 s (web) so it refines.
- **Pinned.** The first time nothing is pending, `describe` freezes it: `playlists.cover_snapshot` stores the DNA, layout, variant (0), the sorted song ids and when it was drawn. From then on, adding or removing songs, or better analysis, never changes it. Covers are drawn from every song in the library, whichever account looks.
- **New cover.** The playlist's owner opens a picker (the cover, the ⋯ menu, or the link under the stats; `CoverPicker.tsx`) with one candidate per layout from the *current* songs, via `/art/playlist/:id/preview?layout=&variant=` (not cached). Shuffle moves to the next variant, which re-rolls every random choice; "Use this" pins it with `PUT /api/playlists/:id/cover { layout, variant }`.
- **Suggestion.** When more than 30% of the songs differ from the snapshot (Jaccard distance, `STALE_AFTER`), the cover info says `stale` and the page suggests a new cover.

The cover info also carries the facts the playlist page shows beside its explanation ("Each line is a song…"): tempo, energy, up to three styles of at least 12% weight, era, and how many songs are analysed.

## 7. Titles (`cover/title.ts`)

The name is set top-left, as on a printed sleeve, under a small tracked-out "PLAYLIST" label. It's drawn as vector outlines with opentype.js in the app's own faces, Gloock for the title and DM Mono for the label (from `@fontsource`), so it renders the same on any server. Sizes run from 128 down to 52 px, wrapping to two lines, or three for long titles. It sits on a panel of the background colour, except over a Horizon sky. Names with characters the faces lack (emoji, CJK) fall back to SVG text.

The title is a separate layer: renaming changes the URL but never redraws the art. Thumbnails under 120 px ask for `title=0`, as lists show the name beside them.

## 8. Compared with Apple Music, and what was ruled out

Apple Music's default is a live 2×2 mosaic of the first four songs' album art; since iOS 17.1 the user can pick one of eight preset designs coloured from the first song's artwork, title top-left. Playarr borrows the user-picks-and-it-stays model and the title placement, but draws from how every song sounds.

Ruled out: image models such as diffusion or VQGAN (no GPU on the NAS, an outside service would see listening data, and results aren't deterministic), CPPNs (psychedelic gradients clash with the sleeve look), and reaction-diffusion or differential growth (slow on a CPU and loosely tied to the music). Currents follows the flow-field-with-collisions technique popularised by Tyler Hobbs; Colonies follows Jeff Jones, Sage Jenson and fogleman/physarum. Both are written from scratch. See [../decisions.md](../decisions.md).

---

See also: [../architecture.md](../architecture.md), [streaming-and-art.md](streaming-and-art.md) for the rest of artwork, [discover-and-requests.md](discover-and-requests.md), and [../mixes.md](../mixes.md), which use the same features.
