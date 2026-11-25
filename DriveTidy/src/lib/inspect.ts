// Read-only recovery inspection of journaled operations. Never mutates files or the journal.
// Pure of React so it can be tested with fake file-system handles.
//
// Efficiency: directory lookups are cached per inspection run, and a file whose size differs
// from the recorded size is reported as "differs" without reading its contents.

import { classify, type Classification, type Observation, type Outcome } from "./recovery";
import { hashBlobFull } from "./sha256";
import type { BatchRecord, OpRecord } from "./journal";

export interface InspectedOp {
  observation: Observation;
  result: Classification;
}

export interface InspectStats {
  /** Files whose full contents were hashed. */
  hashed: number;
  /** Files reported as changed from their size alone, without reading contents. */
  sizeShortcuts: number;
}

export interface Inspector {
  inspect(op: OpRecord): Promise<InspectedOp>;
  stats: InspectStats;
}

const QUARANTINE = "_DriveTidy_Quarantine";
const PERMISSION_ERRORS = ["NotAllowedError", "SecurityError"];

const errorName = (error: unknown) => (error as DOMException | undefined)?.name;

export function createInspector(
  root: FileSystemDirectoryHandle,
  batch: Pick<BatchRecord, "kind">,
  signal?: AbortSignal,
): Inspector {
  const stats: InspectStats = { hashed: 0, sizeShortcuts: 0 };
  const dirCache = new Map<string, Promise<FileSystemDirectoryHandle | null>>();

  // Resolves a folder path, reusing resolved parents. A missing folder is null, not an error.
  const resolveDir = (path: string): Promise<FileSystemDirectoryHandle | null> => {
    const key = path.split("/").filter(Boolean).join("/");
    if (!key) return Promise.resolve(root);
    let cached = dirCache.get(key);
    if (!cached) {
      const cut = key.lastIndexOf("/");
      const parentKey = cut < 0 ? "" : key.slice(0, cut);
      const name = key.slice(cut + 1);
      cached = resolveDir(parentKey).then(async (parent) => {
        if (!parent) return null;
        try {
          return await parent.getDirectoryHandle(name);
        } catch (error) {
          if (errorName(error) === "NotFoundError") return null;
          throw error;
        }
      });
      dirCache.set(key, cached);
    }
    return cached;
  };

  const fileHandle = async (dir: FileSystemDirectoryHandle | null, name: string) => {
    if (!dir) return null;
    try {
      return await dir.getFileHandle(name);
    } catch (error) {
      if (errorName(error) === "NotFoundError") return null;
      throw error;
    }
  };

  const readFile = async (handle: FileSystemFileHandle): Promise<File | null> => {
    try {
      return await handle.getFile();
    } catch (error) {
      if (errorName(error) === "NotFoundError") return null;
      throw error;
    }
  };

  const sameBytes = async (file: File, sha256: string, size: number) => {
    if (typeof size === "number" && file.size !== size) {
      stats.sizeShortcuts++;
      return false;
    }
    stats.hashed++;
    return (await hashBlobFull(file, signal)) === sha256;
  };

  async function observeSource(op: OpRecord, obs: Observation) {
    const handle = await fileHandle(await resolveDir(op.fromDir), op.fromName);
    const file = handle ? await readFile(handle) : null;
    if (!handle || !file) {
      obs.source = "absent";
      return;
    }
    obs.source = (await sameBytes(file, op.sourceSha256, op.size)) ? "match" : "differs";
    if (op.sourceHandle && typeof handle.isSameEntry === "function") {
      obs.sourceSame = await handle.isSameEntry(op.sourceHandle);
    }
  }

  async function observeDestination(op: OpRecord, obs: Observation) {
    let pathKnown = false;
    let path = "";
    if (typeof op.toPath === "string") {
      pathKnown = true;
      path = op.toPath;
    } else if (batch.kind === "quarantine-move") {
      pathKnown = true;
      path = [QUARANTINE, op.fromDir].filter(Boolean).join("/");
    } else if (!op.toDir || op.toDir === root.name) {
      pathKnown = true;
    }
    const expected = op.finalSha256 ?? op.sourceSha256;
    const handle = pathKnown
      ? await fileHandle(await resolveDir(path), op.finalName ?? op.intendedName)
      : null;
    const file = handle ? await readFile(handle) : null;
    if (handle && file) {
      obs.dest = (await sameBytes(file, expected, op.size)) ? "match" : "differs";
      if (op.finalHandle && typeof handle.isSameEntry === "function") {
        obs.destSame = await handle.isSameEntry(op.finalHandle);
      }
      return;
    }
    // A stored handle can prove the bytes still exist, but not their current path.
    const stored = op.finalHandle ? await readFile(op.finalHandle) : null;
    if (stored) {
      obs.dest = (await sameBytes(stored, expected, op.size)) ? "match" : "differs";
      obs.destSame = false;
      return;
    }
    // Nothing at the known path and the stored handle is gone: absent. With an unknown path the
    // file may exist elsewhere, so that stays unreadable.
    obs.dest = pathKnown ? "absent" : "unreadable";
  }

  async function inspect(op: OpRecord): Promise<InspectedOp> {
    signal?.throwIfAborted();
    let observation: Observation = { access: "ok", source: "unreadable", dest: "unreadable" };

    // Source and destination are checked independently: a missing source folder (normal after
    // "remove emptied folders") must not stop the destination from being inspected.
    try {
      await observeSource(op, observation);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (PERMISSION_ERRORS.includes(errorName(error) ?? "")) {
        observation = { access: "missing", source: "unreadable", dest: "unreadable" };
      } else {
        observation.source = "unreadable";
      }
    }

    if (observation.access !== "missing") {
      try {
        await observeDestination(op, observation);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (PERMISSION_ERRORS.includes(errorName(error) ?? "")) {
          observation = { ...observation, access: "missing", dest: "unreadable" };
        } else {
          observation.dest = "unreadable";
        }
      }
    }
    return { observation, result: classify(op.state, observation) };
  }

  return { inspect, stats };
}

// ---------- presentation helpers ----------

export type Tone = "good" | "info" | "warn" | "bad";

const TONES: Record<Outcome, Tone> = {
  completed: "good",
  "not-started": "info",
  "reverted-safe": "info",
  "resume-placement": "info",
  "not-deleted": "info",
  "probable-completion": "warn",
  "awaiting-finalize": "warn",
  "partial-final": "warn",
  "deletion-unconfirmed": "warn",
  "dir-ownership-unknown": "warn",
  "needs-review": "bad",
  conflict: "bad",
  "waiting-for-access": "bad",
};

export const outcomeTone = (outcome: Outcome): Tone => TONES[outcome] ?? "bad";

export interface InspectionSummary {
  total: number;
  /** Classified completed with the stored destination handle identity confirmed. */
  completed: number;
  /** Everything else; these entries still need a person to look at them. */
  attention: number;
  safeToFinalize: boolean;
  tones: Record<Tone, number>;
}

export function summarize(rows: InspectedOp[], total: number): InspectionSummary {
  const tones: Record<Tone, number> = { good: 0, info: 0, warn: 0, bad: 0 };
  let completed = 0;
  for (const row of rows) {
    tones[outcomeTone(row.result.outcome)]++;
    if (row.result.outcome === "completed" && row.observation.destSame === true) completed++;
  }
  return {
    total,
    completed,
    attention: total - completed,
    safeToFinalize: total > 0 && completed === total,
    tones,
  };
}

const TONE_RANK: Record<Tone, number> = { bad: 0, warn: 1, info: 2, good: 3 };

/**
 * Orders a batch's operations for review: entries that need attention first, in journal order
 * within each group. With a tone filter, only entries of that tone are kept. Operations that
 * have not been inspected keep their journal order and are dropped by any filter.
 */
export function arrangeOps(
  ops: OpRecord[],
  rows: Record<string, InspectedOp>,
  filter: Tone | "all" = "all",
): OpRecord[] {
  if (!ops.some((op) => rows[op.id])) return filter === "all" ? ops : [];
  const toneOf = (op: OpRecord) => {
    const row = rows[op.id];
    return row ? outcomeTone(row.result.outcome) : null;
  };
  const rank = (op: OpRecord) => {
    const tone = toneOf(op);
    return tone ? TONE_RANK[tone] : 4;
  };
  return ops
    .filter((op) => filter === "all" || toneOf(op) === filter)
    .map((op, index) => ({ op, index, rank: rank(op) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.op);
}
