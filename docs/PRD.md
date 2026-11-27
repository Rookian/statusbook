# Statusbook: Product Requirements Document

| | |
|---|---|
| **Product** | Statusbook (repository: `statusbook`, folder: `MediaPicker`) |
| **Document type** | PRD, as built: describes the product as it is today, not a roadmap |
| **Status** | Current as of 27 November 2026 |
| **Owner** | Alex (product owner and only user so far) |
| **Audience** | The product team: product, design and engineering |
| **Related** | [README](../README.md) (overview), [User guide](GUIDE.md), [Publishing](PUBLISHING.md) |

---

## 1. Summary

Statusbook turns the photos and videos of a trip into a series of WhatsApp Status posts.
The traveler picks the best moments on a PC, cuts video scenes, writes captions, adds day
intros, maps and collages, and publishes everything to WhatsApp Status in the right order,
within WhatsApp's limits, in one click.

It is a local web app: a Node.js server on the traveler's Windows PC and a browser UI.
Publishing works by operating WhatsApp Web in a Chrome window, the way a person would.

## 2. Problem

Sharing a trip day by day on WhatsApp Status is attractive: the audience (family and
friends) is already there, no new app or album link is needed. Doing it from a phone is
slow and error-prone:

| Pain | Detail |
|---|---|
| Volume | Hundreds of files per week: phone photos, drone flights, snorkeling clips. Finding the good ones on a small screen takes long. |
| Long videos | A drone flight lasts minutes; the good moment is 10 seconds somewhere in it. Status shows at most 90 s per video. |
| Hidden limits | WhatsApp Web refuses Status videos over about 10 MB, shows no HD for Status, and its caption field takes no line breaks. |
| Manual posting | Every post needs its file, caption and position; nothing can be posted in one go. |
| Order and duplicates | Status shows posts in the order they were sent. Posting a day late or twice breaks the story. |
| No context | Twenty photos in a row don't tell where and when. |
| Quality | WhatsApp compresses heavily; badly prepared videos look blocky. |

## 3. Goals and non-goals

**Goals**
- G1: From a folder of trip media to published Status posts with as few steps as possible.
- G2: The audience sees a coherent story: chronological, with days and places, with context.
- G3: Nothing is posted twice, nothing is lost, and every post's state is visible.
- G4: Media look as good as WhatsApp allows.
- G5: Everything stays on the traveler's PC; the original files are never changed.

**Non-goals (today)**
- Other networks than WhatsApp Status (Instagram, chats, groups).
- Several users, sharing or collaboration; cloud hosting.
- Mobile app; macOS or Linux as a supported platform.
- Editing media beyond what posting needs (no full photo or video editor).
- Uploading to cloud storage itself (exports go to a folder; cloud sync is the user's tool).

## 4. Users

| Persona | Needs |
|---|---|
| **The traveler (primary)** | Often on the road with limited time and patchy internet. Wants to share every few days in batches, with good quality, without fiddling on the phone. Writes captions in German. Uses a Windows laptop, a phone and a drone or action camera. |
| **The audience (indirect)** | Family and friends who watch the Status on their phones. A status disappears after 24 hours, so they see a few days at a time and in order. |

## 5. Product principles

These rules explain many decisions below and should guide new ones.

1. **Never post twice, never lose a post.** Every post's state (new, in a release, sent) is
   tracked. A post whose fate is unclear is not repeated automatically; the user decides.
2. **Chronological on WhatsApp.** Status shows posts in posting order. Releases are cut at
   day boundaries, earlier parts go first, and warnings appear before anything goes out of order.
3. **Originals are sacred.** Rotation, crop, colour grade and speed are settings; files for
   WhatsApp are made from the originals, which are never changed.
4. **Ask before anything risky or irreversible.** Publishing, marking a whole release as sent,
   deleting a draft. Small reversible actions need no confirmation.
5. **Show only what matters to the user.** Progress as "Post 5 of 33", errors in plain words
   with a next step, technical details only on demand.
6. **Recover by itself where it is safe.** Retries before a post is sent, maps reloaded when
   back online, interrupted runs continue where they stopped.
7. **Work offline.** Picking and composing work without internet; only maps, place names,
   spelling, AI identification and WhatsApp need a connection.

## 6. Concepts and glossary

| Term | Meaning |
|---|---|
| **Journey** | One trip: a name and one folder with all its photos and videos. Several journeys can exist; the app opens the last one. |
| **File** | A photo or video in the journey folder. |
| **Favorite (♥)** | A file the user loves (F). Independent of releases; has its own view. |
| **Pick** | A photo chosen for the release being made (P). |
| **Scene** | A marked part of a video (I / O), optionally slowed down. Each scene is one post. |
| **Draft** | The release being put together. There is at most one. All picks and scenes not yet released belong to it. |
| **Post** | One Status item: a photo, a video scene, a text post, a day intro, a map summary or a collage. |
| **Text post** | Text only. Goes out as WhatsApp's own text status. |
| **Day intro** | A post with the date and a map of the day's spots, placed before the day's first post. |
| **Map summary** | Like a day intro, for a week, any time frame or the whole release. |
| **Collage** | Two to four photos as one picture, in one of 10 designs. |
| **Release** | A numbered batch of posts made into files and published together (Release 1, 2, …). |
| **Part** | Legacy: older releases were split into parts of 30 files. New releases have one part. |
| **Sent** | A post confirmed as posted to WhatsApp Status. |

## 7. End-to-end flow

```mermaid
flowchart LR
  A[Journey folder] --> B[Pick: choose photos, mark scenes]
  B --> C[Compose: captions, order, intros, maps, collages]
  C --> D[Review & publish: choose days, checks, spelling]
  D --> E[Files made within WhatsApp limits]
  E --> F[Posted to WhatsApp Status, one by one]
  F --> G[Releases: state of every post]
  G --> H[Export sent scenes in original quality]
  D -. later days stay in the draft .-> C
```

Typical use: every few days the traveler copies new media into the journey folder, opens
the draft, picks and composes, and publishes the first one or two days of the draft.

## 8. Functional requirements

Requirement IDs are stable references for discussions and tickets. All listed requirements
are implemented.

### 8.1 Journeys

| ID | Requirement |
|---|---|
| JRN-01 | Create, rename and switch journeys; each has a name and exactly one folder. |
| JRN-02 | The app opens in the last journey and in the last view (step) used. |
| JRN-03 | The journey folder is watched: new files appear without a restart. Subfolders are not shown. |
| JRN-04 | Files are dated by their capture date (EXIF, video metadata), else a date in the file name, else the file date (marked ≈). |

### 8.2 Pick

| ID | Requirement |
|---|---|
| PCK-01 | Gallery of all files, oldest first, grouped by day, with counts of files, picks, released and sent files per day. |
| PCK-02 | Each tile shows its state: picked, in Release N, sent, left out, favorite. |
| PCK-03 | P picks a photo for the draft; F marks a favorite. Without a draft nothing can be picked; the UI offers "New release". |
| PCK-04 | Videos: frame-accurate scene marking (I / O) on a timeline that shows scene lengths; scene ends can be dragged. |
| PCK-05 | Per scene speed: 1×, ¾, ½, ¼ (S). Sound is stretched with the picture. |
| PCK-06 | A released file is locked: it cannot be picked again and its scenes cannot change (prevents duplicates). |
| PCK-07 | Days already released are hidden in Pick, with a marker where the new release starts (B jumps there, L to the last pick). |
| PCK-08 | Keyboard-first: arrows move between files, Space plays, ← / → always change the file, C collapses a day. Position and collapsed days are remembered per journey. |
| PCK-09 | Videos the browser can't play get a small preview copy; releases are still made from the original. |

### 8.3 Media settings (non-destructive)

| ID | Requirement |
|---|---|
| MED-01 | Rotate (R / Shift+R), crop with shape presets (K), colour grade with presets and an AI "auto" grade (G), choose the video thumbnail frame (T). |
| MED-02 | Settings are stored per file in the journey folder and applied when release files are made (photos via canvas, videos via ffmpeg). |
| MED-03 | One full-screen viewer everywhere (Pick, Compose, Releases): zoom by wheel or pinch, a strip of the files grouped by day, the same keys. In Compose and Releases it shows only the files of that draft or release. |

### 8.4 Compose (the draft's posts)

| ID | Requirement |
|---|---|
| CMP-01 | Every pick and scene is a post automatically, sorted by time; posts can be reordered by drag and drop or Shift+← / →. |
| CMP-02 | Posts are previewed in 9:16 as they will look on the phone. |
| CMP-03 | Captions with emoji; they go to WhatsApp as one line (WhatsApp Web sends on Enter). Photos and videos carry no text on the picture. |
| CMP-04 | Text posts anywhere, in a choice of background colours; they go out as WhatsApp text status. Texts over about 650 characters are split into numbered statuses at paragraph, sentence or word boundaries. |
| CMP-05 | Day intro per day: date (German), a map of all spots of that day (Google Maps Static API), place names on request, a Google Maps link in the caption. Days without locations: a place can be typed in, or the location left out. |
| CMP-06 | Map summary for a week (Monday to Sunday), any from–to range, or the whole release (follows the days being published; fixed once released). Text describes the time frame until the user writes one. Many spots are merged so the map stays readable (at most 60 pins). |
| CMP-07 | Spots on the map of a day intro or map summary can be left out one by one (list with picture, day and time). At least one stays. |
| CMP-08 | Map links with several pins open an own map page (GitHub Pages) showing all pins; one pin opens Google Maps there. |
| CMP-09 | Collages: two to four photos as one post, 10 designs (polaroids with tape, postcard with stamp, film strip, diagonal cut, slanted bands, tilted tiles, pin wall, honeycomb …), paper colour, drag and zoom a photo in its frame. Its photos are no posts of their own; "Split up" restores them with their captions. |
| CMP-10 | Location per post from EXIF or video metadata; drone videos without GPS borrow the location of the nearest photo in time. Place names and nearby sights from OpenStreetMap, or from Google with the user's key. |
| CMP-11 | Animal identification (A) with the user's AI key (Claude, Gemini or OpenAI): German and English names, on demand, optionally for a marked frame. |
| CMP-12 | A post can be removed from the draft without unpicking it; a deleted draft unpicks everything of it. |

### 8.5 Review & publish

| ID | Requirement |
|---|---|
| REV-01 | One window: choose up to which day to publish (default: the first two days of the draft; "all days" possible). Later days stay in the draft and become the next release. |
| REV-02 | Shows the posts in order as thumbnails, the number of posts, and checks with a "Show" link to the post: posts without caption, videos that are split, day intros added automatically. |
| REV-03 | Spelling of captions and texts is checked when the window opens (LanguageTool, German); fixes and "ignore" in place. Publish reuses the result. |
| REV-04 | Videos are measured: a clip that would look blocky within 9.9 MB is split into equal posts of at least 5 s (can be turned off). A spinner shows while videos are checked. |
| REV-05 | One "Publish N posts" button: makes the files, then posts them; progress and Stop in the same window. |
| REV-06 | A release that begins in the middle of a day starts with that day's intro again, marked "Fortsetzung"; a day intro with nothing after it is left out. |

### 8.6 Release files

| ID | Requirement |
|---|---|
| FIL-01 | Each release is a self-contained folder `WhatsApp\Releases\<date> release <n>` with numbered files in posting order, `release.json` (manifest) and `captions.txt`. |
| FIL-02 | Photos: JPEG within 2560 px copied unchanged; otherwise drawn with rotation, crop and grade as JPEG. |
| FIL-03 | Videos: MP4 H.264/AAC, at most 720p and 30 fps, bitrate chosen to stay under 9.9 MB, longer than 90 s split into pieces; an earlier identical render is reused. |
| FIL-04 | Text posts, day intros, map summaries and collages are rendered as 1080×1920 pictures (text posts are still sent as text status). |
| FIL-05 | Changes to a post after its release was made but before it was sent are detected (caption, picture, spots, crop, grade, speed) and the file is updated before publishing. |

### 8.7 Publishing to WhatsApp

| ID | Requirement |
|---|---|
| PUB-01 | Publishing runs in a separate Chrome window with WhatsApp Web, signed in once by QR code and kept signed in. Controls are found by their names, not screen positions. |
| PUB-02 | Posts go out one by one in order; each is ticked as sent as soon as WhatsApp confirms it. |
| PUB-03 | A post that fails before Send is retried automatically up to three times (the last time after reloading WhatsApp Web). A file WhatsApp refuses is not retried. |
| PUB-04 | After Send the app waits up to 10 minutes and says so after one minute ("connection seems slow"). If still unconfirmed, it asks: "Did post N arrive?" with "It is there: continue" and "It is not there: send it again". It never re-sends on its own. |
| PUB-05 | When publishing stops, the reason is shown in plain words (window closed, file refused, not signed in, …) with "Continue". A release with posts left shows "Continue publishing (n left)". |
| PUB-06 | Stop after the current post at any time. A running or stopped publish is shown again after a page reload. |
| PUB-07 | Text posts: the WhatsApp background closest to the post's colour is chosen; each text is read back before sending. Captions are checked after typing. |

### 8.8 Releases overview

| ID | Requirement |
|---|---|
| REL-01 | Releases page: the draft on top, then all releases newest first, each with state (sent, n of m sent, ready), days, number of posts and send date. |
| REL-02 | A total on top: how many photos and videos were sent (photos in collages count; a split video counts once), in how many releases, and how many are made but not sent. |
| REL-03 | A draft published in part says which days went out as which release and which are still to publish; the release made from it is marked "rest in Release N (draft)". |
| REL-04 | The days of a release are taken from the files as sent (a text post belongs to the day before it), not from today's order in Compose. |
| REL-05 | Single posts can be marked as sent or not sent by hand; doing it for a whole release asks first and says that nothing is posted. |
| REL-06 | Legacy releases with several parts stay readable and publishable part by part, with a warning before a later part goes out first. |

### 8.9 Export of sent scenes

| ID | Requirement |
|---|---|
| EXP-01 | Every video scene that was sent is cut from its original without re-encoding (picture and sound as recorded) into a folder of the user's choice, e.g. a Google Drive folder synced by Google Drive for desktop. |
| EXP-02 | Each scene is exported once; the record survives moving the files or choosing another folder. "Export again" is possible. |
| EXP-03 | The folder is checked first (exists or can be made, writable, a local path, not a web address, drive answers); missing space is warned about with the estimated size. Errors appear under the folder field. |
| EXP-04 | Progress, Stop, and a clean stop when the drive is full or disappears; the next run continues. |

### 8.10 App behaviour

| ID | Requirement |
|---|---|
| APP-01 | Starts with `Start.bat`; the browser opens the app. The app updates itself: the page reloads and the server restarts when its files change. |
| APP-02 | Maps that failed (e.g. offline) are loaded again when the PC is back online, when needed again, and before a file is made. |
| APP-03 | The browser must not translate the app (it would change captions on screen). |
| APP-04 | Messages appear above open windows; errors stay until read where they block a task. |

## 9. Constraints and dependencies

| Area | Constraint |
|---|---|
| WhatsApp Status | 90 s per video; no HD; text status about 700 characters; posts shown in posting order; statuses expire after 24 h. |
| WhatsApp Web | Status videos above about 10 MB are refused (tested again on 14 Nov 2026: 8.6 MB accepted, 12.8 MB refused); captions single-line; UI can change at any time. |
| Platform | Windows 10/11, Node.js LTS, ffmpeg, Google Chrome (or Edge). |
| Google Maps (optional, user's key) | Maps Static API for day maps and summaries; Geocoding for place names. |
| OpenStreetMap | Place names and nearby sights without a key (Nominatim, Overpass). |
| LanguageTool | Free public API for German spelling; rate-limited, so checked once per text. |
| AI providers (optional, user's key) | Claude, Gemini or OpenAI for animal identification and auto colour grade. |
| Terms | Automating WhatsApp Web may not be covered by WhatsApp's terms; used for the owner's own account at normal pace. |

## 10. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-01 Privacy | Media never leave the PC except the files posted to WhatsApp. Only coordinates go to map and place services, only on use. Keys and the WhatsApp session stay in the app folder and are excluded from git. |
| NFR-02 Data ownership | Journey data lives in the journey folder next to the media (see section 11), so a journey can be moved or backed up with its folder. |
| NFR-03 Safety | Originals are never modified. Destructive or irreversible actions ask first. |
| NFR-04 Reliability | Publishing state is written after every confirmed post; interruptions (crash, closed window, lost connection) lose nothing and never cause a duplicate post. |
| NFR-05 Performance | Thumbnails and previews are made once and cached; long video renders run as server jobs that survive dropped connections. |
| NFR-06 Language | The UI is English. Content for the audience (dates on intros, automatic texts, spelling) is German. |

## 11. Data and storage

| What | Where |
|---|---|
| Picks, favorites, rotation, crop, grade, thumbnails, species | `_favorites.json`, `_loved.json`, `_rotations.json`, `_crops.json`, `_grades.json`, `_thumbs.json`, `_species.json` in the journey folder |
| Scenes and their speed | `<video>.cuts.json` next to each video |
| Posts: captions, order, text posts, intros, map summaries, collages, draft | `_posts.json` in the journey folder |
| Exported scenes record | `_exported.json` in the journey folder |
| Releases and sent state | `WhatsApp\Releases\…\release.json` (per release and per part) |
| Journeys, view state, API keys, limits, export folder | `settings.json` in the app folder |
| WhatsApp Web sign-in | `whatsapp-profile\` in the app folder |
| Thumbnails, previews, map images | Temp folder and `maps\` (caches, can be deleted) |

## 12. Current usage

Journey "Indonesia 2026", as of 24 November 2026:

| Metric | Value |
|---|---|
| Files in the journey | 1,248 photos and videos |
| Releases published | 11 |
| Photos and videos sent | 503 (261 photos, 242 videos) |
| Posts in releases | about 509, including day intros and text posts |

## 13. Known limitations

- Windows only; one user; one journey folder without subfolders.
- HEIC photos are not shown (browsers can't display them).
- Publishing depends on WhatsApp Web's page; a change there can stop it until the publisher is adapted.
- Video quality is bounded by the 9.9 MB Web limit; long busy clips are split rather than kept whole.
- WhatsApp re-compresses after upload; the final look on phones is not measured by the app.
- Phone HDR videos are converted to normal video without colour conversion; colours can shift slightly.
- The user guide (`GUIDE.md`) still describes some earlier behaviour (e.g. parts of 30, "Create release", F for picking).
