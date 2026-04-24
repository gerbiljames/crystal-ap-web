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
