// Selections in, highlights out.
//
// Creating an annotation: the reader hands us a DOM selection, we turn it into a
// source range, adjust it off anything unsplittable, and splice a marker pair.
// Loading a document: the markers in the file are turned back into DOM ranges.
// Both directions go through source offsets, never through a search for similar
// looking text.

import { projection, unitAt } from "./doc.js";
import { nextThreadId, stripMarkers, insertSpan } from "./markers.js";
import { parseThreads, appendThread, messageLine, detectEol } from "./threads.js";

/** Character offset of a DOM point within a unit element's text. */
export function charOffset(unitEl, node, offset) {
  let total = 0;
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (n === node) {
      if (n.nodeType === 3) total += offset;
      else {
        let count = 0;
        for (let i = 0; i < offset && i < n.childNodes.length; i++) count += textLength(n.childNodes[i]);
        total += count;
      }
      found = true;
      return;
    }
    for (const child of n.childNodes) {
      if (contains(child, node)) {
        walk(child);
        if (found) return;
      }
    }
  };
  walk(unitEl);
  return found ? total : -1;
}

function textLength(node) {
  if (node.nodeType === 3) return node.data.length;
  if (node.nodeType !== 1) return 0;
  let n = 0;
  for (const c of node.childNodes) n += textLength(c);
  return n;
}

function contains(haystack, needle) {
  let n = needle;
  while (n) {
    if (n === haystack) return true;
    n = n.parentNode;
  }
  return false;
}

/**
 * A new annotation from what the reader selected.
 *
 * @param {object} analysis result of analyze()
 * @param {{start:{unit:object, plain:number}, end:{unit:object, plain:number}}} sel
 * @param {string} cleanText marker-free source text
 * @returns {{ok:true, start:number, end:number, quote:string, expanded:boolean, id:number}
 *          | {ok:false, reason:string}}
 */
export function spanForSelection(analysis, sel, cleanText, existingIds = []) {
  const startUnit = analysis.units.get(sel.start.unit);
  const endUnit = analysis.units.get(sel.end.unit);
  if (!startUnit || !endUnit) return { ok: false, reason: "can't anchor here" };
  if (startUnit.unmappable || endUnit.unmappable) return { ok: false, reason: "can't anchor this construct" };
  if (startUnit.srcStart < 0 || endUnit.srcStart < 0) return { ok: false, reason: "can't anchor here" };
  if (endUnit.i < startUnit.i) return { ok: false, reason: "select forwards to annotate" };

  let start;
  let end;
  let expanded = false;

  if (startUnit.i === endUnit.i) {
    const proj = projection(startUnit);
    const adj = proj.adjust(sel.start.plain, sel.end.plain);
    if (!adj) return { ok: false, reason: "nothing selected" };
    start = adj.start;
    end = adj.end;
    expanded = adj.expanded;
  } else {
    const sp = projection(startUnit);
    const ep = projection(endUnit);
    const a = sp.adjust(Math.min(sel.start.plain, sp.plain.length), sp.plain.length);
    const b = ep.adjust(0, Math.min(sel.end.plain, ep.plain.length));
    start = a ? a.start : sp.toSource(sp.plain.length);
    end = b ? b.end : ep.toSource(0);
    expanded = Boolean((a && a.expanded) || (b && b.expanded));
  }

  if (end <= start) return { ok: false, reason: "nothing left to annotate" };

  const quote = quoteBetween(analysis, start, end);
  if (!quote.trim()) return { ok: false, reason: "nothing left to annotate" };

  return {
    ok: true,
    start,
    end,
    quote,
    expanded,
    id: nextThreadId(analysis.markers || [], existingIds),
  };
}

/**
 * The unit a source offset belongs to, or the closest one before it with the
 * offset clamped to that unit's edge. A marker an agent or an editor nudged into
 * the whitespace between blocks still belongs to its paragraph.
 */
export function unitNear(units, offset) {
  const exact = unitAt(units, offset);
  if (exact) return { unit: exact, plain: projection(exact).toPlain(offset), displaced: false };

  let best = null;
  for (const u of units.values()) {
    if (u.unmappable || u.srcStart < 0) continue;
    const proj = projection(u);
    if (u.base <= offset && (!best || u.base > best.u.base)) best = { u, proj };
  }
  if (!best) return null;
  const endSrc = best.proj.end.length ? best.proj.end[best.proj.end.length - 1] : best.u.base;
  const plain = offset >= endSrc ? best.proj.plain.length : 0;
  return { unit: best.u, plain, displaced: true };
}

/**
 * Turn the markers in a file into spans the reader can draw.
 *
 * @returns {Array<{id:number, status?:string, ok:boolean, reason?:string,
 *            startUnit:object, startPlain:number, endUnit:object, endPlain:number,
 *            quote:string}>}
 */
export function resolveMarkers(analysis, markers) {
  const byId = new Map();
  for (const m of markers) {
    if (!byId.has(m.id)) byId.set(m.id, {});
    byId.get(m.id)[m.side] = m;
  }

  const out = [];
  for (const [id, pair] of [...byId.entries()].sort((a, b) => a[0] - b[0])) {
    if (!pair.start || !pair.end) {
      out.push({ id, ok: false, reason: "incomplete pair" });
      continue;
    }
    if (pair.end.cleanIndex < pair.start.cleanIndex) {
      out.push({ id, ok: false, reason: "markers the wrong way round" });
      continue;
    }
    const su = pair.start.block ? null : unitNear(analysis.units, pair.start.cleanIndex);
    const eu = pair.end.block ? null : unitNear(analysis.units, pair.end.cleanIndex);
    if ((!pair.start.block && !su) || (!pair.end.block && !eu)) {
      out.push({ id, ok: false, reason: "anchor lost" });
      continue;
    }
    out.push({
      id,
      ok: true,
      empty: pair.end.cleanIndex === pair.start.cleanIndex,
      displaced: Boolean((su && su.displaced) || (eu && eu.displaced)),
      startBlock: pair.start.block,
      endBlock: pair.end.block,
      skip: pair.start.skip,
      len: pair.start.len,
      srcStart: pair.start.cleanIndex,
      srcEnd: pair.end.cleanIndex,
      quote: quoteBetween(analysis, pair.start.cleanIndex, pair.end.cleanIndex),
    });
  }
  return out;
}

/** The visible text of a source range, which is what a card shows and `on:` records. */
export function quoteBetween(analysis, start, end) {
  const parts = [];
  for (const u of analysis.units.values()) {
    if (u.unmappable || u.srcStart < 0) continue;
    const proj = projection(u);
    const uStart = u.base;
    const uEnd = proj.end.length ? proj.end[proj.end.length - 1] : u.base;
    if (uEnd < start || uStart > end) continue;
    const from = proj.toPlain(Math.max(start, uStart));
    const to = proj.toPlain(Math.min(end, uEnd));
    const slice = proj.plain.slice(Math.min(from, to), Math.max(from, to));
    if (slice) parts.push(slice);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function isBlocked(analysis, sourceOffset) {
  return analysis.blocked.some(([s, e]) => sourceOffset >= s && sourceOffset <= e);
}

/**
 * Find a span again in a newer copy of the text. The span was measured in
 * `baseClean`; the file on disk may differ by line endings (the DOM normalises
 * CRLF) or by an agent's edits elsewhere. The exact source slice is searched for,
 * and among several hits the one whose surroundings match best, then the one
 * nearest the old position, wins. Null if the slice is gone.
 */
export function relocateSpan(baseClean, start, end, newClean) {
  if (newClean === baseClean) return { start, end };
  const slice = baseClean.slice(start, end);
  const variants = [slice];
  if (slice.includes("\n")) variants.push(slice.replace(/\r?\n/g, "\r\n"));
  const before = baseClean.slice(Math.max(0, start - 40), start).replace(/\r/g, "");
  const after = baseClean.slice(end, end + 40).replace(/\r/g, "");
  const expected = Math.round((start / Math.max(1, baseClean.length)) * newClean.length);

  let best = null;
  for (const v of variants) {
    for (let at = newClean.indexOf(v); at !== -1; at = newClean.indexOf(v, at + 1)) {
      const nb = newClean.slice(Math.max(0, at - 60), at).replace(/\r/g, "");
      const na = newClean.slice(at + v.length, at + v.length + 60).replace(/\r/g, "");
      let score = 0;
      while (score < before.length && nb[nb.length - 1 - score] === before[before.length - 1 - score]) score++;
      let k = 0;
      while (k < after.length && na[k] === after[k]) k++;
      score += k;
      const distance = Math.abs(at - expected);
      if (!best || score > best.score || (score === best.score && distance < best.distance)) {
        best = { start: at, end: at + v.length, score, distance };
      }
    }
  }
  return best ? { start: best.start, end: best.end } : null;
}

/**
 * The whole edit for a new annotation, applied to the file's current bytes: a
 * marker pair around the span and an entry, with its first message, in the
 * threads block. The id is chosen against those same bytes, so a thread an agent
 * added a moment ago is never collided with.
 *
 * @param {string} text the file as it is on disk now
 * @param {{baseClean:string, start:number, end:number, startBlock?:boolean,
 *          endBlock?:boolean, skip?:number, len?:number, quote:string,
 *          context:?string, author:string, stamp:string, body:string}} draft
 * @returns {{text:string, id:number}}
 */
export function addThread(text, draft) {
  const { clean, markers } = stripMarkers(text);
  const at = relocateSpan(draft.baseClean, draft.start, draft.end, clean);
  if (!at) {
    const err = new Error("The text you selected changed on disk. Select it again.");
    err.code = "relocate";
    throw err;
  }
  const id = nextThreadId(markers, parseThreads(text).threads.map((t) => t.id));
  const eol = detectEol(text);
  const marked = insertSpan(text, id, at.start, at.end, draft);
  const lines = draft.body ? [messageLine(draft.author, draft.stamp, draft.body).split("\n").join(eol)] : [];
  return { id, text: appendThread(marked, { id, status: "open", quote: draft.quote, context: draft.context }, lines, eol) };
}
