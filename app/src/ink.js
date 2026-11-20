// ink.js — the illustration pass: a photograph becomes a painted cel plate.
//
// The look this file is after is key art that was painted, not a photograph with a filter on
// it, so the pipeline is deliberately destructive. It keeps three things and throws the rest
// away: the big shapes, the value breaks between them, and a coarse idea of hue.
//
//   photo -> heavy blur -> per-panel value normalise -> crush -> four flat tones
//         -> mode filter (kills confetti) -> flat palette (tone x hue sector)
//         -> ink contours stamped where tones meet, heavier where the tonal jump is bigger
//
// There is no grain, no stipple, no halftone screen and no per-pixel tinting anywhere in this
// file. Every colour inside a panel is one of twelve flat values taken from the grade's
// four-tone ramp, and every boundary between two of them is a drawn line. That is the whole
// trick: flat fills the eye can name, and contours the eye can follow.
//
// One light, one grade. Each panel's value range is normalised to the same percentile window
// and then cut into the same four steps, so a dim shot and a bright one land on the same four
// tones; the ramp itself carries the sunset (plum in the shade, amber in the light). Three
// panels cut from three photographs therefore read as three views of one place at one hour.

/**
 * The three grades the editor offers.
 *
 *   cel    the four flat fills, shade to light. Every panel is painted only from these.
 *   ink    the contour colour: a near-black with the grade's hue in it, never pure black.
 *   light  the brightest accent, used by the lettering and the numeral.
 *   drop   the lettering's offset shadow.
 *   paper/wash/glow/hatch   the poster card the panels sit on.
 *   sun    where the poster's low sun sits, in cover coordinates, for the backdrop glow.
 */
export const GRADES = {
  dusk: {
    label: 'Dusk',
    note: 'plum shade, amber sun',
    bands: 4,
    cel: ['#2b0f3f', '#6d1a55', '#b6403b', '#f2913c'],
    ink: '#150618',
    light: '#ffe3ab',
    drop: '#8a2350',
    accent: '#ffc35c',
    paper: '#110a1b',
    wash: '#3f1246',
    glow: '#ff9a4e',
    hatch: '#ffcf8e',
    sun: { x: 0.5, y: 0.94, r: 0.62 },
  },
  neon: {
    label: 'Neon',
    note: 'cyan rim, magenta haze',
    bands: 4,
    cel: ['#0a0726', '#341268', '#8d1c9e', '#ef4a93'],
    ink: '#070313',
    light: '#c8f2ff',
    drop: '#5a1a86',
    accent: '#66e6ff',
    paper: '#080618',
    wash: '#2a1160',
    glow: '#ff4fa2',
    hatch: '#9fe8ff',
    sun: { x: 0.5, y: 0.9, r: 0.58 },
  },
  heat: {
    label: 'Heat',
    note: 'burnt orange, hard black',
    bands: 4,
    cel: ['#160305', '#4a0a0f', '#a72a11', '#f0891f'],
    ink: '#0d0204',
    light: '#ffe6b0',
    drop: '#75200c',
    accent: '#ffb03a',
    paper: '#120406',
    wash: '#54100c',
    glow: '#ff8a1f',
    hatch: '#ffd08a',
    sun: { x: 0.5, y: 0.96, r: 0.66 },
  },
};

export const GRADE_ORDER = ['dusk', 'neon', 'heat'];

/** The working grid's long side, in cells. Cel art wants big shapes, not pixels. */
const WORK_LONG = 640;

/** How far the value curve is pushed away from mid grey before banding. */
const CRUSH = 1.24;

/** The value window taken from each panel's own histogram (percentiles, not min/max). */
const CUT_LO = 0.03;
const CUT_HI = 0.97;

/** How many times the 3x3 modal filter runs. Each pass erases specks one cell smaller. */
const MODE_PASSES = 2;

/** Above this chroma a cell is given a warm or cool variant instead of the neutral fill. */
const HUE_FLOOR = 16;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Parse '#rrggbb' into three bytes. */
function rgbOf(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * The twelve flat fills of a grade: four tones, each in three hue sectors.
 *
 * The variants are small on purpose. A warm sector leans the fill a touch toward red while
 * dropping a little blue; a cool sector does the reverse. That is enough for a face and a sky
 * in the same tone to stay distinguishable as paint, and far too little to break the poster's
 * single palette: the twelve all sit on the grade's four-tone spine.
 */
const paletteCache = new Map();
function paletteOf(grade) {
  const hit = paletteCache.get(grade);
  if (hit) return hit;
  const out = new Uint8Array(grade.bands * 3 * 3);
  for (let b = 0; b < grade.bands; b++) {
    const base = rgbOf(grade.cel[b]);
    const variants = [
      base,
      [base[0] * 1.1 + 8, base[1] * 0.97, base[2] * 0.86],
      [base[0] * 0.9, base[1] * 0.99, base[2] * 1.12 + 6],
    ];
    for (let s = 0; s < 3; s++) {
      const at = (b * 3 + s) * 3;
      for (let c = 0; c < 3; c++) out[at + c] = clamp(Math.round(variants[s][c]), 0, 255);
    }
  }
  paletteCache.set(grade, out);
  return out;
}

/**
 * Draw `source` into a W x H box with cover-fit, a zoom and a focal point.
 * `fx`/`fy` name the point of the source that stays in the middle of the box; the draw is
 * clamped to the image so a panel can never show empty space, whatever the slider says.
 */
export function drawCropped(source, ctx, W, H, crop = {}) {
  const zoom = crop.zoom > 1 ? crop.zoom : 1;
  const scale = Math.max(W / source.width, H / source.height) * zoom;
  const dw = source.width * scale;
  const dh = source.height * scale;
  const fx = clamp(crop.fx ?? 0.5, 0, 1);
  const fy = clamp(crop.fy ?? 0.5, 0, 1);
  const dx = clamp(W / 2 - fx * dw, W - dw, 0);
  const dy = clamp(H / 2 - fy * dh, H - dh, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, dx, dy, dw, dh);
}

/**
 * How much one panel-fraction of drag moves the focal point, per axis. A drag across the whole
 * panel then travels exactly the hidden overflow, so the picture tracks the pointer one-to-one.
 */
export function panFactor(source, W, H, zoom) {
  const scale = Math.max(W / source.width, H / source.height) * (zoom > 1 ? zoom : 1);
  return { x: (source.width * scale) / W, y: (source.height * scale) / H };
}

/**
 * Two passes of a separable [1 2 1] blur over one float plane, in place.
 * This is the pass that decides what counts as a shape: run hard enough, stubble, weave, water
 * ripple and JPEG mosquito noise all collapse, while a jawline or a horizon survives.
 */
function blurPlane(plane, w, h) {
  const tmp = new Float32Array(plane.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const last = row + w - 1;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const l = x > 0 ? plane[i - 1] : plane[i];
        const r = x < w - 1 ? plane[i + 1] : plane[i];
        tmp[i] = (l + plane[i] + plane[i] + r) * 0.25;
      }
      tmp[last] = tmp[last];
    }
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const up = y > 0 ? row - w : row;
      const dn = y < h - 1 ? row + w : row;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        plane[i] = (tmp[up + x] + tmp[i] + tmp[i] + tmp[dn + x]) * 0.25;
      }
    }
  }
}

/**
 * The most common value in each cell's 3x3 neighbourhood, centre winning ties, in place.
 * A flat fill can only be flat if the labels under it are: a single speck of the wrong tone in
 * a stretch of sky paints a hole, and a hole in a flat is exactly the "photo with a filter on
 * it" tell this pass exists to remove.
 */
function modeFilter(labels, w, h, passes) {
  const src = new Uint8Array(labels.length);
  for (let p = 0; p < passes; p++) {
    src.set(labels);
    for (let y = 1; y < h - 1; y++) {
      let i = y * w + 1;
      for (let x = 1; x < w - 1; x++, i++) {
        const a0 = src[i - w - 1];
        const a1 = src[i - w];
        const a2 = src[i - w + 1];
        const a3 = src[i - 1];
        const a4 = src[i];
        const a5 = src[i + 1];
        const a6 = src[i + w - 1];
        const a7 = src[i + w];
        const a8 = src[i + w + 1];
        let c0 = 0;
        let c1 = 0;
        let c2 = 0;
        let c3 = 0;
        c0 += a0 === 0; c1 += a0 === 1; c2 += a0 === 2; c3 += a0 === 3;
        c0 += a1 === 0; c1 += a1 === 1; c2 += a1 === 2; c3 += a1 === 3;
        c0 += a2 === 0; c1 += a2 === 1; c2 += a2 === 2; c3 += a2 === 3;
        c0 += a3 === 0; c1 += a3 === 1; c2 += a3 === 2; c3 += a3 === 3;
        c0 += a4 === 0; c1 += a4 === 1; c2 += a4 === 2; c3 += a4 === 3;
        c0 += a5 === 0; c1 += a5 === 1; c2 += a5 === 2; c3 += a5 === 3;
        c0 += a6 === 0; c1 += a6 === 1; c2 += a6 === 2; c3 += a6 === 3;
        c0 += a7 === 0; c1 += a7 === 1; c2 += a7 === 2; c3 += a7 === 3;
        c0 += a8 === 0; c1 += a8 === 1; c2 += a8 === 2; c3 += a8 === 3;
        // The centre's own count is 2 in the comparison below, so it wins every tie.
        const m0 = c0 * 2 + (a4 === 0);
        const m1 = c1 * 2 + (a4 === 1);
        const m2 = c2 * 2 + (a4 === 2);
        const m3 = c3 * 2 + (a4 === 3);
        let best = a4;
        let top = m0;
        if (m1 > top) { top = m1; best = 1; }
        if (m2 > top) { top = m2; best = 2; }
        if (m3 > top) { best = 3; }
        labels[i] = best;
      }
    }
  }
}

/**
 * The illustration pass. `options` is
 *   { width, height, grade, zoom, fx, fy, world }
 * where `world` describes the cover the panel sits on ({coverW, coverH, x, y}); it is only used
 * to place the placeholder's glow, since the panel grade is cover-independent by design.
 *
 * Returns a new canvas holding the painted plate. No source yields a painted placeholder, so an
 * empty panel is still composed rather than a grey hole.
 */
export function processPhoto(source, options) {
  const W = Math.max(8, Math.round(options.width));
  const H = Math.max(8, Math.round(options.height));
  const grade = GRADES[options.grade] ?? GRADES.dusk;
  const world = options.world ?? { coverW: W, coverH: H, x: 0, y: 0 };
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  if (!source) {
    paintPlaceholder(ctx, W, H, grade, world);
    return canvas;
  }

  // 1. Down to the working grid and blur it flat. Everything from here on happens in cells, so
  //    the cost of the pass does not grow with the export size.
  const gs = Math.min(1, WORK_LONG / Math.max(W, H));
  const gw = Math.max(12, Math.round(W * gs));
  const gh = Math.max(12, Math.round(H * gs));
  const scratch = document.createElement('canvas');
  scratch.width = gw;
  scratch.height = gh;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  drawCropped(source, sctx, gw, gh, options);
  const frame = sctx.getImageData(0, 0, gw, gh);
  const px = frame.data;
  const cells = gw * gh;

  const pr = new Float32Array(cells);
  const pg = new Float32Array(cells);
  const pb = new Float32Array(cells);
  for (let i = 0, p = 0; i < cells; i++, p += 4) {
    pr[i] = px[p];
    pg[i] = px[p + 1];
    pb[i] = px[p + 2];
  }
  blurPlane(pr, gw, gh);
  blurPlane(pg, gw, gh);
  blurPlane(pb, gw, gh);

  // 2. Value, normalised per panel to the same percentile window. This is the step that makes
  //    three photographs share one exposure, and therefore one light.
  const lum = new Float32Array(cells);
  const hist = new Int32Array(256);
  for (let i = 0; i < cells; i++) {
    const v = (pr[i] * 77 + pg[i] * 150 + pb[i] * 29) * 0.00390625;
    lum[i] = v;
    hist[clamp(Math.round(v), 0, 255)]++;
  }
  let acc = 0;
  let lo = 0;
  let hi = 255;
  const loTarget = cells * CUT_LO;
  const hiTarget = cells * CUT_HI;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc <= loTarget) lo = v;
    if (acc <= hiTarget) hi = v;
  }
  const span = Math.max(28, hi - lo);

  // 3. Band, crush and flatten. CRUSH pushes the shoulders out so the middle of the range is
  //    thin and each panel settles on four readable tones instead of six hazy ones.
  const bands = grade.bands;
  const band = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) {
    let t = clamp((lum[i] - lo) / span, 0, 1);
    t = clamp((t - 0.5) * CRUSH + 0.5, 0, 1);
    const b = Math.floor(t * bands);
    band[i] = b >= bands ? bands - 1 : b;
  }
  modeFilter(band, gw, gh, MODE_PASSES);

  // 4. Hue sector: warm, neutral or cool, from the blurred photograph. Coarse on purpose — it
  //    picks between three near-shades of the same ramped tone, not between colours.
  const sector = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) {
    const r = pr[i];
    const g = pg[i];
    const b = pb[i];
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
    const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
    const chroma = mx - mn;
    if (chroma < HUE_FLOOR) continue;
    let hue;
    if (mx === r) hue = 60 * ((g - b) / chroma);
    else if (mx === g) hue = 60 * (2 + (b - r) / chroma);
    else hue = 60 * (4 + (r - g) / chroma);
    if (hue < 0) hue += 360;
    sector[i] = hue < 105 || hue >= 330 ? 1 : 2;
  }
  modeFilter(sector, gw, gh, 1);

  // One byte per cell naming its flat fill. Tone x 3 + sector, so the tone is recoverable as
  // (index / 3) | 0 and a contour can be found from the tone alone.
  const pal = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) pal[i] = band[i] * 3 + sector[i];

  // 5. Up to the panel's own resolution, nearest-neighbour. The flats stay hard-edged; the ink
  //    pass below is what covers the cell steps at the boundaries.
  const colMap = new Int32Array(W);
  for (let x = 0; x < W; x++) colMap[x] = Math.min(gw - 1, ((x * gw) / W) | 0);
  const rowMap = new Int32Array(H);
  for (let y = 0; y < H; y++) rowMap[y] = Math.min(gh - 1, ((y * gh) / H) | 0);
  const big = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const srcRow = rowMap[y] * gw;
    const row = y * W;
    for (let x = 0; x < W; x++) big[row + x] = pal[srcRow + colMap[x]];
  }

  // 6. Contours. A cell boundary where the TONE steps is ink; the wider the step, the heavier
  //    the line. Because the tone map has already been modal-filtered, these contours close:
  //    they are the outlines of the shapes, not the ghost of the photograph's texture.
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H - 1; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      const here = (big[i] / 3) | 0;
      const right = x < W - 1 ? (big[i + 1] / 3) | 0 : here;
      const down = (big[i + W] / 3) | 0;
      const dr = here - right;
      const dd = here - down;
      const step = Math.max(dr < 0 ? -dr : dr, dd < 0 ? -dd : dd);
      if (step > 0) mask[i] = step > 1 ? 2 : 1;
    }
  }

  // 7. Weight by stamping. A three-pixel square for a one-tone break, five for a two-tone one:
  //    silhouettes get a fat contour and interior modelling gets a thin one, which is how a
  //    painted plate varies its line weight without a brush engine.
  const alpha = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const v = mask[row + x];
      if (v === 0) continue;
      const rad = v > 1 ? 2 : 1;
      const level = v > 1 ? 1 : 0.82;
      const y0 = y - rad < 0 ? 0 : y - rad;
      const y1 = y + rad > H - 1 ? H - 1 : y + rad;
      const x0 = x - rad < 0 ? 0 : x - rad;
      const x1 = x + rad > W - 1 ? W - 1 : x + rad;
      for (let yy = y0; yy <= y1; yy++) {
        const at = yy * W;
        for (let xx = x0; xx <= x1; xx++) {
          if (alpha[at + xx] < level) alpha[at + xx] = level;
        }
      }
    }
  }

  // 8. Composite: flat fill, then ink. A single 3x3 box over the mask keeps the cell steps from
  //    showing as staircases inside the line.
  const inkRGB = rgbOf(grade.ink);
  const palette = paletteOf(grade);
  const out = ctx.createImageData(W, H);
  const dst = out.data;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    const up = y > 0 ? row - W : row;
    const dn = y < H - 1 ? row + W : row;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      const p = i << 2;
      const at = big[i] * 3;
      let r = palette[at];
      let g = palette[at + 1];
      let b = palette[at + 2];
      const a0 = x > 0 ? i - 1 : i;
      const a1 = x < W - 1 ? i + 1 : i;
      const coat =
        (alpha[i] * 2 + alpha[a0] + alpha[a1] + alpha[up + x] + alpha[dn + x]) * 0.16666667;
      if (coat > 0.02) {
        const k = coat > 1 ? 1 : coat;
        r += (inkRGB[0] - r) * k;
        g += (inkRGB[1] - g) * k;
        b += (inkRGB[2] - b) * k;
      }
      dst[p] = r;
      dst[p + 1] = g;
      dst[p + 2] = b;
      dst[p + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

/**
 * A painted panel for a slot with no photograph: the same four tones, a low sun, and a scatter
 * of dune shapes with ink on them, so the poster still looks composed before the first upload.
 */
function paintPlaceholder(ctx, W, H, grade, world) {
  const palette = paletteOf(grade);
  const sunY = H * 0.72;
  ctx.fillStyle = grade.cel[1];
  ctx.fillRect(0, 0, W, H);

  // Sky: two flat bands, hard edge between them.
  ctx.fillStyle = grade.cel[2];
  ctx.fillRect(0, 0, W, H * 0.42);
  ctx.fillStyle = grade.cel[3];
  ctx.beginPath();
  ctx.arc(W * 0.5, sunY, Math.min(W, H) * 0.26, Math.PI, 0);
  ctx.fill();
  ctx.fillRect(0, sunY - 1, W, H * 0.07);

  // Ground: one soft dune, cut flat.
  ctx.fillStyle = grade.cel[0];
  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(0, H * 0.78);
  ctx.quadraticCurveTo(W * 0.34, H * 0.6, W * 0.66, H * 0.8);
  ctx.quadraticCurveTo(W * 0.84, H * 0.9, W, H * 0.84);
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fill();

  // Ink on every boundary, heavier on the horizon.
  ctx.strokeStyle = grade.ink;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, Math.min(W, H) * 0.009);
  ctx.beginPath();
  ctx.moveTo(0, H * 0.42);
  ctx.lineTo(W, H * 0.42);
  ctx.stroke();
  ctx.lineWidth = Math.max(2, Math.min(W, H) * 0.013);
  ctx.beginPath();
  ctx.arc(W * 0.5, sunY, Math.min(W, H) * 0.26, Math.PI, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, H * 0.78);
  ctx.quadraticCurveTo(W * 0.34, H * 0.6, W * 0.66, H * 0.8);
  ctx.quadraticCurveTo(W * 0.84, H * 0.9, W, H * 0.84);
  ctx.stroke();

  // A pale disc for the sun itself, so the plate has a light source.
  ctx.fillStyle = grade.light;
  ctx.beginPath();
  ctx.arc(W * 0.5, sunY - Math.min(W, H) * 0.05, Math.min(W, H) * 0.12, 0, Math.PI * 2);
  ctx.fill();
}
