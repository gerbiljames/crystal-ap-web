import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { adminOpen, setAdminOpen, publicState, you } from "../state.js";
import { api } from "../lib/api.js";
import { END_REASON_ADMIN_TEXT, type AdminState, type AdminUserRow, type CheckpointRow } from "../../shared/protocol.js";
import { UserBadge, ChecksMeter, FindList } from "./Home.jsx";

const TABS = ["run", "checkpoints", "users", "turns"] as const;
type Tab = typeof TABS[number];
// The tab an admin last had open (a convenience: any failure just means "run").
const TAB_KEY = "yogos-admin-tab";
function savedTab(): Tab {
  try { const t = localStorage.getItem(TAB_KEY); if ((TABS as readonly string[]).includes(t ?? "")) return t as Tab; } catch {}
  return "run";
}

function fmtTime(ms: number | null) {
  return ms ? new Date(ms).toLocaleString() : "—";
}

function AdminBody() {
  // The last state that loaded: a failed poll keeps showing it (with the
  // error above) rather than blanking the page. Each poll is reconciled in by
  // id, so rows that didn't change keep their DOM (and the button under the
  // pointer, and what's selected or scrolled).
  const [store, setStore] = createStore<{ data: (AdminState & { users: (AdminState["users"][number] & { id: string })[] }) | null }>({ data: null });
  const state = () => store.data;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const refetch = async () => {
    try {
      const data = await api.admin.state();
      setStore("data", reconcile({ ...data, users: data.users.map((r) => ({ ...r, id: r.user.id })) }, { key: "id" }));
      setLoadError(null);
    }
    catch (err: any) { setLoadError(`couldn't load the admin state: ${err?.message || err}`); }
  };
  void refetch();
  const [filter, setFilter] = createSignal("");
  // Expanded turns, by id: each poll brings new row objects, and this keeps
  // the ones being read open.
  const [openTurns, setOpenTurns] = createSignal<Set<string>>(new Set());
  const toggleTurn = (id: string, open: boolean) => setOpenTurns((prev) => {
    const next = new Set(prev);
    if (open) next.add(id); else next.delete(id);
    return next;
  });
  // The public state is pushed live; the user and session lists are fetched,
  // so poll them while the page is open and visible (and catch up as soon as
  // it's shown again).
  const t = setInterval(() => { if (document.visibilityState === "visible") refetch(); }, 5000);
  const onVisible = () => { if (document.visibilityState === "visible") refetch(); };
  document.addEventListener("visibilitychange", onVisible);
  onCleanup(() => { clearInterval(t); document.removeEventListener("visibilitychange", onVisible); });

  const act = async (action: string, body: Record<string, unknown> = {}, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    try { await api.admin.action(action, body); await refetch(); }
    catch (err: any) { setError(err?.message || String(err)); }
    finally { setBusy(false); }
  };

  // Checkpoints: the one picked to roll back to, and the outcome of the last
  // checkpoint or rollback.
  const [label, setLabel] = createSignal("");
  const [picked, setPicked] = createSignal<string | null>(null);
  const [returnTurns, setReturnTurns] = createSignal(false);
  const [notice, setNotice] = createSignal<string | null>(null);
  const run = async (task: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try { setNotice(await task()); await refetch(); }
    catch (err: any) { setError(err?.message || String(err)); }
    finally { setBusy(false); }
  };
  const takeCheckpoint = () => run(async () => {
    const row = await api.admin.checkpoint(label());
    setLabel("");
    return `Checkpoint taken: ${row.label} (${row.checked}/${row.total} checked).`;
  });
  const rollback = (c: CheckpointRow) => run(async () => {
    const r = await api.admin.rollback(c.id, returnTurns());
    setPicked(null);
    return `Rolled back to “${c.label}”: ${r.undone} check${r.undone === 1 ? "" : "s"} undone`
      + (returnTurns() ? `, ${r.turnsReturned} turn${r.turnsReturned === 1 ? "" : "s"} given back` : "")
      + ". The queue is paused: resume it when you're ready.";
  });
  // Turns started after a checkpoint (from the turns list, the latest 200).
  const turnsAfter = (c: CheckpointRow) => (state()?.sessions ?? []).filter((s) => s.startedAt > c.createdAt);
  // Why a rollback can't be started right now, if it can't.
  const rollbackBlocked = () =>
    ps()?.current ? "end the running turn first"
    : !ps()?.serverReady ? "the game server isn't ready"
    : null;

  const [tab, setTabSignal] = createSignal<Tab>(savedTab());
  const setTab = (t: Tab) => { setTabSignal(t); try { localStorage.setItem(TAB_KEY, t); } catch {} };
  // What each tab's label adds: how much is in it.
  const tabCount = (t: Tab): string => {
    const n = t === "run" ? ps()?.queue.length : t === "checkpoints" ? state()?.checkpoints.length
      : t === "users" ? state()?.users.length : state()?.sessions.length;
    return n ? ` ${n}` : "";
  };

  const users = () => {
    const q = filter().trim().toLowerCase();
    const rows = state()?.users ?? [];
    return q ? rows.filter((r: AdminUserRow) => r.user.name.toLowerCase().includes(q) || r.user.id.includes(q)) : rows;
  };
  const ps = () => publicState();

  return (
    <div class="admin-body">
      <Show when={error() || loadError()}><div class="error-box"><span class="err-title">admin</span><span>{error() || loadError()}</span></div></Show>

      <div class="admin-tabs" role="tablist">
        <For each={TABS}>{(t) => (
          <button type="button" class="admin-tab" role="tab" aria-selected={tab() === t} data-active={tab() === t ? "true" : undefined} onClick={() => setTab(t)}>
            {t}<span class="admin-tab-count">{tabCount(t)}</span>
          </button>
        )}</For>
      </div>

      <Show when={tab() === "run"}>
        <section class="admin-section">
          <Show when={ps()}>
            <div class="admin-row">
              <span>queue {ps()!.paused ? "paused" : "running"}{ps()!.complete ? " · goal complete" : ""}{ps()!.serverReady ? "" : " · server not ready"}</span>
              <Show when={ps()!.paused} fallback={<button disabled={busy()} onClick={() => act("pause")}>pause queue</button>}>
                <button disabled={busy()} onClick={() => act("resume")}>resume queue</button>
              </Show>
            </div>
            <Show when={ps()!.current}>
              <div class="admin-row">
                <UserBadge user={ps()!.current!.user} small />
                <ChecksMeter checks={ps()!.current!.checks} limit={ps()!.checkLimit} />
                <button class="btn-danger" disabled={busy()} onClick={() => act("end-session", { sessionId: ps()!.current!.sessionId }, `End ${ps()!.current!.user.name}'s turn? It counts as their one turn.`)}>end turn</button>
                <button disabled={busy()} onClick={() => act("end-session-to-hints", { sessionId: ps()!.current!.sessionId }, `End ${ps()!.current!.user.name}'s turn and let them choose hints, as if they'd used all their checks? It counts as their one turn.`)}>end turn with hints</button>
              </div>
            </Show>
            <Show when={state()?.hinting}>
              <div class="admin-row">
                <UserBadge user={state()!.hinting!.user} small />
                <span class="muted">choosing {state()!.hinting!.allowance} hint{state()!.hinting!.allowance === 1 ? "" : "s"} (found {state()!.hinting!.progressionFound} progression)</span>
                <button disabled={busy()} onClick={() => act("skip-hints", {}, `Skip ${state()!.hinting!.user.name}'s hints? The next turn starts and their hints are lost.`)}>skip hints</button>
              </div>
            </Show>
            <Show when={ps()!.offered}>
              <div class="admin-row">
                <UserBadge user={ps()!.offered!.user} small />
                <span class="muted">offered a turn</span>
                <button disabled={busy()} onClick={() => act("skip", { userId: ps()!.offered!.user.id })}>skip</button>
              </div>
            </Show>
            <h4>queue</h4>
            <Show when={ps()!.queue.length > 0} fallback={<p class="muted">empty</p>}>
              <ol class="queue-list">
                <For each={ps()!.queue}>{(u) => (
                  <li class="admin-row">
                    <UserBadge user={u} small />
                    <button disabled={busy()} onClick={() => act("dequeue", { userId: u.id })}>remove</button>
                  </li>
                )}</For>
              </ol>
            </Show>
          </Show>
        </section>

      </Show>

      <Show when={tab() === "checkpoints"}>
        <section class="admin-section">
          <p class="admin-note">
            A checkpoint saves everything the game server holds: checked locations, items sent and data storage. One is
            taken at the start and after every turn. Rolling back puts the game back to a checkpoint and pauses the queue;
            a checkpoint is taken first, so a rollback can be undone.
          </p>
          <Show when={notice()}><p class="admin-note">{notice()}</p></Show>
          <div class="admin-row">
            <input class="admin-filter" type="text" maxLength={80} placeholder="label (optional)" value={label()} onInput={(ev) => setLabel(ev.currentTarget.value)} />
            <button disabled={busy() || state()?.checkpointBusy || !ps()?.serverReady} onClick={takeCheckpoint}>checkpoint now</button>
          </div>
          <Show when={(state()?.checkpoints.length ?? 0) > 0} fallback={<p class="muted">no checkpoints yet</p>}>
            <ul class="checkpoint-list">
              <For each={state()!.checkpoints}>{(c) => (
                <li data-selected={picked() === c.id ? "true" : undefined}>
                  <div class="checkpoint-main">
                    <span class="checkpoint-label">{c.label}</span>
                    <span class="muted">{fmtTime(c.createdAt)}</span>
                    <span>{c.checked}/{c.total}{c.complete ? " · goal" : ""}</span>
                    <button disabled={busy() || state()?.checkpointBusy || !!rollbackBlocked()} title={rollbackBlocked() ?? undefined}
                      onClick={() => { setReturnTurns(false); setPicked(picked() === c.id ? null : c.id); }}>roll back</button>
                  </div>
                  <Show when={picked() === c.id}>
                    <div class="checkpoint-confirm">
                      <span>
                        Put the game back to how it was {fmtTime(c.createdAt)}: {c.checked}/{c.total} checked
                        (now {ps()?.totals.checked ?? "?"}/{ps()?.totals.total ?? "?"}). Players see the game server restart.
                      </span>
                      <Show when={turnsAfter(c).length > 0}>
                        <label>
                          <input type="checkbox" checked={returnTurns()} onChange={(ev) => setReturnTurns(ev.currentTarget.checked)} />
                          give the {turnsAfter(c).length} player{turnsAfter(c).length === 1 ? "" : "s"} who started a turn since then another turn
                        </label>
                      </Show>
                      <div class="admin-row">
                        <button class="btn-danger" disabled={busy() || !!rollbackBlocked()} onClick={() => rollback(c)}>{busy() ? "rolling back…" : "roll back"}</button>
                        <button disabled={busy()} onClick={() => setPicked(null)}>cancel</button>
                      </div>
                    </div>
                  </Show>
                </li>
              )}</For>
            </ul>
          </Show>
        </section>

      </Show>

      <Show when={tab() === "users"}>
        <section class="admin-section">
          <input class="admin-filter" type="search" placeholder="filter by name or id" value={filter()} onInput={(ev) => setFilter(ev.currentTarget.value)} />
          <table class="admin-table">
            <thead><tr><th>user</th><th>id</th><th>turn</th><th></th></tr></thead>
            <tbody>
              <For each={users()}>{(r) => (
                <tr>
                  <td><UserBadge user={r.user} small /></td>
                  <td class="mono-small">{r.user.id}</td>
                  <td>{r.banned ? "banned" : r.attemptUsed ? "used" : "available"}</td>
                  <td class="admin-actions">
                    <Show when={r.attemptUsed}>
                      <button disabled={busy()} onClick={() => act("reset-user", { userId: r.user.id }, `Give ${r.user.name} another turn?`)}>reset turn</button>
                    </Show>
                    <Show when={r.banned} fallback={
                      <button class="btn-danger" disabled={busy() || r.user.id === you()?.user.id} onClick={() => act("ban", { userId: r.user.id }, `Ban ${r.user.name}? This also ends their turn or removes them from the queue.`)}>ban</button>
                    }>
                      <button disabled={busy()} onClick={() => act("unban", { userId: r.user.id })}>unban</button>
                    </Show>
                  </td>
                </tr>
              )}</For>
            </tbody>
          </table>
        </section>

      </Show>

      <Show when={tab() === "turns"}>
        <section class="admin-section">
          <For each={state()?.sessions ?? []} fallback={<p class="muted">no turns yet</p>}>{(s) => (
            <details class="admin-session" open={openTurns().has(s.id)} onToggle={(ev) => toggleTurn(s.id, ev.currentTarget.open)}>
              <summary>
                <UserBadge user={s.user} small />
                <span>{fmtTime(s.startedAt)}</span>
                <span>{s.finds.filter((f) => !f.undone).length} check{s.finds.filter((f) => !f.undone).length === 1 ? "" : "s"}{s.finds.some((f) => f.undone) ? ` (${s.finds.filter((f) => f.undone).length} undone)` : ""}</span>
                <span class="muted">{s.reason ? END_REASON_ADMIN_TEXT[s.reason] : "running"}</span>
              </summary>
              <Show when={s.detail}><p class="muted">{s.detail}</p></Show>
              <p class="muted">ended {fmtTime(s.endedAt)}</p>
              <FindList finds={s.finds} empty="no new checks" />
              <Show when={s.hints?.length}>
                <hr />
                <span class="eyebrow">hinted</span>
                <ul class="find-list">
                  <For each={s.hints}>{(h) => (
                    <li><span class="find-item">{h.item ?? "something"}</span><span class="find-sep"> at </span><span class="find-loc">{h.location}</span>{h.priority ? <span class="find-sep"> (priority)</span> : null}</li>
                  )}</For>
                </ul>
              </Show>
            </details>
          )}</For>
        </section>
      </Show>
    </div>
  );
}

export function Admin() {
  const syncFromHash = () => setAdminOpen(location.hash === "#admin");
  onMount(() => {
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    onCleanup(() => window.removeEventListener("hashchange", syncFromHash));
  });
  const close = () => { history.replaceState(null, "", location.pathname + location.search); setAdminOpen(false); };
  return (
    <Show when={adminOpen() && you()?.admin}>
      <div class="modal-backdrop">
        <div class="modal admin-modal" role="dialog" aria-modal="true" aria-label="admin">
          <div class="modal-head">
            <span class="modal-title">admin</span>
            <button class="modal-close" onClick={close} aria-label="close">✕</button>
          </div>
          <div class="modal-body"><AdminBody /></div>
        </div>
      </div>
    </Show>
  );
}
