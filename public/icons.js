'use strict';
// A small set of line icons, drawn for this tool (24×24, stroked in the text color),
// so nothing has to be loaded from the internet.
//   ic('send')                      -> an <svg> element, e.g. el('button', {}, ic('send'), 'Publish')
//   <span data-icon="send"></span>  -> filled in when the page loads
const ICONS = {
  back: 'M19 12H5M11 6l-6 6 6 6',
  releases: 'M12 4l8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4',
  pick: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM9 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM20 15l-4.5-4.5L6 20',
  arrange: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  settings: 'M4 7h9M17 7h3M15 5v4M4 12h3M11 12h9M9 10v4M4 17h11M19 17h1M17 15v4',
  send: 'M20 4L4 11l6.5 2.5L13 20zM10.5 13.5L20 4',
  package: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  trash: 'M5 7h14M10 11v6M14 11v6M6.5 7l1 13h9l1-13M9.5 7V4.5h5V7',
  folder: 'M4 7.5A1.5 1.5 0 0 1 5.5 6h4l2 2h7A1.5 1.5 0 0 1 20 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  plus: 'M12 5v14M5 12h14',
  leaf: 'M5 19C5 11 10 5 20 5c0 10-6 15-14 15M5 19l7-7',
  waves: 'M3 10c3-3 6 3 9 0s6 3 9 0M3 15c3-3 6 3 9 0s6 3 9 0',
  down: 'M6 9l6 6 6-6',
  right: 'M9 6l6 6-6 6',
  next: 'M5 12h14M13 6l6 6-6 6',
  play: 'M8 5v14l11-7z',
};

function ic(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name] || '');
  svg.append(path);
  return svg;
}

// Placeholders keep their own classes (e.g. "journeys-only"), so they still show and hide.
document.querySelectorAll('[data-icon]').forEach(s => {
  const svg = ic(s.dataset.icon);
  if (s.className) svg.setAttribute('class', `${svg.getAttribute('class')} ${s.className}`);
  s.replaceWith(svg);
});
