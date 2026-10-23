// Boot: decide whether this tab is a markdown file we should take over, get the
// source text out of Chrome's plain-text viewer, and hand the page to the app.

import { createApp } from "./ui/app.js";
import { fileLink } from "./ui/fs.js";
import cssText from "./ui/styles.css";

const MARKDOWN = /\.(md|markdown|mdown|mkd)$/i;
const DEFAULTS = { name: "dan", theme: "system", disabled: [] };

function wantsThreadmark() {
  if (location.protocol === "file:") {
    /* the only target in the shipped build */
  } else if (!__TM_DEV__ || !/^127\.0\.0\.1$|^localhost$/.test(location.hostname)) {
    return false;
  }
  const type = document.contentType || "";
  if (type === "text/markdown") return true;
  return MARKDOWN.test(location.pathname) && Boolean(document.querySelector("pre")) && document.body.childElementCount <= 1;
}

/** The file's text as Chrome's viewer shows it. Must run before we touch the DOM. */
function sourceFromViewer() {
  const pre = document.querySelector("body > pre") || document.querySelector("pre");
  return pre ? pre.textContent : document.body.textContent || "";
}

async function readSettings() {
  try {
    return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  } catch (e) {
    return DEFAULTS;
  }
}

async function main() {
  if (!wantsThreadmark()) return;
  const source = sourceFromViewer();
  const settings = await readSettings();
  const path = decodeURIComponent(location.pathname);
  const fileName = path.split("/").pop();
  if ((settings.disabled || []).includes(path)) return;

  const style = document.createElement("style");
  style.textContent = cssText;
  document.head.appendChild(style);

  const file = fileLink(path, fileName);
  const app = createApp({ path, fileName, settings, file });
  app.mount();
  app.load(source);
  await file.restore();
  await app.start();
}

main().catch((e) => {
  console.error("[threadmark] gave up:", e);
});
