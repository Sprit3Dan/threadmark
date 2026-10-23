# Threadmark

Read local markdown in Chrome and leave review threads on any part of it. Threads are stored **in the file itself**, so the agent that wrote the document can read your comments and reply by editing the same file. No server, no account, no export.

```
┌──────────────────────────────────────────────┬──────────────────────────┐
│ Payment retry review                         │ plan.md     ● Saved 18:31│
│                                              │ [Open 2 | All 3]   Source│
│ The queue ▒retries forever▒ on a 500, …      │ ┌──────────────────────┐ │
│                                              │ │ T1            Resolve│ │
│ ```python                                    │ │ ▌retries forever     │ │
│ def retry(job): …                            │ │ dan  why forever?    │ │
│ ```                                          │ │ claude  capping at 5 │ │
│                                              │ │ [Reply…            ] │ │
└──────────────────────────────────────────────┴──────────────────────────┘
```

## Install

Threadmark isn't in the Chrome Web Store. Build it and load it unpacked:

```sh
npm install
npm run build          # writes dist/
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** → choose the `dist/` folder.
3. Open the extension's **Details** and turn on **Allow access to file URLs**. Without it Chrome never runs the extension on local files, and nothing tells you so; the toolbar popup shows whether it's on.

After pulling changes, run `npm run build` again and click reload on the extension's card.

## Use

Open any `.md` file by its `file://` URL. Threadmark replaces Chrome's plain-text view with the rendered document on the left and the threads on the right; drag the divider to resize.

| Action | How |
| --- | --- |
| Comment on a selection | Select text → **Comment** (or press **C**, or **⌘⌥M**) |
| Send | **⌘↵** |
| Cancel a new comment or an edit | **Esc** |
| Reply, resolve, reopen | In the thread's card |
| Edit or delete your own message | Hover it → **Edit** / **Delete** |
| Delete a whole thread of yours | Hover the card → **Delete** in its header |
| Remove all resolved threads from the file | **Clean up** under the cards |
| See the raw file, markers and all | **Source** |

You can annotate anything you can select: prose, headings, wrapped bullets, table cells, inline code, links, fenced code blocks and raw HTML.

### Connecting the file

Chrome won't let a page write a file without your OK, so the first time you send a comment, Threadmark asks for one:

- **Choose folder…** (recommended): pick the folder you keep documents in, such as `~/dev`. Every `.md` under it is then connected automatically, including tabs that are already open. After a Chrome restart, Chrome asks once more; choose **Allow on every visit** and it stops asking.
- **Just this file**: pick the one file.

Chrome refuses some folders outright, your home folder itself among them; pick a folder inside it.

While a file is connected, changes made on disk (an agent replying, say) show up within about two seconds, with no reload.

### Settings

Toolbar icon → **Settings**: your name in replies (default `dan`), theme, and a list of files Threadmark should leave alone.

## The format in the file

The selected text is wrapped in a pair of HTML comments, which renderers don't show:

```markdown
The queue <!-- @t1:start -->retries forever<!-- @t1:end --> on a 500.
```

Where a comment can't go inline (inside a code block or raw HTML), the pair goes on lines of its own around the whole block. `skip`/`len` record exactly which characters were selected:

````markdown
<!-- @t2:start skip=21 len=13 -->
```sql
SELECT count(*) FROM invalidations WHERE bucket = 'write-heavy';
```
<!-- @t2:end -->
````

The threads themselves live in one block at the end of the file:

```markdown
<!-- @threads:start -->
<!-- Review threads (Threadmark). Reply by adding a line at the end of a thread: … -->

## Review threads

### T1 · open

> on: "retries forever" — in "Payment retry review"

- **dan** · 2026-10-22 18:14 — why forever? the on-call has asked twice
- **claude** · 2026-10-22 18:31 — agreed, capping at five with a DLQ

<!-- @threads:end -->
```

- `### T<n> · open|resolved`: one entry per thread; `T1` matches the `@t1` markers.
- `> on:`: a copy of the selected text and the heading it sits under, so the block reads on its own.
- `- **name** · YYYY-MM-DD HH:MM — text`: one message per line; continuation lines are indented two spaces.
- A thread with no markers is an agent raising its own point; it shows up in the rail tagged *agent-raised*.

## Working with agents

Tell the agent to read the file and reply to the open threads. The comment at the top of the threads block explains the format, so the agent needs nothing else. Parsing is forgiving (`- **claude**: looks good` works too), and Threadmark only ever writes its own lines, so whatever an agent writes is left exactly as it is.

## Develop

```sh
npm test               # unit tests (vitest) for the pure modules in src/core
npm run e2e            # builds dist-dev/ and drives a real Chrome through the UI
node dev/e2e.mjs --shot                  # same, saving screenshots
node dev/e2e.mjs --file path/to/doc.md   # render a real document and screenshot it
```

The end-to-end run needs Chrome for Testing (`npx playwright install chromium`), because branded Chrome ignores `--load-extension`. See [AGENTS.md](AGENTS.md) for how the code is laid out and the rules it keeps.

## License

MIT
