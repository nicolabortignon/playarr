# Native iOS app, Phase 11: App Store Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Playarr is submitted for App Store review, and it goes on sale by itself once Apple approves it. `pnpm ios:release` does the whole thing from the repo. It checks the listing in `apps/ios/store/` and signs in to the demo server the way App Review will. It uploads the build the way `ios:beta` does, brings App Store Connect in line with the listing (text, category, age rating, price, availability, review details, screenshots, build), and submits. Running it again changes nothing, and `DRY_RUN=1` prints what it would change. `make screenshots` takes reproducible screenshots on the iPhone 17 Pro Max and iPad Pro 13-inch simulators. The privacy policy and support pages are on GitHub Pages.

**Architecture:** There are four new Node modules with no dependencies next to `asc.mjs`. `store.mjs` is pure: it reads and checks the listing (Apple's length limits, URLs, age rating answers, screenshot sizes and transparency), works out diffs and versions, plans screenshot uploads and builds request bodies. `appstore.mjs` has the App Store Connect steps (`syncListing`, `submitForReview`) and works on an injected `api`. In `release.mjs` that `api` is `asc.mjs` over HTTP. In a dry run, `withDryRun` wraps it so writes are logged instead of sent. In the tests it's an in-memory fake. `release.mjs` gains `release` and `check-store`; `beta()`'s upload half becomes `uploadBuild()`, which both use. `screenshots.mjs` starts the repo's own server on port 4610 with an empty data folder and a local copy of the Creative Commons albums. It seeds a listener account with two weeks of plays. Then, on simulators of its own, it fixes the status bar at 9:41 and runs the `StoreScreenshots` XCUITest. Finally it exports the attachments from the result bundle with `xcresulttool` and removes their alpha channel with `flatten-png.swift`. A `workflow_dispatch` job runs the release from CI, and a Pages workflow publishes `apps/ios/store/site/`.

**Tech Stack:** Node 24+ (`node:test`, `fetch`, `node:crypto`), App Store Connect API 4.5.1 (Apple's OpenAPI spec, downloaded 2026-11-03), XCUITest (Swift 6), `xcrun simctl`, `xcrun xcresulttool export attachments`, CoreGraphics (the flatten script), GNU Make 3.81, GitHub Actions (`macos-26` with Xcode 26.6; `actions/configure-pages@v6`, `upload-pages-artifact@v5`, `deploy-pages@v5`, the newest majors on 2026-11-03). pnpm through `corepack pnpm`.

**Design:** [2026-11-03-ios-app-design.md](2026-11-03-ios-app-design.md), section 5 ("Signing and releasing", `pnpm ios:release`) and the App Review row of Decisions: a reviewer account on the owner's server that sees only a Creative Commons folder, with no requests and no admin rights. Requests stay in every build, gated by the server and the account. Names and commands come from [2026-11-03-ios-conventions.md](2026-11-03-ios-conventions.md). The pipeline this builds on is [phase 0](2026-11-03-ios-phase0-pipeline.md): `asc.mjs`, `release.mjs`, the unsigned archive, cloud-signed export, altool upload, the Makefile and `.github/workflows/ios.yml`.

---

## Where things stand (checked read-only on 2026-11-03)

Only GET requests were made to App Store Connect while writing this plan. The `syncListing` and `submitForReview` code below was also run against the live API in dry-run mode: every read succeeded, and every write was only printed.

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

0. Starting point (read-only)
1. **Checkpoint (user)**: decisions, the public address, the demo account, contact details, the Creative Commons folder
2. The store text and settings, checked against Apple's limits
3. Privacy policy and support pages on GitHub Pages
4. Screenshot sets: sizes, transparency, names
5. The pieces of a sync: diffs, versions, screenshot plans, request bodies
6. `asc.mjs`: GETs that may find nothing, and what a refused submission says
7. `appstore.mjs`: App Store Connect in line with the listing, then submit
8. `release.mjs`: the `release` and `check-store` commands
9. Makefile, pnpm scripts and `.env.example`
10. The `StoreScreenshots` UI test and the flatten script
11. `screenshots.mjs`: a local server, simulators of their own, the screenshots out of the result bundle
12. Take the screenshots (**Checkpoint (user)**: look at them)
13. CI: a release you start by hand (**Checkpoint (user)**: the secrets)
14. A dry run against App Store Connect
15. **Checkpoint (user)**: App Privacy, DSA trader status, the developer name, the pages
16. Release: submit for review
17. Docs: README, PLAN.md and the conventions
18. **Checkpoint (user)**: Apple's answer

---

### Task 0: Starting point (read-only)

No changes and no commit.

**Step 1: Phases 0 to 10 are in**

```bash
ls docs/plans/2026-11-03-ios-phase*.md
ls apps/ios/PlayarrUITests apps/ios/scripts
grep -c '' apps/ios/scripts/release.mjs apps/ios/Makefile
git log --oneline -15 -- apps/ios
```

Expected: plans for phases 0 to 11 and commits from phases 4 to 10 (screens, DJ transitions, downloads, settings, iPad). `apps/ios/scripts` has `asc.mjs`, `release.mjs`, `gen-models.mjs` and their tests. If phase 10's iPad layout isn't in yet, stop: the iPad screenshots must show it.

**Step 2: The names the screenshot test relies on**

```bash
grep -rn --include=*.swift -E 'accessibilityIdentifier\("MiniPlayer"\)|"Jump back in"|"Lyrics"|Tab\("Library"|"Server address"|"Sign in"' apps/ios/Packages apps/ios/PlayarrUITests | head -30
```

Expected: each of the six shows up. The mini player has `.accessibilityIdentifier("MiniPlayer")`, Home has a "Jump back in" heading, Now Playing a "Lyrics" button, the tab bar a "Library" tab, and the sign-in screens the "Server address" field and "Sign in" button from phase 2. Note any that are missing or named differently: Task 10 uses them (lines marked `// UI:`).

**Step 3: The script tests pass, and the key works**

```bash
make -C apps/ios test-scripts 2>&1 | grep -E 'ℹ (pass|fail)'
node --env-file=.env apps/ios/scripts/asc.mjs check
```

Expected: `ℹ fail 0`, and four `✓` lines (key, bundle id, app record "Playarr" (6830169335), group "Household").

**Step 4: The simulators exist**

```bash
xcrun simctl list devicetypes | grep -E 'iPhone 17 Pro Max|iPhone 17 Pro \(|iPad Pro 13-inch \(M5\)'
```

Expected: the three device types. `screenshots.mjs` creates its own simulators from them.

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

**3. The demo account.** It is phase 1, Task 24: the user creates `reviewer` (member, "Can request albums" off, library "Only these sources" → Creative Commons) and chooses its password through the setup link. If the user hasn't done it yet, hand them that task's steps 3 to 6 and wait.

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

### Task 2: The store text and settings, checked against Apple's limits

**Files:**
- Create: `apps/ios/store/en-US/name.txt`, `subtitle.txt`, `description.txt`, `keywords.txt`, `promotional-text.txt`, `whats-new.txt`, `support-url.txt`, `marketing-url.txt`, `privacy-policy-url.txt`, `review-notes.txt`
- Create: `apps/ios/store/app.json`
- Create: `apps/ios/scripts/store.mjs`
- Test: `apps/ios/scripts/store.test.mjs`

These are first drafts. They are honest: every feature named exists after phases 4 to 10, and the text says plainly that a Playarr server is needed. Lidarr appears in the description (a fact about compatibility), not in the keywords (guideline 2.3.7).

**Step 1: Write the failing test**

`apps/ios/scripts/store.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fillNotes, readStore, validateStore } from './store.mjs';

const listing = () => {
  const store = readStore();
  return { ...store, text: { ...store.text }, app: structuredClone(store.app) };
};

test('the listing in apps/ios/store is within Apple’s limits', () => {
  assert.deepEqual(validateStore(readStore()), []);
});

test('validateStore names what is too long, not https, badly spaced or left as a placeholder', () => {
  const store = listing();
  store.text.name = 'Playarr: the music player for your own server';
  store.text.supportUrl = 'http://example.com/support';
  store.text.keywords = 'music, flac,music';
  store.text.description = 'Contact {{SUPPORT_EMAIL}}';
  delete store.app.ageRating.lootBox;
  store.app.ageRating.profanityOrCrudeHumor = 'SOMETIMES';
  assert.deepEqual(validateStore(store), [
    'name.txt has 45 characters; Apple allows 30',
    'description.txt still has {{SUPPORT_EMAIL}}',
    'support-url.txt must be one https:// address',
    'keywords.txt: no spaces around the commas (they count against the 100)',
    'keywords.txt repeats a keyword',
    'app.json: ageRating.profanityOrCrudeHumor must be one of NONE, INFREQUENT_OR_MILD, FREQUENT_OR_INTENSE',
    'app.json: ageRating.lootBox must be true or false',
  ]);
});

test('validateStore wants the required files and allows only the review placeholders in the notes', () => {
  const store = listing();
  store.text.description = null;
  store.text.notes = 'Server: {{REVIEW_SERVER_URL}}, user {{REVIEW_USERNAME}}, password {{REVIEW_PASSWORD}}';
  assert.deepEqual(validateStore(store), ['description.txt is missing or empty', 'review-notes.txt still has {{REVIEW_PASSWORD}}']);
});

test('fillNotes puts in the server and username, and names what is unset', () => {
  const template = 'Address: {{REVIEW_SERVER_URL}}\nUsername: {{REVIEW_USERNAME}}';
  assert.equal(fillNotes(template, { REVIEW_SERVER_URL: 'https://music.example.com', REVIEW_USERNAME: 'reviewer' }), 'Address: https://music.example.com\nUsername: reviewer');
  assert.throws(() => fillNotes(template, { REVIEW_USERNAME: 'reviewer' }), /Set REVIEW_SERVER_URL/);
});
```

**Step 2: Run it to see it fail**

```bash
node --test apps/ios/scripts/store.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` (Cannot find module …/apps/ios/scripts/store.mjs).

**Step 3: Write the text**

`apps/ios/store/en-US/name.txt`:

```
Playarr
```

`apps/ios/store/en-US/subtitle.txt`:

```
Music from your own server
```

`apps/ios/store/en-US/keywords.txt` (93 characters of 100; commas with no spaces, since spaces count):

```
self-hosted,music player,home server,flac,gapless,lyrics,dj mix,crossfade,offline,nas,library
```

`apps/ios/store/en-US/promotional-text.txt` (139 of 170):

```
Your own music, from your own server: gapless, at an even volume, mixed like a DJ if you like, and kept on the phone for listening offline.
```

`apps/ios/store/en-US/whats-new.txt` (not sent for the first version; replace it before each later release):

```
Playarr for iPhone and iPad.
```

`apps/ios/store/en-US/support-url.txt`:

```
https://nicolabortignon.github.io/playarr/support.html
```

`apps/ios/store/en-US/marketing-url.txt`:

```
https://github.com/nicolabortignon/playarr
```

`apps/ios/store/en-US/privacy-policy-url.txt`:

```
https://nicolabortignon.github.io/playarr/privacy.html
```

`apps/ios/store/en-US/description.txt` (1,793 of 4,000):

```
Playarr plays the music on your own server: the albums you own, kept on your computer or NAS, wherever you are.

Playarr is a free, open-source music server that you run yourself, at home or on a machine you rent. It reads the music folders you give it and, if you use Lidarr, the library Lidarr manages. This app is its player for iPhone and iPad. You need a Playarr server to use it: set one up from github.com/nicolabortignon/playarr, or ask someone who runs one for an account.

LISTEN
• Gapless albums, played from each song's own file (FLAC or MP3)
• Even volume: every song at the same loudness, quiet ones turned up as well as loud ones down
• Crossfade, or DJ mix: songs blend into each other on the beat, prepared by your server
• Synced lyrics, a sleep timer, and radio that keeps playing similar songs from your library when the queue ends
• Controls on the Lock Screen and in Control Center, AirPlay and Bluetooth

YOUR LIBRARY
• Home, with Jump back in and mixes made from what you listen to
• Search, artists, albums, favorites and playlists
• Your listening: top artists, songs and albums
• Downloads: keep albums, playlists and mixes on the device and listen with no connection
• On iPad, a sidebar, with the queue and lyrics beside what you browse

YOUR SERVER, YOUR ACCOUNTS
• Finds Playarr servers on your home network, or connects to yours over HTTPS from anywhere
• One server, many people: each has their own account, history, favorites and playlists
• Switch between accounts and servers with one tap
• The server's owner manages sources, accounts and settings from the app
• Where the server's owner allows it, ask for an album to be added to the server's Lidarr library

NOTHING ELSE
Playarr talks only to the servers you add. No ads, no tracking, no account with us.
```

`apps/ios/store/en-US/review-notes.txt` (about 1,900 of 4,000 once filled in; `{{REVIEW_SERVER_URL}}` and `{{REVIEW_USERNAME}}` are filled in at release time, and the password is never in the notes):

```
Playarr is the player for Playarr, a free, open-source music server that people run themselves (https://github.com/nicolabortignon/playarr). The app has no music of its own and no sign-up: you connect to a server and sign in with an account its owner created.

HOW TO SIGN IN
1. Open Playarr. On "Add a server", type this address in "Server address" and tap Connect:
   {{REVIEW_SERVER_URL}}
2. On "Sign in to …", use the demo account in the Sign-In Information fields (username {{REVIEW_USERNAME}}).

THE DEMO ACCOUNT
It is on the developer's own Playarr server. It sees only a folder of Creative Commons albums (CC BY), so everything it plays may be shared. It is a regular member: no admin settings and no requests.

WHAT TO TRY
- Library: open an album and play it (gapless, at an even volume).
- Tap the mini player for Now Playing: lyrics where the song has them, the sleep timer, the queue.
- Settings → Playback: crossfade or DJ mix.
- Long-press an album: Download, then turn on Airplane Mode and play it.
- Lock the device: the Lock Screen controls keep working.

FEATURES THE DEMO ACCOUNT DOESN'T SEE
- Admin settings (sources, accounts, analysis, updates) appear only for a server's owner and the admins they name.
- Requests: a server's owner can connect it to Lidarr, their own library manager, and let chosen accounts ask for an album to be added to that library. The owner turns this on for the server and for each account; the demo account can't request, so no request buttons appear. The app only sends the request to the user's own server; it doesn't download, sell or stream music from any other service.

PRIVACY
The app sends data only to the servers the user adds (sign-in, what is played, favorites and playlists). The developer receives nothing; there are no analytics or ads.

The local network permission is used to find Playarr servers at home (Bonjour).
```

Then make "WHAT TO TRY" match the app as built. Open the views from phases 4 to 10 and check each path: the mini player and Now Playing, Settings → Playback, how an album is downloaded (its menu → Download, or a button), and Library → Downloads. Change the wording where the app differs. Keep the web's words (conventions, "User-facing text").

`apps/ios/store/app.json`:

```json
{
  "copyright": "2026 W1T LTD",
  "primaryCategory": "MUSIC",
  "contentRights": "USES_THIRD_PARTY_CONTENT",
  "releaseType": "AFTER_APPROVAL",
  "price": "free",
  "availableInNewTerritories": true,
  "ageRating": {
    "alcoholTobaccoOrDrugUseOrReferences": "NONE",
    "contests": "NONE",
    "gamblingSimulated": "NONE",
    "gunsOrOtherWeapons": "NONE",
    "horrorOrFearThemes": "NONE",
    "matureOrSuggestiveThemes": "NONE",
    "medicalOrTreatmentInformation": "NONE",
    "profanityOrCrudeHumor": "INFREQUENT_OR_MILD",
    "sexualContentGraphicAndNudity": "NONE",
    "sexualContentOrNudity": "NONE",
    "violenceCartoonOrFantasy": "NONE",
    "violenceRealistic": "NONE",
    "violenceRealisticProlongedGraphicOrSadistic": "NONE",
    "advertising": false,
    "ageAssurance": false,
    "gambling": false,
    "healthOrWellnessTopics": false,
    "lootBox": false,
    "messagingAndChat": false,
    "parentalControls": false,
    "socialMedia": false,
    "unrestrictedWebAccess": false,
    "userGeneratedContent": false
  }
}
```

If the user chose a different age rating or content rights answer in Task 1, change it here (and the copyright line if the developer name decision changes the company name).

**Step 4: Write `store.mjs`**

`apps/ios/scripts/store.mjs`:

```js
// The App Store listing of the iOS app, offline: the text in store/en-US, the settings in store/app.json and
// the screenshots in store/screenshots, read and checked against Apple's limits. Also the pure pieces that
// release.mjs needs to bring App Store Connect in line with them: what changed, which version to edit, which
// screenshots to upload, and the request bodies. Nothing here talks to Apple; appstore.mjs does.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STORE = fileURLToPath(new URL('../store', import.meta.url));
export const LOCALE = 'en-US';

/** Each text file in store/en-US: the App Store Connect attribute it fills, where that lives, and Apple's limit. */
export const FIELDS = [
  { file: 'name.txt', key: 'name', on: 'appInfoLocalization', max: 30, required: true },
  { file: 'subtitle.txt', key: 'subtitle', on: 'appInfoLocalization', max: 30 },
  { file: 'privacy-policy-url.txt', key: 'privacyPolicyUrl', on: 'appInfoLocalization', url: true, required: true },
  { file: 'description.txt', key: 'description', on: 'versionLocalization', max: 4000, required: true },
  { file: 'keywords.txt', key: 'keywords', on: 'versionLocalization', max: 100, required: true },
  { file: 'promotional-text.txt', key: 'promotionalText', on: 'versionLocalization', max: 170 },
  { file: 'whats-new.txt', key: 'whatsNew', on: 'versionLocalization', max: 4000 },
  { file: 'support-url.txt', key: 'supportUrl', on: 'versionLocalization', url: true, required: true },
  { file: 'marketing-url.txt', key: 'marketingUrl', on: 'versionLocalization', url: true },
  { file: 'review-notes.txt', key: 'notes', on: 'reviewDetail', max: 4000, required: true },
];

/** The only placeholders review-notes.txt may use; release.mjs fills them from the environment. */
export const NOTE_PLACEHOLDERS = ['REVIEW_SERVER_URL', 'REVIEW_USERNAME'];

/** The age rating questionnaire as the API has it (ageRatingDeclarations, API 4.5.1): every one is answered. */
export const AGE_RATING = {
  levels: [
    'alcoholTobaccoOrDrugUseOrReferences', 'contests', 'gamblingSimulated', 'gunsOrOtherWeapons', 'horrorOrFearThemes',
    'matureOrSuggestiveThemes', 'medicalOrTreatmentInformation', 'profanityOrCrudeHumor', 'sexualContentGraphicAndNudity',
    'sexualContentOrNudity', 'violenceCartoonOrFantasy', 'violenceRealistic', 'violenceRealisticProlongedGraphicOrSadistic',
  ],
  booleans: [
    'advertising', 'ageAssurance', 'gambling', 'healthOrWellnessTopics', 'lootBox', 'messagingAndChat', 'parentalControls',
    'socialMedia', 'unrestrictedWebAccess', 'userGeneratedContent',
  ],
  values: ['NONE', 'INFREQUENT_OR_MILD', 'FREQUENT_OR_INTENSE'],
};

export const CONTENT_RIGHTS = ['DOES_NOT_USE_THIRD_PARTY_CONTENT', 'USES_THIRD_PARTY_CONTENT'];
export const RELEASE_TYPES = ['AFTER_APPROVAL', 'MANUAL'];

/** The listing: text by attribute (null when a file is missing or empty) and app.json. */
export function readStore(dir = STORE, locale = LOCALE) {
  const text = {};
  for (const { file, key } of FIELDS) {
    const path = join(dir, locale, file);
    const value = existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trim() : '';
    text[key] = value || null;
  }
  const appPath = join(dir, 'app.json');
  const app = existsSync(appPath) ? JSON.parse(readFileSync(appPath, 'utf8')) : null;
  return { locale, text, app };
}

const length = (s) => [...s].length;

/** Everything wrong with the listing, as sentences; empty when it can be sent. */
export function validateStore({ text, app }) {
  const problems = [];
  for (const { file, key, max, url, required } of FIELDS) {
    const value = text[key];
    if (value == null) {
      if (required) problems.push(`${file} is missing or empty`);
      continue;
    }
    if (max && length(value) > max) problems.push(`${file} has ${length(value)} characters; Apple allows ${max}`);
    if (url && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(value)) problems.push(`${file} must be one https:// address`);
    const placeholders = [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    const allowed = key === 'notes' ? NOTE_PLACEHOLDERS : [];
    for (const name of placeholders.filter((p) => !allowed.includes(p))) problems.push(`${file} still has {{${name}}}`);
  }
  if (text.keywords != null) {
    const words = text.keywords.split(',');
    if (words.some((w) => w !== w.trim())) problems.push('keywords.txt: no spaces around the commas (they count against the 100)');
    if (words.some((w) => !w.trim())) problems.push('keywords.txt has an empty keyword');
    const lower = words.map((w) => w.trim().toLowerCase());
    if (new Set(lower).size !== lower.length) problems.push('keywords.txt repeats a keyword');
    if (text.name && lower.includes(text.name.toLowerCase())) problems.push('keywords.txt repeats the app name, which is searched anyway');
  }
  if (!app) return [...problems, 'app.json is missing'];
  if (!app.copyright?.trim()) problems.push('app.json: copyright is missing');
  if (app.primaryCategory !== 'MUSIC') problems.push('app.json: primaryCategory should be MUSIC');
  if (!CONTENT_RIGHTS.includes(app.contentRights)) problems.push(`app.json: contentRights must be one of ${CONTENT_RIGHTS.join(', ')}`);
  if (!RELEASE_TYPES.includes(app.releaseType)) problems.push(`app.json: releaseType must be one of ${RELEASE_TYPES.join(', ')}`);
  if (app.price !== 'free') problems.push('app.json: price must be "free" (release.mjs sets no other price)');
  if (typeof app.availableInNewTerritories !== 'boolean') problems.push('app.json: availableInNewTerritories must be true or false');
  const rating = app.ageRating ?? {};
  for (const key of AGE_RATING.levels) {
    if (!AGE_RATING.values.includes(rating[key])) problems.push(`app.json: ageRating.${key} must be one of ${AGE_RATING.values.join(', ')}`);
  }
  for (const key of AGE_RATING.booleans) {
    if (typeof rating[key] !== 'boolean') problems.push(`app.json: ageRating.${key} must be true or false`);
  }
  const known = new Set([...AGE_RATING.levels, ...AGE_RATING.booleans]);
  for (const key of Object.keys(rating).filter((k) => !known.has(k))) problems.push(`app.json: ageRating.${key} isn't a question App Store Connect asks`);
  return problems;
}

/** review-notes.txt with {{REVIEW_SERVER_URL}} and {{REVIEW_USERNAME}} filled in; throws naming what's unset. */
export function fillNotes(template, env) {
  const missing = NOTE_PLACEHOLDERS.filter((name) => template.includes(`{{${name}}}`) && !env[name]);
  if (missing.length) throw new Error(`Set ${missing.join(', ')} (in .env, or the GitHub secrets in CI)`);
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => env[name]);
}
```

**Step 5: Run the tests again**

```bash
node --test apps/ios/scripts/store.test.mjs 2>&1 | grep -E 'ℹ (pass|fail)'
```

Expected: `ℹ pass 4`, `ℹ fail 0`.

**Step 6: Commit**

```bash
git add apps/ios/store/en-US apps/ios/store/app.json apps/ios/scripts/store.mjs apps/ios/scripts/store.test.mjs
git commit -m "$(cat <<'EOF'
iOS app: App Store text, review notes and settings in apps/ios/store, checked against Apple's limits

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

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

### Task 4: Screenshot sets: sizes, transparency, names

**Files:**
- Modify: `apps/ios/scripts/store.mjs`, `apps/ios/scripts/store.test.mjs`

**Step 1: Write the failing test.** Replace the import lines of `store.test.mjs` with:

```js
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fillNotes, md5, pngInfo, readScreenshots, readStore, STORE, validateScreenshots, validateStore } from './store.mjs';
```

and append:

```js
/** A PNG header that pngInfo can read (the pixels and CRCs don't matter to it). */
function png(width, height, { colorType = 2, trns = false } = {}) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(trns ? [chunk('tRNS', Buffer.alloc(6))] : []),
    chunk('IDAT', Buffer.alloc(4)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('pngInfo reads the size and sees transparency', () => {
  assert.deepEqual(pngInfo(png(1320, 2868)), { width: 1320, height: 2868, alpha: false });
  assert.equal(pngInfo(png(10, 10, { colorType: 6 })).alpha, true);
  assert.equal(pngInfo(png(10, 10, { trns: true })).alpha, true);
  assert.throws(() => pngInfo(Buffer.from('GIF89a…')), /not a PNG/);
});

test('readScreenshots and validateScreenshots: sizes per display type, landscape, transparency, names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'playarr-shots-'));
  mkdirSync(join(dir, 'iphone-6.9'));
  mkdirSync(join(dir, 'ipad-13'));
  writeFileSync(join(dir, 'iphone-6.9', '01-home.png'), png(1320, 2868));
  writeFileSync(join(dir, 'iphone-6.9', '02-album.png'), png(1290, 2796, { colorType: 6 }));
  writeFileSync(join(dir, 'iphone-6.9', 'Now Playing.png'), png(1179, 2556));
  writeFileSync(join(dir, 'ipad-13', '01-home.png'), png(2752, 2064));
  const sets = readScreenshots(dir);
  assert.deepEqual(sets.map((s) => [s.folder, s.displayType, s.files.map((f) => f.name)]), [
    ['iphone-6.9', 'APP_IPHONE_67', ['01-home.png', '02-album.png', 'Now Playing.png']],
    ['ipad-13', 'APP_IPAD_PRO_3GEN_129', ['01-home.png']],
  ]);
  assert.equal(sets[0].files[0].md5, md5(png(1320, 2868)));
  assert.deepEqual(validateScreenshots(sets), [
    'screenshots/iphone-6.9/02-album.png has transparency, which App Store Connect refuses (scripts/flatten-png.swift removes it)',
    'screenshots/iphone-6.9/Now Playing.png: name it NN-what-it-shows.png',
    'screenshots/iphone-6.9/Now Playing.png is 1179×2556; APP_IPHONE_67 takes 1320×2868, 1290×2796, 1260×2736 (or turned)',
  ]);
  assert.deepEqual(validateScreenshots(sets.slice(0, 1)).at(0), 'screenshots/ipad-13 has no screenshots (make screenshots takes them on the iPad Pro 13-inch (M5) simulator)');
});
```

**Step 2: Run it to see it fail**

```bash
node --test apps/ios/scripts/store.test.mjs 2>&1 | grep -E 'SyntaxError|ℹ (pass|fail)'
```

Expected: `SyntaxError: The requested module './store.mjs' does not provide an export named 'md5'`.

**Step 3: Add the code.** In `store.mjs`, replace

```js
import { existsSync, readFileSync } from 'node:fs';
```

with

```js
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
```

and append:

```js
/**
 * Screenshot folders → App Store Connect display types and the sizes Apple accepts (portrait; landscape is the
 * same sizes turned). iPhone 6.9" ("Dynamic Island, large display") and iPad 13" are what the App Store needs;
 * the 6.3" set is optional, sent when its folder exists.
 */
export const SCREENSHOT_SETS = {
  'iphone-6.9': { displayType: 'APP_IPHONE_67', simulator: 'iPhone 17 Pro Max', required: true, sizes: [[1320, 2868], [1290, 2796], [1260, 2736]] },
  'iphone-6.3': { displayType: 'APP_IPHONE_61', simulator: 'iPhone 17 Pro', required: false, sizes: [[1206, 2622], [1179, 2556]] },
  'ipad-13': { displayType: 'APP_IPAD_PRO_3GEN_129', simulator: 'iPad Pro 13-inch (M5)', required: true, sizes: [[2064, 2752], [2048, 2732]] },
};
export const MAX_SCREENSHOTS = 10;

/** Width, height and whether a PNG has transparency (an alpha channel or a tRNS chunk). Throws for non-PNGs. */
export function pngInfo(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature) || buffer.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const colorType = buffer[25];
  let alpha = colorType === 4 || colorType === 6;
  for (let at = 8; at + 8 <= buffer.length; ) {
    const size = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    if (type === 'tRNS') alpha = true;
    if (type === 'IDAT' || type === 'IEND') break;
    at += 12 + size;
  }
  return { width, height, alpha };
}

export const md5 = (buffer) => createHash('md5').update(buffer).digest('hex');

/** The screenshot folders that exist, each with its PNGs in file-name order. */
export function readScreenshots(dir = join(STORE, 'screenshots')) {
  const sets = [];
  for (const [folder, spec] of Object.entries(SCREENSHOT_SETS)) {
    const path = join(dir, folder);
    if (!existsSync(path)) continue;
    const files = readdirSync(path)
      .filter((name) => name.endsWith('.png'))
      .sort()
      .map((name) => {
        const buffer = readFileSync(join(path, name));
        let info;
        try {
          info = pngInfo(buffer);
        } catch {
          info = { width: 0, height: 0, alpha: false, broken: true };
        }
        return { name, path: join(path, name), size: buffer.length, md5: md5(buffer), ...info };
      });
    sets.push({ folder, ...spec, files });
  }
  return sets;
}

/** Everything wrong with the screenshots, as sentences. */
export function validateScreenshots(sets) {
  const problems = [];
  for (const [folder, spec] of Object.entries(SCREENSHOT_SETS)) {
    if (spec.required && !sets.some((s) => s.folder === folder && s.files.length)) {
      problems.push(`screenshots/${folder} has no screenshots (make screenshots takes them on the ${spec.simulator} simulator)`);
    }
  }
  for (const set of sets) {
    if (set.files.length > MAX_SCREENSHOTS) problems.push(`screenshots/${set.folder} has ${set.files.length} screenshots; Apple takes ${MAX_SCREENSHOTS}`);
    for (const file of set.files) {
      const where = `screenshots/${set.folder}/${file.name}`;
      if (!/^\d\d-[a-z0-9-]+\.png$/.test(file.name)) problems.push(`${where}: name it NN-what-it-shows.png`);
      if (file.broken) {
        problems.push(`${where} isn't a PNG`);
        continue;
      }
      const fits = set.sizes.some(([w, h]) => (file.width === w && file.height === h) || (file.width === h && file.height === w));
      if (!fits) problems.push(`${where} is ${file.width}×${file.height}; ${set.displayType} takes ${set.sizes.map(([w, h]) => `${w}×${h}`).join(', ')} (or turned)`);
      if (file.alpha) problems.push(`${where} has transparency, which App Store Connect refuses (scripts/flatten-png.swift removes it)`);
    }
  }
  return problems;
}
```

**Step 4: Run the tests again**

```bash
node --test apps/ios/scripts/store.test.mjs 2>&1 | grep -E 'ℹ (pass|fail)'
```

Expected: `ℹ pass 7`, `ℹ fail 0`.

**Step 5: Commit**

```bash
git add apps/ios/scripts/store.mjs apps/ios/scripts/store.test.mjs
git commit -m "$(cat <<'EOF'
iOS app: App Store screenshot sets for iPhone 6.9", 6.3" and iPad 13", checked for size, transparency and names

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The pieces of a sync: diffs, versions, screenshot plans, request bodies

**Files:**
- Modify: `apps/ios/scripts/store.mjs`, `apps/ios/scripts/store.test.mjs`

**Step 1: Write the failing test.** Replace the import lines of `store.test.mjs` with:

```js
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  availability, changes, compareVersions, editableAppInfo, fillNotes, freePriceSchedule, md5, pickSubmission, pickVersion,
  pngInfo, readScreenshots, readStore, reviewDetailAttributes, screenshotPlan, STORE, uploadParts, validateScreenshots, validateStore,
} from './store.mjs';
```

and append:

```js
test('changes reports only real differences', () => {
  const current = { description: 'Plays music.\n', keywords: null, supportUrl: 'https://a.example', whatsNew: '' };
  assert.deepEqual(changes(current, { description: 'Plays music.', keywords: 'flac', supportUrl: 'https://a.example', whatsNew: null, promotionalText: null }), { keywords: 'flac' });
  assert.deepEqual(changes(null, { name: 'Playarr' }), { name: 'Playarr' });
  assert.deepEqual(changes({ demoAccountRequired: true }, { demoAccountRequired: true }), {});
});

const version = (versionString, state, id = versionString) => ({ id, attributes: { versionString, appVersionState: state, appStoreState: state } });

test('compareVersions compares numbers, not text', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
});

test('pickVersion uses, renames, creates, or leaves alone a version in review', () => {
  assert.equal(pickVersion([version('1.0.0', 'PREPARE_FOR_SUBMISSION')], '1.0.0').action, 'use');
  assert.equal(pickVersion([version('1.0', 'PREPARE_FOR_SUBMISSION')], '1.0.0').action, 'rename');
  assert.equal(pickVersion([version('1.0.0', 'READY_FOR_DISTRIBUTION')], '1.1.0').action, 'create');
  assert.deepEqual(pickVersion([version('1.0.0', 'WAITING_FOR_REVIEW')], '1.0.0').state, 'WAITING_FOR_REVIEW');
  assert.equal(pickVersion([version('1.0.0', 'REJECTED')], '1.0.0').action, 'use');
  assert.throws(() => pickVersion([version('1.2.0', 'READY_FOR_DISTRIBUTION')], '1.1.0'), /would go backwards/);
});

test('editableAppInfo picks the app info of the next version', () => {
  const infos = [{ id: 'live', attributes: { state: 'READY_FOR_DISTRIBUTION' } }, { id: 'next', attributes: { state: 'PREPARE_FOR_SUBMISSION' } }];
  assert.equal(editableAppInfo(infos).id, 'next');
  assert.equal(editableAppInfo(infos.slice(0, 1)), null);
});

const remote = (id, checksum, state = 'COMPLETE') => ({ id, attributes: { sourceFileChecksum: checksum, assetDeliveryState: { state } } });

test('screenshotPlan keeps what matches, replaces what changed or failed, and notices the order', () => {
  const a = { name: '01-a.png', md5: 'aaa' };
  const b = { name: '02-b.png', md5: 'bbb' };
  const c = { name: '03-c.png', md5: 'ccc' };
  assert.deepEqual(screenshotPlan([a, b], [remote('1', 'aaa'), remote('2', 'bbb')]), { keep: [{ file: a, id: '1' }, { file: b, id: '2' }], upload: [], remove: [], unchanged: true });
  const plan = screenshotPlan([a, c], [remote('1', 'aaa'), remote('2', 'bbb'), remote('3', 'ccc', 'FAILED')]);
  assert.deepEqual([plan.keep.map((k) => k.id), plan.upload.map((f) => f.name), plan.remove, plan.unchanged], [['1'], ['03-c.png'], ['2', '3'], false]);
  assert.equal(screenshotPlan([b, a], [remote('1', 'aaa'), remote('2', 'bbb')]).unchanged, false);
});

test('uploadParts cuts the file as the upload operations say', () => {
  const parts = uploadParts(Buffer.from('0123456789'), [
    { method: 'PUT', url: 'https://upload.example/1', offset: 0, length: 6, requestHeaders: [{ name: 'Content-Type', value: 'image/png' }] },
    { method: 'PUT', url: 'https://upload.example/2', offset: 6, length: 4, requestHeaders: [] },
  ]);
  assert.deepEqual(parts.map((p) => [p.method, p.url, p.headers, p.body.toString()]), [
    ['PUT', 'https://upload.example/1', { 'Content-Type': 'image/png' }, '012345'],
    ['PUT', 'https://upload.example/2', {}, '6789'],
  ]);
});

test('pickSubmission waits for a review in progress, reuses a draft or a rejected one, or creates one', () => {
  const s = (state) => ({ id: state, attributes: { state } });
  assert.equal(pickSubmission([s('COMPLETE'), s('WAITING_FOR_REVIEW')]).action, 'wait');
  assert.equal(pickSubmission([s('UNRESOLVED_ISSUES')]).submission.id, 'UNRESOLVED_ISSUES');
  assert.equal(pickSubmission([s('COMPLETE')]).action, 'create');
});

test('reviewDetailAttributes asks for the demo account and the contact', () => {
  const env = {
    REVIEW_USERNAME: 'reviewer', REVIEW_PASSWORD: 'secret', REVIEW_CONTACT_FIRST_NAME: 'Ada', REVIEW_CONTACT_LAST_NAME: 'Lovelace',
    REVIEW_CONTACT_EMAIL: 'ada@example.com', REVIEW_CONTACT_PHONE: '+44 20 7946 0000',
  };
  assert.deepEqual(reviewDetailAttributes(env, 'Notes'), {
    contactFirstName: 'Ada', contactLastName: 'Lovelace', contactEmail: 'ada@example.com', contactPhone: '+44 20 7946 0000',
    demoAccountRequired: true, demoAccountName: 'reviewer', demoAccountPassword: 'secret', notes: 'Notes',
  });
  assert.throws(() => reviewDetailAttributes({ ...env, REVIEW_PASSWORD: '' }, 'Notes'), /Set REVIEW_PASSWORD/);
});

test('freePriceSchedule and availability use inline resources with local ids', () => {
  const price = freePriceSchedule('6830169335', 'free-point');
  assert.deepEqual(price.data.relationships.manualPrices.data, [{ type: 'appPrices', id: '${free}' }]);
  assert.deepEqual(price.included[0].relationships.appPricePoint.data, { type: 'appPricePoints', id: 'free-point' });
  const where = availability('6830169335', ['GBR', 'USA'], true);
  assert.equal(where.data.attributes.availableInNewTerritories, true);
  assert.deepEqual(where.data.relationships.territoryAvailabilities.data.map((t) => t.id), ['${GBR}', '${USA}']);
  assert.deepEqual(where.included[1], {
    type: 'territoryAvailabilities', id: '${USA}', attributes: { available: true, releaseDate: null, preOrderEnabled: false },
    relationships: { territory: { data: { type: 'territories', id: 'USA' } } },
  });
});
```

**Step 2: Run it to see it fail**

```bash
node --test apps/ios/scripts/store.test.mjs 2>&1 | grep -E 'SyntaxError'
```

Expected: `SyntaxError: The requested module './store.mjs' does not provide an export named 'availability'`.

**Step 3: Append to `store.mjs`**

```js
const normal = (value) => (value === undefined || value === '' ? null : typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : value);

/** The attributes of `desired` that differ from `current` (missing, empty and null count as the same). */
export function changes(current, desired) {
  const changed = {};
  for (const [key, value] of Object.entries(desired)) {
    if (normal(current?.[key]) !== normal(value)) changed[key] = value;
  }
  return changed;
}

/** "description, keywords" for the log: names only, so a password or a long text is never printed. */
export const names = (attributes) => Object.keys(attributes).join(', ');

/** Versions as numbers: compareVersions('1.10.0', '1.9') > 0. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const EDITABLE = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'];
const stateOf = (version) => version.attributes.appVersionState ?? version.attributes.appStoreState;

/**
 * Which App Store version to work on for `wanted`: `use` it (it exists and can be edited), `rename` the one
 * version that can be edited (App Store Connect keeps one at a time, e.g. the "1.0" it makes with the app
 * record), `create` it, or `locked` (it's in review, approved or live: nothing to change).
 */
export function pickVersion(versions, wanted) {
  const same = versions.find((v) => v.attributes.versionString === wanted);
  if (same) return EDITABLE.includes(stateOf(same)) ? { action: 'use', version: same } : { action: 'locked', version: same, state: stateOf(same) };
  const newer = versions.find((v) => !EDITABLE.includes(stateOf(v)) && compareVersions(v.attributes.versionString, wanted) > 0);
  if (newer) throw new Error(`Version ${newer.attributes.versionString} is already on the App Store; ${wanted} would go backwards.`);
  const editable = versions.find((v) => EDITABLE.includes(stateOf(v)));
  return editable ? { action: 'rename', version: editable } : { action: 'create' };
}

/** The app info that can be edited (there are two while a version is live: the live one and the next). */
export const editableAppInfo = (infos) => infos.find((i) => ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'READY_FOR_REVIEW'].includes(i.attributes.state)) ?? null;

/**
 * Which screenshots to keep, delete and upload so the set holds exactly the local files, in their order.
 * A screenshot is the same when its checksum (MD5 of the file) matches; failed uploads are replaced.
 */
export function screenshotPlan(local, remote) {
  const usable = remote.filter((r) => r.attributes.assetDeliveryState?.state !== 'FAILED');
  const taken = new Set();
  const keep = [];
  const upload = [];
  for (const file of local) {
    const match = usable.find((r) => !taken.has(r.id) && r.attributes.sourceFileChecksum === file.md5);
    if (match) {
      taken.add(match.id);
      keep.push({ file, id: match.id });
    } else upload.push(file);
  }
  const remove = remote.filter((r) => !taken.has(r.id)).map((r) => r.id);
  const inOrder = remote.map((r) => r.id).join() === keep.map((k) => k.id).join();
  return { keep, upload, remove, unchanged: !upload.length && !remove.length && inOrder };
}

/** The upload operations App Store Connect hands out for a reserved file, with the bytes each one sends. */
export function uploadParts(buffer, operations) {
  return operations.map((op) => ({
    method: op.method,
    url: op.url,
    headers: Object.fromEntries((op.requestHeaders ?? []).map((h) => [h.name, h.value])),
    body: buffer.subarray(op.offset, op.offset + op.length),
  }));
}

/** What to do about the review submission: wait for the one in review, use a draft, or create one. */
export function pickSubmission(submissions) {
  const active = submissions.find((s) => ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'CANCELING', 'COMPLETING'].includes(s.attributes.state));
  if (active) return { action: 'wait', submission: active };
  const draft = submissions.find((s) => ['READY_FOR_REVIEW', 'UNRESOLVED_ISSUES'].includes(s.attributes.state));
  return draft ? { action: 'use', submission: draft } : { action: 'create' };
}

export const rel = (type, id) => ({ data: { type, id } });

/** The review details: who Apple calls, the demo account, and the notes. */
export function reviewDetailAttributes(env, notes) {
  const missing = ['REVIEW_USERNAME', 'REVIEW_PASSWORD', 'REVIEW_CONTACT_FIRST_NAME', 'REVIEW_CONTACT_LAST_NAME', 'REVIEW_CONTACT_EMAIL', 'REVIEW_CONTACT_PHONE'].filter((n) => !env[n]);
  if (missing.length) throw new Error(`Set ${missing.join(', ')} (in .env, or the GitHub secrets in CI)`);
  return {
    contactFirstName: env.REVIEW_CONTACT_FIRST_NAME,
    contactLastName: env.REVIEW_CONTACT_LAST_NAME,
    contactEmail: env.REVIEW_CONTACT_EMAIL,
    contactPhone: env.REVIEW_CONTACT_PHONE,
    demoAccountRequired: true,
    demoAccountName: env.REVIEW_USERNAME,
    demoAccountPassword: env.REVIEW_PASSWORD,
    notes,
  };
}

/** A price schedule that makes the app free everywhere, from the base territory's free price point. */
export function freePriceSchedule(appId, freePricePointId, baseTerritory = 'USA') {
  return {
    data: {
      type: 'appPriceSchedules',
      relationships: {
        app: rel('apps', appId),
        baseTerritory: rel('territories', baseTerritory),
        manualPrices: { data: [{ type: 'appPrices', id: '${free}' }] },
      },
    },
    included: [{ type: 'appPrices', id: '${free}', attributes: { startDate: null }, relationships: { appPricePoint: rel('appPricePoints', freePricePointId) } }],
  };
}

/** Availability in every territory given, and in new ones as Apple adds them when `inNew`. */
export function availability(appId, territoryIds, inNew) {
  const local = (t) => `\${${t}}`;
  return {
    data: {
      type: 'appAvailabilities',
      attributes: { availableInNewTerritories: inNew },
      relationships: {
        app: rel('apps', appId),
        territoryAvailabilities: { data: territoryIds.map((t) => ({ type: 'territoryAvailabilities', id: local(t) })) },
      },
    },
    included: territoryIds.map((t) => ({
      type: 'territoryAvailabilities',
      id: local(t),
      attributes: { available: true, releaseDate: null, preOrderEnabled: false },
      relationships: { territory: rel('territories', t) },
    })),
  };
}
```

**Step 4: Run the tests again**

```bash
node --test apps/ios/scripts/store.test.mjs 2>&1 | grep -E 'ℹ (pass|fail)'
```

Expected: `ℹ pass 16`, `ℹ fail 0`.

**Step 5: Commit**

```bash
git add apps/ios/scripts/store.mjs apps/ios/scripts/store.test.mjs
git commit -m "$(cat <<'EOF'
iOS app: what changed, which App Store version to edit, which screenshots to upload, and the request bodies

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `asc.mjs`: GETs that may find nothing, and what a refused submission says

`asc()` retries a GET answered 404 four times (30 s in all), because a lagging replica sometimes says something it just listed doesn't exist. Availability and manual prices really don't exist on a fresh app, so `ascOrNull` asks once and answers `null`. When App Store Connect refuses a submission, it lists what's missing under `meta.associatedErrors`. `explain` now prints those too, and it points at the website when the missing thing is App Privacy.

**Files:**
- Modify: `apps/ios/scripts/asc.mjs`, `apps/ios/scripts/asc.test.mjs`

**Step 1: Write the failing tests.** In `asc.test.mjs`, replace

```js
import { generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import { explain, token } from './asc.mjs';
```

with

```js
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ascOrNull, explain, token } from './asc.mjs';
```

and append:

```js
test('ascOrNull answers null for a 404 straight away, without retrying', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'playarr-home-'));
  mkdirSync(join(home, '.appstoreconnect', 'private_keys'), { recursive: true });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeFileSync(join(home, '.appstoreconnect', 'private_keys', 'AuthKey_TESTKEY.p8'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  Object.assign(process.env, { HOME: home, ASC_KEY_ID: 'TESTKEY', ASC_ISSUER_ID: 'issuer', APPLE_TEAM_ID: 'TEAM', IOS_BUNDLE_ID: 'me.example.app' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([init.method, url]);
    return new Response(JSON.stringify({ errors: [{ detail: "There is no resource of type 'appAvailabilities'" }] }), { status: 404 });
  });
  assert.equal(await ascOrNull('/v1/apps/1/appAvailabilityV2'), null);
  assert.deepEqual(calls, [['GET', 'https://api.appstoreconnect.apple.com/v1/apps/1/appAvailabilityV2']]);
});

test('explain lists what a refused submission is missing, and points at App Privacy', () => {
  const body = {
    errors: [{
      status: '409', code: 'ENTITY_ERROR', detail: 'The request entity is not valid.',
      meta: { associatedErrors: { '/v1/apps/1': [{ detail: 'You must provide App Privacy information (data usage) before submitting.' }], '/v1/appStoreVersions/2': [{ detail: 'Screenshots are missing.' }] } },
    }],
  };
  const message = explain(409, body);
  assert.match(message, /App Store Connect → Playarr → App Privacy/);
  assert.ok(message.endsWith('The request entity is not valid. You must provide App Privacy information (data usage) before submitting. Screenshots are missing.'));
});
```

The first test points `HOME` at a temporary folder with a throwaway key, so `config()` finds a key without touching the real one, and it mocks `fetch`.

**Step 2: Run them to see them fail**

```bash
node --test apps/ios/scripts/asc.test.mjs 2>&1 | grep -E 'SyntaxError'
```

Expected: `SyntaxError: The requested module './asc.mjs' does not provide an export named 'ascOrNull'`.

**Step 3: Change `asc.mjs`.** Five edits:

(a) In `explain`, replace

```js
export function explain(status, body) {
  const said = (body?.errors ?? []).map((e) => e.detail ?? e.title).filter(Boolean).join(' ');
```

with

```js
export function explain(status, body) {
  // A refused submission lists what's missing in meta.associatedErrors, keyed by the resource it's about.
  const details = (e) => [e.detail ?? e.title, ...Object.values(e.meta?.associatedErrors ?? {}).flat().map((a) => a.detail ?? a.title)];
  const said = (body?.errors ?? []).flatMap(details).filter(Boolean).join(' ');
```

(b) Replace

```js
  if (status === 403) return `The key isn't allowed to do this (403); it needs the Admin role. Apple says: ${said}`;
```

with

```js
  if (status === 403) return `The key isn't allowed to do this (403); it needs the Admin role. Apple says: ${said}`;
  if (status === 409 && /privacy|data (usage|collection)/i.test(said)) {
    return `App Store Connect refuses (409) until App Privacy is published, which only its website can do: App Store Connect → Playarr → App Privacy (see the phase 11 plan). Apple says: ${said}`;
  }
```

(c) Replace

```js
 * just listed doesn't exist. Changes aren't retried: a failed one may have happened anyway.
 */
export async function asc(method, path, body) {
```

with

```js
 * just listed doesn't exist. Changes aren't retried: a failed one may have happened anyway.
 * With `orNull`, a 404 answers null at once: for things that may well not exist yet (ascOrNull).
 */
export async function asc(method, path, body, { orNull = false } = {}) {
```

(d) In the loop, replace

```js
    const failed = res instanceof Error || res.status === 404 || res.status === 429 || res.status >= 500;
```

with

```js
    const failed = res instanceof Error || (res.status === 404 && !orNull) || res.status === 429 || res.status >= 500;
```

and replace

```js
    if (res instanceof Error) throw new Error(`${method} ${path}: no answer from App Store Connect (${res.cause?.code ?? res.message})`);
```

with

```js
    if (res instanceof Error) throw new Error(`${method} ${path}: no answer from App Store Connect (${res.cause?.code ?? res.message})`);
    if (orNull && res.status === 404) return null;
```

(e) Above `const q = encodeURIComponent;` add:

```js
/** GET something that may not exist yet (an app's availability, its prices): null for a 404, with no retries. */
export const ascOrNull = (path) => asc('GET', path, undefined, { orNull: true });

```

**Step 4: Run the tests again**

```bash
node --test apps/ios/scripts/asc.test.mjs 2>&1 | grep -E 'ℹ (pass|fail)'
```

Expected: `ℹ pass 5`, `ℹ fail 0`.

**Step 5: Commit**

```bash
git add apps/ios/scripts/asc.mjs apps/ios/scripts/asc.test.mjs
git commit -m "$(cat <<'EOF'
iOS app: asc.mjs asks once for things that may not exist, and says what a refused submission is missing

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `appstore.mjs`: App Store Connect in line with the listing, then submit

**Files:**
- Create: `apps/ios/scripts/appstore.mjs`
- Test: `apps/ios/scripts/appstore.test.mjs`

`syncListing` goes through the app, the version, the store text, the app info (name, subtitle, privacy policy, category), the age rating, the price, availability, the review details, the screenshots and the build. Each step reads first and writes only the attributes that differ. `submitForReview` waits if a submission is already in review. Otherwise it reuses a draft or a rejected submission (or creates one), adds the version if it isn't an item yet, and submits. The tests use a fake API. Its "fresh" state is what App Store Connect held for Playarr on 2026-11-03 (see "Where things stand"), and its "in sync" state is the same app after a release. A second run must write nothing.

**Step 1: Write the failing test**

`apps/ios/scripts/appstore.test.mjs`:

```js
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { submitForReview, syncListing, withDryRun } from './appstore.mjs';
import { fillNotes, md5, readStore, reviewDetailAttributes } from './store.mjs';

const APP = '6830169335';
const VERSION = 'v1';
const INFO = 'info1';
const LOC = 'loc1';
const SET = 'set1';
const env = {
  REVIEW_SERVER_URL: 'https://music.example.com', REVIEW_USERNAME: 'reviewer', REVIEW_PASSWORD: 'secret',
  REVIEW_CONTACT_FIRST_NAME: 'Ada', REVIEW_CONTACT_LAST_NAME: 'Lovelace', REVIEW_CONTACT_EMAIL: 'ada@example.com', REVIEW_CONTACT_PHONE: '+44 20 7946 0000',
};
const store = readStore();
const shot = Buffer.from('a screenshot');
const shotPath = join(mkdtempSync(join(tmpdir(), 'playarr-shot-')), '01-home.png');
writeFileSync(shotPath, shot);
const screenshots = [{ folder: 'iphone-6.9', displayType: 'APP_IPHONE_67', files: [{ name: '01-home.png', path: shotPath, size: shot.length, md5: md5(shot) }] }];
const build = { id: 'build330', number: 330 };

/** An App Store Connect that answers the GETs in `routes` (null: 404) and records every write. */
function fakeApi(routes) {
  const writes = [];
  const read = (path) => {
    if (!(path in routes)) throw new Error(`unexpected GET ${path}`);
    return routes[path];
  };
  return {
    writes,
    get: async (path) => {
      const res = read(path);
      if (res === null) throw new Error(`404 for ${path}`);
      return res;
    },
    getOrNull: async (path) => read(path),
    post: async (path, body) => {
      writes.push(['POST', path]);
      if (path === '/v1/appScreenshots') {
        return { data: { type: 'appScreenshots', id: 'shot-new', attributes: { uploadOperations: [{ method: 'PUT', url: 'https://upload.example/1', offset: 0, length: shot.length, requestHeaders: [] }] } } };
      }
      return { data: { ...body.data, id: `new-${body.data.type}` } };
    },
    patch: async (path) => {
      writes.push(['PATCH', path]);
      return {};
    },
    del: async (path) => {
      writes.push(['DELETE', path]);
      return null;
    },
    put: async ({ url, body }) => writes.push(['PUT', url, body.length]),
    sleep: async () => {},
  };
}

/** What App Store Connect held for Playarr on 2026-11-03: the app record and its empty "1.0" version. */
const fresh = {
  [`/v1/apps/${APP}?fields[apps]=contentRightsDeclaration`]: { data: { type: 'apps', id: APP, attributes: { contentRightsDeclaration: null } } },
  [`/v1/apps/${APP}/appStoreVersions?filter[platform]=IOS&limit=200`]: {
    data: [{ type: 'appStoreVersions', id: VERSION, attributes: { versionString: '1.0', appVersionState: 'PREPARE_FOR_SUBMISSION', appStoreState: 'PREPARE_FOR_SUBMISSION', copyright: null, releaseType: 'AFTER_APPROVAL' } }],
  },
  [`/v1/appStoreVersions/${VERSION}/appStoreVersionLocalizations`]: { data: [{ type: 'appStoreVersionLocalizations', id: LOC, attributes: { locale: 'en-US', description: null } }] },
  [`/v1/apps/${APP}/appInfos`]: { data: [{ type: 'appInfos', id: INFO, attributes: { state: 'PREPARE_FOR_SUBMISSION' } }] },
  [`/v1/appInfos/${INFO}/appInfoLocalizations`]: { data: [{ type: 'appInfoLocalizations', id: 'infoloc1', attributes: { locale: 'en-US', name: 'Playarr', subtitle: null, privacyPolicyUrl: null } }] },
  [`/v1/appInfos/${INFO}/primaryCategory`]: { data: null },
  [`/v1/appInfos/${INFO}/ageRatingDeclaration`]: { data: { type: 'ageRatingDeclarations', id: INFO, attributes: { profanityOrCrudeHumor: null, ageRatingOverrideV2: 'NONE' } } },
  [`/v1/appPriceSchedules/${APP}/manualPrices?include=appPricePoint&limit=50`]: null,
  [`/v1/apps/${APP}/appPricePoints?filter[territory]=USA&limit=200`]: { data: [{ type: 'appPricePoints', id: 'free-usa', attributes: { customerPrice: '0.0' } }, { type: 'appPricePoints', id: 'paid', attributes: { customerPrice: '0.29' } }] },
  [`/v1/apps/${APP}/appAvailabilityV2`]: null,
  ['/v1/territories?limit=200']: { data: [{ type: 'territories', id: 'GBR' }, { type: 'territories', id: 'USA' }] },
  [`/v1/appStoreVersions/${VERSION}/appStoreReviewDetail`]: { data: null },
  [`/v1/appStoreVersionLocalizations/${LOC}/appScreenshotSets?limit=50`]: { data: [] },
  ['/v1/appScreenshotSets/new-appScreenshotSets/appScreenshots?limit=50']: { data: [] },
  ['/v1/appScreenshots/shot-new?fields[appScreenshots]=assetDeliveryState']: { data: { attributes: { assetDeliveryState: { state: 'COMPLETE' } } } },
  [`/v1/appStoreVersions/${VERSION}/build`]: { data: null },
};

const quiet = () => {};

test('a fresh app record gets everything, the "1.0" version renamed, and the screenshot uploaded', async () => {
  const api = fakeApi(fresh);
  const result = await syncListing({ api, appId: APP, versionString: '1.0.0', build, store, screenshots, env, log: quiet });
  assert.deepEqual(result, { locked: false, versionId: VERSION });
  assert.deepEqual(api.writes, [
    ['PATCH', `/v1/apps/${APP}`],
    ['PATCH', `/v1/appStoreVersions/${VERSION}`],
    ['PATCH', `/v1/appStoreVersionLocalizations/${LOC}`],
    ['PATCH', '/v1/appInfoLocalizations/infoloc1'],
    ['PATCH', `/v1/appInfos/${INFO}`],
    ['PATCH', `/v1/ageRatingDeclarations/${INFO}`],
    ['POST', '/v1/appPriceSchedules'],
    ['POST', '/v2/appAvailabilities'],
    ['POST', '/v1/appStoreReviewDetails'],
    ['POST', '/v1/appScreenshotSets'],
    ['POST', '/v1/appScreenshots'],
    ['PUT', 'https://upload.example/1', shot.length],
    ['PATCH', '/v1/appScreenshots/shot-new'],
    ['PATCH', '/v1/appScreenshotSets/new-appScreenshotSets/relationships/appScreenshots'],
    ['PATCH', `/v1/appStoreVersions/${VERSION}/relationships/build`],
  ]);
});

/** The same app once everything is in place: a second run must write nothing. */
const inSync = {
  ...fresh,
  [`/v1/apps/${APP}?fields[apps]=contentRightsDeclaration`]: { data: { type: 'apps', id: APP, attributes: { contentRightsDeclaration: store.app.contentRights } } },
  [`/v1/apps/${APP}/appStoreVersions?filter[platform]=IOS&limit=200`]: {
    data: [{ type: 'appStoreVersions', id: VERSION, attributes: { versionString: '1.0.0', appVersionState: 'PREPARE_FOR_SUBMISSION', copyright: store.app.copyright, releaseType: 'AFTER_APPROVAL' } }],
  },
  [`/v1/appStoreVersions/${VERSION}/appStoreVersionLocalizations`]: {
    data: [{
      type: 'appStoreVersionLocalizations', id: LOC,
      attributes: { locale: 'en-US', description: store.text.description, keywords: store.text.keywords, promotionalText: store.text.promotionalText, supportUrl: store.text.supportUrl, marketingUrl: store.text.marketingUrl, whatsNew: null },
    }],
  },
  [`/v1/appInfos/${INFO}/appInfoLocalizations`]: { data: [{ type: 'appInfoLocalizations', id: 'infoloc1', attributes: { locale: 'en-US', name: store.text.name, subtitle: store.text.subtitle, privacyPolicyUrl: store.text.privacyPolicyUrl } }] },
  [`/v1/appInfos/${INFO}/primaryCategory`]: { data: { type: 'appCategories', id: 'MUSIC' } },
  [`/v1/appInfos/${INFO}/ageRatingDeclaration`]: { data: { type: 'ageRatingDeclarations', id: INFO, attributes: { ...store.app.ageRating } } },
  [`/v1/appPriceSchedules/${APP}/manualPrices?include=appPricePoint&limit=50`]: { data: [{ type: 'appPrices', id: 'p1' }], included: [{ type: 'appPricePoints', id: 'free-usa', attributes: { customerPrice: '0.0' } }] },
  [`/v1/apps/${APP}/appAvailabilityV2`]: { data: { type: 'appAvailabilities', id: APP, attributes: { availableInNewTerritories: true } } },
  [`/v1/appStoreVersions/${VERSION}/appStoreReviewDetail`]: { data: { type: 'appStoreReviewDetails', id: 'rd1', attributes: reviewDetailAttributes(env, fillNotes(store.text.notes, env)) } },
  [`/v1/appStoreVersionLocalizations/${LOC}/appScreenshotSets?limit=50`]: { data: [{ type: 'appScreenshotSets', id: SET, attributes: { screenshotDisplayType: 'APP_IPHONE_67' } }] },
  [`/v1/appScreenshotSets/${SET}/appScreenshots?limit=50`]: { data: [{ type: 'appScreenshots', id: 's1', attributes: { sourceFileChecksum: md5(shot), assetDeliveryState: { state: 'COMPLETE' } } }] },
  [`/v1/appStoreVersions/${VERSION}/build`]: { data: { type: 'builds', id: build.id } },
};

test('running it again writes nothing', async () => {
  const api = fakeApi(inSync);
  const lines = [];
  await syncListing({ api, appId: APP, versionString: '1.0.0', build, store, screenshots, env, log: (l) => lines.push(l) });
  assert.deepEqual(api.writes, []);
  assert.ok(lines.every((l) => /up to date|already set/.test(l)), lines.join('\n'));
});

test('a dry run says what it would write and writes nothing, even for things it would create', async () => {
  const api = fakeApi({ ...fresh, [`/v1/appStoreVersions/${VERSION}/appStoreVersionLocalizations`]: { data: [] } });
  const lines = [];
  await syncListing({ api: withDryRun(api, (l) => lines.push(l)), appId: APP, versionString: '1.0.0', build, store, screenshots, env, log: (l) => lines.push(l) });
  assert.deepEqual(api.writes, []);
  assert.ok(lines.includes('    would PATCH /v1/appStoreVersions/v1 (versionString, copyright)'), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('    would POST /v1/appStoreVersionLocalizations (locale, description, keywords')));
  assert.ok(lines.includes('    would POST /v1/appScreenshots (fileName, fileSize → appScreenshotSet)'));
  assert.ok(!lines.join('\n').includes('secret'), 'the password is never printed');
});

test('a version already in review is left alone', async () => {
  const api = fakeApi({
    ...fresh,
    [`/v1/apps/${APP}/appStoreVersions?filter[platform]=IOS&limit=200`]: { data: [{ type: 'appStoreVersions', id: VERSION, attributes: { versionString: '1.0.0', appVersionState: 'WAITING_FOR_REVIEW' } }] },
  });
  assert.deepEqual(await syncListing({ api, appId: APP, versionString: '1.0.0', build, store, screenshots, env, log: quiet }), { locked: true, state: 'WAITING_FOR_REVIEW', versionId: VERSION });
  assert.deepEqual(api.writes, [['PATCH', `/v1/apps/${APP}`]]);
});

test('submitForReview creates a submission, adds the version and submits; a submission in review is left alone', async () => {
  const subs = `/v1/reviewSubmissions?filter[app]=${APP}&filter[platform]=IOS&limit=50`;
  const api = fakeApi({ [subs]: { data: [] }, ['/v1/reviewSubmissions/new-reviewSubmissions/items?include=appStoreVersion&limit=50']: { data: [] } });
  assert.deepEqual(await submitForReview({ api, appId: APP, versionId: VERSION, log: quiet }), { submitted: true, state: 'WAITING_FOR_REVIEW' });
  assert.deepEqual(api.writes, [['POST', '/v1/reviewSubmissions'], ['POST', '/v1/reviewSubmissionItems'], ['PATCH', '/v1/reviewSubmissions/new-reviewSubmissions']]);

  const waiting = fakeApi({ [subs]: { data: [{ type: 'reviewSubmissions', id: 'r1', attributes: { state: 'WAITING_FOR_REVIEW' } }] } });
  assert.deepEqual(await submitForReview({ api: waiting, appId: APP, versionId: VERSION, log: quiet }), { submitted: false, state: 'WAITING_FOR_REVIEW' });
  assert.deepEqual(waiting.writes, []);
});
```

**Step 2: Run it to see it fail**

```bash
node --test apps/ios/scripts/appstore.test.mjs 2>&1 | grep -E 'ERR_MODULE_NOT_FOUND' | head -1
```

Expected: `ERR_MODULE_NOT_FOUND` for `appstore.mjs`.

**Step 3: Write `appstore.mjs`**

`apps/ios/scripts/appstore.mjs`:

```js
// Brings App Store Connect in line with apps/ios/store, then submits the version for review. Every step reads
// first and writes only what differs, so running it again changes nothing; under withDryRun it only says what
// it would write. `api` is asc.mjs over HTTP (release.mjs makes it) or an in-memory fake in the tests:
//   get(path), getOrNull(path) (null for a 404), post(path, body), patch(path, body), del(path),
//   put({ method, url, headers, body }) for screenshot bytes, sleep(ms)
import { readFileSync } from 'node:fs';
import {
  availability, changes, editableAppInfo, FIELDS, fillNotes, freePriceSchedule, names, pickSubmission, pickVersion, rel,
  reviewDetailAttributes, screenshotPlan, uploadParts,
} from './store.mjs';

export const list = (res) => (Array.isArray(res?.data) ? res.data : res?.data ? [res.data] : []);
export const one = (res) => list(res)[0] ?? null;

const describe = (body) => {
  const data = body?.data;
  if (!data || Array.isArray(data) || !data.type || (!data.attributes && !data.relationships)) return 'relationship';
  return [data.attributes && names(data.attributes), data.relationships && `→ ${Object.keys(data.relationships).join(', ')}`].filter(Boolean).join(' ');
};

/**
 * `api` with its writes logged instead of sent. What a dry run "creates" gets an id starting with dry-run-,
 * and reads under such an id find nothing, so later steps say what they'd create there too.
 */
export function withDryRun(api, log) {
  let n = 0;
  const pretend = (path) => path.includes('/dry-run-');
  return {
    ...api,
    dryRun: true,
    get: async (path) => (pretend(path) ? { data: [] } : api.get(path)),
    getOrNull: async (path) => (pretend(path) ? null : api.getOrNull(path)),
    post: async (path, body) => {
      log(`    would POST ${path} (${describe(body)})`);
      return { data: { ...body.data, id: `dry-run-${body.data.type}-${++n}`, attributes: body.data.attributes ?? {} } };
    },
    patch: async (path, body) => {
      log(`    would PATCH ${path} (${describe(body)})`);
      return { data: body.data };
    },
    del: async (path) => {
      log(`    would DELETE ${path}`);
      return null;
    },
    put: async () => {},
  };
}

/** Create the resource with `desired`, or PATCH the attributes that differ. Answers the resource. */
async function upsert(api, log, { label, type, current, desired, relationships }) {
  if (!current) {
    const { data } = await api.post(`/v1/${type}`, { data: { type, attributes: desired, ...(relationships && { relationships }) } });
    log(`  ${label}: created`);
    return data;
  }
  const diff = changes(current.attributes, desired);
  if (Object.keys(diff).length) await api.patch(`/v1/${type}/${current.id}`, { data: { type, id: current.id, attributes: diff } });
  log(`  ${label}: ${Object.keys(diff).length ? names(diff) : 'up to date'}`);
  return current;
}

const textFor = (text, on) => Object.fromEntries(FIELDS.filter((f) => f.on === on).map((f) => [f.key, text[f.key]]));

/**
 * The listing, the review details, the screenshots and the build for `versionString`. Answers
 * { locked, state, versionId }: locked when that version is already in review, approved or live.
 */
export async function syncListing({ api, appId, versionString, build, store, screenshots, env, log = console.log }) {
  const { text, app: settings, locale } = store;

  const app = one(await api.get(`/v1/apps/${appId}?fields[apps]=contentRightsDeclaration`));
  await upsert(api, log, { label: 'Content rights', type: 'apps', current: app, desired: { contentRightsDeclaration: settings.contentRights } });

  const versions = list(await api.get(`/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=200`));
  const pick = pickVersion(versions, versionString);
  if (pick.action === 'locked') return { locked: true, state: pick.state, versionId: pick.version.id };
  const wanted = { versionString, copyright: settings.copyright, releaseType: settings.releaseType };
  let version = pick.version;
  if (pick.action === 'create') {
    ({ data: version } = await api.post('/v1/appStoreVersions', {
      data: { type: 'appStoreVersions', attributes: { platform: 'IOS', ...wanted }, relationships: { app: rel('apps', appId) } },
    }));
    log(`  App Store version ${versionString}: created`);
  } else {
    const label = pick.action === 'rename' ? `App Store version ${version.attributes.versionString} → ${versionString}` : `App Store version ${versionString}`;
    await upsert(api, log, { label, type: 'appStoreVersions', current: version, desired: wanted });
  }
  // App Store Connect refuses "What's New" on an app's first version.
  const firstRelease = versions.every((v) => v.id === version.id);
  const versionText = textFor(text, 'versionLocalization');
  if (firstRelease) delete versionText.whatsNew;

  const localizations = list(await api.get(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`));
  const localization = await upsert(api, log, {
    label: `Description, keywords and links (${locale})`,
    type: 'appStoreVersionLocalizations',
    current: localizations.find((l) => l.attributes.locale === locale),
    desired: { locale, ...versionText },
    relationships: { appStoreVersion: rel('appStoreVersions', version.id) },
  });

  const info = editableAppInfo(list(await api.get(`/v1/apps/${appId}/appInfos`)));
  if (!info) throw new Error('App Store Connect has no app information that can be edited right now (is a version in review?).');
  const infoLocalizations = list(await api.get(`/v1/appInfos/${info.id}/appInfoLocalizations`));
  await upsert(api, log, {
    label: `Name, subtitle and privacy policy (${locale})`,
    type: 'appInfoLocalizations',
    current: infoLocalizations.find((l) => l.attributes.locale === locale),
    desired: { locale, ...textFor(text, 'appInfoLocalization') },
    relationships: { appInfo: rel('appInfos', info.id) },
  });
  const category = one(await api.get(`/v1/appInfos/${info.id}/primaryCategory`));
  if (category?.id === settings.primaryCategory) log('  Category: up to date');
  else {
    await api.patch(`/v1/appInfos/${info.id}`, { data: { type: 'appInfos', id: info.id, relationships: { primaryCategory: rel('appCategories', settings.primaryCategory) } } });
    log(`  Category: ${settings.primaryCategory}`);
  }
  const rating = one(await api.get(`/v1/appInfos/${info.id}/ageRatingDeclaration`));
  await upsert(api, log, { label: 'Age rating', type: 'ageRatingDeclarations', current: rating, desired: settings.ageRating });

  const prices = await api.getOrNull(`/v1/appPriceSchedules/${appId}/manualPrices?include=appPricePoint&limit=50`);
  if ((prices?.included ?? []).some((p) => p.type === 'appPricePoints' && Number(p.attributes.customerPrice) === 0)) log('  Price: up to date (free)');
  else {
    const points = list(await api.get(`/v1/apps/${appId}/appPricePoints?filter[territory]=USA&limit=200`));
    const free = points.find((p) => Number(p.attributes.customerPrice) === 0);
    if (!free) throw new Error('App Store Connect lists no free price point for the United States.');
    await api.post('/v1/appPriceSchedules', freePriceSchedule(appId, free.id));
    log('  Price: free');
  }
  if (await api.getOrNull(`/v1/apps/${appId}/appAvailabilityV2`)) log('  Availability: already set (App Store Connect → Pricing and Availability changes it)');
  else {
    const territories = list(await api.get('/v1/territories?limit=200')).map((t) => t.id);
    await api.post('/v2/appAvailabilities', availability(appId, territories, settings.availableInNewTerritories));
    log(`  Availability: all ${territories.length} countries and regions`);
  }

  const detail = one(await api.get(`/v1/appStoreVersions/${version.id}/appStoreReviewDetail`));
  await upsert(api, log, {
    label: 'App Review information',
    type: 'appStoreReviewDetails',
    current: detail,
    desired: reviewDetailAttributes(env, fillNotes(text.notes, env)),
    relationships: { appStoreVersion: rel('appStoreVersions', version.id) },
  });

  const sets = list(await api.get(`/v1/appStoreVersionLocalizations/${localization.id}/appScreenshotSets?limit=50`));
  for (const local of screenshots) {
    let set = sets.find((s) => s.attributes.screenshotDisplayType === local.displayType);
    if (!set) {
      ({ data: set } = await api.post('/v1/appScreenshotSets', {
        data: {
          type: 'appScreenshotSets',
          attributes: { screenshotDisplayType: local.displayType },
          relationships: { appStoreVersionLocalization: rel('appStoreVersionLocalizations', localization.id) },
        },
      }));
    }
    const remote = list(await api.get(`/v1/appScreenshotSets/${set.id}/appScreenshots?limit=50`));
    const plan = screenshotPlan(local.files, remote);
    if (plan.unchanged) {
      log(`  Screenshots ${local.folder}: up to date`);
      continue;
    }
    for (const id of plan.remove) await api.del(`/v1/appScreenshots/${id}`);
    const uploaded = [];
    for (const file of plan.upload) uploaded.push({ file, id: await uploadScreenshot(api, set.id, file) });
    const order = local.files.map((f) => [...plan.keep, ...uploaded].find((s) => s.file === f).id);
    await api.patch(`/v1/appScreenshotSets/${set.id}/relationships/appScreenshots`, { data: order.map((id) => ({ type: 'appScreenshots', id })) });
    log(`  Screenshots ${local.folder}: ${plan.upload.length} uploaded, ${plan.remove.length} removed, ${plan.keep.length} kept`);
  }

  const attached = one(await api.get(`/v1/appStoreVersions/${version.id}/build`));
  if (!build.id) log(`  Build: ${build.number} once it's uploaded`);
  else if (attached?.id === build.id) log(`  Build ${build.number}: up to date`);
  else {
    await api.patch(`/v1/appStoreVersions/${version.id}/relationships/build`, { data: { type: 'builds', id: build.id } });
    log(`  Build ${build.number}: chosen for this version`);
  }
  return { locked: false, versionId: version.id };
}

/** Reserve, send the bytes, commit, and wait until App Store Connect has processed the screenshot. */
async function uploadScreenshot(api, setId, file) {
  const { data: reserved } = await api.post('/v1/appScreenshots', {
    data: { type: 'appScreenshots', attributes: { fileName: file.name, fileSize: file.size }, relationships: { appScreenshotSet: rel('appScreenshotSets', setId) } },
  });
  if (api.dryRun) return reserved.id;
  for (const part of uploadParts(readFileSync(file.path), reserved.attributes.uploadOperations)) await api.put(part);
  await api.patch(`/v1/appScreenshots/${reserved.id}`, { data: { type: 'appScreenshots', id: reserved.id, attributes: { uploaded: true, sourceFileChecksum: file.md5 } } });
  for (let tries = 0; tries < 90; tries++) {
    const { data } = await api.get(`/v1/appScreenshots/${reserved.id}?fields[appScreenshots]=assetDeliveryState`);
    const { state, errors = [] } = data.attributes.assetDeliveryState ?? {};
    if (state === 'COMPLETE') return reserved.id;
    if (state === 'FAILED') throw new Error(`App Store Connect couldn't process ${file.name}: ${errors.map((e) => e.description ?? e.code).join(' ')}`);
    await api.sleep(2000);
  }
  throw new Error(`App Store Connect still hasn't processed ${file.name} after 3 minutes.`);
}

/** Add the version to a review submission (a draft, or a new one) and submit it. */
export async function submitForReview({ api, appId, versionId, log = console.log }) {
  const pick = pickSubmission(list(await api.get(`/v1/reviewSubmissions?filter[app]=${appId}&filter[platform]=IOS&limit=50`)));
  if (pick.action === 'wait') {
    log(`  Review submission: already ${pick.submission.attributes.state}`);
    return { submitted: false, state: pick.submission.attributes.state };
  }
  let submission = pick.submission;
  if (!submission) {
    ({ data: submission } = await api.post('/v1/reviewSubmissions', {
      data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: rel('apps', appId) } },
    }));
  }
  const items = list(await api.get(`/v1/reviewSubmissions/${submission.id}/items?include=appStoreVersion&limit=50`));
  if (!items.some((i) => i.relationships?.appStoreVersion?.data?.id === versionId)) {
    await api.post('/v1/reviewSubmissionItems', {
      data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: rel('reviewSubmissions', submission.id), appStoreVersion: rel('appStoreVersions', versionId) } },
    });
  }
  await api.patch(`/v1/reviewSubmissions/${submission.id}`, { data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } } });
  log('  Review submission: submitted');
  return { submitted: true, state: 'WAITING_FOR_REVIEW' };
}
```

**Step 4: Run the tests again**

```bash
node --test apps/ios/scripts/appstore.test.mjs 2>&1 | grep -E 'ℹ (pass|fail)'
```

Expected: `ℹ pass 5`, `ℹ fail 0`. (The site test in `store.test.mjs` needs Task 3's pages; this file doesn't.)

**Step 5: Commit**

```bash
git add apps/ios/scripts/appstore.mjs apps/ios/scripts/appstore.test.mjs
git commit -m "$(cat <<'EOF'
iOS app: bring App Store Connect in line with apps/ios/store and submit for review, writing only what differs

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `release.mjs`: the `release` and `check-store` commands

**Files:**
- Modify: `apps/ios/scripts/release.mjs`, `apps/ios/scripts/release.test.mjs`

**Step 1: Write the failing tests.** In `release.test.mjs`, replace

```js
import { exportOptions, whatsNew } from './release.mjs';
```

with

```js
import { exportOptions, marketingVersionIn, reviewerProblems, whatsNew, withMarketingVersion } from './release.mjs';
```

and append:

```js
test('marketingVersionIn and withMarketingVersion read and set MARKETING_VERSION only', () => {
  const xcconfig = '// Settings\nMARKETING_VERSION = 1.0.0\nCURRENT_PROJECT_VERSION = 1\n';
  assert.equal(marketingVersionIn(xcconfig), '1.0.0');
  assert.equal(withMarketingVersion(xcconfig, '1.1.0'), '// Settings\nMARKETING_VERSION = 1.1.0\nCURRENT_PROJECT_VERSION = 1\n');
  assert.throws(() => marketingVersionIn('CURRENT_PROJECT_VERSION = 1\n'), /no MARKETING_VERSION/);
});

test('reviewerProblems wants a member with no requests, one source and some albums', () => {
  const server = { setup: false };
  const reviewer = { username: 'reviewer', role: 'member', canRequest: false, sources: [2] };
  assert.deepEqual(reviewerProblems(server, reviewer, [{ id: 1 }]), []);
  assert.deepEqual(reviewerProblems({ setup: true }, { ...reviewer, role: 'admin', canRequest: true, sources: null }, []), [
    'the server is still in setup mode',
    'the demo account is an admin; it must be a member',
    'the demo account may request albums; turn that off in Settings → Accounts',
    'the demo account hears every source; give it only the Creative Commons folder',
    'the demo account sees no albums',
  ]);
});
```

**Step 2: Run them to see them fail**

```bash
node --test apps/ios/scripts/release.test.mjs 2>&1 | grep -E 'SyntaxError'
```

Expected: `SyntaxError: The requested module './release.mjs' does not provide an export named 'marketingVersionIn'`.

**Step 3: Change `release.mjs`.** Five edits. They were written against `release.mjs` as of phase 2's merge (with `NO_MACRO_SANDBOX`). If `beta()` has changed since, carry its changes into `uploadBuild()`.

(a) The header comment: replace

```js
//   node scripts/release.mjs device   build and install on a paired iPhone (DEVICE="name or UDID" picks one);
//                                     optional, TestFlight needs no registered device
//
// Run through the Makefile (`pnpm ios:beta`, `pnpm ios:device`), which loads the repo's .env. The build
// number is `git rev-list --count HEAD`; the marketing version is MARKETING_VERSION in Config/Base.xcconfig.
```

with

```js
//   node scripts/release.mjs device   build and install on a paired iPhone (DEVICE="name or UDID" picks one);
//                                     optional, TestFlight needs no registered device
//   node scripts/release.mjs release [X.Y.Z] [--dry-run]
//                                     the App Store: check the listing in store/ and the demo account, set
//                                     MARKETING_VERSION to X.Y.Z and commit it (when given and new), upload the
//                                     build like beta, bring App Store Connect in line with store/ (text, age
//                                     rating, price, availability, review details, screenshots, build), submit
//                                     for review; released automatically once approved. --dry-run changes nothing
//                                     and prints what it would change. Safe to run again.
//   node scripts/release.mjs check-store
//                                     only check store/ against Apple's limits, offline
//
// Run through the Makefile (`pnpm ios:beta`, `pnpm ios:device`, `pnpm ios:release`), which loads the repo's
// .env. The build number is `git rev-list --count HEAD`; the marketing version is MARKETING_VERSION in
// Config/Base.xcconfig, changed only by `release`.
```

(b) The imports and constants: replace

```js
import { fileURLToPath } from 'node:url';
import { asc, authFlags, config, fail, findApp, findGroup, GROUP } from './asc.mjs';

const IOS = fileURLToPath(new URL('..', import.meta.url));
const ARCHIVE = join(IOS, 'build/Playarr.xcarchive');
```

with

```js
import { fileURLToPath } from 'node:url';
import { submitForReview, syncListing, withDryRun } from './appstore.mjs';
import { asc, ascOrNull, authFlags, config, fail, findApp, findGroup, GROUP } from './asc.mjs';
import { compareVersions, fillNotes, readScreenshots, readStore, reviewDetailAttributes, validateScreenshots, validateStore, VERSION_PATTERN } from './store.mjs';

const IOS = fileURLToPath(new URL('..', import.meta.url));
const ARCHIVE = join(IOS, 'build/Playarr.xcarchive');
const XCCONFIG = join(IOS, 'Config/Base.xcconfig');
```

(c) `beta()` splits in two. The upload half becomes `uploadBuild()` with no change in what it does, except that it reads the version through `marketingVersionIn`. Replace the whole `async function beta() { … }` (up to, not including, `/** Polls until the uploaded build is processed`) with:

```js
async function beta() {
  const cfg = config();
  const app = (await findApp(cfg.bundleId)) ?? fail(`No app record for ${cfg.bundleId} in App Store Connect: create it first (see the phase 0 plan).`);
  const { build, version, lastBuild, fresh } = await uploadBuild(cfg, app);
  if (!fresh) return;

  step('Waiting for App Store Connect to process the build (usually 5 to 15 minutes)');
  const uploaded = await processed(app.id, build);

  const notes = lastBuild
    ? whatsNew(sh('git', ['log', '--format=%s', `--max-count=${build - lastBuild}`]).split('\n'))
    : 'The first Playarr build on TestFlight.';
  const { data: localizations } = await asc('GET', `/v1/builds/${uploaded.id}/betaBuildLocalizations`);
  const existing = localizations.find((l) => l.attributes.locale === 'en-US');
  if (existing) {
    await asc('PATCH', `/v1/betaBuildLocalizations/${existing.id}`, { data: { type: 'betaBuildLocalizations', id: existing.id, attributes: { whatsNew: notes } } });
  } else {
    await asc('POST', '/v1/betaBuildLocalizations', {
      data: { type: 'betaBuildLocalizations', attributes: { locale: 'en-US', whatsNew: notes }, relationships: { build: { data: { type: 'builds', id: uploaded.id } } } },
    });
  }
  console.log(`  What to Test:\n${notes.replace(/^/gm, '    ')}`);

  const group = await findGroup(app.id);
  if (!group) fail(`Build ${build} is processed, but there's no TestFlight group "${GROUP}": run corepack pnpm ios:setup, then add the build to it in App Store Connect.`);
  if (!group.attributes.hasAccessToAllBuilds) {
    await asc('POST', `/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: 'builds', id: uploaded.id }] });
  }
  console.log(`\n✓ Playarr ${version} (${build}) is on TestFlight for "${GROUP}".`);
}

/**
 * Archive (unsigned), sign at export and upload the build for HEAD, unless App Store Connect already has it.
 * Answers its number, the marketing version, the last build before it, and whether it was uploaded now.
 */
async function uploadBuild(cfg, app) {
  const build = Number(sh('git', ['rev-list', '--count', 'HEAD']));
  const version = marketingVersionIn(readFileSync(XCCONFIG, 'utf8'));
  const { data: [last] } = await asc('GET', `/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=1&fields[builds]=version`);
  const lastBuild = Number(last?.attributes.version ?? 0);
  if (build === lastBuild) {
    console.log(`✓ Build ${build} is already on App Store Connect: nothing to upload.`);
    return { build, version, lastBuild, fresh: false };
  }
  if (build < lastBuild) fail(`Build ${build} is older than ${lastBuild}, the last one on App Store Connect. Pull, then try again.`);
  if (sh('git', ['status', '--porcelain'])) console.warn('! Uncommitted changes go into this build, but not into its number.');

  step(`Archiving Playarr ${version} (${build}), unsigned`);
  rmSync(ARCHIVE, { recursive: true, force: true });
  xcodebuild([
    'archive', '-scheme', 'Playarr', '-configuration', 'Release', '-destination', 'generic/platform=iOS',
    '-archivePath', ARCHIVE, '-derivedDataPath', 'build/DerivedData', '-quiet',
    'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY=', `CURRENT_PROJECT_VERSION=${build}`, NO_MACRO_SANDBOX,
  ]);

  const tmp = mkdtempSync(join(tmpdir(), 'playarr-export-'));
  try {
    step('Signing for the App Store (cloud-managed distribution certificate)');
    const options = join(tmp, 'ExportOptions.plist');
    writeFileSync(options, exportOptions(cfg.teamId));
    xcodebuild(['-exportArchive', '-archivePath', ARCHIVE, '-exportPath', join(tmp, 'export'), '-exportOptionsPlist', options, ...authFlags(cfg)]);
    const ipa = join(tmp, 'export', 'Playarr.ipa');
    if (!existsSync(ipa)) fail(`The export finished without ${ipa}.`);

    step('Uploading to App Store Connect');
    // altool reads the key from ~/.appstoreconnect/private_keys/AuthKey_<id>.p8, where config() found it.
    // It prints a harmless "CDUploaderStateInfoResumeFilePath" ERROR line before it starts.
    execFileSync('xcrun', ['altool', '--upload-app', '-f', ipa, '-t', 'ios', '--apiKey', cfg.keyId, '--apiIssuer', cfg.issuerId], { stdio: 'inherit' });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  return { build, version, lastBuild, fresh: true };
}
```

(d) Above `function step(message) {` insert:

```js
/** MARKETING_VERSION from Base.xcconfig's text. */
export function marketingVersionIn(xcconfig) {
  const found = xcconfig.match(/^MARKETING_VERSION = (.+)$/m);
  if (!found) throw new Error('Config/Base.xcconfig has no MARKETING_VERSION line');
  return found[1].trim();
}

/** Base.xcconfig's text with MARKETING_VERSION set to `version`. */
export function withMarketingVersion(xcconfig, version) {
  marketingVersionIn(xcconfig);
  return xcconfig.replace(/^MARKETING_VERSION = .+$/m, `MARKETING_VERSION = ${version}`);
}

/** What's wrong with the demo account for App Review, from GET /api/server, its account and its albums. */
export function reviewerProblems(server, account, albums) {
  const problems = [];
  if (server.setup) problems.push('the server is still in setup mode');
  if (account.role !== 'member') problems.push(`the demo account is an ${account.role}; it must be a member`);
  if (account.canRequest) problems.push('the demo account may request albums; turn that off in Settings → Accounts');
  if (!account.sources?.length) problems.push('the demo account hears every source; give it only the Creative Commons folder');
  if (!albums.length) problems.push('the demo account sees no albums');
  return problems;
}

/** Sign in to the demo server as the reviewer would, check the account, and sign out again. */
async function checkReviewer(env) {
  const base = (env.REVIEW_SERVER_URL ?? '').replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+/.test(base)) fail("Set REVIEW_SERVER_URL to the demo server's https:// address (in .env, or the GitHub secrets in CI).");
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'X-Playarr': '1', ...(body && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    }).catch((err) => fail(`${base} doesn't answer (${err.cause?.code ?? err.message}): App Review couldn't sign in either.`));
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) fail(`${method} ${base}${path} answered ${res.status}${json?.error ? `: ${json.error}` : ''}`);
    return json;
  };
  const server = await call('GET', '/api/server');
  const { token, account } = await call('POST', '/api/auth/sign-in', {
    body: { username: env.REVIEW_USERNAME, password: env.REVIEW_PASSWORD, device: 'App Store release check', platform: 'script' },
  });
  try {
    const albums = await call('GET', '/api/albums?limit=50', { token });
    const problems = reviewerProblems(server, account, albums);
    if (problems.length) fail(`The demo account isn't ready for App Review:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    console.log(`  ✓ ${account.username} signs in to "${server.name}" (${server.version}): a member with no requests, ${albums.length}${albums.length === 50 ? '+' : ''} albums`);
  } finally {
    await call('POST', '/api/auth/sign-out', { token });
  }
}

/** The version to release: `wanted` (set in Base.xcconfig and committed when it's new), or the one there. */
function marketingVersion(wanted, dryRun) {
  const current = marketingVersionIn(readFileSync(XCCONFIG, 'utf8'));
  if (!wanted || wanted === current) return current;
  if (!VERSION_PATTERN.test(wanted)) fail(`Give the version as X.Y.Z (now ${current}).`);
  if (compareVersions(wanted, current) < 0) fail(`${wanted} is older than ${current}, the version in Config/Base.xcconfig.`);
  if (process.env.CI) {
    fail(`CI releases the version in Config/Base.xcconfig (${current}). Run corepack pnpm ios:release VERSION=${wanted} on the Mac (it commits the change), push, then run the workflow.`);
  }
  if (dryRun) {
    console.log(`  would set MARKETING_VERSION = ${wanted} in Config/Base.xcconfig and commit it`);
    return wanted;
  }
  writeFileSync(XCCONFIG, withMarketingVersion(readFileSync(XCCONFIG, 'utf8'), wanted));
  sh('git', ['add', 'Config/Base.xcconfig']);
  sh('git', ['commit', '--quiet', '-m', `iOS app ${wanted} for the App Store`]);
  console.log(`  ✓ MARKETING_VERSION = ${wanted}, committed (push it when the release is done)`);
  return wanted;
}

/** The listing in store/, checked offline. Exits naming every problem. */
function checkedListing() {
  const store = readStore();
  const screenshots = readScreenshots();
  const problems = [...validateStore(store), ...validateScreenshots(screenshots)];
  if (problems.length) fail(`The listing in apps/ios/store isn't ready:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return { store, screenshots };
}

function checkStore() {
  const { screenshots } = checkedListing();
  const counts = screenshots.map((s) => `${s.files.length} ${s.folder}`).join(', ');
  console.log(`✓ The listing in apps/ios/store is within Apple's limits (screenshots: ${counts}).`);
}

/** App Store Connect over HTTP, as appstore.mjs wants it. */
const live = {
  get: (path) => asc('GET', path),
  getOrNull: (path) => ascOrNull(path),
  post: (path, body) => asc('POST', path, body),
  patch: (path, body) => asc('PATCH', path, body),
  del: (path) => asc('DELETE', path),
  put: async ({ method, url, headers, body }) => {
    const res = await fetch(url, { method, headers, body });
    if (!res.ok) throw new Error(`Uploading a screenshot part answered ${res.status}.`);
  },
  sleep,
};

async function release(args) {
  const dryRun = args.includes('--dry-run');
  const wanted = args.find((a) => !a.startsWith('--'));
  const cfg = config();
  const env = process.env;

  step('Checking the listing in apps/ios/store');
  const { store, screenshots } = checkedListing();
  reviewDetailAttributes(env, fillNotes(store.text.notes, env));
  console.log("  ✓ Text, settings and screenshots are within Apple's limits");

  step(`Signing in to ${env.REVIEW_SERVER_URL ?? 'the demo server'} as App Review will`);
  await checkReviewer(env);

  if (sh('git', ['status', '--porcelain']) && !dryRun) fail('Commit or stash your changes first: an App Store build is made from a commit.');
  const version = marketingVersion(wanted, dryRun);
  const app = (await findApp(cfg.bundleId)) ?? fail(`No app record for ${cfg.bundleId} in App Store Connect.`);

  let build;
  if (dryRun) {
    const number = Number(sh('git', ['rev-list', '--count', 'HEAD']));
    const { data: [found] } = await asc('GET', `/v1/builds?filter[app]=${app.id}&filter[version]=${number}&fields[builds]=version,processingState`);
    build = { id: found?.attributes.processingState === 'VALID' ? found.id : null, number };
    console.log(`\n▸ Build ${number}: ${build.id ? 'on App Store Connect' : 'would be archived and uploaded'}`);
  } else {
    const up = await uploadBuild(cfg, app);
    if (up.fresh) step('Waiting for App Store Connect to process the build (usually 5 to 15 minutes)');
    build = { id: (await processed(app.id, up.build)).id, number: up.build };
  }

  step(`${dryRun ? 'Comparing' : 'Updating'} the App Store listing of Playarr ${version}${dryRun ? ' (dry run: nothing is changed)' : ''}`);
  const api = dryRun ? withDryRun(live, console.log) : live;
  const result = await syncListing({ api, appId: app.id, versionString: version, build, store, screenshots, env });
  if (result.locked) {
    console.log(`\n✓ Playarr ${version} is ${result.state.toLowerCase().replaceAll('_', ' ')} in App Store Connect: nothing to change.`);
    return;
  }

  step('Submitting for review');
  // App Privacy ("Data Not Collected") is set on App Store Connect's website: the API has no endpoint for it.
  const outcome = await submitForReview({ api, appId: app.id, versionId: result.versionId });
  if (dryRun) console.log(`\n✓ Dry run done: Playarr ${version} (${build.number}) would be submitted for review.`);
  else if (outcome.submitted) console.log(`\n✓ Playarr ${version} (${build.number}) is submitted for review. It goes on the App Store by itself once approved.`);
  else console.log(`\n✓ Playarr ${version} is already ${outcome.state.toLowerCase().replaceAll('_', ' ')}.`);
}
```

(e) The command table at the bottom: replace

```js
  const commands = { beta, device };
  const command = commands[process.argv[2]] ?? (() => fail('Usage: node scripts/release.mjs beta | device'));
  await command().catch((err) => fail(err.message));
```

with

```js
  const [name, ...args] = process.argv.slice(2);
  const commands = { beta, device, release: () => release(args), 'check-store': async () => checkStore() };
  const command = commands[name] ?? (() => fail('Usage: node scripts/release.mjs beta | device | release [X.Y.Z] [--dry-run] | check-store'));
  await command().catch((err) => fail(err.message));
```

**Step 4: Run the tests again, and try `check-store`**

```bash
make -C apps/ios test-scripts 2>&1 | grep -E 'ℹ (pass|fail)'
node apps/ios/scripts/release.mjs check-store; echo "exit $?"
node apps/ios/scripts/release.mjs nope; echo "exit $?"
```

Expected: `ℹ fail 0`. The new files alone have 7 (release) + 16 (store) + 5 (appstore) + 5 (asc) tests. Then (no screenshots yet):

```
✗ The listing in apps/ios/store isn't ready:
  - screenshots/iphone-6.9 has no screenshots (make screenshots takes them on the iPhone 17 Pro Max simulator)
  - screenshots/ipad-13 has no screenshots (make screenshots takes them on the iPad Pro 13-inch (M5) simulator)
exit 1
✗ Usage: node scripts/release.mjs beta | device | release [X.Y.Z] [--dry-run] | check-store
exit 1
```

**Step 5: Commit**

```bash
git add apps/ios/scripts/release.mjs apps/ios/scripts/release.test.mjs
git commit -m "$(cat <<'EOF'
iOS app: release.mjs release checks the listing and the demo account, uploads like beta, syncs App Store Connect and submits

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Makefile, pnpm scripts and `.env.example`

**Files:**
- Modify: `apps/ios/Makefile`, `package.json`, `.env.example`

**Step 1: The Makefile.** Recipe lines start with a tab.

(a) In the header, below the `#   make device …` line, add:

```make
#   make screenshots the App Store screenshots: a local server with the Creative Commons albums and the
#                    StoreScreenshots UI test on simulators of their own (SETS="ipad-13" takes only that set)
#   make store-check check the App Store text, settings and screenshots in store/ against Apple's limits
#   make release     test, then put MARKETING_VERSION on the App Store and submit it for review
#                    (release-submit skips the tests); VERSION=1.1.0 sets and commits a new version first,
#                    DRY_RUN=1 changes nothing and prints what would change (and skips the tests)
```

(b) In the `.PHONY:` line, add `screenshots store-check release release-submit` before `clean`.

(c) Below the `device` target, add:

```make

screenshots: project
	$(NODE) scripts/screenshots.mjs $(SETS)

store-check:
	$(NODE) scripts/release.mjs check-store

release: $(if $(DRY_RUN),,test)
	$(MAKE) release-submit

release-submit: project
	$(NODE) scripts/release.mjs release $(VERSION) $(if $(DRY_RUN),--dry-run)
```

`$(MAKE) release-submit` passes `VERSION` and `DRY_RUN` on to the sub-make (make does that for command-line variables).

**Step 2: The pnpm scripts.** In the root `package.json`, after `"ios:device": "make -C apps/ios device"` add (with a comma after the line before):

```json
    "ios:screenshots": "make -C apps/ios screenshots",
    "ios:release": "make -C apps/ios release"
```

**Step 3: `.env.example`.** Append:

```bash

# iOS app, App Store releases (pnpm ios:release): the App Review demo account on your server
# (docs/plans/2026-11-03-ios-phase11-app-store.md) and who App Review calls. Never commit the values.
# REVIEW_SERVER_URL=https://music.example.com
# REVIEW_USERNAME=reviewer
# REVIEW_PASSWORD=
# REVIEW_CONTACT_FIRST_NAME=
# REVIEW_CONTACT_LAST_NAME=
# REVIEW_CONTACT_EMAIL=
# REVIEW_CONTACT_PHONE=
# The App Store screenshots (pnpm ios:screenshots): the folder of Creative Commons albums (default
# ~/Music/Playarr Creative Commons, written out in full) and the album to feature.
# SCREENSHOT_LIBRARY=
# SCREENSHOT_ALBUM=
```

**Step 4: Check what make would run**

```bash
make -n -C apps/ios release DRY_RUN=1 VERSION=1.1.0 | grep -v xcodegen
make -n -C apps/ios release-submit | tail -1
make -n -C apps/ios screenshots SETS=ipad-13 | tail -1
make -C apps/ios store-check; echo "exit $?"
```

Expected:

```
make release-submit
node --env-file-if-exists=../../.env scripts/release.mjs release 1.1.0 --dry-run
node --env-file-if-exists=../../.env scripts/release.mjs release
node --env-file-if-exists=../../.env scripts/screenshots.mjs ipad-13
```

(the first line may show make's full path), then the two "has no screenshots" lines from Task 8 and `exit 2`: make stops because there are no screenshots yet. A dry run skips the tests; a real release runs them first.

**Step 5: Commit**

```bash
git add apps/ios/Makefile package.json .env.example
git commit -m "$(cat <<'EOF'
iOS app: make release, release-submit, screenshots and store-check; pnpm ios:release and ios:screenshots

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The `StoreScreenshots` UI test and the flatten script

**Files:**
- Create: `apps/ios/PlayarrUITests/StoreScreenshots.swift`
- Create: `apps/ios/scripts/flatten-png.swift`

The test skips itself unless `PLAYARR_SCREENSHOTS=1`. `xcodebuild` passes `TEST_RUNNER_PLAYARR_SCREENSHOTS` to the test runner as `PLAYARR_SCREENSHOTS`, and only `screenshots.mjs` sets it. So `make test` and CI see it as skipped. It signs in through phase 2's screens ("Server address", Connect, "Username", "Password", "Sign in"). It then takes five screenshots as attachments named like their files. Queries marked `// UI:` depend on the screens of phases 4 to 10: adjust them to the identifiers found in Task 0, Step 2. If a screen has no stable identifier, add one in that screen's view (e.g. `.accessibilityIdentifier("MiniPlayer")`) in this task and list the file under **Files**.

**Step 1: Write the test**

`apps/ios/PlayarrUITests/StoreScreenshots.swift`:

```swift
import XCTest

/// The App Store screenshots in store/screenshots. `make screenshots` (scripts/screenshots.mjs) runs this on
/// simulators of its own, signed in to a local Playarr server that holds only Creative Commons albums, and passes
/// the server, the account and the album to feature as PLAYARR_* variables. Ordinary test runs skip it.
/// Each screenshot is an attachment named like its file ("01-now-playing"); the number is its place on the App
/// Store, not the order it's taken in.
final class StoreScreenshots: XCTestCase {
    private let env = ProcessInfo.processInfo.environment

    override func setUpWithError() throws {
        try XCTSkipUnless(env["PLAYARR_SCREENSHOTS"] == "1", "Taken by make screenshots only")
        continueAfterFailure = false
    }

    @MainActor
    func testStoreScreenshots() throws {
        let app = XCUIApplication()
        app.launch()
        if env["PLAYARR_LANDSCAPE"] == "1" { XCUIDevice.shared.orientation = .landscapeLeft }
        addUIInterruptionMonitor(withDescription: "Local network or saving the password") { alert in
            for label in ["Allow", "Not Now"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
        try signIn(app)

        // Home, with the listening screenshots.mjs seeded: Jump back in and the mixes.
        XCTAssertTrue(app.staticTexts["Jump back in"].waitForExistence(timeout: 30)) // UI: phase 4's Home
        shot("02-home")

        tab(app, "Library")
        shot("05-library")

        let album = try XCTUnwrap(env["PLAYARR_ALBUM"])
        let cover = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", album)).firstMatch // UI: phase 4's album grid
        XCTAssertTrue(cover.waitForExistence(timeout: 10))
        cover.tap()
        XCTAssertTrue(app.staticTexts[album].waitForExistence(timeout: 10))
        shot("03-album")

        app.buttons["Play"].firstMatch.tap() // UI: phase 4's album header
        let mini = app.otherElements["MiniPlayer"] // UI: phase 4's mini player identifier
        XCTAssertTrue(mini.waitForExistence(timeout: 15))
        mini.tap()
        XCTAssertTrue(app.buttons["Lyrics"].waitForExistence(timeout: 10)) // UI: phase 4's Now Playing
        settle(seconds: 4) // the artwork, its accent colour and a few seconds of playing
        shot("01-now-playing")

        app.buttons["Lyrics"].tap()
        settle(seconds: 3)
        shot("04-lyrics")
    }

    @MainActor
    private func signIn(_ app: XCUIApplication) throws {
        let address = app.textFields["Server address"]
        XCTAssertTrue(address.waitForExistence(timeout: 20))
        address.tap()
        address.typeText(try XCTUnwrap(env["PLAYARR_SERVER"]))
        app.buttons["Connect"].tap()
        let username = app.textFields["Username"]
        XCTAssertTrue(username.waitForExistence(timeout: 20))
        username.tap()
        username.typeText(try XCTUnwrap(env["PLAYARR_USERNAME"]))
        let password = app.secureTextFields["Password"]
        password.tap()
        password.typeText(try XCTUnwrap(env["PLAYARR_PASSWORD"]))
        app.buttons["Sign in"].tap()
        app.tap() // lets the interruption monitor answer an alert, if one came up
    }

    /// A tab on iPhone, the same item in the sidebar on iPad.
    @MainActor
    private func tab(_ app: XCUIApplication, _ name: String) {
        let button = app.buttons[name].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 10))
        button.tap()
        settle(seconds: 2)
    }

    @MainActor
    private func shot(_ name: String) {
        settle(seconds: 1.5)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Waits for images to load and animations to end.
    private func settle(seconds: TimeInterval) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }
}
```

**Step 2: Write the flatten script.** XCUITest's screenshots have an alpha channel, which App Store Connect refuses. The script draws the image onto an opaque canvas in the same colour space and writes a PNG.

`apps/ios/scripts/flatten-png.swift`:

```swift
// Writes a copy of a PNG without transparency, in the same colours: App Store Connect refuses screenshots
// with an alpha channel, and XCUITest's screenshots have one. Run by scripts/screenshots.mjs:
//   swift scripts/flatten-png.swift in.png out.png
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 3,
      let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
      let space = image.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB),
      let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
                              space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
else {
  FileHandle.standardError.write(Data("usage: swift flatten-png.swift in.png out.png (in.png must be an image)\n".utf8))
  exit(1)
}
let all = CGRect(x: 0, y: 0, width: image.width, height: image.height)
context.setFillColor(CGColor(gray: 0, alpha: 1))
context.fill(all)
context.draw(image, in: all)
guard let flat = context.makeImage(),
      let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)
else { exit(1) }
CGImageDestinationAddImage(destination, flat, nil)
exit(CGImageDestinationFinalize(destination) ? 0 : 1)
```

**Step 3: Check both**

```bash
P=$(xcrun --sdk iphonesimulator --show-sdk-platform-path)
xcrun --sdk iphonesimulator swiftc -typecheck -swift-version 6 -target arm64-apple-ios26.0-simulator -F "$P/Developer/Library/Frameworks" -I "$P/Developer/usr/lib" apps/ios/PlayarrUITests/StoreScreenshots.swift && echo typechecks
mkdir -p /tmp/playarr-flatten && cat > /tmp/playarr-flatten/rgba.swift <<'EOF'
import CoreGraphics; import Foundation; import ImageIO; import UniformTypeIdentifiers
let c = CGContext(data: nil, width: 40, height: 80, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.displayP3)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
c.setFillColor(CGColor(srgbRed: 1, green: 0.5, blue: 0.1, alpha: 0.5)); c.fill(CGRect(x: 0, y: 0, width: 40, height: 80))
let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(d, c.makeImage()!, nil); CGImageDestinationFinalize(d)
EOF
swift /tmp/playarr-flatten/rgba.swift /tmp/playarr-flatten/in.png
swift apps/ios/scripts/flatten-png.swift /tmp/playarr-flatten/in.png /tmp/playarr-flatten/out.png
sips -g hasAlpha -g pixelWidth /tmp/playarr-flatten/in.png /tmp/playarr-flatten/out.png | grep -E 'hasAlpha|pixelWidth'
```

Expected: `typechecks`; then `hasAlpha: yes`, `pixelWidth: 40` for `in.png` and `hasAlpha: no`, `pixelWidth: 40` for `out.png`.

**Step 4: The UI tests still pass, with this one skipped**

```bash
make -C apps/ios test-app 2>&1 | grep -E 'StoreScreenshots|skipped|\*\* TEST' | sort -u
```

Expected: a line saying `StoreScreenshots` `testStoreScreenshots` was skipped ("Taken by make screenshots only"), and `** TEST SUCCEEDED **`.

**Step 5: Commit**

```bash
git add apps/ios/PlayarrUITests/StoreScreenshots.swift apps/ios/scripts/flatten-png.swift
git commit -m "$(cat <<'EOF'
iOS app: a UI test that takes the App Store screenshots, and a script that removes their alpha channel

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: `screenshots.mjs`: a local server, simulators of their own, the screenshots out of the result bundle

**Files:**
- Create: `apps/ios/scripts/screenshots.mjs`
- Test: `apps/ios/scripts/screenshots.test.mjs`

**Step 1: Write the failing test**

`apps/ios/scripts/screenshots.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickShots, seedPlays, statusBarArgs, statusBarTime } from './screenshots.mjs';

test('statusBarTime is 9:41 on 13 January 2026 here, in ISO 8601 with this zone’s offset', () => {
  const time = statusBarTime();
  assert.match(time, /^2026-01-13T09:41:00[+-]\d\d:\d\d$/);
  const parsed = new Date(time);
  assert.deepEqual([parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), parsed.getHours(), parsed.getMinutes()], [2026, 0, 13, 9, 41]);
});

test('statusBarArgs fixes the clock, full bars and a full battery', () => {
  assert.deepEqual(statusBarArgs('UDID', '2026-01-13T09:41:00+00:00'), [
    'status_bar', 'UDID', 'override', '--time', '2026-01-13T09:41:00+00:00', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3',
    '--cellularMode', 'active', '--cellularBars', '4', '--operatorName', '', '--batteryState', 'charged', '--batteryLevel', '100',
  ]);
});

test('pickShots names the screenshots by their NN-name, keeping the last of a repeated one', () => {
  const manifest = [{
    testIdentifier: 'StoreScreenshots/testStoreScreenshots()',
    attachments: [
      { exportedFileName: 'A.png', suggestedHumanReadableName: '02-home_0_6F1C.png', timestamp: 1 },
      { exportedFileName: 'B.png', suggestedHumanReadableName: '01-now-playing_0_77AA.png', timestamp: 2 },
      { exportedFileName: 'C.png', suggestedHumanReadableName: 'Debug description_0_1.txt', timestamp: 3 },
      { exportedFileName: 'D.png', suggestedHumanReadableName: '02-home_1_8B2D.png', timestamp: 4 },
    ],
  }];
  assert.deepEqual(pickShots(manifest), [{ name: '01-now-playing', file: 'B.png' }, { name: '02-home', file: 'D.png' }]);
});

test('seedPlays plays one album a day back from now, every song, in order', () => {
  const albums = [
    { tracks: [{ id: 1, recordingId: 'r1', duration: 200.4 }, { id: 2, recordingId: 'r2', duration: 100 }] },
    { tracks: [{ id: 3, recordingId: 'r3', duration: 300 }] },
  ];
  const now = new Date(2026, 10, 3, 12, 0);
  const plays = seedPlays(albums, now);
  assert.deepEqual(plays.map((p) => [p.trackId, p.recordingId, p.seconds, p.skipped, p.hour]), [[1, 'r1', 200, false, 20], [2, 'r2', 100, false, 20], [3, 'r3', 300, false, 20]]);
  assert.equal(new Date(plays[0].at).getDate(), 2);
  assert.equal(new Date(plays[1].at) - new Date(plays[0].at), 200_000);
  assert.equal(new Date(plays[2].at).getDate(), 1);
  assert.equal(plays[0].weekday, new Date(2026, 10, 2).getDay());
});
```

**Step 2: Run it to see it fail**

```bash
node --test apps/ios/scripts/screenshots.test.mjs 2>&1 | grep -E 'ERR_MODULE_NOT_FOUND' | head -1
```

Expected: `ERR_MODULE_NOT_FOUND` for `screenshots.mjs`.

**Step 3: Write `screenshots.mjs`**

`apps/ios/scripts/screenshots.mjs`:

```js
// The App Store screenshots, taken by the StoreScreenshots UI test on simulators signed in to a local Playarr
// server that holds only Creative Commons albums, so they come out the same every time and need no network.
//
//   node scripts/screenshots.mjs [iphone-6.9 ipad-13 iphone-6.3]   (all three when none is named)
//
// Run through `make screenshots`. SCREENSHOT_LIBRARY is the folder of Creative Commons albums (default
// ~/Music/Playarr Creative Commons: the same albums as the App Review account's folder on the real server);
// SCREENSHOT_ALBUM is the album to feature (default: the first by artist). For each device it erases a simulator
// of its own ("Playarr Screenshots …"), fixes the status bar at 9:41 with full battery, runs the test, exports
// its screenshots from the result bundle, removes their alpha channel and writes them to
// store/screenshots/<folder>/, replacing what was there.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScreenshots, SCREENSHOT_SETS, STORE, validateScreenshots } from './store.mjs';

const IOS = fileURLToPath(new URL('..', import.meta.url));
const SERVER = join(IOS, '../server');
const PORT = 4610;
const BASE = `http://localhost:${PORT}`;

/** The status bar's clock: 9:41 on 13 January 2026 in this Mac's time zone, as simctl wants it (ISO 8601). */
export function statusBarTime(at = new Date(2026, 0, 13, 9, 41)) {
  const offset = -at.getTimezoneOffset();
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const zone = `${offset < 0 ? '-' : '+'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:00${zone}`;
}

/** `simctl status_bar … override` arguments: Apple's 9:41, full Wi-Fi and signal, a full battery, no carrier. */
export const statusBarArgs = (udid, time = statusBarTime()) => [
  'status_bar', udid, 'override', '--time', time, '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3',
  '--cellularMode', 'active', '--cellularBars', '4', '--operatorName', '', '--batteryState', 'charged', '--batteryLevel', '100',
];

/** The screenshots in an exported manifest.json: "NN-name" → exported file, the last one when a test ran twice. */
export function pickShots(manifest) {
  const shots = new Map();
  for (const test of manifest) {
    for (const a of [...test.attachments].sort((x, y) => (x.timestamp ?? 0) - (y.timestamp ?? 0))) {
      const name = a.suggestedHumanReadableName.match(/^(\d\d-[a-z0-9-]+)/)?.[1];
      if (name) shots.set(name, a.exportedFileName);
    }
  }
  return [...shots].sort(([a], [b]) => a.localeCompare(b)).map(([name, file]) => ({ name, file }));
}

/**
 * Two weeks of listening for the screenshot account, so Home has Jump back in and mixes: every song of the
 * first `count` albums, one album a day going back from `now`, at 8 pm local time.
 */
export function seedPlays(albums, now, count = 4) {
  const plays = [];
  albums.slice(0, count).forEach((album, day) => {
    const start = new Date(now);
    start.setDate(start.getDate() - day - 1);
    start.setHours(20, 0, 0, 0);
    let at = start.getTime();
    for (const track of album.tracks) {
      const when = new Date(at);
      plays.push({ trackId: track.id, recordingId: track.recordingId, at: when.toISOString(), hour: when.getHours(), weekday: when.getDay(), seconds: Math.round(track.duration), skipped: false });
      at += Math.round(track.duration) * 1000;
    }
  });
  return plays;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' }).trim();

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'X-Playarr': '1', ...(body && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}${json?.error ? `: ${json.error}` : ''}`);
  return json;
}

/** The repo's server on PORT with empty data, only the library folder, no analysis, Bonjour or Lidarr. */
async function startServer(library) {
  const data = mkdtempSync(join(tmpdir(), 'playarr-shots-data-'));
  // A clean environment: the repo's .env (loaded by make) may point at Lidarr or a real music folder.
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: join(data, 'data'),
    CACHE_DIR: join(data, 'cache'), ANALYSIS: 'off', BONJOUR: 'off', SERVER_NAME: 'Playarr', FOLDER_ROOTS: library,
  };
  const server = spawn('corepack', ['pnpm', 'exec', 'tsx', '--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: SERVER, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const stop = () => {
    server.kill();
    rmSync(data, { recursive: true, force: true });
  };
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; await sleep(1000)) {
    if (server.exitCode !== null) break;
    if (await call('GET', '/api/server').catch(() => null)) return stop;
  }
  stop();
  throw new Error(`The local server didn't start on ${BASE} (corepack pnpm install, then try again).`);
}

/** Claim the server, add the folder, wait for its albums, and make the listener account with some history. */
async function seed(library, featured) {
  const owner = await call('POST', '/api/auth/setup', { body: { username: 'owner', name: 'Owner', password: randomBytes(12).toString('base64url'), device: 'screenshots', platform: 'script' } });
  const source = await call('POST', '/api/settings/sources', { token: owner.token, body: { kind: 'folder', name: 'Creative Commons', settings: { path: library, access: 'local' } } });
  let albums = [];
  for (let stable = 0, deadline = Date.now() + 180_000; stable < 3 && Date.now() < deadline; await sleep(2000)) {
    const now = await call('GET', '/api/albums', { token: owner.token });
    stable = now.length && now.length === albums.length ? stable + 1 : 0;
    albums = now;
  }
  if (!albums.length) throw new Error(`No albums in ${library}: it needs tagged audio files (Artist/Album/01 Title.flac also works).`);
  const password = randomBytes(12).toString('base64url');
  const created = await call('POST', '/api/accounts', { token: owner.token, body: { username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: [source.id] } });
  const listener = await call('POST', '/api/auth/redeem', { body: { code: created.setup.code, password, device: 'screenshots', platform: 'script' } });
  const feature = albums.find((a) => a.title === featured) ?? albums[0];
  const ordered = [feature, ...albums.filter((a) => a.id !== feature.id)];
  const details = [];
  for (const album of ordered.slice(0, 4)) details.push(await call('GET', `/api/albums/${album.id}`, { token: listener.token }));
  await call('POST', '/api/plays', { token: listener.token, body: { plays: seedPlays(details, new Date()) } });
  console.log(`  ${albums.length} albums; featuring "${feature.title}" by ${feature.artistName}`);
  return { username: 'sam', password, album: feature.title };
}

/** A simulator of our own for `folder`, erased and booted, with the status bar fixed. */
function prepareSimulator(folder) {
  const { simulator } = SCREENSHOT_SETS[folder];
  const name = `Playarr Screenshots ${folder}`;
  const { devices } = JSON.parse(simctl('list', 'devices', 'available', '-j'));
  let udid = Object.values(devices).flat().find((d) => d.name === name)?.udid;
  if (udid) {
    try {
      simctl('shutdown', udid);
    } catch {
      // already shut down
    }
    simctl('erase', udid);
  } else {
    udid = simctl('create', name, simulator);
  }
  simctl('boot', udid);
  simctl('bootstatus', udid, '-b');
  simctl('ui', udid, 'appearance', 'dark');
  simctl(...statusBarArgs(udid));
  return udid;
}

function capture(folder, udid, account) {
  const bundle = join(IOS, 'build', 'screenshots', `${folder}.xcresult`);
  rmSync(bundle, { recursive: true, force: true });
  execFileSync('xcodebuild', [
    'test', '-project', 'Playarr.xcodeproj', '-scheme', 'Playarr', '-derivedDataPath', 'build/DerivedData',
    '-IDEPackageSupportDisableManifestSandbox=YES', '-destination', `id=${udid}`, '-only-testing:PlayarrUITests/StoreScreenshots',
    '-resultBundlePath', bundle, '-testLanguage', 'en', '-testRegion', 'US', '-quiet',
    // As the Makefile's XCODEBUILD: the compiler can't sandbox its macro plugins inside Claude's sandbox.
    'OTHER_SWIFT_FLAGS=$(inherited) -Xfrontend -disable-sandbox',
  ], {
    cwd: IOS,
    stdio: 'inherit',
    // xcodebuild hands TEST_RUNNER_X to the UI test as X.
    env: {
      ...process.env, TEST_RUNNER_PLAYARR_SCREENSHOTS: '1', TEST_RUNNER_PLAYARR_SERVER: BASE, TEST_RUNNER_PLAYARR_USERNAME: account.username,
      TEST_RUNNER_PLAYARR_PASSWORD: account.password, TEST_RUNNER_PLAYARR_ALBUM: account.album, TEST_RUNNER_PLAYARR_LANDSCAPE: folder.startsWith('ipad') ? '1' : '0',
    },
  });
  const exported = mkdtempSync(join(tmpdir(), 'playarr-shots-export-'));
  try {
    execFileSync('xcrun', ['xcresulttool', 'export', 'attachments', '--path', bundle, '--output-path', exported], { stdio: 'ignore' });
    const shots = pickShots(JSON.parse(readFileSync(join(exported, 'manifest.json'), 'utf8')));
    if (!shots.length) throw new Error(`The test left no screenshots in ${bundle}.`);
    const out = join(STORE, 'screenshots', folder);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    for (const { name, file } of shots) {
      execFileSync('swift', [join(IOS, 'scripts', 'flatten-png.swift'), join(exported, file), join(out, `${name}.png`)], { stdio: 'inherit' });
    }
    console.log(`  ✓ ${shots.map((s) => s.name).join(', ')}`);
  } finally {
    rmSync(exported, { recursive: true, force: true });
  }
}

async function main(folders) {
  const unknown = folders.filter((f) => !SCREENSHOT_SETS[f]);
  if (unknown.length) throw new Error(`No screenshot set ${unknown.join(', ')}; there are ${Object.keys(SCREENSHOT_SETS).join(', ')}.`);
  const library = process.env.SCREENSHOT_LIBRARY || join(homedir(), 'Music', 'Playarr Creative Commons');
  if (!existsSync(library) || !readdirSync(library).length) {
    throw new Error(`Put the Creative Commons albums in ${library} (or set SCREENSHOT_LIBRARY): see the phase 11 plan, Task 1.`);
  }
  console.log(`▸ Starting a local Playarr server on ${BASE} with ${library}`);
  const stop = await startServer(library);
  try {
    const account = await seed(library, process.env.SCREENSHOT_ALBUM);
    for (const folder of folders) {
      console.log(`\n▸ ${folder} on ${SCREENSHOT_SETS[folder].simulator}`);
      const udid = prepareSimulator(folder);
      try {
        capture(folder, udid, account);
      } finally {
        simctl('status_bar', udid, 'clear');
        simctl('shutdown', udid);
      }
    }
  } finally {
    stop();
  }
  // Only the sets taken now: the others may be taken another time.
  const problems = validateScreenshots(readScreenshots()).filter((p) => folders.some((f) => p.includes(`screenshots/${f}`)));
  if (problems.length) throw new Error(`The screenshots aren't ready:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  console.log('\n✓ Screenshots are in apps/ios/store/screenshots. Look at them before committing.');
}

if (import.meta.main) {
  const folders = process.argv.slice(2);
  await main(folders.length ? folders : Object.keys(SCREENSHOT_SETS)).catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
}
```

The server parts use phase 1's endpoints:
- `POST /api/auth/setup` claims the fresh server from localhost.
- `POST /api/settings/sources` adds the folder and answers the new source with its `id`.
- `POST /api/accounts` then `POST /api/auth/redeem` make the listener account `sam`, a member who hears only that folder and can't request.
- `POST /api/plays` takes at most 500 plays, and 4 albums are far fewer.

When this plan was written, the server started this way (`tsx`, a clean environment, port 4610) and answered `/api/server` and `/api/auth/setup`.

**Step 4: Run the tests again**

```bash
node --test apps/ios/scripts/screenshots.test.mjs 2>&1 | grep -E 'ℹ (pass|fail)'
node --check apps/ios/scripts/screenshots.mjs && echo parses
```

Expected: `ℹ pass 4`, `ℹ fail 0`, `parses`.

**Step 5: Commit**

```bash
git add apps/ios/scripts/screenshots.mjs apps/ios/scripts/screenshots.test.mjs
git commit -m "$(cat <<'EOF'
iOS app: make screenshots runs a local server with the Creative Commons albums and takes the App Store screenshots on simulators of their own

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

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
| `The demo account isn't ready for App Review: …` | Fix the account on the server as the message says (phase 1, Task 24). |
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

### Task 17: Docs: README, PLAN.md and the conventions

**Files:**
- Modify: `README.md`, `PLAN.md`, `docs/plans/2026-11-03-ios-conventions.md`

**Step 1: README, "iOS app".** In the command block, after `pnpm ios:device …`, add:

```bash
pnpm ios:screenshots # the App Store screenshots, from a local server with the Creative Commons albums
pnpm ios:release     # put MARKETING_VERSION on the App Store and submit it (VERSION=1.1.0 bumps it first; DRY_RUN=1 only shows what would change)
```

and after the paragraph about GitHub Actions, add:

```markdown
App Store releases: the listing is in `apps/ios/store/` (text per field in `en-US/`, settings in `app.json`, screenshots in `screenshots/`, the privacy and support pages in `site/`, published on GitHub Pages). `pnpm ios:release` checks it against Apple's limits and signs in to the App Review demo account. Then it uploads the build like `ios:beta`, brings App Store Connect in line with the listing, and submits; the app goes on sale by itself once approved. It's safe to run again. It needs `REVIEW_SERVER_URL`, `REVIEW_USERNAME`, `REVIEW_PASSWORD` and the `REVIEW_CONTACT_*` lines in `.env` (see `.env.example`). App Privacy ("Data Not Collected") can only be set on App Store Connect's website. `pnpm ios:screenshots` needs the Creative Commons albums in `~/Music/Playarr Creative Commons`. The "iOS" workflow can also release from GitHub (Run workflow, a dry run by default).
```

**Step 2: PLAN.md.** Add a last row to the decisions log in section 12:

```markdown
| 2026-11-03 | iOS app on the App Store (phase 11): `pnpm ios:release` keeps App Store Connect in line with `apps/ios/store/` through the API (text, category, age rating, price, availability, review details, screenshots, build) and submits; released automatically after approval; safe to rerun, with a dry run. Screenshots come from an XCUITest against a local copy of the server with the Creative Commons albums, committed as PNGs. Privacy policy and support page on GitHub Pages. App Privacy: Data Not Collected (set on the website; the API can't). |
```

**Step 3: The conventions** (skip what has already been done centrally):
- **Commands**: add `pnpm ios:screenshots` and `pnpm ios:release` ("App Store version, text, screenshots, submit for review"). Add the make variables `VERSION=X.Y.Z` and `DRY_RUN=1` for `ios:release`, and `SETS="ipad-13"` for `ios:screenshots`. Add the lower-level targets `release-submit` (used by CI) and `store-check`.
- **`.env`**: add `REVIEW_SERVER_URL`, `REVIEW_USERNAME`, `REVIEW_PASSWORD`, `REVIEW_CONTACT_FIRST_NAME`, `REVIEW_CONTACT_LAST_NAME`, `REVIEW_CONTACT_EMAIL`, `REVIEW_CONTACT_PHONE`, and optionally `SCREENSHOT_LIBRARY`, `SCREENSHOT_ALBUM`.
- **GitHub secrets**: add the seven `REVIEW_*` secrets.
- **Repository layout**:
  - `store/` holds `en-US/*.txt` (one file per App Store field), `app.json` (copyright, category, content rights, release type, price, availability, age rating), `screenshots/<iphone-6.9|iphone-6.3|ipad-13>/NN-name.png` and `site/` (GitHub Pages);
  - `scripts/` gains `store.mjs`, `appstore.mjs`, `screenshots.mjs` and `flatten-png.swift`;
  - `PlayarrUITests/StoreScreenshots.swift` skips unless run by `make screenshots`.
- **Swift conventions**: the screens the screenshot test drives keep stable accessibility identifiers (`MiniPlayer`, the tab names, "Lyrics"). A phase that renames one updates `StoreScreenshots.swift`.
- **Apple identifiers**: add App Store category Music, release after approval, privacy policy `https://nicolabortignon.github.io/playarr/privacy.html`.

**Step 4: Check**

```bash
grep -c 'ios:release' README.md docs/plans/2026-11-03-ios-conventions.md
```

Expected: at least 1 in each.

**Step 5: Commit**

```bash
git add README.md PLAN.md docs/plans/2026-11-03-ios-conventions.md
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
