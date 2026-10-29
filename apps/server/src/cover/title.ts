/**
 * The playlist title, set top-left like a printed sleeve (and like Apple Music's presets), as
 * vector outlines in the app's own faces: Gloock for the title, DM Mono for the small label.
 * Outlines rather than <text> so the server renders it identically everywhere, whatever fonts
 * the machine has. Characters the faces lack (emoji, CJK) fall back to plain SVG text.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import opentype, { type Font, type Path } from 'opentype.js';
import { hex, mix } from './color.ts';
import type { Layout } from './layouts.ts';
import type { Palette } from './palette.ts';

const S = 1000;
const MARGIN = 64;
const MAX_SIZE = 128;
const MIN_SIZE = 52;
const KICKER_SIZE = 25;

let faces: { title: Font[]; label: Font } | undefined;
function loadFaces() {
  if (!faces) {
    const require = createRequire(import.meta.url);
    const load = (file: string) => {
      const buf = readFileSync(require.resolve(file));
      return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    };
    faces = {
      title: [load('@fontsource/gloock/files/gloock-latin-400-normal.woff'), load('@fontsource/gloock/files/gloock-latin-ext-400-normal.woff')],
      label: load('@fontsource/dm-mono/files/dm-mono-latin-500-normal.woff'),
    };
  }
  return faces;
}

/** A title block: label and title on a panel of the background color (none over a horizon's sky). */
export function titleLayer(name: string, pal: Palette, layout: Layout): string {
  const title = name.trim().replace(/\s+/g, ' ');
  if (!title) return '';
  const { title: titleFaces, label } = loadFaces();
  const faceFor = (ch: string) => titleFaces.find((f) => f.charToGlyph(ch).index !== 0);
  const ink = hex(pal.fg);

  const width = (text: string, size: number) =>
    [...text].reduce((w, ch) => w + (faceFor(ch) ?? titleFaces[0]!).getAdvanceWidth(ch, size), 0);
  const { size, lines } = fit(title, width);
  const ascent = size * 0.74; // Gloock cap height, roughly: what the eye reads as the top of the line
  const lineHeight = size * 1.02;

  const kickerY = MARGIN + KICKER_SIZE * 0.75;
  const firstBaseline = kickerY + 26 + ascent;
  const supported = [...title].every((ch) => ch === ' ' || faceFor(ch));
  let body: string;
  let textWidth = Math.max(...lines.map((l) => width(l, size)));
  if (supported) {
    body = lines
      .map((line, i) => {
        let x = MARGIN;
        const y = firstBaseline + i * lineHeight;
        const parts: string[] = [];
        for (const ch of line) {
          const face = faceFor(ch) ?? titleFaces[0]!;
          parts.push(pathData(face.getPath(ch, x, y, size)));
          x += face.getAdvanceWidth(ch, size);
        }
        return parts.join('');
      })
      .join('');
    body = `<path d="${body}" fill="${ink}"/>`;
  } else {
    textWidth = Math.min(S - 2 * MARGIN, textWidth);
    body = lines
      .map(
        (line, i) =>
          `<text x="${MARGIN}" y="${round(firstBaseline + i * lineHeight)}" font-family="Gloock, Georgia, serif" font-size="${size}" fill="${ink}">${escapeXml(line)}</text>`,
      )
      .join('');
  }

  // Label: "PLAYLIST", tracked out, like the app's section kickers.
  let kx = MARGIN;
  const kicker: string[] = [];
  for (const ch of 'PLAYLIST') {
    kicker.push(pathData(label.getPath(ch, kx, kickerY, KICKER_SIZE)));
    kx += label.getAdvanceWidth(ch, KICKER_SIZE) + KICKER_SIZE * 0.22;
  }
  const kickerPath = `<path d="${kicker.join('')}" fill="${hex(mix(pal.fg, pal.bg, 0.35))}"/>`;

  const panelW = Math.min(S, MARGIN * 2 + Math.max(textWidth, kx - MARGIN));
  const panelH = firstBaseline + (lines.length - 1) * lineHeight + size * 0.26 + MARGIN * 0.75;
  const panel = layout === 'horizon' ? '' : `<rect width="${round(panelW)}" height="${round(panelH)}" fill="${hex(pal.bg)}"/>`;
  return `<g>${panel}${kickerPath}${body}</g>`;
}

/** Largest size at which the title wraps into at most two lines (three for long titles). */
function fit(title: string, width: (text: string, size: number) => number): { size: number; lines: string[] } {
  const room = S - 2 * MARGIN;
  for (const maxLines of [2, 3]) {
    for (let size = MAX_SIZE; size >= MIN_SIZE; size -= 4) {
      const lines = wrap(title, size, room, width);
      if (lines.length <= maxLines) return { size, lines };
    }
  }
  return { size: MIN_SIZE, lines: wrap(title, MIN_SIZE, room, width).slice(0, 3) };
}

function wrap(title: string, size: number, room: number, width: (text: string, size: number) => number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of title.split(' ')) {
    const candidate = current ? `${current} ${word}` : word;
    if (width(candidate, size) <= room) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    // A single word wider than the room: break it.
    let rest = word;
    while (width(rest, size) > room && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && width(`${rest.slice(0, cut)}-`, size) > room) cut--;
      lines.push(`${rest.slice(0, cut)}-`);
      rest = rest.slice(cut);
    }
    current = rest;
  }
  if (current) lines.push(current);
  return lines;
}

/** Outline commands → SVG path data (opentype.js's own toPathData can emit NaN when rounding). */
function pathData(path: Path): string {
  return path.commands
    .map((c) => {
      switch (c.type) {
        case 'M':
        case 'L':
          return `${c.type}${round(c.x)} ${round(c.y)}`;
        case 'Q':
          return `Q${round(c.x1)} ${round(c.y1)} ${round(c.x)} ${round(c.y)}`;
        case 'C':
          return `C${round(c.x1)} ${round(c.y1)} ${round(c.x2)} ${round(c.y2)} ${round(c.x)} ${round(c.y)}`;
        default:
          return 'Z';
      }
    })
    .join('');
}

function escapeXml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const round = (n: number) => Math.round(n * 10) / 10;
