// ink.js — the illustration pass: a photograph becomes a painted cel plate.
//
// The look this file is after is key art that was painted, not a photograph with a filter on
// it, so the pipeline is deliberately destructive. It keeps three things and throws the rest
// away: the big shapes, the value breaks between them, and a coarse idea of hue.
//
//   photo -> heavy blur -> per-panel value normalise -> crush -> four flat tones
//         -> area despeckle (no region smaller than a brush-load survives)
//         -> twelve flat fills (tone x hue sector)
//         -> contour distance field -> antialiased, weight-varying ink lines
//
// There is no grain, no stipple, no halftone screen and no per-pixel tinting anywhere in this
// file. Every colour inside a panel is one of twelve flat values taken from the grade's
// four-tone ramp, and every boundary between two tones is a drawn line. That is the whole
// trick: flat fills the eye can name, and contours the eye can follow.
//
// The contour is the interesting part. Thresholding a band map gives broken, stair-stepped,
// speckle-ringed edges — the "photo with a filter" tell. So the boundaries are traced as
// *distance fields* at cell resolution, bilinearly resampled to the panel, and thresholded
// there. A line therefore comes out continuous (the field has no gaps), antialiased (the ramp
// is sub-pixel) and of varying weight (a second field is kept for the strong boundaries, and
// it is wider). Silhouettes get a fat contour, interior modelling a thin one — the way a
// painted plate varies line weight without a brush engine.
//
// One light, one grade. Each panel's value range is normalised to the same percentile window
// and then cut into the same four steps, so a dim shot and a bright one land on the same four
// tones; the ramp itself carries the sunset. Three panels cut from three photographs therefore
// read as three views of one place at one hour.

/**
 * The three grades the editor offers.
 *
 *   cel    the four flat fills, shade to light. Every panel is painted only from these.
 *   ink    the contour colour: a near-black with the grade's hue in it, never pure black.
 *   light  the brightest accent, used by the lettering and the numeral.
 *   drop   the lettering's offset shadow.
 *   paper/wash/glow   the poster card the panels sit on.
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
    sun: { x: 0.5, y: 0.96, r: 0.66 },
  },
};

export const GRADE_ORDER = ['dusk', 'neon', 'heat'];

/** The working grid's long side, in cells. Cel art wants shapes, not pixels. */
const WORK_LONG = 760;

/** How far the value curve is pushed away from mid grey before banding. */
const CRUSH = 1.22;

/** The value window taken from each panel's own histogram (percentiles, not min/max). */
const CUT_LO = 0.03;
const CUT_HI = 0.97;

/** No region smaller than this share of the panel survives: it is confetti, not a shape. */
const MIN_REGION = 0.00055;

/** Above this chroma a cell is given a warm or cool variant instead of the neutral fill. */
const HUE_FLOOR = 18;

/** Contour half-widths in cells: the thin line, and the heavy silhouette line. */
const W_THIN = 1.15;
const W_HEAVY = 2.05;

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
 * Separable [1 2 1] blur, run `passes` times over one float plane, in place.
 * This is the pass that decides what counts as a shape: run hard enough, stubble, weave, water
 * ripple and JPEG mosquito noise all collapse, while a jawline or a horizon survives.
 */
function blurPlane(plane, w, h, passes) {
  const tmp = new Float32Array(plane.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const l = x > 0 ? plane[i - 1] : plane[i];
        const r = x < w - 1 ? plane[i + 1] : plane[i];
        tmp[i] = (l + plane[i] + plane[i] + r) * 0.25;
      }
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
 * Absorb every region smaller than `minArea` cells into the label around it.
 *
 * This is the pass that ends the confetti. A photo has thousands of one-cell value islands —
 * the top of a hair, a glint on chrome, a ripple — and a band map draws each one as a ring of
 * ink, which is exactly what made the earlier version read as a filtered photograph. A cell
 * that belongs to a region too small to be a shape is repainted as its most common neighbour,
 * and the sweep is repeated, because absorbing one speck can orphan the next.
 *
 * `passes` bounds the work: four sweeps clear specks of up to four cells' growth, which is
 * every artefact a 7-cell blur leaves behind.
 */
function despeckle(labels, w, h, minArea, passes) {
  const total = w * h;
  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  const members = new Int32Array(total);
  const counts = new Int32Array(64);

  for (let pass = 0; pass < passes; pass++) {
    seen.fill(0);
    let changed = false;
    for (let start = 0; start < total; start++) {
      if (seen[start]) continue;
      const label = labels[start];
      let top = 0;
      let n = 0;
      stack[top++] = start;
      seen[start] = 1;
      while (top > 0) {
        const i = stack[--top];
        members[n++] = i;
        const x = i % w;
        const y = (i / w) | 0;
        if (x > 0 && !seen[i - 1] && labels[i - 1] === label) { seen[i - 1] = 1; stack[top++] = i - 1; }
        if (x < w - 1 && !seen[i + 1] && labels[i + 1] === label) { seen[i + 1] = 1; stack[top++] = i + 1; }
        if (y > 0 && !seen[i - w] && labels[i - w] === label) { seen[i - w] = 1; stack[top++] = i - w; }
        if (y < h - 1 && !seen[i + w] && labels[i + w] === label) { seen[i + w] = 1; stack[top++] = i + w; }
      }
      if (n >= minArea) continue;

      // Too small to keep. Its surrounding labels decide what it becomes: a region this small
      // is edge material, so most of its cells touch the label that will replace them.
      counts.fill(0);
      for (let k = 0; k < n; k++) {
        const i = members[k];
        const x = i % w;
        const y = (i / w) | 0;
        if (x > 0 && labels[i - 1] !== label) counts[labels[i - 1]]++;
        if (x < w - 1 && labels[i + 1] !== label) counts[labels[i + 1]]++;
        if (y > 0 && labels[i - w] !== label) counts[labels[i - w]]++;
        if (y < h - 1 && labels[i + w] !== label) counts[labels[i + w]]++;
      }
      let best = label;
      let bestCount = 0;
      for (let v = 0; v < counts.length; v++) {
        if (counts[v] > bestCount) { bestCount = counts[v]; best = v; }
      }
      if (best === label) continue;
      for (let k = 0; k < n; k++) labels[members[k]] = best;
      changed = true;
    }
    if (!changed) break;
  }
}

/**
 * A chamfer distance transform: for every cell, the distance in cells to the nearest set cell
 * of `seed`, capped at `cap`. Two sweeps of a 3x3 mask, which is all a contour needs.
 */
function distanceField(seed, w, h, cap) {
  const field = new Float32Array(w * h);
  const far = cap + 1;
  for (let i = 0; i < field.length; i++) field[i] = seed[i] ? 0 : far;
  const D1 = 1;
  const D2 = 1.41421356;
  const relax = (i, j, d) => {
    const v = field[j] + d;
    if (v < field[i]) field[i] = v;
  };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (field[i] === 0) continue;
      if (x > 0) relax(i, i - 1, D1);
      if (y > 0) {
        if (x > 0) relax(i, i - w - 1, D2);
        relax(i, i - w, D1);
        if (x < w - 1) relax(i, i - w + 1, D2);
      }
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    for (let x = w - 1; x >= 0; x--) {
      const i = row + x;
      if (field[i] === 0) continue;
      if (x < w - 1) relax(i, i + 1, D1);
      if (y < h - 1) {
        if (x < w - 1) relax(i, i + w + 1, D2);
        relax(i, i + w, D1);
        if (x > 0) relax(i, i + w - 1, D2);
      }
    }
  }
  for (let i = 0; i < field.length; i++) if (field[i] > cap) field[i] = cap;
  return field;
}

/** Bilinear sample of a cell-resolution float field at fractional cell coordinates. */
function sampleField(field, w, h, fx, fy) {
  const x = fx < 0 ? 0 : fx > w - 1.001 ? w - 1.001 : fx;
  const y = fy < 0 ? 0 : fy > h - 1.001 ? h - 1.001 : fy;
  const x0 = x | 0;
  const y0 = y | 0;
  const tx = x - x0;
  const ty = y - y0;
  const i = y0 * w + x0;
  const a = field[i];
  const b = field[i + 1];
  const c = field[i + w];
  const d = field[i + w + 1];
  const top = a + (b - a) * tx;
  const bot = c + (d - c) * tx;
  return top + (bot - top) * ty;
}

/** A smooth 1 inside the contour, 0 outside it, with a one-pixel ramp for antialiasing. */
function inkAt(dist, half) {
  if (dist >= half + 0.5) return 0;
  if (dist <= half - 0.5) return 1;
  return half + 0.5 - dist;
}

/**
 * The illustration pass. `options` is
 *   { width, height, grade, zoom, fx, fy }
 *
 * Returns a new canvas holding the painted plate. No source yields a painted placeholder, so an
 * empty panel is still composed rather than a grey hole.
 */
export function processPhoto(source, options) {
  const W = Math.max(8, Math.round(options.width));
  const H = Math.max(8, Math.round(options.height));
  const grade = GRADES[options.grade] ?? GRADES.dusk;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  if (!source) {
    paintPlaceholder(ctx, W, H, grade, options.world);
    return canvas;
  }

  // 1. Down to the working grid and blur it flat. Everything from here on happens in cells, so
  //    the cost of the pass does not grow with the export size.
  const gs = Math.max(1e-6, Math.min(1, WORK_LONG / Math.max(W, H)));
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
  // Three passes: a 7-cell kernel, which at a 760-cell grid is a generous brush. It is what
  // turns a face into planes instead of pores.
  blurPlane(pr, gw, gh, 3);
  blurPlane(pg, gw, gh, 3);
  blurPlane(pb, gw, gh, 3);

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
  const tone = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) {
    let t = clamp((lum[i] - lo) / span, 0, 1);
    t = clamp((t - 0.5) * CRUSH + 0.5, 0, 1);
    const b = Math.floor(t * bands);
    tone[i] = b >= bands ? bands - 1 : b;
  }

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

  // 5. One byte per cell naming its flat fill: tone x 3 + sector. Then despeckle the whole
  //    label so neither a tone speck nor a stray hue patch can survive as a ring of ink.
  const pal = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) pal[i] = tone[i] * 3 + sector[i];
  despeckle(pal, gw, gh, Math.max(20, Math.round(cells * MIN_REGION)), 4);

  // 6. Contours, as distance fields. A boundary cell is one whose tone differs from the cell to
  //    its right or below it. `thin` seeds every such boundary; `heavy` seeds only the ones
  //    where the tone steps by two bands or more, i.e. where a shape meets its background.
  const thinSeed = new Uint8Array(cells);
  const heavySeed = new Uint8Array(cells);
  for (let y = 0; y < gh - 1; y++) {
    const row = y * gw;
    for (let x = 0; x < gw; x++) {
      const i = row + x;
      const here = (pal[i] / 3) | 0;
      if (x < gw - 1) {
        const right = (pal[i + 1] / 3) | 0;
        const step = here > right ? here - right : right - here;
        if (step > 0) {
          thinSeed[i] = 1;
          if (step > 1) heavySeed[i] = 1;
        }
      }
      const down = (pal[i + gw] / 3) | 0;
      const step = here > down ? here - down : down - here;
      if (step > 0) {
        thinSeed[i] = 1;
        if (step > 1) heavySeed[i] = 1;
      }
    }
  }
  const distThin = distanceField(thinSeed, gw, gh, W_HEAVY + 2);
  const distHeavy = distanceField(heavySeed, gw, gh, W_HEAVY + 2);

  // 7. Composite: flat fill, sampled nearest so the flats stay hard, then ink from the two
  //    distance fields resampled bilinearly so the lines stay smooth at any export size.
  const inkRGB = rgbOf(grade.ink);
  const palette = paletteOf(grade);
  const out = ctx.createImageData(W, H);
  const dst = out.data;
  const stepX = gw / W;
  const stepY = gh / H;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    const cy = (y + 0.5) * stepY - 0.5;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      const p = i << 2;
      const cx = (x + 0.5) * stepX - 0.5;
      const sx = clamp(Math.round(cx), 0, gw - 1);
      const sy = clamp(Math.round(cy), 0, gh - 1);
      const at = pal[sy * gw + sx] * 3;
      let r = palette[at];
      let g = palette[at + 1];
      let b = palette[at + 2];

      // Convert the contour half-widths from cells to the panel's pixels on this axis.
      const scale = (stepX + stepY) * 0.5;
      const aThin = inkAt(sampleField(distThin, gw, gh, cx, cy), W_THIN / scale);
      const aHeavy = inkAt(sampleField(distHeavy, gw, gh, cx, cy), W_HEAVY / scale);
      const coat = aHeavy > aThin ? aHeavy : aThin;
      if (coat > 0.002) {
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
 * A painted panel for a slot with no photograph: the same four tones, a low sun, and a bank of
 * dunes with ink on them, so the poster still looks composed before the first upload.
 */
function paintPlaceholder(ctx, W, H, grade, world) {
  const unitSize = Math.min(W, H);
  const sunY = H * 0.7;

  ctx.fillStyle = grade.cel[1];
  ctx.fillRect(0, 0, W, H);

  // Sky: one flat band, a hard horizon, a half-disc of sun.
  ctx.fillStyle = grade.cel[2];
  ctx.fillRect(0, 0, W, H * 0.46);
  ctx.fillStyle = grade.cel[3];
  ctx.beginPath();
  ctx.arc(W * 0.5, sunY, unitSize * 0.27, Math.PI, 0);
  ctx.closePath();
  ctx.fill();

  // Ground: two dunes, cut flat, the far one lighter.
  ctx.fillStyle = grade.cel[0];
  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(0, H * 0.8);
  ctx.quadraticCurveTo(W * 0.34, H * 0.6, W * 0.68, H * 0.82);
  ctx.quadraticCurveTo(W * 0.86, H * 0.92, W, H * 0.85);
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fill();

  // Ink on every boundary, heavier on the horizon.
  ctx.strokeStyle = grade.ink;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, unitSize * 0.008);
  ctx.beginPath();
  ctx.moveTo(0, H * 0.46);
  ctx.lineTo(W, H * 0.46);
  ctx.stroke();
  ctx.lineWidth = Math.max(2.5, unitSize * 0.014);
  ctx.beginPath();
  ctx.arc(W * 0.5, sunY, unitSize * 0.27, Math.PI, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, H * 0.8);
  ctx.quadraticCurveTo(W * 0.34, H * 0.6, W * 0.68, H * 0.82);
  ctx.quadraticCurveTo(W * 0.86, H * 0.92, W, H * 0.85);
  ctx.stroke();

  // The sun's disc, in the grade's brightest fill, so the plate has a light source.
  ctx.fillStyle = grade.light;
  ctx.beginPath();
  ctx.arc(W * 0.5, sunY - unitSize * 0.045, unitSize * 0.115, 0, Math.PI * 2);
  ctx.fill();
  void world;
}
