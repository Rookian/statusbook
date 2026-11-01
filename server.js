'use strict';
// Statusbook: a small local server for travel releases on WhatsApp Status. Each journey
// is one folder of photos and videos; in the browser you pick photos and cut video
// scenes for a release, arrange the posts, and the server makes the files (within
// WhatsApp's limits) and publishes them via WhatsApp Web (publisher.js). Uses Node's
// built-in modules, ffmpeg, and playwright-core for publishing.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const publisher = require('./publisher');

const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');
const PREVIEW_DIR = path.join(os.tmpdir(), 'media-picker-previews');
const EXPORT_DIR_NAME = 'WhatsApp';
const FAVORITES_FILE = '_favorites.json';
const CUTS_SUFFIX = '.cuts.json';
const POSTS_FILE = '_posts.json';
const FIRST_PORT = 4870;

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.3gp']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.3gp': 'video/3gpp',
};

let currentFolder = null;

// ---------- settings ----------

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}

function saveSettings(patch) {
  const s = { ...loadSettings(), ...patch };
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); } catch { /* not critical */ }
}

// Per-folder view state (collapsed days, last selected file), kept in the app's
// settings so the photo folders stay free of extra files. Windows paths ignore case.
function folderView(folder) {
  const v = (loadSettings().folders || {})[folder.toLowerCase()] || {};
  return {
    collapsed: Array.isArray(v.collapsed) ? v.collapsed.filter(k => typeof k === 'string') : [],
    lastFile: typeof v.lastFile === 'string' ? v.lastFile : null,
  };
}

function saveFolderView(folder, patch) {
  const folders = loadSettings().folders || {};
  folders[folder.toLowerCase()] = { ...folderView(folder), ...patch };
  saveSettings({ folders });
}

// ---------- ffmpeg / ffprobe ----------

const toolCache = {};

// Looks on PATH first, then in the places winget puts ffmpeg, so a fresh
// install works without restarting Windows.
function tool(name) {
  if (toolCache[name]) return toolCache[name];
  const exe = name + '.exe';
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const local = process.env.LOCALAPPDATA;
  if (local) dirs.push(path.join(local, 'Microsoft', 'WinGet', 'Links'));
  dirs.push(APP_DIR, path.join(APP_DIR, 'ffmpeg', 'bin'));
  for (const d of dirs) {
    const p = path.join(d, exe);
    if (fs.existsSync(p)) return (toolCache[name] = p);
  }
  if (local) {
    const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const pkg of fs.readdirSync(pkgs)) {
        if (!/ffmpeg/i.test(pkg)) continue;
        for (const sub of fs.readdirSync(path.join(pkgs, pkg))) {
          const p = path.join(pkgs, pkg, sub, 'bin', exe);
          if (fs.existsSync(p)) return (toolCache[name] = p);
        }
      }
    } catch { /* no winget packages */ }
  }
  return null;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(stdout);
    });
  });
}

// ---------- dates ----------

const pad = n => String(n).padStart(2, '0');

// All dates are kept as local "YYYY-MM-DDTHH:MM:SS" strings, so they sort as text
// and group by day without time zone surprises.
function stamp(y, mo, d, h = 0, mi = 0, s = 0) {
  [y, mo, d, h, mi, s] = [y, mo, d, h, mi, s].map(Number);
  if (!(y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h < 24 && mi < 60 && s < 60)) return null;
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`;
}

function stampFromDate(dt) {
  if (isNaN(dt)) return null;
  return stamp(dt.getFullYear(), dt.getMonth() + 1, dt.getDate(), dt.getHours(), dt.getMinutes(), dt.getSeconds());
}

// Capture date and GPS position from a JPEG's EXIF: { date, geo: { lat, lon } }.
async function readExif(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return parseJpegExif(buf.subarray(0, bytesRead));
  } catch {
    return {};
  } finally {
    await fh.close();
  }
}

function parseJpegExif(b) {
  if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return {};
  let off = 2;
  while (off + 4 <= b.length) {
    if (b[off] !== 0xFF) return {};
    const marker = b[off + 1];
    if (marker === 0xD9 || marker === 0xDA) return {};
    const len = b.readUInt16BE(off + 2);
    if (marker === 0xE1 && b.toString('latin1', off + 4, off + 10) === 'Exif\0\0') {
      return parseTiff(b.subarray(off + 10, Math.min(b.length, off + 2 + len)));
    }
    off += 2 + len;
  }
  return {};
}

function validGeo(lat, lon) {
  // 0,0 is what some cameras write when they had no GPS fix.
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) return null;
  return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
}

function parseTiff(t) {
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = o => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = o => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const readIfd = o => {
    const tags = {};
    if (o + 2 > t.length) return tags;
    const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      if (e + 12 > t.length) break;
      tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), valOff: e + 8 };
    }
    return tags;
  };
  const str = tag => {
    if (!tag || tag.type !== 2) return null;
    const ptr = tag.count > 4 ? u32(tag.valOff) : tag.valOff;
    if (ptr + tag.count > t.length) return null;
    return t.toString('latin1', ptr, ptr + tag.count).replace(/\0[\s\S]*$/, '');
  };
  const ifd0 = readIfd(u32(4));
  let s = null;
  if (ifd0[0x8769]) {
    const exif = readIfd(u32(ifd0[0x8769].valOff));
    s = str(exif[0x9003]) || str(exif[0x9004]); // DateTimeOriginal, DateTimeDigitized
  }
  s = s || str(ifd0[0x0132]); // DateTime
  const m = s && /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  const date = m ? stamp(...m.slice(1)) : null;

  // GPS IFD: 1/3 = N/S and E/W reference, 2/4 = degrees, minutes, seconds as rationals.
  let geo = null;
  if (ifd0[0x8825]) {
    try {
      const g = readIfd(u32(ifd0[0x8825].valOff));
      const dms = tag => {
        if (!tag || tag.type !== 5 || tag.count < 3) return NaN;
        const p = u32(tag.valOff);
        const r = k => u32(p + k * 8) / u32(p + k * 8 + 4);
        return r(0) + r(1) / 60 + r(2) / 3600;
      };
      const ref = tag => (tag ? t.toString('latin1', tag.valOff, tag.valOff + 1) : '');
      geo = validGeo((ref(g[1]) === 'S' ? -1 : 1) * dms(g[2]), (ref(g[3]) === 'W' ? -1 : 1) * dms(g[4]));
    } catch { /* broken GPS block */ }
  }
  return { date, geo };
}

// ISO 6709 as phones write it in videos, e.g. "-08.4729+115.5325/" or "+37.7749-122.4194+010.000/".
function parseIso6709(s) {
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(String(s || ''));
  return m ? validGeo(parseFloat(m[1]), parseFloat(m[2])) : null;
}

async function readVideoInfo(file) {
  const ffprobe = tool('ffprobe');
  if (!ffprobe) return {};
  try {
    const out = await run(ffprobe, ['-v', 'error', '-show_entries',
      'format=duration:format_tags:stream=codec_type,codec_name', '-of', 'json', file]);
    const probe = JSON.parse(out);
    const fmt = probe.format || {};
    const streams = probe.streams || [];
    const first = type => (streams.find(s => s.codec_type === type) || {}).codec_name || null;
    const codec = first('video');
    const audioCodec = first('audio');
    const tags = {};
    for (const [k, v] of Object.entries(fmt.tags || {})) tags[k.toLowerCase()] = v;
    let date = null;
    // iPhones store the local capture time with its offset; take it as is.
    const apple = tags['com.apple.quicktime.creationdate'];
    const am = apple && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(apple);
    if (am) date = stamp(...am.slice(1));
    if (!date && tags.creation_time) date = stampFromDate(new Date(tags.creation_time));
    const geo = parseIso6709(tags.location || tags['location-eng'] || tags['com.apple.quicktime.location.iso6709']);
    return { date, duration: parseFloat(fmt.duration) || null, codec, audioCodec, geo };
  } catch {
    return {};
  }
}

// Phone and WhatsApp file names often carry the date, e.g. IMG_20260712_100215.jpg,
// PXL_20260712_100215123.mp4 or IMG-20260712-WA0001.jpg.
function dateFromName(name) {
  let m = /(?:^|\D)(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})/.exec(name);
  if (m && stamp(...m.slice(1))) return stamp(...m.slice(1));
  m = /(20\d{2})-(\d{2})-(\d{2})[ _](\d{2})[.\-:](\d{2})[.\-:](\d{2})/.exec(name);
  if (m && stamp(...m.slice(1))) return stamp(...m.slice(1));
  m = /-(20\d{2})(\d{2})(\d{2})-WA\d+/i.exec(name);
  if (m) return stamp(...m.slice(1));
  return null;
}

const metaCache = new Map();

async function getMeta(file, type, st) {
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  if (metaCache.has(key)) return metaCache.get(key);
  let date = null, dateSource = null, duration = null, codec = null, audioCodec = null, geo = null;
  const ext = path.extname(file).toLowerCase();
  if (type === 'image' && (ext === '.jpg' || ext === '.jpeg')) {
    const exif = await readExif(file);
    date = exif.date || null;
    geo = exif.geo || null;
  } else if (type === 'video') {
    const info = await readVideoInfo(file);
    date = info.date || null;
    duration = info.duration || null;
    codec = info.codec || null;
    audioCodec = info.audioCodec || null;
    geo = info.geo || null;
  }
  if (date) dateSource = 'capture';
  if (!date && (date = dateFromName(path.basename(file)))) dateSource = 'name';
  if (!date && (date = stampFromDate(st.mtime))) dateSource = 'file';
  const meta = { date, dateSource, duration, codec, audioCodec, geo };
  metaCache.set(key, meta);
  return meta;
}

// ---------- marks (favorites and scenes) ----------

async function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

async function readFavorites(folder) {
  try {
    const j = JSON.parse(await fsp.readFile(path.join(folder, FAVORITES_FILE), 'utf8'));
    return new Set(Array.isArray(j.favorites) ? j.favorites : []);
  } catch {
    return new Set();
  }
}

async function setFavorite(folder, name, value) {
  const favs = await readFavorites(folder);
  if (value) favs.add(name); else favs.delete(name);
  const file = path.join(folder, FAVORITES_FILE);
  if (favs.size === 0) await fsp.rm(file, { force: true });
  else await writeJsonAtomic(file, { favorites: [...favs].sort() });
}

async function readScenes(videoFile) {
  try {
    const j = JSON.parse(await fsp.readFile(videoFile + CUTS_SUFFIX, 'utf8'));
    return (Array.isArray(j.scenes) ? j.scenes : [])
      .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
  } catch {
    return [];
  }
}

async function writeScenes(videoFile, scenes) {
  const clean = scenes
    .map(s => ({ start: Math.round(+s.start * 1000) / 1000, end: Math.round(+s.end * 1000) / 1000 }))
    .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  if (clean.length === 0) await fsp.rm(videoFile + CUTS_SUFFIX, { force: true });
  else await writeJsonAtomic(videoFile + CUTS_SUFFIX, { video: path.basename(videoFile), scenes: clean });
  return clean;
}

// ---------- scanning ----------

function mediaType(name) {
  const ext = path.extname(name).toLowerCase();
  return IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : null;
}

async function pool(tasks, limit) {
  let i = 0;
  const worker = async () => { while (i < tasks.length) await tasks[i++](); };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

async function scanFolder(folder) {
  const entries = await fsp.readdir(folder, { withFileTypes: true });
  const favs = await readFavorites(folder);
  const items = [];
  const tasks = entries
    .filter(e => e.isFile() && mediaType(e.name))
    .map(e => async () => {
      const full = path.join(folder, e.name);
      const type = mediaType(e.name);
      try {
        const st = await fsp.stat(full);
        const item = { name: e.name, type, size: st.size, ...(await getMeta(full, type, st)) };
        if (type === 'image') item.favorite = favs.has(e.name);
        else item.scenes = await readScenes(full);
        items.push(item);
      } catch { /* file vanished or unreadable */ }
    });
  await pool(tasks, 6);
  return items;
}

// ---------- previews for videos the browser cannot play ----------

const previewJobs = new Map();

async function makePreview(file) {
  const st = await fsp.stat(file);
  const hash = crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
  const out = path.join(PREVIEW_DIR, hash + '.mp4');
  if (fs.existsSync(out)) return out;
  if (previewJobs.has(out)) return previewJobs.get(out);
  const ffmpeg = tool('ffmpeg');
  if (!ffmpeg) throw new Error('ffmpeg is not installed');
  const job = (async () => {
    await fsp.mkdir(PREVIEW_DIR, { recursive: true });
    const tmp = out + '.part.mp4';
    await run(ffmpeg, ['-y', '-v', 'error', '-i', file, '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', "scale=-2:'min(720,ih)'", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', tmp]);
    await fsp.rename(tmp, out);
    return out;
  })();
  previewJobs.set(out, job);
  try { return await job; } finally { previewJobs.delete(out); }
}

// One frame of a video as a small JPEG, for the posts gallery. Cached like previews.
const thumbJobs = new Map();

// Thumbnails are made a few at a time, so opening a big folder doesn't start
// hundreds of ffmpeg processes at once.
let thumbsRunning = 0;
const thumbQueue = [];
async function thumbSlot(fn) {
  if (thumbsRunning >= 4) await new Promise(r => thumbQueue.push(r));
  thumbsRunning++;
  try { return await fn(); } finally {
    thumbsRunning--;
    const next = thumbQueue.shift();
    if (next) next();
  }
}

// A small JPEG for the gallery: a video frame at t seconds, or a photo scaled down.
async function makeThumb(file, t) {
  const st = await fsp.stat(file);
  const at = Math.max(0, Math.round((Number(t) || 0) * 10) / 10);
  const hash = crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}|${at}`).digest('hex').slice(0, 16);
  const out = path.join(PREVIEW_DIR, `thumb-${hash}.jpg`);
  if (fs.existsSync(out)) return out;
  if (thumbJobs.has(out)) return thumbJobs.get(out);
  const ffmpeg = tool('ffmpeg');
  if (!ffmpeg) throw new Error('ffmpeg is not installed');
  const job = thumbSlot(async () => {
    await fsp.mkdir(PREVIEW_DIR, { recursive: true });
    const tmp = out + '.part.jpg';
    const frame = seek => run(ffmpeg, ['-y', '-v', 'error', ...seek, '-i', file, '-frames:v', '1',
      '-vf', "scale=-2:'min(480,ih)'", '-q:v', '4', tmp]);
    // A video shorter than the requested moment (e.g. a 0.3 s clip) gets its first frame.
    if (mediaType(file) === 'video' && at > 0) await frame(['-ss', String(at)]).catch(() => {});
    if (!fs.existsSync(tmp)) await frame([]);
    await fsp.rename(tmp, out);
    return out;
  });
  thumbJobs.set(out, job);
  try { return await job; } finally { thumbJobs.delete(out); }
}

// ---------- place names ----------
// Turns coordinates into a name like "Ubud, Bali". With a Google Maps API key saved
// (settings.json, entered by the user on the page) Google's Geocoding API is used,
// otherwise OpenStreetMap's Nominatim. Only runs when asked from the page, sends
// nothing but the coordinates, and keeps results in places.json next to the app so
// each spot is looked up once per provider.

const PLACES_FILE = path.join(APP_DIR, 'places.json');
const POI_CATEGORIES = new Set(['tourism', 'natural', 'leisure', 'historic', 'amenity', 'aeroway', 'waterway']);
// Only real sights count as a place's point of interest: Google also tags bus stops,
// shops and the like as "point_of_interest", which make poor place names.
const GOOGLE_POI_TYPES = new Set(['tourist_attraction', 'natural_feature', 'park', 'place_of_worship', 'airport',
  'museum', 'zoo', 'amusement_park', 'campground', 'aquarium', 'hindu_temple', 'church', 'mosque', 'stadium']);
const GOOGLE_SKIP_TYPES = new Set(['transit_station', 'bus_station', 'train_station', 'route', 'street_address', 'plus_code']);
let placeQueue = Promise.resolve();
let lastPlaceAt = 0;

function loadPlaces() {
  try { return JSON.parse(fs.readFileSync(PLACES_FILE, 'utf8')); } catch { return {}; }
}

const googleKey = () => loadSettings().googleMapsKey || null;
const placeProvider = () => (googleKey() ? 'google' : 'osm');
// About 100 m; OpenStreetMap entries keep the plain key they always had.
// "g2:" = Google names with the stricter choice of sights (older "g:" entries are not reused).
const placeCacheKey = (lat, lon) => `${placeProvider() === 'google' ? 'g2:' : ''}${lat.toFixed(3)},${lon.toFixed(3)}`;

async function osmPlace(lat, lon) {
  // Nominatim's usage policy: at most one request per second, with a User-Agent.
  const wait = lastPlaceAt + 1100 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastPlaceAt = Date.now();
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&addressdetails=1&lat=${lat}&lon=${lon}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'Statusbook/1.0 (personal photo tool)', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('Place lookup failed: no connection to OpenStreetMap');
  }
  if (!res.ok) throw new Error(`Place lookup failed (OpenStreetMap answered ${res.status})`);
  const j = await res.json();
  const a = j.address || {};
  const local = a.village || a.town || a.city || a.suburb || a.hamlet || a.municipality || a.city_district || a.county || '';
  const region = a.state || a.province || a.region || '';
  return {
    name: [local, region].filter(Boolean).join(', ') || j.display_name || '',
    poi: j.name && j.name !== local && POI_CATEGORIES.has(j.category) ? j.name : '',
    country: a.country || '',
  };
}

async function googlePlace(lat, lon, apiKey) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&language=en&key=${encodeURIComponent(apiKey)}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error('Place lookup failed: no connection to Google Maps');
  }
  const j = await res.json().catch(() => ({}));
  if (j.status === 'ZERO_RESULTS') return { name: '', poi: '', country: '' };
  // e.g. REQUEST_DENIED "The provided API key is invalid." The key itself is never echoed.
  if (j.status !== 'OK') throw new Error(`Google Maps: ${j.error_message || j.status || `HTTP ${res.status}`}`);
  // The first (most precise) result that has a component of a type wins.
  const comp = {};
  for (const r of j.results) {
    for (const c of r.address_components || []) {
      for (const t of c.types) if (!comp[t]) comp[t] = c.long_name;
    }
  }
  const local = comp.locality || comp.sublocality || comp.administrative_area_level_3 || comp.administrative_area_level_2 || '';
  const region = comp.administrative_area_level_1 || '';
  const poiResult = j.results.find(r => !r.types.some(t => GOOGLE_SKIP_TYPES.has(t)) && r.types.some(t => GOOGLE_POI_TYPES.has(t)));
  const poiName = poiResult && poiResult.address_components && poiResult.address_components[0]
    ? poiResult.address_components[0].long_name : '';
  return {
    name: [local, region].filter(Boolean).join(', ') || (j.results[0] && j.results[0].formatted_address) || '',
    poi: poiName && poiName !== local && poiName !== region ? poiName : '',
    country: comp.country || '',
  };
}

// The other direction: a place name typed by the user ("Nusa Penida") -> coordinates,
// for day intros of days without any location in the files.
async function findPlace(q) {
  const apiKey = googleKey();
  let res;
  try {
    res = apiKey
      ? await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&language=de&key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(15000) })
      : await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`, {
        headers: { 'User-Agent': 'Statusbook/1.0 (personal photo tool)', 'Accept-Language': 'de' }, signal: AbortSignal.timeout(15000),
      });
  } catch {
    throw new Error(`No connection to ${apiKey ? 'Google Maps' : 'OpenStreetMap'}`);
  }
  const j = await res.json().catch(() => ({}));
  if (apiKey) {
    if (j.status === 'ZERO_RESULTS') return null;
    if (j.status !== 'OK') throw new Error(`Google Maps: ${j.error_message || j.status || `HTTP ${res.status}`}`);
    const r = j.results[0];
    return { name: r.formatted_address, lat: r.geometry.location.lat, lon: r.geometry.location.lng };
  }
  const r = Array.isArray(j) ? j[0] : null;
  return r ? { name: r.display_name, lat: Number(r.lat), lon: Number(r.lon) } : null;
}

function lookupPlace(lat, lon) {
  const key = placeCacheKey(lat, lon);
  const cached = loadPlaces()[key];
  if (cached) return Promise.resolve(cached);
  const job = placeQueue.then(async () => {
    const again = loadPlaces()[key];
    if (again) return again;
    const apiKey = googleKey();
    const place = { ...(apiKey ? await googlePlace(lat, lon, apiKey) : await osmPlace(lat, lon)), source: apiKey ? 'google' : 'osm' };
    const all = loadPlaces();
    all[key] = place;
    fs.writeFileSync(PLACES_FILE, JSON.stringify(all, null, 2));
    return place;
  });
  placeQueue = job.catch(() => {});
  return job;
}

// ---------- day maps ----------
// Map with pins for a day intro, from Google's Maps Static API with the saved key
// (the key never leaves the server). Each map is fetched once and kept in maps\ next
// to the app; only the pin coordinates and the map size are sent to Google.

const MAPS_DIR = path.join(APP_DIR, 'maps');
const mapJobs = new Map();

async function getDayMap(pins, w, h) {
  const apiKey = googleKey();
  if (!apiKey) throw Object.assign(new Error('Day maps need a Google Maps key: open a post\'s location → "Use Google instead…"'), { code: 400 });
  const markers = `color:red|${pins.map(p => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join('|')}`;
  // One pin alone would be shown at street level; zoom out to see the area.
  const zoom = pins.length === 1 ? '&zoom=12' : '';
  const query = `size=${w}x${h}&scale=2&maptype=roadmap&language=de${zoom}&markers=${encodeURIComponent(markers)}`;
  const hash = crypto.createHash('sha1').update(query).digest('hex').slice(0, 20);
  const file = path.join(MAPS_DIR, `${hash}.png`);
  if (fs.existsSync(file)) return file;
  if (mapJobs.has(file)) return mapJobs.get(file);
  const job = (async () => {
    let res;
    try {
      res = await fetch(`https://maps.googleapis.com/maps/api/staticmap?${query}&key=${encodeURIComponent(apiKey)}`, {
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new Error('No connection to Google Maps');
    }
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.startsWith('image/')) {
      // e.g. 403 "This API project is not authorized to use this API." The key is never echoed.
      const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
      const hint = /not authorized|not activated|disabled/i.test(text) ? ' Turn on "Maps Static API" for your key in the Google Cloud Console.' : '';
      throw new Error(`Google Maps (${res.status}): ${text || 'no map'}${hint}`);
    }
    await fsp.mkdir(MAPS_DIR, { recursive: true });
    await fsp.writeFile(file + '.part', Buffer.from(await res.arrayBuffer()));
    await fsp.rename(file + '.part', file);
    return file;
  })();
  mapJobs.set(file, job);
  try { return await job; } finally { mapJobs.delete(file); }
}

// ---------- Status posts ----------
// Posts are prepared in the browser. Text posts arrive as finished 1080×1920 JPEGs;
// photos are copied (or scaled down), video scenes are cut by ffmpeg.

// The browser owns the format of _posts.json (see posts.js); the server only stores it.
async function readPosts(folder) {
  try {
    const j = JSON.parse(await fsp.readFile(path.join(folder, POSTS_FILE), 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

async function writePosts(folder, data) {
  const file = path.join(folder, POSTS_FILE);
  if (!data) await fsp.rm(file, { force: true });
  else await writeJsonAtomic(file, data);
}

// Running and recently finished video post exports: id -> { out, done, error }.
const videoJobs = new Map();

// The part being published to WhatsApp (or the last one): progress for the page.
let publishJob = null;

// Saves from the browser carry the folder they belong to. One that arrives after
// switching to another folder is dropped instead of landing in the wrong folder.
const isCurrentFolder = f => !f || (!!currentFolder && path.resolve(String(f)).toLowerCase() === currentFolder.toLowerCase());

// ---------- releases ----------
// A release is one "Create release" from the Posts view, kept within WhatsApp's
// limits. If it has more posts than WhatsApp takes at once, it is split into parts:
//   WhatsApp\Releases\2026-10-26 release 1\part 1 of 3\01_….jpg … release.json captions.txt
//   WhatsApp\Releases\2026-10-26 release 1\release.json   (overview of all parts)
// Each part's release.json holds everything about it: release, part, limits, and
// per post the file, source, scene, caption, location, size and when it was sent.

const RELEASES_DIR_NAME = 'Releases';
const RELEASE_FILE = 'release.json';
const RELEASE_RE = /^\d{4}-\d{2}-\d{2} release \d{1,3}$/;
const PART_RE = /^part (\d{1,3}) of (\d{1,3})$/;
// WhatsApp Status limits (WhatsApp Help Center, where it is clear; otherwise the
// safer value). Can be overridden with "releaseLimits" in settings.json.
const DEFAULT_LIMITS = {
  maxPosts: 30,          // per part: older WhatsApp versions take 30 at once
  maxVideoSeconds: 90,   // Status shows only the first 90 s
  maxVideoMB: 9.9,       // WhatsApp Web takes Status videos up to about 10 MB (tested); see MB_BYTES
  maxVideoSide: 1920,    // 1080p; Status has no HD
  maxImageSide: 2560,    // longest side of photos
};
const releaseLimits = () => ({ ...DEFAULT_LIMITS, ...(loadSettings().releaseLimits || {}) });
// Video size limits count 1 MB = 1,000,000 bytes, so 9.9 MB stays under "10 MB"
// however WhatsApp (or the browser upload) counts it.
const MB_BYTES = 1000 * 1000;
const releasesDir = () => path.join(currentFolder, EXPORT_DIR_NAME, RELEASES_DIR_NAME);

function releaseDir(release, part) {
  if (!RELEASE_RE.test(String(release || ''))) throw Object.assign(new Error('Invalid release name'), { code: 400 });
  const dir = path.join(releasesDir(), release);
  if (part === undefined || part === null) return dir;
  if (!PART_RE.test(String(part))) throw Object.assign(new Error('Invalid part name'), { code: 400 });
  return path.join(dir, part);
}

// Where an export step writes: a part of a release.
const outDir = body => releaseDir(body.release, body.part);

// Output names come from the browser: "01_beach.mp4". Only plain names are allowed.
function statusFile(body, name, ext) {
  const n = String(name || '');
  if (!/^\d{2,3}_[^<>:"/\\|?*]{1,120}$/.test(n) || path.extname(n).toLowerCase() !== ext || n.includes('..')) {
    throw Object.assign(new Error('Invalid output name'), { code: 400 });
  }
  return path.join(outDir(body), n);
}

async function probeFile(file) {
  const ffprobe = tool('ffprobe');
  const st = await fsp.stat(file);
  const info = { size: st.size };
  if (!ffprobe) return info;
  try {
    const j = JSON.parse(await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=codec_name,width,height:stream_side_data=rotation:format=duration', '-of', 'json', file]));
    const s = (j.streams || [])[0] || {};
    const rot = Math.abs(Number(((s.side_data_list || [])[0] || {}).rotation) || 0);
    // Phone videos are often stored sideways with a rotation flag; report what is shown.
    const turned = rot === 90 || rot === 270;
    Object.assign(info, {
      codec: s.codec_name || null,
      width: turned ? s.height : s.width,
      height: turned ? s.width : s.height,
      duration: parseFloat((j.format || {}).duration) || null,
    });
  } catch { /* not a media file ffprobe understands */ }
  return info;
}

async function readRelease(release) {
  const dir = releaseDir(release);
  const parts = [];
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    if (!PART_RE.test(name)) continue;
    try {
      parts.push(JSON.parse(await fsp.readFile(path.join(dir, name, RELEASE_FILE), 'utf8')));
    } catch { /* part without manifest (export interrupted) */ }
  }
  parts.sort((a, b) => a.partNo - b.partNo);
  return { release, created: parts.length ? parts[0].created : null, partsTotal: parts.length ? parts[0].parts : 0, parts };
}

async function listReleases() {
  if (!currentFolder) return [];
  const names = (await fsp.readdir(releasesDir()).catch(() => [])).filter(n => RELEASE_RE.test(n));
  const all = await Promise.all(names.map(readRelease));
  return all.filter(r => r.parts.length).sort((a, b) => (a.created || '').localeCompare(b.created || '') || a.release.localeCompare(b.release));
}

// Marks files of one part as sent (with the time) or not sent.
async function markSent(release, part, keys, sent) {
  const file = path.join(releaseDir(release, part), RELEASE_FILE);
  const m = JSON.parse(await fsp.readFile(file, 'utf8'));
  const wanted = new Set(keys);
  const when = stampFromDate(new Date());
  for (const it of m.items) if (wanted.has(it.key)) it.sentAt = sent ? it.sentAt || when : null;
  await writeJsonAtomic(file, m);
  await writeReleaseOverview(release);
}

// The overview in the release folder: which parts belong to it and what's in them.
async function writeReleaseOverview(release) {
  const r = await readRelease(release);
  const overview = {
    kind: 'media-picker-release-overview', version: 1, release, created: r.created, parts: r.partsTotal,
    partsPresent: r.parts.map(p => ({
      part: p.part, posts: p.items.length,
      numbers: p.items.length ? `${p.items[0].file.split('_')[0]}–${p.items[p.items.length - 1].file.split('_')[0]}` : '',
      sent: p.items.filter(i => i.sentAt).length,
    })),
  };
  await writeJsonAtomic(path.join(releaseDir(release), RELEASE_FILE), overview);
}

// Already rendered video from an earlier release with the same name (e.g. the scene
// was released before), usable as is if it fits the limits and has the right length.
async function findReusableVideo(base, seconds, limits) {
  const re = new RegExp(`^\\d{2,3}_${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.mp4$`, 'i');
  const roots = [releasesDir()];
  for (const root of roots) {
    for (const sub of await fsp.readdir(root).catch(() => [])) {
      const dirs = [path.join(root, sub)];
      for (const p of await fsp.readdir(dirs[0]).catch(() => [])) if (PART_RE.test(p)) dirs.push(path.join(dirs[0], p));
      for (const d of dirs) {
        for (const f of await fsp.readdir(d).catch(() => [])) {
          if (!re.test(f)) continue;
          const file = path.join(d, f);
          const info = await probeFile(file);
          const fits = info.codec === 'h264' && info.size <= limits.maxVideoMB * MB_BYTES &&
            Math.max(info.width || 1e9, info.height || 1e9) <= limits.maxVideoSide &&
            info.duration && Math.abs(info.duration - seconds) < 0.3;
          if (fits) return file;
        }
      }
    }
  }
  return null;
}

function dataUrlBuffer(dataUrl, mime) {
  const prefix = `data:${mime};base64,`;
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) {
    throw Object.assign(new Error('Invalid image data'), { code: 400 });
  }
  return Buffer.from(dataUrl.slice(prefix.length), 'base64');
}

// Highest video bitrate (kbit/s) that keeps a clip of this length under the size
// limit, leaving room for audio; capped at 8 Mbit/s, which is plenty for 1080p.
function videoBitrateK(seconds, limits) {
  const bits = limits.maxVideoMB * MB_BYTES * 8 * 0.92;
  return Math.max(500, Math.min(8000, Math.floor(bits / 1000 / Math.max(1, seconds)) - 160));
}

// A video post within the limits: H.264/AAC MP4, longest side at most maxVideoSide
// (never enlarged), bitrate capped so the file stays under maxVideoMB.
// The scene in its original format; WhatsApp fits it to the screen.
function statusVideoArgs(src, start, end, out, limits, kbps) {
  const side = limits.maxVideoSide;
  const keep = `scale='min(iw,${side})':'min(ih,${side})':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  return ['-y', '-v', 'error', '-ss', String(start), '-t', String(end - start), '-i', src,
    '-filter_complex', `[0:v]${keep},setsar=1,format=yuv420p[v]`,
    '-map', '[v]', '-map', '0:a:0?', '-map_metadata', '0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out];
}

// ---------- folder dialog ----------

let pickJob = null;

// Windows won't let a background process put a window in front of the browser,
// so the dialog gets an invisible always-on-top owner; owned windows stay above
// their owner. Only one dialog at a time: repeated clicks wait for the same one.
function pickFolder(start) {
  if (pickJob) return pickJob;
  const from = start || currentFolder;
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = 'Choose a folder with photos and videos'",
    '$d.ShowNewFolderButton = $false',
    from ? `$d.SelectedPath = '${String(from).replace(/'/g, "''")}'` : '',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    "$owner.FormBorderStyle = 'None'",
    "$owner.StartPosition = 'CenterScreen'",
    '$owner.Size = New-Object System.Drawing.Size(1, 1)',
    '$owner.Opacity = 0',
    '$owner.Show()',
    '$owner.Activate()',
    "$picked = if ($d.ShowDialog($owner) -eq 'OK') { $d.SelectedPath }",
    '$owner.Close()',
    '$picked',
  ].filter(Boolean).join('; ');
  pickJob = run('powershell.exe', ['-NoProfile', '-STA', '-Command', script])
    .then(out => out.trim() || null)
    .finally(() => { pickJob = null; });
  return pickJob;
}

// ---------- HTTP ----------

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    // Large enough for a finished 1080×1920 post image sent as base64.
    req.on('data', c => { data += c; if (data.length > 60e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Only plain file names inside the open folder are served or changed.
function fileInFolder(name) {
  if (!currentFolder) throw Object.assign(new Error('No folder is open'), { code: 400 });
  if (!name || name !== path.basename(name) || !mediaType(name)) throw Object.assign(new Error('Invalid file name'), { code: 400 });
  return path.join(currentFolder, name);
}

async function serveFile(req, res, file, type) {
  const st = await fsp.stat(file);
  const headers = { 'Content-Type': type || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  let start = 0, end = st.size - 1, code = 200;
  if (m) {
    if (m[1]) { start = parseInt(m[1], 10); if (m[2]) end = Math.min(parseInt(m[2], 10), end); }
    else if (m[2]) start = Math.max(0, st.size - parseInt(m[2], 10));
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    code = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

async function openFolder(folder) {
  const st = await fsp.stat(folder).catch(() => null);
  if (!st || !st.isDirectory()) throw Object.assign(new Error(`Folder not found: ${folder}`), { code: 404 });
  currentFolder = path.resolve(folder);
  saveSettings({ lastFolder: currentFolder });
  watchFolder(currentFolder);
}

// The open folder is watched: when photos or videos are added, changed or deleted,
// the version goes up and the page (asking every few seconds) reads the folder again.
// Only media files count, not the tool's own .json files. While files are being
// copied, changes come in quick succession; they count once, after a quiet moment.
let folderWatcher = null, folderVersion = 0, watchTimer = null;

function watchFolder(folder) {
  if (folderWatcher) folderWatcher.close();
  folderWatcher = null;
  clearTimeout(watchTimer);
  try {
    folderWatcher = fs.watch(folder, (event, name) => {
      if (!name || !mediaType(String(name))) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => { folderVersion++; }, 1500);
    });
    folderWatcher.on('error', () => { /* folder gone (drive removed): nothing more to watch */ });
  } catch { /* not watchable: the page still reads the folder when it opens */ }
}

// ---------- journeys ----------
// A journey is one trip: a name and the one folder that holds its photos and videos,
// stars, scenes, posts and releases. The list lives in settings.json:
//   journeys: [{ id, name, folder, created, opened, summary }], lastJourney: id
// summary is what the page last saw (days, posts, releases), for the journeys list.

let currentJourney = null;

const sameFolder = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function loadJourneys() {
  const s = loadSettings();
  if (Array.isArray(s.journeys)) return s.journeys;
  // Before journeys: the last opened folder becomes the first journey, named after it.
  const list = [];
  if (s.lastFolder) {
    list.push({ id: crypto.randomBytes(6).toString('hex'), name: path.basename(s.lastFolder), folder: s.lastFolder, created: stampFromDate(new Date()) });
  }
  saveSettings({ journeys: list, lastJourney: list.length ? list[0].id : null });
  return list;
}

const saveJourneys = list => saveSettings({ journeys: list });

function findJourney(id) {
  const j = loadJourneys().find(x => x.id === id);
  if (!j) throw Object.assign(new Error('Unknown journey'), { code: 404 });
  return j;
}

async function checkJourneyFolder(folder, exceptId) {
  const f = String(folder || '').trim().replace(/^"(.*)"$/, '$1');
  if (!f) throw Object.assign(new Error('Choose a folder for the journey'), { code: 400 });
  const st = await fsp.stat(f).catch(() => null);
  if (!st || !st.isDirectory()) throw Object.assign(new Error(`Folder not found: ${f}`), { code: 400 });
  const other = loadJourneys().find(j => j.id !== exceptId && sameFolder(j.folder, f));
  // Two journeys on one folder would share stars, posts and releases.
  if (other) throw Object.assign(new Error(`This folder belongs to the journey "${other.name}" already`), { code: 409 });
  return path.resolve(f);
}

async function openJourney(id) {
  const list = loadJourneys();
  const j = list.find(x => x.id === id);
  if (!j) throw Object.assign(new Error('Unknown journey'), { code: 404 });
  await openFolder(j.folder);
  currentJourney = j.id;
  j.opened = stampFromDate(new Date());
  saveSettings({ journeys: list, lastJourney: j.id });
  return j;
}

const journeyName = n => {
  const name = String(n || '').trim().slice(0, 80);
  if (!name) throw Object.assign(new Error('Give the journey a name'), { code: 400 });
  return name;
};

// ---------- spelling ----------
// LanguageTool's free public API checks German spelling, grammar and capitalization.
// Only captions and the text of text posts are sent, which go to WhatsApp anyway.
// Typography (quotes, "..." instead of "…", spaces) is left out: that's style, not a mistake.
const SPELL_URL = 'https://api.languagetool.org/v2/check';
const SPELL_SEP = '\n\n\n';

// texts: strings; answers one list of { offset, length, message, replacements } per text.
async function checkSpelling(texts) {
  const joined = texts.join(SPELL_SEP);
  if (joined.length > 20000) throw Object.assign(new Error('Too much text to check at once'), { code: 400 });
  const out = texts.map(() => []);
  if (!joined.trim()) return out;
  let res;
  try {
    res = await fetch(SPELL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Statusbook/1.0 (personal photo tool)' },
      body: new URLSearchParams({ text: joined, language: 'de-DE', disabledCategories: 'TYPOGRAPHY', disabledRules: 'WHITESPACE_RULE' }),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error('No connection to LanguageTool');
  }
  if (res.status === 429) throw new Error('LanguageTool is busy (too many checks in a row); try again in a minute');
  if (!res.ok) throw new Error(`LanguageTool answered ${res.status}`);
  const data = await res.json();
  // Map each match back to its text.
  const starts = [];
  let at = 0;
  for (const t of texts) { starts.push(at); at += t.length + SPELL_SEP.length; }
  for (const m of data.matches || []) {
    let i = starts.length - 1;
    while (i > 0 && starts[i] > m.offset) i--;
    const offset = m.offset - starts[i];
    if (offset < 0 || offset + m.length > texts[i].length) continue;
    out[i].push({
      offset, length: m.length, message: m.message || m.shortMessage || '',
      replacements: (m.replacements || []).slice(0, 4).map(r => r.value),
      rule: m.rule ? m.rule.id : '',
    });
  }
  return out;
}

const routes = {
  'GET /api/state': async () => ({
    folder: currentFolder,
    journey: currentJourney ? loadJourneys().find(j => j.id === currentJourney) || null : null,
    ffmpeg: !!tool('ffmpeg'),
    exportDirName: EXPORT_DIR_NAME,
    // The own map page for day intro links with several pins (see docs/map/README.md).
    mapPageUrl: loadSettings().mapPageUrl || null,
  }),
  // Asked every few seconds by the page: goes up when files in the folder change.
  'GET /api/folder-version': async () => ({ folder: currentFolder, version: folderVersion }),
  'GET /api/items': async () => {
    if (!currentFolder) return { folder: null, items: [], view: { collapsed: [], lastFile: null } };
    return { folder: currentFolder, items: await scanFolder(currentFolder), view: folderView(currentFolder) };
  },
  'POST /api/view': async body => {
    if (!currentFolder) throw Object.assign(new Error('No folder is open'), { code: 400 });
    if (!isCurrentFolder(body.folder)) return { ok: false, ignored: true };
    const patch = {};
    if (Array.isArray(body.collapsed)) patch.collapsed = body.collapsed.filter(k => typeof k === 'string').slice(0, 5000);
    if (typeof body.lastFile === 'string' || body.lastFile === null) patch.lastFile = body.lastFile;
    saveFolderView(currentFolder, patch);
    return { ok: true };
  },
  // ----- journeys -----
  'GET /api/journeys': async () => ({
    current: currentJourney,
    journeys: loadJourneys().map(j => ({ ...j, missing: !fs.existsSync(j.folder) })),
  }),
  // The folder window, for the journey dialog; the folder is only checked, not opened.
  'POST /api/journeys/pick': async body => ({ folder: await pickFolder(body.start || null) }),
  'POST /api/journeys/new': async body => {
    const name = journeyName(body.name);
    const folder = await checkJourneyFolder(body.folder);
    const j = { id: crypto.randomBytes(6).toString('hex'), name, folder, created: stampFromDate(new Date()) };
    saveJourneys([...loadJourneys(), j]);
    return { journey: await openJourney(j.id) };
  },
  'POST /api/journeys/open': async body => ({ journey: await openJourney(String(body.id || '')) }),
  // Rename, or choose the folder again (moved, or another drive letter).
  'POST /api/journeys/update': async body => {
    const list = loadJourneys();
    const j = list.find(x => x.id === body.id);
    if (!j) throw Object.assign(new Error('Unknown journey'), { code: 404 });
    if (body.name !== undefined) j.name = journeyName(body.name);
    if (body.folder !== undefined && !(fs.existsSync(j.folder) && sameFolder(j.folder, String(body.folder).trim().replace(/^"(.*)"$/, '$1')))) {
      j.folder = await checkJourneyFolder(body.folder, j.id);
      delete j.summary;
    }
    saveJourneys(list);
    if (currentJourney === j.id) await openFolder(j.folder);
    return { journey: j };
  },
  // Off the list only: the folder and everything in it stay as they are.
  'POST /api/journeys/remove': async body => {
    findJourney(body.id);
    saveJourneys(loadJourneys().filter(j => j.id !== body.id));
    if (currentJourney === body.id) {
      currentJourney = null;
      currentFolder = null;
      saveSettings({ lastJourney: null });
    }
    return { ok: true };
  },
  'POST /api/journeys/summary': async body => {
    if (!currentJourney || !isCurrentFolder(body.folder)) return { ok: false };
    const list = loadJourneys();
    const j = list.find(x => x.id === currentJourney);
    if (j && body.summary && typeof body.summary === 'object') {
      const s = body.summary;
      j.summary = { from: s.from || null, to: s.to || null, posts: Number(s.posts) || 0, releases: Number(s.releases) || 0,
        files: Number(s.files) || 0, sent: Number(s.sent) || 0 };
      saveJourneys(list);
    }
    return { ok: true };
  },
  'POST /api/favorite': async body => {
    const file = fileInFolder(body.name);
    if (mediaType(body.name) !== 'image') throw Object.assign(new Error('Only images can be favorites'), { code: 400 });
    await setFavorite(currentFolder, path.basename(file), !!body.value);
    return { ok: true };
  },
  'POST /api/scenes': async body => {
    const file = fileInFolder(body.name);
    if (mediaType(body.name) !== 'video') throw Object.assign(new Error('Scenes need a video'), { code: 400 });
    return { scenes: await writeScenes(file, Array.isArray(body.scenes) ? body.scenes : []) };
  },
  'POST /api/reveal': async body => {
    const dir = body.release && currentFolder ? releaseDir(body.release, body.part || null)
      : body.releases && currentFolder ? releasesDir()
        : currentFolder;
    if (dir) spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  },
  'GET /api/posts': async () => ({ data: currentFolder ? await readPosts(currentFolder) : null }),
  'POST /api/posts': async body => {
    if (!currentFolder) throw Object.assign(new Error('No folder is open'), { code: 400 });
    if (!isCurrentFolder(body.folder)) return { ok: false, ignored: true };
    const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : null;
    await writePosts(currentFolder, data);
    return { ok: true };
  },
  'GET /api/place': async (body, url) => {
    const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
    if (!validGeo(lat, lon)) throw Object.assign(new Error('Invalid coordinates'), { code: 400 });
    // cached=1: answer only from places.json, never go online.
    if (url.searchParams.get('cached')) return { place: loadPlaces()[placeCacheKey(lat, lon)] || null, provider: placeProvider() };
    return { place: await lookupPlace(lat, lon), provider: placeProvider() };
  },
  'GET /api/find-place': async (body, url) => {
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 200);
    if (!q) throw Object.assign(new Error('Type a place name'), { code: 400 });
    const place = await findPlace(q);
    if (!place || !validGeo(place.lat, place.lon)) throw Object.assign(new Error(`"${q}" was not found`), { code: 404 });
    return { place: { ...place, ...validGeo(place.lat, place.lon) } };
  },
  // The page only learns whether a key is saved, never the key itself.
  'GET /api/google-key': async () => ({ saved: !!googleKey() }),
  'POST /api/google-key': async body => {
    const key = String(body.key || '').trim();
    if (!key) {
      const s = loadSettings();
      delete s.googleMapsKey;
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
      return { saved: false };
    }
    if (!/^[A-Za-z0-9_-]{30,60}$/.test(key)) throw Object.assign(new Error('That does not look like a Google API key (it usually starts with "AIza" and has 39 characters).'), { code: 400 });
    saveSettings({ googleMapsKey: key });
    return { saved: true };
  },
  // ----- releases -----
  'POST /api/spellcheck': async body => {
    const texts = Array.isArray(body.texts) ? body.texts.map(t => String(t || '')) : [];
    return { results: await checkSpelling(texts) };
  },
  'GET /api/releases': async () => ({ limits: releaseLimits(), releases: await listReleases() }),
  // Creates the folder of one part of a new release. An existing folder (a repeated
  // run of the same part) is reused; other releases are never touched.
  'POST /api/posts/prepare': async body => {
    if (!currentFolder) throw Object.assign(new Error('No folder is open'), { code: 400 });
    const dir = outDir(body);
    await fsp.mkdir(dir, { recursive: true });
    return { dir };
  },
  // Writes a part's release.json. Sizes, resolutions and lengths are measured from
  // the files themselves, so the manifest describes exactly what is in the folder.
  'POST /api/releases/manifest': async body => {
    if (!currentFolder) throw Object.assign(new Error('No folder is open'), { code: 400 });
    const dir = releaseDir(body.release, body.part);
    const m = body.manifest || {};
    const items = [];
    for (const it of Array.isArray(m.items) ? m.items : []) {
      const file = path.join(dir, path.basename(String(it.file || '')));
      const info = fs.existsSync(file) ? await probeFile(file) : {};
      items.push({ ...it, size: info.size || null, width: info.width || null, height: info.height || null,
        duration: it.type === 'video' ? info.duration || null : undefined, sentAt: it.sentAt || null });
    }
    const [, partNo, parts] = PART_RE.exec(body.part);
    const manifest = {
      kind: 'media-picker-release', version: 1, release: body.release, part: body.part,
      partNo: Number(partNo), parts: Number(parts), created: m.created || stampFromDate(new Date()),
      sourceFolder: currentFolder, limits: releaseLimits(), items,
    };
    await writeJsonAtomic(path.join(dir, RELEASE_FILE), manifest);
    await writeReleaseOverview(body.release);
    return { manifest };
  },
  // Replaces one file of a part that is not sent yet (a post edited after the release
  // was made): new caption and/or new file. A replaced file with another name is
  // deleted; captions.txt is written again from the manifest.
  'POST /api/releases/item': async body => {
    if (!currentFolder) throw Object.assign(new Error('No folder is open'), { code: 400 });
    const dir = releaseDir(body.release, body.part);
    const mfile = path.join(dir, RELEASE_FILE);
    const m = JSON.parse(await fsp.readFile(mfile, 'utf8'));
    const i = m.items.findIndex(it => it.key === body.key);
    if (i < 0) throw Object.assign(new Error('Not in this part'), { code: 404 });
    const old = m.items[i];
    if (old.sentAt) throw Object.assign(new Error('Already sent; it can\'t be changed any more'), { code: 409 });
    const it = { ...(body.item || {}), key: old.key, n: old.n, sentAt: null };
    it.file = path.basename(String(it.file || old.file));
    const file = path.join(dir, it.file);
    if (!fs.existsSync(file)) throw Object.assign(new Error(`${it.file} is missing`), { code: 400 });
    const info = await probeFile(file);
    Object.assign(it, { size: info.size || null, width: info.width || null, height: info.height || null,
      duration: it.type === 'video' ? info.duration || null : undefined });
    m.items[i] = it;
    await writeJsonAtomic(mfile, m);
    if (it.file !== old.file) await fsp.rm(path.join(dir, path.basename(old.file)), { force: true });
    const lines = m.items.filter(x => x.caption).map(x => `${x.file.split('_')[0]}  (${x.file})\n${x.caption}\n`);
    const ctext = lines.join('\n');
    const cfile = path.join(dir, 'captions.txt');
    if (ctext.trim()) await fsp.writeFile(cfile, '﻿' + ctext.replace(/\r?\n/g, '\r\n'), 'utf8');
    else await fsp.rm(cfile, { force: true });
    await writeReleaseOverview(body.release);
    return { item: it };
  },
  // Marks posts of one part as sent (or not), with the time.
  'POST /api/releases/sent': async body => {
    if (!currentFolder) throw Object.assign(new Error('No folder is open'), { code: 400 });
    await markSent(body.release, body.part, Array.isArray(body.keys) ? body.keys : [], !!body.sent);
    return { ok: true };
  },
  // ----- publishing to WhatsApp Status (see publisher.js) -----
  'GET /api/publish/status': async () => ({
    browser: publisher.findBrowser() ? 'found' : 'missing',
    login: await publisher.loginState(),
    lastDialog: publisher.lastDialogText(),
    job: publishJob,
  }),
  // Opens (or brings to the front) the WhatsApp Web window.
  'POST /api/publish/open': async () => {
    await publisher.open(path.join(APP_DIR, 'whatsapp-profile'));
    return { login: await publisher.loginState() };
  },
  // Development aid: reads WhatsApp Web's text status editor without sending.
  'POST /api/publish/inspect-text': async () => {
    if (publishJob && publishJob.running) throw Object.assign(new Error('A part is being published'), { code: 409 });
    return publisher.inspectTextStatus();
  },
  // Development aid: a text post up to Send, never sent.
  'POST /api/publish/try-text': async body => {
    if (publishJob && publishJob.running) throw Object.assign(new Error('A part is being published'), { code: 409 });
    return publisher.tryTextStatus(String(body.text || ''), body.bg || null);
  },
  // Posts the not-yet-sent files of one part, in order, ticking each as sent.
  'POST /api/publish/start': async body => {
    if (!currentFolder) throw Object.assign(new Error('No folder is open'), { code: 400 });
    if (publishJob && publishJob.running) throw Object.assign(new Error('A part is being published already'), { code: 409 });
    const dir = releaseDir(body.release, body.part);
    const m = JSON.parse(await fsp.readFile(path.join(dir, RELEASE_FILE), 'utf8'));
    const items = m.items.filter(i => !i.sentAt).map(i => ({
      file: i.file, caption: i.caption || '', key: i.key,
      // Text posts go out as WhatsApp text status (publisher.js), not as their picture.
      type: i.type, intro: !!i.intro, text: i.text, bg: i.bg,
    }));
    if (!items.length) throw Object.assign(new Error('Everything in this part is sent already'), { code: 400 });
    if ((await publisher.loginState()) !== 'ready') throw Object.assign(new Error('Sign in to WhatsApp Web first'), { code: 409 });
    // dryRun (testing): every step except Send, nothing is ticked; optional limit of posts.
    const dryRun = !!body.dryRun;
    if (dryRun && body.limit) items.splice(Number(body.limit));
    const job = publishJob = {
      running: true, release: body.release, part: body.part, total: items.length, done: 0, dryRun,
      current: items[0].file, error: null, stopRequested: false, started: stampFromDate(new Date()),
    };
    (async () => {
      try {
        const res = await publisher.publish(items, dir, async item => {
          if (!dryRun) await markSent(job.release, job.part, [item.key], true);
          job.done++;
          job.current = items[job.done] ? items[job.done].file : null;
        }, () => job.stopRequested, dryRun);
        job.stopped = res.stopped;
      } catch (err) {
        job.error = err.message || String(err);
      } finally {
        job.running = false;
        job.current = null;
        job.finished = stampFromDate(new Date());
      }
    })();
    return { job };
  },
  // Stops after the post that is being sent right now.
  'POST /api/publish/stop': async () => {
    if (publishJob && publishJob.running) publishJob.stopRequested = true;
    return { job: publishJob };
  },
  'POST /api/posts/image': async body => {
    if (!currentFolder) throw Object.assign(new Error('No folder is open'), { code: 400 });
    await fsp.writeFile(statusFile(body, body.file, '.jpg'), dataUrlBuffer(body.data, 'image/jpeg'));
    return { ok: true };
  },
  // Video posts can take minutes (4K drone footage). The request only starts a job
  // and answers at once; the page then asks /api/posts/video-job until it's done,
  // so a dropped connection can't lose a finished video.
  'POST /api/posts/video': async body => {
    const src = fileInFolder(body.source);
    if (mediaType(body.source) !== 'video') throw Object.assign(new Error('Not a video'), { code: 400 });
    const start = Number(body.start), end = Number(body.end);
    if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) throw Object.assign(new Error('Invalid scene'), { code: 400 });
    const ffmpeg = tool('ffmpeg');
    if (!ffmpeg) throw new Error('ffmpeg is not installed');
    const out = statusFile(body, body.file, '.mp4');
    // The same output already being made (a repeated start after a dropped
    // connection) is not started twice.
    for (const [id, j] of videoJobs) if (j.out === out && !j.done) return { job: id };
    const id = crypto.randomBytes(8).toString('hex');
    const job = { out, done: false, error: null, reused: null, started: Date.now() };
    videoJobs.set(id, job);
    const limits = releaseLimits();
    (async () => {
      try {
        // Already rendered earlier and within the limits: copy instead of rendering again.
        const reuse = body.reuseBase ? await findReusableVideo(String(body.reuseBase), end - start, limits) : null;
        if (reuse) {
          await fsp.copyFile(reuse, out);
          job.reused = path.relative(currentFolder, reuse);
          return;
        }
        // Encode, then check the size; if a clip still ends up too big, try again
        // with a lower bitrate.
        let kbps = videoBitrateK(end - start, limits);
        for (let attempt = 1; ; attempt++) {
          await run(ffmpeg, statusVideoArgs(src, start, end, out, limits, kbps));
          const size = (await fsp.stat(out)).size;
          if (size <= limits.maxVideoMB * MB_BYTES) break;
          if (attempt >= 3) throw new Error(`still ${(size / MB_BYTES).toFixed(1)} MB after 3 tries (limit ${limits.maxVideoMB} MB)`);
          kbps = Math.floor(kbps * 0.7);
        }
      } catch (err) {
        job.error = (err.stderr || err.message || '').trim().split('\n').pop() || 'ffmpeg failed';
      } finally {
        job.done = true;
        job.finished = Date.now();
      }
    })();
    return { job: id };
  },
  'GET /api/posts/video-job': async (body, url) => {
    const job = videoJobs.get(url.searchParams.get('id') || '');
    if (!job) throw Object.assign(new Error('Unknown video job'), { code: 404 });
    // Finished jobs are kept for a while, so a repeated question still gets the answer.
    for (const [id, j] of videoJobs) if (j.done && Date.now() - j.finished > 30 * 60000) videoJobs.delete(id);
    return { done: job.done, error: job.error, reused: job.reused };
  },
  // Original photo, unchanged (same file type), for posts without a 9:16 frame.
  'POST /api/posts/copy': async body => {
    const src = fileInFolder(body.source);
    if (mediaType(body.source) !== 'image') throw Object.assign(new Error('Not a photo'), { code: 400 });
    const out = statusFile(body, body.file, path.extname(src).toLowerCase());
    await fsp.copyFile(src, out);
    const st = await fsp.stat(src);
    await fsp.utimes(out, st.atime, st.mtime);
    return { ok: true };
  },
  'POST /api/posts/captions': async body => {
    if (!currentFolder) throw Object.assign(new Error('No folder is open'), { code: 400 });
    const file = path.join(outDir(body), 'captions.txt');
    const text = String(body.text || '');
    if (text.trim()) await fsp.writeFile(file, '﻿' + text.replace(/\r?\n/g, '\r\n'), 'utf8');
    else await fsp.rm(file, { force: true });
    return { ok: true };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    const handler = routes[`${req.method} ${url.pathname}`];
    if (handler) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      return sendJson(res, 200, await handler(body, url));
    }
    // A file of a release part, for the viewer (double-click a card in a release).
    if (url.pathname === '/release-file' && (req.method === 'GET' || req.method === 'HEAD')) {
      const q = url.searchParams;
      const name = path.basename(String(q.get('file') || ''));
      if (!name || name !== q.get('file')) throw Object.assign(new Error('Invalid file name'), { code: 400 });
      const dir = releaseDir(q.get('release'), q.get('part'));
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) throw Object.assign(new Error('File not found'), { code: 404 });
      return await serveFile(req, res, file, MIME[path.extname(file).toLowerCase()]);
    }
    // /daymap?w=480&h=600&p=lat,lon|lat,lon|… -> PNG (scale 2, so 960×1200 pixels)
    if (url.pathname === '/daymap' && req.method === 'GET') {
      const w = Number(url.searchParams.get('w')), h = Number(url.searchParams.get('h'));
      const pins = String(url.searchParams.get('p') || '').split('|').filter(Boolean).slice(0, 80)
        .map(s => s.split(',').map(Number)).map(([lat, lon]) => validGeo(lat, lon)).filter(Boolean);
      if (!pins.length || !(w >= 100 && w <= 640 && h >= 100 && h <= 640)) throw Object.assign(new Error('Invalid map request'), { code: 400 });
      return await serveFile(req, res, await getDayMap(pins, w, h), 'image/png');
    }
    if (url.pathname === '/thumb' && (req.method === 'GET' || req.method === 'HEAD')) {
      const file = fileInFolder(url.searchParams.get('name'));
      return await serveFile(req, res, await makeThumb(file, url.searchParams.get('t')), 'image/jpeg');
    }
    if (url.pathname === '/media' && (req.method === 'GET' || req.method === 'HEAD')) {
      const file = fileInFolder(url.searchParams.get('name'));
      return await serveFile(req, res, file, MIME[path.extname(file).toLowerCase()]);
    }
    if (url.pathname === '/preview' && (req.method === 'GET' || req.method === 'HEAD')) {
      const file = fileInFolder(url.searchParams.get('name'));
      return await serveFile(req, res, await makePreview(file), 'video/mp4');
    }
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.join(PUBLIC_DIR, rel);
      if (file.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return await serveFile(req, res, file, MIME[path.extname(file).toLowerCase()]);
      }
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    if (res.headersSent) return res.destroy();
    // Our own errors carry an HTTP status as code; others (e.g. a failed ffmpeg run,
    // whose code is its exit code) are a plain 500.
    const status = Number.isInteger(err.code) && err.code >= 400 && err.code <= 599 ? err.code : 500;
    sendJson(res, status, { error: err.message || String(err) });
  }
});

function listen(port) {
  server.removeAllListeners('listening'); // drop the handler from a port that was taken
  server.once('error', err => {
    if (err.code === 'EADDRINUSE' && port < FIRST_PORT + 20) listen(port + 1);
    else { console.error(err.message); process.exit(1); }
  });
  server.listen(port, '127.0.0.1', () => {
    server.removeAllListeners('error');
    const url = `http://localhost:${port}/`;
    console.log(`Statusbook is running at ${url}`);
    console.log('Close this window to stop it.');
    if (!process.argv.includes('--no-browser')) {
      spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  });
}

(async () => {
  // A folder given on the command line opens directly (and its journey, if it has one);
  // otherwise the last journey. If its folder is missing, the page shows the journeys.
  const arg = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (arg) {
    await openFolder(arg).catch(err => console.log(err.message));
    const j = currentFolder && loadJourneys().find(x => sameFolder(x.folder, currentFolder));
    currentJourney = j ? j.id : null;
  } else {
    const last = loadSettings().lastJourney || (loadJourneys()[0] || {}).id;
    if (last) await openJourney(last).catch(err => console.log(err.message));
  }
  if (!tool('ffmpeg')) console.log('Note: ffmpeg was not found. Viewing and marking work, but scenes cannot be exported.');
  listen(FIRST_PORT);
})();
