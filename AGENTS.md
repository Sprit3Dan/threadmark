# AGENTS.md

Notes for coding agents working on Threadmark. The README covers what it does and the file format; this covers how the code is built and the rules it must keep.

## Commands

```sh
npm install
npm test                 # vitest, src/core only — fast, run it after every change
npm run build            # dist/      (the build the user loads in Chrome)
npm run build:dev        # dist-dev/  (also runs on http://127.0.0.1, for the e2e harness)
npm run e2e              # build:dev + dev/e2e.mjs: real Chrome, real clicks, ~1 min
node dev/e2e.mjs --shot  # also writes screenshots to $TMPDIR/threadmark-e2e/
```

Before calling a change done, run both `npm test` and `npm run e2e`, and look at the screenshots for anything visual. After `npm run build`, the user has to click reload on `chrome://extensions`; say so.

## Layout

```
src/
  content.js        boot: decides whether to take over the tab, reads the source out of
                    Chrome's plain-text viewer BEFORE touching the DOM, mounts the app
  core/             pure ESM, no DOM or Chrome APIs, unit tested
    markers.js      @tN markers: find, strip, insert (inline and block), clean↔original offsets
    doc.js          markdown-it → HTML plus "units" and "blocks" with source coordinates
    project.js      inline projection: rendered text ↔ source offsets, guarded ranges
    annotate.js     resolve markers to spans, relocate a span, addThread (the write)
    threads.js      the @threads block: parse leniently, edit minimally
  ui/
    app.js          reading view + rail + every write (commit)
    dom.js          anchors, DOM points, highlights
    fs.js           File System Access: file and folder handles, pickers, IndexedDB
    kv.js           small persistent UI state (drafts, scroll, filter)
    styles.css      everything visual; tokens on :root, dark mode via media query
  sample.*          extension page with an in-memory "file"; the e2e write tests run here
  popup.*, options.*
dev/e2e.mjs         the end-to-end harness
spike/              the original feasibility probe (file:// injection); not shipped
```

## Rules the code keeps

- **Never write the file from the DOM.** Every write goes through `commit(edit)` in `app.js`: read the bytes on disk, apply `edit(text)` to *those* bytes, re-check that nothing changed in between, write. Edits find their target again in the fresh text (by thread id, message author+stamp+body, or `relocateSpan`), never by offsets remembered from an older read.
- **Write minimally.** Only add or remove our own lines and markers, or flip a status token. Never reformat lines an agent wrote. Preserve CRLF (`detectEol`).
- **Two coordinate systems.** `clean` = the source with every marker stripped; the renderer, units and selections all live there. `original` = the file as saved. Convert with `cleanToOriginal` / `insertSpan`; forgetting this corrupts the file.
- **Units vs blocks.** A *unit* (`.tm-u`, `data-tm-i`) is inline text whose rendered characters map one-to-one onto the source through its projection; markers go inline there. A *block* (`data-tm-b="a-b"`: fenced code, raw HTML between `.tm-bs`/`.tm-be` sentinels, unmappable table text) takes block markers on lines of their own at its line range `a..b`. `skip`/`len` on the start marker narrow the highlight to the exact selection.
- **Nothing is unannotatable.** If a selection can't take a marker where it is, widen the anchor (to the code span, link, or block) and record `skip`/`len`. Never refuse.
- **Markers next to `**`/`[`/`](…)` delimiters go outside them** (`adjust` in project.js), so other renderers still see the emphasis.
- **No blocking dialogs** (`alert`/`confirm`/`prompt`). They freeze the page, and with it the CDP harness. Use the two-click `deleteButton` pattern.
- **The threads block is not rendered** in the reading pane: `analyze` stops at `@threads:start`.

## Gotchas you will hit

- markdown-it renders `inline` tokens directly and never calls `rules.inline`. Unit wrappers are injected as `html_inline` child tokens (`wrapChildren` in doc.js).
- markdown-it strips continuation-line indentation and `>` from `token.content`; doc.js matches it back with a whitespace-tolerant regex. Projection skips `>` after newlines when `quoted`.
- `fs.js` and `kv.js` use **separate IndexedDB databases**. Sharing one name at version 1 means only the first opener's store ever exists.
- Branded Chrome ignores `--load-extension`; the harness uses Playwright's Chrome for Testing (`CHROME=/path` overrides).
- Native pickers can't be scripted. Folder logic is tested through `window.__tmTestFolder` (dev build, sample page) using OPFS; the real "Choose folder…" click is manual.
- A background tab in headless Chrome never finishes CSS transitions. `Page.bringToFront` before screenshotting or reading computed styles.
- The content script runs in the isolated world, so CDP `Runtime.evaluate` can't reach app state. Test through the DOM, or through `window.__tmSample` on the sample page.
