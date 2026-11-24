# Changelog

English | [繁體中文](CHANGELOG.zh-TW.md)

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.1] - 2026-11-25

### Added

- Watch page previews: resting on a post (in a creator's posts, "New posts" or "Favorite posts") shows its images at their own proportions, and the mouse wheel switches between them; resting on a favorite image shows it larger. Thumbnails are shown by default; the original can be loaded instead.
- Watch page settings: the new ⚙ at the top left of the watch page opens its settings: hover previews (on/off for posts and images, original image, delay), tracking, the creator list layout, and export / import (moved here from the bottom of the sidebar).
- Favorite images: right-click an image to download it, move it to another folder (or a new one), open it in its own window, open its post, copy its URL or remove it. With several images selected, download, move and remove act on all of them.

### Changed

- Kemono: previews and the watchlist only. Its original-file servers `n1`–`n4.kemono.cr` are gone, so previews, the watch page and the image window use thumbnails there, and crawling, downloading, the thumbnail download button and the Crawl, Download and Naming pages are turned off on Kemono. Crawl caches from Kemono can no longer be mounted or queued, and Kemono images are left out of downloads on the watch page.
- Naming: there is one naming rule again. A Pawchive rule you had set becomes the naming rule. The default rule now starts with a `pawchive/` folder instead of `kemono/`. If you never changed the rule, new downloads go into `Downloads/pawchive/`; when you skip files already in your folder, pick `pawchive` as that folder.
- Settings panel: the Home page is now a guide for new users. It says what the current page can do, walks through the two steps (crawl, then download) and shows which one you are on, lets you watch the creator of the page, and keeps a few common switches. The panel opens on Home, and a crawl started there stays on Home when it finishes.
- Settings panel: the tracking settings moved to the watch page's ⚙; the Watchlist page keeps the summary and the "Open watch page" button.

### Removed

- Support for the old Kemono domains `kemono.su` and `kemono.party`, which no longer exist. A saved link host on one of them falls back to `kemono.cr`.

## [1.2.0] - 2026-11-25

### Added

- Watchlist: follow creators with the extension's own list, separate from the site's favorites. Click ☆ on a creator page (or in the avatar preview) to add a creator to a folder. The new watch page (toolbar icon on any other tab, or "Open watch page" in the settings panel) shows the creators as cards or a list, with folders, search, sorting, multi-select and drag-to-folder. Each creator can have a custom name, a note and a cover picked from their posts or uploaded from your computer. The watchlist can be exported to a file and imported back.
- Tracking: turn on 🔔 for a creator and the extension remembers their newest post. When you visit the site it checks the tracked creators of that site (at most every 6 hours by default) and shows a notice when there are new posts; the toolbar icon shows the number of unread posts, and the watch page lists them in "New posts". Visiting the creator's page marks them as read.
- Favorites: save posts with the new "Favorite post" button under a post's actions, and single images with the ☆ on each image of a post page or the S key in the hover preview (changeable on the Preview page). The watch page has "Favorite posts" and "Favorite images" sections, each with its own folders; images open in a lightbox with previous/next.
- Ratings and tags: give creators, favorite posts and favorite images a 1–5 star rating and tags (one shared tag list). Filter and sort by them, edit many at once in select mode, and rename, merge or delete tags on the "Tags" page.
- Card previews: pick up to 6 preview images for a creator (from saved images, post covers or uploads); resting on the creator's card on the watch page for half a second shows them.
- Naming: the new `{creator_alias}` tag uses the custom name from the watchlist, or the creator's name when there is none.
- Crawl caches: export one cache or all of them to a file with the new buttons on the Crawl page, and import the file back. Entries that are already there, or past the 20-entry limit, are skipped.
- Image window: the new "Middle-click opens the image in its own window" setting on the Preview page opens the previewed image in its own window with the middle mouse button. It works even when the browser window is not focused, where the key cannot. While it is on, middle-clicking a previewed card no longer opens the post in a new tab. Off by default.

### Changed

- Renamed to Better Pawchive. The repository moved to https://github.com/ddd000987/Better-Pawchive (old links redirect). Settings, download history, the watchlist and favorites are kept.
- Download history and crawl caches are saved in smaller pieces, so saving stays fast with a large history and other tabs only receive what changed. Existing data is moved over the first time it loads; the export format is unchanged.
- Settings import checks dates, post ID ranges, services and file count ranges, and resolves conflicts between imported hotkeys.
- Settings panel: dropdown options follow a language change, and the "Auto" language option says it follows the browser.
- 繁體中文: wording uses Taiwan terms.

### Fixed

- Downloads: a short network failure paused the batch for good. It is now retried later; only a full disk or denied access pauses the download.
- Downloads: after giving up on files that kept failing, the batch never ended, so queued downloads did not start.
- Downloads: turning text content or the cover on or off made every file download again.
- Downloads: when another extension renames downloads to random IDs, a warning is shown and those files are not recorded as downloaded.
- Crawl: runs where posts failed, the list was malformed or an error stopped the crawl ended as complete. They now end as incomplete, and their caches are saved with an "(incomplete)" tag. Retry-After is honored, and the crawl stops after repeated rate limits.
- Crawl: when the creator's profile could not be loaded, files were saved under the creator's ID without a word. The request is retried, then the previous name is used or a warning is shown.
- Crawl: the quick check on the list page and the full filter could count a cover that repeats an attachment differently.
- Crawl: posts picked by hand that failed to crawl were dropped from the picks.
- Naming: characters not allowed in file names in the fixed text of the naming rule are replaced, with a warning.
- Preview: switching images with the wheel kept loading the previous image and preloads that were no longer needed.
- Preview: floats could slide under the page's scrollbar, and a long creator name could make the creator preview too wide.
- Preview: the preview closed when the pointer moved onto the thumbnail's download button.
- Image window: a notice says when the original image failed and the preview copy is shown.
- Settings: a failed save was lost silently. It now shows a message and is saved again later, without overwriting changes made in another tab.
- Accessibility: the thumbnail download button can be reached with the keyboard and has a label.

### Security

- The background script accepts messages only from this extension and checks download requests (http/https only, relative file names, no "..").

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
