// Document analysis: the bridge between the file's source text and the rendered
// reading view.
//
// markdown-it hands us a flat token stream in which every `inline` token's
// `content` is a slice of the source (give or take continuation-line indentation). Because tokens are in document
// order, a moving cursor finds each slice's exact position in the file. That gives
// every rendered unit a source coordinate, which is what `project.js` maps
// selections and highlights through — no fuzzy text matching anywhere.

import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js/lib/common";
import { projectInline } from "./project.js";
import { THREADS_START } from "./markers.js";

const TASK_BEFORE = /(?:^|\n)[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\][ \t]*$/;

/** Is the unit starting at `at` a task list item, and is it ticked? */
function checkboxBefore(clean, at) {
  const m = TASK_BEFORE.exec(clean.slice(Math.max(0, at - 200), at));
  if (!m) return null;
  return m[1] === " " ? "unchecked" : "checked";
}

export function makeMd() {
  const md = new MarkdownIt({
    // Agent documents use <details>, <br>, <kbd> and comments; rendering them as
    // literal tags is worse than useless. The output goes through DOMPurify.
    html: true,
    linkify: true,
    breaks: false,
    highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } catch (e) {
          /* fall back to unhighlighted */
        }
      }
      return "";
    },
  });
  // Checkboxes, not editable inputs.
  md.use(taskLists, { enabled: false, label: false });
  // Raw HTML can't be wrapped (it may open a <details> that a later block
  // closes), so its extent is marked with empty sentinels on either side.
  const htmlBlock = md.renderer.rules.html_block;
  md.renderer.rules.html_block = (tokens, idx, ...rest) => {
    const block = tokens[idx].meta && tokens[idx].meta.tmBlock;
    const html = htmlBlock(tokens, idx, ...rest);
    if (!block) return html;
    const tag = `data-tm-b="${block.a}-${block.b}"`;
    return `<span class="tm-bs" ${tag}></span>${html}<span class="tm-be" ${tag}></span>`;
  };

  return md;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/**
 * @param {string} clean source text with our markers removed
 * @param {MarkdownIt} [md]
 * @returns {{html: string, units: Map<number, object>, blocks: Array<{a:number, b:number, kind:string}>,
 *            blocked: Array<[number,number]>, headings: Array<{level:number,text:string,srcStart:number}>,
 *            bodyEnd: number}}
 *
 * Units are inline runs of text that map character-for-character onto the source
 * (`<span class="tm-u">` in the HTML); an annotation's markers go inline there.
 * Blocks are everything that doesn't — fenced code, raw HTML, the odd table cell
 * whose text isn't a verbatim slice — marked `data-tm-b="a-b"` with the source
 * range of their whole lines; an annotation's markers go on lines around them.
 */
export function analyze(clean, md = makeMd()) {
  // The threads block is rendered by the rail, not the reading pane. Everything
  // before it is a prefix of `clean`, so offsets stay in clean coordinates.
  const cut = clean.indexOf(THREADS_START);
  const bodyEnd = cut === -1 ? clean.length : cut;
  clean = clean.slice(0, bodyEnd);
  const tokens = md.parse(clean, {});
  const starts = lineStarts(clean);
  const lineAt = (n) => (n < starts.length ? starts[n] : clean.length);
  const units = new Map();
  const blocks = [];
  const blocked = [];
  const headings = [];
  const stack = [];
  let cursor = 0;
  let nextIndex = 0;
  let pendingHeading = null;
  const slugs = new Map();

  const addBlock = (map, kind) => {
    const block = { a: lineAt(map[0]), b: lineAt(map[1]), kind };
    blocks.push(block);
    return block;
  };

  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t];

    if (token.type === "fence" || token.type === "code_block" || token.type === "html_block") {
      if (token.map) {
        const block = addBlock(token.map, token.type === "html_block" ? "html" : "code");
        blocked.push([block.a, Math.max(block.a, block.b - 1)]);
        if (token.type === "html_block") token.meta = { ...(token.meta || {}), tmBlock: block };
        else {
          token.attrJoin("class", "tm-b");
          token.attrSet("data-tm-b", `${block.a}-${block.b}`);
        }
        cursor = Math.max(cursor, block.b);
      }
      continue;
    }
    if (token.type.endsWith("_open")) stack.push(token);
    else if (token.type.endsWith("_close")) stack.pop();

    if (token.type === "heading_open") {
      pendingHeading = {
        level: Number(token.tag.slice(1)) || 1,
        srcStart: token.map ? starts[token.map[0]] : cursor,
        token,
      };
      continue;
    }

    if (token.type !== "inline") continue;

    const kinds = stack.map((o) => o.type.slice(0, -5));
    const kind = kinds[kinds.length - 1] || "paragraph";
    const quoted = kinds.includes("blockquote");
    const i = nextIndex++;
    const line = token.map ? token.map[0] : -1;
    const content = token.content;

    if (content === "") continue;

    let found = clean.indexOf(content, cursor);
    let srcText = content;
    if (found === -1 && content.includes("\n")) {
      // markdown-it strips the indentation (and `>`s) of continuation lines — a
      // bullet that wraps onto an indented second line. Match them back in.
      const re = new RegExp(content.split("\n").map(escapeRe).join("\\n[ \\t>]*"), "g");
      re.lastIndex = cursor;
      const m = re.exec(clean);
      if (m) {
        found = m.index;
        srcText = m[0];
      }
    }
    if (found === -1) {
      // Not a verbatim slice — escaped pipes in a table cell, for instance. The
      // enclosing table or paragraph becomes a block anchor instead.
      const owner = [...stack].reverse().find((o) => o.type === "table_open" && o.map) || [...stack].reverse().find((o) => o.map);
      if (owner) {
        const block = addBlock(owner.map, "opaque");
        wrapChildren(token, `<span class="tm-b" data-tm-b="${block.a}-${block.b}">`);
      }
      continue;
    }
    cursor = found;

    let src = srcText;
    let base = found;
    // The renderer collapses leading whitespace, so the annotatable range starts
    // at the first visible character.
    const lead = srcText.length - srcText.trimStart().length;
    if (lead) {
      base = found + lead;
      src = srcText.slice(lead);
    }
    // markdown-it has already eaten a task checkbox, so its state has to be read
    // from the source just before this unit's text.
    const checkbox = checkboxBefore(clean, found);

    units.set(i, { i, srcStart: found, srcLen: srcText.length, base, src, content, kind, quoted, line, checkbox, proj: null });
    wrapUnit(token, i, line);

    if (pendingHeading) {
      const text = plain(content);
      pendingHeading.token.attrSet("id", slugify(text, slugs));
      headings.push({ level: pendingHeading.level, text, srcStart: pendingHeading.srcStart });
      pendingHeading = null;
    }
  }

  return { html: md.renderer.render(tokens, md.options, {}), units, blocks, blocked, headings, bodyEnd };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** GitHub-style heading id, so `[see](#latency-results)` links work. */
function slugify(text, seen) {
  const base =
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  const n = seen.get(base) || 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

/**
 * Wrap a unit's rendered inline content in `<span class="tm-u">`, which is how the
 * view finds a unit's text again. Done with tokens because markdown-it renders
 * inline children directly and never consults a renderer rule for `inline`.
 */
function wrapUnit(token, i, line) {
  wrapChildren(token, `<span class="tm-u" data-tm-i="${i}" data-tm-line="${line}">`);
}

function wrapChildren(token, openTag) {
  const Token = token.constructor;
  const open = new Token("html_inline", "", 0);
  open.content = openTag;
  const close = new Token("html_inline", "", 0);
  close.content = "</span>";
  const children = token.children || [];
  // A task item's checkbox goes outside the unit, and the space the task-list
  // plugin leaves after it is dropped (CSS spaces it), so the unit's text matches
  // its projection character for character.
  let lead = 0;
  if (children[0] && children[0].type === "html_inline" && children[0].content.includes("task-list-item-checkbox")) {
    lead = 1;
    const next = children[1];
    if (next && next.type === "text") next.content = next.content.replace(/^\s+/, "");
  }
  token.children = [...children.slice(0, lead), open, ...children.slice(lead), close];
}

function plain(inlineSrc) {
  return inlineSrc.replace(/<!--[\s\S]*?-->/g, "").replace(/[*_`~]/g, "").trim();
}

/** The projection for a unit, built once on demand. */
export function projection(unit) {
  if (!unit.proj) unit.proj = projectInline(unit.src, unit.base, { quoted: unit.quoted });
  return unit.proj;
}

/** Which unit covers a source offset, if any. */
export function unitAt(units, offset) {
  for (const u of units.values()) {
    if (u.unmappable || u.srcStart < 0) continue;
    const proj = projection(u);
    const endSrc = proj.end.length ? proj.end[proj.end.length - 1] : u.base;
    if (offset >= u.base && offset <= endSrc) return u;
  }
  return null;
}

/** Nearest heading above a source offset — the "in: …" line on a card. */
export function headingAt(headings, offset) {
  let best = null;
  for (const h of headings) if (h.srcStart <= offset && (!best || h.srcStart > best.srcStart)) best = h;
  return best;
}
