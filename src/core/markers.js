// Thread markers: the comment pairs that delimit an annotated span in the source.
//
//   The p95 <!-- @t3:start -->latency is 40ms<!-- @t3:end --> and we measured it twice.
//
// Inline markers are inserted at exact offsets with no added whitespace, so the
// text between a pair is byte-for-byte what the reader selected.
//
// Where a comment can't go inline — inside a fenced code block, raw HTML, a table
// that doesn't map cleanly — the pair goes on lines of their own around the whole
// block instead, and a block marker is removed together with its line:
//
//   <!-- @t4:start skip=12 len=30 -->
//   ```js
//   ...
//   ```
//   <!-- @t4:end -->
//
// `skip`/`len`, when present on a start marker, say which part of the rendered
// text between the pair was actually selected: skip that many characters, then
// highlight `len`. Without them the whole span is the selection.
//
// Indexes come in two flavours because removing a marker shifts every later
// character: `originalIndex` is where the marker (or its line) starts in the file
// as saved, `cleanIndex` is where it sits in the marker-free text we render.

const MARKER_RE = /<!--\s*@t([0-9]+):(start|end)((?:\s+[a-z]+=[0-9]+)*)\s*-->/gi;
// What may precede a block marker on its line: indentation and blockquote `>`s.
const LINE_PREFIX_RE = /^(?:[ \t]*>)*[ \t]*/;

export const THREADS_START = "<!-- @threads:start -->";
export const THREADS_END = "<!-- @threads:end -->";

/** Marker text exactly as we write it. */
export function markerText(id, side, attrs = {}) {
  const extra = Object.entries(attrs)
    .filter(([, v]) => Number.isFinite(v))
    .map(([k, v]) => ` ${k}=${v}`)
    .join("");
  return `<!-- @t${id}:${side}${extra} -->`;
}

/**
 * Every marker in the text, in order.
 * @param {string} text
 * @returns {Array<{id:number, side:'start'|'end', originalIndex:number, length:number,
 *            cleanIndex:number, block:boolean, skip?:number, len?:number}>}
 */
export function findMarkers(text) {
  const found = [];
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(text)) !== null) {
    const attrs = {};
    for (const [, k, v] of (m[3] || "").matchAll(/([a-z]+)=([0-9]+)/g)) attrs[k] = Number(v);
    const marker = {
      id: Number(m[1]),
      side: m[2].toLowerCase() === "start" ? "start" : "end",
      originalIndex: m.index,
      length: m[0].length,
      block: false,
      skip: attrs.skip,
      len: attrs.len,
    };
    // Alone on its line: a block marker, removed with its line.
    const lineStart = text.lastIndexOf("\n", m.index - 1) + 1;
    const nl = text.indexOf("\n", m.index + m[0].length);
    const lineEnd = nl === -1 ? text.length : nl;
    const before = text.slice(lineStart, m.index);
    const after = text.slice(m.index + m[0].length, lineEnd);
    if (LINE_PREFIX_RE.exec(before)[0] === before && /^[ \t]*\r?$/.test(after)) {
      marker.block = true;
      if (nl !== -1) {
        marker.originalIndex = lineStart;
        marker.length = nl + 1 - lineStart;
      } else if (lineStart > 0) {
        // Last line, no newline after it: take the newline before it instead.
        const cut = text[lineStart - 2] === "\r" ? 2 : 1;
        marker.originalIndex = lineStart - cut;
        marker.length = text.length - marker.originalIndex;
      }
    }
    found.push(marker);
  }
  let removed = 0;
  for (const f of found) {
    f.cleanIndex = f.originalIndex - removed;
    removed += f.length;
  }
  return found;
}

/** Remove every marker, leaving the text between them untouched. */
export function stripMarkers(text) {
  const markers = findMarkers(text);
  let out = "";
  let at = 0;
  for (const m of markers) {
    out += text.slice(at, m.originalIndex);
    at = m.originalIndex + m.length;
  }
  out += text.slice(at);
  return { clean: out, markers };
}

/** Highest id in use, so a new thread never collides with one an agent wrote. */
export function nextThreadId(markers, threadIds = []) {
  let max = 0;
  for (const m of markers) max = Math.max(max, m.id);
  for (const id of threadIds) max = Math.max(max, Number(id) || 0);
  return max + 1;
}

/**
 * Turn a clean coordinate into a coordinate in the file as saved.
 *
 * Where existing markers sit exactly at `cleanOffset` there is a choice of side:
 * a new span's start goes after them and its end goes before them, so a span
 * selected over the same words as an existing one nests inside it instead of
 * interleaving with it.
 *
 * @param {Array<{cleanIndex:number, length:number}>} markers from findMarkers
 * @param {number} cleanOffset
 * @param {'start'|'end'} side
 */
export function cleanToOriginal(markers, cleanOffset, side = "start") {
  let shift = 0;
  for (const m of markers) {
    if (m.cleanIndex < cleanOffset || (m.cleanIndex === cleanOffset && side === "start")) shift += m.length;
    else break;
  }
  return cleanOffset + shift;
}

/**
 * Splice a new marker pair into the file as saved, given the span in clean
 * coordinates — the ones the reading view and every selection are measured in.
 */
export function insertSpan(text, id, cleanStart, cleanEnd, opts = {}) {
  const markers = findMarkers(text);
  const s = cleanToOriginal(markers, cleanStart, "start");
  const e = cleanToOriginal(markers, cleanEnd, "end");
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const startMarker = markerText(id, "start", { skip: opts.skip, len: opts.len });
  const endMarker = markerText(id, "end");
  // A block marker line takes the indentation (and `>`s) of the block line next to
  // it, so it stays inside the list item or quote the block belongs to.
  let startText = startMarker;
  if (opts.startBlock) startText = LINE_PREFIX_RE.exec(text.slice(s))[0] + startMarker + eol;
  let endText = endMarker;
  if (opts.endBlock) {
    const atEof = e === text.length && !text.endsWith("\n");
    const lastLine = atEof ? e : e - 1;
    const prefix = LINE_PREFIX_RE.exec(text.slice(text.lastIndexOf("\n", lastLine - 1) + 1))[0];
    endText = atEof ? eol + prefix + endMarker : prefix + endMarker + eol;
  }
  return text.slice(0, s) + startText + text.slice(s, e) + endText + text.slice(e);
}

/**
 * Splice marker pairs into `text`, highest offset first so earlier insertions do
 * not move the positions of later ones.
 * @param {string} text file text as saved
 * @param {Array<{id:number, start:number, end:number}>} spans coordinates in `text`
 */
export function insertMarkers(text, spans) {
  const inserts = [];
  for (const span of spans) {
    inserts.push({ at: span.start, text: markerText(span.id, "start") });
    inserts.push({ at: span.end, text: markerText(span.id, "end") });
  }
  inserts.sort((a, b) => b.at - a.at || a.text.localeCompare(b.text));
  let out = text;
  for (const ins of inserts) out = out.slice(0, ins.at) + ins.text + out.slice(ins.at);
  return out;
}
