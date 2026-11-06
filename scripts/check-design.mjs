// Keeps both apps on the design language (docs/design.md): pages take colors, type sizes and radii from the tokens,
// never raw values. Web: no hex or rgb() colors, no Tailwind palette reds and greens, no arbitrary text sizes outside
// index.css. iOS: no Color(red:), .system(size:) or literal corner radii outside Theme/.
// Usage: node scripts/check-design.mjs [--report]   (--report lists every finding and exits 0)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const report = process.argv.includes('--report');

const RULES = [
  {
    app: 'web',
    dir: 'apps/web/src',
    files: /\.tsx?$/,
    skip: /\.test\.tsx?$|^index\.css$/,
    checks: [
      { name: 'hex color', pattern: /['"`(\s]#[0-9a-fA-F]{3,8}\b/ },
      { name: 'rgb() color', pattern: /\brgba?\(/ },
      { name: 'palette red or green', pattern: /\b(?:text|bg|border|ring|fill|stroke|from|via|to)-(?:red|emerald|green|rose|amber|yellow)-\d/ },
      { name: 'arbitrary text size', pattern: /\btext-\[\d+(?:\.\d+)?(?:px|rem)\]/ },
    ],
    // Where a raw value is the point: the accent choices themselves, the favicon drawn on a canvas, data colors in a
    // chart, and art composed from cover colors.
    allow: {
      'components/AppearancePanel.tsx': ['hex color'],
      'lib/prefs.ts': ['hex color'],
      'lib/favicon.ts': ['hex color', 'rgb() color'],
      'player/AudioEngine.tsx': ['hex color'],
    },
  },
  {
    app: 'ios',
    dir: 'apps/ios/Packages/PlayarrUI/Sources/PlayarrUI',
    files: /\.swift$/,
    skip: /^Theme\//,
    checks: [
      { name: 'Color(red:)', pattern: /Color\(red:/ },
      { name: '.system(size:)', pattern: /\.system\(size:/ },
      { name: 'literal corner radius', pattern: /cornerRadius:\s*\d/ },
    ],
    allow: {},
  },
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const findings = [];
for (const rule of RULES) {
  const base = join(ROOT, rule.dir);
  for (const path of walk(base)) {
    const rel = relative(base, path);
    if (!rule.files.test(rel) || rule.skip.test(rel)) continue;
    const allowed = new Set(rule.allow[rel] ?? []);
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const check of rule.checks) {
          if (!allowed.has(check.name) && check.pattern.test(line)) findings.push({ app: rule.app, file: join(rule.dir, rel), line: i + 1, check: check.name, text: line.trim() });
        }
      });
  }
}

const counts = Object.groupBy(findings, (f) => `${f.app}: ${f.check}`);
if (report || findings.length) {
  for (const f of report ? findings : findings.slice(0, 40)) console.log(`${f.file}:${f.line}  ${f.check}  ${f.text.slice(0, 110)}`);
  if (!report && findings.length > 40) console.log(`… and ${findings.length - 40} more`);
  console.log('');
  for (const [key, list] of Object.entries(counts)) console.log(`${String(list.length).padStart(5)}  ${key}`);
}
if (!findings.length) console.log('Design check: no raw colors, sizes or radii outside the tokens.');
process.exit(findings.length && !report ? 1 : 0);
