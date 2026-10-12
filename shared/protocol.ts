// Shapes exchanged between the browser and the YOGOS server: the JSON bodies of
// the /api routes and the messages pushed over the /api/live socket. Imported
// by both sides, so keep it to types and plain constants.

export type PublicUser = {
  id: string;
  name: string;
  avatar: string | null;
};

// Why a session ended.
export type EndReason =
  | "quota"      // reached the check limit
  | "grace"      // the game client stayed disconnected past the grace period
  | "violation"  // something other than the game client or PopTracker used the credentials
  | "gave-up"    // the player ended it themselves
  | "admin"      // an admin ended it
  | "goal"       // the game reported the slot's goal: the event is complete
  | "server";    // the server shut down or lost MultiServer mid-session

export const END_REASON_TEXT: Record<EndReason, string> = {
  "quota": "you used all of your checks",
  "grace": "the game was disconnected for too long",
  "violation": "something other than the game or PopTracker connected with your session's details",
  "gave-up": "you ended the session",
  "admin": "an admin ended the session",
  "goal": "the goal was completed",
  "server": "the server stopped during the session",
};

// The same, for admins reading about someone else's turn.
export const END_REASON_ADMIN_TEXT: Record<EndReason, string> = {
  "quota": "used all their checks",
  "grace": "the game was disconnected too long",
  "violation": "another client used the turn's details",
  "gave-up": "the player ended it",
  "admin": "ended by an admin",
  "goal": "goal completed",
  "server": "the server stopped during it",
};

// One location checked during a session, with what it held when the server
// could tell us (a scout of the location after it was checked).
export type Find = {
  location: string;
  item: string | null;
  // Who received the item, when it is not the slot itself (multi-slot seeds).
  receiver: string | null;
  at: number;
  // Taken back by a rollback: the server no longer has this check. (Only
  // admins are shown these.)
  undone?: boolean;
};

// A hint a player made at the end of their turn, and what was there.
export type HintMade = {
  location: string;
  item: string | null;
  // Hinted as priority: the item is progression.
  priority: boolean;
};

export type SessionSummary = {
  id: string;
  user: PublicUser;
  startedAt: number;
  endedAt: number | null;
  reason: EndReason | null;
  detail: string | null;
  finds: Find[];
  // The hints made after the turn (for the player themselves and admins).
  hints?: HintMade[];
};

// What everyone sees: who is playing, who is waiting, and recent finds.
export type PublicState = {
  // Identifies the seed being played: a page holding a ROM patched for an
  // earlier one patches again.
  seed: string;
  checkLimit: number;
  // Hints a turn that uses all its checks may make (less its progression items).
  hintsPerTurn: number;
  // Admin paused the queue: the current session (if any) carries on, but
  // nobody new is offered a turn.
  paused: boolean;
  // The slot reached its goal; the event is over.
  complete: boolean;
  // How long a queued player may have no page open before losing their place.
  queueAbsentSeconds: number;
  // MultiServer is up and the observer is connected.
  serverReady: boolean;
  // Why the seed can't be played here (a setup mistake for the admin), if so.
  serverProblem: string | null;
  current: {
    sessionId: string;
    user: PublicUser;
    startedAt: number;
    checks: number;
    gameConnected: boolean;
    trackerConnected: boolean;
  } | null;
  // The player whose turn it is but who hasn't started yet.
  offered: { user: PublicUser; expiresAt: number } | null;
  // The player who just used all their checks, choosing hints before the
  // next turn is offered.
  hinting: { user: PublicUser } | null;
  queue: PublicUser[];
  // Newest first, across all sessions.
  recent: (Find & { who: PublicUser })[];
  totals: { checked: number; total: number };
};

export type Credentials = {
  // What the browser's game client connects to.
  apUrl: string;
  // The address PopTracker users type in (host:port).
  apAddress: string;
  slot: string;
  gamePassword: string;
  trackerPassword: string;
};

// What one signed-in user sees about themselves.
export type YouState = {
  user: PublicUser;
  admin: boolean;
  banned: boolean;
  attemptUsed: boolean;
  inQueue: boolean;
  // 1-based, among the people waiting (excluding an offered turn).
  position: number | null;
  offer: { expiresAt: number } | null;
  session: {
    id: string;
    startedAt: number;
    checks: number;
    finds: Find[];
    gameConnected: boolean;
    trackerConnected: boolean;
    // Set while the game client is disconnected: the session ends at this time
    // unless it reconnects.
    graceEndsAt: number | null;
    // The device claim currently holding the turn (null before any claim). A
    // page resumes the turn by itself only if it holds this claim.
    holder: string | null;
    credentials: Credentials;
  } | null;
  // The user's own finished session, once they've had their go.
  lastSession: SessionSummary | null;
  // Set while it's this user's turn to choose hints (their turn used all its
  // checks): how many they may make.
  hints: HintAllowance | null;
};

// A turn that used all its checks may hint `allowance` locations: the hints
// per turn, less the progression items the turn found.
export type HintAllowance = {
  allowance: number;
  perTurn: number;
  progressionFound: number;
};

// What the player choosing hints may pick from: the slot's locations nobody
// has checked or hinted.
export type HintOptions = HintAllowance & {
  locations: { id: number; name: string }[];
};

export type ServerMessage =
  // `now`: the server's clock when this was sent. Deadlines in the state are
  // server times; clients count down against this, not their own clock.
  | { type: "public"; now: number; state: PublicState }
  | { type: "you"; you: YouState | null }
  // Sent once to the owner when their session ends, ahead of the "you" update
  // that clears it, so the client can tear down even if it missed the change.
  | { type: "session-ended"; sessionId: string; reason: EndReason; detail: string | null };

export type MeResponse = {
  you: YouState | null;
  loginUrl: string;
};

export type AdminUserRow = {
  user: PublicUser;
  attemptUsed: boolean;
  banned: boolean;
  createdAt: number;
};

// Why a checkpoint was taken.
//   start:  when the game server was first seen, before anyone played.
//   turn:   after a turn ended.
//   manual: by an admin.
//   before-rollback: just before a rollback, so it can be undone.
export type CheckpointKind = "start" | "turn" | "manual" | "before-rollback";

export type CheckpointRow = {
  id: string;
  createdAt: number;
  label: string;
  kind: CheckpointKind;
  // The turn it was taken after (kind "turn").
  sessionId: string | null;
  // Locations checked at the time, out of the total.
  checked: number;
  total: number;
  // Whether the goal had been confirmed.
  complete: boolean;
  size: number;
};

export type AdminState = {
  // Who is choosing hints, and how many they may make.
  hinting: (HintAllowance & { user: PublicUser }) | null;
  sessions: SessionSummary[];
  users: AdminUserRow[];
  checkpoints: CheckpointRow[];
  // A checkpoint or rollback is under way.
  checkpointBusy: boolean;
};

export type RollbackResult = {
  // Checks the rollback took back.
  undone: number;
  // Players given their turn back.
  turnsReturned: number;
};
