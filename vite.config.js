import { defineConfig } from "vite";

// BASE_PATH lets CI set the subpath for GitHub Pages project deploys
// (e.g. "/crystal-ap-web/"). Local dev + user-page deploys stay at "/".
const base = process.env.BASE_PATH || "/";

export default defineConfig({
  base,
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
