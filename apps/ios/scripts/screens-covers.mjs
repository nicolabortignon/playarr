#!/usr/bin/env node
// The demo albums' real covers, for `make screens` only: looked up on MusicBrainz and fetched from the Cover Art
// Archive into build/screens-covers/ (gitignored), named by the demo album's id. Screenshots of the main views then
// show them; the app, the repository and the App Store screenshots keep the demo's drawn covers (DemoArt.swift),
// as the artwork isn't ours to publish. Files already there are kept. A failed lookup leaves that album drawn.
// Usage: node scripts/screens-covers.mjs <dir>
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The demo library's albums (Packages/PlayarrUI/Sources/PlayarrUI/Demo/Demo.swift): id, artist, title.
const ALBUMS = [
  [70, 'Massive Attack', 'Mezzanine'],
  [71, 'Massive Attack', 'Protection'],
  [80, 'Portishead', 'Dummy'],
];
const AGENT = { 'User-Agent': 'Playarr screenshots (https://github.com/nicolabortignon/playarr)' };

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** JSON from MusicBrainz, asking again while it says it's busy (its answer to too many requests). */
async function musicBrainz(url) {
  for (let attempt = 1; ; attempt++) {
    const body = await (await fetch(url, { headers: AGENT })).json();
    if (!body.error || attempt === 4) return body;
    await pause(2000 * attempt);
  }
}

const dir = process.argv[2];
if (!dir) throw new Error('Usage: screens-covers.mjs <dir>');
mkdirSync(dir, { recursive: true });

for (const [id, artist, title] of ALBUMS) {
  const file = join(dir, `${id}.jpg`);
  if (existsSync(file)) continue;
  try {
    const query = encodeURIComponent(`releasegroup:"${title}" AND artist:"${artist}" AND primarytype:album`);
    const found = await musicBrainz(`https://musicbrainz.org/ws/2/release-group/?query=${query}&limit=1&fmt=json`);
    const group = found['release-groups']?.[0];
    if (!group) throw new Error(found.error ?? 'not on MusicBrainz');
    const cover = await fetch(`https://coverartarchive.org/release-group/${group.id}/front-500`, { headers: AGENT });
    if (!cover.ok) throw new Error(`Cover Art Archive: HTTP ${cover.status}`);
    writeFileSync(file, Buffer.from(await cover.arrayBuffer()));
    console.log(`▸ cover: ${artist} – ${title}`);
  } catch (err) {
    console.warn(`▸ no cover for ${artist} – ${title} (${err.message}): drawn instead`);
  }
  // MusicBrainz asks for one request a second.
  await pause(1100);
}
