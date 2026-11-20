// shots.js — the ?shot= screenshot harness, and the sample-photo loader it shares with the app.
//
// The kit's convention, extended: a URL drives the app into a known state so headless Chrome can
// photograph it, and the same render function the Export button calls paints the pixels.
//
//   ?shot=editor&photo=pier,boulevard&caption=Pier%20Pressure&layout=classic&grade=dusk&size=1920x1080
//   ?shot=poster&size=1920x1080&layout=classic&grade=dusk&photo=pier,boulevard&caption=Pier%20Pressure
//
// `shot=poster` draws the cover full-viewport at its exact export size, so a Chrome --window-size
// equal to that size is a screenshot of the exported PNG. window.__shotReady flips true after two
// animation frames, once the fonts are in and the ink pass has run.
//
// The framing table below is the answer to "three panels that look like one photo cropped three
// ways". Each sample photo carries a shot list: a wide establishing view, a medium figure, a
// tight face and a detail. A layout asks for those shots by scale, so the poster shows a wide
// view, a face and a close-up rather than three crops of the same frame at the same scale.

import { LAYOUTS } from './panels.js';

/** The sample photos shipped under app/samples/. */
export const SAMPLES = {
  pier: { file: 'samples/pier.jpg' },
  boulevard: { file: 'samples/boulevard.jpg' },
};

/**
 * Per photo, the three framings as a focal point plus a small zoom bias.
 *
 * The bias numbers are small on purpose, and that is the correction that matters. The slots are
 * not all the same shape: the hero is 1.87:1 and the strips are 2.55:1, so a strip is already
 * showing only 30% of the frame's height once cover-fit has been applied. Asking a strip for a
 * zoom of 2 on top of that crops into a horizontal band across the sunglasses and nothing else —
 * which is what made the right-hand panels unreadable. Cover-fit has done most of the work
 * already, so the bias only nudges it: a wide view stays wide, the face is a touch tighter, a
 * detail a touch tighter again.
 *
 *   wide  -- the whole place: sky, water, the figure small in the frame.
 *   face  -- head and shoulders, the eyes on the upper third.
 *   part  -- a detail: hands, reel, chrome, cloth. No face at all.
 */
const SHOTS = {
  pier: [
    { fx: 0.50, fy: 0.46, bias: 1.00 },
    { fx: 0.34, fy: 0.27, bias: 1.06 },
    { fx: 0.74, fy: 0.60, bias: 1.10 },
  ],
  boulevard: [
    { fx: 0.50, fy: 0.46, bias: 1.00 },
    { fx: 0.52, fy: 0.20, bias: 1.04 },
    { fx: 0.24, fy: 0.70, bias: 1.08 },
  ],
};

/** Which of a photo's three shots a panel of the given rank should take. */
const RANK_SHOT = [0, 1, 2];

/**
 * The crop a photo wants in the n-th panel it lands in.
 * `framing` is the layout's per-slot scale list; it is what makes the three panels different
 * views, and the shot list above is what makes them different subjects within one photograph.
 */
export function cropFor(sample, slot, framing) {
  const shots = SHOTS[sample];
  const width = framing && framing[slot] ? framing[slot] : 1;
  if (!shots) return { zoom: width, fx: 0.5, fy: 0.5 };
  const shot = shots[RANK_SHOT[slot % RANK_SHOT.length]];
  return { zoom: width * shot.bias, fx: shot.fx, fy: shot.fy };
}

/** Decode one image URL into a canvas the ink pass can draw from. */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      resolve(canvas);
    };
    img.onerror = () => reject(new Error(`cannot load ${src}`));
    img.src = src;
  });
}

/** Decode the named samples, in order, as state photos. Unknown names are skipped. */
export async function loadSamples(names) {
  const out = [];
  for (const name of names) {
    const sample = SAMPLES[name];
    if (!sample) continue;
    try {
      const canvas = await loadImage(sample.file);
      out.push({ id: name, name: `${name}.jpg`, source: canvas, sample: name });
    } catch {
      /* a missing sample leaves a placeholder panel, which is still a composed poster */
    }
  }
  return out;
}

/**
 * Fill the state with the decoded photos: one photo per panel, cycling through them, each at the
 * framing the current layout asks of that slot.
 */
export function seedPanels(state, photos) {
  if (photos.length === 0) return;
  const data = state.get();
  const framing = (LAYOUTS[data.layout] ?? LAYOUTS.classic).framing;
  data.photos.length = 0;
  for (const photo of photos) data.photos.push(photo);
  for (let i = 0; i < data.crops.length; i++) {
    const at = i % photos.length;
    data.crops[i] = { photo: at, ...cropFor(photos[at].sample, i, framing) };
  }
}

/**
 * Drive the page from the query string. Returns the cover size the shot asks for, or null.
 * The order matters: the layout is set before the panels are seeded, because the layout is what
 * decides which shot each slot takes.
 */
export async function runShot(state, params) {
  const named = (params.get('photo') ?? 'pier,boulevard').split(',').filter(Boolean);
  const photos = await loadSamples(named.length ? named : ['pier', 'boulevard']);

  const layout = params.get('layout');
  if (layout && LAYOUTS[layout]) state.setLayout(layout);
  const grade = params.get('grade');
  if (grade) state.setGrade(grade);
  const caption = params.get('caption');
  if (caption !== null) state.setCaption(caption);
  const strapline = params.get('strapline');
  if (strapline !== null) state.setStrapline(strapline);

  if (photos.length > 0) seedPanels(state, photos);

  let size = null;
  const raw = params.get('size');
  if (raw) {
    const [w, h] = raw.split('x').map(Number);
    if (w > 0 && h > 0) size = { w, h };
  }
  const panel = params.get('panel');
  if (panel !== null) state.select(Math.max(0, Number(panel) || 0));

  return size;
}
