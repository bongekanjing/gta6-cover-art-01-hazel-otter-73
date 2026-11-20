// panels.js — the four layout templates and the drawing of a single panel.
//
// A layout is a list of panels in normalised coordinates (0..1 of the cover), the index of the
// hero panel, the rect the title lockup occupies, and whether the lockup is drawn over a panel
// (grid5 and single) rather than beside it (classic and triptych).

export const LAYOUTS = {
  classic: {
    label: 'Classic',
    note: 'hero left, two strips right',
    panels: [
      { x: 0.024, y: 0.042, w: 0.564, h: 0.536 },
      { x: 0.604, y: 0.042, w: 0.372, h: 0.259 },
      { x: 0.604, y: 0.319, w: 0.372, h: 0.259 },
    ],
    hero: 0,
    title: { x: 0.03, y: 0.595, w: 0.94, h: 0.362 },
    over: false,
  },
  triptych: {
    label: 'Triptych',
    note: 'three columns, title below',
    panels: [
      { x: 0.024, y: 0.042, w: 0.302, h: 0.606 },
      { x: 0.349, y: 0.042, w: 0.302, h: 0.606 },
      { x: 0.674, y: 0.042, w: 0.302, h: 0.606 },
    ],
    hero: 1,
    title: { x: 0.03, y: 0.666, w: 0.94, h: 0.3 },
    over: false,
  },
  grid5: {
    label: 'Grid 5',
    note: 'hero plus four',
    panels: [
      { x: 0.024, y: 0.042, w: 0.592, h: 0.878 },
      { x: 0.638, y: 0.042, w: 0.162, h: 0.249 },
      { x: 0.814, y: 0.042, w: 0.162, h: 0.249 },
      { x: 0.638, y: 0.311, w: 0.162, h: 0.249 },
      { x: 0.814, y: 0.311, w: 0.162, h: 0.249 },
    ],
    hero: 0,
    title: { x: 0.055, y: 0.618, w: 0.53, h: 0.3 },
    over: true,
  },
  single: {
    label: 'Single',
    note: 'one full bleed',
    panels: [{ x: 0, y: 0, w: 1, h: 1 }],
    hero: 0,
    title: { x: 0.058, y: 0.66, w: 0.884, h: 0.29 },
    over: true,
  },
};

export const LAYOUT_ORDER = ['classic', 'triptych', 'grid5', 'single'];

/** A layout's panels in device pixels for a W x H cover. */
export function panelsOf(layout, W, H) {
  return LAYOUTS[layout].panels.map((p) => ({
    x: Math.round(p.x * W),
    y: Math.round(p.y * H),
    w: Math.round(p.w * W),
    h: Math.round(p.h * H),
  }));
}

/** The title lockup's rect in device pixels. */
export function titleRectOf(layout, W, H) {
  const t = LAYOUTS[layout].title;
  return { x: Math.round(t.x * W), y: Math.round(t.y * H), w: Math.round(t.w * W), h: Math.round(t.h * H) };
}

/** Deterministic grain tile: a small canvas of soft noise, made once and tiled. */
const grainTiles = new Map();
export function grainTile(strength = 1) {
  const key = String(strength);
  const hit = grainTiles.get(key);
  if (hit) return hit;
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (rnd() - 0.5) * 190 * strength;
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 26;
  }
  ctx.putImageData(img, 0, 0);
  grainTiles.set(key, canvas);
  return canvas;
}

/**
 * The poster's own ground: a deep plum card, a sunset wash rising from the lower left, a
 * diagonal hatch, and grain. This is what the panels sit on, and it carries the grade.
 */
export function drawBackdrop(ctx, W, H, grade) {
  ctx.fillStyle = '#0d0716';
  ctx.fillRect(0, 0, W, H);

  const wash = ctx.createLinearGradient(0, H, W * 0.85, 0);
  wash.addColorStop(0, grade.bandTint[2]);
  wash.addColorStop(0.38, grade.bandTint[1]);
  wash.addColorStop(0.72, '#170b26');
  wash.addColorStop(1, '#0a0613');
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1;

  // A low sun behind the panel block, so the poster glows from one corner.
  const sun = ctx.createRadialGradient(W * 0.16, H * 0.94, 0, W * 0.16, H * 0.94, Math.max(W, H) * 0.7);
  sun.addColorStop(0, grade.skyGlow);
  sun.addColorStop(0.25, 'rgba(255,120,60,0.30)');
  sun.addColorStop(0.6, 'rgba(90,20,70,0.16)');
  sun.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';

  // Diagonal hatch, hairline, very low contrast: printed card, not flat colour.
  ctx.save();
  ctx.globalAlpha = 0.13;
  ctx.strokeStyle = grade.bandTint[4];
  ctx.lineWidth = Math.max(1, W * 0.0011);
  const step = Math.max(10, Math.round(W * 0.022));
  ctx.beginPath();
  for (let x = -H; x < W + H; x += step) {
    ctx.moveTo(x, H);
    ctx.lineTo(x + H, 0);
  }
  ctx.stroke();
  ctx.restore();

  // Grain.
  const tile = grainTile(1);
  const pattern = ctx.createPattern(tile, 'repeat');
  if (pattern) {
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // Corner burn, so the type reads against the edges.
  const burn = ctx.createRadialGradient(W * 0.5, H * 0.48, Math.min(W, H) * 0.2, W * 0.5, H * 0.5, Math.max(W, H) * 0.78);
  burn.addColorStop(0, 'rgba(0,0,0,0)');
  burn.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = burn;
  ctx.fillRect(0, 0, W, H);
}

/**
 * One panel: the illustrated art, a black keyline inset from the edge, a light hairline just
 * outside it, and an inner shadow against the keyline.
 */
export function drawPanel(ctx, art, rect, scale, selected) {
  const { x, y, w, h } = rect;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(art, 0, 0, art.width, art.height, x, y, w, h);

  const inset = Math.max(2, Math.round(Math.min(w, h) * 0.011));
  const keyW = Math.max(1.6, Math.min(w, h) * 0.0062);
  const kx = x + inset;
  const ky = y + inset;
  const kw = w - inset * 2;
  const kh = h - inset * 2;

  // Inner shadow: a soft dark fall-off from just inside the keyline.
  const shade = Math.round(Math.min(w, h) * 0.05);
  let grad = ctx.createLinearGradient(0, ky, 0, ky + shade);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(kx, ky, kw, shade);
  grad = ctx.createLinearGradient(0, ky + kh, 0, ky + kh - shade);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(kx, ky + kh - shade, kw, shade);
  grad = ctx.createLinearGradient(kx, 0, kx + shade, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0.5)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(kx, ky, shade, kh);
  grad = ctx.createLinearGradient(kx + kw, 0, kx + kw - shade, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0.5)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(kx + kw - shade, ky, shade, kh);

  // The keyline, and the light hairline on its outside.
  ctx.lineJoin = 'miter';
  ctx.strokeStyle = '#080410';
  ctx.lineWidth = keyW;
  ctx.strokeRect(kx, ky, kw, kh);
  ctx.strokeStyle = 'rgba(255,226,178,0.30)';
  ctx.lineWidth = Math.max(1, keyW * 0.32);
  ctx.strokeRect(kx - keyW * 0.75, ky - keyW * 0.75, kw + keyW * 1.5, kh + keyW * 1.5);

  if (selected) {
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = Math.max(2, 3 * scale);
    ctx.setLineDash([Math.max(6, 10 * scale), Math.max(4, 7 * scale)]);
    ctx.strokeRect(x + keyW, y + keyW, w - keyW * 2, h - keyW * 2);
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/** A scrim behind a lockup that sits over a panel, so the type never fights the photo. */
export function drawScrim(ctx, rect, W, H) {
  const g = ctx.createLinearGradient(0, rect.y - rect.h * 0.55, 0, rect.y + rect.h * 1.15);
  g.addColorStop(0, 'rgba(8,3,16,0)');
  g.addColorStop(0.4, 'rgba(8,3,16,0.62)');
  g.addColorStop(0.75, 'rgba(6,2,12,0.86)');
  g.addColorStop(1, 'rgba(6,2,12,0.95)');
  ctx.fillStyle = g;
  ctx.fillRect(0, Math.max(0, rect.y - rect.h * 0.55), W, Math.min(H, rect.h * 1.7));
}
