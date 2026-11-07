import type { AudioFormat } from '@playarr/shared';
import type { FolderFs, FoundFile } from '../catalog/folderFs.ts';
import type { TagInfo } from '../catalog/tags.ts';
import type { SourceAlbum, SourceArtist, SourceCopy, SourceSync, SourceTrack } from '../catalog/types.ts';
import type { MediaSource } from '../media/index.ts';

/**
 * A synthetic music library for measuring Playarr at a collector's size (plan 3 §1, `pnpm -C apps/server
 * bench:library`): by default 100,000 songs on about 10,000 albums by about 3,000 artists, with the variety real
 * tags have. Compilations, multi-disc albums, featured artists, names in many scripts, albums tagged with
 * MusicBrainz ids beside plainly tagged ones, a few untagged files and loose songs, an album or two in two
 * formats, and plausible paths, sizes, formats and dates. The same seed always gives the same library, so the
 * numbers can be taken again. A folder scan sees it as `files` (each with the tags reading it gives); Lidarr
 * reports it as `lidarr()`.
 */
export interface SyntheticFile extends FoundFile {
  tags: TagInfo;
}

export interface SyntheticLibrary {
  /** The folder the files are under. */
  root: string;
  /** Every audio file, by path relative to the root, with its tags. Change them to make a change on disk. */
  files: SyntheticFile[];
  /** The same music as Lidarr reports it (a new object each call): every album's songs, files or not. */
  lidarr(): SourceSync;
  /** What was generated, before any source has merged it. */
  counts: { artists: number; albums: number; songs: number; files: number };
  /** What listeners type into search over this library: names in full and in part, typos, other scripts. */
  queries: { label: string; q: string }[];
}

export interface SyntheticOptions {
  /** How many songs (files of songs, loose songs included); 100,000 by default. */
  tracks?: number;
  seed?: number;
  root?: string;
}

const VARIOUS = 'Various Artists';
const VARIOUS_MBID = '89ad4ac3-39f7-470e-963a-56509c546377';

const FIRST = ['Anna', 'Ben', 'Clara', 'David', 'Elena', 'Felix', 'Grace', 'Hugo', 'Iris', 'Jonas', 'Kate', 'Leo', 'Maya', 'Nina', 'Oscar', 'Paula', 'Quentin', 'Rosa', 'Sam', 'Tara', 'Uma', 'Victor', 'Wendy', 'Xavier', 'Yara', 'Aaron', 'Bianca', 'Carlos', 'Dana', 'Emil', 'Freya', 'Gabriel', 'Hanna', 'Ivan', 'Julia', 'Karl', 'Lena', 'Marco', 'Nora', 'Olga', 'Pedro', 'Ruth', 'Sofia', 'Tom', 'Vera', 'Will', 'Ada', 'Bruno', 'Cecilia', 'Dexter', 'Edith', 'Frank', 'Gloria', 'Harvey', 'Ines', 'Jack', 'Kira', 'Louis', 'Miles', 'Nico'];
const FIRST_ACCENTED = ['José', 'Zoë', 'Søren', 'Ægir', 'Łukasz', 'Željko', 'Mårten', 'Ólafur', 'Ásgeir', 'Chloé', 'Renée', 'Noël', 'Raphaël', 'Héloïse', 'Inès', 'Agnès', 'Joaquín', 'Martín', 'Sebastián', 'Ramón', 'Iñaki', 'Gösta', 'Jürgen', 'Antonín', 'Ľubomír', 'Özge', 'Çağla', 'Şebnem', 'Päivi', 'Ørjan', 'Øystein', 'François', 'Thérèse', 'Zdeněk', 'Dóra', 'Bjørn'];
const LAST = ['Adams', 'Baker', 'Carter', 'Dalton', 'Evans', 'Fischer', 'Garcia', 'Hughes', 'Ivers', 'Jensen', 'Klein', 'Lopez', 'Moreau', 'Nash', 'Olsen', 'Park', 'Quinn', 'Reyes', 'Stone', 'Turner', 'Ulrich', 'Vance', 'Walsh', 'Young', 'Zimmer', 'Brooks', 'Cole', 'Dunn', 'Ellis', 'Ford', 'Grant', 'Hale', 'Irwin', 'Jacobs', 'Kerr', 'Lowe', 'Marsh', 'Noble', 'Owens', 'Pryce', 'Rhodes', 'Shaw', 'Tate', 'Webb', 'Wolfe', 'Hart', 'Bishop', 'Coleman', 'Davies', 'Fletcher'];
const LAST_ACCENTED = ['Núñez', 'Gonçalves', 'Müller', 'Sørensen', 'Ångström', 'Kowalczyk', 'Dvořáková', 'Østergaard', 'Fernández', 'Hernández', 'Lévesque', 'Chénier', 'Ibáñez', 'Štěpánek', 'Szabó', 'Kovačević', 'Jóhannsson', 'Gíslason', 'Ólafsdóttir', 'Björnsson', 'Ruíz', 'Peña', 'Löfgren', 'Kärkkäinen'];
const ADJ = ['Velvet', 'Silent', 'Golden', 'Electric', 'Hollow', 'Crimson', 'Neon', 'Paper', 'Wild', 'Lunar', 'Broken', 'Glass', 'Iron', 'Secret', 'Northern', 'Midnight', 'Static', 'Burning', 'Frozen', 'Distant', 'Gentle', 'Savage', 'Little', 'Endless', 'Hidden', 'Bright', 'Sleeping', 'Painted', 'Restless', 'Lonely', 'Copper', 'Silver', 'Purple', 'Blue', 'Black', 'White', 'Red', 'Green', 'Young', 'Ancient', 'Quiet', 'Strange', 'Sacred', 'Sweet', 'Bitter', 'Heavy', 'Tender', 'Last', 'First', 'Open'];
const NOUN = ['Foxes', 'Harbor', 'Echoes', 'Parade', 'Lanterns', 'Tides', 'Wolves', 'Engines', 'Gardens', 'Mirrors', 'Satellites', 'Rivers', 'Sparrows', 'Machines', 'Ghosts', 'Horses', 'Arrows', 'Strangers', 'Kings', 'Daughters', 'Pilots', 'Saints', 'Shadows', 'Waves', 'Comets', 'Cities', 'Lovers', 'Dreamers', 'Giants', 'Monsters', 'Orchestra', 'Collective', 'Society', 'Brothers', 'Sisters', 'Club', 'Assembly', 'Quartet', 'Trio', 'Band'];
const WORDS = ['Love', 'Night', 'Summer', 'Dream', 'Light', 'Heart', 'Fire', 'Rain', 'Gold', 'Sky', 'Road', 'Home', 'Time', 'World', 'Ocean', 'Star', 'Moon', 'Sun', 'City', 'River', 'Song', 'Story', 'Life', 'Soul', 'Blood', 'Bone', 'Stone', 'Glass', 'Paper', 'Silver', 'Shadow', 'Mirror', 'Garden', 'Window', 'Door', 'House', 'Room', 'Island', 'Desert', 'Forest', 'Mountain', 'Valley', 'Storm', 'Thunder', 'Winter', 'Autumn', 'Spring', 'Morning', 'Evening', 'Midnight', 'Dawn', 'Dusk', 'Echo', 'Silence', 'Noise', 'Signal', 'Radio', 'Machine', 'Engine', 'Wheel', 'Wire', 'Ghost', 'Angel', 'Devil', 'Saint', 'King', 'Queen', 'Prince', 'Sister', 'Brother', 'Mother', 'Father', 'Children', 'Lover', 'Stranger', 'Friend', 'Hero', 'Thief', 'Dancer', 'Singer', 'Pilot', 'Sailor', 'Wonder', 'Fever', 'Gravity', 'Velocity', 'Paradise', 'Heaven', 'Memory', 'Promise', 'Secret', 'Truth', 'Sorrow', 'Joy', 'Hope', 'Fear', 'Desire', 'Freedom', 'Danger', 'Mercy', 'Glory', 'Grace', 'Tomorrow', 'Yesterday', 'Kingdom', 'Empire', 'Satellite', 'Horizon', 'Highway', 'Harbour', 'Lantern', 'Ribbon', 'Feather', 'Diamond', 'Velvet', 'Neon', 'Chrome', 'Marble', 'Honey', 'Cherry', 'Orange', 'Lemon', 'Violet', 'Scarlet', 'Indigo', 'Amber', 'Ivory', 'Coral', 'Jade'];
const EDITIONS = [' (Deluxe Edition)', ' (Remastered 2011)', ' - Expanded Edition', ' (Live)', ' (25th Anniversary Edition)', ' [Bonus Tracks]'];
const TITLE_EXTRAS = [' (Remix)', ' (Live)', ' - 2011 Remaster', ' (Acoustic)', ' (Radio Edit)', ' (Demo)', ', Pt. 2', ' (Reprise)'];
const CJK_FAMILY = ['坂本', '宇多田', '久石', '椎名', '山下', '岡村', '細野', '小沢', '矢野', '大貫', '김', '이', '박', '최', '王', '陳', '周', '林'];
const CJK_GIVEN = ['龍一', 'ヒカル', '譲', '林檎', '達郎', '靖幸', '晴臣', '健二', '顕子', '妙子', '서연', '민준', '지우', '하늘', '菲', '奕迅', '杰倫', '憶蓮'];
const CJK_WORDS = ['夏', '東京', '風', '星空', '光', '影', '海', '夜', '雨', '花', '月', '空', '사랑', '바다', '하늘', '꿈', '城市', '時間'];
const CYRILLIC = ['Кино', 'Аквариум', 'Земфира', 'Сплин', 'Ленинград', 'Звуки', 'Ночь', 'Лето', 'Звезда', 'Солнце', 'Город', 'Группа', 'Крови', 'Весна', 'Река', 'Пётр', 'Ольга', 'Дождь'];
const GREEK = ['Ελένη', 'Βαγγέλης', 'Μίκης', 'Θάλασσα', 'Ήλιος', 'Νύχτα', 'Αγάπη', 'Όνειρο', 'Φως', 'Καραΐνδρου', 'Παπαθανασίου'];
const GENRES = ['rock', 'indie rock', 'electronic', 'jazz', 'hip hop', 'classical', 'ambient', 'trip hop', 'metal', 'folk', 'soul', 'funk', 'pop', 'synthpop', 'post-rock', 'punk', 'techno', 'house', 'drum and bass', 'reggae', 'blues', 'country', 'r&b', 'dream pop', 'shoegaze', 'krautrock', 'bossa nova', 'afrobeat', 'j-pop', 'k-pop', 'chanson', 'fado', 'flamenco', 'tango', 'opera', 'baroque', 'minimal', 'dub', 'grime', 'garage'];

interface FormatChoice {
  weight: number;
  ext: string;
  format: AudioFormat;
}
const FORMATS: FormatChoice[] = [
  { weight: 45, ext: 'flac', format: { codec: 'FLAC', container: 'flac', bits: 16, sampleRate: 44100, bitrate: 900, channels: 2, lossless: true } },
  { weight: 10, ext: 'flac', format: { codec: 'FLAC', container: 'flac', bits: 24, sampleRate: 96000, bitrate: 2800, channels: 2, lossless: true } },
  { weight: 3, ext: 'flac', format: { codec: 'FLAC', container: 'flac', bits: 24, sampleRate: 48000, bitrate: 1500, channels: 2, lossless: true } },
  { weight: 22, ext: 'mp3', format: { codec: 'MP3', container: 'mp3', sampleRate: 44100, bitrate: 320, channels: 2, lossless: false } },
  { weight: 10, ext: 'mp3', format: { codec: 'MP3', container: 'mp3', sampleRate: 44100, bitrate: 245, channels: 2, lossless: false } },
  { weight: 6, ext: 'm4a', format: { codec: 'AAC', container: 'm4a', sampleRate: 44100, bitrate: 256, channels: 2, lossless: false } },
  { weight: 2, ext: 'm4a', format: { codec: 'ALAC', container: 'm4a', bits: 16, sampleRate: 44100, bitrate: 850, channels: 2, lossless: true } },
  { weight: 1, ext: 'opus', format: { codec: 'OPUS', container: 'opus', sampleRate: 48000, bitrate: 160, channels: 2, lossless: false } },
  { weight: 1, ext: 'ogg', format: { codec: 'VORBIS', container: 'ogg', sampleRate: 44100, bitrate: 192, channels: 2, lossless: false } },
];

/** Small, fast and seedable (mulberry32): the same seed, the same library. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const chance = (p: number) => next() < p;
  /** Mostly the first items: a few artists have many albums, most have one or two. */
  const skewed = <T>(list: readonly T[]): T => list[Math.floor(next() ** 1.5 * list.length)]!;
  const hex = (n: number) => {
    let s = '';
    for (let i = 0; i < n; i++) s += Math.floor(next() * 16).toString(16);
    return s;
  };
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`;
  return { next, int, pick, chance, skewed, uuid };
}

interface Artist {
  id: number;
  name: string;
  sortName: string;
  mbid: string;
  genres: string[];
  script: 'latin' | 'accented' | 'cjk' | 'cyrillic' | 'greek';
}

interface Song {
  id: number;
  /** The file's id in Lidarr; undefined for a song of the album nobody has a file of. */
  fileId?: number;
  title: string;
  /** The song's credit: the album's artist, or someone else on a compilation, with any featured guest. */
  credit: string;
  creditMbid: string;
  recordingMbid: string;
  trackNumber: number;
  discNumber: number;
  duration: number;
  explicit: boolean;
}

interface Album {
  id: number;
  artist: Artist | null;
  title: string;
  year: number;
  month: number;
  mbid: string;
  albumType: string;
  secondaryTypes: string[];
  genres: string[];
  choice: FormatChoice;
  /** How the files are tagged: with MusicBrainz ids, plainly, or not at all (the path says it all). */
  tagging: 'mb' | 'plain' | 'bare';
  discs: number;
  songs: Song[];
  /** Songs of the album on disk: all of them, less a few on albums only partly there. */
  present: Set<number>;
  trackTotal?: number;
  folder: string;
  /** A second copy of the album in another format, in a folder of its own. */
  twin?: { choice: FormatChoice; folder: string };
  imageVersion: number;
}

/** Characters no file name may have, as a tagger would replace them. */
const safe = (name: string) => name.replace(/[/\\:*?"<>|]/g, '_').replace(/\.+$/, '');

export function syntheticLibrary(opts: SyntheticOptions = {}): SyntheticLibrary {
  const target = opts.tracks ?? 100_000;
  const root = opts.root ?? '/music';
  const r = prng(opts.seed ?? 1);
  const artistCount = Math.max(3, Math.round(target / 33));

  const artistNames = new Set<string>();
  const artists: Artist[] = [];
  for (let id = 1; artists.length < artistCount; id++) {
    const roll = r.next();
    let name: string;
    let sortName: string;
    let script: Artist['script'] = 'latin';
    if (roll < 0.06) {
      script = 'cjk';
      name = `${r.pick(CJK_FAMILY)}${r.pick(CJK_GIVEN)}`;
      sortName = name;
    } else if (roll < 0.09) {
      script = 'cyrillic';
      name = r.chance(0.5) ? r.pick(CYRILLIC) : `${r.pick(CYRILLIC)} ${r.pick(CYRILLIC)}`;
      sortName = name;
    } else if (roll < 0.1) {
      script = 'greek';
      name = `${r.pick(GREEK)} ${r.pick(GREEK)}`;
      sortName = name;
    } else if (roll < 0.22) {
      script = 'accented';
      const first = r.pick(FIRST_ACCENTED);
      const last = r.chance(0.6) ? r.pick(LAST_ACCENTED) : r.pick(LAST);
      name = `${first} ${last}`;
      sortName = `${last}, ${first}`;
    } else if (roll < 0.5) {
      const first = r.pick(FIRST);
      const last = r.pick(LAST);
      name = `${first} ${last}`;
      sortName = `${last}, ${first}`;
    } else if (roll < 0.75) {
      const band = `${r.pick(ADJ)} ${r.pick(NOUN)}`;
      name = `The ${band}`;
      sortName = `${band}, The`;
    } else if (roll < 0.9) {
      name = r.chance(0.5) ? `${r.pick(WORDS)} ${r.pick(NOUN)}` : `${r.pick(ADJ)}${r.pick(WORDS).toLowerCase()}`;
      sortName = name;
    } else {
      name = `${r.pick(FIRST)} ${r.pick(LAST)} & the ${r.pick(NOUN)}`;
      sortName = name;
    }
    // A name taken already gets a number, as real bands do ("Blue Horses 2").
    if (artistNames.has(name)) name = `${name} ${id}`;
    if (artistNames.has(name)) continue;
    artistNames.add(name);
    const genres = Array.from({ length: r.int(1, 3) }, () => r.pick(GENRES)).filter((g, i, all) => all.indexOf(g) === i);
    artists.push({ id, name, sortName, mbid: r.uuid(), genres, script });
  }

  const titleOf = (script: Artist['script'], words: number) => {
    if (script === 'cjk') return Array.from({ length: Math.min(words, 3) }, () => r.pick(CJK_WORDS)).join('');
    if (script === 'cyrillic') return Array.from({ length: words }, () => r.pick(CYRILLIC)).join(' ');
    if (script === 'greek') return Array.from({ length: words }, () => r.pick(GREEK)).join(' ');
    const roll = r.next();
    if (words === 1 || roll < 0.25) return r.pick(WORDS);
    if (roll < 0.55) return `${r.pick(ADJ)} ${r.pick(WORDS)}`;
    if (roll < 0.7) return `${r.pick(WORDS)} of ${r.pick(WORDS)}`;
    if (roll < 0.8) return `The ${r.pick(ADJ)} ${r.pick(WORDS)}`;
    if (roll < 0.9) return `${r.pick(WORDS)} & ${r.pick(WORDS)}`;
    return `${r.pick(WORDS)} ${r.pick(WORDS)} ${r.pick(WORDS)}`;
  };
  const durationOf = () => {
    const roll = r.next();
    if (roll < 0.02) return r.int(600, 1500);
    if (roll < 0.03) return r.int(20, 60);
    return Math.max(70, Math.round(230 + (r.next() + r.next() + r.next() - 1.5) * 160));
  };
  const formatOf = (): FormatChoice => {
    let roll = r.next() * FORMATS.reduce((n, f) => n + f.weight, 0);
    for (const f of FORMATS) if ((roll -= f.weight) < 0) return f;
    return FORMATS[0]!;
  };

  // Recordings an artist has made, so a compilation can carry the same recording as the artist's own album.
  const recordingsOf = new Map<number, Song[]>();
  const albums: Album[] = [];
  let songId = 1;
  let fileId = 1;
  let files = 0;
  const albumTitles = new Set<string>();
  while (files < target * 0.99) {
    const id = albums.length + 1;
    const compilation = r.chance(0.05);
    const artist = compilation ? null : r.skewed(artists);
    const script = artist?.script ?? 'latin';
    let title = titleOf(script, r.int(1, 3));
    if (script === 'latin' && r.chance(0.05)) title += r.pick(EDITIONS);
    const titleKey = `${artist?.id ?? 0}|${title}`;
    if (albumTitles.has(titleKey)) title = `${title} ${r.pick(['II', 'III', 'IV', 'Vol. 2', 'Vol. 3'])}`;
    albumTitles.add(`${artist?.id ?? 0}|${title}`);
    const year = Math.min(2026, Math.max(1955, Math.round(1998 + (r.next() + r.next() - 1) * 40)));
    const roll = r.next();
    const albumType = compilation ? 'Album' : roll < 0.82 ? 'Album' : roll < 0.93 ? 'EP' : 'Single';
    const secondaryTypes = compilation ? ['Compilation'] : r.chance(0.03) ? ['Live'] : r.chance(0.01) ? ['Soundtrack'] : [];
    const discs = albumType === 'Album' && r.chance(0.08) ? r.int(2, 3) : 1;
    const perDisc = compilation ? r.int(15, 22) : albumType === 'Single' ? r.int(1, 3) : albumType === 'EP' ? r.int(4, 6) : r.int(8, 13);
    const tagRoll = r.next();
    const choice = formatOf();
    const album: Album = {
      id,
      artist,
      title,
      year,
      month: r.int(1, 12),
      mbid: r.uuid(),
      albumType,
      secondaryTypes,
      genres: artist ? artist.genres.slice(0, r.int(0, artist.genres.length)) : [r.pick(GENRES)],
      choice,
      tagging: tagRoll < 0.65 ? 'mb' : tagRoll < 0.98 ? 'plain' : 'bare',
      discs,
      songs: [],
      present: new Set(),
      folder: '',
      imageVersion: r.int(1_600_000_000, 1_790_000_000),
    };
    for (let disc = 1; disc <= discs; disc++) {
      for (let n = 1; n <= perDisc; n++) {
        const by = compilation ? r.skewed(artists) : artist!;
        const reuse = compilation && album.tagging === 'mb' && r.chance(0.5) ? recordingsOf.get(by.id)?.[r.int(0, (recordingsOf.get(by.id)?.length ?? 1) - 1)] : undefined;
        const guest = !compilation && r.chance(0.08) ? r.pick(artists) : undefined;
        let songTitle = reuse?.title ?? titleOf(by.script, r.int(1, 3));
        if (!reuse && by.script === 'latin' && r.chance(0.05)) songTitle += r.pick(TITLE_EXTRAS);
        if (!reuse && n === 1 && r.chance(0.03)) songTitle = 'Intro';
        const song: Song = {
          id: songId++,
          title: songTitle,
          credit: guest && guest !== by ? `${by.name} feat. ${guest.name}` : by.name,
          creditMbid: by.mbid,
          recordingMbid: reuse?.recordingMbid ?? r.uuid(),
          trackNumber: n,
          discNumber: disc,
          duration: reuse?.duration ?? durationOf(),
          explicit: r.chance(0.05),
        };
        album.songs.push(song);
        if (!compilation && !reuse) {
          const list = recordingsOf.get(by.id) ?? [];
          list.push(song);
          recordingsOf.set(by.id, list);
        }
      }
    }
    // Most albums are whole; a few are missing a song or three, and a few don't say how long they are.
    const missing = album.songs.length > 4 && r.chance(0.04) ? r.int(1, 3) : 0;
    for (const song of album.songs) album.present.add(song.id);
    for (let i = 0; i < missing; i++) album.present.delete(r.pick(album.songs).id);
    album.trackTotal = r.chance(0.8) ? perDisc : undefined;
    const artistFolder = safe(artist?.name ?? VARIOUS);
    const roll2 = r.next();
    const albumFolder = roll2 < 0.6 ? `${title} (${year})` : roll2 < 0.85 ? `${year} - ${title}` : `${title} [${choice.format.codec}]`;
    album.folder = `${artistFolder}/${safe(albumFolder)}`;
    if (r.chance(0.005)) {
      const other = FORMATS[choice.format.lossless ? 3 : 0]!;
      album.twin = { choice: other, folder: `${artistFolder}/${safe(`${title} [${other.format.codec}]`)}` };
    }
    for (const song of album.songs) if (album.present.has(song.id)) song.fileId = fileId++;
    files += album.present.size;
    albums.push(album);
  }

  const DAY = 86_400_000;
  const since = Date.UTC(2008, 0, 1);
  const until = Date.UTC(2026, 9, 1);
  const out: SyntheticFile[] = [];
  const fileOf = (album: Album, song: Song, choice: FormatChoice, folder: string) => {
    const multi = album.discs > 1;
    // A multi-disc album's songs are numbered "2-05", or kept in a folder per disc ("CD2/05 - …").
    const discInName = multi && album.id % 2 === 0;
    const nn = `${discInName ? `${song.discNumber}-` : ''}${String(song.trackNumber).padStart(2, '0')}`;
    const credit = album.artist ? '' : `${safe(song.credit)} - `;
    const rel = `${folder}/${multi && !discInName ? `CD${song.discNumber}/` : ''}${nn} - ${credit}${safe(song.title)}.${choice.ext}`;
    const mtimeMs = Math.floor(since + r.next() * (until - since));
    const bytes = Math.round((choice.format.bitrate! * 1000 * song.duration) / 8) + r.int(20_000, 1_200_000);
    const tags: TagInfo =
      album.tagging === 'bare'
        ? { genres: [], duration: song.duration, format: { ...choice.format } }
        : {
            title: song.title,
            artist: song.credit,
            albumArtist: album.artist?.name ?? VARIOUS,
            album: album.title,
            trackNumber: song.trackNumber,
            ...(album.trackTotal ? { trackTotal: album.trackTotal } : {}),
            ...(multi || r.chance(0.3) ? { discNumber: song.discNumber } : {}),
            year: album.year,
            genres: album.genres.length ? album.genres.slice(0, 1) : [],
            duration: song.duration,
            ...(album.tagging === 'mb'
              ? {
                  recordingMbid: song.recordingMbid,
                  releaseGroupMbid: album.mbid,
                  artistMbid: song.creditMbid,
                  albumArtistMbid: album.artist?.mbid ?? VARIOUS_MBID,
                }
              : {}),
            format: { ...choice.format },
          };
    out.push({
      rel,
      path: `${root}/${rel}`,
      size: bytes,
      mtimeMs,
      ...(r.chance(0.7) ? { createdMs: Math.min(until, mtimeMs + Math.floor(r.next() * 400 * DAY)) } : {}),
      tags,
    });
  };
  for (const album of albums) {
    for (const song of album.songs) {
      if (!album.present.has(song.id)) continue;
      fileOf(album, song, album.choice, album.folder);
      if (album.twin) fileOf(album, song, album.twin.choice, album.twin.folder);
    }
  }
  // Loose songs: a single downloaded on its own, filed under its artist with no album.
  const loose: Song[] = [];
  while (out.length < target) {
    const by = r.skewed(artists);
    const song: Song = { id: songId++, title: titleOf(by.script, r.int(1, 3)), credit: by.name, creditMbid: by.mbid, recordingMbid: r.uuid(), trackNumber: 0, discNumber: 1, duration: durationOf(), explicit: false };
    loose.push(song);
    const choice = FORMATS[3]!;
    const rel = `${safe(by.name)}/${safe(song.title)} ${song.id}.${choice.ext}`;
    const mtimeMs = Math.floor(since + r.next() * (until - since));
    out.push({
      rel,
      path: `${root}/${rel}`,
      size: Math.round((320_000 * song.duration) / 8),
      mtimeMs,
      tags: { title: song.title, artist: by.name, genres: [], duration: song.duration, format: { ...choice.format } },
    });
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const lidarr = (): SourceSync => {
    const usedArtists = new Map<number | 'va', SourceArtist>();
    const sourceAlbums: SourceAlbum[] = [];
    const tracks: SourceTrack[] = [];
    const copies: SourceCopy[] = [];
    for (const album of albums) {
      const artist = album.artist;
      const artistKey = `mb:${artist?.mbid ?? VARIOUS_MBID}`;
      if (!usedArtists.has(artist?.id ?? 'va')) {
        usedArtists.set(artist?.id ?? 'va', {
          key: artistKey,
          preferredId: artist?.id ?? artistCount + 1,
          mbid: artist?.mbid ?? VARIOUS_MBID,
          name: artist?.name ?? VARIOUS,
          sortName: artist?.sortName ?? VARIOUS,
          genres: artist?.genres ?? [],
          ...(artist && artist.id % 3 === 0 ? { overview: `${artist.name} have been making records since ${1960 + (artist.id % 60)}.` } : {}),
          ...(artist && artist.id % 5 !== 0 ? { imageUrl: `/art/artist/${artist.id}/poster?v=${album.imageVersion}` } : {}),
          ...(artist && artist.id % 2 === 0 ? { fanartUrl: `/art/artist/${artist.id}/fanart?v=${album.imageVersion}` } : {}),
        });
      }
      const albumKey = `mb:${album.mbid}`;
      sourceAlbums.push({
        key: albumKey,
        preferredId: album.id,
        artistKey,
        mbid: album.mbid,
        title: album.title,
        albumType: album.albumType,
        secondaryTypes: album.secondaryTypes,
        releaseDate: `${album.year}-${String(album.month).padStart(2, '0')}-01T00:00:00Z`,
        genres: album.genres,
        ...(album.id % 5 === 0 ? { overview: `${album.title} is the record that ${artist?.name ?? 'everyone'} made in ${album.year}.` } : {}),
        coverUrl: `/art/album/${album.id}/cover?v=${album.imageVersion}`,
        totalTrackCount: album.songs.length,
      });
      const keys = new Set<string>();
      for (const song of album.songs) {
        // The same recording twice on one album (a compilation's): the repeat gets its own key, as Lidarr's do.
        let key = `${albumKey}#${song.recordingMbid}`;
        for (let n = 2; keys.has(key); n++) key = `${albumKey}#${song.recordingMbid}#${n}`;
        keys.add(key);
        tracks.push({
          key,
          preferredId: song.id,
          albumKey,
          recordingId: song.recordingMbid,
          title: song.title,
          trackNumber: song.trackNumber,
          discNumber: song.discNumber,
          duration: song.duration,
          explicit: song.explicit,
        });
        if (song.fileId === undefined) continue;
        const nn = String(song.trackNumber).padStart(2, '0');
        const path = `${root}/${album.folder}/${album.discs > 1 ? `CD${song.discNumber}/` : ''}${nn} - ${safe(song.title)}.${album.choice.ext}`;
        copies.push({
          ref: String(song.fileId),
          preferredId: song.fileId,
          trackKey: key,
          path,
          size: Math.round((album.choice.format.bitrate! * 1000 * song.duration) / 8) + 40_000 + (song.fileId % 977) * 1000,
          format: { ...album.choice.format },
          addedAt: new Date(since + ((song.fileId * 7919) % (until - since))).toISOString(),
        });
      }
    }
    return {
      artists: [...usedArtists.values()],
      albums: sourceAlbums,
      tracks,
      copies,
      metaRank: 0,
      lidarrAlbums: [
        ...albums.map((a) => ({ mbid: a.mbid, lidarrId: a.id, monitored: true })),
        // Albums Lidarr knows of that nobody has a file of: Discover and requests ask about them.
        ...albums.filter((a) => a.id % 5 === 0).map((a, i) => ({ mbid: `${a.mbid.slice(0, -4)}ffff`, lidarrId: albums.length + i + 1, monitored: i % 2 === 0 })),
      ],
    };
  };

  return {
    root,
    files: out,
    lidarr,
    counts: { artists: artists.length, albums: albums.length, songs: songId - 1, files: out.length },
    queries: searchQueries(artists, albums, loose, r),
  };
}

/** A dozen searches as people type them, drawn from the library so each finds what it's after (or nothing). */
function searchQueries(artists: Artist[], albums: Album[], loose: Song[], r: ReturnType<typeof prng>): { label: string; q: string }[] {
  const latin = artists.filter((a) => a.script === 'latin' && !a.name.startsWith('The '));
  const band = artists.find((a) => a.name.startsWith('The ') && !/\d/.test(a.name))!;
  const accented = artists.find((a) => a.script === 'accented' && /[À-ž]/.test(a.name))!;
  const cjk = artists.find((a) => a.script === 'cjk')!;
  const someone = latin[Math.floor(latin.length / 3)] ?? artists[0]!;
  const album = albums.find((a) => a.artist?.script === 'latin' && a.title.split(' ').length >= 2 && !a.title.includes('('))!;
  const song = albums[Math.floor(albums.length / 2)]!.songs.find((s) => s.title.split(' ').length >= 2) ?? albums[0]!.songs[0]!;
  const plain = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  // A letter dropped from a long word of a name: "radiohed".
  const long = latin.find((a) => a.name.split(' ').some((w) => w.length >= 7)) ?? someone;
  const word = long.name.split(' ').find((w) => w.length >= 7) ?? long.name;
  const typo = long.name.replace(word, word.slice(0, -2) + word.slice(-1)).toLowerCase();
  const longest = (s: string) => s.split(' ').reduce((a, b) => (b.length > a.length ? b : a));
  return [
    { label: 'artist, in full', q: someone.name },
    { label: 'artist, as typed so far', q: someone.name.slice(0, 4).toLowerCase() },
    { label: 'band without “the”', q: band.name.slice(4) },
    { label: 'album, in full', q: album.title },
    { label: 'song, in full', q: song.title },
    { label: 'artist and song', q: `${song.credit.split(' feat. ')[0]} ${longest(song.title)}` },
    { label: 'accented name, typed plain', q: plain(accented.name).toLowerCase() },
    { label: 'CJK name', q: cjk.name },
    { label: 'one common word', q: 'love' },
    { label: 'two letters', q: 'th' },
    { label: 'a typo (near match)', q: typo },
    { label: 'nothing like it', q: `zq${r.int(100, 999)}xv` },
    { label: 'loose song', q: (loose[0] ?? song).title },
  ];
}

/**
 * A folder source's filesystem over a synthetic library, as this server's disk would show it: listing the files
 * as they are now (change `library.files` to change the disk), and reading each file's tags. Counts how many
 * files had their tags read, which only new and changed files should.
 */
export function syntheticFolderFs(library: { root: string; files: SyntheticFile[] }): FolderFs & { tagsRead: number } {
  const media: MediaSource = {
    kind: 'local',
    stat: async () => ({ size: 0, mtimeMs: 0 }) as never,
    open: async () => {
      throw new Error('A synthetic library has no audio');
    },
    check: async () => {},
    close: async () => {},
  };
  // The files by path as the last listing found them: a scan reads the tags of the files it has just listed.
  let byPath = new Map<string, SyntheticFile>();
  const fs = {
    kind: 'local' as const,
    concurrency: 8,
    media,
    tagsRead: 0,
    stat: async (path: string) => (path === library.root ? { size: 0, mtimeMs: 0, dir: true } : null),
    readdir: async () => [],
    listAudio: async (): Promise<FoundFile[]> => {
      byPath = new Map(library.files.map((f) => [f.path, f]));
      return library.files.map(({ tags: _tags, ...file }) => file);
    },
    readTags: async (path: string) => {
      fs.tagsRead++;
      const file = byPath.get(path);
      return file ? structuredClone(file.tags) : null;
    },
    picture: async () => null,
    readFile: async () => Buffer.alloc(0),
    close: async () => {},
  };
  return fs;
}
