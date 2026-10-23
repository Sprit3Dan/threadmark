#!/usr/bin/env node
// Bundle the extension into dist/ (or dist-dev/ with --dev, which additionally
// matches http://127.0.0.1 so the automated test bed can run without the
// "Allow access to file URLs" toggle).

import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const dev = process.argv.includes("--dev");
const SRC = path.join(import.meta.dirname, "src");
const OUT = path.join(import.meta.dirname, dev ? "dist-dev" : "dist");

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const shared = {
  bundle: true,
  format: "iife",
  target: "chrome120",
  legalComments: "none",
  logLevel: "warning",
  define: { __TM_DEV__: String(dev) },
  // CSS is inlined as a string and injected with the view, so the page needs no
  // web_accessible_resources.
  loader: { ".css": "text" },
};

await esbuild.build({
  ...shared,
  entryPoints: [path.join(SRC, "content.js")],
  outfile: path.join(OUT, "content.js"),
  minify: !dev,
});

for (const page of ["popup", "options", "sample"]) {
  await esbuild.build({
    ...shared,
    entryPoints: [path.join(SRC, `${page}.js`)],
    outfile: path.join(OUT, `${page}.js`),
    minify: !dev,
  });
}

for (const asset of ["popup.html", "options.html", "sample.html", "sample.md"]) {
  fs.copyFileSync(path.join(SRC, asset), path.join(OUT, asset));
}

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
if (dev) {
  for (const entry of manifest.content_scripts) {
    entry.matches = [...entry.matches, "http://127.0.0.1/*", "http://localhost/*"];
  }
}
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const bytes = fs.readdirSync(OUT).reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`${dev ? "dist-dev" : "dist"}: ${fs.readdirSync(OUT).length} files, ${(bytes / 1024).toFixed(0)} KB`);
