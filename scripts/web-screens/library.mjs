// The library the web screen tour plays: 20 real albums' track lists from MusicBrainz and their covers from the
// Cover Art Archive, as silent MP3s with full ID3v2.4 tags, so pages look as they do with real music. Albums are
// made once and kept, so later runs need no network. Run alone: node scripts/web-screens/library.mjs <dir>
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Artist, album, genre. The steps in steps.json tap some of these by name.
export const ALBUMS = [
  ['Massive Attack', 'Mezzanine', 'Trip Hop'],
  ['Massive Attack', 'Protection', 'Trip Hop'],
  ['Portishead', 'Dummy', 'Trip Hop'],
  ['Daft Punk', 'Discovery', 'Electronic'],
  ['Daft Punk', 'Random Access Memories', 'Electronic'],
  ['Radiohead', 'OK Computer', 'Alternative Rock'],
  ['Radiohead', 'In Rainbows', 'Alternative Rock'],
  ['Fleetwood Mac', 'Rumours', 'Rock'],
  ['Miles Davis', 'Kind of Blue', 'Jazz'],
  ['Kendrick Lamar', 'To Pimp a Butterfly', 'Hip Hop'],
  ['Björk', 'Homogenic', 'Electronic'],
  ['Bon Iver', 'For Emma, Forever Ago', 'Folk'],
  ['Khruangbin', 'Con Todo El Mundo', 'Psychedelic'],
  ['The xx', 'xx', 'Indie'],
  ['Air', 'Moon Safari', 'Electronic'],
  ['Nina Simone', 'Pastel Blues', 'Jazz'],
  ['Bonobo', 'Black Sands', 'Electronic'],
  ['Arctic Monkeys', 'AM', 'Indie'],
  ['Stevie Wonder', 'Innervisions', 'Soul'],
  ['Talking Heads', 'Remain in Light', 'New Wave'],
];

const AGENT = { 'User-Agent': 'Playarr web screens (https://github.com/nicolabortignon/playarr)' };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safe = (s) => s.replace(/[/:*?"<>|\\]/g, '_').trim();

// MusicBrainz asks for one request a second at most.
let lastAsked = 0;
async function musicBrainz(path) {
  for (let attempt = 1; ; attempt++) {
    await pause(Math.max(0, lastAsked + 1100 - Date.now()));
    lastAsked = Date.now();
    const url = `https://musicbrainz.org/ws/2/${path}${path.includes('?') ? '&' : '?'}fmt=json`;
    const body = await fetch(url, { headers: AGENT })
      .then((res) => res.json().catch(() => ({ error: `HTTP ${res.status}` })))
      .catch((err) => ({ error: err.cause?.message ?? err.message }));
    // An error is most often "busy" (too many requests): ask again, a little later each time.
    if (!body.error || attempt === 4) return body;
    await pause(2000 * attempt);
  }
}

// ID3v2.4: syncsafe sizes, UTF-8 text.
const syncsafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
const frame = (id, body) => Buffer.concat([Buffer.from(id, 'latin1'), syncsafe(body.length), Buffer.from([0, 0]), body]);
const text = (id, value) => frame(id, Buffer.concat([Buffer.from([3]), Buffer.from(String(value), 'utf8')]));
const txxx = (desc, value) => frame('TXXX', Buffer.concat([Buffer.from([3]), Buffer.from(desc, 'utf8'), Buffer.from([0]), Buffer.from(value, 'utf8')]));
const ufid = (owner, id) => frame('UFID', Buffer.concat([Buffer.from(owner, 'latin1'), Buffer.from([0]), Buffer.from(id, 'latin1')]));
function id3(frames) {
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0]), syncsafe(body.length), body]);
}
// MPEG-2 Layer III, 8 kbps, 16 kHz, mono: 36-byte frames of 36 ms, all zero after the header (silence). A song
// takes a few hundred KB yet reports its real length.
const FRAME = Buffer.concat([Buffer.from([0xff, 0xf3, 0x18, 0xc0]), Buffer.alloc(32)]);
const silence = (ms) => Buffer.concat(Array(Math.max(1, Math.ceil(ms / 36))).fill(FRAME));

/** One album into `dir`: its shortest official release with six songs or more, tagged as Picard would. */
async function makeAlbum(dir, artist, title, genre) {
  const query = `releasegroup:"${title}" AND artist:"${artist}" AND primarytype:album`;
  const found = await musicBrainz(`release-group/?query=${encodeURIComponent(query)}&limit=1`);
  const group = found['release-groups']?.[0];
  if (!group) throw new Error(found.error ?? 'not on MusicBrainz');
  const releases = (await musicBrainz(`release?release-group=${group.id}&status=official&inc=recordings+media&limit=100`)).releases ?? [];
  const count = (r) => r.media.reduce((n, m) => n + (m['track-count'] ?? 0), 0);
  const release = releases.filter((r) => count(r) >= 6 && r.media.every((m) => m.tracks?.length)).sort((a, b) => count(a) - count(b))[0];
  if (!release) throw new Error('no release with its track list');
  const year = (group['first-release-date'] ?? '').slice(0, 4);
  const artistId = group['artist-credit']?.[0]?.artist?.id ?? '';
  mkdirSync(dir, { recursive: true });
  for (const [d, medium] of release.media.entries()) {
    for (const track of medium.tracks) {
      const name = `${release.media.length > 1 ? `${d + 1}-` : ''}${String(track.position).padStart(2, '0')} ${safe(track.title)}.mp3`;
      const tags = id3([
        text('TIT2', track.title), text('TPE1', artist), text('TPE2', artist), text('TALB', title),
        text('TRCK', `${track.position}/${medium.tracks.length}`), text('TPOS', `${d + 1}/${release.media.length}`),
        text('TDRC', year), text('TCON', genre),
        ufid('http://musicbrainz.org', track.recording.id),
        txxx('MusicBrainz Album Id', release.id), txxx('MusicBrainz Release Group Id', group.id),
        txxx('MusicBrainz Artist Id', artistId), txxx('MusicBrainz Album Artist Id', artistId),
        txxx('MusicBrainz Release Track Id', track.id),
      ]);
      writeFileSync(join(dir, name), Buffer.concat([tags, silence(track.length ?? track.recording.length ?? 240_000)]));
    }
  }
  const cover = await fetch(`https://coverartarchive.org/release-group/${group.id}/front-500`, { headers: AGENT }).catch(() => null);
  if (cover?.ok) writeFileSync(join(dir, 'cover.jpg'), Buffer.from(await cover.arrayBuffer()));
  return { songs: count(release), year, cover: !!cover?.ok };
}

/**
 * Make the albums `dir` doesn't have yet. Each is written to a hidden folder and renamed when complete, so an
 * interrupted run leaves no half album. Returns the albums it couldn't make.
 */
export async function buildLibrary(dir, log = console.log) {
  const missing = [];
  for (const [artist, title, genre] of ALBUMS) {
    const parent = join(dir, safe(artist));
    const final = join(parent, safe(title));
    if (existsSync(final)) continue;
    // An earlier run stopped halfway through this album.
    for (const name of existsSync(parent) ? readdirSync(parent) : []) {
      if (name.startsWith('.')) rmSync(join(parent, name), { recursive: true, force: true });
    }
    const partial = join(parent, `.${safe(title)}.partial`);
    try {
      const made = await makeAlbum(partial, artist, title, genre);
      renameSync(partial, final);
      log(`  ${artist} – ${title} (${made.year}): ${made.songs} songs${made.cover ? '' : ', no cover'}`);
    } catch (err) {
      rmSync(partial, { recursive: true, force: true });
      missing.push(`${artist} – ${title}`);
      log(`  ✗ ${artist} – ${title}: ${err.message}`);
    }
  }
  return missing;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) throw new Error('Usage: node scripts/web-screens/library.mjs <dir>');
  const missing = await buildLibrary(dir);
  if (missing.length) process.exitCode = 1;
}
