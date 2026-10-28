/**
 * Redraw the favicon (the record from public/icon.svg) with the current accent color.
 * Drawn to a canvas and set as PNG, since Safari ignores SVG favicons.
 */
export function setFaviconAccent(accent: string) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const c = size / 2;

  ctx.fillStyle = '#0f0e0c';
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, 14);
  ctx.fill();

  // Grooves.
  ctx.strokeStyle = 'rgba(236, 230, 220, 0.16)';
  ctx.lineWidth = 1;
  for (const r of [26, 21, 16]) {
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Label in the accent color, with the spindle hole.
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(c, c, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0f0e0c';
  ctx.beginPath();
  ctx.arc(c, c, 2, 0, Math.PI * 2);
  ctx.fill();

  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.append(link);
  }
  link.type = 'image/png';
  link.href = canvas.toDataURL('image/png');
}
