import { For, Show, createSignal, createMemo, createEffect, onCleanup, untrack } from "solid-js";
import Prism from "prismjs";
import "prismjs/components/prism-yaml";
import { yamlCreatorOpen, setYamlCreatorOpen, yamlEditTarget, setYamlEditTarget } from "../state.js";
import { saveCreatedYaml, createAndUseYaml, saveEditedYaml, useSavedYaml } from "../actions.js";
import {
  SCHEMAS, serializeFormToYaml, initialValueFor, parseYamlToForm,
  type FormState, type FormValue, type GameKey, type OptionDef, type SingleValue, type WeightedValue,
} from "../lib/yaml-schema.js";

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
        <input
          type="number"
          min={opt().range_start ?? undefined}
          max={opt().range_end ?? undefined}
          value={Number(v())}
          onInput={e => set(Number(e.currentTarget.value))}
        />
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
        <input
          type="number"
          min={props.opt.range_start ?? undefined}
          max={props.opt.range_end ?? undefined}
          value={Number(props.value)}
          onInput={e => props.set(Number(e.currentTarget.value))}
        />
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
            onDragStart={orderable() ? onDragStart(i()) : undefined}
            onDragOver={orderable() ? onDragOver(i()) : undefined}
            onDrop={orderable() ? onDrop(i()) : undefined}
            onDragEnd={orderable() ? onDragEnd : undefined}
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
  const defaultRowValue = () => {
    const opt = props.opt;
    if (opt.kind === "choice" && opt.choices && opt.choices.length) {
      const idx = typeof opt.default === "number" ? opt.default : 0;
      return opt.choices[idx] ?? opt.choices[0];
    }
    if (opt.kind === "toggle" || opt.kind === "toggle_on") {
      return opt.default === 1 || opt.default === true ? "true" : "false";
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

  const valueInput = (i: number, e: { value: string }) => {
    const opt = props.opt;
    if (opt.kind === "choice" && opt.choices) {
      return (
        <select value={e.value} onChange={ev => update(i, { value: ev.currentTarget.value })}>
          <For each={opt.choices}>{c => <option value={c}>{c}</option>}</For>
        </select>
      );
    }
    if (opt.kind === "toggle" || opt.kind === "toggle_on") {
      return (
        <select value={e.value} onChange={ev => update(i, { value: ev.currentTarget.value })}>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    }
    return <input type="text" value={e.value} onInput={ev => update(i, { value: ev.currentTarget.value })} />;
  };

  return (
    <div class="yc-weighted">
      <For each={props.value.entries}>{(e, i) => (
        <div class="yc-weighted-row">
          {valueInput(i(), e)}
          <input
            class="yc-weight"
            type="number"
            min="0"
            value={e.weight}
            onInput={ev => update(i(), { weight: Number(ev.currentTarget.value) || 0 })}
          />
          <button class="yc-btn yc-btn-x" type="button" onClick={() => remove(i())} aria-label="remove">×</button>
        </div>
      )}</For>
      <button class="yc-btn" type="button" onClick={add}>+ row</button>
    </div>
  );
}

export function YamlCreator() {
  const [form, setForm] = createSignal<FormState>(emptyForm("Pokemon Crystal"));
  const [openGroups, setOpenGroups] = createSignal<Record<string, boolean>>({});
  const [showPreview, setShowPreview] = createSignal(false);
  const [busy, setBusy] = createSignal<null | "save" | "use">(null);
  // When editing an existing saved YAML, we hold onto the library name so the
  // entry round-trips with whatever the user had previously renamed it to.
  const [libraryName, setLibraryName] = createSignal<string | null>(null);

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
    });
  });

  // Clear the edit target whenever the modal closes so the next open starts
  // in create mode.
  createEffect(() => {
    if (!yamlCreatorOpen()) setYamlEditTarget(null);
  });

  // Esc closes.
  createEffect(() => {
    if (!yamlCreatorOpen()) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") setYamlCreatorOpen(false); };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const onBackdrop = (ev: MouseEvent) => {
    if (ev.target === ev.currentTarget) setYamlCreatorOpen(false);
  };

  const setGame = (g: GameKey) => {
    // Carry across every value whose yaml_key + kind survives in the new
    // schema. Goal's kind flip between Choice (stable) and OptionSet
    // (prerelease) is the main offender that benefits from the kind check.
    const nextSchema = SCHEMAS[g];
    const kindByKey = new Map<string, string>();
    for (const grp of nextSchema.groups) {
      for (const opt of grp.options) kindByKey.set(opt.yaml_key, opt.kind);
    }
    const prevSchema = SCHEMAS[form().game];
    const prevKindByKey = new Map<string, string>();
    for (const grp of prevSchema.groups) {
      for (const opt of grp.options) prevKindByKey.set(opt.yaml_key, opt.kind);
    }
    const carried: Record<string, FormValue> = {};
    for (const [k, v] of Object.entries(form().values)) {
      const nextKind = kindByKey.get(k);
      if (!nextKind) continue;
      if (prevKindByKey.get(k) !== nextKind) continue;
      carried[k] = v;
    }
    setForm({ game: g, name: form().name, description: form().description, values: carried });

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
      if (target) {
        const newHash = await saveEditedYaml(text, name, target.hash);
        if (alsoUse) await useSavedYaml(newHash);
      } else if (alsoUse) {
        await createAndUseYaml(text, name);
      } else {
        await saveCreatedYaml(text, name);
      }
      setYamlCreatorOpen(false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Show when={yamlCreatorOpen()}>
      <div class="modal-backdrop" onClick={onBackdrop}>
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
              <pre class="yaml-preview language-yaml"><code class="language-yaml" innerHTML={Prism.highlight(yamlText(), Prism.languages.yaml, "yaml")} /></pre>
            </details>
          </div>

          <div class="modal-foot yc-foot">
            <button class="btn-primary" disabled={!!busy()} onClick={() => doSave(false)}>
              {busy() === "save" ? "saving…" : "save"}
            </button>
            <button class="btn-primary" disabled={!!busy()} onClick={() => doSave(true)}>
              {busy() === "use" ? "starting…" : "save & use"}
            </button>
            <button class="forget" onClick={() => setYamlCreatorOpen(false)}>cancel</button>
          </div>
        </div>
      </div>
    </Show>
  );
}
