// Raise the patch version in the root package.json, in the commit being made and in the working tree.
// Run by .githooks/pre-commit. Only the "version" line changes, so other staged or unstaged edits to
// package.json are left exactly as they are.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const git = (args, input) => execFileSync('git', args, { encoding: 'utf8', input }).trim();
const VERSION = /("version":\s*")(\d+)\.(\d+)\.(\d+)(")/;

const bump = (text) => {
  const m = text.match(VERSION);
  if (!m) throw new Error('package.json has no "version": "x.y.z"');
  const next = `${m[2]}.${m[3]}.${Number(m[4]) + 1}`;
  return { next, text: text.replace(VERSION, `$1${next}$5`) };
};

const root = git(['rev-parse', '--show-toplevel']);
// The commit: bump the staged copy (or the committed one, if package.json isn't staged).
const staged = git(['show', ':package.json']);
const { next, text } = bump(staged);
const blob = git(['hash-object', '-w', '--stdin'], text + (staged.endsWith('\n') ? '' : '\n'));
const mode = git(['ls-files', '-s', 'package.json']).split(' ')[0] || '100644';
git(['update-index', '--cacheinfo', `${mode},${blob},package.json`]);
// The working tree: the same version, keeping any unstaged edits.
const file = `${root}/package.json`;
const current = readFileSync(file, 'utf8');
writeFileSync(file, current.replace(VERSION, `$1${next}$5`));
console.log(`version ${next}`);
