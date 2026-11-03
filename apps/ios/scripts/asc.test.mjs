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
