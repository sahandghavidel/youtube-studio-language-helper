# YouTube Studio Language Helper

A local, unpacked Manifest V3 Chrome extension that processes translated assets for one YouTube Studio video through the existing signed-in Studio tab.

It does not use the YouTube API, OAuth, API keys, private YouTube endpoints, analytics, telemetry, remote JavaScript, or a native companion. Optional Telegram notifications are relayed through the user's existing local Ultimate Video Editor server; Telegram credentials never enter this extension.

> **Project status:** Early controlled testing. Test one empty translated language first and verify every component in YouTube Studio before selecting a larger queue. YouTube Studio can change its interface without notice, so selectors may require maintenance.

## Requirements

- Google Chrome with Manifest V3 and Side Panel support
- Ultimate Video Editor running locally on port `9540` when Telegram notifications are desired
- A signed-in YouTube Studio session
- One video's **Languages** page open in Studio
- A local export folder following the four-file contract below
- Chrome kept open, the target Studio tab available, and the computer awake while a job runs

## Safety model

- Nothing is added or uploaded until you press **Start** and confirm the bound video and destination count.
- **Preview / Dry Run** reads the visible Studio state and language catalog without adding a language or attaching a file.
- Jobs are bound to the YouTube video ID, channel ID, and selected folder name.
- The extension pauses if the bound tab closes, navigates away, stops responding, changes video/channel, or is signed out.
- Languages and components run sequentially. There are no parallel YouTube uploads.
- Queue pacing targets a randomized 10–20 seconds between components and 30–60 seconds between languages, measured from the last verified Publish/Update click. Time spent waiting for Studio's explicit completion or processing confirmation is credited toward that target, with a 1–3 second post-confirmation settle retained. Unknown or invalid timing falls back to the full cooldown. Verified Publish/Update controls receive an additional 1–2 second settling delay before the click.
- Dry Run and each component first inspect the main Translations-table row. Clearly published metadata, subtitles, audio, and localized thumbnails are marked Skipped without opening language details; visible audio Processing is also treated as existing work. These no-click skips use only a 0.5–1.5 second settle.
- A visible CAPTCHA, sign-in verification, rate-limit, unusual-activity, or similar Studio warning immediately fails the atomic operation and pauses the queue. The extension never attempts to solve or bypass a safeguard.
- Queue completion and operational errors send one Telegram notification through `http://localhost:9540/api/notifications/telegram`. Notification delivery failures are logged and never change upload results.
- While a job is actively Running, the extension uses Chrome's `power` permission at the `display` level so the Mac display and system remain awake. It releases that request on Complete, Pause, Stop, Reset, or Error, after which normal macOS display and sleep timers apply again.
- Existing translated components are never deleted.
- Existing subtitle and audio tracks are blocked because replacing them can require deletion.
- Existing metadata or thumbnails require a separate, component-specific overwrite confirmation.
- Asset-level **Publish** is used only inside a scoped translated-subtitle or translated-audio dialog.
- The extension never touches video visibility, scheduling, publication state, original title/description, tags, audience, category, original thumbnail, channel settings, cookies, passwords, tokens, or unrelated browser storage.
- English and English (United Kingdom) assets are always ignored. They remain fully user-managed.

## Installation

1. Keep this folder in a stable location:

   `/absolute/path/to/youtube-upload-helper`

2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this project folder.
6. Pin **YouTube Studio Language Helper** if you want the toolbar icon to remain visible.
7. Click the toolbar icon while YouTube Studio is open. Chrome opens the persistent side panel.

After editing extension source files, return to `chrome://extensions` and click the extension's **Reload** button. Reload the YouTube Studio tab as well so the updated content script is installed in that page.

If the normal manifest injection is missing, the side panel's **Refresh** button uses Chrome's `scripting` permission to inject the same packaged `content-script.js` into the current Studio tab and retry once. YouTube host access remains restricted to `https://studio.youtube.com/*`.

The only additional host permission is `http://localhost:9540/*`, used exclusively for the optional Telegram notification route. Ultimate Video Editor's page does not need to be open in a browser, but its local server must be running. The bot token and chat ID remain in that project's `.env.local`; do not copy them into this extension.

## Expected asset folder

Each translated source language may provide any combination of these assets. Missing assets are shown as unavailable and skipped; at least one valid asset is needed for a language to be processed. Audio may use either the WAV or M4A filename, not both:

```text
<Language> - audio.wav
or <Language> - audio.m4a
<Language>.srt
<Language> - Thumbnail.png
<Language> - metadata.json
```

Metadata supports both forms:

```json
{
  "language": "German (Germany)",
  "title": "Translated YouTube title",
  "description": "Translated YouTube description"
}
```

```json
{
  "language": "German (Germany)",
  "languageCode": "de-DE",
  "title": "Translated YouTube title",
  "description": "Translated YouTube description"
}
```

The parser discovers the number of source sets dynamically. It does not assume 48 languages.

### Approved one-to-many mappings

| Exported source | YouTube Studio destinations |
| --- | --- |
| Bengali | Bangla |
| Chinese | Chinese; Chinese (Simplified) |
| Spanish (United States) | Spanish; Spanish (United States) |
| French | French; French (France) |
| Portuguese (Brazil) | Portuguese; Portuguese (Brazil) |

All other source names must match one exact Studio language label unless a supported future `languageCode` resolves the label.

## Side panel

**Watch folder** is the default view. **Manual queue** has a separate preflight, destination list, and history. Switching views leaves the current operation running. The header shows the video, current activity, and last watch scan. Each existing-files preview is a dated snapshot grouped into additions, skips, and items needing review. Use **Copy report** for the full snapshot. Watch history records new events and Telegram delivery states as they become available.

## Optional folder watch

Open the correct Studio Languages tab and select the exported video folder using **Choose Folder**. Expand **Watch this video folder**, choose **Watch all languages in this folder** or check individual languages under **Watch selected languages**, and choose **Start watching**. Watch all also accepts languages added after watching starts, including when the folder starts empty. Selected-language choices are remembered for the paired folder and Studio video. Each available asset can run independently. **Preview existing files** compares the selected languages with the current Studio rows without starting uploads. The panel previews the Studio destinations, including one-to-many mappings, and the confirmation shows the folder, channel, video and destination languages. **Include existing files** also processes eligible files already in the folder. With it unchecked, the initial files form a baseline.

Watch handles translated metadata JSON (title and description together), thumbnail PNG, SRT, WAV and M4A. Each new file must stay stable across scans for at least five seconds. If both audio formats exist, audio waits unless you explicitly choose which format to use. Watch can finish a subtitle first and pick up audio later. It skips existing Studio work, serializes uploads, and stores watch results separately from the manual job. Keep the panel open while uploading. The panel shows its last successful scan. If it closes unexpectedly, the background worker detects this on its next heartbeat (normally within 30 seconds while Chrome is running). Reopen the paired panel and start watching to catch up. Unexpected navigation or permission loss pauses watch; inspect the target and restart watching to resume. Stop watching to return to manual controls.

When a file is held or blocked, or monitoring pauses unexpectedly, the helper queues one Telegram alert per open issue through the local Ultimate Video Editor. Intentional stops are quiet. If the editor is offline, alerts stay queued and delivery retries when it is available. If a send may already have reached Telegram, the helper shows unconfirmed delivery and avoids a duplicate.

For a blocked result, fix the cause and click **Retry blocked file** while the paired watcher is running. It rechecks that specific destination and filename against the live Studio page. Published subtitles and published or processing audio are skipped. An interrupted upload still requires review before replay.


## Normal workflow

1. Sign in to the correct channel.
2. Open the correct video's **Languages** section in YouTube Studio.
3. Open the extension side panel.
4. Click **Choose Folder** and choose the exported asset directory.
5. Wait for both folder scans to finish. The extension compares file names, sizes, and modification times across a five-second interval.
6. Review source-set validation and individual language checkboxes.
7. Click **Preview / Dry Run**.
8. Verify the bound channel ID, video title, video ID, selected folder, source-set count, and derived Studio destination count.
9. Press **Start** only when the Dry Run passes.

Keep Chrome open, keep the Studio tab available, keep the side panel open during large file transfers, keep the Mac awake, and keep the internet connection active. The Studio tab can remain in a background Chrome window while you use another application.

The extension keeps the display awake during a running manual queue and throughout a confirmed folder watch, including time spent waiting for files. Stop watching releases it after any current component finishes. Previewing files alone leaves the normal display timer in effect. It cannot override a manual Lock Screen, a closed MacBook lid, logout, or an administrator-enforced security policy.

Cooldowns are shown in the side-panel status and activity log. Pause and Stop remain responsive during a cooldown, and an interrupted cooldown is saved with the job. These delays reduce request bursts and give Studio time to settle; they do not guarantee that automated browser interaction is permitted or undetected.

## Folder permission and persistence

The primary chooser uses `showDirectoryPicker()` with read-only access. The directory handle is stored locally in extension-owned IndexedDB. Chrome may revoke permission after a restart or period of inactivity; use **Grant Access Again** when shown.

If the File System Access API is unavailable, the extension falls back to a `webkitdirectory` input. The fallback cannot re-read a live directory handle, so the same folder must be selected again after at least five seconds to confirm stability.

Large media contents are not saved in IndexedDB or `chrome.storage`. One selected file is streamed in small acknowledged chunks to the Studio content script, reconstructed as a temporary browser `File`, attached to the exact scoped input, and released after that component finishes.

## Controls

- **Preview / Dry Run**: checks page identity, visible rows, and the current Studio language catalog without adding or uploading.
- **Start**: begins or confirms a new sequential queue.
- **Pause**: stops after the current atomic component finishes.
- **Resume**: continues from the next incomplete component.
- **Stop**: stops after the current atomic component while keeping saved progress.
- **Retry Failed**: resets failed components to Waiting; completed work is retained.
- **Reset Job**: removes all saved job progress after confirmation but keeps the selected folder handle.

Progress is recorded independently for metadata, subtitle, audio, and thumbnail. Blocked components are terminal for that run, allowing safe non-conflicting components to continue.

For dubbed audio, the extension uses a guarded multi-stage workflow: it waits for the Audio popup's Publish control and clicks it, then requires an explicit **Published** confirmation from either that transitional popup or the exact language-details Audio row before clicking **Update**. It then monitors the main Languages-table Audio column. A dash or percentage-free **Processing** state keeps the queue waiting; **Processing with a percentage** or final **Published** confirms that it is safe to continue.

## Existing work

The main Studio table can hide important state. For example, a dash can still correspond to an auto-dub draft visible inside language details.

- Exact matching metadata is skipped.
- Different existing metadata is blocked until you explicitly approve metadata overwrite for that one destination.
- Existing subtitles are blocked and are not replaced.
- Existing manual audio or auto-dub audio is blocked and is not deleted or replaced.
- Existing thumbnails require explicit thumbnail overwrite confirmation, but only when Studio exposes a visible localized-thumbnail control.

YouTube currently requires deleting an auto-dub before uploading a manual dub for the same language. This extension deliberately does not perform that deletion.

## Localized thumbnail availability

YouTube documents localized thumbnails, but the control can be account-, video-, or rollout-dependent. The inspected video's current Hindi dialog did not expose a visible thumbnail row even though a hidden image input existed.

The extension never uses that hidden input by itself. It requires a visible Thumbnail row and a unique **Add** or explicitly approved **Change** control. Otherwise the thumbnail component is marked Blocked with a diagnostic.

## Validation rules

Preflight checks include:

- Recognized shared-language filenames for every asset that is present
- Parseable JSON object
- Non-empty `language`, `title`, and `description`
- Optional non-empty `languageCode`
- JSON language exactly matching the filename language
- Title at most 100 characters
- Description at most 5,000 characters
- No duplicate language/component entries
- Non-empty UTF-8 SRT with a plausible numbered timing block
- RIFF/WAVE header for WAV or an ISO BMFF `ftyp` header for M4A
- PNG signature, minimum dimensions, and approximately 16:9 ratio
- Stable size and modification metadata
- Exact/approved Studio language mappings
- Signed-in `/video/<id>/translations` Studio page with video and channel identity

Missing components are skipped. An invalid component is blocked without preventing other valid components for that language from running. A selected language with no valid assets cannot start.

## Resume behavior

Lightweight job state is stored in `chrome.storage.local`. The identity combines:

- YouTube video ID
- YouTube channel ID
- Selected folder name

Before a resumed run, the extension checks the bound page again. Published subtitle and audio completion is reconciled against the visible Studio row when possible. If stored completion cannot be verified, that component returns to Waiting instead of being trusted blindly.

The extension does not persist WAV, SRT, PNG, or metadata file contents. The saved directory handle is used to obtain fresh `File` objects after a restart.

## Diagnostics

The expandable log records only local operational data:

- Operation
- Destination language
- Expected UI state
- Observed UI state
- Whether retrying is safe

Logs do not intentionally contain cookies, tokens, account email addresses, file contents, or unrelated page data. The log is capped at 500 entries.

## Automated checks

Run:

```bash
npm test
npm run check
npm run validate:sample -- "/absolute/path/to/exported-video-folder"
```

The test suite covers:

- Folder parsing and filename classification
- Current three-field JSON
- Optional language codes
- Missing companion files
- Duplicate components
- JSON/filename mismatches
- Metadata limits
- Approved one-to-many mappings
- Derived destination counts
- File stability snapshots
- Component-level resume state
- Manifest permission policy
- JavaScript syntax

The sample validation is read-only and does not modify the exported folder.

## First controlled integration test

Do not start the full queue first.

1. Run Dry Run.
2. Select exactly one safe, currently empty translated destination.
3. Ask for and give explicit approval for that one language.
4. Start the job.
5. Verify title, description, subtitle, audio, and thumbnail directly in Studio.
6. Check the activity log and reload/resume behavior.
7. Fix any adapter issue before selecting more languages.

## Full-queue manual checklist

- [ ] Correct channel ID and video ID are shown.
- [ ] Folder count and destination count are expected.
- [ ] English/source assets are absent.
- [ ] All selected languages pass preflight.
- [ ] Dry Run passes after the latest extension reload.
- [ ] One-language controlled test has succeeded.
- [ ] Existing auto-dubs/manual tracks are understood and expected to block.
- [ ] Localized-thumbnail controls are available where expected.
- [ ] Chrome will remain open and the Mac will remain awake.
- [ ] The side panel will remain open during file transfers.
- [ ] The full queue has separate explicit approval.

## Troubleshooting

### Studio unavailable

Open exactly one video's Languages section and press **Refresh**. Reload the Studio tab after installing or reloading the extension so `content-script.js` is active.

### Folder access expired

Click **Grant Access Again**. If Chrome no longer recognizes the saved handle, click **Choose Folder** and select it again.

### Files keep changing

Wait for the translation/export application to finish every file. Choose the folder again and let both stability scans complete.

### Language missing

Open Studio's **Add language** menu and compare the exact visible label. Update only `lib/language-mapping.js`; never add fuzzy first-match behavior.

### Existing auto-dub blocks audio

This is intentional. The extension will not delete it. Resolve that conflict manually outside the extension only if you deliberately choose to do so, then rerun Dry Run.

### Thumbnail blocked

Open the language details dialog manually and verify that Studio visibly provides a localized Thumbnail row. A hidden file input alone is not considered safe evidence.

### Selector failure

Expand the activity log and note the operation, language, expected state, observed state, and retry-safety field. Do not repeatedly retry an ambiguous selector failure. Inspect the current Studio UI and update the centralized selectors and adapters in `content-script.js`.

After changing extension files, reload the unpacked extension and then reload the Studio tab before testing again.

## Updating Studio selectors

All Studio DOM knowledge is centralized in `content-script.js`:

1. Update the `SELECTORS` object first.
2. Prefer stable custom-element names, accessible roles, exact visible labels, and row-scoped queries.
3. Keep language row lookup exact.
4. Never replace a scoped query with `nth-child`, obfuscated classes, or a global first-match selector.
5. Preserve the visible-control requirement for destructive or upload actions.
6. Run `npm test` and `npm run check`.
7. Reload the unpacked extension and Studio tab.
8. Run Dry Run.
9. Repeat a one-language controlled test before a full queue.

## Project structure

```text
manifest.json
service-worker.js
content-script.js
sidepanel.html
sidepanel.css
sidepanel.js
lib/
  constants.js
  directory-store.js
  folder-parser.js
  job-store.js
  language-mapping.js
  validation.js
scripts/
  check-syntax.mjs
  validate-manifest.mjs
  validate-sample.mjs
tests/
README.md
```

## License

Released under the [MIT License](LICENSE).
