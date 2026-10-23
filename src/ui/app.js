// The reading view and the threads rail. Everything the reader touches lives
// here; the file and the parsers are reached through `file` and the core modules.
//
// The flow: select text → Comment → type the first message → send. Sending is
// what writes: the marker pair, the thread entry and the message land in the file
// in one edit, applied to the bytes on disk at that moment. The first send in a
// tab connects the file (one picker or permission click); after that, changes an
// agent makes on disk show up by themselves.

import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { analyze, headingAt, projection } from "../core/doc.js";
import { stripMarkers } from "../core/markers.js";
import {
  parseThreads,
  appendMessage,
  appendThread,
  setStatus,
  findMessage,
  replaceMessage,
  removeMessage,
  removeThread,
  removeResolved,
} from "../core/threads.js";
import { resolveMarkers, unitNear, addThread, relocateSpan } from "../core/annotate.js";
import { highlightRange, clearHighlights, unitElement, pointAt, anchors, between, startOf, endOf, textLength, intersects, pointIn, esc } from "./dom.js";
import { kvGet, kvPut, kvDelete } from "./kv.js";

const PURIFY = {
  ADD_ATTR: ["data-tm-i", "data-tm-line"],
  FORBID_TAGS: ["style", "form", "button", "textarea", "select", "iframe", "object", "embed"],
};
const messageMd = new MarkdownIt({ html: false, linkify: true, breaks: true });
const POLL_MS = 2000;

const pad = (n) => String(n).padStart(2, "0");
const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const hhmm = () => stamp().slice(11);

function relative(when) {
  if (!when) return "";
  const t = Date.parse(when.replace(" ", "T"));
  if (Number.isNaN(t)) return when;
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : when.slice(0, 10);
}

const WARNINGS = {
  "agent-raised": ["agent-raised", "Raised in the threads block with no text marked in the document."],
  "span removed": ["text removed", "The flagged words were deleted from the document. The thread is kept."],
  "incomplete pair": ["broken marker", "Only one half of this thread's marker pair is in the file."],
  "markers the wrong way round": ["broken marker", "This thread's end marker comes before its start marker."],
  "anchor lost": ["unanchored", "The marked text can't be shown in the reading view."],
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function initials(name) {
  return (name || "?").trim().slice(0, 1).toUpperCase();
}

/** A stable hue per author, so dan and claude are told apart at a glance. */
function hue(name) {
  let h = 0;
  for (const ch of name || "") h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/**
 * @param {{path:string, fileName:string, settings:object, file:ReturnType<import('./fs.js').fileLink>}} env
 */
export function createApp({ path, fileName, settings, file }) {
  const author = settings.name || "dan";
  const state = {
    source: "",
    clean: "",
    analysis: null,
    block: { present: false, closed: true, threads: [] },
    spans: [],
    disk: null,
    save: { kind: "idle" },
    pending: null, // a new annotation waiting for its first message
    drafts: {}, // composer key -> unsent text
    filter: "open",
    expanded: new Set(), // resolved threads opened by hand
    hot: null,
    quotes: new Map(), // thread id -> the text its highlight covers, as rendered
    editing: null, // "id.index" of the message being edited
    arming: null, // "id.index" (or "id") of a delete waiting for its second click
    showSource: false,
    width: null,
  };

  let root, scroller, page, rail, cards, statusEl, popover, toastEl;

  // ---------- model ----------

  function ingest(text) {
    state.source = text;
    const { clean, markers } = stripMarkers(text);
    state.clean = clean;
    state.analysis = analyze(clean);
    state.analysis.markers = markers;
    state.block = parseThreads(text);
    state.spans = resolveMarkers(state.analysis, markers);
  }

  function views() {
    const entries = new Map(state.block.threads.map((t) => [t.id, t]));
    const spans = new Map(state.spans.map((s) => [s.id, s]));
    const ids = new Set([...entries.keys(), ...spans.keys()]);
    const out = [...ids].map((id) => {
      const entry = entries.get(id);
      const span = spans.get(id);
      let warning = null;
      if (!span) warning = "agent-raised";
      else if (!span.ok) warning = span.reason;
      else if (span.empty) warning = "span removed";
      const anchored = Boolean(span && span.ok && !span.empty);
      return {
        id,
        status: entry ? entry.status : "open",
        messages: entry ? entry.messages : [],
        quote: (anchored && (state.quotes.get(id) || span.quote)) || (entry && entry.quote) || "",
        context: (entry && entry.context) || (anchored ? headingAt(state.analysis.headings, span.srcStart)?.text : null) || null,
        anchored,
        warning,
        order: anchored ? span.srcStart : Infinity,
      };
    });
    out.sort((a, b) => (a.status === b.status ? a.order - b.order || a.id - b.id : a.status === "open" ? -1 : 1));
    return out;
  }

  // ---------- drawing ----------

  function draw() {
    drawDocument();
    drawRail();
    drawStatus();
  }

  function drawDocument() {
    if (state.showSource) {
      const pre = el("pre", "tm-raw");
      pre.textContent = state.source;
      page.replaceChildren(pre);
      return;
    }
    page.innerHTML = DOMPurify.sanitize(state.analysis.html, PURIFY);
    drawHighlights();
  }

  function drawHighlights() {
    if (state.showSource) return;
    clearHighlights(page);
    state.quotes.clear();
    const status = new Map(state.block.threads.map((t) => [t.id, t.status]));
    for (const span of state.spans) {
      if (span.ok && !span.empty) paint(span, span.id, status.get(span.id) || "open");
    }
    if (state.pending) paint(state.pending, "new", "pending");
    applyHot();
  }

  /**
   * The DOM point for a marker position. Block markers sit on lines around a
   * block, so they map to the edge of that block's anchor; inline markers map
   * through the unit's projection.
   */
  function domPoint(list, offset, side, isBlock) {
    if (isBlock) {
      const key = side === "start" ? "a" : "b";
      const hits = list.filter((an) => an.kind === "b" && an[key] === offset);
      const an = side === "start" ? hits[0] : hits[hits.length - 1];
      if (an) return side === "start" ? startOf(an.range) : endOf(an.range);
    }
    const near = unitNear(state.analysis.units, offset);
    const el = near && unitElement(page, near.unit.i);
    if (!el) return null;
    const p = pointAt(el, near.plain);
    return p ? [p.node, p.offset] : null;
  }

  /** The rendered range a span covers: the marker pair, narrowed by skip/len. */
  function spanRange(span, list = anchors(page)) {
    const from = domPoint(list, span.srcStart ?? span.start, "start", span.startBlock);
    const to = domPoint(list, span.srcEnd ?? span.end, "end", span.endBlock);
    if (!from || !to) return null;
    let range;
    try {
      range = between(from, to);
    } catch (e) {
      return null;
    }
    if (Number.isFinite(span.skip)) {
      const a = pointIn(range, span.skip);
      const b = pointIn(range, span.skip + (span.len || 0));
      range = between(a, b);
    }
    return range.collapsed ? null : range;
  }

  function paint(span, id, status) {
    const range = spanRange(span);
    if (!range) return;
    const marks = highlightRange(range, { threadId: id, status });
    if (id !== "new") state.quotes.set(id, marks.map((m) => m.textContent).join("").replace(/\s+/g, " ").trim());
  }

  function drawStatus() {
    statusEl.replaceChildren();
    statusEl.className = "tm-status";
    const link = file.state;
    let label;
    let tone = "";
    let action = null;
    if (state.save.kind === "saving") {
      label = "Saving…";
    } else if (state.save.kind === "error") {
      label = state.save.message;
      tone = "is-bad";
    } else if (link === "none") {
      label = "Not connected";
      tone = "is-warn";
      action = "Connect";
    } else if (link === "prompt") {
      label = "Not connected";
      tone = "is-warn";
      action = "Allow editing";
    } else if (state.save.kind === "saved") {
      label = `Saved ${state.save.at}`;
      tone = "is-good";
    } else {
      label = "Connected";
      tone = "is-good";
    }
    statusEl.classList.add(tone || "is-plain");
    const dot = el("span", "tm-status-dot");
    statusEl.append(dot, el("span", "tm-status-label", label));
    statusEl.title =
      link === "granted"
        ? `Comments are written into ${path}${file.via ? ` (connected through ${file.via})` : ""}`
        : "Comments are written into the file itself. Chrome needs your OK once for a folder or this file.";
    if (action) {
      const btn = el("button", "tm-link", action);
      btn.type = "button";
      btn.addEventListener("click", () => connect());
      statusEl.appendChild(btn);
    }
  }

  function drawRail() {
    const all = views();
    const open = all.filter((v) => v.status === "open");
    const shown = state.filter === "open" ? open : all;
    for (const btn of rail.querySelectorAll("[data-filter]")) {
      const on = btn.dataset.filter === state.filter;
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-pressed", String(on));
      btn.querySelector(".tm-n").textContent = String(btn.dataset.filter === "open" ? open.length : all.length);
    }

    const focus = captureFocus();
    const nodes = [];
    if (state.pending) nodes.push(pendingCard());
    for (const v of shown) nodes.push(card(v));
    if (!nodes.length) nodes.push(emptyState(all.length));
    const resolved = all.length - open.length;
    if (resolved) nodes.push(resolvedFooter(resolved));
    cards.replaceChildren(...nodes);
    restoreFocus(focus);
    applyHot();
  }

  function emptyState(total) {
    const box = el("div", "tm-empty");
    if (total) {
      box.append(el("p", "tm-empty-title", "All threads resolved"));
    } else {
      box.append(
        el("p", "tm-empty-title", "No comments yet"),
        el("p", null, "Select any text in the document and press C, or click Comment."),
      );
    }
    return box;
  }

  /** "3 resolved · Show · Clean up": the way resolved threads leave the file. */
  function resolvedFooter(count) {
    const bar = el("div", "tm-footer");
    bar.appendChild(el("span", null, `${count} resolved`));
    const show = el("button", "tm-link", state.filter === "open" ? "Show" : "Hide");
    show.type = "button";
    show.addEventListener("click", () => {
      state.filter = state.filter === "open" ? "all" : "open";
      persistUi();
      drawRail();
    });
    const clean = deleteButton("cleanup", "Clean up", cleanUpResolved, `Remove ${count} for good?`);
    clean.title = "Remove every resolved thread from the file: its highlight, its markers and its messages";
    bar.append(show, clean);
    return bar;
  }

  function pendingCard() {
    const p = state.pending;
    const c = el("article", "tm-card is-pending");
    c.dataset.thread = "new";
    const head = el("header", "tm-card-head");
    head.append(el("span", "tm-id", "New comment"));
    c.append(head, quoteBlock(p.quote, null), composer("new", "Add a comment…", sendNew, { autofocus: true, label: "Comment", onCancel: cancelPending }));
    if (file.state !== "granted") {
      c.appendChild(el("p", "tm-fine", "Sending saves into the file. Chrome asks for access to it the first time."));
    }
    return c;
  }

  function card(v) {
    const collapsed = v.status === "resolved" && !state.expanded.has(v.id);
    const c = el("article", `tm-card is-${v.status}${collapsed ? " is-collapsed" : ""}`);
    c.dataset.thread = String(v.id);

    const head = el("header", "tm-card-head");
    head.appendChild(el("span", "tm-id", `T${v.id}`));
    if (v.status === "resolved") head.appendChild(el("span", "tm-tag is-done", "resolved"));
    if (v.warning) {
      const [label, why] = WARNINGS[v.warning] || [v.warning, v.warning];
      const tag = el("span", "tm-tag is-warn", label);
      tag.title = why;
      head.appendChild(tag);
    }
    const last = v.messages[v.messages.length - 1];
    head.appendChild(el("span", "tm-when", last ? relative(last.stamp) : ""));
    if (!collapsed) {
      const toggle = el("button", "tm-link", v.status === "open" ? "Resolve" : "Reopen");
      toggle.type = "button";
      toggle.dataset.status = v.status === "open" ? "resolved" : "open";
      toggle.addEventListener("click", () => changeStatus(v.id, toggle.dataset.status));
      head.appendChild(toggle);
      // A thread that is all yours (or has no messages at all) can go entirely.
      if (v.messages.every((m) => m.author === author)) {
        head.appendChild(deleteButton(String(v.id), "Delete", () => deleteThread(v.id)));
      }
    }
    c.appendChild(head);
    if (v.quote || v.anchored) c.appendChild(quoteBlock(v.quote, v.anchored ? v.id : null));

    if (collapsed) {
      c.title = "Show this resolved thread";
      c.addEventListener("click", () => {
        state.expanded.add(v.id);
        persistUi();
        drawRail();
      });
      return c;
    }

    if (v.messages.length) {
      const list = el("ol", "tm-msgs");
      v.messages.forEach((m, k) => list.appendChild(message(m, v.id, k)));
      c.appendChild(list);
    }

    if (v.status === "open") c.appendChild(composer(`t${v.id}`, "Reply…", (text) => reply(v.id, text), { label: "Reply" }));

    if (v.status === "resolved") {
      const fold = el("button", "tm-link tm-fold", "Collapse");
      fold.type = "button";
      fold.addEventListener("click", () => {
        state.expanded.delete(v.id);
        persistUi();
        drawRail();
      });
      c.appendChild(fold);
    }
    return c;
  }

  function quoteBlock(text, revealId) {
    const q = el("blockquote", "tm-quote", text || "(no text)");
    if (revealId !== null) {
      q.classList.add("is-link");
      q.title = "Show in the document";
      q.addEventListener("click", (e) => {
        e.stopPropagation();
        reveal(revealId);
      });
    }
    return q;
  }

  function message(m, threadId, index) {
    const li = el("li", "tm-msg");
    const key = `${threadId}.${index}`;
    const mine = m.author === author;
    const who = m.author || "unknown";
    const avatar = el("span", "tm-avatar", initials(who));
    avatar.style.setProperty("--h", String(hue(who)));
    const head = el("div", "tm-msg-head");
    head.append(avatar, el("span", "tm-author", who));
    if (m.stamp) {
      const time = el("time", "tm-time", relative(m.stamp));
      time.title = m.stamp;
      head.appendChild(time);
    }
    if (mine && state.editing !== key) {
      const tools = el("span", "tm-msg-tools");
      const edit = el("button", "tm-link", "Edit");
      edit.type = "button";
      edit.addEventListener("click", () => {
        state.editing = key;
        state.drafts[`e${key}`] = m.body;
        drawRail();
      });
      tools.append(edit, deleteButton(key, "Delete", () => deleteMessage(threadId, index, m)));
      head.appendChild(tools);
    }
    li.appendChild(head);
    if (state.editing === key) {
      const stopEditing = () => {
        state.editing = null;
        delete state.drafts[`e${key}`];
        drawRail();
      };
      const form = composer(`e${key}`, "Edit your comment…", (text) => editMessage(threadId, index, m, text), {
        autofocus: true,
        label: "Save",
        onCancel: stopEditing,
      });
      form.classList.add("is-editing");
      li.appendChild(form);
      return li;
    }
    const body = el("div", "tm-msg-body");
    body.innerHTML = DOMPurify.sanitize(messageMd.render(m.body || ""));
    for (const a of body.querySelectorAll("a")) a.target = "_blank";
    li.appendChild(body);
    return li;
  }

  /** A delete that needs a second click within a few seconds. */
  function deleteButton(key, label, run, armedLabel = "Really delete?") {
    const armed = state.arming === key;
    const btn = el("button", `tm-link tm-danger${armed ? " is-armed" : ""}`, armed ? armedLabel : label);
    btn.type = "button";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.arming === key) {
        state.arming = null;
        run();
        return;
      }
      state.arming = key;
      drawRail();
      setTimeout(() => {
        if (state.arming !== key) return;
        state.arming = null;
        drawRail();
      }, 4000);
    });
    return btn;
  }

  function composer(key, placeholder, onSend, opts = {}) {
    const form = el("form", "tm-composer");
    const ta = el("textarea");
    ta.rows = 1;
    ta.placeholder = placeholder;
    ta.value = state.drafts[key] || "";
    ta.dataset.draft = key;
    const bar = el("div", "tm-composer-bar");
    bar.appendChild(el("span", "tm-hint", "⌘↵"));
    if (opts.onCancel) {
      const cancel = el("button", "tm-btn", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", opts.onCancel);
      bar.appendChild(cancel);
    }
    const send = el("button", "tm-btn is-primary", opts.label || "Send");
    send.type = "submit";
    bar.appendChild(send);
    form.append(ta, bar);

    const grow = () => {
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
      form.classList.toggle("has-text", Boolean(ta.value.trim()));
    };
    ta.addEventListener("input", () => {
      state.drafts[key] = ta.value;
      saveDraft(key);
      grow();
    });
    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        form.requestSubmit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (opts.onCancel) opts.onCancel();
        else ta.blur();
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text || send.disabled) return;
      send.disabled = true;
      delete state.drafts[key];
      const ok = await onSend(text);
      send.disabled = false;
      if (ok) {
        kvDelete(draftKey(key));
      } else {
        state.drafts[key] = text;
        if (ta.isConnected) ta.value = text;
        else drawRail();
      }
    });
    requestAnimationFrame(grow);
    if (opts.autofocus) requestAnimationFrame(() => ta.focus());
    return form;
  }

  function captureFocus() {
    const a = document.activeElement;
    if (!a || a.tagName !== "TEXTAREA" || !cards.contains(a)) return null;
    return { key: a.dataset.draft, start: a.selectionStart, end: a.selectionEnd };
  }

  function restoreFocus(f) {
    if (!f) return;
    const ta = cards.querySelector(`textarea[data-draft="${f.key}"]`);
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(f.start, f.end);
  }

  // ---------- linking the document and the rail ----------

  function setHot(id) {
    if (state.hot === id) return;
    state.hot = id;
    applyHot();
  }

  function applyHot() {
    const id = state.hot === null ? null : String(state.hot);
    for (const m of page.querySelectorAll("mark.tm-mark")) m.classList.toggle("is-hot", m.dataset.thread === id);
    for (const c of cards.querySelectorAll(".tm-card")) c.classList.toggle("is-hot", c.dataset.thread === id);
  }

  function reveal(id) {
    const mark = page.querySelector(`mark[data-thread="${id}"]`);
    if (!mark) return;
    mark.scrollIntoView({ block: "center", behavior: "smooth" });
    const marks = page.querySelectorAll(`mark[data-thread="${id}"]`);
    marks.forEach((m) => m.classList.add("tm-flash"));
    setTimeout(() => marks.forEach((m) => m.classList.remove("tm-flash")), 1200);
  }

  function showCard(id) {
    const v = views().find((x) => String(x.id) === String(id));
    if (v && v.status === "resolved") {
      state.filter = "all";
      state.expanded.add(v.id);
      persistUi();
      drawRail();
    }
    const c = cards.querySelector(`.tm-card[data-thread="${id}"]`);
    if (!c) return;
    c.scrollIntoView({ block: "nearest", behavior: "smooth" });
    c.classList.add("tm-flash");
    setTimeout(() => c.classList.remove("tm-flash"), 1200);
  }

  // ---------- writing ----------

  /**
   * Apply an edit to the file's current bytes and write the result. `edit` gets
   * the text on disk and returns the new text, or `{text, ...}`. Never writes
   * anything assembled from the DOM.
   */
  async function commit(edit, attempt = 0) {
    if (!(await connect())) return null;
    state.save = { kind: "saving" };
    drawStatus();
    try {
      const fresh = await file.read();
      const result = edit(fresh.text);
      const next = typeof result === "string" ? result : result.text;
      // Something wrote the file while we were working: start again on its bytes.
      const now = await file.stat();
      if ((now.lastModified !== fresh.lastModified || now.size !== fresh.size) && attempt < 3) {
        return commit(edit, attempt + 1);
      }
      const info = await file.write(next);
      state.disk = { lastModified: info.lastModified, size: info.size };
      ingest(next);
      state.save = { kind: "saved", at: hhmm() };
      return typeof result === "string" ? { text: next } : result;
    } catch (e) {
      if (e && e.code === "relocate") {
        state.save = { kind: "idle" };
        toast(e.message);
      } else {
        const gone = e && e.name === "NotFoundError";
        state.save = { kind: "error", message: gone ? "File is gone" : "Couldn't save" };
        toast(gone ? "The file was moved or deleted." : `Couldn't save: ${e && e.message ? e.message : e}`);
      }
      return null;
    } finally {
      drawStatus();
    }
  }

  /** Make sure we can write the file. Call only from a click or key press. */
  async function connect() {
    if (file.state === "granted") return true;
    if (file.state === "prompt") {
      try {
        await file.ensure();
      } catch (e) {
        if (!e || e.name !== "AbortError") toast(e && e.message ? e.message : String(e));
        drawStatus();
        return false;
      }
      return linked();
    }
    return new Promise((resolve) => openChooser(resolve));
  }

  async function linked() {
    await refresh();
    watch();
    drawStatus();
    return true;
  }

  /**
   * Nothing is known about this file yet: offer a folder (every file under it
   * connects by itself from then on) or just this file. Resolves when the reader
   * has chosen, so a send that needed the connection carries on.
   */
  let chooser = null;
  function openChooser(done) {
    if (chooser) chooser.finish(false);
    const box = el("div", "tm-chooser");
    const folder = el("button", "tm-btn is-primary", "Choose folder…");
    const single = el("button", "tm-btn", "Just this file");
    const later = el("button", "tm-link", "Not now");
    for (const b of [folder, single, later]) b.type = "button";
    const row = el("div", "tm-chooser-row");
    row.append(folder, single, later);
    box.append(
      el("p", "tm-chooser-title", "Save comments into your files"),
      el("p", null, "Chrome needs your OK once. Choose the folder you keep docs in (like ~/dev) and every .md under it opens ready to save from then on."),
      row,
    );
    const finish = async (ok, where) => {
      box.remove();
      chooser = null;
      if (ok) {
        await linked();
        if (where) toast(`Connected ${where.replace(/^\/Users\/[^/]+/, "~")}`);
      }
      done(ok);
    };
    const run = async (pick) => {
      try {
        await finish(true, await pick());
      } catch (e) {
        if (e && e.name !== "AbortError") toast(e.message || String(e));
        drawStatus();
      }
    };
    folder.addEventListener("click", () => run(() => file.connectFolder()));
    single.addEventListener("click", () => run(() => file.connectFile()));
    later.addEventListener("click", () => finish(false));
    chooser = { finish };
    rail.querySelector(".tm-rail-head").after(box);
    folder.focus();
  }

  async function sendNew(body) {
    const p = state.pending;
    if (!p) return false;
    const result = await commit((text) =>
      addThread(text, {
        baseClean: p.baseClean,
        start: p.start,
        end: p.end,
        startBlock: p.startBlock,
        endBlock: p.endBlock,
        skip: p.skip,
        len: p.len,
        quote: p.quote,
        context: p.context,
        author,
        stamp: stamp(),
        body,
      }),
    );
    if (!result) return false;
    state.pending = null;
    draw();
    showCard(result.id);
    return true;
  }

  async function reply(id, body) {
    const result = await commit((text) => {
      const entry = parseThreads(text).threads.find((t) => t.id === id);
      const quote = views().find((v) => v.id === id)?.quote || "";
      return appendMessage(text, entry, { id, quote, author, stamp: stamp(), body });
    });
    if (!result) return false;
    draw();
    return true;
  }

  const changedOnDisk = () => {
    const e = new Error("That comment changed on disk, so nothing was changed. Have a look and try again.");
    e.code = "relocate";
    return e;
  };

  async function editMessage(id, index, m, body) {
    const result = await commit((text) => {
      const found = findMessage(text, id, index, m);
      if (!found) throw changedOnDisk();
      return replaceMessage(text, found.message, body);
    });
    if (!result) return false;
    state.editing = null;
    draw();
    return true;
  }

  async function deleteMessage(id, index, m) {
    const result = await commit((text) => {
      const found = findMessage(text, id, index, m);
      if (!found) throw changedOnDisk();
      // The only message in its thread: the annotation goes with it.
      return found.thread.messages.length === 1 ? removeThread(text, id) : removeMessage(text, found.message);
    });
    if (result) draw();
  }

  async function cleanUpResolved() {
    const result = await commit((text) => removeResolved(text));
    if (!result) return;
    for (const id of result.removed) state.expanded.delete(id);
    draw();
    const n = result.removed.length;
    toast(n ? `Removed ${n} resolved thread${n === 1 ? "" : "s"}` : "Nothing resolved to remove");
  }

  async function deleteThread(id) {
    const result = await commit((text) => removeThread(text, id));
    if (result) draw();
  }

  async function changeStatus(id, status) {
    const result = await commit((text) => {
      const entry = parseThreads(text).threads.find((t) => t.id === id);
      if (entry) return setStatus(text, entry, status);
      const quote = views().find((v) => v.id === id)?.quote || "";
      return appendThread(text, { id, status, quote }, []);
    });
    if (!result) return;
    if (status === "resolved") state.expanded.delete(id);
    draw();
  }

  /** Re-read the file and redraw if it changed. Keeps scroll and drafts. */
  async function refresh() {
    const fresh = await file.read();
    state.disk = { lastModified: fresh.lastModified, size: fresh.size };
    if (fresh.text === state.source) return false;
    const top = scroller.scrollTop;
    ingest(fresh.text);
    const p = state.pending;
    if (p) {
      const at = relocateSpan(p.baseClean, p.start, p.end, state.clean);
      if (at) Object.assign(p, at, { baseClean: state.clean });
      else {
        state.pending = null;
        toast("The text you were commenting on changed on disk. Your comment is kept as a draft.");
      }
    }
    draw();
    scroller.scrollTop = top;
    return true;
  }

  let watching = false;
  function watch() {
    if (watching) return;
    watching = true;
    const tick = async () => {
      if (document.hidden || file.state !== "granted" || state.save.kind === "saving") return;
      try {
        const s = await file.stat();
        if (state.disk && s.lastModified === state.disk.lastModified && s.size === state.disk.size) return;
        if (await refresh()) toast("Updated from disk");
        if (state.save.kind === "error") {
          state.save = { kind: "idle" };
          drawStatus();
        }
      } catch (e) {
        if (e && e.name === "NotFoundError") {
          state.save = { kind: "error", message: "File is gone" };
          drawStatus();
        }
      }
    };
    setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
  }

  // ---------- selecting ----------

  function readSelection() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!page.contains(range.commonAncestorContainer)) return null;
    if (!sel.toString().trim()) return null;
    const info = spanFromSelection(range);
    return { rect: range.getBoundingClientRect(), info: info || { ok: false, reason: "Nothing here can be annotated" } };
  }

  /**
   * Turn a DOM selection into a span to write. Each end lands on the anchor it is
   * in (or the nearest one the selection covers). An end in a unit becomes an
   * inline marker position, widened off anything a comment can't split; an end in
   * a block becomes a marker line at the block's edge. When that makes the span
   * bigger than the selection, skip/len record exactly what was selected.
   */
  function spanFromSelection(range) {
    const list = anchors(page);
    const hit = list.filter((an) => intersects(an.range, range));
    if (!hit.length) return null;
    let first = hit[0];
    let last = hit[hit.length - 1];
    const inside = (an, node, offset) => an.range.comparePoint(node, offset) === 0;
    let selStart = inside(first, range.startContainer, range.startOffset) ? startOf(range) : startOf(first.range);
    let selEnd = inside(last, range.endContainer, range.endOffset) ? endOf(range) : endOf(last.range);
    // A selection that ends at the very start of an anchor covers none of it (a
    // triple-click ends on the next block); likewise one starting at an end.
    if (hit.length > 1 && textLength(between(startOf(last.range), selEnd)) === 0) {
      last = hit[hit.length - 2];
      selEnd = endOf(last.range);
    }
    if (first !== last && textLength(between(selStart, endOf(first.range))) === 0) {
      first = hit[hit.indexOf(first) + 1];
      selStart = startOf(first.range);
    }
    const startAt = textLength(between(startOf(first.range), selStart));
    const endAt = textLength(between(startOf(last.range), selEnd));

    const span = {};
    if (first.kind === "u" && last.kind === "u" && first.i === last.i) {
      const adj = projection(state.analysis.units.get(first.i)).adjust(startAt, endAt);
      if (!adj) return null;
      span.start = adj.start;
      span.end = adj.end;
    } else {
      if (first.kind === "u") {
        const proj = projection(state.analysis.units.get(first.i));
        span.start = (proj.adjust(startAt, proj.plain.length) || { start: proj.toSource(startAt) }).start;
      } else {
        span.start = first.a;
        span.startBlock = true;
      }
      if (last.kind === "u") {
        const proj = projection(state.analysis.units.get(last.i));
        span.end = (proj.adjust(0, endAt) || { end: proj.toSource(endAt) }).end;
      } else {
        span.end = last.b;
        span.endBlock = true;
      }
    }
    if (span.end <= span.start) return null;

    const region = spanRange(span, list);
    if (!region) return null;
    const selected = between(selStart, selEnd);
    const skip = Math.max(0, textLength(between(startOf(region), selStart)));
    const len = textLength(selected);
    if (skip > 0 || len < textLength(region)) Object.assign(span, { skip, len });
    return { ok: true, ...span, quote: selected.toString().replace(/\s+/g, " ").trim() };
  }

  let offered = null;
  function offer() {
    const sel = readSelection();
    if (!sel) return hidePopover();
    offered = sel.info.ok ? sel.info : null;
    popover.replaceChildren();
    if (offered) {
      const btn = el("button", "tm-pop-btn");
      btn.type = "button";
      btn.append(el("span", null, "Comment"), el("kbd", null, "C"));
      btn.addEventListener("click", startPending);
      popover.appendChild(btn);
    } else {
      popover.appendChild(el("span", "tm-pop-note", sel.info.reason));
    }
    popover.hidden = false;
    const box = popover.getBoundingClientRect();
    const pane = scroller.getBoundingClientRect();
    const left = Math.min(Math.max(sel.rect.left + sel.rect.width / 2 - box.width / 2, pane.left + 8), pane.right - box.width - 8);
    let top = sel.rect.top - box.height - 8;
    if (top < pane.top + 4) top = sel.rect.bottom + 8;
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  function hidePopover() {
    popover.hidden = true;
    offered = null;
  }

  function startPending() {
    const info = offered;
    if (!info) return;
    hidePopover();
    document.getSelection().removeAllRanges();
    // An unsent comment moves to the new selection rather than being thrown away.
    state.pending = { ...info, baseClean: state.clean, context: headingAt(state.analysis.headings, info.start)?.text || null };
    drawHighlights();
    drawRail();
    cards.scrollTop = 0;
  }

  function cancelPending() {
    state.pending = null;
    delete state.drafts.new;
    kvDelete(draftKey("new"));
    drawHighlights();
    drawRail();
  }

  // ---------- small things ----------

  let toastTimer;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    toastEl.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove("is-on");
      toastEl.hidden = true;
    }, 3200);
  }

  const draftKey = (key) => `draft:${path}:${key}`;
  const draftTimers = {};
  function saveDraft(key) {
    clearTimeout(draftTimers[key]);
    draftTimers[key] = setTimeout(() => {
      if (state.drafts[key]) kvPut(draftKey(key), state.drafts[key]);
      else kvDelete(draftKey(key));
    }, 400);
  }

  let uiTimer;
  function persistUi() {
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => {
      kvPut(`view:${path}`, {
        filter: state.filter,
        expanded: [...state.expanded],
        width: state.width,
        scroll: scroller.scrollTop,
      });
    }, 300);
  }

  async function restoreUi() {
    const saved = await kvGet(`view:${path}`);
    if (saved) {
      state.filter = saved.filter === "all" ? "all" : "open";
      state.expanded = new Set(saved.expanded || []);
      state.width = saved.width || null;
    }
    if (state.width) root.style.setProperty("--tm-doc", `${state.width}%`);
    for (const v of views()) {
      const draft = await kvGet(draftKey(`t${v.id}`));
      if (draft) state.drafts[`t${v.id}`] = draft;
    }
    drawRail();
    if (saved && saved.scroll) scroller.scrollTop = saved.scroll;
  }

  // ---------- mount ----------

  function mount() {
    document.title = fileName;
    if (settings.theme === "dark" || settings.theme === "light") document.documentElement.dataset.tmTheme = settings.theme;
    root = el("div", "tm-app");
    root.innerHTML = `
      <main class="tm-scroller"><article class="tm-page"></article></main>
      <div class="tm-divider" role="separator" aria-orientation="vertical" aria-label="Resize panes"></div>
      <aside class="tm-rail">
        <header class="tm-rail-head">
          <div class="tm-file">
            <span class="tm-file-name" title="${esc(path)}">${esc(fileName)}</span>
            <span class="tm-status"></span>
          </div>
          <div class="tm-toolbar">
            <div class="tm-seg">
              <button type="button" data-filter="open">Open <span class="tm-n">0</span></button>
              <button type="button" data-filter="all">All <span class="tm-n">0</span></button>
            </div>
            <span class="tm-spacer"></span>
            <button type="button" class="tm-btn" data-act="source" title="Show the file's raw text, markers included">Source</button>
          </div>
        </header>
        <div class="tm-cards"></div>
        <div class="tm-toast" role="status" hidden></div>
      </aside>`;
    document.body.replaceChildren(root);
    scroller = root.querySelector(".tm-scroller");
    page = root.querySelector(".tm-page");
    rail = root.querySelector(".tm-rail");
    cards = root.querySelector(".tm-cards");
    statusEl = root.querySelector(".tm-status");
    toastEl = root.querySelector(".tm-toast");
    popover = el("div", "tm-pop");
    popover.hidden = true;
    // Keep the selection alive while the button is pressed.
    popover.addEventListener("mousedown", (e) => e.preventDefault());
    document.body.appendChild(popover);

    rail.addEventListener("click", (e) => {
      const target = e.target.closest("button");
      if (!target) return;
      if (target.dataset.filter) {
        state.filter = target.dataset.filter;
        persistUi();
        drawRail();
      } else if (target.dataset.act === "source") {
        state.showSource = !state.showSource;
        target.classList.toggle("is-on", state.showSource);
        hidePopover();
        drawDocument();
      }
    });

    document.addEventListener("mouseup", (e) => {
      if (popover.contains(e.target)) return;
      setTimeout(offer, 0);
    });
    document.addEventListener("selectionchange", () => {
      if (!popover.hidden && !readSelection()) hidePopover();
    });
    page.addEventListener("click", (e) => {
      const mark = e.target.closest("mark[data-thread]");
      if (!mark || mark.dataset.thread === "new" || !document.getSelection().isCollapsed) return;
      setHot(Number(mark.dataset.thread));
      showCard(mark.dataset.thread);
    });
    page.addEventListener("mouseover", (e) => {
      const mark = e.target.closest("mark[data-thread]");
      setHot(mark ? (mark.dataset.thread === "new" ? "new" : Number(mark.dataset.thread)) : null);
    });
    page.addEventListener("mouseleave", () => setHot(null));
    cards.addEventListener("mouseover", (e) => {
      const c = e.target.closest(".tm-card");
      setHot(c ? (c.dataset.thread === "new" ? "new" : Number(c.dataset.thread)) : null);
    });
    cards.addEventListener("mouseleave", () => setHot(null));

    document.addEventListener("keydown", (e) => {
      const typing = e.target.closest && e.target.closest("textarea, input, [contenteditable]");
      const commentKey = (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "c" || e.key === "C")) || (e.metaKey && e.altKey && e.code === "KeyM");
      if (!typing && commentKey) {
        if (popover.hidden) offer();
        if (offered) {
          e.preventDefault();
          startPending();
        }
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault(); // everything is saved as it happens
        toast(file.state === "granted" ? "Everything is already saved" : "Nothing to save until you send a comment");
      } else if (e.key === "Escape" && !typing) {
        if (!popover.hidden) hidePopover();
        else if (state.pending && !state.drafts.new) cancelPending();
      }
    });
    scroller.addEventListener(
      "scroll",
      () => {
        hidePopover();
        persistUi();
      },
      { passive: true },
    );
    window.addEventListener("resize", hidePopover);
    dragDivider(root.querySelector(".tm-divider"));
  }

  function dragDivider(divider) {
    let startX = 0;
    let startWidth = 0;
    const move = (e) => {
      const pct = Math.min(82, Math.max(40, ((startWidth + e.clientX - startX) / window.innerWidth) * 100));
      root.style.setProperty("--tm-doc", `${pct}%`);
      state.width = Math.round(pct * 10) / 10;
    };
    const up = () => {
      root.classList.remove("is-resizing");
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      persistUi();
    };
    divider.addEventListener("pointerdown", (e) => {
      startX = e.clientX;
      startWidth = scroller.getBoundingClientRect().width;
      root.classList.add("is-resizing");
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      e.preventDefault();
    });
    divider.addEventListener("dblclick", () => {
      root.style.removeProperty("--tm-doc");
      state.width = null;
      persistUi();
    });
  }

  /** Show the text we already have; no disk access needed. */
  function load(text) {
    ingest(text);
    draw();
  }

  /** After the file link is restored: read from disk if allowed, restore the view. */
  async function start() {
    if (file.state === "granted") {
      try {
        await linked();
      } catch (e) {
        /* the stored handle went stale; we stay on the viewer's copy */
      }
    }
    drawStatus();
    await restoreUi();
    // A folder connected in another tab covers this one too: look again whenever
    // the tab comes back into view.
    const retry = async () => {
      if (file.state === "granted" || document.hidden) return;
      await file.restore();
      if (file.state === "granted") await linked().catch(() => {});
      else drawStatus();
    };
    window.addEventListener("focus", retry);
    document.addEventListener("visibilitychange", retry);
  }

  return {
    mount,
    load,
    start,
    connect,
    get state() {
      return state;
    },
  };
}
