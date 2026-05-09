import { For, Show, createSignal, createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { app, setApp, persistHostPref } from "../state.js";
import { formatAge } from "../lib/sessions.js";
import { isPatchName } from "../lib/zip.js";
import { db, idbGet } from "../lib/idb.js";
import { GB_ROM_SIZE, VANILLA_STORE } from "../lib/constants.js";
import {
  handleYamlDrop, handleRomDrop, continueToRom, resumeSession, forgetSession, resetTransient,
  useSavedYaml, renameSavedYaml, forgetSavedYaml, fetchSavedYamlText,
} from "../actions.js";
import type { SavedYaml } from "../lib/yamls.js";
import Prism from "prismjs";
import "prismjs/components/prism-yaml";
import { Dropzone } from "./Dropzone.jsx";

function Blurb() {
  return (
    <aside class="blurb">
      <h1><span class="blurb-title">Pokémon Crystal Archipelago</span><br /><em>in your browser.</em></h1>
      <p>A full multiworld client for <a href="https://github.com/gerbiljames/Archipelago-Crystal/tree/pokecrystal" target="_blank" rel="noopener">Pokémon Crystal</a>. You provide a YAML and your own vanilla Crystal ROM; generation and patching happen locally.</p>
      <ul class="blurb-list">
        <li>Generation and ROM patching run in your browser via <a href="https://pyodide.org" target="_blank" rel="noopener">Pyodide</a>.</li>
        <li>Your ROM never leaves this browser. It's stored locally so you don't need to re-provide it.</li>
        <li>Emulation by <a href="https://github.com/binji/binjgb" target="_blank" rel="noopener">binjgb</a>. Saves persist per seed.</li>
        <li>The multiworld can be hosted on <a href="https://archipelago.gg" target="_blank" rel="noopener">archipelago.gg</a> via a tiny proxy.</li>
      </ul>
    </aside>
  );
}

function ResumeList() {
  return (
    <Show when={app.sessions.length > 0}>
      <div class="resume-list" id="resume-list">
        <div class="resume-head">
          <span class="eyebrow">active seeds</span>
          <span class="resume-head-hint">saved locally · ROM cached</span>
        </div>
        <div id="resume-list-inner">
          <For each={app.sessions}>{(s) => (
            <div class="resume-row">
              <span class="slot">{s.slot || "?"}</span>
              <span class="id">
                {s.id}
                <Show when={s.romCached}>
                  <span class="rom-cached" title="patched ROM cached locally">ROM</span>
                </Show>
              </span>
              <span class="meta">
                <em>{s.hosted?.kind === "loopback" ? "self-hosted" : (s.hosted?.host ? `${s.hosted.host}:${s.hosted.port}` : "no host")}</em>
                {" "}{formatAge(Date.now() - s.savedAt)}
              </span>
              <span class="actions">
                <button class="btn-primary resume" onClick={() => resumeSession(s.id)}>resume</button>
                <button class="forget" title="remove from this device" onClick={() => forgetSession(s.id)}>forget</button>
              </span>
            </div>
          )}</For>
        </div>
      </div>
    </Show>
  );
}

function SavedYamlsList() {
  const [editing, setEditing] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal("");
  const [preview, setPreview] = createSignal<{ entry: SavedYaml; text: string | null } | null>(null);

  const beginEdit = (hash: string, current: string) => {
    setEditing(hash);
    setDraft(current);
  };
  const commitEdit = (hash: string) => {
    renameSavedYaml(hash, draft());
    setEditing(null);
  };

  const openPreview = async (y: SavedYaml) => {
    // Render the modal immediately with null text (shows a loading line) so
    // the UI doesn't wait on IDB before acknowledging the click.
    setPreview({ entry: y, text: null });
    const text = await fetchSavedYamlText(y.hash);
    // Guard against the modal being closed / another row opened while the
    // fetch was in flight.
    const current = preview();
    if (current && current.entry.hash === y.hash) setPreview({ entry: y, text: text ?? "" });
  };
  const closePreview = () => setPreview(null);

  // Row-level click opens the preview, but only when the click landed on
  // "free space" — any button/input or anything inside .actions handles its
  // own behaviour and shouldn't double-fire the modal.
  const onRowClick = (y: SavedYaml) => (ev: MouseEvent) => {
    const t = ev.target as HTMLElement;
    if (t.closest("button, input, .actions")) return;
    openPreview(y);
  };

  createEffect(() => {
    if (!preview()) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") closePreview(); };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const onBackdrop = (ev: MouseEvent) => {
    if (ev.target === ev.currentTarget) closePreview();
  };

  return (
    <Show when={app.yamls.length > 0}>
      <div class="resume-list yaml-list">
        <div class="resume-head">
          <span class="eyebrow">saved yamls</span>
          <span class="resume-head-hint">
            <span class="hint-desktop">click row to preview · click name to rename</span>
            <span class="hint-touch">tap row to preview · tap name to rename</span>
          </span>
        </div>
        <div>
          <For each={app.yamls}>{(y) => (
            <div class="resume-row resume-row-clickable" onClick={onRowClick(y)} title="click to preview">
              <span class="slot">{y.slotName || "?"}</span>
              <span class="id yaml-name">
                <Show
                  when={editing() === y.hash}
                  fallback={
                    <button class="yaml-name-btn" onClick={() => beginEdit(y.hash, y.name)} title="rename">{y.name}</button>
                  }
                >
                  <input
                    class="yaml-name-input"
                    value={draft()}
                    autofocus
                    onInput={(e) => setDraft(e.currentTarget.value)}
                    onBlur={() => commitEdit(y.hash)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit(y.hash);
                      else if (e.key === "Escape") setEditing(null);
                    }}
                  />
                </Show>
              </span>
              <span class="meta">
                <em>{(y.size / 1024).toFixed(1)} KB</em>
                {" "}{formatAge(Date.now() - y.savedAt)}
              </span>
              <span class="actions">
                <button class="btn-primary resume" onClick={() => useSavedYaml(y.hash)}>use</button>
                <button class="forget" title="remove from this device" onClick={() => forgetSavedYaml(y.hash)}>forget</button>
              </span>
            </div>
          )}</For>
        </div>
        <div class="resume-foot">
          <label class="host-pref host-pref-inline" title="Where to run the MultiServer when you `use` one of these.">
            <span class="host-pref-label">hosting</span>
            <select
              class="host-pref-select"
              value={app.hostPref}
              onChange={(ev) => persistHostPref(ev.currentTarget.value as any)}
            >
              <option value="local">in this tab (no external connections)</option>
              <option value="remote">on archipelago.gg (public room)</option>
              <option value="off">off (I'll host it myself)</option>
            </select>
          </label>
        </div>
      </div>
      <Show when={preview()}>
        {(p) => (
          <Portal>
            <div class="modal-backdrop" onClick={onBackdrop}>
              <div class="modal yaml-preview-modal" role="dialog" aria-modal="true" aria-label="yaml preview">
                <div class="modal-head">
                  <span class="modal-title">{p().entry.name}</span>
                  <button class="modal-close" onClick={closePreview} aria-label="close">✕</button>
                </div>
                <div class="modal-body">
                  <pre class="yaml-preview language-yaml"><code class="language-yaml" innerHTML={
                  p().text === null
                    ? `<span class="token comment">loading…</span>`
                    : p().text === ""
                      ? `<span class="token comment">(empty)</span>`
                      : Prism.highlight(p().text!, Prism.languages.yaml, "yaml")
                }></code></pre>
                </div>
              </div>
            </div>
          </Portal>
        )}
      </Show>
    </Show>
  );
}

function OptionsPane() {
  return (
    <div class="home-pane" data-pane="options">
      <ResumeList />
      <SavedYamlsList />
      <div class="home-card">
        <div class="card-head"><span class="eyebrow">generate or import seed</span></div>
        <Dropzone id="dz-yaml" inputId="yaml-file" accept=".yaml,.yml,.apcrystal,.apcrystalpre,.zip,text/yaml" onFile={handleYamlDrop}>
          <div class="dz-mark">◇</div>
          <div class="dz-primary">Drop YAML, <b>.apcrystal</b>, or <b>output .zip</b></div>
        </Dropzone>
        <label class="host-pref" title="Where to run the MultiServer for this seed.">
          <span class="host-pref-label">hosting</span>
          <select
            class="host-pref-select"
            value={app.hostPref}
            onChange={(ev) => persistHostPref(ev.currentTarget.value as any)}
          >
            <option value="local">in this tab (no external connections)</option>
            <option value="remote">on archipelago.gg (public room)</option>
            <option value="off">off (I'll host it myself)</option>
          </select>
        </label>
        <Show when={app.yamlErr}>
          <div class="error-box" id="yaml-err">
            <span class="err-title">rejected</span>
            <span id="yaml-err-msg">{app.yamlErr}</span>
          </div>
        </Show>
      </div>
    </div>
  );
}

function ArtifactChips() {
  const artifacts = () => app.artifacts || {};
  const blobUrl = (name) => URL.createObjectURL(new Blob([artifacts()[name]], { type: "application/octet-stream" }));
  const chips = () => {
    const a = artifacts();
    const out = [];
    if (app.hosted) out.push({ href: app.hosted.room_url, title: "archipelago.gg room", kind: "external", sublabel: "host" });
    const patch = Object.keys(a).find(isPatchName);
    const spoil = Object.keys(a).find(n => n.endsWith("_Spoiler.txt"));
    const multi = Object.keys(a).find(n => n.endsWith(".archipelago"));
    if (patch) out.push({ href: blobUrl(patch), title: patch,       kind: "download", sublabel: "patch",       download: patch });
    if (spoil) out.push({ href: blobUrl(spoil), title: "spoiler",   kind: "download", sublabel: "txt",         download: spoil });
    if (multi) out.push({ href: blobUrl(multi), title: "multidata", kind: "download", sublabel: "archipelago", download: multi });
    return out;
  };
  return (
    <div class="result-grid" id="result-grid">
      <For each={chips()}>{(c) => (
        <a class="result-chip" href={c.href} target="_blank" rel="noopener" title={c.title}
           download={c.kind === "download" ? (c.download || c.title) : undefined}>
          <span class="chip-left">
            <span class="label">{c.sublabel}</span>
            <span class="title">{c.title}</span>
          </span>
          <span class="arrow">{c.kind === "download" ? "↓" : "↗"}</span>
        </a>
      )}</For>
    </div>
  );
}

function GeneratingPane() {
  // "Continue" label flips based on whether we have a cached vanilla ROM —
  // if yes, we skip straight to Play; if not, the user has to upload a ROM.
  const [continueLabel, setContinueLabel] = createSignal("Continue → ROM");
  createEffect(async () => {
    if (!app.gen.done) return;
    const dbc = await db();
    const cached = dbc ? await idbGet(dbc, "rom", VANILLA_STORE).catch(() => null) : null;
    setContinueLabel((cached && cached.byteLength === GB_ROM_SIZE) ? "Continue → Play" : "Continue → ROM");
  });
  return (
    <div class="home-pane" data-pane="generating">
      <div class="home-card">
        <div class="card-head"><span class="eyebrow">rolling seed</span></div>
        <Show when={app.gen.visible}>
          <div class="progress-bar" id="gen-progress"><div class="progress-sweep"></div></div>
        </Show>
        <dl class="seed-meta">
          <dt>seed id</dt><dd id="gen-seed">{app.seedId || "—"}</dd>
          <dt>status</dt><dd id="gen-status">{app.gen.status}</dd>
          <dt>elapsed</dt><dd id="gen-elapsed">{app.gen.elapsed}</dd>
        </dl>
        <Show when={app.gen.done}>
          <div class="seed-result" id="seed-result">
            <ArtifactChips />
            <div style="display:flex; gap:12px; margin-top:4px;">
              <button class="btn-primary" id="next-rom" onClick={continueToRom}>{continueLabel()}</button>
            </div>
          </div>
        </Show>
        <Show when={app.gen.error}>
          <div class="error-box" id="gen-err">
            <span class="err-title">generation failed</span>
            <span id="gen-err-msg">{app.gen.error}</span>
          </div>
          <button class="err-back" onClick={resetTransient}>← start over</button>
        </Show>
      </div>
    </div>
  );
}

function RomPane() {
  return (
    <div class="home-pane" data-pane="rom">
      <div class="home-card">
        <div class="card-head"><span class="eyebrow">your rom</span></div>
        <p class="tip">Patching happens entirely in your browser — Python via Pyodide, in a Web Worker. Your ROM never leaves this tab.</p>
        <p class="legend">accepts: <kbd>.gbc</kbd> · 2,097,152 bytes · Crystal v1.0 or v1.1</p>
        <Dropzone id="dz-rom" inputId="rom-file" accept=".gbc,.gb,application/octet-stream" onFile={handleRomDrop}>
          <div class="dz-mark">▱</div>
          <div class="dz-primary">Drop vanilla Pokémon Crystal ROM</div>
          <div class="dz-meta">your file · your machine</div>
        </Dropzone>
        <Show when={app.rom.progressText}>
          <div class="rom-progress" id="rom-progress">
            <span class="spinner" aria-hidden="true">◐</span>
            <span id="rom-progress-text">{app.rom.progressText}</span>
          </div>
        </Show>
        <Show when={app.rom.error}>
          <div class="error-box" id="rom-err">
            <span class="err-title">patch failed</span>
            <span id="rom-err-msg">{app.rom.error}</span>
          </div>
          <button class="err-back" onClick={resetTransient}>← start over</button>
        </Show>
      </div>
    </div>
  );
}

export function Home() {
  return (
    <section class="home">
      <Blurb />
      <div class="home-main">
        <OptionsPane />
        <GeneratingPane />
        <RomPane />
      </div>
    </section>
  );
}
