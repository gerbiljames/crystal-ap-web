# crystal.ap

Pokemon Crystal Archipelago, in your browser.

A full multiworld client: upload an Archipelago YAML or a generated `.apcrystal` patch, provide your own vanilla Crystal ROM, and play. Everything except the archipelago.gg room handoff runs locally in your browser — generation via [Pyodide](https://pyodide.org), emulation via [binjgb](https://github.com/binji/binjgb).

**Live:** https://gerbiljames.github.io/crystal-ap-web/

## How it works

- **Generation and patching** run in a Web Worker via Pyodide (CPython in WASM) against the Archipelago source in `vendor/archipelago`.
- **Emulation** is binjgb compiled to WASM, driven from JS. SRAM saves and patched ROMs persist per-seed in IndexedDB.
- **The session client** (`CommonClient` + `BizHawkClient`) also runs in Pyodide, with a JS shim replacing the TCP socket to BizHawk with direct postMessage calls to the main-thread emulator.
- **archipelago.gg hosting** happens via a tiny Cloudflare Worker (`worker/`) that proxies the multidata upload. Necessary because browsers can't POST cross-origin to archipelago.gg (no CORS headers on their `/uploads` endpoint). No ROMs or YAMLs touch the Worker — only the multidata blob.

## Running locally

```bash
git clone --recurse-submodules https://github.com/gerbiljames/crystal-ap-web
cd crystal-ap-web
npm install
./pack.sh          # bundle Archipelago source into public/ap.tar
npm run dev        # http://localhost:8765
```

## Branches

- `develop` — day-to-day work (default).
- `main` — releases. Push here to trigger a GitHub Pages deploy via `.github/workflows/deploy.yml`.

## License

MIT.
