# Summit Benchmark

An offline-first PWA that shows your **current elevation** at a glance and logs it
over time. Built so you can keep an eye on altitude in the mountains without a cell
signal.

## Why

Planned for a trip to Yellowstone, Grand Teton, and Rocky Mountain National Parks.
The immediate need is peace of mind about **altitude sickness**: a dead-simple,
always-available readout of "how high are we right now?" so we can correlate
elevation with how we're feeling and decide when to head lower. The secondary goal
is logging elevation across a day of exploring and charting it.

Those parks have long stretches with no cell service, so the app is designed to be
installed to the home screen and run **fully offline**. GPS itself is satellite-based
and works without a signal; only loading the page needs caching, which a service
worker handles.

The name nods to a surveying **benchmark**, a fixed point of known elevation (the
kind literally set into mountain summits), and to the app's "calibrate here"
feature, which uses exactly that idea.

## Status

Working PWA, deployed and installable at **https://summit-benchmark.netlify.app**.

Built so far:

- App shell that installs to the home screen and runs offline (service worker,
  network-first so a new deploy reaches installed devices without a stale-cache lag).
- Live elevation readout from `navigator.geolocation.watchPosition()`, smoothed with
  a rolling median so it does not flicker while you stand still.
- Sea-level calibration in two modes: a one-tap lookup against USGS ground truth
  (EPQS) when online, or a hand-entered known elevation offline. The offset persists
  in `localStorage` and one calibration holds across a region.
- A coarse altitude-sickness band cue that flags the high, very high, and extreme
  bands as you climb.

Still to come: logging each reading to IndexedDB with start/stop sessions, and
charting a day's elevation with uPlot.

## Device compatibility test

Before committing to the build, we verified that the browser Geolocation API actually
reports altitude on the phones we'll carry. That test lives in
[`tools/altitude-test/`](tools/altitude-test/), a single self-contained HTML page
that streams `navigator.geolocation.watchPosition()` and displays altitude, its
accuracy, and whether the device provides it at all.

How to run it: geolocation requires a *secure context* (HTTPS), and a phone can't use
the `localhost` exemption, so the page must be served over HTTPS. We used
[Netlify Drop](https://app.netlify.com/drop) (drag the `tools/altitude-test/` folder,
get an instant HTTPS URL) and opened it on each phone **outdoors** for a real GPS fix.
A live copy of that test is here: **https://silver-gnome-c9e679.netlify.app/**

### Results (2026-08-29)

Ground truth from the USGS EPQS elevation service for the test location (Twin Cities
metro, MN; exact coordinate withheld) was about **903 ft (275 m)** above sea level.

| Device | Reported elevation | vs. USGS truth |
|---|---|---|
| USGS ground truth (orthometric / MSL) | 903 ft | reference |
| iPhone 15 Pro | 890 ft | 13 ft low |
| Galaxy S25 Ultra | 816 ft | 87 ft low |

Both phones report altitude, so the feasibility gate passed. The roughly 74 ft gap
between them is not GPS noise; it is a **reference-frame difference**:

- **iOS returns orthometric height** (above mean sea level). It is geoid-corrected, so
  it matches trail signs and maps almost exactly.
- **Android returns raw ellipsoidal height** (above the WGS84 ellipsoid), which sits
  about 30 m (100 ft) below sea level at this latitude. That offset is the *geoid
  separation*.

So the real build normalizes everything to sea level through calibration. Because the
geoid separation varies by location (the roughly 32 m offset measured here is smaller
out in the mountain west), a single bundled correction would be wrong at the
destination. Instead the app calibrates against a known elevation: a one-tap lookup
against USGS ground truth when online, or a hand-entered value offline. That cancels
geoid separation and device bias in one step, and one calibration holds across a whole
region. (One more note: Android returns `null` for *altitude accuracy* even when
altitude itself is fine, which is cosmetic only.)

## Tech

Vanilla JS, no framework, no build step. Static site on Netlify, which provides the
HTTPS a PWA requires and lets us set cache headers (GitHub Pages would also work).
The service worker handles offline use, and calibration state lives in `localStorage`.
Still to add: IndexedDB for the elevation log and a small vendored charting library
(uPlot) for the graphs.

---

*This project has been developed with AI assistance (Claude Code).*
