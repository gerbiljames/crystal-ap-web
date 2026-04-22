/// <reference types="vite/client" />

// binjgb.js ships as a classic script and exposes a global Binjgb() factory.
declare const Binjgb: () => Promise<any>;

// Debug handle stashed on window.ap after the emulator boots.
interface Window {
  ap?: any;
  __updateEmuMaxH?: () => void;
}
