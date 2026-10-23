// DOM plumbing: character positions inside a rendered unit, and highlights that
// wrap text fragments without disturbing the markup around them.

/** Every text node under `el`, in document order. */
export function textNodes(el) {
  const out = [];
  const walk = (n) => {
    for (const child of n.childNodes) {
      if (child.nodeType === 3) out.push(child);
      else if (child.nodeType === 1 && child.tagName !== "SCRIPT") walk(child);
    }
  };
  walk(el);
  return out;
}

/**
 * The DOM point that sits `offset` characters into `el`'s text.
 * @returns {{node: Node, offset: number}|null}
 */
export function pointAt(el, offset) {
  if (offset <= 0) return { node: el, offset: 0 };
  let remaining = offset;
  for (const node of textNodes(el)) {
    if (node.data.length >= remaining) return { node, offset: remaining };
    remaining -= node.data.length;
  }
  const nodes = textNodes(el);
  const last = nodes[nodes.length - 1];
  return last ? { node: last, offset: last.data.length } : null;
}

function isInside(node, el) {
  let n = node;
  while (n) {
    if (n === el) return true;
    n = n.parentNode;
  }
  return false;
}

/** A range running from one unit's character offset to another's. */
export function rangeAcross(startEl, startOffset, endEl, endOffset) {
  const a = pointAt(startEl, startOffset);
  const b = pointAt(endEl, endOffset);
  if (!a || !b) return null;
  const r = new Range();
  try {
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
  } catch (e) {
    return null;
  }
  return r.startContainer === r.endContainer && r.startOffset === r.endOffset ? null : r;
}

/**
 * Wrap the text a range covers in highlight elements. Text is split per node
 * rather than lifted out, so emphasis and links inside the span survive exactly as
 * rendered.
 */
export function highlightRange(range, { threadId, status = "open", lost = false }) {
  const marks = [];
  const targets = [];
  for (const node of textNodes(range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentNode)) {
    if (!range.intersectsNode(node)) continue;
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : node.data.length;
    if (to > from) targets.push({ node, from, to });
  }
  for (const { node, from, to } of targets) {
    const middle = node.data.slice(from, to);
    if (!middle) continue;
    const mark = document.createElement("mark");
    mark.className = `tm-mark tm-${status}${lost ? " tm-lost" : ""}`;
    mark.dataset.thread = String(threadId);
    if (to < node.data.length) node.splitText(to);
    const target = from > 0 ? node.splitText(from) : node;
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
    marks.push(mark);
  }
  return marks;
}

/** Remove every highlight, putting the text back as it was. */
export function clearHighlights(root) {
  root.querySelectorAll("mark.tm-mark").forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
}

/** The element the renderer tagged for a unit index. */
export function unitElement(root, index) {
  return root.querySelector(`[data-tm-i="${index}"]`);
}

/** Which unit element contains a node, if any. */
export function unitElementFor(node) {
  let n = node && (node.nodeType === 3 ? node.parentNode : node);
  while (n && n.nodeType === 1) {
    if (n.classList && n.classList.contains("tm-u")) return n;
    n = n.parentNode;
  }
  return null;
}

const contentsOf = (el) => {
  const r = document.createRange();
  r.selectNodeContents(el);
  return r;
};

/** A range between two DOM points given as [node, offset]. */
export function between(from, to) {
  const r = document.createRange();
  r.setStart(from[0], from[1]);
  r.setEnd(to[0], to[1]);
  return r;
}

export const startOf = (r) => [r.startContainer, r.startOffset];
export const endOf = (r) => [r.endContainer, r.endOffset];
export const textLength = (r) => r.toString().length;

/** Does range `a` share any content with range `b`? */
export function intersects(a, b) {
  return a.compareBoundaryPoints(Range.END_TO_START, b) < 0 && a.compareBoundaryPoints(Range.START_TO_END, b) > 0;
}

/**
 * Everything on the page an annotation can anchor to, in document order.
 *
 * - `u`: a unit — inline text that maps onto the source character by character
 *   (`.tm-u`, with its index into analysis.units).
 * - `b`: a block — code, raw HTML, an opaque table cell — with the source range
 *   `a`..`b` of its whole lines (`[data-tm-b]`; raw HTML is bracketed by
 *   `.tm-bs`/`.tm-be` sentinels because it can't be wrapped).
 *
 * @returns {Array<{kind:'u'|'b', i?:number, a?:number, b?:number, el?:Element, range:Range}>}
 */
export function anchors(root) {
  const out = [];
  const open = new Map();
  for (const n of root.querySelectorAll(".tm-u, [data-tm-b]")) {
    if (n.classList.contains("tm-u")) {
      out.push({ kind: "u", i: Number(n.dataset.tmI), el: n, range: contentsOf(n) });
      continue;
    }
    const [a, b] = n.dataset.tmB.split("-").map(Number);
    if (n.classList.contains("tm-bs")) {
      open.set(n.dataset.tmB, n);
    } else if (n.classList.contains("tm-be")) {
      const s = open.get(n.dataset.tmB);
      if (!s) continue;
      open.delete(n.dataset.tmB);
      const r = document.createRange();
      r.setStartAfter(s);
      r.setEndBefore(n);
      if (!r.collapsed) out.push({ kind: "b", a, b, range: r });
    } else {
      out.push({ kind: "b", a, b, el: n, range: contentsOf(n) });
    }
  }
  return out;
}

/** The DOM point `k` characters into a range's text, as [node, offset]. */
export function pointIn(range, k) {
  const host = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentNode;
  let left = k;
  for (const node of textNodes(host)) {
    if (!range.intersectsNode(node)) continue;
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : node.data.length;
    if (to - from >= left) return [node, from + left];
    left -= Math.max(0, to - from);
  }
  return endOf(range);
}

/** Character offset of a DOM point within a unit, or -1. */
export function offsetIn(unitEl, node, offset) {
  let total = 0;
  for (const text of textNodes(unitEl)) {
    if (text === node) return total + Math.min(offset, text.data.length);
    if (isInside(node, text)) return total + Math.min(offset, text.data.length);
    total += text.data.length;
  }
  return -1;
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
