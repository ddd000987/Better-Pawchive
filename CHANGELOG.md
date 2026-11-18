# Changelog

English | [繁體中文](CHANGELOG.zh-TW.md)

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-11-18

### Added

- Image window: press F in the hover preview to open the current image in its own window, which can be moved, resized and put on another screen. In the window the mouse wheel zooms around the pointer, dragging pans a zoomed-in image and otherwise moves the window, double-click switches between fitting the window and actual size, 0 fits the window and Esc closes it. The original image is loaded, and the preview image is shown until it arrives.
- Preview keys: the keys used inside the preview (D whole post, C this image, V original, F window) can be changed or turned off in the new "Preview keys" section on the Preview page. The key hint in the preview info bar follows the keys you set; Esc always closes the preview.
- Creator preview: hover a creator's avatar to see the covers of their latest posts. Click a cover to open that post, or anywhere else in the preview to open the creator's page. The new "Creator page preview" section on the Preview page turns it off, sets how many posts it shows (12 by default) and whether it stays open while the mouse is on it.
- Pick posts by hand: with "Pick posts by hand" on the Crawl page, clicking a post card picks it instead of opening it (click again to unpick; Ctrl+click or the middle button still opens it). "Save to cache" crawls only the picked posts and saves them as one crawl cache entry. The Filter settings do not apply to picked posts, neither when they are crawled nor when they are downloaded. Picks stay in the tab until the page reloads.
- Preview preloading: two new settings on the Preview page choose how many images after the current one (1 by default, as before) and before it (0 by default) are loaded ahead of time.

### Fixed

- Downloads: pausing a "restart all" download and resuming it skipped the remaining files as already downloaded.
- Downloads: with ordered downloads on, a file that failed every retry kept all the files after it from starting.
- Downloads: a file the browser refused to save paused the download, and resuming tried the same file again, so the batch could never finish. The file is now skipped and the batch goes on (three failures in a row still pause), and the completion message says how many files were skipped.
- Downloads: a few temporary save failures anywhere in a large batch could turn the next one into a hard error. Each file now has its own retries.
- Downloads: resuming a paused download could save a second copy of a file the browser was still saving.
- Downloads: when a quick download of a large file was handed to the browser's own download, the first request was left open and used bandwidth twice.
- Crawl: a crawl whose list page still failed after the retries was reported as complete, or as "no posts found". It is now reported as incomplete. Responses that are not valid JSON are retried.
- Crawl: starting a crawl dropped the tasks queued behind it. Tasks queued after a crawl was stopped are now cancelled with a notice instead of running after a later crawl.
- Crawl: a file whose name has no extension was saved as `.bin` even when its path has one.
- Filter: the post ID range compared IDs as text, so bounds with leading zeros or non-numeric IDs gave wrong results.
- Several tabs: settings, download history and crawl caches changed in one tab could be erased when another tab saved. Tabs now merge their changes and pick up each other's.
- Settings: if reading the saved settings failed, the first change overwrote every saved setting with the defaults.
- Download history: records of files that finished in quick succession could be lost when the tab was closed. A record is now saved within two seconds.
- Hotkeys: holding a key down ran its command over and over, and after clicking a checkbox or button the hotkeys and Esc stopped working.
- File names: when a long path was shortened, every file of a long-titled post got the same name.
- File names: a file named like a reserved Windows name (for example `NUL.png`) lost its extension.
- Local folder: if the folder's read permission was withdrawn during a check, every file looked missing. The check now says the folder cannot be read.
- Messages: post titles or creator names containing `$&`, `$$` or `{}` came out garbled in messages.
- CSV export: line breaks containing carriage returns are now quoted, so rows no longer split.

### Security

- Hotkeys loaded from storage or from an imported settings file are now validated and shown as plain text, so a crafted settings file can no longer put HTML into the settings page.
- CSV export: cells that start with `=`, `+`, `-` or `@` are neutralised, so spreadsheet apps do not run them as formulas.

## [1.0.2] - 2026-11-04

### Added

- Download queue: queue several crawl caches and download them one after another, for example overnight. Use "Add to queue" on a cache card, then "Start queue" in the new Download queue section on the Download page, where items can also be reordered or removed. When a cache finishes, the next one is mounted and started. If some files still fail after the automatic retries, that cache is marked as partly failed and the queue moves on; files already saved are skipped on a rerun. Stopping the download pauses the queue; "Pause queue" lets the current cache finish without starting the next. The download runs in the tab, so keep the tab open and the computer awake.
- An "Unmount" button on the mounted cache card and on the mount info card clears the download area and frees memory. The cache entry itself is kept.
- When switching to an image that is still loading in the preview, the previous image is dimmed and a small "Loading…" line is shown over it, so it no longer looks as if the switch did nothing.

### Fixed

- Large images in the preview kept flashing on and off. The preview could cover the mouse pointer, which closed it and then reopened it. It is now placed on the side of the pointer with the most room and never covers the pointer or goes off screen.
- With "Preview original image" turned off, the V key opened the thumbnail instead of the original image. V now always opens the original; the preview image is shown until the original has loaded.
- Downloading a cache from a tab on the other site (for example a Pawchive cache from a Kemono tab) saved thumbnails instead of original images.

## [1.0.1] - 2026-10-28

### Added

- A "Restore defaults" button on the Common page resets every setting after a confirmation. Download history, the crawl cache and the chosen folder are kept.

### Changed

- In the preview, the wheel scrolls the page only when the mouse has moved at least 30 px in the last 0.2 s. Small movements (a shaky hand, nudging the cursor) keep switching images. The distance can be changed in the Preview settings.
- The crawl cache list moved to the bottom of the Crawl page, together with the "Auto-mount cache after crawl" option (previously on the Download page); the separate Crawl cache page is gone.
- The hover delay setting uses the same layout as the other fields (label on the left, input on the right) and is limited to 0–2000 ms.

## [1.0.0] - 2026-10-28

First public release. Changes since 0.2.0:

### Security

- The internal event bus now uses a private `EventTarget` instead of the page's `window`, so scripts on the site can no longer observe or forge the extension's events.
- The CORS header rules now apply only to requests made from the Kemono / Pawchive sites (`initiatorDomains`), instead of to every site that requests their files.
- The download folder used by "skip files that already exist" is now picked in the extension's own window and owned by the extension. Previously its handle and read access belonged to the website, so the site's scripts could have listed that folder. The old handle is deleted from the site's storage automatically; pick the folder again once.

### Added

- Crawling can be paused and resumed; while paused, a Stop button appears. The crawl controls are on both the Home and Crawl pages.
- The floating ⚙ button can be turned off in the settings (the panel still opens with Alt+X or the toolbar icon).
- The settings show whether the chosen download folder is authorized.
- The Home and Crawl pages show live crawl progress: status, elapsed time, posts checked, posts and files added, and how many posts were excluded by each filter or failed. An empty result now explains why in a toast.

### Fixed

- `n1.kemono.cr` had two conflicting Referer rules; all `n1`–`n4.kemono.cr` file servers now send `https://kemono.cr/`.
- When every file was already downloaded, the progress showed 0/N and a "download started" toast covered the pre-check summary. It now ends at N/N without starting threads.
- Toasts shown at the same time no longer overlap.

### Removed

- Switching preview images with the arrow keys (it also triggered the site's own paging). Use the mouse wheel.
- The separate dedup strategy (loose / strict) setting; the loose behaviour is always used.

### Changed

- The extension name and description are localized (English, 简体中文, 繁體中文, 日本語).
- Requires Chrome / Edge 101 or later.
- The settings panel is split into one module per page.
- "Skip by download record" and "skip files already in the folder" are merged into one "Skip already downloaded" option: none / download record / folder / both. Existing settings are migrated.
- The Pause download button only appears once a download has started.
- In the preview, the mouse wheel switches images only while the mouse is still; scrolling while moving the mouse scrolls the page. While the preview is shown and the mouse is still, the page never scrolls, including while images are still loading and when the cursor is over something covering the card.
- Crawling no longer skips posts that are already in the download history; skipping happens only when downloading. Re-crawling a fully downloaded creator used to give an empty result.
- Kemono support is marked best-effort: its original-file servers were unreachable when tested.
- Added an English README, a privacy policy, and CI that type-checks, lints, tests and builds every push; tagged releases attach a ready-to-load zip.

## [0.2.0]

Not publicly released. First feature-complete version: hover preview, batch crawl with filters, crawl cache, download control (pause / resume / restart, stall detection, retry with backoff, large-file direct download), duplicate and local-file checks, naming rules, download history, CSV export, configurable hotkeys, in-panel log, and four UI languages.
