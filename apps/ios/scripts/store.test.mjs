import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fillNotes, md5, pngInfo, readScreenshots, readStore, STORE, validateScreenshots, validateStore } from './store.mjs';

const listing = () => {
  const store = readStore();
  return { ...store, text: { ...store.text }, app: structuredClone(store.app) };
};

test('the listing in apps/ios/store is within Apple’s limits', () => {
  assert.deepEqual(validateStore(readStore()), []);
});

test('validateStore names what is too long, not https, badly spaced or left as a placeholder', () => {
  const store = listing();
  store.text.name = 'Playarr: the music player for your own server';
  store.text.supportUrl = 'http://example.com/support';
  store.text.keywords = 'music, flac,music';
  store.text.description = 'Contact {{SUPPORT_EMAIL}}';
  delete store.app.ageRating.lootBox;
  store.app.ageRating.profanityOrCrudeHumor = 'SOMETIMES';
  assert.deepEqual(validateStore(store), [
    'name.txt has 45 characters; Apple allows 30',
    'description.txt still has {{SUPPORT_EMAIL}}',
    'support-url.txt must be one https:// address',
    'keywords.txt: no spaces around the commas (they count against the 100)',
    'keywords.txt repeats a keyword',
    'app.json: ageRating.profanityOrCrudeHumor must be one of NONE, INFREQUENT_OR_MILD, FREQUENT_OR_INTENSE',
    'app.json: ageRating.lootBox must be true or false',
  ]);
});

test('validateStore wants the required files and allows only the review placeholders in the notes', () => {
  const store = listing();
  store.text.description = null;
  store.text.notes = 'Server: {{REVIEW_SERVER_URL}}, user {{REVIEW_USERNAME}}, password {{REVIEW_PASSWORD}}';
  assert.deepEqual(validateStore(store), ['description.txt is missing or empty', 'review-notes.txt still has {{REVIEW_PASSWORD}}']);
});

test('fillNotes puts in the server and username, and names what is unset', () => {
  const template = 'Address: {{REVIEW_SERVER_URL}}\nUsername: {{REVIEW_USERNAME}}';
  assert.equal(fillNotes(template, { REVIEW_SERVER_URL: 'https://music.example.com', REVIEW_USERNAME: 'reviewer' }), 'Address: https://music.example.com\nUsername: reviewer');
  assert.throws(() => fillNotes(template, { REVIEW_USERNAME: 'reviewer' }), /Set REVIEW_SERVER_URL/);
});

/** A PNG header that pngInfo can read (the pixels and CRCs don't matter to it). */
function png(width, height, { colorType = 2, trns = false } = {}) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(trns ? [chunk('tRNS', Buffer.alloc(6))] : []),
    chunk('IDAT', Buffer.alloc(4)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('pngInfo reads the size and sees transparency', () => {
  assert.deepEqual(pngInfo(png(1320, 2868)), { width: 1320, height: 2868, alpha: false });
  assert.equal(pngInfo(png(10, 10, { colorType: 6 })).alpha, true);
  assert.equal(pngInfo(png(10, 10, { trns: true })).alpha, true);
  assert.throws(() => pngInfo(Buffer.from('GIF89a…')), /not a PNG/);
});

test('readScreenshots and validateScreenshots: sizes per display type, landscape, transparency, names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'playarr-shots-'));
  mkdirSync(join(dir, 'iphone-6.9'));
  mkdirSync(join(dir, 'ipad-13'));
  writeFileSync(join(dir, 'iphone-6.9', '01-home.png'), png(1320, 2868));
  writeFileSync(join(dir, 'iphone-6.9', '02-album.png'), png(1290, 2796, { colorType: 6 }));
  writeFileSync(join(dir, 'iphone-6.9', 'Now Playing.png'), png(1179, 2556));
  writeFileSync(join(dir, 'ipad-13', '01-home.png'), png(2752, 2064));
  const sets = readScreenshots(dir);
  assert.deepEqual(sets.map((s) => [s.folder, s.displayType, s.files.map((f) => f.name)]), [
    ['iphone-6.9', 'APP_IPHONE_67', ['01-home.png', '02-album.png', 'Now Playing.png']],
    ['ipad-13', 'APP_IPAD_PRO_3GEN_129', ['01-home.png']],
  ]);
  assert.equal(sets[0].files[0].md5, md5(png(1320, 2868)));
  assert.deepEqual(validateScreenshots(sets), [
    'screenshots/iphone-6.9/02-album.png has transparency, which App Store Connect refuses (scripts/flatten-png.swift removes it)',
    'screenshots/iphone-6.9/Now Playing.png: name it NN-what-it-shows.png',
    'screenshots/iphone-6.9/Now Playing.png is 1179×2556; APP_IPHONE_67 takes 1320×2868, 1290×2796, 1260×2736 (or turned)',
  ]);
  assert.deepEqual(validateScreenshots(sets.slice(0, 1)).at(0), 'screenshots/ipad-13 has no screenshots (make screenshots takes them on the iPad Pro 13-inch (M5) simulator)');
});
