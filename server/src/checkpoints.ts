// Copies of MultiServer's save (everything checked, every item sent, data
// storage) taken over the run, so an admin can put the game back to one.
// Each is a file in the checkpoints directory plus a row in the database.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { inflateSync } from "node:zlib";
import type { Db } from "./db.ts";
import type { CheckpointKind, CheckpointRow } from "../../shared/protocol.ts";

export interface SaveSource {
  readonly savePath: string;
  saveNow(): Promise<void>;
}

// A save MultiServer wrote completely: zlib all the way to its end. (Its
// periodic save can be part-way through rewriting the file as we copy it.)
function isWholeSave(bytes: Buffer): boolean {
  if (!bytes.length) return false;
  try { inflateSync(bytes); return true; } catch { return false; }
}

export class Checkpoints {
  private db: Db;
  private dir: string;
  private source: SaveSource;

  constructor(db: Db, dir: string, source: SaveSource) {
    this.db = db;
    this.dir = dir;
    this.source = source;
    mkdirSync(dir, { recursive: true });
  }

  private file(id: string) { return join(this.dir, `${id}.apsave`); }

  list(): CheckpointRow[] { return this.db.checkpoints(); }
  get(id: string): CheckpointRow | null { return this.db.checkpoint(id); }

  // Save the game now and keep a copy. `meta` is what the game looked like
  // at the time, for the list.
  async take(meta: { label: string; kind: CheckpointKind; sessionId: string | null; checked: number; total: number; complete: boolean }): Promise<CheckpointRow> {
    await this.source.saveNow();
    let bytes: Buffer | null = null;
    for (let attempt = 0; attempt < 5 && !bytes; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 200));
      const read = readFileSync(this.source.savePath);
      if (isWholeSave(read)) bytes = read;
    }
    if (!bytes) throw new Error("couldn't read a complete save from the game server");
    const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const tmp = `${this.file(id)}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, this.file(id));
    const row: CheckpointRow = { id, createdAt: Date.now(), size: bytes.length, ...meta };
    try { this.db.addCheckpoint(row); }
    catch (err) { rmSync(this.file(id), { force: true }); throw err; }
    return row;
  }

  // Put a checkpoint's save where MultiServer will load it. Only while
  // MultiServer is stopped (see MultiServer.restartWith).
  install(id: string) {
    const src = this.file(id);
    if (!existsSync(src) || !isWholeSave(readFileSync(src))) throw new Error(`checkpoint ${id}'s save is missing or damaged`);
    const tmp = `${this.source.savePath}.restore`;
    copyFileSync(src, tmp);
    renameSync(tmp, this.source.savePath);
  }
}
