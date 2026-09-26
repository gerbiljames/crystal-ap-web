import { For, Index, Show, createSignal, createMemo, createEffect, onCleanup, untrack } from "solid-js";
import Prism from "prismjs";
import "prismjs/components/prism-yaml";
import { yamlCreatorOpen, setYamlCreatorOpen, yamlEditTarget, setYamlEditTarget } from "../state.js";
import { saveCreatedYaml, saveEditedYaml, useYamlText } from "../actions.js";
import {
  SCHEMAS, serializeFormToYaml, initialValueFor, parseYamlToForm, specialNameFor, choiceForValue,
  type FormState, type FormValue, type GameKey, type OptionDef, type SingleValue, type WeightedValue,
} from "../lib/yaml-schema.js";
import { backdropDismiss } from "../lib/backdrop.js";

const GAMES: GameKey[] = ["Pokemon Crystal", "Pokemon Crystal Prerelease"];

function emptyForm(game: GameKey): FormState {
  return { game, name: "Player1", description: "", values: {} };
}

// One option row: label, control by kind, and a weights toggle.
function OptionRow(props: {
  opt: OptionDef;
  value: FormValue | undefined;
  setValue: (v: FormValue | undefined) => void;
}) {
  const initial = () => props.value ?? initialValueFor(props.opt);
  const isWeighted = () => initial().mode === "weighted";
  const docIsLong = () => props.opt.docstring.includes("\n") || props.opt.docstring.length > 110;
  const [docOpen, setDocOpen] = createSignal(false);
  // Weighting only makes sense for scalar-valued options. Collections (sets,
  // lists, dicts) already carry the full value in the YAML so you can't
  // "weight" between them.
  const COLLECTION_KINDS = new Set(["option_set", "pokemon_set", "option_list", "option_dict", "option_counter", "other"]);
  const canWeight = () => !COLLECTION_KINDS.has(props.opt.kind);

  const toggleWeighted = () => {
    if (isWeighted()) {
      props.setValue(initialValueFor(props.opt));
    } else {
      const cur = initial() as SingleValue;
      const v = Array.isArray(cur.value) ? (cur.value[0] ?? "") : cur.value;
      const w: WeightedValue = { mode: "weighted", entries: [{ value: String(v ?? ""), weight: 50 }] };
      props.setValue(w);
    }
  };

  return (
    <div class="yc-row" data-kind={props.opt.kind}>
      <div class="yc-row-head">
        <span class="yc-row-name" title={props.opt.docstring}>{props.opt.display_name}</span>
        <Show when={canWeight()}>
          <label class="yc-switch yc-weights-toggle" data-on={isWeighted()} title="Toggle weighted randomization">
            <input type="checkbox" checked={isWeighted()} onChange={toggleWeighted} />
            <span class="yc-switch-track"><span class="yc-switch-thumb" /></span>
            <span class="yc-switch-label">weights</span>
          </label>
        </Show>
      </div>
      <Show when={props.opt.docstring}>
        <div
          class="yc-row-doc"
          data-collapsed={docIsLong() && !docOpen()}
          data-clickable={docIsLong()}
          onClick={() => docIsLong() && setDocOpen(o => !o)}
          title={docIsLong() ? (docOpen() ? "click to collapse" : "click to expand") : undefined}
        >{props.opt.docstring}</div>
      </Show>
      <Show when={!isWeighted()} fallback={
        <WeightedEditor
          opt={props.opt}
          value={initial() as WeightedValue}
          setValue={(v: WeightedValue) => props.setValue(v)}
        />
      }>
        <SingleEditor
          opt={props.opt}
          value={initial() as SingleValue}
          setValue={v => props.setValue(v)}
        />
      </Show>
    </div>
  );
}

function SingleEditor(props: {
  opt: OptionDef;
  value: SingleValue;
  setValue: (v: SingleValue) => void;
}) {
  const set = (v: SingleValue["value"]) => props.setValue({ mode: "single", value: v });
  const opt = () => props.opt;
  const v = () => props.value.value;

  return (
    <Show when={true}>
      <Show when={opt().kind === "toggle" || opt().kind === "toggle_on"}>
        <label class="yc-switch" data-on={!!v()}>
          <input
            type="checkbox"
            checked={!!v()}
            onChange={e => set(e.currentTarget.checked)}
          />
          <span class="yc-switch-track"><span class="yc-switch-thumb" /></span>
          <span class="yc-switch-label">{v() ? "on" : "off"}</span>
        </label>
      </Show>

      <Show when={opt().kind === "choice"}>
        <select value={String(v())} onChange={e => set(e.currentTarget.value)}>
          <For each={opt().choices ?? []}>{c => <option value={c}>{c}</option>}</For>
        </select>
      </Show>

      <Show when={opt().kind === "range"}>
        <RangeInput opt={opt()} value={Number(v())} set={set} />
        <span class="yc-hint">{opt().range_start}..{opt().range_end}</span>
      </Show>

      <Show when={opt().kind === "named_range"}>
        <NamedRangeEditor opt={opt()} value={v()} set={set} />
      </Show>

      <Show when={opt().kind === "option_set" || opt().kind === "pokemon_set" || opt().kind === "option_list"}>
        <SetEditor opt={opt()} value={Array.isArray(v()) ? v() as string[] : []} set={set as any} />
      </Show>

      <Show when={opt().kind === "free_text"}>
        <input type="text" value={String(v() ?? "")} onInput={e => set(e.currentTarget.value)} />
      </Show>

      <Show when={opt().kind === "option_dict" || opt().kind === "option_counter" || opt().kind === "other"}>
        <textarea
          rows="3"
          value={String(v() ?? "")}
          placeholder='Inline YAML, e.g. {key: value}'
          onInput={e => set(e.currentTarget.value)}
        />
      </Show>
    </Show>
  );
}

// Whole number within the option's range. Typing only commits values that
// already are one, so the field can sit empty or mid-edit; leaving it snaps
// whatever's there into range (min/max attributes alone don't stop typing).
function RangeInput(props: { opt: OptionDef; value: number; set: (v: number) => void }) {
  // Special values of a named range are valid outside the range (vanilla =
  // -1 below a range starting at 0); a non-number never is.
  const clamp = (n: number) => {
    if (!Number.isFinite(n)) return props.opt.range_start ?? 0;
    if (specialNameFor(props.opt, n) !== null) return n;
    let x = Math.round(n);
    if (typeof props.opt.range_start === "number") x = Math.max(props.opt.range_start, x);
    if (typeof props.opt.range_end === "number") x = Math.min(props.opt.range_end, x);
    return x;
  };
  return (
    <input
      type="number"
      step="1"
      min={props.opt.range_start ?? undefined}
      max={props.opt.range_end ?? undefined}
      value={props.value}
      onInput={e => {
        const raw = e.currentTarget.value;
        if (raw === "") return;
        const n = Number(raw);
        if (Number.isFinite(n) && n === clamp(n)) props.set(n);
      }}
      onBlur={e => {
        const n = Number(e.currentTarget.value);
        const next = e.currentTarget.value === "" || !Number.isFinite(n) ? clamp(props.value) : clamp(n);
        e.currentTarget.value = String(next);
        props.set(next);
      }}
    />
  );
}

function NamedRangeEditor(props: { opt: OptionDef; value: any; set: (v: any) => void }) {
  const names = () => Object.keys(props.opt.special_range_names ?? {});
  const isNamed = () => typeof props.value === "string" && names().includes(props.value);
  return (
    <span class="yc-inline">
      <Show when={names().length > 0}>
        <select
          value={isNamed() ? String(props.value) : "__custom__"}
          onChange={e => {
            const v = e.currentTarget.value;
            if (v === "__custom__") props.set(props.opt.range_start ?? 0);
            else props.set(v);
          }}
        >
          <For each={names()}>{n => <option value={n}>{n}</option>}</For>
          <option value="__custom__">custom…</option>
        </select>
      </Show>
      <Show when={!isNamed()}>
        <RangeInput opt={props.opt} value={Number(props.value)} set={props.set} />
        <span class="yc-hint">{props.opt.range_start}..{props.opt.range_end ?? "?"}</span>
      </Show>
    </span>
  );
}

function SetEditor(props: { opt: OptionDef; value: string[]; set: (v: string[]) => void }) {
  const [draft, setDraft] = createSignal("");
  const [dragIndex, setDragIndex] = createSignal<number | null>(null);
  const [dropIndex, setDropIndex] = createSignal<number | null>(null);
  const valid = () => props.opt.valid_keys ?? [];
  const known = () => valid().length > 0 && !props.opt.valid_keys_computed;
  const validSet = createMemo(() => new Set(valid()));
  const isValid = (v: string) => !known() || validSet().has(v);
  const orderable = () => props.opt.kind === "option_list";
  const draftInvalid = () => {
    const d = draft().trim();
    if (!d) return false;
    if (props.value.includes(d)) return true;
    return !isValid(d);
  };

  const add = () => {
    const v = draft().trim();
    if (!v) return;
    if (props.value.includes(v)) return;
    if (!isValid(v)) return;
    props.set([...props.value, v]);
    setDraft("");
  };
  const remove = (v: string) => props.set(props.value.filter(x => x !== v));

  const onDragStart = (i: number) => (ev: DragEvent) => {
    setDragIndex(i);
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = "move";
      // Some browsers (Firefox) need a payload to actually start a drag.
      ev.dataTransfer.setData("text/plain", String(i));
    }
  };
  const onDragOver = (i: number) => (ev: DragEvent) => {
    if (dragIndex() === null) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    setDropIndex(i);
  };
  const onDrop = (i: number) => (ev: DragEvent) => {
    ev.preventDefault();
    const from = dragIndex();
    setDragIndex(null);
    setDropIndex(null);
    if (from === null || from === i) return;
    const next = props.value.slice();
    const [moved] = next.splice(from, 1);
    next.splice(i, 0, moved);
    props.set(next);
  };
  const onDragEnd = () => { setDragIndex(null); setDropIndex(null); };

  return (
    <div class="yc-set">
      <div class="yc-chips">
        <For each={props.value}>{(v, i) => (
          <span
            class="yc-chip"
            data-invalid={!isValid(v)}
            data-dragging={orderable() && dragIndex() === i()}
            data-drop-target={orderable() && dropIndex() === i() && dragIndex() !== i()}
            data-orderable={orderable()}
            draggable={orderable()}
            title={isValid(v) ? (orderable() ? "drag to reorder" : undefined) : "not a known value for this option"}
            // Solid binds handlers once, and <For> keeps a chip's node when
            // the list reorders: read the index when the event fires.
            onDragStart={ev => { if (orderable()) onDragStart(i())(ev); }}
            onDragOver={ev => { if (orderable()) onDragOver(i())(ev); }}
            onDrop={ev => { if (orderable()) onDrop(i())(ev); }}
            onDragEnd={() => { if (orderable()) onDragEnd(); }}
          >
            {v}
            <button class="yc-chip-x" onClick={() => remove(v)} aria-label="remove">×</button>
          </span>
        )}</For>
      </div>
      <span class="yc-inline">
        <Show when={known()} fallback={
          <input
            type="text"
            value={draft()}
            placeholder={props.opt.valid_keys_computed ? "free-text entry (dynamic options)" : "value"}
            onInput={e => setDraft(e.currentTarget.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          />
        }>
          <select
            class={draftInvalid() ? "yc-invalid" : undefined}
            value={draft()}
            onChange={e => { setDraft(e.currentTarget.value); }}
          >
            <option value="">— add —</option>
            <For each={valid().filter(k => !props.value.includes(k))}>{k => <option value={k}>{k}</option>}</For>
          </select>
        </Show>
        <button class="yc-btn" type="button" onClick={add} disabled={!draft().trim() || draftInvalid()}>add</button>
      </span>
    </div>
  );
}

function WeightedEditor(props: { opt: OptionDef; value: WeightedValue; setValue: (v: WeightedValue) => void }) {
  const update = (i: number, patch: Partial<{ value: string; weight: number }>) => {
    const next = props.value.entries.slice();
    next[i] = { ...next[i], ...patch };
    props.setValue({ mode: "weighted", entries: next });
  };
  // A new row starts on a value no row has yet, so it doesn't just repeat
  // row 0 (usually the default).
  const defaultRowValue = () => {
    const opt = props.opt;
    const used = new Set(props.value.entries.map(e => e.value));
    const firstUnused = (vals: string[]) => vals.find(v => !used.has(v)) ?? vals[0];
    if (opt.kind === "choice" && opt.choices && opt.choices.length) {
      const dflt = (typeof opt.default === "number" ? choiceForValue(opt, opt.default) : null) ?? opt.choices[0];
      return firstUnused([dflt, ...opt.choices]);
    }
    if (opt.kind === "toggle" || opt.kind === "toggle_on") {
      const dflt = opt.default === 1 || opt.default === true ? "true" : "false";
      return firstUnused([dflt, "true", "false"]);
    }
    if (opt.kind === "named_range") {
      const names = opt.special_range_names ? Object.keys(opt.special_range_names) : [];
      if (names.length) return names[0];
      if (typeof opt.range_start === "number") return String(opt.range_start);
    }
    if (opt.kind === "range" && typeof opt.range_start === "number") return String(opt.range_start);
    return "";
  };
  const add = () => props.setValue({ mode: "weighted", entries: [...props.value.entries, { value: defaultRowValue(), weight: 1 }] });
  const remove = (i: number) => props.setValue({ mode: "weighted", entries: props.value.entries.filter((_, j) => j !== i) });

  // Builds a row's control once; only its value attribute tracks the entry,
  // so typing doesn't swap the element (and focus) out from under the user.
  const valueInput = (i: number, entry: () => { value: string }) => {
    const opt = props.opt;
    if (opt.kind === "choice" && opt.choices) {
      return (
        <select value={entry().value} onChange={ev => update(i, { value: ev.currentTarget.value })}>
          <For each={opt.choices}>{c => <option value={c}>{c}</option>}</For>
          <Show when={!opt.choices.includes(entry().value)}><option value={entry().value}>{entry().value}</option></Show>
        </select>
      );
    }
    if (opt.kind === "toggle" || opt.kind === "toggle_on") {
      return (
        <select value={entry().value} onChange={ev => update(i, { value: ev.currentTarget.value })}>
          <option value="true">true</option>
          <option value="false">false</option>
          <Show when={entry().value !== "true" && entry().value !== "false"}><option value={entry().value}>{entry().value}</option></Show>
        </select>
      );
    }
    return <input type="text" value={entry().value} onInput={ev => update(i, { value: ev.currentTarget.value })} />;
  };

  return (
    <div class="yc-weighted">
      <Index each={props.value.entries}>{(entry, i) => (
        <div class="yc-weighted-row">
          {untrack(() => valueInput(i, entry))}
          <input
            class="yc-weight"
            type="number"
            min="0"
            value={entry().weight}
            onInput={ev => {
              const raw = ev.currentTarget.value;
              if (raw === "") return;
              const n = Number(raw);
              if (Number.isFinite(n)) update(i, { weight: Math.max(0, Math.floor(n)) });
            }}
            onBlur={ev => {
              if (ev.currentTarget.value === "") update(i, { weight: 0 });
            }}
          />
          <button class="yc-btn yc-btn-x" type="button" onClick={() => remove(i)} aria-label="remove">×</button>
        </div>
      )}</Index>
      <button class="yc-btn" type="button" onClick={add}>+ row</button>
    </div>
  );
}

// v as the new version's `opt` will take it, or undefined to fall back to
// the default. `random…` values pass through: they name no choice or value.
function carryValue(opt: OptionDef, v: FormValue): FormValue | undefined {
  let accepts: ((x: string) => boolean) | null = null;
  if (opt.kind === "choice" && opt.choices) {
    const choices = opt.choices;
    // A choice also takes its value (weighted tables keyed 0/1/…).
    accepts = (x) => choices.includes(x) || (/^-?\d+$/.test(x) && choiceForValue(opt, Number(x)) !== null);
  } else if (opt.kind === "range" || opt.kind === "named_range") {
    const names = Object.keys(opt.special_range_names ?? {}).map((k) => k.toLowerCase());
    accepts = (x) => {
      if (names.includes(x.toLowerCase())) return true;
      if (!/^-?\d+$/.test(x)) return false;
      const n = Number(x);
      return specialNameFor(opt, n) !== null
        || ((opt.range_start == null || n >= opt.range_start) && (opt.range_end == null || n <= opt.range_end));
    };
  }
  if (accepts) {
    const ok = (x: string) => x.startsWith("random") || accepts(x);
    if (v.mode === "single") return ok(String(v.value)) ? v : undefined;
    const entries = v.entries.filter(e => ok(e.value));
    return entries.length ? { mode: "weighted", entries } : undefined;
  }
  if ((opt.kind === "option_set" || opt.kind === "pokemon_set" || opt.kind === "option_list") &&
      opt.valid_keys?.length && !opt.valid_keys_computed && v.mode === "single" && Array.isArray(v.value)) {
    const valid = new Set(opt.valid_keys);
    return { mode: "single", value: v.value.filter(x => valid.has(x)) };
  }
  return v;
}

export function YamlCreator() {
  const [form, setForm] = createSignal<FormState>(emptyForm("Pokemon Crystal"));
  const [openGroups, setOpenGroups] = createSignal<Record<string, boolean>>({});
  const [showPreview, setShowPreview] = createSignal(false);
  const [busy, setBusy] = createSignal<null | "save" | "use">(null);
  const [saveErr, setSaveErr] = createSignal<string | null>(null);
  // When editing an existing saved YAML, we hold onto the library name so the
  // entry round-trips with whatever the user had previously renamed it to.
  const [libraryName, setLibraryName] = createSignal<string | null>(null);
  // The YAML as it stood when the creator opened, to tell whether a stray
  // Esc or backdrop click would throw edits away.
  let openedText = "";

  const schema = createMemo(() => SCHEMAS[form().game]);
  const yamlText = createMemo(() => serializeFormToYaml(form()));

  // Reset on open. Reads of `schema()` etc. are untracked so this effect
  // doesn't re-fire (and undo the user's edits) when reactive deps change
  // during normal use.
  createEffect(() => {
    if (!yamlCreatorOpen()) return;
    untrack(() => {
      const target = yamlEditTarget();
      if (target) {
        const parsed = parseYamlToForm(target.text);
        setForm(parsed);
        setLibraryName(target.displayName);
        const initial: Record<string, boolean> = {};
        SCHEMAS[parsed.game].groups.forEach((g, i) => { initial[g.name] = i === 0; });
        setOpenGroups(initial);
      } else {
        setLibraryName(null);
        setForm(emptyForm("Pokemon Crystal"));
        const initial: Record<string, boolean> = {};
        SCHEMAS["Pokemon Crystal"].groups.forEach((g, i) => { initial[g.name] = i === 0; });
        setOpenGroups(initial);
      }
      setShowPreview(false);
      openedText = serializeFormToYaml(form());
    });
  });

  const closeUnlessEdited = () => {
    if (yamlText() !== openedText && !confirm("Discard your changes to this YAML?")) return;
    setYamlCreatorOpen(false);
  };

  // Clear the edit target whenever the modal closes so the next open starts
  // in create mode.
  createEffect(() => {
    if (!yamlCreatorOpen()) { setYamlEditTarget(null); setSaveErr(null); }
  });

  // Esc closes.
  createEffect(() => {
    if (!yamlCreatorOpen()) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") closeUnlessEdited(); };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const backdrop = backdropDismiss(closeUnlessEdited);

  const setGame = (g: GameKey) => {
    // Carry across every value whose yaml_key + kind survives in the new
    // schema and that the new version still accepts. Goal's kind flip between
    // Choice (stable) and OptionSet (prerelease) is the main offender the kind
    // check catches; choices and set members that exist in only one version
    // are the rest.
    const nextSchema = SCHEMAS[g];
    const optsByKey = (sch: typeof nextSchema) =>
      new Map(sch.groups.flatMap(grp => grp.options.map(o => [o.yaml_key, o] as const)));
    const nextOpts = optsByKey(nextSchema);
    const prevOpts = optsByKey(SCHEMAS[form().game]);
    const carried: Record<string, FormValue> = {};
    for (const [k, v] of Object.entries(form().values)) {
      const next = nextOpts.get(k);
      if (!next || prevOpts.get(k)?.kind !== next.kind) continue;
      const kept = carryValue(next, v);
      if (kept) carried[k] = kept;
    }
    setForm({ ...form(), game: g, values: carried });

    // Keep section open state for groups that exist under the same name in
    // the new schema; default the rest to closed (the first group stays open
    // if it would otherwise have no prior state).
    const prevOpen = openGroups();
    const initial: Record<string, boolean> = {};
    nextSchema.groups.forEach((grp, i) => {
      initial[grp.name] = grp.name in prevOpen ? prevOpen[grp.name] : (i === 0);
    });
    setOpenGroups(initial);
  };

  const setValue = (key: string, v: FormValue | undefined) => {
    const next = { ...form().values };
    if (v === undefined) delete next[key];
    else next[key] = v;
    setForm({ ...form(), values: next });
  };

  const doSave = async (alsoUse: boolean) => {
    if (busy()) return;
    setBusy(alsoUse ? "use" : "save");
    try {
      const text = yamlText();
      const target = yamlEditTarget();
      const name = libraryName() ?? ((form().name || "Player1") + ".yaml");
      setSaveErr(null);
      const saved = target
        ? await saveEditedYaml(text, name, target.hash, !!form().lossy?.length)
        : await saveCreatedYaml(text, name);
      // A plain save that failed keeps the creator open so nothing is lost.
      // "save & use" goes ahead from the text in hand either way.
      if (!saved && !alsoUse) {
        setSaveErr("couldn't save to the library (browser storage unavailable — see the log)");
        return;
      }
      setYamlCreatorOpen(false);
      // Not awaited: the flow runs through generation, which shows its own
      // progress once the creator is closed.
      if (alsoUse) void useYamlText(text);
    } finally {
      setBusy(null);
    }
  };

  // Saves the YAML as it stands in the form, without touching the library.
  const downloadYaml = () => {
    const base = (libraryName() ?? (form().name || "Player1")).replace(/\.ya?ml$/i, "");
    const fileName = (base.replace(/[\\/:*?"<>|]+/g, "_").trim() || "Player1") + ".yaml";
    const url = URL.createObjectURL(new Blob([yamlText()], { type: "text/yaml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <Show when={yamlCreatorOpen()}>
      <div class="modal-backdrop" {...backdrop}>
        <div class="modal yaml-creator" role="dialog" aria-modal="true" aria-label="create yaml">
          <div class="modal-head">
            <span class="modal-title">{yamlEditTarget() ? "edit yaml" : "create yaml"}</span>
            <div class="yc-version">
              <For each={GAMES}>{g => (
                <label class="yc-version-opt" data-active={form().game === g}>
                  <input
                    type="radio"
                    name="yc-game"
                    checked={form().game === g}
                    onChange={() => setGame(g)}
                  /> {g === "Pokemon Crystal" ? "stable" : "prerelease"}
                </label>
              )}</For>
            </div>
            <button class="modal-close" onClick={() => setYamlCreatorOpen(false)} aria-label="close">✕</button>
          </div>

          <div class="modal-body yc-body">
            <Show when={form().lossy?.length}>
              <div class="error-box">
                <span class="err-title">can't fully edit this YAML</span>
                <span>
                  The form can't represent {form().lossy!.join(", ")}. Saving adds a new
                  library entry and keeps the original.
                </span>
              </div>
            </Show>
            <div class="yc-header">
              <label>
                <span>name</span>
                <input
                  type="text"
                  value={form().name}
                  onInput={e => setForm({ ...form(), name: e.currentTarget.value })}
                />
              </label>
              <label>
                <span>description</span>
                <input
                  type="text"
                  value={form().description}
                  placeholder="optional"
                  onInput={e => setForm({ ...form(), description: e.currentTarget.value })}
                />
              </label>
            </div>

            <div class="yc-groups">
              <For each={schema().groups}>{group => (
                <details class="yc-group" open={openGroups()[group.name]} onToggle={ev => {
                  setOpenGroups({ ...openGroups(), [group.name]: (ev.currentTarget as HTMLDetailsElement).open });
                }}>
                  <summary class="yc-group-head">
                    <span>{group.name}</span>
                    <span class="yc-group-count">{group.options.length}</span>
                    <span class="yc-group-chevron" aria-hidden="true">
                      <svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor">
                        <polygon points="2,4 10,4 6,9" />
                      </svg>
                    </span>
                  </summary>
                  <For each={group.options}>{opt => (
                    <OptionRow
                      opt={opt}
                      value={form().values[opt.yaml_key]}
                      setValue={v => setValue(opt.yaml_key, v)}
                    />
                  )}</For>
                </details>
              )}</For>
            </div>

            <details class="yc-preview" open={showPreview()} onToggle={ev => setShowPreview((ev.currentTarget as HTMLDetailsElement).open)}>
              <summary>preview YAML</summary>
              <pre class="yaml-preview language-yaml"><code class="language-yaml" innerHTML={showPreview() ? Prism.highlight(yamlText(), Prism.languages.yaml, "yaml") : ""} /></pre>
            </details>
          </div>

          <Show when={saveErr()}>
            <div class="error-box">
              <span class="err-title">not saved</span>
              <span>{saveErr()}</span>
            </div>
          </Show>
          <div class="modal-foot yc-foot">
            <button class="btn-primary" disabled={!!busy()} onClick={() => doSave(false)}>
              {busy() === "save" ? "saving…" : "save"}
            </button>
            <button class="btn-primary" disabled={!!busy()} onClick={() => doSave(true)}>
              {busy() === "use" ? "starting…" : "save & use"}
            </button>
            <button class="forget" onClick={downloadYaml} title="save this YAML as a file">download</button>
            <button class="forget" onClick={() => setYamlCreatorOpen(false)}>cancel</button>
          </div>
        </div>
      </div>
    </Show>
  );
}
