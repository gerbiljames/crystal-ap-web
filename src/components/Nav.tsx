import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { app, setSettingsOpen, setConnectOpen, isMobile } from "../state.js";
import { teardownAndReload } from "../actions.js";
// Bundled at build time from the pokecrystal apworld submodule — same
// source pack.sh tars into public/ap.tar, so versions stay in sync.
import crystalManifest    from "../../vendor/archipelago/worlds/pokemon_crystal/archipelago.json";
import prereleaseManifest from "../../vendor/archipelago-prerelease/worlds/pokemon_crystal_prerelease/archipelago.json";
import trackerInitSource  from "../../vendor/archipelago-tracker/worlds/tracker/__init__.py?raw";

// UT publishes its version as `UT_VERSION = "v0.2.30"` in worlds/tracker/__init__.py.
// Pull it out at build time so the chip stays in sync with the bundled apworld.
const utVersion = (() => {
  const m = trackerInitSource.match(/UT_VERSION\s*=\s*["']([^"']+)["']/);
  return m ? m[1] : "unknown";
})();

export function Nav() {
  const [menuOpen, setMenuOpen] = createSignal(false);
  let menuRef: HTMLDivElement | undefined;

  onMount(() => {
    const onDocClick = (ev: MouseEvent) => {
      if (!menuOpen() || !menuRef) return;
      if (menuRef.contains(ev.target as Node)) return;
      setMenuOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("click", onDocClick);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("click", onDocClick);
      window.removeEventListener("keydown", onKey);
    });
  });

  const closeMenu = () => setMenuOpen(false);
  const licensesHref = `${import.meta.env.BASE_URL}THIRD_PARTY_LICENSES.txt`;

  return (
    <header class="nav">
      <a class="gh-link" href="https://github.com/gerbiljames/crystal-ap-web" target="_blank" rel="noopener" aria-label="source on github" title="source on github">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
      </a>
      <a class="brand" id="brand-home" href="#" onClick={teardownAndReload}>
        <span>crystal<span style="color:var(--jade-bright)">.</span>ap</span>
      </a>
      <span class="world-version" title={`bundled Pokémon Crystal apworld versions\nstable v${crystalManifest.world_version}\nprerelease v${prereleaseManifest.pokemon_crystal_version}\nuniversal tracker ${utVersion}`}>v{crystalManifest.world_version}</span>
      <div class="nav-spacer"></div>
      <button class="cog-btn" onClick={() => setSettingsOpen(true)} aria-label="settings" title="settings">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M19.14 12.94a7.49 7.49 0 0 0 .05-.94 7.49 7.49 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.03 7.03 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.49 7.49 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.38 1.05.7 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.24 1.13-.56 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.04-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/>
        </svg>
      </button>
      <a class="license-link" href={licensesHref} target="_blank" rel="noopener" aria-label="third-party licenses" title="third-party licenses">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M7 3h7l4 4v14H7z"/>
          <path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M14 3v4h4"/>
          <path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M9.5 12h5M9.5 15h5M9.5 18h3"/>
        </svg>
      </a>
      <div class="nav-menu" ref={menuRef!}>
        <button
          class="nav-menu-trigger"
          aria-label="menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen()}
          onClick={() => setMenuOpen(o => !o)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="5"  r="2" fill="currentColor"/>
            <circle cx="12" cy="12" r="2" fill="currentColor"/>
            <circle cx="12" cy="19" r="2" fill="currentColor"/>
          </svg>
        </button>
        <Show when={menuOpen()}>
          <div class="nav-menu-panel" role="menu">
            <a href="https://github.com/gerbiljames/crystal-ap-web" target="_blank" rel="noopener" role="menuitem" onClick={closeMenu}>source on github</a>
            <button role="menuitem" onClick={() => { closeMenu(); setSettingsOpen(true); }}>settings</button>
            <a href={licensesHref} target="_blank" rel="noopener" role="menuitem" onClick={closeMenu}>third-party licenses</a>
          </div>
        </Show>
      </div>
      <button
        type="button"
        class="session-chip"
        id="session-chip"
        data-state={app.session.state}
        data-tappable={isMobile() && app.step === "play" ? "true" : undefined}
        aria-label={isMobile() && app.step === "play" ? "connection details" : undefined}
        onClick={() => { if (isMobile() && app.step === "play") setConnectOpen(o => !o); }}
      >
        <span class="dot"></span><span class="label">{app.session.label}</span>
      </button>
    </header>
  );
}
