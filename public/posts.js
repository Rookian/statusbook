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
//   texts:    text-only posts in order: { id, after: <media key or null>, at, text, caption, bg, ... };
//             a collage is one of them, with collage: { tpl, images, ... } (collage.js)
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
  limits: { maxVideoSeconds: 90, maxVideoMB: 9.9, maxVideoSide: 1920, maxVideoShort: 720, maxImageSide: 2560 },
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
    if (v.collage && item.collage) picture = item.collage !== collageSig(v.collage); // photos, layout or look changed
    // Spots on the map left out, or the time frame changed.
    const was = (item.intro && item.intro.sig) || (item.mapsum && item.mapsum.sig);
    if (was && v.map && was !== mapSig(v.map)) picture = true;
  } else if (item.format) {
    picture = item.format !== 'original';  // an old file with a blurred background
  }
  if (e.kind === 'media' && (item.rotate || 0) !== rotOf(e.source)) picture = true; // turned since
  if (e.kind === 'media' && (item.grade || '') !== Grade.gradeId(gradeOf(e.source))) picture = true; // colours changed
  if (e.kind === 'media' && (item.crop || '') !== cropKey((itemOf(e.source) || {}).crop)) picture = true; // cropped since
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
  const inCollage = collagePhotoNames();  // those photos are part of a collage post
  for (const it of state.items) {
    if (it.type === 'image' && inCollage.has(it.name)) continue;
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
    if (e.kind === 'media') {
      lastTime = e.time;
    } else if (e.cfg.intro) {
      // A day intro belongs to its own day, even though it comes after the previous day's
      // last post; so do the text posts right after it.
      e.time = lastTime = `${e.cfg.intro.day}T00:00:00`;
    } else if (e.cfg.collage) {
      // A collage belongs to the day of its first photo (where that photo was).
      const first = itemOf((e.cfg.collage.images[0] || {}).name);
      e.time = (first && first.date) || lastTime;
      lastTime = e.time > lastTime ? e.time : lastTime;
    } else {
      e.time = lastTime;
    }
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
  // A collage is a picture of its photos, without text on it.
  if (e.cfg.collage) Object.assign(v, { collage: e.cfg.collage, text: '' });
  // Day intro: fixed layout, the date on top and the map below it.
  // Without any location there is no map, so the date moves to the middle.
  if (e.cfg.intro) {
    const map = pinsOf(e.cfg);
    Object.assign(v, { intro: e.cfg.intro, map, size: 'l', style: 'shadow', bg: e.cfg.bg || INTRO_BG,
      position: map.length ? 'top' : 'middle' });
  }
  // Map summary: the same layout, its text made from the time frame unless written.
  if (e.cfg.mapsum) {
    const map = pinsOf(e.cfg);
    Object.assign(v, { mapsum: e.cfg.mapsum, map, size: 'l', style: 'shadow', bg: e.cfg.bg || INTRO_BG,
      position: map.length ? 'top' : 'middle', text: e.cfg.text || mapsumText(e.cfg) });
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

// A scene whose start or end was moved (dragged on the timeline in Pick) has a new
// key: what belongs to its post moves along.
function movePostKey(oldKey, newKey) {
  if (oldKey === newKey) return;
  const d = posts.data;
  let changed = false;
  if (d.media[oldKey]) { d.media[newKey] = d.media[oldKey]; delete d.media[oldKey]; changed = true; }
  if (Array.isArray(d.order)) {
    const k = d.order.indexOf(oldKey);
    if (k >= 0) { d.order[k] = newKey; changed = true; }
  }
  for (const t of d.texts) if (t.after === oldKey) { t.after = newKey; changed = true; }
  if (posts.selKey === oldKey) posts.selKey = newKey;
  if (posts.species.has(oldKey)) { posts.species.set(newKey, posts.species.get(oldKey)); posts.species.delete(oldKey); }
  if (changed) savePosts();
}

// ---------- drawing (shared by gallery, preview and export) ----------

function mediaSize(m) {
  return m instanceof HTMLVideoElement ? [m.videoWidth, m.videoHeight] : [m.naturalWidth, m.naturalHeight];
}

function drawBackground(ctx, post, media, scale) {
  if (post.collage) { drawCollage(ctx, post.collage, scale); return; }
  if (post.type === 'text') {
    ctx.fillStyle = post.bg || BG_COLORS[0];
    ctx.fillRect(0, 0, SW, SH);
    // A day without any location gets just the date, without an empty map box.
    if (post.map && post.map.length) drawMapBox(ctx, post.map);
    return;
  }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, SW, SH);
  if (!media) return;
  const [mw, mh] = mediaSize(media);
  if (!mw || !mh) return;
  // media.rot: the file's turn (R in Pick), set when it was loaded.
  const rot = media.rot || 0, side = rot % 180 !== 0;
  // The file's crop (K in Pick), as a part of the unturned picture.
  const it = media.srcName ? itemOf(media.srcName) : null;
  const oc = it && it.crop ? cropInOriginal(it.crop, rot) : { x: 0, y: 0, w: 1, h: 1 };
  const sw = oc.w * mw, sh = oc.h * mh;
  const f = side ? Math.min(SW / sh, SH / sw) : Math.min(SW / sw, SH / sh);
  ctx.save();
  ctx.translate(SW / 2, SH / 2);
  ctx.rotate((rot * Math.PI) / 180);
  // The file's colour grade (G in Pick), looked up fresh so a change shows at once.
  const grade = media.srcName ? gradeOf(media.srcName) : null;
  if (grade) ctx.filter = gradeCss(grade);
  ctx.drawImage(media, oc.x * mw, oc.y * mh, sw, sh, -sw * f / 2, -sh * f / 2, sw * f, sh * f);
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

// ---------- maps: day intros and map summaries ----------
// A day intro (cfg.intro = { day }) shows the spots of one day. A map summary
// (cfg.mapsum = { scope, from, to }) shows those of a time frame: scope 'range' (a week
// is a range from Monday to Sunday) or 'release' (the days of the release it goes out
// with). Both can leave out single spots: cfg.hidden = ["lat,lon", …] (pinKey).

const pinKey = p => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
const MAX_PINS = 60;

// "2026-11-16" plus n days.
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
function daysBetween(from, to) {
  const out = [];
  for (let d = from; d && d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}
// Monday of the week a day is in.
function weekStart(day) {
  const [y, m, d] = day.split('-').map(Number);
  const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDays(day, -wd);
}
// "16.11." and "16.–22.11." / "30.11.–6.12."
const shortDay = d => `${+d.slice(8, 10)}.${+d.slice(5, 7)}.`;
function dayRangeDe(from, to) {
  if (!from) return '';
  if (!to || from === to) return shortDay(from);
  return from.slice(0, 7) === to.slice(0, 7) ? `${+from.slice(8, 10)}.–${shortDay(to)}` : `${shortDay(from)}–${shortDay(to)}`;
}

// The text of a map summary until one is written: what it covers.
function mapsumText(t) {
  const days = mapsumDays(t);
  const range = dayRangeDe(days[0], days[days.length - 1]);
  if (t.mapsum.scope === 'release') return range ? `Rückblick\n${range}` : 'Rückblick';
  return t.mapsum.week ? `Die Woche\n${range}` : range;
}

// A short fingerprint of the spots on a map, to notice a change after a release was made.
function mapSig(pins) {
  let h = 5381;
  for (const ch of (pins || []).map(pinKey).join('|')) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return `${(pins || []).length}:${h.toString(36)}`;
}

// Every location from the photos and videos of that day (not only the starred
// ones), with spots closer than about 10 m merged into one pin. Each pin knows the
// first file taken there (pin.it), for the list of spots.
function autoDayPins(day) {
  const seen = new Set(), pins = [];
  const byTime = state.items.filter(it => it.geo && (it.date || '').startsWith(day))
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  for (const it of byTime) {
    const k = pinKey(it.geo);
    if (seen.has(k)) continue;
    seen.add(k);
    pins.push({ lat: it.geo.lat, lon: it.geo.lon, it });
  }
  return pins.slice(0, 80);
}

// Many spots (a week): spots close together become one pin, closer ones first,
// until the map has at most MAX_PINS (the map stays readable, the link short).
function thinPins(pins) {
  for (const dec of [3, 2, 1]) {
    if (pins.length <= MAX_PINS) break;
    const seen = new Set();
    pins = pins.filter(p => {
      const k = `${p.lat.toFixed(dec)},${p.lon.toFixed(dec)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return pins.slice(0, MAX_PINS);
}

// The days a map summary covers. A whole-release summary follows the release being
// made (and the days chosen in Review & publish); once it is in a release, the days
// it went out with (fixed when its file was made).
function mapsumDays(t) {
  const m = t.mapsum;
  if (m.scope === 'release') {
    if (m.fixed && t.id && !isNew({ key: `txt:${t.id}` })) return m.fixed.days || [];
    return [...new Set(releaseList().filter(e => e.kind === 'media').map(postDay).filter(Boolean))].sort();
  }
  return daysBetween(m.from, m.to || m.from);
}

// The pins of a day intro or map summary (t: its stored settings). all: also the
// spots that were left out.
function pinsOf(t, { all = false } = {}) {
  if (!t) return [];
  let pins = [];
  if (t.mapsum) {
    pins = thinPins(mapsumDays(t).flatMap(autoDayPins));
  } else if (t.intro) {
    if (t.noLocation) return [];
    pins = autoDayPins(t.intro.day);
    if (!pins.length && t.place) pins.push({ lat: t.place.lat, lon: t.place.lon, typed: true });
  }
  if (all || !Array.isArray(t.hidden) || !t.hidden.length) return pins;
  const hidden = new Set(t.hidden);
  return pins.filter(p => !hidden.has(pinKey(p)));
}

// The pins of a day's map: the locations from its files, or else the place typed in
// for the intro; none if the location was left out.
const dayPins = day => pinsOf(introFor(day) || { intro: { day } });

const mapUrl = pins => (pins && pins.length
  ? `/daymap?w=${MAP_BOX.w / 2}&h=${MAP_BOX.h / 2}&p=${pins.map(p => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join('|')}`
  : null);

// Loads a map once; when it arrives, the map posts and the preview are redrawn.
// A map that failed (e.g. offline) is tried again when it is needed and the last try
// is more than 15 s ago, or at once with retry (button, before making a release file).
const MAP_RETRY_MS = 15000;
function mapState(pins, { retry = false } = {}) {
  const url = mapUrl(pins);
  if (!url) return { none: true };
  let s = posts.dayMaps.get(url);
  if (s && s.error && (retry || Date.now() - s.failedAt > MAP_RETRY_MS)) {
    posts.dayMaps.delete(url);
    s = null;
  }
  if (!s) {
    s = { loading: true };
    posts.dayMaps.set(url, s);
    s.ready = new Promise(resolve => {
      const img = new Image();
      img.onload = () => { s.img = img; s.loading = false; resolve(s); redrawMaps(); };
      img.onerror = async () => {
        // The server answers errors as JSON (e.g. the API is not turned on for the key).
        try { s.error = (await (await fetch(url)).json()).error; } catch { s.error = 'Could not load the map'; }
        s.error = s.error || 'Could not load the map';
        s.failedAt = Date.now();
        s.loading = false;
        resolve(s);
        redrawMaps();
      };
      img.src = url;
    });
  }
  return s;
}
const dayMapState = (day, opts) => mapState(dayPins(day), opts);

const isMapPost = e => !!(e && e.cfg && (e.cfg.intro || e.cfg.mapsum));

// Back online: every map that failed is loaded again.
function retryFailedMaps() {
  for (const [url, s] of posts.dayMaps) if (s.error) posts.dayMaps.delete(url);
  for (const e of posts.entries) if (isMapPost(e)) mapState(postView(e).map);
  redrawMaps();
}
window.addEventListener('online', retryFailedMaps);

// A map arrived (or failed): the cards and the preview of map posts are drawn again.
let mapRedraw = 0;
function redrawMaps() {
  cancelAnimationFrame(mapRedraw);
  mapRedraw = requestAnimationFrame(() => {
    for (const e of posts.entries) if (isMapPost(e)) refreshCard(e);
    const cur = curEntry();
    if (isMapPost(cur)) { drawPostPreview(); renderEditor(); }
  });
}
const redrawIntros = () => redrawMaps();

function drawMapBox(ctx, pins) {
  const { x, y, w, h } = MAP_BOX;
  const s = mapState(pins);
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
    const msg = s.none ? 'Keine Orte' : s.error ? 'Karte nicht verfügbar' : 'Karte wird geladen …';
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
// The map link that goes into the caption: one pin opens Google Maps there, more pins
// the own map page with all of them (title on top), or else Google Maps on their area.
function mapLink(pins, title) {
  if (!pins || !pins.length) return null;
  const f = n => n.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
  if (pins.length === 1) return `https://www.google.com/maps/search/?api=1&query=${f(pins[0].lat)},${f(pins[0].lon)}`;
  if (state.mapPageUrl) {
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

// The title of a map post's link: a day intro's date and place, a summary's first line.
function mapTitle(t, v) {
  if (t.intro) return [germanDay(t.intro.day), t.place && t.place.label].filter(Boolean).join(' · ');
  return (v.text || '').split('\n').map(x => x.trim()).filter(Boolean).join(' · ');
}
const dayMapLink = day => {
  const t = introFor(day) || { intro: { day } };
  return mapLink(dayPins(day), mapTitle(t, {}));
};

// The caption that goes to WhatsApp: your text, and for a day intro its map link,
// on one line (WhatsApp Web takes no line breaks).
function fullCaption(e, v) {
  const text = (v.caption || '').trim().replace(/\s*\n\s*/g, ' ');
  const link = v.map ? mapLink(v.map, mapTitle(e.cfg, v)) : null;
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
    img.onload = () => { img.rot = rotOf(name); img.srcName = name; resolve(img); };
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

// Releases: the draft on top, then the releases, newest first (their parts in order:
// part 1 above part 2, so they get published in the right order), each part with its
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
  const sum = releasedSummary();
  if (sum) g.append(sum);
  if (posts.releases.some(r => r.parts.some(p => p.items.some(i => i.type === 'video' && i.sentAt)))) {
    g.append(el('div', { class: 'gnote export-line' },
      el('span', { class: 'grow' }, 'The video scenes you sent, in original quality, e.g. for your Google Drive.'),
      el('button', { onclick: openOriginalsExport, title: 'Cut the sent scenes from the originals, without quality loss, into a folder' }, ic('folder'), 'Export sent scenes …')));
  }
  for (const r of [...posts.releases].reverse()) {
    // A release in several parts: one line with its whole date range above them.
    if (r.parts.length > 1) {
      const all = r.parts.flatMap(p => p.items);
      g.append(el('div', { class: 'gnote rel-line' },
        el('b', {}, `Release ${releaseTitle(r.release)}`),
        ` · ${dayRange(all)} · ${plural(all.length, 'post')} in ${r.partsTotal} parts`));
    }
    if (r.parts.length < r.partsTotal) {
      g.append(el('div', { class: 'gnote warnline' }, `Release ${releaseTitle(r.release)}: only ${r.parts.length} of ${r.partsTotal} parts are complete (the export was interrupted).`));
    }
    const group = r.parts.length > 1 ? el('div', { class: 'rel-group' }) : g;
    for (const p of r.parts) group.append(partSection(r, p));
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
  // Days of this draft that are out already (published up to a day).
  const done = draftReleases();
  const doneItems = done.flatMap(r => r.parts.flatMap(p => p.items));
  const doneSent = doneItems.filter(i => i.sentAt).length;
  const doneLine = done.length ? el('div', { class: 'draft-done' },
    ic('check'),
    el('span', {}, `Partly published: ${dayRange(doneItems)} went out as ${releaseNames(done)}` +
      (doneSent === doneItems.length ? '' : ` (${doneSent} of ${doneItems.length} sent so far)`) +
      `. ${list.length ? `Still to publish: ${days || `${list.length} posts`}.` : 'Nothing left to publish.'}`)) : null;
  return el('div', { class: 'draft-card' + (done.length ? ' partly' : '') },
    ic('leaf'),
    el('b', {}, draftTitle()),
    el('span', { class: 'chip new' }, 'Draft'),
    el('span', { class: 'muted' }, list.length ? `${list.length} post${list.length === 1 ? '' : 's'}` + (days ? ` · ${days}` : '') : 'nothing picked yet'),
    el('span', { class: 'grow' }),
    el('button', { onclick: () => setMode('pick'), title: 'Step 1: pick photos and video scenes' }, ic('pick'), '1 · Pick'),
    el('button', { onclick: () => setMode('arrange'), title: 'Step 2: captions, text posts, day intros, order' }, ic('arrange'), '2 · Compose'),
    el('button', { class: 'primary', disabled: list.length ? null : '', onclick: openPostsExport, title: 'A last look, then everything goes to your WhatsApp Status' }, ic('send'), 'Review & publish'),
    el('button', { class: 'quiet', onclick: deleteDraft, title: 'Unpick everything in this draft' }, ic('trash'), 'Delete draft'),
    doneLine);
}

// What files of releases hold: photos (also those in a collage), videos (a scene split
// into pieces counts once) and text posts (day intros and text-only posts).
// sentOnly: only what went out.
function mediaCount(items, sentOnly = false) {
  const c = { photos: 0, videos: 0, texts: 0 };
  const scenes = new Set();
  for (const i of items) {
    if (sentOnly && !i.sentAt) continue;
    if (i.type === 'image') c.photos++;
    else if (i.type === 'video') scenes.add(i.postKey || i.key);
    else if (i.collage) c.photos += (i.sources || []).length || 1;
    else c.texts++;
  }
  c.videos = scenes.size;
  return c;
}
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// The whole journey's releases: how many photos and videos went out, and how many are
// in releases not sent yet.
function releasedSummary() {
  const all = posts.releases.flatMap(r => r.parts.flatMap(p => p.items));
  if (!all.length) return null;
  const sent = mediaCount(all, true), made = mediaCount(all);
  const open = (made.photos - sent.photos) + (made.videos - sent.videos);
  return el('div', { class: 'released-sum' },
    el('div', { class: 'big' }, el('b', {}, (sent.photos + sent.videos).toLocaleString()), ' photos and videos sent'),
    el('span', { class: 'muted' }, `${plural(sent.photos, 'photo')}, ${plural(sent.videos, 'video')} · in ${plural(posts.releases.length, 'release')}` +
      (open ? ` · ${open} more not sent yet` : '')));
}

// Releases made from the current draft: publishing only some of its days (Review &
// publish) leaves the rest in the draft. Every release made after the draft was started
// came from it, because a draft that is published completely ends.
function draftReleases() {
  const d = posts.data.draft;
  if (!d || !d.created) return [];
  return posts.releases.filter(r => r.created && r.created >= d.created);
}

// "Release 10" or "Releases 10 and 11", with their numbers as shown in Releases.
const releaseNames = list => {
  const nos = list.map(r => posts.releases.indexOf(r) + 1);
  return nos.length === 1 ? `Release ${nos[0]}` : `Releases ${nos.slice(0, -1).join(', ')} and ${nos[nos.length - 1]}`;
};

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
    // The photos of the draft's collages are unpicked like its other photos.
    for (const t of dropTexts) {
      for (const name of collageNames(t.collage)) {
        await api('/api/favorite', { name, value: false });
        const it = itemOf(name);
        if (it) it.favorite = false;
      }
    }
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
    el('button', { onclick: () => openCollage(), title: 'Put two to four photos of this release together as one post' }, '▦ Collage'),
    el('button', { onclick: addMapSummary, title: 'A map of the spots of a week, a time frame of your choice or the whole release' }, '🗺 Map summary'),
    el('button', {
      class: 'primary', disabled: n ? null : '', onclick: openPostsExport,
      title: 'A last look, then everything goes to your WhatsApp Status',
    }, ic('send'), 'Review & publish'),
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
// The day of each file of a release, as it was sent: a day intro's day, a photo's or
// video's time taken; a text post or collage belongs to the day of the file before it.
// (Not the post's place in Compose today, which may have moved since.) Items without a
// file are posts of the draft: their time in Compose.
function itemDays(items) {
  let prev = '';
  return items.map(i => {
    const own = ((i.intro && i.intro.day) || i.taken || '').slice(0, 10);
    if (own) return (prev = own);
    if (i.file) return prev;
    const e = entryFor(i.postKey || i.key);
    return ((e && e.time) || '').slice(0, 10);
  });
}

function dayRange(items) {
  const days = itemDays(items).filter(Boolean).sort();
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
  // Made from the draft, whose later days are not published yet.
  const fromDraft = draftReleases().includes(r) && exportList().length;
  return gallerySection(`part:${r.release}|${p.part}`, !allSent, allSent ? 'gsec-sent' : 'gsec-ready', title, [
    sentChip(sent, p.items.length),
    el('span', { class: 'days' }, dayRange(p.items)),
    fromDraft ? el('span', { class: 'chip draftrest', title: `The later days of the same draft are not published yet: ${dayRangeOf(exportList())}` }, `↪ rest in ${draftTitle()} (draft)`) : null,
    el('span', { class: 'muted', title: `Files ${range}` }, plural(p.items.length, 'post') + (allSent ? ` · sent ${shortDate(lastSent(p.items))}` : '')),
    changed ? el('span', { class: 'chip changed', title: 'Changed after the release was made; updated in the release when you publish' }, `✎ ${changed} changed`) : null,
    el('span', { class: 'grow' }),
    el('button', { title: 'Open the folder of this part', onclick: () => api('/api/reveal', { release: r.release, part: p.part }).catch(err => toast(err.message)) }, ic('folder')),
    allSent ? null : el('button', {
      class: 'primary', title: sent ? 'Post the rest to your WhatsApp Status' : 'Post this to your WhatsApp Status',
      onclick: () => publishPart(r, p),
    }, ic('send'), sent ? `Continue publishing (${p.items.length - sent} left)` : 'Publish'),
    allSent
      ? el('button', { title: 'Removes the ticks of all its posts', onclick: () => setAllSent(r, p, false) }, 'Mark all as not sent')
      : el('button', { title: 'Only if you posted them yourself. Nothing is posted.', onclick: () => setAllSent(r, p, true) }, '✓ Mark all as sent'),
  ], grid => fillItems(grid, p.items.map(item => ({
    item, sentAt: item.sentAt, release: r.release, part: p.part, src: releaseFileUrl(r.release, p.part, item.file),
  }))));
}

// The files of a release part as cards, with a line for each day.
function fillItems(grid, rows) {
  let lastDay = null;
  const days = itemDays(rows.map(r => r.item));
  rows.forEach((row, k) => {
    const e = entryFor(row.item.postKey || row.item.key);
    const day = days[k];
    if (day !== lastDay) {
      grid.append(el('div', { class: 'gday' }, dayLabel(day ? `${day}T12:00:00` : '')));
      lastDay = day;
    }
    const num = row.item.file.split('_')[0];
    grid.append(e ? renderCard(e, num, row) : goneCard(row, num));
  });
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
    ondblclick: () => {
      const it = item.type !== 'text' && item.source && state.items.find(x => x.name === item.source);
      if (it) openInFocus(it, item.start || 0, partFiles(row));
      else openViewer({ title: item.file, type: item.type === 'video' ? 'video' : 'image', src: row.src });
    },
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
    frame.append(el('img', { class: 'fg' + rotClass(rotOf(e.source)), src, loading: 'lazy', alt: '', style: row ? null : mediaStyle(itemOf(e.source)) }));
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
  if (e.kind === 'media' && (row ? row.item.grade : gradeOf(e.source))) frame.append(el('span', { class: 'cgrade', title: 'Colours changed in Pick (G)' }, '🎨'));
  if (!row && e.removed) frame.append(el('div', { class: 'gone' }, 'Removed'));
  if (missing) frame.append(el('div', { class: 'gone' }, 'File missing'));
  const time = e.time ? e.time.slice(11, 16) : '';
  const name = e.type === 'text' ? (e.cfg.intro ? 'Day intro' : e.cfg.mapsum ? 'Map summary' : e.cfg.collage ? 'Collage' : 'Text') : e.source;
  const caption = row ? row.item.caption || '' : fullCaption(e, v);
  const card = el('div', {
    class: 'card' + (e.key === posts.selKey ? ' sel' : '') + (!row && e.removed ? ' removed' : '') + (row ? ' rel' : ''),
    'data-key': e.key, draggable: row ? null : 'true',
    title: row
      ? `${row.item.file}\nDouble-click: the released file at real size`
      : (e.type === 'text' ? (v.collage ? `Collage of ${v.collage.images.length} photos` : v.text || 'Text post') : e.source) + '\nDrag to move · double-click: real size',
    onclick: () => selectEntry(e.key),
    ondblclick: row
      ? () => {
        // A released photo or video: its original in the full screen, else the released file.
        const it = row.item.source && state.items.find(x => x.name === row.item.source);
        if (it) openInFocus(it, row.item.start || 0, partFiles(row));
        else openViewer({ title: row.item.file, type: row.item.type === 'video' ? 'video' : 'image', src: row.src });
      }
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
// The files whose posts are around a post: in Compose all media posts of the release
// being made; in Releases those of the part the post belongs to.
function browseFiles(e) {
  if (state.mode === 'arrange' || isNew(e)) {
    return new Set(posts.entries.filter(x => x.kind === 'media' && isNew(x) && !x.removed).map(x => x.source));
  }
  return null;
}

function partFiles(row) {
  for (const r of posts.releases) {
    if (r.release !== row.release) continue;
    const p = r.parts.find(x => x.part === row.part);
    if (p) return new Set(p.items.map(i => i.source).filter(Boolean));
  }
  return null;
}

async function viewPost(e) {
  // Compose: the files of the release being made (not removed ones); Releases: the
  // files of the part this post is in.
  if (e.kind === 'media' && e.item) { openInFocus(e.item, e.start || 0, browseFiles(e)); return; }
  const v = postView(e);
  if (v.map && v.map.length) {
    const s = mapState(v.map);
    if (s.ready) await s.ready;
  }
  if (v.collage) await collageReady(v.collage).catch(err => toast(err.message));
  const canvas = document.createElement('canvas');
  canvas.width = SW;
  canvas.height = SH;
  renderPost(canvas, v, null, 1, false);
  openViewer({ title: v.intro ? 'Day intro' : v.mapsum ? 'Map summary' : v.collage ? 'Collage' : 'Text post', type: 'canvas', canvas });
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
  const isMapsum = !!(e.cfg && e.cfg.mapsum);
  const isCollage = !!(e.cfg && e.cfg.collage);
  for (const id of ['#pTextField', '#pBgField']) $(id).hidden = !isText || isCollage;
  // Day intros and map summaries have a fixed layout (text on top, map below); a collage has no text on it.
  for (const id of ['#pPosField', '#pStyleField', '#pSizeField']) $(id).hidden = !isText || isIntro || isMapsum || isCollage;
  $('#mapsumField').hidden = !isMapsum;
  if (isMapsum) renderMapsumInfo(e);
  $('#spotsField').hidden = !(isIntro || isMapsum) || pinsOf(e.cfg, { all: true }).length < 2 || !!(e.cfg.noLocation);
  if (!$('#spotsField').hidden) renderSpots(e);
  $('#collageField').hidden = !isCollage;
  if (isCollage) $('#collageInfo').textContent = `${e.cfg.collage.images.length} photos · ${collageTemplate(e.cfg.collage.tpl).name.toLowerCase()}`;
  $('#introField').hidden = !isIntro;
  if (isIntro) renderIntroInfo(e);
  $('#geoField').hidden = isText;
  $('#speciesField').hidden = isText;
  $('#pRemove').textContent = isCollage ? '🗑 Split up collage' : isMapsum ? '🗑 Delete map summary' : e.type === 'text' ? '🗑 Delete text post' : e.removed ? '↩ Restore post' : '✕ Remove post';
  const info = [];
  if (e.type === 'video') {
    info.push(`Scene ${e.sceneNo} of ${e.source}: ${fmtTime(e.start)} → ${fmtTime(e.end)} (${postLen(e).toFixed(1)} s` +
      ((e.speed || 1) < 1 ? `, ${{ 0.75: '¾', 0.5: '½', 0.25: '¼' }[e.speed]}× slow motion).` : ').'));
    if (postLen(e) > STATUS_LIMIT_S) info.push(`⚠ Longer than ${STATUS_LIMIT_S} s: WhatsApp Status only shows the first ${STATUS_LIMIT_S} s.`);
  }
  if (e.type === 'image') info.push(`Photo ${e.source}.`);
  if (isCollage) info.push('Goes out as one picture. Its photos are no posts of their own while they are in the collage.');
  if (isMapsum) info.push('Goes out as a picture with the map; the caption gets a link to all its spots.');
  if (isText && !isIntro && !isMapsum && !isCollage) {
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
    box.append(el('div', { class: 'muted' }, `In the draft of ${draftTitle()}. "Review & publish" sends it.`));
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
    if (!confirm(e.cfg.collage ? 'Split up this collage? Its photos become single posts again.' : 'Delete this text post?')) return;
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
    s.error ? el('div', { class: 'warnline' }, `Map not loaded: ${s.error}`,
      el('button', { class: 'linkbtn', onclick: () => { dayMapState(day, { retry: true }); renderEditor(); redrawIntros(day); } }, '↻ Load map again')) : null,
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
  const areas = new Map();
  for (const p of postView(e).map || []) {
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
  const first = (postView(e).text || (e.cfg.intro ? germanDay(e.cfg.intro.day) : '')).split('\n')[0];
  editPost({ text: `${first}\n${names.slice(0, 4).join(' · ')}` });
  $('#pText').value = postView(e).text;
}

// A day intro in front of the day's first post: the German date as the heading,
// a map with a pin for every photo and video of that day that has a location.
// ---------- map summaries ----------

// The days of the journey that have photos or videos, for choosing a time frame.
const journeyDays = () => [...new Set(state.items.map(it => (it.date || '').slice(0, 10)).filter(Boolean))].sort();

// A map summary of the week (Monday to Sunday) of the selected post, or of the first
// post of the draft; it goes after the last post of that week. Its time frame can be
// changed in the editor.
function addMapSummary() {
  if (!state.folder || !hasDraft()) { toast('Start a new release first (＋ New release)'); return; }
  const list = visibleEntries().filter(e => isNew(e) && !e.removed);
  const cur = curEntry();
  const base = (cur && isNew(cur) && postDay(cur)) || (list.find(postDay) && postDay(list.find(postDay)));
  if (!base) { toast('Pick photos or scenes for this release first'); return; }
  const from = weekStart(base), to = addDays(from, 6);
  const last = [...list].reverse().find(e => postDay(e) && postDay(e) <= to);
  const extra = { mapsum: { scope: 'range', week: true, from, to }, text: '', bg: INTRO_BG };
  if (last) insertTextAfter(last, extra);
  else insertTextPost(lastAnchor(), posts.data.texts.length, extra);
  toast(`Map summary of the week ${dayRangeDe(from, to)} added. Change its time frame on the right.`);
}

function setMapsum(e, patch) {
  const m = { ...e.cfg.mapsum, ...patch };
  if (m.scope !== 'release') delete m.fixed;
  if (m.from && m.to && m.to < m.from) [m.from, m.to] = [m.to, m.from];
  editPost({ mapsum: m });
}

// Editor of a map summary: what it covers, how many spots, the map's state.
function renderMapsumInfo(e) {
  const m = e.cfg.mapsum, box = $('#mapsumInfo');
  const days = mapsumDays(e.cfg), all = journeyDays();
  const v = postView(e), pins = v.map || [];
  const kind = m.scope === 'release' ? 'release' : m.week ? 'week' : 'range';
  const released = !isNew(e);
  const seg = el('div', { class: 'seg' }, ...[['week', 'A week'], ['range', 'From – to'], ['release', 'Whole release']].map(([k, label]) =>
    el('button', { class: k === kind ? 'on' : null, disabled: released ? '' : null, onclick: () => {
      const start = days[0] || all[0];
      if (k === 'week') { const f = weekStart(start); setMapsum(e, { scope: 'range', week: true, from: f, to: addDays(f, 6) }); }
      if (k === 'range') setMapsum(e, { scope: 'range', week: false, from: days[0] || all[0], to: days[days.length - 1] || all[0] });
      if (k === 'release') setMapsum(e, { scope: 'release', week: false });
    } }, label)));
  const daySelect = (value, onchange, list = all) => {
    const sel = el('select', { disabled: released ? '' : null, onchange: ev => onchange(ev.target.value) },
      ...list.map(d => el('option', { value: d }, `${germanDay(d)}`)));
    sel.value = value;
    return sel;
  };
  let choose = null;
  if (kind === 'week') {
    const weeks = [...new Set(all.map(weekStart))];
    const sel = el('select', { disabled: released ? '' : null, onchange: ev => setMapsum(e, { from: ev.target.value, to: addDays(ev.target.value, 6) }) },
      ...weeks.map(w => el('option', { value: w }, `Week ${dayRangeDe(w, addDays(w, 6))}`)));
    sel.value = weekStart(m.from || all[0]);
    choose = sel;
  } else if (kind === 'range') {
    choose = el('div', { class: 'range-pick' },
      daySelect(m.from, d => setMapsum(e, { from: d })), el('span', {}, 'to'), daySelect(m.to || m.from, d => setMapsum(e, { to: d })));
  } else {
    choose = el('small', { class: 'muted' }, released
      ? `The days it went out with: ${dayRangeDe(days[0], days[days.length - 1]) || '–'}.`
      : `The days of the release it goes out with: now ${dayRangeDe(days[0], days[days.length - 1]) || 'none yet'}. Follows what you choose in Review & publish.`);
  }
  const s = pins.length ? mapState(pins) : {};
  const link = v.map ? mapLink(v.map, mapTitle(e.cfg, v)) : null;
  const daysWith = days.filter(d => autoDayPins(d).length).length;
  box.replaceChildren(...[
    seg, choose,
    el('span', {}, pins.length
      ? `${pins.length} spot${pins.length === 1 ? '' : 's'} from ${daysWith} day${daysWith === 1 ? '' : 's'} with locations` +
        (pins.length >= MAX_PINS ? ' (nearby spots merged, so the map stays readable)' : '') + '.'
      : 'No photo or video of these days has a location, so there is no map.'),
    s.error ? el('div', { class: 'warnline' }, `Map not loaded: ${s.error}`,
      el('button', { class: 'linkbtn', onclick: () => { mapState(pins, { retry: true }); renderEditor(); redrawMaps(); } }, '↻ Load map again')) : null,
    s.loading ? el('div', { class: 'muted' }, 'Loading the map from Google Maps …') : null,
    link ? el('small', { class: 'muted' }, '🗺 Added to the caption automatically: ', el('a', { href: link, target: '_blank', rel: 'noopener' }, 'open map link ↗')) : null,
    pins.length ? el('button', { onclick: () => addDayPlaces(e) }, '📍 Add place names to the text') : null,
  ].filter(Boolean));
}

// The spots of a day intro or map summary, each with a tick: untick to leave it off the map.
function renderSpots(e) {
  const all = pinsOf(e.cfg, { all: true });
  const hidden = new Set(e.cfg.hidden || []);
  const shown = all.filter(p => !hidden.has(pinKey(p))).length;
  const set = keys => editPost({ hidden: keys.length ? keys : undefined });
  const multiDay = new Set(all.map(p => p.it && (p.it.date || '').slice(0, 10))).size > 1;
  const box = $('#spotsInfo');
  const head = el('div', { class: 'spots-head' },
    el('span', { class: 'muted' }, `${shown} of ${all.length} shown. Untick a spot to leave it off the map.`),
    hidden.size ? el('button', { class: 'linkbtn', onclick: () => set([]) }, 'Show all') : null);
  const list = el('div', { class: 'spots' }, ...all.map(p => {
    const k = pinKey(p), on = !hidden.has(k);
    const place = posts.places.get(geoKey(p));
    const it = p.it;
    const when = it && it.date ? (multiDay ? `${shortDay(it.date.slice(0, 10))} ` : '') + it.date.slice(11, 16) : '';
    const name = place ? (place.poi || place.name.split(',')[0]) : it ? it.name : 'Place entered by you';
    return el('label', { class: 'spot' + (on ? '' : ' off'), title: it ? it.name : '' },
      el('input', { type: 'checkbox', checked: on ? '' : null, onchange: ev => {
        const next = new Set(hidden);
        if (ev.target.checked) next.delete(k); else next.add(k);
        // At least one spot stays: without any, the post would lose its map.
        if (next.size >= all.length) { ev.target.checked = true; toast('Leave at least one spot on the map'); return; }
        set([...next]);
      } }),
      it ? el('img', { src: thumbSrc(it), loading: 'lazy', alt: '', class: rotClass(it.rotate).trim() || null, style: mediaStyle(it) }) : el('span', { class: 'noimg' }, '📍'),
      el('span', { class: 'when' }, when),
      el('span', { class: 'name' }, name));
  }));
  box.replaceChildren(head, list);
}

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

// Publishing only part of the draft: its days up to and including publishUntil (null:
// all of it). The later days stay in the draft for the next release. Cutting at a day
// keeps the order: WhatsApp shows statuses in the order they were posted.
const PUBLISH_DAYS_DEFAULT = 2;
let publishUntil = null;
const postDay = e => (e.time || '').slice(0, 10);
const draftDays = () => [...new Set(exportList().map(postDay).filter(Boolean))].sort();
const releaseList = () => (publishUntil ? exportList().filter(e => postDay(e) <= publishUntil) : exportList());

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
// A scene whose picture needs more bits than WhatsApp's size limit leaves it is split
// further, into pieces of at least 5 s (the server measures that, see checkVideoPieces).
function releaseItems(list) {
  const L = posts.limits;
  const items = [];
  for (const e of list) {
    const v = postView(e);
    const k = e.type === 'video' ? piecesOf(e) : 1;
    if (k > 1) {
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
      // Short: the long story of the day stays with its first part.
      caption: t ? `Fortsetzung vom ${date.split('\n')[0].trim()}` : caption,
      place: t ? t.place : undefined, noLocation: t ? t.noLocation : undefined, hidden: t ? t.hidden : undefined,
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
// Publishing posts one file at a time, so a release is no longer split: one part.
// (Older releases made in several parts are still read and shown as they are.)
function releaseParts(allItems) {
  const max = Infinity;
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
  // The first two days by default; all of them when there are no more than that.
  const days = draftDays();
  publishUntil = days.length > PUBLISH_DAYS_DEFAULT ? days[PUBLISH_DAYS_DEFAULT - 1] : null;
  renderPublishDays();
  updatePostsExportInfo();
  // Which videos need more posts to stay sharp takes a moment to measure.
  if (releaseList().some(e => e.type === 'video')) {
    videoCheckRunning = true;
    updatePostsExportInfo();
    checkVideoPieces(releaseList()).finally(() => {
      videoCheckRunning = false;
      if ($('#postsDlg').open && !$('#postsSetup').hidden) updatePostsExportInfo();
    });
  }
  $('#postsTitle').textContent = `Review & publish · ${draftTitle()}`;
  $('#postsPhase').textContent = '';
  $('#postsStop').hidden = true;
  $('#postsClose').disabled = false;
  reviewPublishing = false;
  $('#postsSetup').hidden = false;
  $('#postsProgress').hidden = true;
  $('#postsDlg').showModal();
  reviewSpell();  // after showModal: its "checking" line needs the open window
}

// Into how many posts each video of the release goes: asked from the server, which
// measures how many bits the picture needs. Kept per scene and speed.
const videoPieces = new Map();
let videoCheckRunning = false;
const pieceKey = e => `${e.key}|${e.speed || 1}`;
const splitForQuality = () => localStorage.getItem('media-picker-split') !== 'off';
const lengthPieces = e => Math.ceil(postLen(e) / posts.limits.maxVideoSeconds);
function piecesOf(e) {
  const k = lengthPieces(e);
  return splitForQuality() ? Math.max(k, videoPieces.get(pieceKey(e)) || 1) : k;
}

async function checkVideoPieces(list) {
  const scenes = list.filter(e => e.type === 'video')
    .map(e => ({ id: pieceKey(e), source: e.source, start: e.start, end: e.end, speed: e.speed || 1 }));
  if (!scenes.length) return;
  try {
    const { pieces } = await apiRetry('/api/posts/video-pieces', { scenes });
    for (const [id, k] of Object.entries(pieces || {})) videoPieces.set(id, k);
  } catch (err) {
    toast('The videos could not be checked: ' + err.message);
  }
}

// The choice which days go out now: "up to Mo 16.11. (25 posts)" … "all days (60 posts)".
function renderPublishDays() {
  const days = draftDays(), list = exportList();
  const sel = $('#postsDays');
  $('#postsDaysRow').hidden = days.length < 2;
  // As many as the window then says: with automatic day intros and split videos.
  const posts = l => releaseParts(releaseItems(l)).flatMap(p => p.items).length;
  const n = k => `${k} post${k === 1 ? '' : 's'}`;
  const label = d => parseStamp(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  sel.replaceChildren(
    ...days.slice(0, -1).map((d, i) => el('option', { value: d },
      `${i === 0 ? 'only' : 'up to'} ${label(d)} · ${i + 1} day${i ? 's' : ''}, ${n(posts(list.filter(e => postDay(e) <= d)))}`)),
    el('option', { value: '' }, `all ${days.length} days · ${n(posts(list))}`));
  sel.value = publishUntil || '';
}

function setPublishUntil(day) {
  publishUntil = day || null;
  updatePostsExportInfo();
  reviewSpell();   // only what goes out is checked (texts checked before are not sent again)
  if (releaseList().some(e => e.type === 'video')) {
    videoCheckRunning = true;
    updatePostsExportInfo();
    checkVideoPieces(releaseList()).finally(() => {
      videoCheckRunning = false;
      if ($('#postsDlg').open && !$('#postsSetup').hidden) updatePostsExportInfo();
    });
  }
}

// "Show" next to a check: back to Compose with that post selected.
function showPostFromReview(key) {
  $('#postsDlg').close();
  if (state.mode !== 'arrange') setMode('arrange');
  selectEntry(key);
}

function updatePostsExportInfo() {
  const L = posts.limits;
  const list = releaseList();
  const items = releaseItems(list);
  const parts = releaseParts(items);
  const files = parts.flatMap(p => p.items);
  const name = nextReleaseName();
  $('#postsGo').disabled = !files.length;
  const days = dayRangeOf(list);
  $('#postsGo').textContent = `Publish ${files.length} post${files.length === 1 ? '' : 's'}`;
  if (videoCheckRunning) {
    $('#postsGo').disabled = true;
    $('#postsGo').replaceChildren(el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Checking the videos …');
  }
  $('#postsExportSummary').textContent = !files.length ? 'Nothing to publish with this choice.'
    : `${files.length} post${files.length === 1 ? ' goes' : 's go'} to your WhatsApp Status, in this order` + (days ? ` (${days})` : '') + '.' +
      (() => {
        const rest = exportList().length - list.length;
        return rest > 0 ? ` The other ${rest} post${rest === 1 ? '' : 's'} stay in the draft for the next release.` : '';
      })();
  // The posts in order, small; a click goes to that post in Compose.
  const strip = $('#postsThumbs');
  strip.replaceChildren(...files.map((it, i) => {
    const e = it.e;
    const style = e.kind === 'media' ? mediaStyle(itemOf(e.source)) : null;
    return el('div', { class: 'rthumb' + (e.type === 'text' ? ' text' : ''), title: `${pad2(i + 1)} · ` + (e.type === 'text' ? (postView(e).text || 'Text post').split('\n')[0] : e.source),
      onclick: () => { if (!e.cfg.auto) showPostFromReview(e.key); } },
    e.type === 'text' ? el('span', {}, e.cfg.intro || e.cfg.mapsum ? '🗺' : e.cfg.collage ? '▦' : 'Aa')
      : el('img', { src: thumbUrl(e), loading: 'lazy', alt: '', class: rotClass(rotOf(e.source)).trim() || null, style }),
    e.type === 'video' ? el('i', {}, '▶') : null);
  }));
  const warn = $('#postsWarnings');
  warn.replaceChildren();
  const check = (text, keys) => warn.append(el('li', {}, text,
    keys && keys.length ? el('button', { class: 'linkbtn', onclick: () => showPostFromReview(keys[0]) }, 'Show') : null));
  const long = list.filter(e => postLen(e) > L.maxVideoSeconds);
  // Videos that need more posts than their length asks for, to look good.
  const sharp = list.filter(e => e.type === 'video' && (videoPieces.get(pieceKey(e)) || 1) > lengthPieces(e));
  $('#postsSplitRow').hidden = !sharp.length;
  $('#postsSplit').checked = splitForQuality();
  if (sharp.length) {
    const extra = sharp.reduce((n, e) => n + (videoPieces.get(pieceKey(e)) || 1) - lengthPieces(e), 0);
    check(splitForQuality()
      ? `${sharp.length} video${sharp.length === 1 ? ' is' : 's are'} split into shorter posts (${extra} more post${extra === 1 ? '' : 's'}): ` +
        `WhatsApp's ${L.maxVideoMB} MB per video is too little for ${sharp.length === 1 ? 'its' : 'their'} length and picture.`
      : `${sharp.length} video${sharp.length === 1 ? '' : 's'} will look blocky: WhatsApp's ${L.maxVideoMB} MB per video is too little for ${sharp.length === 1 ? 'its' : 'their'} length and picture.`,
    sharp.map(e => e.key));
  }
  const noCaption = list.filter(e => e.kind === 'media' && !fullCaption(e, postView(e)).trim());
  if (long.length) check(`${long.length} video${long.length === 1 ? ' is' : 's are'} longer than ${L.maxVideoSeconds} s and will be split into pieces (WhatsApp Status shows at most ${L.maxVideoSeconds} s).`, long.map(e => e.key));
  if (noCaption.length) check(`${noCaption.length} photo${noCaption.length === 1 ? '' : 's'} or video${noCaption.length === 1 ? ' has' : 's have'} no caption.`, noCaption.map(e => e.key));
  const captions = files.filter(it => it.caption).length;
  // Day intros made for the start of a part, and intros left out.
  for (const p of parts) {
    const a = p.items[0] && p.items[0].e.cfg.auto;
    if (a) {
      warn.append(el('li', {}, `The release begins on ${germanDay(itemDay(p.items[0]))}: ` +
        (a === 'continuation' ? 'it starts with that day\'s intro again, marked "Fortsetzung".' : 'that day has no intro, so a plain one (date and map) is added.')));
    }
  }
  const empty = emptyIntros(items);
  if (empty.length) {
    warn.append(el('li', {}, `Left out: the day intro for ${empty.map(it => germanDay(itemDay(it))).join(', ')}, because nothing of that day follows it in this release.`));
  }
  warn.append(el('li', { style: 'color: var(--muted)' },
    `Within WhatsApp's limits: videos MP4, at most ${L.maxVideoShort || 720}p and 30 fps, ${L.maxVideoMB} MB and ${L.maxVideoSeconds} s; photos at most ${L.maxImageSide} px.`));
  // Spelling, checked when the review opened (reviewSpell).
  const sp = reviewSpellState;
  if (sp.status === 'checking') {
    warn.append(el('li', { style: 'color: var(--muted)' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Checking the spelling of captions and texts …'));
  } else if (sp.status === 'error') {
    warn.append(el('li', {}, `The spelling check did not work: ${sp.error}`,
      el('button', { class: 'linkbtn', onclick: () => reviewSpell() }, 'Try again')));
  } else if (sp.status === 'done' && sp.issues.length) {
    warn.append(el('li', {}, `${sp.issues.length} possible spelling mistake${sp.issues.length === 1 ? '' : 's'} in captions and texts.`,
      el('button', { class: 'linkbtn', onclick: openReviewSpell }, 'Show')));
  } else if (sp.status === 'done') {
    warn.append(el('li', { style: 'color: var(--muted)' }, '✓ Spelling of captions and texts: nothing found.'));
  }
  if (captions) warn.append(el('li', { style: 'color: var(--muted)' }, `Files and captions are kept in WhatsApp\\Releases\\${name}.`));
}

// ---------- spelling in the review ----------

// The review checks the spelling as soon as it opens; Publish then uses that result
// (and only asks LanguageTool again for texts changed since). Ignored marks stay
// ignored for this session.
let reviewSpellState = { status: 'idle', issues: [] };
let reviewSpellRun = 0;
let reviewSpellPromise = null;
const reviewSpellPart = () => ({ items: releaseList().map((e, i) => ({ postKey: e.key, n: i + 1 })) });

function reviewSpell() {
  reviewSpellPromise = reviewSpellCheck();
  return reviewSpellPromise;
}

async function reviewSpellCheck() {
  const run = ++reviewSpellRun;
  const fields = spellFields(reviewSpellPart());
  reviewSpellState = fields.length ? { status: 'checking', issues: [] } : { status: 'none', issues: [] };
  const redraw = () => { if (run === reviewSpellRun && $('#postsDlg').open && !$('#postsSetup').hidden) updatePostsExportInfo(); };
  redraw();
  if (!fields.length) return;
  try {
    const issues = await spellIssues(fields);
    if (run === reviewSpellRun) reviewSpellState = { status: 'done', issues };
  } catch (err) {
    if (run === reviewSpellRun) reviewSpellState = { status: 'error', issues: [], error: err.message };
  }
  redraw();
}

function openReviewSpell() {
  showSpellDialog(reviewSpellState.issues, () => reviewSpell(), { goLabel: 'Done', cancel: false });
}

// "beach", "DJI_0042_95s", "DJI_0042_95s_1of2", "text": the file name after its number.
const releaseFileBase = it => (it.e.type === 'text' ? (it.e.cfg.collage ? 'collage' : it.e.cfg.mapsum ? 'map' : 'text') : fileBase(it.e.source) + (it.e.type === 'video' ? `_${Math.floor(it.start)}s` : '')) +
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
    const grade = gradeOf(e.source);
    const crop = (itemOf(e.source) || {}).crop || null;
    if (rot || grade || crop) {
      // Turned, cropped or colour-graded in Pick: drawn that way (and scaled down if needed) as a new JPEG.
      let c = turnedCanvas(img, rot, Math.min(1, L.maxImageSide / big));
      if (crop) {
        const cut = document.createElement('canvas');
        cut.width = Math.max(1, Math.round(c.width * crop.w));
        cut.height = Math.max(1, Math.round(c.height * crop.h));
        cut.getContext('2d').drawImage(c, Math.round(c.width * crop.x), Math.round(c.height * crop.y), cut.width, cut.height, 0, 0, cut.width, cut.height);
        c = cut;
      }
      if (grade) {
        const ctx = c.getContext('2d');
        const px = ctx.getImageData(0, 0, c.width, c.height);
        Grade.gradePixels(px.data, grade);
        ctx.putImageData(px, 0, 0);
      }
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
    if (v.map && v.map.length) {
      const s = mapState(v.map, { retry: true });  // a map that failed earlier gets another try
      if (s.ready) await s.ready;
      const what = v.intro ? `Day intro ${germanDay(v.intro.day)}` : `Map summary ${v.text.split('\n').join(' ')}`;
      if (s.error) throw new Error(`${what}: the map could not be loaded (${s.error})`);
    }
    // A summary of the whole release keeps the days it went out with.
    if (e.cfg.mapsum && e.cfg.mapsum.scope === 'release' && isNew(e)) {
      e.cfg.mapsum.fixed = { days: mapsumDays(e.cfg) };
      savePosts();
    }
    // A collage needs its photos loaded at real size.
    if (v.collage) await collageReady(v.collage);
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
    // A collage: what it was made of (to notice changes), and its photos, which count as released.
    collage: v.collage ? collageSig(v.collage) : undefined,
    sources: v.collage ? collageNames(v.collage) : undefined,
    // Text layout, so a later change of it can be noticed.
    look: e.type === 'text' && !v.intro && !v.mapsum && !v.collage ? { position: v.position, style: v.style, size: v.size } : undefined,
    mapsum: v.mapsum ? (() => {
      const days = mapsumDays(e.cfg);
      return { scope: v.mapsum.scope, from: days[0], to: days[days.length - 1], pins: v.map.length,
        hidden: (e.cfg.hidden || []).length || undefined, sig: mapSig(v.map) };
    })() : undefined,
    intro: v.intro ? {
      day: v.intro.day, pins: v.map.length, hidden: (e.cfg.hidden || []).length || undefined, sig: mapSig(v.map),
      place: e.cfg.place ? e.cfg.place.label : undefined, noLocation: e.cfg.noLocation || undefined,
      auto: e.cfg.auto || undefined,
    } : undefined,
    format: e.type === 'text' ? undefined : 'original',
    rotate: e.kind === 'media' && rotOf(e.source) ? rotOf(e.source) : undefined,
    grade: e.kind === 'media' && gradeOf(e.source) ? Grade.gradeId(gradeOf(e.source)) : undefined,
    crop: e.kind === 'media' && (itemOf(e.source) || {}).crop ? cropKey(itemOf(e.source).crop) : undefined,
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

// Publish in the review window: spelling check, then the files, then WhatsApp.
async function reviewPublish() {
  const list = releaseList();
  if (!list.length) return;
  // Spelling first, on the posts as they are now; nothing has been made yet. A check
  // still running from the review is awaited, so the texts aren't sent twice.
  if (reviewSpellPromise) await reviewSpellPromise.catch(() => {});
  const fake = { items: list.map((e, i) => ({ postKey: e.key, n: i + 1 })) };
  if (!(await spellcheckBeforePublish(fake))) return;
  $('#postsPhase').textContent = '1 of 2 · Making the files';
  const made = await runPostsExport();
  if (!made) return;
  if (made.errors.length) {
    $('#postsPhase').textContent = '⚠ Some files could not be made, so nothing was posted yet.';
    $('#postsStatus').textContent = 'Fix or remove those posts, then publish the release from the Releases page.';
    return;
  }
  const r = posts.releases.find(x => x.release === made.release);
  const p = r && r.parts[0];
  if (!p) return;
  $('#postsPhase').textContent = '2 of 2 · Posting to WhatsApp';
  $('#postsStatus').textContent = 'Opening WhatsApp Web …';
  $('#postsClose').disabled = true;
  await publishPart(r, p, { quiet: true });
}

async function runPostsExport() {
  const list = releaseList();
  if (!list.length) return null;
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
  // Days left for later stay in the draft (now the next release).
  publishUntil = null;
  if (!exportList().length) delete posts.data.draft;
  savePosts();
  setMode('releases', true);  // redrawn even when Releases is open already
  finish(`${ok} of ${items.length} files made for ${title}` +
    (reused ? ` (${reused} video${reused === 1 ? '' : 's'} reused from an earlier export)` : '') + '.');
  return { release, errors };
}

function sentChip(sent, total) {
  if (total && sent === total) return el('span', { class: 'chip sent' }, '✓ Sent');
  if (sent) return el('span', { class: 'chip prepared' }, `${sent} of ${total} sent`);
  return el('span', { class: 'chip prepared' }, 'Ready, not sent');
}

// ---------- publishing to WhatsApp (server: publisher.js) ----------

let publishPoll = null;
let publishSeen = -1;
let reviewPublishing = false;   // started from the Review & publish window: progress shows there

// The part a publish job works on, from the releases as they are now.
function jobPart(job) {
  const r = posts.releases.find(x => x.release === job.release);
  const p = r && r.parts.find(x => x.part === job.part);
  return p ? { r, p } : null;
}

// "post 5 (video)": how a post of a part is called towards the user.
function postName(p, key) {
  const it = p && p.items.find(i => i.key === key);
  if (!it) return 'a post';
  const kind = it.intro ? 'day intro' : it.collage ? 'collage' : it.type === 'text' ? 'text' : it.type === 'video' ? 'video' : 'photo';
  return `post ${it.n} (${kind})`;
}

// What the user needs to know about a publish job, and what they can do next:
// { title, text, bar: [value, max], running, bad, actions: [{ label, primary, run }] }.
// Counts are those of the whole part, also when publishing was continued.
function publishView(job) {
  const jp = jobPart(job);
  const p = jp && jp.p;
  const total = p ? p.items.length : job.total;
  const before = Math.max(0, total - job.total);   // sent before this run
  const sent = before + job.done;
  const where = (p && p.parts > 1 ? `Part ${p.partNo} of ` : '') + `Release ${releaseTitle(job.release)}`;
  const v = { where, bar: [sent, Math.max(1, total)], running: !!job.running, bad: false, actions: [] };
  const cont = (label, arrivedKey) => ({ label, primary: true, run: () => resumePublish(job, arrivedKey) });
  if (job.running) {
    v.title = 'Posting to WhatsApp';
    v.text = `Post ${Math.min(total, sent + 1)} of ${total}` +
      (job.note && job.note.retry ? ` · that didn't work, trying again (try ${job.note.retry} of 3)` : '') +
      (job.note && job.note.slow ? ' · WhatsApp is still sending it, the connection seems slow' : '') +
      (job.stopRequested ? ' · stopping after this post' : '');
    return v;
  }
  const name = postName(p, job.failedKey);
  const sure = `${sent} of ${total} posts are sent`;
  if (job.why === 'uncertain') {
    v.bad = true;
    v.title = `Did ${name} arrive?`;
    v.text = `WhatsApp was still sending ${name} after 10 minutes, so it is not clear whether it went out. ` +
      `Look at your status on the phone. Apart from it, ${sure}.`;
    v.actions = [cont('✓ It is there: continue', job.failedKey), { label: 'It is not there: send it again', run: () => resumePublish(job) }];
  } else if (job.error) {
    v.bad = true;
    v.title = 'Publishing stopped';
    v.text = (job.why === 'start' ? `Publishing could not start: ${job.error.replace(/\.$/, '')}.`
      : job.why === 'closed' ? 'The WhatsApp window was closed.'
      : job.why === 'refused' ? `WhatsApp doesn't take ${name}: the file may be too big, or of a kind it doesn't support.`
        : /not signed in/i.test(job.error) ? 'WhatsApp Web is not signed in any more.'
          : `${name[0].toUpperCase()}${name.slice(1)} could not be posted, also after three tries.`) +
      ` ${sure}; nothing is lost.`;
    v.detail = job.why === 'error' ? job.error : '';
    v.actions = [cont(job.why === 'refused' ? 'Try again' : 'Continue')];
  } else if (job.stopped) {
    v.title = 'Stopped';
    v.text = `${sure}. Continue whenever you like.`;
    v.actions = [cont('Continue')];
  } else {
    v.title = '✓ Published';
    v.text = `All ${total} posts are on your WhatsApp Status.`;
  }
  return v;
}

const publishActions = v => v.actions.map(a => el('button', { class: a.primary ? 'primary' : null, onclick: a.run }, a.label));

// Goes on with a part after publishing stopped. arrivedKey: a post the user saw on
// the phone although it was never confirmed; it is ticked as sent first.
async function resumePublish(job, arrivedKey) {
  const inReview = $('#postsDlg').open && !$('#postsProgress').hidden;
  try {
    if (arrivedKey) {
      await api('/api/releases/sent', { release: job.release, part: job.part, keys: [arrivedKey], sent: true });
      await loadReleases();
      if (inPostsView()) { renderGallery({ reveal: false }); renderEditor(); }
    }
    const jp = jobPart(job);
    if (!jp) { toast('That release is no longer there'); return; }
    if (!jp.p.items.some(i => !i.sentAt)) {
      // It was the last post: everything is out.
      reviewPublishing = inReview;
      renderPublishPanel({ release: job.release, part: job.part, running: false, done: 0, total: 0 });
      return;
    }
    if (inReview) { $('#postsPhase').textContent = 'Posting to WhatsApp'; $('#postsActions').replaceChildren(); }
    await publishPart(jp.r, jp.p, { quiet: true, review: inReview });
  } catch (err) {
    toast(err.message);
  }
}

// The progress in the Review & publish window.
function renderReviewProgress(job, note) {
  const stop = $('#postsStop');
  if (note) { $('#postsStatus').textContent = note; return; }
  const v = publishView(job);
  const bar = $('#postsBar');
  bar.max = v.bar[1];
  bar.value = v.bar[0];
  stop.hidden = !v.running;
  stop.disabled = !!job.stopRequested;
  $('#postsClose').disabled = v.running;
  $('#postsPhase').textContent = (v.bad ? '⚠ ' : '') + (v.running ? `2 of 2 · ${v.title}` : v.title);
  $('#postsStatus').textContent = v.text;
  $('#postsStatus').title = v.detail || '';
  $('#postsActions').replaceChildren(...publishActions(v));
  if (!v.running) reviewPublishing = false;
}

function renderPublishPanel(job, note) {
  if (reviewPublishing && $('#postsDlg').open) { renderReviewProgress(job, note); return; }
  const panel = $('#publishPanel');
  panel.hidden = false;
  panel.replaceChildren();
  if (note) {
    panel.classList.remove('error');
    panel.append(el('span', { class: 'text' }, note));
    return;
  }
  const v = publishView(job);
  panel.classList.toggle('error', v.bad);
  const bar = el('progress', { max: String(v.bar[1]) });
  bar.value = v.bar[0];
  // (append() would write a missing part out as the word "null".)
  panel.append(...[
    el('span', { class: 'text', title: v.detail || null }, el('b', {}, `${v.bad ? '⚠ ' : ''}${v.where}: ${v.title}. `), v.text),
    v.running ? bar : null,
    v.running ? el('button', { disabled: job.stopRequested ? '' : null, onclick: () => api('/api/publish/stop', {}).catch(err => toast(err.message)) }, '■ Stop after this post') : null,
    ...publishActions(v),
    v.running ? null : el('button', { onclick: () => { panel.hidden = true; } }, 'Close'),
  ].filter(Boolean));
}

// When Releases or Compose comes up: a publish that is still running (the page was
// reloaded) is followed again, and one that stopped is shown with how to go on.
async function checkPublishState() {
  if (publishPoll) return;
  const st = await api('/api/publish/status').catch(() => null);
  const job = st && st.job;
  if (!job || job.dryRun) return;
  if (job.running) { publishSeen = -1; renderPublishPanel(job); watchPublish(); return; }
  const jp = jobPart(job);
  if ((job.error || job.stopped) && jp && jp.p.items.some(i => !i.sentAt) && inPostsView()) renderPublishPanel(job);
}

// Follows a running publish: progress panel, and the ticks in the list as posts go out.
function watchPublish() {
  clearInterval(publishPoll);
  publishPoll = setInterval(async () => {
    const st = await api('/api/publish/status').catch(() => null);
    if (!st || !st.job) return;
    if (inPostsView() || reviewPublishing) renderPublishPanel(st.job);
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

// ---------- sent scenes in original quality (server: startOriginalsExport) ----------

let origPoll = null;
let syncOrigGo = () => {};

function renderOriginalsJob(job) {
  $('#origSetup').hidden = true;
  $('#origProgress').hidden = false;
  const bar = $('#origBar');
  bar.max = Math.max(1, job.total);
  bar.value = job.done;
  const gb = job.bytes >= 1e9 ? `${(job.bytes / 1e9).toFixed(1)} GB` : `${Math.round(job.bytes / 1e6)} MB`;
  $('#origStatus').textContent = job.running
    ? `${job.done} of ${job.total}` + (job.current ? ` · now: ${job.current}` : '') + (job.stopRequested ? ' · stopping …' : '')
    : (job.stopped ? `■ Stopped after ${job.done} of ${job.total}. ` : '✓ Done. ') +
      `${job.made} scene${job.made === 1 ? '' : 's'} exported (${gb})` +
      (job.skipped ? `, ${job.skipped} ${job.skipped === 1 ? 'was' : 'were'} exported before` : '') +
      (job.errors.length ? `, ${job.errors.length} failed` : '') + `. Folder: ${job.dest}`;
  $('#origErrors').replaceChildren(...job.errors.map(x => el('li', {}, x)));
  $('#origStop').hidden = !job.running;
  $('#origStop').disabled = !!job.stopRequested;
  $('#origClose').disabled = false;
}

function watchOriginals() {
  clearInterval(origPoll);
  origPoll = setInterval(async () => {
    const st = await api('/api/originals').catch(() => null);
    if (!st || !st.job) return;
    if ($('#origDlg').open) renderOriginalsJob(st.job);
    if (!st.job.running) { clearInterval(origPoll); origPoll = null; }
  }, 1500);
}

async function openOriginalsExport() {
  let st;
  try { st = await api('/api/originals'); } catch (err) { toast(err.message); return; }
  $('#origDlg').showModal();
  if (st.job && st.job.running) { renderOriginalsJob(st.job); watchOriginals(); return; }
  $('#origSetup').hidden = false;
  $('#origProgress').hidden = true;
  const fresh = st.scenes - st.exported;
  $('#origInfo').textContent = `${st.scenes} video scene${st.scenes === 1 ? ' was' : 's were'} sent so far` +
    (st.exported ? `, ${st.exported} of them ${st.exported === 1 ? 'is' : 'are'} exported already: ${fresh ? `${fresh} new` : 'nothing new'} to export. ` : '. ') +
    'Each is cut from its original video into the folder below.';
  $('#origAgainRow').hidden = !st.exported;
  $('#origAgain').checked = false;
  origMessage('');
  origSpaceOk = null;
  // Nothing new and nothing to repeat: nothing to export.
  syncOrigGo = () => { $('#origGo').disabled = !fresh && !$('#origAgain').checked; };
  $('#origAgain').onchange = syncOrigGo;
  syncOrigGo();
  if (st.dest && !$('#origDest').value) $('#origDest').value = st.dest;
}

// What's wrong with the folder, shown right under its field (warn: export is still possible).
function origMessage(text, warn = false) {
  const box = $('#origError');
  box.hidden = !text;
  box.textContent = text || '';
  box.classList.toggle('warn', warn);
  $('#origDest').classList.toggle('invalid', !!text && !warn);
}

const fmtBytes = b => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
let origSpaceOk = null;   // the folder the user chose to export to although space is short

async function runOriginalsExport() {
  const go = $('#origGo'), again = $('#origAgain').checked;
  const dest = $('#origDest').value.trim();
  if (!dest) { origMessage('Choose the folder for the scenes first.'); $('#origDest').focus(); return; }
  origMessage('');
  go.disabled = true;
  go.replaceChildren(el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Checking the folder …');
  try {
    // The folder is checked first: does it exist, can it be written to, is there room.
    const chk = await api('/api/originals/check', { dest, again });
    $('#origDest').value = chk.dest;
    if (chk.free != null && chk.need > chk.free * 0.97 && origSpaceOk !== chk.dest) {
      origSpaceOk = chk.dest;
      origMessage(`The ${chk.scenes} scene${chk.scenes === 1 ? '' : 's'} need about ${fmtBytes(chk.need)}, but only ${fmtBytes(chk.free)} are free on that drive. ` +
        'Make room or choose another folder. Click Export again to start anyway: it stops when the drive is full and continues there next time.', true);
      return;
    }
    const { job } = await api('/api/originals/export', { dest: chk.dest, again });
    renderOriginalsJob(job);
    watchOriginals();
  } catch (err) {
    origMessage(err instanceof TypeError ? 'The app on this PC doesn\'t answer. Is Statusbook still running?' : err.message);
    $('#origDest').focus();
  } finally {
    go.disabled = false;
    go.textContent = 'Export';
    syncOrigGo();
  }
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
    if (e.type === 'text' && !e.cfg.intro && !e.cfg.mapsum && v.text.trim()) out.push({ e, n: item.n, field: 'text', text: v.text });
  }
  return out;
}

// Resolves true to go on publishing, false to stop.
// LanguageTool's answers per text, so a text is checked only once while unchanged.
const spellCache = new Map();
const spellIgnored = new Set();
// An ignored word stays ignored in that caption or text, also after other fixes in it.
const ignoreKey = (f, word) => `${f.e.key}|${f.field}|${word}`;

// The open marks in these fields; only texts not checked yet go to LanguageTool.
async function spellIssues(fields) {
  const todo = [...new Set(fields.map(f => f.text).filter(t => !spellCache.has(t)))];
  if (todo.length) {
    const { results } = await api('/api/spellcheck', { texts: todo });
    todo.forEach((t, i) => spellCache.set(t, results[i] || []));
  }
  const issues = [];
  for (const f of fields) {
    for (const m of spellCache.get(f.text) || []) {
      if (spellIgnored.has(ignoreKey(f, f.text.substr(m.offset, m.length)))) continue;
      issues.push({ ...m, f, at: m.offset, orig: f.text.substr(m.offset, m.length) });
    }
  }
  return issues;
}

async function spellcheckBeforePublish(p) {
  const fields = spellFields(p);
  if (!fields.length) return true;
  let issues;
  try {
    if (fields.some(f => !spellCache.has(f.text))) toast('Checking spelling …');
    issues = await spellIssues(fields);
  } catch (err) {
    return confirm(`The spelling check did not work: ${err.message}.\n\nPublish without it?`);
  }
  if (!issues.length) return true;
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

// goLabel / cancel: from the review's "Show", the dialog only fixes, it doesn't publish.
function showSpellDialog(issues, resolve, { goLabel = 'Publish', cancel = true } = {}) {
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
        el('button', { class: 'quiet', onclick: () => { spellIgnored.add(ignoreKey(issue.f, issue.orig)); done(`ignored: „${issue.orig}"`); } }, 'Ignore')));
    list.append(row);
  }
  count();
  const finish = go => {
    dlg.onclose = null;
    dlg.close();
    if (changed) { renderGallery({ reveal: false }); renderEditor(); }
    resolve(go);
  };
  $('#spellGo').textContent = goLabel;
  $('#spellCancel').hidden = !cancel;
  $('#spellGo').onclick = () => finish(true);
  $('#spellCancel').onclick = () => finish(false);
  dlg.onclose = () => finish(false);  // Esc
  dlg.showModal();
}

// quiet: from the review window, where spelling and the yes are done already; its
// progress shows in that window.
// review: that window is open and shows the progress.
async function publishPart(r, p, { quiet = false, review = quiet } = {}) {
  reviewPublishing = review;
  const panelNote = note => { if (review) $('#postsStatus').textContent = note; else renderPublishPanel(null, note); };
  if (!quiet) {
  // WhatsApp shows statuses in the order they were posted: an earlier part sent later
  // would come after this one (a "Fortsetzung" without its beginning).
  const before = r.parts.slice(0, r.parts.indexOf(p)).filter(x => x.items.some(i => !i.sentAt));
  if (before.length && !confirm(`${before.map(x => x.part).join(' and ')} of this release ${before.length === 1 ? "isn't" : "aren't"} sent yet.\n\n` +
    `WhatsApp shows statuses in the order they are posted, so ${before.length === 1 ? 'it' : 'they'} would appear after ${p.part}. ` +
    `Publish ${before[0].part} first (Cancel), or publish ${p.part} anyway (OK)?`)) return;
  if (!(await spellcheckBeforePublish(p))) return;
  const unsent = p.items.filter(i => !i.sentAt).length;
  const changedNow = p.items.filter(i => releaseChanges(i));
  if (!confirm(`Publish ${p.part} of release ${releaseTitle(r.release)} to WhatsApp now?\n\n` +
    `${unsent} post${unsent === 1 ? '' : 's'} go to your WhatsApp Status, in order and with their captions. ` +
    'Each is ticked as sent as soon as WhatsApp has sent it.' +
    (changedNow.length ? `\n\n${changedNow.length} post${changedNow.length === 1 ? ' was' : 's were'} changed after the release was made; ` +
      `${changedNow.length === 1 ? 'it is' : 'they are'} updated in the release first.` : ''))) return;
  }
  const unsentQuiet = p.items.filter(i => !i.sentAt).length;
  const changed = p.items.filter(i => !i.sentAt && releaseChanges(i));
  try {
    let st = await api('/api/publish/status');
    if (st.browser === 'missing') { panelNote('⚠ Google Chrome was not found on this PC'); return; }
    if (st.job && st.job.running) { panelNote('⚠ Something is being published already'); return; }
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
        panelNote(st.login === 'signin'
          ? '🔑 Sign in to WhatsApp in the Chrome window that opened: on your phone, WhatsApp → Linked devices → Link a device, then scan the QR code. Publishing starts by itself afterwards.'
          : st.login === 'closed' ? 'The WhatsApp window was closed. Click Publish again.' : '⏳ Opening WhatsApp Web …');
        if (st.login === 'closed') return;
        await sleep(1500);
      }
      if (st.login !== 'ready') { panelNote('WhatsApp Web did not get ready. Click Publish again.'); return; }
    }
    const { job } = await api('/api/publish/start', { release: r.release, part: p.part });
    publishSeen = -1;
    renderPublishPanel(job);
    watchPublish();
  } catch (err) {
    renderPublishPanel({ release: r.release, part: p.part, done: 0, total: unsentQuiet, error: err.message, why: 'start' });
  }
}

// The ticks of a whole release (or part) by hand. That is easy to hit next to Publish
// and changes what goes out, so it asks first.
function setAllSent(r, p, sent) {
  const name = (p.parts > 1 ? `part ${p.partNo} of ` : '') + `Release ${releaseTitle(r.release)}`;
  const open = p.items.filter(i => !i.sentAt).length, total = p.items.length;
  const ok = sent
    ? confirm(`Mark ${open === total ? `all ${total} posts` : `the ${open} post${open === 1 ? '' : 's'} that ${open === 1 ? 'is' : 'are'} not sent yet`} of ${name} as sent?\n\n` +
      'Nothing is posted to WhatsApp. Do this only if you posted them yourself: Publish will skip them.\n\n' +
      'To post them, choose Cancel and click Publish instead.')
    : confirm(`Remove the "sent" ticks of all ${total} posts of ${name}?\n\n` +
      'They count as not sent again, and the next Publish posts every one of them to WhatsApp, also those that are out already.');
  if (ok) setPartSent(r, p, p.items.map(i => i.key), sent);
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
const MODES = ['releases', 'pick', 'arrange', 'favorites', 'browse', 'journeys'];
const MODE_VIEW = { releases: 'postsView', pick: 'pickView', arrange: 'postsView', favorites: 'pickView', browse: 'pickView', journeys: 'journeysView' };
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
  if (mode === 'favorites' || mode === 'browse') document.body.classList.add('mode-pick');
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
    if (mode === 'pick' && cameFrom !== 'pick' && hasDraft() && !state.keepPlace) jumpToNewDays();
  }
  if (inPostsView()) {
    // Only posts of this view can stay selected.
    if (mode === 'arrange' && posts.selKey && !isNew({ key: posts.selKey })) posts.selKey = null;
    refreshPosts();
    // Back to the release being made: start at its first (oldest) post, at the top.
    if (mode === 'arrange' && cameFrom !== 'arrange' && !state.keepPlace) {
      const first = $('#gallery .card[data-key]:not(.slot):not(.rel)');
      if (first) selectEntry(first.dataset.key);
      $('#gallery').scrollTop = 0;
    }
    // Release folders may have changed meanwhile (e.g. a part was published): read them again.
    // Then: a publish that is still running (e.g. after reloading the page) shows its
    // progress again, and one that stopped says how to go on.
    if (state.folder) {
      loadReleases().then(() => {
        if (!inPostsView()) return;
        renderGallery({ reveal: false });
        renderEditor();
        checkPublishState();
      });
    }
  } else if (wasPosts || force) {
    stopPostVideo();
    flushPosts();
  }
  // The step to come back to in a journey (the journeys list is not one).
  if (mode !== 'journeys' && mode !== 'browse') try { localStorage.setItem('media-picker-mode', mode); } catch { /* storage unavailable */ }
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
  $('#pCollageEdit').addEventListener('click', () => { const e = curEntry(); if (e && e.cfg.collage) openCollage(e); });
  initCollage();
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
  $('#origCancel').addEventListener('click', () => $('#origDlg').close());
  $('#origClose').addEventListener('click', () => $('#origDlg').close());
  $('#origGo').addEventListener('click', runOriginalsExport);
  $('#origDest').addEventListener('input', () => { origMessage(''); origSpaceOk = null; });
  $('#origDest').addEventListener('keydown', ev => { if (ev.key === 'Enter' && !$('#origGo').disabled) runOriginalsExport(); });
  $('#origPick').addEventListener('click', async () => {
    try {
      const { folder } = await api('/api/originals/pick', { start: $('#origDest').value.trim() || null });
      if (folder) { $('#origDest').value = folder; origMessage(''); }
    } catch (err) {
      origMessage(`The folder window could not be opened: ${err.message}`);
    }
  });
  $('#origStop').addEventListener('click', () => api('/api/originals/stop', {}).catch(err => toast(err.message)));
  $('#origReveal').addEventListener('click', () => api('/api/originals/reveal', {}).catch(err => toast(err.message)));
  $('#postsGo').addEventListener('click', reviewPublish);
  $('#postsDays').addEventListener('change', ev => setPublishUntil(ev.target.value));
  // Back in Compose: the whole draft again (also for a whole-release map summary).
  $('#postsDlg').addEventListener('close', () => { if (publishUntil) { publishUntil = null; redrawMaps(); } });
  $('#postsSplit').addEventListener('change', ev => {
    localStorage.setItem('media-picker-split', ev.target.checked ? 'on' : 'off');
    updatePostsExportInfo();
  });
  $('#postsStop').addEventListener('click', () => {
    $('#postsStop').disabled = true;
    api('/api/publish/stop', {}).catch(err => toast(err.message));
  });
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
