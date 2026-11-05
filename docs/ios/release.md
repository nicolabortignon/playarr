# Releasing the iOS app

How a build gets from the repo to TestFlight and the App Store. Everything goes through the App Store Connect API key: no Apple ID is signed in anywhere, there's no fastlane, and no certificate or private key sits in a keychain. The scripts are plain Node with no dependencies, in `apps/ios/scripts/`, and the `Makefile` runs them with the repo's `.env` loaded.

What's still to do before the first App Store release is tracked in [../plans/2026-11-03-ios-phase11-app-store.md](../plans/2026-11-03-ios-phase11-app-store.md).

---

## 1. What a Mac needs

- Xcode, and `make -C apps/ios bootstrap` (the pinned XcodeGen).
- The App Store Connect API key: a Team key with the Admin role, at `~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8`.
- In the repo's `.env`: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `APPLE_TEAM_ID` and `IOS_BUNDLE_ID` (`me.tracklistme.playarr`). `asc.mjs` stops with a message naming any that are missing. `node --env-file=.env apps/ios/scripts/asc.mjs check` says whether the key is accepted, and whether the bundle id, the app record and the TestFlight group exist.

One-time steps that only App Store Connect's website can do:

- **The app record** (the API can't create apps): Apps → New App, iOS, name "Playarr", primary language English (U.S.), bundle id `me.tracklistme.playarr` (register it first with `pnpm ios:setup`), SKU `playarr-ios`. It exists already; a new one is needed only for a new bundle id.
- **The agreement**: until the account holder accepts the Apple Developer Program License Agreement, the API answers 403, and `asc.mjs` says so.
- **App Privacy**, before the first App Store release.

`pnpm ios:setup` (`asc.mjs setup`) registers the bundle id. Once the app record exists, it creates the internal TestFlight group "Household", which gets every build, and adds the App Store Connect users given in `TESTERS="a@example.com b@example.com"`. It's safe to run again. Background audio and downloads are `Info.plist` keys, so the bundle id needs no capabilities.

## 2. Signing and uploading

`scripts/release.mjs`, shared by `beta` and `release` (`uploadBuild()`):

1. **Build number.** `git rev-list --count HEAD`, or `BUILD_NUMBER` when set (for when a build from another Mac took a higher number). If App Store Connect already has this build or a newer one, there's nothing to upload, and `beta` stops there with success.
2. **Archive, unsigned.** `xcodebuild archive` for `generic/platform=iOS` with `CODE_SIGNING_ALLOWED=NO`, into `apps/ios/build/Playarr.xcarchive`. A dev-signed archive would need a registered device; this one doesn't.
3. **Sign at export.** `xcodebuild -exportArchive` with `method: app-store-connect`, automatic signing and `-allowProvisioningUpdates` plus the key's flags (`authFlags` in `asc.mjs`): Apple's cloud-managed distribution certificate signs the `.ipa`. `manageAppVersionAndBuildNumber` is off, so the commit count stays the build number.
4. **Upload.** `xcrun altool --upload-app` with `--apiKey` and `--apiIssuer`; altool finds the key in `~/.appstoreconnect/private_keys/`. It prints a harmless `CDUploaderStateInfoResumeFilePath` error line first.

`ITSAppUsesNonExemptEncryption = NO` in `Info.plist` answers the export-compliance question, so builds need no manual step.

`uploadBuild()` warns when there are uncommitted changes: they'd go into the build without changing its number.

## 3. TestFlight

`pnpm ios:beta` (`make beta`) runs every test, then `make beta-upload`, which is the upload alone. After the upload, `release.mjs beta`:

- waits for App Store Connect to process the build (5 to 15 minutes usually; it gives up after 45), polling every 30 s;
- sets "What to Test" from the commit subjects since the last build (merges left out, at most 25 lines and 4,000 characters);
- makes sure "Household" gets it (the group has access to every build, so usually nothing to do).

**From a clean worktree.** Build from a commit, not from edits in progress:

```sh
git worktree add --detach /tmp/playarr-tf HEAD
cp .env /tmp/playarr-tf/ && cp -R apps/ios/.tools /tmp/playarr-tf/apps/ios/
make -C /tmp/playarr-tf/apps/ios beta-upload
```

**On a phone without TestFlight.** `pnpm ios:device` builds Debug and installs it on a paired iPhone with `xcrun devicectl` (`DEVICE="name or UDID"` picks one). It signs with the key and `-allowProvisioningDeviceRegistration`, which registers the phone. The phone needs pairing once by cable, Trust, and Developer Mode.

**Crash reports.** `pnpm ios:crashes` (`asc.mjs crashes`) lists crash reports testers sent from TestFlight that haven't been looked at yet, and saves each log to `apps/ios/build/crashes/<date>-<id>.crash`. What's been seen is kept in `build/crashes/seen.json`; `node scripts/asc.mjs crashes --all` (from `apps/ios`, with the `.env` variables set) lists them all again.

## 4. GitHub Actions

`.github/workflows/ios.yml` is the only iOS workflow. It runs on every push and pull request that changes `apps/ios/**` or the workflow itself, on `macos-26` with Xcode 26.6 (`XCODE_VERSION`; check the runner image's list before changing it), with a 90-minute limit:

1. Check out with the full history (the build number is the commit count, and "What to Test" reads the log).
2. `make -C apps/ios bootstrap`.
3. Install the web's packages (`pnpm install --frozen-lockfile --filter '@playarr/web...'`), which `mix-fixtures.test.mjs` needs.
4. `make -C apps/ios test`: the scripts' tests, the package tests (including the contract tests) and the UI tests.
5. On pushes to `main` only: write the key from the `ASC_KEY_P8_BASE64` secret, run `make -C apps/ios beta-upload` with `ASC_KEY_ID`, `ASC_ISSUER_ID`, `APPLE_TEAM_ID` from secrets and `IOS_BUNDLE_ID` set in the workflow, then remove the key whatever happened.

Pull requests never see the secrets. On `main` a run is never cancelled mid-upload: a newer push waits, and replaces any run still waiting. Elsewhere a newer push cancels the running one. There's no release job yet: App Store releases run from the Mac.

## 5. The App Store listing

`apps/ios/store/` is the listing, kept in the repo and pushed to App Store Connect by the release:

- `en-US/*.txt`: `name`, `subtitle`, `privacy-policy-url`, `description`, `keywords`, `promotional-text`, `whats-new`, `support-url`, `marketing-url`, `review-notes`. Each file's attribute and Apple's limit are in `FIELDS` in `store.mjs`. `review-notes.txt` may use only the placeholders `REVIEW_SERVER_URL` and `REVIEW_USERNAME`, filled from the environment.
- `app.json`: copyright, primary category, content rights, release type (`AFTER_APPROVAL`), price (`free`), availability in new territories, and every age-rating answer.
- `screenshots/<set>/`: PNGs named `NN-name.png` for the sets `iphone-6.9`, `ipad-13` (both required) and `iphone-6.3`, made by `make screenshots`. Not taken yet.

The scripts:

- **`store.mjs`** reads and checks the listing offline: lengths, URLs, age-rating answers, screenshot sizes, names and transparency. It also has the pure pieces the release needs: diffs, which version to edit, which screenshots to upload, and request bodies. `make store-check` (`release.mjs check-store`) runs only the checks.
- **`appstore.mjs`** brings App Store Connect in line with the listing (`syncListing`) and submits (`submitForReview`), on an injected `api`. Every step reads first and writes only what differs, so running it again changes nothing. `withDryRun` logs the writes instead of sending them.
- **`asc.mjs`** is the API itself: an ES256 JWT signed with `node:crypto` for each request, GETs retried on 5xx, 429, 404 or no answer (2, 4, 8, 16 s apart), and Apple's errors explained in words (a revoked key, the agreement, the Admin role, App Privacy).

## 6. Releasing to the App Store

`pnpm ios:release` (`make release`) runs every test, then `make release-submit` (`release.mjs release`):

1. Checks the listing in `store/`, and the review details from `REVIEW_*` in `.env`.
2. Signs in to `REVIEW_SERVER_URL` as App Review will, with `REVIEW_USERNAME` and `REVIEW_PASSWORD`, and checks that the account is a member who can't request, sees only some sources, and sees albums. Then signs out.
3. Refuses uncommitted changes. `VERSION=1.1.0` sets `MARKETING_VERSION` in `Config/Base.xcconfig` and commits it (not in CI).
4. Uploads this commit's build as `beta` does, and waits for processing.
5. Brings App Store Connect in line with the listing: version, text, age rating, price, availability, review details, screenshots, build.
6. Submits for review. Once approved, it goes on sale by itself.

`DRY_RUN=1` skips the tests, changes nothing and prints every write it would make. A version already in review or on sale is left alone. App Privacy ("Data Not Collected") has no API, so it's set on the website.

## 7. Screenshots

There are two kinds, and they never mix.

**App Store screenshots** (`pnpm ios:screenshots`, `make screenshots`, `scripts/screenshots.mjs`). It starts the repo's server on port 4610 with empty data, no analysis, no Bonjour and no Lidarr, and only a folder of Creative Commons albums (`SCREENSHOT_LIBRARY`, default `~/Music/Playarr Creative Commons`, the same albums as App Review's account). It claims the server, adds the folder, makes a member account and seeds two weeks of plays so Home has Jump back in and mixes. Then, per set, it erases a simulator of its own ("Playarr Screenshots …"), fixes the status bar at 9:41 with full battery, runs the `StoreScreenshots` UI test (skipped in ordinary runs), takes its attachments from the result bundle, removes their alpha channel (`flatten-png.swift`) and writes them to `store/screenshots/<set>/`. `SCREENSHOT_ALBUM` picks the album to feature; `SETS="ipad-13"` takes only that set.

**Screenshots of the main views** (`pnpm ios:screens`, `make screens`), for looking at the app after a UI change, not for the store. The `ScreenTour` UI test walks the main views on the demo library on simulators of its own ("Playarr Screens iphone", "ipad", "duo") and writes `screenshots/<device>/` (and `-sideways/`) at the repo root, replaced on every run and gitignored. `SCREENS="ipad"` takes one device. First, `scripts/screens-covers.mjs` looks the three demo albums up on MusicBrainz and fetches their real covers from the Cover Art Archive into `apps/ios/build/screens-covers/`, once. `ScreenTour` hands that folder to the app as `PLAYARR_DEMO_COVERS`, so these screenshots show real covers. The covers stay on this Mac: the app, the repo and the App Store screenshots keep the demo's drawn ones (`DemoArt.swift`), as the artwork isn't ours to publish. An album whose lookup fails is drawn.

`scripts/make-icons.swift` draws the app icon's dark and tinted variants from the same shapes as `AppIcon.png`.
