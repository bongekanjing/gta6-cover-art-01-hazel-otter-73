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

/** The sample photos shipped under app/samples/. */
export const SAMPLES = {
  pier: { file: 'samples/pier.jpg' },
  boulevard: { file: 'samples/boulevard.jpg' },
};

/**
 * A focal point per (photo, slot), so a poster made from two photos reads as a montage of
 * different moments rather than the same frame twice: the hero holds the whole subject, the
 * smaller panels push in on a face or a detail.
 */
const FOCUS = {
  pier: [
    { fx: 0.47, fy: 0.32, zoom: 1.0 },
    { fx: 0.47, fy: 0.24, zoom: 1.72 },
    { fx: 0.76, fy: 0.7, zoom: 1.95 },
    { fx: 0.26, fy: 0.5, zoom: 1.55 },
    { fx: 0.47, fy: 0.2, zoom: 1.35 },
  ],
  boulevard: [
    { fx: 0.54, fy: 0.34, zoom: 1.06 },
    { fx: 0.58, fy: 0.3, zoom: 1.6 },
    { fx: 0.34, fy: 0.72, zoom: 1.9 },
    { fx: 0.55, fy: 0.46, zoom: 1.45 },
    { fx: 0.6, fy: 0.26, zoom: 1.3 },
  ],
};

/** The crop a photo wants in the n-th panel it lands in: a focal point and a zoom. */
export function cropFor(sample, slot) {
  const list = FOCUS[sample];
  if (!list) return { zoom: 1, fx: 0.5, fy: 0.5 };
  const point = list[slot % list.length];
  return { zoom: point.zoom ?? 1, fx: point.fx, fy: point.fy };
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
 * Fill the state with the decoded photos: one photo per panel, cycling through them, each at
 * the focal point that photo wants in that slot.
 */
export function seedPanels(state, photos) {
  if (photos.length === 0) return;
  const data = state.get();
  data.photos.length = 0;
  for (const photo of photos) data.photos.push(photo);
  for (let i = 0; i < data.crops.length; i++) {
    const at = i % photos.length;
    data.crops[i] = { photo: at, ...cropFor(photos[at].sample, i) };
  }
}

/**
 * Drive the page from the query string. Returns the cover size the shot asks for, or null.
 */
export async function runShot(state, params) {
  const named = (params.get('photo') ?? 'pier,boulevard').split(',').filter(Boolean);
  const photos = await loadSamples(named.length ? named : ['pier', 'boulevard']);
  if (photos.length > 0) seedPanels(state, photos);

  const layout = params.get('layout');
  if (layout) state.setLayout(layout);
  const grade = params.get('grade');
  if (grade) state.setGrade(grade);
  const caption = params.get('caption');
  if (caption !== null) state.setCaption(caption);
  const strapline = params.get('strapline');
  if (strapline !== null) state.setStrapline(strapline);

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
