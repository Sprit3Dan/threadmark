# Threadmark — review threads in markdown, in Chrome

Date: 2026-10-22
Status: for approval
Project location: `~/dev/threadmark` (name is my call; rename freely)

## Intent and why

The documents agents produce for you arrive as markdown, and you read them in Chrome.
Reading is where you do your thinking, and right now the thinking has nowhere to live:
the extension you use charges for annotating text you wrote yourself, which you
consider absurd.

Threadmark replaces it. You open a `.md` file in Chrome by direct `file://` URL, read a
comfortably typeset copy, select any span of text, and leave a note on it. The note is the
root of a thread. You keep talking to yourself in that thread, or you tell an agent to
review what you flagged and let it answer in the thread. When you are done, the document
itself carries the whole conversation, so the agent reading your file sees exactly what you
flagged and what was said about it, and you have nothing to export, sync, or pay for.

The annotation is not a screenshot pinned to a scroll position. It is text in the file,
portable across editors, diffable in git, readable by any agent with file access.

## Who it's for

You, on macOS, in Chrome, working with markdown documents an agent writes to your disk
and reads back. Single local user, no accounts, no server.

## Scope

`file://` URLs only, for files ending in `.md` or `.markdown`. Nothing else: not agent web
apps, not GitHub, not a markdown file served over http. A served document has no write path
— a File System Access handle is a local file, not bytes at a URL — so annotations on one
could never be saved, and Chrome downloads such responses anyway. Leaving a `.md` URL that
isn't a local file alone is correct behaviour, not a limitation to apologise for.

## Goals

- Open `file:///…/anything.md` and get a pleasant reading view instead of raw text.
- Annotate any span of text you can select — mid-sentence, mid-list-item, inside a table
  cell — not just whole paragraphs or blocks.
- Select text → annotate, in one gesture, no dialog.
- Threads render in a right-hand rail; the document stays the main event.
- Annotations and replies are written back into the same file, in place, as markdown
  comments — no copy, no download, no sidecar database.
- An agent can read the file and reply by appending a line. It needs no tools, plugin,
  or format knowledge beyond reading the file you point it at.
- Reopen the file later: highlights and threads rebuild from the file alone.
- Never silently overwrite anything an agent wrote.

## Non-goals

- Viewing or annotating anything over `http(s)`, and scraping agent web apps (claude.ai,
  ChatGPT, GitHub) in any form.
- Editing the document body inside the extension. You edit in your editor or through an
  agent; Threadmark writes only span markers and the threads block.
- Cloud sync, sharing between people, collaboration on one document, search across files.
- Mobile, Firefox, Safari.
- Math (KaTeX), Mermaid diagrams, footnotes — nice later, not v1.
- Concurrent editing by two people, or two tabs editing threads at once.
- Deleting threads in v1. Resolving is the cleanup; see Failure modes.

## Anti-goals

- A read view that is worse than a good markdown renderer. Reading is the everyday use;
  annotations are the reason the view exists, not the point of every glance.
- Annotations that die with the tab, or live only in extension storage.
- A file that an agent, or a markdown renderer, can no longer read comfortably because we
  made it weird.
- The extension rewriting your document while you weren't looking.
- Anything that needs a background server, an installer beyond the unpacked extension, or
  an API key.

## Constraints, and what I verified

Probed in Chrome on macOS (Oct 22) against local `.md` files:

- Chrome renders `file://` markdown as plain text with `document.contentType ===
  "text/markdown"`, raw source in the DOM. Verified for a 3 MB file: `innerText` came back
  at exactly the file's byte count, no truncation.
- A `file://` page **is** a secure context and `showOpenFilePicker` /
  `showSaveFilePicker` exist and are callable there — a tab opened by direct URL can be
  granted a handle to its own file and write to it in place. This is the fact the whole
  design rests on.
- `fetch()` of a sibling file from a `file://` page fails (opaque origin). We cannot
  re-read the file without a granted handle.
- Chrome has no built-in markdown renderer, so `.md` stays raw text in a `<pre>`; the text
  viewer is an ordinary document, and IndexedDB is available on `file://` (all local files
  share one store, which is why handles are keyed by path).
- Content scripts injecting into Chrome's plain-text viewer tab is expected but not yet
  proven on this machine, and it is the first thing the build checks (see Build order).
- Content scripts do not run at all until "Allow access to file URLs" is switched on for
  the extension, and a script that cannot run cannot tell you. The extension action popup
  therefore carries the installation state: whether file access is on, and a link to the
  right settings page.

Other constraints:

- Manifest V3 forbids remote code. Renderer, sanitizer, and syntax highlighter are vendored
  into the bundle: markdown-it (GFM tables, task lists), DOMPurify, highlight.js.
- `innerText` normalizes line endings, so a round-trip through the DOM would silently
  rewrite every CRLF file and can drop a trailing newline. Writes therefore never
  reconstruct the file from the DOM.
- An agent edits the same file you are looking at. Writes must be deltas on the current
  bytes on disk, guarded against drift.
- Target size is documents up to ~3 MB (verified to render as text at that size). No
  virtualization in v1; the build measures where rendering degrades and says so.

## Approaches considered

1. **Take over the `file://` tab (chosen).** A content script matches `*.md`, replaces the
   plain text with the split view, and writes back to the same file through a File System
   Access handle granted once per tab. Keeps your direct-URL habit, gets in-place save, no
   extra installed parts. Costs: one click per tab to connect, plus one manual "Allow
   access to file URLs" toggle at install, and fidelity care around line endings — all
   handled below.
2. **A viewer page inside the extension.** You open files *into* it. Cleanest save story,
   no `file://` quirks, but it breaks the direct-URL habit you confirmed is how you work,
   and still needs the "Allow access to file URLs" toggle. It solves a problem you don't
   have.
3. **Content script plus a native messaging helper.** A small local script reads and writes
   files silently — no click, no fidelity risk — at the cost of a second installed
   component that can break quietly on a Chrome or macOS update.

Escalation rule, so the decision is made once: if the spike finds that connecting costs
more than one click per tab (a full picker trip every time, or a handle that cannot be
re-granted), the native helper in approach 3 replaces the handle path rather than papering
over it.

## Design

### Layout

One tab, two panes, full height, independently scrollable.

- **Left, ~68% (resizable, remembering its width):** the rendered document, max line width
  ~72ch inside that pane, comfortable body measure, sensible heading rhythm,
  syntax-highlighted fenced code, GFM tables, task lists, linked headings with hover
  anchors. Light and dark, following the system by default.
- **Right, ~32%:** the threads rail. Sticky header with the file name, save state, and a
  filter (Open / All). Below it, one card per thread in document order: thread id, a
  colour-coded status dot, the flagged text truncated to two lines, relative time of the
  last message, reply count. Open cards expand to full reply history plus a reply box.
  Resolved threads collapse to a single muted line and sink to the bottom.

Selection inside the document raises a small floating popover with one action,
**Annotate**. `Cmd+Shift+A` does the same for the current selection.

The `@threads` block is **not rendered** in the reading pane — the rail is its rendering,
and showing both duplicates the conversation at the foot of every document you read.
**Show source**, in the rail header, reveals the file's exact text with the markers visible,
for when you want to check that what the rail claims is really what the file holds.

### The contract in the file

A thread's span is delimited in place by a pair of HTML comments, which no markdown
renderer displays:

```markdown
The p95 <!-- @t3:start -->latency is 40ms<!-- @t3:end --> and we measured it twice.
```

The words between the markers *are* the annotation: the highlight is drawn exactly over
them, and an agent reading the file sees your flagged text inline, in context. Nothing is
stored about where the span is, because it isn't a pointer to anything. Markers are legal
wherever inline content is legal — inside a paragraph, a heading, a list item, a blockquote,
or a table cell — which is what makes an arbitrary span annotatable rather than tying
threads to paragraphs.

One block at the end of the file holds every thread:

```markdown
<!-- @threads:start -->
## Review threads

### T3 · open
> on: "latency is 40ms" — in "Latency results"
- **dan** · 2026-10-22 18:14 — this contradicts §2, which measured 12ms
- **claude** · 2026-10-22 18:31 — correct, §2 is the real number. Fixing.
<!-- @threads:end -->
```

- **Ids.** `T` + integer, next unused number in the file, matched case-insensitively by both
  the marker pair (`@t3:start` / `@t3:end`) and the block heading. Agents may add their own
  threads with their own ids; new ids are max-existing + 1, so collisions don't happen by
  accident.
- **Status.** `open` or `resolved`, a token in the heading. You resolve from the card; an
  agent resolves by editing the token. Both sides can do both.
- **Replies.** Markdown list items, in order: `**author** · YYYY-MM-DD HH:MM — text`,
  continuation lines indented two spaces. Your name comes from settings (default `dan`),
  stamped at send time.
- **The `on:` line is a record, not an anchor.** It is derived from the span when the thread
  is written and refreshed when we can, so a reader of the block alone still knows what T3
  meant. Nothing depends on finding that text again — the marker pair already says where the
  span is. That is the difference from a quote-matched anchor, and the reason rewording a
  sentence doesn't orphan your thread.
- An agent that writes `- **agent**: looks good to me` — no timestamp, colon instead of dash
  — is understood anyway. Parsing is tolerant; **writing is minimal**: we insert marker pairs
  and append our own lines and flip status tokens, and never reformat or rewrite lines we did
  not write, so agent-authored formatting and diffs survive.

### Where a span can't be delimited

Inserting a comment mid-line can corrupt inline markdown — a comment inside a code span
shows up as literal text, and one inside `*emphasis*`, a link's text or destination, or an
autolink can break the construct. The rule is in this order:

1. **Never** inside a fenced code block, an inline code span, a link destination, an
   autolink, an HTML block, or the `@threads` block. Selecting there explains why instead of
   offering Annotate.
2. **Otherwise shrink to fit.** If the selection crosses one of those boundaries, the span
   is trimmed to the largest safe part and the popover says so — *highlighted 12 of 15
   characters, inside a link* — so nothing is silently different from what you selected.
3. **If no safe range remains**, refuse with the reason.

This is the module carrying the build's real risk, and it is checked second, right after
injection.

### Model, parsing, anchoring

The markdown ↔ model logic lives in plain ESM modules with no Chrome dependencies — `parse`
(text → document model: blocks, inline spans, marker pairs, threads with replies),
`serialize` (model + delta → text), `locate` (a DOM selection range ↔ source offsets, and a
marker pair ↔ the rendered nodes to highlight). They are unit tested under Node against a
fixture corpus, and bundled into the content script by esbuild. Everything Chrome-specific
sits in a thin layer around them.

The mapping runs both ways and is the heart of the thing. For a new annotation, the DOM
range is translated to source offsets through the per-node source positions markdown-it
records, then validated against the rules above and the markers spliced into the source at
those offsets. For a reload, the marker pairs found in the source are matched to the
rendered nodes carrying the same source positions and wrapped in highlight spans. Both
directions land on the source text, never on a text search.

Degenerate cases stay visible instead of vanishing: a marker pair with nothing between them
(agent deleted the flagged sentence) becomes a thread tagged **span removed**, carrying the
last recorded `on:` text; a pair with only one marker becomes **incomplete pair** and is
left exactly as it is in the file rather than "fixed" behind your back.

A thread can exist in the `@threads` block with no marker pair in the body — an agent raising
its own concern. Those are parsed, shown in the rail tagged **agent-raised**, sorted after
the anchored threads, and replyable like any other; they have no text to highlight. The
marker is not required for a thread to exist, which is decided now because it is a shape of
the model, not a detail of the view.

The document model is built from the DOM text for display. Once the file is connected,
subsequent parses read the bytes from disk instead, which keeps non-UTF-8 and CRLF files
faithful and avoids any dependence on the text viewer's rendering.

### Connecting the file

A handle is needed to write, and also to notice that something else changed the file.

- First write attempt (or clicking the **Not connected** chip) explains in one line why, then
  opens `showOpenFilePicker`. Chrome remembers the last directory, and the file name is
  prefilled as the suggested name; the picker is filtered to markdown. If the chosen file's
  path doesn't match the tab's URL, we warn before writing anything.
- The handle is stored in IndexedDB keyed by path, so the next tab for the same file can
  reuse it. Chrome requires permission to be re-granted per tab, so a reopened file needs one
  **Reconnect** click. That is the whole cost of this approach: one click per tab. If the
  spike shows the cost is higher, see the escalation rule above.
- Annotations made before connecting are kept in `chrome.storage.local` keyed by path, shown
  normally but tagged **not saved**, and flushed to disk the moment a handle exists. On
  reopen, anything still unsaved is offered back before the file's own threads are rendered,
  with the file's version and the local version both visible. Nothing you type is thrown away
  because you hadn't connected yet.

### Saving

You chose: a thread that receives a message writes the file immediately. Also saved
automatically: creating a thread, resolving or reopening one. `Cmd+S` is a manual save. The
rail header states the state plainly — `Saved 18:31`, `Not connected`, `1 unsaved change`,
`Reload to see changes`.

The write sequence, always: read the bytes from disk → confirm they are the bytes we expect
(same `lastModified` and size as our last read) → apply the delta to *those* bytes → write.
We never write a document assembled from the DOM.

**Drift.** If the disk file changed since our last read, we do not write. A banner takes over
the rail: *the file changed on disk — Reload*, sends are disabled, and the text you were
typing is kept as a draft in `chrome.storage.local`, offered back in the same reply box after
you reload. Reloading re-parses and re-anchors everything, including the agent's new replies,
which is the behaviour you asked for. While connected, the file's `lastModified` and size are
polled every few seconds while the tab is visible, on focus, and immediately before every
write. Before connecting there is no way to notice a change, which is part of why the
not-connected state is loud rather than subtle.

### Surviving a reload

Reloading is part of the loop, so the cheap parts of your place in the document are kept per
path in `chrome.storage.local`: scroll position, which cards are expanded, the Open / All
filter, and pane width. That is the whole state layer — no session restore, no undo history.
Keyed by absolute path, cleared by the per-file "don't take over" toggle being switched on.

### Handing off to agents

The rail header has **Copy brief**, which puts a paste-ready prompt on the clipboard: the
file's absolute path, the open thread ids with their flagged text and reply counts, and an
instruction to read the file, answer in the matching `### T<n>` block, and resolve what it
settles. Agent-raised threads are listed too. The document is the handoff; the brief is only
the pointer. The same text is printed on the extension's onboarding page so you can see the
format before trusting it.

### Settings

A minimal options page: your display name (default `dan`), theme (system / light / dark),
reading width, and a per-file "don't take over this file" toggle. Plus **Open sample file**,
which loads a fixture into a fresh tab so the format can be seen without touching a real
document.

### Failure modes

| Situation | Behaviour |
| --- | --- |
| Agent deleted the flagged text | Thread kept, tagged **span removed**, with the last recorded `on:` text |
| Marker pair with one half missing | Tagged **incomplete pair**, left untouched in the file |
| Selection crosses a link, code span or autolink | Trimmed to the largest safe range and announced, or refused if none |
| Selection inside a fenced code block | Refused, with the reason |
| Two thread ids in use twice | Both rendered, flagged in the rail as **duplicate id**, nothing written until you fix it |
| `@threads` block deleted | Threads parsed from marker pairs alone (flagged text intact, replies lost) — warn loudly and offer to recreate the block before writing |
| File deleted or unreadable since load | Write refused, banner: **file is gone** |
| Picker cancelled | Nothing written, state unchanged, still **Not connected** |
| Same file open in two tabs | Second tab's write trips the drift guard → reload banner. Known and honest. |
| Malformed reply line | Still shown, worst case as an unknown author with raw text |
| Thread you regret | Resolve it. No delete in v1; the markers and the block stay |
| "Allow access to file URLs" left off | Nothing injects; the toolbar action explains and links to the setting |
| Document past ~3 MB | Renders as far as it can and says where it stopped; never writes in that state |

## Build order

1. **Spike, throwaway:** minimal MV3 manifest and content script matching `file:///*` and
   `*.md`, proving it injects into Chrome's plain-text viewer tab, can replace the document,
   and can open `showOpenFilePicker` and write back to the same file. A day at most; it either
   confirms the design or triggers the escalation rule.
2. **Spike the span mapping:** select text in a rendered fixture, land on exact source
   offsets, insert a marker pair, reload, get the highlight back — over headings, nested
   lists, tables, links and emphasis. If offset mapping proves unreliable for a construct,
   that construct joins the refuse list; the design does not change.
3. Parser/serializer modules and their fixtures, under Node — including CRLF, trailing
   newline, unicode, nested lists, code fences, tables.
4. Reading view: render, typography, dark mode, `Show source`.
5. Anchoring for real: popover, shrink rules, highlight, rebuild on reload.
6. Rail: cards, replies, resolve, filter, agent-raised threads.
7. Handle lifecycle: connect, persist, reconnect, permission.
8. Write path with the drift guard.
9. Copy brief, settings, onboarding, install instructions, polish.

## Calls I made, not yours

- Name `Threadmark`, repo `~/dev/threadmark`.
- Paired inline markers delimiting the span, rather than one marker at a block boundary plus
  a stored quote to search for — your "any arbitrary piece of text, not tied to paragraphs"
  answer is what rules this in, and it also makes rewording harmless.
- The `on:` line in the threads block kept as a human- and agent-readable record, with no
  parsing depending on it.
- Threads block at the end of the file rather than scattered after each thread; your "a
  section" sounded like one gathering place.
- Tolerant parsing, minimal writing, never reformat an agent's lines.
- Drift = refuse and ask to reload, per your instruction, with your unsent message kept as a
  draft rather than lost. (Merging into a changed body is a deliberate v2 idea, not v1.)
- Annotations allowed before connecting, clearly marked unsaved, kept in
  `chrome.storage.local`, flushed on connect.
- Reload keeps scroll, expanded cards, filter, pane width. Nothing else.
- The `@threads` block is hidden in the reading pane; `Show source` reveals it.
- Agent-raised threads with no marker are first-class in the rail, tagged, sorted last.
- Author name from settings, default `dan`.
- No thread deletion in v1; resolving is the cleanup.
- ~3 MB target, no virtualized rendering.
- markdown-it + DOMPurify + highlight.js vendored; esbuild for the bundle; vitest for the
  pure modules. No framework, no build server.
- Content script injects plain DOM with `tm-` prefixed classes and one stylesheet, no shadow
  root — the page is ours to replace, so there is nothing to style-collide with.

## What success looks like

You open a real agent-written document from last week by typing its `file://` URL, read it
without squinting, mark three sentences without leaving the keyboard much, tell an agent to
review the file, watch it answer in the rail after a reload, reply once, and see the file on
disk carry all of it. Nothing costs money, nothing phones home, and the document is still
perfectly readable in your editor with the extension switched off.
