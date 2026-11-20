// panels.js — the layout templates, the poster card, and the drawing of one panel.
//
// A layout is a list of panels in normalised cover coordinates plus the rect the title lockup
// owns. Layouts also carry a `framing` list: the crop scale each slot is meant to be shot at,
// so one photograph spreads across a poster as a tight face, a medium figure and a wide
// environment rather than as the same frame cropped three ways. The editor overrides these the
// moment the user drags or zooms, but they are the framing the poster opens on.
//
// Nothing in this file adds texture to the artwork. The card is flat colour with flat shapes on
// it; every grain, stipple and halftone screen the earlier version had is gone, because a
// screened photograph is the one thing that makes painted art read as a filtered photo.

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
    // Three scales, not three crops. Kept near 1 because cover-fit already frames a 2.55:1 strip
    // hard; see the note in shots.js.
    framing: [1.0, 1.02, 1.06],
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
    // Left column wide, centre the face, right column a low detail.
    framing: [1.0, 1.9, 2.2],
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
    // The hero is the wide view; the four cards climb in scale toward a face and a detail.
    framing: [1.0, 1.7, 2.15, 1.95, 2.35],
  },
  single: {
    label: 'Single',
    note: 'one full bleed',
    panels: [{ x: 0, y: 0, w: 1, h: 1 }],
    hero: 0,
    title: { x: 0.058, y: 0.66, w: 0.884, h: 0.29 },
    over: true,
    framing: [1.12],
  },
};

export const LAYOUT_ORDER = ['classic', 'triptych', 'grid5', 'single'];

/** A layout's panels in device pixels for a W x H cover. */
export function panelsOf(layout, W, H) {
  return (LAYOUTS[layout] ?? LAYOUTS.classic).panels.map((p) => ({
    x: Math.round(p.x * W),
    y: Math.round(p.y * H),
    w: Math.round(p.w * W),
    h: Math.round(p.h * H),
  }));
}

/** The title lockup's rect in device pixels. */
export function titleRectOf(layout, W, H) {
  const t = (LAYOUTS[layout] ?? LAYOUTS.classic).title;
  return { x: Math.round(t.x * W), y: Math.round(t.y * H), w: Math.round(t.w * W), h: Math.round(t.h * H) };
}

/**
 * The poster card the panels are mounted on: flat colour, one sunset wash rising from the
 * bottom, one soft glow where the poster's sun sits, and a drawn border. No hatch, no grain.
 *
 * The wash and the glow come from the grade, so all three panels and the card behind them are
 * lit by the same source — the sun low and behind the characters, which is what makes the
 * collage read as one photograph of one place at one hour.
 */
export function drawBackdrop(ctx, W, H, grade) {
  const long = Math.max(W, H);

  ctx.fillStyle = grade.paper;
  ctx.fillRect(0, 0, W, H);

  // The sky the panels are cut into: a wash from the sun's side, ending in flat card.
  const wash = ctx.createLinearGradient(0, H * 1.05, W * 0.9, 0);
  wash.addColorStop(0, grade.wash);
  wash.addColorStop(0.42, grade.paper);
  wash.addColorStop(1, grade.paper);
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);

  // The sun: a glowing disc low in the middle of the cover, behind the panel block.
  const sunX = grade.sun.x * W;
  const sunY = grade.sun.y * H;
  const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, long * grade.sun.r);
  glow.addColorStop(0, grade.glow);
  glow.addColorStop(0.22, grade.glow);
  glow.addColorStop(0.55, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // The horizon: one drawn line under the sun, so the card is a scene and not a field.
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = grade.ink;
  ctx.lineWidth = Math.max(1, W * 0.0015);
  ctx.beginPath();
  ctx.moveTo(0, H * 0.965);
  ctx.lineTo(W, H * 0.965);
  ctx.stroke();
  ctx.restore();

  // Corner burn, so the lettering at the foot of the card has a ground to sit on.
  const burn = ctx.createRadialGradient(W * 0.5, H * 0.44, Math.min(W, H) * 0.18, W * 0.5, H * 0.52, long * 0.8);
  burn.addColorStop(0, 'rgba(0,0,0,0)');
  burn.addColorStop(1, 'rgba(0,0,0,0.62)');
  ctx.fillStyle = burn;
  ctx.fillRect(0, 0, W, H);
}

/**
 * One panel: the painted plate, a black keyline inset from the edge, a light hairline just
 * outside it, and a short inner shadow along the top and the left — the side away from the sun.
 * The shadow keeps one direction across every panel, which is the other half of reading as one
 * light rather than three pictures.
 */
export function drawPanel(ctx, art, rect, scale, selected) {
  const { x, y, w, h } = rect;
  const short = Math.min(w, h);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(art, 0, 0, art.width, art.height, x, y, w, h);

  const inset = Math.max(2, Math.round(short * 0.012));
  const keyW = Math.max(1.8, short * 0.0068);
  const kx = x + inset;
  const ky = y + inset;
  const kw = w - inset * 2;
  const kh = h - inset * 2;

  // Inner shadow from the top-left only: the sun is low behind the subjects, so the shade
  // inside a frame gathers away from it.
  const fall = Math.max(4, Math.round(short * 0.075));
  let grad = ctx.createLinearGradient(0, ky, 0, ky + fall);
  grad.addColorStop(0, 'rgba(0,0,0,0.46)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(kx, ky, kw, fall);
  grad = ctx.createLinearGradient(kx, 0, kx + fall, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0.34)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(kx, ky, fall, kh);

  // The keyline, and the light hairline on its outside.
  ctx.lineJoin = 'miter';
  ctx.strokeStyle = '#07030d';
  ctx.lineWidth = keyW;
  ctx.strokeRect(kx, ky, kw, kh);
  ctx.strokeStyle = 'rgba(255,226,178,0.34)';
  ctx.lineWidth = Math.max(1, keyW * 0.34);
  ctx.strokeRect(kx - keyW * 0.8, ky - keyW * 0.8, kw + keyW * 1.6, kh + keyW * 1.6);

  if (selected) {
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = Math.max(2, 3 * scale);
    ctx.setLineDash([Math.max(6, 10 * scale), Math.max(4, 7 * scale)]);
    ctx.strokeRect(x + keyW, y + keyW, w - keyW * 2, h - keyW * 2);
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/**
 * A scrim behind a lockup that sits over a panel. It is a flat-ish gradient of the card colour
 * rather than a blur, so the lettering keeps its hard cel edge.
 */
export function drawScrim(ctx, rect, W, H) {
  const g = ctx.createLinearGradient(0, rect.y - rect.h * 0.6, 0, rect.y + rect.h * 1.1);
  g.addColorStop(0, 'rgba(10,4,18,0)');
  g.addColorStop(0.34, 'rgba(9,3,16,0.68)');
  g.addColorStop(0.7, 'rgba(7,2,13,0.9)');
  g.addColorStop(1, 'rgba(6,2,11,0.97)');
  ctx.fillStyle = g;
  ctx.fillRect(0, Math.max(0, rect.y - rect.h * 0.6), W, Math.min(H, rect.h * 1.7));
}
