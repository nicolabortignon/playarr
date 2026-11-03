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

function step(message) {
  console.log(`\n▸ ${message}`);
}

if (import.meta.main) {
  const commands = { beta, device };
  const command = commands[process.argv[2]] ?? (() => fail('Usage: node scripts/release.mjs beta | device'));
  await command().catch((err) => fail(err.message));
}
