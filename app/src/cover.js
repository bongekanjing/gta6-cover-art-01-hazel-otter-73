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
