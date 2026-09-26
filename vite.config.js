import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// BASE_PATH lets CI set the subpath for GitHub Pages project deploys
// (e.g. "/crystal-ap-web/"). Local dev + user-page deploys stay at "/".
const base = process.env.BASE_PATH || "/";

const buildId = Date.now().toString(36);
// Paths below are relative to this file, not to wherever vite was run from.
const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// Content hash of every bundle tar under public/ap/ (built by pack.sh, which
// runs first), keyed by its path relative to that dir. The worker fetches each
// tar with its hash as a query string, so a browser or CDN copy of a tar whose
// content changed under the same name (core.tar, a world re-packed at the same
// world_version) is never mixed into a new runtime, while an unchanged tar
// stays cached across deploys.
function tarHashes() {
  const root = here("public/ap");
  const out = {};
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".tar"))
        out[relative(root, p).split("\\").join("/")] = createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

// public/ is copied unhashed, and GitHub Pages serves only the current deploy
// whatever the query string, so a tab opened before a deploy would spawn the
// new ap_worker.js against its old bundle. Emit the worker a second time under
// a per-build name and have the bundle spawn that: an old tab then gets a 404
// it can recognise (see ap-worker.ts) instead of a mismatched worker. It sits
// at the root beside ap_worker.js so its relative ap/ fetches still resolve.
function pinnedWorker() {
  return {
    name: "pinned-ap-worker",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: `ap_worker.${buildId}.js`, source: readFileSync(here("public/ap_worker.js")) });
    },
  };
}

export default defineConfig({
  base,
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
    __AP_TAR_HASHES__: JSON.stringify(tarHashes()),
  },
  plugins: [solid(), pinnedWorker()],
  // esbuild defaults to the React factory for .tsx in dev, clobbering
  // vite-plugin-solid's JSX transform before it can run. `preserve` leaves
  // JSX alone so the Solid babel pass owns the transform.
  esbuild: { jsx: "preserve" },
  server: {
    host: "127.0.0.1",
    port: 8765,
  },
  build: {
    target: "es2022",
    // Pyodide + binjgb + AP source tarball all live in public/ and are
    // fetched at runtime — don't let Vite try to inline or analyse them.
    assetsInlineLimit: 0,
  },
});
