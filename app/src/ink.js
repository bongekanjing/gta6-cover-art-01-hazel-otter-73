// ink.js — the illustration pass: a photograph becomes a painted cel plate.
//
// The target is key art that was painted, not a photograph with a filter on it, so the pipeline
// is deliberately destructive. It keeps three things and throws the rest away: the big shapes,
// the value breaks between them, and a coarse idea of hue.
//
//   photo -> brush grid -> hard blur -> per-panel value normalise -> shared tone conform
//         -> four band labels + three hue labels, each despeckled as a region map
//         -> the two axes combined and despeckled again, so slivers cannot survive
//         -> paint grid: one-hot vote planes, argmax per cell, so every cell is exactly one tone
//         -> ink = chamfer distance from the tone boundaries, in two weights
//         -> one bilinear upscale of the finished plate
//
// No grain, no stipple, no halftone screen and no per-pixel tinting. Every colour inside a panel
// is one of twelve flat values on the grade's four-tone spine.
//
// WHY ARGMAX AND NOT A THRESHOLD. Thresholding a continuous value field produces cells that
// belong to no band: a gradient crossing one boundary yields a one-cell ribbon of a fourth colour
// sandwiched between two others. Those ribbons were the loudest "a quantiser did this" tell in
// the previous pass — a stray rule under every horizon, a pale rim along every rod, a sliver on
// every hat brim. Voting for each band separately and taking the winner can only ever return a
// band that some region actually has, so ribbons are impossible by construction.
//
// WHY A DISTANCE TRANSFORM AND NOT A GRADIENT. Ink width from `value / |grad value|` is only as
// even as the gradient is, and the gradient of a blurred field varies by an order of magnitude
// between a hard silhouette and a soft fold — so the same line came out fat in one place and
// vanished in another, and where the field was locally flat it drew no line at all. The distance
// from the boundary set is exact, so a stroke is one width along its whole length and cannot
// break. Two masks are transformed: every tone boundary, and the subset where the tone jumps two
// bands or more. The second is the fat contour that goes round silhouettes; the first is the thin
// line that goes round folds. Ink is the greater of the two, which is weight-varying line drawn
// from the picture, with no brush engine and no randomness.
//
// One light, one grade. Each panel's value range is normalised to the same percentile window,
// conformed to the same mean and spread, and finally its finished plate is driven onto the
// luminance of the grade's own four tones. A dim shot and a bright one therefore land on the same
// ramps; the ramp itself carries the sunset. Three panels cut from three photographs read as
// three views of one place at one hour.

/**
 * The three grades the editor offers.
 *
 *   cel    the four flat fills, shade to light. Every panel is painted only from these.
 *   ink    the contour colour: a near-black carrying the grade's hue, never pure black.
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
    cel: ['#1a0620', '#cf2287', '#f76a45', '#ffd089'],
    ink: '#100311',
    light: '#fff0c8',
    drop: '#7d1443',
    accent: '#ffc35c',
    paper: '#0d0614',
    wash: '#35103c',
    glow: '#ff8f45',
    sun: { x: 0.5, y: 0.94, r: 0.62 },
  },
  neon: {
    label: 'Neon',
    note: 'cyan rim, magenta haze',
    bands: 4,
    cel: ['#0c0729', '#8820c9', '#ee56d4', '#ffc2dc'],
    ink: '#060314',
    light: '#d8f6ff',
    drop: '#4a1673',
    accent: '#66e6ff',
    paper: '#070515',
    wash: '#231055',
    glow: '#ff4fa2',
    sun: { x: 0.5, y: 0.9, r: 0.58 },
  },
  heat: {
    label: 'Heat',
    note: 'burnt orange, hard black',
    bands: 4,
    cel: ['#220607', '#b8300f', '#fc7a1c', '#ffd07d'],
    ink: '#0b0203',
    light: '#fff3d2',
    drop: '#6b1a09',
    accent: '#ffb03a',
    paper: '#100304',
    wash: '#4a0e0a',
    glow: '#ff7d16',
    sun: { x: 0.5, y: 0.96, r: 0.66 },
  },
};

export const GRADE_ORDER = ['dusk', 'neon', 'heat'];

/** The brush grid's long side, in cells. Cel art wants shapes, not pixels. */
const WORK_LONG = 700;

/**
 * The paint grid's long side, in cells. The plate is composed at this size and upscaled once, so
 * every edge in the finished panel is the bilinear interpolation of an already antialiased edge —
 * the cheapest way to get a smooth curve out of a region map, and the reason the ink can stay a
 * few pixels wide without staircasing.
 */
const PAINT_LONG = 1400;

/** How far the value curve is pushed away from mid grey before banding. */
const CRUSH = 1.18;

/** The value window taken from each panel's own histogram (percentiles, not min/max). */
const CUT_LO = 0.03;
const CUT_HI = 0.97;

/**
 * How big a region has to be, as a fraction of the brush grid, to count as a shape rather than as
 * texture. Anything smaller is absorbed into the tone or hue around it.
 *
 * The tone floor is the smaller of the two because a tonal step is what carries the drawing: a
 * nostril or a lapel is a real, if small, shape. The hue floor is much larger because a hue island
 * never is — it is a glint, a leaf, the colour caught in a strand of hair — and painting each one
 * is exactly what makes flat art look like a photograph with flecks in it. The combined floor is
 * smallest of all because it only has to clean up the slivers the two axes leave behind when they
 * disagree about where an edge is.
 */
const TONE_MIN = 0.005;
const SECTOR_MIN = 0.014;
const COMBINED_MIN = 0.0012;

/**
 * The box-majority radius, in brush cells, and how many rounds of it run. This is the pass that
 * deletes anything narrower than about three cells — the pale rim on a rod, the sliver under a
 * horizon — and it rounds the corners of what survives. Two rounds, because a single pass leaves
 * the corners of a staircase sharp enough that the contour pass draws a stepped line round them.
 */
const CONDENSE_R = 2;
const CONDENSE_ROUNDS = 2;

/**
 * The one grade every panel is driven onto, after its own range is normalised.
 *
 * Percentiles equalise where a panel's darkest and lightest tones land but not where its middle
 * sits, so a dim shot and a bright one still come out at different means and the collage reads as
 * three photographs rather than one place. This curve puts every panel's mean on the same value
 * (`mean`) and gives it the same spread (`std`), so both ends of the histogram match and the
 * middle matches too.
 *
 * `stretch` clamps the gain. Without the clamp a panel of flat sky — a small spread — would be
 * stretched until its noise became contours, and the ink pass would draw a hard line through what
 * should be empty sky. `settle` is the number of recentre passes that undo the bias the 0..1 clamp
 * introduces at each end.
 */
const TONE = { mean: 0.52, std: 0.235, stretch: [0.72, 1.4], settle: 4 };

/** Above this chroma a cell is given a warm or cool variant instead of the neutral fill. */
const HUE_FLOOR = 20;

/**
 * The poster's one light, in grid axes: a low sun behind the characters, slightly to the left, so
 * every panel's highlights sit on the same side of every form.
 *
 *   x/y    the direction TOWARD the sun, in cells.
 *   reach  how many cells away the normal is measured. This is the parameter that decides whether
 *          the result reads as light or as a filter. Measured across one cell, the normal is
 *          dominated by whatever edge is adjacent, so every boundary grows a bright rim and a dark
 *          rim — an emboss, not a light. Measured across three, it reflects the tilt of the whole
 *          plane a cell sits on, which is what a painter reads.
 *   slope  how strongly that tilt is read as a surface normal, given the reach above.
 *   gain   how far the light may move a value, as a fraction of the whole range. At 4 bands a band
 *          is 0.25, so this is worth roughly one band: enough that one side of a form crosses into
 *          the next tone and the fill itself does the modelling, which is the point — when the
 *          plates carry the form, the line is free to be thin.
 */
const LIGHT = { x: -0.42, y: -0.91, reach: 3, slope: 1.15, gain: 0.15 };

/**
 * The terminator, as a deadband on the light term.
 *
 * `hi`/`lo` are how clearly a cell must be facing towards or away from the sun before it is moved a
 * whole plate. The deadband between them is what keeps the light from becoming a gradient: cells
 * that are neither strongly lit nor strongly shaded keep the plate they were given, so a form
 * resolves into (shade plate | unchanged plate | light plate) separated by two hard edges instead of
 * a soft ramp. `min` is the area floor the shifted map is cleaned to, big enough that the fringe of
 * a terminator is a shape rather than ragged pixels.
 */
const TERMINATOR = { hi: 0.34, lo: -0.3, min: 0.004 };

/**
 * Ink strength. The contour colour itself is near-black on its own; this is how much of it is
 * mixed in at the centre of a line, so the darkest tone of the plate and the ink on top of it stay
 * distinguishable. An ink that is merely the fourth darkest colour does not read as a drawn line —
 * it reads as the next band down, which is exactly the "traced region" look this pass exists to
 * avoid. Keeping the ink darker than any fill is what makes it a stroke.
 */
const INK_DEPTH = 0.94;

/**
 * Line weights in three ranks, in DISPLAY pixels. The ranks are the whole point: a line that is the
 * same thickness on a jaw and on a shirt-fold tells the eye nothing, and uniform outline is the
 * single clearest sign of an auto-trace. So the weight is read off the SIZE of the tonal step the
 * contour crosses — one band is a fold (thin), two is a form break (medium), three is a silhouette
 * against the sky (heavy). A poster's drawing is legible because its heaviest lines are spent on the
 * few edges that define the subject, and its lightest are barely there.
 *
 *   thin    one band of difference
 *   mid     two bands
 *   heavy   three bands, i.e. the darkest fill against the lightest
 */
const LINE_THIN = 1.25;
const LINE_MID = 3.4;
const LINE_HEAVY = 7.2;

/** How many times the one-hot vote planes are blurred before the argmax is taken. */
const VOTE_BLUR = 2;

/** Sentinel for "no boundary anywhere near". */
const FAR = 1e6;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Parse '#rrggbb' into three bytes. */
function rgbOf(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * The twelve flat fills of a grade: four tones, each in three hue sectors.
 *
 * The variants are deliberately tiny — a few percent of one channel. That is enough for a face and
 * a sky in the same tone to stay distinguishable as paint, and far too small to break the poster's
 * palette: standing back, a panel is four tones, which is the whole point.
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
      [base[0] * 1.06 + 4, base[1] * 0.985, base[2] * 0.92],
      [base[0] * 0.94, base[1] * 0.995, base[2] * 1.07 + 4],
    ];
    for (let s = 0; s < 3; s++) {
      const at = (b * 3 + s) * 3;
      for (let c = 0; c < 3; c++) out[at + c] = clamp(Math.round(variants[s][c]), 0, 255);
    }
  }
  paletteCache.set(grade, out);
  return out;
}

/** The luminance mean and spread of a grade's own four fills — what every plate is conformed to. */
const spineCache = new Map();
function spineOf(grade) {
  const hit = spineCache.get(grade);
  if (hit) return hit;
  const lums = grade.cel.map((hex) => {
    const [r, g, b] = rgbOf(hex);
    return r * 0.2126 + g * 0.7152 + b * 0.0722;
  });
  const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
  const variance = lums.reduce((a, b) => a + (b - mean) * (b - mean), 0) / lums.length;
  const out = { mean, std: Math.sqrt(variance) };
  spineCache.set(grade, out);
  return out;
}

/**
 * Draw `source` into a W x H box with cover-fit, a zoom and a focal point.
 * `fx`/`fy` name the point of the source that stays in the middle of the box; the draw is clamped
 * to the image so a panel can never show empty space, whatever the slider says.
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
 * Separable [1 2 1] blur over one float plane, in place, `passes` times.
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

/** Bilinear sample of a cell-resolution float field, with clamp-to-edge. */
function bilinear(field, w, h, fx, fy) {
  const x = fx < 0 ? 0 : fx > w - 1.002 ? w - 1.002 : fx;
  const y = fy < 0 ? 0 : fy > h - 1.002 ? h - 1.002 : fy;
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

/**
 * Absorb every region smaller than `minArea` cells into the label around it.
 *
 * This is the pass that ends the confetti, and the single most important difference between
 * painted art and a filtered photograph. A photo has thousands of tiny islands of one value or one
 * hue — a glint on water, the top of a hair — and giving each one its own fill sprays specks across
 * every flat area. Here each island too small to be a shape is repainted as its most common
 * neighbour, so the value and hue fields become a handful of large patches a painter would have
 * laid in with one stroke.
 *
 * `passes` bounds the work: absorbing one speck can orphan the next, so the sweep repeats.
 */
function despeckle(labels, w, h, minArea, passes, slots) {
  const total = w * h;
  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  const members = new Int32Array(total);
  const counts = new Int32Array(slots);

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

      // Too small to keep. Its surrounding labels decide what it becomes: a region this small is
      // edge material, so most of its cells touch the label that will replace them.
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
      for (let v = 0; v < slots; v++) {
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
 * Majority (mean-shift) filter over a label map: each cell takes the label that covers most of a
 * box around it, if that label is not already its own.
 *
 * This is what despeckle cannot do. Area is the wrong test for thinness: a one-cell-wide ribbon
 * winding across half the panel has thousands of cells and passes any area floor, yet it is
 * exactly the artefact that makes a traced photo look traced — the pale rim along a rod, the
 * sliver under a horizon, the fringe of hard-edge noise round a face. A box majority removes
 * anything narrower than the box, whatever its length, and it rounds the corners of what survives
 * instead of leaving the staircases a threshold makes. Runs on an integral image per label, so
 * the cost is linear in cells and independent of the radius.
 */
function condense(labels, w, h, slots, radius, rounds) {
  const W1 = w + 1;
  const rows = h + 1;
  const total = w * h;
  const plane = new Int32Array(W1 * rows);
  const best = new Int32Array(total);
  const bestN = new Int32Array(total);

  for (let round = 0; round < rounds; round++) {
    best.fill(0);
    bestN.fill(-1);
    for (let s = 0; s < slots; s++) {
      // Integral image of "is this cell label s", built in one sweep.
      plane.fill(0);
      let any = false;
      for (let y = 0; y < h; y++) {
        const src = y * w;
        const dst = (y + 1) * W1;
        let run = 0;
        for (let x = 0; x < w; x++) {
          if (labels[src + x] === s) {
            run++;
            any = true;
          }
          plane[dst + x + 1] = plane[dst - W1 + x + 1] + run;
        }
      }
      if (!any) continue;
      // Box count per cell, keeping the widest cover seen so far.
      for (let y = 0; y < h; y++) {
        const y0 = y - radius < 0 ? 0 : y - radius;
        const y1 = y + radius + 1 > h ? h : y + radius + 1;
        const top = y0 * W1;
        const bot = y1 * W1;
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const x0 = x - radius < 0 ? 0 : x - radius;
          const x1 = x + radius + 1 > w ? w : x + radius + 1;
          const n = plane[bot + x1] - plane[bot + x0] - plane[top + x1] + plane[top + x0];
          const i = row + x;
          if (n > bestN[i]) {
            bestN[i] = n;
            best[i] = s;
          }
        }
      }
    }
    // Adopt the winner. A cell whose own label already covers the box is left alone, which is
    // what keeps the pass from eroding big masses round their own boundary.
    for (let i = 0; i < total; i++) labels[i] = best[i];
  }
}
/**
 * One-hot vote planes for a label map: one float plane per label, holding 1 where a cell has that
 * label. Blurring a one-hot plane and taking the largest value is the standard way to turn a hard
 * region map into smooth boundaries, and it is why the paint grid can sample these with bilinear
 * and still return a valid label everywhere.
 */
function votePlanes(labels, cells, slots) {
  const planes = [];
  for (let s = 0; s < slots; s++) planes.push(new Float32Array(cells));
  for (let i = 0; i < cells; i++) planes[labels[i]][i] = 1;
  return planes;
}

/**
 * Two-pass chamfer distance from a binary mask, in cells.
 *
 * Distances are the only thing that can give a line an even width: the level sets of a distance
 * transform are offset curves, so a stroke drawn between two of them is the same thickness all the
 * way along, round both sides of a corner, and cannot pinch out where the underlying field happens
 * to be flat. sqrt(2) steps along the diagonals keep the offsets round rather than diamond-shaped.
 */
function chamfer(mask, w, h) {
  const dist = new Float32Array(w * h);
  const D = Math.SQRT2;
  for (let i = 0; i < dist.length; i++) dist[i] = mask[i] ? 0 : FAR;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (dist[i] === 0) continue;
      let d = dist[i];
      if (x > 0) { const v = dist[i - 1] + 1; if (v < d) d = v; }
      if (y > 0) {
        const up = i - w;
        const v = dist[up] + 1; if (v < d) d = v;
        if (x > 0) { const dv = dist[up - 1] + D; if (dv < d) d = dv; }
        if (x < w - 1) { const dv = dist[up + 1] + D; if (dv < d) d = dv; }
      }
      dist[i] = d;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    for (let x = w - 1; x >= 0; x--) {
      const i = row + x;
      if (dist[i] === 0) continue;
      let d = dist[i];
      if (x < w - 1) { const v = dist[i + 1] + 1; if (v < d) d = v; }
      if (y < h - 1) {
        const dn = i + w;
        const v = dist[dn] + 1; if (v < d) d = v;
        if (x < w - 1) { const dv = dist[dn + 1] + D; if (dv < d) d = dv; }
        if (x > 0) { const dv = dist[dn - 1] + D; if (dv < d) d = dv; }
      }
      dist[i] = d;
    }
  }
  return dist;
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
  const bands = grade.bands;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  if (!source) {
    paintPlaceholder(ctx, W, H, grade);
    return canvas;
  }

  // 1. Down to the brush grid, then blur hard. Every decision is made in these cells; a four-pass
  //    [1 2 1] is a nine-cell brush on the long axis, which is enough to lose pores, fabric weave
  //    and the ripple on water while every form the poster needs is still there.
  const gs = Math.min(1, WORK_LONG / Math.max(W, H));
  const gw = Math.max(12, Math.round(W * gs));
  const gh = Math.max(12, Math.round(H * gs));
  const scratch = document.createElement('canvas');
  scratch.width = gw;
  scratch.height = gh;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  drawCropped(source, sctx, gw, gh, options);
  const px = sctx.getImageData(0, 0, gw, gh).data;
  const cells = gw * gh;

  const pr = new Float32Array(cells);
  const pg = new Float32Array(cells);
  const pb = new Float32Array(cells);
  for (let i = 0, p = 0; i < cells; i++, p += 4) {
    pr[i] = px[p];
    pg[i] = px[p + 1];
    pb[i] = px[p + 2];
  }
  blurPlane(pr, gw, gh, 4);
  blurPlane(pg, gw, gh, 4);
  blurPlane(pb, gw, gh, 4);

  // 2. Value, normalised per panel to the same percentile window, then conformed to the shared
  //    mean and spread. This is the step that makes three photographs share one exposure, and
  //    therefore one light.
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
  for (let i = 0; i < cells; i++) lum[i] = clamp((lum[i] - lo) / span, 0, 1);
  for (let pass = 0; pass <= TONE.settle; pass++) {
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < cells; i++) {
      sum += lum[i];
      sumSq += lum[i] * lum[i];
    }
    const mean = sum / cells;
    const std = Math.sqrt(Math.max(1e-6, sumSq / cells - mean * mean));
    const gain = clamp(TONE.std / Math.max(1e-4, std), TONE.stretch[0], TONE.stretch[1]);
    const shift = TONE.mean - mean * gain;
    for (let i = 0; i < cells; i++) lum[i] = clamp(lum[i] * gain + shift, 0, 1);
  }

  // 3. Directional light. This is what separates a designed shadow from an iso-luminance contour:
  //    a photo's shading is whatever the day did, but a poster is lit from one place by the
  //    designer's choice. So a fake surface normal is taken from the gradient of the blurred
  //    value field, and the value is biased by how far that normal turns TOWARD the poster's own
  //    low sun. Forms facing the sun cross up into the next plate; forms turning from it drop
  //    toward the shade — on the same side, in every panel, whatever the original photo's light
  //    was. This is what makes three photographs read as one hour in one place.
  //
  //    Two details decide whether this reads as light or as an emboss, and both were wrong at
  //    first. The gradient is measured across `reach` cells, not one, so it describes the plane a
  //    cell sits on instead of the edge it abuts. And it is normalised by its own RMS before being
  //    used: a photograph's gradients are tiny almost everywhere (the whole face of a subject moves
  //    by a hundredth of the range over ten cells), so a fixed slope produces a bias of
  //    approximately zero and the "light" does nothing at all. Scaling so that a typical gradient
  //    maps to a full unit of facing is what lets a flat cheek resolve into a lit plate and a
  //    shadow plate, which is precisely the modelling the line should not have to draw.
  const lightX = LIGHT.x;
  const lightY = LIGHT.y;
  const nl = Math.sqrt(lightX * lightX + lightY * lightY) || 1;
  const lx = lightX / nl;
  const ly = lightY / nl;
  const reach = Math.max(1, LIGHT.reach | 0);
  const tx = new Float32Array(cells);
  const ty = new Float32Array(cells);
  let energy = 0;
  for (let y = 0; y < gh; y++) {
    const row = y * gw;
    for (let x = 0; x < gw; x++) {
      const i = row + x;
      const xm = x - reach >= 0 ? i - reach : i;
      const xp = x + reach < gw ? i + reach : i;
      const ym = y - reach >= 0 ? i - gw * reach : i;
      const yp = y + reach < gh ? i + gw * reach : i;
      const dx = (lum[xp] - lum[xm]) / reach;
      const dy = (lum[yp] - lum[ym]) / reach;
      tx[i] = dx;
      ty[i] = dy;
      energy += dx * dx + dy * dy;
    }
  }
  // `slope` is in units of "typical gradient": a gradient of twice the panel's own RMS saturates the
  // facing term, and the median gradient produces about half light.
  const amp = LIGHT.slope / Math.sqrt(Math.max(1e-9, energy / cells));
  const facingOf = new Float32Array(cells);
  for (let i = 0; i < cells; i++) {
    // The gradient points toward the brighter side, i.e. toward the light, so a cell whose
    // neighbourhood brightens toward the sun is already the lit side of its form and must be
    // lifted further — hence the positive sign. Negating this, as the first version did, put every
    // highlight on the shadow side.
    const f = clamp((tx[i] * lx + ty[i] * ly) * amp, -1, 1);
    facingOf[i] = f;
    lum[i] = clamp(lum[i] + f * LIGHT.gain, 0, 1);
  }

  // 4. Crush, then vote. A cell's tone is decided once, here; every later stage only reads that
  //    decision, so the fill edge and the ink line are the same curve by construction.
  const bandOf = new Int32Array(cells);
  for (let i = 0; i < cells; i++) {
    const t = clamp((lum[i] - 0.5) * CRUSH + 0.5, 0, 1);
    let b = Math.floor(t * bands);
    if (b >= bands) b = bands - 1;
    bandOf[i] = b;
  }
  despeckle(bandOf, gw, gh, Math.max(24, Math.round(cells * TONE_MIN)), 6, bands + 1);

  // 4. Hue sector: warm, neutral or cool, from the blurred photograph. Coarse on purpose — it picks
  //    between three near-shades of the same ramped tone, never between colours. It is despeckled
  //    far harder than the tone, because a hue island is never a shape.
  const sectorOf = new Int32Array(cells);
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
    sectorOf[i] = hue < 105 || hue >= 330 ? 1 : 2;
  }
  despeckle(sectorOf, gw, gh, Math.max(60, Math.round(cells * SECTOR_MIN)), 5, 4);

  // 5. The two axes are combined and cleaned as one map. This catches the slivers left where a band
  //    change and a hue change disagree about where the edge is, and it is the last chance to
  //    remove anything too small to have been painted on purpose.
  const comboOf = new Int32Array(cells);
  for (let i = 0; i < cells; i++) comboOf[i] = bandOf[i] * 3 + sectorOf[i];
  despeckle(comboOf, gw, gh, Math.max(12, Math.round(cells * COMBINED_MIN)), 4, bands * 4);
  // Condense before reading the labels back: a box majority removes thin ribbons and rounds the
  // corners of what remains, which despeckle cannot do because a ribbon has plenty of area.
  condense(comboOf, gw, gh, bands * 4, CONDENSE_R, CONDENSE_ROUNDS);
  for (let i = 0; i < cells; i++) {
    const c = comboOf[i];
    bandOf[i] = (c / 3) | 0;
    sectorOf[i] = c % 3;
  }

  // 5b. The terminator. The bias in step 3 moves values, and a moved value only shows up as a new
  //     plate where it happens to cross a band edge — so on a form that sits comfortably in the
  //     middle of a band nothing visible happens, and the light reads as a whisper. What a painted
  //     plate actually does is decide, once, that everything on the far side of a line is one plate
  //     darker — a hard terminator running across the form. So the facing term is turned into a
  //     discrete shift with a deadband: clearly-lit cells go up a plate, clearly-shadowed cells go
  //     down one, and the ambiguous middle stays put so the shift lands as a shape rather than as a
  //     gradient. Then the shifted map is despeckled back into solid regions, which is what turns
  //     the ragged fringe of shifted cells into an edge worth drawing.
  const shifted = new Int32Array(cells);
  for (let i = 0; i < cells; i++) {
    let b = bandOf[i];
    if (facingOf[i] > TERMINATOR.hi) b += 1;
    else if (facingOf[i] < TERMINATOR.lo) b -= 1;
    shifted[i] = b < 0 ? 0 : b > bands - 1 ? bands - 1 : b;
  }
  despeckle(shifted, gw, gh, Math.max(30, Math.round(cells * TERMINATOR.min)), 5, bands + 1);
  condense(shifted, gw, gh, bands, CONDENSE_R, 1);
  for (let i = 0; i < cells; i++) bandOf[i] = shifted[i];

  // 6. Vote planes. Each band and each sector gets a one-hot plane, blurred so that a bilinear
  //    sample ramps across a boundary instead of jumping — the ramp is what the argmax below turns
  //    into a smooth curve.
  const bandVotes = votePlanes(bandOf, cells, bands);
  const sectorVotes = votePlanes(sectorOf, cells, 3);
  for (const plane of bandVotes) blurPlane(plane, gw, gh, VOTE_BLUR);
  for (const plane of sectorVotes) blurPlane(plane, gw, gh, VOTE_BLUR);

  // 7. The paint grid. Compose the plate once at this size, then upscale — so the upscale is the
  //    only place a hard edge is ever resampled, and it is a bilinear filter, which is exactly what
  //    an antialiased edge needs.
  const ps = PAINT_LONG / Math.max(W, H);
  const PW = Math.max(16, Math.round(W * ps));
  const PH = Math.max(16, Math.round(H * ps));
  const paintCells = PW * PH;
  const stepX = gw / PW;
  const stepY = gh / PH;

  const toneAt = new Uint8Array(paintCells);
  const sectorAt = new Uint8Array(paintCells);
  for (let y = 0; y < PH; y++) {
    const row = y * PW;
    const fy = (y + 0.5) * stepY - 0.5;
    for (let x = 0; x < PW; x++) {
      const fx = (x + 0.5) * stepX - 0.5;
      let bestB = 0;
      let bestV = -1;
      for (let b = 0; b < bands; b++) {
        const v = bilinear(bandVotes[b], gw, gh, fx, fy);
        if (v > bestV) { bestV = v; bestB = b; }
      }
      let bestS = 0;
      let bestSV = -1;
      for (let s = 0; s < 3; s++) {
        const v = bilinear(sectorVotes[s], gw, gh, fx, fy);
        if (v > bestSV) { bestSV = v; bestS = s; }
      }
      const i = row + x;
      toneAt[i] = bestB;
      sectorAt[i] = bestS;
    }
  }

  // 8. Boundaries, one mask per weight rank. A contour is ranked by the size of the tonal step it
  //    crosses, so the ink can be spent hierarchically: one band is a fold, two a form break, three
  //    a silhouette. Three masks and three distance transforms is the price of a line that thins
  //    where the drawing does not need it.
  const edgeFold = new Uint8Array(paintCells);
  const edgeForm = new Uint8Array(paintCells);
  const edgeSil = new Uint8Array(paintCells);
  const plot = (i, j, step) => {
    edgeFold[i] = 1;
    edgeFold[j] = 1;
    if (step >= 2) {
      edgeForm[i] = 1;
      edgeForm[j] = 1;
    }
    if (step >= 3) {
      edgeSil[i] = 1;
      edgeSil[j] = 1;
    }
  };
  for (let y = 0; y < PH; y++) {
    const row = y * PW;
    for (let x = 0; x < PW; x++) {
      const i = row + x;
      const a = toneAt[i];
      if (x < PW - 1) {
        const b = toneAt[i + 1];
        if (b !== a) plot(i, i + 1, b > a ? b - a : a - b);
      }
      if (y < PH - 1) {
        const b = toneAt[i + PW];
        if (b !== a) plot(i, i + PW, b > a ? b - a : a - b);
      }
    }
  }
  const distFold = chamfer(edgeFold, PW, PH);
  const distForm = chamfer(edgeForm, PW, PH);
  const distSil = chamfer(edgeSil, PW, PH);

  // 9. Fill and ink. Widths are given in display pixels and converted to the paint grid, so a small
  //    panel's line has the same apparent weight as the hero's.
  const inkRGB = rgbOf(grade.ink);
  const palette = paletteOf(grade);
  const toPaint = PW / W;
  const thinPx = Math.max(0.7, LINE_THIN * toPaint);
  const midPx = Math.max(thinPx + 0.5, LINE_MID * toPaint);
  const heavyPx = Math.max(midPx + 0.6, LINE_HEAVY * toPaint);

  const plate = document.createElement('canvas');
  plate.width = PW;
  plate.height = PH;
  const pctx = plate.getContext('2d');
  const out = pctx.createImageData(PW, PH);
  const dst = out.data;
  for (let i = 0; i < paintCells; i++) {
    const at = (toneAt[i] * 3 + sectorAt[i]) * 3;
    let r = palette[at];
    let g = palette[at + 1];
    let bl = palette[at + 2];

    // Ink coverage: each rank contributes a ribbon of constant width, and the greatest coverage
    // wins, so a silhouette's fat line is never thinned by the fold pass that also runs along it.
    // The coverage eases out over one paint cell, which antialiases the line here and again in the
    // upscale.
    let k = 0;
    let d = distFold[i];
    if (d < thinPx) {
      const v = thinPx - d;
      k = v > 1 ? 1 : v;
    }
    d = distForm[i];
    if (d < midPx) {
      const v = midPx - d;
      const kv = v > 1 ? 1 : v;
      if (kv > k) k = kv;
    }
    d = distSil[i];
    if (d < heavyPx) {
      const v = heavyPx - d;
      const kv = v > 1 ? 1 : v;
      if (kv > k) k = kv;
    }

    if (k > 0) {
      r += (inkRGB[0] - r) * k * INK_DEPTH;
      g += (inkRGB[1] - g) * k * INK_DEPTH;
      bl += (inkRGB[2] - bl) * k * INK_DEPTH;
    }
    const p = i << 2;
    dst[p] = r;
    dst[p + 1] = g;
    dst[p + 2] = bl;
    dst[p + 3] = 255;
  }
  pctx.putImageData(out, 0, 0);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(plate, 0, 0, PW, PH, 0, 0, W, H);

  // 10. Conform the finished plate to the grade's own luminance spine. Steps 2 and 3 graded the
  //     value field, but what got painted is four flat tones plus ink, and those tones are not
  //     evenly spaced in luminance — so two panels can share a band distribution and still come out
  //     at different average values. Measuring the plate itself and moving it onto the spine is what
  //     makes the panels of one cover average the same luminance, which is what one light means.
  conformPlate(ctx, W, H, spineOf(grade));
  return canvas;
}

/**
 * Drive a finished plate's mean and spread onto the grade's spine.
 *
 * The gain is applied to all three channels about the plate's own mean, so hue is untouched: a
 * linear scale preserves the ratios between channels and only value moves. Ink must not be lifted,
 * so cells darker than the spine's own darkest fill are excluded from the measurement — otherwise a
 * panel with more line work would be brightened to compensate for it — and left unscaled.
 */
function conformPlate(ctx, W, H, target) {
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const cells = W * H;
  const lum = new Float32Array(cells);
  const floor = Math.max(4, target.mean - target.std * 1.6);
  let sum = 0;
  let weights = 0;
  for (let i = 0, p = 0; i < cells; i++, p += 4) {
    const v = d[p] * 0.2126 + d[p + 1] * 0.7152 + d[p + 2] * 0.0722;
    lum[i] = v;
    if (v > floor) {
      sum += v;
      weights++;
    }
  }
  if (weights < cells * 0.15) return;
  const mean = sum / weights;
  let sumSq = 0;
  for (let i = 0; i < cells; i++) {
    if (lum[i] > floor) sumSq += (lum[i] - mean) * (lum[i] - mean);
  }
  const std = Math.sqrt(sumSq / weights);
  const gain = clamp(target.std / Math.max(1e-3, std), TONE.stretch[0], TONE.stretch[1]);
  const shift = target.mean - mean * gain;
  for (let i = 0, p = 0; i < cells; i++, p += 4) {
    if (lum[i] <= floor) continue;
    d[p] = clamp(d[p] * gain + shift, 0, 255);
    d[p + 1] = clamp(d[p + 1] * gain + shift, 0, 255);
    d[p + 2] = clamp(d[p + 2] * gain + shift, 0, 255);
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * A painted panel for a slot with no photograph: the same four tones, a low sun and a bank of dunes
 * with ink on them, so the poster still looks composed before the first upload.
 */
function paintPlaceholder(ctx, W, H, grade) {
  const u = Math.min(W, H);
  const sunY = H * 0.68;
  const sunR = u * 0.27;

  ctx.fillStyle = grade.cel[1];
  ctx.fillRect(0, 0, W, H);

  // Sky: one flat band, a hard horizon, a half-disc of sun.
  ctx.fillStyle = grade.cel[2];
  ctx.fillRect(0, 0, W, H * 0.44);
  ctx.fillStyle = grade.cel[3];
  ctx.beginPath();
  ctx.arc(W * 0.5, sunY, sunR, Math.PI, 0);
  ctx.closePath();
  ctx.fill();

  // Ground: one dune, cut flat.
  const dune = () => {
    ctx.beginPath();
    ctx.moveTo(0, H);
    ctx.lineTo(0, H * 0.8);
    ctx.quadraticCurveTo(W * 0.34, H * 0.58, W * 0.68, H * 0.82);
    ctx.quadraticCurveTo(W * 0.86, H * 0.93, W, H * 0.85);
    ctx.lineTo(W, H);
    ctx.closePath();
  };
  ctx.fillStyle = grade.cel[0];
  dune();
  ctx.fill();

  // Ink on every boundary, heavier on the dune.
  ctx.strokeStyle = grade.ink;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, u * 0.007);
  ctx.beginPath();
  ctx.moveTo(0, H * 0.44);
  ctx.lineTo(W, H * 0.44);
  ctx.stroke();
  ctx.lineWidth = Math.max(2.5, u * 0.013);
  ctx.beginPath();
  ctx.arc(W * 0.5, sunY, sunR, Math.PI, 0);
  ctx.stroke();
  dune();
  ctx.stroke();

  // The sun's disc, in the grade's brightest fill, so the plate has a light source.
  ctx.fillStyle = grade.light;
  ctx.beginPath();
  ctx.arc(W * 0.5, sunY - u * 0.04, u * 0.115, 0, Math.PI * 2);
  ctx.fill();
}
