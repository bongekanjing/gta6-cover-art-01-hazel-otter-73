// cover.js — the one place a cover is drawn.
//
// renderCover paints a complete poster at any resolution: the live preview, the native-resolution
// export and the ?shot=poster harness all call it with their own canvas, so the PNG the user
// downloads is literally the pixels the preview showed. Panel art is cached by (photo, grade,
// crop, panel size), so dragging a slider re-inks only the panel that changed.

import { GRADES, processPhoto } from './ink.js';
import { LAYOUTS, drawBackdrop, drawPanel, drawScrim, panelsOf, titleRectOf } from './panels.js';
import { drawLockup, drawSeriesStamp } from './letter.js';

const artCache = new Map();
const CACHE_LIMIT = 40;

/**
 * One panel's processed art, from the cache when nothing about it changed.
 * The world (cover size and the panel's origin in it) is part of the key: the same crop at the
 * same size still grades differently when the panel moves, because the sun is a cover-level
 * term.
 */
function artFor(state, crop, rect, coverW, coverH, pass) {
  const photo = state.photos[crop.photo] ?? state.photos[0] ?? null;
  const world = { coverW, coverH, x: rect.x, y: rect.y };
  const key = [
    photo ? photo.id : 'none',
    state.grade,
    crop.zoom.toFixed(3),
    crop.fx.toFixed(3),
    crop.fy.toFixed(3),
    rect.w,
    rect.h,
    coverW,
    coverH,
    rect.x,
    rect.y,
    pass,
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
    world,
  });
  artCache.set(key, art);
  if (artCache.size > CACHE_LIMIT) artCache.delete(artCache.keys().next().value);
  return art;
}

/** Drop every cached panel, e.g. after a photo is added or removed. */
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
    const art = artFor(state, crop, rect, W, H, preview ? 'preview' : 'export');
    drawPanel(ctx, art, rect, W / 1600, i === selected);
  }

  const title = titleRectOf(state.layout, W, H);
  if (layout.over) drawScrim(ctx, title, W, H);

  drawLockup(ctx, title, grade, {
    caption: state.caption,
    strapline: state.strapline,
  });

  // The card's trim: a hairline frame just inside the edge, so it reads as printed matter.
  ctx.strokeStyle = 'rgba(255,232,196,0.20)';
  ctx.lineWidth = Math.max(1, Math.round(W * 0.0016));
  ctx.strokeRect(W * 0.008, H * 0.008, W * 0.984, H * 0.984);

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
