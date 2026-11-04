import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fillNotes, readStore, validateStore } from './store.mjs';

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
