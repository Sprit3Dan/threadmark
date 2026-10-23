// Talking to the file. A File System Access handle is the only way in: a file://
// page cannot fetch its own siblings, and the DOM copy of the text is not
// something we should ever write back.
//
// Handles are remembered in IndexedDB, which every file:// page shares. Two kinds:
//
//   "/Users/dan/notes/plan.md"   a file handle, for one file
//   "root:/Users/dan/dev"         a folder handle; every file under it connects
//                                 without a picker
//
// Chrome keeps a granted permission for the session; picking "Allow on every
// visit" when it asks again after a restart keeps it for good.

const DB_NAME = "threadmark-handles"; // kv.js owns "threadmark"; one store per database
const STORE = "handles";
const ROOT = "root:";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null);
}

async function withStore(mode, fn) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
  }).catch(() => null);
}

export const handleStore = {
  get: (key) => withStore("readonly", (s) => s.get(key)),
  put: (key, handle) => withStore("readwrite", (s) => s.put(handle, key)),
  drop: (key) => withStore("readwrite", (s) => s.delete(key)),
  keys: async () => (await withStore("readonly", (s) => s.getAllKeys())) || [],
};

const dirOf = (p) => p.slice(0, p.lastIndexOf("/"));

/** Walk from a folder handle down a relative path to a file handle. */
async function resolveIn(dir, segments) {
  let at = dir;
  for (const name of segments.slice(0, -1)) at = await at.getDirectoryHandle(name);
  return at.getFileHandle(segments[segments.length - 1]);
}

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * The tab's link to its file on disk. States: `none` (nothing known — the reader
 * has to choose a folder or the file), `prompt` (a handle from earlier, waiting
 * for one permission click) and `granted`. Everything that asks Chrome for
 * something must be called from a click or key press.
 */
export function fileLink(path, fileName, pickers = window) {
  let handle = null; // the file
  let root = null; // { path, handle } of a remembered folder above it, if any
  let granted = false;

  async function useRoot() {
    handle = await resolveIn(root.handle, path.slice(root.path.length + 1).split("/"));
    granted = true;
  }

  /** Where a picker should open: next to the closest file or folder we know. */
  async function startIn() {
    let best = null;
    let score = -1;
    for (const key of await handleStore.keys()) {
      const p = key.startsWith(ROOT) ? key.slice(ROOT.length) : dirOf(key);
      let n = 0;
      while (n < p.length && n < path.length && p[n] === path[n]) n++;
      if (n > score) {
        best = key;
        score = n;
      }
    }
    if (best && score > 1) {
      const h = await handleStore.get(best);
      if (h) return h;
    }
    if (path.includes("/Downloads/")) return "downloads";
    if (path.includes("/Desktop/")) return "desktop";
    if (path.includes("/Documents/")) return "documents";
    return undefined;
  }

  return {
    get state() {
      return granted ? "granted" : handle || root ? "prompt" : "none";
    },
    get via() {
      return root ? root.path : null;
    },

    /** Find a remembered folder or file for this path. No prompts. */
    async restore() {
      if (granted) return;
      const keys = await handleStore.keys();
      const roots = keys
        .filter((k) => k.startsWith(ROOT) && path.startsWith(k.slice(ROOT.length) + "/"))
        .sort((a, b) => b.length - a.length);
      for (const key of roots) {
        const dir = await handleStore.get(key);
        if (!dir) continue;
        root = { path: key.slice(ROOT.length), handle: dir };
        try {
          if ((await dir.queryPermission({ mode: "readwrite" })) === "granted") await useRoot();
          return;
        } catch (e) {
          root = null; // the file isn't there any more, or the folder moved
        }
      }
      const stored = await handleStore.get(path);
      if (!stored) return;
      handle = stored;
      try {
        granted = (await handle.queryPermission({ mode: "readwrite" })) === "granted";
      } catch (e) {
        handle = null;
      }
    },

    /** From `prompt`: one permission click. From `none`: throws code "choose". */
    async ensure() {
      if (granted) return;
      const target = root ? root.handle : handle;
      if (!target) throw err("Choose a folder or the file to save into.", "choose");
      let answer;
      try {
        answer = await target.requestPermission({ mode: "readwrite" });
      } catch (e) {
        throw err("One more click: Allow editing, then send again.", "activation");
      }
      if (answer !== "granted") throw err("Chrome didn't grant access to the file.", "denied");
      if (root) await useRoot();
      else granted = true;
    },

    /**
     * Pick a folder that contains this file. Every file under it connects by
     * itself from now on. The folder's path isn't exposed by Chrome, so it is
     * worked out by finding this tab's file inside it.
     */
    async connectFolder() {
      const dir = await pickers.showDirectoryPicker({ id: "threadmark-folder", mode: "readwrite", startIn: await startIn() });
      const segments = path.split("/").filter(Boolean);
      for (let k = segments.length - 2; k >= 0; k--) {
        if (segments[k] !== dir.name) continue;
        try {
          handle = await resolveIn(dir, segments.slice(k + 1));
        } catch (e) {
          continue;
        }
        root = { path: "/" + segments.slice(0, k + 1).join("/"), handle: dir };
        await handleStore.put(ROOT + root.path, dir);
        granted = (await dir.queryPermission({ mode: "readwrite" })) === "granted";
        if (!granted) await this.ensure();
        return root.path;
      }
      throw err(`${fileName} isn't inside “${dir.name}”. Pick a folder that contains it.`, "mismatch");
    },

    /** Pick just this file. */
    async connectFile() {
      const [picked] = await pickers.showOpenFilePicker({
        id: "threadmark",
        startIn: await startIn(),
        multiple: false,
        types: [{ description: "Markdown", accept: { "text/markdown": [".md", ".markdown", ".mdown", ".txt"] } }],
      });
      if (picked.name !== fileName) {
        throw err(`You picked ${picked.name}, but this tab is ${fileName}. Nothing was written.`, "mismatch");
      }
      handle = picked;
      root = null;
      await handleStore.put(path, handle);
      await this.ensure();
    },

    read: () => readHandle(handle),
    write: (text) => writeHandle(handle, text),
    stat: () => statHandle(handle),
  };
}

export async function readHandle(handle) {
  const file = await handle.getFile();
  return { text: await file.text(), lastModified: file.lastModified, size: file.size, name: file.name };
}

export async function statHandle(handle) {
  const file = await handle.getFile();
  return { lastModified: file.lastModified, size: file.size };
}

export async function writeHandle(handle, text) {
  const w = await handle.createWritable({ keepExistingData: false });
  await w.write(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  await w.close();
  return statHandle(handle);
}
