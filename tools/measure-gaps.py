#!/usr/bin/env python3
"""Measure the white gaps between the title's glyphs in an exported cover PNG.

Usage: python3 measure-gaps.py <png> [--rows H] [--bright N]

Finds the title band (the row with the most bright pixels in the lower half),
takes a band of rows above and below it, and reports every run of columns with
no bright pixel: each run is the white gap between two neighbouring glyphs.
Exit code 1 if any letter gap is under the minimum, so it can gate a build.
"""
import sys

from PIL import Image

MIN_GAP = 14          # px at 1920 wide
EVENNESS = 2.5        # widest letter gap / narrowest must stay under this


def mask_profile(path, band=70, bright=210):
    im = Image.open(path).convert('L')
    w, h = im.size
    px = im.load()
    x_lo, x_hi = int(w * 0.02), int(w * 0.98)
    y_lo, y_hi = int(h * 0.45), int(h * 0.95)

    best, best_y = -1, y_lo
    for y in range(y_lo, y_hi):
        c = sum(1 for x in range(x_lo, x_hi, 2) if px[x, y] > bright)
        if c > best:
            best, best_y = c, y

    cols = set()
    for y in range(max(0, best_y - band), min(h, best_y + band)):
        for x in range(x_lo, x_hi):
            if px[x, y] > bright:
                cols.add(x)
    if not cols:
        return None, best_y, []
    xs = sorted(cols)
    runs, run = [], 0
    for x in range(xs[0], xs[-1] + 1):
        if x not in cols:
            run += 1
        elif run:
            runs.append((x - run, run))
            run = 0
    return (xs[0], xs[-1]), best_y, runs


def main():
    if len(sys.argv) < 2:
        print('usage: measure-gaps.py <png>')
        return 2
    path = sys.argv[1]
    ext, peak, runs = mask_profile(path)
    if ext is None:
        print('FAIL: no bright title band found (blank render?)')
        return 1
    print(f'{path}: glyph extent x={ext[0]}..{ext[1]}, peak row {peak}')
    if not runs:
        print('FAIL: glyphs form one solid run - letters are fused')
        return 1
    widths = [r[1] for r in runs]
    # the widest run is the word space; the rest are letter gaps
    word = max(widths)
    letters = [w for w in widths if w != word] or []
    print(f'  {len(runs)} gap(s), widths={widths}')
    print(f'  word space {word} px; letter gaps {sorted(letters)}')
    ok = True
    if letters:
        if min(letters) < MIN_GAP:
            print(f'  FAIL: narrowest letter gap {min(letters)} px < {MIN_GAP} px')
            ok = False
        if max(letters) / max(1, min(letters)) > EVENNESS:
            print(f'  FAIL: uneven tracking (max/min {max(letters)/max(1,min(letters)):.2f} > {EVENNESS})')
            ok = False
    if word and letters and word <= max(letters) * 1.15:
        print('  FAIL: word space is not clearly wider than a letter gap')
        ok = False
    print('  PASS' if ok else '  not yet')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
