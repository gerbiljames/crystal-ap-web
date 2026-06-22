import { For, Show, createSignal, createEffect, onCleanup } from "solid-js";
import { settingsOpen, setSettingsOpen, overlayPrefs, setOverlayPrefs, controllerPrefs, setControllerPrefs, audioPrefs, setAudioPrefs, uiPrefs, setUiPrefs, romOverridePrefs, setRomOverridePrefs } from "../state.js";
import { TOP_LEVEL_FIELDS, GAME_OPTION_FIELDS, type OverrideField } from "../lib/overrides.js";
import {
  DEFAULT_BINDINGS, loadBindings, saveBindings, captureNextButton, getActivePad,
  type InputName,
} from "../lib/controller.js";
import {
  DEFAULT_KEY_BINDINGS, loadKeyBindings, saveKeyBindings, captureNextKey,
} from "../lib/keyboard.js";

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

type Tab = "controller" | "keyboard" | "audio" | "overlay" | "ui" | "overrides";

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
                aria-selected={tab() === "keyboard"}
                data-active={tab() === "keyboard"}
                onClick={() => setTab("keyboard")}
              >keyboard</button>
              <button
                class="modal-tab"
                role="tab"
                aria-selected={tab() === "audio"}
                data-active={tab() === "audio"}
                onClick={() => setTab("audio")}
              >audio</button>
              <button
                class="modal-tab"
                role="tab"
                aria-selected={tab() === "overlay"}
                data-active={tab() === "overlay"}
                onClick={() => setTab("overlay")}
              >overlay</button>
              <button
                class="modal-tab"
                role="tab"
                aria-selected={tab() === "ui"}
                data-active={tab() === "ui"}
                onClick={() => setTab("ui")}
              >ui</button>
              <button
                class="modal-tab"
                role="tab"
                aria-selected={tab() === "overrides"}
                data-active={tab() === "overrides"}
                onClick={() => setTab("overrides")}
              >overrides</button>
            </div>
            <button class="modal-close" onClick={() => setSettingsOpen(false)} aria-label="close">✕</button>
          </div>
          <div class="modal-body">
            <Show when={tab() === "controller"}>
              <ControllerPanel />
            </Show>
            <Show when={tab() === "keyboard"}>
              <KeyboardPanel />
            </Show>
            <Show when={tab() === "audio"}>
              <AudioPanel />
            </Show>
            <Show when={tab() === "overlay"}>
              <OverlayPanel />
            </Show>
            <Show when={tab() === "ui"}>
              <UiPanel />
            </Show>
            <Show when={tab() === "overrides"}>
              <OverridesPanel />
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
      const next = { ...bindings() };
      // Kick any other input currently using this button so a single press
      // never fires two joypad inputs at once.
      for (const k of Object.keys(next) as InputName[]) {
        if (k !== name && next[k] === index) next[k] = -1;
      }
      next[name] = index;
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
          const isPressed = () => idx() >= 0 && pressed().has(idx());
          return (
            <div class="ctrl-row" data-capturing={isCapturing()}>
              <span class="ctrl-label">{row.label}</span>
              <span class="ctrl-binding" data-pressed={isPressed()}>
                {isCapturing() ? "press any button…" : (idx() >= 0 ? `button ${idx()}` : "unbound")}
              </span>
              <button
                class="ctrl-rebind"
                onClick={() => (isCapturing() ? stopCapture() : beginRebind(row.name))}
              >{isCapturing() ? "cancel" : "rebind"}</button>
            </div>
          );
        }}</For>
      </div>

      <label class="switch ctrl-bg-switch" title="When on, gamepad input is processed even while the browser tab/window doesn't have keyboard focus.">
        <input
          type="checkbox"
          checked={controllerPrefs().background}
          onChange={(ev) => setControllerPrefs({ background: ev.currentTarget.checked })}
        />
        <span class="switch-track"><span class="switch-knob"></span></span>
        <span class="switch-text">accept input while unfocused</span>
      </label>

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

function formatKeyCode(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code === "ArrowUp") return "↑";
  if (code === "ArrowDown") return "↓";
  if (code === "ArrowLeft") return "←";
  if (code === "ArrowRight") return "→";
  return code;
}

function KeyboardPanel() {
  const [bindings, setBindings] = createSignal({ ...loadKeyBindings() });
  const [capturing, setCapturing] = createSignal<InputName | null>(null);

  let cancelCapture: (() => void) | null = null;
  const stopCapture = () => {
    if (cancelCapture) { cancelCapture(); cancelCapture = null; }
    setCapturing(null);
  };

  const beginRebind = (name: InputName) => {
    stopCapture();
    setCapturing(name);
    cancelCapture = captureNextKey((code) => {
      const next = { ...bindings() };
      // Kick any other input currently using this key off it so a single
      // key never fires two joypad inputs at once.
      for (const k of Object.keys(next) as InputName[]) {
        if (k !== name && next[k] === code) next[k] = "";
      }
      next[name] = code;
      setBindings(next);
      saveKeyBindings(next);
      setCapturing(null);
      cancelCapture = null;
    });
  };

  const resetDefaults = () => {
    stopCapture();
    const next = { ...DEFAULT_KEY_BINDINGS };
    setBindings(next);
    saveKeyBindings(next);
  };

  onCleanup(stopCapture);

  return (
    <div class="ctrl-panel">
      <div class="ctrl-rows">
        <For each={INPUT_ROWS}>{(row) => {
          const isCapturing = () => capturing() === row.name;
          return (
            <div class="ctrl-row" data-capturing={isCapturing()}>
              <span class="ctrl-label">{row.label}</span>
              <span class="ctrl-binding">
                {isCapturing() ? "press any key…" : (bindings()[row.name] ? formatKeyCode(bindings()[row.name]) : "unbound")}
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
        Esc cancels capture. Modifier-only presses (Shift/Ctrl/Alt/Meta) are ignored.
      </p>
    </div>
  );
}

function AudioPanel() {
  const onVolume = (ev: Event) => {
    const v = Number((ev.currentTarget as HTMLInputElement).value) / 100;
    setAudioPrefs({ ...audioPrefs(), volume: v });
  };
  const onBackground = (ev: Event) => {
    setAudioPrefs({ ...audioPrefs(), background: (ev.currentTarget as HTMLInputElement).checked });
  };
  return (
    <div class="audio-panel">
      <div class="pref-row">
        <label class="pref-label" for="aud-vol">
          <span>volume</span>
          <span class="pref-sub">also mirrored under the emulator</span>
        </label>
        <input
          id="aud-vol"
          class="pref-range"
          type="range"
          min="0"
          max="100"
          step="1"
          value={Math.round(audioPrefs().volume * 100)}
          onInput={onVolume}
        />
      </div>

      <label class="switch audio-bg-switch" title="When on, audio keeps playing while the browser tab/window doesn't have focus.">
        <input
          type="checkbox"
          checked={audioPrefs().background}
          onChange={onBackground}
        />
        <span class="switch-track"><span class="switch-knob"></span></span>
        <span class="switch-text">play audio while unfocused</span>
      </label>
    </div>
  );
}

function UiPanel() {
  return (
    <div class="ui-panel">
      <label class="switch" title="When on, the touch gamepad under the emulator is never shown, even on touch devices.">
        <input
          type="checkbox"
          checked={uiPrefs().hideGamepad}
          onChange={(ev) => setUiPrefs({ ...uiPrefs(), hideGamepad: ev.currentTarget.checked })}
        />
        <span class="switch-track"><span class="switch-knob"></span></span>
        <span class="switch-text">never show on-screen controls</span>
      </label>
    </div>
  );
}

function OverrideField(props: { field: OverrideField; prefKey: string }) {
  const f = props.field;
  const value = () => romOverridePrefs()[props.prefKey] ?? "";

  const set = (v: string) => {
    const next = { ...romOverridePrefs() };
    if (v === "") delete next[props.prefKey];
    else next[props.prefKey] = v;
    setRomOverridePrefs(next);
  };

  const onNumber = (ev: Event) => {
    const el = ev.currentTarget as HTMLInputElement;
    if (el.value === "") return set("");
    let n = Math.floor(Number(el.value));
    if (!Number.isFinite(n)) return;
    if (f.min != null) n = Math.max(f.min, n);
    if (f.max != null) n = Math.min(f.max, n);
    set(String(n));
  };

  return (
    <div class="pref-row">
      <label class="pref-label" for={`ov-${props.prefKey}`}>
        <span>{f.label}</span>
        <Show when={f.help}><span class="pref-sub">{f.help}</span></Show>
      </label>
      <Show when={f.kind === "toggle" || f.kind === "choice"}>
        <select
          id={`ov-${props.prefKey}`}
          class="pref-input"
          value={value()}
          onChange={(ev) => set(ev.currentTarget.value)}
        >
          <option value="">default</option>
          <For each={f.choices}>{(c) => <option value={c}>{c}</option>}</For>
        </select>
      </Show>
      <Show when={f.kind === "number"}>
        <input
          id={`ov-${props.prefKey}`}
          class="pref-input"
          type="number"
          min={f.min}
          max={f.max}
          step="1"
          placeholder="default"
          value={value()}
          onInput={onNumber}
        />
      </Show>
      <Show when={f.kind === "text"}>
        <input
          id={`ov-${props.prefKey}`}
          class="pref-input"
          type="text"
          maxLength={f.maxLen}
          placeholder="default"
          value={value()}
          onInput={(ev) => set(ev.currentTarget.value)}
        />
      </Show>
      <Show when={f.kind === "list"}>
        <input
          id={`ov-${props.prefKey}`}
          class="pref-input"
          type="text"
          placeholder={f.validKeys ? f.validKeys.join(", ") : "comma-separated"}
          value={value()}
          onInput={(ev) => set(ev.currentTarget.value)}
        />
      </Show>
    </div>
  );
}

function OverridesPanel() {
  const setCount = () => Object.keys(romOverridePrefs()).length;
  return (
    <div class="overlay-panel">
      <p class="panel-intro">
        Patch-time tweaks applied to <strong>your</strong> ROM only. They don't affect
        the seed, logic, or other players. Left at <strong>default</strong>, each option
        keeps whatever the seed rolled. Changes apply the next time a ROM is patched;
        resuming a seed re-patches automatically when these change.
      </p>

      <h3 class="ov-group-head">General</h3>
      <For each={TOP_LEVEL_FIELDS}>{(f) => <OverrideField field={f} prefKey={f.key} />}</For>

      <h3 class="ov-group-head">In-game options</h3>
      <For each={GAME_OPTION_FIELDS}>{(f) => <OverrideField field={f} prefKey={`go:${f.key}`} />}</For>

      <div class="ctrl-actions">
        <button class="btn-ghost" disabled={setCount() === 0} onClick={() => setRomOverridePrefs({})}>
          reset all{setCount() > 0 ? ` (${setCount()})` : ""}
        </button>
      </div>
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
