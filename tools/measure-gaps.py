#!/usr/bin/env python3
"""Measure the tracking of the wordmark in an exported cover.

    python3 tools/measure-gaps.py cover.png [--min 14] [--even 2.5] [--json]

The rule this tool exists to enforce, at 1920 px wide:

    every white gap between two glyphs of the wordmark is at least 14 px, and
    no letter gap is more than 2.5x the narrowest.

Anything narrower than that fuses into a smear; anything wider makes the
lockup read as separate words. Both are the difference between hand-lettered
display type and a system font with tracking switched off.

HOW THE TITLE IS FOUND

The obvious approach -- "the brightest block of rows in the lower half" -- does
not work on this poster, and the reason is worth stating because it is the whole
difficulty. The panels above the title are full of cream and gold, and they are
taller than the lettering, so they win any brightness contest. A first version of
this tool reported a "title line" 534 px wide spanning rows 461-624: that was a
strip of panel art, and its tracking verdict was meaningless.

The discriminating property is not brightness but *what sits between the
glyphs*. Display lettering is cream ink on the poster's near-black field, so the
gaps between its letters are dark; a panel is bright fills packed edge to edge
with no dark field between shapes. So a candidate row block is accepted only if
a good share of its own columns are dark -- that single test separates type from
picture, and it is why this tool reads the dark fraction before it reads any
gap.

  1. Row blocks are the runs of rows in the lower two-thirds with meaningful ink.
  2. A block is a title line if its dark fraction is at least DARK_FIELD. Blocks
     taller than 60% of the tallest such block are other lines of the same stack.
  3. Within a line, a column is ink when any pixel in it is bright. Every run of
     empty columns between the first and last ink column is a gap.
  4. The widest gap on a line, when it is WORD_RATIO times the median, is the
     word space and is excluded from the letter gaps.
  5. The numeral is measured to the right of the last line, and its gap to the
     title, its baseline against the last line's foot, and its right edge against
     the lockup margin are all reported, because a lockup whose numeral drifts is
     as broken as one whose letters are unevenly tracked.

Exit 0 means the rule passes; exit 1 means it does not, and every failure is
printed with the number that failed it.
"""

import argparse
import json
import sys

from PIL import Image

BRIGHT = 210        # the cream fill and its own highlight
NUMERAL = 150       # the gold numeral, plus the AA fringe of its dark outline
DARK = 70           # the poster's field: darker than any fill ever gets
DARK_FIELD = 0.30   # share of a line's columns that must be field, to be type
WORD_RATIO = 1.6    # a gap this many times the median is a word space
INK_FLOOR = 0.06    # a row needs this share of the peak's ink to count


def load(path):
    im = Image.open(path).convert('L')
    return im, im.load(), im.size[0], im.size[1]


def row_profile(px, w, y_lo, y_hi, step=2):
    """(bright count, dark count) per row: how much ink, and how much field."""
    out = []
    for y in range(y_lo, y_hi):
        bright = 0
        dark = 0
        for x in range(0, w, step):
            v = px[x, y]
            if v > BRIGHT:
                bright += 1
            elif v < DARK:
                dark += 1
        out.append((y, bright, dark))
    return out


def blocks_of(profile, floor):
    """Runs of consecutive rows holding more than `floor` ink."""
    blocks = []
    start = None
    end = None
    for y, bright, _ in profile:
        if bright > floor:
            if start is None:
                start = y
            end = y
        elif start is not None:
            blocks.append((start, end))
            start = None
    if start is not None:
        blocks.append((start, end))
    return blocks


def title_band(px, w, h):
    """(top, bottom) of the whole wordmark, stacked lines included, or None.

    Row blocks are found in the lower part of the sheet, then filtered by dark
    fraction: only a block of type has the poster's field showing between its
    glyphs. The tallest survivors are grouped, so a two-line lockup stays whole
    while a strapline -- a fraction of a cap height -- is dropped.
    """
    y_lo, y_hi = int(h * 0.55), int(h * 0.985)
    profile = row_profile(px, w, y_lo, y_hi)
    if not profile:
        return None
    peak = max(p[1] for p in profile)
    if peak < 8:
        return None
    step = max(1, round(2 * h / 1080))
    cols = sum(1 for x in range(0, w, step))
    keep = []
    for (a, b) in blocks_of(profile, max(3, peak * INK_FLOOR)):
        if b - a < h * 0.02:          # a rule or a strapline, not a cap height
            continue
        inked = [p for p in profile if a <= p[0] <= b]
        field = sum(p[2] for p in inked) / max(1, len(inked) * cols)
        if field < DARK_FIELD:
            continue
        keep.append((a, b))
    if not keep:
        return None
    tallest = max(b - a for a, b in keep)
    keep = [b for b in keep if b[1] - b[0] >= tallest * 0.6]
    return min(b[0] for b in keep), max(b[1] for b in keep)


def split_lines(px, w, top, bottom):
    """The band's lines as (y_lo, y_hi), split at the gutters between them."""
    profile = row_profile(px, w, top, bottom + 1)
    if not profile:
        return []
    peak = max(p[1] for p in profile) or 1
    blocks = blocks_of(profile, peak * 0.16)
    tallest = max((b[1] - b[0] for b in blocks), default=0)
    return [b for b in blocks if b[1] - b[0] >= tallest * 0.45]


def column_ink(px, x_lo, x_hi, y_lo, y_hi, threshold=BRIGHT):
    """The set of columns holding at least one pixel above `threshold`.

    Columns are the outer loop on purpose. Iterating rows and breaking at the
    first bright pixel would find only the leftmost glyph on each row, which
    undercounts the ink to one column per row and reports a title 400 px wide
    when it is 1500.
    """
    cols = set()
    for x in range(x_lo, x_hi):
        for y in range(y_lo, y_hi + 1):
            if px[x, y] > threshold:
                cols.add(x)
                break
    return cols


def runs_of_empty(cols):
    """(first, last) ink column and the (x, width) of every empty run between."""
    if not cols:
        return None, []
    xs = sorted(cols)
    gaps = []
    run = 0
    for x in range(xs[0], xs[-1] + 1):
        if x not in cols:
            run += 1
        elif run:
            gaps.append((x - run, run))
            run = 0
    return (xs[0], xs[-1]), gaps


def numeral_of(px, w, after, y_lo, y_hi):
    """The numeral's ink box to the right of `after`, over the last line's rows."""
    tall = []
    for x in range(after, w):
        n = sum(1 for y in range(y_lo, y_hi + 1) if px[x, y] > NUMERAL)
        if n > (y_hi - y_lo) * 0.25:
            tall.append(x)
    if not tall:
        return None
    left, right = min(tall), max(tall)
    rows = [y for y in range(y_lo, y_hi + 1)
            if any(px[x, y] > NUMERAL for x in range(left, right + 1))]
    return {'left': left, 'right': right, 'top': min(rows), 'bottom': max(rows)}


def lockup_margin(px, w, h, top, bottom):
    """The right edge of the printed chrome above the title: the price tag.

    The lockup's right margin is the vertical the price tag, the barcode and the
    numeral all sit on. Three things must be excluded or the answer is wrong:

      - The trim frame and the panel keylines, which run on above the title. They
        are rejected by testing whether a column is bright at BOTH ends of the
        strip: a vertical rule is, a glyph is not. Without this the margin comes
        back as the frame edge, a dozen pixels outside the numeral, and the check
        then reports a numeral that has drifted when it has not.
      - Hairlines and rules, which are bright for a row or two and then not. A
        column has to hold a real depth of ink -- a twelfth of a cap height -- to
        count as part of a letterform. This is what rejects the rule that hangs
        over the numeral, whose right end lands at the sheet margin rather than
        the lockup's.
      - Rows high above the title, which belong to the panel art.

    So the scan is confined to the strip just above the lettering, and a column
    counts only if its ink is interior to the strip and deep enough to be type.
    """
    y_hi = top - max(3, int(h * 0.012))
    y_lo = max(0, top - int(h * 0.16))
    if y_hi <= y_lo:
        return None
    depth = max(3, int((bottom - top) * 0.083))
    best = None
    for x in range(int(w * 0.4), int(w * 0.995)):
        if px[x, y_lo + 1] > 190 and px[x, y_hi - 1] > 190:
            continue                      # a rule running the height of the strip
        n = 0
        for y in range(y_lo, y_hi):
            if px[x, y] > 190:
                n += 1
        if n >= depth:
            best = x
    return best


def measure(path, min_gap=None, even=2.5):
    im, px, w, h = load(path)
    # The 14 px rule is stated for a 1920-wide export; keep the same optical gap at any size.
    if min_gap is None:
        min_gap = max(6, int(round(14 * (w / 1920))))
    band = title_band(px, w, h)
    if band is None:
        return {'ok': False, 'error': 'no type found: no bright block over a dark field',
                'path': path}
    top, bottom = band
    lines = split_lines(px, w, top, bottom)
    if not lines:
        return {'ok': False, 'error': 'no line inside the title band', 'path': path}

    out = {'path': path, 'image': [w, h], 'band': [top, bottom], 'lines': []}
    all_gaps = []
    word = None
    word_line = None
    for (y_lo, y_hi) in lines:
        extent, gaps = runs_of_empty(column_ink(px, 0, w, y_lo, y_hi))
        if not extent or not gaps:
            continue
        widths = sorted(g[1] for g in gaps)
        median = widths[len(widths) // 2] if widths else 0
        is_word = len(widths) >= 3 and widths[-1] >= median * WORD_RATIO
        letters = [g[1] for g in gaps]
        if is_word:
            letters.remove(widths[-1])
            if word is None or widths[-1] > word:
                word = widths[-1]
                word_line = len(out['lines'])
        out['lines'].append({
            'rows': [y_lo, y_hi],
            'height': y_hi - y_lo + 1,
            'extent': list(extent),
            'gapX': [g[0] for g in gaps],
            'gaps': [g[1] for g in gaps],
            'word': widths[-1] if is_word else None,
        })
        all_gaps.extend(letters)

    if not all_gaps:
        out['ok'] = False
        out['error'] = 'glyphs form one solid run: the letters are fused'
        return out

    out['letters'] = sorted(all_gaps)
    out['minLetter'] = min(all_gaps)
    out['maxLetter'] = max(all_gaps)
    out['word'] = word
    out['wordLine'] = word_line

    last = out['lines'][-1]
    num = numeral_of(px, w, last['extent'][1] + 1, last['rows'][0], last['rows'][1])
    margin = lockup_margin(px, w, h, top, bottom)
    if num:
        out['numeral'] = num
        out['numeralGap'] = num['left'] - last['extent'][1] - 1
        out['numeralMargin'] = margin
        out['numeralRightMargin'] = (margin - num['right']) if margin else None
        out['numeralBaselineDelta'] = last['rows'][1] - num['bottom']

    ok = True
    notes = []
    if min(all_gaps) < min_gap:
        ok = False
        notes.append(f'narrowest letter gap {min(all_gaps)} px < {min_gap} px')
    if max(all_gaps) > min(all_gaps) * even:
        ok = False
        notes.append(f'uneven tracking: max/min {max(all_gaps) / min(all_gaps):.2f} > {even}')
    if word is not None and word <= max(all_gaps) * 1.2:
        ok = False
        notes.append('word space is not clearly wider than a letter gap')
    if num:
        if out['numeralGap'] <= max(all_gaps):
            ok = False
            notes.append(f"numeral gap {out['numeralGap']} px is not wider than the "
                         f"widest letter gap {max(all_gaps)} px")
        if abs(out['numeralBaselineDelta']) > max(3, (bottom - top) * 0.05):
            ok = False
            notes.append(f"numeral baseline off by {out['numeralBaselineDelta']} px")
        if out['numeralRightMargin'] is None:
            ok = False
            notes.append('no lockup margin found to check the numeral against')
        elif abs(out['numeralRightMargin']) > 6:
            ok = False
            notes.append(f"numeral right edge is {out['numeralRightMargin']} px off the "
                         f"lockup margin (x={margin})")
    else:
        ok = False
        notes.append('numeral not found beside the title')
    out['ok'] = ok
    out['notes'] = notes
    return out


def report(m):
    if 'lines' not in m:
        print(f"{m['path']}: FAIL {m.get('error')}")
        return
    print(f"{m['path']}  {m['image'][0]}x{m['image'][1]}"
          f"  title rows {m['band'][0]}-{m['band'][1]}  lines {len(m['lines'])}")
    if 'letters' not in m:
        print(f"  FAIL {m.get('error')}")
        return
    for i, line in enumerate(m['lines']):
        print(f"  line {i + 1}: rows {line['rows'][0]}-{line['rows'][1]}"
              f"  ink x {line['extent'][0]}-{line['extent'][1]}")
        for gx, gw in zip(line['gapX'], line['gaps']):
            tag = '   (word space)' if gw == line['word'] else ''
            print(f"    x={gx:5d}  {gw:4d} px{tag}")
    print(f"  letter gaps: {m['letters']}")
    print(f"  narrowest {m['minLetter']} px, widest {m['maxLetter']} px,"
          f" ratio {m['maxLetter'] / m['minLetter']:.2f}")
    if m['word']:
        print(f"  word space {m['word']} px on line {m['wordLine'] + 1}")
    if 'numeral' in m:
        n = m['numeral']
        print(f"  numeral: x {n['left']}-{n['right']}, gap to title {m['numeralGap']} px,"
              f" right edge {m['numeralRightMargin']} px from the lockup margin,"
              f" baseline delta {m['numeralBaselineDelta']} px")
    for note in m.get('notes', []):
        print(f'  FAIL: {note}')
    print('  PASS' if m['ok'] else '  not yet')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    ap.add_argument('png')
    ap.add_argument('--min', type=int, default=None,
                    help='minimum letter gap in px (default: 14 at 1920 wide)')
    ap.add_argument('--even', type=float, default=2.5,
                    help='widest gap may be this many times the narrowest')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    m = measure(args.png, args.min, args.even)
    if args.json:
        print(json.dumps(m))
    else:
        report(m)
    return 0 if m['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
