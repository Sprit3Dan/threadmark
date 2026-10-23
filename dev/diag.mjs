import { spawn } from "node:child_process";
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
const ROOT = path.resolve(import.meta.dirname, "..");
const EXT = path.join(ROOT, "dist-dev");
const PROFILE = path.join(os.tmpdir(), "threadmark-diag", "profile");
fs.rmSync(path.dirname(PROFILE), { recursive: true, force: true }); fs.mkdirSync(PROFILE, { recursive: true });
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
 ["--no-first-run","--disable-sync","--remote-debugging-port=9445","--user-data-dir="+PROFILE,
  "--disable-extensions-except="+EXT,"--load-extension="+EXT,"about:blank"], {stdio:"ignore"});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
await sleep(6000);
const list = await (await fetch("http://127.0.0.1:9445/json/list")).json();
console.log("targets:", list.map(t=>`${t.type}|${t.url}|${t.title}`).join("\n         "));
for (const f of ["Secure Preferences","Preferences"]) {
  const p = path.join(PROFILE, "Default", f);
  if (!fs.existsSync(p)) { console.log(f, "missing"); continue; }
  const raw = fs.readFileSync(p, "utf8");
  console.log(f, "mentions dist-dev:", raw.includes("dist-dev"), "| mentions Threadmark:", raw.includes("Threadmark"));
  try { const d = JSON.parse(raw); const s = d.extensions?.settings||{};
    for (const [id,v] of Object.entries(s)) if ((v.path||"").includes("threadmark")) console.log("  id", id, v.path, "state", v.state, "fileAccess", v.allow_file_access);
  } catch(e) { console.log("  parse fail", e.message); }
}
chrome.kill("SIGTERM");
