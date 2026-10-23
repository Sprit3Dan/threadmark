// Shared spike probe. Duplicated into main.js / iso.js by build-spike.mjs.
(() => {
  const WORLD = "ISO";
  const out = {
    world: WORLD,
    injected: true,
    contentType: document.contentType,
    title: document.title,
    textChars: (document.body && document.body.innerText) || "".length,
    isSecureContext: window.isSecureContext,
    showOpenFilePicker: typeof window.showOpenFilePicker,
    showSaveFilePicker: typeof window.showSaveFilePicker,
    chromeRuntimeId: typeof chrome !== "undefined" && chrome.runtime ? String(chrome.runtime.id) : "none",
  };
  out.textChars = typeof out.textChars === "string" ? out.textChars.length : out.textChars;

  try {
    localStorage.getItem("tm-probe");
    out.localStorage = "ok";
  } catch (e) {
    out.localStorage = e.name + ": " + e.message;
  }

  let flushed = false;
  const flush = () => {
    if (flushed) return;
    flushed = true;
    document.documentElement.setAttribute("data-spike-" + WORLD, JSON.stringify(out));
    if (WORLD === "MAIN") document.title = "spike-done";
  };

  try {
    const req = indexedDB.open("tm-probe", 1);
    req.onsuccess = () => {
      out.indexedDB = "ok";
      try { req.result.close(); } catch (e) {}
      flush();
    };
    req.onerror = () => {
      out.indexedDB = "error: " + (req.error ? req.error.name : "unknown");
      flush();
    };
    req.onblocked = () => {
      out.indexedDB = "blocked";
      flush();
    };
  } catch (e) {
    out.indexedDB = "throw: " + e.name;
    flush();
  }

  setTimeout(() => {
    if (!out.indexedDB) out.indexedDB = "no-callback";
    flush();
  }, 2000);
})();
