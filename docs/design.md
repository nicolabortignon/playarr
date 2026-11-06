# Design language

How Playarr looks, on the web and on iOS: every role once, with one name in both apps. A page never holds a raw color, size or radius. When nothing here fits, this page and the shared components change together ([plan 5](plans/2026-11-05-5-ui-consistency.md)).

The tokens live in `apps/web/src/index.css` (`@theme` and the `type-*` utilities) and in iOS's `PlayarrUI/Theme/` (`Palette.swift`, `TypeRole.swift`, `Shape.swift`, `Typography.swift`).

Where the apps differ, the platform is the reason: the tab bar, sheets, SF Symbols, and the system's menus and lists. iOS pages share the screen with system menus, sheets, lists and alerts, so iOS text takes the system's white, and danger, success and warning its red, green and yellow. The web's canvas is all Playarr's, so it uses warm ink and paper.

## Color

| Role | Web | iOS | For |
|---|---|---|---|
| Surface | `bg-ink-900`; raised: `ink-850`, `ink-800`; deepest: `ink-950` | the system's dark background, and system materials for bars and sheets | pages, panels, menus, the player bar |
| Text | `text-paper` (#ece6dc) | `.paper` (the system's label white) | titles, row titles, paragraphs |
| Secondary text | `text-paper-dim` (#b8b0a3) | `.paperDim` (white 70 %, 85 % with Increase Contrast) | the artist under a title, descriptions |
| Muted | `text-muted` (#857d71) | `.muted` (white 50 %, 65 % with Increase Contrast) | kickers, times, counts, hints |
| Line | `border-line` (paper at 8 %) | `.line` (white at 8 %) | hairlines, a secondary button's outline |
| Accent | `accent`, with `accent-ink` on it (from the cover playing) | `theme.accent` | the one primary action on a screen, the playing song, links |
| Danger | `danger` (#f87171), with `ink-950` on it | `.danger` (system red) | errors, Delete |
| Success | `success` (#34d399) | `.success` (system green) | downloaded, saved, connected |
| Warning | `warning` (#fcd34d) | `.warning` (system yellow) | worth a look before going on |

- Over art (a tinted header, a blurred cover), secondary text is `paper-dim`/`.paperDim`, never `muted`.
- Color is never the only signal: an error also says so in words, and a done state has a tick.
- In system lists and forms (iOS Settings and sheets), iOS keeps the system's `.secondary`.

## Type

| Role | Web | iOS | Spec |
|---|---|---|---|
| Page title | `type-page-title` | `.typeRole(.pageTitle)` | Gloock. Web: 40 px on a phone up to 72 px. iOS: the large title, 34 pt |
| Section title | `type-section-title` | `.typeRole(.sectionTitle)` | Gloock. Web: 24 to 28 px. iOS: 22 pt |
| Kicker | `type-kicker` | `.typeRole(.kicker)` | DM Mono 11, capitals, 0.2 em apart, always `muted` |
| Body | `type-body` | `.typeRole(.body)` | Schibsted Grotesk 15: row titles, paragraphs |
| Small | `type-small` | `.typeRole(.small)` | 13: row subtitles, secondary lines |
| Meta | `type-meta` | `.typeRole(.meta)` | DM Mono 12, figures of one width: times, counts |
| Badge | `type-badge` | `.typeRole(.badge)` | DM Mono 10, capitals, 0.08 em apart |

- iOS sizes grow with Dynamic Type; spaced capitals close up at the accessibility sizes.
- Big numbers (Stats' headline) are set in Gloock, not DM Mono, whose comma takes a full cell ("1 , 792").

## Shape

- **Radii:** covers and thumbnails 4 (`rounded-cover`, `Radius.cover`); panels and cards 12 (`rounded-panel`, `Radius.panel`); dialogs and sheets 16 (`rounded-dialog`, `Radius.dialog`); pills and round buttons are full (`rounded-full`, `Capsule`/`Circle`).
- **Cover shadows:** a cover on a shelf or in a grid (`shadow-cover`, `.coverShadow(.shelf)`); a page's own cover and Now Playing's (`shadow-cover-hero`, `.coverShadow(.hero)`).

## Icons

- **Sizes by role:** in a menu 16 (web `size-4`), in a toolbar 18 (`size-4.5`), an icon button 20 (`size-5`), a tab 22 (`size-5.5`). iOS uses the same points, growing with Dynamic Type.
- **One stroke:** lucide's 2 on the web; SF Symbols' regular weight on iOS.
- **One glyph per concept** on each platform, mapped below by plan 5 §6.

## Motion

- **Fast, 150 ms:** a press, a hover, a color changing (Tailwind's default; `Motion.fast`).
- **Standard, 250 ms:** things that move or change size: menus, toasts, rows (`duration-250`, `Motion.standard`).
- **Sheets and dialogs** spring in: web Now Playing at damping 34, stiffness 320, mass 0.9, and dialogs at damping 32, stiffness 380; iOS sheets use the system's spring.
- **Slow on purpose:** covers fade in over 500 to 700 ms, and the accent follows a new cover over 0.8 s.
- **Reduce Motion:** the system setting, or Settings → Appearance → Motion, collapses every duration to nothing.

## Words

- **Songs, not tracks**, in every count and heading: "3 songs · 17 min", "Show all 12 songs".
- **Favorites** is the noun: "Favorites", "Add to Favorites". "Songs you love" can stay as flavor in a kicker.
- **Made for you** is the place for mixes (the nav, Home's shelf, Settings); one of them is a **mix** ("New mix").
- **Pending verbs** end with an ellipsis: "Requesting…", "Looking up…".
- **Retry** is always "Try again".
- **Remove** takes something out of a list; **Delete** destroys it.
- **Actions** are sentence case ("Play", "Shuffle", "Feeling lucky"). Mono capitals are for choices (Albums' sort, Stats' ranges) and kickers.
- **Spelling:** American (decided 2026-11-06): color, favorite, analyzed, leveled, organize.
- **Badges** say what they mean: "MP3 · 320 kbps", and an ordinary bitrate isn't shown.
- **Accent means action:** text in the accent can be tapped.
