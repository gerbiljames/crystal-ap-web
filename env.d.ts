/// <reference types="vite/client" />

// Per-build id stamped in by vite.config.js (define).
declare const __BUILD_ID__: string;
// Content hash per bundle tar, keyed by path under public/ap/ (vite.config.js).
declare const __AP_TAR_HASHES__: Record<string, string>;

// binjgb.js ships as a classic script and exposes a global Binjgb() factory.
declare const Binjgb: () => Promise<any>;

// Debug handle stashed on window.ap after the emulator boots.
interface Window {
  ap?: any;
  __updateEmuMaxH?: () => void;
}
