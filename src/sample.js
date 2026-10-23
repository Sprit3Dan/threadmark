// The sample: the real reading view over a document held in memory, so the format
// can be seen without touching a real file. Writes go to the in-memory copy, which
// is what makes the demo behave exactly like the real thing.

import { createApp } from "./ui/app.js";
import { fileLink, handleStore } from "./ui/fs.js";
import cssText from "./ui/styles.css";

const state = { text: "", mtime: Date.now() };
const info = () => ({ lastModified: state.mtime, size: state.text.length });

const file = {
  state: "granted",
  via: null,
  async restore() {},
  async ensure() {},
  async read() {
    return { text: state.text, ...info() };
  },
  async write(text) {
    state.text = text;
    state.mtime = Date.now();
    return info();
  },
  async stat() {
    return info();
  },
};

async function main() {
  const style = document.createElement("style");
  style.textContent = cssText;
  document.head.appendChild(style);

  state.text = await (await fetch("sample.md")).text();
  const settings = { name: "dan", theme: "system" };
  try {
    Object.assign(settings, await chrome.storage.local.get(["name", "theme"]));
  } catch (e) {
    /* defaults */
  }
  const app = createApp({ path: "threadmark:sample", fileName: "sample.md", settings, file });
  app.mount();
  app.load(state.text);
  await app.start();
  if (__TM_DEV__) window.__tmTestFolder = testFolder;
  // For the dev harness: what the "file" holds now, and a way to simulate an agent.
  window.__tmSample = {
    text: () => state.text,
    write(text) {
      state.text = text;
      state.mtime = Date.now();
    },
  };
}

main().catch((e) => console.error("[threadmark sample] gave up:", e));

/**
 * Dev harness only: the folder flow against the origin-private file system,
 * standing in for a real folder (Chrome's pickers can't be scripted).
 */
async function testFolder() {
  const opfs = await navigator.storage.getDirectory();
  const mk = async (dir, names) => {
    for (const n of names) dir = await dir.getDirectoryHandle(n, { create: true });
    return dir;
  };
  const dev = await mk(opfs, ["Users", "dan", "dev"]);
  const proj = await mk(dev, ["proj"]);
  for (const [name, text] of [["a.md", "# A\n"], ["b.md", "# B\n"]]) {
    const w = await (await proj.getFileHandle(name, { create: true })).createWritable();
    await w.write(text);
    await w.close();
  }
  for (const key of await handleStore.keys()) await handleStore.drop(key);

  const out = {};
  const first = fileLink("/Users/dan/dev/proj/a.md", "a.md", { showDirectoryPicker: async () => dev });
  await first.restore();
  out.before = first.state;
  out.root = await first.connectFolder();
  out.after = first.state;
  out.readA = (await first.read()).text;

  const second = fileLink("/Users/dan/dev/proj/b.md", "b.md", {});
  await second.restore(); // no picker: found through the remembered folder
  out.second = second.state;
  out.readB = (await second.read()).text;

  const outside = fileLink("/Users/dan/other/c.md", "c.md", {});
  await outside.restore();
  out.outside = outside.state;

  const wrong = fileLink("/Users/dan/elsewhere/x.md", "x.md", { showDirectoryPicker: async () => dev });
  out.wrong = await wrong.connectFolder().then(() => "connected?!", (e) => e.code);
  return out;
}
