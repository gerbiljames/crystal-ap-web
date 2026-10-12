// After a turn that used all its checks: the player picks locations to hint
// before the next turn starts. The hints go to the game server, so everyone's
// PopTracker shows them; this page never shows what they hold.

import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { api } from "../lib/api.js";
import type { HintAllowance } from "../../shared/protocol.js";

export function HintPicker(props: { allowance: HintAllowance }) {
  const [locations, setLocations] = createSignal<{ id: number; name: string }[] | null>(null);
  const [query, setQuery] = createSignal("");
  const [chosen, setChosen] = createSignal<{ id: number; name: string }[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const load = async () => {
    setError(null);
    try { setLocations((await api.hintOptions()).locations); }
    catch (err: any) { setError(err?.message || String(err)); }
  };
  onMount(load);

  const left = () => props.allowance.allowance - chosen().length;
  const matches = createMemo(() => {
    const all = locations() ?? [];
    const words = query().toLowerCase().split(/\s+/).filter(Boolean);
    const picked = new Set(chosen().map((l) => l.id));
    return all.filter((l) => !picked.has(l.id) && words.every((w) => l.name.toLowerCase().includes(w)));
  });

  const send = async (ids: number[]) => {
    const n = ids.length;
    const question = n
      ? `Hint ${n} location${n === 1 ? "" : "s"}? You can't change them afterwards, and the next turn starts.`
      : "Finish without hinting? Your hints are lost and the next turn starts.";
    if (!confirm(question)) return;
    setBusy(true);
    setError(null);
    try { await api.sendHints(ids); }
    catch (err: any) { setError(err?.message || String(err)); }
    finally { setBusy(false); }
  };

  const a = () => props.allowance;
  return (
    <div class="hint-picker">
      <p class="tip">
        <strong>You used all your checks.</strong> Before the next turn you can hint up
        to <strong>{a().allowance}</strong> location{a().allowance === 1 ? "" : "s"}
        <Show when={a().progressionFound > 0}> ({a().perTurn}, less the {a().progressionFound} progression item{a().progressionFound === 1 ? "" : "s"} you found)</Show>.
        Everyone using PopTracker will see what's there.
      </p>
      <Show when={error()}>
        <div class="error-box" role="alert"><span class="err-title">couldn't do that</span><span>{error()}</span></div>
      </Show>
      <Show when={locations()} fallback={<p class="muted">{error() ? "" : "loading locations…"}</p>}>
        <input class="admin-filter hint-search" type="search" placeholder={`search ${locations()!.length.toLocaleString()} unchecked locations`}
          value={query()} onInput={(ev) => setQuery(ev.currentTarget.value)} />
        <ul class="hint-options">
          <For each={matches()}>{(l) => (
            <li><button disabled={busy() || left() <= 0} onClick={() => setChosen([...chosen(), l])}>{l.name}</button></li>
          )}</For>
        </ul>
        <p class="muted hint-status">{
          left() <= 0 ? "that's all your hints — remove one to pick another"
            : !matches().length ? "no unchecked location matches"
            : query().trim() ? `${matches().length.toLocaleString()} match${matches().length === 1 ? "" : "es"}`
            : ""
        }</p>
      </Show>
      {/* A row for every hint from the start, filled as they're picked, so
          picking never changes the size of anything. */}
      <ol class="hint-chosen">
        <For each={Array.from({ length: a().allowance }, (_, i) => i)}>{(i) => (
          <Show when={chosen()[i]} fallback={<li class="hint-slot-empty">hint {i + 1}: pick a location above</li>}>
            <li>
              <span>{chosen()[i].name}</span>
              <button class="hint-remove" aria-label={`remove ${chosen()[i].name}`} disabled={busy()} onClick={() => setChosen(chosen().filter((_, j) => j !== i))}>✕</button>
            </li>
          </Show>
        )}</For>
      </ol>
      <div class="turn-actions">
        <button class="btn-primary" disabled={busy() || !chosen().length} onClick={() => send(chosen().map((l) => l.id))}>
          hint {chosen().length || ""} location{chosen().length === 1 ? "" : "s"} and finish
        </button>
        <button disabled={busy()} onClick={() => send([])}>finish without hinting</button>
      </div>
    </div>
  );
}
