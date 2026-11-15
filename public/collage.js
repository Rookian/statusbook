'use strict';
// Collages: two to four photos of the draft as one post, laid out by a template.
// A collage is stored like a text post (posts.data.texts) with
//   collage: { tpl, images: [{ name, fx, fy, zoom }], gap, round, bg }
// fx / fy: which part of a photo its cell shows (0…1, 0.5 = middle); zoom: 1…3.
// Photos in a collage are no posts of their own. Uses helpers from app.js and posts.js.

// Cells as fractions of the picture: [x, y, width, height].
const COLLAGE_TEMPLATES = [
  { id: 'rows2', n: 2, name: 'Two rows', cells: [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]] },
  { id: 'cols2', n: 2, name: 'Two columns', cells: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]] },
  { id: 'bigtop2', n: 2, name: 'Big on top', cells: [[0, 0, 1, 0.64], [0, 0.64, 1, 0.36]] },
  { id: 'bigbottom2', n: 2, name: 'Big at the bottom', cells: [[0, 0, 1, 0.36], [0, 0.36, 1, 0.64]] },
  { id: 'rows3', n: 3, name: 'Three rows', cells: [[0, 0, 1, 1 / 3], [0, 1 / 3, 1, 1 / 3], [0, 2 / 3, 1, 1 / 3]] },
  { id: 'top3', n: 3, name: 'One on top, two below', cells: [[0, 0, 1, 0.58], [0, 0.58, 0.5, 0.42], [0.5, 0.58, 0.5, 0.42]] },
  { id: 'bottom3', n: 3, name: 'Two on top, one below', cells: [[0, 0, 0.5, 0.42], [0.5, 0, 0.5, 0.42], [0, 0.42, 1, 0.58]] },
  { id: 'left3', n: 3, name: 'One left, two right', cells: [[0, 0, 0.58, 1], [0.58, 0, 0.42, 0.5], [0.58, 0.5, 0.42, 0.5]] },
  { id: 'right3', n: 3, name: 'Two left, one right', cells: [[0, 0, 0.42, 0.5], [0, 0.5, 0.42, 0.5], [0.42, 0, 0.58, 1]] },
  { id: 'grid4', n: 4, name: 'Two by two', cells: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]] },
  { id: 'top4', n: 4, name: 'One on top, three below', cells: [[0, 0, 1, 0.62], [0, 0.62, 1 / 3, 0.38], [1 / 3, 0.62, 1 / 3, 0.38], [2 / 3, 0.62, 1 / 3, 0.38]] },
  { id: 'left4', n: 4, name: 'One left, three right', cells: [[0, 0, 0.62, 1], [0.62, 0, 0.38, 1 / 3], [0.62, 1 / 3, 0.38, 1 / 3], [0.62, 2 / 3, 0.38, 1 / 3]] },
];
// Border: m = around the collage, g = between photos, r = rounded corners (all in px of 1080×1920).
const COLLAGE_GAPS = { none: { m: 0, g: 0, r: 0 }, thin: { m: 22, g: 14, r: 30 }, wide: { m: 52, g: 30, r: 46 } };
const COLLAGE_BGS = ['#ffffff', '#111111', '#f3ead9', '#12324a', '#0b7d78', '#e9b8a8'];
const COLLAGE_MAX = 4;

const collageTemplate = id => COLLAGE_TEMPLATES.find(t => t.id === id) || COLLAGE_TEMPLATES[0];
const collageNames = c => (c && Array.isArray(c.images) ? c.images.map(i => i.name) : []);
// Every photo that is part of a collage (and so no post of its own).
const collagePhotoNames = () => new Set(posts.data.texts.flatMap(t => collageNames(t.collage)));
// What a release remembers of a collage, to notice a later change.
const collageSig = c => JSON.stringify([c.tpl, c.gap, !!c.round, c.bg,
  c.images.map(i => [i.name, +(i.fx ?? 0.5).toFixed(3), +(i.fy ?? 0.5).toFixed(3), +(i.zoom || 1).toFixed(2),
    rotOf(i.name), Grade.gradeId(gradeOf(i.name)) || '', cropKey((itemOf(i.name) || {}).crop)])]);

// The cells of a collage in px of the 1080×1920 picture.
function collageRects(c) {
  const { m, g } = COLLAGE_GAPS[c.gap] || COLLAGE_GAPS.thin;
  const x0 = m - g / 2, y0 = m - g / 2, w0 = SW - 2 * m + g, h0 = SH - 2 * m + g;
  return collageTemplate(c.tpl).cells.map(([x, y, w, h]) => ({
    x: x0 + x * w0 + g / 2, y: y0 + y * h0 + g / 2, w: w * w0 - g, h: h * h0 - g,
  }));
}

// ---------- pictures ----------

// Loaded once per photo: small ones for the cards, the real ones for preview and release.
const collageImgs = new Map();
function collageImg(name, full) {
  const key = (full ? 'f|' : 't|') + name;
  let s = collageImgs.get(key);
  if (!s) {
    s = { loading: true };
    collageImgs.set(key, s);
    s.ready = new Promise(resolve => {
      const img = new Image();
      const done = ok => { if (ok) s.img = img; else s.error = true; s.loading = false; resolve(s); redrawCollages(); };
      img.onload = () => done(true);
      img.onerror = () => done(false);
      img.src = full ? mediaUrl({ name }) : `/thumb?name=${encodeURIComponent(name)}`;
    });
  }
  return s;
}

// All photos of a collage at real size (for the release file and the full-size view).
async function collageReady(c) {
  const states = await Promise.all(collageNames(c).map(n => collageImg(n, true).ready));
  const bad = c.images.find((im, i) => states[i].error);
  if (bad) throw new Error(`Could not load ${bad.name} for the collage`);
}

let collageRedraw = 0;
function redrawCollages() {
  cancelAnimationFrame(collageRedraw);
  collageRedraw = requestAnimationFrame(() => {
    for (const e of posts.entries) if (e.cfg && e.cfg.collage) refreshCard(e);
    const cur = curEntry();
    if (cur && cur.cfg && cur.cfg.collage) drawPostPreview();
    if ($('#collageDlg').open) drawCollageDlg();
  });
}

// How a photo (turned and cropped as in Pick) fills its cell: scale and what sticks out.
function collageFit(img, im, r) {
  const mw = img.naturalWidth, mh = img.naturalHeight;
  const rot = rotOf(im.name), side = rot % 180 !== 0;
  const it = itemOf(im.name);
  const oc = it && it.crop ? cropInOriginal(it.crop, rot) : { x: 0, y: 0, w: 1, h: 1 };
  const sw = oc.w * mw, sh = oc.h * mh;
  const dw = side ? sh : sw, dh = side ? sw : sh;
  const f = Math.max(r.w / dw, r.h / dh) * Math.min(3, Math.max(1, im.zoom || 1));
  return { mw, mh, rot, oc, sw, sh, f, overX: dw * f - r.w, overY: dh * f - r.h };
}

function drawCollage(ctx, c, scale = 1) {
  const gap = COLLAGE_GAPS[c.gap] || COLLAGE_GAPS.thin;
  ctx.fillStyle = c.bg || COLLAGE_BGS[0];
  ctx.fillRect(0, 0, SW, SH);
  const radius = c.round && gap.g ? gap.r : 0;
  collageRects(c).forEach((r, i) => {
    const im = c.images[i];
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, radius);
    ctx.clip();
    ctx.fillStyle = 'rgba(128, 128, 128, .3)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    let s = im && itemOf(im.name) ? collageImg(im.name, scale > 0.2) : null;
    if (s && s.error && scale <= 0.2) s = collageImg(im.name, true);  // no small picture: the real one
    if (s && s.img) {
      const k = collageFit(s.img, im, r);
      ctx.translate(r.x + r.w / 2 + (0.5 - (im.fx ?? 0.5)) * k.overX, r.y + r.h / 2 + (0.5 - (im.fy ?? 0.5)) * k.overY);
      ctx.rotate((k.rot * Math.PI) / 180);
      const grade = gradeOf(im.name);
      if (grade) ctx.filter = gradeCss(grade);
      ctx.drawImage(s.img, k.oc.x * k.mw, k.oc.y * k.mh, k.sw, k.sh, -k.sw * k.f / 2, -k.sh * k.f / 2, k.sw * k.f, k.sh * k.f);
    } else if (!s || s.error) {
      // An empty cell (in the dialog) or a photo that is gone.
      ctx.fillStyle = 'rgba(128, 128, 128, .9)';
      ctx.font = `600 ${Math.min(r.w, r.h) * 0.3}px ${POST_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(im ? '?' : String(i + 1), r.x + r.w / 2, r.y + r.h / 2);
    }
    ctx.restore();
  });
}

// ---------- the dialog ----------

// cd: the collage being made or changed. id: its text post when changing one.
let cd = null;

// A small picture of a template for its button.
function collageIcon(t) {
  const ns = 'http://www.w3.org/2000/svg', W = 27, H = 48, g = 2;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  for (const [x, y, w, h] of t.cells) {
    const r = document.createElementNS(ns, 'rect');
    r.setAttribute('x', x * (W + g) + 0);
    r.setAttribute('y', y * (H + g) + 0);
    r.setAttribute('width', Math.max(1, w * (W + g) - g));
    r.setAttribute('height', Math.max(1, h * (H + g) - g));
    r.setAttribute('rx', 2);
    svg.append(r);
  }
  return svg;
}

// The photos a collage can use: the draft's photo posts, and those already in it.
function collageChoices() {
  const names = new Set(cd.own);
  for (const e of posts.entries) if (e.type === 'image' && !e.removed && isNew(e)) names.add(e.source);
  return [...names].map(itemOf).filter(Boolean)
    .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function openCollage(entry = null) {
  if (!state.folder || !hasDraft()) { toast('Start a new release first (＋ New release)'); return; }
  if (entry && postStatus(entry.key).state === 'sent') { toast('Already sent; it can\'t be changed any more'); return; }
  const c = entry ? entry.cfg.collage : null;
  const sel = curEntry();
  cd = {
    id: entry ? entry.cfg.id : null,
    own: collageNames(c),
    tpl: c ? c.tpl : 'rows2',
    images: c ? c.images.map(i => ({ ...i })) : sel && sel.type === 'image' && isNew(sel) && !sel.removed ? [{ name: sel.source }] : [],
    gap: c ? c.gap : 'thin',
    round: c ? !!c.round : true,
    bg: c ? c.bg : COLLAGE_BGS[0],
  };
  if (!entry && collageChoices().length < 2) { cd = null; toast('A collage needs at least two photos in this release. Pick them first (P in Pick).'); return; }
  $('#collageTitle').textContent = entry ? 'Change collage' : 'New collage';
  $('#collageGo').textContent = entry ? 'Save' : 'Create collage';
  renderCollageDlg();
  $('#collageDlg').showModal();
}

function drawCollageDlg() {
  if (!cd) return;
  const canvas = $('#collageCanvas');
  const ctx = canvas.getContext('2d');
  const scale = canvas.width / SW;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, SW, SH);
  drawCollage(ctx, cd, 1);
}

function renderCollageDlg() {
  const n = cd.images.length, tpl = collageTemplate(cd.tpl);
  // Templates, grouped by how many photos they take.
  const box = $('#collageTemplates');
  box.replaceChildren();
  for (const count of [2, 3, 4]) {
    box.append(el('div', { class: 'ctgroup' },
      el('span', { class: 'muted' }, `${count} photos`),
      el('div', { class: 'ctrow' }, ...COLLAGE_TEMPLATES.filter(t => t.n === count).map(t => el('button', {
        class: 'ctpl' + (t.id === cd.tpl ? ' on' : ''), title: t.name,
        onclick: () => { cd.tpl = t.id; cd.images = cd.images.slice(0, t.n); renderCollageDlg(); },
      }, collageIcon(t))))));
  }
  // Photos: a click adds one (in that order) or takes it out again.
  const strip = $('#collagePhotos');
  strip.replaceChildren(...collageChoices().map(it => {
    const at = cd.images.findIndex(i => i.name === it.name);
    return el('button', {
      class: 'cphoto' + (at >= 0 ? ' on' : ''), title: it.name,
      onclick: () => {
        if (at >= 0) cd.images.splice(at, 1);
        else if (cd.images.length >= COLLAGE_MAX) { toast(`A collage takes at most ${COLLAGE_MAX} photos`); return; }
        else cd.images.push({ name: it.name });
        // The template follows the number of photos.
        const k = Math.max(2, cd.images.length);
        if (collageTemplate(cd.tpl).n !== k) cd.tpl = COLLAGE_TEMPLATES.find(t => t.n === k).id;
        renderCollageDlg();
      },
    },
    el('img', { src: `/thumb?name=${encodeURIComponent(it.name)}`, loading: 'lazy', alt: '', class: rotClass(it.rotate).trim() || null, style: mediaStyle(it) }),
    at >= 0 ? el('span', { class: 'cnum' }, String(at + 1)) : null);
  }));
  for (const b of $('#collageGap').children) b.classList.toggle('on', b.dataset.v === cd.gap);
  for (const b of $('#collageRound').children) b.classList.toggle('on', (b.dataset.v === 'round') === cd.round);
  $('#collageRoundField').hidden = cd.gap === 'none';
  $('#collageBgField').hidden = cd.gap === 'none';
  $('#collageBg').replaceChildren(...COLLAGE_BGS.map(c => el('button', {
    class: c === cd.bg ? 'on' : '', style: `background:${c}`, title: c, onclick: () => { cd.bg = c; renderCollageDlg(); },
  })));
  const missing = tpl.n - n;
  $('#collageHint').textContent = missing > 0
    ? `Click ${missing === 1 ? 'one more photo' : `${missing} more photos`} below for this layout.`
    : 'Drag a photo in the preview to move it in its frame, turn the mouse wheel over it to zoom.';
  $('#collageGo').disabled = missing !== 0;
  drawCollageDlg();
}

// Preview: drag moves a photo inside its cell, the wheel zooms it.
function collageCellAt(ev) {
  const box = $('#collageCanvas').getBoundingClientRect();
  const x = (ev.clientX - box.left) / box.width * SW, y = (ev.clientY - box.top) / box.height * SH;
  const i = collageRects(cd).findIndex(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  return i >= 0 && cd.images[i] ? { i, perPx: SW / box.width } : null;
}

function initCollageCanvas() {
  const canvas = $('#collageCanvas');
  let drag = null;
  canvas.addEventListener('pointerdown', ev => {
    const hit = cd && collageCellAt(ev);
    if (!hit) return;
    drag = { ...hit, x: ev.clientX, y: ev.clientY };
    canvas.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  canvas.addEventListener('pointermove', ev => {
    if (!drag) return;
    const im = cd.images[drag.i], s = collageImg(im.name, true);
    if (!s.img) return;
    const k = collageFit(s.img, im, collageRects(cd)[drag.i]);
    const clamp = v => Math.min(1, Math.max(0, v));
    if (k.overX > 1) im.fx = clamp((im.fx ?? 0.5) - (ev.clientX - drag.x) * drag.perPx / k.overX);
    if (k.overY > 1) im.fy = clamp((im.fy ?? 0.5) - (ev.clientY - drag.y) * drag.perPx / k.overY);
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    drawCollageDlg();
  });
  const end = () => { drag = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', ev => {
    const hit = cd && collageCellAt(ev);
    if (!hit) return;
    ev.preventDefault();
    const im = cd.images[hit.i];
    im.zoom = Math.min(3, Math.max(1, (im.zoom || 1) * (ev.deltaY < 0 ? 1.08 : 1 / 1.08)));
    drawCollageDlg();
  }, { passive: false });
}

function saveCollage() {
  const tpl = collageTemplate(cd.tpl);
  if (cd.images.length !== tpl.n) return;
  const collage = { tpl: cd.tpl, images: cd.images.map(i => ({ ...i })), gap: cd.gap, round: cd.round, bg: cd.bg };
  let t = cd.id ? posts.data.texts.find(x => x.id === cd.id) : null;
  if (t) {
    t.collage = collage;
  } else {
    // A new collage takes the place of its first photo in the order of the posts.
    const keys = collage.images.map(i => imgKey(i.name));
    const at = posts.entries.findIndex(e => keys.includes(e.key));
    const first = posts.entries[at], prev = posts.entries[at - 1];
    const after = !prev ? null : prev.kind === 'media' ? prev.key : prev.cfg.after || null;
    // The photos' captions become the collage's caption.
    const captions = [...new Set(collage.images.map(i => ((posts.data.media[imgKey(i.name)] || {}).caption || '').trim()).filter(Boolean))];
    t = { id: newPostId(), after, at: first ? first.time : '', text: '', caption: captions.join(' · '), bg: collage.bg, collage };
    let index = posts.data.texts.length;
    if (prev && prev.kind === 'text') index = posts.data.texts.indexOf(prev.cfg) + 1;
    else if (prev) { const k = posts.data.texts.findIndex(x => x.after === prev.key); if (k >= 0) index = k; }
    else index = 0;
    posts.data.texts.splice(index, 0, t);
    if (Array.isArray(posts.data.order) && first) {
      const k = posts.data.order.indexOf(first.key);
      if (k >= 0) posts.data.order[k] = `txt:${t.id}`;
    }
  }
  $('#collageDlg').close();
  cd = null;
  buildEntries();
  posts.selKey = `txt:${t.id}`;
  renderGallery();
  renderEditor();
  loadPostMedia();
  savePosts();
  if (state.mode !== 'arrange' && state.mode !== 'releases') return;
  toast('Collage saved. Its photos are no posts of their own any more.');
}

function initCollage() {
  initCollageCanvas();
  $('#collageCancel').addEventListener('click', () => { $('#collageDlg').close(); cd = null; });
  $('#collageDlg').addEventListener('close', () => { cd = null; });
  $('#collageGo').addEventListener('click', saveCollage);
  $('#collageGap').addEventListener('click', ev => {
    const b = ev.target.closest('button');
    if (b && cd) { cd.gap = b.dataset.v; renderCollageDlg(); }
  });
  $('#collageRound').addEventListener('click', ev => {
    const b = ev.target.closest('button');
    if (b && cd) { cd.round = b.dataset.v === 'round'; renderCollageDlg(); }
  });
}
