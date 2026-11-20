// letter.js — the lettering and the poster chrome.
//
// The title is drawn as four layers in a fixed order (dark outline, offset mid-tone drop, warm
// fill, thin top highlight) and auto-fitted to its lockup by binary search, so a captions of any
// length fills the band without ever running over it. Everything else here — the rating box, the
// price tag, the studio rule, the ticker — is vector-drawn with our own invented words.
//
// No font file ships with the app: the display face is a stack of condensed system sans faces
// with a generic fallback, and the character comes from the strokes, the offsets and the
// condensation, not from a borrowed typeface.

const DISPLAY = "700 {S}px 'Arial Narrow', 'Liberation Sans Narrow', 'DejaVu Sans Condensed', 'Helvetica Neue', Impact, 'Haettenschweiler', sans-serif";
const UTILITY = "600 {S}px 'DejaVu Sans', 'Liberation Sans', 'Helvetica Neue', Arial, sans-serif";
const MONO = "700 {S}px 'DejaVu Sans Mono', 'Liberation Mono', Consolas, monospace";

const font = (stack, size) => stack.replace('{S}', String(size));

/** How much the title is narrowed horizontally on top of an already condensed face. */
const CONDENSE = 0.9;

/**
 * The words of a caption, in caps, with runs of spaces collapsed.
 */
export function titleWords(caption) {
  return String(caption ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9'&.\-!? ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Split a caption into at most two lines, balanced by character count. */
export function titleLines(words) {
  if (words.length === 0) return ['VICE LEDGER'];
  if (words.length === 1) return [words[0]];
  if (words.length === 2) return [words[0], words[1]];
  let best = 1;
  let bestDelta = Infinity;
  for (let cut = 1; cut < words.length; cut++) {
    const a = words.slice(0, cut).join(' ').length;
    const b = words.slice(cut).join(' ').length;
    const delta = Math.abs(a - b) + (a > b * 1.9 ? 6 : 0);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = cut;
    }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

/** The trailing number of a caption as a roman numeral, or "VI". */
export function numeralOf(caption) {
  const m = /(\d{1,4})\s*$/.exec(String(caption ?? '').trim());
  const n = m ? Number(m[1]) : 0;
  if (!n || n > 3999) return 'VI';
  const table = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let rest = n;
  let out = '';
  for (const [v, s] of table) {
    while (rest >= v) {
      out += s;
      rest -= v;
    }
  }
  return out;
}

/**
 * The ink box of one glyph, relative to its pen position: `left` is how far the drawn ink
 * starts left of the pen (negative when the glyph overhangs), `right` how far it reaches past
 * it. Measuring ink rather than advances is the whole trick below: two letters are as far
 * apart as the eye sees them, not as far as the font's sidebearings say.
 */
function inkOf(ctx, ch) {
  const m = ctx.measureText(ch);
  const left = typeof m.actualBoundingBoxLeft === 'number' ? -m.actualBoundingBoxLeft : 0;
  const right = typeof m.actualBoundingBoxRight === 'number' ? m.actualBoundingBoxRight : m.width;
  return { left, right };
}

/**
 * Set one line on its ink: every pair of neighbouring letters gets the SAME white gap (GAP em
 * between their drawn edges) and word spaces get WORD em. Because the gap is enforced between
 * ink edges — with the outline stroke's half-width added to each glyph's box — no two glyphs
 * can touch at any size, and the rhythm stays even from a 20 px thumbnail to a 400 px title.
 * Advance-based tracking fails exactly here: a narrow I ends up as far from its neighbour as a
 * round O, so the line reads as lumps, and a fat outline closes the thin gaps to nothing.
 *
 * Positions are in pre-condense units; the caller scales x by CONDENSE, so the gap is divided
 * by CONDENSE here to come out as exactly GAP em on the page. `padEm` is the outline's half
 * width in em, added to both sides of every glyph's ink box so the gap is measured as white.
 */
function layoutLine(ctx, text, size, gapEm, wordEm, padEm) {
  ctx.font = font(DISPLAY, size);
  const gap = (gapEm * size) / CONDENSE;
  const wordGap = (wordEm * size) / CONDENSE;
  const pad = (padEm * size) / CONDENSE;
  const glyphs = [];
  let target = 0;
  for (const ch of text) {
    if (ch === ' ') {
      target += wordGap;
      continue;
    }
    const ink = inkOf(ctx, ch);
    const pen = target + pad - ink.left;
    glyphs.push({ ch, pen, ink });
    target = pen + ink.right + pad + gap;
  }
  const last = glyphs[glyphs.length - 1];
  return { glyphs, width: last ? last.pen + last.ink.right + pad : 0, size };
}

/** The widest line of a set, laid out at `size`, in page units. */
function widestOf(ctx, lines, size, gapEm, wordEm, padEm) {
  let widest = 0;
  for (const line of lines) {
    widest = Math.max(widest, layoutLine(ctx, line, size, gapEm, wordEm, padEm).width * CONDENSE);
  }
  return widest;
}

/**
 * The title's tracking, in em: the white gap between two letters, between two words, and the
 * outline stroke's half-width (which the gap is measured outside of).
 *
 * The gap has to hold *outside* the fill's stroke, not outside the bare glyph: the fill pass
 * strokes every letter with lineWidth = size*OUTLINE, which pushes its ink size*OUTLINE/2 out
 * on each side. TRACK.pad is that reach (plus a little AA headroom) so neighbouring ink boxes
 * are laid sidebearing-free, and TRACK.gap is then real white page. At a 250 px title that is
 * ~24 px of white between letters: readable at 1280 wide, still tight enough to read as one
 * wordmark. The word space stays about four letter gaps wide.
 */
const TRACK = { gap: 0.10, word: 0.40, pad: 0.045 };

/** The outline stroke as a fraction of the title size, matched by TRACK.pad on each side. */
const OUTLINE = 0.082;

/** The numeral's proportion of the title size, and the gap that separates it from the title. */
const NUM_RATIO = 0.78;
const NUM_GAP = 0.42;

/**
 * The hard offset shadow, in em. It is a full silhouette of every glyph, so the room it takes
 * to the right of the last letter has to be reserved in the fit: otherwise the shadow of the
 * last glyph lands on the numeral and closes a gap the layout thinks it has.
 */
const SHADOW = { x: 0.046, y: 0.052 };

/**
 * The numeral's outline, sized so the numeral's ink grows *exactly* as much as the title's:
 * the fill pass adds OUTLINE/2 to the title's letters, so a numeral drawn at NUM_RATIO of the
 * size needs OUTLINE/NUM_RATIO to land on the same footing. That is also what makes the
 * right-margin arithmetic exact — the visible ink edge is the measured box, not a guess.
 */
const NUM_OUTLINE = OUTLINE / NUM_RATIO;

/**
 * Choose how to set the title: a single full-width line when the canvas is wide enough for that
 * to come out bigger than a stack, a two-line stack otherwise. Either way the numeral shares the
 * last baseline, so it is part of the lockup rather than a footnote, and both are measured with
 * the numeral's width and its gap already subtracted.
 */
function fitLockup(ctx, lines, maxW, maxH, numeral) {
  const numRatio = NUM_RATIO;
  const numGap = NUM_GAP;
  // The numeral's own outline pads it: measure its ink plus the stroke, so it cannot spill
  // past the right margin or close the gap to the title.
  const numWide = (size) => {
    const ns = size * numRatio;
    ctx.font = font(DISPLAY, ns);
    const m = ctx.measureText(numeral);
    const ink = typeof m.actualBoundingBoxRight === 'number' ? m.actualBoundingBoxRight : m.width;
    return ink + (ns * NUM_OUTLINE) / 2;
  };
  const solve = (set) => {
    const leading = set.length > 1 ? 0.88 : 1;
    // The hard ink shadow is stamped at +SHADOW.x em right, so the wordmark's visible right
    // edge is that much past its measured ink. Budgeting for it here is what keeps the last
    // letter off the numeral instead of under it.
    const budget = (size) => maxW - numGap * size - numWide(size) - SHADOW.x * size;
    // Fit against the room left after the numeral, by bisecting on the width budget instead
    // of shrinking after the fact: one solve, no multiplicative drift.
    let lo = 6;
    let hi = Math.max(10, maxH * 1.5);
    for (let step = 0; step < 24; step++) {
      const mid = (lo + hi) / 2;
      const blockH = mid * leading * (set.length - 1) + mid * 0.74;
      if (widestOf(ctx, set, mid, TRACK.gap, TRACK.word, TRACK.pad) <= budget(mid) && blockH <= maxH) lo = mid;
      else hi = mid;
    }
    const size = lo;
    return {
      set,
      size,
      leading,
      numRatio,
      numW: numWide(size),
      numGap: numGap * size,
      laid: set.map((line) => layoutLine(ctx, line, size, TRACK.gap, TRACK.word, TRACK.pad)),
      blockH: size * leading * (set.length - 1) + size * 0.74,
    };
  };
  const stacked = solve(lines);
  if (lines.length === 1) return stacked;
  const single = solve([lines.join(' ')]);
  // The bolder setting wins: whichever puts more height into the letters.
  return single.size > stacked.size * 1.02 ? single : stacked;
}

/**
 * The title lockup inside `rect`: a chrome row (rating box, price tag), the title with its
 * numeral on the last baseline, the strapline, the studio rule, the ticker.
 * All measurements come from the rect, so it scales with the export and never overflows.
 */
export function drawLockup(ctx, rect, grade, options) {
  const caption = options.caption ?? 'Vice Ledger';
  const strapline = String(options.strapline ?? '').toUpperCase();
  const words = titleWords(caption);
  const numeral = numeralOf(caption);
  const unit = Math.min(rect.w, rect.h * 1.55);

  ctx.save();
  ctx.textBaseline = 'alphabetic';

  // --- rows: the chrome sits on top, the ticker at the foot.
  const chromeH = Math.min(rect.h * 0.145, unit * 0.088);
  const footH = chromeH * 0.8;
  const topRow = { x: rect.x, y: rect.y, w: rect.w, h: chromeH };
  const footRow = { x: rect.x, y: rect.y + rect.h - footH, w: rect.w, h: footH };

  drawRatingBox(ctx, { x: topRow.x, y: topRow.y, w: chromeH * 2.35, h: chromeH * 0.94 }, unit);
  drawPriceTag(ctx, { x: rect.x + rect.w - chromeH * 1.58, y: topRow.y, w: chromeH * 1.58, h: chromeH * 0.94 }, unit);

  // The strapline's room, measured before the title is fitted.
  const strapSize = Math.max(7, Math.round(unit * (strapline.length > 30 ? 0.023 : 0.0275)));
  const strapRoom = strapline ? strapSize * 2.6 : 0;
  const ruleRoom = unit * 0.04;
  const titleTop = topRow.y + chromeH * 1.22;
  const titleBottom = footRow.y - strapRoom - ruleRoom;
  const maxH = Math.max(unit * 0.1, titleBottom - titleTop);

  const plan = fitLockup(ctx, titleLines(words), rect.w, maxH, numeral);
  const lines = plan.set;
  const size = plan.size;
  const leading = plan.leading;
  const numSize = size * plan.numRatio;

  // Centre the title and the strapline as one group inside the band.
  const groupH = plan.blockH + (strapline ? strapSize * 2.25 : 0);
  const groupTop = titleTop + Math.max(0, (maxH - groupH) * 0.5);
  const firstBase = groupTop + size * 0.76;
  const lastBase = firstBase + (lines.length - 1) * leading * size;

  // A hard two-tone fill, not a smooth gradient: cream across the upper two thirds of the
  // letterform, amber on the bottom third, with a hard edge between them. Flat paint reads as
  // lettering; a smooth ramp reads as a gradient applied to a system font.
  const fillGrad = ctx.createLinearGradient(0, firstBase - size * 0.74, 0, lastBase + size * 0.04);
  fillGrad.addColorStop(0, '#fffdf2');
  fillGrad.addColorStop(0.585, '#fff6dc');
  fillGrad.addColorStop(0.6, '#ffd88f');
  fillGrad.addColorStop(1, '#f4a94e');

  const outlineW = size * OUTLINE;

  // Each pass draws the same laid-out glyphs: the ink-kerned positions are computed once, so
  // the outline, the drop, the fill and the highlight cannot drift apart.
  const paintLine = (laid, paint) => laid.glyphs.forEach(({ ch, pen }, gi) => paint(ch, pen, gi));

  /**
   * A hand-set wobble, one value per glyph: a two-degree swing and a hair of rise, cycling over
   * eight letters. It is small enough to leave the measured gaps alone (under a pixel at any
   * title size) and large enough that the wordmark stops sitting on one machined baseline --
   * the difference between cut lettering and a row of system-font glyphs.
   */
  const wobble = (gi) => {
    const phase = [0, 1, 0, -1, 1, 0, -1, 0][gi % 8];
    return { turn: phase * 0.013, lift: ((gi % 3) - 1) * 0.012 * size };
  };

  /**
   * One glyph, at its ink-kerned pen position, turned by its own wobble and condensed. Every
   * layer calls this, so the ink shadow, the outline, the drop, the fill and the highlight are
   * the same letterform painted five times, and can never drift apart.
   *
   * The pen is multiplied by CONDENSE *before* the scale, so the glyphs stay on the positions
   * layoutLine computed: condensing after the translate would widen every gap by 1/CONDENSE and
   * destroy the even tracking the fit depends on.
   */
  const orbit = (ch, pen, gi, paint) => {
    const w = wobble(gi);
    ctx.save();
    ctx.translate(pen * CONDENSE, w.lift);
    ctx.rotate(w.turn);
    ctx.scale(CONDENSE, 1);
    paint(ch);
    ctx.restore();
  };

  for (let li = 0; li < lines.length; li++) {
    const laid = plan.laid[li];
    const y = firstBase + li * leading * size;
    const x0 = rect.x;
    ctx.font = font(DISPLAY, size);

    // 1. The hard ink shadow, offset down-right and fully opaque. This is the layer that makes
    //    the lettering read as ink on a card instead of type hanging in the air: no blur, one
    //    offset, one colour.
    ctx.save();
    ctx.translate(x0 + size * 0.046, y + size * 0.052);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#07030c';
    ctx.fillStyle = '#07030c';
    ctx.lineWidth = outlineW / CONDENSE;
    paintLine(laid, (ch, x, gi) => {
      orbit(ch, x, gi, (c) => {
        ctx.strokeText(c, 0, 0);
        ctx.fillText(c, 0, 0);
      });
    });
    ctx.restore();

    // 2. The wide dark outline at the fill's own position, round-joined, so the letterforms
    //    hold as one mass at any size.
    ctx.save();
    ctx.translate(x0, y);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = grade.ink;
    ctx.lineWidth = outlineW / CONDENSE;
    paintLine(laid, (ch, x, gi) => {
      orbit(ch, x, gi, (c) => ctx.strokeText(c, 0, 0));
    });
    ctx.restore();

    // 3. The mid-tone drop, a shorter offset in the grade's hue: the lit edge of the bevel.
    ctx.save();
    ctx.translate(x0 + size * 0.018, y + size * 0.03);
    ctx.fillStyle = grade.drop;
    paintLine(laid, (ch, x, gi) => {
      orbit(ch, x, gi, (c) => ctx.fillText(c, 0, 0));
    });
    ctx.restore();

    // 4. The fill, stroked as well as filled so it meets the outline with no seam.
    ctx.save();
    ctx.translate(x0, y);
    ctx.fillStyle = fillGrad;
    ctx.strokeStyle = fillGrad;
    ctx.lineJoin = 'round';
    ctx.lineWidth = outlineW / CONDENSE;
    paintLine(laid, (ch, x, gi) => {
      orbit(ch, x, gi, (c) => {
        ctx.strokeText(c, 0, 0);
        ctx.fillText(c, 0, 0);
      });
    });
    ctx.restore();

    // 5. The highlight: a thin lit slice off the top of each letter, clipped to the cap band.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0 - size * 0.1, y - size * 0.92, rect.w, size * 0.2);
    ctx.clip();
    ctx.translate(x0, y);
    ctx.globalAlpha = 0.72;
    ctx.fillStyle = '#fffefb';
    paintLine(laid, (ch, x, gi) => {
      orbit(ch, x, gi, (c) => ctx.fillText(c, 0, 0));
    });
    ctx.restore();
  }

  // The numeral: one flat accent colour, no gradient, hung off the cover's right margin on the
  // last baseline with its own measured gap. A deliberate accent, not a second fill treatment.
  ctx.font = font(DISPLAY, numSize);
  const numInk = ctx.measureText(numeral);
  const numInkLeft = typeof numInk.actualBoundingBoxLeft === 'number' ? numInk.actualBoundingBoxLeft : 0;
  const numInkRight = typeof numInk.actualBoundingBoxRight === 'number' ? numInk.actualBoundingBoxRight : numInk.width;
  const numStroke = Math.max(2, numSize * NUM_OUTLINE);
  // Place on the visible ink, stroke included: the right edge of the numeral's gold fill is the
  // cover's margin — its dark outline overshoots by half a stroke and stays inside the panel
  // edge — so the lockup and the price tag above it share one vertical.
  const numRight = rect.x + rect.w;
  const numX = numRight - numInkRight;
  const numVisLeft = numX - numInkLeft - numStroke / 2;
  // The numeral sits on the title's bottom edge: the fill's baseline plus the mid-tone drop's
  // offset, because the drop is what the eye reads as the foot of the letterform. Both layers
  // add the same half-stroke to their ink, so the two visible bottoms come out flush.
  const numBase = lastBase + size * 0.038;
  if (numSize > 6) {
    ctx.save();
    ctx.translate(numX, numBase);
    ctx.font = font(DISPLAY, numSize);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0b0413';
    ctx.lineWidth = numStroke;
    ctx.strokeText(numeral, 0, 0);
    ctx.fillStyle = grade.accent;
    ctx.fillText(numeral, 0, 0);
    ctx.restore();

    // A hairline over the numeral, and the word SERIES beneath it.
    ctx.save();
    ctx.strokeStyle = 'rgba(255,214,150,0.5)';
    ctx.lineWidth = Math.max(1, numSize * 0.03);
    ctx.beginPath();
    ctx.moveTo(numVisLeft, numBase - numSize * 0.99);
    ctx.lineTo(numRight, numBase - numSize * 0.99);
    ctx.stroke();
    drawTracked(ctx, 'SERIES', numVisLeft, numBase + numSize * 0.3, Math.max(6, numSize * 0.17), 0.3, 'rgba(255,222,178,0.72)', 'left', MONO);
    ctx.restore();
  }

  // The strapline, flush left under the title's baseline block, wide-tracked. It gives way to
  // the numeral's column rather than running underneath it.
  if (strapline) {
    const limit = numVisLeft - rect.x - size * 0.3;
    let sy2 = strapSize;
    for (let guard = 0; guard < 10; guard++) {
      ctx.font = font(UTILITY, sy2);
      let w = 0;
      for (const ch of [...strapline]) w += ctx.measureText(ch).width + 0.2 * sy2;
      if (w <= limit) break;
      sy2 *= 0.92;
    }
    drawTracked(ctx, strapline, rect.x, lastBase + sy2 * 2.15, sy2, 0.2, '#ffdfb2', 'left');
  }

  // The studio rule, between the strapline and the ticker.
  drawStudioRule(ctx, { x: rect.x, y: footRow.y - ruleRoom * 0.72, w: rect.w }, unit);

  drawTicker(ctx, { ...footRow, w: footRow.w * 0.63 }, unit);
  drawBarcode(ctx, { x: rect.x + footRow.w * 0.685, y: footRow.y, w: footRow.w * 0.315, h: footH }, unit);
  ctx.restore();
}

/** Text with extra tracking, centred or left-aligned on a baseline. */
export function drawTracked(ctx, text, x, y, size, tracking, color, align = 'center', stack = UTILITY) {
  ctx.save();
  ctx.font = font(stack, size);
  const chars = [...text];
  let width = 0;
  for (const ch of chars) width += ctx.measureText(ch).width + tracking * size;
  width -= tracking * size;
  let cx = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  for (const ch of chars) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + tracking * size;
  }
  ctx.restore();
  return width;
}

/** The rating box: our own invented content classification. */
function drawRatingBox(ctx, box, unit) {
  const r = Math.max(2, box.h * 0.1);
  ctx.save();
  ctx.beginPath();
  roundRect(ctx, box.x, box.y, box.w, box.h, r);
  ctx.fillStyle = 'rgba(9,4,18,0.78)';
  ctx.fill();
  ctx.strokeStyle = '#e9d6b6';
  ctx.lineWidth = Math.max(1, box.h * 0.055);
  ctx.stroke();
  ctx.clip();

  const cellW = box.w * 0.42;
  ctx.beginPath();
  ctx.moveTo(box.x + cellW, box.y);
  ctx.lineTo(box.x + cellW, box.y + box.h);
  ctx.strokeStyle = 'rgba(233,214,182,0.55)';
  ctx.lineWidth = Math.max(1, box.h * 0.04);
  ctx.stroke();

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffe9c4';
  ctx.font = font(DISPLAY, box.h * 0.74);
  ctx.fillText('M', box.x + cellW * 0.5, box.y + box.h * 0.53);
  ctx.fillStyle = '#f0dabd';
  ctx.font = font(UTILITY, box.h * 0.27);
  ctx.fillText('17+', box.x + cellW * 0.5, box.y + box.h * 0.845);
  ctx.font = font(MONO, box.h * 0.235);
  ctx.fillStyle = '#e2c9a4';
  ctx.fillText('CRUDE', box.x + cellW + (box.w - cellW) * 0.5, box.y + box.h * 0.36);
  ctx.fillText('CAPERS', box.x + cellW + (box.w - cellW) * 0.5, box.y + box.h * 0.7);
  ctx.restore();
}

/** The parody price tag, hanging off the right of the chrome row. */
function drawPriceTag(ctx, box, unit) {
  ctx.save();
  const notch = box.h * 0.22;
  ctx.beginPath();
  ctx.moveTo(box.x + notch, box.y);
  ctx.lineTo(box.x + box.w, box.y);
  ctx.lineTo(box.x + box.w, box.y + box.h);
  ctx.lineTo(box.x + notch, box.y + box.h);
  ctx.lineTo(box.x, box.y + box.h * 0.5);
  ctx.closePath();
  ctx.fillStyle = 'rgba(9,4,18,0.78)';
  ctx.fill();
  ctx.strokeStyle = '#e9d6b6';
  ctx.lineWidth = Math.max(1, box.h * 0.055);
  ctx.stroke();

  // Both lines are set to the box's own measure, so the tag always closes on its right edge
  // and the numeral below it can be hung off that same vertical.
  const x = box.x + box.w * 0.24;
  const room = box.x + box.w - box.h * 0.1 - x;
  const fitted = (stack, text, size) => {
    let s = size;
    for (let guard = 0; guard < 12; guard++) {
      ctx.font = font(stack, s);
      if (ctx.measureText(text).width <= room) break;
      s *= 0.9;
    }
    return s;
  };

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const priceSize = fitted(DISPLAY, '$59.99', box.h * 0.56);
  ctx.fillStyle = '#ffe9c4';
  ctx.font = font(DISPLAY, priceSize);
  ctx.fillText('$59.99', x, box.y + box.h * 0.44);
  const noteSize = fitted(MONO, 'NO REFUNDS', box.h * 0.2);
  ctx.font = font(MONO, noteSize);
  ctx.fillStyle = '#c9a97f';
  ctx.fillText('NO REFUNDS', x, box.y + box.h * 0.8);
  ctx.restore();
}

/** A hairline rule with a fake studio mark set into it. */
function drawStudioRule(ctx, rule, unit) {
  const size = Math.max(6, unit * 0.021);
  ctx.save();
  ctx.font = font(UTILITY, size);
  const label = 'A SUNBURN PICTURES RELEASE';
  const track = 0.26;
  let labelW = 0;
  for (const ch of [...label]) labelW += ctx.measureText(ch).width + track * size;
  labelW -= track * size;
  const y = rule.y + size * 0.5;
  const gap = size * 1.1;
  ctx.strokeStyle = 'rgba(240,214,176,0.5)';
  ctx.lineWidth = Math.max(1, size * 0.075);
  ctx.beginPath();
  ctx.moveTo(rule.x, y);
  ctx.lineTo(rule.x + rule.w / 2 - labelW / 2 - gap, y);
  ctx.moveTo(rule.x + rule.w / 2 + labelW / 2 + gap, y);
  ctx.lineTo(rule.x + rule.w, y);
  ctx.stroke();
  drawTracked(ctx, label, rule.x + rule.w / 2, rule.y + size * 0.85, size, track, 'rgba(245,222,186,0.88)', 'center');

  // The little mark: a diamond either side of the label.
  for (const dir of [-1, 1]) {
    const cx = rule.x + rule.w / 2 + dir * (labelW / 2 + gap * 0.95);
    ctx.beginPath();
    ctx.moveTo(cx, y - size * 0.32);
    ctx.lineTo(cx + size * 0.32, y);
    ctx.lineTo(cx, y + size * 0.32);
    ctx.lineTo(cx - size * 0.32, y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(247,180,96,0.9)';
    ctx.fill();
  }
  ctx.restore();
}

/** The ticker of invented brands along the foot of the lockup. */
function drawTicker(ctx, row, unit) {
  const brands = ['SUNSET COLA', 'PALMERO TYRES', 'DRIFT FM 88.1', 'VELVET CASINO'];
  let size = Math.max(6, unit * 0.02);
  ctx.save();
  ctx.font = font(MONO, size);
  // Shrink until every brand and its separator fits on one line.
  for (let guard = 0; guard < 14; guard++) {
    let total = 0;
    for (const b of brands) total += ctx.measureText(b).width + size * 2.4;
    if (total <= row.w * 0.97) break;
    size *= 0.91;
    ctx.font = font(MONO, size);
  }
  const y = row.y + row.h * 0.68;
  ctx.strokeStyle = 'rgba(255,238,208,0.34)';
  ctx.lineWidth = Math.max(1, size * 0.09);
  ctx.beginPath();
  ctx.moveTo(row.x, row.y + row.h * 0.05);
  ctx.lineTo(row.x + row.w, row.y + row.h * 0.05);
  ctx.stroke();

  const widths = brands.map((b) => ctx.measureText(b).width);
  const dotW = size * 1.5;
  const total = widths.reduce((a, b) => a + b, 0) + dotW * (brands.length - 1);
  // Flush left on the title's axis, so the whole lockup shares one grid.
  let x = row.x;
  ctx.textAlign = 'left';
  brands.forEach((brand, i) => {
    ctx.fillStyle = 'rgba(255,244,224,0.95)';
    ctx.fillText(brand, x, y);
    x += widths[i];
    if (i < brands.length - 1) {
      ctx.fillStyle = '#ffb257';
      ctx.fillText('·', x + dotW * 0.32, y);
      x += dotW;
    }
  });
  ctx.restore();
}

/** A barcode block with a faux catalogue number: the last piece of packaging furniture. */
function drawBarcode(ctx, box, unit) {
  const size = Math.max(5, unit * 0.0155);
  ctx.save();
  ctx.fillStyle = 'rgba(9,4,18,0.42)';
  ctx.fillRect(box.x, box.y + box.h * 0.05, box.w, box.h * 0.62);
  const padX = box.w * 0.07;
  let seed = 0x51af13;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return (seed >>> 8) / 16777216;
  };
  let x = box.x + padX;
  const top = box.y + box.h * 0.11;
  const height = box.h * 0.48;
  ctx.fillStyle = '#f6e8d2';
  while (x < box.x + box.w - padX) {
    const w = 1 + Math.floor(rnd() * 2.4);
    const gap = 1 + Math.floor(rnd() * 2);
    if (x + w > box.x + box.w - padX) break;
    ctx.fillRect(x, top, w, height * (0.78 + rnd() * 0.22));
    x += w + gap;
  }
  ctx.font = font(MONO, size);
  ctx.fillStyle = 'rgba(255,240,216,0.85)';
  ctx.textAlign = 'center';
  ctx.fillText('GTA6 · 0881 · 1972', box.x + box.w / 2, box.y + box.h * 0.86);
  ctx.restore();
}

/** A rounded rectangle path. */
export function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
}

/** A small corner stamp: the series mark along the bottom edge of the trim. */
export function drawSeriesStamp(ctx, W, H, size) {
  const px = Math.max(6, size * 0.0135);
  ctx.save();
  drawTracked(ctx, 'VICE LEDGER  ·  MMXXVI', W * 0.03, H * 0.9815, px, 0.18, 'rgba(255,238,210,0.46)', 'left', MONO);
  ctx.restore();
}
