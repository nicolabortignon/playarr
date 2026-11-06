import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** scripts/check-design.mjs, the check the web's typecheck runs (docs/design.md). */
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/check-design.mjs');

/** Runs the check for the web on a scratch tree holding `files` (paths under apps/web/src): its exit code and output. */
function check(files: Record<string, string>, ...args: string[]): { code: number; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'design-check-'));
  try {
    for (const [path, text] of Object.entries(files)) {
      const file = join(root, 'apps/web/src', path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, '--app', 'web', '--root', root, ...args], { encoding: 'utf8' }) };
  } catch (err) {
    const { status, stdout } = err as { status: number; stdout: string };
    return { code: status, out: stdout };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const page = (className: string) => `export const Page = () => <p className="${className}">Teardrop</p>;\n`;

describe('the design check', () => {
  it('fails a page that adds a raw color, naming the file, the line and what it found', () => {
    const { code, out } = check({ 'pages/Late.tsx': page('bg-[#ff0000] text-paper') });
    expect(code).toBe(1);
    expect(out).toContain('apps/web/src/pages/Late.tsx:1  hex color');
  });

  it('fails Tailwind’s own colors, color functions and arbitrary text sizes as well', () => {
    const { code, out } = check({
      'pages/A.tsx': page('text-sky-400'),
      'pages/B.tsx': page('bg-white/10'),
      'pages/C.tsx': page('shadow-[0_0_0_4px_rgb(0_0_0/0.25)]'),
      'pages/D.tsx': page('text-[13px]'),
    });
    expect(code).toBe(1);
    expect(out).toMatch(/A\.tsx:1 {2}palette color/);
    expect(out).toMatch(/B\.tsx:1 {2}palette color/);
    expect(out).toMatch(/C\.tsx:1 {2}color function/);
    expect(out).toMatch(/D\.tsx:1 {2}arbitrary text size/);
  });

  it('passes a page made of the tokens and type roles, and black in a shadow', () => {
    expect(check({ 'pages/Late.tsx': page('bg-ink-850 text-paper-dim type-small shadow-2xl shadow-black/60') }).code).toBe(0);
    expect(check({ 'pages/Late.tsx': page('bg-black/50') }).code).toBe(1);
  });

  it('passes a raw value where it’s the point, and only there', () => {
    expect(check({ 'components/AppearancePanel.tsx': "export const ACCENT = '#ff7a1a';\n" }).code).toBe(0);
    expect(check({ 'components/Other.tsx': "export const ACCENT = '#ff7a1a';\n" }).code).toBe(1);
    // Stats for nerds may mark the intro in its own data color, but not use any other raw one.
    expect(check({ 'components/StatsForNerds.tsx': page('bg-sky-300') }).code).toBe(0);
    expect(check({ 'components/StatsForNerds.tsx': page('bg-red-500') }).code).toBe(1);
  });

  it('lists every finding with --report, without failing', () => {
    const { code, out } = check({ 'pages/Late.tsx': page('text-[11px] text-white') }, '--report');
    expect(code).toBe(0);
    expect(out).toContain('arbitrary text size');
    expect(out).toContain('palette color');
  });
});
