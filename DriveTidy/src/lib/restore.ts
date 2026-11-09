import { hashBlobFull } from "@/lib/sha256";
import { moveFile, type ScannedFile } from "@/lib/fs";
import {
  beginJournalRun,
  finishJournalRun,
  journaledMove,
} from "@/lib/safe-operations";
import type { BatchRecord, Journal, OpRecord } from "@/lib/journal";

const QUARANTINE = "_DriveTidy_Quarantine";

async function directoryAt(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const part of path.split("/").filter(Boolean)) {
    current = await current.getDirectoryHandle(part);
  }
  return current;
}

async function fileAt(dir: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle | null> {
  try {
    return await dir.getFileHandle(name);
  } catch (error) {
    if ((error as DOMException)?.name === "NotFoundError") return null;
    throw error;
  }
}

async function matches(handle: FileSystemFileHandle | null, expectedHash: string): Promise<boolean> {
  if (!handle) return false;
  return (await hashBlobFull(await handle.getFile())) === expectedHash;
}

export interface RestoreResult {
  restored: number;
  alreadyRestored: number;
  skipped: number;
  failures: string[];
}

/**
 * Restore only files recorded by a completed quarantine batch.
 * Every source is fingerprint-checked and every original destination must be absent.
 * No folder is created during restoration and no existing file is overwritten.
 */
export async function restoreQuarantinedBatch(
  root: FileSystemDirectoryHandle,
  journal: Journal,
  batch: BatchRecord,
  operations: OpRecord[],
): Promise<RestoreResult> {
  if (batch.kind !== "quarantine-move") {
    throw new Error("Only quarantine operations can be restored from this action.");
  }
  if (batch.status !== "completed" && batch.status !== "completed-with-issues") {
    throw new Error("Only finished quarantine batches can be restored.");
  }
  if (!operations.some((op) => op.action === "move" && op.state === "native-moved" && op.sourceSha256 && op.finalName)) {
    throw new Error("There are no remaining quarantined files to restore in this batch.");
  }
  const run = await beginJournalRun(root, "undo", `Restore: ${batch.title}`);
  const result: RestoreResult = { restored: 0, alreadyRestored: 0, skipped: 0, failures: [] };

  try {
    for (const op of operations) {
      if (op.state === "restored") {
        result.alreadyRestored++;
        continue;
      }
      if (op.action !== "move" || op.state !== "native-moved" || !op.sourceSha256 || !op.finalName) {
        result.skipped++;
        continue;
      }
      try {
        const originalDir = await directoryAt(root, op.fromDir);
        const quarantineDir = await directoryAt(
          root,
          op.toPath ?? [QUARANTINE, op.fromDir].filter(Boolean).join("/"),
        );
        const quarantineFile = await fileAt(quarantineDir, op.finalName);
        const originalFile = await fileAt(originalDir, op.fromName);

        // Crash recovery: if the move completed but the original journal row wasn't updated,
        // recognize the byte-identical file at its original location and mark it restored.
        if (!quarantineFile && await matches(originalFile, op.sourceSha256)) {
          await journal.putOp({ ...op, state: "restored", updatedAt: Date.now() });
          result.alreadyRestored++;
          continue;
        }
        if (!quarantineFile) throw new Error("Quarantined copy is missing; left untouched.");
        if (originalFile) throw new Error("Original path is occupied; no file was overwritten.");
        const source = await quarantineFile.getFile();
        const sourceHash = await hashBlobFull(source);
        if (sourceHash !== op.sourceSha256) {
          throw new Error("Quarantined file no longer matches its recorded fingerprint.");
        }

        const path = [op.toPath ?? [QUARANTINE, op.fromDir].filter(Boolean).join("/"), op.finalName].filter(Boolean).join("/");
        const scanned: ScannedFile = {
          id: path,
          name: op.finalName,
          path,
          size: source.size,
          lastModified: source.lastModified,
          type: source.type,
          handle: quarantineFile,
          parent: quarantineDir,
        };

        // The original directory already exists. Never create it or silently rename on conflict.
        await journaledMove(run, scanned, originalDir, op.fromName, async (file, dest, name) => {
          const current = await file.handle.getFile();
          if ((await hashBlobFull(current)) !== op.sourceSha256) {
            throw new Error("Quarantined file changed during restore; no move performed.");
          }
          const occupied = await fileAt(dest, name);
          if (occupied) throw new Error("Original path became occupied; no file was overwritten.");
          return moveFile(file, dest, name, undefined, true);
        }, op.fromDir);
        await journal.putOp({ ...op, state: "restored", updatedAt: Date.now() });
        result.restored++;
      } catch (error) {
        result.skipped++;
        result.failures.push(`${op.fromDir ? `${op.fromDir}/` : ""}${op.fromName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await finishJournalRun(run, result.failures.length ? "completed-with-issues" : "completed", result.failures.length);
    return result;
  } catch (error) {
    await finishJournalRun(run, "completed-with-issues", 1).catch(() => undefined);
    throw error;
  }
}
