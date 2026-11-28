// Persistent operation journal (IndexedDB). File-changing workflows write durable intent and completion records.
// A step counts as committed only on transaction `oncomplete`. Safety-critical commits request
// durability "strict" (a browser hint, not an absolute guarantee); unsupported → "relaxed".

export const DB_NAME = "drivetidy-journal";
export const DB_VERSION = 1;
export const SCHEMA = 1;

export type BatchKind =
  | "restructure"
  | "rename"
  | "duplicates-move"
  | "quarantine-move"
  | "delete"
  | "empty-folders"
  | "undo";
export type BatchStatus =
  | "running"
  | "stopped"
  | "interrupted"
  | "completed"
  | "completed-with-issues"
  | "resolved"
  | "undone";
export type Visibility = "active" | "dismissed" | "archived";
export type Durability = "strict" | "relaxed";

export interface RootRecord {
  id: string;
  handle?: FileSystemDirectoryHandle;
  name: string;
  firstSeen: number;
}
export interface BatchRecord {
  id: string;
  kind: BatchKind;
  rootId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: BatchStatus;
  visibility: Visibility;
  irreversible: boolean;
  durability: Durability;
  counts: Record<string, number>;
  schema: number;
  dryRun?: boolean;
  importedAt?: number;
}
export type Identity = "handle" | "unconfirmed";
export interface OpRecord {
  id: string;
  txId: string;
  batchId: string;
  seq: number;
  action: "move" | "rename" | "delete" | "rmdir" | "finalize" | "restore";
  fromDir: string;
  fromName: string;
  toDir: string;
  toPath?: string;
  intendedName: string;
  stagingName?: string;
  finalName?: string;
  size: number;
  lastModified: number;
  sourceSha256: string;
  copiedSha256?: string;
  finalSha256?: string;
  sourceHandle?: FileSystemFileHandle;
  stagingHandle?: FileSystemFileHandle;
  finalHandle?: FileSystemFileHandle;
  identity: { source: Identity; staging: Identity; final: Identity };
  state: string;
  error?: string;
  updatedAt: number;
  undoOf?: string;
}
export interface DirRecord {
  id: string;
  opId: string;
  path: string;
  state: "create-intent" | "created" | "observed-existing";
  handle?: FileSystemDirectoryHandle;
  intentAt: number;
}

export type Unreadable = { unreadable: true; id: string; raw: unknown };

export class JournalError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "JournalError";
  }
}

const UNFINISHED: BatchStatus[] = ["running", "stopped", "interrupted"];
export const isUnfinished = (b: BatchRecord) => UNFINISHED.includes(b.status);

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export function openJournal(factory: IDBFactory = indexedDB): Promise<Journal> {
  return new Promise((resolve, reject) => {
    let r: IDBOpenDBRequest;
    try {
      r = factory.open(DB_NAME, DB_VERSION);
    } catch (e) {
      return reject(new JournalError("History unavailable", e));
    }
    r.onupgradeneeded = (ev) => {
      const db = r.result;
      if (ev.oldVersion < 1) {
        db.createObjectStore("roots", { keyPath: "id" });
        db.createObjectStore("batches", { keyPath: "id" });
        const ops = db.createObjectStore("ops", { keyPath: "id" });
        ops.createIndex("batchId", "batchId");
        ops.createIndex("batchState", ["batchId", "state"]);
        ops.createIndex("txId", "txId");
        const dirs = db.createObjectStore("dirs", { keyPath: "id" });
        dirs.createIndex("opId", "opId");
      }
    };
    r.onerror = () => reject(new JournalError("History unavailable", r.error));
    r.onblocked = () => reject(new JournalError("History is open in an older DriveTidy window"));
    r.onsuccess = () => resolve(new Journal(r.result));
  });
}

type Store = "roots" | "batches" | "ops" | "dirs";

export class Journal {
  readonly durability: Durability;
  constructor(private db: IDBDatabase) {
    this.durability = Journal.detectDurability(db);
  }

  static detectDurability(db: IDBDatabase): Durability {
    try {
      const t = db.transaction(["batches"], "readonly", {
        durability: "strict",
      } as IDBTransactionOptions);
      const d = (t as IDBTransaction & { durability?: string }).durability;
      t.abort();
      return d === "strict" ? "strict" : "relaxed";
    } catch {
      return "relaxed";
    }
  }

  /** Commit writes; resolves only on oncomplete. Any abort/quota error rejects (caller must not mutate files). */
  commit(stores: Store[], write: (s: Record<Store, IDBObjectStore>) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      let t: IDBTransaction;
      try {
        t =
          this.durability === "strict"
            ? this.db.transaction(stores, "readwrite", {
                durability: "strict",
              } as IDBTransactionOptions)
            : this.db.transaction(stores, "readwrite");
      } catch (e) {
        return reject(new JournalError("Could not record step", e));
      }
      t.oncomplete = () => resolve();
      t.onabort = () => reject(new JournalError("Recording the step was aborted", t.error));
      t.onerror = () => {
        /* surfaced by onabort */
      };
      try {
        const map = {} as Record<Store, IDBObjectStore>;
        for (const s of stores) map[s] = t.objectStore(s);
        write(map);
      } catch (e) {
        try {
          t.abort();
        } catch {
          /* */
        }
        reject(new JournalError("Could not record step", e));
      }
    });
  }

  putBatch(b: BatchRecord) {
    return this.commit(["batches"], (s) => {
      s.batches.put(b);
    });
  }
  putOp(o: OpRecord) {
    return this.commit(["ops"], (s) => {
      s.ops.put(o);
    });
  }
  putDir(d: DirRecord) {
    return this.commit(["dirs"], (s) => {
      s.dirs.put(d);
    });
  }
  putRoot(r: RootRecord) {
    return this.commit(["roots"], (s) => {
      s.roots.put(r);
    });
  }

  async listBatches(): Promise<(BatchRecord | Unreadable)[]> {
    const all = await req(this.db.transaction("batches").objectStore("batches").getAll());
    const t = (r: BatchRecord | Unreadable) => ("unreadable" in r ? 0 : r.createdAt);
    return all.map(validateBatch).sort((a, b) => t(b) - t(a));
  }

  async opsFor(batchId: string): Promise<OpRecord[]> {
    const ops = await req(
      this.db.transaction("ops").objectStore("ops").index("batchId").getAll(batchId),
    );
    return (ops as OpRecord[]).sort((a, b) => a.seq - b.seq);
  }

  async getRoot(id: string): Promise<RootRecord | undefined> {
    return req(this.db.transaction("roots").objectStore("roots").get(id));
  }

  /** Export a portable JSON snapshot. Live filesystem handles are deliberately excluded. */
  async exportBackup(): Promise<string> {
    const tx = this.db.transaction(["roots", "batches", "ops", "dirs"], "readonly");
    const [roots, batches, ops, dirs] = await Promise.all([
      req(tx.objectStore("roots").getAll()),
      req(tx.objectStore("batches").getAll()),
      req(tx.objectStore("ops").getAll()),
      req(tx.objectStore("dirs").getAll()),
    ]);
    const clean = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(clean);
      if (!value || typeof value !== "object") return value;
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (key === "handle" || key.endsWith("Handle")) continue;
        out[key] = clean(item);
      }
      return out;
    };
    const validBatches = batches.map(validateBatch);
    if (validBatches.some((b) => "unreadable" in b)) {
      throw new JournalError(
        "Cannot export history containing unreadable batch records. Review or preserve the original device data first.",
      );
    }
    if (
      (roots as Array<RootRecord | null>).some(
        (r) =>
          !r ||
          typeof r.id !== "string" ||
          typeof r.name !== "string" ||
          typeof r.firstSeen !== "number",
      )
    ) {
      throw new JournalError("Cannot export history containing invalid root records.");
    }
    const rootIds = new Set((roots as RootRecord[]).map((r) => r.id));
    const batchIds = new Set((validBatches as BatchRecord[]).map((b) => b.id));
    if ((validBatches as BatchRecord[]).some((b) => !rootIds.has(b.rootId))) {
      throw new JournalError(
        "Cannot export history with broken root references. Preserve the original device data and review the journal.",
      );
    }
    const opIds = new Set<string>();
    for (const value of ops as Array<Record<string, unknown>>) {
      if (
        !value ||
        typeof value["id"] !== "string" ||
        typeof value["batchId"] !== "string" ||
        !batchIds.has(value["batchId"]) ||
        typeof value["txId"] !== "string" ||
        typeof value["fromDir"] !== "string" ||
        typeof value["fromName"] !== "string" ||
        typeof value["toDir"] !== "string" ||
        typeof value["intendedName"] !== "string" ||
        typeof value["sourceSha256"] !== "string" ||
        !/^[a-f0-9]{64}$/i.test(value["sourceSha256"]) ||
        typeof value["state"] !== "string" ||
        typeof value["size"] !== "number" ||
        typeof value["lastModified"] !== "number" ||
        typeof value["seq"] !== "number" ||
        !["move", "rename", "delete", "rmdir", "finalize", "restore"].includes(
          String(value["action"]),
        ) ||
        opIds.has(value["id"])
      ) {
        throw new JournalError("Cannot export history containing invalid operation records.");
      }
      opIds.add(value["id"]);
    }
    const portableDirs = (dirs as Array<DirRecord | null>).filter(
      (d): d is DirRecord => !!d && typeof d.opId === "string" && opIds.has(d.opId),
    );
    for (const value of portableDirs as unknown as Array<Record<string, unknown>>) {
      if (
        !value ||
        typeof value["id"] !== "string" ||
        typeof value["opId"] !== "string" ||
        !opIds.has(value["opId"]) ||
        typeof value["path"] !== "string" ||
        !["create-intent", "created", "observed-existing"].includes(String(value["state"])) ||
        typeof value["intentAt"] !== "number"
      ) {
        throw new JournalError("Cannot export history containing invalid directory records.");
      }
    }
    return JSON.stringify(
      {
        format: "drivetidy-journal-backup",
        version: 1,
        exportedAt: Date.now(),
        roots: clean(roots),
        batches: clean(batches),
        ops: clean(ops),
        dirs: clean(portableDirs),
      },
      null,
      2,
    );
  }

  /**
   * Import as archived, non-actionable history. Every imported root receives a fresh ID and
   * no filesystem handles are restored, so a backup can never silently authorize file changes.
   */
  async importBackup(
    json: string,
  ): Promise<{ batches: number; operations: number; directories: number }> {
    if (json.length > 50 * 1024 * 1024)
      throw new JournalError("Backup is larger than the 50 MB import limit");
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch (e) {
      throw new JournalError("Backup is not valid JSON", e);
    }
    if (!data || typeof data !== "object")
      throw new JournalError("Backup has an invalid structure");
    const backup = data as Record<string, unknown>;
    if (
      backup["format"] !== "drivetidy-journal-backup" ||
      backup["version"] !== 1 ||
      !Array.isArray(backup["roots"]) ||
      !Array.isArray(backup["batches"]) ||
      !Array.isArray(backup["ops"]) ||
      !Array.isArray(backup["dirs"])
    ) {
      throw new JournalError("Unsupported or malformed DriveTidy backup");
    }
    if (
      backup["roots"].length > 10000 ||
      backup["batches"].length > 100000 ||
      backup["ops"].length > 500000 ||
      backup["dirs"].length > 100000
    ) {
      throw new JournalError("Backup contains too many records");
    }

    const roots = backup["roots"] as Array<Record<string, unknown>>;
    const rootMap = new Map<string, string>();
    const importedRoots: RootRecord[] = [];
    for (const raw of roots) {
      if (
        !raw ||
        typeof raw["id"] !== "string" ||
        typeof raw["name"] !== "string" ||
        typeof raw["firstSeen"] !== "number" ||
        rootMap.has(raw["id"])
      ) {
        throw new JournalError("Backup contains an invalid or duplicate root record");
      }
      const id = `import:${crypto.randomUUID()}`;
      rootMap.set(raw["id"], id);
      importedRoots.push({ id, name: raw["name"], firstSeen: raw["firstSeen"] });
    }

    const batches = backup["batches"] as Array<Record<string, unknown>>;
    const batchMap = new Map<string, string>();
    const importedBatches: BatchRecord[] = [];
    for (const raw of batches) {
      const validated = validateBatch(raw);
      if (
        "unreadable" in validated ||
        typeof raw["id"] !== "string" ||
        typeof raw["rootId"] !== "string" ||
        !rootMap.has(raw["rootId"]) ||
        typeof raw["title"] !== "string" ||
        typeof raw["createdAt"] !== "number" ||
        typeof raw["updatedAt"] !== "number" ||
        typeof raw["irreversible"] !== "boolean" ||
        !raw["counts"] ||
        typeof raw["counts"] !== "object" ||
        ![
          "restructure",
          "rename",
          "duplicates-move",
          "quarantine-move",
          "delete",
          "empty-folders",
          "undo",
        ].includes(String(raw["kind"])) ||
        ![
          "running",
          "stopped",
          "interrupted",
          "completed",
          "completed-with-issues",
          "resolved",
          "undone",
        ].includes(String(raw["status"])) ||
        !["strict", "relaxed"].includes(String(raw["durability"]))
      ) {
        throw new JournalError("Backup contains an invalid batch or an unknown root reference");
      }
      if (batchMap.has(raw["id"])) throw new JournalError("Backup contains duplicate batch IDs");
      const id = `import:${crypto.randomUUID()}`;
      batchMap.set(raw["id"], id);
      importedBatches.push({
        ...validated,
        id,
        rootId: rootMap.get(raw["rootId"])!,
        status: isUnfinished(validated) ? "interrupted" : validated.status,
        visibility: "archived",
        importedAt: Date.now(),
      });
    }

    const importedOps: OpRecord[] = [];
    const opMap = new Map<string, string>();
    const seenOps = new Set<string>();
    for (const value of backup["ops"]) {
      if (!value || typeof value !== "object")
        throw new JournalError("Backup contains an invalid operation");
      const raw = value as Record<string, unknown>;
      if (
        typeof raw["id"] !== "string" ||
        typeof raw["batchId"] !== "string" ||
        typeof raw["txId"] !== "string" ||
        !batchMap.has(raw["batchId"]) ||
        typeof raw["fromDir"] !== "string" ||
        typeof raw["fromName"] !== "string" ||
        typeof raw["toDir"] !== "string" ||
        typeof raw["intendedName"] !== "string" ||
        typeof raw["sourceSha256"] !== "string" ||
        !/^[a-f0-9]{64}$/i.test(raw["sourceSha256"]) ||
        typeof raw["state"] !== "string" ||
        typeof raw["size"] !== "number" ||
        typeof raw["lastModified"] !== "number" ||
        typeof raw["seq"] !== "number" ||
        !["move", "rename", "delete", "rmdir", "finalize", "restore"].includes(
          String(raw["action"]),
        ) ||
        seenOps.has(raw["id"])
      ) {
        throw new JournalError("Backup contains an invalid or duplicate operation record");
      }
      seenOps.add(raw["id"]);
      const importedId = `import:${crypto.randomUUID()}`;
      opMap.set(raw["id"], importedId);
      const {
        sourceHandle: _source,
        stagingHandle: _staging,
        finalHandle: _final,
        ...portable
      } = raw;
      importedOps.push({
        ...(portable as unknown as OpRecord),
        id: importedId,
        batchId: batchMap.get(raw["batchId"])!,
        txId: `import:${crypto.randomUUID()}`,
        identity: { source: "unconfirmed", staging: "unconfirmed", final: "unconfirmed" },
      });
    }

    const importedDirs: DirRecord[] = [];
    for (const value of backup["dirs"]) {
      if (!value || typeof value !== "object")
        throw new JournalError("Backup contains an invalid directory record");
      const raw = value as Record<string, unknown>;
      if (
        typeof raw["id"] !== "string" ||
        typeof raw["opId"] !== "string" ||
        typeof raw["path"] !== "string" ||
        !seenOps.has(raw["opId"]) ||
        !["create-intent", "created", "observed-existing"].includes(String(raw["state"])) ||
        typeof raw["intentAt"] !== "number"
      ) {
        throw new JournalError("Backup contains an invalid directory record");
      }
      const importedOpId = opMap.get(raw["opId"]);
      if (!importedOpId) throw new JournalError("Directory record references an unknown operation");
      importedDirs.push({
        id: `import:${crypto.randomUUID()}`,
        opId: importedOpId,
        path: raw["path"],
        state: raw["state"] as DirRecord["state"],
        intentAt: raw["intentAt"],
      });
    }

    await this.commit(["roots", "batches", "ops", "dirs"], (stores) => {
      importedRoots.forEach((r) => stores.roots.add(r));
      importedBatches.forEach((b) => stores.batches.add(b));
      importedOps.forEach((o) => stores.ops.add(o));
      importedDirs.forEach((d) => stores.dirs.add(d));
    });
    return {
      batches: importedBatches.length,
      operations: importedOps.length,
      directories: importedDirs.length,
    };
  }

  async setVisibility(id: string, visibility: Visibility) {
    const b = await req(this.db.transaction("batches").objectStore("batches").get(id));
    if (!b || "unreadable" in validateBatch(b))
      throw new JournalError("Record not found or unreadable");
    await this.putBatch({ ...(b as BatchRecord), visibility, updatedAt: Date.now() });
  }

  /** Explicit record deletion: only resolved/undone/completed batches; never touches files. */
  async deleteRecord(id: string) {
    const b = await req(this.db.transaction("batches").objectStore("batches").get(id));
    const v = b ? validateBatch(b) : undefined;
    if (!v || "unreadable" in v || isUnfinished(v))
      throw new JournalError("Only finished operations can be removed from history");
    const ops = await this.opsFor(id);
    const allDirs = await req(this.db.transaction("dirs").objectStore("dirs").getAll());
    const opIds = new Set(ops.map((o) => o.id));
    const dirIds = (allDirs as DirRecord[]).filter((d) => opIds.has(d.opId)).map((d) => d.id);
    await this.commit(["batches", "ops", "dirs"], (s) => {
      s.batches.delete(id);
      ops.forEach((o) => s.ops.delete(o.id));
      dirIds.forEach((dirId) => s.dirs.delete(dirId));
    });
  }

  close() {
    this.db.close();
  }
}

export function validateBatch(raw: unknown): BatchRecord | Unreadable {
  const b = raw as Partial<BatchRecord> | null;
  const id = typeof b?.id === "string" ? b.id : "?";
  if (
    !b ||
    typeof b !== "object" ||
    b.schema !== SCHEMA ||
    typeof b.createdAt !== "number" ||
    typeof b.status !== "string" ||
    typeof b.kind !== "string"
  )
    return { unreadable: true, id, raw };
  return b as BatchRecord;
}
