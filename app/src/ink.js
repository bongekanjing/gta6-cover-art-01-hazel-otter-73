// ink.js — the illustration pass.
//
// One entry point, processPhoto(source, options), turns a photograph into poster art on an
// offscreen canvas. It runs in two clearly separated stages:
//
//   1. the PLATE pass — per photo: smooth, flatten the value into a few luminance flats,
//      trace the band boundaries with a Sobel contour and lay ink on them. This stage only
//      knows its own picture.
//   2. the WORLD pass — per cover: map every panel's flats through one shared five-stop
//      colour ramp, light it from one shared sun position computed in COVER coordinates, and
//      vignette it against the cover's centre rather than its own.
//
// Stage 2 is what makes a collage read as one place. Because the ramp and the sun point are
// the same for every panel, a teal midday shot and an amber golden-hour shot land in the same
// light: the grade, not the photograph, decides the palette. A panel near the sun's corner is
// lit; the panel across the cover falls into the same shade the backdrop does.
//
// Everything here is plain canvas 2D and typed arrays: a 900 px panel grades in a few tens of
// milliseconds, so the pass can re-run on every edit. No library, no network, no randomness.

/**
 * The three grade presets the editor offers. `ramp` is the shared five-stop colour ramp every
 * panel is mapped onto (shadow → highlight); `sun` is the cover-space point the light comes
 * from; `mix` is how hard a panel's own hue is pulled onto that ramp (1 would be a pure
 * duotone, 0 would leave the photographs as unrelated as they arrived).
 */
export const GRADES = {
  dusk: {
    label: 'Dusk',
    note: 'plum shadows, amber sun',
    bands: 5,
    ink: 1.0,
    halftone: 0.22,
    saturation: 1.24,
    contrast: 1.14,
    mix: 0.64,
    sun: { x: 0.14, y: 0.92, spread: 0.78, lift: 0.3 },
    ramp: ['#140a20', '#3a1146', '#8d2360', '#e2603a', '#ffd48c'],
    skyGlow: '#ffb257',
    bandTint: ['#251138', '#521a55', '#a63553', '#ea7a3c', '#ffd48c'],
  },
  neon: {
    label: 'Neon',
    note: 'cyan rim, magenta haze',
    bands: 5,
    ink: 1.05,
    halftone: 0.26,
    saturation: 1.3,
    contrast: 1.18,
    mix: 0.68,
    sun: { x: 0.86, y: 0.18, spread: 0.8, lift: 0.26 },
    ramp: ['#06041a', '#221056', '#5c1584', '#e0338a', '#ffc8de'],
    skyGlow: '#ff5fa8',
    bandTint: ['#120a33', '#351565', '#7a1a92', '#ea4a93', '#ffc8de'],
  },
  heat: {
    label: 'Heat',
    note: 'burnt orange, hard black',
    bands: 4,
    ink: 1.15,
    halftone: 0.16,
    saturation: 1.18,
    contrast: 1.24,
    mix: 0.62,
    sun: { x: 0.5, y: 0.96, spread: 0.74, lift: 0.34 },
    ramp: ['#100203', '#430810', '#a32212', '#ee8420', '#ffe2a6'],
    skyGlow: '#ff9a2e',
    bandTint: ['#1c0507', '#5c0f12', '#be3514', '#f49026', '#ffe2a6'],
  },
};

export const GRADE_ORDER = ['dusk', 'neon', 'heat'];

/**
 * The luminance window every panel of a cover is banded into: fixed, never measured per
 * photograph. A shared window is the other half of the unification — a bright shot and a dim
 * one break into flats at the same absolute levels, so their bands correspond.
 */
const LEVELS = { low: 26, high: 236 };

/** A 4x4 ordered dither matrix, 0..15, for the halftone screen. */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const clamp = (value, low, high) => (value < low ? low : value > high ? high : value);

/** Parse '#rrggbb' once into three bytes. */
function rgbOf(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** A 256-entry lookup of a grade's ramp, interpolated linearly between its five stops. */
const rampCache = new Map();
function rampLut(grade) {
  let lut = rampCache.get(grade);
  if (lut) return lut;
  const stops = grade.ramp.map(rgbOf);
  lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const a = Math.min(stops.length - 2, Math.floor(t));
    const f = t - a;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = stops[a][c] + (stops[a + 1][c] - stops[a][c]) * f;
  }
  rampCache.set(grade, lut);
  return lut;
}

/**
 * Draw `source` into a W x H box with cover-fit, a zoom factor and a focal point.
 * `fx`/`fy` name the point of the source to keep in the middle of the box (0..1); the draw is
 * clamped to the image, so a panel can never show empty space whatever the slider says.
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
 * How much one panel-fraction of drag moves the focal point, per axis, for a given panel box.
 * A drag across the whole panel then travels exactly the hidden overflow.
 */
export function panFactor(source, W, H, zoom) {
  const scale = Math.max(W / source.width, H / source.height) * (zoom > 1 ? zoom : 1);
  return {
    x: (source.width * scale) / W,
    y: (source.height * scale) / H,
  };
}

/**
 * The illustration pass. `options` is
 *   { width, height, grade, zoom, fx, fy, world }
 * where `world` is the cover this panel belongs to:
 *   { coverW, coverH, x, y }  the cover size and the panel's top-left, in cover pixels.
 * When `world` is omitted the panel is treated as a cover of its own (the single-panel case,
 * and the placeholder).
 *
 * Returns a new canvas holding the graded art, or a placeholder when there is no source yet.
 * The grade runs at 2x and is then reduced, so the contour lines and the halftone screen are
 * resolved with antialiasing instead of landing on a ragged one-pixel grid.
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
  const ss = W * H <= 1100000 ? 2 : W * H <= 2400000 ? 1.5 : 1;
  const gw = Math.round(W * ss);
  const gh = Math.round(H * ss);
  const scratch = document.createElement('canvas');
  scratch.width = gw;
  scratch.height = gh;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  drawCropped(source, sctx, gw, gh, options);
  const frame = sctx.getImageData(0, 0, gw, gh);
  gradeInto(frame, gw, gh, grade, world, ss);
  sctx.putImageData(frame, 0, 0);
  if (ss === 1) {
    ctx.drawImage(scratch, 0, 0);
    return canvas;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(scratch, 0, 0, gw, gh, 0, 0, W, H);
  return canvas;
}

/** A gradient panel with a painted edge, so an empty panel still looks composed. */
function paintPlaceholder(ctx, W, H, grade, world) {
  const g = ctx.createLinearGradient(0, 0, W * 0.4, H);
  g.addColorStop(0, grade.bandTint[1]);
  g.addColorStop(0.55, grade.bandTint[2]);
  g.addColorStop(1, grade.bandTint[0]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = grade.bandTint[4];
  const step = Math.max(14, Math.round(Math.min(W, H) * 0.06));
  ctx.lineWidth = 2;
  for (let x = -H; x < W + H; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, H);
    ctx.lineTo(x + H, 0);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The grade proper, in place over one ImageData.
 *
 * `world` and `scale` are what turn this into a cover-level pass rather than a panel one:
 * `scale` is the pixel supersampling factor, so cover coordinates can be reconstructed
 * exactly, and every light and shade term below is read from there.
 */
export function gradeInto(frame, W, H, grade, world, scale = 1) {
  const data = frame.data;
  const n = W * H;
  const bands = grade.bands;

  // 0. A light five-tap box blur first. Photographic grain, sensor noise and JPEG artifacts
  //    are what make a banded photo look like dirt; this settles them without softening a
  //    contour.
  const src = new Uint8ClampedArray(data);
  for (let y = 0; y < H; y++) {
    const rowUp = y > 0 ? (y - 1) * W : 0;
    const row = y * W;
    const rowDn = y < H - 1 ? (y + 1) * W : row;
    for (let x = 0; x < W; x++) {
      const p = (row + x) << 2;
      const left = x > 0 ? p - 4 : p;
      const right = x < W - 1 ? p + 4 : p;
      const u = (rowUp + x) << 2;
      const d = (rowDn + x) << 2;
      data[p] = (src[p] * 4 + src[left] + src[right] + src[u] + src[d]) * 0.125;
      data[p + 1] = (src[p + 1] * 4 + src[left + 1] + src[right + 1] + src[u + 1] + src[d + 1]) * 0.125;
      data[p + 2] = (src[p + 2] * 4 + src[left + 2] + src[right + 2] + src[u + 2] + src[d + 2]) * 0.125;
    }
  }

  const lum = new Uint8Array(n);

  // 1. Luminance, then two passes of a nine-tap blur over it alone. This is the step that
  //    turns a photo into shapes: without it a banded sky or a stretch of water breaks into
  //    confetti, because every grain of the photograph straddles a band edge.
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    lum[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  const buffer = new Uint8Array(n);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < H; y++) {
      const up = y > 0 ? (y - 1) * W : 0;
      const row = y * W;
      const dn = y < H - 1 ? (y + 1) * W : row;
      for (let x = 0; x < W; x++) {
        const xl = x > 0 ? x - 1 : 0;
        const xr = x < W - 1 ? x + 1 : W - 1;
        buffer[row + x] =
          (lum[row + x] * 4 +
            lum[row + xl] +
            lum[row + xr] +
            lum[up + xl] +
            lum[up + x] +
            lum[up + xr] +
            lum[dn + xl] +
            lum[dn + x] +
            lum[dn + xr]) *
          0.08333333;
      }
    }
    lum.set(buffer);
  }

  // 2. Band into the cover's shared window. No per-photo histogram: two panels graded from
  //    different exposures must break at the same absolute levels or they cannot share a ramp.
  const { low, high } = LEVELS;
  const span = (high - low) / bands;
  const bandOf = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let b = Math.floor((lum[i] - low) / span);
    if (b < 0) b = 0;
    else if (b >= bands) b = bands - 1;
    bandOf[i] = b;
  }

  // The flat colour of each band, taken from the shared ramp at the band's centre.
  const lut = rampLut(grade);
  const bandRGB = new Float32Array(bands * 3);
  for (let b = 0; b < bands; b++) {
    const at = Math.round(((b + 0.5) / bands) * 255) * 3;
    bandRGB[b * 3] = lut[at];
    bandRGB[b * 3 + 1] = lut[at + 1];
    bandRGB[b * 3 + 2] = lut[at + 2];
  }

  // 3. The world terms, all in cover space. `sx`/`sy` is where the sun sits over the whole
  //    cover; the radial reach is normalised by the cover's long side so a portrait and a
  //    landscape cover light the same way.
  const sun = grade.sun;
  const coverW = Math.max(1, world.coverW);
  const coverH = Math.max(1, world.coverH);
  const originX = world.x ?? 0;
  const originY = world.y ?? 0;
  const longSide = Math.max(coverW, coverH);
  const sat = grade.saturation;
  const con = grade.contrast;
  const mix = grade.mix;
  const half = grade.halftone;
  const lift = sun.lift;

  let i = 0;
  for (let y = 0; y < H; y++) {
    // Cover-space coordinates of this pixel, 0..1 across the whole cover.
    const cy = (originY + (y + 0.5) / scale) / coverH;
    const dxSunY = (cy - sun.y) * (coverH / longSide);
    for (let x = 0; x < W; x++, i++) {
      const p = i << 2;
      const b = bandOf[i];
      const target = low + span * (b + 0.5);

      // Hue from the source, value from the flat: the photograph contributes its colours and
      // the grade contributes its light.
      const l = lum[i] < 8 ? 8 : lum[i];
      const k = (target / l) * sat * 0.9;
      let r = target + (data[p] - lum[i]) * k;
      let g = target + (data[p + 1] - lum[i]) * k;
      let bl = target + (data[p + 2] - lum[i]) * k;

      // Print contrast about mid grey.
      r = (r - 128) * con + 128;
      g = (g - 128) * con + 128;
      bl = (bl - 128) * con + 128;

      // Onto the shared ramp. This is the palette, and it is the same palette in every panel.
      const t = clamp((target - low) / (high - low), 0, 1);
      const rt = clamp(t, 0, 1) * 255;
      const at = (rt | 0) * 3;
      r = r * (1 - mix) + (lut[at] + (lut[at + 3] - lut[at]) * (rt % 1)) * mix;
      g = g * (1 - mix) + (lut[at + 1] + (lut[at + 4] - lut[at + 1]) * (rt % 1)) * mix;
      bl = bl * (1 - mix) + (lut[at + 2] + (lut[at + 5] - lut[at + 2]) * (rt % 1)) * mix;

      // One sun for the whole cover: distance from the sun point, in cover space, so a
      // highlight in the hero panel and one in a corner panel are lit from the same side.
      const cx = (originX + (x + 0.5) / scale) / coverW;
      const ddx = (cx - sun.x) * (coverW / longSide);
      const dist = Math.sqrt(ddx * ddx + dxSunY * dxSunY) / sun.spread;
      const reach = Math.exp(-dist * dist * 1.9);
      // Only the flats already reading as lit take the warm lift; shadow stays shadow.
      const litW = reach * (0.35 + 0.65 * t * t);
      r += litW * 118 * lift;
      g += litW * 74 * lift;
      bl += litW * 24 * lift;
      // And the far side of the cover cools off, again by cover coordinates.
      const shade = (1 - reach) * 0.22;
      r -= shade * 26;
      g -= shade * 22;
      bl += shade * 6;

      // Mid bands get the dot screen: a print texture, never noise.
      if (half > 0 && b > 0 && b < bands - 1) {
        const screen = BAYER4[((y & 3) << 2) | (x & 3)] / 15;
        const strength = 1 - half * (0.09 + 0.3 * screen);
        r *= strength;
        g *= strength;
        bl *= strength;
      }

      // Vignette against the cover, not the panel: a panel in the middle of the poster must
      // not darken at its own edges, or the collage reads as tiles.
      const nx = (cx - 0.5) * 1.3;
      const ny = (cy - 0.5) * 1.3;
      const vig = 1 - 0.4 * Math.min(1, (nx * nx + ny * ny) * 1.1);
      r = r * vig + 6;
      g = g * vig + 3;
      bl = bl * vig + 9;

      data[p] = r < 0 ? 0 : r > 255 ? 255 : r;
      data[p + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      data[p + 2] = bl < 0 ? 0 : bl > 255 ? 255 : bl;
      data[p + 3] = 255;
    }
  }

  // 4. Sobel over the banded luminance. Because only band boundaries survive the flattening,
  //    the gradient is exactly the drawn contour: crisp, closed, and blind to photo noise.
  const banded = new Uint8Array(n);
  const scaleBand = 255 / (bands - 1);
  for (let q = 0; q < n; q++) banded[q] = (bandOf[q] * scaleBand) | 0;
  const edge = new Uint8Array(n);
  const inkSpan = 255 / (bands - 1);
  const baseThr = (inkSpan * 1.35) / (grade.ink || 1);
  for (let y = 1; y < H - 1; y++) {
    let c = y * W + 1;
    for (let x = 1; x < W - 1; x++, c++) {
      const tl = banded[c - W - 1];
      const tc = banded[c - W];
      const tr = banded[c - W + 1];
      const ml = banded[c - 1];
      const mr = banded[c + 1];
      const bl2 = banded[c + W - 1];
      const bc = banded[c + W];
      const br = banded[c + W + 1];
      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl2);
      const gy = bl2 + 2 * bc + br - (tl + 2 * tc + tr);
      const mag = (gx < 0 ? -gx : gx) + (gy < 0 ? -gy : gy);
      const t = banded[c] * 0.00392157;
      // The threshold rises in shadow, so a dark region keeps its detail instead of
      // collapsing into one black shape.
      const thr = baseThr * (0.8 + 1.15 * (1 - t) * (1 - t));
      if (mag > thr) edge[c] = 1;
    }
  }

  // 5. Ink, drawn once and thickened once with a one-pixel offset. The mask is dilated into a
  //    second pass rather than stamped twice in place, so the line reads as a drawn contour of
  //    even weight instead of a doubled, ragged one.
  const thick = new Uint8Array(n);
  for (let y = 1; y < H - 1; y++) {
    let q = y * W + 1;
    for (let x = 1; x < W - 1; x++, q++) {
      if (edge[q] === 1) {
        thick[q] = 1;
        thick[q + W + 1] = 1;
        thick[q + W] = 1;
        thick[q + 1] = 1;
      }
    }
  }
  for (let q = 0; q < n; q++) {
    if (thick[q] === 0) continue;
    const p = q << 2;
    const k = edge[q] === 1 ? 1 : 0.72;
    data[p] = data[p] * (1 - 0.86 * k) + 14 * k;
    data[p + 1] = data[p + 1] * (1 - 0.9 * k) + 5 * k;
    data[p + 2] = data[p + 2] * (1 - 0.82 * k) + 20 * k;
  }
}
