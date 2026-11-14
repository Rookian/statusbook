'use strict';
// Releases and Arrange: WhatsApp Status posts, sorted by time. Every photo picked and
// every scene marked for the draft is a post automatically; its words go into the
// WhatsApp caption, the picture stays clean. Text-only posts (text drawn
// on a colored background) can be inserted anywhere. "Create release" writes the
// numbered files into WhatsApp\Releases. Uses the helpers and `state` from app.js.
//
// _posts.json (version 2):
//   defaults: look of new text posts
//   media:    per photo/scene, keyed "img:<name>" / "vid:<name>@<start>-<end>":
//             { caption, removed }
//   texts:    text-only posts in order: { id, after: <media key or null>, at, text, caption, bg, ... }
//   order:    every post key in the chosen order, once posts were rearranged
// A post's status follows from the release folders: not prepared yet, prepared (in a
// release part) or sent (ticked in that part's release.json).

const SW = 1080, SH = 1920;     // Status format, 9:16
const PREVIEW_SCALE = 1 / 3;    // editor preview canvas is 360×640
const CARD_SCALE = 2 / 15;      // gallery text layer is 144×256
const TEXT_SIZES = { s: 56, m: 80, l: 112 };
const BG_COLORS = ['#1e88e5', '#43a047', '#e53935', '#8e24aa', '#f4511e', '#00897b', '#3949ab', '#212121'];
const POST_FONT = '"Segoe UI", "Segoe UI Emoji", system-ui, sans-serif';
const LOOK_FIELDS = ['position', 'style', 'size'];
const DEFAULT_LOOK = { position: 'bottom', style: 'shadow', size: 'm' };
const TEXT_POST_LOOK = { position: 'middle', style: 'shadow', size: 'l' };
const NEARBY_PHOTO_MIN = 30;    // a video without location borrows it from a photo this close in time
// Day intro: the map sits below the date, 960×1200 (Google map 480×600 at scale 2).
const MAP_BOX = { x: 60, y: 520, w: 960, h: 1200 };
const INTRO_BG = '#12324a';

const posts = {
  data: emptyPostsData(),
  folder: null,     // folder the data belongs to
  entries: [],      // gallery order, rebuilt from state.items + data
  selKey: null,
  showRemoved: false,
  releases: [],      // from the release folders (WhatsApp\Releases), see server.js
  limits: { maxPosts: 30, maxVideoSeconds: 90, maxVideoMB: 9.9, maxVideoSide: 1920, maxImageSide: 2560 },
  media: null,      // loaded <img> or <video> for the selected post
  mediaKey: null,
  raf: 0,
  saveTimer: null,
  places: new Map(), // "lat,lon" -> place (or null while unknown)
  nearby: new Map(), // "lat,lon" -> { sights, towns } around a spot (or null while unknown)
  dayMaps: new Map(), // map URL -> { img, error, loading } for day intros
  googleKey: false,  // whether a Google Maps key is saved (the key itself stays on the server)
  ai: { saved: false, provider: 'anthropic', model: '', providers: {} }, // animal identification (key stays on the server)
  species: new Map(), // post key -> { animals, t, ... } (or null while unknown)
};

function emptyPostsData() {
  return { version: 2, defaults: { ...DEFAULT_LOOK }, media: {}, texts: [] };
}

const pad2 = n => String(n).padStart(2, '0');
const newPostId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const imgKey = name => `img:${name}`;
const sceneKey = (name, sc) => `vid:${name}@${sc.start.toFixed(2)}-${sc.end.toFixed(2)}`;
// Length in the release: a slow-motion scene (speed < 1) gets longer.
const postLen = e => (e.type === 'video' ? (e.end - e.start) / (e.speed || 1) : 0);
const curEntry = () => posts.entries.find(e => e.key === posts.selKey) || null;
const exportEntries = () => posts.entries.filter(e => !e.removed);
// Removed posts are only shown with "Show removed".
const visibleEntries = () => posts.entries.filter(e => posts.showRemoved || !e.removed);
const isNew = e => postStatus(e.key).state === 'new';
const entryFor = key => posts.entries.find(e => e.key === key) || null;

function nowStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const shortDate = s => parseStamp(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
// Releases are numbered in the order they were made: "1", "2", … (the folder names
// keep their date, "2026-10-26 release 1").
function releaseTitle(name) {
  const i = posts.releases.findIndex(r => r.release === name);
  return i >= 0 ? String(i + 1) : `${shortDate(name.slice(0, 10))} #${name.split(' ').pop()}`;
}
// The draft: the one release being put together, before its files are made. Its
// posts are the posts in no release yet; "Create release" turns them into one.
const hasDraft = () => !!posts.data.draft;
const draftTitle = () => `Release ${posts.releases.length + 1}`;

// state: "new" (not prepared yet), "prepared" (in a release, not
// sent) or "sent". A post can have several files in a release (long videos are
// split); it counts as sent when all of them are.
function postStatus(key) {
  let prepared = null, sentAt = null;
  for (const r of posts.releases) {
    // All pieces of the post in this release, across its parts: a long video can
    // start in one part and end in the next.
    const mine = [];
    for (const p of r.parts) {
      for (const i of p.items) {
        if (i.postKey !== key) continue;
        mine.push(i);
        if (!prepared || prepared.release !== r.release) prepared = { release: r.release, part: p.part };
      }
    }
    if (mine.length && mine.every(i => i.sentAt)) {
      const last = mine.map(i => i.sentAt).sort().pop();
      if (!sentAt || last > sentAt) sentAt = last;
    }
  }
  return { prepared, sentAt, state: sentAt ? 'sent' : prepared ? 'prepared' : 'new' };
}

// Every file of a post in the releases: [{ r, p, item }].
function releasePlaces(key) {
  const out = [];
  for (const r of posts.releases) {
    for (const p of r.parts) for (const item of p.items) if ((item.postKey || item.key) === key) out.push({ r, p, item });
  }
  return out;
}

// What changed in a post since its file in a release (not sent yet) was made:
// ["caption"], ["picture"], both, or null. Parts already sent are never compared.
function releaseChanges(item, e = entryFor(item.postKey || item.key)) {
  if (!e || item.sentAt) return null;
  const v = postView(e);
  const first = !item.piece || item.piece.startsWith('1/');
  const out = [];
  if ((item.caption || '') !== (first ? fullCaption(e, v) : '')) out.push('caption');
  let picture = false;
  if (e.type === 'text') {
    picture = (item.text || '') !== v.text.trim() || (!!item.bg && item.bg !== v.bg) ||
      (!!item.look && ['position', 'style', 'size'].some(k => item.look[k] !== v[k]));
    if (v.intro && item.intro) {
      picture = picture || (item.intro.place || '') !== (e.cfg.place ? e.cfg.place.label : '') ||
        !!item.intro.noLocation !== !!e.cfg.noLocation;
    }
  } else if (item.format) {
    picture = item.format !== 'original';  // an old file with a blurred background
  }
  if (e.kind === 'media' && (item.rotate || 0) !== rotOf(e.source)) picture = true; // turned since
  if (e.type === 'video' && (item.speed || 1) !== (e.speed || 1)) picture = true;    // speed changed
  if (picture) out.push('picture');
  return out.length ? out : null;
}

function addSeconds(stampStr, secs) {
  if (!stampStr) return '';
  const d = new Date(parseStamp(stampStr).getTime() + Math.round(secs * 1000));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// ---------- building the gallery ----------

// Old format (version 1): one explicit list. Photo/video posts become media
// entries; text posts are anchored to the media post before them.
function migratePosts(d) {
  if (!d) return emptyPostsData();
  const data = d.version === 2 ? { ...emptyPostsData(), ...d } : migrateV1(d);
  // Batches (exports from before releases) are no longer kept.
  if (data.batches) {
    delete data.batches;
    posts.dropped = true;
  }
  // Photo and video posts used to have text on the picture; it now belongs in the caption.
  for (const cfg of Object.values(data.media)) {
    if ((cfg.text || '').trim()) {
      cfg.caption = [(cfg.caption || '').trim(), cfg.text.trim()].filter(Boolean).join('\n');
      posts.migrated = true;
    }
    delete cfg.text;
    // Blurred background was removed: every photo and video keeps its original format.
    delete cfg.fill;
  }
  delete data.defaults.fill;
  return data;
}

function migrateV1(d) {
  const data = emptyPostsData();
  let lastKey = null;
  for (const p of Array.isArray(d.posts) ? d.posts : []) {
    const own = {};
    for (const f of ['text', 'caption', ...LOOK_FIELDS]) if (p[f] !== undefined) own[f] = p[f];
    if (p.type === 'text') {
      data.texts.push({ id: p.id || newPostId(), after: lastKey, ...own, bg: p.bg });
    } else if (p.source) {
      lastKey = p.type === 'image' ? imgKey(p.source) : sceneKey(p.source, p);
      data.media[lastKey] = { ...own, removed: !!p.off };
    }
  }
  return data;
}

function buildEntries() {
  const media = [];
  for (const it of state.items) {
    if (it.type === 'image' && it.favorite) {
      media.push({ kind: 'media', type: 'image', key: imgKey(it.name), source: it.name, item: it, start: 0, time: it.date || '' });
    } else if (it.type === 'video') {
      it.scenes.forEach((sc, i) => media.push({
        kind: 'media', type: 'video', key: sceneKey(it.name, sc), source: it.name, item: it,
        start: sc.start, end: sc.end, speed: sc.speed || 1, sceneNo: i + 1, time: addSeconds(it.date, sc.start),
      }));
    }
  }
  media.sort((a, b) => (a.time || '9999').localeCompare(b.time || '9999') ||
    a.source.localeCompare(b.source, undefined, { numeric: true }) || a.start - b.start);
  for (const m of media) {
    m.cfg = posts.data.media[m.key] || {};
    m.removed = !!m.cfg.removed;
  }

  // Text posts go after their anchor. If the anchor is gone (unstarred, scene
  // changed), they go after the last post taken at or before their time.
  const begin = [], after = new Map();
  const keys = new Set(media.map(m => m.key));
  for (const t of posts.data.texts) {
    let anchor = t.after && keys.has(t.after) ? t.after : null;
    if (!anchor && t.after) {
      const prev = [...media].reverse().find(m => (m.time || '') <= (t.at || ''));
      anchor = prev ? prev.key : null;
    }
    const entry = { kind: 'text', type: 'text', key: `txt:${t.id}`, cfg: t, removed: false };
    if (anchor) (after.get(anchor) || after.set(anchor, []).get(anchor)).push(entry);
    else begin.push(entry);
  }
  let out = [...begin];
  for (const m of media) out.push(m, ...(after.get(m.key) || []));
  if (Array.isArray(posts.data.order)) out = applyCustomOrder(out);
  // Text posts take the time of what comes before them, for the day headers.
  let lastTime = media.length ? media[0].time : '';
  for (const e of out) {
    if (e.kind === 'media') lastTime = e.time;
    // A day intro belongs to its own day, even though it comes after the previous day's last post.
    else e.time = e.cfg.intro ? `${e.cfg.intro.day}T00:00:00` : lastTime;
  }
  posts.entries = out;
}

// Once posts were rearranged, data.order holds every post key in the chosen order.
// Posts not in it yet (newly starred, new scene, new text post) go right after the
// post in front of them in time order, so they land next to their neighbors.
function applyCustomOrder(timeOrder) {
  const byKey = new Map(timeOrder.map(e => [e.key, e]));
  const result = posts.data.order.filter(k => byKey.has(k)).map(k => byKey.get(k));
  const placed = new Set(result.map(e => e.key));
  timeOrder.forEach((e, i) => {
    if (placed.has(e.key)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = result.findIndex(x => x.key === timeOrder[j].key);
      if (k >= 0) { at = k + 1; break; }
    }
    result.splice(at, 0, e);
    placed.add(e.key);
  });
  posts.data.order = result.map(e => e.key);
  return result;
}

// Moves a post in front of (after = false) or behind (after = true) another one.
function movePost(key, targetKey, after) {
  if (key === targetKey) return;
  const keys = posts.entries.map(e => e.key);
  keys.splice(keys.indexOf(key), 1);
  const t = keys.indexOf(targetKey);
  if (t < 0) return;
  keys.splice(after ? t + 1 : t, 0, key);
  posts.data.order = keys;
  buildEntries();
  renderGallery();
  renderEditor();
  savePosts();
}

// Earlier/later by one among the posts not released yet (released files keep their numbers).
function stepPost(dir) {
  const e = curEntry();
  if (e && !isNew(e)) { toast('Posts in a release keep their order'); return; }
  const list = visibleEntries().filter(isNew);
  const i = list.indexOf(e);
  const target = list[i + dir];
  if (!e || !target) return;
  movePost(e.key, target.key, dir > 0);
}

// What a post looks like: its own settings over the shared defaults.
function postView(e) {
  const base = e.type === 'text' ? TEXT_POST_LOOK : { ...DEFAULT_LOOK, ...posts.data.defaults };
  // Only text-only posts have text on the picture.
  const v = { type: e.type, text: e.type === 'text' ? e.cfg.text || '' : '', caption: e.cfg.caption || '', bg: e.cfg.bg };
  for (const f of LOOK_FIELDS) v[f] = e.cfg[f] !== undefined ? e.cfg[f] : base[f];
  // Day intro: fixed layout, the date on top and the map below it.
  // Without any location there is no map, so the date moves to the middle.
  if (e.cfg.intro) {
    Object.assign(v, { intro: e.cfg.intro, size: 'l', style: 'shadow', bg: e.cfg.bg || INTRO_BG,
      position: dayPins(e.cfg.intro.day).length ? 'top' : 'middle' });
  }
  return v;
}

// The stored object for a post, created on first change.
function cfgFor(e) {
  if (e.kind === 'text') return e.cfg;
  if (!posts.data.media[e.key]) posts.data.media[e.key] = {};
  e.cfg = posts.data.media[e.key];
  return e.cfg;
}

// ---------- drawing (shared by gallery, preview and export) ----------

function mediaSize(m) {
  return m instanceof HTMLVideoElement ? [m.videoWidth, m.videoHeight] : [m.naturalWidth, m.naturalHeight];
}

function drawBackground(ctx, post, media, scale) {
  if (post.type === 'text') {
    ctx.fillStyle = post.bg || BG_COLORS[0];
    ctx.fillRect(0, 0, SW, SH);
    // A day without any location gets just the date, without an empty map box.
    if (post.intro && dayPins(post.intro.day).length) drawDayMap(ctx, post.intro.day, scale);
    return;
  }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, SW, SH);
  if (!media) return;
  const [mw, mh] = mediaSize(media);
  if (!mw || !mh) return;
  // media.rot: the file's turn (R in Pick), set when it was loaded.
  const rot = media.rot || 0, side = rot % 180 !== 0;
  const f = side ? Math.min(SW / mh, SH / mw) : Math.min(SW / mw, SH / mh);
  ctx.save();
  ctx.translate(SW / 2, SH / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(media, -mw * f / 2, -mh * f / 2, mw * f, mh * f);
  ctx.restore();
}

// A photo drawn turned onto a new canvas, scaled by f.
function turnedCanvas(img, rot, f = 1) {
  const w = Math.round(img.naturalWidth * f), h = Math.round(img.naturalHeight * f);
  const side = rot % 180 !== 0;
  const c = document.createElement('canvas');
  c.width = side ? h : w;
  c.height = side ? w : h;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  return c;
}

// Called by app.js after a file was turned: cards and the post preview follow.
function onRotated(it) {
  if (posts.media && curEntry() && curEntry().source === it.name) { posts.media.rot = it.rotate || 0; drawPostPreview(); }
  if (typeof renderGallery === 'function' && inPostsView()) renderGallery({ reveal: false });
}

// ---------- day intro maps ----------

// The pins of a day's map: the locations from its files, or else the place typed in
// for the intro; none if the location was left out.
function dayPins(day) {
  const t = introFor(day);
  if (t && t.noLocation) return [];
  const pins = autoDayPins(day);
  if (!pins.length && t && t.place) pins.push({ lat: t.place.lat, lon: t.place.lon });
  return pins;
}

// Every location from the photos and videos of that day (not only the starred
// ones), with spots closer than about 10 m merged into one pin.
function autoDayPins(day) {
  const seen = new Set(), pins = [];
  const byTime = state.items.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  for (const it of byTime) {
    if (!it.geo || !(it.date || '').startsWith(day)) continue;
    const k = `${it.geo.lat.toFixed(4)},${it.geo.lon.toFixed(4)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pins.push(it.geo);
  }
  return pins.slice(0, 80);
}

const dayMapUrl = day => {
  const pins = dayPins(day);
  return pins.length ? `/daymap?w=${MAP_BOX.w / 2}&h=${MAP_BOX.h / 2}&p=${pins.map(p => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join('|')}` : null;
};

// Loads the map once; when it arrives, the intro cards and the preview are redrawn.
function dayMapState(day) {
  const url = dayMapUrl(day);
  if (!url) return { none: true };
  let s = posts.dayMaps.get(url);
  if (!s) {
    s = { loading: true };
    posts.dayMaps.set(url, s);
    s.ready = new Promise(resolve => {
      const img = new Image();
      img.onload = () => { s.img = img; s.loading = false; resolve(s); redrawIntros(day); };
      img.onerror = async () => {
        // The server answers errors as JSON (e.g. the API is not turned on for the key).
        try { s.error = (await (await fetch(url)).json()).error; } catch { s.error = 'Could not load the map'; }
        s.loading = false;
        resolve(s);
        redrawIntros(day);
      };
      img.src = url;
    });
  }
  return s;
}

function redrawIntros(day) {
  for (const e of posts.entries) if (e.cfg && e.cfg.intro && e.cfg.intro.day === day) refreshCard(e);
  const cur = curEntry();
  if (cur && cur.cfg.intro && cur.cfg.intro.day === day) { drawPostPreview(); renderEditor(); }
}

function drawDayMap(ctx, day, scale) {
  const { x, y, w, h } = MAP_BOX;
  const s = dayMapState(day);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 36);
  ctx.clip();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.fillRect(x, y, w, h);
  if (s.img) {
    ctx.drawImage(s.img, x, y, w, h);
  } else {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.font = `600 44px ${POST_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const msg = s.none ? 'Keine Orte an diesem Tag' : s.error ? 'Karte nicht verfügbar' : 'Karte wird geladen …';
    ctx.fillText(msg, x + w / 2, y + h / 2);
  }
  ctx.restore();
}

// Pins for the own map page's link: Google's polyline encoding (lat/lon × 1e5, delta,
// zigzag, 5-bit chunks) with the URL-safe alphabet, so WhatsApp keeps the link whole.
// docs/map/index.html (the page on GitHub Pages) decodes it.
const PIN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function encodePins(pins) {
  let out = '', lat = 0, lon = 0;
  const put = d => {
    let v = d < 0 ? ~(d << 1) : d << 1;
    while (v >= 32) { out += PIN_ALPHABET[(v & 31) | 32]; v >>>= 5; }
    out += PIN_ALPHABET[v];
  };
  for (const p of pins) {
    const a = Math.round(p.lat * 1e5), o = Math.round(p.lon * 1e5);
    put(a - lat); put(o - lon);
    lat = a; lon = o;
  }
  return out;
}

// Map link for a day intro's caption (the intro itself is an image, so its link has to
// be in the caption). One place: a Google Maps link with exactly that pin. Several:
// with "mapPageUrl" in settings.json, the own map page with every pin of the day,
// numbered in time order; without it, Google Maps on the day's area (a plain Google
// link can't carry many pins).
function dayMapLink(day) {
  const pins = dayPins(day);
  if (!pins.length) return null;
  const f = n => n.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
  if (pins.length === 1) return `https://www.google.com/maps/search/?api=1&query=${f(pins[0].lat)},${f(pins[0].lon)}`;
  if (state.mapPageUrl) {
    const t = introFor(day);
    const title = [germanDay(day), t && t.place && t.place.label].filter(Boolean).join(' · ');
    return `${state.mapPageUrl.replace(/#.*$/, '')}#t=${encodeURIComponent(title)}&p=${encodePins(pins)}`;
  }
  const lats = pins.map(p => p.lat), lons = pins.map(p => p.lon);
  const [s, n, w, e] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  // Web Mercator: the largest zoom at which the spots fit into ~360×640 px (portrait phone).
  const y = lat => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  let zoom = 15;
  while (zoom > 3) {
    const world = 256 * 2 ** zoom;
    if ((e - w) / 360 * world <= 360 && (y(n) - y(s)) / (2 * Math.PI) * world <= 640) break;
    zoom--;
  }
  return `https://www.google.com/maps/@?api=1&map_action=map&center=${f((s + n) / 2)},${f((w + e) / 2)}&zoom=${zoom}`;
}

// The caption that goes to WhatsApp: your text, and for a day intro its map link,
// on one line (WhatsApp Web takes no line breaks).
function fullCaption(e, v) {
  const text = (v.caption || '').trim().replace(/\s*\n\s*/g, ' ');
  const link = v.intro ? dayMapLink(v.intro.day) : null;
  return [text, link ? `🗺 ${link}` : ''].filter(Boolean).join(' ');
}

// "Montag, 20.10."
const germanDay = day => parseStamp(day).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' });

function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (line && ctx.measureText(test).width > maxWidth) { lines.push(line); line = w; } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

function drawPostText(ctx, post) {
  const text = (post.text || '').trim();
  if (!text) return;
  const size = TEXT_SIZES[post.size] || TEXT_SIZES.m;
  ctx.save();
  ctx.font = `700 ${size}px ${POST_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = wrapLines(ctx, text, SW * 0.82);
  const lh = size * 1.3;
  const blockH = lines.length * lh;
  // Top and bottom keep clear of WhatsApp's own bars on the phone.
  const top = post.position === 'top' ? SH * 0.13
    : post.position === 'bottom' ? SH * 0.85 - blockH
      : (SH - blockH) / 2;
  const boxed = post.style === 'box' || post.style === 'light';
  if (boxed) {
    ctx.fillStyle = post.style === 'box' ? 'rgba(0, 0, 0, 0.6)' : 'rgba(255, 255, 255, 0.95)';
    lines.forEach((line, i) => {
      if (!line) return;
      const w = ctx.measureText(line).width + size * 0.8;
      ctx.beginPath();
      ctx.roundRect(SW / 2 - w / 2, top + i * lh, w, lh, size * 0.25);
      ctx.fill();
    });
  } else {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
    ctx.shadowBlur = size * 0.3;
    ctx.shadowOffsetY = size * 0.05;
  }
  ctx.fillStyle = post.style === 'light' ? '#111' : '#fff';
  lines.forEach((line, i) => { if (line) ctx.fillText(line, SW / 2, top + i * lh + lh / 2); });
  ctx.restore();
}

// textOnly: just the text on a transparent background (laid over media).
function renderPost(canvas, post, media, scale = 1, textOnly = false) {
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, SW, SH);
  if (!textOnly) drawBackground(ctx, post, media, scale);
  drawPostText(ctx, post);
}

// onload rather than img.decode(): decode() can stay pending in some browser panes.
function loadImageEl(name) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { img.rot = rotOf(name); resolve(img); };
    img.onerror = () => reject(new Error(`Could not load ${name}`));
    img.src = mediaUrl({ name });
  });
}

const thumbUrl = e => (e.type === 'video'
  ? `/thumb?name=${encodeURIComponent(e.source)}&t=${(e.start + 0.1).toFixed(1)}`
  : mediaUrl({ name: e.source }));

// ---------- gallery ----------

function dayLabel(time) {
  if (!time) return 'Unknown date';
  return parseStamp(time.slice(0, 10)).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// Releases: the draft on top, then the release parts, newest first, each with its
// Publish button (fully sent parts start collapsed). Arrange: the draft's posts,
// editable and movable.
// reveal: scroll the selected post into view (not when only the status changed).
function renderGallery({ reveal = true } = {}) {
  const g = $('#gallery');
  const scroll = g.scrollTop;
  g.replaceChildren();
  if (!state.folder) {
    g.append(el('div', { class: 'gempty' }, 'Choose a journey first.'));
    return;
  }
  if (state.mode === 'arrange') {
    g.append(hasDraft() ? newSection() : el('div', { class: 'gempty' }, 'No release is being made. Start one in Releases with ＋ New release.'));
    finishGallery(g, scroll, reveal);
    return;
  }
  g.append(draftCard());
  for (const r of [...posts.releases].reverse()) {
    // A release in several parts: one line with its whole date range above them.
    if (r.parts.length > 1) {
      const all = r.parts.flatMap(p => p.items);
      g.append(el('div', { class: 'gnote rel-line' },
        el('b', {}, `Release ${releaseTitle(r.release)}`),
        ` · ${dayRange(all)} · ${all.length} files in ${r.partsTotal} parts`));
    }
    if (r.parts.length < r.partsTotal) {
      g.append(el('div', { class: 'gnote warnline' }, `Release ${releaseTitle(r.release)}: only ${r.parts.length} of ${r.partsTotal} parts are complete (the export was interrupted).`));
    }
    const group = r.parts.length > 1 ? el('div', { class: 'rel-group' }) : g;
    for (const p of [...r.parts].reverse()) group.append(partSection(r, p));
    if (group !== g) g.append(group);
  }
  if (!posts.releases.length && !hasDraft()) g.append(el('div', { class: 'gempty' }, 'No releases yet.'));
  finishGallery(g, scroll, reveal);
}

function finishGallery(g, scroll, reveal) {
  g.scrollTop = scroll;
  const sel = g.querySelector('.card.sel');
  if (reveal && sel) sel.scrollIntoView({ block: 'nearest' });
  updatePostsSummary();
}

// Top of Releases: the draft with its steps, or the button to start one.
function draftCard() {
  if (!hasDraft()) {
    return el('div', { class: 'draft-card empty' },
      el('span', {}, 'Start a new release, then pick the photos and scenes for it.'),
      el('button', { class: 'primary', onclick: startDraft }, ic('plus'), 'New release'));
  }
  const list = exportEntries().filter(isNew);
  const days = dayRangeOf(list);
  return el('div', { class: 'draft-card' },
    ic('leaf'),
    el('b', {}, draftTitle()),
    el('span', { class: 'chip new' }, 'Draft'),
    el('span', { class: 'muted' }, list.length ? `${list.length} post${list.length === 1 ? '' : 's'}` + (days ? ` · ${days}` : '') : 'nothing picked yet'),
    el('span', { class: 'grow' }),
    el('button', { onclick: () => setMode('pick'), title: 'Step 1: pick photos and video scenes' }, ic('pick'), '1 · Pick'),
    el('button', { onclick: () => setMode('arrange'), title: 'Step 2: captions, text posts, day intros, order' }, ic('arrange'), '2 · Compose'),
    el('button', { class: 'primary', disabled: list.length ? null : '', onclick: openPostsExport, title: 'Make the files of this release, within WhatsApp\'s limits' }, ic('package'), 'Create release'),
    el('button', { class: 'quiet', onclick: deleteDraft, title: 'Unpick everything in this draft' }, ic('trash'), 'Delete draft'));
}

// "Sat 24 Oct – Mon 26 Oct" for posts (dayRange is for released files).
const dayRangeOf = list => dayRange(list.map(e => ({ postKey: e.key })));

function startDraft() {
  if (!hasDraft()) {
    posts.data.draft = { created: nowStamp() };
    savePosts();
    toast(`${draftTitle()} started. Pick photos (P) and scenes (I / O) for it.`);
  }
  setMode('pick');
}

// Unpicks everything of the draft: its stars and scenes, its text posts and day
// intros. Released posts and the files themselves are not touched.
async function deleteDraft() {
  const list = posts.entries.filter(isNew);
  if (list.length && !confirm(`Delete the draft of ${draftTitle()}?\n\nIts ${list.length} post${list.length === 1 ? '' : 's'} are unpicked: stars are removed, its video scenes and text posts deleted. Your photos and videos stay as they are.`)) return;
  try {
    for (const e of list.filter(x => x.type === 'image')) {
      await api('/api/favorite', { name: e.source, value: false });
      e.item.favorite = false;
    }
    const videos = new Set(list.filter(x => x.type === 'video').map(x => x.item));
    for (const it of videos) {
      const drop = new Set(list.filter(x => x.item === it).map(x => x.key));
      const res = await api('/api/scenes', { name: it.name, scenes: it.scenes.filter(sc => !drop.has(sceneKey(it.name, sc))) });
      it.scenes = res.scenes;
    }
    const dropTexts = new Set(list.filter(x => x.kind === 'text').map(x => x.cfg));
    posts.data.texts = posts.data.texts.filter(t => !dropTexts.has(t));
    for (const e of list) if (e.kind === 'media') delete posts.data.media[e.key];
  } catch (err) {
    toast('Could not delete everything: ' + err.message);
  }
  delete posts.data.draft;
  savePosts();
  refreshPosts();
  buildView();
  renderList();
  renderViewer();
  toast('Draft deleted');
}

// A collapsible block of the gallery. Open/collapsed is remembered in this browser.
function gallerySection(key, openByDefault, cls, title, extras, fill) {
  const open = isOpen(key, openByDefault);
  const box = el('section', { class: `gsec ${cls}` + (open ? '' : ' collapsed') },
    el('div', { class: 'gsec-head' },
      chevron(key, open),
      el('h3', { class: 'toggle', onclick: () => toggleOpen(key, open) }, title),
      ...extras));
  if (open) {
    const grid = el('div', { class: 'ggrid' });
    fill(grid);
    box.append(grid);
  }
  return box;
}

function newSection() {
  const list = visibleEntries().filter(isNew);
  const n = list.filter(e => !e.removed).length;
  return gallerySection('section:new', true, 'gsec-new', draftTitle(), [
    el('span', { class: 'chip new' }, `Draft · ${n} post${n === 1 ? '' : 's'}`),
    el('span', { class: 'grow' }),
    el('button', {
      class: 'primary', disabled: n ? null : '', onclick: openPostsExport,
      title: 'Make the files of this release, within WhatsApp\'s limits',
    }, ic('package'), 'Create release'),
  ], grid => {
    if (!list.length) {
      grid.append(el('div', { class: 'gempty' }, 'Nothing picked yet. Pick photos (P) and scenes (I / O) for this release in Pick.'));
    }
    grid.append(slotCard('＋ Text at the beginning', () => insertTextPost(null, 0)));
    const numbers = new Map();
    list.filter(e => !e.removed).forEach((e, i) => numbers.set(e.key, i + 1));
    const dayCounts = {};
    for (const e of list) { const d = (e.time || '').slice(0, 10); dayCounts[d] = (dayCounts[d] || 0) + 1; }
    let lastDay = null;
    for (const e of list) {
      const day = (e.time || '').slice(0, 10);
      if (day !== lastDay) {
        const intro = day && introFor(day);
        const introNew = intro && isNew({ key: `txt:${intro.id}` });
        grid.append(el('div', { class: 'gday' }, dayLabel(e.time), el('span', { class: 'count' }, String(dayCounts[day])),
          !day ? null : intro && !introNew
            ? el('span', { class: 'dayintro muted', title: 'This day\'s intro is in an earlier release; this release starts the day with it again, marked "Fortsetzung"' }, '🗺 continues')
            : intro
            ? el('button', { class: 'dayintro', title: 'Show the day intro', onclick: () => selectEntry(`txt:${intro.id}`) }, '🗺 Day intro ✓')
            : el('button', { class: 'dayintro', title: 'Insert a post with the date and a map of this day in front of it', onclick: () => addDayIntro(e, day) }, '＋ Day intro')));
        lastDay = day;
      }
      grid.append(renderCard(e, numbers.get(e.key)));
    }
    if (list.length) grid.append(slotCard('＋ Text at the end', () => insertTextPost(lastAnchor(), posts.data.texts.length)));
  });
}

const releaseFileUrl = (release, part, file) =>
  `/release-file?release=${encodeURIComponent(release)}&part=${encodeURIComponent(part)}&file=${encodeURIComponent(file)}`;
const lastSent = items => items.map(i => i.sentAt).filter(Boolean).sort().pop();

// The days the files of a release (part) were taken: "Sun 19 Oct – Wed 22 Oct".
function dayRange(items) {
  const days = items.map(i => {
    const e = entryFor(i.postKey || i.key);
    return ((e && e.time) || (i.intro && i.intro.day) || i.taken || '').slice(0, 10);
  }).filter(Boolean).sort();
  if (!days.length) return '';
  const fmt = d => parseStamp(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const first = days[0], last = days[days.length - 1];
  return first === last ? fmt(first) : `${fmt(first)} – ${fmt(last)}`;
}

function partSection(r, p) {
  const sent = p.items.filter(i => i.sentAt).length;
  const allSent = p.items.length > 0 && sent === p.items.length;
  const changed = p.items.filter(i => releaseChanges(i)).length;
  const range = p.items.length ? `${p.items[0].file.split('_')[0]}–${p.items[p.items.length - 1].file.split('_')[0]}` : '';
  // In a release with several parts, the release's name is in the line above them.
  const title = p.parts > 1 ? `Part ${p.partNo} of ${p.parts}` : `Release ${releaseTitle(r.release)}`;
  const keys = p.items.map(i => i.key);
  return gallerySection(`part:${r.release}|${p.part}`, !allSent, allSent ? 'gsec-sent' : 'gsec-ready', title, [
    sentChip(sent, p.items.length),
    el('span', { class: 'days' }, dayRange(p.items)),
    el('span', { class: 'muted' }, `files ${range}` + (allSent ? ` · sent ${shortDate(lastSent(p.items))}` : '')),
    changed ? el('span', { class: 'chip changed', title: 'Changed after the release was made; updated in the release when you publish' }, `✎ ${changed} changed`) : null,
    el('span', { class: 'grow' }),
    el('button', { title: 'Open the folder of this part', onclick: () => api('/api/reveal', { release: r.release, part: p.part }).catch(err => toast(err.message)) }, ic('folder')),
    allSent ? null : el('button', { class: 'primary', title: 'Post this part to your WhatsApp Status', onclick: () => publishPart(r, p) }, ic('send'), 'Publish'),
    allSent
      ? el('button', { onclick: () => setPartSent(r, p, keys, false) }, 'Mark as not sent')
      : el('button', { title: 'Only if you posted it yourself', onclick: () => setPartSent(r, p, keys, true) }, '✓ Mark as sent'),
  ], grid => fillItems(grid, p.items.map(item => ({
    item, sentAt: item.sentAt, release: r.release, part: p.part, src: releaseFileUrl(r.release, p.part, item.file),
  }))));
}

// The files of a release part as cards, with a line for each day.
function fillItems(grid, rows) {
  let lastDay = null;
  for (const row of rows) {
    const e = entryFor(row.item.postKey || row.item.key);
    const time = e ? e.time : row.item.intro ? row.item.intro.day : row.item.taken || '';
    const day = (time || '').slice(0, 10);
    if (day !== lastDay) {
      grid.append(el('div', { class: 'gday' }, dayLabel(time)));
      lastDay = day;
    }
    const num = row.item.file.split('_')[0];
    grid.append(e ? renderCard(e, num, row) : goneCard(row, num));
  }
}

// A released file whose post doesn't exist any more (unstarred, scene changed, text deleted).
function goneCard(row, num) {
  const { item } = row;
  const frame = el('div', { class: 'frame' });
  if (item.type === 'video') {
    if (item.source && state.items.some(it => it.name === item.source)) {
      frame.append(el('img', { class: 'fg', src: `/thumb?name=${encodeURIComponent(item.source)}&t=${((item.start || 0) + 0.1).toFixed(1)}`, loading: 'lazy', alt: '' }));
    }
    frame.append(el('span', { class: 'badge' }, `🎬 ${item.piece || ''}`));
  } else {
    frame.append(el('img', { class: 'fg', src: row.src, loading: 'lazy', alt: '' }));
  }
  if (row.sentAt) frame.append(el('span', { class: 'chip sent' }, '✓ Sent'));
  // A day intro the release added at the start of a part: not a post of its own.
  const auto = item.intro && item.intro.auto;
  return el('div', {
    class: 'card rel' + (auto ? ' auto-intro' : ' gone-post'),
    title: `${item.file}\n` + (auto
      ? `Added at the start of this part${auto === 'continuation' ? ' (the day continues from before)' : ''}`
      : 'No longer a post here (unstarred, scene changed or deleted)') + ' · double-click: the released file',
    ondblclick: () => openViewer({ title: item.file, type: item.type === 'video' ? 'video' : 'image', src: row.src }),
  }, frame,
  el('div', { class: 'meta' }, el('span', { class: 'num' }, num),
    el('span', { class: 'name' }, auto === 'continuation' ? 'Day intro · Fortsetzung' : auto ? 'Day intro (added)' : item.file)),
  item.caption ? el('div', { class: 'cap', title: item.caption }, `💬 ${item.caption}`) : null,
  // No editor for these files: they are marked as sent or not right here.
  row.release ? el('button', {
    class: 'add', title: row.sentAt ? 'This file goes out again with the next Publish of this part' : 'Only if you posted it yourself; Publish then skips it',
    onclick: ev => { ev.stopPropagation(); setPartSent({ release: row.release }, { part: row.part }, [item.key], !row.sentAt); },
  }, row.sentAt ? '↩ Mark as not sent' : '✓ Mark as sent') : null);
}

function slotCard(label, onclick) {
  return el('div', { class: 'card slot', onclick }, el('div', { class: 'frame' }, label));
}

// row: the released file when the card stands in a release part
// ({ item, sentAt, src, release, part }); then it shows that file's number, caption
// and sent state, and can't be dragged.
function renderCard(e, num, row = null) {
  const v = postView(e);
  const frame = el('div', { class: 'frame' });
  const missing = e.kind === 'media' && !state.items.some(it => it.name === e.source);
  if (e.type === 'text') {
    const c = el('canvas', { width: 144, height: 256 });
    renderPost(c, v, null, CARD_SCALE);
    frame.append(c);
  } else {
    const src = thumbUrl(e);
    frame.append(el('img', { class: 'fg' + rotClass(rotOf(e.source)), src, loading: 'lazy', alt: '' }));
  }
  const piece = row && row.item.piece;
  if (e.type === 'video') {
    const len = piece ? (row.item.end - row.item.start) / (row.item.speed || 1) : postLen(e);
    frame.append(el('span', { class: 'badge' }, `🎬 ${len.toFixed(1)} s` + (piece ? ` · ${piece}` : '')));
  }
  if (!row && postLen(e) > STATUS_LIMIT_S) frame.append(el('span', { class: 'badge right', title: `WhatsApp Status only shows the first ${STATUS_LIMIT_S} s` }, '⏱'));
  else if (e.kind === 'media' && geoFor(e)) frame.append(el('span', { class: 'badge right', title: 'Has a location' }, '📍'));
  if (row && row.sentAt) {
    frame.append(el('span', { class: 'chip sent', title: `Sent on ${parseStamp(row.sentAt).toLocaleString()}` }, `✓ Sent ${shortDate(row.sentAt)}`));
  }
  const changes = row && row.release ? releaseChanges(row.item, e) : null;
  if (changes) {
    frame.append(el('span', { class: 'chip changed', title: `Changed after the release was made (${changes.join(' and ')}); updated in the release when you publish` }, '✎ Changed'));
  }
  if (!row && e.removed) frame.append(el('div', { class: 'gone' }, 'Removed'));
  if (missing) frame.append(el('div', { class: 'gone' }, 'File missing'));
  const time = e.time ? e.time.slice(11, 16) : '';
  const name = e.type === 'text' ? (e.cfg.intro ? 'Day intro' : 'Text') : e.source;
  const caption = row ? row.item.caption || '' : fullCaption(e, v);
  const card = el('div', {
    class: 'card' + (e.key === posts.selKey ? ' sel' : '') + (!row && e.removed ? ' removed' : '') + (row ? ' rel' : ''),
    'data-key': e.key, draggable: row ? null : 'true',
    title: row
      ? `${row.item.file}\nDouble-click: the released file at real size`
      : (e.type === 'text' ? (v.text || 'Text post') : e.source) + '\nDrag to move · double-click: real size',
    onclick: () => selectEntry(e.key),
    ondblclick: row
      ? () => openViewer({ title: row.item.file, type: row.item.type === 'video' ? 'video' : 'image', src: row.src })
      : () => viewPost(e),
  },
  frame,
  el('div', { class: 'meta' },
    el('span', { class: 'num' }, row ? num : e.removed ? '–' : pad2(num)),
    el('span', {}, time),
    el('span', { class: 'name' }, e.type === 'video' ? `${name} · scene ${e.sceneNo}` : name)),
  caption ? el('div', { class: 'cap', title: caption }, `💬 ${caption}`) : null,
  row ? null : el('button', {
    class: 'add', title: 'Insert a text-only post after this one',
    onclick: ev => { ev.stopPropagation(); insertTextAfter(e); },
  }, '＋ Text after'));
  card._num = num;
  card._row = row;
  if (!row) addDragHandlers(card, e);
  return card;
}

// Double-click on a card: the photo or video at real size (a scene from its start),
// a text post or day intro as the finished 1080×1920 picture.
async function viewPost(e) {
  if (e.kind === 'media' && e.item) { viewItem(e.item, e.start || 0); return; }
  const v = postView(e);
  if (v.intro) {
    const s = dayMapState(v.intro.day);
    if (s.ready) await s.ready;
  }
  const canvas = document.createElement('canvas');
  canvas.width = SW;
  canvas.height = SH;
  renderPost(canvas, v, null, 1, false);
  openViewer({ title: v.intro ? 'Day intro' : 'Text post', type: 'canvas', canvas });
}

// Drag a card onto another: dropped on its left half it goes in front, on the right half behind.
let dragKey = null;

function addDragHandlers(card, e) {
  const side = ev => {
    const r = card.getBoundingClientRect();
    return ev.clientX > r.left + r.width / 2;
  };
  card.addEventListener('dragstart', ev => {
    dragKey = e.key;
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', e.key);
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => {
    dragKey = null;
    card.classList.remove('dragging');
    for (const c of document.querySelectorAll('#gallery .drop-before, #gallery .drop-after')) c.classList.remove('drop-before', 'drop-after');
  });
  card.addEventListener('dragover', ev => {
    if (!dragKey || dragKey === e.key) return;
    ev.preventDefault();
    const after = side(ev);
    card.classList.toggle('drop-before', !after);
    card.classList.toggle('drop-after', after);
  });
  card.addEventListener('dragleave', () => card.classList.remove('drop-before', 'drop-after'));
  card.addEventListener('drop', ev => {
    ev.preventDefault();
    card.classList.remove('drop-before', 'drop-after');
    if (dragKey && dragKey !== e.key) {
      const moved = dragKey;
      movePost(moved, e.key, side(ev));
      selectEntry(moved);
    }
  });
}

// A post can have several cards (in the list of new posts and in release parts).
function refreshCard(e) {
  for (const old of document.querySelectorAll(`#gallery .card[data-key="${CSS.escape(e.key)}"]`)) {
    old.replaceWith(renderCard(e, old._num, old._row));
  }
}

// Keys of the posts in the order the gallery shows them (for the arrow keys).
const galleryKeys = () => [...new Set([...document.querySelectorAll('#gallery .card[data-key]')].map(c => c.dataset.key))];

function updatePostsSummary() {
  const total = posts.entries.length;
  const removed = posts.entries.filter(e => e.removed).length;
  const n = total - removed;
  const counts = { new: 0, prepared: 0, sent: 0 };
  for (const e of exportEntries()) counts[postStatus(e.key).state]++;
  // The Arrange tab counts the draft's posts.
  const draft = exportEntries().filter(isNew).length;
  $('#postCount').textContent = hasDraft() && draft ? String(draft) : '';
  $('#postsSummary').textContent = total
    ? `${n} post${n === 1 ? '' : 's'}: ${counts.new} new · ${counts.prepared} prepared · ${counts.sent} sent` : '';
  $('#removedCount').textContent = removed ? `(${removed})` : '';
  // The journeys list shows these numbers too (journeys.js loads after this file).
  if (typeof journeySummaryChanged === 'function') journeySummaryChanged();
}

// ---------- selecting and editing ----------

function selectEntry(key) {
  const before = posts.selKey;
  posts.selKey = key;
  for (const k of [before, key]) {
    const e = posts.entries.find(x => x.key === k);
    if (e) refreshCard(e);
  }
  const sel = $('#gallery .card.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
  renderEditor();
  loadPostMedia();
}

function stepEntry(dir) {
  const keys = galleryKeys();
  const i = keys.indexOf(posts.selKey);
  const next = keys[i < 0 ? 0 : Math.min(keys.length - 1, Math.max(0, i + dir))];
  if (next) selectEntry(next);
}

function renderEditor() {
  const e = curEntry();
  $('#postEmpty').hidden = !!e;
  $('#postFields').hidden = !e;
  $('#postPreview').hidden = !e;
  if (!e) return;
  const v = postView(e);
  if (document.activeElement !== $('#pText')) $('#pText').value = v.text;
  if (document.activeElement !== $('#pCaption')) $('#pCaption').value = v.caption;
  for (const [id, key] of [['#pPos', 'position'], ['#pStyle', 'style'], ['#pSize', 'size']]) {
    for (const b of $(id).children) b.classList.toggle('on', b.dataset.v === v[key]);
  }
  for (const b of $('#pBg').children) b.classList.toggle('on', b.dataset.v === (v.bg || BG_COLORS[0]));
  // Text on the picture and its look only exist for text-only posts.
  const isText = e.type === 'text';
  const isIntro = !!(e.cfg && e.cfg.intro);
  for (const id of ['#pTextField', '#pBgField']) $(id).hidden = !isText;
  // A day intro has a fixed layout (date on top, map below).
  for (const id of ['#pPosField', '#pStyleField', '#pSizeField']) $(id).hidden = !isText || isIntro;
  $('#introField').hidden = !isIntro;
  if (isIntro) renderIntroInfo(e);
  $('#geoField').hidden = isText;
  $('#speciesField').hidden = isText;
  $('#pRemove').textContent = e.type === 'text' ? '🗑 Delete text post' : e.removed ? '↩ Restore post' : '✕ Remove post';
  const info = [];
  if (e.type === 'video') {
    info.push(`Scene ${e.sceneNo} of ${e.source}: ${fmtTime(e.start)} → ${fmtTime(e.end)} (${postLen(e).toFixed(1)} s` +
      ((e.speed || 1) < 1 ? `, ${{ 0.75: '¾', 0.5: '½', 0.25: '¼' }[e.speed]}× slow motion).` : ').'));
    if (postLen(e) > STATUS_LIMIT_S) info.push(`⚠ Longer than ${STATUS_LIMIT_S} s: WhatsApp Status only shows the first ${STATUS_LIMIT_S} s.`);
  }
  if (e.type === 'image') info.push(`Photo ${e.source}.`);
  if (isText && !isIntro) {
    // Sent as WhatsApp's own text status (publisher.js), not as the picture shown here.
    const full = [v.text, v.caption].map(t => (t || '').trim()).filter(Boolean).join('\n\n');
    const n = splitStatusText(full).length;
    info.push(`Goes out as a WhatsApp text status (WhatsApp's background color closest to this one), not as a picture: ` +
      `${full.length} characters` + (n > 1 ? `, split into ${n} statuses of at most ${STATUS_TEXT_MAX} characters.` : '.') +
      (v.caption.trim() ? ' The caption is added as the last paragraph.' : ''));
  }
  if (e.removed) info.push("Removed: it won't go into the release. The pick stays in Pick.");
  $('#pInfo').textContent = info.join(' ');
  if (e.type !== 'text') { renderGeo(e); renderSpecies(e); }
  renderReleaseInfo(e);
  lockEditor(e);
  drawPostPreview();
}

// Where the post stands: not released yet, in a release part (with what changed since),
// or sent.
function renderReleaseInfo(e) {
  const box = $('#pRelease');
  box.replaceChildren();
  const st = postStatus(e.key);
  if (st.state === 'new') {
    box.append(el('div', { class: 'muted' }, `In the draft of ${draftTitle()}. "Create release" makes its files.`));
    return;
  }
  if (st.state === 'sent') box.append(el('div', {}, `✓ Sent on ${parseStamp(st.sentAt).toLocaleString()}. It can't be changed any more.`));
  // Every part that holds a file of this post (a long video can have pieces in two parts).
  const byPart = new Map();
  for (const x of releasePlaces(e.key)) {
    const k = `${x.r.release}|${x.p.part}`;
    if (!byPart.has(k)) byPart.set(k, { r: x.r, p: x.p, items: [] });
    byPart.get(k).items.push(x.item);
  }
  for (const { r, p, items } of byPart.values()) {
    const sent = items.every(i => i.sentAt);
    const where = `Release ${releaseTitle(r.release)}` + (p.parts > 1 ? `, part ${p.partNo} of ${p.parts}` : '') +
      (sent ? ': sent.' : ', not sent yet.');
    // Marking by hand: for a post you posted (or deleted) yourself in WhatsApp.
    box.append(el('div', { class: 'rel-row' }, el('span', {}, where), sent
      ? el('button', { title: 'This file goes out again with the next Publish of this part', onclick: () => setPartSent(r, p, items.map(i => i.key), false) }, '↩ Mark as not sent')
      : el('button', { title: 'Only if you posted it yourself; Publish then skips it', onclick: () => setPartSent(r, p, items.map(i => i.key), true) }, '✓ Mark as sent')));
    if (sent) continue;
    const changes = [...new Set(items.flatMap(i => releaseChanges(i, e) || []))];
    if (changes.length) {
      box.append(el('div', { class: 'warnline' },
        `✎ The ${changes.join(' and ')} changed after the release was made. It is updated in the release when you publish, or now:`),
      el('button', { onclick: () => updateInRelease(r, p, items) }, '↻ Update in release'));
    }
  }
}

// Sent posts can't be edited any more; posts in a release keep their place.
function lockEditor(e) {
  const st = postStatus(e.key);
  const sent = st.state === 'sent', released = st.state !== 'new';
  for (const c of $('#postFields').querySelectorAll('textarea, input, button')) {
    if (c.id === 'pCopyCaption' || c.closest('#pRelease')) continue;
    c.disabled = sent || (released && ['pEarlier', 'pLater', 'pRemove'].includes(c.id));
  }
  $('#postFields').classList.toggle('locked', sent);
}

function editPost(fields) {
  const e = curEntry();
  if (!e) return;
  if (postStatus(e.key).state === 'sent') { toast('Already sent; it can\'t be changed any more'); return; }
  Object.assign(cfgFor(e), fields);
  renderEditor();
  // In a release: the part's "changed" count may change too.
  if (postStatus(e.key).state === 'prepared') renderGallery({ reveal: false });
  else refreshCard(e);
  savePosts();
}

function toggleRemoved() {
  const e = curEntry();
  if (!e) return;
  if (!isNew(e)) { toast('This post is in a release already'); return; }
  if (e.kind === 'text') {
    if (!confirm('Delete this text post?')) return;
    const list = visibleEntries();
    const i = list.findIndex(x => x.key === e.key);
    posts.data.texts = posts.data.texts.filter(t => t !== e.cfg);
    buildEntries();
    const next = list[i + 1] || list[i - 1];
    posts.selKey = next ? next.key : null;
  } else {
    cfgFor(e).removed = !e.removed;
    e.removed = !e.removed;
    // When removed posts are hidden, move on to the next post.
    if (e.removed && !posts.showRemoved) {
      const list = posts.entries.filter(x => !x.removed || x === e);
      const i = list.indexOf(e);
      const next = list[i + 1] || list[i - 1];
      posts.selKey = next && next !== e ? next.key : null;
    }
  }
  renderGallery();
  renderEditor();
  loadPostMedia();
  savePosts();
}

// ---------- text-only posts ----------

function lastAnchor() {
  const media = posts.entries.filter(e => e.kind === 'media');
  return media.length ? media[media.length - 1].key : null;
}

// extra: more fields for the new text post, e.g. a day intro.
function insertTextPost(afterKey, index, extra = {}) {
  if (!state.folder) { toast('Choose a journey first'); return; }
  const anchor = posts.entries.find(e => e.key === afterKey);
  const t = {
    id: newPostId(), after: afterKey, at: anchor ? anchor.time : '', text: '', caption: '',
    bg: BG_COLORS[posts.data.texts.length % BG_COLORS.length],
    ...extra,
  };
  posts.data.texts.splice(index, 0, t);
  buildEntries();
  posts.selKey = `txt:${t.id}`;
  renderGallery();
  renderEditor();
  loadPostMedia();
  savePosts();
  $('#pText').focus();
}

// After a photo/scene: right after it, before text posts already following it.
// After a text post: right after that text post, with the same anchor.
function insertTextAfter(e, extra) {
  if (e.kind === 'text') {
    insertTextPost(e.cfg.after || null, posts.data.texts.indexOf(e.cfg) + 1, extra);
  } else {
    const first = posts.data.texts.findIndex(t => t.after === e.key);
    insertTextPost(e.key, first >= 0 ? first : posts.data.texts.length, extra);
  }
}

// Before a post = right after the post in front of it (or at the very beginning).
function insertTextBefore(e, extra) {
  const i = posts.entries.indexOf(e);
  const prev = posts.entries[i - 1];
  if (prev) insertTextAfter(prev, extra);
  else insertTextPost(null, 0, extra);
}

const introFor = day => posts.data.texts.find(t => t.intro && t.intro.day === day);

function renderIntroInfo(e) {
  const day = e.cfg.intro.day;
  const auto = autoDayPins(day);
  const files = state.items.filter(it => it.geo && (it.date || '').startsWith(day)).length;
  const s = dayPins(day).length ? dayMapState(day) : {};
  const box = $('#introInfo');
  const link = dayMapLink(day);
  const status = [
    s.error ? el('div', { class: 'warnline' }, s.error) : null,
    s.loading ? el('div', { class: 'muted' }, 'Loading the map from Google Maps …') : null,
    link ? el('small', { class: 'muted' }, `🗺 Added to the caption automatically (${dayPins(day).length === 1 ? 'pin' : state.mapPageUrl ? 'all pins, own map page' : 'area of the day'}): `,
      el('a', { href: link, target: '_blank', rel: 'noopener' }, 'open map link ↗')) : null,
  ];
  if (auto.length) {
    box.replaceChildren(...[
      el('span', {}, `${auto.length} pin${auto.length === 1 ? '' : 's'} from ${files} photo${files === 1 ? '' : 's'} and video${files === 1 ? '' : 's'} of this day with a location.`),
      ...status,
      el('button', { onclick: () => addDayPlaces(e) }, '📍 Add the day\'s place names to the text'),
    ].filter(Boolean));
    return;
  }
  // No file of this day has a location: ask for a place, or leave it out.
  if (e.cfg.place) {
    box.replaceChildren(...[
      el('span', {}, `📍 ${e.cfg.place.label} (entered by you)`),
      el('small', { class: 'muted' }, e.cfg.place.name),
      ...status,
      el('div', { class: 'editor-btns' },
        el('button', { onclick: () => editPost({ place: undefined }) }, 'Change place'),
        el('button', { onclick: () => leaveOutLocation(e) }, 'Leave out location')),
    ].filter(Boolean));
    return;
  }
  if (e.cfg.noLocation) {
    box.replaceChildren(
      el('span', {}, 'Location left out: this intro shows just the date.'),
      el('button', { onclick: () => editPost({ noLocation: undefined }) }, 'Enter a place instead'));
    return;
  }
  const input = el('input', { type: 'text', placeholder: 'e.g. Nusa Penida', spellcheck: 'false' });
  const find = el('button', { class: 'primary', onclick: () => setIntroPlace(e, input.value, find) }, 'Show on map');
  input.addEventListener('keydown', ev => { if (ev.key === 'Enter') setIntroPlace(e, input.value, find); });
  box.replaceChildren(
    el('span', { class: 'warnline' }, 'No photo or video of this day has a location. Where were you?'),
    el('div', { class: 'place-ask' }, input, find),
    el('button', { onclick: () => leaveOutLocation(e) }, 'Leave out location (date only)'));
}

// A place typed in for a day without locations: found via Google (or OpenStreetMap),
// shown as the map's pin, and its name goes under the date.
async function setIntroPlace(e, q, btn) {
  const label = String(q || '').trim();
  if (!label) { toast('Type where you were, e.g. "Nusa Penida"'); return; }
  btn.disabled = true;
  btn.textContent = 'Searching …';
  try {
    const { place } = await api(`/api/find-place?q=${encodeURIComponent(label)}`);
    const date = (e.cfg.text || germanDay(e.cfg.intro.day)).split('\n')[0];
    editPost({ place: { label, name: place.name, lat: place.lat, lon: place.lon }, noLocation: undefined, text: `${date}\n${label}` });
    $('#pText').value = postView(e).text;
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
    btn.textContent = 'Show on map';
  }
}

function leaveOutLocation(e) {
  const date = (e.cfg.text || germanDay(e.cfg.intro.day)).split('\n')[0];
  editPost({ noLocation: true, place: undefined, text: date });
  $('#pText').value = postView(e).text;
}

// Looks up the place names of the day's spots (one per area of about 1 km, at most
// 6 lookups) and adds them as a line under the date, e.g. "Ubud · Tegallalang".
async function addDayPlaces(e) {
  const day = e.cfg.intro.day;
  const areas = new Map();
  for (const p of dayPins(day)) {
    const k = `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
    if (!areas.has(k)) areas.set(k, p);
  }
  const names = [];
  toast('Looking up place names …');
  for (const p of [...areas.values()].slice(0, 6)) {
    try {
      const { place } = await api(`/api/place?lat=${p.lat}&lon=${p.lon}`);
      posts.places.set(geoKey(p), place);
      // Town names ("Ubud") read better in a day heading than single sights.
      const n = place && (place.name.split(',')[0] || place.poi);
      if (n && !names.includes(n)) names.push(n);
    } catch (err) {
      toast(err.message);
      break;
    }
  }
  if (!names.length) { toast('No place names found'); return; }
  const first = (e.cfg.text || germanDay(day)).split('\n')[0];
  editPost({ text: `${first}\n${names.slice(0, 4).join(' · ')}` });
  $('#pText').value = postView(e).text;
}

// A day intro in front of the day's first post: the German date as the heading,
// a map with a pin for every photo and video of that day that has a location.
function addDayIntro(first, day) {
  if (introFor(day)) { selectEntry(`txt:${introFor(day).id}`); return; }
  insertTextBefore(first, { intro: { day }, text: germanDay(day), bg: INTRO_BG });
}

// ---------- location ----------

const geoKey = g => `${g.lat.toFixed(3)},${g.lon.toFixed(3)}`;
const fmtGeo = g => `${g.lat.toFixed(5)}, ${g.lon.toFixed(5)}`;

// The file's own location, or for a video without one (e.g. DJI drone videos)
// the location of the photo taken closest in time, if within 30 minutes.
function geoFor(e) {
  if (!e.item) return null;
  if (e.item.geo) return { ...e.item.geo, from: null };
  if (e.type !== 'video' || !e.time) return null;
  const t = parseStamp(e.time).getTime();
  let best = null;
  for (const it of state.items) {
    if (!it.geo || !it.date || it.type !== 'image') continue;
    const d = Math.abs(parseStamp(it.date).getTime() - t);
    // Prefer photos from the same camera (DJI photo for a DJI video).
    const same = it.name.slice(0, 3) === e.source.slice(0, 3) ? 0 : 1;
    if (d <= NEARBY_PHOTO_MIN * 60000 && (!best || same < best.same || (same === best.same && d < best.d))) best = { it, d, same };
  }
  if (!best) return null;
  return { ...best.it.geo, from: best.it.name, minutes: Math.round(best.d / 60000) };
}

function renderGeo(e) {
  const box = $('#geoInfo');
  box.replaceChildren();
  const g = geoFor(e);
  if (!g) {
    box.append(el('span', { class: 'muted' }, e.type === 'video'
      ? 'No location: this video has none, and no photo with a location was taken within 30 minutes.'
      : 'This photo has no location.'));
    return;
  }
  const map = `https://www.google.com/maps/search/?api=1&query=${g.lat},${g.lon}`;
  box.append(el('span', {}, `📍 ${fmtGeo(g)}  `, el('a', { href: map, target: '_blank', rel: 'noopener' }, 'Open in Google Maps ↗')));
  if (g.from) box.append(el('small', { class: 'muted' }, `≈ from ${g.from}, taken ${g.minutes} min ${g.minutes ? 'apart' : 'at the same time'}.`));
  box.append(el('span', { class: 'provider muted' },
    `Place names from ${posts.googleKey ? 'Google Maps' : 'OpenStreetMap'} · `,
    el('button', { class: 'linkbtn', onclick: openGoogleDlg }, posts.googleKey ? 'Google key…' : 'Use Google instead…')));
  const key = geoKey(g);
  const place = posts.places.get(key);
  if (place) {
    for (const name of [place.poi && `${place.poi}, ${place.name.split(',')[0]}`, place.name].filter(Boolean)) {
      const line = `📍 ${name}${place.country ? `, ${place.country}` : ''}`;
      box.append(el('div', { class: 'place' },
        el('b', {}, line),
        el('button', { onclick: () => appendTo('caption', line) }, '＋ Caption')));
    }
    renderNearby(box, e, g, place);
    return;
  }
  const providerName = posts.googleKey ? 'Google Maps' : 'OpenStreetMap';
  const btn = el('button', { title: `Asks ${providerName} for the place name. Only the coordinates are sent.` }, `Look up place name (${providerName})`);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Looking up…';
    try {
      // The nearby list comes along with the place name, so you can choose right away.
      const [res, near] = await Promise.all([
        api(`/api/place?lat=${g.lat}&lon=${g.lon}`),
        api(`/api/nearby?lat=${g.lat}&lon=${g.lon}`).catch(err => { toast(err.message); return null; }),
      ]);
      posts.places.set(key, res.place);
      if (near && near.nearby) posts.nearby.set(key, near.nearby);
    } catch (err) {
      toast(err.message);
    }
    if (curEntry() === e) renderGeo(e);
  });
  box.append(btn);
  // Spots looked up before (places.json) show up without going online.
  if (!posts.places.has(key)) {
    posts.places.set(key, null);
    api(`/api/place?lat=${g.lat}&lon=${g.lon}&cached=1`).then(res => {
      if (res.place) { posts.places.set(key, res.place); if (curEntry() === e) renderGeo(e); } else posts.places.delete(key);
    }).catch(() => posts.places.delete(key));
  }
}

// A broader choice of names around the spot (towns, beaches, viewpoints, temples, …),
// nearest first. Click one to add it to the caption.
const NEARBY_ICON = { Beach: '🏖', Bay: '🏖', Lagoon: '🏖', Reef: '🐠', Viewpoint: '🌄', Peak: '⛰', Volcano: '🌋', Hill: '⛰', Crater: '🌋',
  Cliffs: '🪨', Cape: '🪨', Waterfall: '💧', Spring: '💧', Lake: '💧', Temple: '🛕', 'Nature park': '🌿', Park: '🌳', Garden: '🌺',
  'Hiking area': '🥾', 'Rice terraces': '🌾', Valley: '🌄', Island: '🏝', City: '🏙', Town: '🏘', Village: '🏡', District: '🏘',
  Museum: '🏛', 'Historic site': '🏛', Harbour: '⚓' };
const fmtDist = m => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);

function renderNearby(box, e, g, place) {
  const key = geoKey(g);
  const near = posts.nearby.get(key);
  const town = place && place.name ? place.name.split(',')[0] : '';
  const country = place && place.country ? `, ${place.country}` : '';
  if (near) {
    const chips = list => list.map(p => {
      const line = ['Town', 'City', 'Village', 'District', 'Island'].includes(p.kind) || !town || p.name === town
        ? `📍 ${p.name}${country}` : `📍 ${p.name}, ${town}${country}`;
      return el('button', { class: 'nchip', title: `${p.kind} · ${fmtDist(p.dist)} away\nAdds "${line}" to the caption`,
        onclick: () => { appendTo('caption', line); toast(`Added: ${line}`); } },
      el('span', { class: 'nicon' }, NEARBY_ICON[p.kind] || '📍'), el('span', { class: 'nname' }, p.name),
      el('small', {}, `${p.kind} · ${fmtDist(p.dist)}`));
    });
    const wrap = el('div', { class: 'nearby' });
    if (near.sights.length) wrap.append(el('div', { class: 'nhead' }, 'Sights & landscapes nearby'), el('div', { class: 'nlist' }, ...chips(near.sights)));
    if (near.towns.length) wrap.append(el('div', { class: 'nhead' }, 'Towns & islands around'), el('div', { class: 'nlist' }, ...chips(near.towns)));
    if (!near.sights.length && !near.towns.length) wrap.append(el('small', { class: 'muted' }, 'Nothing named found around this spot.'));
    else wrap.append(el('small', { class: 'muted' }, 'Click a place to add it to the caption.'));
    box.append(wrap);
    return;
  }
  const btn = el('button', { title: 'Lists towns, beaches, viewpoints, temples and other sights around this spot. Only the coordinates are sent.' },
    '🔎 More places nearby …');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Searching nearby …';
    try {
      posts.nearby.set(key, (await api(`/api/nearby?lat=${g.lat}&lon=${g.lon}`)).nearby);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = '🔎 More places nearby …';
      return;
    }
    if (curEntry() === e) renderGeo(e);
  });
  box.append(btn);
  // Spots searched before (places.json) show their list without going online.
  if (!posts.nearby.has(key)) {
    posts.nearby.set(key, null);
    api(`/api/nearby?lat=${g.lat}&lon=${g.lon}&cached=1`).then(res => {
      if (res.nearby) { posts.nearby.set(key, res.nearby); if (curEntry() === e) renderGeo(e); } else posts.nearby.delete(key);
    }).catch(() => posts.nearby.delete(key));
  }
}

// ---------- animals in the picture ----------
// Asks an AI model (the user's own key) what animals a photo or the video frame in the
// preview shows. Names come in German and English; click one to add it to the caption.

const ANIMAL_ICON = { fish: '🐠', shark: '🦈', ray: '🐟', turtle: '🐢', mammal: '🐬', octopus: '🐙', crustacean: '🦀', snail: '🐌',
  jellyfish: '🪼', coral: '🪸', starfish: '⭐', eel: '🐍', bird: '🐦', reptile: '🦎', other: '🔎' };

// The frame a video is asked about: where the preview stands, within the scene.
function speciesTime(e) {
  if (e.type !== 'video') return 0;
  const v = posts.media instanceof HTMLVideoElement && posts.mediaKey === e.key ? posts.media : null;
  const t = v && v.currentTime >= e.start && v.currentTime <= e.end ? v.currentTime : e.start + Math.min(1, (e.end - e.start) / 2);
  return Math.round(t * 10) / 10;
}

function renderSpecies(e) {
  const box = $('#speciesInfo');
  box.replaceChildren();
  if (e.kind !== 'media' || !e.item) return;
  const known = posts.species.get(e.key);
  const provider = (posts.ai.providers[posts.ai.provider] || {}).label || 'AI';
  if (known) {
    if (!known.animals.length) box.append(el('span', { class: 'muted' }, 'No animal could be made out' + (e.type === 'video' ? ` at ${fmtTime(known.t)}.` : '.')));
    for (const a of known.animals) {
      const icon = ANIMAL_ICON[a.group] || '🔎';
      const sci = a.scientific ? ` (${a.scientific})` : '';
      const add = name => { const line = `${icon} ${name}${sci}`; appendTo('caption', line); toast(`Added: ${line}`); };
      const same = a.de.toLowerCase() === a.en.toLowerCase();
      box.append(el('div', { class: 'animal' },
        el('span', { class: 'aicon' }, icon),
        el('div', { class: 'anames' },
          el('b', {}, same ? a.de : `${a.de} · ${a.en}`),
          el('small', { class: 'muted' }, ...[a.scientific && el('i', {}, a.scientific), a.level !== 'species' ? `${a.level} only` : null, `${a.confidence} confidence`]
            .filter(Boolean).reduce((acc, x, i) => (i ? [...acc, ' · ', x] : [x]), []))),
        el('button', { title: `Adds "${icon} ${a.de}${sci}" to the caption`, onclick: () => add(a.de) }, same ? '＋ Caption' : '＋ DE'),
        same ? null : el('button', { title: `Adds "${icon} ${a.en}${sci}" to the caption`, onclick: () => add(a.en) }, '＋ EN')));
    }
    if (known.animals.length) box.append(el('small', { class: 'muted' }, 'A suggestion, not a fact: similar species are easy to mix up.'));
  }
  const btn = el('button', {
    title: posts.ai.saved ? `Sends this ${e.type === 'video' ? 'video frame' : 'photo'} (scaled down) and the place name to ${provider}.` : 'Needs your own API key (Claude, Gemini or OpenAI)',
  }, known ? (e.type === 'video' ? '🔁 Identify the frame in the preview' : '🔁 Ask again') : `🐠 Identify animals${e.type === 'video' ? ' (frame in the preview)' : ''}`);
  btn.addEventListener('click', async () => {
    if (!posts.ai.saved) { openAiDlg(); return; }
    btn.disabled = true;
    btn.textContent = `Asking ${provider} …`;
    try {
      const g = geoFor(e);
      const place = g ? posts.places.get(geoKey(g)) : null;
      const where = place ? [place.poi, place.name, place.country].filter(Boolean).join(', ')
        : e.cfg.place ? e.cfg.place.label : g ? `${g.lat.toFixed(3)}, ${g.lon.toFixed(3)}` : '';
      const res = await api('/api/identify', { name: e.source, t: speciesTime(e), place: where, again: !!known });
      posts.species.set(e.key, res.result);
    } catch (err) {
      toast(err.message);
    }
    if (curEntry() === e) renderSpecies(e);
  });
  box.append(el('div', { class: 'arow' }, btn,
    el('button', { class: 'linkbtn', onclick: openAiDlg }, posts.ai.saved ? `${provider} · key…` : 'Set up…')));
  // Answers from before (_species.json in the journey's folder) show without asking again.
  if (!posts.species.has(e.key)) {
    posts.species.set(e.key, null);
    const q = e.type === 'video' ? `&from=${e.start}&to=${e.end}` : '';
    api(`/api/identify?name=${encodeURIComponent(e.source)}${q}`).then(res => {
      if (res.result) { posts.species.set(e.key, res.result); if (curEntry() === e) renderSpecies(e); } else posts.species.delete(e.key);
    }).catch(() => posts.species.delete(e.key));
  }
}

async function loadAiState() {
  try { posts.ai = await api('/api/ai-key'); } catch { /* keep what we know */ }
}

async function openAiDlg() {
  await loadAiState();
  const sel = $('#aiProvider');
  sel.replaceChildren(...Object.entries(posts.ai.providers).map(([k, p]) => el('option', { value: k, selected: k === posts.ai.provider ? '' : null }, p.label)));
  const sync = () => { $('#aiModel').placeholder = (posts.ai.providers[sel.value] || {}).model || ''; };
  sel.onchange = () => { $('#aiModel').value = ''; sync(); };
  sync();
  $('#aiModel').value = posts.ai.model || '';
  $('#aiKeyInput').value = '';
  $('#aiKeyInput').placeholder = posts.ai.saved ? 'A key is saved. Paste a new one to replace it.' : 'Paste your key';
  $('#aiStatus').textContent = posts.ai.saved
    ? `✓ A key for ${(posts.ai.providers[posts.ai.provider] || {}).label} is saved.`
    : 'No key saved yet.';
  $('#aiRemove').hidden = !posts.ai.saved;
  $('#aiDlg').showModal();
}

async function saveAiKey(remove) {
  try {
    await api('/api/ai-key', remove ? { remove: true }
      : { provider: $('#aiProvider').value, model: $('#aiModel').value.trim(), key: $('#aiKeyInput').value.trim() });
  } catch (err) {
    toast(err.message);
    return;
  }
  await loadAiState();
  $('#aiKeyInput').value = '';
  $('#aiDlg').close();
  toast(remove ? 'Key removed' : 'Saved. Click "Identify animals" on a photo or video post.');
  const e = curEntry();
  if (e && e.type !== 'text') renderSpecies(e);
}

// ---------- Google Maps key ----------
// The key goes from this field to the local server, which keeps it in settings.json;
// the page is only ever told whether one is saved.

async function openGoogleDlg() {
  try { posts.googleKey = (await api('/api/google-key')).saved; } catch { /* keep what we know */ }
  $('#googleStatus').textContent = posts.googleKey
    ? '✓ A Google Maps key is saved. Place names come from Google Maps.'
    : 'No key saved. Place names come from OpenStreetMap.';
  $('#googleRemove').hidden = !posts.googleKey;
  $('#googleKeyInput').value = '';
  $('#googleDlg').showModal();
}

async function saveGoogleKey(key) {
  try {
    posts.googleKey = (await api('/api/google-key', { key })).saved;
  } catch (err) {
    toast(err.message);
    return;
  }
  $('#googleKeyInput').value = '';
  $('#googleDlg').close();
  // Names already shown came from the other provider: look them up again.
  posts.places.clear();
  toast(posts.googleKey ? 'Google Maps key saved' : 'Key removed: place names come from OpenStreetMap again');
  const e = curEntry();
  if (e && e.type !== 'text') renderGeo(e);
}

function appendTo(field, line) {
  const e = curEntry();
  if (!e) return;
  const cur = (postView(e)[field] || '').trimEnd();
  editPost({ [field]: cur ? `${cur}\n${line}` : line });
  if (field === 'text') $('#pText').value = postView(e).text;
  else $('#pCaption').value = postView(e).caption;
}

// ---------- preview ----------

function drawPostPreview() {
  const e = curEntry();
  if (e) renderPost($('#postCanvas'), postView(e), posts.media, PREVIEW_SCALE);
}

function stopPostVideo() {
  cancelAnimationFrame(posts.raf);
  const m = posts.media;
  if (m instanceof HTMLVideoElement) {
    m.pause();
    m.removeAttribute('src');
    m.load();
  }
  posts.media = null;
  posts.mediaKey = null;
}

async function loadPostMedia() {
  const e = curEntry();
  const key = e && e.type !== 'text' ? `${e.type}:${e.source}` : null;
  if (key && key === posts.mediaKey && posts.media) {
    // Same file as before (e.g. another scene of the same video): just jump.
    if (e.type === 'video') { posts.media.pause(); posts.media.currentTime = e.start; }
    drawPostPreview();
    updatePlayBar();
    return;
  }
  stopPostVideo();
  posts.mediaKey = key;
  drawPostPreview();
  updatePlayBar();
  if (!key) return;
  if (e.type === 'image') {
    try {
      const img = await loadImageEl(e.source);
      if (posts.mediaKey === key) { posts.media = img; drawPostPreview(); }
    } catch {
      if (posts.mediaKey === key) toast(`Could not load ${e.source}`);
    }
    return;
  }
  const v = document.createElement('video');
  v.preload = 'auto';
  v.addEventListener('loadeddata', () => {
    const ce = curEntry();
    if (posts.media === v && ce && ce.type === 'video') v.currentTime = ce.start;
  }, { once: true });
  v.addEventListener('seeked', () => { if (posts.media === v) { drawPostPreview(); updatePlayBar(); } });
  // Formats the browser can't play get the same small preview copy as in the Pick view.
  v.addEventListener('error', () => {
    if (posts.media !== v || v.dataset.preview) return;
    v.dataset.preview = '1';
    toast('Creating a preview of this video…');
    v.src = '/preview?name=' + encodeURIComponent(e.source);
  });
  v.rot = rotOf(e.source);
  v.srcName = e.source;
  v.defaultPlaybackRate = e.speed || 1;
  v.preservesPitch = true;
  v.addEventListener('loadedmetadata', () => { v.playbackRate = e.speed || 1; }, { once: true });
  posts.media = v;
  v.src = mediaUrl({ name: e.source });
}

function togglePostPlay() {
  const v = posts.media, e = curEntry();
  if (!(v instanceof HTMLVideoElement) || !e || e.type !== 'video') return;
  if (v.paused) {
    if (v.currentTime < e.start - 0.05 || v.currentTime >= e.end - 0.05) v.currentTime = e.start;
    v.playbackRate = e.speed || 1;
    v.play().catch(() => {});
    postLoop();
  } else {
    v.pause();
  }
  updatePlayBar();
}

// Plays only the scene: stops at its end and goes back to its start.
function postLoop() {
  const v = posts.media, e = curEntry();
  if (!(v instanceof HTMLVideoElement) || !e || e.type !== 'video') return;
  if (v.currentTime >= e.end) {
    v.pause();
    v.currentTime = e.start;
  } else {
    drawPostPreview();
  }
  updatePlayBar();
  if (!v.paused) posts.raf = requestAnimationFrame(postLoop);
}

function updatePlayBar() {
  const e = curEntry();
  const isVideo = !!e && e.type === 'video';
  $('#postPlayBar').hidden = !isVideo;
  if (!isVideo) return;
  const v = posts.media instanceof HTMLVideoElement ? posts.media : null;
  $('#postPlay').textContent = v && !v.paused ? '❚❚ Pause' : '▶ Play';
  const t = v ? Math.min(Math.max(0, (v.currentTime - e.start) / (e.speed || 1)), postLen(e)) : 0;
  $('#postTime').textContent = `${fmtTime(t)} / ${fmtTime(postLen(e))}`;
}

// ---------- saving and loading ----------

function savePosts() {
  clearTimeout(posts.saveTimer);
  posts.saveTimer = setTimeout(flushPosts, 500);
  updatePostsSummary();
}

async function flushPosts() {
  if (!posts.saveTimer) return;
  clearTimeout(posts.saveTimer);
  posts.saveTimer = null;
  // The folder is sent along, so a save that arrives after switching folders is ignored.
  try {
    await api('/api/posts', { folder: posts.folder, data: posts.data });
  } catch (err) {
    toast('Could not save posts: ' + err.message);
  }
}

async function loadPosts() {
  await flushPosts();
  stopPostVideo();
  let data = null;
  try { if (state.folder) data = (await api('/api/posts')).data; } catch (err) { toast(err.message); }
  posts.folder = state.folder;
  posts.migrated = false;
  posts.dropped = false;
  posts.data = migratePosts(data);
  posts.selKey = null;
  await loadReleases();
  refreshPosts();
  if (posts.migrated) {
    savePosts();
    toast('Text from photo and video posts was moved into their captions');
  }
  if (posts.dropped) savePosts();
  // Picks that are in no release (made before drafts existed): they are the draft.
  if (!hasDraft() && exportList().length) {
    posts.data.draft = { created: nowStamp() };
    savePosts();
  }
}

// Stars and scenes may have changed in the Pick view: rebuild the gallery from them.
function refreshPosts() {
  buildEntries();
  if (!posts.entries.some(e => e.key === posts.selKey)) {
    // First choice: a new post, else one waiting to be published, else any.
    const list = visibleEntries();
    const first = list.find(isNew) || list.find(e => postStatus(e.key).state === 'prepared') || list[0];
    posts.selKey = first ? first.key : null;
  }
  updatePostsSummary();
  if (inPostsView()) {
    renderGallery();
    renderEditor();
    loadPostMedia();
  }
}

// ---------- export ----------

const fileBase = name => name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\s]+/g, '_').slice(0, 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Retries when the connection itself failed (fetch throws a TypeError, "Failed to
// fetch"). Errors the tool reports (missing file, ffmpeg error) are not retried.
// Only used for steps that are safe to repeat: they write the same file again.
async function apiRetry(url, body, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await api(url, body);
    } catch (err) {
      if (!(err instanceof TypeError) || i >= tries) throw err;
      await sleep(1000 * i);
    }
  }
}

// A video post is made by a job on the server; the page asks every second whether
// it's done, so a long 4K export doesn't depend on one open connection.
async function exportVideoPost(body) {
  const { job } = await apiRetry('/api/posts/video', body);
  for (;;) {
    await sleep(1000);
    const st = await apiRetry(`/api/posts/video-job?id=${job}`, undefined, 10);
    if (st.done) {
      if (st.error) throw new Error(st.error);
      return st;
    }
  }
}

// What a release takes: the draft, i.e. every post not in a release yet.
const exportList = () => exportEntries().filter(isNew);

// Releases live in their folders (WhatsApp\Releases); the server reads them.
async function loadReleases() {
  if (!state.folder) { posts.releases = []; return; }
  try {
    const r = await api('/api/releases');
    posts.releases = r.releases;
    posts.limits = r.limits;
  } catch (err) {
    toast('Could not read releases: ' + err.message);
  }
}

// "2026-10-26 release 1", "… release 2", … counting the releases made that day.
function nextReleaseName() {
  const day = nowStamp().slice(0, 10);
  const used = posts.releases.filter(r => r.release.startsWith(day)).map(r => Number(r.release.split(' ').pop()) || 0);
  return `${day} release ${Math.max(0, ...used) + 1}`;
}

// The files a release will contain, in posting order. Videos longer than WhatsApp
// shows are split into equal pieces ("1/2", "2/2"); the caption goes with the first.
function releaseItems(list) {
  const L = posts.limits;
  const items = [];
  for (const e of list) {
    const v = postView(e);
    if (e.type === 'video' && postLen(e) > L.maxVideoSeconds) {
      const k = Math.ceil(postLen(e) / L.maxVideoSeconds);
      const seg = (e.end - e.start) / k; // in the original video's time
      for (let i = 0; i < k; i++) {
        items.push({ e, v, start: e.start + i * seg, end: e.start + (i + 1) * seg, piece: `${i + 1}/${k}`, caption: i === 0 ? fullCaption(e, v) : '' });
      }
    } else {
      items.push({ e, v, start: e.start, end: e.end, piece: null, caption: fullCaption(e, v) });
    }
  }
  return items;
}

const isIntroItem = it => !!(it.e.cfg && it.e.cfg.intro);
const itemDay = it => (it.e.cfg && it.e.cfg.intro ? it.e.cfg.intro.day : it.e.time || '').slice(0, 10);

// A day intro made for the start of a part, not stored as a post: the day's own intro
// (date, map, place) again with "Fortsetzung" under the date when the day was begun
// in an earlier part or release; a plain intro for a day that has none of its own.
function autoIntroItem(day) {
  const t = introFor(day);
  const date = ((t && t.text) || germanDay(day)).trim();
  const caption = ((t && t.caption) || '').trim();
  const e = {
    kind: 'text', type: 'text', key: `auto:${day}`, removed: false, time: `${day}T00:00:00`,
    cfg: {
      intro: { day }, auto: t ? 'continuation' : 'intro', bg: (t && t.bg) || INTRO_BG,
      text: t ? `${date}\nFortsetzung` : date,
      caption: t ? ['Fortsetzung', caption].filter(Boolean).join(' – ') : caption,
      place: t ? t.place : undefined, noLocation: t ? t.noLocation : undefined,
    },
  };
  const v = postView(e);
  return { e, v, start: undefined, end: undefined, piece: null, caption: fullCaption(e, v) };
}

// Day intros with nothing of their day after them in this release (the next item is
// another intro, or the release ends): they would end a part, so they are left out.
function emptyIntros(items) {
  return items.filter((it, i) => isIntroItem(it) && (!items[i + 1] || isIntroItem(items[i + 1])));
}

// The day a part begins in, or null when it begins with a day intro. Text posts in
// front of it don't count: they take their day from the post before them, which for a
// text at the very beginning of a release is a post of an earlier release (so a text
// put first would otherwise open the part with "Fortsetzung" of a long-gone day).
function partStartDay(items, i) {
  for (let j = i; j < items.length; j++) {
    if (isIntroItem(items[j])) return null;
    if (items[j].e.kind === 'media') return itemDay(items[j]) || null;
  }
  return null;
}

// More files than WhatsApp takes at once: split into parts that belong together.
// Every part starts with a day intro (an automatic one when the part begins in the
// middle of a day) and no part ends with one.
function releaseParts(allItems) {
  const max = posts.limits.maxPosts;
  const drop = new Set(emptyIntros(allItems));
  const items = allItems.filter(it => !drop.has(it));
  const parts = [];
  let i = 0;
  while (i < items.length) {
    const part = [];
    const day = partStartDay(items, i);
    if (day) part.push(autoIntroItem(day));
    while (i < items.length && part.length < max) part.push(items[i++]);
    // An intro at the end goes to the next part, together with its day.
    while (part.length > 1 && i < items.length && isIntroItem(part[part.length - 1])) {
      part.pop();
      i--;
    }
    parts.push(part);
  }
  if (!parts.length) parts.push([]);
  return parts.map((p, k) => ({ name: `part ${k + 1} of ${parts.length}`, items: p }));
}

function openPostsExport() {
  if (!hasDraft() || !exportList().length) { toast('Pick photos and scenes for the release first'); return; }
  updatePostsExportInfo();
  $('#postsSetup').hidden = false;
  $('#postsProgress').hidden = true;
  $('#postsDlg').showModal();
}

function updatePostsExportInfo() {
  const L = posts.limits;
  const list = exportList();
  const items = releaseItems(list);
  const parts = releaseParts(items);
  const files = parts.flatMap(p => p.items);
  const name = nextReleaseName();
  $('#postsGo').disabled = !files.length;
  $('#postsExportSummary').textContent = !files.length ? 'Nothing to release with this choice.'
    : `${list.length} post${list.length === 1 ? ' becomes' : 's become'} ${draftTitle()}` +
      (parts.length > 1
        ? ` in ${parts.length} parts (${parts.map(p => p.items.length).join(' + ')} files), because WhatsApp takes at most ${L.maxPosts} at once.`
        : ` (${files.length} file${files.length === 1 ? '' : 's'}).`) +
      ` Folder: WhatsApp\\Releases\\${name}. Numbered in posting order (01_…, 02_…) across all parts.`;
  const warn = $('#postsWarnings');
  warn.replaceChildren();
  const split = list.filter(e => postLen(e) > L.maxVideoSeconds).length;
  const captions = files.filter(it => it.caption).length;
  if (split) warn.append(el('li', {}, `${split} video${split === 1 ? ' is' : 's are'} longer than ${L.maxVideoSeconds} s and will be split into pieces (WhatsApp Status shows at most ${L.maxVideoSeconds} s).`));
  // Day intros made for the start of a part, and intros left out.
  for (const p of parts) {
    const a = p.items[0] && p.items[0].e.cfg.auto;
    if (a) {
      warn.append(el('li', {}, `${p.name[0].toUpperCase()}${p.name.slice(1)} begins on ${germanDay(itemDay(p.items[0]))}: ` +
        (a === 'continuation' ? 'it starts with that day\'s intro again, marked "Fortsetzung".' : 'that day has no intro, so a plain one (date and map) is added.')));
    }
  }
  const empty = emptyIntros(items);
  if (empty.length) {
    warn.append(el('li', {}, `Left out: the day intro for ${empty.map(it => germanDay(itemDay(it))).join(', ')}, because nothing of that day follows it in this release.`));
  }
  warn.append(el('li', { style: 'color: var(--muted)' },
    `Within WhatsApp's limits: videos MP4, at most ${L.maxVideoSide >= 1920 ? '1080p' : `${L.maxVideoSide} px`}, ${L.maxVideoMB} MB and ${L.maxVideoSeconds} s; photos at most ${L.maxImageSide} px.`));
  if (captions) warn.append(el('li', { style: 'color: var(--muted)' }, `${captions} caption${captions === 1 ? ' goes' : 's go'} into each part's release.json and captions.txt.`));
}

// "beach", "DJI_0042_95s", "DJI_0042_95s_1of2", "text": the file name after its number.
const releaseFileBase = it => (it.e.type === 'text' ? 'text' : fileBase(it.e.source) + (it.e.type === 'video' ? `_${Math.floor(it.start)}s` : '')) +
  (it.piece ? `_${it.piece.replace('/', 'of')}` : '');

// Makes one file of a release part (it: from releaseItems) and returns its entry for
// the part's release.json. reuse: copy a video rendered earlier instead of rendering
// it again (not when a changed post replaces its own file).
async function makeReleaseFile(where, it, n, canvas, reuse) {
  const L = posts.limits;
  const { e, v } = it;
  const base = releaseFileBase(it);
  let file = `${pad2(n)}_${base}`;
  let reused = false;
  if (e.type === 'video') {
    file += '.mp4';
    const res = await exportVideoPost({ ...where, file, source: e.source, start: it.start, end: it.end, speed: e.speed || 1, reuseBase: reuse ? base : undefined });
    reused = !!(res && res.reused);
  } else if (e.type === 'image') {
    // The photo unchanged if it is a JPEG within the size limit, otherwise
    // scaled down (the canvas also applies its rotation).
    const img = await loadImageEl(e.source);
    const ext = e.source.split('.').pop().toLowerCase();
    const big = Math.max(img.naturalWidth, img.naturalHeight);
    const rot = rotOf(e.source);
    if (rot) {
      // Turned in Pick: drawn turned (and scaled down if needed) as a new JPEG.
      const c = turnedCanvas(img, rot, Math.min(1, L.maxImageSide / big));
      file += '.jpg';
      await apiRetry('/api/posts/image', { ...where, file, data: c.toDataURL('image/jpeg', 0.92) });
    } else if ((ext === 'jpg' || ext === 'jpeg') && big <= L.maxImageSide) {
      file += `.${ext}`;
      await apiRetry('/api/posts/copy', { ...where, file, source: e.source });
    } else {
      const f = Math.min(1, L.maxImageSide / big);
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * f);
      c.height = Math.round(img.naturalHeight * f);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      file += '.jpg';
      await apiRetry('/api/posts/image', { ...where, file, data: c.toDataURL('image/jpeg', 0.9) });
    }
  } else {
    // A text post. A day intro needs its map loaded before it is drawn.
    if (v.intro) {
      const s = dayMapState(v.intro.day);
      if (s.ready) await s.ready;
      if (s.error) throw new Error(s.error);
    }
    renderPost(canvas, v, null, 1, false);
    file += '.jpg';
    await apiRetry('/api/posts/image', { ...where, file, data: canvas.toDataURL('image/jpeg', 0.92) });
  }
  // Everything about this file, for the part's release.json.
  const g = e.kind === 'media' ? geoFor(e) : null;
  const place = g ? posts.places.get(geoKey(g)) : null;
  const entry = {
    n, file, type: e.type, key: it.piece ? `${e.key}#${it.piece}` : e.key, postKey: e.key,
    source: e.source || null,
    start: e.type === 'video' ? Math.round(it.start * 1000) / 1000 : undefined,
    end: e.type === 'video' ? Math.round(it.end * 1000) / 1000 : undefined,
    piece: it.piece || undefined,
    speed: e.type === 'video' && (e.speed || 1) < 1 ? e.speed : undefined,
    caption: it.caption,
    text: e.type === 'text' ? v.text.trim() : undefined,
    bg: e.type === 'text' ? v.bg : undefined,
    // Text layout, so a later change of it can be noticed.
    look: e.type === 'text' && !v.intro ? { position: v.position, style: v.style, size: v.size } : undefined,
    intro: v.intro ? {
      day: v.intro.day, pins: dayPins(v.intro.day).length,
      place: e.cfg.place ? e.cfg.place.label : undefined, noLocation: e.cfg.noLocation || undefined,
      auto: e.cfg.auto || undefined,
    } : undefined,
    format: e.type === 'text' ? undefined : 'original',
    rotate: e.kind === 'media' && rotOf(e.source) ? rotOf(e.source) : undefined,
    taken: e.kind === 'media' ? addSeconds(e.time, it.start - e.start) || undefined : undefined,
    location: g ? {
      lat: g.lat, lon: g.lon, approxFrom: g.from || undefined,
      place: place ? [place.poi, place.name, place.country].filter(Boolean).join(', ') : undefined,
    } : undefined,
  };
  return { entry, reused };
}

// Brings files of a part that is not sent yet up to date with their posts: a new
// caption only goes into release.json and captions.txt; a changed picture (text,
// colors, format, day intro place) is made again. Returns false if something failed.
async function updateInRelease(r, p, items) {
  const where = { release: r.release, part: p.part };
  const canvas = document.createElement('canvas');
  canvas.width = SW;
  canvas.height = SH;
  const errors = [];
  let done = 0;
  await flushPosts();
  for (const item of items) {
    const e = entryFor(item.postKey || item.key);
    const changes = releaseChanges(item, e);
    if (!changes) continue;
    toast(`Updating ${item.file} …`);
    try {
      const v = postView(e);
      const first = !item.piece || item.piece.startsWith('1/');
      const it = { e, v, start: item.start ?? e.start, end: item.end ?? e.end, piece: item.piece || null, caption: first ? fullCaption(e, v) : '' };
      const next = changes.includes('picture')
        ? (await makeReleaseFile(where, it, Number(item.file.split('_')[0]), canvas, false)).entry
        : { ...item, caption: it.caption };
      await api('/api/releases/item', { ...where, key: item.key, item: next });
      done++;
    } catch (err) {
      errors.push(`${item.file}: ${err.message}`);
    }
  }
  await loadReleases();
  renderGallery({ reveal: false });
  renderEditor();
  toast(errors.length ? `Could not update ${errors.join('; ')}` : `${done} file${done === 1 ? '' : 's'} updated in the release`);
  return !errors.length;
}

async function runPostsExport() {
  const list = exportList();
  if (!list.length) return;
  $('#postsSetup').hidden = true;
  $('#postsProgress').hidden = false;
  $('#postsErrors').replaceChildren();
  $('#postsClose').disabled = true;
  $('#postsReveal').disabled = true;
  stopPostVideo();
  const bar = $('#postsBar');
  const errors = [];
  const release = nextReleaseName();
  posts.lastRelease = release;
  const parts = releaseParts(releaseItems(list));
  const items = parts.flatMap(p => p.items);  // all files, with automatic day intros
  const created = nowStamp();
  const L = posts.limits;
  bar.max = items.length;
  bar.value = 0;
  let n = 0, ok = 0, reused = 0;
  const finish = msg => {
    $('#postsStatus').textContent = msg;
    $('#postsErrors').replaceChildren(...errors.map(x => el('li', {}, x)));
    $('#postsClose').disabled = false;
    $('#postsReveal').disabled = !ok;
    loadPostMedia();
  };
  await flushPosts();
  const canvas = document.createElement('canvas');
  canvas.width = SW;
  canvas.height = SH;
  for (const part of parts) {
    const where = { release, part: part.name };
    try {
      await apiRetry('/api/posts/prepare', where);
    } catch (err) {
      errors.push(`${part.name}: ${err.message}`);
      n += part.items.length;
      continue;
    }
    const done = [];
    const captionLines = [];
    for (const it of part.items) {
      n++;
      const name = `${pad2(n)}_${releaseFileBase(it)}`;
      $('#postsStatus').textContent = `${n} of ${items.length} (${part.name}): ${name}` + (it.e.type === 'video' ? ' (videos take a while)' : '');
      try {
        const res = await makeReleaseFile(where, it, n, canvas, true);
        if (res.reused) reused++;
        done.push(res.entry);
        ok++;
        if (it.caption) captionLines.push(`${pad2(n)}  (${res.entry.file})\n${it.caption}\n`);
      } catch (err) {
        errors.push(`${name}: ${err.message || 'could not be created'}`);
      }
      bar.value = n;
    }
    try {
      await apiRetry('/api/posts/captions', { ...where, text: captionLines.join('\n') });
      if (done.length) await apiRetry('/api/releases/manifest', { ...where, manifest: { created, items: done } });
    } catch (err) {
      errors.push(`${part.name}: ${err.message}`);
    }
  }
  await loadReleases();
  // The draft is a release now. A failed file stays in the draft (it's in no release
  // yet), so it can be tried again with a new draft.
  const title = `Release ${releaseTitle(release)}`;
  delete posts.data.draft;
  savePosts();
  setMode('releases', true);  // redrawn even when Releases is open already
  finish(`Done. ${ok} of ${items.length} files in ${title}` +
    (parts.length > 1 ? `, ${parts.length} parts` : '') +
    (reused ? ` (${reused} video${reused === 1 ? '' : 's'} reused from an earlier export)` : '') +
    '. Publish it part by part with its Publish button.');
}

function sentChip(sent, total) {
  if (total && sent === total) return el('span', { class: 'chip sent' }, '✓ Sent');
  if (sent) return el('span', { class: 'chip prepared' }, `${sent} of ${total} sent`);
  return el('span', { class: 'chip prepared' }, 'Ready, not sent');
}

// ---------- publishing to WhatsApp (server: publisher.js) ----------

let publishPoll = null;
let publishSeen = -1;

function renderPublishPanel(job, note) {
  const panel = $('#publishPanel');
  panel.hidden = false;
  panel.classList.toggle('error', !!(job && job.error));
  panel.replaceChildren();
  if (note) {
    panel.append(el('span', { class: 'text' }, note));
    return;
  }
  const where = `${job.part} of release ${releaseTitle(job.release)}`;
  if (job.running) {
    const bar = el('progress', { max: String(job.total) });
    bar.value = job.done;
    panel.append(
      el('span', { class: 'text' }, `Publishing ${where}: ${job.done} of ${job.total} sent` +
        (job.current ? ` · now: ${job.current}` : '') + (job.stopRequested ? ' · stopping after this post …' : '')),
      bar,
      el('button', { disabled: job.stopRequested ? '' : null, onclick: () => api('/api/publish/stop', {}).catch(err => toast(err.message)) }, '■ Stop after this post'));
  } else {
    const msg = job.error
      ? `⚠ ${where}: stopped after ${job.done} of ${job.total}. ${job.error}. Posts that went out are ticked; click Publish again to continue with the rest.`
      : job.stopped ? `■ ${where}: stopped after ${job.done} of ${job.total}, as asked. Click Publish to continue.`
        : `✓ ${where} is published: ${job.done} of ${job.total} posts sent.`;
    panel.append(el('span', { class: 'text' }, msg), el('button', { onclick: () => { panel.hidden = true; } }, 'Close'));
  }
}

// Follows a running publish: progress panel, and the ticks in the list as posts go out.
function watchPublish() {
  clearInterval(publishPoll);
  publishPoll = setInterval(async () => {
    const st = await api('/api/publish/status').catch(() => null);
    if (!st || !st.job) return;
    if (inPostsView()) renderPublishPanel(st.job);
    if (st.job.done !== publishSeen || !st.job.running) {
      publishSeen = st.job.done;
      await loadReleases();
      if (inPostsView()) {
        renderGallery({ reveal: false });
        renderEditor();
      }
      updatePostsSummary();
    }
    if (!st.job.running) { clearInterval(publishPoll); publishPoll = null; }
  }, 2000);
}

// ---------- spelling check before publishing ----------

// What a part still sends that someone wrote: captions, and the text of text posts.
// The release files may be older; what counts is the post as it is now (changed posts
// are updated in the release before publishing).
function spellFields(p) {
  const out = [], seen = new Set();
  for (const item of p.items) {
    if (item.sentAt) continue;
    const key = item.postKey || item.key;
    if (seen.has(key)) continue;
    seen.add(key);
    const e = entryFor(key);
    if (!e) continue;
    const v = postView(e);
    if (v.caption.trim()) out.push({ e, n: item.n, field: 'caption', text: v.caption });
    if (e.type === 'text' && !e.cfg.intro && v.text.trim()) out.push({ e, n: item.n, field: 'text', text: v.text });
  }
  return out;
}

// Resolves true to go on publishing, false to stop.
async function spellcheckBeforePublish(p) {
  const fields = spellFields(p);
  if (!fields.length) return true;
  toast('Checking spelling …');
  let results;
  try {
    ({ results } = await api('/api/spellcheck', { texts: fields.map(f => f.text) }));
  } catch (err) {
    return confirm(`The spelling check did not work: ${err.message}.\n\nPublish without it?`);
  }
  const issues = [];
  fields.forEach((f, i) => (results[i] || []).forEach(m =>
    issues.push({ ...m, f, at: m.offset, orig: f.text.substr(m.offset, m.length) })));
  if (!issues.length) { toast('✓ Spelling check: nothing found'); return true; }
  return new Promise(resolve => showSpellDialog(issues, resolve));
}

// Replaces the marked words in the post itself; later marks in the same text move along.
function applySpellFix(issue, value, issues) {
  const cfg = cfgFor(issue.f.e);
  const cur = cfg[issue.f.field] || '';
  if (cur.substr(issue.offset, issue.length) !== issue.orig) { toast('That text was changed in the meantime'); return false; }
  cfg[issue.f.field] = cur.slice(0, issue.offset) + value + cur.slice(issue.offset + issue.length);
  const delta = value.length - issue.length;
  for (const o of issues) {
    if (o !== issue && o.f.e === issue.f.e && o.f.field === issue.f.field && o.offset > issue.offset) o.offset += delta;
  }
  savePosts();
  return true;
}

function showSpellDialog(issues, resolve) {
  const dlg = $('#spellDlg'), list = $('#spellList');
  let open = issues.length, changed = false;
  const count = () => {
    $('#spellCount').textContent = open
      ? `${open} possible mistake${open === 1 ? '' : 's'} in the posts that go out:`
      : '✓ All checked.';
  };
  list.replaceChildren();
  for (const issue of issues) {
    const t = issue.f.text, a = issue.at;
    const row = el('li', {});
    const done = label => {
      row.classList.add('done');
      row.replaceChildren(el('span', { class: 'muted' }, `#${pad2(issue.f.n)} · ${label}`));
      open--;
      count();
    };
    row.append(
      el('div', { class: 'where muted' }, `#${pad2(issue.f.n)} · ${issue.f.field === 'text' ? 'text on the post' : 'caption'}`),
      el('div', { class: 'ctx' }, (a > 50 ? '…' : '') + t.slice(Math.max(0, a - 50), a),
        el('mark', {}, issue.orig || ' '), t.slice(a + issue.length, a + issue.length + 50) + (a + issue.length + 50 < t.length ? '…' : '')),
      el('div', { class: 'msg' }, issue.message),
      el('div', { class: 'fixes' },
        ...issue.replacements.map(r => el('button', {
          onclick: () => { if (applySpellFix(issue, r, issues)) { changed = true; done(`✓ „${issue.orig}" → „${r}"`); } },
        }, r === '' ? '(remove)' : r)),
        el('button', { class: 'quiet', onclick: () => done(`ignored: „${issue.orig}"`) }, 'Ignore')));
    list.append(row);
  }
  count();
  const finish = go => {
    dlg.onclose = null;
    dlg.close();
    if (changed) { renderGallery({ reveal: false }); renderEditor(); }
    resolve(go);
  };
  $('#spellGo').onclick = () => finish(true);
  $('#spellCancel').onclick = () => finish(false);
  dlg.onclose = () => finish(false);  // Esc
  dlg.showModal();
}

async function publishPart(r, p) {
  if (!(await spellcheckBeforePublish(p))) return;
  const unsent = p.items.filter(i => !i.sentAt).length;
  const changed = p.items.filter(i => releaseChanges(i));
  if (!confirm(`Publish ${p.part} of release ${releaseTitle(r.release)} to WhatsApp now?\n\n` +
    `${unsent} post${unsent === 1 ? '' : 's'} go to your WhatsApp Status, in order and with their captions. ` +
    'Each is ticked as sent as soon as WhatsApp has sent it.' +
    (changed.length ? `\n\n${changed.length} post${changed.length === 1 ? ' was' : 's were'} changed after the release was made; ` +
      `${changed.length === 1 ? 'it is' : 'they are'} updated in the release first.` : ''))) return;
  try {
    let st = await api('/api/publish/status');
    if (st.browser === 'missing') { toast('Google Chrome was not found on this PC'); return; }
    if (st.job && st.job.running) { toast('A part is being published already'); return; }
    if (changed.length) {
      renderPublishPanel(null, `✎ Updating ${changed.length} changed post${changed.length === 1 ? '' : 's'} in the release …`);
      if (!(await updateInRelease(r, p, changed))) {
        renderPublishPanel(null, '⚠ Not every changed post could be updated in the release, so nothing was published. Check the message, then click Publish again.');
        return;
      }
    }
    if (st.login !== 'ready') {
      await api('/api/publish/open', {});
      // First time (or after signing out): sign in once in that window.
      for (let i = 0; i < 300; i++) {
        st = await api('/api/publish/status');
        if (st.login === 'ready') break;
        renderPublishPanel(null, st.login === 'signin'
          ? '🔑 Sign in to WhatsApp in the Chrome window that opened: on your phone, WhatsApp → Linked devices → Link a device, then scan the QR code. Publishing starts by itself afterwards.'
          : st.login === 'closed' ? 'The WhatsApp window was closed. Click Publish again.' : '⏳ Opening WhatsApp Web …');
        if (st.login === 'closed') return;
        await sleep(1500);
      }
      if (st.login !== 'ready') { renderPublishPanel(null, 'WhatsApp Web did not get ready. Click Publish again.'); return; }
    }
    const { job } = await api('/api/publish/start', { release: r.release, part: p.part });
    publishSeen = -1;
    renderPublishPanel(job);
    watchPublish();
  } catch (err) {
    renderPublishPanel({ release: r.release, part: p.part, done: 0, total: unsent, error: err.message });
  }
}

async function setPartSent(r, p, keys, sent) {
  try {
    await api('/api/releases/sent', { release: r.release, part: p.part, keys, sent });
  } catch (err) {
    toast(err.message);
  }
  await loadReleases();
  renderGallery({ reveal: false });
  renderEditor();
}

// Open or collapsed in the gallery. Fully sent parts start collapsed
// (just their header line); a click on the header toggles, and that choice is
// remembered in this browser.
function loadOpenState() {
  try { return JSON.parse(localStorage.getItem('media-picker-open') || '{}'); } catch { return {}; }
}

function isOpen(key, openByDefault) {
  const saved = loadOpenState()[key];
  return typeof saved === 'boolean' ? saved : openByDefault;
}

function toggleOpen(key, open) {
  const s = loadOpenState();
  s[key] = !open;
  try { localStorage.setItem('media-picker-open', JSON.stringify(s)); } catch { /* storage unavailable */ }
  renderGallery({ reveal: false });
}

const chevron = (key, open) => el('button', {
  class: 'chev-btn', title: open ? 'Collapse' : 'Expand', onclick: () => toggleOpen(key, open),
}, ic(open ? 'down' : 'right'));

// ---------- switching views ----------

// Inside a journey: Releases (the draft and the releases), Pick (the gallery, picking
// for the draft) and Arrange (the draft's posts). Releases and Arrange share the posts
// view. "journeys" is the list of journeys (journeys.js).
const MODES = ['releases', 'pick', 'arrange', 'favorites', 'journeys'];
const MODE_VIEW = { releases: 'postsView', pick: 'pickView', arrange: 'postsView', favorites: 'pickView', journeys: 'journeysView' };
const inPostsView = () => state.mode === 'releases' || state.mode === 'arrange';

// The step you were in last time (Releases if none, or from older versions).
function lastStep() {
  try {
    const saved = localStorage.getItem('media-picker-mode');
    // Pick and Compose are steps inside the release being made: only with a draft.
    if (saved === 'favorites') return saved;
    return (saved === 'pick' || saved === 'arrange') && hasDraft() ? saved : 'releases';
  } catch { return 'releases'; }
}

// force: apply even if the mode is already set (first call on page load).
function setMode(mode, force = false) {
  if (state.mode === mode && !force) return;
  const wasPosts = inPostsView();
  const cameFrom = state.mode;
  state.mode = mode;
  for (const m of MODES) {
    document.body.classList.toggle(`mode-${m}`, m === mode);
    const tab = $(`#tab${m[0].toUpperCase()}${m.slice(1)}`);
    if (tab) tab.classList.toggle('on', m === mode);
  }
  // Favorites uses the Pick view (gallery and large view), without picking.
  if (mode === 'favorites') document.body.classList.add('mode-pick');
  // Inside the release being made (Pick, Compose): its name and steps in the header.
  document.body.classList.toggle('in-draft', mode === 'pick' || mode === 'arrange');
  $('#draftLabel').textContent = hasDraft() ? draftTitle() : 'New release';
  for (const v of new Set(Object.values(MODE_VIEW))) $(`#${v}`).hidden = v !== MODE_VIEW[mode];
  document.body.classList.toggle('mode-posts', inPostsView());
  if (!inPickView()) {
    const v = video();
    if (v) v.pause();
    toggleFocus(false);
  }
  if (inPickView()) {
    // Favorites shows only favorites; Pick starts with all files.
    const lovedOnly = mode === 'favorites';
    if (state.lovedOnly !== lovedOnly) setLovedOnly(lovedOnly); else renderList();
    renderStageTools();
    renderPickBar();
    // Back to the release being made: start at the first day that isn't released yet.
    if (mode === 'pick' && cameFrom !== 'pick' && hasDraft()) jumpToNewDays();
  }
  if (inPostsView()) {
    // Only posts of this view can stay selected.
    if (mode === 'arrange' && posts.selKey && !isNew({ key: posts.selKey })) posts.selKey = null;
    refreshPosts();
    // Back to the release being made: start at its first (oldest) post, at the top.
    if (mode === 'arrange' && cameFrom !== 'arrange') {
      const first = $('#gallery .card[data-key]:not(.slot):not(.rel)');
      if (first) selectEntry(first.dataset.key);
      $('#gallery').scrollTop = 0;
    }
    // A publish that is still running (e.g. after reloading the page): show its progress again.
    api('/api/publish/status').then(st => {
      if (st.job && st.job.running) { renderPublishPanel(st.job); watchPublish(); }
    }).catch(() => {});
    // Release folders may have changed meanwhile (e.g. a part was published): read them again.
    if (state.folder) {
      loadReleases().then(() => {
        if (!inPostsView()) return;
        renderGallery({ reveal: false });
        renderEditor();
      });
    }
  } else if (wasPosts || force) {
    stopPostVideo();
    flushPosts();
  }
  // The step to come back to in a journey (the journeys list is not one).
  if (mode !== 'journeys') try { localStorage.setItem('media-picker-mode', mode); } catch { /* storage unavailable */ }
}

function onPostsKey(e) {
  if (!inPostsView() || document.querySelector('dialog[open]')) return;
  const tag = e.target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && e.target.type !== 'checkbox')) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  let handled = true;
  switch (e.key) {
    // Shift + arrow moves the selected post, plain arrows select the next one.
    case 'ArrowRight': case 'ArrowDown': if (e.shiftKey) stepPost(1); else stepEntry(1); break;
    case 'ArrowLeft': case 'ArrowUp': if (e.shiftKey) stepPost(-1); else stepEntry(-1); break;
    case ' ': togglePostPlay(); break;
    case 'Delete': toggleRemoved(); break;
    default: handled = false;
  }
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  }
}

function initPosts() {
  for (const c of BG_COLORS) {
    $('#pBg').append(el('button', { 'data-v': c, title: c, style: `background:${c}`, onclick: () => editPost({ bg: c }) }));
  }
  for (const [id, key] of [['#pPos', 'position'], ['#pStyle', 'style'], ['#pSize', 'size']]) {
    $(id).addEventListener('click', ev => {
      const b = ev.target.closest('button');
      if (b) editPost({ [key]: b.dataset.v });
    });
  }
  $('#pText').addEventListener('input', ev => editPost({ text: ev.target.value }));
  $('#pCaption').addEventListener('input', ev => editPost({ caption: ev.target.value }));
  $('#pCopyCaption').addEventListener('click', async () => {
    const e = curEntry();
    const text = e ? fullCaption(e, postView(e)) : '';
    if (!text) { toast('This post has no caption'); return; }
    try { await navigator.clipboard.writeText(text); toast('Caption copied'); } catch { toast('Could not copy'); }
  });
  $('#pRemove').addEventListener('click', toggleRemoved);
  $('#pEarlier').addEventListener('click', () => stepPost(-1));
  $('#pLater').addEventListener('click', () => stepPost(1));
  $('#googleSave').addEventListener('click', () => {
    const key = $('#googleKeyInput').value.trim();
    if (!key) { toast('Paste your API key first'); return; }
    saveGoogleKey(key);
  });
  $('#googleRemove').addEventListener('click', () => saveGoogleKey(''));
  $('#googleCancel').addEventListener('click', () => { $('#googleKeyInput').value = ''; $('#googleDlg').close(); });
  api('/api/google-key').then(r => { posts.googleKey = r.saved; }).catch(() => {});
  $('#aiSave').addEventListener('click', () => saveAiKey(false));
  $('#aiRemove').addEventListener('click', () => saveAiKey(true));
  $('#aiCancel').addEventListener('click', () => { $('#aiKeyInput').value = ''; $('#aiDlg').close(); });
  loadAiState();
  $('#pTextBefore').addEventListener('click', () => { const e = curEntry(); if (e) insertTextBefore(e); });
  $('#pTextAfter').addEventListener('click', () => { const e = curEntry(); if (e) insertTextAfter(e); });
  $('#postPlay').addEventListener('click', togglePostPlay);
  $('#showRemoved').addEventListener('change', ev => {
    posts.showRemoved = ev.target.checked;
    const e = curEntry();
    if (e && e.removed && !posts.showRemoved) posts.selKey = (visibleEntries()[0] || {}).key || null;
    renderGallery();
    renderEditor();
    loadPostMedia();
    ev.target.blur();
  });
  $('#tabReleases').addEventListener('click', () => setMode('releases'));
  $('#tabFavorites').addEventListener('click', () => setMode('favorites'));
  $('#tabPick').addEventListener('click', () => setMode('pick'));
  $('#tabArrange').addEventListener('click', () => {
    if (!hasDraft()) { toast('Start a new release first (＋ New release)'); return; }
    setMode('arrange');
  });
  $('#postsCancel').addEventListener('click', () => $('#postsDlg').close());
  $('#postsGo').addEventListener('click', runPostsExport);
  $('#postsClose').addEventListener('click', () => $('#postsDlg').close());
  $('#postsReveal').addEventListener('click', () => api('/api/reveal', posts.lastRelease ? { release: posts.lastRelease } : { releases: true }).catch(() => {}));
  $('#postsDlg').addEventListener('cancel', ev => { if ($('#postsClose').disabled && !$('#postsProgress').hidden) ev.preventDefault(); });
  window.addEventListener('keydown', onPostsKey, true);
  window.addEventListener('pagehide', () => {
    if (!posts.saveTimer) return;
    clearTimeout(posts.saveTimer);
    posts.saveTimer = null;
    navigator.sendBeacon('/api/posts', new Blob([JSON.stringify({ folder: posts.folder, data: posts.data })], { type: 'application/json' }));
  });
  setMode(lastStep(), true);
}

initPosts();
