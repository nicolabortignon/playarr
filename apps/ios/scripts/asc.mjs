// App Store Connect API for the iOS app, with no dependencies: a JWT signed with node:crypto, and fetch.
//
//   node scripts/asc.mjs check             is the key accepted? Then: bundle id, app record, TestFlight group
//   node scripts/asc.mjs setup [email...]  register the bundle id; once the app record exists, create the
//                                          internal TestFlight group "Household" and add those testers to it
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
 * 2, 4, 8 and 16 s apart. Changes aren't retried: a failed one may have happened anyway.
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
    const failed = res instanceof Error || res.status === 429 || res.status >= 500;
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

export function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const commands = { check: () => check(), setup: () => setup(args) };
  if (!commands[command]) fail('Usage: node scripts/asc.mjs check | setup [tester email...]');
  await commands[command]().catch((err) => fail(err.message));
}
