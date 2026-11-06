// Keeps both apps on the design language (docs/design.md): pages take colors, type sizes and radii from the tokens,
// never raw values.
//   Web: no hex colors, no color functions (rgb(), hsl(), oklch()…), no Tailwind palette colors (text-red-400,
//   bg-white; black only in a shadow) and no arbitrary text sizes (text-[13px]): colors come from index.css's tokens,
//   sizes from its type-* roles.
//   iOS: no Color(red:), .system(size:) or literal corner radii outside Theme/.
// Where a raw value is the point, ALLOW below says where and why.
//
// Usage: node scripts/check-design.mjs [--app web|ios] [--report] [--root <dir>]
//   Both apps unless --app names one. The web enforces the check: any finding fails (exit 1), and the web's typecheck
//   runs it. iOS is report-only until its own sweep: its findings are counted, never failed. --report lists every
//   finding of the apps checked and exits 0. --root checks another copy of the repo (the check's own test does).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const HUES = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const UTILITIES = 'text|bg|border(?:-[xytrbls])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|divide|decoration|accent|caret|placeholder';

const RULES = [
  {
    app: 'web',
    enforced: true,
    dir: 'apps/web/src',
    files: /\.tsx?$/,
    skip: /\.test\.tsx?$/,
    checks: [
      // After a quote, a space, a bracket, a comma or Tailwind's underscore: "#ff7a1a", bg-[#123], circle,#2a2823.
      { name: 'hex color', pattern: /(?<![A-Za-z0-9&#-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![A-Za-z0-9-])/ },
      { name: 'color function', pattern: /(?<![A-Za-z0-9-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/ },
      // Any of Tailwind's own colors; black only in a shadow, where it's the shadow's color rather than a surface's.
      {
        name: 'palette color',
        pattern: new RegExp(`(?<![\\w-])(?:(?:${UTILITIES}|shadow)-(?:white|(?:${HUES})-\\d{2,3})|(?:${UTILITIES})-black)(?![\\w-])`),
      },
      { name: 'arbitrary text size', pattern: /(?<![\w-])text-\[(?:length:)?\d*\.?\d+(?:px|rem|em|pt)\]/ },
    ],
  },
  {
    app: 'ios',
    enforced: false,
    dir: 'apps/ios/Packages/PlayarrUI/Sources/PlayarrUI',
    files: /\.swift$/,
    skip: /^Theme\//,
    checks: [
      { name: 'Color(red:)', pattern: /Color\(red:/ },
      { name: '.system(size:)', pattern: /\.system\(size:/ },
      { name: 'literal corner radius', pattern: /cornerRadius:\s*\d/ },
    ],
  },
];

/**
 * Where a raw value is the point. A file (relative to the app's folder) may use a check's raw values; with `match`,
 * only on the lines it matches.
 */
const ALLOW = {
  web: [
    { file: 'components/AppearancePanel.tsx', check: 'hex color', reason: 'the accent choices themselves, and the swatch of all of them' },
    { file: 'lib/prefs.ts', check: 'hex color', reason: 'the accent choices, kept as the colors they are' },
    { file: 'player/AudioEngine.tsx', check: 'hex color', reason: 'the accent before a cover gives one (index.css’s --accent)' },
    { file: 'lib/favicon.ts', check: ['hex color', 'color function'], reason: 'the favicon is drawn on a canvas, which takes colors, not classes' },
    { file: 'lib/color.ts', check: 'color function', reason: 'reads the accent out of a cover’s pixels and writes it as a color' },
    { file: 'components/Mixes.tsx', check: 'color function', reason: 'a mix’s cover is drawn in colors made from its own hue' },
    {
      file: 'components/StatsForNerds.tsx',
      check: 'palette color',
      match: /-(?:sky|rose)-300\b/,
      reason: 'the intro and outro marks are data colors of their own, apart from the accent (iOS: cyan and pink)',
    },
    { file: 'components/Nav.tsx', check: 'arbitrary text size', match: /text-\[1\.6rem\]/, reason: 'the wordmark is a logo, set at its own size' },
  ],
  ios: [],
};

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** Whether `line` of `file` may hold the raw values `check` finds. */
function allowed(app, file, check, line) {
  return ALLOW[app].some((a) => a.file === file && [a.check].flat().includes(check) && (!a.match || a.match.test(line)));
}

/** Every raw value in the apps' sources: { app, file, line, check, text }. */
export function findings(root, apps) {
  const found = [];
  for (const rule of RULES.filter((r) => apps.includes(r.app))) {
    const base = join(root, rule.dir);
    if (!existsSync(base)) continue;
    for (const path of walk(base)) {
      const rel = relative(base, path);
      if (!rule.files.test(rel) || rule.skip.test(rel)) continue;
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const check of rule.checks) {
            if (check.pattern.test(line) && !allowed(rule.app, rel, check.name, line)) {
              found.push({ app: rule.app, file: join(rule.dir, rel), line: i + 1, check: check.name, text: line.trim() });
            }
          }
        });
    }
  }
  return found;
}

function main(argv) {
  const report = argv.includes('--report');
  const value = (flag) => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const root = resolve(value('--root') ?? new URL('..', import.meta.url).pathname);
  const app = value('--app');
  const known = RULES.map((r) => r.app);
  if (app !== undefined && !known.includes(app)) {
    console.error(`No app called “${app}”: there are ${known.join(' and ')}.`);
    return 2;
  }
  const apps = app ? [app] : known;
  const all = findings(root, apps);
  const enforced = new Set(RULES.filter((r) => r.enforced).map((r) => r.app));
  const failing = all.filter((f) => enforced.has(f.app));
  const listed = report ? all : failing;

  for (const f of listed) console.log(`${f.file}:${f.line}  ${f.check}  ${f.text.slice(0, 110)}`);
  const counts = Object.groupBy(all, (f) => `${f.app}: ${f.check}`);
  if (listed.length) console.log('');
  for (const [key, list] of Object.entries(counts)) console.log(`${String(list.length).padStart(5)}  ${key}`);
  for (const a of apps.filter((a) => !enforced.has(a) && !report && all.some((f) => f.app === a))) {
    console.log(`${a} is report-only until its sweep: --report --app ${a} lists its findings.`);
  }
  const passing = apps.filter((a) => enforced.has(a));
  if (!failing.length && passing.length) console.log(`Design check (${passing.join(', ')}): no raw colors or sizes where the tokens should be.`);
  else if (failing.length && !report) console.log(`\nUse index.css’s tokens and type-* roles (docs/design.md), or add the file to ALLOW in scripts/check-design.mjs with a reason.`);
  return failing.length && !report ? 1 : 0;
}

if (resolve(process.argv[1] ?? '') === resolve(new URL(import.meta.url).pathname)) process.exitCode = main(process.argv.slice(2));
