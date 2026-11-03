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
