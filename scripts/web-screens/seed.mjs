// Give the tour's fresh server a life: claim it as Alex, add the library folder, and wait for its albums; then
// favorites, five playlists and four weeks of plays for Alex, Sam (a second listener with plays of their own) and
// an invite Jo hasn't taken up yet. A seeded random makes the same history every run, relative to today.
import { randomBytes } from 'node:crypto';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let s = 42;
const rnd = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

/** Seed the server at `base` with `library` as its folder. Returns the owner's username and password, and what it found. */
export async function seed(base, library) {
  s = 42;
  async function call(method, path, { token, body } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'X-Playarr': '1', ...(body && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
      body: body && JSON.stringify(body),
    });
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}${json?.error ? `: ${json.error}` : ''}`);
    return json;
  }

  const password = randomBytes(12).toString('base64url');
  const owner = await call('POST', '/api/auth/setup', { body: { username: 'alex', name: 'Alex', password, device: 'web screens', platform: 'script' } });
  const token = owner.token;
  const source = await call('POST', '/api/settings/sources', { token, body: { kind: 'folder', name: 'Music', settings: { path: library, access: 'local' } } });
  // The scan runs in the background: done when three looks in a row find the same albums.
  let albums = [];
  for (let stable = 0, deadline = Date.now() + 240_000; stable < 3 && Date.now() < deadline; await sleep(2000)) {
    const now = await call('GET', '/api/albums', { token });
    stable = now.length && now.length === albums.length ? stable + 1 : 0;
    albums = now;
  }
  if (!albums.length) throw new Error(`The server found no albums in ${library}`);
  const details = [];
  for (const a of albums) details.push(await call('GET', `/api/albums/${a.id}`, { token }));
  const byTitle = (title) => details.find((d) => d.title === title);

  // Favorites: up to two songs from most albums.
  for (const d of details) {
    for (const t of d.tracks.slice(1, 1 + Math.floor(rnd() * 3))) await call('PUT', `/api/favorites/${encodeURIComponent(t.recordingId)}`, { token });
  }

  // Playlists: the first songs of a few albums each.
  const from = (titles, n) => titles.flatMap((t) => (byTitle(t)?.tracks ?? []).slice(0, n)).map((t) => t.recordingId);
  const playlists = [
    ['Late night', 'Slow, low and after midnight.', from(['Mezzanine', 'Dummy', 'xx', 'For Emma, Forever Ago', 'Kind of Blue'], 3), true],
    ['Sunday morning', 'Coffee, sun, nowhere to be.', from(['Moon Safari', 'Con Todo El Mundo', 'Pastel Blues', 'Black Sands'], 3), false],
    ['Road trip', '', from(['Rumours', 'AM', 'Discovery', 'Random Access Memories', 'Remain in Light', 'Innervisions'], 3), false],
    ['Deep focus', 'Music to think to.', from(['Black Sands', 'Homogenic', 'In Rainbows', 'Moon Safari'], 4), false],
    ['Dinner party', 'For good company.', from(['Kind of Blue', 'Innervisions', 'Con Todo El Mundo', 'Pastel Blues', 'Random Access Memories'], 2), true],
  ];
  for (const [name, description, recordingIds, shared] of playlists) await call('POST', '/api/playlists', { token, body: { name, description, recordingIds, shared } });

  // Listening sessions in the morning, at lunch, in the evening and late at night, from a few favorite albums.
  function history(days, taste) {
    const plays = [];
    for (let day = days; day >= 1; day--) {
      for (const hour of [8, 13, 19, 23]) {
        if (rnd() > (hour === 19 ? 0.85 : 0.45)) continue;
        const start = new Date(Date.now() - day * 86_400_000);
        start.setHours(hour, Math.floor(rnd() * 50), 0, 0);
        let at = start.getTime();
        for (const t of (byTitle(pick(taste))?.tracks ?? []).slice(0, 4 + Math.floor(rnd() * 8))) {
          const skipped = rnd() < 0.12;
          const seconds = skipped ? 8 + Math.floor(rnd() * 20) : Math.round(t.duration);
          const when = new Date(at);
          plays.push({ trackId: t.id, recordingId: t.recordingId, at: when.toISOString(), hour: when.getHours(), weekday: when.getDay(), seconds, skipped });
          at += seconds * 1000;
        }
      }
    }
    return plays;
  }
  const alexTaste = ['Mezzanine', 'Mezzanine', 'Dummy', 'In Rainbows', 'In Rainbows', 'OK Computer', 'Discovery', 'Random Access Memories', 'Kind of Blue', 'xx', 'Moon Safari', 'Black Sands', 'Rumours', 'Con Todo El Mundo', 'To Pimp a Butterfly'];
  await call('POST', '/api/plays', { token, body: { plays: history(28, alexTaste) } });

  const sam = await call('POST', '/api/accounts', { token, body: { username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: [source.id] } });
  const samSession = await call('POST', '/api/auth/redeem', { body: { code: sam.setup.code, password: randomBytes(12).toString('base64url'), device: 'iPhone', platform: 'ios' } });
  await call('POST', '/api/plays', { token: samSession.token, body: { plays: history(14, ['AM', 'Rumours', 'Remain in Light', 'Innervisions', 'Homogenic']) } });
  await call('POST', '/api/accounts', { token, body: { username: 'jo', name: 'Jo', role: 'member', canRequest: true, sources: [source.id] } });

  // Each simulator signs in as Alex itself, so Settings lists their Safaris rather than this script.
  await call('POST', '/api/auth/sign-out', { token });
  return { username: 'alex', password, albums: albums.length, songs: details.reduce((n, d) => n + d.tracks.length, 0) };
}
