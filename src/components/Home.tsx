import { For, Match, Show, Switch, createSignal, onCleanup, type JSX } from "solid-js";
import { app, you, publicState, meLoaded, loginUrl, liveConnected, endedNotice, prep, clockOffset, playStatus } from "../state.js";
import { handleRomDrop, joinQueue, leaveQueue, startTurn, prepareRom, resumeTurn } from "../actions.js";
import { END_REASON_TEXT, type Find, type PublicUser, type SessionSummary } from "../../shared/protocol.js";
import { Dropzone } from "./Dropzone.jsx";

// The server's time, ticking once a second for as long as the calling
// component is mounted: use it (or <Countdown>) only inside what shows a
// countdown, so nothing ticks while none is on screen.
export function useNow() {
  const [now, setNow] = createSignal(Date.now());
  const t = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(t));
  return () => now() + clockOffset();
}

export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function formatAway(seconds: number): string {
  if (seconds % 60 === 0) return seconds === 60 ? "a minute" : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

// Time left until a server deadline, as m:ss, ticking while it's shown.
export function Countdown(props: { to: number }) {
  const now = useNow();
  return <>{formatCountdown(props.to - now())}</>;
}

export function UserBadge(props: { user: PublicUser; small?: boolean }) {
  return (
    <span class="user-badge" data-small={props.small ? "true" : undefined}>
      <Show when={props.user.avatar} fallback={<span class="avatar avatar-blank" aria-hidden="true"></span>}>
        <img class="avatar" src={props.user.avatar!} alt="" referrerpolicy="no-referrer" />
      </Show>
      <span class="user-name">{props.user.name}</span>
    </span>
  );
}

// n of limit checks, as pips.
export function ChecksMeter(props: { checks: number; limit: number }) {
  return (
    <span class="checks-meter" title={`${props.checks} of ${props.limit} checks used`}>
      <For each={Array.from({ length: props.limit }, (_, i) => i)}>{(i) => (
        <span class="pip" data-on={i < props.checks ? "true" : undefined}></span>
      )}</For>
      <span class="checks-count">{props.checks}/{props.limit}</span>
    </span>
  );
}

export function FindList<T extends Find>(props: { finds: T[]; empty?: string; who?: (f: T) => JSX.Element }) {
  return (
    <Show when={props.finds.length > 0} fallback={<p class="muted">{props.empty ?? "nothing found yet"}</p>}>
      <ul class="find-list">
        <For each={props.finds}>{(f) => (
          <li data-undone={f.undone ? "true" : undefined} title={f.undone ? "undone by a rollback" : undefined}>
            <Show when={props.who}>{props.who!(f)}</Show>
            <span class="find-item">{f.item ?? "something"}</span>
            <Show when={f.receiver}><span class="find-receiver"> for {f.receiver}</span></Show>
            <span class="find-sep"> at </span>
            <span class="find-loc">{f.location}</span>
          </li>
        )}</For>
      </ul>
    </Show>
  );
}

function Blurb() {
  const limit = () => publicState()?.checkLimit ?? 10;
  return (
    <aside class="blurb">
      <h1><span class="blurb-title">You only get one slot</span><br /><em>one game, everyone's turn.</em></h1>
      <p>A single Pokémon Crystal Archipelago slot, played in relay. Everyone takes one turn, one at a time.</p>
      <ul class="blurb-list">
        <li>Sign in with Discord and join the queue. When it's your turn you have a few minutes to start.</li>
        <li>You start a <b>fresh save</b>, with every item the players before you found already in your bag.</li>
        <li>Your turn ends after <b>{limit()} new checks</b>. Locations someone already checked don't count.</li>
        <li>You get <b>one turn, ever</b>. Your save is deleted when it ends.</li>
        <li>You can connect one <b>PopTracker</b> alongside the game. Connecting a second, or anything else, ends your turn on the spot.</li>
        <li>If the game loses its connection it pauses; stay away too long and your turn ends.</li>
      </ul>
    </aside>
  );
}

function AccountCard() {
  return (
    <Show when={meLoaded() && !you()}>
      <div class="home-card">
        <div class="card-head"><span class="eyebrow">sign in</span></div>
        <p class="tip">Sign in with Discord to join the queue. Only your Discord name and avatar are used.</p>
        <div><a class="btn btn-primary btn-discord" href={loginUrl()}>sign in with discord</a></div>
      </div>
    </Show>
  );
}

function NowPlayingCard() {
  const ps = () => publicState();
  return (
    <div class="home-card">
      <div class="card-head">
        <span class="eyebrow">now playing</span>
      </div>
      <Show when={!liveConnected() && you()}>
        <p class="muted">reconnecting to the server…</p>
      </Show>
      <Show when={ps()} fallback={<p class="muted">loading…</p>}>
        <Show when={ps()!.complete}>
          <p class="victory">The goal is complete. Thanks to everyone who took a turn!</p>
        </Show>
        <Show when={!ps()!.serverReady && !ps()!.complete}>
          <p class="muted">{ps()!.serverProblem ? `the game can't start: ${ps()!.serverProblem}` : "the game server is starting up…"}</p>
        </Show>
        <Show when={ps()!.current} fallback={
          <Show when={ps()!.offered} fallback={<p class="muted">{ps()!.complete ? "" : "nobody is playing right now"}</p>}>
            <div class="now-row">
              <UserBadge user={ps()!.offered!.user} />
              <span class="muted">has <Countdown to={ps()!.offered!.expiresAt} /> to start their turn</span>
            </div>
          </Show>
        }>
          <div class="now-row">
            <UserBadge user={ps()!.current!.user} />
            <ChecksMeter checks={ps()!.current!.checks} limit={ps()!.checkLimit} />
          </div>
          <div class="now-flags">
            <span data-on={ps()!.current!.gameConnected ? "true" : undefined}>game {ps()!.current!.gameConnected ? "connected" : "disconnected"}</span>
            <span data-on={ps()!.current!.trackerConnected ? "true" : undefined}>poptracker {ps()!.current!.trackerConnected ? "connected" : "not connected"}</span>
          </div>
        </Show>
        <Show when={ps()!.paused && !ps()!.complete}>
          <p class="muted">the queue is paused by an admin</p>
        </Show>
        <div class="queue-block">
          <span class="eyebrow">queue ({ps()!.queue.length})</span>
          <Show when={ps()!.queue.length > 0} fallback={<p class="muted">nobody waiting</p>}>
            <ol class="queue-list">
              <For each={ps()!.queue}>{(u) => <li><UserBadge user={u} small /></li>}</For>
            </ol>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function SessionSummaryView(props: { s: SessionSummary }) {
  return (
    <>
      <Show when={props.s.reason}>
        <p class="tip">Your turn ended: {END_REASON_TEXT[props.s.reason!]}{props.s.detail ? ` (${props.s.detail})` : ""}.</p>
      </Show>
      <span class="eyebrow">what you found</span>
      <FindList finds={props.s.finds} empty="no new checks" />
    </>
  );
}

function TurnCard() {
  const y = () => you();
  // What this tab is doing with the player's running turn, when the game
  // isn't showing: starting it, failed to, or found it open in another tab.
  const statusHere = () => {
    const session = y()?.session, st = playStatus();
    return session && app.step !== "play" && st?.sessionId === session.id ? st.kind : null;
  };
  const ps = () => publicState();
  const ready = () => prep().kind === "ready";
  return (
    <Show when={y()}>
      <div class="home-card turn-card" data-urgent={y()!.offer ? "true" : undefined}>
        <div class="card-head"><span class="eyebrow">your turn</span></div>
        {/* Until the turn's summary arrives (which then says how it ended, and
            stays right if an admin settles a reported goal later). */}
        <Show when={endedNotice() && !y()!.lastSession}>
          <div class="error-box" role="status">
            <span class="err-title">turn over</span>
            <span>{END_REASON_TEXT[endedNotice()!.reason]}{endedNotice()!.detail ? ` — ${endedNotice()!.detail}` : ""}</span>
          </div>
        </Show>
        {/* Branches, not one big expression: each branch's buttons are only
            rebuilt when the branch changes, never by the countdown ticking or
            an unrelated broadcast (a click mustn't land on a stale button). */}
        <Switch>
          <Match when={y()!.banned}>
            <p class="tip">You can't take part in this event.</p>
          </Match>
          <Match when={statusHere() === "starting"}>
            <p class="tip">Starting your turn…</p>
          </Match>
          <Match when={statusHere() === "other-tab"}>
            <p class="tip">Your turn is open in another tab of this browser. Play there (or close it, then reload this one).</p>
          </Match>
          <Match when={statusHere() === "failed"}>
            <p class="tip">Your turn has started, but the game couldn't be set up in this tab (see the log). Your turn's clock is running.</p>
            <div><button class="btn-primary" onClick={resumeTurn}>try again</button></div>
          </Match>
          <Match when={y()!.session && app.step !== "play"}>
            <p class="tip">Your turn is running somewhere else: another tab, browser or device. Playing here takes over from it (its game pauses), and this browser starts from its own save.</p>
            <div><button class="btn-primary" onClick={resumeTurn}>play here</button></div>
          </Match>
          <Match when={y()!.attemptUsed && !y()!.session}>
            <p class="tip">You've had your turn. Thanks for playing!</p>
            <Show when={y()!.lastSession}><SessionSummaryView s={y()!.lastSession!} /></Show>
          </Match>
          <Match when={ps()?.complete}>
            <p class="tip">The goal is complete, so there are no more turns.</p>
          </Match>
          <Match when={y()!.offer}>
            <p class="tip"><strong>It's your turn!</strong> Start within <Countdown to={y()!.offer?.expiresAt ?? 0} /> or it passes to the next player, and you'd have to join the queue again. Missing it doesn't use up your turn.</p>
            <div class="turn-actions">
              <button class="btn-primary" disabled={!ready()} onClick={startTurn}>start my turn</button>
              <button onClick={leaveQueue}>pass</button>
            </div>
            <Show when={!ready()}><p class="muted">your ROM needs to be ready before you can start — see below</p></Show>
          </Match>
          <Match when={y()!.inQueue}>
            <p class="tip">You're <strong>#{y()!.position}</strong> in the queue. Keep this tab open: closing it for more than {formatAway(ps()?.queueAbsentSeconds ?? 60)} drops you from the queue.</p>
            <div class="turn-actions"><button onClick={leaveQueue}>leave the queue</button></div>
          </Match>
          <Match when={!y()!.session}>
            <p class="tip">You haven't had your turn yet. Join the queue when you're ready to play; it starts as soon as the people ahead of you are done.</p>
            <div class="turn-actions"><button class="btn-primary" onClick={joinQueue}>join the queue</button></div>
          </Match>
        </Switch>
      </div>
    </Show>
  );
}

function RomCard() {
  const show = () => {
    const y = you();
    return !!y && !y.banned && (!y.attemptUsed || !!y.session) && !publicState()?.complete;
  };
  return (
    <Show when={show()}>
      <div class="home-card" data-pane="rom">
        <div class="card-head">
          <span class="eyebrow">your rom</span>
          <Show when={app.runningApworld}><span class="eyebrow">apworld v{app.runningApworld}</span></Show>
        </div>
        <Show when={prep().kind === "ready"}>
          <p class="tip">Your ROM is patched and ready to go.</p>
        </Show>
        <Show when={prep().kind === "saved"}>
          <p class="tip">Your ROM is saved. It'll be patched when you join the queue.</p>
        </Show>
        <Show when={prep().kind === "need-rom"}>
          <p class="tip">Get your ROM ready while you wait.</p>
          <p class="legend">accepts: <kbd>.gbc</kbd> · Crystal v1.0 or v1.1</p>
        </Show>
        <Show when={prep().kind === "need-rom"}>
          <Dropzone id="dz-rom" inputId="rom-file" accept=".gbc,.gb,application/octet-stream" onFile={handleRomDrop}>
            <div class="dz-mark">▱</div>
            <div class="dz-primary">Drop vanilla Pokémon Crystal ROM</div>
          </Dropzone>
        </Show>
        <Show when={prep().kind === "working"}>
          <div class="rom-progress" id="rom-progress">
            <span class="spinner" aria-hidden="true">◐</span>
            <span id="rom-progress-text">{(prep() as any).text}</span>
          </div>
        </Show>
        <Show when={prep().kind === "error" || (app.rom.error && (prep().kind === "need-rom" || prep().kind === "saved"))}>
          <div class="error-box" id="rom-err">
            <span class="err-title">rom not ready</span>
            <span id="rom-err-msg">{prep().kind === "error" ? (prep() as any).message : app.rom.error}</span>
          </div>
          <Show when={prep().kind === "error"}>
            <div><button onClick={() => prepareRom()}>try again</button></div>
          </Show>
        </Show>
      </div>
    </Show>
  );
}

export function Home() {
  return (
    <section class="home">
      <Blurb />
      <div class="home-main">
        <AccountCard />
        <TurnCard />
        <RomCard />
        <NowPlayingCard />
      </div>
    </section>
  );
}
