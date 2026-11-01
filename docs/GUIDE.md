# Statusbook: user guide

Put together WhatsApp Status releases from the photos and videos of a trip: start a
release, pick photos and cut video scenes for it, arrange the posts, create the release
and publish it part by part.

## Start

Double-click **Start.bat**. Your browser opens with the tool, in the journey you had
open last. Close the black window to stop the tool.

## Journeys

A **journey** is one trip: a name and the one folder with all its photos and videos
(copy everything of the trip directly into that folder; subfolders are not read). Stars, scenes, posts and releases are
kept in the folder too, so each journey is self-contained.

- **← Journeys** (top left) shows all journeys, most recently opened first, with their
  days, number of posts and releases, and how many files are sent. Click one to open it.
- **＋ New journey:** type a name, choose the folder once (**📁 Choose…**, or paste the
  path), **Create journey**. A folder can belong to one journey only.
- **⚙** (next to the journey name, or on its card): rename it, or choose the folder
  again if it moved or the drive letter changed. **Remove from list** only takes it off
  the list; the folder and its files stay, and it can be added again later.
- A journey whose folder is missing (e.g. the USB drive isn't plugged in) is marked on
  its card and can't be opened until the folder is back or chosen again.
- The journey's folder is watched: photos and videos you copy into it (or delete) show
  up in Pick by themselves within a few seconds.

Journeys are kept in `settings.json` next to the app. Dragging a folder onto
Start.bat still opens that folder directly.

## Inside a journey: Releases, Pick, Arrange

| Tab | What it's for |
|---|---|
| **Releases** | the start page of a journey: the release being made (the **draft**) on top, then every release with its parts, newest first. **📤 Publish** on a part posts it. Sent parts are collapsed. |
| **1 · Pick** | the gallery of all photos and videos, oldest first, grouped by day: pick photos and cut video scenes for the draft |
| **2 · Arrange** | the draft's posts: captions, text posts, day intros, order |

How a release comes together:

1. **Releases → ＋ New release** starts the draft, e.g. "Release 2". There is one draft at
   a time; Pick and Arrange work on it.
2. **Pick:** **F** picks a photo or a whole video, **I / O** mark a scene in a video; every picked photo
   and every scene is a post of the draft.
3. **Arrange:** write captions, add text posts and day intros, put the posts in order.
4. **Create release ▶** (in Arrange, or on the draft in Releases) makes the files. The
   draft is then a release, and **＋ New release** starts the next one.
5. **📤 Publish** each part, when you like.

**Delete draft** (on the draft in Releases) unpicks everything of the draft: its stars,
scenes and text posts. Your photos and videos are not touched.

Needs Node.js and ffmpeg (both installed already on this PC):

```
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
```

## Pick

Every file of the journey's folder is a tile with a thumbnail, oldest first, grouped
by day. A tile shows where the file stands:

| Tile | Meaning |
|---|---|
| **★ Picked** / **N scenes** (yellow frame) | picked for the draft |
| **📦 Release N** (dimmed) | in release N, not sent yet |
| **✓ Release N** (dimmed) | in release N, sent |
| **Left out** | picked, but removed in Arrange |

Each day's header counts its files, picks, released and sent files. A file that is in
a release can't be picked again (no new star, no new or changed scenes). Without a
draft, nothing can be picked: the bar above the gallery offers **＋ New release**.
Thumbnails are made once with ffmpeg and kept in your temp folder.

Click a tile to see the file on the right (a video with its timeline and scenes);
double-click for real size.

| Key | Action |
|---|---|
| ↑ / ↓ | next / previous file |
| F | pick or unpick a photo |
| Space | play / pause a video |
| ← / → | back / forward 2 s (Shift: 10 s) |
| I | scene start |
| O | scene end |
| Esc | cancel a started scene |
| C | collapse the current day and move on to the next |
| Home / End | first / last file |

Click a scene in the list to play it, ✕ deletes it. Click the green bar to jump.

Click a day header to collapse or expand it. Collapsed days are skipped by the arrow
keys. The tool remembers, per folder, which days are collapsed and which file you had
open, so next time you continue where you left off.

## Arrange: the draft's posts

**2 · Arrange** shows the draft: every photo picked and every scene marked is already a
post there, in a gallery sorted by time and grouped by day. Everything is shown in
phone format (9:16) as it will look on the Status.

- **Caption:** photos and videos get no text on the picture. Click a post and write
  its WhatsApp caption on the right (**Win + .** for emoji; flags work too). The
  caption shows under the card. Click **📋 Copy caption** and paste it when posting.
- **Text-only posts:** **＋ Text after** under a post, or **＋ Text post before / after**
  in the editor, inserts one exactly there; there are also bars at the beginning and
  at the end.
- **Day intro:** **＋ Day intro** on a day's header inserts a post in front of that
  day: the date as a heading (e.g. `Montag, 20.10.`) and a Google map with a pin for
  every photo and video of that day that has a location (all files of the day, not
  only the picked ones; spots within ~10 m share one pin). A day whose intro is in an
  earlier release shows **🗺 continues** instead: the release starts it with that intro
  again, marked "Fortsetzung". **Add the day's place
  names** puts a line like `Ubud · Tegallalang` under the date. Needs the Google Maps
  key (see below) with the **Maps Static API** turned on; each map is fetched once and
  kept in `maps\` next to the app.
  The intro's caption automatically gets a **Google Maps link** (the image itself
  can't hold a link): a pin for a day with one place; for several places the own
  [day map](map/README.md) with every pin of the day, numbered in time order (without
  `mapPageUrl` in `settings.json`: the day's area in Google Maps, without pins).
  Days without any location in the files: the intro asks **Where were you?**. Type a
  place (e.g. `Nusa Penida`) to get a pin and the name under the date, or click
  **Leave out location** to show just the date.
- **Rearranging:** drag a card onto another (left half: in front, right half:
  behind), or use **◀ Earlier / Later ▶** in the editor, or **Shift + ← / →**. The
  order is saved; newly picked photos and new scenes slot in by time next to their
  neighbors. Text posts are
  pictures of text on a colored background, with position, style (shadow, dark box,
  light box) and size.
- **Format:** photos and videos keep their original format. The photo goes into the release
  unchanged (same file, only scaled down if it is too big), the video just cut;
  WhatsApp fits it to the screen itself.
- **Location:** photos and phone videos with GPS show their coordinates and an
  **Open in Google Maps** link. Videos without a location (e.g. DJI drone videos) borrow it from the photo
  taken closest in time, within 30 minutes (marked with ≈). **Look up place name**
  asks OpenStreetMap for a name like `Ubud, Bali` (only the coordinates are sent);
  add it to the caption with one click. Names are kept in
  `places.json` next to the app, so each spot is looked up only once.
- **Google Maps place names** (optional): click **Use Google instead…** in a post's
  location section and paste your own Google Maps API key (the window explains how
  to create one: Google Cloud Console → project → billing → enable *Geocoding API* →
  Credentials → API key). With a key saved, place names come from Google; 10,000
  lookups a month are free (as of 2026). The key is stored only in `settings.json`
  next to the app and never shown on the page again; **Remove key** switches back to
  OpenStreetMap.
- **Final sort-out:** **✕ Remove post** (or **Del**) leaves a post out of the release;
  the pick stays (its tile says **Left out**). **Show removed** brings removed posts
  back into view to restore them.
- **Create release ▶** turns the draft into a **release**, ready for WhatsApp (see below).

Captions, the draft and settings are saved in `_posts.json` in the journey's folder. If you change
a scene's start or end later, that scene's post starts without a caption again.

## Releases

A release is everything you want to post, prepared within WhatsApp's limits. It is
self-contained: its folder holds the finished files and all information about them.

```
WhatsApp\Releases\2026-10-26 release 1\
  release.json              overview: which parts belong to this release
  part 1 of 3\              files 01–30
    01_….mp4, 02_….jpg …
    release.json            everything about this part (see below)
    captions.txt            the captions, readable
  part 2 of 3\              files 31–60
  part 3 of 3\              files 61–72
```

- **Parts:** WhatsApp takes at most 30 files at once, so a bigger release is split into
  parts. Files are numbered across all parts, so the order stays clear, and each part
  can be posted on a different day.
- **Every part starts with a day intro, and none ends with one.** An intro that would
  be the last file of a part moves to the next part with its day. A part (or release)
  that begins in the middle of a day starts with that day's intro again: same date, map
  and map link, with **Fortsetzung** under the date and at the start of the caption. A
  day without an intro of its own gets a plain one (date and map). A day intro with
  nothing of its day after it in the release is left out. The release dialog lists all
  of this before you start.
- **Limits:** videos MP4 (H.264), at most 1080p, 9.9 MB and 90 s; longer scenes are split
  into pieces (`…_1of2`, `…_2of2`); photos at most 2560 px (bigger ones are scaled down,
  smaller JPEGs are copied unchanged). The values can be changed with `"releaseLimits"`
  in `settings.json`.
- **Nothing rendered twice:** a video already rendered earlier within the limits (e.g.
  in an earlier release) is copied instead of rendered again.
- **release.json** of a part lists, per file: number, file name, type, source file and
  scene, piece, caption, picture text, format, capture time, location with place name,
  size, resolution, length, and when it was sent.

**Releases** shows the draft on top and then every release, numbered in the order
they were made:

| Section | What's in it |
|---|---|
| **📝 Release N · Draft** | the release being made, with **1 · Pick**, **2 · Arrange**, **3 · Create release ▶** and **Delete draft** (or **＋ New release** if there is none) |
| **📦 Release N · Part K of M** (not fully sent) | the files of that part, numbered as in the folder, with **📤 Publish** |
| **📦 Release N · Part K of M** (sent) | collapsed to one line; click it to look inside |

Releases are listed newest first. **📤 Publish** on a part posts it to your WhatsApp
Status by itself, in order and with captions, in a separate Chrome window where you
sign in to WhatsApp Web once (see [PUBLISHING.md](PUBLISHING.md)). The progress shows above the list;
each post is ticked (`✓ Sent`) as soon as WhatsApp has sent it. If you post a part
yourself, use **✓ Mark as sent** in its header. A single file: select its post and use
**✓ Mark as sent** / **↩ Mark as not sent** in the editor (automatic day intros have
that button on their card). A file marked as not sent goes out with the next Publish of
its part. Double-click a card in a release to see the released
file itself.

- **Sent posts** can't be changed any more (the editor is locked).
- **Posts in a part that isn't sent yet** keep their place, but you can still change
  them. A changed caption, text, color, format or day-intro place marks the card
  **✎ Changed** (and the part `✎ N changed`). **↻ Update in release** in the editor
  brings the release up to date; **Publish** does this by itself before posting. Only
  the changed files are made again; a new caption alone just updates `release.json`
  and `captions.txt`.

## WhatsApp limits (checked October 2026)

- Status video: up to **90 seconds**; longer videos are cut to the first 90 s
  ([WhatsApp: About status](https://faq.whatsapp.com/454876960047011)). Status takes MP4
  or 3GP and has no HD option.
- Video size: 64 MB or 100 MB depending on the connection in the phone app
  ([WhatsApp: Why can't I send long videos](https://faq.whatsapp.com/545917406122452/?locale=en_US)),
  but **WhatsApp Web takes Status videos only up to about 10 MB** (tested). Releases
  use **9.9 MB** (counted as 9,900,000 bytes, so it stays under 10 MB either way).
- Files at once: 30 in older versions, up to 100 in newer ones; releases use 30.
- Sent as a **document**: up to **2 GB** per file, without compression.

## Dates

Files are sorted and grouped by the capture date stored in the file (EXIF for JPEG
photos, creation date for videos). If there is none, the date in the file name is
used (e.g. `IMG-20260712-WA0001.jpg`), and only then the file's last-changed date,
marked with ≈ in the list.

## Where things are saved

- Picked photos: `_favorites.json` in the folder.
- Scenes: next to each video, e.g. `beach.mp4.cuts.json`.
- Releases: `WhatsApp\Releases\` inside the folder (see Releases).

Your original files are never changed.

Your journeys, collapsed days and the last opened file are kept in `settings.json`
next to `server.js`, not in your photo folders.

## Notes

- Only the journey's folder itself is shown, not its subfolders.
- HEIC photos are not shown (browsers can't display them).
- If a video doesn't play, click **Create preview**: a small viewing copy is made in
  your temp folder. Releases still cut from the original.
