import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// BASE_PATH lets CI set the subpath for GitHub Pages project deploys
// (e.g. "/crystal-ap-web/"). Local dev + user-page deploys stay at "/".
const base = process.env.BASE_PATH || "/";

export default defineConfig({
  base,
  plugins: [solid()],
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
