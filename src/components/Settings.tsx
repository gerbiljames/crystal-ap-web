import { For, Show, createSignal, createEffect, onCleanup } from "solid-js";
import { settingsOpen, setSettingsOpen, overlayPrefs, setOverlayPrefs } from "../state.js";
import {
  DEFAULT_BINDINGS, loadBindings, saveBindings, captureNextButton, getActivePad,
  type InputName,
} from "../lib/controller.js";

const INPUT_ROWS: { name: InputName; label: string }[] = [
  { name: "A",      label: "A" },
  { name: "B",      label: "B" },
  { name: "start",  label: "start" },
  { name: "select", label: "select" },
  { name: "up",     label: "up" },
  { name: "down",   label: "down" },
  { name: "left",   label: "left" },
  { name: "right",  label: "right" },
];

type Tab = "controller" | "overlay";

export function Settings() {
  const [tab, setTab] = createSignal<Tab>("controller");

  const onBackdrop = (ev: MouseEvent) => {
    if (ev.target === ev.currentTarget) setSettingsOpen(false);
  };

  // Esc closes the modal while open.
  createEffect(() => {
    if (!settingsOpen()) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") setSettingsOpen(false); };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <Show when={settingsOpen()}>
      <div class="modal-backdrop" onClick={onBackdrop}>
        <div class="modal" role="dialog" aria-modal="true" aria-label="settings">
          <div class="modal-head">
            <div class="modal-tabs" role="tablist">
              <button
                class="modal-tab"
                role="tab"
                aria-selected={tab() === "controller"}
                data-active={tab() === "controller"}
                onClick={() => setTab("controller")}
              >controller</button>
              <button
                class="modal-tab"
                role="tab"
                aria-selected={tab() === "overlay"}
                data-active={tab() === "overlay"}
                onClick={() => setTab("overlay")}
              >overlay</button>
            </div>
            <button class="modal-close" onClick={() => setSettingsOpen(false)} aria-label="close">✕</button>
          </div>
          <div class="modal-body">
            <Show when={tab() === "controller"}>
              <ControllerPanel />
            </Show>
            <Show when={tab() === "overlay"}>
              <OverlayPanel />
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}

function ControllerPanel() {
  const [bindings, setBindings] = createSignal({ ...loadBindings() });
  const [capturing, setCapturing] = createSignal<InputName | null>(null);
  const [padInfo, setPadInfo] = createSignal<{ id: string; mapping: string } | null>(null);

  // Cheap periodic poll to surface pad identity + live button feedback
  // (so users can see which index lights up when they press a button).
  const [pressed, setPressed] = createSignal<Set<number>>(new Set());
  createEffect(() => {
    let rafId: number | null = null;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const pad = getActivePad();
      if (!pad) { setPadInfo(null); setPressed(new Set<number>()); return; }
      setPadInfo({ id: pad.id, mapping: pad.mapping || "non-standard" });
      const s = new Set<number>();
      for (let i = 0; i < pad.buttons.length; i++) if (pad.buttons[i]?.pressed) s.add(i);
      setPressed(s);
    };
    rafId = requestAnimationFrame(tick);
    onCleanup(() => { if (rafId != null) cancelAnimationFrame(rafId); });
  });

  let cancelCapture: (() => void) | null = null;
  const stopCapture = () => {
    if (cancelCapture) { cancelCapture(); cancelCapture = null; }
    setCapturing(null);
  };

  const beginRebind = (name: InputName) => {
    stopCapture();
    setCapturing(name);
    cancelCapture = captureNextButton((index) => {
      const next = { ...bindings(), [name]: index };
      setBindings(next);
      saveBindings(next);
      setCapturing(null);
      cancelCapture = null;
    });
  };

  const resetDefaults = () => {
    stopCapture();
    const next = { ...DEFAULT_BINDINGS };
    setBindings(next);
    saveBindings(next);
  };

  onCleanup(stopCapture);

  return (
    <div class="ctrl-panel">
      <div class="ctrl-pad-info">
        <Show when={padInfo()} fallback={<span class="muted">no controller connected — press a button on your pad</span>}>
          {(info) => (
            <>
              <div><span class="ctrl-k">device</span> <span class="ctrl-v">{info().id}</span></div>
              <div><span class="ctrl-k">mapping</span> <span class="ctrl-v">{info().mapping}</span></div>
            </>
          )}
        </Show>
      </div>

      <div class="ctrl-rows">
        <For each={INPUT_ROWS}>{(row) => {
          const idx = () => bindings()[row.name];
          const isCapturing = () => capturing() === row.name;
          const isPressed = () => pressed().has(idx());
          return (
            <div class="ctrl-row" data-capturing={isCapturing()}>
              <span class="ctrl-label">{row.label}</span>
              <span class="ctrl-binding" data-pressed={isPressed()}>
                {isCapturing() ? "press any button…" : `button ${idx()}`}
              </span>
              <button
                class="ctrl-rebind"
                onClick={() => (isCapturing() ? stopCapture() : beginRebind(row.name))}
              >{isCapturing() ? "cancel" : "rebind"}</button>
            </div>
          );
        }}</For>
      </div>

      <div class="ctrl-actions">
        <button class="btn-ghost" onClick={resetDefaults}>reset defaults</button>
      </div>

      <p class="ctrl-tip">
        Tip: the highlighted index next to each row lights up when that button is pressed.
        Useful for figuring out which physical button is which if your pad reports a non-standard mapping.
      </p>
    </div>
  );
}

function OverlayPanel() {
  const prefs = overlayPrefs;

  const onPersistChange = (ev: Event) => {
    const v = Number((ev.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(v) || v < 0) return;
    setOverlayPrefs({ ...prefs(), persistSec: Math.floor(v) });
  };
  const onMaxChange = (ev: Event) => {
    const v = Number((ev.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(v) || v < 1) return;
    setOverlayPrefs({ ...prefs(), maxEntries: Math.min(50, Math.floor(v)) });
  };

  return (
    <div class="overlay-panel">
      <p class="panel-intro">
        The console overlay appears in the top-left while the emulator is fullscreen.
      </p>

      <div class="pref-row">
        <label class="pref-label" for="ov-persist">
          <span>persist duration</span>
          <span class="pref-sub">seconds an entry stays visible — <strong>0</strong> keeps them forever</span>
        </label>
        <input
          id="ov-persist"
          class="pref-input"
          type="number"
          min="0"
          step="1"
          value={prefs().persistSec}
          onInput={onPersistChange}
        />
      </div>

      <div class="pref-row">
        <label class="pref-label" for="ov-max">
          <span>max entries</span>
          <span class="pref-sub">how many lines to show at once (1–50)</span>
        </label>
        <input
          id="ov-max"
          class="pref-input"
          type="number"
          min="1"
          max="50"
          step="1"
          value={prefs().maxEntries}
          onInput={onMaxChange}
        />
      </div>
    </div>
  );
}
