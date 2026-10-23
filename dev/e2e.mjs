#!/usr/bin/env node
// Dev harness: real Chrome, real extension, scripted checks.
//
// The extension is file://-only by design, but that requires the "allow access to
// file URLs" toggle, which cannot be set from a script. So this runs the dev build
// (which additionally matches 127.0.0.1) against a local server serving markdown as
// text/plain — the same plain-text document Chrome's viewer shows for a .md file.
//
// Run: node dev/e2e.mjs [--shot]

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
const EXT = path.join(ROOT, "dist-dev");
const TMP = path.join(os.tmpdir(), "threadmark-e2e");
const PROFILE = path.join(TMP, "profile");
const PORT = 8787;
const DEBUG = 9444;
// Branded Chrome ignores --load-extension since 137; Chrome for Testing (as
// installed by Playwright) still honours it. Override with CHROME=/path/to/binary.
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  const builds = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const b of builds) {
    const bin = path.join(cache, b, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
    if (fs.existsSync(bin)) return bin;
  }
  return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}
const CHROME = findChrome();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fixture ----------

const FIXTURE = `# Payment retry review

The queue <!-- @t1:start -->retries forever<!-- @t1:end --> on a 500, which the
on-call has been asking about since March.

| path | attempts | median |
| --- | --- | --- |
| charge | 3 | 210ms |
| refund | infinite | 4s |

\`\`\`python
def retry(job):  # not annotatable
    return True
\`\`\`

## Where this goes next

- [ ] cap attempts at five
- [x] add a dead-letter queue
- a bullet long enough that it wraps onto
  an indented second line in the source

<details>
<summary>Raw HTML block</summary>
</details>

A closing paragraph with **bold** and a [link](https://x.test/docs) to anchor on.

<!-- @threads:start -->

## Review threads

### T1 · open

> on: "retries forever" — in "Payment retry review"

- **dan** · 2026-10-22 11:02 — this is the on-call complaint in one line
- **claude** · 2026-10-22 11:09 — agreed; proposing five attempts plus DLQ

<!-- @threads:end -->
`;

// --file <path>: serve a real document instead, screenshot it, and stop.
const fileArg = process.argv.indexOf("--file");
const REAL = fileArg > -1 ? fs.readFileSync(process.argv[fileArg + 1], "utf8") : null;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(REAL ?? FIXTURE);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// ---------- launch ----------

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    ...(process.argv.includes("--headed") ? [] : ["--headless=new"]),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--remote-debugging-port=" + DEBUG,
    "--user-data-dir=" + PROFILE,
    "--disable-extensions-except=" + EXT,
    "--load-extension=" + EXT,
    "--window-size=1440,900",
    "about:blank",
  ],
  { stdio: "ignore" }
);

async function waitUp() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG}/json/version`);
      if (r.ok) return (await r.json()).Browser;
    } catch (e) {}
    await sleep(400);
  }
  throw new Error("chrome never answered");
}

// ---------- tiny CDP ----------

async function connect(urlMatch) {
  for (let i = 0; i < 60; i++) {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json();
    const target = list.find((t) => t.type === "page" && t.url.includes(urlMatch));
    if (target?.webSocketDebuggerUrl) return page(target.webSocketDebuggerUrl);
    await sleep(300);
  }
  throw new Error("no page matching " + urlMatch);
}

function page(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", () => rej(new Error("ws failed")));
  });
  const send = (method, params = {}) =>
    ready.then(
      () =>
        new Promise((res, rej) => {
          const n = ++id;
          pending.set(n, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
          ws.send(JSON.stringify({ id: n, method, params }));
        })
    );
  return {
    send,
    async eval(expression) {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error("page threw: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      }
      return r.result.value;
    },
    async open(url) {
      await send("Page.enable");
      await send("Page.navigate", { url });
    },
    async shot(file) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(file, Buffer.from(r.data, "base64"));
      return file;
    },
    close: () => ws.close(),
  };
}

// Unpacked extension ids are derived from the directory's absolute path.
function extensionId(dirPath) {
  const digest = crypto.createHash("sha256").update(dirPath).digest("hex").slice(0, 32);
  return [...digest].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

// ---------- checks ----------

let browserWs = null;
let failures = 0;
const shots = process.argv.includes("--shot");
const check = (name, value, ok = (v) => Boolean(v)) => {
  const pass = ok(value);
  if (!pass) failures++;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
};

/** Select `snippet` inside the first rendered unit containing it, then release the mouse. */
const selectJs = (snippet) => `(() => {
  const unit = [...document.querySelectorAll('.tm-u')].find(u => u.textContent.includes(${JSON.stringify(snippet)}));
  const walker = document.createTreeWalker(unit, NodeFilter.SHOW_TEXT);
  let node; while ((node = walker.nextNode()) && !node.data.includes(${JSON.stringify(snippet)}));
  const at = node.data.indexOf(${JSON.stringify(snippet)});
  const r = new Range(); r.setStart(node, at); r.setEnd(node, at + ${snippet.length});
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return true;
})()`;

/** Select `snippet` in the first text node under `selector` that contains it. */
const selectInJs = (selector, snippet) => `(() => {
  const walker = document.createTreeWalker(document.querySelector(${JSON.stringify(selector)}), NodeFilter.SHOW_TEXT);
  let node; while ((node = walker.nextNode()) && !node.data.includes(${JSON.stringify(snippet)}));
  const at = node.data.indexOf(${JSON.stringify(snippet)});
  const r = new Range(); r.setStart(node, at); r.setEnd(node, at + ${snippet.length});
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return true;
})()`;

const submitJs = (key, text) => `(() => {
  const box = document.querySelector('textarea[data-draft="${key}"]');
  box.value = ${JSON.stringify(text)};
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.closest('form').requestSubmit();
  return true;
})()`;

try {
  check("chrome", await waitUp());
  const extId = extensionId(EXT);

  // --- the reading view over a "file" Chrome shows as plain text ---
  await browserTarget("Target.createTarget", { url: `http://127.0.0.1:${PORT}/fixture.md` });
  await sleep(1500);
  const doc = await connect(`127.0.0.1:${PORT}`);
  await doc.send("Runtime.enable");
  await doc.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await doc.open(`http://127.0.0.1:${PORT}/fixture.md`);
  await sleep(1800);

  check("took over the page", await doc.eval(`Boolean(document.querySelector('.tm-app'))`));
  if (REAL) {
    check("rendered blocks", await doc.eval(`document.querySelector('.tm-page').children.length`), (v) => v > 0);
    check("units", await doc.eval(`document.querySelectorAll('.tm-u').length`), (v) => v > 0);
    check("highlights", await doc.eval(`document.querySelectorAll('mark.tm-mark').length`), () => true);
    check("cards", await doc.eval(`document.querySelectorAll('.tm-card').length`), () => true);
    check("shot", await doc.shot(path.join(TMP, "real.png")));
    for (const y of [1, 2]) {
      await doc.eval(`document.querySelector('.tm-scroller').scrollTop = ${y} * 1600`);
      await sleep(200);
      await doc.shot(path.join(TMP, `real-${y}.png`));
    }
    throw new Error(failures ? "real file checks failed" : "done");
  }
  check("rendered the file, not the rail", await doc.eval(`document.querySelector('.tm-page h1')?.textContent`), (v) => v === "Payment retry review");
  check("table rows", await doc.eval(`document.querySelectorAll('.tm-page tbody tr').length`), (v) => v === 2);
  check("code block", await doc.eval(`Boolean(document.querySelector('.tm-page pre code'))`));
  check("highlight from markers", await doc.eval(`[...document.querySelectorAll('mark.tm-mark')].map(m => m.textContent).join('|')`), (v) => v === "retries forever");
  check("cards in rail", await doc.eval(`[...document.querySelectorAll('.tm-card')].map(c => c.dataset.thread)`), (v) => v.join() === "1");
  check("messages in card", await doc.eval(`document.querySelectorAll('.tm-card[data-thread="1"] .tm-msg').length`), (v) => v === 2);
  check("threads block hidden from reading view", await doc.eval(`!document.querySelector('.tm-page').textContent.match(/Review threads|@threads/)`));
  check("no literal comments rendered", await doc.eval(`!document.querySelector('.tm-page').textContent.includes('<!--')`));
  check("status says not connected", await doc.eval(`document.querySelector('.tm-status')?.textContent`), (v) => /Not connected/.test(v));
  if (shots) check("shot", await doc.shot(path.join(TMP, "reading.png")));

  await doc.eval(selectJs("cap attempts"));
  await sleep(300);
  check("popover offers Comment", await doc.eval(`document.querySelector('.tm-pop:not([hidden]) .tm-pop-btn')?.textContent`), (v) => /Comment/.test(v));
  if (shots) await doc.shot(path.join(TMP, "popover.png"));
  await doc.eval(`document.querySelector('.tm-pop-btn').click()`);
  await sleep(300);
  check("pending card opened", await doc.eval(`document.querySelector('.tm-card.is-pending .tm-quote')?.textContent`), (v) => v === "cap attempts");
  check("pending highlight drawn", await doc.eval(`document.querySelector('mark.tm-pending')?.textContent`), (v) => v === "cap attempts");
  check("composer focused", await doc.eval(`document.activeElement?.dataset?.draft`), (v) => v === "new");
  if (shots) await doc.shot(path.join(TMP, "pending.png"));

  // A whole paragraph the way a triple-click or an overshooting drag selects it:
  // from the paragraph element itself to offset 0 of the next block.
  const PARA = "The queue retries forever on a 500, which the on-call has been asking about since March.";
  for (const [name, setup] of [
    ["paragraph → next block", `r.setStart(p, 0); r.setEnd(p.nextElementSibling, 0);`],
    ["paragraph text → start of next block's text", `r.setStart(p.querySelector('.tm-u').firstChild, 0); r.setEnd(document.createTreeWalker(p.nextElementSibling, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.data.trim() ? 1 : 3 }).nextNode(), 0);`],
  ]) {
    await doc.eval(`(() => {
      const p = document.querySelector('.tm-page p');
      const r = new Range(); ${setup}
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return true;
    })()`);
    await sleep(250);
    check(`whole paragraph offered (${name})`, await doc.eval(`document.querySelector('.tm-pop:not([hidden]) .tm-pop-btn')?.textContent || document.querySelector('.tm-pop .tm-pop-note')?.textContent`), (v) => /Comment/.test(v || ""));
    await doc.eval(`document.querySelector('.tm-pop-btn')?.click()`);
    await sleep(250);
    check(`whole paragraph quoted (${name})`, await doc.eval(`document.querySelector('.tm-card.is-pending .tm-quote')?.textContent`), (v) => v === PARA);
  }

  // Real triple-clicks and real drags through Chrome's input pipeline, so the
  // selection is whatever Chrome itself makes of them.
  const mouse = async (type, x, y, clickCount = 1) =>
    doc.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount, buttons: type === "mouseReleased" ? 0 : 1 });
  const at = async (selector, edge) =>
    doc.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.scrollIntoView({ block: "nearest" });
      const r = [...el.getClientRects()]; const a = r[0], z = r[r.length - 1];
      return ${JSON.stringify(edge)} === "end" ? { x: z.right - 2, y: z.top + z.height / 2 } : { x: a.left + 2, y: a.top + a.height / 2 };
    })()`);
  const tripleClick = async (selector) => {
    const p = await at(selector, "start");
    for (let n = 1; n <= 3; n++) {
      await mouse("mousePressed", p.x + 10, p.y, n);
      await mouse("mouseReleased", p.x + 10, p.y, n);
    }
    await sleep(300);
  };
  const drag = async (from, to) => {
    await mouse("mousePressed", from.x, from.y);
    for (let k = 1; k <= 8; k++) await mouse("mouseMoved", from.x + ((to.x - from.x) * k) / 8, from.y + ((to.y - from.y) * k) / 8);
    await mouse("mouseReleased", to.x, to.y);
    await sleep(300);
  };
  const pendingQuote = async () => {
    const offered = await doc.eval(`document.querySelector('.tm-pop:not([hidden]) .tm-pop-btn') ? 'Comment' : (document.querySelector('.tm-pop .tm-pop-note')?.textContent || 'no popover')`);
    if (offered !== "Comment") return offered;
    await doc.eval(`document.querySelector('.tm-pop-btn').click()`);
    await sleep(200);
    return doc.eval(`document.querySelector('.tm-card.is-pending .tm-quote')?.textContent`);
  };

  await tripleClick(".tm-page p .tm-u");
  check("triple-click a paragraph", await pendingQuote(), (v) => v === PARA);
  await tripleClick(".tm-page li .tm-u");
  check("triple-click a bullet", await pendingQuote(), (v) => v === "cap attempts at five");
  await tripleClick(".tm-page li:nth-child(2) .tm-u");
  check("triple-click the last bullet", await pendingQuote(), (v) => v === "add a dead-letter queue");
  await drag(await at(".tm-page li .tm-u", "start"), { ...(await at(".tm-page li:nth-child(2) .tm-u", "end")), x: (await at(".tm-page li:nth-child(2) .tm-u", "end")).x + 60 });
  check("drag across two bullets, past the end", await pendingQuote(), (v) => v === "cap attempts at five add a dead-letter queue");
  await drag({ ...(await at(".tm-page li .tm-u", "start")), x: (await at(".tm-page li .tm-u", "start")).x - 40 }, await at(".tm-page li .tm-u", "end"));
  check("drag a bullet from its marker", await pendingQuote(), (v) => v === "cap attempts at five");

  await doc.eval(submitJs("new", "keep me"));
  await sleep(300);
  check("sending unconnected offers folder or file", await doc.eval(`[...document.querySelectorAll('.tm-chooser button')].map(b => b.textContent).join(' | ')`), (v) => v === "Choose folder… | Just this file | Not now");
  await doc.eval(`[...document.querySelectorAll('.tm-chooser button')].pop().click()`);
  await sleep(300);
  check("Not now keeps the draft", await doc.eval(`document.querySelector('textarea[data-draft="new"]')?.value`), (v) => v === "keep me");
  if (shots) {
    await doc.eval(submitJs("new", "keep me"));
    await sleep(300);
    await doc.shot(path.join(TMP, "chooser.png"));
    await doc.eval(`[...document.querySelectorAll('.tm-chooser button')].pop().click()`);
  }

  await doc.eval(selectJs("add a dead-letter"));
  await sleep(250);
  check("a draft follows a new selection", (await pendingQuote()) + " / " + (await doc.eval(`document.querySelector('textarea[data-draft="new"]')?.value`)), (v) => v === "add a dead-letter / keep me");

  await doc.eval(`(() => {
    const code = document.createTreeWalker(document.querySelector('.tm-page pre code'), NodeFilter.SHOW_TEXT).nextNode();
    const r = new Range(); r.setStart(code, 0); r.setEnd(code, Math.min(3, code.data.length));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  check("code offered", await pendingQuote(), (v) => v === "def");
  await doc.eval(selectJs("onto\nan indented"));
  await sleep(250);
  check("wrapped bullet offered", await pendingQuote(), (v) => v === "onto an indented");
  await doc.eval(`(() => {
    const s = document.querySelector('.tm-page summary');
    const r = new Range(); r.selectNodeContents(s);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  })()`);
  await sleep(250);
  check("raw HTML offered", await pendingQuote(), (v) => v === "Raw HTML block");

  // --- the sample: the full write path against an in-memory file ---
  const samplePage = await pageAt(`chrome-extension://${extId}/sample.html`);
  await samplePage.send("Runtime.enable");
  await samplePage.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(1200);
  check("sample mounted", await samplePage.eval(`Boolean(document.querySelector('.tm-app'))`));
  const before = await samplePage.eval(`[...document.querySelectorAll('mark.tm-mark')].length`);

  await samplePage.eval(submitJs("t1", "thanks — I will take the **DLQ** row"));
  await sleep(500);
  check("reply rendered", await samplePage.eval(`[...document.querySelectorAll('.tm-card[data-thread="1"] .tm-msg-body')].pop()?.innerHTML`), (v) => /<strong>DLQ<\/strong>/.test(v || ""));

  await samplePage.eval(selectJs("atomic per key"));
  await sleep(200);
  await samplePage.eval(`document.querySelector('.tm-pop-btn').click()`);
  await sleep(200);
  await samplePage.eval(submitJs("new", "is per-key atomicity actually cheaper?"));
  await sleep(600);
  const raw = await samplePage.eval(`window.__tmSample.text()`);
  check("new thread's markers wrapped exactly the selection", raw.match(/<!-- @t(\d+):start -->atomic per key<!-- @t\1:end -->/)?.[0]);
  check("existing markers intact", (raw.match(/<!-- @t\d+:(start|end) -->/g) || []).length, (v) => v % 2 === 0 && v >= 6);
  check("reply line written", (raw.match(/^- \*\*dan\*\* · \d{4}-\d\d-\d\d \d\d:\d\d — thanks.*$/m) || [])[0]);
  check("one thread block", (raw.match(/@threads:start/g) || []).length, (v) => v === 1);
  check("highlights after write", await samplePage.eval(`new Set([...document.querySelectorAll('mark.tm-mark')].map(m => m.dataset.thread)).size`), (v) => v >= 3);
  check("no pending card left", await samplePage.eval(`!document.querySelector('.tm-card.is-pending')`));

  // A word inside a fenced code block: markers go on lines around the block, and
  // skip/len keep the highlight on just that word.
  await samplePage.eval(selectInJs(".tm-page pre code", "invalidations"));
  await sleep(200);
  await samplePage.eval(`document.querySelector('.tm-pop-btn').click()`);
  await sleep(200);
  await samplePage.eval(submitJs("new", "why this table?"));
  await sleep(600);
  const withCode = await samplePage.eval(`window.__tmSample.text()`);
  const codeMarker = withCode.match(/\n<!-- @t(\d+):start skip=\d+ len=13 -->\n```sql\n[\s\S]*?\n```\n<!-- @t\1:end -->\n/);
  check("code block wrapped by block markers", codeMarker?.[0].split("\n")[1]);
  check("code highlight is just the word", await samplePage.eval(`[...document.querySelectorAll('mark[data-thread="${codeMarker?.[1]}"]')].map(m => m.textContent).join('')`), (v) => v === "invalidations");
  check("code card quotes the word", await samplePage.eval(`document.querySelector('.tm-card[data-thread="${codeMarker?.[1]}"] .tm-quote')?.textContent`), (v) => v === "invalidations");
  check("code block still renders as code", await samplePage.eval(`document.querySelector('.tm-page pre code')?.textContent.startsWith('SELECT')`));

  // Edit your own reply: same author and stamp, new text, nothing else touched.
  const beforeEdit = await samplePage.eval(`window.__tmSample.text()`);
  await samplePage.eval(`(() => {
    const mine = [...document.querySelectorAll('.tm-card[data-thread="1"] .tm-msg')].filter(li => li.querySelector('.tm-author').textContent === 'dan').pop();
    [...mine.querySelectorAll('.tm-msg-tools button')].find(b => b.textContent === 'Edit').click();
    return true;
  })()`);
  await sleep(200);
  const editKey = await samplePage.eval(`document.querySelector('.tm-composer.is-editing textarea')?.dataset.draft`);
  if (shots) {
    await samplePage.send("Page.bringToFront");
    const r = await samplePage.eval(`(() => { const li = [...document.querySelectorAll('.tm-card[data-thread="1"] .tm-msg')][0]; const b = li.getBoundingClientRect(); return { x: b.left + 40, y: b.top + 8 }; })()`);
    await samplePage.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y });
    await sleep(300);
    await samplePage.shot(path.join(TMP, "editing.png"));
  }
  check("edit opens prefilled", await samplePage.eval(`document.querySelector('.tm-composer.is-editing textarea')?.value`), (v) => /DLQ/.test(v || ""));
  await samplePage.eval(submitJs(editKey, "edited: I'll take the DLQ row and the timer row"));
  await sleep(500);
  const afterEdit = await samplePage.eval(`window.__tmSample.text()`);
  const oldLine = beforeEdit.match(/^- \*\*dan\*\* · (\S+ \S+) — thanks.*$/m);
  check("edit rewrote just that line", afterEdit === beforeEdit.replace(oldLine[0], `- **dan** · ${oldLine[1]} — edited: I'll take the DLQ row and the timer row`));
  check("edited text shown", await samplePage.eval(`[...document.querySelectorAll('.tm-card[data-thread="1"] .tm-msg-body')].map(b => b.textContent).join('|')`), (v) => v.includes("edited: I'll take"));

  // Delete the only message of the code-block thread: the annotation goes too.
  const codeId = codeMarker?.[1];
  const delMsg = `[...document.querySelectorAll('.tm-card[data-thread="${codeId}"] .tm-msg-tools button')].find(b => /Delete|Really/.test(b.textContent)).click()`;
  await samplePage.eval(delMsg);
  await sleep(150);
  check("delete asks for a second click", await samplePage.eval(`document.querySelector('.tm-card[data-thread="${codeId}"] .tm-danger.is-armed')?.textContent`), (v) => v === "Really delete?");
  check("nothing deleted after one click", (await samplePage.eval(`window.__tmSample.text()`)).includes(`@t${codeId}:start`));
  await samplePage.eval(delMsg);
  await sleep(500);
  const afterDel = await samplePage.eval(`window.__tmSample.text()`);
  check("deleting the last message removes the thread", !afterDel.includes(`@t${codeId}:`) && !afterDel.includes(`### T${codeId}`));
  check("code block untouched", afterDel.includes("\n```sql\nSELECT count(*) FROM invalidations WHERE bucket = 'write-heavy';\n-- 1400/s, and it is not the query that is slow\n```\n"));
  check("its highlight is gone", await samplePage.eval(`document.querySelectorAll('mark[data-thread="${codeId}"]').length`), (v) => v === 0);

  // Delete a whole thread of yours from its header.
  const delThread = `document.querySelector('.tm-card[data-thread="4"] .tm-card-head .tm-danger').click()`;
  await samplePage.eval(delThread);
  await sleep(150);
  await samplePage.eval(delThread);
  await sleep(500);
  const afterThread = await samplePage.eval(`window.__tmSample.text()`);
  check("thread deleted from its header", !afterThread.includes("@t4:") && !afterThread.includes("### T4") && afterThread.includes("atomic per key rather than global"));
  check("agent's thread has no delete", await samplePage.eval(`!document.querySelector('.tm-card[data-thread="3"] .tm-danger')`));

  // An agent replies on disk; the view picks it up on its own.
  await samplePage.eval(`(() => {
    const t = window.__tmSample.text();
    window.__tmSample.write(t.replace(/(### T1 · open[\\s\\S]*?)(\\n\\n### T2)/, "$1\\n- **claude** · 2026-10-22 21:00 — noted, adding the row$2"));
    return true;
  })()`);
  await sleep(2600);
  check("agent reply appeared without reload", await samplePage.eval(`[...document.querySelectorAll('.tm-card[data-thread="1"] .tm-author')].map(a => a.textContent).pop()`), (v) => v === "claude");

  await samplePage.eval(`document.querySelector('.tm-card[data-thread="1"] .tm-card-head .tm-link').click()`);
  await sleep(400);
  check("resolve rewrote the status token", /### T1 · resolved/.test(await samplePage.eval(`window.__tmSample.text()`)));
  check("footer counts resolved threads", await samplePage.eval(`document.querySelector('.tm-footer span')?.textContent`), (v) => v === "2 resolved");
  const clean = `[...document.querySelectorAll('.tm-footer button')].pop().click()`;
  await samplePage.eval(clean);
  await sleep(150);
  check("clean up asks first", await samplePage.eval(`[...document.querySelectorAll('.tm-footer button')].pop().textContent`), (v) => v === "Remove 2 for good?");
  if (shots) await samplePage.shot(path.join(TMP, "cleanup.png"));
  await samplePage.eval(clean);
  await sleep(500);
  const cleaned = await samplePage.eval(`window.__tmSample.text()`);
  check("resolved threads removed from the file", !/@t[12]:|### T[12] /.test(cleaned));
  check("open thread kept", /### T3/.test(cleaned));
  check("their highlights gone", await samplePage.eval(`document.querySelectorAll('mark.tm-mark').length`), (v) => v === 0);
  check("footer gone", await samplePage.eval(`!document.querySelector('.tm-footer')`));
  if (shots) {
    await samplePage.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await sleep(300);
    await samplePage.shot(path.join(TMP, "sample-dark.png"));
    await samplePage.send("Emulation.setEmulatedMedia", { features: [] });
  }
  const folder = await samplePage.eval(`window.__tmTestFolder()`);
  check("folder: unknown file starts unconnected", folder.before, (v) => v === "none");
  check("folder: path of the chosen folder worked out", folder.root, (v) => v === "/Users/dan/dev");
  check("folder: first file connected", folder.after + " / " + JSON.stringify(folder.readA), (v) => v === 'granted / "# A\\n"');
  check("folder: second file connects with no picker", folder.second + " / " + JSON.stringify(folder.readB), (v) => v === 'granted / "# B\\n"');
  check("folder: file outside it stays unconnected", folder.outside, (v) => v === "none");
  check("folder: a folder without the file is refused", folder.wrong, (v) => v === "mismatch");

  // A background tab never runs its CSS transitions; bring it forward first.
  await samplePage.send("Page.bringToFront");
  await sleep(400);
  if (process.env.TM_DEBUG) console.log(await samplePage.eval(`[...document.querySelectorAll('.tm-card')].map(c => c.className + ' | ' + getComputedStyle(c).borderTopColor).join('\\n')`));
  if (shots) await samplePage.shot(path.join(TMP, "sample.png"));
  void before;

  console.log(`\n${failures ? failures + " FAILED" : "all checks passed"}${shots ? " — shots in " + TMP : ""}`);
  if (failures) process.exitCode = 1;
} catch (e) {
  if (e.message === "done") console.log("shots in " + TMP);
  else {
    console.log("FAILED: " + e.message);
    process.exitCode = 1;
  }
} finally {
  chrome.kill("SIGTERM");
  server.close();
}

async function pageAt(url) {
  const list = await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json();
  let target = list.find((t) => t.type === "page" && t.url === url);
  if (!target) {
    const created = await browserTarget("Target.createTarget", { url });
    await sleep(1200);
    const again = await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json();
    target = again.find((t) => t.type === "page" && t.url.startsWith(url));
    if (!target) throw new Error("could not open " + url + " (created: " + JSON.stringify(created) + ")");
  }
  return page(target.webSocketDebuggerUrl);
}

async function browserTarget(method, params) {
  const info = await (await fetch(`http://127.0.0.1:${DEBUG}/json/version`)).json();
  if (!browserWs) {
    browserWs = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((r) => browserWs.addEventListener("open", r));
    browserWs._pending = new Map();
    browserWs.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && browserWs._pending.has(m.id)) {
        browserWs._pending.get(m.id)(m);
        browserWs._pending.delete(m.id);
      }
    });
    browserWs._id = 0;
  }
  return new Promise((res) => {
    const n = ++browserWs._id;
    browserWs._pending.set(n, (m) => res(m.result));
    browserWs.send(JSON.stringify({ id: n, method, params }));
  });
}
