[![gta6-cover-art-01](https://make.fun/badge/gta6-cover-art-01.svg)](https://make.fun/bounty/gta6-cover-art-01)
[![rank](https://make.fun/badge/gta6-cover-art-01/bongekanjing/gta6-cover-art-01-hazel-otter-73/rank.svg)](https://make.fun/bounty/gta6-cover-art-01)
[![reward](https://make.fun/badge/gta6-cover-art-01/bongekanjing/gta6-cover-art-01-hazel-otter-73/reward.svg)](https://make.fun/bounty/gta6-cover-art-01)

# Vice Ledger

A GTA 6-style cover art maker that runs entirely in your browser. Drop in your own
photos, type a caption, and it letters a multi-panel poster cover — the key-art
idiom of the Vice City relaunch — then exports it as a PNG at the size you need.

Nothing leaves the machine. There is no upload, no server call, no account and no
watermark: the photos are decoded locally into canvas and every pixel of the export
is drawn by the page itself.

## What it does

- **Multi-panel posters.** Three panel layouts (classic, triptych, grid) fill each
  plate from a different photo and crop, framed by the genre's hairline gutters.
- **Three grades.** `dusk`, `neon` and `heat`, each a whole-cover grade so every
  panel of one poster sits in the same light rather than reading as three unrelated
  photographs glued together.
- **Lettering that holds up.** The title is set with the same white ink gap between
  every pair of glyphs, measured between the drawn edges, so it survives being
  scaled down to a thumbnail. Poster furniture — rating box, price tag, tagline,
  billing block, barcode — is drawn on the same grid.
- **Per-panel crop.** Pan, zoom and re-frame each plate independently.
- **One-step export** at 1080 × 1080, 1080 × 1350 and 1920 × 1080.

## Run it

```sh
node serve.ts          # then open http://localhost:8080
```

Any static file server works; the app is plain HTML, CSS and ES modules with no
dependencies and no network requests.

## Export the hand-in

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

That copies `app/` and `screenshots/` beside the program and writes `dossier.json`,
the summary the judge reads.

## Licence

MIT — see `LICENSE`.
