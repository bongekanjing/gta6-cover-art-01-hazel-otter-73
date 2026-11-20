// main.js — the editor.
//
// Controls on the left, a live preview on the right. Every change goes through state.js and comes
// back as one render, so nothing can drift. Photographs are read with the File API on this machine
// and never leave it. The preview calls the export's own render function at screen scale.

import { createState, SIZES, sizeIndexOf } from './state.js';
import { LAYOUTS, LAYOUT_ORDER } from './panels.js';
import { GRADES, GRADE_ORDER, panFactor } from './ink.js';
import { renderCover, renderToCanvas, renderVariantsToCanvas, renderDetailToCanvas, invalidateArt } from './cover.js';
import { loadImage, loadSamples, seedPanels, runShot, parseSize, VARIANTS } from './shots.js';

const state = createState();
const params = new URLSearchParams(location.search);
const shotMode = params.get('shot') ?? '';
const $ = (sel) => document.querySelector(sel);

// ------------------------------------------------------------------ preview

const previewCanvas = $('#preview');
const previewCtx = previewCanvas.getContext('2d');
const previewBox = { w: 1, h: 1, dpr: 1 };
let renderQueued = false;
/** Panel rects in CSS pixels of the preview, for hit testing a click. */
let lastPanels = [];

/** Lay the preview canvas out inside its frame at the chosen size's aspect ratio. */
function sizePreview() {
  const frame = $('#preview-frame');
  const avail = frame.getBoundingClientRect();
  const size = SIZES[state.get().sizeIndex];
  const boxW = Math.max(160, avail.width - 34);
  const boxH = Math.max(160, avail.height - 34);
  const scale = Math.min(boxW / size.w, boxH / size.h);
  previewBox.w = Math.max(1, Math.floor(size.w * scale));
  previewBox.h = Math.max(1, Math.floor(size.h * scale));
  previewBox.dpr = Math.min(2, window.devicePixelRatio || 1);
  previewCanvas.style.width = `${previewBox.w}px`;
  previewCanvas.style.height = `${previewBox.h}px`;
  previewCanvas.width = Math.round(previewBox.w * previewBox.dpr);
  previewCanvas.height = Math.round(previewBox.h * previewBox.dpr);
}

/** One render pass: the cover at preview scale, drawn by the export's own function. */
function drawPreview() {
  const s = state.get();
  previewCtx.setTransform(previewBox.dpr, 0, 0, previewBox.dpr, 0, 0);
  previewCtx.clearRect(0, 0, previewBox.w, previewBox.h);
  lastPanels = renderCover(previewCtx, previewBox.w, previewBox.h, s, { preview: true });
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    drawPreview();
    syncControls();
  });
}

// ------------------------------------------------------------------ controls

const photoStrip = $('#photo-strip');
const photoCount = $('#photo-count');
const selectLabel = $('#selected-label');
const zoomRange = $('#zoom');
const zoomValue = $('#zoom-val');
const captionField = $('#caption');
const straplineField = $('#strapline');
const statusLine = $('#status');

/** Rebuild the photo thumbnails from the loaded photos. */
function renderThumbs() {
  const s = state.get();
  photoStrip.textContent = '';
  photoCount.textContent = s.photos.length
    ? `${s.photos.length} photo${s.photos.length === 1 ? '' : 's'}`
    : 'none yet';
  s.photos.forEach((photo, i) => {
    const cell = document.createElement('div');
    cell.className = 'thumb';
    cell.dataset.photo = String(i);
    const view = document.createElement('canvas');
    view.width = 96;
    view.height = 70;
    const ctx = view.getContext('2d');
    const src = photo.source;
    const scale = Math.max(view.width / src.width, view.height / src.height);
    const dw = src.width * scale;
    const dh = src.height * scale;
    ctx.drawImage(src, (view.width - dw) / 2, (view.height - dh) / 2, dw, dh);
    const tag = document.createElement('span');
    tag.textContent = photo.sample ?? photo.name.replace(/\.[a-z0-9]+$/i, '');
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'thumb-drop';
    drop.title = 'Remove this photo';
    drop.textContent = '×';
    drop.addEventListener('click', (ev) => {
      ev.stopPropagation();
      state.removePhoto(i);
      invalidateArt();
      renderThumbs();
    });
    cell.append(view, tag, drop);
    cell.title = 'Use this photo in the selected panel';
    cell.addEventListener('click', () => {
      state.setCrop(state.get().selected, { photo: i });
      scheduleRender();
    });
    photoStrip.append(cell);
  });
}

/** Push state into every control, without re-firing their input events. */
function syncControls() {
  const s = state.get();
  const crop = s.crops[s.selected] ?? { zoom: 1, fx: 0.5, fy: 0.5, photo: 0 };
  const count = LAYOUTS[s.layout].panels.length;
  selectLabel.innerHTML = `Panel <b>${s.selected + 1}</b> of ${count}`;
  if (zoomRange.value !== String(crop.zoom)) zoomRange.value = String(crop.zoom);
  zoomValue.textContent = `${crop.zoom.toFixed(2)}×`;
  if (document.activeElement !== captionField && captionField.value !== s.caption) captionField.value = s.caption;
  if (document.activeElement !== straplineField && straplineField.value !== s.strapline) straplineField.value = s.strapline;
  if (statusLine.textContent !== s.status) statusLine.textContent = s.status;

  for (const btn of document.querySelectorAll('[data-layout]')) {
    const on = btn.dataset.layout === s.layout;
    btn.classList.toggle('on', on);
    btn.querySelector('em').textContent = on ? 'in use' : LAYOUTS[btn.dataset.layout].note;
  }
  for (const btn of document.querySelectorAll('[data-grade]')) {
    btn.classList.toggle('on', btn.dataset.grade === s.grade);
  }
  for (const btn of document.querySelectorAll('[data-size]')) {
    btn.classList.toggle('on', Number(btn.dataset.size) === s.sizeIndex);
  }
  for (const cell of photoStrip.children) {
    cell.classList.toggle('used', crop.photo === Number(cell.dataset.photo));
  }
  const size = SIZES[s.sizeIndex];
  $('#size-readout').textContent = `${size.w} × ${size.h}`;
  $('#export').textContent = `Export ${size.w} × ${size.h} PNG`;
}

// ------------------------------------------------------------------ panel dragging

let drag = null;

/** The panel under a pointer, in preview fractions. */
function panelAt(s, px, py) {
  const panels = LAYOUTS[s.layout].panels;
  for (let i = 0; i < panels.length; i++) {
    const p = panels[i];
    if (px >= p.x && px <= p.x + p.w && py >= p.y && py <= p.y + p.h) return i;
  }
  return -1;
}

previewCanvas.addEventListener('pointerdown', (ev) => {
  const s = state.get();
  if (!s.photos.length) return;
  const rect = previewCanvas.getBoundingClientRect();
  const px = (ev.clientX - rect.left) / rect.width;
  const py = (ev.clientY - rect.top) / rect.height;
  const hit = panelAt(s, px, py);
  if (hit < 0) return;
  if (hit !== s.selected) state.select(hit);
  const crop = state.get().crops[hit];
  const photo = state.get().photos[crop.photo];
  if (!photo) return;
  const box = lastPanels[hit] ?? { w: 1, h: 1 };
  const factor = panFactor(photo.source, box.w, box.h, crop.zoom);
  drag = {
    panel: hit,
    x: ev.clientX,
    y: ev.clientY,
    fx: crop.fx,
    fy: crop.fy,
    factor,
  };
  previewCanvas.setPointerCapture(ev.pointerId);
  previewCanvas.classList.add('grabbing');
});

previewCanvas.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  const rect = previewCanvas.getBoundingClientRect();
  const dx = (ev.clientX - drag.x) / rect.width;
  const dy = (ev.clientY - drag.y) / rect.height;
  // Dragging the picture right shows the part of it to its left, so the focal point moves the
  // other way, by exactly the number of image-widths travelled.
  state.setCrop(drag.panel, {
    fx: drag.fx - dx * drag.factor.x,
    fy: drag.fy - dy * drag.factor.y,
  });
  scheduleRender();
});

const endDrag = () => {
  if (!drag) return;
  drag = null;
  previewCanvas.classList.remove('grabbing');
};
previewCanvas.addEventListener('pointerup', endDrag);
previewCanvas.addEventListener('pointercancel', endDrag);

// Arrow keys nudge the selected panel; digits pick a panel.
window.addEventListener('keydown', (ev) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const step = ev.shiftKey ? 4 : 1;
  const moves = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  if (moves[ev.key]) {
    ev.preventDefault();
    state.nudge(...moves[ev.key]);
    scheduleRender();
    return;
  }
  if (ev.key >= '1' && ev.key <= '5') {
    state.select(Number(ev.key) - 1);
    scheduleRender();
  }
});

// ------------------------------------------------------------------ wiring

const fileInput = $('#photos');

/** Decode a File, returning a state photo or null. */
async function readFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const source = await loadImage(url);
    return { id: `${file.name}:${file.size}:${file.lastModified}`, name: file.name, source };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Add photos from a FileList, framing them in the panels after the ones already filled. */
async function addFiles(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (images.length === 0) return;
  const loaded = (await Promise.all(images.map(readFile))).filter(Boolean);
  if (loaded.length === 0) {
    state.setStatus('Could not read those files as images.');
    return;
  }
  const s = state.get();
  const wasEmpty = s.photos.length === 0;
  const base = s.photos.length;
  for (const photo of loaded) s.photos.push(photo);
  if (wasEmpty) {
    seedPanels(state, loaded);
  } else {
    const count = LAYOUTS[s.layout].panels.length;
    for (let i = 0; i < loaded.length; i++) {
      const at = base + i;
      if (at < count) s.crops[at] = { photo: at, zoom: 1, fx: 0.5, fy: 0.5 };
    }
    s.selected = Math.min(base, count - 1);
  }
  invalidateArt();
  renderThumbs();
  state.setStatus(`${images.length} photo${images.length === 1 ? '' : 's'} loaded. Drag inside a panel to reframe it.`);
}

fileInput.addEventListener('change', () => {
  const files = fileInput.files;
  fileInput.value = '';
  if (files && files.length) addFiles(files);
});

zoomRange.addEventListener('input', (ev) => {
  state.setCrop(state.get().selected, { zoom: Number(ev.target.value) });
  zoomValue.textContent = `${Number(ev.target.value).toFixed(2)}×`;
  scheduleRender();
});

captionField.addEventListener('input', () => {
  state.setCaption(captionField.value);
  scheduleRender();
});
straplineField.addEventListener('input', () => {
  state.setStrapline(straplineField.value);
  scheduleRender();
});

for (const btn of document.querySelectorAll('[data-layout]')) {
  btn.addEventListener('click', () => {
    state.setLayout(btn.dataset.layout);
    scheduleRender();
  });
}
for (const btn of document.querySelectorAll('[data-grade]')) {
  btn.addEventListener('click', () => {
    state.setGrade(btn.dataset.grade);
    scheduleRender();
  });
}
for (const btn of document.querySelectorAll('[data-size]')) {
  btn.addEventListener('click', () => {
    state.setSize(Number(btn.dataset.size));
    sizePreview();
    scheduleRender();
  });
}

$('#spread').addEventListener('click', () => {
  state.spreadPhotos();
  scheduleRender();
});
$('#fill-all').addEventListener('click', () => {
  state.fillAll(state.get().crops[state.get().selected].photo);
  scheduleRender();
});
$('#reset-crop').addEventListener('click', () => {
  state.resetCrops();
  scheduleRender();
});
$('#prev-panel').addEventListener('click', () => {
  state.nextPanel(-1);
  scheduleRender();
});
$('#next-panel').addEventListener('click', () => {
  state.nextPanel(1);
  scheduleRender();
});

const exportButton = $('#export');
exportButton.addEventListener('click', () => {
  const size = SIZES[state.get().sizeIndex];
  const started = performance.now();
  const canvas = renderToCanvas(state.get(), size.w, size.h);
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `cover-${size.w}x${size.h}.png`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    const ms = Math.round(performance.now() - started);
    state.setStatus(`Saved cover-${size.w}x${size.h}.png · ${Math.round(blob.size / 1024)} KB · ${ms} ms.`);
  }, 'image/png');
  state.setStatus(`Rendering cover-${size.w}x${size.h}.png…`);
});

window.addEventListener('resize', () => {
  if (shotMode === 'poster') return;
  sizePreview();
  scheduleRender();
});

// Dropping photographs anywhere on the page loads them, same path as the picker.
window.addEventListener('dragover', (ev) => {
  ev.preventDefault();
  document.body.classList.add('dropping');
});
window.addEventListener('dragleave', (ev) => {
  if (ev.relatedTarget === null) document.body.classList.remove('dropping');
});
window.addEventListener('drop', (ev) => {
  ev.preventDefault();
  document.body.classList.remove('dropping');
  if (ev.dataTransfer?.files?.length) addFiles(ev.dataTransfer.files);
});

// ------------------------------------------------------------------ boot

/** The layout chooser's little panel diagram, drawn inline. */
function layoutGlyph(layout) {
  const panels = layout.panels
    .map((p, i) => {
      const fill = i === layout.hero ? 'currentColor' : 'none';
      const inset = 1.2;
      return `<rect x="${(p.x * 38 + 2).toFixed(1)}" y="${(p.y * 38 + 2).toFixed(1)}" width="${(p.w * 38 - inset).toFixed(1)}" height="${(p.h * 38 - inset).toFixed(1)}" fill="${fill}" stroke="currentColor" stroke-width="1.1" opacity="${i === layout.hero ? 0.85 : 0.6}"/>`;
    })
    .join('');
  const t = layout.title;
  const rule = `<rect x="${(t.x * 38 + 2).toFixed(1)}" y="${(t.y * 38 + 2 + t.h * 19).toFixed(1)}" width="${(t.w * 30).toFixed(1)}" height="1.3" fill="currentColor" opacity="0.45"/>`;
  return `<svg viewBox="0 0 42 42" width="32" height="32" aria-hidden="true">${panels}${rule}</svg>`;
}

function buildControls() {
  const gradeRow = $('#grade-row');
  for (const id of GRADE_ORDER) {
    const grade = GRADES[id];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'grade';
    btn.dataset.grade = id;
    btn.innerHTML = `<i class="swatch ${id}"></i><span>${grade.label}</span><em>${grade.note}</em>`;
    btn.addEventListener('click', () => {
      state.setGrade(id);
      scheduleRender();
    });
    gradeRow.append(btn);
  }

  const layoutRow = $('#layout-row');
  for (const id of LAYOUT_ORDER) {
    const layout = LAYOUTS[id];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layout';
    btn.dataset.layout = id;
    btn.innerHTML = `${layoutGlyph(layout)}<span>${layout.label}</span><em>${layout.note}</em>`;
    btn.addEventListener('click', () => {
      state.setLayout(id);
      scheduleRender();
    });
    layoutRow.append(btn);
  }

  const sizeRow = $('#size-row');
  SIZES.forEach((size, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.size = String(i);
    btn.className = 'size';
    btn.innerHTML = `<span>${size.label}</span><em>${size.label === 'Wide' ? '16:9' : size.label === 'Square' ? '1:1' : '4:5'}</em>`;
    btn.title = size.note;
    btn.addEventListener('click', () => {
      state.setSize(i);
      sizePreview();
      scheduleRender();
    });
    sizeRow.append(btn);
  });
}

/** Two animation frames and the fonts, then the flag the screenshot tool waits on. */
function ready() {
  return new Promise((resolve) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(async () => {
        try {
          await document.fonts.ready;
        } catch {
          /* fonts.ready is optional */
        }
        window.__shotReady = true;
        resolve();
      }),
    );
  });
}

/** Paste one finished canvas full-viewport into the shot stage. */
function showStage(canvas) {
  const stage = $('#poster-stage');
  stage.textContent = '';
  stage.append(canvas);
}

/** A `zoom`/`cx`/`cy` query triple, for the detail shot. */
function windowFromParams(defaults) {
  const raw = Number(params.get('zoom'));
  return {
    zoom: Number.isFinite(raw) && raw >= 1 ? Math.min(4, Math.round(raw)) : defaults.zoom,
    cx: params.has('cx') ? Number(params.get('cx')) : defaults.cx,
    cy: params.has('cy') ? Number(params.get('cy')) : defaults.cy,
  };
}

async function boot() {
  buildControls();
  state.subscribe(() => scheduleRender());

  if (shotMode === 'poster') {
    document.body.classList.add('poster-only');
    const size = await runShot(state, params);
    const cover = size ?? { w: SIZES[state.get().sizeIndex].w, h: SIZES[state.get().sizeIndex].h };
    showStage(renderToCanvas(state.get(), cover.w, cover.h));
    document.title = `cover-${cover.w}x${cover.h}.png`;
    await ready();
    return;
  }

  // The variants strip: four cells, each a real renderCover at its own layout, grade and size.
  if (shotMode === 'variants') {
    document.body.classList.add('poster-only');
    await runShot(state, params);
    const size = parseSize(params.get('strip')) ?? { w: 1440, h: 1030 };
    showStage(renderVariantsToCanvas(state.get(), size.w, size.h, VARIANTS));
    document.title = 'cover-variants.png';
    await ready();
    return;
  }

  // A 2x close-up of one window of the cover, for the ink and lettering detail.
  if (shotMode === 'detail') {
    document.body.classList.add('poster-only');
    const size = await runShot(state, params);
    const cover = size ?? { w: 1920, h: 1080 };
    const win = windowFromParams({ zoom: 2, cx: 0.34, cy: 0.55 });
    showStage(renderDetailToCanvas(state.get(), cover.w, cover.h, win.zoom, win.cx, win.cy));
    document.title = 'cover-detail.png';
    await ready();
    return;
  }

  if (shotMode === 'editor') {
    // The size a shot asks for wins over the default, so an editor screenshot can show the
    // 1080 x 1350 button live rather than only the square one.
    const asked = parseSize(params.get('size'));
    if (asked) state.setSize(sizeIndexOf(asked.w, asked.h));
    await runShot(state, params);
    renderThumbs();
    sizePreview();
    scheduleRender();
    if (!params.get('panel')) state.select(1);
    state.setStatus('Panel 2 selected — drag inside it to reframe, or use the arrow keys.');
    await ready();
    return;
  }

  // The ordinary app: open on the two samples so the first thing anyone sees is a finished cover.
  sizePreview();
  scheduleRender();
  const seed = await loadSamples(['pier', 'boulevard']);
  if (seed.length > 0) {
    seedPanels(state, seed);
    invalidateArt();
  }
  renderThumbs();
  scheduleRender();
  state.setStatus(seed.length ? 'Two samples loaded. Drop your own photos in, or press Export.' : 'Add a photo to begin.');
  await ready();
}

boot();
