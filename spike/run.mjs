#!/usr/bin/env node
// Throwaway spike: does a content script reach Chrome's plain-text .md viewer on
// file://, and what storage / File System Access primitives are available there?
// Not product code. Run: node spike/run.mjs
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(import.meta.dirname);
const EXT = path.join(ROOT, "ext");
const TMP = path.join(os.tmpdir(), "threadmark-spike");
const PROFILE = path.join(TMP, "profile");
const FIXTURE = path.join(TMP, "fixture.md");
const PORT = 9333;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });
fs.writeFileSync(
  FIXTURE,
  "# Fixture\n\nSome **markdown** text to make sure the text viewer renders us.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n"
);

// 1. build the two world scripts from the shared probe
const probe = fs.readFileSync(path.join(ROOT, "probe.js"), "utf8");
fs.writeFileSync(path.join(EXT, "main.js"), probe.replace("__WORLD__", "MAIN"));
fs.writeFileSync(path.join(EXT, "iso.js"), probe.replace("__WORLD__", "ISO"));

function launch(extra = []) {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + PROFILE,
    "--disable-extensions-except=" + EXT,
    "--load-extension=" + EXT,
    ...extra,
    "about:blank",
  ];
  const p = spawn(CHROME, args, { stdio: "ignore" });
  p.on("error", (e) => console.log("spawn failed", e.message));
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targetList() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function waitChrome(timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return true;
    } catch (e) {}
    await sleep(400);
  }
  throw new Error("chrome did not come up");
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const open = new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  return {
    ready: open,
    send(method, params = {}) {
      return open.then(
        () =>
          new Promise((res, rej) => {
            const n = ++id;
            pending.set(n, (msg) =>
              msg.error ? rej(new Error(method + ": " + JSON.stringify(msg.error))) : res(msg.result)
            );
            ws.send(JSON.stringify({ id: n, method, params }));
          })
      );
    },
    evaluate: async (expression) => {
      await open;
      const out = await new Promise((res, rej) => {
        const n = ++id;
        pending.set(n, (msg) => (msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)));
        ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
      });
      if (out.exceptionDetails) throw new Error("page threw: " + JSON.stringify(out.exceptionDetails));
      return out.result.value;
    },
    close: () => ws.close(),
  };
}

function kill(chrome) {
  if (!chrome || chrome.killed) return Promise.resolve();
  chrome.kill("SIGTERM");
  return new Promise((res) => chrome.on("exit", res));
}

const prefsPath = path.join(PROFILE, "Default", "Preferences");

// Phase 1: launch once so Chrome registers the unpacked extension, then exit.
console.log("phase 1: registering extension");
let chrome = launch();
await waitChrome();
await sleep(1500);
await kill(chrome);
await sleep(1500);

// Phase 2: find the extension id and grant file access the way the toggle does.
let settings = {};
try {
  const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
  settings = prefs.extensions?.settings || {};
} catch (e) {
  console.log("could not read Preferences:", e.message);
}
const entries = Object.entries(settings)
  .filter(([, v]) => (v.path || "").startsWith(EXT))
  .map(([id, v]) => ({ id, path: v.path, keys: Object.keys(v) }));
console.log("extension entries:", JSON.stringify(entries, null, 2));

const id = entries[0] && entries[0].id;
if (id) {
  const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
  const s = prefs.extensions.settings[id];
  s.allow_file_access = true;
  s.active_permissions = { ...s.active_permissions, api: s.active_permissions?.api || [] };
  const tmp = prefsPath + ".patched";
  fs.writeFileSync(tmp, JSON.stringify(prefs));
  fs.renameSync(tmp, prefsPath);
  console.log("granted file access to", id);
} else {
  console.log("NO EXTENSION REGISTERED - content scripts cannot be tested");
}

// Phase 3: relaunch, open the .md file, read what each world saw.
console.log("phase 3: probing a file:// .md tab");
chrome = launch();
try {
  await waitChrome();
  const pages = (await targetList()).filter((t) => t.type === "page");
  const page = pages[0];
  if (!page?.webSocketDebuggerUrl) throw new Error("no page target");
  const c = cdp(page.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await c.send("Page.navigate", { url: "file://" + FIXTURE });
  await sleep(2500);

  const read = (world) => c.evaluate(`document.documentElement.getAttribute('data-spike-${world}')`);
  let seen = { MAIN: null, ISO: null };
  for (let i = 0; i < 20; i++) {
    seen.MAIN = await read("MAIN");
    seen.ISO = await read("ISO");
    if (seen.MAIN && seen.ISO) break;
    await sleep(500);
  }
  const title = await c.evaluate("document.title");
  const contentType = await c.evaluate("document.contentType");
  const html = await c.evaluate("document.body ? document.body.innerHTML.slice(0,120) : 'no body'");
  console.log(
    JSON.stringify(
      {
        contentType,
        title,
        bodyStart: html,
        MAIN: seen.MAIN ? JSON.parse(seen.MAIN) : "NOT INJECTED",
        ISO: seen.ISO ? JSON.parse(seen.ISO) : "NOT INJECTED",
      },
      null,
      2
    )
  );
  c.close();
} catch (e) {
  console.log("probe failed:", e.message);
} finally {
  await kill(chrome);
}
