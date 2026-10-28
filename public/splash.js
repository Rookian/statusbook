'use strict';
// The start splash (index.html, #splash): the logo assembles itself, then fades into the
// app. Shown once per browser session; with "reduce animations" only briefly and still.
(function splash() {
  const el = document.getElementById('splash');
  if (!el) return;
  let seen = false;
  try { seen = sessionStorage.getItem('statusbook-splash') === '1'; } catch { /* storage unavailable */ }
  if (seen) { el.remove(); return; }
  try { sessionStorage.setItem('statusbook-splash', '1'); } catch { /* storage unavailable */ }
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const show = still ? 700 : 2900;    // the logo is complete after about 2.3 s
  const hide = () => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 700);
  };
  const wait = Math.max(0, show - performance.now());
  // A click or key skips the rest.
  const skip = () => { clearTimeout(timer); hide(); };
  const timer = setTimeout(hide, wait);
  el.addEventListener('click', skip, { once: true });
  window.addEventListener('keydown', skip, { once: true });
})();
