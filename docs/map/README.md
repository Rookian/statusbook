# Day map (map page for day intro links)

A Google Maps link can show only one pin. For days with several places, Statusbook links
to this page instead: it shows every pin of the day on an OpenStreetMap map, numbered in
time order; tapping a pin offers "In Google Maps öffnen".

The link carries everything after `#` (`#t=<title>&p=<pins>`), so the page stores
nothing and never changes. It is published with GitHub Pages from the `docs/` folder:

    https://rookian.github.io/statusbook/map/

Statusbook uses it when `settings.json` has

    "mapPageUrl": "https://rookian.github.io/statusbook/map/"

Without `mapPageUrl`, day intros with several places link to the Google Maps area instead.
