// Inline markdown projection: the source text of one block's inline content, and
// the text that content renders to, with a map between them.
//
// This is what makes an annotation land where you selected it. The reader gives us
// a position in *rendered* text; the file needs a position in *source* text. The
// two differ by exactly the markup characters markdown eats — `**`, backticks, the
// `](dest)` of a link — so we walk the source once, dropping markup as we go and
// recording where every surviving character came from.
//
// Pure: no DOM, no Chrome. Unit tested in Node.

const ESCAPABLE = "\\`*_{}[]()#+-.!<>~|'\"$%^&,/;:?=@ ";

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", ndash: "\u2013",
  mdash: "\u2014", hellip: "\u2026", copy: "\u00a9", reg: "\u00ae", trade: "\u2122",
  times: "\u00d7", laquo: "\u00ab", raquo: "\u00bb", lsquo: "\u2018", rsquo: "\u2019",
  ldquo: "\u201c", rdquo: "\u201d", bull: "\u2022", deg: "\u00b0", plusmn: "\u00b1",
  frac12: "\u00bd", frac14: "\u00bc", middot: "\u00b7", sect: "\u00a7", para: "\u00b6",
  euro: "\u20ac", pound: "\u00a3", yen: "\u00a5",
};

function decodeEntity(raw) {
  if (raw[1] === "#") {
    const body = raw.slice(2, -1);
    const cp = body[0] === "x" || body[0] === "X" ? parseInt(body.slice(1), 16) : parseInt(body, 10);
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : null;
  }
  const named = NAMED_ENTITIES[raw.slice(1, -1)];
  return named === undefined ? null : named;
}

/**
 * @typedef {object} Projection
 * @property {string} plain rendered text of this inline content
 * @property {number[]} map map[i] = source index of plain[i]
 * @property {number[]} end end[i] = source index just past plain[i]
 * @property {Array<[number, number]>} guarded source ranges a marker must not be
 *   dropped inside (code spans, link destinations, autolinks, images, escapes)
 * @property {(plainIndex: number) => number} toSource plain offset -> source offset
 * @property {(sourceOffset: number) => number} toPlain source offset -> plain offset
 * @property {(s:number, e:number) => ({start:number, end:number, expanded:boolean}|null)} adjust widen a range to safe marker positions
 */

/**
 * @param {string} src inline source of a single block
 * @param {number} base source index in the whole document where `src` starts
 * @param {{quoted?:boolean}} [opts] quoted: the block sits in a blockquote, so
 *   continuation lines start with `>` markup
 * @returns {Projection}
 */
export function projectInline(src, base = 0, opts = {}) {
  const plain = [];
  const map = [];
  const end = [];
  const guarded = [];
  let i = 0;

  const push = (ch, srcStart, srcEnd) => {
    plain.push(ch);
    map.push(srcStart);
    end.push(srcEnd);
  };

  /** Run of identical chars at i. */
  const runLen = (ch, from) => {
    let n = 0;
    while (src[from + n] === ch) n++;
    return n;
  };

  /** Find the index where a run of `n` identical chars closes, skipping escapes. */
  const closeRun = (ch, n, from) => {
    let j = from;
    while (j < src.length) {
      if (src[j] === "\\") {
        j += 2;
        continue;
      }
      if (src[j] === ch && runLen(ch, j) >= n) return j;
      j++;
    }
    return -1;
  };

  while (i < src.length) {
    const ch = src[i];

    // Line break: leading whitespace (and blockquote `>`s) on the next line are
    // markup; the break itself renders as one character.
    if (ch === "\n") {
      let j = i + 1;
      while (j < src.length && (src[j] === " " || src[j] === "\t" || (opts.quoted && src[j] === ">"))) j++;
      push(" ", base + i, base + j);
      i = j;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }

    // Backslash escape.
    if (ch === "\\" && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) {
      push(src[i + 1], base + i + 1, base + i + 2);
      guarded.push([base + i, base + i + 2]);
      i += 2;
      continue;
    }

    // Inline code: whatever is inside is verbatim, and unsplittable.
    if (ch === "`") {
      const n = runLen("`", i);
      const close = closeRun("`", n, i + n);
      if (close > -1) {
        let body = src.slice(i + n, close);
        let bodyShift = 0;
        if (body.length > 2 && body[0] === " " && body[body.length - 1] === " " && body.trim() !== "") {
          body = body.slice(1, -1);
          bodyShift = 1;
        }
        const bodyStart = base + i + n + bodyShift;
        for (let k = 0; k < body.length; k++) push(body[k], bodyStart + k, bodyStart + k + 1);
        guarded.push([base + i, base + close + n]);
        i = close + n;
        continue;
      }
    }

    // Autolink <https://…> — renders its target, cannot be split.
    if (ch === "<") {
      const gt = src.indexOf(">", i + 1);
      const inner = gt > -1 ? src.slice(i + 1, gt) : "";
      if (gt > -1 && /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*$/.test(inner)) {
        for (let k = 0; k < inner.length; k++) push(inner[k], base + i + 1 + k, base + i + 2 + k);
        guarded.push([base + i, base + gt + 1]);
        i = gt + 1;
        continue;
      }
      // Inline HTML and comments render as markup, not text: they contribute
      // nothing to the plain text and a marker must not land inside them.
      if (src.startsWith("<!--", i)) {
        const close = src.indexOf("-->", i + 4);
        if (close > -1) {
          guarded.push([base + i, base + close + 3]);
          i = close + 3;
          continue;
        }
      }
      const tag = /^<\/?[a-zA-Z][a-zA-Z0-9-]*((\s+[a-zA-Z_:][a-zA-Z0-9_:.-]*(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/.exec(
        src.slice(i)
      );
      if (tag) {
        guarded.push([base + i, base + i + tag[0].length]);
        i += tag[0].length;
        continue;
      }
    }

    // Image: an <img>, so it contributes no text.
    if (ch === "!" && src[i + 1] === "[") {
      const close = matchBracket(src, i + 1);
      if (close > -1) {
        let after = close + 1;
        if (src[after] === "(") {
          const dest = matchParen(src, after);
          if (dest > -1) after = dest + 1;
        }
        guarded.push([base + i, base + after]);
        i = after;
        continue;
      }
    }

    // Link: the text renders, the brackets and destination do not.
    if (ch === "[") {
      const close = matchBracket(src, i);
      if (close > -1) {
        let after = close + 1;
        let consumedDest = false;
        if (src[after] === "(" || src[after] === "[") {
          const closer = src[after] === "(" ? matchParen(src, after) : matchBracket(src, after);
          if (closer > -1) {
            guarded.push([base + close, base + closer + 1, "close"]);
            after = closer + 1;
            consumedDest = true;
          }
        }
        guarded.push([base + i, base + i + 1, "open"]);
        const inner = src.slice(i + 1, close);
        const nested = projectInline(inner, base + i + 1, opts);
        absorb(nested, plain, map, end, guarded);
        if (!consumedDest) guarded.push([base + close, base + close + 1, "close"]);
        i = after;
        continue;
      }
    }

    // Emphasis and strikethrough: delimiters vanish, and splitting a delimiter in
    // two is exactly the corruption we must not write.
    if (ch === "*" || ch === "_" || ch === "~") {
      const n = runLen(ch, i);
      const min = ch === "~" ? Math.min(n, 2) : n;
      const close = closeRun(ch, min, i + n);
      if (close > -1 && close > i + n - 1) {
        guarded.push([base + i, base + i + min, "open"]);
        guarded.push([base + close, base + close + min, "close"]);
        const inner = src.slice(i + min, close);
        const nested = projectInline(inner, base + i + min, opts);
        absorb(nested, plain, map, end, guarded);
        i = close + min;
        continue;
      }
    }

    // Character reference.
    if (ch === "&") {
      const semi = src.indexOf(";", i + 1);
      if (semi > -1 && semi - i <= 12) {
        const raw = src.slice(i, semi + 1);
        const decoded = decodeEntity(raw);
        if (decoded) {
          for (let k = 0; k < decoded.length; k++) push(decoded[k], base + i, base + semi + 1);
          guarded.push([base + i, base + semi + 1]);
          i = semi + 1;
          continue;
        }
      }
    }

    push(ch, base + i, base + i + 1);
    i++;
    continue;
  }

  // Trailing whitespace the renderer trims off the end of the block.
  while (plain.length && /\s/.test(plain[plain.length - 1]) && plain[plain.length - 1] !== "\u00a0") {
    plain.pop();
    map.pop();
    end.pop();
  }

  const plainText = plain.join("");

  const toSource = (plainIndex) => {
    if (plainIndex <= 0) return map.length ? map[0] : base;
    if (plainIndex >= plain.length) return end.length ? end[end.length - 1] : base + src.length;
    return map[plainIndex];
  };

  /**
   * Where to cut *after* the character before plainIndex. Different from toSource
   * whenever invisible markup sits between two visible characters: this keeps a
   * closing marker tight against the text instead of after a link destination.
   */
  const toSourceEnd = (plainIndex) => {
    if (plainIndex <= 0) return map.length ? map[0] : base;
    if (plainIndex > plain.length) plainIndex = plain.length;
    return end[plainIndex - 1];
  };

  const toPlain = (sourceOffset) => {
    for (let k = 0; k < plain.length; k++) {
      if (map[k] >= sourceOffset) return k;
      if (sourceOffset <= end[k]) return k + 1;
    }
    return plain.length;
  };

  const edge = (kind, side, offset) => guarded.find((g) => g[2] === kind && g[side] === offset);

  const insideGuarded = (offset) => {
    for (const [s, e] of guarded) if (offset > s && offset < e) return [s, e];
    return null;
  };

  return {
    plain: plainText,
    map,
    end,
    guarded,
    toSource,
    toSourceEnd,
    toPlain,
    /**
     * The source range for a selection, widened so neither end splits something
     * that can't take a marker inside it (a code span, a link destination, an
     * escape). Widening never refuses: selecting part of `npm install` anchors on
     * the whole code span. `expanded` says whether that happened, in plain text.
     */
    adjust(plainStart, plainEnd) {
      let s = toSource(plainStart);
      let e = toSourceEnd(plainEnd);
      for (let g = insideGuarded(s); g; g = insideGuarded(s)) s = g[0];
      for (let g = insideGuarded(e); g; g = insideGuarded(e)) e = g[1];
      // A marker touching an emphasis or link delimiter goes outside it: a comment
      // between `**` and the word it closes can stop other renderers seeing bold.
      for (let g = edge("open", 1, s); g; g = edge("open", 1, s)) s = g[0];
      for (let g = edge("close", 0, e); g; g = edge("close", 0, e)) e = g[1];
      if (e <= s) return null;
      const plainS = toPlain(s);
      const plainE = toPlain(e);
      return {
        start: s,
        end: e,
        plainStart: plainS,
        plainEnd: plainE,
        expanded: plainS !== plainStart || plainE !== plainEnd,
      };
    },
  };
}

function absorb(nested, plain, map, end, guarded) {
  for (let k = 0; k < nested.plain.length; k++) {
    plain.push(nested.plain[k]);
    map.push(nested.map[k]);
    end.push(nested.end[k]);
  }
  for (const g of nested.guarded) guarded.push(g);
}

/** Index of the `]` closing the `[` at `from`, honouring nesting and escapes. */
function matchBracket(src, from) {
  let depth = 0;
  for (let j = from; j < src.length; j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (src[j] === "[") depth++;
    else if (src[j] === "]") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Index of the `)` closing the `(` at `from`. */
function matchParen(src, from) {
  let depth = 0;
  for (let j = from; j < src.length; j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (src[j] === "(") depth++;
    else if (src[j] === ")") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Convenience: the rendered text a chunk of inline source produces. */
export function projectText(src) {
  return projectInline(src, 0).plain;
}
