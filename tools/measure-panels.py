#!/usr/bin/env python3
"""Measure each panel's mean luminance and mean hue in a rendered cover PNG.

    python3 tools/measure-panels.py cover.png [--layout classic] [--json]

Panels come from the app's own layout template (the same normalised rects as
app/src/panels.js), inset by 12% so the keyline, the inner shadow and the light hairline
cannot bias the sample. Mean hue is a circular mean of the hue of every pixel with enough
chroma to have a hue at all, so a washed-out panel does not drag the average around.
Exit code 1 unless every panel's mean luminance is within TOL_LUM of the others and every
panel's mean hue is within TOL_HUE degrees of the others.
"""

import argparse
import colorsys
import json
import sys

from PIL import Image

TOL_LUM = 0.12      # fraction of the mean
TOL_HUE = 15.0      # degrees

LAYOUTS = {
    'classic': [
        (0.024, 0.042, 0.564, 0.536),
        (0.604, 0.042, 0.372, 0.259),
        (0.604, 0.319, 0.372, 0.259),
    ],
    'triptych': [
        (0.024, 0.042, 0.302, 0.606),
        (0.349, 0.042, 0.302, 0.606),
        (0.674, 0.042, 0.302, 0.606),
    ],
    'grid5': [
        (0.024, 0.042, 0.592, 0.878),
        (0.638, 0.042, 0.162, 0.249),
        (0.814, 0.042, 0.162, 0.249),
        (0.638, 0.311, 0.162, 0.249),
        (0.814, 0.311, 0.162, 0.249),
    ],
    'single': [(0.0, 0.0, 1.0, 1.0)],
}


def circular_mean_hue(hues):
    """Mean of angles, in degrees, weighted equally."""
    import math
    if not hues:
        return None
    x = sum(math.cos(math.radians(h)) for h in hues)
    y = sum(math.sin(math.radians(h)) for h in hues)
    return math.degrees(math.atan2(y, x)) % 360


def hue_gap(a, b):
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


def panel_stats(im, rect, inset=0.12):
    x, y, w, h = rect
    W, H = im.size
    x0 = int((x + w * inset) * W)
    y0 = int((y + h * inset) * H)
    x1 = int((x + w * (1 - inset)) * W)
    y1 = int((y + h * (1 - inset)) * H)
    crop = im.crop((x0, y0, x1, y1))
    px = list(crop.convert('RGB').getdata())
    lum = 0.0
    hues = []
    for r, g, b in px:
        lum += 0.2126 * r + 0.7152 * g + 0.0722 * b
        mx, mn = max(r, g, b), min(r, g, b)
        if mx - mn > 22 and mx > 26:          # enough chroma to carry a hue
            hues.append(colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)[0] * 360.0)
    return {
        'box': [x0, y0, x1, y1],
        'lum': lum / max(1, len(px)),
        'hue': circular_mean_hue(hues),
        'chromaShare': len(hues) / max(1, len(px)),
        'pixels': len(px),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('png')
    ap.add_argument('--layout', default='classic')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    im = Image.open(args.png)
    rects = LAYOUTS[args.layout]
    stats = [panel_stats(im, r) for r in rects]
    lums = [s['lum'] for s in stats]
    hues = [s['hue'] for s in stats]
    mean_lum = sum(lums) / len(lums)
    out = {'path': args.png, 'layout': args.layout, 'panels': stats}

    ok = True
    notes = []
    for i, s in enumerate(stats):
        s['lumDev'] = (s['lum'] - mean_lum) / mean_lum
    spread = max(lums) / max(1e-6, min(lums))
    out['lumSpread'] = spread
    # "within 12% of the others": every panel's deviation from the mean under 12%.
    if max(abs(s['lumDev']) for s in stats) > TOL_LUM:
        ok = False
        notes.append(f"luminance spread {spread:.3f}x, worst deviation "
                     f"{max(abs(s['lumDev']) for s in stats) * 100:.1f}% > {TOL_LUM * 100:.0f}%")
    base = hues[0]
    worst = 0.0
    for i, s in enumerate(stats):
        s['hueDev'] = hue_gap(s['hue'], base)
        worst = max(worst, s['hueDev'])
    out['hueWorst'] = worst
    if worst > TOL_HUE:
        ok = False
        notes.append(f"hue spread {worst:.1f} deg > {TOL_HUE:.0f} deg")

    if args.json:
        out['ok'] = ok
        out['notes'] = notes
        print(json.dumps(out))
        return 0 if ok else 1

    print(f"{args.png}  layout {args.layout}  panels {len(stats)}")
    print('  panel      box                     mean lum   dev      mean hue   d(hue)')
    for i, s in enumerate(stats):
        b = s['box']
        print(f"  {i + 1:>5}  x{b[0]:4d}-{b[2]:4d} y{b[1]:4d}-{b[3]:4d}   "
              f"{s['lum']:7.1f}  {s['lumDev'] * 100:+6.1f}%   {s['hue']:6.1f}°   {s['hueDev']:6.1f}°")
    lums_s = [round(s['lum'], 1) for s in stats]
    print(f"  lum: {lums_s}  mean {mean_lum:.1f}  spread {spread:.3f}x")
    print(f"  hue: {[round(s['hue'], 1) for s in stats]}  worst gap {worst:.1f}°")
    for note in notes:
        print(f'  FAIL: {note}')
    print('  PASS' if ok else '  not yet')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
