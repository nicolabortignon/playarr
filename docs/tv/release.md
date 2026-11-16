# Releasing the TV app

How a build gets from the repo to the owner's TV and to Google Play (plan 9 §7). There are two flavors of the app:

- **`sideload`**, for GitHub releases. It updates itself from them (Settings → About).
- **`play`**, for Google Play, which updates it. Play doesn't allow an app to install packages, so this flavor has no
  updater and none of its permissions.

Everything goes through the Makefile and plain Node scripts with no dependencies (`apps/tv/scripts/`). There's no
fastlane and no Android Studio. The architecture is in [README.md](README.md).

---

## 1. The upload key (once)

Every release is signed with the **upload key**. Android only installs an update signed with the same key as the app
already installed, so a sideloaded TV takes releases signed with this key and no other. With another key, the app has
to be uninstalled first, which signs the TV out. For Play the stakes are lower: Google re-signs what's uploaded with
its own app signing key, and can reset a lost upload key.

On the Mac that makes releases:

```sh
make -C apps/tv upload-key
```

- It makes a PKCS12 keystore at `~/.playarr/playarr-tv-upload.jks`, outside the repo: RSA 4096, valid 27 years (Play
  wants past 2033), with a random password.
- It adds three lines to the repo's `.env`: `PLAYARR_TV_KEYSTORE`, `PLAYARR_TV_KEYSTORE_PASSWORD` and
  `PLAYARR_TV_KEY_ALIAS`.
- It prints the key's SHA-256 fingerprint.
- It refuses to run when a key already exists.

**Back up the keystore and its password together**, in a password manager for instance.

Then give CI the key, from a terminal signed in to GitHub with `gh`:

```sh
make -C apps/tv ci-secrets
```

This sets `PLAYARR_TV_KEYSTORE_BASE64`, `PLAYARR_TV_KEYSTORE_PASSWORD` and `PLAYARR_TV_KEY_ALIAS`. When
`PLAY_SERVICE_ACCOUNT_FILE` is set (§4), it sets `PLAY_SERVICE_ACCOUNT_JSON` too. Claude's shell can't run `gh`, whose
configuration it isn't allowed to read.

## 2. Making a release

1. Raise `versionName` in `apps/tv/app/build.gradle.kts` (`1.0.0` → `1.1.0`). The version code is the commit count,
   as the iOS build number is.
2. Write `apps/tv/store/en-US/whats-new.txt`, 500 characters at most. It becomes the GitHub release's notes, Play's
   release notes, and the note above Settings → About's "Install version …" on the TV.
3. Commit and push, then tag the commit:
   ```sh
   git tag tv-v1.1.0 && git push origin tv-v1.1.0
   ```

`.github/workflows/tv.yml` then:

1. runs the tests;
2. checks that the tag is `tv-v` + `versionName`;
3. builds the signed sideload APK and Play bundle (`make release`, with the key from secrets);
4. creates the GitHub release "Playarr for TV 1.1.0" with `playarr-tv-1.1.0.apk`. It isn't marked latest, so the
   server's updater, which reads the latest release, never sees it;
5. sends the bundle to Play's internal testing track (`play-upload.mjs`), once `PLAY_SERVICE_ACCOUNT_JSON` exists.

**From the Mac:** `make -C apps/tv release` builds the same two files into `apps/tv/build/release/`, signed with the
key named in `.env`. `make -C apps/tv play-upload` (with `TRACK=internal` by default) sends the bundle to Play.

## 3. The owner's TV: sideloaded, updating itself

**The first install** of a release, either way:

- `adb install apps/tv/build/release/playarr-tv-1.0.0.apk`, with the TV's debugging on ([README.md](README.md#the-tv-and-adb)).
- Or with no computer: the free **Downloader** app on the TV, given the release's address
  `https://github.com/nicolabortignon/playarr/releases/download/tv-v1.0.0/playarr-tv-1.0.0.apk`, and allowed to
  install unknown apps when it asks.

`pnpm tv:install` installs a **debug** build, signed with this Mac's debug key. A release can't update it, and it
can't update a release. Uninstall it first (`adb uninstall me.tracklistme.playarr.tv`, which signs the TV out).

**How the app updates itself** (`app/src/sideload/…/update/GitHubUpdates.kt`, `app/src/main/…/update/TvReleases.kt`):

- **Checking.** Each time the app comes to the front, at most once a day, it asks GitHub for the newest `tv-v*`
  release newer than itself. That takes two small unauthenticated API calls:
  - `git/matching-refs/tags/tv-v`, then `releases/tags/<the highest newer tag>`.
  - A tag whose release isn't there yet (CI still building) gives way to the one below it.
  - Drafts, pre-releases and releases without `playarr-tv-<version>.apk` are skipped.
  - GitHub allows 60 unauthenticated calls an hour per address, shared with the NAS updater's.
- **Offering.** Settings → About shows the release's notes and **Install version …** with when it was released. The
  Settings rail item carries an orange dot. Up to date, it says the latest release and when it came out, and the
  version row says when this one was installed (in the play flavor too).
- **Allowing, the first time.** The TV must allow Playarr to install unknown apps once. The app opens the TV's own
  panel for it. Where a TV has no such panel, Settings says where the switch is: Device Preferences (or Apps) →
  Security & restrictions → Unknown sources. Back from the panel with it allowed, the install carries on.
- **Downloading.** The release is asked for afresh first, so a newer one, or a replaced APK, is never missed. Then the
  APK downloads into the app's cache, outside the HTTP cache. It's checked against GitHub's size and SHA-256 digest,
  and then read: it must be this app's package, with a higher version code.
- **Installing.** The APK goes to the TV's PackageInstaller, which asks to confirm. Android then checks the signature.
  Once Playarr has installed itself, Android 12 and later update it without asking, through
  `UPDATE_PACKAGES_WITHOUT_USER_ACTION`. Android 9–11 always ask.
- **The app closes as it's replaced**, so the music stops. Settings says so before Install. A refusal is explained in
  Settings, for example an APK signed with another key ("a development build?"), a full disk, or a TV that blocks it.
  Cancel goes back to the offer.

**Trying it without a release**, on the emulator:

1. Make a throwaway key with `keytool` in `apps/tv/build/`, and set `PLAYARR_TV_KEYSTORE` and its password to it.
2. Build the sideload release twice with
   `make gradle ARGS=":app:assembleSideloadRelease -PupdatesRepo=http://10.0.2.2:4621/repos/owner/playarr"`. Between
   the two builds, raise `versionName` and add 1 to `versionCode`, then put both back.
3. `node apps/tv/scripts/fake-releases.mjs <the newer APK named playarr-tv-<version>.apk>` stands in for GitHub
   (`make fake-releases` serves `build/release/`'s APKs).
4. Install the older APK, sign in to `make demo`, and use Settings → About.

Seen on the emulator (Android TV 16) on 2026-11-16:

- 1.0.0 installed by adb found 1.0.1. It opened the TV's "Install unknown apps" panel and carried on once it was
  allowed. It downloaded and checked the APK, and the TV's "Do you want to update this app?" installed it.
- Cancel there went back to the offer.
- From a build with `UPDATE_PACKAGES_WITHOUT_USER_ACTION`, 1.0.2 → 1.0.3 installed without asking.

## 4. Google Play

**Once, on Play Console's website** (the API can't create an app or upload its first bundle):

1. **The developer account**: personal, $25, with the identity checks Google asks for.
2. **The app**: Create app, "Playarr", default language English (United States), App, Free.
3. **App content**:
   - The privacy policy at `store/en-US/privacy-policy-url.txt`. It's the iOS listing's page, which isn't published
     yet; the App Store plan publishes it.
   - Ads: none.
   - App access: reviewers need a server. Give them one with an account, as `REVIEW_*` does for Apple.
   - The content rating questionnaire, the target audience (not children), and Data safety: Playarr collects nothing
     for us, and everything goes to the user's own server.
4. **Advanced settings → Form factors**: add Android TV. Play reviews TV apps on their own, against its TV quality
   guidelines.
5. **Play App Signing**: keep Google's app signing key, the default. A Play copy and a sideloaded copy are then signed
   with different keys, and a TV moves from one to the other by uninstalling first.
6. **The first bundle**, by hand: Testing → Internal testing → Create release, upload
   `apps/tv/build/release/playarr-tv-<version>.aab`, and add the testers' emails.
7. **The service account**, so that CI uploads after that:
   - In Google Cloud: a project, the **Google Play Android Developer API** enabled, IAM → Service accounts → Create,
     then Keys → Add key → JSON.
   - In Play Console → Users and permissions: invite the service account's email, with "Release apps to testing
     tracks" (and later "Release to production") and "View app information" on Playarr.
   - Keep the JSON outside the repo. Name it in `.env` as `PLAY_SERVICE_ACCOUNT_FILE=/path/to/key.json`.
   - `make -C apps/tv play-check` says whether the account works. `make -C apps/tv ci-secrets` gives it to CI.
8. **Closed testing before production.** A personal account opened after November 2023 needs a closed test with at
   least 12 testers opted in for 14 days in a row before it can publish to production.

**The store listing** lives in `apps/tv/store/en-US/`: `title.txt`, `short-description.txt`, `full-description.txt`
and `whats-new.txt`, within Play's limits (the script's tests check them). `play-upload.mjs <bundle> --listing` sends
the words with a release. The pictures aren't in the repo yet: a 512×512 icon, a 1024×500 feature graphic, a
1280×720 TV banner, and TV screenshots at 1920×1080 (`make screens`).

**`scripts/play-upload.mjs`**:

- **Signing in.** The service account's JWT (RS256, `node:crypto`) is traded for an access token.
- **Uploading.** In one edit, it uploads the bundle and sets the track's release (status `completed`, the notes from
  `whats-new.txt`), then commits.
- **What Play asks for.** An app Play still has as a draft takes only draft releases; the script retries that way and
  says to roll it out in Play Console. An edit that can't be sent for review on its own is committed with
  `changesNotSentForReview`, and the script says so.
- **On failure.** A failed edit is deleted. The usual causes are explained: no such app, no permission, a version code
  already used.
- It doesn't promote a release from one track to another; Play Console does that.

**Play's TV requirements**, as the app stands:

| Requirement | Status |
|---|---|
| Shows in the TV launcher (`LEANBACK_LAUNCHER`) with a 320×180 banner | Done |
| Touchscreen not required; every screen works with the D-pad | Done |
| A Now Playing card while playing (`MediaSessionService`), Ambient Mode left alone | Done |
| 64-bit, and 16 KB pages | Done: the only native code is AndroidX's own path library, 16 KB-aligned |
| A privacy policy | Waiting for the page |
| TV screenshots and a TV banner in the listing | Not made yet |

## 5. The server and old apps

`/api/server` answers `minTvVersion` (1.0.0). Raise it by the same rule as `minAppVersion`
([ios/release.md](../ios/release.md#when-to-raise-minappversion)): only when the server can no longer serve an older
app.
