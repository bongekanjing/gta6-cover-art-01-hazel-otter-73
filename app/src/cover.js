// cover.js — the one place a cover is drawn.
//
// renderCover paints a complete poster at any resolution: the live preview, the native-resolution
// export and the ?shot=poster harness all call it with their own canvas, so the PNG a user
// downloads is literally the pixels the preview showed. Panel art is cached by
// (photo, grade, crop, panel size, coverspace), so dragging a slider re-inks only the panel that
// changed.
//
// The cover owns two things the panel pass deliberately does not: the grade, which every panel
// shares, and the sun, which every panel is lit by. That is why the three plates read as one
// poster in one light even when they come from three different photographs.

import { GRADES, processPhoto } from './ink.js';
import { LAYOUTS, drawBackdrop, drawPanel, drawScrim, panelsOf, titleRectOf } from './panels.js';
import { drawLockup, drawSeriesStamp } from './letter.js';

const artCache = new Map();
const CACHE_LIMIT = 48;

/**
 * One panel's painted plate, from the cache when nothing about it changed.
 *
 * The key holds the grade, the crop and the panel's box. It does not hold the panel's position
 * on the cover any more: the cel pass normalises every panel to its own value window and lights
 * it with flat fills, so a plate is identical wherever it is mounted. That is what lets a
 * four-panel layout reuse one plate across two panels instead of re-running the pass.
 */
function artFor(state, crop, rect) {
  const photo = state.photos[crop.photo] ?? state.photos[0] ?? null;
  const key = [
    photo ? photo.id : 'none',
    state.grade,
    crop.zoom.toFixed(3),
    crop.fx.toFixed(3),
    crop.fy.toFixed(3),
    rect.w,
    rect.h,
  ].join('|');
  const hit = artCache.get(key);
  if (hit !== undefined) return hit;
  const art = processPhoto(photo ? photo.source : null, {
    width: rect.w,
    height: rect.h,
    grade: state.grade,
    zoom: crop.zoom,
    fx: crop.fx,
    fy: crop.fy,
  });
  artCache.set(key, art);
  if (artCache.size > CACHE_LIMIT) artCache.delete(artCache.keys().next().value);
  return art;
}

/** Drop every cached plate, e.g. after a photo is added or removed. */
export function invalidateArt() {
  artCache.clear();
}

/**
 * Paint the whole cover into `ctx` at W x H.
 *   options.preview   true for the editor's live view: the selection outline is drawn
 *   options.selected  which panel to outline (preview only)
 * Returns the panel rects in device pixels, for hit testing.
 */
export function renderCover(ctx, W, H, state, options = {}) {
  const layout = LAYOUTS[state.layout] ?? LAYOUTS.classic;
  const grade = GRADES[state.grade] ?? GRADES.dusk;
  const preview = Boolean(options.preview);
  const selected = preview && state.showGuides ? (options.selected ?? state.selected) : -1;
  const panels = panelsOf(state.layout, W, H);

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.textBaseline = 'alphabetic';

  drawBackdrop(ctx, W, H, grade);

  for (let i = 0; i < panels.length; i++) {
    const rect = panels[i];
    const crop = state.crops[i] ?? { photo: 0, zoom: 1, fx: 0.5, fy: 0.5 };
    const art = artFor(state, crop, rect);
    drawPanel(ctx, art, rect, W / 1600, i === selected);
  }

  const title = titleRectOf(state.layout, W, H);
  if (layout.over) drawScrim(ctx, title, W, H);

  drawLockup(ctx, title, grade, {
    caption: state.caption,
    strapline: state.strapline,
  });

  // The card's trim: a hairline frame just inside the edge, so it reads as printed matter, and
  // the series stamp along the foot of the card.
  ctx.strokeStyle = 'rgba(255,232,196,0.20)';
  ctx.lineWidth = Math.max(1, Math.round(W * 0.0016));
  ctx.strokeRect(W * 0.008, H * 0.008, W * 0.984, H * 0.984);
  drawSeriesStamp(ctx, W, H, Math.min(W, H));

  ctx.restore();
  return panels;
}

/** A canvas holding the cover at its native export size. */
export function renderToCanvas(state, W, H) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  renderCover(canvas.getContext('2d'), W, H, state, { preview: false });
  return canvas;
}

/**
 * The `?shot=variants` contact strip: four covers side by side in a 2 x 2 grid.
 *
 * Each cell goes through the same renderCover the Export button calls, at the variant's own
 * aspect and grade, so the strip is the app's own drawing rather than a paste-up of four
 * separate images: nothing is composited afterwards. The cell labels are drawn here, in the
 * app, for the same reason the poster's chrome is — they are part of what the app renders.
 */
export function renderVariantsToCanvas(state, W, H, variants) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0a0611';
  ctx.fillRect(0, 0, W, H);

  const pad = Math.round(Math.min(W, H) * 0.028);
  const gutter = Math.round(Math.min(W, H) * 0.022);
  const labelH = Math.round(Math.min(W, H) * 0.05);
  const cellW = Math.floor((W - pad * 2 - gutter) / 2);
  const cellH = Math.floor((H - pad * 2 - gutter - labelH * 2) / 2);

  variants.forEach((variant, i) => {
    const col = i % 2;
    const row = (i / 2) | 0;
    const cx = pad + col * (cellW + gutter);
    const cy = pad + row * (cellH + labelH + gutter);
    const { w, h } = variant.size;
    const scale = Math.min(cellW / w, cellH / h);
    const dw = Math.round(w * scale);
    const dh = Math.round(h * scale);
    const dx = cx + Math.round((cellW - dw) / 2);
    const dy = cy + Math.round((cellH - dh) / 2);

    // The cell's own copy of the state: the cover changes, the photographs and the words do not.
    const cell = { ...state, layout: variant.layout, grade: variant.grade };
    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();
    ctx.translate(dx, dy);
    ctx.scale(dw / w, dh / h);
    renderCover(ctx, w, h, cell, { preview: false });
    ctx.restore();

    // A keyline round the cell and its name beneath it, in the strip's own small type.
    ctx.strokeStyle = 'rgba(255,232,196,0.26)';
    ctx.lineWidth = Math.max(1, Math.round(W * 0.0012));
    ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);
    ctx.fillStyle = 'rgba(255,238,212,0.68)';
    ctx.font = `600 ${Math.round(labelH * 0.62)}px 'DejaVu Sans Mono', 'Liberation Mono', monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(variant.label, dx + 2, dy + dh + labelH * 0.58);
  });

  return canvas;
}

/**
 * The `?shot=detail` close-up: one window of the cover, magnified `zoom` times, at the cover's
 * own pixel size.
 *
 * The cover is painted at `zoom` times its export resolution and the window's pixels are copied
 * out of that one for one, so nothing is interpolated: the magnified ink line, hard terminator
 * and lettering edges in the result are the render's own pixels. Painting at export size and
 * scaling up instead would blur exactly the edge weights a detail shot exists to show.
 */
export function renderDetailToCanvas(state, W, H, zoom, cx, cy) {
  const z = Math.max(1, Math.min(4, Math.round(zoom) || 1));
  const big = renderToCanvas(state, W * z, H * z);
  const cw = Math.round(W / z);
  const ch = Math.round(H / z);
  const sx = Math.round(Math.min(W - cw, Math.max(0, (cx ?? 0.5) * W - cw / 2)));
  const sy = Math.round(Math.min(H - ch, Math.max(0, (cy ?? 0.5) * H - ch / 2)));

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(big, sx * z, sy * z, cw * z, ch * z, 0, 0, W, H);
  return canvas;
}
