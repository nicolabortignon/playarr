# Native iOS app, Phase 11: App Store Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Playarr is submitted for App Store review, and it goes on sale by itself once Apple approves it. `pnpm ios:release` does the whole thing from the repo. It checks the listing in `apps/ios/store/` and signs in to the demo server the way App Review will. It uploads the build the way `ios:beta` does, brings App Store Connect in line with the listing (text, category, age rating, price, availability, review details, screenshots, build), and submits. Running it again changes nothing, and `DRY_RUN=1` prints what it would change. `make screenshots` takes reproducible screenshots on the iPhone 17 Pro Max and iPad Pro 13-inch simulators. The privacy policy and support pages are on GitHub Pages.

**Architecture:** There are four new Node modules with no dependencies next to `asc.mjs`. `store.mjs` is pure: it reads and checks the listing (Apple's length limits, URLs, age rating answers, screenshot sizes and transparency), works out diffs and versions, plans screenshot uploads and builds request bodies. `appstore.mjs` has the App Store Connect steps (`syncListing`, `submitForReview`) and works on an injected `api`. In `release.mjs` that `api` is `asc.mjs` over HTTP. In a dry run, `withDryRun` wraps it so writes are logged instead of sent. In the tests it's an in-memory fake. `release.mjs` gains `release` and `check-store`; `beta()`'s upload half becomes `uploadBuild()`, which both use. `screenshots.mjs` starts the repo's own server on port 4610 with an empty data folder and a local copy of the Creative Commons albums. It seeds a listener account with two weeks of plays. Then, on simulators of its own, it fixes the status bar at 9:41 and runs the `StoreScreenshots` XCUITest. Finally it exports the attachments from the result bundle with `xcresulttool` and removes their alpha channel with `flatten-png.swift`. A `workflow_dispatch` job runs the release from CI, and a Pages workflow publishes `apps/ios/store/site/`.

**Tech Stack:** Node 24+ (`node:test`, `fetch`, `node:crypto`), App Store Connect API 4.5.1 (Apple's OpenAPI spec, downloaded 2026-11-03), XCUITest (Swift 6), `xcrun simctl`, `xcrun xcresulttool export attachments`, CoreGraphics (the flatten script), GNU Make 3.81, GitHub Actions (`macos-26` with Xcode 26.6; `actions/configure-pages@v6`, `upload-pages-artifact@v5`, `deploy-pages@v5`, the newest majors on 2026-11-03). pnpm through `corepack pnpm`.

**Design:** the App Review decision in [docs/decisions.md](../decisions.md) (2026-11-03): a reviewer account on the owner's server that sees only a Creative Commons folder, with no requests and no admin rights. Requests stay in every build, gated by the server and the account. Names and commands: [docs/ios/conventions.md](../ios/conventions.md). The pipeline this builds on, and the tooling this plan has already added, are described in [docs/ios/release.md](../ios/release.md): `asc.mjs`, `release.mjs`, the unsigned archive, cloud-signed export, altool upload, the Makefile and `.github/workflows/ios.yml`.

---

## Progress (2026-11-05)

**Done** (Tasks 0, 2 and 4 to 11, committed on main; how it works now is in [docs/ios/release.md](../ios/release.md)):
- the listing in `apps/ios/store/` (`en-US/*.txt`, `app.json`), checked against Apple's limits by `store.mjs` (`make store-check`);
- screenshot sets for iPhone 6.9", 6.3" and iPad 13", checked for size, transparency and names;
- `appstore.mjs` (`syncListing`, `submitForReview`, writing only what differs; `withDryRun`), `asc.mjs`'s GETs that may find nothing and its reading of refused submissions;
- `release.mjs release` and `check-store`, with `uploadBuild()` shared with `beta`;
- `make release`, `release-submit`, `screenshots`, `store-check`; `pnpm ios:release`, `ios:screenshots`; the `REVIEW_*` and `SCREENSHOT_*` lines in `.env.example`;
- the `StoreScreenshots` UI test, `flatten-png.swift` and `screenshots.mjs` (a local server on port 4610 with the Creative Commons albums, simulators of its own).

**Pending**, below in full: Task 1 (the user's decisions and `.env` lines), Task 3 (the pages; needs the support email), Task 12 (take the screenshots), Task 13 (the CI release job and its secrets: `.github/workflows/ios.yml` has no `workflow_dispatch` yet), Task 14 (dry run), Task 15 (website-only settings), Task 16 (submit), Task 17 (docs) and Task 18 (Apple's answer).

## Where things stand (checked read-only on 2026-11-03)

Only GET requests were made to App Store Connect while writing this plan. The `syncListing` and `submitForReview` code (now in `appstore.mjs`) was also run against the live API in dry-run mode: every read succeeded, and every write was only printed.

- **App record** "Playarr" (id `6830169335`), bundle `me.tracklistme.playarr`, SKU `playarr-ios`, primary locale `en-US`. `contentRightsDeclaration` is `null` (unanswered).
- **App Store version**: App Store Connect made one with the app record. It is `1.0` (not `1.0.0`), `PREPARE_FOR_SUBMISSION`, `releaseType: AFTER_APPROVAL`, `copyright: null`, with no build attached. The builds were uploaded as `1.0.0` (pre-release version `1.0.0`), so the release renames that version to `1.0.0`; App Store Connect wants the two to match.
- **Builds** 301, 304 and 310: all `VALID` and `usesNonExemptEncryption: false` (the Info.plist's `ITSAppUsesNonExemptEncryption = NO` works).
- **App info** `582365e2-…`, `PREPARE_FOR_SUBMISSION`. The en-US app info localization has name "Playarr" and no subtitle or privacy policy URL. There is no primary category. The age rating declaration (its id is the app info's) has every answer `null`.
- **Version localization** en-US exists, every field empty. No review details, no screenshot sets.
- **Price**: the price schedule exists with base territory USA but **no manual price** (`manualPrices` answers 404). The free price point for the USA exists (`customerPrice "0.0"`).
- **Availability**: none set (`/v1/apps/6830169335/appAvailabilityV2` answers 404). There are 175 territories.
- **Review submissions**: none.
- **App Privacy**: the API has no endpoint for it. Spec 4.5.1 has no data-usage resource, and the undocumented `/v1/apps/{id}/dataUsages` answered 500. It's done on the website (Task 15).
- **Accessibility declarations** (Accessibility Nutrition Labels): none; the API supports them (`/v1/accessibilityDeclarations`). Optional, and not in this phase (see "Not in this phase").
- **Phase plans present** when this plan was written: 0 to 3 only. Phases 4 to 10 were being planned in parallel, so the screen names this plan's UI test uses (marked `// UI:`) come from the design and must be checked against what those phases built (Task 0 and Task 10).
- **Simulators** on this Mac (Xcode 27.2, runtime iOS 26.1): "iPhone 17 Pro Max", "iPhone 17 Pro" and "iPad Pro 13-inch (M5)" all exist.
- **Apple's screenshot rules** (developer.apple.com, "Screenshot specifications", read 2026-11-03):
  - iPhone "Dynamic Island (large display)" (6.9"): 1320×2868, 1290×2796 or 1260×2736. The API's display type is `APP_IPHONE_67`.
  - iPad 13": 2064×2752 or 2048×2732, required for an app that runs on iPad. The API's display type is `APP_IPAD_PRO_3GEN_129`.
  - 1 to 10 screenshots per set; PNG or JPEG; **no alpha channel**.
  - The page also says at least one screenshot is required for "iPhone with Dynamic Island (medium display)" (6.3", 1206×2622, `APP_IPHONE_61`), which otherwise falls back to scaled large-display shots. This plan therefore also takes a 6.3" set (see Key decisions).
  - "iPhone Duo" screenshots become required in April 2027 for apps built with the iOS 27.1 SDK or later. Not yet (see "Not in this phase").

## Key decisions in this plan

- **The version comes from a command-line argument.** `corepack pnpm ios:release VERSION=1.1.0` passes the version through make to `release.mjs release 1.1.0`.
  - If the version is new, `release.mjs` writes `MARKETING_VERSION = 1.1.0` into `Config/Base.xcconfig` and commits it before archiving, so the build number (the commit count) includes that commit.
  - Without `VERSION`, it releases the version already in the xcconfig. For the first release that's `1.0.0`: no bump.
  - A version lower than the current one, or lower than one already on the App Store, is refused.
  - CI refuses to bump at all (`CI` is set there). A commit made on the runner would never reach `main`, and the next push would reuse its build number. So CI only releases what `main` already says.
  - A release needs a clean tree: an App Store build is made from a commit. Beta builds only warn about a dirty tree.
- **`release` reuses beta's upload.** `uploadBuild()` is the archive, export and altool half of `beta()`, unchanged. If App Store Connect already has the build for HEAD (CI's beta uploaded it), nothing is uploaded and the release just picks that build. Release builds reach the "Household" group too, which is fine.
- **The listing lives in `apps/ios/store/`.** There is one text file per field in `en-US/` (the file is the field; no YAML to parse), plus `app.json` for the settings that aren't localized: copyright, category, content rights, release type, price, availability and the age rating answers. Review contact details and the demo account are secrets or personal, and the repo is public, so they come from the environment. `review-notes.txt` uses `{{REVIEW_SERVER_URL}}` and `{{REVIEW_USERNAME}}`, which are filled in at release time. The password goes only into App Store Connect's "Sign-In Information" password field, never into the notes.
- **Screenshots come from a local copy of the server, not from the reviewer's server and not from a hand-written stub.** `make screenshots` runs the repo's own server (`apps/server`, through `tsx`) on `localhost:4610`, with an empty `DATA_DIR`, no analysis, Bonjour or Lidarr, and a clean environment (the repo's `.env` may point at Lidarr). It reads a folder holding a copy of the same Creative Commons albums as the reviewer's folder. Reasons:
  - The screens hit the real routes, so nothing drifts as phases change the API. A stub would need every endpoint Home, Library, Album and Now Playing call, and would go stale with each phase.
  - It is reproducible and offline once the folder is on the Mac. The reviewer's live server would change its Home with every review, would need the network (and the reverse proxy) for each run, and would leave sessions behind.
  - The screenshots show what App Review will see: the same albums.

  Lyrics come from an `.lrc` file beside a song (the server reads those before LRCLIB), so the lyrics shot doesn't depend on the network either. A listener account gets two weeks of seeded plays through `POST /api/plays`, so Home has Jump back in and mixes. MusicBrainz lookups for folder songs fail offline; the albums still show from their tags (checked in Task 12).
- **Three screenshot sets:**
  - iPhone 17 Pro Max (6.9", `APP_IPHONE_67`, required);
  - iPad Pro 13-inch (`APP_IPAD_PRO_3GEN_129`, required), in landscape so the sidebar, content and queue columns of phase 10 show;
  - iPhone 17 Pro (6.3", `APP_IPHONE_61`), optional, because Apple's page currently says a "medium display" screenshot is required.

  Each set's simulator is one of its own ("Playarr Screenshots iphone-6.9"), erased before every run. The appearance is dark (Playarr's look), the status bar is 9:41 with full bars and battery, and the date is 13 January 2026 (the iPad shows it). There are five shots: `01-now-playing`, `02-home`, `03-album`, `04-lyrics` and `05-library`. The number is the App Store order.
- **Screenshots are committed** (PNG, flattened). The release uploads the committed files and compares them by MD5 with what App Store Connect has (`sourceFileChecksum`), so a rerun uploads nothing. CI can release without running a simulator, and you see every screenshot in a diff before it goes out. They change only when `make screenshots` runs again.
- **The privacy policy and support page are on GitHub Pages** (`https://nicolabortignon.github.io/playarr/privacy.html` and `support.html`), from `apps/ios/store/site/`, published by a small Pages workflow. A `/privacy` page on the Playarr server was rejected for four reasons:
  - The policy belongs to the app, and so to every user of every server, not to one server.
  - It must stay up when the owner's NAS is off or moved, because Apple and users open it from the App Store page.
  - Every self-hosted server would otherwise serve a policy for an app its owner didn't publish.
  - The repo is public anyway, so Pages costs nothing and keeps the policy's history in git.

  The marketing URL is the GitHub repo. A custom domain later only changes three URL files.
- **App Privacy: "Data Not Collected".** Apple counts data as collected when it is sent off the device and the developer (or its partners) can keep it longer than needed to serve the request. Playarr sends nothing to W1T LTD. Sign-in, plays, favorites and playlists go to a server the user chooses and someone else runs, the way a mail app talks to the user's mail server. The app has no analytics, no ads and no third-party code. ListenBrainz forwarding and the MusicBrainz, LRCLIB, Deezer and AcoustID lookups are done by the server, not the app (checked in `apps/server/src/listenbrainz/scrobbler.ts` and `apps/server/src/lyrics/lyrics.ts`). The one exception is the demo account, which lives on the developer's own server, but it's used only by App Review. App Privacy can only be answered on the website (Task 15).
- **Age rating.** Every questionnaire field in the API is answered, because App Store Connect wants all of them:
  - `profanityOrCrudeHumor: INFREQUENT_OR_MILD`: the app shows song lyrics, and lyrics can swear. The app makes none of its content, but showing lyrics is the app's doing.
  - Every other level is `NONE`.
  - Every yes/no is `false`. In particular, `unrestrictedWebAccess` is false (there's no browser) and `userGeneratedContent` is false: shared playlists are seen only by the accounts a server's owner created, never publicly. `messagingAndChat`, `advertising` and `socialMedia` are false too.

  This probably gives 13+ (it was 12+ under the old scale). The alternative, all `NONE` (4+), is the user's call in Task 1.
- **Content rights: `USES_THIRD_PARTY_CONTENT`.** The App Store Connect question is "Does your app contain, show, or access third-party content?". Playarr plays the user's own music and shows artwork, metadata and lyrics that the server fetched from MusicBrainz, the Cover Art Archive and LRCLIB. So the honest answer is yes, with "the necessary rights": users play files they own, and the open databases license their data for this use. The demo account plays Creative Commons music. Answering "no" would be inaccurate.
- **Price free, available everywhere.** A free price schedule is created only when there's no manual price yet. The app becomes available in all 175 territories and in new ones (`availableInNewTerritories: true`), set only if no availability exists; later changes are made in App Store Connect. EU distribution also needs the Digital Services Act trader declaration, which is account-level and done on the website (Task 1, Task 15).
- **Category Music**, no secondary category. **Release after approval** (`AFTER_APPROVAL`, already the version's value). **Export compliance**: settled by the Info.plist since phase 0.
- **"What's New" is left out on the first version**: App Store Connect doesn't accept it there. From the second version on, `whats-new.txt` is sent.
- **Dry runs use the same code path.** `withDryRun` replaces `post`, `patch` and `del` with lines like `would PATCH /v1/appStoreVersions/… (versionString, copyright)`. Reads still go to Apple. Things a dry run would create get ids starting with `dry-run-`, and reads under them find nothing, so later steps show what they'd create too. The upload is skipped (`Build N: would be archived and uploaded`), and so is the version bump.
- **Secrets are never printed.** Logs name changed attributes only ("notes, demoAccountPassword"), never values. Claude never prints `.env` values or the `.p8` key: checks print `set` or `MISSING`.
- **The demo account is checked before anything is changed.** The release signs in to `REVIEW_SERVER_URL` as the reviewer. It checks `GET /api/server` (not in setup mode) and that the account is a member, can't request and sees only some sources. It checks that at least one album is visible, then signs out again. An App Review rejection under 2.1 costs days; this check takes a second.

## App Store Connect API: what's verified and what isn't

| Capability | Status | Fallback if it fails |
|---|---|---|
| Read app, versions, app infos, localizations, age rating, category, price schedule, territories, builds, review submissions | **Verified** with GETs on 2026-11-03 (and the dry run of `syncListing`) | — |
| PATCH `apps` `contentRightsDeclaration` | In spec 4.5.1 (`AppUpdateRequest`); not tried | App Store Connect → App Information → Content Rights |
| PATCH `appStoreVersions` `versionString` (renaming "1.0" to "1.0.0"), `copyright`, `releaseType` | In spec; not tried. Renaming is believed allowed while `PREPARE_FOR_SUBMISSION` | Rename the version in App Store Connect (iOS App → 1.0 → version field) |
| PATCH/POST `appStoreVersionLocalizations`, `appInfoLocalizations` | In spec; not tried. `whatsNew` is believed refused on a first version, so it's left out | Paste the text from `store/en-US/` |
| PATCH `appInfos` relationship `primaryCategory` → `appCategories/MUSIC` | In spec; `MUSIC` verified to exist | App Information → Category |
| PATCH `ageRatingDeclarations` (all 23 answers) | In spec 4.5.1 with these exact field names. **Unsure** whether `socialMediaAgeRestricted` (left out) or `kidsAgeBand` must be sent too, and whether the newest questions (`ageAssurance`, `healthOrWellnessTopics`, `messagingAndChat`, `parentalControls`) are already writable | If Apple answers 409 naming a field, add or drop it in `AGE_RATING` and `app.json`; otherwise App Information → Age Rating → Edit |
| POST `appPriceSchedules` with an inline `appPrices` (`id: "${free}"`) | In spec (`AppPriceV2InlineCreate`); **unsure** about the exact local-id syntax | Pricing and Availability → Price → Free |
| POST `/v2/appAvailabilities` with 175 inline `territoryAvailabilities` (`id: "${GBR}"`, …) | In spec; **unsure** about the local-id syntax and whether all 175 go in one request | Pricing and Availability → Availability → all countries; tick "make available in new countries" |
| POST/PATCH `appStoreReviewDetails` (contact, demo account, notes) | In spec; not tried. There's no field for the server URL, so it goes in the notes | App Review Information on the version page |
| Screenshots: POST `appScreenshotSets`, POST `appScreenshots` (reserve) → PUT each `uploadOperations` part → PATCH `uploaded: true` + MD5 `sourceFileChecksum` → poll `assetDeliveryState` → PATCH set order | Documented flow; not tried here. **Unsure** that `APP_IPHONE_61` takes 1206×2622 | Drag the PNGs from `store/screenshots/` into the version page; delete `store/screenshots/iphone-6.3/` if the 6.3" set is refused |
| PATCH `appStoreVersions/{id}/relationships/build` | In spec; not tried | Version page → Build → choose |
| `reviewSubmissions` + `reviewSubmissionItems` + PATCH `submitted: true` | In spec; not tried. **Unsure** how a rejected submission (`UNRESOLVED_ISSUES`) is resubmitted: the script reuses it and adds the version if missing | App Store Connect → the version → "Add for Review" / "Resubmit to App Review" |
| App Privacy (data usage) | **Not in the API** (none in spec 4.5.1; the undocumented `dataUsages` answered 500) | Website only: Task 15 |
| DSA trader status | **Not in the API** (account-level) | Website only: Task 15 |
| Developer name ("Latitude") | **Not in the API**; only Apple Support changes it | Task 1 decision |

## App Review risk notes

| Guideline | Risk | What this plan does |
|---|---|---|
| 2.1 App completeness | The reviewer can't sign in (server down, proxy, wrong password) and rejects | The release signs in as the reviewer first and refuses to go on otherwise. The notes give the exact address and steps. Keep the server up and the password unchanged until approval (Task 16). |
| 4.2 Minimum functionality | Native SwiftUI with its own audio engine, not a web wrapper | Nothing more needed. |
| Login required | Apple needs a demo account | `demoAccountRequired: true`, the demo username and password in Sign-In Information, the server address in the notes. |
| 4.8 Sign in with Apple | Required only alongside third-party or social login | Not required: Playarr has its own server accounts, no third-party login. |
| 5.2.3 Audio/video downloading | Requests ask the server owner's Lidarr to add albums. Lidarr gets music from wherever its owner configured it, which App Review could read as facilitating downloads | The demo account can't request (checked before submitting), so no request button appears. The notes describe requests honestly (a 2.3.1 "hidden features" rejection is worse) as a gated feature that adds to the owner's own library, with the app downloading nothing from third-party sources. **If Apple objects**, the options are the user's: explain in Resolution Center, or hide requests in App Store builds, which reverses the design's "requests in all builds" decision. |
| 2.3.1 Hidden features | Requests and admin settings aren't visible to the reviewer | Both are named in the review notes and the description. If Apple asks to see them, attach a screen recording made on a test server (App Review attachments exist in the API, `appStoreReviewAttachments`, but this plan uploads them by hand in Resolution Center). |
| 5.1.1(v) Account deletion | Claiming a server in setup mode creates an account in the app | Accounts live on the user's own server, not a developer service. Admins delete accounts in Settings → Accounts, and removing a server from the app removes its data from the device. If Apple asks, answer that in Resolution Center; there is no developer-side account to delete. |
| 5.1.1 Data collection and 5.1.2 | "Data Not Collected" must be true | It is (Key decisions). The privacy policy says what goes to the user's server. |
| 5.2.1 and 5.2.2 Intellectual property | Album art and music in screenshots and the demo | Only Creative Commons albums (CC BY or CC0; no NC or ND), credited on the Pages index page. |
| 2.3.7 Metadata | Other apps' names in keywords | Keywords name no apps (Lidarr is in the description only, as a fact about compatibility). |
| 2.3.3 and 2.3.4 Screenshots | Must show the app in use | Taken from the app itself, with the reviewer's albums. |

## Conventions

- Run everything from the repo root `/Users/bortignon/dev/playarr`. `pnpm` is `corepack pnpm` in Claude's shell.
- Script tests: `node --test apps/ios/scripts/<file>.test.mjs`, or all of them: `make -C apps/ios test-scripts`. `make -C apps/ios test` also runs the Swift and UI tests. `StoreScreenshots` skips itself there.
- Make variables go after the target, through pnpm too: `corepack pnpm ios:release VERSION=1.1.0 DRY_RUN=1`, `corepack pnpm ios:screenshots SETS=ipad-13`.
- **Never print secrets.** Don't `cat .env`, echo `REVIEW_PASSWORD` or read the `.p8` key. Use the `set`/`MISSING` check in Task 1.
- Claude's shell can't reach the home network (macOS Local Network privacy blocks it, e.g. 192.168.1.103). The demo server is checked by its public HTTPS address, which normally works. If the release's sign-in check fails at once with `EPERM`/`EHOSTUNREACH` (for example when the domain resolves to a LAN address at home), ask the user to run the same `corepack pnpm ios:release …` in Terminal.
- `corepack pnpm ios:screenshots` takes 10 to 25 minutes, and `corepack pnpm ios:release` 15 to 60 minutes (archive, upload, processing). Run them in the background and wait for them to finish.
- Commit after every task that changes files: on `main`, only that task's files, with a plain-English subject (no `feat:`) and the `Co-Authored-By: Claude <noreply@anthropic.com>` line after a blank line. The pre-commit hook bumps `package.json`'s version; never bypass it. The user pushes.
- Steps the user has to do are marked **Checkpoint (user)**. Stop there until the user confirms.
- `Makefile` recipe lines start with a **tab**.
- The repository moves while phases run in parallel. Where a step edits an existing file, match the text shown. If it has changed, apply the same change to the current text; don't drop someone else's change (for example `release.mjs`'s `NO_MACRO_SANDBOX` flag from phase 2).

## Tasks

0. ~~Starting point (read-only)~~ (done)
1. **Checkpoint (user)**: decisions, the public address, the demo account, contact details, the Creative Commons folder
2. ~~The store text and settings, checked against Apple's limits~~ (done)
3. Privacy policy and support pages on GitHub Pages
4. ~~Screenshot sets: sizes, transparency, names~~ (done)
5. ~~The pieces of a sync: diffs, versions, screenshot plans, request bodies~~ (done)
6. ~~`asc.mjs`: GETs that may find nothing, and what a refused submission says~~ (done)
7. ~~`appstore.mjs`: App Store Connect in line with the listing, then submit~~ (done)
8. ~~`release.mjs`: the `release` and `check-store` commands~~ (done)
9. ~~Makefile, pnpm scripts and `.env.example`~~ (done)
10. ~~The `StoreScreenshots` UI test and the flatten script~~ (done)
11. ~~`screenshots.mjs`: a local server, simulators of their own, the screenshots out of the result bundle~~ (done)
12. Take the screenshots (**Checkpoint (user)**: look at them)
13. CI: a release you start by hand (**Checkpoint (user)**: the secrets)
14. A dry run against App Store Connect
15. **Checkpoint (user)**: App Privacy, DSA trader status, the developer name, the pages
16. Release: submit for review
17. Docs: README, the decisions log and the iOS docs
18. **Checkpoint (user)**: Apple's answer

---

### Task 1: Checkpoint (user): decisions, the public address, the demo account, contact details, the Creative Commons folder

No code. Ask the user for each item below, and record the answers in this plan (edit the "Decisions taken" list at the end of this task) before going on.

**1. Developer name (open decision).** App Store Connect and TestFlight show the developer name "Latitude", the team's existing name. It appears on the App Store page under "Playarr". The options:
- (a) Leave it as "Latitude".
- (b) Ask Apple Support (developer.apple.com/contact → Membership and Account) to change it to "W1T LTD" or to a registered trade name of W1T LTD. It changes for every app of the team, and Apple asks for proof of the name.
- (c) Publish under a different team: a new Apple Developer Program membership, then an app transfer of "Playarr" (App Store Connect → App Information → Transfer App, possible only once a version has been approved). That means new keys, secrets and team id.

The copyright line (`app.json`, "2026 W1T LTD") and the privacy policy (published by W1T LTD) name the company either way. Decide before Task 16: after approval the name is public, and changing it needs Apple anyway.

**2. The public address of the demo server.** The reviewer reaches the owner's Playarr server over HTTPS on the user's own domain, through the reverse proxy (design, "Remote access"). Ask for the URL, e.g. `https://music.example.com`. Check it from Claude's shell (a public address, so the Local Network block doesn't apply):

```bash
curl -s https://<the address>/api/server
```

Expected: `{"id":"…","name":"…","version":"…","minAppVersion":"…","setup":false}`. A certificate error, a timeout or `"setup":true` has to be fixed on the server first. Ask the user to also open the address on a phone using mobile data, not Wi-Fi.

**3. The demo account.** The user creates it on the real server (Claude can't reach the NAS from its shell; hand over these steps and wait):
- Make sure the Creative Commons music is a source of its own: Settings → Sources → Add source → a folder holding only Creative Commons albums (CC BY or CC0), named "Creative Commons". Wait for its sync and matching to finish.
- Settings → Accounts → **Add account**: Name `App Review`, Username `reviewer`, Role **Member**, **Can request albums** off, Library **Only these sources** → tick only **Creative Commons**. Copy the setup link.
- Open the setup link in a private window and choose a strong password; keep it in a password manager under "Playarr App Review".
- Still signed in as `reviewer`, check: Home and Library show only the Creative Commons albums and Search finds nothing else; no Request buttons; Settings → Accounts shows only "You"; Sources, Requests and Updates say only an admin can change them; an album URL from another source answers "not found". Sign that browser session out afterwards (Settings → Accounts → reviewer → Devices).

**4. Contact details for App Review** (first name, last name, email, phone with country code). They aren't public, but the repo is, so they go in `.env` only.

**5. A support email address.** It's public: it goes on the support page and in the privacy policy.

**6. The `.env` lines.** Ask the user to add these to the repo's `.env` themselves (Claude must not see the password):

```bash
REVIEW_SERVER_URL=https://music.example.com
REVIEW_USERNAME=reviewer
REVIEW_PASSWORD=…
REVIEW_CONTACT_FIRST_NAME=…
REVIEW_CONTACT_LAST_NAME=…
REVIEW_CONTACT_EMAIL=…
REVIEW_CONTACT_PHONE=+44 …
# Only if the albums for the screenshots aren't in ~/Music/Playarr Creative Commons:
# SCREENSHOT_LIBRARY=/Users/you/Music/Some other folder
# The album to feature in the screenshots (its title as the server shows it):
SCREENSHOT_ALBUM=…
```

Then check without printing values:

```bash
node --env-file=.env -e "for (const k of ['REVIEW_SERVER_URL','REVIEW_USERNAME','REVIEW_PASSWORD','REVIEW_CONTACT_FIRST_NAME','REVIEW_CONTACT_LAST_NAME','REVIEW_CONTACT_EMAIL','REVIEW_CONTACT_PHONE','SCREENSHOT_ALBUM']) console.log(k.padEnd(26), process.env[k] ? 'set' : 'MISSING')"
```

Expected: eight `set` lines.

**7. The Creative Commons albums on this Mac, for the screenshots.** Ask the user to copy the albums of the reviewer's "Creative Commons" folder into `~/Music/Playarr Creative Commons` (Artist/Album/NN Title.flac, with their cover image). 4 to 8 albums is plenty. Conditions:
- Only CC BY or CC0 licences (no NC or ND), because the covers appear on the App Store.
- The featured album (`SCREENSHOT_ALBUM`) has a song with vocals and an `.lrc` file beside its **first** song (same name, `.lrc`), from the artist's published lyrics. The lyrics screenshot shows it.
- For each album: title, artist, licence and where it came from (a URL), for the credits on the Pages index.

```bash
find "$HOME/Music/Playarr Creative Commons" -maxdepth 3 \( -name '*.lrc' -o -name 'cover.*' -o -name 'folder.*' \) | head
find "$HOME/Music/Playarr Creative Commons" -type f \( -name '*.flac' -o -name '*.mp3' \) | wc -l
```

Expected: at least one `.lrc`, a cover per album, and some songs.

**8. Confirm the listing decisions** in "Key decisions": the age rating (lyrics → infrequent mild profanity, probably 13+; or all "none", 4+), content rights ("uses third-party content"), all territories, free, dark screenshots, and the optional 6.3" set.

**9. EU: Digital Services Act trader status (website only).** The account holder declares it in App Store Connect → Business (or Users and Access → the account's "Digital Services Act" section). An organization distributing on the App Store is normally a trader. The company's address, phone and email are then shown on the EU product pages. Until it's declared, Apple doesn't publish the app in EU countries. Ask the user to do it now, or to accept that the EU waits.

**Decisions taken** (fill in): developer name: … · demo server: … · support email: … · age rating: … · content rights: … · DSA: … · featured album: …

---

### Task 3: Privacy policy and support pages on GitHub Pages

**Files:**
- Create: `apps/ios/store/site/index.html`, `privacy.html`, `support.html`, `style.css`
- Create: `.github/workflows/pages.yml`
- Modify: `apps/ios/scripts/store.test.mjs`

**Step 1: Write the failing test.** Replace the import lines at the top of `apps/ios/scripts/store.test.mjs` with:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fillNotes, readStore, STORE, validateStore } from './store.mjs';
```

and append:

```js
test('the store pages have nothing left to fill in, and the listing points at them', () => {
  for (const page of ['index.html', 'privacy.html', 'support.html']) {
    assert.doesNotMatch(readFileSync(join(STORE, 'site', page), 'utf8'), /\{\{\w+\}\}/, `site/${page} still has a placeholder`);
  }
  const { text } = readStore();
  assert.match(text.privacyPolicyUrl, /\/privacy\.html$/);
  assert.match(text.supportUrl, /\/support\.html$/);
});
```

**Step 2: Run it to see it fail**

```bash
node --test apps/ios/scripts/store.test.mjs 2>&1 | grep -E 'ℹ (pass|fail)|ENOENT'
```

Expected: `ℹ fail 1`, with `ENOENT` for `site/index.html`.

**Step 3: Write the pages**

`apps/ios/store/site/style.css`:

```css
:root { color-scheme: dark; --accent: #ff7a1a; }
body { margin: 0; background: #0f0e0c; color: #ece6dc; font: 17px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 42rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 0.25rem; }
h2 { font-size: 1.2rem; margin: 2.2rem 0 0.5rem; }
a { color: var(--accent); }
.meta { color: #a59d92; margin: 0 0 2rem; }
nav { margin-top: 3rem; color: #a59d92; }
```

`apps/ios/store/site/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Playarr for iPhone and iPad</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
<main>
  <h1>Playarr for iPhone and iPad</h1>
  <p class="meta">The player for your own Playarr server.</p>
  <p>Playarr is a free, open-source music server that you run yourself. It plays the music folders you give it and the library <a href="https://lidarr.audio">Lidarr</a> manages. The app plays that music on iPhone and iPad: gapless, at an even volume, with crossfades or DJ mixes, lyrics and downloads for listening offline.</p>
  <p>The app needs a Playarr server: the code and how to run one are on <a href="https://github.com/nicolabortignon/playarr">GitHub</a>.</p>
  <h2>Music in the screenshots</h2>
  <p>The App Store screenshots show albums released under Creative Commons licences:</p>
  <ul>
    {{SCREENSHOT_CREDITS}}
  </ul>
  <nav><a href="support.html">Support</a> · <a href="privacy.html">Privacy policy</a></nav>
</main>
</body>
</html>
```

`apps/ios/store/site/support.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Playarr support</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
<main>
  <h1>Playarr support</h1>
  <p class="meta">Help with the Playarr app for iPhone and iPad.</p>

  <h2>Contact</h2>
  <p>Write to <a href="mailto:{{SUPPORT_EMAIL}}">{{SUPPORT_EMAIL}}</a>, or open an issue on <a href="https://github.com/nicolabortignon/playarr/issues">GitHub</a>. Say which version of the app you have (the version is under Settings) and what you expected to happen.</p>

  <h2>What do I need to use the app?</h2>
  <p>A Playarr server: a small program that runs on a computer or NAS at home, or on a server you rent, and reads your music. The app has no music of its own. The <a href="https://github.com/nicolabortignon/playarr#readme">README</a> explains how to run one with Docker. If someone you know runs one, ask them for an account.</p>

  <h2>How do I connect?</h2>
  <p>At home, the app lists the Playarr servers on your network: tap yours. Elsewhere, type its address, for example <code>https://music.example.com</code>. Away from home the server must be reachable over HTTPS (behind a reverse proxy, for example).</p>

  <h2>I forgot my password</h2>
  <p>Ask the server's owner: in Settings → Accounts they can give you a new setup code. Owners who forgot their own password reset it on the server itself, as the README describes.</p>

  <h2>Where is my data?</h2>
  <p>On your server, and on your device for what you downloaded. See the <a href="privacy.html">privacy policy</a>.</p>

  <nav><a href="index.html">Playarr for iPhone and iPad</a> · <a href="privacy.html">Privacy policy</a></nav>
</main>
</body>
</html>
```

`apps/ios/store/site/privacy.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Playarr privacy policy</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
<main>
  <h1>Privacy policy</h1>
  <p class="meta">Playarr for iPhone and iPad · last changed {{POLICY_DATE}}</p>

  <p>Playarr is an app for listening to music on a Playarr server: a server that you, or someone you know, run. It is published by W1T LTD ("we"). In short: <strong>we collect nothing</strong>. The app talks only to the servers you add.</p>

  <h2>What we collect</h2>
  <p>Nothing. The app has no analytics, no advertising, no tracking and no third-party code, and it sends nothing to us. We have no account system: you sign in to a server, not to us.</p>

  <h2>What the app sends to the servers you add</h2>
  <p>To let you listen, the app sends these to the Playarr server you connect to, and to nothing else:</p>
  <ul>
    <li>your username and password when you sign in; the app then keeps a sign-in token in the iOS Keychain;</li>
    <li>the name and type of your device, so you can see and end its session from the server;</li>
    <li>what you play, so the server can keep your listening history and make your mixes;</li>
    <li>your favorites, playlists and settings you save on the server, and, if the server's owner allows it, album requests.</li>
  </ul>
  <p>That server is run by its owner, not by us. Its owner can see the accounts on it and what they play. If you run the server yourself, all of it stays with you.</p>

  <h2>What the server may share</h2>
  <p>A Playarr server can look things up for its library on services its owner sets up: MusicBrainz and AcoustID (song details), LRCLIB (lyrics), Deezer and ListenBrainz (recommendations), and Lidarr (the owner's own library manager). If you link your ListenBrainz account in the app, the server sends what you play to ListenBrainz. The app itself never contacts these services. The <a href="https://github.com/nicolabortignon/playarr#readme">Playarr README</a> describes the server.</p>

  <h2>What stays on your device</h2>
  <p>The list of your servers and accounts, your playback and appearance settings, a cache of the library and its artwork, and the songs you download. Deleting the app deletes all of it. Signing out of an account removes its token.</p>

  <h2>Local network</h2>
  <p>With your permission, the app looks for Playarr servers on your home network (Bonjour). Nothing found there leaves your network.</p>

  <h2>Apple</h2>
  <p>If you choose to share crash reports and usage data with app developers in your device's settings, Apple sends them to us without anything that identifies you. We use them only to fix problems.</p>

  <h2>Children</h2>
  <p>The app is not made for children and collects nothing from anyone.</p>

  <h2>Changes and contact</h2>
  <p>When this policy changes, the new version is posted here with its date. Questions: <a href="mailto:{{SUPPORT_EMAIL}}">{{SUPPORT_EMAIL}}</a>.</p>

  <nav><a href="index.html">Playarr for iPhone and iPad</a> · <a href="support.html">Support</a></nav>
</main>
</body>
</html>
```

Fill in the placeholders from Task 1:
- `{{SUPPORT_EMAIL}}` (three places): the support address.
- `{{POLICY_DATE}}`: today's date, e.g. `3 November 2026`.
- `{{SCREENSHOT_CREDITS}}`: one line per album, e.g. `<li><a href="https://…">Album title</a> by Artist, CC BY 4.0</li>`.

If the developer name decision publishes under another company, change "W1T LTD" in `privacy.html`.

**Step 4: Write the Pages workflow**

`.github/workflows/pages.yml`:

```yaml
# The iOS app's pages for the App Store (privacy policy, support) from apps/ios/store/site, on GitHub Pages:
# https://nicolabortignon.github.io/playarr/. Runs when they change on main, or by hand.
name: Pages

on:
  push:
    branches: [main]
    paths: ['apps/ios/store/site/**', '.github/workflows/pages.yml']
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/configure-pages@v6
      - uses: actions/upload-pages-artifact@v5
        with:
          path: apps/ios/store/site
      - id: deployment
        uses: actions/deploy-pages@v5
```

**Step 5: Run the tests and check the workflow parses**

```bash
node --test apps/ios/scripts/store.test.mjs 2>&1 | grep -E 'ℹ (pass|fail)'
ruby -ryaml -e 'puts YAML.load_file(".github/workflows/pages.yml")["jobs"]["deploy"]["steps"].map { |s| s["uses"] }'
```

Expected: `ℹ pass 5`, `ℹ fail 0`; then `actions/checkout@v7`, `actions/configure-pages@v6`, `actions/upload-pages-artifact@v5`, `actions/deploy-pages@v5`. Open `apps/ios/store/site/privacy.html` in a browser (`open apps/ios/store/site/privacy.html`) and read it once: dark page, orange links, no `{{`.

**Step 6: Commit**

```bash
git add apps/ios/store/site .github/workflows/pages.yml apps/ios/scripts/store.test.mjs
git commit -m "$(cat <<'EOF'
iOS app: privacy policy and support pages for the App Store, published on GitHub Pages

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

**Step 7: Checkpoint (user): turn on Pages and push.** On github.com/nicolabortignon/playarr → **Settings** → **Pages** → **Build and deployment** → Source: **GitHub Actions**. Then `git push origin main`. The "Pages" workflow runs, and its summary shows the address. Then check from Claude's shell:

```bash
for page in privacy support; do curl -s -o /dev/null -w "%{http_code} $page\n" https://nicolabortignon.github.io/playarr/$page.html; done
```

Expected: `200 privacy` and `200 support`. If the user prefers a custom domain (e.g. `https://playarr.example.com`), set it under Pages → Custom domain and change the three URL files in `apps/ios/store/en-US/` in a commit of its own.

---

### Task 12: Take the screenshots (Checkpoint (user): look at them)

**Files:**
- Create: `apps/ios/store/screenshots/iphone-6.9/*.png`, `apps/ios/store/screenshots/iphone-6.3/*.png`, `apps/ios/store/screenshots/ipad-13/*.png`

**Step 1: Take them** (in the background; 10 to 25 minutes)

```bash
corepack pnpm ios:screenshots
```

Expected, after the project generation and build output:

```
▸ Starting a local Playarr server on http://localhost:4610 with /Users/…/Music/Playarr Creative Commons
  6 albums; featuring "<SCREENSHOT_ALBUM>" by <artist>

▸ iphone-6.9 on iPhone 17 Pro Max
  ✓ 01-now-playing, 02-home, 03-album, 04-lyrics, 05-library

▸ iphone-6.3 on iPhone 17 Pro
  ✓ 01-now-playing, 02-home, 03-album, 04-lyrics, 05-library

▸ ipad-13 on iPad Pro 13-inch (M5)
  ✓ 01-now-playing, 02-home, 03-album, 04-lyrics, 05-library

✓ Screenshots are in apps/ios/store/screenshots. Look at them before committing.
```

**Step 2: If it fails**

| Message | What to do |
|---|---|
| `Put the Creative Commons albums in …` | Task 1, item 7. |
| `The local server didn't start` | `corepack pnpm install`; check that port 4610 is free (`lsof -i tcp:4610`). |
| `No albums in …` | The files need tags or Artist/Album/NN Title names. Start the server by hand as in `startServer` and look at `GET /api/settings/sources/<id>/review`. Albums waiting for review there (doubtful MusicBrainz matches, offline) can be accepted with their own names. If folder albums never show without a match, file it as a server issue and tag the files fully. |
| The test fails waiting for an element | Its name differs from the app: open `build/screenshots/<set>.xcresult` in Xcode (the failure has a screenshot), fix the `// UI:` query in `StoreScreenshots.swift`, and amend Task 10's file in a new commit. |
| A sheet ("Save Password?", "Allow … local network") covers a screenshot | The interruption monitor didn't catch it. Add a tap on its button after `signIn` and commit. |
| The iPad screenshots come out sideways (2752×2064 pixels but the picture turned) | XCUITest captured the native portrait buffer. In `capture()`, after flattening an `ipad-` set, turn it upright: `execFileSync('sips', ['-r', '-90', file])` (or `90`, whichever is upright), commit, rerun with `SETS=ipad-13`. |
| `xcresulttool: … manifest.json` missing | Xcode older than 16 has no `export attachments`; the project needs Xcode 26 or later anyway. |

**Step 3: Check them**

```bash
make -C apps/ios store-check
for f in apps/ios/store/screenshots/*/*.png; do sips -g pixelWidth -g pixelHeight -g hasAlpha "$f" | tr '\n' ' '; echo; done
du -sh apps/ios/store/screenshots
```

Expected: `✓ The listing in apps/ios/store is within Apple's limits (screenshots: 5 iphone-6.9, 5 iphone-6.3, 5 ipad-13).` The sizes are 1320×2868 (6.9"), 1206×2622 (6.3") and 2752×2064 (iPad, landscape), all `hasAlpha: no`. The folder is about 10 to 25 MB.

Read every PNG (the Read tool shows images) and check, for each one:
- the status bar shows 9:41, full Wi-Fi and battery, no carrier name;
- the content is right: Now Playing with artwork and the accent colour, Home with Jump back in, the featured album, lyrics on screen, the library;
- there's no request button, no admin entry, no error and no spinner;
- the iPad shows the sidebar, with the queue or lyrics column.

**Step 4: Checkpoint (user):** show the user the 15 screenshots (paths) and ask whether they're good for the App Store. If not, change what they ask (the featured album, the order, another screen), run Step 1 again (`SETS=ipad-13` for one set), and check again.

**Step 5: Commit**

```bash
git add apps/ios/store/screenshots
git commit -m "$(cat <<'EOF'
iOS app: App Store screenshots for iPhone 6.9" and 6.3" and iPad 13", from the Creative Commons albums

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: CI: a release you start by hand (Checkpoint (user): the secrets)

**Files:**
- Modify: `.github/workflows/ios.yml`

**Step 1: Edit the workflow.**

(a) Add to the header comment, after its first paragraph:

```yaml
# Run by hand (Actions → iOS → Run workflow, on main), the `release` job submits MARKETING_VERSION to the
# App Store (`make release-submit`); "Dry run" (ticked by default) only prints what would change. It shares
# the concurrency group with pushes to main: a push while it's still queued replaces it, so start it when no
# iOS run is waiting.
```

(b) Under `on:`, after the `pull_request:` entry, add:

```yaml
  workflow_dispatch:
    inputs:
      dry_run:
        description: Dry run (only print what would change in App Store Connect)
        type: boolean
        default: true
```

(c) In `jobs: ios:`, add `if: github.event_name != 'workflow_dispatch'` above `runs-on: macos-26`, so starting a release doesn't also run the test job.

(d) At the end of the file, add the job (indented under `jobs:`):

```yaml
  # By hand only (Actions → iOS → Run workflow, on main): submits MARKETING_VERSION to the App Store with
  # `make release-submit`, after the tests. With "Dry run" ticked it only prints what would change.
  release:
    if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'
    runs-on: macos-26
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # the build number is the commit count

      - name: Select Xcode
        run: sudo xcode-select -s "/Applications/Xcode_${XCODE_VERSION}.app"

      - name: Bootstrap
        run: make -C apps/ios bootstrap

      - name: Test
        if: ${{ !inputs.dry_run }}
        run: make -C apps/ios test

      - name: Install the App Store Connect key
        env:
          ASC_KEY_ID: ${{ secrets.ASC_KEY_ID }}
          ASC_KEY_P8_BASE64: ${{ secrets.ASC_KEY_P8_BASE64 }}
        run: |
          mkdir -p ~/.appstoreconnect/private_keys
          umask 077
          printf '%s' "$ASC_KEY_P8_BASE64" | base64 --decode > ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8

      - name: Release to the App Store
        env:
          ASC_KEY_ID: ${{ secrets.ASC_KEY_ID }}
          ASC_ISSUER_ID: ${{ secrets.ASC_ISSUER_ID }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          IOS_BUNDLE_ID: me.tracklistme.playarr
          REVIEW_SERVER_URL: ${{ secrets.REVIEW_SERVER_URL }}
          REVIEW_USERNAME: ${{ secrets.REVIEW_USERNAME }}
          REVIEW_PASSWORD: ${{ secrets.REVIEW_PASSWORD }}
          REVIEW_CONTACT_FIRST_NAME: ${{ secrets.REVIEW_CONTACT_FIRST_NAME }}
          REVIEW_CONTACT_LAST_NAME: ${{ secrets.REVIEW_CONTACT_LAST_NAME }}
          REVIEW_CONTACT_EMAIL: ${{ secrets.REVIEW_CONTACT_EMAIL }}
          REVIEW_CONTACT_PHONE: ${{ secrets.REVIEW_CONTACT_PHONE }}
          DRY_RUN: ${{ inputs.dry_run && '1' || '' }}
        run: make -C apps/ios release-submit DRY_RUN="$DRY_RUN"

      - name: Remove the key
        if: always()
        run: rm -rf ~/.appstoreconnect
```

**Step 2: Check that it parses**

```bash
ruby -ryaml -e 'y = YAML.load_file(".github/workflows/ios.yml"); p y["jobs"].keys; puts y["jobs"]["release"]["steps"].map { |s| s["name"] || s["uses"] }; p y[true].keys'
```

Expected:

```
["ios", "release"]
actions/checkout@v7
Select Xcode
Bootstrap
Test
Install the App Store Connect key
Release to the App Store
Remove the key
["push", "pull_request", "workflow_dispatch"]
```

(YAML 1.1 reads the key `on` as `true`, hence `y[true]`.)

**Step 3: Commit**

```bash
git add .github/workflows/ios.yml
git commit -m "$(cat <<'EOF'
CI: an App Store release started by hand from main, with a dry run by default

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

**Step 4: Checkpoint (user): the secrets.** On github.com/nicolabortignon/playarr → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, add seven secrets with the same values as in `.env`:

| Name | Secret |
|---|---|
| `REVIEW_SERVER_URL` | the demo server's https:// address |
| `REVIEW_USERNAME` | `reviewer` |
| `REVIEW_PASSWORD` | its password |
| `REVIEW_CONTACT_FIRST_NAME`, `REVIEW_CONTACT_LAST_NAME`, `REVIEW_CONTACT_EMAIL`, `REVIEW_CONTACT_PHONE` | the App Review contact |

`ASC_KEY_ID`, `ASC_ISSUER_ID`, `APPLE_TEAM_ID` and `ASC_KEY_P8_BASE64` exist since phase 0. Then push. CI is optional: the local `corepack pnpm ios:release` does the same. A good first use is a dry run from Actions once Task 16 is done; it should say every step is up to date.

---

### Task 14: A dry run against App Store Connect

No commit. Nothing changes in App Store Connect: `withDryRun` sends GETs only.

**Step 1: Run it**

```bash
corepack pnpm ios:release DRY_RUN=1
```

Expected (on the state of 2026-11-03; the ids are App Store Connect's):

```
▸ Checking the listing in apps/ios/store
  ✓ Text, settings and screenshots are within Apple's limits

▸ Signing in to https://<demo server> as App Review will
  ✓ reviewer signs in to "<server name>" (<version>): a member with no requests, <n> albums

▸ Build <N>: would be archived and uploaded          (or "on App Store Connect" if CI's beta has it)

▸ Comparing the App Store listing of Playarr 1.0.0 (dry run: nothing is changed)
    would PATCH /v1/apps/6830169335 (contentRightsDeclaration)
  Content rights: contentRightsDeclaration
    would PATCH /v1/appStoreVersions/8fb230eb-45ec-4f84-9947-2a5d3c8d54c2 (versionString, copyright)
  App Store version 1.0 → 1.0.0: versionString, copyright
    would PATCH /v1/appStoreVersionLocalizations/7a6d531c-… (description, keywords, promotionalText, supportUrl, marketingUrl)
  Description, keywords and links (en-US): description, keywords, promotionalText, supportUrl, marketingUrl
    would PATCH /v1/appInfoLocalizations/cfd6cce1-… (subtitle, privacyPolicyUrl)
  Name, subtitle and privacy policy (en-US): subtitle, privacyPolicyUrl
    would PATCH /v1/appInfos/582365e2-… (→ primaryCategory)
  Category: MUSIC
    would PATCH /v1/ageRatingDeclarations/582365e2-… (alcoholTobaccoOrDrugUseOrReferences, contests, …)
  Age rating: alcoholTobaccoOrDrugUseOrReferences, contests, …
    would POST /v1/appPriceSchedules (→ app, baseTerritory, manualPrices)
  Price: free
    would POST /v2/appAvailabilities (availableInNewTerritories → app, territoryAvailabilities)
  Availability: all 175 countries and regions
    would POST /v1/appStoreReviewDetails (contactFirstName, …, demoAccountPassword, notes → appStoreVersion)
  App Review information: created
    would POST /v1/appScreenshotSets (screenshotDisplayType → appStoreVersionLocalization)
    would POST /v1/appScreenshots (fileName, fileSize → appScreenshotSet)
    …
  Screenshots iphone-6.9: 5 uploaded, 0 removed, 0 kept
  …
  Build <N> once it's uploaded

▸ Submitting for review
    would POST /v1/reviewSubmissions (platform → app)
    would POST /v1/reviewSubmissionItems (→ reviewSubmission, appStoreVersion)
    would PATCH /v1/reviewSubmissions/dry-run-reviewSubmissions-… (submitted)
  Review submission: submitted

✓ Dry run done: Playarr 1.0.0 (<N>) would be submitted for review.
```

The same steps ran against the live API while this plan was written, from `syncListing` with a fake demo account, and printed exactly these requests.

**Step 2: Check that no secret was printed.** Search the output for the password. Without printing it, count matches only:

```bash
corepack pnpm ios:release DRY_RUN=1 2>&1 | grep -c -F "$(node --env-file=.env -p process.env.REVIEW_PASSWORD)"
```

Expected: `0`.

**Step 3: If it fails**

| Message | What to do |
|---|---|
| `… doesn't answer (EPERM …)` from the sign-in check | Claude's shell can't reach the address (Local Network block, or the domain resolves to a LAN address at home). Ask the user to run `corepack pnpm ios:release DRY_RUN=1` in Terminal and paste the output. |
| `The demo account isn't ready for App Review: …` | Fix the account on the server as the message says (Task 1, item 3). |
| `The listing in apps/ios/store isn't ready: …` | Fix the named files. |
| `Version 1.x is already on the App Store; … would go backwards` | Use `VERSION=` above it. |
| A 400 or 409 for a GET | The API changed. Look up the path in Apple's current OpenAPI spec (`https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip`) and fix `appstore.mjs`, with a test, in a commit of its own. |

---

### Task 15: Checkpoint (user): App Privacy, DSA trader status, the developer name, the pages

No code. These are on App Store Connect's website because the API has none of them. Hand the user these steps and wait.

**1. App Privacy: "Data Not Collected".** App Store Connect → Apps → Playarr → **App Privacy** (left column) → **Get Started**. To "Do you or your third-party partners collect data from this app?" answer **No, we do not collect data from this app** → **Save**. Then **Publish** at the top right. The page also has a "Privacy Policy URL" field, which shows the URL the release sets (`…/privacy.html`). Before the release has run it may be empty: then paste `https://nicolabortignon.github.io/playarr/privacy.html`.

**2. Digital Services Act** (Task 1, item 9): declared, or the user accepts that the EU waits.

**3. The developer name** (Task 1, item 1): the user's choice is recorded. If it's (b), Apple Support's answer can take days, and the user decides whether to wait for it before Task 16. If it's (c), stop this plan here: a new team means new keys, secrets and team id, and the app has to be transferred first.

**4. The pages are live:**

```bash
for page in privacy support; do curl -s -o /dev/null -w "%{http_code} $page\n" https://nicolabortignon.github.io/playarr/$page.html; done
```

Expected: `200 privacy`, `200 support`.

**5. The demo server stays up.** Review takes one to three days and can come at any hour from the US. The user keeps the server up and doesn't change the reviewer's password or folder until the app is approved. An uptime check (a phone on mobile data, or any monitoring service) is a good idea.

---

### Task 16: Release: submit for review

No commit, unless a version bump is asked for (the script commits it itself).

**Step 1: The tree is clean and pushed**

```bash
git status --porcelain | wc -l
git log origin/main..main --oneline | wc -l
```

Expected: `0`, and preferably `0` (if not, ask the user to `git push origin main` first, so CI's beta and this release don't build the same number twice).

**Step 2: Release** (in the background; 15 to 60 minutes)

```bash
corepack pnpm ios:release
```

(For a later version: `corepack pnpm ios:release VERSION=1.1.0`. Write `whats-new.txt` first.) Expected: the tests from `make test`, then:

```
▸ Checking the listing in apps/ios/store
  ✓ Text, settings and screenshots are within Apple's limits

▸ Signing in to https://<demo server> as App Review will
  ✓ reviewer signs in to "<server>" (<version>): a member with no requests, <n> albums
✓ Build <N> is already on App Store Connect: nothing to upload.      (or the archive, export and upload, as for beta)
  <time> VALID

▸ Updating the App Store listing of Playarr 1.0.0
  Content rights: contentRightsDeclaration
  App Store version 1.0 → 1.0.0: versionString, copyright
  Description, keywords and links (en-US): description, keywords, promotionalText, supportUrl, marketingUrl
  Name, subtitle and privacy policy (en-US): subtitle, privacyPolicyUrl
  Category: MUSIC
  Age rating: alcoholTobaccoOrDrugUseOrReferences, …
  Price: free
  Availability: all 175 countries and regions
  App Review information: created
  Screenshots iphone-6.9: 5 uploaded, 0 removed, 0 kept
  Screenshots iphone-6.3: 5 uploaded, 0 removed, 0 kept
  Screenshots ipad-13: 5 uploaded, 0 removed, 0 kept
  Build <N>: chosen for this version

▸ Submitting for review
  Review submission: submitted

✓ Playarr 1.0.0 (<N>) is submitted for review. It goes on the App Store by itself once approved.
```

**Step 3: If a step is refused.** Each step is safe to run again, so fix the cause and rerun `corepack pnpm ios:release`; what's done is skipped.

| Refused | What to do |
|---|---|
| Age rating (409 naming a field) | Add or drop that field in `AGE_RATING` (store.mjs) and `app.json`, with the test, commit, rerun. If it keeps refusing, answer the questionnaire on the website (App Information → Age Rating), then make `app.json` say the same, so the step finds nothing to change. |
| Price schedule or availability (400 about `included` or ids) | The local-id syntax differs. Set them on the website (Pricing and Availability: Free; all countries; "new countries" on) and rerun: both steps skip once something exists. Then fix `freePriceSchedule`/`availability` from Apple's error, with a test. |
| `APP_IPHONE_61` refuses 1206×2622 | `git rm -r apps/ios/store/screenshots/iphone-6.3`, commit, rerun. The 6.9" set covers smaller iPhones by scaling. |
| A screenshot `FAILED` | Apple's message names the reason (size, format). Fix and retake (Task 12), commit, rerun. |
| Submission 409 "App Privacy" | Task 15, item 1, then rerun. |
| Submission 409 naming another missing item (e.g. the copyright, the support URL, a missing screenshot set) | Fix it in `store/`, commit, rerun. |
| `contentRightsDeclaration` or the version rename refused | Do it on the website as the API table says, rerun. |

**Step 4: Check (read-only)**

```bash
node --env-file=.env --input-type=module -e "
import { asc, findApp } from './apps/ios/scripts/asc.mjs';
const app = await findApp(process.env.IOS_BUNDLE_ID);
for (const v of (await asc('GET', '/v1/apps/' + app.id + '/appStoreVersions?filter[platform]=IOS')).data) console.log('version', v.attributes.versionString, v.attributes.appVersionState, v.attributes.releaseType);
for (const s of (await asc('GET', '/v1/reviewSubmissions?filter[app]=' + app.id + '&filter[platform]=IOS')).data) console.log('submission', s.attributes.state, s.attributes.submittedDate ?? '');
"
```

Expected: `version 1.0.0 WAITING_FOR_REVIEW AFTER_APPROVAL` and `submission WAITING_FOR_REVIEW <date>`.

**Step 5: Run it again: nothing changes**

```bash
corepack pnpm ios:release DRY_RUN=1 2>&1 | tail -3
```

Expected: `✓ Playarr 1.0.0 is waiting for review in App Store Connect: nothing to change.`

**Step 6:** Tell the user it's submitted, and to push (`git push origin main`) if the script committed a version bump. App Store Connect emails the account holder at each change of state.

---

### Task 17: Docs: README, the decisions log and the iOS docs

**Files:**
- Modify: `README.md`, `docs/decisions.md`, `docs/ios/release.md`, `docs/ios/conventions.md`

**Step 1: README, "iOS app".** In the command block, after `pnpm ios:device …`, add (if not already there):

```bash
pnpm ios:screenshots # the App Store screenshots, from a local server with the Creative Commons albums
pnpm ios:release     # put MARKETING_VERSION on the App Store and submit it (VERSION=1.1.0 bumps it first; DRY_RUN=1 only shows what would change)
```

and a short paragraph on App Store releases that points to `docs/ios/release.md`.

**Step 2: `docs/decisions.md`.** Add a row:

```markdown
| 2026-11-xx | iOS app on the App Store: `pnpm ios:release` keeps App Store Connect in line with `apps/ios/store/` through the API (text, category, age rating, price, availability, review details, screenshots, build) and submits; released automatically after approval; safe to rerun, with a dry run. Screenshots come from an XCUITest against a local copy of the server with the Creative Commons albums, committed as PNGs. Privacy policy and support page on GitHub Pages. App Privacy: Data Not Collected (set on the website; the API can't). |
```

**Step 3: `docs/ios/release.md` and `docs/ios/conventions.md`** (skip what's already there):
- the release section: the pages in `store/site/` and their Pages workflow, the committed screenshots in `store/screenshots/<iphone-6.9|iphone-6.3|ipad-13>/`, the CI release job (Run workflow, a dry run by default) and its seven `REVIEW_*` secrets;
- Apple identifiers: App Store category Music, release after approval, privacy policy `https://nicolabortignon.github.io/playarr/privacy.html`;
- the screens the screenshot test drives keep stable accessibility identifiers (`MiniPlayer`, the tab names, "Lyrics"); renaming one means updating `StoreScreenshots.swift`.

**Step 4: Check**

```bash
grep -c 'ios:release' README.md docs/ios/release.md docs/ios/conventions.md
```

Expected: at least 1 in each.

**Step 5: Commit**

```bash
git add README.md docs/decisions.md docs/ios/release.md docs/ios/conventions.md
git commit -m "$(cat <<'EOF'
Docs: App Store releases of the iOS app, its listing in apps/ios/store and its screenshots

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---


### Task 18: Checkpoint (user): Apple's answer

No code. App Review answers by email to the account holder and in App Store Connect.

- **Approved**: with `AFTER_APPROVAL`, the version goes `PENDING_DEVELOPER_RELEASE` → `PROCESSING_FOR_DISTRIBUTION` → `READY_FOR_DISTRIBUTION` (on sale) by itself, within about a day. Check with Task 16, Step 4: `version 1.0.0 READY_FOR_DISTRIBUTION`. Then search the App Store for "Playarr" on a phone.
- **Rejected**: the version is `REJECTED` (or `METADATA_REJECTED`) and the submission `UNRESOLVED_ISSUES`. Read Apple's message in App Store Connect → the version → App Review (Resolution Center), and answer by guideline:

| Guideline in the message | Answer |
|---|---|
| 2.1 (couldn't sign in, server down) | Check the server and the reviewer account (`corepack pnpm ios:release DRY_RUN=1` signs in). Reply in Resolution Center when it works again; no new build needed. |
| 2.3.1 (requests or admin features) | Reply with the explanation from the review notes, and attach a short screen recording of requests on an account that may request (a test server). |
| 5.2.3 (requests and downloading) | This is the user's decision (see the risk notes): explain that requests add to the owner's own library manager and that the app downloads nothing from third-party services, or hide requests in App Store builds (a design change: write it up before doing it). |
| 5.1.1(v) (account deletion) | Explain that accounts belong to the user's own server, that admins delete them in Settings → Accounts, and that the developer runs no account service. |
| 4.2, 2.3.x (metadata, screenshots) | Change `store/`, commit, and run `corepack pnpm ios:release` again. It updates what changed and resubmits the same version. |
| A bug in the app | Fix it, commit (a new build number), and run `corepack pnpm ios:release`. It uploads the new build, chooses it for the version, and resubmits. |

---

## Not in this phase

- **Other languages**: en-US only. `readStore(dir, locale)` takes a locale, so another language is a folder, plus a loop in `syncListing` later.
- **App previews (video)**, custom product pages, phased release, pre-orders, in-app events.
- **iPhone Duo screenshots**: Apple requires them from April 2027 for apps built with the iOS 27.1 SDK or later. This Mac has Xcode 27.2, and the runner Xcode 26.6. Add a set (and its display type, once the API lists one; spec 4.5.1 has none) before an April 2027 release built with Xcode 27.
- **Accessibility Nutrition Labels**: the API has them (`accessibilityDeclarations`: VoiceOver, Voice Control, larger text, dark interface, reduced motion, sufficient contrast, differentiate without colour, captions, audio descriptions). They are optional today. Once phase 10's accessibility work is checked, they could be declared from `app.json` in the same way as the age rating.
- **Mac and CarPlay**: later, per the design.

## Uncertainties

These are assumptions about Apple's behaviour that couldn't be tried without changing things in App Store Connect. Each has a fallback in the task it belongs to (Task 16, Step 3), and the API table above lists them all.

1. **Renaming "1.0" to "1.0.0"** through `versionString` while the version is `PREPARE_FOR_SUBMISSION`. If refused, rename it on the website.
2. **Inline creates with local ids** (`${free}`, `${GBR}`) for the price schedule and availability, and 175 territories in one request.
3. **The age rating fields**: whether the newest questions are writable yet, and whether `socialMediaAgeRestricted` or `kidsAgeBand` must be sent.
4. **`whatsNew` on a first version**: believed refused, so it's left out. If App Store Connect requires it, `firstRelease` is the line to change.
5. **`APP_IPHONE_61` accepting 1206×2622**, and whether Apple really requires the medium-display set (the page's wording conflicts with its own scaling notes).
6. **Resubmitting after a rejection**: reusing the `UNRESOLVED_ISSUES` submission and PATCHing `submitted: true`. If refused, use "Resubmit to App Review" on the website.
7. **Screenshots in the simulator**: XCUITest's PNGs carry alpha, which is removed. The iPad status bar's date follows `--time` only when it's ISO 8601, as `simctl` says. Whether `XCUIScreen.main.screenshot()` on an iPad turned to landscape gives an upright landscape image wasn't tried; Task 12 has the fix if it doesn't.
8. **Folder albums offline**: they're believed listed from their tags while MusicBrainz is unreachable. Task 12 has the way out if not.
9. **Claude's shell and the demo server**: a public HTTPS address should be reachable. If the domain resolves to a LAN address at home, the user runs the release in Terminal.
