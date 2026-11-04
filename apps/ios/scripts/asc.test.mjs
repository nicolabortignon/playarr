import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ascOrNull, crashLogText, explain, token, unseenCrashes } from './asc.mjs';

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

test('unseenCrashes lists the reports not looked at yet, oldest first', () => {
  const report = (id, createdDate, comment) => ({ id, attributes: { createdDate, comment, deviceModel: 'iPhone18_3', osVersion: '26.7.1' } });
  const reports = [report('b', '2026-11-04T09:00:00Z', 'again'), report('a', '2026-11-03T22:47:06Z', 'Crashed on loading')];
  assert.deepEqual(unseenCrashes(reports, new Set(['b'])).map((r) => r.id), ['a']);
  assert.deepEqual(unseenCrashes(reports, new Set()).map((r) => r.id), ['a', 'b']);
});

test('crashLogText takes the log out of its API answer', () => {
  assert.equal(crashLogText({ data: { type: 'betaCrashLogs', attributes: { logText: 'Incident Identifier: X\n' } } }), 'Incident Identifier: X\n');
});

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
