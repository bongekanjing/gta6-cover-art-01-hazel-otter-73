#!/usr/bin/env python3
"""Measure the white gaps between the wordmark's glyphs in an exported cover.

    python3 tools/measure-gaps.py cover.png [--min 14] [--even 2.5] [--json]

Everything is measured on the flattened 'L' channel, i.e. on what the eye sees in the PNG.

  1. The title band is the run of rows in the lower part of the image around the brightest
     row, keeping every neighbouring row that still holds a third of that peak.
  2. Inside the band the rows are split into lines at the gutters where the bright count
     collapses: a one-line lockup gives one block, a stacked one gives two or more.
  3. In each line a column counts as ink when ANY pixel in it is bright (>210). Every run of
     empty columns between the line's first and last ink column is a white gap.
  4. A gap much wider than the line's median gap is the word space; the rest are letter
     gaps. Every letter gap, in every line, is reported.
  5. The numeral is measured separately to the right of the last line (it is a gold accent,
     dimmer than the cream fill). Its gap to the title, its baseline against the last line's
     foot, and its right edge against the lockup's right margin are reported.

The lockup's right margin is the price tag's right edge, found as the rightmost column above
the title whose bright run closes before the cap band (a panel keyline runs on through it and
is rejected). Exit code 0 means every letter gap is at least --min, no gap exceeds --even
times the narrowest, a word space is clearly the widest gap it appears in, the numeral clears
the title by more than the widest letter gap, and it sits on the last baseline at the margin.
"""

import argparse
import json
import sys

from PIL import Image

BRIGHT = 210        # the cream fill and its highlight
NUMERAL = 150       # the gold numeral plus its dark outline's AA fringe
WORD_RATIO = 1.6    # a gap this many times the line's median gap is a word space


def load(path):
    im = Image.open(path).convert('L')
    return im, im.load(), im.size[0], im.size[1]


def row_counts(px, w, y_lo, y_hi):
    return [
        (y, sum(1 for x in range(0, w, 2) if px[x, y] > BRIGHT)) for y in range(y_lo, y_hi)
    ]


def title_band(px, w, h):
    """(top, bottom, peak_row) of the whole title lockup, stacked lines included.

    Blocks of bright rows are taken in the lower part of the image; the tallest is the title
    line that carries the most ink, and every block at least 60% as tall as it is another
    title line. That keeps a two-line stack together while dropping the chrome row above it,
    the strapline and the ticker below — both of which are a fraction of a cap height tall.
    """
    counts = row_counts(px, w, int(h * 0.42), int(h * 0.985))
    if not counts:
        return None
    peak_y, peak_c = max(counts, key=lambda t: t[1])
    if peak_c < 8:
        return None
    floor = max(4, peak_c * 0.10)
    blocks = []
    start = None
    end = None
    for y, c in counts:
        if c > floor:
            if start is None:
                start = y
            end = y
        elif start is not None:
            blocks.append((start, end))
            start = None
    if start is not None:
        blocks.append((start, end))
    if not blocks:
        return None
    tallest = max(b[1] - b[0] for b in blocks)
    keep = [b for b in blocks if b[1] - b[0] >= tallest * 0.6]
    return min(b[0] for b in keep), max(b[1] for b in keep), peak_y


def split_lines(px, w, top, bottom):
    """The band's lines as (y_lo, y_hi) blocks, split at the gutters between them."""
    counts = row_counts(px, w, top, bottom + 1)
    peak = max(c for _, c in counts) or 1
    gutter = peak * 0.16
    blocks = []
    start = None
    end = None
    for y, c in counts:
        if c > gutter:
            if start is None:
                start = y
            end = y
        elif start is not None:
            blocks.append((start, end))
            start = None
    if start is not None:
        blocks.append((start, end))
    tallest = max((b[1] - b[0] for b in blocks), default=0)
    return [b for b in blocks if b[1] - b[0] >= tallest * 0.45]


def column_ink(px, x_lo, x_hi, y_lo, y_hi, threshold=BRIGHT):
    cols = set()
    for y in range(y_lo, y_hi + 1):
        for x in range(x_lo, x_hi):
            if px[x, y] > threshold:
                cols.add(x)
    return cols


def runs_of_empty(cols):
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
    """The numeral's ink box right of `after`, over the last line's rows."""
    cols = column_ink(px, after, w, y_lo, y_hi, NUMERAL)
    tall = []
    for x in cols:
        n = sum(1 for y in range(y_lo, y_hi + 1) if px[x, y] > NUMERAL)
        if n > (y_hi - y_lo) * 0.25:
            tall.append(x)
    if not tall:
        return None
    left, right = min(tall), max(tall)
    rows = [y for y in range(y_lo, y_hi + 1) if any(px[x, y] > NUMERAL for x in range(left, right + 1))]
    return {'left': left, 'right': right, 'top': min(rows), 'bottom': max(rows)}


def chrome_row(px, w, h, top, bottom):
    """The row block directly above the title band: the rating box and price tag.

    Walking up from the cap band, the first band of rows that holds bright ink and is
    separated from the title by a clear gap is the chrome row. Panels sit further up and are
    ignored, which is what keeps their bright pixels out of the margin measurement.
    """
    cap = bottom - top
    need = max(4, int(cap * 0.08))
    hi = top - need
    counts = dict(row_counts(px, w, int(h * 0.3), max(int(h * 0.3) + 1, hi)))
    ys = sorted(counts)
    block_end = None
    for y in reversed(ys):
        if counts[y] > 3:
            block_end = y
            break
    if block_end is None:
        return None
    start = block_end
    while start - 1 in counts and counts[start - 1] > 3:
        start -= 1
    return start, block_end


def chrome_margin(px, w, h, top, bottom):
    """The right edge of the printed chrome: the price tag's right stroke.

    The lockup's right margin is where the price tag, the barcode and the numeral all line up
    — the lockup rect's right edge, not the canvas edge and not the trim frame outside it.
    Measuring the rightmost bright column of the chrome row gives that vertical without
    hard-coding a layout number; the row block is isolated first so panel art above it cannot
    win the scan.
    """
    row = chrome_row(px, w, h, top, bottom)
    if row is None:
        return None
    best = None
    for x in range(int(w * 0.4), int(w * 0.985)):
        if any(px[x, y] > 190 for y in range(row[0], row[1] + 1)):
            best = x
    return best


def measure(path, min_gap=None, even=2.5):
    im, px, w, h = load(path)
    # The 14 px rule is stated for a 1920-wide export; keep the same optical gap at any size.
    if min_gap is None:
        min_gap = max(6, int(round(14 * (w / 1920))))
    band = title_band(px, w, h)
    if band is None:
        return {'ok': False, 'error': 'no bright title band (blank render?)', 'path': path}
    top, bottom, peak = band
    lines = split_lines(px, w, top, bottom)
    if not lines:
        return {'ok': False, 'error': 'no line found in the title band', 'path': path}

    out = {
        'path': path,
        'image': [w, h],
        'band': [top, bottom],
        'peakRow': peak,
        'lines': [],
    }
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
            'gaps': [g[1] for g in gaps],
            'gapX': [g[0] for g in gaps],
            'word': widths[-1] if is_word else None,
        })
        all_gaps.extend(letters)

    if not all_gaps:
        out['ok'] = False
        out['error'] = 'glyphs form one solid run - letters are fused'
        return out

    out['letters'] = sorted(all_gaps)
    out['minLetter'] = min(all_gaps)
    out['maxLetter'] = max(all_gaps)
    out['word'] = word
    out['wordLine'] = word_line

    last = out['lines'][-1]
    num = numeral_of(px, w, last['extent'][1] + 1, last['rows'][0], last['rows'][1])
    margin = chrome_margin(px, w, h, top, bottom)
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
            notes.append(f"numeral gap {out['numeralGap']} px not wider than the widest letter gap {max(all_gaps)} px")
        if abs(out['numeralBaselineDelta']) > max(3, (bottom - top) * 0.05):
            ok = False
            notes.append(f"numeral baseline off by {out['numeralBaselineDelta']} px")
        if out['numeralRightMargin'] is None:
            ok = False
            notes.append('no lockup margin found to check the numeral against')
        elif abs(out['numeralRightMargin']) > 4:
            ok = False
            notes.append(f"numeral right edge is {out['numeralRightMargin']} px off the lockup margin (x={margin})")
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
    print(f"{m['path']}  {m['image'][0]}x{m['image'][1]}  band rows {m['band'][0]}-{m['band'][1]}"
          f"  lines {len(m['lines'])}")
    if 'letters' not in m:
        print(f"  FAIL {m.get('error')}")
        return
    for i, line in enumerate(m['lines']):
        print(f"  line {i + 1}: rows {line['rows'][0]}-{line['rows'][1]}"
              f"  ink x {line['extent'][0]}-{line['extent'][1]}")
        for gx, gw in zip(line['gapX'], line['gaps']):
            tag = '  (word space)' if gw == line['word'] else ''
            print(f"    x={gx:5d}  {gw:4d} px{tag}")
    print(f"  letter gaps, all lines: {m['letters']}")
    if m['word']:
        print(f"  word space {m['word']} px on line {m['wordLine'] + 1}")
    if 'numeral' in m:
        n = m['numeral']
        print(f"  numeral VI: x {n['left']}-{n['right']}, gap to title {m['numeralGap']} px,"
              f" right edge {m['numeralRightMargin']} px from the lockup margin,"
              f" baseline delta {m['numeralBaselineDelta']} px")
    for note in m.get('notes', []):
        print(f'  FAIL: {note}')
    print('  PASS' if m['ok'] else '  not yet')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('png')
    ap.add_argument('--min', type=int, default=None, help='minimum letter gap in px (default: 14 at 1920 wide)')
    ap.add_argument('--even', type=float, default=2.5)
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
