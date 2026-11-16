import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LIMITS, PACKAGE, accessToken, assertion, check, client, credentials, explain, parseArgs, readStore, upload } from './play-upload.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const account = JSON.stringify({ type: 'service_account', client_email: 'ci@playarr.iam.gserviceaccount.com', private_key: pem, token_uri: 'https://oauth2.example/token' });

/** A stand-in for Google: answers by method and path (the API's or the upload host's), records what it was sent. */
function fakeGoogle(answers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? 'GET'} ${u.pathname.replace(`/applications/${PACKAGE}`, '')}${u.search}`;
    calls.push({ key, init, url: u });
    const answer = answers[key];
    const value = typeof answer === 'function' ? answer(calls.filter((c) => c.key === key).length) : answer;
    if (value === undefined) return new Response(JSON.stringify({ error: { message: `no answer for ${key}` } }), { status: 500 });
    const [status, body] = Array.isArray(value) ? value : [200, value];
    return new Response(body === null ? '' : JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

const quiet = () => {};
const words = { 'whats-new.txt': 'Faster covers.' };
const V3 = '/androidpublisher/v3';
const UP = '/upload/androidpublisher/v3';

test('the service account key comes from the environment, and must be one', () => {
  assert.equal(credentials({ PLAY_SERVICE_ACCOUNT_JSON: account }).email, 'ci@playarr.iam.gserviceaccount.com');
  assert.throws(() => credentials({}), /PLAY_SERVICE_ACCOUNT_JSON/);
  assert.throws(() => credentials({ PLAY_SERVICE_ACCOUNT_JSON: 'nope' }), /isn't JSON/);
  assert.throws(() => credentials({ PLAY_SERVICE_ACCOUNT_JSON: '{"type":"authorized_user"}' }), /isn't a service account/);
  const dir = mkdtempSync(join(tmpdir(), 'play-'));
  writeFileSync(join(dir, 'key.json'), account);
  assert.equal(credentials({ PLAY_SERVICE_ACCOUNT_FILE: join(dir, 'key.json') }).tokenUri, 'https://oauth2.example/token');
});

test('the assertion is an RS256 JWT Google can check with the public key', () => {
  const creds = credentials({ PLAY_SERVICE_ACCOUNT_JSON: account });
  const jwt = assertion(creds, 1_700_000_000_000);
  const [header, claims, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), {
    iss: 'ci@playarr.iam.gserviceaccount.com',
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.example/token',
    iat: 1_700_000_000,
    exp: 1_700_003_600,
  });
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url')));
});

test('the access token is traded for the assertion; a refusal says what to check', async () => {
  const creds = credentials({ PLAY_SERVICE_ACCOUNT_JSON: account });
  const google = fakeGoogle({ 'POST /token': { access_token: 'ya29.token', expires_in: 3599 } });
  assert.equal(await accessToken(creds, { fetch: google.fetch }), 'ya29.token');
  const form = new URLSearchParams(google.calls[0].init.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(form.get('assertion').split('.').length, 3);

  const refused = fakeGoogle({ 'POST /token': [400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }] });
  await assert.rejects(accessToken(creds, { fetch: refused.fetch }), /refused the service account.*Invalid JWT Signature/);
});

test('a release goes up in one edit: the bundle, the track with its notes, the commit', async () => {
  const bundle = Buffer.from('PK fake bundle');
  const google = fakeGoogle({
    [`POST ${V3}/edits`]: { id: 'e1' },
    [`POST ${UP}/edits/e1/bundles?uploadType=media`]: { versionCode: 412, sha256: 'x' },
    [`PUT ${V3}/edits/e1/tracks/internal`]: { track: 'internal' },
    [`POST ${V3}/edits/e1:commit`]: { id: 'e1' },
  });
  const code = await upload(client('tok', { fetch: google.fetch }), { bundle, words, log: quiet });
  assert.equal(code, '412');
  assert.deepEqual(google.calls.map((c) => c.key), [
    `POST ${V3}/edits`,
    `POST ${UP}/edits/e1/bundles?uploadType=media`,
    `PUT ${V3}/edits/e1/tracks/internal`,
    `POST ${V3}/edits/e1:commit`,
  ]);
  const sent = google.calls[1].init;
  assert.equal(sent.headers['Content-Type'], 'application/octet-stream');
  assert.equal(sent.headers.Authorization, 'Bearer tok');
  assert.equal(sent.body, bundle);
  assert.deepEqual(JSON.parse(google.calls[2].init.body), {
    track: 'internal',
    releases: [{ versionCodes: ['412'], status: 'completed', releaseNotes: [{ language: 'en-US', text: 'Faster covers.' }] }],
  });
});

test('with the listing, its words go in the same edit', async () => {
  const google = fakeGoogle({
    [`POST ${V3}/edits`]: { id: 'e2' },
    [`POST ${UP}/edits/e2/bundles?uploadType=media`]: { versionCode: 5 },
    [`PUT ${V3}/edits/e2/listings/en-US`]: {},
    [`PUT ${V3}/edits/e2/tracks/beta`]: {},
    [`POST ${V3}/edits/e2:commit`]: {},
  });
  const all = { ...words, 'title.txt': 'Playarr', 'short-description.txt': 'Short.', 'full-description.txt': 'Full.' };
  await upload(client('tok', { fetch: google.fetch }), { bundle: Buffer.alloc(1), track: 'beta', words: all, log: quiet });
  const listing = google.calls.find((c) => c.key.includes('/listings/'));
  assert.deepEqual(JSON.parse(listing.init.body), { language: 'en-US', title: 'Playarr', shortDescription: 'Short.', fullDescription: 'Full.' });
});

test('an app Play still has as a draft gets a draft release', async () => {
  const google = fakeGoogle({
    [`POST ${V3}/edits`]: { id: 'e3' },
    [`POST ${UP}/edits/e3/bundles?uploadType=media`]: { versionCode: 7 },
    [`PUT ${V3}/edits/e3/tracks/internal`]: (n) => (n === 1 ? [400, { error: { message: 'Only releases with status draft may be created on draft app.' } }] : {}),
    [`POST ${V3}/edits/e3:commit`]: {},
  });
  const said = [];
  await upload(client('tok', { fetch: google.fetch }), { bundle: Buffer.alloc(1), words, log: (m) => said.push(m) });
  const tracks = google.calls.filter((c) => c.key.endsWith('/tracks/internal'));
  assert.deepEqual(tracks.map((c) => JSON.parse(c.init.body).releases[0].status), ['completed', 'draft']);
  assert.ok(said.some((m) => /draft/.test(m)));
});

test('an edit that can only be committed without review is committed so', async () => {
  const google = fakeGoogle({
    [`POST ${V3}/edits`]: { id: 'e4' },
    [`POST ${UP}/edits/e4/bundles?uploadType=media`]: { versionCode: 8 },
    [`PUT ${V3}/edits/e4/tracks/internal`]: {},
    [`POST ${V3}/edits/e4:commit`]: [400, { error: { message: 'Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true.' } }],
    [`POST ${V3}/edits/e4:commit?changesNotSentForReview=true`]: {},
  });
  await upload(client('tok', { fetch: google.fetch }), { bundle: Buffer.alloc(1), words, log: quiet });
  assert.equal(google.calls.at(-1).key, `POST ${V3}/edits/e4:commit?changesNotSentForReview=true`);
});

test('a failed upload deletes its edit and says why', async () => {
  const google = fakeGoogle({
    [`POST ${V3}/edits`]: { id: 'e5' },
    [`POST ${UP}/edits/e5/bundles?uploadType=media`]: [403, { error: { message: 'APK specifies a version code that has already been used.' } }],
    [`DELETE ${V3}/edits/e5`]: null,
  });
  await assert.rejects(upload(client('tok', { fetch: google.fetch }), { bundle: Buffer.alloc(1), words, log: quiet }), /uploading the bundle.*already been used/);
  assert.equal(google.calls.at(-1).key, `DELETE ${V3}/edits/e5`);
});

test('an app Play has never seen is explained', async () => {
  const google = fakeGoogle({ [`POST ${V3}/edits`]: [404, { error: { message: `Package not found: ${PACKAGE}.` } }] });
  await assert.rejects(upload(client('tok', { fetch: google.fetch }), { bundle: Buffer.alloc(1), words, log: quiet }), /first bundle there by hand/);
  assert.match(explain(403, { error: { message: 'The caller does not have permission' } }), /Users and permissions/);
});

test('--check opens an edit, lists the tracks and deletes it', async () => {
  const google = fakeGoogle({
    [`POST ${V3}/edits`]: { id: 'e6' },
    [`GET ${V3}/edits/e6/tracks`]: { tracks: [{ track: 'internal' }, { track: 'production' }] },
    [`DELETE ${V3}/edits/e6`]: null,
  });
  const said = [];
  await check(client('tok', { fetch: google.fetch }), (m) => said.push(m));
  assert.equal(google.calls.at(-1).key, `DELETE ${V3}/edits/e6`);
  assert.match(said[0], /internal, production/);
});

test('the store words are checked against Play’s limits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  writeFileSync(join(dir, 'whats-new.txt'), 'x'.repeat(LIMITS['whats-new.txt'] + 1));
  assert.throws(() => readStore(dir), /whats-new.txt is 501 characters/);
  writeFileSync(join(dir, 'whats-new.txt'), '  New.\n');
  assert.deepEqual(readStore(dir), { 'whats-new.txt': 'New.' });
  assert.throws(() => readStore(dir, { listing: true }), /title.txt/);
});

test('the repo’s own store listing fits', () => {
  const store = readStore(undefined, { listing: true });
  assert.ok(store['title.txt'] && store['short-description.txt'] && store['full-description.txt'] && store['whats-new.txt']);
});

test('arguments', () => {
  assert.deepEqual(parseArgs(['a.aab']), { track: 'internal', listing: false, check: false, bundle: 'a.aab' });
  assert.deepEqual(parseArgs(['a.aab', '--track', 'beta', '--listing']), { track: 'beta', listing: true, check: false, bundle: 'a.aab' });
  assert.equal(parseArgs(['--check']).check, true);
  assert.throws(() => parseArgs([]), /Usage/);
  assert.throws(() => parseArgs(['a.aab', '--nope']), /Unknown option/);
});
