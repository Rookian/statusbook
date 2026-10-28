# Publishing a release part to WhatsApp Status

## With the Publish button (no chat needed)

1. **Releases** → on a release part that isn't fully sent, click **📤 Publish**.
2. Confirm the part. Each part is confirmed on its own, so parts can go out on
   different days. Posts changed after the release was made are updated in the
   release first.
3. **First time only:** a separate Chrome window with WhatsApp Web opens. Sign in once:
   on the phone, WhatsApp → Linked devices → Link a device, then scan the QR code. The
   sign-in is kept in `whatsapp-profile\` next to the app.
4. The tool posts the part in that window, in order, with captions. The panel at the
   top shows the progress; each post is ticked as sent as soon as WhatsApp has sent it.
5. **■ Stop after this post** pauses. If something goes wrong, it stops and shows why.
   Publish again continues with the rest; nothing is posted twice.

How it works: `publisher.js` controls that Chrome window with Playwright
(`playwright-core`, uses the installed Chrome). It finds WhatsApp Web's controls by
their names ("Status", "Add Status", "Photos & videos", "Add a caption", "Send"), not
by screen positions, and closes WhatsApp notices that cover the page (welcome,
notifications) only with harmless buttons (OK, Got it, Not now, Close …) or Escape.

Automated posting counts as automated use under WhatsApp's terms. At this volume
(your own account, normal pace) problems are unlikely, but can't be ruled out.

## Limits to keep in mind

- **Videos ≤ 9.9 MB** (9,900,000 bytes). WhatsApp Web silently refuses Status videos
  over about 10 MB: the edit screen just doesn't open, and Publish stops with
  "WhatsApp did not accept …". New releases use 9.9 MB by default. Older parts with
  bigger videos: shrink them first, from the original scene, with a backup:

  ```
  node tools/shrink-part.js "D:\Indonesia 2026\WhatsApp\Releases\2026-10-26 release 1\part 2 of 3" "%TEMP%\mp-backup-part2" 9.9
  ```

- **Captions are single-line.** WhatsApp Web's caption field doesn't take line breaks
  (Enter sends). Multi-line captions are joined with a space; each caption is checked
  after typing, before sending.

## Testing without posting

`POST /api/publish/start` with `"dryRun": true` (and optionally `"limit": 3`) goes
through every step except Send and ticks nothing.
