// Re-renders the videos of one release part that are over the WhatsApp Web limit,
// from the original scene, so they stay under maxMB. Backs up the replaced files.
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
// Usage: node tools/shrink-part.js "<release part folder>" "<backup folder>" [maxMB=9.9]
// 1 MB = 1,000,000 bytes here (as in server.js), so 9.9 MB stays under WhatsApp Web's 10 MB.
const [partDir, backupDir, maxMB = '9.9'] = process.argv.slice(2);
const FF = process.env.LOCALAPPDATA + '/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin/ffmpeg.exe';
const SRC = 'D:/Indonesia 2026';
const limit = Number(maxMB) * 1000 * 1000;
const mf = path.join(partDir, 'release.json');
const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
fs.mkdirSync(backupDir, { recursive: true });
for (const it of m.items) {
  if (it.type !== 'video' || it.size <= limit) continue;
  const out = path.join(partDir, it.file);
  fs.copyFileSync(out, path.join(backupDir, it.file));
  const dur = it.end - it.start;
  let kbps = Math.max(500, Math.min(8000, Math.floor(limit * 8 * 0.9 / 1000 / dur) - 160));
  for (let attempt = 1; ; attempt++) {
    const tmp = out + '.new.mp4';
    execFileSync(FF, ['-y', '-v', 'error', '-ss', String(it.start), '-t', String(dur), '-i', path.join(SRC, it.source),
      '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '0', '-write_tmcd', '0',
      '-vf', "scale='min(iw,1920)':'min(ih,1920)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp]);
    const size = fs.statSync(tmp).size;
    if (size <= limit || attempt >= 3) {
      fs.renameSync(tmp, out);
      console.log(`${it.file}: ${(it.size / 1e6).toFixed(1)} MB -> ${(size / 1e6).toFixed(1)} MB (${kbps} kbit/s, try ${attempt})${size > limit ? '  STILL TOO BIG' : ''}`);
      it.size = size;
      break;
    }
    kbps = Math.floor(kbps * 0.75);
  }
}
fs.writeFileSync(mf + '.tmp', JSON.stringify(m, null, 2));
fs.renameSync(mf + '.tmp', mf);
console.log('release.json updated');
