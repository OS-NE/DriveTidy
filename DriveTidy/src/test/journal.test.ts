import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect } from "vitest";
import { openJournal, type BatchRecord, type OpRecord } from "@/lib/journal";
import { classify, type Observation } from "@/lib/recovery";
import { withRootLock, LockUnavailable } from "@/lib/oplock";

const batch = (id: string, status: BatchRecord["status"] = "completed"): BatchRecord => ({
  id, kind: "restructure", rootId: "r", title: "t", createdAt: Date.now(), updatedAt: Date.now(),
  status, visibility: "active", irreversible: false, durability: "relaxed", counts: {}, schema: 1,
});
const ok = (o: Partial<Observation>): Observation => ({ access: "ok", source: "match", dest: "absent", ...o });

describe("journal", () => {
  it("round-trips a batch and flags corrupt records as unreadable", async () => {
    const j = await openJournal(new IDBFactory());
    await j.putBatch(batch("a"));
    await j.commit(["batches"], (s) => { s.batches.put({ id: "bad", schema: 99 }); });
    const rows = await j.listBatches();
    expect(rows.find((r) => r.id === "a" && !("unreadable" in r))).toBeTruthy();
    expect(rows.find((r) => r.id === "bad")).toMatchObject({ unreadable: true });
  });
  it("persists complete destination paths while remaining compatible with legacy rows", async () => {
    const j = await openJournal(new IDBFactory());
    const op: OpRecord = {
      id: "op-1", txId: "tx-1", batchId: "b-1", seq: 0, action: "move",
      fromDir: "Photos/2024", fromName: "a.jpg", toDir: "2024",
      toPath: "Organized/Photos/2024", intendedName: "a.jpg", size: 10,
      lastModified: 1, sourceSha256: "abc",
      identity: { source: "handle", staging: "unconfirmed", final: "unconfirmed" },
      state: "hashed", updatedAt: Date.now(),
    };
    await j.putOp(op);
    expect(await j.opsFor("b-1")).toMatchObject([{ toPath: "Organized/Photos/2024" }]);
    await j.putOp({ ...op, id: "legacy", toPath: undefined });
    expect((await j.opsFor("b-1")).find((row) => row.id === "legacy")?.toPath).toBeUndefined();
  });
  it("exports portable history without live file handles and imports it as isolated archive", async () => {
    const source = await openJournal(new IDBFactory());
    const originalBatch = { ...batch("source-batch", "interrupted"), rootId: "root:disk" };
    await source.putRoot({ id: "root:disk", name: "disk", firstSeen: 1, handle: { name: "disk" } as FileSystemDirectoryHandle });
    await source.putBatch(originalBatch);
    const originalOp: OpRecord = {
      id: "source-op", txId: "source-tx", batchId: originalBatch.id, seq: 0, action: "move",
      fromDir: "Photos", fromName: "one.jpg", toDir: "Sorted", toPath: "Archive/Photos",
      intendedName: "one.jpg", size: 42, lastModified: 2, sourceSha256: "a".repeat(64),
      sourceHandle: { name: "one.jpg" } as FileSystemFileHandle,
      identity: { source: "handle", staging: "unconfirmed", final: "unconfirmed" },
      state: "hashed", updatedAt: 3,
    };
    await source.putOp(originalOp);
    await source.putDir({ id: "dir-1", opId: originalOp.id, path: "Archive", state: "created", intentAt: 3 });
    const backup = await source.exportBackup();
    expect(backup).not.toContain("sourceHandle");
    expect(backup).not.toContain('"handle":');

    const target = await openJournal(new IDBFactory());
    const imported = await target.importBackup(backup);
    expect(imported).toEqual({ batches: 1, operations: 1, directories: 1 });
    const rows = await target.listBatches();
    expect(rows).toHaveLength(1);
    const archived = rows[0] as BatchRecord;
    expect(archived).toMatchObject({ status: "interrupted", visibility: "archived", importedAt: expect.any(Number) });
    expect(archived.id).not.toBe(originalBatch.id);
    const importedRoot = await target.getRoot(archived.rootId);
    expect(importedRoot?.handle).toBeUndefined();
    const [op] = await target.opsFor(archived.id);
    expect(op).toMatchObject({ fromName: "one.jpg", toPath: "Archive/Photos" });
    expect(op.sourceHandle).toBeUndefined();
    expect(op.identity).toEqual({ source: "unconfirmed", staging: "unconfirmed", final: "unconfirmed" });
  });

  it("rejects malformed backups without changing existing history", async () => {
    const target = await openJournal(new IDBFactory());
    await target.putBatch(batch("existing"));
    await expect(target.importBackup('{"format":"wrong","version":1}')).rejects.toThrow();
    expect((await target.listBatches()).map((row) => row.id)).toEqual(["existing"]);
  });

  it("removes directory journal rows together with an explicitly deleted finished record", async () => {
    const j = await openJournal(new IDBFactory());
    await j.putBatch(batch("finished"));
    await j.putOp({
      id: "finished-op", txId: "tx", batchId: "finished", seq: 0, action: "move",
      fromDir: "", fromName: "a", toDir: "", intendedName: "a", size: 1,
      lastModified: 1, sourceSha256: "a".repeat(64),
      identity: { source: "unconfirmed", staging: "unconfirmed", final: "unconfirmed" },
      state: "hashed", updatedAt: 1,
    });
    await j.putDir({ id: "finished-dir", opId: "finished-op", path: "folder", state: "created", intentAt: 1 });
    await j.deleteRecord("finished");
    const backup = JSON.parse(await j.exportBackup()) as { dirs: unknown[] };
    expect(backup.dirs).toEqual([]);
  });

  it("rejects a failed commit", async () => {
    const j = await openJournal(new IDBFactory());
    await expect(j.commit(["batches"], () => { throw new Error("boom"); })).rejects.toThrow();
  });
  it("dismiss keeps the record; unfinished records cannot be deleted", async () => {
    const j = await openJournal(new IDBFactory());
    await j.putBatch(batch("u", "interrupted"));
    await j.setVisibility("u", "dismissed");
    expect((await j.listBatches())[0]).toMatchObject({ id: "u", visibility: "dismissed" });
    await expect(j.deleteRecord("u")).rejects.toThrow();
  });
});

describe("recovery classification", () => {
  it.each([
    ["hashed", ok({}), "not-started"],
    ["hashed", ok({ source: "match", dest: "absent" }), "not-started"],
    ["hashed", ok({ source: "absent", dest: "match" }), "probable-completion"],
    ["hashed", ok({ source: "differs" }), "conflict"],
    ["hashed", ok({ source: "match", dest: "differs" }), "needs-review"],
    ["native-intent", ok({ source: "absent", dest: "match", destSame: true }), "completed"],
    ["native-intent", ok({ source: "absent", dest: "match" }), "probable-completion"],
    ["native-moved", ok({ source: "absent", dest: "match", destSame: true }), "completed"],
    ["native-moved", ok({ source: "absent", dest: "differs" }), "needs-review"],
    ["staging-intent", ok({ staging: "present" }), "needs-review"],
    ["copied", ok({ staging: "present", stagingSame: true }), "reverted-safe"],
    ["copied", ok({ staging: "present" }), "needs-review"],
    ["final-create-intent", ok({ dest: "differs" }), "needs-review"],
    ["final-copying", ok({ dest: "differs", destSame: true, stagingVerified: true }), "partial-final"],
    ["final-copying", ok({ dest: "differs", stagingVerified: true }), "needs-review"],
        ["placed", ok({ dest: "match" }), "awaiting-finalize"],
    ["delete-intent", ok({ source: "absent" }), "deletion-unconfirmed"],
    ["delete-intent", ok({}), "not-deleted"],
    ["create-intent", ok({ dirPresent: true }), "dir-ownership-unknown"],
    ["hashed", ok({ source: "absent" }), "needs-review"],
    ["hashed", { access: "missing", source: "absent", dest: "absent" } as Observation, "waiting-for-access"],
  ])("%s with %j → %s", (state, obs, outcome) => {
    expect(classify(state as string, obs as Observation).outcome).toBe(outcome);
  });
  it("never offers deletion for unproven leftovers", () => {
    expect(classify("copied", ok({ staging: "present" })).actions).toEqual([]);
  });
});

describe("root lock", () => {
  it("blocks a second holder and refuses without Web Locks", async () => {
    let held = false;
    const fake = { request: async (_n: string, _o: unknown, cb: (l: unknown) => Promise<unknown>) => { if (held) return cb(null); held = true; try { return await cb({}); } finally { held = false; } } };
    await withRootLock("r", async () => {
      await expect(withRootLock("r", async () => 1, fake)).rejects.toBeInstanceOf(LockUnavailable);
    }, fake);
    await expect(withRootLock("r", async () => 1, undefined as never)).rejects.toBeInstanceOf(LockUnavailable);
  });
});
