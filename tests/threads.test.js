import { describe, it, expect } from "vitest";
import {
  parseThreads,
  appendMessage,
  appendThread,
  setStatus,
  detectEol,
  locateBlock,
  messageLine,
} from "../src/core/threads.js";
import { THREADS_START, THREADS_END } from "../src/core/markers.js";

const BLOCK = `${THREADS_START}

## Review threads

### T3 · open
> on: "latency is 40ms" — in "Latency results"
- **dan** · 2026-10-22 18:14 — this contradicts §2, which measured 12ms
- **claude** · 2026-10-22 18:31 — correct, §2 is the real number. Fixing.

### T4 · resolved
- **dan** · 2026-10-22 18:20 — typo: "recieve"

<!-- @threads:ignore-me -->
Not a thread heading, and must stay untouched.
- **ghost** · never — invisible to us

${THREADS_END}
`;

const DOC = `# Latency results

The p95 latency is 40ms.

${BLOCK}`;

describe("parseThreads", () => {
  it("reads threads, statuses, quotes and messages", () => {
    const { present, threads } = parseThreads(DOC);
    expect(present).toBe(true);
    expect(threads.map((t) => [t.id, t.status])).toEqual([
      [3, "open"],
      [4, "resolved"],
    ]);
    const t3 = threads[0];
    expect(t3.quote).toBe("latency is 40ms");
    expect(t3.context).toBe("Latency results");
    expect(t3.messages.map((m) => m.author)).toEqual(["dan", "claude"]);
    expect(t3.messages[0].stamp).toBe("2026-10-22 18:14");
    expect(t3.messages[0].body).toContain("contradicts §2");
  });

  it("accepts the shapes an agent might actually write", () => {
    const loose = `${THREADS_START}
### T5
- **agent**: looks good to me
- 1. numbered reply is still a reply
- **someone** — just a dash
- bare line with no author at all
${THREADS_END}`;
    const { threads } = parseThreads(loose);
    expect(threads).toHaveLength(1);
    expect(threads[0].status).toBe("open");
    expect(threads[0].messages.map((m) => m.author)).toEqual(["agent", "unknown", "someone", "unknown"]);
    expect(threads[0].messages[0].body).toBe("looks good to me");
  });

  it("joins a continuation line onto the message it belongs to", () => {
    const cont = `${THREADS_START}
### T6 · open
- **dan** · 2026-10-22 09:00 — first line
  indented continuation
${THREADS_END}`;
    const { threads } = parseThreads(cont);
    expect(threads[0].messages).toHaveLength(1);
    expect(threads[0].messages[0].body).toBe("first line\nindented continuation");
  });

  it("says so when the block was cut in half", () => {
    const { closed } = parseThreads(`${THREADS_START}\n### T1 · open\n`);
    expect(closed).toBe(false);
  });
});

describe("writing", () => {
  it("adds exactly one line and leaves every other byte alone", () => {
    const { threads } = parseThreads(DOC);
    const before = DOC.slice(0, threads[0].messages[1].srcEnd);
    const after = appendMessage(DOC, threads[0], { author: "dan", stamp: "2026-10-22 19:02", body: "thanks" });
    expect(after.startsWith(before)).toBe(true);
    const added = after.slice(before.length);
    const inserted = added.split("\n");
    expect(inserted[0]).toBe(""); // the line break that ends the previous message
    expect(inserted[1]).toBe("- **dan** · 2026-10-22 19:02 — thanks");
    expect(added.slice((inserted[0] + inserted[1]).length + 1)).toBe(DOC.slice(before.length));
  });

  it("keeps a multi-paragraph reply readable", () => {
    const line = messageLine("dan", "2026-10-22 19:02", "first para\nsecond para");
    expect(line).toBe("- **dan** · 2026-10-22 19:02 — first para\n  second para");
  });

  it("creates the block at the end of a file that has none", () => {
    const plain = "# Notes\n\nA paragraph.\n";
    const out = appendThread(plain, { id: 1, status: "open", quote: "A paragraph.", context: "Notes" }, [
      messageLine("dan", "2026-10-22 20:00", "flagged"),
    ]);
    expect(out.startsWith(plain)).toBe(true);
    expect(out).toContain(THREADS_START);
    expect(out).toContain("## Review threads");
    expect(out.trimEnd().endsWith(THREADS_END)).toBe(true);
    const { threads } = parseThreads(out);
    expect(threads[0].messages[0].body).toBe("flagged");
  });

  it("closes a block that was missing its end marker", () => {
    const broken = `Body\n\n${THREADS_START}\n\n### T1 · open\n`;
    const out = appendThread(broken, { id: 2, status: "open" }, [messageLine("dan", "x", "y")]);
    expect(locateBlock(out).closed).toBe(true);
    expect(parseThreads(out).threads.map((t) => t.id)).toEqual([1, 2]);
  });

  it("flips a status by rewriting that token only", () => {
    const { threads } = parseThreads(DOC);
    const out = setStatus(DOC, threads[0], "resolved");
    expect(out).toContain("### T3 · resolved");
    expect(out.replace("### T3 · resolved", "### T3 · open")).toBe(DOC);
  });

  it("preserves CRLF", () => {
    const crlf = DOC.replace(/\n/g, "\r\n");
    expect(detectEol(crlf)).toBe("\r\n");
    const { threads } = parseThreads(crlf);
    const out = appendMessage(crlf, threads[0], { author: "dan", stamp: "s", body: "b" });
    expect(out).toContain("- **dan** · s — b\r\n");
    expect((out.match(/\r\n/g) || []).length).toBe((crlf.match(/\r\n/g) || []).length + 1);
  });

  it("does not touch text after the block", () => {
    const doc = DOC + "\nFooter paragraph that must not move.\n";
    const { threads } = parseThreads(doc);
    const out = appendMessage(doc, threads[1], { author: "dan", stamp: "s", body: "b" });
    expect(out.endsWith("\nFooter paragraph that must not move.\n")).toBe(true);
  });
});

import { findMessage, replaceMessage, removeMessage, removeThread } from "../src/core/threads.js";

describe("editing and deleting", () => {
  const BODY = "The p95 <!-- @t1:start -->latency<!-- @t1:end --> is fine.\n\n```js\nx\n```\n";
  const withThreads = (entries) => BODY + "\n<!-- @threads:start -->\n\n## Review threads\n" + entries + "\n<!-- @threads:end -->\n";
  const T1 = "\n### T1 · open\n\n> on: \"latency\"\n\n- **dan** · 2026-10-22 10:00 — first\n  second line\n- **claude** · 2026-10-22 10:05 — reply\n";
  const T2 = "\n### T2 · open\n\n- **dan** · 2026-10-22 11:00 — on code\n";
  const doc = withThreads(T1 + T2).replace("```js", "<!-- @t2:start -->\n```js").replace("```\n\n<!--", "```\n<!-- @t2:end -->\n\n<!--");

  it("finds a message by position, author and text", () => {
    const found = findMessage(doc, 1, 0, { author: "dan", stamp: "2026-10-22 10:00", body: "first\nsecond line" });
    expect(found.message.body).toBe("first\nsecond line");
    expect(findMessage(doc, 1, 0, { author: "dan", stamp: "2026-10-22 10:00", body: "something else" })).toBe(null);
  });

  it("rewrites a message in place, continuation lines and all", () => {
    const { message } = findMessage(doc, 1, 0, { author: "dan", stamp: "2026-10-22 10:00", body: "first\nsecond line" });
    const out = replaceMessage(doc, message, "edited\nnow two");
    expect(out).toContain("- **dan** · 2026-10-22 10:00 — edited\n  now two\n- **claude** · 2026-10-22 10:05 — reply\n");
    expect(out.replace("edited\n  now two", "first\n  second line")).toBe(doc);
  });

  it("removes one message and nothing else", () => {
    const { message } = findMessage(doc, 1, 0, { author: "dan", stamp: "2026-10-22 10:00", body: "first\nsecond line" });
    const out = removeMessage(doc, message);
    expect(out).toBe(doc.replace("- **dan** · 2026-10-22 10:00 — first\n  second line\n", ""));
  });

  it("removes a whole thread: inline markers and its entry", () => {
    const out = removeThread(doc, 1);
    expect(out).toContain("The p95 latency is fine.");
    expect(out).not.toMatch(/### T1|@t1:/);
    expect(parseThreads(out).threads.map((t) => t.id)).toEqual([2]);
  });

  it("removes a thread anchored by block markers, lines and all", () => {
    const out = removeThread(doc, 2);
    expect(out).toContain("is fine.\n\n```js\nx\n```\n");
    expect(out).not.toMatch(/@t2:|### T2/);
  });

  it("removes the threads block once it is empty, restoring the original file", () => {
    const out = removeThread(removeThread(doc, 1), 2);
    expect(out).toBe(BODY.replace("<!-- @t1:start -->latency<!-- @t1:end -->", "latency"));
  });
});

import { removeResolved } from "../src/core/threads.js";

describe("cleaning up resolved threads", () => {
  const body = "A <!-- @t1:start -->one<!-- @t1:end --> B <!-- @t2:start -->two<!-- @t2:end --> C <!-- @t3:start -->three<!-- @t3:end -->.\n";
  const block = (statuses) =>
    "\n<!-- @threads:start -->\n\n## Review threads\n" +
    statuses.map((st, k) => `\n### T${k + 1} · ${st}\n\n- **dan** · 2026-10-22 10:0${k} — m${k + 1}\n- **claude** · 2026-10-22 10:1${k} — r${k + 1}\n`).join("") +
    "\n<!-- @threads:end -->\n";

  it("removes resolved threads, whoever wrote in them, and keeps the open ones", () => {
    const { text, removed } = removeResolved(body + block(["resolved", "open", "resolved"]));
    expect(removed).toEqual([1, 3]);
    expect(text).toContain("A one B <!-- @t2:start -->two<!-- @t2:end --> C three.");
    expect(parseThreads(text).threads.map((t) => t.id)).toEqual([2]);
  });

  it("restores the original file when every thread was resolved", () => {
    const { text } = removeResolved(body + block(["resolved", "resolved", "resolved"]));
    expect(text).toBe("A one B two C three.\n");
  });

  it("changes nothing when nothing is resolved", () => {
    const doc = body + block(["open", "open", "open"]);
    expect(removeResolved(doc)).toEqual({ text: doc, removed: [] });
  });
});

import { AGENT_NOTE } from "../src/core/threads.js";
import { analyze } from "../src/core/doc.js";
import { findMarkers } from "../src/core/markers.js";

describe("the note for agents", () => {
  it("opens every new threads block and stays a single invisible comment", () => {
    const out = appendThread("Body.\n", { id: 1, status: "open", quote: "Body" }, [messageLine("dan", "s", "m")]);
    expect(out).toContain(THREADS_START + "\n" + AGENT_NOTE + "\n");
    expect(AGENT_NOTE.indexOf("-->")).toBe(AGENT_NOTE.length - 3); // nothing closes it early
    expect(findMarkers(AGENT_NOTE)).toEqual([]); // and it holds no real marker
    const visible = analyze(AGENT_NOTE + "\n\nText.\n").html.replace(/<!--[\s\S]*?-->/g, "");
    expect(visible).not.toMatch(/Reply by|&lt;|-->/);
    expect(parseThreads(out).threads.map((t) => t.id)).toEqual([1]);
  });
});
