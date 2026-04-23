import { onMount, onCleanup } from "solid-js";
import { app } from "./state.js";
import { teardownAndReload } from "./actions.js";
import { Nav } from "./components/Nav.jsx";
import { Home } from "./components/Home.jsx";
import { PlayStep } from "./components/Play.jsx";
import { Settings } from "./components/Settings.jsx";
// Side-effect import: installs one-shot gesture listeners on document so
// the AudioContext is primed by the time the emulator boots (avoids a
// silent window before the user's first in-emulator input).
import "./lib/audio.js";

export function App() {
  onMount(() => {
    // Browser back while in-app: same teardown as clicking the brand.
    const onPop = () => teardownAndReload();
    window.addEventListener("popstate", onPop);
    onCleanup(() => window.removeEventListener("popstate", onPop));

    // Warn before closing/reloading while the emulator is live. Browsers
    // ignore custom copy here (they show a generic "Leave site?" prompt),
    // but setting returnValue is still what triggers the dialog.
    const onBeforeUnload = (ev: BeforeUnloadEvent) => {
      if (app.step !== "play") return;
      ev.preventDefault();
      ev.returnValue = "Make sure you've saved in-game before leaving.";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    onCleanup(() => window.removeEventListener("beforeunload", onBeforeUnload));
  });
  return (
    <div class="app" data-step={app.step} data-session={app.session.state}>
      <Nav />
      <main>
        <Home />
        <PlayStep />
      </main>
      <Settings />
    </div>
  );
}
