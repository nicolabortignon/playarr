/**
 * Genre tags → a dozen broad style families. Each family has a hue (OKLCH degrees) that the
 * cover generator paints with, and a lightness bias (some styles feel like paper, some like night).
 */

export type StyleFamily =
  | 'electronic'
  | 'chill'
  | 'rock'
  | 'metal'
  | 'pop'
  | 'hiphop'
  | 'soul'
  | 'jazz'
  | 'classical'
  | 'cinematic'
  | 'folk'
  | 'world'
  | 'experimental';

export interface FamilyInfo {
  label: string;
  hue: number;
  /** −1 (night) … +1 (paper): which background suits the style. */
  light: number;
  words: string[];
}

export const FAMILIES: Record<StyleFamily, FamilyInfo> = {
  electronic: {
    label: 'electronic',
    hue: 255,
    light: -0.3,
    words: ['electronic', 'electronica', 'techno', 'house', 'trance', 'edm', 'electro', 'idm', 'synthwave', 'big beat',
      'breakbeat', 'drum and bass', 'dnb', 'jungle', 'dubstep', 'uk garage', 'disco', 'dance', 'club', 'acid'],
  },
  chill: {
    label: 'ambient',
    hue: 195,
    light: 0.1,
    words: ['ambient', 'downtempo', 'chillout', 'chill', 'lounge', 'trip hop', 'trip-hop', 'new age', 'drone',
      'space music', 'dream pop', 'chillwave', 'easy listening'],
  },
  rock: {
    label: 'rock',
    hue: 28,
    light: -0.1,
    words: ['rock', 'punk', 'grunge', 'alternative', 'indie', 'post-punk', 'britpop', 'shoegaze', 'emo', 'garage',
      'new wave', 'psychedelic', 'surf'],
  },
  metal: {
    label: 'metal',
    hue: 12,
    light: -0.8,
    words: ['metal', 'doom', 'thrash', 'hardcore', 'grindcore', 'sludge', 'djent', 'metalcore'],
  },
  pop: {
    label: 'pop',
    hue: 350,
    light: 0.2,
    words: ['pop', 'synth-pop', 'synthpop', 'dance-pop', 'k-pop', 'j-pop', 'teen pop', 'bubblegum', 'europop'],
  },
  hiphop: {
    label: 'hip hop',
    hue: 300,
    light: -0.3,
    words: ['hip hop', 'hip-hop', 'rap', 'trap', 'grime', 'boom bap', 'drill', 'turntablism'],
  },
  soul: {
    label: 'soul & funk',
    hue: 58,
    light: 0,
    words: ['soul', 'funk', 'r&b', 'rnb', 'rhythm and blues', 'motown', 'gospel', 'neo soul', 'boogie'],
  },
  jazz: {
    label: 'jazz',
    hue: 78,
    light: 0.1,
    words: ['jazz', 'bebop', 'swing', 'fusion', 'bossa nova', 'blues', 'big band', 'ecm', 'free jazz', 'nu jazz'],
  },
  classical: {
    label: 'classical',
    hue: 92,
    light: 0.7,
    words: ['classical', 'baroque', 'orchestral', 'opera', 'choral', 'chamber', 'symphony', 'symphonic', 'romantic',
      'minimalism', 'modern classical', 'neoclassical', 'piano', 'medieval', 'renaissance', 'early music', 'gregorian'],
  },
  cinematic: {
    label: 'soundtrack',
    hue: 278,
    light: -0.2,
    words: ['soundtrack', 'score', 'film score', 'film', 'cinematic', 'video game', 'game', 'musical', 'ost',
      'television', 'tv'],
  },
  folk: {
    label: 'folk',
    hue: 138,
    light: 0.5,
    words: ['folk', 'acoustic', 'country', 'singer-songwriter', 'singer/songwriter', 'americana', 'bluegrass', 'celtic'],
  },
  world: {
    label: 'world',
    hue: 45,
    light: 0.2,
    words: ['world', 'latin', 'reggae', 'afrobeat', 'afro', 'african', 'brazilian', 'mpb', 'salsa', 'cumbia',
      'flamenco', 'dub', 'reggaeton', 'ska', 'bollywood', 'arabic'],
  },
  experimental: {
    label: 'experimental',
    hue: 112,
    light: -0.4,
    words: ['experimental', 'noise', 'avant-garde', 'avant garde', 'industrial', 'glitch', 'abstract',
      'musique concrète', 'improvisation', 'sound art'],
  },
};

/** Mood words: nudge colors warmer/cooler, and calmer. */
const WARM = ['happy', 'upbeat', 'summer', 'sunny', 'uplifting', 'party', 'feel good', 'fun', 'romantic', 'warm'];
const COOL = ['dark', 'melancholic', 'melancholy', 'sad', 'haunting', 'cold', 'night', 'atmospheric', 'eerie', 'bleak'];
const CALM = ['mellow', 'calm', 'relaxing', 'meditative', 'peaceful', 'soft', 'chill', 'quiet', 'sleep', 'gentle'];

const patterns = Object.entries(FAMILIES).map(([family, info]) => ({
  family: family as StyleFamily,
  regex: new RegExp(`(^|[^a-z])(${info.words.map(escape).join('|')})($|[^a-z])`),
}));

export interface StyleProfile {
  /** Family weights, summing to 1 (empty when nothing matched). */
  families: Partial<Record<StyleFamily, number>>;
  /** −1 … +1. */
  warmth: number;
  /** 0 … 1. */
  calm: number;
}

/** Weighted tags (any source) → style profile. */
export function styleProfile(tags: [tag: string, weight: number][]): StyleProfile {
  const families: Partial<Record<StyleFamily, number>> = {};
  let warm = 0;
  let cool = 0;
  let calm = 0;
  let moodWeight = 0;
  for (const [raw, weight] of tags) {
    const tag = raw.toLowerCase();
    for (const { family, regex } of patterns) {
      if (regex.test(tag)) families[family] = (families[family] ?? 0) + weight;
    }
    if (WARM.some((w) => tag.includes(w))) warm += weight;
    if (COOL.some((w) => tag.includes(w))) cool += weight;
    if (CALM.some((w) => tag.includes(w))) calm += weight;
    moodWeight += weight;
  }
  // Crowd tags are noisy: drop families with under 12% of the song's tag weight.
  let total = Object.values(families).reduce((s, w) => s + w, 0);
  for (const key of Object.keys(families) as StyleFamily[]) {
    if (families[key]! / total < 0.12) delete families[key];
  }
  total = Object.values(families).reduce((s, w) => s + w, 0);
  for (const key of Object.keys(families) as StyleFamily[]) families[key] = families[key]! / total;
  return {
    families,
    warmth: warm + cool ? (warm - cool) / (warm + cool) : 0,
    calm: moodWeight ? Math.min(1, (calm / moodWeight) * 4) : 0,
  };
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
