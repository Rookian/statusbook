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
  mode: 'releases',  // 'releases', 'pick', 'arrange' or 'journeys' (see posts.js)
  pendingStart: null,
  collapsed: new Set(), // "day:2026-07-12", saved per folder
};

// ---------- helpers ----------

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
const isMarked = it => (it.type === 'image' ? it.favorite : it.scenes.length > 0);

const collapseKey = it => `day:${groupKey(it)}`;
const isHidden = it => state.collapsed.has(collapseKey(it));

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
  state.view = state.items.slice().sort((a, b) => {
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
  if (!state.view.length) {
    list.append(el('div', { class: 'list-empty' }, 'No photos or videos in this folder.'));
    return;
  }
  const released = releasedFiles();
  const stats = {};
  for (const it of state.view) {
    const s = stats[groupKey(it)] || (stats[groupKey(it)] = { count: 0, picked: 0, released: 0, sent: 0, leftout: 0 });
    s.count++;
    s[fileStatus(it, released).state]++;
  }
  let lastKey = null, grid = null;
  state.view.forEach((it, i) => {
    const key = groupKey(it);
    if (key !== lastKey) {
      list.append(renderGroupHeader(key, stats[key], state.collapsed.has(collapseKey(it)), collapseKey(it)));
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
    title: closed ? 'Click to expand' : 'Click to collapse (C)',
    onclick: () => toggleGroup(ckey),
  },
  el('span', { class: 'chev' }, ic(closed ? 'right' : 'down')),
  groupLabel(key),
  el('span', { class: 'count' }, facts.join(' · ')));
}

const thumbSrc = it => `/thumb?name=${encodeURIComponent(it.name)}` + (it.type === 'video' ? '&t=1' : '');

function renderTile(it, i, released = releasedFiles()) {
  const st = fileStatus(it, released);
  const badge = st.state === 'sent' ? el('span', { class: 'tbadge sent' }, ic('check'), `Release ${st.no}`)
    : st.state === 'released' ? el('span', { class: 'tbadge released' }, `Release ${st.no}`)
      : st.state === 'picked' && it.type === 'video' ? el('span', { class: 'tbadge picked' }, `${it.scenes.length} scene${it.scenes.length === 1 ? '' : 's'}`)
        : st.state === 'leftout' ? el('span', { class: 'tbadge leftout', title: 'Picked, but removed in Arrange' }, 'Left out')
          : null;
  const time = it.date ? it.date.slice(11, 16) : '';
  // Soft tile: the photo with rounded corners, its time and name over the bottom edge.
  return el('div', {
    class: `tile ${st.state}` + (i === state.sel ? ' sel' : ''), 'data-i': i,
    title: `${it.name}${time ? ` · ${time}` : ''}` + (st.state === 'sent' || st.state === 'released' ? `\nIn Release ${st.no}; can't be picked again` : '') + '\nDouble-click: real size',
    onclick: () => select(i),
    ondblclick: () => viewItem(it),
  },
  el('div', { class: 'tthumb' },
    el('img', { src: thumbSrc(it), loading: 'lazy', decoding: 'async', alt: '' }),
    it.type === 'video' ? el('span', { class: 'tvid' }, ic('play'), it.duration ? fmtTime(it.duration).replace(/\.\d$/, '') : '') : null,
    badge,
    st.state === 'picked' ? el('span', { class: 'ttick' }, ic('check')) : null,
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
      el('button', { onclick: () => setMode('arrange') }, 'Arrange', ic('next')));
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
  refreshRow(prev);
  refreshRow(i);
  scrollSelIntoView();
  renderViewer();
  saveView();
}

function renderViewer() {
  const stage = $('#stage');
  const it = current();
  stage.replaceChildren();
  $('#videoPanel').hidden = true;
  if (!it) {
    const msg = !state.folder ? 'Choose a journey to start.'
      : state.view.length ? 'All days are collapsed. Click a day to open it.' : 'Nothing to show.';
    stage.append(el('div', { class: 'empty' }, msg));
    $('#infoBar').textContent = '';
    return;
  }
  if (it.type === 'image') {
    stage.append(el('img', { src: mediaUrl(it), alt: it.name, title: 'Double-click: real size', ondblclick: () => viewItem(it) }));
    if (it.favorite) stage.append(el('div', { class: 'bigstar' }, '★'));
  } else {
    const v = el('video', { src: mediaUrl(it), controls: '', preload: 'metadata' });
    // Double-click opens the viewer at the current position (instead of browser full screen).
    v.addEventListener('dblclick', e => { e.preventDefault(); v.pause(); viewItem(it, v.currentTime); });
    v.addEventListener('error', () => offerPreview(it), { once: true });
    v.addEventListener('timeupdate', updateTimeline);
    v.addEventListener('loadedmetadata', renderScenes);
    v.addEventListener('play', tick);
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
      const v = el('video', { src: '/preview?name=' + encodeURIComponent(it.name), controls: '', preload: 'metadata' });
      v.addEventListener('timeupdate', updateTimeline);
      v.addEventListener('loadedmetadata', () => { stage.replaceChildren(v); renderScenes(); });
      v.addEventListener('play', tick);
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
    p.style.display = 'block';
    p.style.left = pct(state.pendingStart);
    p.style.width = `calc(${pct(v.currentTime)} - ${pct(state.pendingStart)})`;
  } else {
    p.style.display = 'none';
  }
  $('#timeInfo').textContent = `${fmtTime(v.currentTime)} / ${fmtTime(dur)}`;
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
    if (dur) {
      segs.append(el('div', {
        class: 'seg', title: `Scene ${i + 1}`,
        style: `left:${(sc.start / dur) * 100}%;width:${((sc.end - sc.start) / dur) * 100}%`,
      }));
    }
    const len = sc.end - sc.start;
    list.append(el('li', { onclick: () => seek(sc.start, true) },
      el('span', { class: 'dot' }),
      `Scene ${i + 1}   ${fmtTime(sc.start)} → ${fmtTime(sc.end)}`,
      el('span', { class: 'len' }, `${len.toFixed(1)} s`),
      len > STATUS_LIMIT_S ? el('span', { class: 'warn', title: `WhatsApp Status only shows the first ${STATUS_LIMIT_S} s (chats are fine)` }, `⚠ over ${STATUS_LIMIT_S} s`) : null,
      el('button', {
        class: 'del', title: 'Delete scene',
        onclick: e => { e.stopPropagation(); deleteScene(i); },
      }, '✕')));
  });
  $('#pendingInfo').textContent = state.pendingStart != null
    ? `Start set at ${fmtTime(state.pendingStart)}, press O at the end`
    : '';
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
  if (it.type !== 'image') { toast('For videos, mark scenes with I and O'); return; }
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
  await saveScenes(it, [...it.scenes, { start, end }]);
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

async function checkFolder() {
  if (!state.folder || document.hidden) return;
  try {
    const r = await api('/api/folder-version');
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
    node = el('video', { src: what.src, controls: '', autoplay: '', playsinline: '' });
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
    node = el('img', { src: what.src, alt: what.title || '' });
    node.addEventListener('load', () => showSize(node.naturalWidth, node.naturalHeight));
  }
  // Clicking pictures switches real size / fit; videos keep their clicks for play/pause.
  if (what.type !== 'video') node.addEventListener('click', e => { e.stopPropagation(); toggleViewerFit(); });
  stage.append(node);
  $('#viewerFit').textContent = 'Real size';
  dlg.showModal();
}

function toggleViewerFit() {
  const fit = $('#viewerStage').classList.toggle('fit');
  $('#viewerFit').textContent = fit ? 'Real size' : 'Fit to window';
}

function closeViewer() {
  const v = $('#viewerStage video');
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  $('#viewerStage').replaceChildren();
  $('#viewer-dlg').close();
}

// A file of the open folder (Pick, Arrange and Releases).
function viewItem(it, start = 0) {
  if (!it) return;
  if (it.type === 'video') {
    openViewer({ title: it.name, type: 'video', src: mediaUrl(it), start,
      fallbackSrc: '/preview?name=' + encodeURIComponent(it.name) });
  } else {
    openViewer({ title: it.name, type: 'image', src: mediaUrl(it) });
  }
}

// ---------- keyboard ----------

function onKey(e) {
  if (state.mode !== 'pick' || document.querySelector('dialog[open]')) return;
  const tag = e.target.tagName;
  if (tag === 'SELECT' || (tag === 'INPUT' && e.target.type !== 'checkbox')) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const v = video();
  const secs = e.shiftKey ? 10 : 2;
  let handled = true;
  switch (e.key) {
    case 'ArrowDown': select(step(state.sel, 1)); break;
    case 'ArrowUp': select(step(state.sel, -1)); break;
    case 'ArrowRight': if (v) seek(v.currentTime + secs); else select(step(state.sel, 1)); break;
    case 'ArrowLeft': if (v) seek(v.currentTime - secs); else select(step(state.sel, -1)); break;
    case 'c': case 'C': collapseCurrentGroup(); break;
    case ' ': if (v) { if (v.paused) v.play().catch(() => {}); else v.pause(); } break;
    case 'f': case 'F': toggleFavorite(); break;
    case 'i': case 'I': markIn(); break;
    case 'o': case 'O': markOut(); break;
    case 'Escape': state.pendingStart = null; renderScenes(); break;
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
  $('#markIn').addEventListener('click', markIn);
  $('#markOut').addEventListener('click', markOut);
  $('#timeline').addEventListener('click', e => {
    const v = video();
    if (!v || !v.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * v.duration);
  });
  window.addEventListener('keydown', onKey, true);
  $('#viewerClose').addEventListener('click', closeViewer);
  $('#viewerFit').addEventListener('click', toggleViewerFit);
  // A click beside the picture closes; Esc closes the dialog by itself.
  $('#viewer-dlg').addEventListener('click', e => { if (e.target.id === 'viewerStage' || e.target.id === 'viewer-dlg') closeViewer(); });
  $('#viewer-dlg').addEventListener('close', () => {
    const v = $('#viewerStage video');
    if (v) v.pause();
  });
  // Save the very last selection too when the tab is closed right after a key press.
  window.addEventListener('pagehide', () => {
    if (!viewTimer) return;
    clearTimeout(viewTimer);
    viewTimer = null;
    navigator.sendBeacon('/api/view', new Blob([JSON.stringify(viewBody())], { type: 'application/json' }));
  });

  loadItems().catch(err => toast(err.message));
  api('/api/state').then(s => { if (!s.ffmpeg) toast('ffmpeg not found: scenes cannot be exported'); }).catch(() => {});
}

init();
