import { describe, it, expect } from "vitest";
import { analyze, projection } from "../src/core/doc.js";
import { stripMarkers } from "../src/core/markers.js";
import { parseThreads } from "../src/core/threads.js";
import { spanForSelection, resolveMarkers, addThread, relocateSpan } from "../src/core/annotate.js";

const STAMP = "2026-10-22 19:40";

/** Select `snippet` in the rendered text of `text` the way the reading view does. */
function select(text, snippet) {
  const { clean, markers } = stripMarkers(text);
  const a = analyze(clean);
  a.markers = markers;
  for (const u of a.units.values()) {
    const at = projection(u).plain.indexOf(snippet);
    if (at === -1) continue;
    const info = spanForSelection(a, { start: { unit: u.i, plain: at }, end: { unit: u.i, plain: at + snippet.length } }, clean);
    expect(info.ok, info.reason).toBe(true);
    return { ...info, baseClean: clean };
  }
  throw new Error("not rendered: " + snippet);
}

function annotate(text, snippet, body = "note") {
  const sel = select(text, snippet);
  return addThread(text, { ...sel, context: null, author: "dan", stamp: STAMP, body });
}

function highlighted(text) {
  const { clean, markers } = stripMarkers(text);
  return Object.fromEntries(resolveMarkers(analyze(clean), markers).map((s) => [s.id, s.quote]));
}

describe("adding threads to a file", () => {
  it("writes the second annotation at the right place when markers already exist", () => {
    let doc = "Alpha first beta.\n\nGamma second delta.\n";
    doc = annotate(doc, "first").text;
    const { text, id } = annotate(doc, "second");
    expect(id).toBe(2);
    expect(text).toContain("Alpha <!-- @t1:start -->first<!-- @t1:end --> beta.");
    expect(text).toContain("Gamma <!-- @t2:start -->second<!-- @t2:end --> delta.");
    expect(highlighted(text)).toEqual({ 1: "first", 2: "second" });
  });

  it("nests a span selected over the same words as an existing one", () => {
    const once = annotate("We ship on Friday.\n", "Friday").text;
    const twice = annotate(once, "Friday").text;
    expect(twice).toContain("<!-- @t1:start --><!-- @t2:start -->Friday<!-- @t2:end --><!-- @t1:end -->");
    expect(highlighted(twice)).toEqual({ 1: "Friday", 2: "Friday" });
  });

  it("puts the span, the entry and the first message in one edit", () => {
    const { text } = annotate("# Plan\n\nRetry five times.\n", "five times", "why five?");
    const [t] = parseThreads(text).threads;
    expect(t).toMatchObject({ id: 1, status: "open", quote: "five times" });
    expect(t.messages).toEqual([expect.objectContaining({ author: "dan", stamp: STAMP, body: "why five?" })]);
  });

  it("picks an id that does not collide with a thread an agent added meanwhile", () => {
    const base = "One two three.\n";
    const sel = select(base, "two");
    const agentEdited =
      base + "\n<!-- @threads:start -->\n\n## Review threads\n\n### T4 · open\n\n- **claude** · x — raised\n\n<!-- @threads:end -->\n";
    const { id, text } = addThread(agentEdited, { ...sel, author: "dan", stamp: STAMP, body: "n" });
    expect(id).toBe(5);
    expect(parseThreads(text).threads.map((t) => t.id)).toEqual([4, 5]);
  });

  it("relocates a span measured on LF text into the CRLF file on disk", () => {
    const lf = "# Title\n\nFirst para.\n\nThe target words here.\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    const sel = select(lf, "target words");
    const { text } = addThread(crlf, { ...sel, author: "dan", stamp: STAMP, body: "n" });
    expect(text).toContain("The <!-- @t1:start -->target words<!-- @t1:end --> here.\r\n");
    expect(text.replace(/\r\n/g, "").includes("\n")).toBe(false); // no bare LF introduced
  });

  it("prefers the occurrence whose surroundings match", () => {
    const base = "a cat sat.\n\nthe cat ran.\n";
    const start = base.indexOf("cat", 5);
    const moved = "intro line\n\n" + base;
    const at = relocateSpan(base, start, start + 3, moved);
    expect(moved.slice(at.start - 4, at.end)).toBe("the cat");
  });

  it("refuses when the selected text is gone", () => {
    const sel = select("Keep this sentence.\n", "this sentence");
    expect(() => addThread("Something else entirely.\n", { ...sel, author: "dan", stamp: STAMP, body: "n" })).toThrow(/changed on disk/);
  });
});

describe("reading view", () => {
  it("does not render the threads block", () => {
    const { text } = annotate("Body text.\n", "Body");
    const { html } = analyze(stripMarkers(text).clean);
    expect(html).not.toMatch(/Review threads|@threads/);
    expect(html).toContain("Body");
  });

  it("hides HTML comments and renders inline HTML", () => {
    const { html } = analyze("Note <!-- hidden --> and <kbd>Esc</kbd>.\n\n<!-- block comment -->\n");
    expect(html).not.toContain("&lt;!--");
    expect(html).toContain("<kbd>Esc</kbd>");
  });

  it("wraps every annotatable unit so the view can find its text", () => {
    const { html } = analyze("# Title\n\nSome *text*.\n\n- [ ] task\n\n| a |\n| - |\n| cell |\n");
    expect(html.match(/class="tm-u"/g)).toHaveLength(5);
    expect(html).toContain('<span class="tm-u" data-tm-i="1" data-tm-line="2">Some <em>text</em>.</span>');
    expect(html).toMatch(/type="checkbox"><span class="tm-u"[^>]*>task<\/span>/);
  });

  it("gives headings ids so in-document links work", () => {
    const { html } = analyze("# Latency results\n\n## Latency results\n");
    expect(html).toContain('<h1 id="latency-results">');
    expect(html).toContain('<h2 id="latency-results-1">');
  });
});

describe("annotating everything", () => {
  it("maps bullets that wrap onto indented continuation lines", () => {
    const doc = "- Metres. Model frame of `x.json`:\n  **x forward**, y up.\n- next item\n";
    const a = analyze(doc);
    const units = [...a.units.values()];
    expect(units.every((u) => !u.unmappable)).toBe(true);
    const { text } = annotate(doc, "frame of x.json: x forward");
    expect(text).toContain("Model <!-- @t1:start -->frame of `x.json`:\n  **x forward**<!-- @t1:end -->, y up.");
    const { text: inner } = annotate(doc, "x forward");
    expect(inner).toContain("<!-- @t1:start -->**x forward**<!-- @t1:end -->");
    expect(highlighted(text)[1]).toBe("frame of x.json: x forward");
  });

  it("maps wrapped lines inside a blockquote", () => {
    const doc = "> first line of the quote\n> second line here\n";
    const { text } = annotate(doc, "quote second line");
    expect(text).toContain("of the <!-- @t1:start -->quote\n> second line<!-- @t1:end --> here");
  });

  function annotateBlock(doc, kindIndex, skip, len) {
    const { clean } = stripMarkers(doc);
    const block = analyze(clean).blocks[kindIndex];
    return addThread(doc, { baseClean: clean, start: block.a, end: block.b, startBlock: true, endBlock: true, skip, len, quote: "q", author: "dan", stamp: STAMP, body: "n" });
  }

  it("anchors a code block with markers on their own lines, and strips them back out exactly", () => {
    const doc = "Intro.\n\n```js\nconst a = 1;\n```\n\nOutro.\n";
    const { text } = annotateBlock(doc, 0, 6, 1);
    expect(text).toContain("Intro.\n\n<!-- @t1:start skip=6 len=1 -->\n```js\nconst a = 1;\n```\n<!-- @t1:end -->\n\nOutro.\n");
    const { clean, markers } = stripMarkers(text);
    expect(clean.startsWith(doc)).toBe(true);
    const span = resolveMarkers(analyze(clean), markers).find((s) => s.id === 1);
    expect(span).toMatchObject({ ok: true, startBlock: true, endBlock: true, skip: 6, len: 1, srcStart: 8, srcEnd: 31 });
  });

  it("keeps a block marker inside the list item its code belongs to", () => {
    const doc = "- step one\n\n  ```sh\n  make\n  ```\n- step two\n";
    const { text } = annotateBlock(doc, 0);
    expect(text).toContain("- step one\n\n  <!-- @t1:start -->\n  ```sh\n  make\n  ```\n  <!-- @t1:end -->\n- step two\n");
    expect(stripMarkers(text).clean.startsWith(doc)).toBe(true);
  });

  it("anchors a code block at the very end of a file with no trailing newline", () => {
    const doc = "Intro.\n\n```\ncode\n```";
    const { clean } = stripMarkers(doc);
    const block = analyze(clean).blocks[0];
    const marked = insertSpanFor(doc, block);
    expect(marked).toBe("Intro.\n\n<!-- @t1:start -->\n```\ncode\n```\n<!-- @t1:end -->");
    expect(stripMarkers(marked).clean).toBe(doc);
  });

  it("anchors raw HTML blocks and keeps <details> structure intact", () => {
    const doc = "<details>\n<summary>More</summary>\n\nInside text.\n\n</details>\n";
    const a = analyze(doc);
    expect(a.blocks.map((b) => b.kind)).toEqual(["html", "html"]);
    expect(a.html).toMatch(/<span class="tm-bs" data-tm-b="0-34"><\/span><details>/);
    expect([...a.units.values()].map((u) => u.src)).toEqual(["Inside text."]);
  });

  it("marks code blocks so the view can find them", () => {
    const { html } = analyze("```js\nx\n```\n\n    indented\n");
    expect(html).toMatch(/<code class="tm-b language-js" data-tm-b="0-12">/);
    expect(html).toMatch(/<pre class="tm-b" data-tm-b="13-26"><code>/);
  });
});

import { insertSpan } from "../src/core/markers.js";
function insertSpanFor(doc, block) {
  return insertSpan(doc, 1, block.a, block.b, { startBlock: true, endBlock: true });
}
