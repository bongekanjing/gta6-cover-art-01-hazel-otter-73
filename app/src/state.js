// state.js — the editor's one place of truth.
//
// Everything the editor knows lives here: the loaded photographs, a per-panel crop (which photo,
// zoom, focal point), the caption and strapline, the layout, the grade and the export size.
// Controls read it, panels write it, and both are refreshed by the same subscribe-and-notify
// call, so a control and the preview can never disagree.

import { LAYOUTS } from './panels.js';
import { GRADE_ORDER } from './ink.js';

export const SIZES = [
  { w: 1080, h: 1080, label: 'Square', note: '1080 × 1080' },
  { w: 1080, h: 1350, label: 'Portrait', note: '1080 × 1350' },
  { w: 1920, h: 1080, label: 'Wide', note: '1920 × 1080' },
];

const DEFAULT_CAPTION = 'Pier Pressure';
const DEFAULT_STRAPLINE = 'The tide always comes back for its money';

/** The most panels any layout has: crops are kept per slot, beyond a layout's own count. */
const SLOTS = 5;

/** A crop at its neutral framing. */
function blankCrop(photo = 0) {
  return { photo, zoom: 1, fx: 0.5, fy: 0.5 };
}

const clampCrop = (crop) => {
  if (!crop) return;
  crop.zoom = Math.max(1, Math.min(3, Number(crop.zoom) || 1));
  crop.fx = Math.max(0, Math.min(1, Number(crop.fx)));
  crop.fy = Math.max(0, Math.min(1, Number(crop.fy)));
};

export function createState() {
  const listeners = new Set();
  const data = {
    photos: [],
    crops: Array.from({ length: SLOTS }, (_, i) => blankCrop(i > 1 ? i % 2 : 0)),
    selected: 0,
    caption: DEFAULT_CAPTION,
    strapline: DEFAULT_STRAPLINE,
    layout: 'classic',
    grade: 'dusk',
    sizeIndex: 0,
    showGuides: true,
    status: 'Ready.',
    renders: 0,
  };

  const notify = () => {
    data.renders++;
    for (const fn of listeners) fn(data);
  };

  const panelCount = () => (LAYOUTS[data.layout] ?? LAYOUTS.classic).panels.length;

  return {
    /** The live state object: read freely, write only through the methods below. */
    get() {
      return data;
    },

    subscribe(fn) {
      listeners.add(fn);
      fn(data);
      return () => listeners.delete(fn);
    },

    /** Re-notify after a direct mutation (the file loader fills `photos` this way once). */
    touch: notify,

    panelCount,

    addPhotos(list) {
      for (const entry of list) data.photos.push(entry);
      notify();
    },

    /** Remove a photo, keeping every panel pointing at a photo that still exists. */
    removePhoto(index) {
      if (data.photos.length <= 1) return;
      data.photos.splice(index, 1);
      for (const crop of data.crops) {
        if (crop.photo === index) crop.photo = 0;
        else if (crop.photo > index) crop.photo--;
      }
      notify();
    },

    select(index) {
      const count = panelCount();
      const next = ((index % count) + count) % count;
      if (data.selected === next) return;
      data.selected = next;
      notify();
    },

    nextPanel(delta) {
      this.select(data.selected + delta);
    },

    setCrop(index, patch) {
      const crop = data.crops[index];
      if (!crop) return;
      Object.assign(crop, patch);
      clampCrop(crop);
      notify();
    },

    /** Move the selected panel's focal point by a fraction of the panel, clamped. */
    nudge(dx, dy) {
      const crop = data.crops[data.selected];
      if (!crop) return;
      this.setCrop(data.selected, { fx: crop.fx + dx * 0.03, fy: crop.fy + dy * 0.03 });
    },

    /** One photo per panel, cycling, around the middle of each photo. */
    spreadPhotos() {
      if (data.photos.length === 0) return;
      for (let i = 0; i < panelCount(); i++) {
        data.crops[i] = blankCrop(i % data.photos.length);
      }
      notify();
    },

    /** Put the selected panel's photo in every panel of this layout. */
    fillAll(photoIndex) {
      for (let i = 0; i < panelCount(); i++) {
        data.crops[i] = blankCrop(photoIndex);
      }
      notify();
    },

    setCaption(text) {
      data.caption = text;
      notify();
    },

    setStrapline(text) {
      data.strapline = text;
      notify();
    },

    setLayout(name) {
      if (!LAYOUTS[name] || data.layout === name) return;
      const was = panelCount();
      data.layout = name;
      const now = LAYOUTS[name].panels.length;
      // Slots the new layout adds have never been framed. Give each the photo the ones before it
      // ended on, at the middle of that photo, so a switch to Grid 5 shows five pictures rather
      // than two framed and three arbitrary leftovers.
      for (let i = was; i < now; i++) {
        const last = data.crops[Math.max(0, was - 1)] ?? blankCrop(0);
        data.crops[i] = blankCrop(data.photos.length ? last.photo % data.photos.length : 0);
      }
      data.selected = Math.min(data.selected, now - 1);
      notify();
    },

    setGrade(name) {
      if (!GRADE_ORDER.includes(name) || data.grade === name) return;
      data.grade = name;
      notify();
    },

    setSize(index) {
      const next = Math.max(0, Math.min(SIZES.length - 1, index));
      if (data.sizeIndex === next) return;
      data.sizeIndex = next;
      notify();
    },

    setStatus(text) {
      data.status = text;
      notify();
    },

    resetCrops() {
      for (let i = 0; i < panelCount(); i++) {
        data.crops[i] = blankCrop(data.photos.length ? i % data.photos.length : 0);
      }
      notify();
    },
  };
}

/** The size button a W x H pair names, or the square by default. */
export function sizeIndexOf(w, h) {
  const at = SIZES.findIndex((s) => s.w === w && s.h === h);
  return at < 0 ? 0 : at;
}
