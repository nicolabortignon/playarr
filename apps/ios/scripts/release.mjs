// Release flows for the iOS app, on top of xcodebuild, altool and asc.mjs.
//
//   node scripts/release.mjs beta     archive (unsigned), sign for the App Store at export, upload with altool,
//                                     wait for processing, set "What to Test" from the commits since the last
//                                     build, make sure the "Household" group gets it
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
// .env. The build number is `git rev-list --count HEAD` (or BUILD_NUMBER); the marketing version is
// MARKETING_VERSION in Config/Base.xcconfig, changed only by `release`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { submitForReview, syncListing, withDryRun } from './appstore.mjs';
import { asc, ascOrNull, authFlags, config, fail, findApp, findGroup, GROUP } from './asc.mjs';
import { compareVersions, fillNotes, readScreenshots, readStore, reviewDetailAttributes, validateScreenshots, validateStore, VERSION_PATTERN } from './store.mjs';

const IOS = fileURLToPath(new URL('..', import.meta.url));
const ARCHIVE = join(IOS, 'build/Playarr.xcarchive');
const XCCONFIG = join(IOS, 'Config/Base.xcconfig');
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: IOS, encoding: 'utf8' }).trim();
const xcodebuild = (args) =>
  execFileSync('xcodebuild', ['-project', 'Playarr.xcodeproj', '-IDEPackageSupportDisableManifestSandbox=YES', ...args], { cwd: IOS, stdio: 'inherit' });
/** For builds: the compiler can't sandbox the macro plugins it runs (@Observable) inside Claude's sandbox. */
const NO_MACRO_SANDBOX = 'OTHER_SWIFT_FLAGS=$(inherited) -Xfrontend -disable-sandbox';
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

/**
 * Whether this build goes up: only when it's newer than the last on App Store Connect. One already there, or older
 * (a CI run queued behind a build uploaded from a Mac, or by a later run), is nothing to do rather than a failure.
 */
export const uploadNeeded = (build, lastBuild) => build > lastBuild;

// TestFlight works with no registered device: a dev-signed archive would need one, so the archive is unsigned,
// the export signs it with Apple's cloud-managed distribution certificate through the key, and altool uploads
// the .ipa. (`destination upload` would need Xcode's ITunesSoftwareService, which Claude's sandbox can't reach.)
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
  // BUILD_NUMBER overrides the commit count: for when a build from work not on main yet (another Mac's) took a higher
  // number, so this one would otherwise be skipped as older.
  const build = Number(process.env.BUILD_NUMBER || sh('git', ['rev-list', '--count', 'HEAD']));
  const version = marketingVersionIn(readFileSync(XCCONFIG, 'utf8'));
  const { data: [last] } = await asc('GET', `/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=1&fields[builds]=version`);
  const lastBuild = Number(last?.attributes.version ?? 0);
  if (!uploadNeeded(build, lastBuild)) {
    console.log(
      build === lastBuild
        ? `✓ Build ${build} is already on App Store Connect: nothing to upload.`
        : `✓ Build ${lastBuild}, newer than this one (${build}), is already on App Store Connect: nothing to upload.`,
    );
    return { build, version, lastBuild, fresh: false };
  }
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
    `CURRENT_PROJECT_VERSION=${build}`, NO_MACRO_SANDBOX, ...authFlags(cfg), '-allowProvisioningDeviceRegistration',
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
    // Beta skips an older build; the App Store needs this commit's.
    if (up.build < up.lastBuild) fail(`Build ${up.build} is older than ${up.lastBuild}, the last one on App Store Connect. Pull, then try again.`);
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

function step(message) {
  console.log(`\n▸ ${message}`);
}

if (import.meta.main) {
  const [name, ...args] = process.argv.slice(2);
  const commands = { beta, device, release: () => release(args), 'check-store': async () => checkStore() };
  const command = commands[name] ?? (() => fail('Usage: node scripts/release.mjs beta | device | release [X.Y.Z] [--dry-run] | check-store'));
  await command().catch((err) => fail(err.message));
}
