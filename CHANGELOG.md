# Changelog

This project follows Semantic Versioning. Dates are ISO 8601.

## Unreleased

### Fixed

- `tabs.history` no longer hides why going back or forward failed. The end of the history is
  still `not_found`, now with Chrome's message, and any other failure is `internal` with
  Chrome's message instead of a misleading `not_found`.

## 0.1.0 - 2026-09-23

The first release. It speaks protocol version 1 with hypruse's `browser-host`.

### Added

- A Manifest V3 service worker that connects to the native host `dev.hypruse.browser`, sends a
  hello first on every connection, and reconnects with backoff and a 30 second alarm.
- Tab operations: `tabs.list`, `tabs.activate`, `tabs.open` (http and https only),
  `tabs.close` and `tabs.history`, plus `sites.top` from Chrome's most visited sites.
- `page.snapshot`: named, visible and reachable elements in reading order, with search boxes
  recognised, repeated items numbered as lists, and an optional wait for the page to settle.
- `page.click`, `page.type` and `page.scroll`, which act only on the latest snapshot of a page
  and answer `stale_snapshot` once the page has moved on.
- Typing that refuses password and payment card fields. Snapshots never contain field values.
- `tabs.changed` events, at most one per tab every 200 ms.
- An extension ID pinned by a public key, `pcfjlemgcbbpppclachnobhnnnahpgoj`, checked on every
  build.
- Unit tests in jsdom and Playwright end to end tests in Chromium, including a full native
  messaging round trip through a stand-in host.
