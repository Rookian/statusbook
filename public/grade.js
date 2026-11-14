'use strict';
// Colour grading, shared by the page (preview, photo export) and the server (video
// export), so both use the same numbers. A grade is
//   { uw, gains: [r, g, b], brightness, contrast, saturation, warmth, tint }
// uw (0..100) is the strength of a white balance whose channel gains were measured
// from the picture itself (removes the blue-green cast under water); the other values
// run from -50 to 50. Everything together is one colour matrix plus an offset:
//   out = M * in + o   (values 0..1, in the picture's own sRGB values)
(function (root) {
  const SLIDERS = ['brightness', 'contrast', 'saturation', 'warmth', 'tint'];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // A valid grade, or null if it changes nothing.
  function cleanGrade(g) {
    if (!g || typeof g !== 'object') return null;
    const out = { uw: clamp(Math.round(Number(g.uw) || 0), 0, 100) };
    const gains = Array.isArray(g.gains) && g.gains.length === 3 ? g.gains.map(x => clamp(Number(x) || 1, 0.4, 3)) : null;
    if (out.uw > 0 && gains) out.gains = gains.map(x => Math.round(x * 1000) / 1000); else out.uw = 0;
    for (const k of SLIDERS) out[k] = clamp(Math.round(Number(g[k]) || 0), -50, 50);
    return out.uw || SLIDERS.some(k => out[k]) ? out : null;
  }

  function gradeMatrix(g) {
    const s = g.uw / 100, w = g.warmth / 50, t = g.tint / 50;
    const u = g.gains || [1, 1, 1];
    const gain = [
      (1 + (u[0] - 1) * s) * (1 + 0.25 * w) * (1 + 0.1 * t),
      (1 + (u[1] - 1) * s) * (1 - 0.2 * t),
      (1 + (u[2] - 1) * s) * (1 - 0.25 * w) * (1 + 0.1 * t),
    ];
    const sat = 1 + g.saturation / 50;          // 0 .. 2
    const k = 1 + (g.contrast / 50) * 0.8;      // 0.2 .. 1.8
    const b = (g.brightness / 50) * 0.3;
    const L = [0.2126, 0.7152, 0.0722];
    const m = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) m.push(k * ((r === c ? sat : 0) + (1 - sat) * L[c]) * gain[c]);
    }
    const o = 0.5 - 0.5 * k + b;
    return { m, o: [o, o, o] };
  }

  // Short name for a grade: SVG filter id, LUT file name, "changed since the release".
  function gradeId(g) {
    if (!g) return '';
    const str = [g.uw, ...(g.gains || []), ...SLIDERS.map(k => g[k])].join(',');
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return 'g' + h.toString(16);
  }

  // A .cube 3D LUT of the grade, for ffmpeg's lut3d filter.
  function gradeCube(g, n = 33) {
    const { m, o } = gradeMatrix(g);
    const lines = [`LUT_3D_SIZE ${n}`];
    const f = v => clamp(v, 0, 1).toFixed(5);
    for (let bi = 0; bi < n; bi++) {
      for (let gi = 0; gi < n; gi++) {
        for (let ri = 0; ri < n; ri++) {
          const r = ri / (n - 1), gg = gi / (n - 1), b = bi / (n - 1);
          lines.push(`${f(m[0] * r + m[1] * gg + m[2] * b + o[0])} ${f(m[3] * r + m[4] * gg + m[5] * b + o[1])} ${f(m[6] * r + m[7] * gg + m[8] * b + o[2])}`);
        }
      }
    }
    return lines.join('\n') + '\n';
  }

  // RGBA pixels (Uint8ClampedArray of a canvas), graded in place.
  function gradePixels(d, g) {
    const { m, o } = gradeMatrix(g);
    const o0 = o[0] * 255, o1 = o[1] * 255, o2 = o[2] * 255;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      d[i] = m[0] * r + m[1] * gg + m[2] * b + o0;
      d[i + 1] = m[3] * r + m[4] * gg + m[5] * b + o1;
      d[i + 2] = m[6] * r + m[7] * gg + m[8] * b + o2;
    }
  }

  // Channel gains that make the picture's average colour neutral ("gray world"),
  // from RGBA pixels. Limited, so a nearly missing red is not blown up into noise.
  function grayWorldGains(d) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    if (!n) return [1, 1, 1];
    r /= n; g /= n; b /= n;
    const mean = (r + g + b) / 3;
    return [r, g, b].map(v => Math.round(clamp(mean / Math.max(v, 1), 0.5, 2.6) * 1000) / 1000);
  }

  const api = { SLIDERS, cleanGrade, gradeMatrix, gradeId, gradeCube, gradePixels, grayWorldGains };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Grade = api;
})(typeof window !== 'undefined' ? window : globalThis);
