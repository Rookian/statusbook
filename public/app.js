'use strict';

// WhatsApp Status shows videos up to this length (WhatsApp Help Center: 90 s; longer
// videos are cut to the first 90 s).
const STATUS_LIMIT_S = 90;
const $ = sel => document.querySelector(sel);

const state = {
  folder: null,
  items: [],
  view: [],          // items in display order: oldest first
  sel: -1,           // index into view
  mode: 'releases',  // 'releases', 'pick', 'arrange', 'favorites' or 'journeys' (see posts.js)
  pendingStart: null,
  collapsed: new Set(), // "day:2026-07-12", saved per folder
  focus: false,      // full screen view of the selected file (Pick)
  lovedOnly: false,  // gallery shows only ♥ favorites
  speed: 1,          // playback speed in Pick; new scenes get it (slow motion)
  muted: false,
  showReleased: false, // Pick: also show the days before the release being made
  hideBefore: null,    // day key: days before it are left out of Pick (see updateHideBefore)
  gradeOpen: false,   // the colour panel in Pick
  gradeClip: null,    // copied colour settings
  animals: new Map(), // file name -> identified animals { animals, t, ... } (null while unknown)
};

// ---------- helpers ----------

// Colour grades (grade.js): shown with an SVG colour-matrix filter, one per distinct
// grade, made when first needed. gradeCss gives the CSS / canvas filter value for it.
const gradeOf = name => { const it = state.items.find(x => x.name === name); return (it && it.grade) || null; };
function gradeCss(g) {
  if (!g) return '';
  const id = Grade.gradeId(g);
  if (!document.getElementById(id)) {
    const ns = 'http://www.w3.org/2000/svg';
    const { m, o } = Grade.gradeMatrix(g);
    const f = document.createElementNS(ns, 'filter');
    f.setAttribute('id', id);
    f.setAttribute('color-interpolation-filters', 'sRGB');
    const cm = document.createElementNS(ns, 'feColorMatrix');
    cm.setAttribute('type', 'matrix');
    cm.setAttribute('values', [m[0], m[1], m[2], 0, o[0], m[3], m[4], m[5], 0, o[1], m[6], m[7], m[8], 0, o[2], 0, 0, 0, 1, 0].map(v => +v.toFixed(5)).join(' '));
    f.append(cm);
    $('#gradeDefs defs').append(f);
  }
  return `url(#${id})`;
}
const gradeStyle = g => (g ? `filter:${gradeCss(g)}` : null);

// Crops (K): kept as fractions of the picture as shown, i.e. after turning. Shown with
// CSS object-view-box, which works on the unturned picture, so the box is turned back.
const itemOf = name => state.items.find(x => x.name === name) || null;
function cropInOriginal(c, rot) {
  if (rot === 90) return { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w };
  if (rot === 180) return { x: 1 - c.x - c.w, y: 1 - c.y - c.h, w: c.w, h: c.h };
  if (rot === 270) return { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w };
  return c;
}
function cropBox(it) {
  if (!it || !it.crop) return '';
  const o = cropInOriginal(it.crop, it.rotate || 0);
  const p = v => `${(Math.max(0, v) * 100).toFixed(3)}%`;
  return `inset(${p(o.y)} ${p(1 - o.x - o.w)} ${p(1 - o.y - o.h)} ${p(o.x)})`;
}
// The style of a picture of a file: its colours and its crop.
function mediaStyle(it) {
  if (!it) return null;
  const parts = [gradeStyle(it.grade), it.crop ? `object-view-box:${cropBox(it)}` : null].filter(Boolean);
  return parts.length ? parts.join(';') : null;
}
const cropKey = c => (c ? [c.x, c.y, c.w, c.h].join(',') : '');

// Turned files (R / Shift+R): the original stays as it is, pictures and videos are shown
// turned (CSS, see .rot in style.css) and the release files are made turned.
const rotOf = name => { const it = state.items.find(x => x.name === name); return (it && it.rotate) || 0; };
const rotClass = r => (r ? ` rot r${r}` : '');

async function api(url, body) {
  const opts = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  };
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue; // e.g. disabled: null = not disabled
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

function fmtTime(sec) {
  if (!Number.isFinite(sec)) return '–';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

function parseStamp(s) {
  const [d, t = '00:00:00'] = s.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, se] = t.split(':').map(Number);
  return new Date(y, mo - 1, da, h, mi, se);
}

// Files are grouped by the day they were taken.
const groupKey = item => (item.date ? item.date.slice(0, 10) : 'unknown');

function groupLabel(key) {
  if (key === 'unknown') return 'Unknown date';
  return parseStamp(key).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

const current = () => state.view[state.sel] || null;
// The gallery with the large view: Pick (inside a release) or Favorites (on its own).
// 'browse' is Pick's view opened in full screen from Compose or Releases (see openInFocus).
const inPickView = () => state.mode === 'pick' || state.mode === 'favorites' || state.mode === 'browse';
const isMarked = it => (it.type === 'image' ? it.favorite : it.scenes.length > 0);

const collapseKey = it => `day:${groupKey(it)}`;
// In the favorites view every day is open: it only holds favorites anyway.
const isHidden = it => !state.lovedOnly && (state.collapsed.has(collapseKey(it)) || isBeforeRelease(it));
// Pick shows the release being made: the days before its start (released already)
// are left out unless "Show earlier days" is on. Favorites shows everything.
const isBeforeRelease = it => !!state.hideBefore && groupKey(it) !== 'unknown' && groupKey(it) < state.hideBefore;

function updateHideBefore(released) {
  const start = state.mode === 'pick' && !state.lovedOnly && !state.showReleased ? newReleaseStart(released) : null;
  state.hideBefore = start && start.after ? start.day : null;
}

// Next visible index from `from` in direction `dir` (+1 / -1), or -1 if none.
function step(from, dir) {
  for (let i = from + dir; i >= 0 && i < state.view.length; i += dir) {
    if (!isHidden(state.view[i])) return i;
  }
  return -1;
}

// Keeps the selection on a visible file: the same one if possible, else the next
// visible one after it, else the one before it.
function ensureVisibleSelection() {
  if (state.sel >= 0 && state.view[state.sel] && !isHidden(state.view[state.sel])) return;
  const from = state.sel >= 0 ? state.sel : -1;
  let i = step(from, 1);
  if (i < 0 && from >= 0) i = step(from, -1);
  state.sel = i;
}

// ---------- gallery ----------
// Every file of the journey's folder as a tile, oldest first, grouped by day. A tile
// shows where the file stands: picked for the release being made, in a release
// (not sent yet), or sent. Released files are dimmed and can't be picked again.

function buildView() {
  const keep = current();
  // browseOnly: the full screen opened from Compose or Releases shows just the files of
  // those posts (see openInFocus).
  state.view = state.items.filter(it => (!state.lovedOnly || it.loved) && (!state.browseOnly || state.browseOnly.has(it.name))).sort((a, b) => {
    if (!a.date !== !b.date) return a.date ? -1 : 1; // undated files always last
    return (a.date || '').localeCompare(b.date || '') || a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  state.sel = keep ? state.view.indexOf(keep) : -1;
  ensureVisibleSelection();
}

// File name -> { no, sent } of the latest release with a file made from it.
function releasedFiles() {
  const map = new Map();
  posts.releases.forEach((r, i) => {
    for (const p of r.parts) {
      for (const x of p.items) {
        if (!x.source) continue;
        const m = map.get(x.source) || { no: 0, all: 0, sent: 0 };
        m.no = i + 1;
        m.all++;
        if (x.sentAt) m.sent++;
        map.set(x.source, m);
      }
    }
  });
  return map;
}

// "sent", "released" (in a release, not all sent), "picked" (for the draft), "leftout"
// (picked, but its posts were removed in Arrange) or "free".
function fileStatus(it, released = releasedFiles()) {
  const r = released.get(it.name);
  if (r) return { state: r.sent === r.all ? 'sent' : 'released', no: r.no };
  if (!isMarked(it)) return { state: 'free' };
  const keys = it.type === 'image' ? [imgKey(it.name)] : it.scenes.map(sc => sceneKey(it.name, sc));
  const left = keys.every(k => (posts.data.media[k] || {}).removed);
  return { state: left ? 'leftout' : 'picked' };
}

// Why a file can't be picked or cut right now, or null if it can.
function pickBlocked(it) {
  if (state.mode === 'favorites') return 'Picking and cutting happen inside a release: Releases → 1 · Pick.';
  const st = fileStatus(it);
  if (st.state === 'sent' || st.state === 'released') return `${it.name} is in Release ${st.no} already. Released files can't be picked again.`;
  if (!hasDraft()) return 'Start a new release first: Releases → ＋ New release.';
  return null;
}

function renderList() {
  const list = $('#list');
  list.replaceChildren();
  if (!state.folder) {
    list.append(el('div', { class: 'list-empty' }, 'No journey open.'));
    return;
  }
  const nLoved = state.items.filter(it => it.loved).length;
  $('#lovedCount').textContent = nLoved ? `(${nLoved})` : '';
  if (!state.view.length) {
    list.append(el('div', { class: 'list-empty' }, state.lovedOnly
      ? 'No favorites yet. Press F (or ♡ over the picture) to make a photo or video a favorite.'
      : 'No photos or videos in this folder.'));
    renderPickBar();
    return;
  }
  const released = releasedFiles();
  // Days before the release leave the gallery; a selection among them moves to its start.
  updateHideBefore(released);
  const selBefore = current();
  ensureVisibleSelection();
  if (current() !== selBefore) queueMicrotask(renderViewer);
  const stats = {};
  for (const it of state.view) {
    const s = stats[groupKey(it)] || (stats[groupKey(it)] = { count: 0, picked: 0, released: 0, sent: 0, leftout: 0 });
    s.count++;
    s[fileStatus(it, released).state]++;
  }
  let lastKey = null, grid = null;
  const start = state.lovedOnly ? null : newReleaseStart(released);
  const earlier = start && start.after ? new Set(state.view.filter(it => groupKey(it) !== 'unknown' && groupKey(it) < start.day).map(groupKey)).size : 0;
  state.view.forEach((it, i) => {
    const key = groupKey(it);
    if (isBeforeRelease(it)) return;
    if (key !== lastKey) {
      // The border between what is released already and the days still open.
      if (start && start.after && key === start.day && state.mode === 'pick') {
        list.append(el('div', { class: 'relstart', title: 'The days before this line are in a release already' },
          ic('next'), newReleaseLabel(),
          el('span', { class: 'grow' }),
          el('button', { class: 'linkbtn', onclick: () => { state.showReleased = !state.showReleased; renderList(); if (state.focus) renderFilmstrip(); } },
            state.showReleased ? 'Hide earlier days' : `Show ${earlier} earlier day${earlier === 1 ? '' : 's'}`)));
      }
      list.append(renderGroupHeader(key, stats[key], isHidden(it), state.lovedOnly ? null : collapseKey(it)));
      grid = el('div', { class: 'pgrid' });
      list.append(grid);
      lastKey = key;
    }
    if (!isHidden(it)) grid.append(renderTile(it, i, released));
  });
  scrollSelIntoView();
  renderPickBar();
}

function renderGroupHeader(key, s, closed, ckey) {
  const facts = [`${s.count} file${s.count === 1 ? '' : 's'}`];
  if (s.picked) facts.push(`${s.picked} picked`);
  if (s.released) facts.push(`${s.released} in a release`);
  if (s.sent) facts.push(`${s.sent} sent`);
  return el('div', {
    class: 'group' + (closed ? ' closed' : '') + (s.sent === s.count ? ' all-sent' : ''),
    title: !ckey ? '' : closed ? 'Click to expand' : 'Click to collapse (C)',
    onclick: () => toggleGroup(ckey),
  },
  el('span', { class: 'chev' }, ic(closed ? 'right' : 'down')),
  groupLabel(key),
  el('span', { class: 'count' }, facts.join(' · ')));
}

// A video's thumbnail: the frame chosen with T, else the one at 1 s.
const thumbSrc = it => `/thumb?name=${encodeURIComponent(it.name)}` + (it.type === 'video' ? `&t=${it.thumbT != null ? it.thumbT : 1}` : '');

function renderTile(it, i, released = releasedFiles()) {
  const st = fileStatus(it, released);
  const badge = st.state === 'sent' ? el('span', { class: 'tbadge sent' }, ic('check'), `Release ${st.no}`)
    : st.state === 'released' ? el('span', { class: 'tbadge released' }, `Release ${st.no}`)
      : st.state === 'picked' && it.type === 'video' ? el('span', { class: 'tbadge picked' }, `${it.scenes.length} scene${it.scenes.length === 1 ? '' : 's'}`)
        : st.state === 'leftout' ? el('span', { class: 'tbadge leftout', title: 'Picked, but removed in Compose' }, 'Left out')
          : null;
  const time = it.date ? it.date.slice(11, 16) : '';
  // Soft tile: the photo with rounded corners, its time and name over the bottom edge.
  return el('div', {
    class: `tile ${st.state}` + (i === state.sel ? ' sel' : '') + (it.grade ? ' graded' : ''), 'data-i': i,
    title: `${it.name}${time ? ` · ${time}` : ''}` + (st.state === 'sent' || st.state === 'released' ? `\nIn Release ${st.no}; can't be picked again` : '') + '\nDouble-click: full screen',
    onclick: () => select(i),
  },
  el('div', { class: 'tthumb' },
    el('img', { src: thumbSrc(it), loading: 'lazy', decoding: 'async', alt: '', class: rotClass(it.rotate).trim() || null, style: mediaStyle(it) }),
    it.type === 'video' ? el('span', { class: 'tvid' }, ic('play'), it.duration ? fmtTime(it.duration).replace(/\.\d$/, '') : '') : null,
    badge,
    st.state === 'picked' ? el('span', { class: 'ttick' }, ic('check')) : null,
    it.loved ? el('span', { class: 'theart', title: 'Favorite' }, '♥') : null,
    it.grade ? el('span', { class: 'tgrade', title: 'Colours changed (G)' }, '🎨') : null,
    el('div', { class: 'tmeta' },
      el('b', { class: 'time' }, time,
        it.dateSource === 'file' ? el('span', { class: 'approx', title: 'No capture date in the file. Using the date it was last changed.' }, ' ≈') : null),
      el('span', { class: 'name' }, it.name))));
}

function refreshRow(i) {
  const old = $(`#list .tile[data-i="${i}"]`);
  if (old && state.view[i]) old.replaceWith(renderTile(state.view[i], i));
}

function scrollSelIntoView() {
  const tile = $('#list .tile.sel');
  if (tile) tile.scrollIntoView({ block: 'nearest' });
}

// Above the gallery: which release you are picking for, or how to start one.
function renderPickBar() {
  const bar = $('#pickBar');
  if (!bar) return;
  bar.replaceChildren();
  if (!state.folder) return;
  if (hasDraft()) {
    const n = exportEntries().filter(isNew).length;
    bar.append(el('span', {}, 'Picking for ', el('b', {}, draftTitle()), ` · ${n} post${n === 1 ? '' : 's'}`),
      el('span', { class: 'grow' }),
      el('button', { onclick: jumpToNewDays, title: 'Jump to the first day of this release (B)' }, 'Release start'),
      el('button', { onclick: jumpToLastPicked, title: 'Jump to the last file you picked for this release (L)' }, 'Last picked'),
      el('button', { onclick: () => setMode('arrange'), title: 'Step 2: captions, text posts, day intros, order' }, 'Next: Compose', ic('next')));
  } else {
    bar.classList.add('none');
    bar.append(el('span', {}, 'No release is being made. Start one to pick photos and scenes.'),
      el('span', { class: 'grow' }),
      el('button', { class: 'primary', onclick: startDraft }, ic('plus'), 'New release'));
  }
  bar.classList.toggle('none', !hasDraft());
}

function toggleGroup(ckey) {
  if (!ckey) return;
  if (state.collapsed.has(ckey)) state.collapsed.delete(ckey);
  else state.collapsed.add(ckey);
  const before = current();
  ensureVisibleSelection();
  renderList();
  if (current() !== before) { state.pendingStart = null; renderViewer(); } else renderInfo();
  saveView();
}

// Collapses the day of the current file and moves on to the next day.
function collapseCurrentGroup() {
  const it = current();
  if (!it) return;
  toggleGroup(collapseKey(it));
}

// Collapsed days and the selected file are saved shortly after each change, so
// quick arrow-key presses end up as one save.
let viewTimer = null;
// The folder is sent along, so a save that arrives after switching folders is ignored.
const viewBody = () => ({ folder: state.folder, collapsed: [...state.collapsed], lastFile: current() ? current().name : null });

function saveView() {
  if (!state.folder) return;
  clearTimeout(viewTimer);
  viewTimer = setTimeout(flushView, 400);
}

function flushView() {
  if (!viewTimer) return Promise.resolve();
  clearTimeout(viewTimer);
  viewTimer = null;
  return api('/api/view', viewBody()).catch(() => {});
}

function renderSummary() {
  $('#summary').textContent = state.folder ? `${state.items.length} file${state.items.length === 1 ? '' : 's'}` : '';
  // Under the journey's name: the days of its photos and videos.
  const days = state.items.map(it => (it.date || '').slice(0, 10)).filter(Boolean).sort();
  const day = d => parseStamp(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const range = days.length ? (days[0] === days[days.length - 1] ? day(days[0]) : `${day(days[0])} – ${day(days[days.length - 1])}`) : '';
  $('#journeyWhen').textContent = state.folder
    ? [range, state.items.length === 1 ? '1 file' : `${state.items.length} photos and videos`].filter(Boolean).join(' · ') : '';
}

// After a pick changed: the draft's posts, the tile and its day's counts.
function picksChanged() {
  refreshPosts();
  const scroll = $('#list').scrollTop;
  renderList();
  $('#list').scrollTop = scroll;
  renderStageTools();
  if (state.focus) renderFilmstrip();
}

// ---------- viewer ----------

function mediaUrl(it) {
  return '/media?name=' + encodeURIComponent(it.name);
}

function select(i) {
  if (i < 0 || i >= state.view.length) return;
  const prev = state.sel;
  state.sel = i;
  state.pendingStart = null;
  // Another file starts at normal speed (a scene keeps its own speed anyway).
  if (i !== prev) { state.speed = 1; speedTargetKey = null; }
  refreshRow(prev);
  refreshRow(i);
  scrollSelIntoView();
  renderViewer();
  updatePlayButtons();
  saveView();
}

function renderViewer() {
  const stage = $('#stage');
  const it = current();
  stage.replaceChildren();
  $('#videoPanel').hidden = true;
  if (state.cropping) endCrop(false);
  resetZoom(); // a new file starts as the whole picture
  renderStageTools();
  renderGradePanel();
  renderAnimals();
  if (state.focus) renderFilmstrip();
  if (!it) {
    const msg = !state.folder ? 'Choose a journey to start.'
      : state.lovedOnly && !state.view.length ? 'No favorites yet.'
      : state.view.length ? 'All days are collapsed. Click a day to open it.' : 'Nothing to show.';
    stage.append(el('div', { class: 'empty' }, msg));
    $('#infoBar').textContent = '';
    return;
  }
  const rot = it.rotate || 0;
  if (it.type === 'image') {
    stage.append(el('img', {
      src: mediaUrl(it), alt: it.name, class: rotClass(rot).trim() || null, style: mediaStyle(it),
      title: state.focus ? 'Double-click: leave full screen' : 'Double-click: full screen',
      ondblclick: () => toggleFocus(),
    }));
    if (it.favorite) stage.append(el('div', { class: 'bigstar' }, '★'));
  } else {
    const v = turnableVideo(mediaUrl(it), rot);
    v.style.filter = gradeCss(it.grade);
    if (it.crop) v.style.setProperty('object-view-box', cropBox(it));
    v.preload = 'metadata';
    // Double-click: full screen of the whole Pick view (with timeline and scenes),
    // instead of the browser's full screen of the bare video.
    v.addEventListener('dblclick', e => { e.preventDefault(); toggleFocus(); });
    v.addEventListener('error', () => offerPreview(it), { once: true });
    v.addEventListener('timeupdate', updateTimeline);
    v.addEventListener('loadedmetadata', renderScenes);
    v.addEventListener('play', tick);
    applyPlayback(v);
    releaseControlsFocus(v);
    stage.append(v);
    $('#videoPanel').hidden = false;
    renderScenes();
  }
  renderInfo();
}

function renderInfo() {
  const it = current();
  if (!it) return;
  const mb = (it.size / 1048576).toFixed(1) + ' MB';
  const when = it.date ? parseStamp(it.date).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' }) : 'unknown date';
  const source = { capture: '', name: ' (from file name)', file: ' (file date, no capture date found)' }[it.dateSource] || '';
  const parts = [it.name, when + source, mb];
  if (it.type === 'video' && it.duration) parts.push(fmtTime(it.duration));
  parts.push(`${state.sel + 1} of ${state.view.length}`);
  $('#infoBar').textContent = parts.join('  ·  ');
}

// Some formats (for example HEVC or AVI on some PCs) do not play in the browser.
// The server can make a small H.264 copy for viewing; cuts still use the original.
function offerPreview(it) {
  const stage = $('#stage');
  if (current() !== it) return;
  const btn = el('button', {
    class: 'primary',
    onclick: () => {
      stage.replaceChildren(el('div', { class: 'msg' }, 'Creating a preview… this can take a while for long videos.'));
      const v = turnableVideo('/preview?name=' + encodeURIComponent(it.name), it.rotate || 0);
      v.style.filter = gradeCss(it.grade);
      if (it.crop) v.style.setProperty('object-view-box', cropBox(it));
      v.preload = 'metadata';
      v.addEventListener('dblclick', e => { e.preventDefault(); toggleFocus(); });
      applyPlayback(v);
      v.addEventListener('timeupdate', updateTimeline);
      v.addEventListener('loadedmetadata', () => { stage.replaceChildren(v); renderScenes(); });
      v.addEventListener('play', tick);
      releaseControlsFocus(v);
      v.addEventListener('error', () => {
        stage.replaceChildren(el('div', { class: 'msg' }, 'Sorry, this video could not be opened.'));
      }, { once: true });
      v.load();
    },
  }, 'Create preview');
  stage.replaceChildren(el('div', { class: 'msg' },
    'This video format does not play in the browser.', el('br'), btn));
}

const video = () => $('#stage video');

// A turned video gets no browser controls (they would be turned with it): a click
// plays or pauses, the timeline below seeks, Space plays too.
function turnableVideo(src, rot, native = false) {
  const v = el('video', { src, class: rotClass(rot).trim() || null });
  if (rot || !native) {
    v.title = 'Click: play / pause · double-click: full screen';
    v.addEventListener('click', () => { if (v.paused) v.play().catch(() => {}); else v.pause(); });
  } else {
    v.controls = true;
  }
  return v;
}

// ---------- playing videos: own controls (play, sound, speed) ----------
// Pick uses its own controls instead of the browser's: they work the same in full
// screen, for turned videos, and never take the keyboard away.

const SPEEDS = [1, 0.75, 0.5, 0.25];
const speedLabel = x => ({ 1: '1×', 0.75: '¾×', 0.5: '½×', 0.25: '¼×' }[x] || `${x}×`);

function applyPlayback(v) {
  v.defaultPlaybackRate = state.speed;
  v.playbackRate = state.speed;
  v.preservesPitch = true;
  v.muted = state.muted;
  const sync = () => updatePlayButtons();
  for (const type of ['play', 'pause', 'ended', 'loadedmetadata']) v.addEventListener(type, sync);
  // Loading a file resets the rate: set it again once it's there.
  v.addEventListener('loadedmetadata', () => { speedTargetKey = null; syncSpeedTarget(true); });
}

function togglePlay() {
  const v = video();
  if (!v) return;
  if (v.paused) v.play().catch(() => {}); else v.pause();
}

// The speed buttons work on the scene the play head stands in (click a scene in the
// timeline or in the list to go there): its speed changes, also in the release.
// Outside of any scene they set the speed that new scenes will get.
function activeScene() {
  const it = current(), v = video();
  if (!it || it.type !== 'video' || !v) return -1;
  const t = v.currentTime;
  return it.scenes.findIndex(sc => t >= sc.start - 0.02 && t <= sc.end + 0.02);
}

// The speed that applies where the play head is: the scene's own, else the one for new scenes.
function speedHere() {
  const i = activeScene();
  return i >= 0 ? current().scenes[i].speed || 1 : state.speed;
}

function setSpeed(x) {
  const speed = SPEEDS.includes(x) ? x : 1;
  const i = activeScene();
  if (i >= 0) {
    if ((current().scenes[i].speed || 1) !== speed) setSceneSpeed(i, speed);
    return;
  }
  state.speed = speed;
  syncSpeedTarget(true);
}

function stepSpeed(dir) {
  const scene = activeScene();
  const i = SPEEDS.indexOf(speedHere());
  const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i + dir))];
  setSpeed(next);
  if (scene < 0) toast(`Speed ${speedLabel(next)}` + (next < 1 ? ' · new scenes get this slow motion' : ''));
}

// Marks the scene under the play head, plays at its speed and shows it on the buttons.
let speedTargetKey = null;
function syncSpeedTarget(force = false) {
  const it = current(), v = video();
  if (!it || !v) return;
  const i = activeScene();
  const speed = speedHere();
  const key = `${it.name}#${i}@${speed}`;
  if (key === speedTargetKey && !force) return;
  speedTargetKey = key;
  if (v.playbackRate !== speed) v.playbackRate = speed;
  $('#tlScenes').querySelectorAll('.seg').forEach((el, j) => el.classList.toggle('active', j === i));
  $('#sceneList').querySelectorAll('li').forEach((el, j) => el.classList.toggle('active', j === i));
  const whole = i >= 0 && isWholeScene(it.scenes[i], v.duration || it.duration || 0);
  $('#speedFor').textContent = i >= 0 ? (whole ? 'whole video' : `scene ${i + 1}`) : 'new scenes';
  $('#speedFor').classList.toggle('scene', i >= 0);
  updatePlayButtons();
}

function toggleMute() {
  state.muted = !state.muted;
  const v = video();
  if (v) v.muted = state.muted;
  updatePlayButtons();
}

function updatePlayButtons() {
  const v = video();
  $('#playBtn').textContent = v && !v.paused ? '❚❚' : '▶';
  $('#muteBtn').textContent = state.muted ? '🔇' : '🔊';
  const speed = speedHere();
  for (const b of document.querySelectorAll('#speedSeg button')) b.classList.toggle('on', Number(b.dataset.speed) === speed);
}

// The timeline: click to jump, or drag to scrub.
function initTimelineDrag() {
  const tl = $('#timeline');
  const at = e => {
    const v = video();
    if (!v || !v.duration) return;
    const r = tl.getBoundingClientRect();
    seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * v.duration);
  };
  tl.addEventListener('pointerdown', e => {
    tl.setPointerCapture(e.pointerId);
    at(e);
    const move = ev => at(ev);
    const up = () => { tl.removeEventListener('pointermove', move); tl.removeEventListener('pointerup', up); tl.removeEventListener('pointercancel', up); };
    tl.addEventListener('pointermove', move);
    tl.addEventListener('pointerup', up);
    tl.addEventListener('pointercancel', up);
  });
}

// ---------- zooming into the picture ----------
// Two fingers on a touch screen, or the mouse wheel, zoom the photo or video on the
// stage around that spot; drag to move it; one finger sideways (not zoomed) goes to
// the next or previous file. Uses the CSS scale / translate properties, which work on
// top of the turn (rotation) the picture may already have.
// makeZoom gives one area this behaviour: the stage in Pick, and the viewer that opens
// on a double-click in Compose and Releases.
//   node(): the picture or video in it · info: the "250 % · reset" button
//   active(): whether zooming applies right now · onSwipe(dir): next (+1) / previous (-1)
function makeZoom(stage, opts) {
  const zoom = { z: 1, x: 0, y: 0 };

  function apply() {
    const node = opts.node();
    if (zoom.z <= 1.001) { zoom.z = 1; zoom.x = 0; zoom.y = 0; }
    // Keep the picture over the stage: it can't be dragged out of sight.
    const mx = (zoom.z - 1) * stage.clientWidth / 2, my = (zoom.z - 1) * stage.clientHeight / 2;
    zoom.x = Math.max(-mx, Math.min(mx, zoom.x));
    zoom.y = Math.max(-my, Math.min(my, zoom.y));
    if (node) {
      node.style.scale = zoom.z === 1 ? '' : String(zoom.z);
      node.style.translate = zoom.z === 1 ? '' : `${zoom.x}px ${zoom.y}px`;
    }
    stage.classList.toggle('zoomed', zoom.z > 1);
    opts.info.hidden = zoom.z === 1;
    opts.info.textContent = `${Math.round(zoom.z * 100)} % · reset`;
  }

  const reset = () => { zoom.z = 1; apply(); };

  // Zoom by a factor around a point of the screen.
  function zoomAt(factor, clientX, clientY) {
    const r = stage.getBoundingClientRect();
    const mx = clientX - (r.left + r.width / 2), my = clientY - (r.top + r.height / 2);
    const z = Math.max(1, Math.min(10, zoom.z * factor));
    const k = z / zoom.z;
    zoom.x = mx - (mx - zoom.x) * k;
    zoom.y = my - (my - zoom.y) * k;
    zoom.z = z;
    apply();
  }

  const pts = new Map(); // pointerId -> { x, y }
  let last = null;       // pinch: { d, cx, cy }; drag: { x, y }
  let moved = 0, startX = 0, startY = 0, pinched = false;
  const pinch = () => {
    const [a, b] = [...pts.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  };
  stage.addEventListener('wheel', e => {
    if (!opts.active()) return;
    e.preventDefault();
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX, e.clientY);
  }, { passive: false });
  stage.addEventListener('pointerdown', e => {
    if (!opts.active()) return;
    if (!e.target.closest('img, video, canvas') && e.target !== stage) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) { moved = 0; pinched = false; startX = e.clientX; startY = e.clientY; last = { x: e.clientX, y: e.clientY }; }
    if (pts.size === 2) { last = pinch(); pinched = true; moved = 99; }
    if (zoom.z > 1 || e.pointerType === 'touch') { try { stage.setPointerCapture(e.pointerId); } catch { /* gone */ } }
  });
  stage.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size >= 2) {
      const now = pinch();
      zoom.x += now.cx - last.cx;
      zoom.y += now.cy - last.cy;
      zoomAt(now.d / last.d, now.cx, now.cy);
      last = now;
    } else if (last && last.x != null) {
      moved = Math.max(moved, Math.hypot(e.clientX - startX, e.clientY - startY));
      if (zoom.z > 1 && moved > 4) {
        zoom.x += e.clientX - last.x;
        zoom.y += e.clientY - last.y;
        stage.classList.add('panning');
        apply();
      }
      last = { x: e.clientX, y: e.clientY };
    }
  });
  const end = e => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    stage.classList.remove('panning');
    // One finger sideways on the whole picture: next / previous.
    if (opts.onSwipe && e.type === 'pointerup' && e.pointerType === 'touch' && pts.size === 0 && zoom.z === 1 && !pinched) {
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) opts.onSwipe(dx < 0 ? 1 : -1);
    }
    if (pts.size === 1) { const p = [...pts.values()][0]; last = { x: p.x, y: p.y }; }
    if (pts.size === 0) last = null;
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  // A drag or pinch must not count as a click (a click plays or pauses a video, or
  // switches the viewer to real size).
  stage.addEventListener('click', e => { if (moved > 4) { e.stopPropagation(); e.preventDefault(); moved = 0; } }, true);
  stage.addEventListener('dragstart', e => e.preventDefault()); // no dragging the picture out of the page
  opts.info.addEventListener('click', e => { e.stopPropagation(); reset(); });
  window.addEventListener('resize', apply);
  return { reset, apply, get z() { return zoom.z; } };
}

let pickZoom = null, viewerZoom = null;
const resetZoom = () => { if (pickZoom) pickZoom.reset(); };

function initZoom() {
  pickZoom = makeZoom($('#stage'), {
    node: () => $('#stage img, #stage video'), info: $('#zoomInfo'),
    active: () => !!current() && !state.cropping, onSwipe: dir => select(step(state.sel, dir)),
  });
  // The viewer zooms while the picture is fitted to the window (not at "real size",
  // where it scrolls instead).
  viewerZoom = makeZoom($('#viewerStage'), {
    node: () => $('#viewerStage > *'), info: $('#viewerZoomInfo'),
    active: () => $('#viewer-dlg').open && $('#viewerStage').classList.contains('fit'),
  });
}

// ---------- cropping (K) ----------
// A frame over the picture: drag its corners or edges, drag inside to move it, drag
// outside it to draw a new one. The bar below sets the shape (free, 9:16 for the
// Status screen …). The whole picture is shown while cropping; Apply keeps the crop.

const CROP_MIN = 24; // px

function initCrop() {
  $('#cropBtn').addEventListener('click', () => (state.cropping ? endCrop(true) : startCrop()));
  $('#cropApply').addEventListener('click', () => endCrop(true));
  $('#cropCancel').addEventListener('click', () => endCrop(false));
  $('#cropReset').addEventListener('click', () => { state.cropping.f = { x: 0, y: 0, w: 1, h: 1 }; setCropAspect(state.cropping.aspect); });
  $('#cropTurn').addEventListener('click', () => {
    const c = state.cropping;
    if (!c || c.aspect === 'free') return;
    setCropAspect(1 / cropAspectValue(c.aspect), true);
  });
  for (const b of document.querySelectorAll('#cropAspects button')) {
    b.addEventListener('click', () => setCropAspect(b.dataset.a));
    b.addEventListener('pointerup', () => setTimeout(() => b.blur(), 0));
  }
  window.addEventListener('resize', () => { if (state.cropping) renderCrop(); });
}

// Where the whole picture is on the stage (px, relative to the stage) and its pixels.
function cropMediaRect() {
  const it = current(), node = $('#stage img, #stage video'), stage = $('#stage');
  if (!it || !node) return null;
  const nw = node.naturalWidth || node.videoWidth, nh = node.naturalHeight || node.videoHeight;
  if (!nw || !nh) return null;
  const rot = it.rotate || 0, side = rot % 180 !== 0;
  const pw = side ? nh : nw, ph = side ? nw : nh; // pixels as shown
  const sr = stage.getBoundingClientRect();
  let x, y, w, h;
  if (rot) {
    // Turned pictures fill the stage (contain), centred.
    const f = Math.min(sr.width / pw, sr.height / ph);
    w = pw * f; h = ph * f; x = (sr.width - w) / 2; y = (sr.height - h) / 2;
  } else {
    const r = node.getBoundingClientRect();
    x = r.left - sr.left; y = r.top - sr.top; w = r.width; h = r.height;
  }
  return { x, y, w, h, pw, ph };
}

function startCrop() {
  const it = current();
  if (!it) return;
  const v = video();
  if (v) v.pause();
  resetZoom();
  const node = $('#stage img, #stage video');
  if (node) node.style.removeProperty('object-view-box'); // show the whole picture
  requestAnimationFrame(() => {
    const m = cropMediaRect();
    if (!m) { if (node) node.style.setProperty('object-view-box', cropBox(it)); toast('The picture is not loaded yet'); return; }
    state.cropping = { it, f: it.crop ? { ...it.crop } : { x: 0, y: 0, w: 1, h: 1 }, aspect: 'free' };
    document.body.classList.add('cropping');
    $('#cropBar').hidden = false;
    $('#cropBtn').classList.add('on');
    buildCropLayer();
    renderCrop();
  });
}

function endCrop(keep) {
  const c = state.cropping;
  if (!c) return;
  state.cropping = null;
  document.body.classList.remove('cropping');
  $('#cropBar').hidden = true;
  const layer = $('#cropLayer');
  if (layer) layer.remove();
  const it = c.it;
  if (keep) {
    const f = c.f;
    const whole = f.x < 0.001 && f.y < 0.001 && f.w > 0.999 && f.h > 0.999;
    const before = it.crop || null;
    it.crop = whole ? null : { x: +f.x.toFixed(4), y: +f.y.toFixed(4), w: +f.w.toFixed(4), h: +f.h.toFixed(4) };
    if (!it.crop) delete it.crop;
    if (cropKey(before) !== cropKey(it.crop)) {
      api('/api/crop', { name: it.name, crop: it.crop || null })
        .then(r => { if (r.crop) it.crop = r.crop; else delete it.crop; })
        .catch(err => toast('Could not save the crop: ' + err.message));
      toast(it.crop ? 'Cropped' : 'Crop removed: the whole picture again');
      if (typeof onRotated === 'function') onRotated(it); // Compose follows
    }
  }
  if (current() === it) {
    const node = $('#stage img, #stage video');
    if (node) { if (it.crop) node.style.setProperty('object-view-box', cropBox(it)); else node.style.removeProperty('object-view-box'); }
    refreshRow(state.sel);
    if (state.focus) renderFilmstrip();
  }
  $('#cropBtn').classList.toggle('on', !!(current() && current().crop));
}

const cropAspectValue = (a, m = cropMediaRect()) => (a === 'free' ? null : a === 'orig' ? m.pw / m.ph : Number(a));

// A shape: the largest frame of it that fits the picture, around the current frame's centre.
function setCropAspect(a, keepButton) {
  const c = state.cropping;
  if (!c) return;
  const m = cropMediaRect();
  if (!keepButton) {
    c.aspect = a;
    for (const b of document.querySelectorAll('#cropAspects button')) b.classList.toggle('on', b.dataset.a === String(a));
  } else {
    c.aspect = String(a);
  }
  const A = cropAspectValue(c.aspect, m);
  if (A) {
    const W = m.pw, H = m.ph; // work in picture pixels so the shape is exact
    const cx = (c.f.x + c.f.w / 2) * W, cy = (c.f.y + c.f.h / 2) * H;
    let w = W, h = w / A;
    if (h > H) { h = H; w = h * A; }
    const x = Math.max(0, Math.min(W - w, cx - w / 2)), y = Math.max(0, Math.min(H - h, cy - h / 2));
    c.f = { x: x / W, y: y / H, w: w / W, h: h / H };
  }
  renderCrop();
}

function buildCropLayer() {
  const old = $('#cropLayer');
  if (old) old.remove();
  const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(d => el('div', { class: `ch ${d}`, 'data-h': d }));
  const rect = el('div', { class: 'crect' },
    el('div', { class: 'cgrid v1' }), el('div', { class: 'cgrid v2' }), el('div', { class: 'cgrid h1' }), el('div', { class: 'cgrid h2' }),
    el('span', { class: 'ctag' }), ...handles);
  // The dark mask is clipped to the picture; the frame and its handles are not, so a
  // handle on the picture's edge can still be grabbed.
  const frame = el('div', { class: 'cframe' }, el('div', { class: 'cmask' }, el('div', { class: 'chole' })), rect);
  const layer = el('div', { id: 'cropLayer' }, frame);
  $('#stage').append(layer);
  frame.addEventListener('pointerdown', cropPointerDown);
  layer.addEventListener('dblclick', () => endCrop(true));
}

function renderCrop() {
  const c = state.cropping, m = cropMediaRect();
  if (!c || !m) return;
  const frame = $('#cropLayer .cframe'), rect = $('#cropLayer .crect');
  Object.assign(frame.style, { left: `${m.x}px`, top: `${m.y}px`, width: `${m.w}px`, height: `${m.h}px` });
  const box = { left: `${c.f.x * m.w}px`, top: `${c.f.y * m.h}px`, width: `${c.f.w * m.w}px`, height: `${c.f.h * m.h}px` };
  Object.assign(rect.style, box);
  Object.assign($('#cropLayer .chole').style, box);
  const px = `${Math.round(c.f.w * m.pw)} × ${Math.round(c.f.h * m.ph)}`;
  $('#cropLayer .ctag').textContent = px;
  $('#cropSize').textContent = `${px} px`;
}

function cropPointerDown(e) {
  const c = state.cropping, m = cropMediaRect();
  if (!c || !m) return;
  e.preventDefault();
  const frame = e.currentTarget;
  frame.setPointerCapture(e.pointerId);
  const fr = frame.getBoundingClientRect();
  const W = m.w, H = m.h;
  const p0 = { x: e.clientX - fr.left, y: e.clientY - fr.top };
  const s = { L: c.f.x * W, T: c.f.y * H, R: (c.f.x + c.f.w) * W, B: (c.f.y + c.f.h) * H };
  let mode = e.target.dataset.h || null;
  if (!mode) mode = p0.x >= s.L && p0.x <= s.R && p0.y >= s.T && p0.y <= s.B ? 'move' : 'new';
  const A0 = cropAspectValue(c.aspect, m);
  const A = A0 ? A0 * (m.ph / m.pw) * (W / H) : null; // the shape in screen pixels
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  if (mode === 'new') {
    const ax = clamp(p0.x, 0, W), ay = clamp(p0.y, 0, H);
    Object.assign(s, { L: ax, R: ax, T: ay, B: ay });
  }
  frame.classList.add('dragging');

  const move = ev => {
    const dx = ev.clientX - fr.left - p0.x, dy = ev.clientY - fr.top - p0.y;
    let { L, T, R, B } = s;
    let h = mode;
    if (mode === 'move') {
      const w = R - L, hh = B - T;
      L = clamp(s.L + dx, 0, W - w); T = clamp(s.T + dy, 0, H - hh); R = L + w; B = T + hh;
    } else {
      if (mode === 'new') h = (dy < 0 ? 'n' : 's') + (dx < 0 ? 'w' : 'e');
      const min = mode === 'new' ? 1 : CROP_MIN;
      if (h.includes('w')) L = clamp(s.L + dx, 0, R - min);
      if (h.includes('e')) R = clamp(s.R + dx, L + min, W);
      if (h.includes('n')) T = clamp(s.T + dy, 0, B - min);
      if (h.includes('s')) B = clamp(s.B + dy, T + min, H);
      if (A) {
        if (h.length === 2) {
          // A corner: the opposite corner stays, the shape is kept.
          let w = R - L, hh = B - T;
          if (w / hh > A) w = hh * A; else hh = w / A;
          const maxW = h.includes('w') ? s.R : W - s.L, maxH = h.includes('n') ? s.B : H - s.T;
          w = Math.min(w, maxW, maxH * A); hh = w / A;
          if (h.includes('w')) { R = s.R; L = R - w; } else { L = s.L; R = L + w; }
          if (h.includes('n')) { B = s.B; T = B - hh; } else { T = s.T; B = T + hh; }
        } else if (h === 'n' || h === 's') {
          // An edge: the frame grows around its middle.
          let hh = B - T, w = hh * A;
          const cx = (s.L + s.R) / 2, maxW = 2 * Math.min(cx, W - cx);
          if (w > maxW) { w = maxW; hh = w / A; if (h === 'n') T = B - hh; else B = T + hh; }
          L = cx - w / 2; R = cx + w / 2;
        } else {
          let w = R - L, hh = w / A;
          const cy = (s.T + s.B) / 2, maxH = 2 * Math.min(cy, H - cy);
          if (hh > maxH) { hh = maxH; w = hh * A; if (h === 'w') L = R - w; else R = L + w; }
          T = cy - hh / 2; B = cy + hh / 2;
        }
      }
    }
    c.f = { x: L / W, y: T / H, w: (R - L) / W, h: (B - T) / H };
    renderCrop();
  };
  const before = { ...c.f };
  const up = () => {
    frame.removeEventListener('pointermove', move);
    frame.removeEventListener('pointerup', up);
    frame.removeEventListener('pointercancel', up);
    frame.classList.remove('dragging');
    // A click (or a tiny drag) outside the frame: keep the frame as it was.
    if (c.f.w * W < CROP_MIN || c.f.h * H < CROP_MIN) { c.f = before; renderCrop(); }
  };
  frame.addEventListener('pointermove', move);
  frame.addEventListener('pointerup', up);
  frame.addEventListener('pointercancel', up);
}

// ---------- colours (G) ----------
// Sliders for the selected file. The picture, its tile and the strip follow at once;
// the grade is saved with the file (_grades.json) a moment after the last change.

const GRADE_SLIDERS = [
  ['uw', '🌊 Underwater', 0, 100], ['brightness', 'Brightness', -50, 50], ['contrast', 'Contrast', -50, 50],
  ['saturation', 'Saturation', -50, 50], ['warmth', 'Warmth', -50, 50], ['tint', 'Tint', -50, 50],
];
const EMPTY_GRADE = { uw: 0, brightness: 0, contrast: 0, saturation: 0, warmth: 0, tint: 0 };

function initGradePanel() {
  const box = $('#gradeSliders');
  for (const [key, label, min, max] of GRADE_SLIDERS) {
    const input = el('input', { type: 'range', min, max, step: 1, value: 0, 'data-key': key });
    const num = el('output', {}, '0');
    input.addEventListener('input', () => { num.textContent = input.value; changeGrade({ [key]: Number(input.value) }); });
    // Double-click a slider: back to 0.
    input.addEventListener('dblclick', () => { input.value = 0; num.textContent = '0'; changeGrade({ [key]: 0 }); });
    input.addEventListener('pointerup', () => setTimeout(() => input.blur(), 0));
    box.append(el('label', {}, el('span', {}, label), input, num));
  }
  $('#gradeBtn').addEventListener('click', () => toggleGradePanel());
  $('#gradeUw').addEventListener('click', () => underwaterFix());
  $('#gradeAuto').addEventListener('click', autoGrade);
  $('#gradeReset').addEventListener('click', () => { $('#gradeNote').textContent = ''; setGrade(current(), null); });
  $('#gradeCopy').addEventListener('click', () => {
    const it = current();
    if (!it || !it.grade) { toast('This file has its original colours: nothing to copy'); return; }
    state.gradeClip = { ...it.grade };
    toast('Colour settings copied. Go to another file and click Paste.');
  });
  $('#gradePaste').addEventListener('click', () => {
    if (!state.gradeClip) { toast('Copy the colour settings of a file first'); return; }
    setGrade(current(), state.gradeClip);
  });
  const before = $('#gradeBefore');
  const show = on => document.body.classList.toggle('grade-off', on);
  before.addEventListener('pointerdown', () => show(true));
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) before.addEventListener(type, () => { show(false); before.blur(); });
}

function toggleGradePanel(on = !state.gradeOpen) {
  state.gradeOpen = on;
  renderGradePanel();
}

function renderGradePanel() {
  const it = current();
  $('#gradePanel').hidden = !state.gradeOpen || !it;
  $('#gradeBtn').classList.toggle('on', !!(it && it.grade));
  if (!it || !state.gradeOpen) return;
  const g = it.grade || EMPTY_GRADE;
  for (const input of document.querySelectorAll('#gradeSliders input')) {
    input.value = g[input.dataset.key] || 0;
    input.nextElementSibling.textContent = input.value;
  }
}

// The picture or video frame on the stage, as pixels (small), for measuring its colours.
function stagePixels() {
  const node = $('#stage img, #stage video');
  if (!node) return null;
  const w = node.videoWidth || node.naturalWidth, h = node.videoHeight || node.naturalHeight;
  if (!w || !h) return null;
  const c = document.createElement('canvas');
  c.width = 96; c.height = Math.max(1, Math.round(96 * h / w));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(node, 0, 0, c.width, c.height);
  try { return ctx.getImageData(0, 0, c.width, c.height).data; } catch { return null; }
}

function changeGrade(patch) {
  const it = current();
  if (!it) return;
  const g = { ...EMPTY_GRADE, ...(it.grade || {}), ...patch };
  // The underwater slider needs the picture's measured colour cast: measure it on first use.
  if (g.uw > 0 && !g.gains) {
    const px = stagePixels();
    if (px) g.gains = Grade.grayWorldGains(px);
  }
  setGrade(it, g);
}

// One click: measure the cast in what is shown now and remove most of it.
function underwaterFix(strength) {
  const it = current();
  const px = stagePixels();
  if (!it || !px) { toast('The picture is not loaded yet'); return; }
  const g = { ...EMPTY_GRADE, ...(it.grade || {}) };
  g.gains = Grade.grayWorldGains(px);
  g.uw = strength != null ? strength : (g.uw || 70);
  setGrade(it, g);
}

async function autoGrade() {
  const it = current();
  if (!it) return;
  if (!posts.ai.saved) { openAiDlg(); return; }
  const btn = $('#gradeAuto');
  const v = video();
  btn.disabled = true;
  btn.textContent = '✨ Looking …';
  try {
    const { suggestion: s } = await api('/api/grade-suggest', { name: it.name, t: v ? v.currentTime : 0 });
    if (current() === it) {
      const px = s.uw > 0 ? stagePixels() : null;
      setGrade(it, { ...s, gains: px ? Grade.grayWorldGains(px) : undefined });
      $('#gradeNote').textContent = s.note ? `✨ ${s.note}` : '';
    }
  } catch (err) {
    toast(err.message);
  }
  btn.disabled = false;
  btn.textContent = '✨ Auto';
}

let gradeSaveTimer = null;
function setGrade(it, grade) {
  if (!it) return;
  const g = Grade.cleanGrade(grade);
  if (g) it.grade = g; else delete it.grade;
  if (current() === it) {
    const node = $('#stage img, #stage video');
    if (node) node.style.filter = gradeCss(it.grade);
    refreshRow(state.sel);
    renderGradePanel();
    if (state.focus) renderFilmstrip();
  }
  if (typeof onRotated === 'function') onRotated(it); // Compose cards and preview follow
  clearTimeout(gradeSaveTimer);
  gradeSaveTimer = setTimeout(async () => {
    try { await api('/api/grade', { name: it.name, grade: it.grade || null }); } catch (err) { toast('Could not save the colours: ' + err.message); }
  }, 500);
}

// ---------- animals in the picture (A) ----------
// Asks the AI model set up in Compose (own key) what animals the photo, or the video
// frame shown right now, holds. The answer is kept with the file and shows up in
// Compose, where a name can go into the caption.

async function identifyCurrent() {
  const it = current();
  if (!it || state.identifying) return;
  if (!posts.ai.saved) { openAiDlg(); return; }
  const v = video();
  const t = it.type === 'video' && v ? Math.round(v.currentTime * 10) / 10 : 0;
  if (v) v.pause();
  // The place helps to narrow down the species: the file's own, or of a photo taken close in time.
  const g = geoFor({ item: it, type: it.type, time: it.date, source: it.name });
  const place = g ? posts.places.get(geoKey(g)) : null;
  const where = place ? [place.poi, place.name, place.country].filter(Boolean).join(', ') : g ? `${g.lat.toFixed(3)}, ${g.lon.toFixed(3)}` : '';
  const known = state.animals.get(it.name);
  const again = !!known && (it.type !== 'video' || known.t === t);
  state.identifying = it.name;
  renderAnimals();
  try {
    const res = await api('/api/identify', { name: it.name, t, place: where, again });
    state.animals.set(it.name, res.result);
    posts.species.clear(); // Compose reads the new answer
  } catch (err) {
    toast(err.message);
  }
  state.identifying = null;
  if (current() === it) renderAnimals();
}

function renderAnimals() {
  const bar = $('#animalsBar');
  const it = current();
  bar.replaceChildren();
  bar.hidden = true;
  if (!it) return;
  if (state.identifying === it.name) {
    bar.hidden = false;
    bar.append(el('span', { class: 'muted' }, 'Identifying the animals …'));
    return;
  }
  const known = state.animals.get(it.name);
  if (known === undefined) {
    // Answers from before (_species.json in the journey's folder).
    state.animals.set(it.name, null);
    api(`/api/identify?name=${encodeURIComponent(it.name)}&from=0&to=999999`).then(res => {
      state.animals.set(it.name, res.result || null);
      if (res.result && current() === it) renderAnimals();
    }).catch(() => state.animals.delete(it.name));
    return;
  }
  if (!known) return;
  bar.hidden = false;
  if (it.type === 'video') {
    bar.append(el('button', { class: 'aframe', title: 'Jump to the identified frame', onclick: () => seek(known.t) }, `at ${fmtTime(known.t)}`));
  }
  if (!known.animals.length) bar.append(el('span', { class: 'muted' }, 'No animal could be made out. Try another frame or a closer shot.'));
  for (const a of known.animals) {
    const same = a.de.toLowerCase() === a.en.toLowerCase();
    bar.append(el('span', { class: `achip ${a.confidence}`, title: [a.scientific, a.level !== 'species' ? `${a.level} only` : null, `${a.confidence} confidence`].filter(Boolean).join(' · ') },
      el('span', {}, ANIMAL_ICON[a.group] || '🔎'),
      el('b', {}, same ? a.de : `${a.de} · ${a.en}`),
      a.scientific ? el('i', {}, a.scientific) : null));
  }
  if (known.animals.length) bar.append(el('small', { class: 'muted' }, 'Suggestions. Add a name to the caption in Compose.'));
}

// ---------- where the next release starts ----------
// The oldest day after the newest day that has files in a release: releases follow
// the trip, so that's where picking goes on. The day is opened if it was collapsed,
// its first file selected and its heading scrolled to the top.
// { index, day, after }: the first file of that day, the day's key, and whether
// anything was released before it (only then is there a border to mark).
function newReleaseStart(released = releasedFiles()) {
  let last = null;
  for (const it of state.view) {
    const k = groupKey(it);
    if (k !== 'unknown' && released.has(it.name) && (!last || k > last)) last = k;
  }
  const index = state.view.findIndex(it => {
    const k = groupKey(it);
    return k !== 'unknown' && (!last || k > last) && !released.has(it.name);
  });
  return index < 0 ? null : { index, day: groupKey(state.view[index]), after: !!last };
}

// What the mark says: the release being made, or the one that would come next.
const newReleaseLabel = () => `${draftTitle()} starts here`;

function jumpToNewDays() {
  if (state.lovedOnly || !state.view.length) return;
  const start = newReleaseStart();
  if (!start) return;
  const target = start.index;
  const ckey = collapseKey(state.view[target]);
  if (state.collapsed.has(ckey)) state.collapsed.delete(ckey);
  const changed = target !== state.sel;
  state.sel = target;
  state.pendingStart = null;
  renderList();
  if (changed) renderViewer();
  saveView();
  const tile = $(`#list .tile[data-i="${target}"]`);
  const head = tile && tile.parentElement && tile.parentElement.previousElementSibling;
  // Show the "starts here" line above the day's heading too, if it is there.
  const mark = head && head.previousElementSibling;
  if (head) (mark && mark.classList.contains('relstart') ? mark : head).scrollIntoView({ block: 'start' });
}

// The last file (in the gallery's order) picked for the release being made: where
// picking usually goes on.
function jumpToLastPicked() {
  const released = releasedFiles();
  let target = -1;
  state.view.forEach((it, i) => { if (fileStatus(it, released).state === 'picked') target = i; });
  if (target < 0) { toast('Nothing is picked for this release yet'); return; }
  const ckey = collapseKey(state.view[target]);
  if (state.collapsed.has(ckey)) state.collapsed.delete(ckey);
  const changed = target !== state.sel;
  state.sel = target;
  state.pendingStart = null;
  renderList();
  if (changed) renderViewer();
  saveView();
  const tile = $(`#list .tile[data-i="${target}"]`);
  if (tile) tile.scrollIntoView({ block: 'center' });
}

// T: the frame shown right now becomes the video's thumbnail in the gallery and the
// strip (Shift+T: back to the usual one).
async function setThumbFrame(reset) {
  const it = current(), v = video();
  if (!it || it.type !== 'video' || !v) { toast('Thumbnails can be chosen for videos'); return; }
  const before = it.thumbT;
  const apply = t => {
    if (t == null) delete it.thumbT; else it.thumbT = t;
    refreshRow(state.sel);
    if (state.focus) renderFilmstrip();
  };
  apply(reset ? null : Math.round(v.currentTime * 10) / 10);
  toast(reset ? 'Thumbnail back to the usual frame' : `Thumbnail: the frame at ${fmtTime(it.thumbT)}`);
  try {
    await api('/api/thumb-time', { name: it.name, t: reset ? null : it.thumbT });
  } catch (err) {
    apply(before == null ? null : before);
    toast('Could not save: ' + err.message);
  }
}

// ---------- favorites (♥, F): kept apart from picking for a release (P) ----------

async function toggleLoved() {
  const it = current();
  if (!it) return;
  const value = !it.loved;
  const set = v => {
    it.loved = v;
    if (state.lovedOnly && !v) { buildView(); renderList(); renderViewer(); return; }
    refreshRow(state.sel);
    renderStageTools();
    if (state.focus) renderFilmstrip();
    $('#lovedCount').textContent = state.items.some(x => x.loved) ? `(${state.items.filter(x => x.loved).length})` : '';
  };
  set(value);
  toast(value ? '♥ Added to your favorites' : 'Removed from your favorites');
  try {
    await api('/api/love', { name: it.name, value });
  } catch (err) {
    set(!value);
    toast('Could not save: ' + err.message);
  }
}

function setLovedOnly(on) {
  if (state.lovedOnly === on) return;
  const before = current();
  state.lovedOnly = on;
  $('#showAll').classList.toggle('on', !on);
  $('#showLoved').classList.toggle('on', on);
  buildView();
  if (before && state.view.includes(before)) state.sel = state.view.indexOf(before);
  ensureVisibleSelection();
  renderList();
  $('#list').scrollTop = 0;
  scrollSelIntoView();
  if (current() !== before) renderViewer(); else renderStageTools();
}

// ---------- over the picture: turn, pick, full screen ----------

function renderStageTools() {
  const it = current();
  $('#stageTools').hidden = !it;
  $('#navPrev').hidden = $('#navNext').hidden = !it;
  if (!it) return;
  $('#navPrev').disabled = step(state.sel, -1) < 0;
  $('#navNext').disabled = step(state.sel, 1) < 0;
  const love = $('#loveBtn');
  love.textContent = it.loved ? '♥' : '♡';
  love.classList.toggle('on', !!it.loved);
  love.title = it.loved ? 'Favorite · F to remove it from your favorites' : 'Make it a favorite (F)';
  const pick = $('#pickBtn');
  pick.hidden = it.type !== 'image';
  pick.textContent = it.favorite ? '★ Picked' : '☆ Pick';
  pick.classList.toggle('on', !!it.favorite);
  $('#focusBtn').title = state.focus ? 'Leave full screen (Esc / Enter)' : 'Full screen (Enter) · Esc to leave';
  $('#focusBtn').textContent = state.focus ? '✕' : '⛶';
  $('#focusName').textContent = `${it.name} · ${state.sel + 1} of ${state.view.length}`;
}

async function rotateCurrent(dir) {
  const it = current();
  if (!it || state.cropping) return;
  // The crop turns with the picture.
  if (it.crop) {
    const c = it.crop;
    it.crop = dir > 0 ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w };
    api('/api/crop', { name: it.name, crop: it.crop }).catch(err => toast('Could not save the crop: ' + err.message));
  }
  const before = it.rotate || 0;
  const v = video();
  const at = v ? v.currentTime : 0, playing = v && !v.paused;
  const setTo = r => {
    it.rotate = r;
    refreshRow(state.sel);
    if (current() === it) {
      renderViewer();
      // Keep the video where it was.
      const nv = video();
      if (nv && at) {
        nv.addEventListener('loadedmetadata', () => { nv.currentTime = at; if (playing) nv.play().catch(() => {}); }, { once: true });
      }
    }
    if (typeof onRotated === 'function') onRotated(it);
  };
  setTo(((before + dir * 90) % 360 + 360) % 360);
  try {
    const res = await api('/api/rotate', { name: it.name, value: it.rotate });
    if (res.rotate !== it.rotate) setTo(res.rotate);
  } catch (err) {
    setTo(before);
    toast('Could not save the turn: ' + err.message);
  }
}

// Full screen: the whole right side (picture, timeline, scenes) fills the screen, with
// a strip of the neighbouring files below; all keys keep working.
function toggleFocus(on = !state.focus) {
  if (on && (!inPickView() || !current())) return;
  if (state.focus === on) return;
  state.focus = on;
  document.body.classList.toggle('focus', on);
  if (on) {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => { /* the overlay works without it */ });
    }
  } else if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
  renderStageTools();
  if (on) renderFilmstrip(); else { $('#filmstrip').replaceChildren(); delete $('#filmstrip').dataset.sig; }
  if (!on) scrollSelIntoView();
  // Opened from Compose or Releases: back there, as it was.
  if (!on && state.mode === 'browse') {
    const back = state.returnMode || 'releases';
    state.returnMode = null;
    state.browseOnly = null;
    buildView();
    state.keepPlace = true;
    setMode(back);
    state.keepPlace = false;
  }
}

// The same full screen as in Pick, for a file shown in Compose or Releases: the file
// (a video at the given second), the day strip, all keys. Leaving it goes back.
// only: names of the files to show (the posts of Compose, or of a release part).
function openInFocus(it, start = 0, only = null) {
  if (!it) return;
  state.returnMode = state.mode;
  state.browseOnly = only && only.size ? new Set([...only, it.name]) : null;
  buildView();
  if (state.collapsed.has(collapseKey(it))) state.collapsed.delete(collapseKey(it));
  setMode('browse');
  const i = state.view.indexOf(it);
  if (i < 0) return;
  if (i !== state.sel) select(i); else renderViewer();
  const v = video();
  if (v && start) {
    const go = () => { v.currentTime = start; };
    if (v.readyState >= 1) go(); else v.addEventListener('loadedmetadata', go, { once: true });
  }
  toggleFocus(true);
}

// The whole gallery as a strip (visible days only), grouped by day: a coloured bar with
// the day's name runs over its pictures. Scroll it with the mouse wheel or by dragging
// the scroll bar; a click selects. It is rebuilt only when the files or their marks
// changed; moving the selection just moves the ring.
const DAY_COLORS = ['#19a8a4', '#d98a2b', '#5b8def', '#2f9f7a', '#c75c8a', '#8a6fd1'];

function renderFilmstrip() {
  const strip = $('#filmstrip');
  if (!state.focus) return;
  const released = releasedFiles();
  const visible = [];
  const start = state.lovedOnly ? null : newReleaseStart(released);
  let sig = start && start.after ? `start:${start.day}:${newReleaseLabel()}|` : '';
  for (let i = 0; i < state.view.length; i++) {
    const it = state.view[i];
    if (isHidden(it)) continue;
    const st = fileStatus(it, released).state;
    visible.push({ i, it, st });
    sig += `${it.name}:${st}${it.loved ? 'h' : ''}${it.rotate || 0}${it.thumbT != null ? '@' + it.thumbT : ''}${Grade.gradeId(it.grade)}${cropKey(it.crop)}|`;
  }
  let opened = false;
  if (strip.dataset.sig !== sig || !strip.firstChild) {
    const keepScroll = strip.dataset.sig ? strip.scrollLeft : null;
    strip.dataset.sig = sig;
    strip.replaceChildren();
    let day = null, row = null, n = -1;
    for (const { i, it, st } of visible) {
      const key = groupKey(it);
      if (key !== day) {
        day = key;
        n++;
        const count = visible.filter(x => groupKey(x.it) === key).length;
        const label = key === 'unknown' ? 'Unknown date'
          : parseStamp(key).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
        row = el('div', { class: 'frow' });
        if (start && start.after && key === start.day) {
          strip.append(el('div', { class: 'fstart', title: 'Everything to the left is in a release already' }, el('b', {}, draftTitle()), el('span', {}, 'starts here'), el('i', {}, '▶')));
        }
        strip.append(el('div', { class: 'fday', style: `--day:${DAY_COLORS[n % DAY_COLORS.length]}`, title: groupLabel(key) },
          el('div', { class: 'fdaybar' }, el('span', {}, el('b', {}, label), ` · ${count} file${count === 1 ? '' : 's'}`)),
          row));
      }
      row.append(el('div', { class: `fthumb ${st}`, 'data-i': i, title: it.name, onclick: () => select(i) },
        el('img', { src: thumbSrc(it), loading: 'lazy', decoding: 'async', alt: '', class: rotClass(it.rotate).trim() || null, style: mediaStyle(it) }),
        it.type === 'video' ? el('span', { class: 'fvid' }, '▶') : null,
        st === 'picked' ? el('span', { class: 'ftick' }, '✓') : null,
        it.loved ? el('span', { class: 'fheart' }, '♥') : null,
        it.grade ? el('span', { class: 'fgrade', title: 'Colours changed' }, '🎨') : null));
    }
    if (keepScroll != null) strip.scrollLeft = keepScroll; else opened = true;
  }
  const old = strip.querySelector('.fthumb.sel');
  const sel = strip.querySelector(`.fthumb[data-i="${state.sel}"]`);
  if (old && old !== sel) old.classList.remove('sel');
  if (sel) {
    sel.classList.add('sel');
    // Keep the selected picture in view: centred when the strip opens, else only as far as needed.
    const s = strip.getBoundingClientRect(), r = sel.getBoundingClientRect();
    if (opened) strip.scrollLeft += r.left - s.left - (s.width - r.width) / 2;
    else if (r.left < s.left + 70) strip.scrollLeft += r.left - s.left - 70;
    else if (r.right > s.right - 70) strip.scrollLeft += r.right - s.right + 70;
  }
}


// Chromium's own video controls (play button, time bar) keep the keyboard focus after a
// click and swallow keys, so I / O / F / Space did nothing. Hand the focus back to the
// page after every click and every play, pause or seek.
function releaseControlsFocus(v) {
  const release = () => setTimeout(() => { if (document.activeElement === v) v.blur(); }, 0);
  for (const type of ['pointerup', 'play', 'pause', 'seeked']) v.addEventListener(type, release);
}

function tick() {
  updateTimeline();
  const v = video();
  if (v && !v.paused) requestAnimationFrame(tick);
}

function updateTimeline() {
  const v = video();
  const it = current();
  if (!v || !it) return;
  const dur = v.duration || it.duration || 0;
  const pct = t => (dur ? Math.min(100, (t / dur) * 100) : 0) + '%';
  $('#tlHead').style.left = pct(v.currentTime);
  const p = $('#tlPending');
  if (state.pendingStart != null && v.currentTime > state.pendingStart) {
    p.style.display = 'flex';
    p.style.left = pct(state.pendingStart);
    p.style.width = `calc(${pct(v.currentTime)} - ${pct(state.pendingStart)})`;
    // The scene being marked shows its length so far (at the speed new scenes get).
    p.firstChild.textContent = fmtLen((v.currentTime - state.pendingStart) / state.speed);
  } else {
    p.style.display = 'none';
  }
  $('#timeInfo').textContent = `${fmtTime(v.currentTime)} / ${fmtTime(dur)}`;
  syncSpeedTarget();
}

// A scene's length for the timeline: "4.5 s", or "1:32" from a minute on.
const fmtLen = s => (s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);

const sceneBarLabel = sc => ((sc.speed || 1) < 1 ? `${speedLabel(sc.speed)} · ` : '') + fmtLen((sc.end - sc.start) / (sc.speed || 1));

// The two ends of a scene on the timeline can be dragged to make it longer or shorter.
// The video follows the dragged end, so you see the exact frame; it is saved on release.
function sceneHandle(i, side) {
  const h = el('div', { class: `shandle ${side}`, title: `Drag to move the scene's ${side === 'l' ? 'start' : 'end'}` });
  h.addEventListener('pointerdown', e => startSceneResize(e, i, side));
  return h;
}

function startSceneResize(e, i, side) {
  e.stopPropagation(); // not a jump on the timeline
  e.preventDefault();
  const it = current(), v = video();
  if (!it || !v || !v.duration) return;
  const why = pickBlocked(it);
  if (why) { toast(why); return; }
  const h = e.currentTarget, seg = h.parentElement;
  const r = $('#timeline').getBoundingClientRect(), dur = v.duration;
  const sc0 = it.scenes[i];
  // Not past the neighbouring scene or the video's ends, and at least 0.3 s long.
  const lo = side === 'l' ? (i > 0 ? it.scenes[i - 1].end : 0) : sc0.start + 0.3;
  const hi = side === 'l' ? sc0.end - 0.3 : (i < it.scenes.length - 1 ? it.scenes[i + 1].start : dur);
  let cur = { ...sc0 };
  v.pause();
  h.setPointerCapture(e.pointerId);
  seg.classList.add('resizing');
  const move = ev => {
    const t = Math.round(Math.max(lo, Math.min(hi, ((ev.clientX - r.left) / r.width) * dur)) * 100) / 100;
    cur = side === 'l' ? { ...sc0, start: t } : { ...sc0, end: t };
    seg.style.left = `${(cur.start / dur) * 100}%`;
    seg.style.width = `${((cur.end - cur.start) / dur) * 100}%`;
    seg.querySelector('span').textContent = sceneBarLabel(cur);
    seek(t);
  };
  const up = async () => {
    h.removeEventListener('pointermove', move);
    h.removeEventListener('pointerup', up);
    h.removeEventListener('pointercancel', up);
    seg.classList.remove('resizing');
    if (cur.start === sc0.start && cur.end === sc0.end) return;
    // The post made from this scene keeps its caption, place in the order and texts.
    movePostKey(sceneKey(it.name, sc0), sceneKey(it.name, cur));
    await saveScenes(it, it.scenes.map((s, j) => (j === i ? cur : s)));
  };
  h.addEventListener('pointermove', move);
  h.addEventListener('pointerup', up);
  h.addEventListener('pointercancel', up);
}

function renderScenes() {
  const it = current();
  if (!it || it.type !== 'video') return;
  const v = video();
  const dur = (v && v.duration) || it.duration || 0;
  const segs = $('#tlScenes');
  segs.replaceChildren();
  const list = $('#sceneList');
  list.replaceChildren();
  it.scenes.forEach((sc, i) => {
    const sp = sc.speed || 1;
    if (dur) {
      segs.append(el('div', {
        class: 'seg' + (sp < 1 ? ' slow' : ''), title: `Scene ${i + 1}` + (sp < 1 ? ` · ${speedLabel(sp)} slow motion` : ''),
        style: `left:${(sc.start / dur) * 100}%;width:${((sc.end - sc.start) / dur) * 100}%`,
      }, sceneHandle(i, 'l'), el('span', {}, sceneBarLabel(sc)), sceneHandle(i, 'r')));
    }
    const len = (sc.end - sc.start) / sp; // length in the release
    const speedSel = el('select', { class: 'scspeed', title: 'Speed of this scene in the release (slow motion)', onclick: e => e.stopPropagation() },
      ...SPEEDS.map(x => el('option', { value: x, selected: x === sp ? '' : null }, speedLabel(x))));
    speedSel.addEventListener('change', e => { e.stopPropagation(); setSceneSpeed(i, Number(speedSel.value)); });
    list.append(el('li', { title: 'Click: go to this scene and play it. The speed buttons then change this scene.', onclick: () => seek(sc.start, true) },
      el('span', { class: 'dot' + (sp < 1 ? ' slow' : '') }),
      isWholeScene(sc, dur) ? `Whole video   ${fmtTime(sc.start)} → ${fmtTime(sc.end)}` : `Scene ${i + 1}   ${fmtTime(sc.start)} → ${fmtTime(sc.end)}`,
      el('span', { class: 'len' }, sp < 1 ? `${(sc.end - sc.start).toFixed(1)} s → ${len.toFixed(1)} s` : `${len.toFixed(1)} s`),
      speedSel,
      len > STATUS_LIMIT_S ? el('span', { class: 'warn', title: `WhatsApp Status only shows the first ${STATUS_LIMIT_S} s (chats are fine)` }, `⚠ over ${STATUS_LIMIT_S} s`) : null,
      el('button', {
        class: 'del', title: 'Delete scene',
        onclick: e => { e.stopPropagation(); deleteScene(i); },
      }, '✕')));
  });
  $('#pendingInfo').textContent = state.pendingStart != null
    ? `Start set at ${fmtTime(state.pendingStart)}, press O at the end`
    : '';
  speedTargetKey = null; // segments and rows were rebuilt: mark the active scene again
  updateTimeline();
}

function seek(t, play = false) {
  const v = video();
  if (!v) return;
  v.currentTime = Math.max(0, Math.min(t, v.duration || t));
  if (play) v.play().catch(() => {});
  updateTimeline();
}

// ---------- actions ----------

async function toggleFavorite() {
  const it = current();
  if (!it) return;
  if (it.type === 'video') { await toggleWholeVideo(it); return; }
  const why = pickBlocked(it);
  if (why) { toast(why); return; }
  it.favorite = !it.favorite;
  renderViewer();
  picksChanged();
  try {
    await api('/api/favorite', { name: it.name, value: it.favorite });
  } catch (err) {
    it.favorite = !it.favorite;
    renderViewer();
    picksChanged();
    toast('Could not save: ' + err.message);
  }
}

// A video picked as a whole is one scene from start to end, so it goes through the
// same path as any scene (release, splitting into 90 s pieces, locking).
const isWholeScene = (sc, dur) => sc.start <= 0.05 && dur && sc.end >= dur - 0.1;

async function toggleWholeVideo(it) {
  const why = pickBlocked(it);
  if (why) { toast(why); return; }
  const v = video();
  const dur = (v && v.duration) || it.duration || 0;
  if (!dur) { toast('The video length is not known yet, try again in a moment'); return; }
  if (it.scenes.length === 1 && isWholeScene(it.scenes[0], dur)) {
    await saveScenes(it, []);
    toast('Whole video unpicked');
    return;
  }
  if (it.scenes.length) {
    toast(`This video has ${it.scenes.length} scene${it.scenes.length === 1 ? '' : 's'}; delete ${it.scenes.length === 1 ? 'it' : 'them'} (✕) to pick the whole video`);
    return;
  }
  state.pendingStart = null;
  await saveScenes(it, [withSpeed({ start: 0, end: Math.round(dur * 1000) / 1000 })]);
  const out = dur / state.speed;
  toast((out > STATUS_LIMIT_S
    ? `Whole video picked (${fmtTime(out)}); it will be split into pieces of ${STATUS_LIMIT_S} s`
    : 'Whole video picked') + (state.speed < 1 ? ` · ${speedLabel(state.speed)} slow motion` : ''));
}

function markIn() {
  const v = video();
  if (!v) { toast('Scenes can only be marked in videos'); return; }
  const why = pickBlocked(current());
  if (why) { toast(why); return; }
  state.pendingStart = v.currentTime;
  renderScenes();
}

async function markOut() {
  const v = video();
  const it = current();
  if (!v || !it) { toast('Scenes can only be marked in videos'); return; }
  if (state.pendingStart == null) { toast('Press I first to set where the scene starts'); return; }
  const start = state.pendingStart, end = v.currentTime;
  if (end - start < 0.3) { toast('The end must be after the start'); return; }
  state.pendingStart = null;
  await saveScenes(it, [...it.scenes, withSpeed({ start, end })]);
  if (state.speed < 1) toast(`Scene saved in ${speedLabel(state.speed)} slow motion`);
}

// The current speed goes with a new scene (1 = normal, not stored).
const withSpeed = sc => (state.speed < 1 ? { ...sc, speed: state.speed } : sc);

async function setSceneSpeed(i, speed) {
  const it = current();
  const why = pickBlocked(it);
  if (why) { toast(why); renderScenes(); return; }
  const scenes = it.scenes.map((sc, j) => {
    if (j !== i) return sc;
    const { speed: _, ...rest } = sc;
    return speed < 1 ? { ...rest, speed } : rest;
  });
  await saveScenes(it, scenes);
  toast(`${isWholeScene(scenes[i], (video() && video().duration) || it.duration || 0) ? 'Whole video' : `Scene ${i + 1}`}: ${speed < 1 ? `${speedLabel(speed)} slow motion` : 'normal speed'}`);
}

async function deleteScene(i) {
  const it = current();
  const why = pickBlocked(it);
  if (why) { toast(why); return; }
  await saveScenes(it, it.scenes.filter((_, j) => j !== i));
}

async function saveScenes(it, scenes) {
  const before = it.scenes;
  it.scenes = scenes.slice().sort((a, b) => a.start - b.start);
  renderScenes();
  picksChanged();
  try {
    const res = await api('/api/scenes', { name: it.name, scenes: it.scenes });
    it.scenes = res.scenes;
  } catch (err) {
    it.scenes = before;
    toast('Could not save: ' + err.message);
  }
  if (current() === it) renderScenes();
  picksChanged();
}

// ---------- folder (of the open journey, see journeys.js) ----------

async function loadItems() {
  await flushView(); // save the old folder's view before switching
  $('#list').replaceChildren(el('div', { class: 'list-empty' }, 'Reading folder…'));
  const data = await api('/api/items');
  state.folder = data.folder;
  state.items = data.items;
  state.collapsed = new Set(data.view.collapsed);
  // Continue where you left off: the last selected file, if it is still there.
  state.sel = -1;
  buildView();
  const last = state.view.findIndex(it => it.name === data.view.lastFile);
  state.sel = last >= 0 ? last : -1;
  ensureVisibleSelection();
  renderList();
  renderViewer();
  renderSummary();
  await loadPosts();
  // Now with the releases read: which files are picked, released or sent.
  renderList();
  folderSeen = null;
}

// The server watches the folder (server.js, watchFolder). Every few seconds the page
// asks whether something changed; if so, the files are read again in place: the
// selection, collapsed days and scroll position stay, a playing video goes on.
let folderSeen = null;

// The same question also tells whether the app itself changed (its page files, or the
// server was restarted with a new version): then the page reloads, at a moment that
// doesn't interrupt typing or a running export.
let appSeen = null, updateWaiting = false;

function appChanged() {
  updateWaiting = true;
  const typing = document.activeElement && ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName) && document.activeElement.type !== 'range';
  const busy = typing || document.querySelector('dialog[open]');
  $('#updateNote').hidden = !busy;
  if (!busy) reloadForUpdate();
}

async function reloadForUpdate() {
  $('#updateNote').hidden = true;
  toast('New version: reloading …');
  try { await flushPosts(); await flushView(); } catch { /* reload anyway */ }
  location.reload();
}

async function checkFolder() {
  try {
    const r = await api('/api/folder-version');
    const app = `${r.boot}:${r.app}`;
    if (appSeen !== null && app !== appSeen || updateWaiting) { appSeen = app; appChanged(); return; }
    appSeen = app;
    if (!state.folder || document.hidden) return;
    if (r.folder !== state.folder) return;
    if (folderSeen !== null && r.version !== folderSeen) await refreshItems();
    folderSeen = r.version;
  } catch { /* server stopped or busy: try again next time */ }
}

async function refreshItems() {
  const data = await api('/api/items');
  if (data.folder !== state.folder) return;
  const before = current();
  const added = data.items.length - state.items.length;
  state.items = data.items;
  buildView();
  state.sel = before ? state.view.findIndex(it => it.name === before.name) : -1;
  ensureVisibleSelection();
  const scroll = $('#list').scrollTop;
  refreshPosts();
  renderList();
  $('#list').scrollTop = scroll;
  renderSummary();
  // The file on the right stays as it is unless it's gone (a playing video keeps playing).
  if (!before || !current() || current().name !== before.name) renderViewer(); else renderInfo();
  if (added > 0) toast(`${added} new file${added === 1 ? '' : 's'} in the folder`);
  else if (added < 0) toast(`${-added} file${added === -1 ? '' : 's'} removed from the folder`);
}

// ---------- viewer (double-click a file) ----------

// Shows a picture, video or canvas fitted to the window; click it (or the button) for
// real size (1 image pixel = 1 screen pixel), scrollable when bigger than the window.
// what: { title, src, type: 'image' | 'video' | 'canvas', canvas, start, fallbackSrc }
function openViewer(what) {
  const dlg = $('#viewer-dlg'), stage = $('#viewerStage');
  stage.replaceChildren();
  stage.classList.add('fit');
  $('#viewerTitle').textContent = what.title || '';
  $('#viewerInfo').textContent = '';
  const showSize = (w, h, extra = '') => { $('#viewerInfo').textContent = `${w} × ${h} px${extra}`; };
  let node;
  if (what.type === 'canvas') {
    node = what.canvas;
    showSize(node.width, node.height);
  } else if (what.type === 'video') {
    node = turnableVideo(what.src, what.rotate || 0, true);
    node.style.filter = gradeCss(what.grade);
    node.autoplay = true;
    node.playsInline = true;
    node.addEventListener('loadedmetadata', () => {
      if (what.start) node.currentTime = what.start;
      showSize(node.videoWidth, node.videoHeight, ` · ${fmtTime(node.duration)}`);
    });
    // Formats the browser can't play: the small preview copy instead.
    node.addEventListener('error', () => {
      if (what.fallbackSrc && node.src.indexOf(what.fallbackSrc) < 0) {
        $('#viewerInfo').textContent = 'Creating a preview …';
        node.src = what.fallbackSrc;
      }
    });
    // Double-clicking a video would otherwise switch the browser to full screen.
    node.addEventListener('dblclick', e => e.preventDefault());
  } else {
    node = el('img', { src: what.src, alt: what.title || '', class: rotClass(what.rotate || 0).trim() || null, style: gradeStyle(what.grade) });
    node.addEventListener('load', () => showSize(node.naturalWidth, node.naturalHeight));
  }
  // Turned files are shown fitted only (real size would need the layout turned too).
  $('#viewerFit').hidden = !!what.rotate;
  // Clicking pictures switches real size / fit; videos keep their clicks for play/pause.
  if (what.type !== 'video') node.addEventListener('click', e => { e.stopPropagation(); toggleViewerFit(); });
  stage.append(node);
  $('#viewerFit').textContent = 'Real size';
  dlg.showModal();
  if (viewerZoom) viewerZoom.reset();
  // Really full screen, like Pick's (without it the browser's bars stay).
  viewerOwnsFullscreen = false;
  if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => { viewerOwnsFullscreen = true; }).catch(() => {});
  }
}

let viewerOwnsFullscreen = false;

function toggleViewerFit() {
  if (viewerZoom) viewerZoom.reset();
  const fit = $('#viewerStage').classList.toggle('fit');
  $('#viewerFit').textContent = fit ? 'Real size' : 'Fit to window';
}

function closeViewer() {
  const v = $('#viewerStage video');
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  $('#viewerStage').replaceChildren();
  if ($('#viewer-dlg').open) $('#viewer-dlg').close();
  if (viewerZoom) viewerZoom.reset();
  if (viewerOwnsFullscreen && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  viewerOwnsFullscreen = false;
}

// A file of the open folder (Pick, Arrange and Releases).
function viewItem(it, start = 0) {
  if (!it) return;
  if (it.type === 'video') {
    openViewer({ title: it.name, type: 'video', src: mediaUrl(it), start, rotate: it.rotate || 0, grade: it.grade,
      fallbackSrc: '/preview?name=' + encodeURIComponent(it.name) });
  } else {
    openViewer({ title: it.name, type: 'image', src: mediaUrl(it), rotate: it.rotate || 0, grade: it.grade });
  }
}

// ---------- keyboard ----------

function onKey(e) {
  if (!inPickView() || document.querySelector('dialog[open]')) return;
  const tag = e.target.tagName;
  if (tag === 'SELECT' || (tag === 'INPUT' && e.target.type !== 'checkbox')) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  // While cropping: Enter keeps it, Esc leaves; other keys wait.
  if (state.cropping) {
    if (e.key === 'Enter' || e.key === 'k' || e.key === 'K') endCrop(true);
    else if (e.key === 'Escape') endCrop(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const v = video();
  const secs = e.shiftKey ? 10 : 2;
  // , and . by their place on the keyboard (Shift gives other characters on German keyboards).
  if (e.code === 'Period' || e.code === 'Comma') {
    if (v) seek(v.currentTime + (e.code === 'Period' ? secs : -secs));
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  let handled = true;
  switch (e.key) {
    case 'ArrowDown': select(step(state.sel, 1)); break;
    case 'ArrowUp': select(step(state.sel, -1)); break;
    // ← / → always go to the next / previous file (also on a video); , and . jump
    // inside a video (2 s, with Shift 10 s).
    case 'ArrowRight': select(step(state.sel, 1)); break;
    case 'ArrowLeft': select(step(state.sel, -1)); break;
    case '.': case '>': case ':': if (v) seek(v.currentTime + secs); break;
    case ',': case '<': case ';': if (v) seek(v.currentTime - secs); break;
    case 'c': case 'C': collapseCurrentGroup(); break;
    case ' ': togglePlay(); break;
    case 's': case 'S': if (v) stepSpeed(e.shiftKey ? -1 : 1); break;
    case 'm': case 'M': toggleMute(); break;
    case 'a': case 'A': identifyCurrent(); break;
    case 'g': case 'G': toggleGradePanel(); break;
    case 'k': case 'K': startCrop(); break;
    case '0': resetZoom(); break;
    case 't': case 'T': setThumbFrame(e.shiftKey); break;
    case 'b': case 'B': if (state.mode === 'pick') jumpToNewDays(); break;
    case 'l': case 'L': if (state.mode === 'pick') jumpToLastPicked(); break;
    case 'f': case 'F': toggleLoved(); break;
    case 'p': case 'P': toggleFavorite(); break; // pick for the release
    case 'i': case 'I': markIn(); break;
    case 'o': case 'O': markOut(); break;
    case 'r': case 'R': rotateCurrent(e.shiftKey ? -1 : 1); break;
    case 'Enter': toggleFocus(); break;
    case 'PageDown': select(step(state.sel, 1)); break;
    case 'PageUp': select(step(state.sel, -1)); break;
    case 'Escape':
      // First Esc drops a scene start that is waiting for its end, the next leaves full screen.
      if (state.pendingStart != null || !state.focus) { state.pendingStart = null; renderScenes(); } else toggleFocus(false);
      break;
    case 'Home': select(step(-1, 1)); break;
    case 'End': select(step(state.view.length, -1)); break;
    default: handled = false;
  }
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  }
}

// ---------- start ----------

function init() {
  setInterval(checkFolder, 3000);
  $('#wholeVideo').addEventListener('click', () => { const it = current(); if (it && it.type === 'video') toggleWholeVideo(it); });
  $('#markIn').addEventListener('click', markIn);
  $('#markOut').addEventListener('click', markOut);
  initTimelineDrag();
  $('#playBtn').addEventListener('click', togglePlay);
  $('#muteBtn').addEventListener('click', toggleMute);
  for (const b of document.querySelectorAll('#speedSeg button')) b.addEventListener('click', () => setSpeed(Number(b.dataset.speed)));
  $('#loveBtn').addEventListener('click', toggleLoved);
  // The mouse wheel scrolls the strip sideways.
  $('#filmstrip').addEventListener('wheel', e => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    e.currentTarget.scrollLeft += e.deltaY * 2;
  }, { passive: false });
  $('#identifyBtn').addEventListener('click', identifyCurrent);
  initGradePanel();
  initCrop();
  initZoom();
  // Double-click a tile: the same full screen as double-clicking the large picture.
  // (The second click of a double-click, counted on the list: the first click redraws
  // the tile, so the browser's own dblclick event never arrives.)
  $('#list').addEventListener('click', e => {
    const tile = e.detail === 2 ? e.target.closest('.tile') : null;
    if (!tile) return;
    const i = Number(tile.dataset.i);
    if (i !== state.sel) select(i);
    toggleFocus(true);
  });
  $('#jumpStartBtn').addEventListener('click', jumpToNewDays);
  $('#jumpLastBtn').addEventListener('click', jumpToLastPicked);
  $('#showAll').addEventListener('click', () => setLovedOnly(false));
  $('#showLoved').addEventListener('click', () => setLovedOnly(true));
  // Buttons hand the keyboard back to the page.
  for (const b of document.querySelectorAll('#sceneBar button, #listBar button')) b.addEventListener('pointerup', () => setTimeout(() => b.blur(), 0));
  window.addEventListener('keydown', onKey, true);
  $('#rotLeft').addEventListener('click', () => rotateCurrent(-1));
  $('#rotRight').addEventListener('click', () => rotateCurrent(1));
  $('#pickBtn').addEventListener('click', toggleFavorite);
  $('#focusBtn').addEventListener('click', () => toggleFocus());
  $('#navPrev').addEventListener('click', () => select(step(state.sel, -1)));
  $('#navNext').addEventListener('click', () => select(step(state.sel, 1)));
  // Buttons hand the keyboard back to the page, so I / O / Space work right after a click.
  for (const id of ['cropBtn', 'cropTurn', 'cropReset', 'cropCancel', 'cropApply', 'gradeBtn', 'gradeUw', 'gradeAuto', 'gradeCopy', 'gradePaste', 'gradeReset', 'jumpStartBtn', 'jumpLastBtn', 'rotLeft', 'rotRight', 'identifyBtn', 'loveBtn', 'pickBtn', 'focusBtn', 'navPrev', 'navNext']) {
    const b = $('#' + id);
    b.addEventListener('pointerup', () => setTimeout(() => b.blur(), 0));
  }
  // Esc in the browser's full screen ends it without a key event: leave the view too.
  document.addEventListener('fullscreenchange', () => {
    const fs = document.fullscreenElement;
    // A bare video in the browser's full screen hides timeline and scenes: use ours.
    if (fs && fs.tagName === 'VIDEO' && inPickView()) { document.exitFullscreen().catch(() => {}); toggleFocus(true); return; }
    if (!fs && state.focus) toggleFocus(false);
    // Esc ended the viewer's full screen: close the viewer too.
    if (!fs && viewerOwnsFullscreen && $('#viewer-dlg').open) closeViewer();
  });
  $('#viewerClose').addEventListener('click', closeViewer);
  $('#viewerFit').addEventListener('click', toggleViewerFit);
  // A click beside the picture closes; Esc closes the dialog by itself.
  $('#viewer-dlg').addEventListener('click', e => { if (e.target.id === 'viewerStage' || e.target.id === 'viewer-dlg') closeViewer(); });
  // Closed with Esc: tidy up the same way as the ✕ button (video, zoom, full screen).
  $('#viewer-dlg').addEventListener('close', closeViewer);
  $('#viewer-dlg').addEventListener('keydown', e => { if (e.key === '0' && viewerZoom) viewerZoom.reset(); });
  // Save the very last selection too when the tab is closed right after a key press.
  window.addEventListener('pagehide', () => {
    if (!viewTimer) return;
    clearTimeout(viewTimer);
    viewTimer = null;
    navigator.sendBeacon('/api/view', new Blob([JSON.stringify(viewBody())], { type: 'application/json' }));
  });

  // Once the journey is read: back to the step of last time (Pick and Compose need
  // the release being made, which is only known now).
  let savedStep = null;
  try { savedStep = localStorage.getItem('media-picker-mode'); } catch { /* storage unavailable */ }
  loadItems().then(() => {
    if (state.mode === 'releases' && (savedStep === 'pick' || savedStep === 'arrange') && hasDraft()) {
      state.keepPlace = true; // after a reload: stay on the file of last time, no jump to the release's start
      setMode(savedStep);
      state.keepPlace = false;
    }
  }).catch(err => toast(err.message));
  api('/api/state').then(s => {
    state.mapPageUrl = s.mapPageUrl || null;
    if (!s.ffmpeg) toast('ffmpeg not found: scenes cannot be exported');
  }).catch(() => {});
}

init();
