import { createEffect, createMemo, createSignal, on, onCleanup, For, Show } from "solid-js";
import { versionPick, setVersionPick } from "../state.js";
import { compareVersions } from "../lib/apworld.js";

// Modal asking which bundled apworld version to play a seed on, for the one
// case the resolver can't decide itself: a stable patch whose embedded
// basepatch matches no bundled version. Defaults to the newest candidate.
export function VersionPicker() {
  const [choice, setChoice] = createSignal<string | null>(null);

  const sorted = createMemo(() => [...(versionPick()?.candidates ?? [])].sort((a, b) => compareVersions(b.world_version, a.world_version)));
  const current = () => choice() ?? sorted()[0]?.world_version ?? null;

  const finish = (pick: boolean) => {
    const q = versionPick();
    if (!q) return;
    const world = pick ? sorted().find((w) => w.world_version === current()) ?? null : null;
    setVersionPick(null);
    setChoice(null);
    q.resolve(world);
  };

  // A new question (including one that replaced a pending one) starts from
  // the newest candidate again, not from a pick made for another seed.
  createEffect(on(versionPick, () => setChoice(null)));

  createEffect(() => {
    if (!versionPick()) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") finish(false); };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <Show when={versionPick()}>{(q) => (
      <div class="modal-backdrop" onClick={(ev) => { if (ev.target === ev.currentTarget) finish(false); }}>
        <div class="modal vp" role="dialog" aria-modal="true" aria-label="choose apworld version">
          <div class="modal-head">
            <span class="modal-title">choose apworld version</span>
            <button class="modal-close" onClick={() => finish(false)} aria-label="close">✕</button>
          </div>
          <div class="modal-body vp-body">
            <p class="tip">{q().reason}. Pick the {q().game} apworld version this seed was generated with, or the closest one. If the ROM layout doesn't match, patching will say so.</p>
            <div class="vp-options" role="radiogroup">
              <For each={sorted()}>{(w, i) => (
                <label class="vp-opt" data-active={current() === w.world_version}>
                  <input type="radio" name="vp-version" checked={current() === w.world_version} onChange={() => setChoice(w.world_version)} />
                  <span class="vp-ver">{w.display_version}</span>
                  <Show when={i() === 0}><span class="vp-tag">newest</span></Show>
                  <Show when={w.ref}><span class="vp-ref">{w.ref}</span></Show>
                </label>
              )}</For>
            </div>
          </div>
          <div class="modal-foot vp-foot">
            <button class="btn-primary" onClick={() => finish(true)}>use this version</button>
            <button class="forget" onClick={() => finish(false)}>cancel</button>
          </div>
        </div>
      </div>
    )}</Show>
  );
}
