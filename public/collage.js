'use strict';
// Collages: two to four photos of the draft as one post, laid out by a template.
// A collage is stored like a text post (posts.data.texts) with
//   collage: { tpl, images: [{ name, fx, fy, zoom }], bg }
// fx / fy: which part of a photo its frame shows (0…1, 0.5 = middle); zoom: 1…3.
// Photos in a collage are no posts of their own. Uses helpers from app.js and posts.js.

// The Status picture (as SW × SH in posts.js, which is loaded after this file).
const CW = 1080, CH = 1920;

// A template is a list of frames on the 1080×1920 picture, drawn in order (later ones
// lie on top). A frame: { x, y: its centre; w, h: the photo's size; rot: degrees;
//   shape: 'rect' | 'circle' | 'arch' | 'hex' | 'poly' (pts: corners, not turned);
//   radius; mat: white card around the photo { t, r, b, l }; ring: white edge (px);
//   deco: [things drawn on top, in the frame's own coordinates] }
// under: drawn on the paper before the frames.
const polaroid = (x, y, size, rot, deco = []) => ({ x, y, w: size, h: size, rot, shape: 'rect', mat: { t: size * 0.06, r: size * 0.06, b: size * 0.22, l: size * 0.06 }, deco });
const tapeTop = (size, rot = -3, color) => ({ type: 'tape', x: 0, y: -size / 2 - size * 0.06, w: size * 0.38, h: size * 0.11, rot, color });
const pinTop = (h, pad = 0) => ({ type: 'pin', x: 0, y: -h / 2 - pad / 2 });
const polyFrame = pts => {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, rot: 0, shape: 'poly', pts };
};
// A point turned around the middle of the picture (for layouts that are tilted as a whole).
const turned = (x, y, deg) => {
  const a = deg * Math.PI / 180, dx = x - CW / 2, dy = y - CH / 2;
  return [CW / 2 + dx * Math.cos(a) - dy * Math.sin(a), CH / 2 + dx * Math.sin(a) + dy * Math.cos(a)];
};
const tiltedGrid = (() => {
  const deg = -8, w = 680, h = 1040, gap = 30;
  return [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([i, j]) => {
    const [x, y] = turned(CW / 2 + i * (w + gap) / 2, CH / 2 + j * (h + gap) / 2, deg);
    return { x, y, w, h, rot: deg, shape: 'rect', radius: 34 };
  });
})();
const filmFrames = (() => {
  const deg = -5;
  return [-610, 0, 610].map(dy => {
    const [x, y] = turned(CW / 2, CH / 2 + dy, deg);
    return { x, y, w: 640, h: 540, rot: deg, shape: 'rect', radius: 14 };
  });
})();

const COLLAGE_TEMPLATES = [
  { id: 'polaroids2', n: 2, name: 'Two polaroids', frames: [
    polaroid(450, 640, 640, -7, [tapeTop(640, -4)]),
    polaroid(640, 1330, 640, 6, [tapeTop(640, 5, 'rgba(160, 215, 205, .8)')]),
  ] },
  { id: 'postcard2', n: 2, name: 'Postcard', frames: [
    { x: CW / 2, y: CH / 2, w: CW, h: CH, rot: 0, shape: 'rect' },
    { x: 540, y: 1330, w: 800, h: 540, rot: -5, shape: 'rect', mat: { t: 30, r: 30, b: 30, l: 30 },
      deco: [{ type: 'stamp', x: 300, y: -200, s: 150 }, { type: 'postmark', x: 150, y: -215, s: 110 }] },
  ] },
  { id: 'diagonal2', n: 2, name: 'Diagonal cut', frames: [
    polyFrame([[0, 0], [CW, 0], [CW, 760], [0, 1130]]),
    polyFrame([[0, 1175], [CW, 805], [CW, CH], [0, CH]]),
  ] },
  { id: 'film3', n: 3, name: 'Film strip', under: 'film', frames: filmFrames },
  { id: 'scattered3', n: 3, name: 'Scattered polaroids', frames: [
    polaroid(370, 420, 520, -9, [pinTop(520, 520 * 0.06)]),
    polaroid(710, 940, 520, 7, [pinTop(520, 520 * 0.06)]),
    polaroid(390, 1450, 520, -4, [pinTop(520, 520 * 0.06)]),
  ] },
  { id: 'bands3', n: 3, name: 'Slanted bands', frames: [
    polyFrame([[0, 0], [CW, 0], [CW, 500], [0, 720]]),
    polyFrame([[0, 765], [CW, 545], [CW, 1155], [0, 1375]]),
    polyFrame([[0, 1420], [CW, 1200], [CW, CH], [0, CH]]),
  ] },
  { id: 'stack4', n: 4, name: 'Four polaroids', frames: [
    polaroid(320, 500, 440, -6, [tapeTop(440, -5)]),
    polaroid(770, 590, 440, 5, [tapeTop(440, 4, 'rgba(240, 170, 160, .8)')]),
    polaroid(310, 1310, 440, 4, [tapeTop(440, 3, 'rgba(160, 215, 205, .8)')]),
    polaroid(760, 1400, 440, -7, [tapeTop(440, -4)]),
  ] },
  { id: 'tilt4', n: 4, name: 'Tilted tiles', frames: tiltedGrid },
  { id: 'pinwall4', n: 4, name: 'Pin wall', frames: [
    { x: 540, y: 600, w: 860, h: 760, rot: -2, shape: 'rect', mat: { t: 28, r: 28, b: 28, l: 28 }, deco: [pinTop(760, 28)] },
    { x: 215, y: 1400, w: 290, h: 380, rot: -6, shape: 'rect', mat: { t: 18, r: 18, b: 18, l: 18 }, deco: [pinTop(380, 18)] },
    { x: 540, y: 1470, w: 290, h: 380, rot: 3, shape: 'rect', mat: { t: 18, r: 18, b: 18, l: 18 }, deco: [pinTop(380, 18)] },
    { x: 865, y: 1400, w: 290, h: 380, rot: 7, shape: 'rect', mat: { t: 18, r: 18, b: 18, l: 18 }, deco: [pinTop(380, 18)] },
  ] },
  { id: 'hex4', n: 4, name: 'Honeycomb', frames: [
    { x: 330, y: 410, w: 540, h: 620, rot: 0, shape: 'hex', ring: 14 },
    { x: 750, y: 780, w: 540, h: 620, rot: 0, shape: 'hex', ring: 14 },
    { x: 330, y: 1150, w: 540, h: 620, rot: 0, shape: 'hex', ring: 14 },
    { x: 750, y: 1520, w: 540, h: 620, rot: 0, shape: 'hex', ring: 14 },
  ] },
];
// Paper colours behind the photos.
const COLLAGE_BGS = ['#f3ead9', '#ffffff', '#d8b98f', '#12324a', '#0b7d78', '#e9b8a8', '#1a1a1a'];
const COLLAGE_MAX = 4;

const collageTemplate = id => COLLAGE_TEMPLATES.find(t => t.id === id) || COLLAGE_TEMPLATES[0];
const collageNames = c => (c && Array.isArray(c.images) ? c.images.map(i => i.name) : []);
// Every photo that is part of a collage (and so no post of its own).
const collagePhotoNames = () => new Set(posts.data.texts.flatMap(t => collageNames(t.collage)));
// What a release remembers of a collage, to notice a later change.
const collageSig = c => JSON.stringify([collageTemplate(c.tpl).id, c.bg,
  c.images.map(i => [i.name, +(i.fx ?? 0.5).toFixed(3), +(i.fy ?? 0.5).toFixed(3), +(i.zoom || 1).toFixed(2),
    rotOf(i.name), Grade.gradeId(gradeOf(i.name)) || '', cropKey((itemOf(i.name) || {}).crop)])]);

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

// How a photo (turned and cropped as in Pick) fills its frame: scale and what sticks out.
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

// The outline of a frame's photo, around its own middle; grow: that many px bigger.
function framePath(ctx, f, grow = 0) {
  const w = f.w + 2 * grow, h = f.h + 2 * grow;
  ctx.beginPath();
  if (f.shape === 'circle') {
    ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (f.shape === 'arch') {
    ctx.roundRect(-w / 2, -h / 2, w, h, [w / 2, w / 2, 20 + grow, 20 + grow]);
  } else if (f.shape === 'hex') {
    [[0, -0.5], [0.5, -0.25], [0.5, 0.25], [0, 0.5], [-0.5, 0.25], [-0.5, -0.25]]
      .forEach(([px, py], i) => ctx[i ? 'lineTo' : 'moveTo'](px * w, py * h));
    ctx.closePath();
  } else if (f.shape === 'poly') {
    f.pts.forEach(([px, py], i) => ctx[i ? 'lineTo' : 'moveTo'](px - f.x, py - f.y));
    ctx.closePath();
  } else {
    ctx.roundRect(-w / 2, -h / 2, w, h, (f.radius || 0) + grow);
  }
}

// Shadows are not scaled with the picture, so they get the scale themselves.
function collageShadow(ctx, k, on) {
  ctx.shadowColor = on ? 'rgba(0, 0, 0, .38)' : 'transparent';
  ctx.shadowBlur = on ? 44 * k : 0;
  ctx.shadowOffsetY = on ? 16 * k : 0;
}

// The paper: its colour, a soft light from the top and fine grain.
function drawCollagePaper(ctx, bg, k) {
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CW, CH);
  const light = ctx.createRadialGradient(CW * 0.3, CH * 0.15, 0, CW * 0.5, CH * 0.5, CH * 0.8);
  light.addColorStop(0, 'rgba(255, 255, 255, .22)');
  light.addColorStop(1, 'rgba(0, 0, 0, .12)');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, CW, CH);
  if (k < 0.2) return;  // too small to see on the cards
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 1400; i++) {
    ctx.fillStyle = i % 2 ? 'rgba(255, 255, 255, .10)' : 'rgba(0, 0, 0, .07)';
    ctx.fillRect(rnd() * CW, rnd() * CH, 2 + rnd() * 3, 2 + rnd() * 3);
  }
}

// A strip of film, tilted, behind the three frames of 'film3'.
function drawFilmStrip(ctx, k) {
  ctx.save();
  ctx.translate(CW / 2, CH / 2);
  ctx.rotate(-5 * Math.PI / 180);
  collageShadow(ctx, k, true);
  ctx.fillStyle = '#161616';
  ctx.fillRect(-420, -1200, 840, 2400);
  collageShadow(ctx, k, false);
  ctx.fillStyle = 'rgba(255, 255, 255, .88)';
  for (let y = -1180; y < 1200; y += 76) {
    for (const x of [-392, 348]) { ctx.beginPath(); ctx.roundRect(x, y, 44, 40, 8); ctx.fill(); }
  }
  ctx.restore();
}

// Things on top of a frame, in its own coordinates.
function drawCollageDeco(ctx, d, k) {
  ctx.save();
  ctx.translate(d.x, d.y);
  if (d.type === 'tape') {
    ctx.rotate((d.rot || 0) * Math.PI / 180);
    ctx.fillStyle = d.color || 'rgba(245, 222, 150, .82)';
    ctx.shadowColor = 'rgba(0, 0, 0, .18)';
    ctx.shadowBlur = 8 * k;
    ctx.shadowOffsetY = 3 * k;
    ctx.fillRect(-d.w / 2, -d.h / 2, d.w, d.h);
  } else if (d.type === 'pin') {
    ctx.shadowColor = 'rgba(0, 0, 0, .4)';
    ctx.shadowBlur = 10 * k;
    ctx.shadowOffsetY = 8 * k;
    ctx.fillStyle = '#d93a32';
    ctx.beginPath(); ctx.arc(0, 0, 20, 0, Math.PI * 2); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = 'rgba(255, 255, 255, .6)';
    ctx.beginPath(); ctx.arc(-6, -7, 6, 0, Math.PI * 2); ctx.fill();
  } else if (d.type === 'stamp') {
    const s = d.s, w = s, h = s * 1.2;
    ctx.rotate(4 * Math.PI / 180);
    ctx.shadowColor = 'rgba(0, 0, 0, .3)';
    ctx.shadowBlur = 10 * k;
    ctx.shadowOffsetY = 4 * k;
    ctx.fillStyle = '#fff';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.shadowColor = 'transparent';
    // Perforated edge.
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = s * 0.09;
    ctx.setLineDash([s * 0.07, s * 0.07]);
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.setLineDash([]);
    // Sea, sky and sun.
    const iw = w * 0.78, ih = h * 0.8;
    ctx.fillStyle = '#7fd0e0';
    ctx.fillRect(-iw / 2, -ih / 2, iw, ih);
    ctx.fillStyle = '#ffd24a';
    ctx.beginPath(); ctx.arc(iw * 0.15, -ih * 0.12, s * 0.16, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0b7d78';
    ctx.fillRect(-iw / 2, ih * 0.12, iw, ih * 0.38);
    ctx.strokeStyle = 'rgba(255, 255, 255, .85)';
    ctx.lineWidth = s * 0.03;
    for (const y of [0.24, 0.36]) {
      ctx.beginPath();
      for (let x = -iw / 2; x <= iw / 2; x += 4) ctx.lineTo(x, ih * y + Math.sin(x / (s * 0.07)) * s * 0.025);
      ctx.stroke();
    }
  } else if (d.type === 'postmark') {
    const s = d.s;
    ctx.strokeStyle = 'rgba(30, 40, 60, .6)';
    ctx.lineWidth = 5;
    for (const r of [s * 0.5, s * 0.36]) { ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke(); }
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      for (let x = s * 0.45; x <= s * 1.5; x += 4) ctx.lineTo(x, i * s * 0.16 + Math.sin(x / (s * 0.09)) * s * 0.035);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// k: the scale the picture is drawn at (for shadows); full: use the real photos.
function drawCollage(ctx, c, k = 1, full = k > 0.2) {
  const tpl = collageTemplate(c.tpl);
  drawCollagePaper(ctx, c.bg || COLLAGE_BGS[0], k);
  if (tpl.under === 'film') drawFilmStrip(ctx, k);
  tpl.frames.forEach((f, i) => {
    const im = c.images[i];
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate((f.rot || 0) * Math.PI / 180);
    // The white card or edge around the photo, with its shadow.
    if (f.mat) {
      collageShadow(ctx, k, true);
      ctx.fillStyle = '#fdfcf8';
      ctx.beginPath();
      ctx.roundRect(-f.w / 2 - f.mat.l, -f.h / 2 - f.mat.t, f.w + f.mat.l + f.mat.r, f.h + f.mat.t + f.mat.b, 6);
      ctx.fill();
      collageShadow(ctx, k, false);
    } else if (f.ring) {
      collageShadow(ctx, k, true);
      ctx.fillStyle = '#fdfcf8';
      framePath(ctx, f, f.ring);
      ctx.fill();
      collageShadow(ctx, k, false);
    }
    ctx.save();
    framePath(ctx, f);
    ctx.clip();
    ctx.fillStyle = '#c3cecb';
    ctx.fillRect(-f.w / 2, -f.h / 2, f.w, f.h);
    let s = im && itemOf(im.name) ? collageImg(im.name, full) : null;
    if (s && s.error && !full) s = collageImg(im.name, true);  // no small picture: the real one
    if (s && s.img) {
      const fit = collageFit(s.img, im, f);
      ctx.translate((0.5 - (im.fx ?? 0.5)) * fit.overX, (0.5 - (im.fy ?? 0.5)) * fit.overY);
      ctx.rotate((fit.rot * Math.PI) / 180);
      const grade = gradeOf(im.name);
      if (grade) ctx.filter = gradeCss(grade);
      ctx.drawImage(s.img, fit.oc.x * fit.mw, fit.oc.y * fit.mh, fit.sw, fit.sh, -fit.sw * fit.f / 2, -fit.sh * fit.f / 2, fit.sw * fit.f, fit.sh * fit.f);
    } else if (!s || s.error) {
      // An empty frame (in the dialog) or a photo that is gone.
      ctx.fillStyle = '#7f8f8b';
      ctx.font = `600 ${Math.min(f.w, f.h) * 0.3}px ${POST_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(im ? '?' : String(i + 1), 0, 0);
    }
    ctx.restore();
    for (const d of f.deco || []) drawCollageDeco(ctx, d, k);
    ctx.restore();
  });
}

// ---------- the dialog ----------

// cd: the collage being made or changed. id: its text post when changing one.
let cd = null;

// A small picture of a template for its button: the layout with empty frames.
function collageIcon(t) {
  const c = el('canvas', { width: 81, height: 144 });
  const ctx = c.getContext('2d');
  ctx.setTransform(c.width / CW, 0, 0, c.width / CW, 0, 0);
  drawCollage(ctx, { tpl: t.id, images: [], bg: COLLAGE_BGS[0] }, c.width / CW, false);
  return c;
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
    tpl: c ? collageTemplate(c.tpl).id : COLLAGE_TEMPLATES[0].id,
    images: c ? c.images.map(i => ({ ...i })) : sel && sel.type === 'image' && isNew(sel) && !sel.removed ? [{ name: sel.source }] : [],
    bg: c && c.bg ? c.bg : COLLAGE_BGS[0],
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
  const scale = canvas.width / CW;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, CW, CH);
  drawCollage(ctx, cd, scale, true);
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
      }, collageIcon(t), el('span', {}, t.name))))));
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

// Preview: drag moves a photo inside its frame, the wheel zooms it.
const unturn = (dx, dy, deg) => {
  const a = -deg * Math.PI / 180;
  return [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
};
const inPoly = (pts, x, y) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

// The topmost frame with a photo under the pointer.
function collageFrameAt(ev) {
  const box = $('#collageCanvas').getBoundingClientRect();
  const x = (ev.clientX - box.left) / box.width * CW, y = (ev.clientY - box.top) / box.height * CH;
  const frames = collageTemplate(cd.tpl).frames;
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    const [lx, ly] = unturn(x - f.x, y - f.y, f.rot || 0);
    const hit = f.shape === 'poly' ? inPoly(f.pts, x, y) : Math.abs(lx) <= f.w / 2 && Math.abs(ly) <= f.h / 2;
    if (hit) return cd.images[i] ? { i, f, perPx: CW / box.width } : null;
  }
  return null;
}

function initCollageCanvas() {
  const canvas = $('#collageCanvas');
  let drag = null;
  canvas.addEventListener('pointerdown', ev => {
    const hit = cd && collageFrameAt(ev);
    if (!hit) return;
    drag = { ...hit, x: ev.clientX, y: ev.clientY };
    canvas.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  canvas.addEventListener('pointermove', ev => {
    if (!drag) return;
    const im = cd.images[drag.i], s = collageImg(im.name, true);
    if (!s.img) return;
    const k = collageFit(s.img, im, drag.f);
    const clamp = v => Math.min(1, Math.max(0, v));
    // The move as seen in the (maybe tilted) frame.
    const [dx, dy] = unturn((ev.clientX - drag.x) * drag.perPx, (ev.clientY - drag.y) * drag.perPx, drag.f.rot || 0);
    if (k.overX > 1) im.fx = clamp((im.fx ?? 0.5) - dx / k.overX);
    if (k.overY > 1) im.fy = clamp((im.fy ?? 0.5) - dy / k.overY);
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    drawCollageDlg();
  });
  const end = () => { drag = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', ev => {
    const hit = cd && collageFrameAt(ev);
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
  const collage = { tpl: cd.tpl, images: cd.images.map(i => ({ ...i })), bg: cd.bg };
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
}
