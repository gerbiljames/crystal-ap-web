import { onMount, Show } from "solid-js";
import { app, pageNotice } from "./state.js";
import { startApp } from "./actions.js";
import { Nav } from "./components/Nav.jsx";
import { Home } from "./components/Home.jsx";
import { PlayStep } from "./components/Play.jsx";
import { Settings } from "./components/Settings.jsx";
import { Admin } from "./components/Admin.jsx";
// Side-effect import: installs one-shot gesture listeners on document so
// the AudioContext is primed by the time the emulator boots (avoids a
// silent window before the user's first in-emulator input).
import "./lib/audio.js";

export function App() {
  onMount(() => {
    // Ask the browser to make our IndexedDB storage persistent, so a reload
    // mid-turn still finds the session's save.
    navigator.storage?.persist?.().catch(() => {});
    void startApp();
  });
  return (
    <div class="app" data-step={app.step} data-session={app.session.state}>
      <Nav />
      <Show when={pageNotice()}>
        <div class="error-box" id="page-notice" role="alert">
          <span class="err-title">reload needed</span>
          <span>{pageNotice()} <button class="btn-primary" onClick={() => location.reload()}>reload</button></span>
        </div>
      </Show>
      <main>
        <Home />
        <PlayStep />
      </main>
      <Settings />
      <Admin />
    </div>
  );
}
