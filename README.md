<p align="center">
  <img src="docs/banner.svg" alt="Statusbook: travel releases for your WhatsApp Status" width="100%">
</p>

<p align="center">
  <b>Turn the photos and videos of a trip into WhatsApp Status posts: picked, cut, captioned,<br>
  put in order, and published part by part, from your PC.</b>
</p>

---

## Why this exists

On a trip through Indonesia I wanted to share the journey with family and friends, day by
day, on WhatsApp Status. That's where everyone already is: no new app, no social network,
no album link that nobody opens.

The reality of doing that from a phone was less fun:

- **Hundreds of files.** Phone photos, drone flights, snorkeling clips. Finding the good ones
  on a small screen takes forever.
- **Long videos.** A drone flight is minutes long, but Status shows at most **90 seconds**
  per video, and the interesting bit is usually 10 seconds somewhere in the middle.
- **Hidden limits.** WhatsApp Web quietly refuses Status videos over **about 10 MB**, takes
  **30 files** at a time, and doesn't allow line breaks in captions.
- **One by one.** Every post needs its file, its caption and the right order, and none of it
  can be posted in one go.
- **No context.** Twenty photos in a row don't tell a story. Which day was that, and where
  were we?

So I built a small tool that runs on my own PC: pick the best moments on a big screen, cut
the scenes, write the captions, add a short intro for each day with a map, and send it all
to WhatsApp Status in the right order, within WhatsApp's limits, without touching the phone.

## How it works

Everything lives in a **journey**: one trip, one folder with all its photos and videos.
Inside a journey you put together **releases**, the batches you post to your Status.

| Step | What you do |
|---|---|
| **1. New release** | Start the next release of the journey. There is always one draft at a time. |
| **2. Pick** | Browse every photo and video by day. **F** picks a photo or a whole video, **I** / **O** mark a scene in a video. Files that went out in an earlier release are locked, so nothing is posted twice. |
| **3. Arrange** | Each pick is a post. Write captions, add text posts, put the posts in order, and add a **day intro** (date, map with a pin for every spot, Google Maps link). |
| **4. Create release** | Statusbook makes the files: photos scaled if needed, scenes cut to MP4 under 9.9 MB, long scenes split into 90-second pieces, and the whole thing split into parts of 30. Every part starts with a day intro. |
| **5. Publish** | One click per part posts it to your WhatsApp Status through WhatsApp Web, in order and with captions. Each post is ticked as sent. Parts can go out on different days. |

## Features

**Picking**
- A gallery of all photos and videos, grouped by day, with soft thumbnail tiles
- At a glance which files are picked, already in a release, or already sent
- Frame-accurate scene marking with a timeline; videos the browser can't play get a preview copy
- The journey's folder is watched: files you copy in show up by themselves

**Arranging**
- Posts in phone format (9:16), exactly as they will look on the Status
- Captions with emoji, text-only posts in any color, and free reordering by drag and drop
- Day intros with a map of the day's spots (Google Maps Static API) and a Google Maps link in the caption
- When a day continues in the next part, a "Fortsetzung" intro is added automatically
- Locations from photo EXIF and video metadata; drone videos borrow the location of the nearest photo
- Place names from OpenStreetMap, or from Google with your own API key

**Releasing and publishing**
- Self-contained release folders with the files, a `release.json` per part and readable captions
- WhatsApp's limits are checked and applied automatically
- Built-in publishing through WhatsApp Web (Chrome, signed in once with the QR code)
- Changes after a release was made are detected and updated before publishing
- Single files or whole parts can be marked as sent or not sent by hand

**Comfort**
- Several journeys, each with its own folder; the tool opens in the last one
- A calm, light design in limestone and lagoon colors
- Runs completely offline, except for maps, place names and WhatsApp itself

## Getting started

**You need**
- Windows 10 or 11
- [Node.js](https://nodejs.org/) (LTS) and [ffmpeg](https://ffmpeg.org/):
  ```
  winget install OpenJS.NodeJS.LTS
  winget install Gyan.FFmpeg
  ```
- Google Chrome, to publish to WhatsApp Web
- Optional: a Google Maps API key with the *Geocoding API* and *Maps Static API* turned on,
  for place names and day maps. The tool explains how to get one.

**Install and run**
```
git clone <this repository>
cd statusbook
npm install
```
Then double-click **Start.bat**. Your browser opens with Statusbook; create a journey,
choose the folder with your trip's photos and videos, and start your first release.

## Privacy

- Everything runs on your PC. Your photos never leave it, except the files you publish to
  WhatsApp yourself.
- Only coordinates are sent for place names and maps (to OpenStreetMap or Google), and only
  when you ask for them.
- Your Google API key, your journeys and the signed-in WhatsApp Web session are stored only
  in the app folder (`settings.json`, `whatsapp-profile/`). Both are excluded from git.
- Picks, captions and releases are stored in the journey's own folder, next to the photos.

## WhatsApp limits used

| Limit | Value |
|---|---|
| Status video length | 90 s (longer scenes are split into pieces) |
| Status video size via WhatsApp Web | 9.9 MB (WhatsApp Web refuses larger ones) |
| Video format | MP4, H.264/AAC, at most 1080p |
| Photo size | at most 2560 px on the longer side |
| Files per part | 30 |
| Captions | one line (WhatsApp Web sends on Enter) |

The values can be changed with `"releaseLimits"` in `settings.json`.

## Project layout

```
server.js        local web server: folders, thumbnails, releases, ffmpeg, maps
publisher.js     publishing to WhatsApp Web (playwright-core with your installed Chrome)
public/          the app in the browser: app.js (Pick), posts.js (Releases, Arrange),
                 journeys.js, icons.js, style.css, index.html
tools/           helpers, e.g. shrink-part.js to shrink the videos of a part
docs/            user guide, publishing notes, banner
Start.bat        starts the server and opens the browser
```

## Documentation

- [User guide](docs/GUIDE.md): every screen and option in detail
- [Publishing](docs/PUBLISHING.md): how publishing to WhatsApp Web works, and what to do if it stops

## Good to know

Statusbook is a personal project and is not affiliated with, endorsed by, or connected to
WhatsApp or Meta. Publishing works by operating WhatsApp Web in a normal Chrome window, the
same way you would by hand; it only posts what you confirm, to your own Status. Automating
WhatsApp Web may not be covered by WhatsApp's terms, and it can stop working whenever
WhatsApp changes its website. Use it for your own account and at your own risk.

## License

No license has been chosen yet. Until then, all rights are reserved by the author.
