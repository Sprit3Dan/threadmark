// The threads block: parsed leniently, written minimally.
//
// An agent writes replies by typing a line, in whatever shape feels natural. We
// have to read all of that and still write only what we add — never reformat a
// line we did not write, or your diffs and your agents' formatting both get eaten.

import { THREADS_START, THREADS_END, findMarkers } from "./markers.js";

const HEADING_RE = /^\s{0,3}#{1,6}\s*T([0-9]+)\b(.*)$/i;
const STATUS_RE = /\b(open|resolved|wip|done)\b/i;
const ON_RE = /^\s*>\s*on:\s*(.*)$/;
const LIST_RE = /^\s*([-*+]|\d+[.)])\s+/;
// "**dan** · 2026-10-22 18:14 — text". The separator before the text is an em or
// en dash, which is what lets a stamp contain hyphens and a body contain dashes.
const AUTHOR_DOTTED_RE = /^\s*[-*+]\s*\*\*(.+?)\*\*\s*[·•]\s*(.+?)\s*[—–]\s*([\s\S]*)$/;
// The same with a plain hyphen, only when the stamp is recognisably a timestamp.
const AUTHOR_HYPHEN_RE = /^\s*[-*+]\s*\*\*(.+?)\*\*\s*[·•]\s*(\d{4}-\d{2}-\d{2}([ T]\d{1,2}:\d{2})?)\s*[-—–]\s*([\s\S]*)$/;
const AUTHOR_COLON_RE = /^\s*[-*+]\s*(?:\*\*(.+?)\*\*|([^*\s][^:]*))\s*[:：]\s*([\s\S]*)$/;
const AUTHOR_ONLY_RE = /^\s*[-*+]\s*\*\*(.+?)\*\*\s*[—–-]?\s*([\s\S]*)$/;
const QUOTE_RE = /"([\s\S]*?)"/;
const CONTEXT_RE = /[—–-]{1,2}\s*in\s*"([\s\S]*?)"\s*$/;

/**
 * Written at the top of every new threads block, so an agent that reads the file
 * knows how to take part without being told. Invisible when rendered.
 */
export const AGENT_NOTE =
  "<!-- Review threads (Threadmark). Reply by adding a line at the end of a thread: " +
  "- **your-name** · YYYY-MM-DD HH:MM — text (indent continuation lines two spaces). " +
  "Change open to resolved in a heading when it is settled. In the document, the comment pair " +
  "@tN:start / @tN:end marks the text thread TN is about; don't move or delete those markers. -->";

export function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(^|[^\r])\n/g) || []).length;
  return crlf > lf ? "\r\n" : "\n";
}

/** Where the threads block lives, if it does. */
export function locateBlock(text) {
  const start = text.indexOf(THREADS_START);
  if (start === -1) return null;
  const end = text.indexOf(THREADS_END, start);
  return { start, end: end === -1 ? text.length : end, closed: end !== -1 };
}

/**
 * Read every thread out of the file. Threads with no block entry but with a marker
 * pair are found elsewhere; entries with no marker pair come back as agent-raised.
 *
 * @returns {{present:boolean, closed:boolean, threads:Array}}
 */
export function parseThreads(text) {
  const block = locateBlock(text);
  if (!block) return { present: false, closed: true, threads: [] };

  const bodyStart = block.start + THREADS_START.length;
  const body = text.slice(bodyStart, block.end);
  const base = bodyStart;
  // Split by hand: a CRLF file's separators are two characters, and every offset
  // we record has to be right in the file as saved.
  const lines = [];
  const offsets = [];
  for (let at = 0; ; ) {
    const nl = body.indexOf("\n", at);
    offsets.push(base + at);
    if (nl === -1) {
      lines.push(body.slice(at));
      break;
    }
    const cr = body[nl - 1] === "\r";
    lines.push(body.slice(at, cr ? nl - 1 : nl));
    at = nl + 1;
  }

  const threads = [];
  let current = null;
  let lastMessage = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = HEADING_RE.exec(line);
    if (h) {
      current = {
        id: Number(h[1]),
        status: (STATUS_RE.exec(h[2] || "") || [null, "open"])[1].toLowerCase() === "resolved" ? "resolved" : "open",
        headingText: line.trim(),
        headingSrcStart: offsets[i],
        headingLineEnd: offsets[i] + line.length,
        srcStart: offsets[i],
        srcEnd: offsets[i],
        quote: null,
        context: null,
        messages: [],
        blockLineCount: 0,
      };
      threads.push(current);
      lastMessage = null;
      continue;
    }
    if (!current) continue;
    current.srcEnd = offsets[i] + line.length;
    if (line.trim() === "") continue;

    const on = ON_RE.exec(line);
    if (on) {
      const quoted = QUOTE_RE.exec(on[1]);
      if (quoted) current.quote = quoted[1];
      const ctx = CONTEXT_RE.exec(on[1]);
      if (ctx) current.context = ctx[1];
      current.quoteLineStart = offsets[i];
      current.quoteLineEnd = offsets[i] + line.length;
      lastMessage = null;
      continue;
    }

    if (LIST_RE.test(line)) {
      const message = parseMessageLine(line);
      current.messages.push({ ...message, srcStart: offsets[i], srcEnd: offsets[i] + line.length });
      lastMessage = current.messages[current.messages.length - 1];
      continue;
    }

    // Continuation of the previous message, or prose an agent added by hand.
    if (lastMessage) {
      lastMessage.body += "\n" + line.trim();
      lastMessage.srcEnd = offsets[i] + line.length;
    } else {
      current.messages.push({ author: "unknown", stamp: null, body: line.trim(), srcStart: offsets[i], srcEnd: offsets[i] + line.length });
    }
  }

  return { present: true, closed: block.closed, threads };
}

function parseMessageLine(line) {
  let m = AUTHOR_DOTTED_RE.exec(line) || AUTHOR_HYPHEN_RE.exec(line);
  if (m) return { author: m[1].trim(), stamp: m[2].trim(), body: m[3].trim() };
  m = AUTHOR_COLON_RE.exec(line);
  if (m) return { author: (m[1] || m[2] || "unknown").trim(), stamp: null, body: m[3].trim() };
  m = AUTHOR_ONLY_RE.exec(line);
  if (m && !/^\d{4}-/.test(m[2])) return { author: m[1].trim(), stamp: null, body: m[2].trim() };
  return { author: "unknown", stamp: null, body: line.replace(LIST_RE, "").trim() };
}

/** A message line as we write it. */
export function messageLine(author, stamp, body) {
  const lines = String(body).replace(/\r\n/g, "\n").split("\n");
  const first = `- **${author}** · ${stamp} — ${lines[0].trim()}`;
  return [first, ...lines.slice(1).map((l) => "  " + l.trim())].join("\n");
}

export function threadHeading(id, status) {
  return `### T${id} · ${status}`;
}

function insertLines(text, at, lines, eol) {
  const chunk = lines.join(eol);
  const before = text.slice(0, at);
  const after = text.slice(at);
  const needsLead = before.length > 0 && !before.endsWith(eol) && !before.endsWith("\n");
  return before + (needsLead ? eol : "") + chunk + (after.startsWith("\n") || after.startsWith("\r") || after === "" ? "" : eol) + after;
}

/**
 * Append a message to a thread, creating the thread entry and then the block if
 * either is missing. Only our own lines are added.
 *
 * @param {{author:string, stamp:string, body:string, quote?:string, context?:string}} message
 */
export function appendMessage(text, thread, message, eol = detectEol(text)) {
  const line = messageLine(message.author, message.stamp, message.body).split("\n").join(eol);
  if (thread && thread.messages.length) {
    const last = thread.messages[thread.messages.length - 1];
    return insertLines(text, last.srcEnd, [line], eol);
  }
  if (thread) {
    return insertLines(text, thread.headingLineEnd, ["", line], eol);
  }
  return appendThread(text, { id: message.id, status: "open", quote: message.quote, context: message.context }, [line], eol);
}

/** Add a whole thread entry at the end of the block. */
export function appendThread(text, thread, messageLines, eol = detectEol(text)) {
  const entry = [
    "",
    threadHeading(thread.id, thread.status || "open"),
    ...(thread.quote ? ["", `> on: "${thread.quote}"${thread.context ? ` — in "${thread.context}"` : ""}`] : []),
    ...(messageLines && messageLines.length ? ["", ...messageLines] : []),
  ];
  const block = locateBlock(text);
  if (block && block.closed) {
    return insertLines(text, block.end, entry, eol);
  }
  if (block && !block.closed) {
    // The block runs to the end of the file; add to its end and close it there,
    // so the threads already in it stay inside it.
    const tail = text.endsWith("\n") ? "" : eol;
    return text + tail + entry.join(eol) + eol + eol + THREADS_END + eol;
  }
  const header = [THREADS_START, AGENT_NOTE, "", "## Review threads", ...entry, "", THREADS_END];
  const tail = text.endsWith("\n") ? "" : eol;
  return text + tail + eol + header.join(eol) + eol;
}

/** Rewrite only the status token in a thread's heading. */
export function setStatus(text, thread, status) {
  const line = text.slice(thread.headingSrcStart, thread.headingLineEnd);
  const replaced = STATUS_RE.test(line)
    ? line.replace(STATUS_RE, status)
    : `${line} · ${status}`;
  return text.slice(0, thread.headingSrcStart) + replaced + text.slice(thread.headingLineEnd);
}

/** Replace the `on:` record line for a thread, or add one under its heading. */
export function setQuote(text, thread, quote, context, eol = detectEol(text)) {
  const wanted = `> on: "${quote}"${context ? ` — in "${context}"` : ""}`;
  if (thread.quoteLineStart !== undefined) {
    return text.slice(0, thread.quoteLineStart) + wanted + text.slice(thread.quoteLineEnd);
  }
  return insertLines(text, thread.headingLineEnd, [wanted], eol);
}

/** Length of the line break at `at`, if there is one. */
function breakAt(text, at) {
  if (text.startsWith("\r\n", at)) return 2;
  return text[at] === "\n" ? 1 : 0;
}

/**
 * Find a message again in the current bytes: same thread, same position, same
 * author and text as the copy on screen. Null if an edit on disk moved it, so a
 * change never lands on someone else's line.
 */
export function findMessage(text, threadId, index, expected) {
  const thread = parseThreads(text).threads.find((t) => t.id === threadId);
  if (!thread) return null;
  const same = (m) => m && m.author === expected.author && m.body === expected.body && m.stamp === expected.stamp;
  const at = same(thread.messages[index]) ? index : thread.messages.findIndex(same);
  return at === -1 ? null : { thread, message: thread.messages[at], index: at };
}

/** Rewrite one message's text, keeping its author and timestamp. */
export function replaceMessage(text, message, body, eol = detectEol(text)) {
  const line = messageLine(message.author, message.stamp || "", body).split("\n").join(eol);
  return text.slice(0, message.srcStart) + line + text.slice(message.srcEnd);
}

/** Remove one message, continuation lines included. */
export function removeMessage(text, message) {
  return text.slice(0, message.srcStart) + text.slice(message.srcEnd + breakAt(text, message.srcEnd));
}

/**
 * Remove a thread completely: its marker pair (block markers with their lines)
 * and its entry in the threads block. The block itself goes when it is empty.
 */
export function removeThread(text, id) {
  const thread = parseThreads(text).threads.find((t) => t.id === id);
  if (thread) {
    const block = locateBlock(text);
    let end = thread.srcEnd;
    if (end < block.end) end += breakAt(text, end);
    text = text.slice(0, thread.headingSrcStart) + text.slice(end);
    const after = parseThreads(text);
    if (after.present && after.closed && !after.threads.length) {
      const b = locateBlock(text);
      let from = b.start;
      while (from > 0 && /[\r\n]/.test(text[from - 1])) from--;
      let to = b.end + THREADS_END.length;
      to += breakAt(text, to);
      const keepBreak = from > 0 ? detectEol(text) : "";
      text = text.slice(0, from) + keepBreak + text.slice(to);
    }
  }
  const mine = findMarkers(text).filter((m) => m.id === id);
  for (const m of mine.reverse()) text = text.slice(0, m.originalIndex) + text.slice(m.originalIndex + m.length);
  return text;
}

/** Remove every resolved thread, markers and entries, in one edit. */
export function removeResolved(text) {
  const ids = parseThreads(text)
    .threads.filter((t) => t.status === "resolved")
    .map((t) => t.id);
  return { text: ids.reduce((acc, id) => removeThread(acc, id), text), removed: ids };
}
