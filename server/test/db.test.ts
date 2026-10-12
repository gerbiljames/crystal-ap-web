import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../src/db.ts";

function withTurns() {
  const db = new Db(":memory:");
  for (const id of ["ann", "bob"]) db.upsertUser({ id, name: id, avatar: null });
  db.createSession({ id: "s1", userId: "ann", startedAt: 1, gamePw: "a", trackerPw: "b" });
  db.createSession({ id: "s2", userId: "bob", startedAt: 5, gamePw: "c", trackerPw: "d" });
  return db;
}

test("a rollback undoes the finds the server no longer has, and only those", () => {
  const db = withTurns();
  db.addFind("s1", 10, "a", 2);
  db.addFind("s2", 20, "b", 6);
  db.addFind("s2", 21, "c", 7);
  assert.equal(db.settleFinds([10]), 2);
  assert.deepEqual(db.finds("s2"), [], "players don't see undone finds");
  assert.deepEqual(db.recentFinds(10).map((f) => f.location), ["a"]);
  assert.deepEqual(db.findLocationIds(), [10]);
  assert.deepEqual(db.sessions().find((s) => s.id === "s2")!.finds.map((f) => f.undone), [true, true], "admins do");
  assert.deepEqual(db.usersWithTurnsSince(2), ["bob"]);
  // Undoing the rollback brings them back.
  assert.equal(db.settleFinds([10, 20, 21]), 0);
  assert.equal(db.finds("s2").length, 2);
});

test("a check taken back and made again belongs to whoever made it again", () => {
  const db = withTurns();
  db.addFind("s1", 10, "a", 2);
  db.settleFinds([]);
  db.addFind("s2", 10, "a", 6);
  assert.equal(db.settleFinds([10]), 0);
  assert.deepEqual(db.finds("s1"), []);
  assert.equal(db.finds("s2").length, 1);
});
