'use strict';
// Journeys: one per trip, a name and the one folder with all its photos and videos
// (stars, scenes, posts and releases are kept in that folder). The tool starts in the
// last journey; "← Journeys" shows the list, where a new one is started. The list is
// kept by the server in settings.json. Uses the helpers and `state` from app.js and
// setMode, dayRange-style dates and `posts` from posts.js.

const journeys = {
  list: [],
  current: null,   // the open journey { id, name, folder, ... }
  editing: null,   // journey in the settings dialog; null = new journey
  summaryTimer: 0,
};

const journeyDay = d => parseStamp(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

async function loadJourneys() {
  const r = await api('/api/journeys');
  journeys.list = r.journeys;
  journeys.current = r.journeys.find(j => j.id === r.current) || null;
  $('#journeyName').textContent = journeys.current ? journeys.current.name : '';
  document.title = journeys.current ? `${journeys.current.name} · Statusbook` : 'Statusbook';
}

// ---------- the list ----------

function renderJourneys() {
  const box = $('#journeyList');
  box.replaceChildren();
  // Most recently opened first.
  const list = [...journeys.list].sort((a, b) => (b.opened || b.created || '').localeCompare(a.opened || a.created || ''));
  for (const j of list) box.append(journeyCard(j));
  box.append(el('div', { class: 'jcard new-card', onclick: () => openJourneyDlg(null) }, ic('plus'), 'New journey'));
  if (!list.length) {
    box.prepend(el('div', { class: 'jempty' }, 'Start your first journey: give it a name and choose the folder with its photos and videos.'));
  }
}

function journeyCard(j) {
  const s = j.summary;
  const facts = [];
  if (s) {
    facts.push(`${s.posts} post${s.posts === 1 ? '' : 's'}`);
    if (s.releases) facts.push(`${s.releases} release${s.releases === 1 ? '' : 's'}, ${s.sent} of ${s.files} files sent`);
  }
  const days = s && s.from ? (s.from === s.to ? journeyDay(s.from) : `${journeyDay(s.from)} – ${journeyDay(s.to)}`) : '';
  return el('div', {
    class: 'jcard' + (journeys.current && journeys.current.id === j.id ? ' current' : '') + (j.missing ? ' missing' : ''),
    title: j.missing ? '' : `Open ${j.name}`,
    onclick: () => { if (!j.missing) openJourney(j.id); },
  },
  el('h3', {}, j.name),
  el('button', { class: 'edit icon-btn', title: 'Journey settings: name, folder', onclick: ev => { ev.stopPropagation(); openJourneyDlg(j); } }, ic('settings')),
  days ? el('div', { class: 'days' }, days) : null,
  facts.length ? el('div', { class: 'facts' }, facts.join(' · ')) : null,
  el('div', { class: 'folder' }, j.folder),
  j.missing ? el('div', { class: 'warnline' }, 'Folder not found. Plugged in the drive? Or choose the folder again in ⚙.') : null);
}

async function showJourneys() {
  try { await loadJourneys(); } catch (err) { toast(err.message); }
  setMode('journeys');
  renderJourneys();
}

async function openJourney(id) {
  try {
    await flushPosts();
    await api('/api/journeys/open', { id });
    await loadJourneys();
    await loadItems();
    setMode(lastStep(), true);
  } catch (err) {
    toast(err.message);
    showJourneys();
  }
}

// ---------- new journey / settings ----------

function openJourneyDlg(j) {
  journeys.editing = j;
  $('#journeyDlgTitle').textContent = j ? 'Journey settings' : 'New journey';
  $('#journeySave').textContent = j ? 'Save' : 'Create journey';
  $('#journeyRemove').hidden = !j;
  $('#journeyNameInput').value = j ? j.name : '';
  $('#journeyFolderInput').value = j ? j.folder : '';
  showJourneyError('');
  $('#journeyDlg').showModal();
  $('#journeyNameInput').focus();
}

function showJourneyError(msg) {
  $('#journeyDlgError').textContent = msg;
  $('#journeyDlgError').hidden = !msg;
}

async function pickJourneyFolder() {
  const btn = $('#journeyFolderPick');
  btn.disabled = true;
  btn.textContent = '📁 Choosing…';
  try {
    toast('A folder window has opened. If you don\'t see it, check the taskbar.');
    const start = $('#journeyFolderInput').value.trim() || (journeys.current && journeys.current.folder) || null;
    const { folder } = await api('/api/journeys/pick', { start });
    if (folder) {
      $('#journeyFolderInput').value = folder;
      // A new journey is named after its folder until you type a name.
      if (!$('#journeyNameInput').value.trim()) $('#journeyNameInput').value = folder.split(/[\\/]/).filter(Boolean).pop();
      showJourneyError('');
    }
  } catch (err) {
    showJourneyError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '📁 Choose…';
  }
}

async function saveJourney() {
  const name = $('#journeyNameInput').value.trim();
  const folder = $('#journeyFolderInput').value.trim();
  if (!name) { showJourneyError('Give the journey a name.'); $('#journeyNameInput').focus(); return; }
  if (!folder) { showJourneyError('Choose the folder with the photos and videos of this journey.'); return; }
  const j = journeys.editing;
  try {
    if (j) {
      const before = j.folder;
      await api('/api/journeys/update', { id: j.id, name, folder });
      $('#journeyDlg').close();
      await loadJourneys();
      // The open journey got another folder: read it.
      if (journeys.current && journeys.current.id === j.id && journeys.current.folder !== before) await loadItems();
      if (state.mode === 'journeys') renderJourneys();
      toast('Journey saved');
    } else {
      await flushPosts();
      await api('/api/journeys/new', { name, folder });
      $('#journeyDlg').close();
      await loadJourneys();
      await loadItems();
      setMode('releases', true);
      toast(`Journey "${name}" started. Click ＋ New release, then pick photos and scenes for it.`);
    }
  } catch (err) {
    showJourneyError(err.message);
  }
}

async function removeJourney() {
  const j = journeys.editing;
  if (!j) return;
  if (!confirm(`Remove "${j.name}" from your journeys?\n\nOnly the entry in this list goes. The folder ${j.folder} and everything in it (photos, videos, stars, posts, releases) stay as they are; you can add it again as a new journey.`)) return;
  try {
    await api('/api/journeys/remove', { id: j.id });
    $('#journeyDlg').close();
    if (journeys.current && journeys.current.id === j.id) {
      await flushPosts();
      await loadItems();
    }
    showJourneys();
  } catch (err) {
    showJourneyError(err.message);
  }
}

// ---------- summary for the list ----------

// What the journeys list shows about the open journey: its days, posts and releases.
// Sent to the server a moment after things change (called by updatePostsSummary).
function journeySummaryChanged() {
  if (!journeys.current || !state.folder) return;
  clearTimeout(journeys.summaryTimer);
  journeys.summaryTimer = setTimeout(() => {
    const days = posts.entries.filter(e => e.kind === 'media' && e.time).map(e => e.time.slice(0, 10)).sort();
    const files = posts.releases.flatMap(r => r.parts.flatMap(p => p.items));
    const summary = {
      from: days[0] || null, to: days[days.length - 1] || null,
      posts: exportEntries().length, releases: posts.releases.length,
      files: files.length, sent: files.filter(i => i.sentAt).length,
    };
    api('/api/journeys/summary', { folder: state.folder, summary }).catch(() => {});
  }, 1500);
}

// ---------- start ----------

function initJourneys() {
  $('#journeysBtn').addEventListener('click', showJourneys);
  $('#newJourneyBtn').addEventListener('click', () => openJourneyDlg(null));
  $('#journeyEditBtn').addEventListener('click', () => { if (journeys.current) openJourneyDlg(journeys.current); });
  $('#journeyFolderPick').addEventListener('click', pickJourneyFolder);
  $('#journeySave').addEventListener('click', saveJourney);
  $('#journeyCancel').addEventListener('click', () => $('#journeyDlg').close());
  $('#journeyRemove').addEventListener('click', removeJourney);
  for (const id of ['#journeyNameInput', '#journeyFolderInput']) {
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') saveJourney(); });
    $(id).addEventListener('input', () => showJourneyError(''));
  }
  // The server opened the last journey already; without one (or with its folder
  // missing) the list comes first.
  loadJourneys().then(() => {
    if (!journeys.current) showJourneys();
  }).catch(err => toast(err.message));
}

initJourneys();
