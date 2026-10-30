# Settings: Playback, Requests and Appearance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fill the three Settings tabs that are placeholders today ("Coming later"): Playback, Requests, Appearance.

**Architecture:** Playback and Appearance are personal and per device: a persisted Zustand store (`lib/prefs.ts`) read by the player, the accent color logic, motion and the format badge. Requests is server-wide (it decides what Lidarr does for everyone): stored in `app_settings`, editable only from the local network like Sources, with `.env` values as fallbacks.

**Tech Stack:** React 19, Zustand (persist), motion, TanStack Query 5, Tailwind 4; Fastify 5, zod 4, node:sqlite, vitest 5. pnpm via `corepack pnpm`.

**Design:** `docs/plans/2026-10-30-sources-design.md` ("Settings panels: Sources now. Playback, Requests and Appearance fit the same shell later"; "The offline storage control later moves from Library into Playback"; "Until login exists, Settings is read-only for visitors outside the local network").

## What goes in each panel

Only things Playarr can do today, plus small controls that cost little. Crossfade, ReplayGain, EQ and transcoding are roadmap items and are not faked here.

**Playback** (this device)
- *On this device*: the offline storage control, moved from Library (Library keeps one line linking to it).
- *Keyboard shortcuts*: a reference table of what `player/useKeyboardShortcuts.ts` already does (Space play/pause; ←/→ seek 10 s; Shift+←/→ previous/next; ↑/↓ volume; M mute; S shuffle; L like; / search).

**Requests** (everyone; editable from the home network)
- *Allow requests*: on/off. Off hides every Request button for everyone, and the server refuses new requests (403 "Requests are turned off in Settings"). Default on.
- *Search right away*: on/off. On (default, today's behaviour) runs Lidarr's AlbumSearch after adding; off only adds and monitors, leaving the search to Lidarr's schedule.
- *Where new artists go*: Lidarr root folder, quality profile and metadata profile, chosen from Lidarr's own lists. "Lidarr's default" is the first option of each (today's behaviour: the root folder's defaults). `.env` `LIDARR_ROOT_FOLDER` / `LIDARR_QUALITY_PROFILE_ID` / `LIDARR_METADATA_PROFILE_ID` still apply when nothing is chosen in Settings.
- Without a Lidarr source: the panel says requests need one and links to Sources.

**Appearance** (this device)
- *Accent color*: "From the album art" (default, today's behaviour) or one of a few fixed colors: the current default orange `#ff7a1a`, plus `#f43f5e`, `#a78bfa`, `#38bdf8`, `#34d399`, `#facc15`.
- *Motion*: System (default) / Reduced / Full. Reduced turns off motion animations and CSS transitions as the `prefers-reduced-motion` block does; Full ignores the system setting.
- *Audio format badges*: show/hide the FLAC/MP3 badges in the player bar, Now Playing and Queue.

## Conventions

- Run from `/Users/bortignon/dev/playarr`. Server tests: `corepack pnpm -C apps/server test`; web tests: `corepack pnpm -C apps/web exec vitest run src` (unit tests only; the smoke tests need a server, skip them). Typecheck: `corepack pnpm -C apps/server typecheck`, `corepack pnpm -C apps/web exec tsc --noEmit`; build: `corepack pnpm -C apps/web exec vite build`.
- A pre-commit hook raises the version in the root package.json on every commit and stages it itself: that's expected, don't fight it or skip it.
- Commit after every task on `main`, staging only that task's files. Don't push.
- Match the existing Settings look: `SourcesPanel.tsx` (section headers, radio-pill buttons like the offline "Keep up to" control, `Field`, muted explanatory text in plain sentences).

---

### Task 1: Requests settings on the server

**Files:** `packages/shared/src/index.ts`, `apps/server/src/lidarr/client.ts` (+ types), `apps/server/src/discover/requests.ts` (+ test), `apps/server/src/routes/settings.ts` (+ test), the requests route file (find where `POST` requests is handled), `apps/server/src/routes/api.ts` (health), `apps/server/src/index.ts`

**Shared types:**

```ts
export interface RequestSettings {
  enabled: boolean;
  searchOnAdd: boolean;
  /** Unset: .env, else Lidarr's default. */
  rootFolderPath?: string;
  qualityProfileId?: number;
  metadataProfileId?: number;
}

/** GET /api/settings/requests: the settings, and Lidarr's choices (absent when Lidarr isn't set up or can't be reached). */
export interface RequestSettingsInfo extends RequestSettings {
  lidarr: boolean;
  options?: {
    rootFolders: { path: string; freeSpace?: number }[];
    qualityProfiles: { id: number; name: string }[];
    metadataProfiles: { id: number; name: string }[];
  };
  /** Why the options are missing, when Lidarr is set up. */
  error?: string;
}
```

`HealthStatus` gains `requests: boolean` (Lidarr configured and requests allowed).

**Lidarr client:** `qualityProfiles()` → `GET /api/v1/qualityprofile`, `metadataProfiles()` → `GET /api/v1/metadataprofile` (each `{ id, name }[]`), following `rootFolders()`.

**Requests service:** replace the constructor's static `overrides` with a function `settings: () => RequestSettings` (read on every request, so changes apply at once). In `defaults()`, each Settings value wins, then the `.env` value, then Lidarr's root-folder default. A root folder chosen in Settings that no longer exists in Lidarr falls back as today (first root). `request()` throws `RequestError('Requests are turned off in Settings', 403)` when `!enabled`, and skips the `AlbumSearch` command when `!searchOnAdd` (then the stored request has no `commandId`, and its initial availability is `{ state: 'monitored', message: 'Added to Lidarr; it will search on its schedule' }` — use whichever existing `Availability` state fits best for "wanted, not searching yet"; if none fits, add `'monitored'` to the union and handle it where availability is displayed).

Tests (requests.test.ts, with its existing fakes): disabled → 403 and nothing sent to Lidarr; `searchOnAdd: false` → no command; a Settings quality profile beats the `.env` one and the root folder default.

**Storage and routes** (`routes/settings.ts`): store the settings as one JSON value in `app_settings` under `requests` (defaults `{ enabled: true, searchOnAdd: true }`). `GET /api/settings/requests` (local-network only, like the others) returns `RequestSettingsInfo`, fetching Lidarr's three lists in parallel with a short timeout; failure fills `error` and leaves `options` out. `PUT /api/settings/requests` (local only) validates with zod (`enabled`, `searchOnAdd` booleans; `rootFolderPath` string ≤ 4096 or null; profile ids positive ints or null; null clears a choice) and returns the new info. Tests: defaults; save and read back; null clears; away → 403; bad input → 400.

**Health:** `requests: lidarr.configured && settings.enabled`.

**Wiring:** `index.ts` builds the settings reader once (`() => readRequestSettings(store)`), passes it to `Requests` (together with the `.env` values, which become the second fallback) and to the routes.

Commit: `Requests settings: allow, search right away, where new artists go`

---

### Task 2: Requests panel

**Files:** `apps/web/src/lib/api.ts`, `apps/web/src/lib/queries.ts`, create `apps/web/src/components/RequestsPanel.tsx`, every place that shows a Request button (start from `RequestButton` in `components/Discover.tsx` and `useHasLidarr` users)

- API/queries: `requestSettings()`, `saveRequestSettings(patch)`; `useRequestSettings()`, `useSaveRequestSettings()` (invalidates `['request-settings']` and `['health']`). `useRequestsEnabled()` = `health.requests` (true while health is loading, like `useHasLidarr`). Request buttons use `useRequestsEnabled()` instead of `useHasLidarr()` (keep `useHasLidarr` for anything that is really about Lidarr).
- Panel: three sections, saving on change (no Save button; toast on error):
  1. *Requests*: two switches (accessible `role="switch"`), "Let people request albums" and "Search for an album as soon as it's requested", each with a one-line explanation.
  2. *Where new artists go*: three selects (root folder with free space, quality profile, metadata profile), first option "Lidarr’s default". While Lidarr's lists load: skeletons. With `error`: the message and a Retry button.
  3. Without Lidarr: only a sentence, "Requests need a Lidarr source," linking to `/settings/sources`.
- From outside the home network (403 on GET): "Settings can be changed from your home network." (reuse whatever Sources does for this; if nothing exists, add a small shared component).

Commit: `Web: Requests panel; Request buttons follow it`

---

### Task 3: Per-device preferences, and the Playback panel

**Files:** create `apps/web/src/lib/prefs.ts` (+ `prefs.test.ts`), create `apps/web/src/components/PlaybackPanel.tsx`, `apps/web/src/components/OfflineStorage.tsx`, `apps/web/src/pages/Library.tsx`

`prefs.ts`:

```ts
export type AccentPref = 'album' | `#${string}`;
export type MotionPref = 'system' | 'reduce' | 'full';

interface Prefs {
  accent: AccentPref;
  motion: MotionPref;
  formatBadges: boolean;
  setAccent(a: AccentPref): void;
  setMotion(m: MotionPref): void;
  setFormatBadges(on: boolean): void;
}
// zustand persist, name 'playarr-prefs', version 1; defaults { accent: 'album', motion: 'system', formatBadges: true }.
export const ACCENTS = ['#ff7a1a', '#f43f5e', '#a78bfa', '#38bdf8', '#34d399', '#facc15'] as const;
```

Validate on rehydrate (an unknown accent or motion value falls back to the default). Test: defaults; setting and reading; a bad persisted value falls back.

Playback panel: `OfflineStorage` (drop its own `mt-12` when used here, e.g. a `className` prop) and a *Keyboard shortcuts* section: a two-column list (`<kbd>` keys styled like the mono labels, then the action). Library: replace `<OfflineStorage />` with one line in the same place: "Songs kept on this device: Settings → Playback" with the link.

Commit: `Web: Playback panel (offline songs, keyboard shortcuts); device preferences`

---

### Task 4: Appearance panel and applying the preferences

**Files:** create `apps/web/src/components/AppearancePanel.tsx`; `apps/web/src/player/AudioEngine.tsx`, `apps/web/src/components/FormatBadge.tsx`, the app root (where the router/providers are; wrap in `MotionConfig`), `apps/web/src/index.css`

- **Accent:** in AudioEngine's accent effect, when `accent !== 'album'` apply that color (and the favicon) instead of sampling the cover; re-run when the preference changes. `--accent-ink` stays as it is today.
- **Motion:** wrap the app in `<MotionConfig reducedMotion={{ system: 'user', reduce: 'always', full: 'never' }[motion]}>`. Set `document.documentElement.dataset.motion` to `reduce`/`full` (remove it for `system`). In `index.css`, make the existing `@media (prefers-reduced-motion: reduce)` rules apply to `:root:not([data-motion='full'])` inside the media query, and add the same rules under `:root[data-motion='reduce']` outside it.
- **Format badges:** `FormatBadge` renders nothing when `formatBadges` is off.
- **Panel:** *Accent color*: a radiogroup of round swatches; the first is "From the album art" (a small cover-like gradient chip), then the fixed colors, each with an `aria-label` (the color names: Orange, Rose, Violet, Sky, Green, Yellow). *Motion*: three pills, System / Reduced / Full, with a line explaining System follows the device setting. *Audio format badges*: a switch.

Commit: `Web: Appearance panel (accent, motion, format badges)`

---

### Task 5: Settings shell and docs

**Files:** `apps/web/src/pages/Settings.tsx`, `README.md`, `PLAN.md`

- All four panels `ready: true`, rendering `SourcesPanel`, `PlaybackPanel`, `RequestsPanel`, `AppearancePanel`. Under the tabs, one muted line for the per-device panels: "These settings are for this device." For Requests: "These settings apply to everyone."
- README: a short Settings paragraph (four panels, which are per device, Requests editable from the home network).
- PLAN.md decisions log: `| 2026-10-30 | Settings panels: Playback (offline songs moved from Library, keyboard shortcuts) and Appearance (accent from art or fixed, motion, format badges) are per device (persisted in the browser); Requests (allow, search right away, root folder and profiles from Lidarr's lists) is server-wide in app_settings, .env values as fallback, editable from the local network only; turning requests off hides Request buttons and the server refuses new ones. |`

Typecheck, all tests, build. Commit: `Settings: all four panels; docs`

---

## Not verified by this plan

- Lidarr's profile endpoints against a real Lidarr (shapes taken from Lidarr's v1 API).
- The panels in a real browser on desktop and mobile.
