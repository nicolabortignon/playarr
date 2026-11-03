# Native iOS app, Phase 0: Apple Setup and Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Put an empty Playarr app on the user's iPhone through TestFlight. It has one SwiftUI screen showing "Playarr" and its version and build, and `pnpm ios:beta` builds and uploads it. GitHub Actions tests every push that changes the app and uploads from `main`.

**Architecture:** `apps/ios` holds an XcodeGen spec, three local Swift packages (`PlayarrAPI`, `PlayarrPlayer`, `PlayarrUI`), each with a placeholder type and a test, the app target, and a UI test target. A Makefile is the only entry point (`pnpm ios:*` calls it). It downloads a pinned, checksummed XcodeGen and runs `node --test`, `swift test` and `xcodebuild`. Two Node scripts with no dependencies talk to App Store Connect with the API key: `asc.mjs` (JWT, `check`, `setup`) and `release.mjs` (install on the phone, upload a beta). Signing is Xcode's cloud-managed signing through the same key, so no Apple ID, certificate file or profile lives in the repo.

**Tech Stack:** Xcode 27.2 locally (Xcode 26.6 on GitHub's `macos-26` runner), Swift 6.4 (tools version 6.2, Swift 6 language mode), SwiftUI, Swift Testing, XCUITest, XcodeGen 2.46.0, GNU Make 3.81 (the one macOS ships), Node 25 locally and 24 on the runner (`node:crypto`, `fetch`, `node:test`), App Store Connect API v1, `xcrun devicectl`, GitHub Actions. pnpm via `corepack pnpm` (pnpm is not on PATH in Claude's shell).

**Design:** [2026-11-03-ios-app-design.md](2026-11-03-ios-app-design.md): Rollout phase 0, details in section 5 "Signing and releasing". Names, layout and commands come from [2026-11-03-ios-conventions.md](2026-11-03-ios-conventions.md). This plan covers phase 0 only.

---

## Where things stand (checked 2026-11-03, about 12:50 UTC)

- The key authenticates and the API answers 200, so the "requires an in-effect agreement" 403 has cleared. Task 1's `check` still explains that 403 clearly in case it comes back (the agreement is renewed every year).
- Already in App Store Connect: the bundle id `me.tracklistme.playarr` (platform UNIVERSAL); the app record "Playarr" (Apple id 6830169335, SKU `playarr-ios`, primary language English (U.S.)); and the internal TestFlight group "Household" (automatic distribution, one tester, not yet invited). They were created in parallel with the writing of this plan. Tasks 5 to 7 should therefore just confirm them, but they stay in the plan so that a new Apple account can be set up from it.
- The team has **no registered devices**, and the user's iPhone can't be connected to this Mac. TestFlight doesn't need one: Task 9 archives unsigned and lets the export sign for distribution (see "Key decisions"). Build 301 went up that way on 2026-11-03. Task 8 (`ios:device`) is optional, for a phone that can be cabled to the Mac.
- Apple's API returned 500s for a few minutes while this plan was written. `asc.mjs` retries GET requests for that reason. While Task 5 ran, it also answered from a lagging replica now and then: an empty group list, and a 404 for the "Household" group it had just listed. So GETs answered 404 are retried too, and `setup` asks three times before it creates the group.

## Key decisions in this plan

- **XcodeGen from a pinned release zip, not Homebrew** (Homebrew isn't writable for this user). `make tools` downloads `xcodegen.zip` 2.46.0 into `apps/ios/.tools/` and checks its SHA-256. The Makefile starts with a placeholder checksum, and Task 2 computes the real one, checks it and fills it in. Task 11 updates the design doc, which still says `brew install xcodegen`.
- **Every make target that builds regenerates the project first.** XcodeGen takes under a second, so adding a Swift file never needs an extra step.
- **TestFlight needs no registered device.** A normal archive is signed with an Apple Development identity, and Apple can't make a development profile for a team with zero devices ("Your team has no devices from which to generate a provisioning profile"). Automatic signing also refuses `CODE_SIGN_IDENTITY="Apple Distribution"`. So `release.mjs beta` archives **unsigned** (`CODE_SIGNING_ALLOWED=NO`). Then `xcodebuild -exportArchive` signs the app with Apple's cloud-managed distribution certificate and an App Store profile through the key (destination `export`, which writes `Playarr.ipa`). Finally `xcrun altool --upload-app` uploads it with the same key. `destination upload` isn't used because it needs Xcode's `ITunesSoftwareService` XPC service, which Claude's sandbox can't reach ("Connection init failed at lookup with error 3"). Tested with build 301 on 2026-11-03. `pnpm ios:device` (Task 8) passes `-allowProvisioningDeviceRegistration`, which registers a cabled phone; it isn't needed for TestFlight.
- **No ExportOptions.plist in the repo.** `release.mjs` writes one from `APPLE_TEAM_ID` for each upload.
- **The Node scripts have tests** (`node:test`) for the parts that don't need Apple: the JWT, the error explanations and "What to Test". `make test` runs them before the Swift tests.
- **Background modes are Info.plist keys, not capabilities.** `UIBackgroundModes` (audio only: background `URLSession` downloads need no mode) needs nothing registered on the bundle id, so `ios:setup` registers no capability, and the entitlements file is empty. Phase 2's Bonjour also needs only Info.plist keys (`NSLocalNetworkUsageDescription`, `NSBonjourServices`).
- **Primary language English (U.S.)**, to match the en-US App Store text the conventions put in `store/`.
- **Placeholders, not guesses.** `AppVersion` (in `PlayarrAPI`) is real and stays. `PlayerPlaceholder` is deleted by phase 3. `RootView` is replaced by phase 4.

## Conventions

- Run everything from the repo root `/Users/bortignon/dev/playarr`. `corepack pnpm ios:<x>` runs `make -C apps/ios <x>`, and both forms do the same thing.
- Make variables go after the target, through pnpm too: `corepack pnpm ios:setup TESTERS=you@example.com`, `make -C apps/ios build SIMULATOR="iPad Pro 13-inch (M5)"`. The `DEVICE="Name"` environment variable picks a phone for `ios:device`.
- Claude's shell runs in a sandbox. Already handled: SwiftPM's own sandbox (`--disable-sandbox`, `-IDEPackageSupportDisableManifestSandbox=YES`). Simulators, `swift test`, the App Store Connect API and GitHub downloads all work there; this was checked while writing the plan. Task 9's flow (unsigned archive, cloud-signed export, altool upload) worked there for build 301; Xcode's own upload (`destination upload`) doesn't, which is why altool uploads. Two things may still not work there: development signing with `-allowProvisioningUpdates` (it writes a certificate to the login keychain) and `devicectl` reaching a phone. If Task 8 or 9 fails with a keychain error, `errSecInternalComponent`, or a phone that `xcrun devicectl list devices` doesn't show, ask the user to run the same `corepack pnpm ios:…` command in Terminal, or to approve running it outside the sandbox.
- `corepack pnpm ios:beta` takes 15 to 45 minutes, mostly Apple processing the build. Run it in the background and wait for it to finish.
- Commit after every task that changes files: on `main`, only that task's files, with a plain-English subject (no `feat:`) and the `Co-Authored-By` line. The pre-commit hook bumps `package.json`'s version; never bypass it. Claude's shell can't push: the user pushes (Task 10 needs that).
- Steps the user has to do are marked **Checkpoint (user)**. Stop there until the user confirms.
- `Makefile` recipe lines start with a **tab**. Copy the Makefile below exactly, tabs included.

---

### Task 1: `asc.mjs` checks the App Store Connect key

The first thing to know is whether Apple accepts the key, and if it doesn't, why. A 403 about the agreement means the key is fine and the account holder has something to accept.

**Files:**
- Create: `apps/ios/scripts/asc.mjs`
- Test: `apps/ios/scripts/asc.test.mjs`

**Step 1: Write the failing test**

`apps/ios/scripts/asc.test.mjs`:

```js
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import { explain, token } from './asc.mjs';

test('token is an ES256 JWT for App Store Connect that lasts 10 minutes', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwt = token({ keyId: 'KEY123', issuerId: 'issuer-uuid', key: privateKey, now: 1_800_000_000_000 });
  const [header, payload, signature] = jwt.split('.');
  const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());
  assert.deepEqual(decode(header), { alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
  assert.deepEqual(decode(payload), { iss: 'issuer-uuid', iat: 1_800_000_000, exp: 1_800_000_600, aud: 'appstoreconnect-v1' });
  const signed = Buffer.from(`${header}.${payload}`);
  assert.ok(verify('sha256', signed, { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
});

test('explain names the missing agreement behind a 403', () => {
  const detail = 'A required agreement is missing or has expired. This request requires an in-effect agreement that has not been signed or has expired.';
  const message = explain(403, { errors: [{ status: '403', code: 'FORBIDDEN_ERROR', detail }] });
  assert.match(message, /License Agreement is accepted and in effect/);
  assert.ok(message.endsWith(detail));
});

test('explain points at the ids for a 401 and at the role for other 403s', () => {
  assert.match(explain(401, { errors: [{ title: 'Authentication credentials are missing or invalid.' }] }), /ASC_KEY_ID and ASC_ISSUER_ID/);
  assert.match(explain(403, { errors: [{ detail: 'The API key in use does not allow this request' }] }), /Admin role/);
});
```

**Step 2: Run it to see it fail**

```bash
node --test apps/ios/scripts/asc.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` ("Cannot find module …/apps/ios/scripts/asc.mjs").

**Step 3: Write `asc.mjs`**

`apps/ios/scripts/asc.mjs`:

```js
// App Store Connect API for the iOS app, with no dependencies: a JWT signed with node:crypto, and fetch.
//
//   node scripts/asc.mjs check   is the key accepted? Then: bundle id, app record, TestFlight group
//
// Run through the Makefile (`pnpm ios:setup`), which loads ASC_KEY_ID, ASC_ISSUER_ID, APPLE_TEAM_ID and
// IOS_BUNDLE_ID from the repo's .env; CI sets them itself. The key is read from
// ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8. release.mjs builds on the exports.
import { createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const API = 'https://api.appstoreconnect.apple.com';
export const GROUP = 'Household';

/** The settings from the environment, checked; exits with a clear message when one is missing. */
export function config(env = process.env) {
  const missing = ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'APPLE_TEAM_ID', 'IOS_BUNDLE_ID'].filter((name) => !env[name]);
  if (missing.length) fail(`Set ${missing.join(', ')} in the repo's .env (see docs/plans/2026-11-03-ios-conventions.md)`);
  const keyPath = join(homedir(), '.appstoreconnect', 'private_keys', `AuthKey_${env.ASC_KEY_ID}.p8`);
  if (!existsSync(keyPath)) fail(`No App Store Connect key at ${keyPath}`);
  return { keyId: env.ASC_KEY_ID, issuerId: env.ASC_ISSUER_ID, teamId: env.APPLE_TEAM_ID, bundleId: env.IOS_BUNDLE_ID, keyPath };
}

/** The flags that let xcodebuild sign (cloud-managed) and upload with the key instead of an Apple ID. */
export const authFlags = ({ keyPath, keyId, issuerId }) => [
  '-allowProvisioningUpdates',
  '-authenticationKeyPath', keyPath,
  '-authenticationKeyID', keyId,
  '-authenticationKeyIssuerID', issuerId,
];

/** An ES256 JWT for the API. Apple accepts at most 20 minutes; each request makes a fresh one. */
export function token({ keyId, issuerId, key, now = Date.now() }) {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const iat = Math.floor(now / 1000);
  const data = `${b64({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${b64({ iss: issuerId, iat, exp: iat + 600, aud: 'appstoreconnect-v1' })}`;
  return `${data}.${sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

/** What went wrong, in words, from a failed response. */
export function explain(status, body) {
  const said = (body?.errors ?? []).map((e) => e.detail ?? e.title).filter(Boolean).join(' ');
  if (status === 401) return `App Store Connect refused the key (401). Check ASC_KEY_ID and ASC_ISSUER_ID in .env, and that the key isn't revoked. ${said}`.trim();
  if (status === 403 && /agreement/i.test(said)) {
    return (
      'The key works, but App Store Connect refuses API calls (403) until the Apple Developer Program License ' +
      'Agreement is accepted and in effect. The account holder accepts it at developer.apple.com/account and in ' +
      `App Store Connect → Business; it can take a few hours to reach the API. Apple says: ${said}`
    );
  }
  if (status === 403) return `The key isn't allowed to do this (403); it needs the Admin role. Apple says: ${said}`;
  return `App Store Connect answered ${status}. ${said}`.trim();
}

let signingKey;
/**
 * Call the API: `asc('GET', '/v1/apps')`. Resolves to the parsed JSON (null for 204); throws with `explain`.
 * Apple's API has bad minutes, so a GET that fails with a 5xx, a 429 or no answer is tried four more times,
 * 2, 4, 8 and 16 s apart. So is a GET answered 404: a replica that lags behind sometimes says a group it
 * just listed doesn't exist. Changes aren't retried: a failed one may have happened anyway.
 */
export async function asc(method, path, body) {
  const cfg = config();
  signingKey ??= createPrivateKey(readFileSync(cfg.keyPath));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token({ ...cfg, key: signingKey })}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }).catch((err) => err);
    const failed = res instanceof Error || res.status === 404 || res.status === 429 || res.status >= 500;
    if (failed && method === 'GET' && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
      continue;
    }
    if (res instanceof Error) throw new Error(`${method} ${path}: no answer from App Store Connect (${res.cause?.code ?? res.message})`);
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`${method} ${path}: ${explain(res.status, json)}`), { status: res.status });
    return json;
  }
}

const q = encodeURIComponent;

export async function findBundleId(identifier) {
  const { data } = await asc('GET', `/v1/bundleIds?filter[identifier]=${q(identifier)}&filter[platform]=IOS&limit=200`);
  return data.find((b) => b.attributes.identifier === identifier) ?? null;
}

export async function findApp(bundleId) {
  const { data } = await asc('GET', `/v1/apps?filter[bundleId]=${q(bundleId)}`);
  return data.find((a) => a.attributes.bundleId === bundleId) ?? null;
}

export async function findGroup(appId) {
  const { data } = await asc('GET', `/v1/betaGroups?filter[app]=${appId}&filter[name]=${q(GROUP)}`);
  return data.find((g) => g.attributes.name === GROUP) ?? null;
}

async function check() {
  const { keyId, bundleId } = config();
  let ok = true;
  const line = (good, text) => {
    ok &&= good;
    console.log(`${good ? '✓' : '✗'} ${text}`);
  };
  const bundle = await findBundleId(bundleId);
  line(true, `Key ${keyId} accepted by App Store Connect`);
  line(Boolean(bundle), bundle ? `Bundle id ${bundleId} registered` : `Bundle id ${bundleId} not registered: corepack pnpm ios:setup`);
  const app = bundle && (await findApp(bundleId));
  line(Boolean(app), app ? `App record "${app.attributes.name}" (${app.id})` : `No app record for ${bundleId}: create it in App Store Connect`);
  const group = app && (await findGroup(app.id));
  line(Boolean(group), group ? `TestFlight group "${GROUP}" (${group.attributes.hasAccessToAllBuilds ? 'gets every build' : 'builds added one by one'})` : `No TestFlight group "${GROUP}": corepack pnpm ios:setup`);
  if (!ok) process.exitCode = 1;
}

export function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (import.meta.main) {
  const [command] = process.argv.slice(2);
  const commands = { check: () => check() };
  if (!commands[command]) fail('Usage: node scripts/asc.mjs check');
  await commands[command]().catch((err) => fail(err.message));
}
```

**Step 4: Run the tests again**

```bash
node --test apps/ios/scripts/asc.test.mjs
```

Expected: `ℹ pass 3`, `ℹ fail 0`.

**Step 5: Ask Apple**

```bash
node --env-file=.env apps/ios/scripts/asc.mjs check
```

Expected, given the state on 2026-11-03 (exit code 0):

```
✓ Key 43C35X77AJ accepted by App Store Connect
✓ Bundle id me.tracklistme.playarr registered
✓ App record "Playarr" (6830169335)
✓ TestFlight group "Household" (gets every build)
```

On a fresh account, lines 2 to 4 are `✗` and point at the task that fixes them (exit code 1). That is expected until Task 7.

If the agreement isn't in effect, the output is one line, with exit code 1:
`✗ GET /v1/bundleIds?…: The key works, but App Store Connect refuses API calls (403) until the Apple Developer Program License Agreement is accepted and in effect. …`
That means the script works. Tell the user that the account holder has to accept the agreement at developer.apple.com/account and in App Store Connect → Business, and that it can take a few hours to reach the API. Go on with Tasks 2 to 4, which don't need the API, and come back to this step afterwards. A 401 means `ASC_KEY_ID` or `ASC_ISSUER_ID` in `.env` is wrong.

**Step 6: Commit**

```bash
git add apps/ios/scripts/asc.mjs apps/ios/scripts/asc.test.mjs
git commit -m "$(cat <<'EOF'
iOS app: asc.mjs talks to App Store Connect with the API key and checks the key, bundle id, app record and TestFlight group

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Makefile with a pinned XcodeGen, and the `pnpm ios:*` scripts

**Files:**
- Create: `apps/ios/Makefile`
- Modify: `.gitignore`, `package.json`

**Step 1: Ignore what's generated**

Append to `.gitignore`:

```gitignore

# iOS app: the generated Xcode project, the downloaded XcodeGen, build output
apps/ios/.tools/
apps/ios/Playarr.xcodeproj/
apps/ios/build/
apps/ios/Packages/*/.build/
apps/ios/Packages/*/.swiftpm/
*.xcarchive
.DerivedData/
xcuserdata/
```

**Step 2: Write the Makefile** (recipe lines start with a tab)

```make
# Playarr iOS app: every entry point. The root package.json's `pnpm ios:*` scripts call these targets.
#
#   make bootstrap   download the pinned XcodeGen into .tools/ and generate Playarr.xcodeproj
#   make build       simulator build (SIMULATOR="iPad Pro 13-inch (M5)" picks another)
#   make test        the scripts' tests, `swift test` in each package, then the UI tests on a simulator
#   make setup       register the bundle id; once the app record exists, the "Household" TestFlight group
#                    (TESTERS="a@example.com b@example.com" adds those App Store Connect users to it)
#   make beta        test, then archive, upload and hand the build to TestFlight (beta-upload skips the tests)
#   make device      build and install on a paired iPhone (DEVICE="name or UDID" picks one)
#   make clean       remove build output and the generated project
#
# Every target that builds regenerates Playarr.xcodeproj first, so added and removed files are picked up.
# macOS ships GNU Make 3.81: no .ONESHELL or .SHELLFLAGS, so a line with several commands starts with `set -e`.

SHELL := /bin/bash

XCODEGEN_VERSION := 2.46.0
# SHA-256 of that release's xcodegen.zip. On a mismatch the download is deleted and make stops.
XCODEGEN_SHA256 := PUT-THE-SHA-256-HERE
XCODEGEN := .tools/xcodegen-$(XCODEGEN_VERSION)/bin/xcodegen

PACKAGES := PlayarrAPI PlayarrPlayer PlayarrUI
SIMULATOR ?= iPhone 17 Pro
# That simulator's id, or the first available iPhone's when this Xcode has none by that name.
SIMULATOR_ID = $(shell { xcrun simctl list devices available | grep -E '^ +$(SIMULATOR) [(][0-9A-F-]{36}[)]'; xcrun simctl list devices available | grep -E '^ +iPhone'; } | head -1 | grep -oE '[0-9A-F-]{36}')
# -IDEPackageSupportDisableManifestSandbox: SwiftPM can't sandbox package manifests inside another sandbox (Claude's shell).
XCODEBUILD = xcodebuild -project Playarr.xcodeproj -scheme Playarr -derivedDataPath build/DerivedData \
  -IDEPackageSupportDisableManifestSandbox=YES -destination 'platform=iOS Simulator,id=$(SIMULATOR_ID)' \
  CURRENT_PROJECT_VERSION=$$(git rev-list --count HEAD)
# The repo's .env has ASC_KEY_ID, ASC_ISSUER_ID, APPLE_TEAM_ID and IOS_BUNDLE_ID; CI sets them itself.
NODE = node --env-file-if-exists=../../.env

.PHONY: bootstrap tools project build test test-scripts test-packages test-app setup beta beta-upload device clean

bootstrap: project

tools: $(XCODEGEN)

$(XCODEGEN):
	mkdir -p .tools && rm -rf .tools/xcodegen .tools/xcodegen.zip
	curl -fsSL -o .tools/xcodegen.zip https://github.com/yonaskolb/XcodeGen/releases/download/$(XCODEGEN_VERSION)/xcodegen.zip
	@actual=$$(shasum -a 256 .tools/xcodegen.zip | cut -d ' ' -f 1); \
	if [ "$$actual" != "$(XCODEGEN_SHA256)" ]; then \
	  rm -f .tools/xcodegen.zip; \
	  echo "xcodegen.zip $(XCODEGEN_VERSION) has SHA-256 $$actual; the Makefile expects $(XCODEGEN_SHA256)" >&2; \
	  exit 1; \
	fi
	unzip -q .tools/xcodegen.zip -d .tools && mv .tools/xcodegen .tools/xcodegen-$(XCODEGEN_VERSION) && rm .tools/xcodegen.zip

project: $(XCODEGEN)
	$(XCODEGEN) generate --spec project.yml --quiet

build: project
	$(XCODEBUILD) build

test: test-scripts test-packages test-app

test-scripts:
	node --test 'scripts/*.test.mjs'

# --disable-sandbox: as above, for `swift test`.
test-packages:
	@set -e; for p in $(PACKAGES); do echo "▸ swift test $$p"; swift test --disable-sandbox --package-path Packages/$$p; done

test-app: project
	$(XCODEBUILD) test

setup:
	$(NODE) scripts/asc.mjs setup $(TESTERS)

beta: test
	$(MAKE) beta-upload

beta-upload: project
	$(NODE) scripts/release.mjs beta

device: project
	$(NODE) scripts/release.mjs device

clean:
	rm -rf build Playarr.xcodeproj Packages/*/.build
```

**Step 3: Add the scripts to the root `package.json`**

In `"scripts"`, replace

```json
    "sim": "node scripts/ios-sim/sim.mjs"
```

with

```json
    "sim": "node scripts/ios-sim/sim.mjs",
    "ios:bootstrap": "make -C apps/ios bootstrap",
    "ios:build": "make -C apps/ios build",
    "ios:test": "make -C apps/ios test",
    "ios:setup": "make -C apps/ios setup",
    "ios:beta": "make -C apps/ios beta",
    "ios:device": "make -C apps/ios device"
```

Don't touch the `"version"` line (the hook owns it). `ios:models` and `ios:release` are added by phases 2 and 11, which build them.

**Step 4: Run the download and see the checksum stop it**

```bash
make -C apps/ios tools
```

Expected: FAIL, with
`xcodegen.zip 2.46.0 has SHA-256 <64 hex digits>; the Makefile expects PUT-THE-SHA-256-HERE`
and `make: *** [.tools/xcodegen-2.46.0/bin/xcodegen] Error 1`. The download is deleted.

**Step 5: Check the checksum, then fill it in**

The value printed must be the one seen when this plan was written:
`4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806`.
Check it against GitHub's own record of the asset too. The API allows 60 requests an hour without a token; if it's rate-limited, say so and rely on the value above.

```bash
curl -s https://api.github.com/repos/yonaskolb/XcodeGen/releases/tags/2.46.0 \
  | node -e "const r = JSON.parse(require('fs').readFileSync(0, 'utf8')); console.log(r.assets?.find((a) => a.name === 'xcodegen.zip')?.digest ?? r.message)"
```

Expected: `sha256:4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806`. If any of the three values differ, stop and tell the user: don't fill anything in. If they match:

```bash
sed -i '' 's/^XCODEGEN_SHA256 := .*/XCODEGEN_SHA256 := 4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806/' apps/ios/Makefile
```

**Step 6: Run it again**

```bash
make -C apps/ios tools && apps/ios/.tools/xcodegen-2.46.0/bin/xcodegen --version
make -C apps/ios test-scripts 2>&1 | grep -E 'ℹ (pass|fail)'
git status --porcelain --ignored apps/ios
```

Expected: `Version: 2.46.0`; `ℹ pass 3` and `ℹ fail 0`; `git status` lists `?? apps/ios/Makefile` (and Task 1's files, if not yet committed) and `!! apps/ios/.tools/`.

**Step 7: Commit**

```bash
git add .gitignore package.json apps/ios/Makefile
git commit -m "$(cat <<'EOF'
iOS app: Makefile with every entry point and a pinned, checksummed XcodeGen; pnpm ios:* scripts

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The three Swift packages, each with a placeholder and a test

The dependencies go `PlayarrUI → PlayarrPlayer → PlayarrAPI`. `PlayarrUI` also imports `PlayarrAPI` directly, so it declares that dependency itself. The packages also declare macOS 26, so `swift test` runs on the Mac.

**Files:**
- Create: `apps/ios/Packages/PlayarrAPI/Package.swift`, `apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/AppVersion.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Package.swift`, `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerPlaceholder.swift`
- Create: `apps/ios/Packages/PlayarrUI/Package.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/RootView.swift`
- Test: `apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/AppVersionTests.swift`, `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerPlaceholderTests.swift`, `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RootViewTests.swift`

**Step 1: Write the package manifests**

`apps/ios/Packages/PlayarrAPI/Package.swift`:

```swift
// swift-tools-version: 6.2
// Talking to Playarr servers: models, the API client, servers and accounts. No dependencies.
import PackageDescription

let package = Package(
  name: "PlayarrAPI",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [.library(name: "PlayarrAPI", targets: ["PlayarrAPI"])],
  targets: [
    .target(name: "PlayarrAPI"),
    .testTarget(name: "PlayarrAPITests", dependencies: ["PlayarrAPI"]),
  ]
)
```

`apps/ios/Packages/PlayarrPlayer/Package.swift`:

```swift
// swift-tools-version: 6.2
// Playback: queue, audio engine, levels, transitions, plays, Now Playing, downloads.
import PackageDescription

let package = Package(
  name: "PlayarrPlayer",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [.library(name: "PlayarrPlayer", targets: ["PlayarrPlayer"])],
  dependencies: [.package(path: "../PlayarrAPI")],
  targets: [
    .target(name: "PlayarrPlayer", dependencies: ["PlayarrAPI"]),
    .testTarget(name: "PlayarrPlayerTests", dependencies: ["PlayarrPlayer"]),
  ]
)
```

`apps/ios/Packages/PlayarrUI/Package.swift`:

```swift
// swift-tools-version: 6.2
// Every screen and component of the app.
import PackageDescription

let package = Package(
  name: "PlayarrUI",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [.library(name: "PlayarrUI", targets: ["PlayarrUI"])],
  dependencies: [.package(path: "../PlayarrAPI"), .package(path: "../PlayarrPlayer")],
  targets: [
    .target(name: "PlayarrUI", dependencies: ["PlayarrAPI", "PlayarrPlayer"]),
    .testTarget(name: "PlayarrUITests", dependencies: ["PlayarrUI"]),
  ]
)
```

(`// swift-tools-version` must stay the first line of each manifest.)

**Step 2: Write the failing tests**

`apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/AppVersionTests.swift`:

```swift
import PlayarrAPI
import Testing

@Test func labelShowsTheMarketingVersionAndTheBuild() {
  let version = AppVersion(infoDictionary: ["CFBundleShortVersionString": "1.0.0", "CFBundleVersion": "812"])
  #expect(version.label == "1.0.0 (812)")
}

@Test func missingKeysReadAsZero() {
  #expect(AppVersion(infoDictionary: [:]).label == "0.0.0 (0)")
}
```

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerPlaceholderTests.swift`:

```swift
import PlayarrPlayer
import Testing

@Test func nothingIsPlayingYet() {
  #expect(PlayerPlaceholder.status == "Nothing playing")
}
```

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RootViewTests.swift`:

```swift
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor
@Test func showsTheVersionAndBuild() {
  let view = RootView(version: AppVersion(marketing: "1.0.0", build: "812"))
  #expect(view.versionText == "Version 1.0.0 (812)")
}
```

**Step 3: Run them to see them fail**

```bash
make -C apps/ios test-packages
```

Expected: FAIL at the first package with `error: 'playarrapi': target 'PlayarrAPI' referenced in product 'PlayarrAPI' is empty`.

**Step 4: Write the placeholder types**

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/AppVersion.swift`:

```swift
import Foundation

/// The app's version as people see it, "1.0.0 (812)": the marketing version and the build number.
public struct AppVersion: Sendable, Equatable {
  public let marketing: String
  public let build: String

  public init(marketing: String, build: String) {
    self.marketing = marketing
    self.build = build
  }

  /// Reads `CFBundleShortVersionString` and `CFBundleVersion`, as found in `Bundle.main.infoDictionary`.
  public init(infoDictionary: [String: Any]) {
    self.init(
      marketing: infoDictionary["CFBundleShortVersionString"] as? String ?? "0.0.0",
      build: infoDictionary["CFBundleVersion"] as? String ?? "0"
    )
  }

  public var label: String { "\(marketing) (\(build))" }
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerPlaceholder.swift`:

```swift
/// Stands in for the player until phase 3 builds it (and deletes this file), so the package has
/// something to compile and test.
public enum PlayerPlaceholder {
  public static let status = "Nothing playing"
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/RootView.swift`:

```swift
import Foundation
import PlayarrAPI
import SwiftUI

/// The app's only screen in phase 0: its name and the version installed.
public struct RootView: View {
  let version: AppVersion

  public init(version: AppVersion = AppVersion(infoDictionary: Bundle.main.infoDictionary ?? [:])) {
    self.version = version
  }

  var versionText: String { "Version \(version.label)" }

  public var body: some View {
    VStack(spacing: 8) {
      Text("Playarr")
        .font(.largeTitle.bold())
      Text(versionText)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("version")
    }
  }
}
```

**Step 5: Run the tests again**

```bash
make -C apps/ios test-packages 2>&1 | grep -E '▸ swift test|Test run with'
```

Expected:

```
▸ swift test PlayarrAPI
✔ Test run with 2 tests in 0 suites passed after … seconds.
▸ swift test PlayarrPlayer
✔ Test run with 1 test in 0 suites passed after … seconds.
▸ swift test PlayarrUI
✔ Test run with 1 test in 0 suites passed after … seconds.
```

`git status --porcelain apps/ios/Packages` must not list any `.build/` folder (it's ignored).

**Step 6: Commit**

```bash
git add apps/ios/Packages
git commit -m "$(cat <<'EOF'
iOS app: the PlayarrAPI, PlayarrPlayer and PlayarrUI packages, each with a placeholder and a Swift Testing test

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The app target, its UI test, and the project spec

The app is one screen: `RootView` from `PlayarrUI`. The UI test launches it on the simulator and reads the name and version. The icon is the web app's (`apps/web/public/icon.svg`), drawn at 1024 px with no transparency (App Store Connect rejects an icon with an alpha channel). iOS rounds the corners itself.

**Files:**
- Create: `apps/ios/project.yml`
- Create: `apps/ios/Config/Base.xcconfig`, `apps/ios/Config/Info.plist`, `apps/ios/Config/Playarr.entitlements`
- Create: `apps/ios/Playarr/PlayarrApp.swift`
- Create: `apps/ios/Playarr/Assets.xcassets/Contents.json`, `apps/ios/Playarr/Assets.xcassets/AppIcon.appiconset/Contents.json`, `apps/ios/Playarr/Assets.xcassets/AppIcon.appiconset/AppIcon.png`, `apps/ios/Playarr/Assets.xcassets/AccentColor.colorset/Contents.json`
- Test: `apps/ios/PlayarrUITests/LaunchTests.swift`

**Step 1: Write the UI test**

`apps/ios/PlayarrUITests/LaunchTests.swift`:

```swift
import XCTest

final class LaunchTests: XCTestCase {
  @MainActor
  func testLaunchShowsTheNameAndVersion() {
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.staticTexts["Playarr"].waitForExistence(timeout: 10))
    let version = app.staticTexts["version"]
    XCTAssertTrue(version.exists)
    XCTAssertTrue(version.label.hasPrefix("Version 1.0.0 ("), version.label)
  }
}
```

**Step 2: Write the XcodeGen spec**

```yaml
# XcodeGen spec for the Playarr app: `make bootstrap` (or any make target) generates Playarr.xcodeproj
# from this file. The .xcodeproj is not committed. Versions, team and bundle id: Config/Base.xcconfig.
name: Playarr
options:
  deploymentTarget:
    iOS: "26.0"
  developmentLanguage: en
  createIntermediateGroups: true
  groupSortPosition: top
configFiles:
  Debug: Config/Base.xcconfig
  Release: Config/Base.xcconfig
settings:
  base:
    SWIFT_VERSION: "6.0"
    ENABLE_USER_SCRIPT_SANDBOXING: YES
    DEAD_CODE_STRIPPING: YES
packages:
  PlayarrAPI:
    path: Packages/PlayarrAPI
    group: Packages
  PlayarrPlayer:
    path: Packages/PlayarrPlayer
    group: Packages
  PlayarrUI:
    path: Packages/PlayarrUI
    group: Packages
targets:
  Playarr:
    type: application
    platform: iOS
    sources:
      - Playarr
      - path: Config
        buildPhase: none
    dependencies:
      - package: PlayarrUI
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: $(PLAYARR_BUNDLE_ID)
        TARGETED_DEVICE_FAMILY: "1,2"
        INFOPLIST_FILE: Config/Info.plist
        CODE_SIGN_ENTITLEMENTS: Config/Playarr.entitlements
        ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME: AccentColor
  PlayarrUITests:
    type: bundle.ui-testing
    platform: iOS
    sources:
      - PlayarrUITests
    dependencies:
      - target: Playarr
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: $(PLAYARR_BUNDLE_ID).uitests
        GENERATE_INFOPLIST_FILE: YES
schemes:
  Playarr:
    build:
      targets:
        Playarr: all
        PlayarrUITests: [test]
    test:
      config: Debug
      targets:
        - PlayarrUITests
    run:
      config: Debug
    archive:
      config: Release
```

XcodeGen's presets put `SWIFT_VERSION = 5.0` in the project's own build settings, and those override the xcconfig. That's why `SWIFT_VERSION` is set in `project.yml`. Versions, team and bundle id stay in the xcconfig, which no preset touches.

**Step 3: Write the configuration files**

`apps/ios/Config/Base.xcconfig`:

```
// Settings every target and configuration shares (project.yml points both configurations here).
// MARKETING_VERSION changes only for App Store releases. CURRENT_PROJECT_VERSION is the build number:
// the Makefile and scripts/release.mjs pass `git rev-list --count HEAD`; 1 is for builds from Xcode.
MARKETING_VERSION = 1.0.0
CURRENT_PROJECT_VERSION = 1
PLAYARR_BUNDLE_ID = me.tracklistme.playarr
DEVELOPMENT_TEAM = M7ME2TS45S
CODE_SIGN_STYLE = Automatic
```

`apps/ios/Config/Info.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>$(DEVELOPMENT_LANGUAGE)</string>
	<key>CFBundleDisplayName</key>
	<string>Playarr</string>
	<key>CFBundleExecutable</key>
	<string>$(EXECUTABLE_NAME)</string>
	<key>CFBundleIdentifier</key>
	<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>$(PRODUCT_NAME)</string>
	<key>CFBundlePackageType</key>
	<string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
	<key>CFBundleShortVersionString</key>
	<string>$(MARKETING_VERSION)</string>
	<key>CFBundleVersion</key>
	<string>$(CURRENT_PROJECT_VERSION)</string>
	<key>ITSAppUsesNonExemptEncryption</key>
	<false/>
	<key>LSRequiresIPhoneOS</key>
	<true/>
	<key>UIApplicationSceneManifest</key>
	<dict>
		<key>UIApplicationSupportsMultipleScenes</key>
		<false/>
	</dict>
	<key>UIBackgroundModes</key>
	<array>
		<string>audio</string>
	</array>
	<key>UILaunchScreen</key>
	<dict/>
	<key>UISupportedInterfaceOrientations</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
		<string>UIInterfaceOrientationLandscapeLeft</string>
		<string>UIInterfaceOrientationLandscapeRight</string>
	</array>
	<key>UISupportedInterfaceOrientations~ipad</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
		<string>UIInterfaceOrientationPortraitUpsideDown</string>
		<string>UIInterfaceOrientationLandscapeLeft</string>
		<string>UIInterfaceOrientationLandscapeRight</string>
	</array>
</dict>
</plist>
```

`apps/ios/Config/Playarr.entitlements` is empty on purpose. Later capabilities go here.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict/>
</plist>
```

**Step 4: Write the app and its assets**

`apps/ios/Playarr/PlayarrApp.swift`:

```swift
import PlayarrUI
import SwiftUI

@main
struct PlayarrApp: App {
  var body: some Scene {
    WindowGroup {
      RootView()
    }
  }
}
```

`apps/ios/Playarr/Assets.xcassets/Contents.json`:

```json
{
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
```

`apps/ios/Playarr/Assets.xcassets/AppIcon.appiconset/Contents.json`:

```json
{
  "images" : [
    {
      "filename" : "AppIcon.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
```

`apps/ios/Playarr/Assets.xcassets/AccentColor.colorset/Contents.json` (the web's default accent, `#ff7a1a`):

```json
{
  "colors" : [
    {
      "color" : {
        "color-space" : "srgb",
        "components" : {
          "alpha" : "1.000",
          "blue" : "0x1A",
          "green" : "0x7A",
          "red" : "0xFF"
        }
      },
      "idiom" : "universal"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
```

Draw the icon with a one-off Swift script. It lives in `/tmp` and isn't committed; only the PNG is.

```bash
mkdir -p /tmp/playarr-icon
cat > /tmp/playarr-icon/icon.swift <<'EOF'
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// The web app's icon (apps/web/public/icon.svg) at 1024 px, square and opaque: iOS rounds the corners.
let size = 1024, scale = CGFloat(size) / 512
let rgb = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: rgb,
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}
func circle(_ r: CGFloat) -> CGRect { CGRect(x: (256 - r) * scale, y: (256 - r) * scale, width: 2 * r * scale, height: 2 * r * scale) }
ctx.setFillColor(color(0x0f0e0c)); ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))
ctx.setLineWidth(2 * scale)
for (r, a) in [(168.0, 0.14), (136.0, 0.10), (104.0, 0.08)] { ctx.setStrokeColor(color(0xece6dc, a)); ctx.strokeEllipse(in: circle(r)) }
ctx.setFillColor(color(0xff7a1a)); ctx.fillEllipse(in: circle(64))
ctx.setFillColor(color(0x0f0e0c)); ctx.fillEllipse(in: circle(10))
let out = URL(fileURLWithPath: CommandLine.arguments[1])
let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
precondition(CGImageDestinationFinalize(dest))
EOF
swift /tmp/playarr-icon/icon.swift apps/ios/Playarr/Assets.xcassets/AppIcon.appiconset/AppIcon.png
sips -g pixelWidth -g pixelHeight -g hasAlpha apps/ios/Playarr/Assets.xcassets/AppIcon.appiconset/AppIcon.png
```

Expected: `pixelWidth: 1024`, `pixelHeight: 1024`, `hasAlpha: no`. Look at the PNG (Read it): a near-black square with three faint rings and an orange disc with a dark centre.

**Step 5: Generate the project**

```bash
corepack pnpm ios:bootstrap
ls apps/ios/Playarr.xcodeproj
```

Expected: the last line printed is `.tools/xcodegen-2.46.0/bin/xcodegen generate --spec project.yml --quiet`, and the listing shows `project.pbxproj`, `project.xcworkspace` and `xcshareddata`.

**Step 6: Build for the simulator**

```bash
corepack pnpm ios:build 2>&1 | grep -E '\*\* BUILD'
```

Expected: `** BUILD SUCCEEDED **`. No signing setup is needed for the simulator.

**Step 7: Run every test**

```bash
corepack pnpm ios:test 2>&1 | grep -E 'ℹ (pass|fail)|Test run with|Executed 1 test|\*\* TEST' | sort -u
```

Expected (the first run boots the simulator and takes a minute or two longer; the `Executed` line can appear up to three times):

```
	 Executed 1 test, with 0 failures (0 unexpected) in … seconds
** TEST SUCCEEDED **
ℹ fail 0
ℹ pass 3
✔ Test run with 1 test in 0 suites passed after … seconds.
✔ Test run with 2 tests in 0 suites passed after … seconds.
```

Lines like `attempt to post distributed notification … thwarted by sandboxing` and stack traces from `Xcode3Core` are noise from Claude's sandbox; the result line is what counts.

**Step 8: Look at it**

```bash
app=apps/ios/build/DerivedData/Build/Products/Debug-iphonesimulator/Playarr.app
plutil -p "$app/Info.plist" | grep -E 'CFBundle(ShortVersionString|Version)"|CFBundleIdentifier"|ITSAppUses'
xcrun simctl boot "iPhone 17 Pro" 2>/dev/null; xcrun simctl install "iPhone 17 Pro" "$app"
xcrun simctl launch "iPhone 17 Pro" me.tracklistme.playarr
sleep 2; xcrun simctl io "iPhone 17 Pro" screenshot /tmp/playarr-ios.png
```

Expected: `CFBundleShortVersionString => "1.0.0"`, `CFBundleVersion =>` the commit count (`git rev-list --count HEAD`), `CFBundleIdentifier => "me.tracklistme.playarr"` and `ITSAppUsesNonExemptEncryption => false`. Read `/tmp/playarr-ios.png`: "Playarr" in large bold type, with "Version 1.0.0 (N)" under it.

**Step 9: Commit**

```bash
git add apps/ios/project.yml apps/ios/Config apps/ios/Playarr apps/ios/PlayarrUITests
git commit -m "$(cat <<'EOF'
iOS app: XcodeGen project, an app that shows its name and version, and a UI test that launches it

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `pnpm ios:setup` registers the bundle id and the TestFlight group

`setup` is safe to run again and again. It registers the bundle id if it's missing and stops if there's no app record yet (Task 6). Once there is one, it creates the internal group "Household" with automatic distribution (`hasAccessToAllBuilds`) and adds any testers given.

**Files:**
- Modify: `apps/ios/scripts/asc.mjs`

**Step 1: Document the command.** In the header comment, replace

```js
//   node scripts/asc.mjs check   is the key accepted? Then: bundle id, app record, TestFlight group
```

with

```js
//   node scripts/asc.mjs check             is the key accepted? Then: bundle id, app record, TestFlight group
//   node scripts/asc.mjs setup [email...]  register the bundle id; once the app record exists, create the
//                                          internal TestFlight group "Household" and add those testers to it
```

**Step 2: Add `setup`** right above `export function fail(message) {`:

```js
async function setup(testers) {
  const { bundleId } = config();
  // Background audio and background downloads are Info.plist keys (UIBackgroundModes), not App ID
  // capabilities, so the bundle id needs no capability registered.
  if (await findBundleId(bundleId)) console.log(`✓ Bundle id ${bundleId} already registered`);
  else {
    await asc('POST', '/v1/bundleIds', { data: { type: 'bundleIds', attributes: { identifier: bundleId, name: 'Playarr', platform: 'IOS' } } });
    console.log(`✓ Registered bundle id ${bundleId}`);
  }

  const app = await findApp(bundleId);
  if (!app) {
    console.log(`… No app record yet. Create it in App Store Connect (plan: docs/plans/2026-11-03-ios-phase0-pipeline.md), then run this again.`);
    return;
  }
  let group = await findGroup(app.id);
  // A lagging replica sometimes lists no groups for a while. Ask twice more before creating one, so a stale
  // answer doesn't make a second "Household".
  for (let tries = 0; !group && tries < 2; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    group = await findGroup(app.id);
  }
  if (group) console.log(`✓ TestFlight group "${GROUP}" already exists`);
  else {
    ({ data: group } = await asc('POST', '/v1/betaGroups', {
      data: {
        type: 'betaGroups',
        attributes: { name: GROUP, isInternalGroup: true, hasAccessToAllBuilds: true },
        relationships: { app: { data: { type: 'apps', id: app.id } } },
      },
    }));
    console.log(`✓ Created the internal TestFlight group "${GROUP}", which gets every build`);
  }

  const { data: members } = await asc('GET', `/v1/betaGroups/${group.id}/betaTesters?limit=200`);
  const have = new Set(members.map((t) => t.attributes.email?.toLowerCase()));
  for (const email of testers) {
    if (have.has(email.toLowerCase())) {
      console.log(`✓ ${email} already in "${GROUP}"`);
      continue;
    }
    // Internal groups only take people who are App Store Connect users of the team.
    await asc('POST', '/v1/betaTesters', {
      data: { type: 'betaTesters', attributes: { email }, relationships: { betaGroups: { data: [{ type: 'betaGroups', id: group.id }] } } },
    });
    console.log(`✓ Added ${email} to "${GROUP}"`);
  }
}

```

**Step 3: Wire it in.** Replace

```js
  const [command] = process.argv.slice(2);
  const commands = { check: () => check() };
  if (!commands[command]) fail('Usage: node scripts/asc.mjs check');
```

with

```js
  const [command, ...args] = process.argv.slice(2);
  const commands = { check: () => check(), setup: () => setup(args) };
  if (!commands[command]) fail('Usage: node scripts/asc.mjs check | setup [tester email...]');
```

**Step 4: The tests still pass**

```bash
make -C apps/ios test-scripts 2>&1 | grep -E 'ℹ (pass|fail)'
```

Expected: `ℹ pass 3`, `ℹ fail 0`.

**Step 5: Run it**

```bash
corepack pnpm ios:setup
```

Expected today, with everything already there:

```
✓ Bundle id me.tracklistme.playarr already registered
✓ TestFlight group "Household" already exists
```

On a fresh account it prints `✓ Registered bundle id me.tracklistme.playarr`, then `… No app record yet. Create it in App Store Connect (…), then run this again.`. Go to Task 6 in that case.

**Step 6: Commit**

```bash
git add apps/ios/scripts/asc.mjs
git commit -m "$(cat <<'EOF'
iOS app: pnpm ios:setup registers the bundle id and creates the Household TestFlight group

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Checkpoint (user): the app record in App Store Connect

The API can't create apps. As of 2026-11-03 the record already exists. Check first:

```bash
node --env-file=.env apps/ios/scripts/asc.mjs check
```

If line 3 reads `✓ App record "Playarr" (…)`, skip to Task 7. Otherwise, ask the user to do the following, signed in as the account holder or an Admin:

1. Open https://appstoreconnect.apple.com/apps.
2. Click the blue **+** next to "Apps", then **New App**.
3. **Platforms:** tick **iOS** only.
4. **Name:** `Playarr`. Names are unique across the whole App Store; if it's taken, use `Playarr Music` and tell Claude, so that `CFBundleDisplayName` stays `Playarr` while the store name differs.
5. **Primary Language:** **English (U.S.)**, to match the en-US store text the conventions plan for.
6. **Bundle ID:** pick **Playarr – me.tracklistme.playarr** from the menu. If it isn't listed, Task 5 didn't register it: run `corepack pnpm ios:setup` and reload the page.
7. **SKU:** `playarr-ios`.
8. **User Access:** **Full Access**.
9. Click **Create**.

Then run `check` again. Expected: line 3 reads `✓ App record "Playarr" (<Apple id>)`. Nothing to commit.

---

### Task 7: The "Household" group and its testers

Internal testers have to be **App Store Connect users** of the team, with any role. To add someone from the household who isn't one yet, the account holder invites them first under App Store Connect → Users and Access → **+**. The least access is a role like Customer Support, with access to Playarr only. They accept the email invitation, and then they can be added here.

**Step 1: Ask the user** for the email address of each person to add. Use the address of their App Store Connect user, which is the Apple ID they'll use in TestFlight.

**Step 2: Create the group (if needed) and add them**

```bash
corepack pnpm ios:setup TESTERS="first@example.com second@example.com"
```

Expected:

```
✓ Bundle id me.tracklistme.playarr already registered
✓ TestFlight group "Household" already exists
✓ Added first@example.com to "Household"
✓ Added second@example.com to "Household"
```

The second line reads `✓ Created the internal TestFlight group "Household", which gets every build` the first time on a fresh account. People already in the group print `✓ … already in "Household"`.

**Step 3: If the API refuses to create the group or add a tester.** This is the part of the plan whose API behaviour is least certain; see "Uncertainties". Ask the user to do it by hand instead:
App Store Connect → Apps → Playarr → **TestFlight** → in the sidebar, **Internal Testing** → **+** → name `Household`, tick **Enable automatic distribution** → **Create**. Then in the group: **Testers** → **+** → tick the people → **Add**.

**Step 4: Check**

```bash
node --env-file=.env --input-type=module -e "import { asc, findApp, findGroup } from './apps/ios/scripts/asc.mjs'; const group = await findGroup((await findApp(process.env.IOS_BUNDLE_ID)).id); console.log('automatic distribution:', group.attributes.hasAccessToAllBuilds); const { data } = await asc('GET', '/v1/betaGroups/' + group.id + '/betaTesters?fields[betaTesters]=email,state'); for (const t of data) console.log(t.attributes.email, t.attributes.state)"
```

Expected: `automatic distribution: true`, then one line per person. The state is `NOT_INVITED` until the first build arrives; the invitations go out with it. Nothing to commit.

---

### Task 8 (optional): `pnpm ios:device` installs on a cabled phone, which registers it

Only for a phone that can be cabled and paired to this Mac. TestFlight doesn't need it: Task 9 works with no registered device (see "Key decisions"). The code is written and committed anyway, because it's cheap. Skip Steps 1, 2 and 4 to 6 when there's no phone to connect.

**Files:**
- Create: `apps/ios/scripts/release.mjs`

**Step 1: Checkpoint (user): get the phone ready.** Connect the iPhone to the Mac with a cable. Unlock it and tap **Trust** (enter the passcode). Turn on **Settings → Privacy & Security → Developer Mode** (the phone restarts; after the restart, tap **Turn On**). Keep the phone unlocked and connected for this task.

**Step 2: See that the Mac sees it**

```bash
xcrun devicectl list devices
```

Expected: a row with the phone's name, model iPhone…, and state `available (paired)` or `connected`. The simulators listed alongside it don't count. If the phone isn't there, try Terminal (see Conventions).

**Step 3: Write `release.mjs`** with the `device` command (Task 9 adds `beta`):

`apps/ios/scripts/release.mjs`:

```js
// Release flows for the iOS app, on top of xcodebuild and asc.mjs.
//
//   node scripts/release.mjs device   build and install on a paired iPhone (DEVICE="name or UDID" picks one)
//
// Run through the Makefile (`pnpm ios:device`), which loads the repo's .env. The build number is
// `git rev-list --count HEAD`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authFlags, config, fail } from './asc.mjs';

const IOS = fileURLToPath(new URL('..', import.meta.url));
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: IOS, encoding: 'utf8' }).trim();
const xcodebuild = (args) =>
  execFileSync('xcodebuild', ['-project', 'Playarr.xcodeproj', '-IDEPackageSupportDisableManifestSandbox=YES', ...args], { cwd: IOS, stdio: 'inherit' });

async function device() {
  const cfg = config();
  const tmp = mkdtempSync(join(tmpdir(), 'playarr-devices-'));
  let devices;
  try {
    execFileSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', join(tmp, 'devices.json')], { stdio: 'ignore' });
    devices = JSON.parse(readFileSync(join(tmp, 'devices.json'), 'utf8')).result.devices;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  // devicectl also lists simulators ("simulated"); only paired physical iPhones and iPads will do.
  const phones = devices.filter(
    (d) => d.hardwareProperties?.platform === 'iOS' && d.hardwareProperties?.reality === 'physical' && d.connectionProperties?.pairingState === 'paired',
  );
  const wanted = process.env.DEVICE;
  const phone = wanted
    ? phones.find((d) => [d.deviceProperties?.name, d.hardwareProperties?.udid].includes(wanted))
    : phones.find((d) => d.connectionProperties?.tunnelState !== 'unavailable');
  if (!phone) fail(`No paired iPhone${wanted ? ` called ${wanted}` : ''} is reachable. Connect it by cable once, tap Trust, and turn on Developer Mode.`);
  const udid = phone.hardwareProperties.udid;
  const build = sh('git', ['rev-list', '--count', 'HEAD']);

  step(`Building for ${phone.deviceProperties.name}`);
  xcodebuild([
    'build', '-scheme', 'Playarr', '-configuration', 'Debug', '-destination', `id=${udid}`, '-derivedDataPath', 'build/DerivedData', '-quiet',
    `CURRENT_PROJECT_VERSION=${build}`, ...authFlags(cfg), '-allowProvisioningDeviceRegistration',
  ]);

  step('Installing');
  const appPath = join(IOS, 'build/DerivedData/Build/Products/Debug-iphoneos/Playarr.app');
  execFileSync('xcrun', ['devicectl', 'device', 'install', 'app', '--device', udid, appPath], { stdio: 'inherit' });
  try {
    execFileSync('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', udid, cfg.bundleId], { stdio: 'inherit' });
  } catch {
    console.log('  Installed. Unlock the phone and open Playarr.');
  }
}

function step(message) {
  console.log(`\n▸ ${message}`);
}

if (import.meta.main) {
  const commands = { device };
  const command = commands[process.argv[2]] ?? (() => fail('Usage: node scripts/release.mjs device'));
  await command().catch((err) => fail(err.message));
}
```

**Step 4: Run it**

```bash
corepack pnpm ios:device
```

Expected (the first time takes a few minutes: xcodebuild registers the phone and creates an Apple Development certificate and a profile through the key):

```
▸ Building for <phone name>
▸ Installing
… App installed: …
… Launched application with me.tracklistme.playarr bundle identifier.
```

If the phone is locked when it launches, the script prints `Installed. Unlock the phone and open Playarr.` instead. If it fails on signing, see the table in Task 9, Step 8.

**Step 5: Checkpoint (user):** Playarr is on the home screen and shows "Playarr" and "Version 1.0.0 (N)".

**Step 6: Check that the phone is registered**

```bash
node --env-file=.env --input-type=module -e "import { asc } from './apps/ios/scripts/asc.mjs'; const { data } = await asc('GET', '/v1/devices?fields[devices]=name,deviceClass,status'); for (const d of data) console.log(d.attributes.name, d.attributes.deviceClass, d.attributes.status)"
```

Expected: `<phone name> IPHONE ENABLED`.

**Step 7: Commit**

```bash
git add apps/ios/scripts/release.mjs
git commit -m "$(cat <<'EOF'
iOS app: pnpm ios:device builds and installs on a paired iPhone, registering it with Apple

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `pnpm ios:beta` uploads to TestFlight

`beta` checks the build number against the last upload and archives **unsigned**. `xcodebuild -exportArchive` (destination `export`) then signs the app with Apple's cloud-managed distribution certificate and an App Store profile through the key, and `xcrun altool --upload-app` uploads the `.ipa` with the same key. No registered device is needed (see "Key decisions"). It then waits until App Store Connect reports the build `VALID` and sets "What to Test" from the commit subjects since the last build. Finally it makes sure "Household" gets the build: with automatic distribution that happens by itself, otherwise the script adds the build to the group. `ITSAppUsesNonExemptEncryption = NO` in the Info.plist answers the export-compliance question, so the build doesn't wait on "Missing Compliance".

**Files:**
- Modify: `apps/ios/scripts/release.mjs` (replaced as a whole)
- Test: `apps/ios/scripts/release.test.mjs`

**Step 1: Write the failing test**

`apps/ios/scripts/release.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportOptions, whatsNew } from './release.mjs';

test('whatsNew lists the commit subjects, without merges', () => {
  assert.equal(
    whatsNew(['Show the version on the first screen', "Merge branch 'main' of https://github.com/nicolabortignon/playarr", 'Upload builds to TestFlight']),
    '- Show the version on the first screen\n- Upload builds to TestFlight',
  );
});

test('whatsNew keeps to 25 lines and says how many it left out', () => {
  const notes = whatsNew(Array.from({ length: 30 }, (_, i) => `Change ${i + 1}`));
  assert.equal(notes.split('\n').length, 26);
  assert.ok(notes.endsWith('- Change 25\n…and 5 more'));
});

test('whatsNew stays under App Store Connect’s 4000 characters', () => {
  assert.ok(whatsNew(Array.from({ length: 25 }, () => 'x'.repeat(300))).length <= 4000);
});

test('whatsNew says so when only merges came in', () => {
  assert.equal(whatsNew(["Merge branch 'main'"]), 'No changes since the last build.');
});

test('exportOptions signs for the App Store and writes an .ipa, keeping our build number', () => {
  const plist = exportOptions('TEAM123');
  for (const [key, value] of [['method', 'app-store-connect'], ['destination', 'export'], ['signingStyle', 'automatic'], ['teamID', 'TEAM123']]) {
    assert.ok(plist.includes(`<key>${key}</key><string>${value}</string>`), `${key} = ${value}`);
  }
  assert.ok(plist.includes('<key>manageAppVersionAndBuildNumber</key><false/>'));
});
```

**Step 2: Run it to see it fail**

```bash
node --test apps/ios/scripts/release.test.mjs
```

Expected: FAIL with `SyntaxError: The requested module './release.mjs' does not provide an export named 'exportOptions'`.

**Step 3: Replace `release.mjs` as a whole**

`apps/ios/scripts/release.mjs`:

```js
// Release flows for the iOS app, on top of xcodebuild, altool and asc.mjs.
//
//   node scripts/release.mjs beta     archive (unsigned), sign for the App Store at export, upload with altool,
//                                     wait for processing, set "What to Test" from the commits since the last
//                                     build, make sure the "Household" group gets it
//   node scripts/release.mjs device   build and install on a paired iPhone (DEVICE="name or UDID" picks one);
//                                     optional, TestFlight needs no registered device
//
// Run through the Makefile (`pnpm ios:beta`, `pnpm ios:device`), which loads the repo's .env. The build
// number is `git rev-list --count HEAD`; the marketing version is MARKETING_VERSION in Config/Base.xcconfig.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asc, authFlags, config, fail, findApp, findGroup, GROUP } from './asc.mjs';

const IOS = fileURLToPath(new URL('..', import.meta.url));
const ARCHIVE = join(IOS, 'build/Playarr.xcarchive');
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: IOS, encoding: 'utf8' }).trim();
const xcodebuild = (args) =>
  execFileSync('xcodebuild', ['-project', 'Playarr.xcodeproj', '-IDEPackageSupportDisableManifestSandbox=YES', ...args], { cwd: IOS, stdio: 'inherit' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** "What to Test": one line per commit subject (merges left out), at most 25 lines and 4000 characters. */
export function whatsNew(subjects) {
  const lines = subjects.filter((s) => !/^Merge (branch|pull request|remote-tracking branch) /.test(s)).map((s) => `- ${s}`);
  if (!lines.length) return 'No changes since the last build.';
  const shown = [];
  for (const line of lines) {
    if (shown.length === 25 || [...shown, line].join('\n').length > 3950) break;
    shown.push(line);
  }
  const more = lines.length - shown.length;
  return more ? `${shown.join('\n')}\n…and ${more} more` : shown.join('\n');
}

// TestFlight works with no registered device: a dev-signed archive would need one, so the archive is unsigned,
// the export signs it with Apple's cloud-managed distribution certificate through the key, and altool uploads
// the .ipa. (`destination upload` would need Xcode's ITunesSoftwareService, which Claude's sandbox can't reach.)
async function beta() {
  const cfg = config();
  const build = Number(sh('git', ['rev-list', '--count', 'HEAD']));
  const version = readFileSync(join(IOS, 'Config/Base.xcconfig'), 'utf8').match(/^MARKETING_VERSION = (.+)$/m)[1];
  const app = (await findApp(cfg.bundleId)) ?? fail(`No app record for ${cfg.bundleId} in App Store Connect: create it first (see the phase 0 plan).`);
  const { data: [last] } = await asc('GET', `/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=1&fields[builds]=version`);
  const lastBuild = Number(last?.attributes.version ?? 0);
  if (build === lastBuild) return console.log(`✓ Build ${build} is already on App Store Connect: nothing to upload.`);
  if (build < lastBuild) fail(`Build ${build} is older than ${lastBuild}, the last one on App Store Connect. Pull, then try again.`);
  if (sh('git', ['status', '--porcelain'])) console.warn('! Uncommitted changes go into this build, but not into its number.');

  step(`Archiving Playarr ${version} (${build}), unsigned`);
  rmSync(ARCHIVE, { recursive: true, force: true });
  xcodebuild([
    'archive', '-scheme', 'Playarr', '-configuration', 'Release', '-destination', 'generic/platform=iOS',
    '-archivePath', ARCHIVE, '-derivedDataPath', 'build/DerivedData', '-quiet',
    'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY=', `CURRENT_PROJECT_VERSION=${build}`,
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

/** Polls until the uploaded build is processed; it takes a few minutes to show up at all. */
async function processed(appId, build) {
  let state;
  for (const deadline = Date.now() + 45 * 60_000; Date.now() < deadline; await sleep(30_000)) {
    const { data: [found] } = await asc('GET', `/v1/builds?filter[app]=${appId}&filter[version]=${build}&fields[builds]=version,processingState`);
    const now = found?.attributes.processingState ?? 'not visible yet';
    if (now !== state) console.log(`  ${new Date().toLocaleTimeString()} ${now}`);
    state = now;
    if (now === 'VALID') return found;
    if (now === 'FAILED' || now === 'INVALID') fail(`App Store Connect couldn't process build ${build} (${now}); Apple emails the reason to the account holder.`);
  }
  fail(`Build ${build} still isn't processed after 45 minutes (last state: ${state}): see App Store Connect → TestFlight.`);
}

/** Export options for an App Store build: cloud-managed signing, written to an .ipa for altool to upload. */
export function exportOptions(teamId) {
  const entries = { method: 'app-store-connect', destination: 'export', signingStyle: 'automatic', teamID: teamId };
  const xml = Object.entries(entries).map(([key, value]) => `  <key>${key}</key><string>${value}</string>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    ...xml,
    // Keep the build number we set (the commit count) instead of letting Xcode raise it.
    '  <key>manageAppVersionAndBuildNumber</key><false/>',
    '</dict></plist>',
    '',
  ].join('\n');
}

async function device() {
  const cfg = config();
  const tmp = mkdtempSync(join(tmpdir(), 'playarr-devices-'));
  let devices;
  try {
    execFileSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', join(tmp, 'devices.json')], { stdio: 'ignore' });
    devices = JSON.parse(readFileSync(join(tmp, 'devices.json'), 'utf8')).result.devices;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  // devicectl also lists simulators ("simulated"); only paired physical iPhones and iPads will do.
  const phones = devices.filter(
    (d) => d.hardwareProperties?.platform === 'iOS' && d.hardwareProperties?.reality === 'physical' && d.connectionProperties?.pairingState === 'paired',
  );
  const wanted = process.env.DEVICE;
  const phone = wanted
    ? phones.find((d) => [d.deviceProperties?.name, d.hardwareProperties?.udid].includes(wanted))
    : phones.find((d) => d.connectionProperties?.tunnelState !== 'unavailable');
  if (!phone) fail(`No paired iPhone${wanted ? ` called ${wanted}` : ''} is reachable. Connect it by cable once, tap Trust, and turn on Developer Mode.`);
  const udid = phone.hardwareProperties.udid;
  const build = sh('git', ['rev-list', '--count', 'HEAD']);

  step(`Building for ${phone.deviceProperties.name}`);
  xcodebuild([
    'build', '-scheme', 'Playarr', '-configuration', 'Debug', '-destination', `id=${udid}`, '-derivedDataPath', 'build/DerivedData', '-quiet',
    `CURRENT_PROJECT_VERSION=${build}`, ...authFlags(cfg), '-allowProvisioningDeviceRegistration',
  ]);

  step('Installing');
  const appPath = join(IOS, 'build/DerivedData/Build/Products/Debug-iphoneos/Playarr.app');
  execFileSync('xcrun', ['devicectl', 'device', 'install', 'app', '--device', udid, appPath], { stdio: 'inherit' });
  try {
    execFileSync('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', udid, cfg.bundleId], { stdio: 'inherit' });
  } catch {
    console.log('  Installed. Unlock the phone and open Playarr.');
  }
}

function step(message) {
  console.log(`\n▸ ${message}`);
}

if (import.meta.main) {
  const commands = { beta, device };
  const command = commands[process.argv[2]] ?? (() => fail('Usage: node scripts/release.mjs beta | device'));
  await command().catch((err) => fail(err.message));
}
```

**Step 4: Run the tests again**

```bash
make -C apps/ios test-scripts 2>&1 | grep -E 'ℹ (pass|fail)'
```

Expected: `ℹ pass 8`, `ℹ fail 0`.

**Step 5: Commit** (before uploading, so the tree is clean and the build number counts this commit)

```bash
git add apps/ios/scripts/release.mjs apps/ios/scripts/release.test.mjs
git commit -m "$(cat <<'EOF'
iOS app: pnpm ios:beta archives, uploads, waits for processing and hands the build to TestFlight with the commits as What to Test

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

**Step 6: Upload** (in the background; 15 to 45 minutes)

```bash
corepack pnpm ios:beta
```

Expected, after the test output from Task 4, Step 7:

```
make beta-upload
…
▸ Archiving Playarr 1.0.0 (<N>), unsigned
▸ Signing for the App Store (cloud-managed distribution certificate)
… ** EXPORT SUCCEEDED **
▸ Uploading to App Store Connect
… ERROR: … CDUploaderStateInfoResumeFilePath …   (harmless; altool prints it before it starts)
… UPLOAD SUCCEEDED …
▸ Waiting for App Store Connect to process the build (usually 5 to 15 minutes)
  <time> not visible yet
  <time> PROCESSING
  <time> VALID
  What to Test:
    The first Playarr build on TestFlight.

✓ Playarr 1.0.0 (<N>) is on TestFlight for "Household".
```

`<N>` is `git rev-list --count HEAD`. It has to be above 301, the build uploaded by hand while this flow was worked out. Running it again without a new commit prints `✓ Build <N> is already on App Store Connect: nothing to upload.`

**Step 7: Check**

```bash
node --env-file=.env --input-type=module -e "import { asc, findApp } from './apps/ios/scripts/asc.mjs'; const app = await findApp(process.env.IOS_BUNDLE_ID); const { data } = await asc('GET', '/v1/builds?filter[app]=' + app.id + '&sort=-uploadedDate&limit=3&fields[builds]=version,processingState'); for (const b of data) console.log(b.attributes.version, b.attributes.processingState)"
```

Expected: `<N> VALID`. Then go through the "Final check" at the end of this plan with the user.

**Step 8: If it fails**

| Message | What to do |
|---|---|
| `Your team has no devices from which to generate a provisioning profile` | The archive was signed. `beta` archives with `CODE_SIGNING_ALLOWED=NO`; check that the flags weren't dropped. |
| `Connection init failed at lookup with error 3` (`ITunesSoftwareService`) | That's `destination upload`, which Claude's sandbox can't use. The export options must say `destination` `export`, and altool does the upload. |
| `No Accounts`, or `No signing certificate "iOS Development" found` with `-allowProvisioningUpdates` | The key didn't reach xcodebuild. Run `node --env-file=.env apps/ios/scripts/asc.mjs check` and check the `.p8` path it names. |
| `Cloud signing permission error`, or access to cloud-managed distribution certificates refused | The key needs the Admin role: App Store Connect → Users and Access → Integrations → App Store Connect API. Ask the user to check the key "Playarr CI". |
| `errSecInternalComponent`, keychain prompts, or a hang at code signing in Claude's shell | Ask the user to run `corepack pnpm ios:beta` in Terminal (see Conventions). |
| altool: `Failed to find API key` or a 401 | altool looks for `AuthKey_<ASC_KEY_ID>.p8` in `~/.appstoreconnect/private_keys`, the same place as `asc.mjs`. Run `node --env-file=.env apps/ios/scripts/asc.mjs check`. |
| `ITMS-9xxxx: …` from the upload | Apple's validation names the problem, usually an Info.plist key or the icon. Fix `Config/Info.plist` or the asset catalog, commit (a new build number), and run again. |
| `Build <N> is older than …` | Someone uploaded from a newer commit. Pull, then run again. |
| `couldn't process build <N> (INVALID)` | Apple emails the reason to the account holder. Ask the user for it. |

---

### Task 10: GitHub Actions: tests on every push that changes the app, TestFlight from `main`

**Files:**
- Create: `.github/workflows/ios.yml`

Facts this task relies on (checked 2026-11-03): `make -C apps/ios beta-upload` works end to end from the Mac (unsigned archive, cloud-signed export, altool upload, processing `VALID`, "Household" got build 304; builds 301 and 304 are on App Store Connect). Distribution signing is cloud-managed, so the export needs **no certificate or private key in the keychain**, and the archive is unsigned, so no development certificate is created either. The runner therefore needs no temporary keychain and no certificate import: only the `.p8` key, which `asc.mjs`, `xcodebuild -exportArchive` and `altool` all read from `~/.appstoreconnect/private_keys/`.

The workflow runs only for pushes and pull requests that change `apps/ios/**` or the workflow file (a `paths` filter), since the macOS job takes 15 minutes or more and server changes don't affect the app. The repo is public, so secrets appear only in the two upload steps, which run only for pushes to `main`; pull requests (forks' or not) never reach them. A push whose build number is already on App Store Connect prints "already on App Store Connect: nothing to upload" and succeeds.

**Step 1: Confirm the runner's Xcode**

```bash
curl -s https://raw.githubusercontent.com/actions/runner-images/main/images/macos/macos-26-arm64-Readme.md | grep -E '^\| 2[6-9]\.[0-9.]+ ' | head -3
curl -s https://raw.githubusercontent.com/actions/runner-images/main/images/macos/macos-26-arm64-Readme.md | grep -c 'iPhone 17 Pro'
```

Found on 2026-11-03 (image 20261026.0455.2, macOS 26.6.2, Node.js 24.22.1): `| 26.6 (default) | 17F113 | /Applications/Xcode_26.6.app …` first, then 26.5 down to 26.0.1, and a count of 3. So `XCODE_VERSION` is `26.6` on `macos-26`. The project targets iOS 26, so Xcode 26.x is enough even though this Mac has 27.2. An `xcode-27` image (`runs-on: xcode-27`, Xcode 27.0 to 27.2 RC) exists but is a **preview**, and its README lists no "iPhone 17 Pro" simulator; move to it (or a `macos-27` image) once it's out of preview. Put the newest non-beta version listed in `XCODE_VERSION`; if `macos-26` has gone, check the replacement image's README the same way and change `runs-on` to match.

**Step 2: Write the workflow**

```yaml
# iOS app: the scripts' tests, the Swift package tests and the UI tests on a simulator, for every push and
# pull request that changes apps/ios (or this file). Such pushes to main also upload a TestFlight build
# (`make beta-upload`: `pnpm ios:beta` without running the tests a second time). Pull requests never see
# the App Store Connect key: only the upload steps use secrets, they only run for pushes to main, and
# GitHub doesn't give secrets to forks' pull requests anyway.
#
# Signing needs no keychain set-up: the archive is unsigned and the export signs it with Apple's
# cloud-managed distribution certificate through the key, so no certificate or private key is installed.
name: iOS

on:
  push:
    paths: ['apps/ios/**', '.github/workflows/ios.yml']
  pull_request:
    paths: ['apps/ios/**', '.github/workflows/ios.yml']

permissions:
  contents: read

concurrency:
  group: ios-${{ github.ref }}
  # On main a run is never cancelled halfway through an upload; a newer push waits, and replaces any run
  # still waiting (its build number is higher anyway). Elsewhere a newer push cancels the running one.
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}

env:
  # The newest Xcode in the runner image's list; check it there before changing runs-on or this:
  # https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md
  XCODE_VERSION: '26.6'

jobs:
  ios:
    runs-on: macos-26
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # the build number is the commit count, and "What to Test" reads the log

      - name: Select Xcode
        run: sudo xcode-select -s "/Applications/Xcode_${XCODE_VERSION}.app"

      - name: Bootstrap
        run: make -C apps/ios bootstrap

      - name: Test
        run: make -C apps/ios test

      - name: Install the App Store Connect key
        if: github.event_name == 'push' && github.ref == 'refs/heads/main'
        env:
          ASC_KEY_ID: ${{ secrets.ASC_KEY_ID }}
          ASC_KEY_P8_BASE64: ${{ secrets.ASC_KEY_P8_BASE64 }}
        run: |
          mkdir -p ~/.appstoreconnect/private_keys
          umask 077
          printf '%s' "$ASC_KEY_P8_BASE64" | base64 --decode > ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8

      - name: Upload to TestFlight
        if: github.event_name == 'push' && github.ref == 'refs/heads/main'
        env:
          ASC_KEY_ID: ${{ secrets.ASC_KEY_ID }}
          ASC_ISSUER_ID: ${{ secrets.ASC_ISSUER_ID }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          IOS_BUNDLE_ID: me.tracklistme.playarr
        run: make -C apps/ios beta-upload

      - name: Remove the key
        if: always() && github.event_name == 'push' && github.ref == 'refs/heads/main'
        run: rm -rf ~/.appstoreconnect
```

`IOS_BUNDLE_ID` isn't secret, so it's written in the workflow. The conventions list the four GitHub secrets.

**Step 3: Check that it parses**

```bash
ruby -ryaml -e 'puts YAML.load_file(".github/workflows/ios.yml")["jobs"]["ios"]["steps"].map { |s| s["name"] || s["uses"] }'
```

Expected:

```
actions/checkout@v7
Select Xcode
Bootstrap
Test
Install the App Store Connect key
Upload to TestFlight
Remove the key
```

**Step 4: Checkpoint (user): the secrets.** On github.com/nicolabortignon/playarr → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, add four secrets (Name, then Secret, then **Add secret**; repeat for each):

| Name | Secret |
|---|---|
| `ASC_KEY_ID` | `43C35X77AJ` |
| `ASC_ISSUER_ID` | `69a6de70-2636-47e3-e053-5b8c7c11a4d1` (the `ASC_ISSUER_ID` line of `.env`) |
| `APPLE_TEAM_ID` | `M7ME2TS45S` |
| `ASC_KEY_P8_BASE64` | run `base64 -i ~/.appstoreconnect/private_keys/AuthKey_43C35X77AJ.p8 \| pbcopy` in your own Terminal, then paste (it's one long line) |

`IOS_BUNDLE_ID` (`me.tracklistme.playarr`) is not a secret: the workflow sets it. Claude must not read, print or base64 the key in its own shell. Add the secrets before pushing the workflow: the first push to main uploads.

**Step 5: Commit**

```bash
git add .github/workflows/ios.yml docs/plans/2026-11-03-ios-phase0-pipeline.md
git commit -m "$(cat <<'EOF2'
iOS app: GitHub Actions runs the iOS tests on every push that changes the app and uploads TestFlight builds from main

Co-Authored-By: Claude <noreply@anthropic.com>
EOF2
)"
```

**Step 6: Checkpoint (user): push**, then follow the run:

```bash
curl -s 'https://api.github.com/repos/nicolabortignon/playarr/actions/workflows/ios.yml/runs?branch=main&per_page=1' \
  | node -e "const r = JSON.parse(require('fs').readFileSync(0, 'utf8')).workflow_runs?.[0]; console.log(r ? [r.head_sha.slice(0, 7), r.status, r.conclusion, r.html_url].join(' ') : 'no run yet')"
```

Expected: the pushed commit, `in_progress` and then, after 20 to 60 minutes, `completed success`. This push contains the workflow file, so the run starts and the upload steps run. Task 9, Step 7's check then shows a new `VALID` build, numbered with the pushed commit count (higher than 304).

**Step 7: If the run fails**

- `xcode-select: error: invalid developer directory`: that Xcode isn't on the image. Repeat Step 1.
- The Swift build fails on a language feature: the code was written with Swift 6.4 (Xcode 27.2) and the runner compiles with Xcode 26.6's Swift. Rewrite the line for the older compiler (tools version 6.2 is the floor), or move `runs-on` to the Xcode 27 image once it's out of preview.
- `No App Store Connect key at …` or altool `Failed to find API key`: a secret is missing or misnamed (`ASC_KEY_ID` must match the key file's id). Check Step 4.
- The export fails asking for a certificate or profile: the key must keep the Admin role (cloud-managed signing needs it). Run `node --env-file=.env apps/ios/scripts/asc.mjs check` on the Mac.

---

### Task 11: README, PLAN.md and the design doc

**Files:**
- Modify: `README.md`, `PLAN.md`, `docs/plans/2026-11-03-ios-app-design.md`

**Step 1: README, repository layout.** Below the `apps/web` row of the table, add:

```markdown
| `apps/ios` | The native iPhone and iPad app in SwiftUI, being built in phases ([design](docs/plans/2026-11-03-ios-app-design.md)). Outside the pnpm workspace: XcodeGen generates the Xcode project from `project.yml`, a Makefile has every entry point, and two Node scripts talk to App Store Connect. |
```

**Step 2: README, how to run it.** Right above `### Docker`, add:

````markdown
### iOS app

The native app in `apps/ios` needs Xcode 26 or later; nothing else is installed system-wide.

```bash
pnpm ios:bootstrap   # download the pinned XcodeGen into apps/ios/.tools and generate Playarr.xcodeproj
pnpm ios:build       # build for the iPhone 17 Pro simulator
pnpm ios:test        # the scripts' tests, the Swift package tests, then the UI tests on the simulator
pnpm ios:beta        # test, archive, upload, and hand the build to the "Household" TestFlight group
pnpm ios:device      # optional: build and install on an iPhone cabled to this Mac (Developer Mode on)
```

The Xcode project is generated, not committed: every `make` target regenerates it, so new files are picked up. Open `apps/ios/Playarr.xcodeproj` to work in Xcode.

Signing and uploads go through an App Store Connect API key, with no Apple ID signed in. Put the key at `~/.appstoreconnect/private_keys/AuthKey_<id>.p8`, and `ASC_KEY_ID`, `ASC_ISSUER_ID`, `APPLE_TEAM_ID` and `IOS_BUNDLE_ID` in `.env`. `pnpm ios:setup` registers the bundle id and creates the TestFlight group (`TESTERS="a@example.com"` adds App Store Connect users to it); it's safe to run again. `node --env-file=.env apps/ios/scripts/asc.mjs check` tells what's set up.

Phones get the app through TestFlight, which needs no registered device: `pnpm ios:beta` archives unsigned, the export signs the app with Apple's cloud-managed distribution certificate through the key (no certificate in the keychain), and `altool` uploads it. `pnpm ios:device` is only for a phone that can be cabled to the Mac; it registers that phone with Apple. The build number is the commit count; the version is `MARKETING_VERSION` in `apps/ios/Config/Base.xcconfig`, changed only for App Store releases.

GitHub Actions (`.github/workflows/ios.yml`, on `macos-26`) runs the tests for every push and pull request that changes `apps/ios`, and uploads a TestFlight build for each such push to main, with the key in the repository's secrets (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `APPLE_TEAM_ID`, `ASC_KEY_P8_BASE64`).

````

Also change "A pnpm monorepo, all TypeScript:" above the layout table to "A pnpm monorepo, all TypeScript, plus the native iOS app in Swift:".

**Step 3: PLAN.md.** In the tree in section 3, replace

```
│   └── server/     # Fastify API, streaming, analysis, transitions
```

with

```
│   ├── server/     # Fastify API, streaming, analysis, transitions
│   └── ios/        # SwiftUI app for iPhone and iPad, outside the workspace: XcodeGen spec, Makefile, App Store Connect scripts
```

and add a last row to the decisions log in section 12:

```markdown
| 2026-11-03 | Native iOS app (design: `docs/plans/2026-11-03-ios-app-design.md`), phase 0: an XcodeGen project that isn't committed, with XcodeGen pinned and checksummed in `apps/ios/.tools/` (Homebrew isn't writable here). Signing and uploads only through the App Store Connect API key, no Apple ID, no fastlane: the archive is unsigned, `xcodebuild -exportArchive` signs it with the cloud-managed distribution certificate, and `altool` uploads it, so TestFlight needs no registered device and no certificate in a keychain. `pnpm ios:beta` uploads to TestFlight's internal "Household" group; GitHub Actions on `macos-26` does the same for pushes to main that change `apps/ios`. Build number = commit count. |
```

**Step 4: The design doc.** In section 2 of `docs/plans/2026-11-03-ios-app-design.md`, replace

```
A new Mac needs Xcode, `brew install xcodegen`, and the App Store Connect key (section 5).
```

with

```
A new Mac needs Xcode and the App Store Connect key (section 5); `pnpm ios:bootstrap` downloads a pinned XcodeGen into `apps/ios/.tools/`.
```

**Step 5: Check**

```bash
grep -c 'apps/ios' README.md PLAN.md
grep -n 'brew install xcodegen' docs/plans/2026-11-03-ios-app-design.md || echo 'no brew left'
```

Expected: both counts at least 2 (README) and 1 (PLAN.md); `no brew left`.

**Step 6: Commit**

```bash
git add README.md PLAN.md docs/plans/2026-11-03-ios-app-design.md
git commit -m "$(cat <<'EOF'
Docs: the iOS app in the README and PLAN; XcodeGen comes from pnpm ios:bootstrap, not Homebrew

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Final check (user, on the iPhone)

- [ ] Install **TestFlight** from the App Store on the iPhone.
- [ ] Open the email "You're invited to test Playarr" (sent to the App Store Connect user's address once the first build is processed) and tap **View in TestFlight**. Or open TestFlight signed in with that Apple ID: Playarr is listed there.
- [ ] Tap **Install** (or **Update**, if a Task 8 development build is on the phone: TestFlight replaces it).
- [ ] Open Playarr: "Playarr" in large type and "Version 1.0.0 (N)". N is the build number `ios:beta` printed (or the GitHub Actions build's, if that one is newer).
- [ ] In TestFlight, the Playarr page shows the "What to Test" text.
- [ ] After a push to main that changes `apps/ios`, the GitHub Actions run goes green, and TestFlight offers the new build within the hour (with automatic updates on, it installs by itself).

## Uncertainties

These are assumptions about Apple's behaviour that couldn't be tried without creating things in the account. Each one has a fallback in the task it belongs to.

1. **Development signing with zero devices.** Confirmed: a dev-signed archive fails until a device is registered. Task 9 therefore archives unsigned and signs at export, which worked for build 301.
2. **Creating an internal group through the API** (`POST /v1/betaGroups` with `isInternalGroup: true, hasAccessToAllBuilds: true`). The existing "Household" group shows exactly these attributes, and they are believed to be writable at creation, but this wasn't tried here. Fallback: Task 7, Step 3.
3. **Adding internal testers through the API** (`POST /v1/betaTesters` with the email and the group). Believed to work only for people who are App Store Connect users of the team, and possibly not at all for internal groups. Fallback: Task 7, Step 3.
4. **`betaBuildLocalizations`.** It isn't known whether App Store Connect creates the en-US localization on its own. `release.mjs` handles both cases (PATCH if it exists, POST if not).
5. **Cloud-managed distribution signing with an API key.** Confirmed with the Admin key: build 301 was exported signed "Apple Distribution: W1T LTD" with an App Store profile and no devices.
6. **CI signing**: settled on the Mac, not yet seen on the runner. The archive is unsigned and the export uses the cloud-managed distribution certificate, so nothing goes into a keychain and no "Created via API" development certificates pile up; the workflow has no keychain step. The first run on `main` after Task 10 confirms it on GitHub's runner (Task 10, Step 7 lists what to check if it fails).
7. **`devicectl` JSON fields** for a physical phone (`hardwareProperties.reality == "physical"`, `udid`, `connectionProperties.pairingState` and `tunnelState`). They were checked on this Mac only against simulators, which `devicectl` now lists too.
8. **`UIBackgroundModes`** is audio only. Background `URLSession` downloads (phase 7) need no background mode; `fetch` is for background app refresh, which the app doesn't use.
