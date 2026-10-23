#!/usr/bin/env node
// Throwaway: is the unpacked extension loaded by a visible Chrome, and can the
// "Allow access to file URLs" toggle be flipped over CDP? Not product code.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(import.meta.dirname);
const EXT = path.join(ROOT, "ext");
const TMP = path.join(os.tmpdir(), "threadmark-spike");
const PROFILE = path.join(TMP, "profile2");
const FIXTURE = path.join(TMP, "fixture.md");
const PORT = 9334;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

fs.mkdirSync(PROFILE, { recursive: true });
fs.writeFileSync(
  FIXTURE,
  "# Fixture\n\nSome **markdown** text to make sure the text viewer renders us.\n"
);
const probe = fs.readFileSync(path.join(ROOT, "probe.js"), "utf8");
fs.writeFileSync(path.join(EXT, "main.js"), probe.replace("__WORLD__", "MAIN"));
fs.writeFileSync(path.join(EXT, "iso.js"), probe.replace("__WORLD__", "ISO"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + PROFILE,
    "--disable-extensions-except=" + EXT,
    "--load-extension=" + EXT,
    "about:blank",
  ],
  { stdio: "ignore" }
);
chrome.on("error", (e) => console.log("spawn failed", e.message));

const deadline = Date.now() + 25000;
let up = false;
while (Date.now() < deadline) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (r.ok) {
      up = true;
      break;
    }
  } catch (e) {}
  await sleep(400);
}
if (!up) {
  console.log("chrome did not come up");
  chrome.kill("SIGTERM");
  process.exit(1);
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
console.log("targets:", list.map((t) => `${t.type}: ${t.url}`).join("\n         "));

// open chrome://extensions through the CDP target API and read the item list
const br = new WebSocket(
  (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl
);
await new Promise((r) => br.addEventListener("open", r));
let mid = 0;
const pending = new Map();
br.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) pending.get(m.id)(m), pending.delete(m.id);
});
const cmd = (method, params = {}, sessionId) =>
  new Promise((res) => {
    const n = ++mid;
    pending.set(n, res);
    br.send(JSON.stringify({ id: n, method, params, sessionId }));
  });

const created = await cmd("Target.createTarget", { url: "chrome://extensions" });
const s = await cmd("Target.attachToTarget", { targetId: created.targetId, flatten: true });
const sid = s.sessionId;
await cmd("Runtime.enable", {}, sid);
await sleep(2500);
const dump = await cmd(
  "Runtime.evaluate",
  {
    sessionId: sid,
    returnByValue: true,
    expression: `(async () => {
      const out = { href: location.href };
      const mgr = document.querySelector('extensions-manager');
      out.hasManager = !!mgr;
      if (mgr && mgr.shadowRoot) {
        const list = mgr.shadowRoot.querySelector('extensions-item-list');
        const sr = list && list.shadowRoot;
        out.items = sr ? Array.from(sr.querySelectorAll('extensions-item')).map(i => ({ name: i.getAttribute('name'), id: i.getAttribute('id') })) : 'no list shadow';
      }
      return JSON.stringify(out);
    })()`,
  },
  sid
);
console.log("chrome://extensions:", dump.result?.result?.value ?? JSON.stringify(dump.result ?? dump));

chrome.kill("SIGTERM");
await new Promise((r) => chrome.on("exit", r));
