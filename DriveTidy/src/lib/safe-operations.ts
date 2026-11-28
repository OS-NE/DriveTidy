import {
  openJournal,
  type BatchKind,
  type BatchRecord,
  type Journal,
  type OpRecord,
} from "@/lib/journal";
import { hashBlobFull } from "@/lib/sha256";
import type { ScannedFile } from "@/lib/fs";

export interface JournalRun {
  journal: Journal;
  batch: BatchRecord;
  close(): void;
}

/** Persist a batch and its root handle before any filesystem mutation starts. */
export async function beginJournalRun(
  root: FileSystemDirectoryHandle,
  kind: BatchKind,
  title: string,
  irreversible = false,
): Promise<JournalRun> {
  const journal = await openJournal();
  const rootId = `root:${root.name}`;
  const now = Date.now();
  const batch: BatchRecord = {
    id: crypto.randomUUID(),
    kind,
    rootId,
    title,
    createdAt: now,
    updatedAt: now,
    status: "running",
    visibility: "active",
    irreversible,
    durability: journal.durability,
    counts: { planned: 0, completed: 0, failed: 0 },
    schema: 1,
  };
  try {
    await journal.putRoot({ id: rootId, handle: root, name: root.name, firstSeen: now });
    await journal.putBatch(batch);
  } catch (error) {
    journal.close();
    throw new Error(
      `DriveTidy could not safely start this operation because its recovery journal could not be written: ${String(error)}`,
    );
  }
  return { journal, batch, close: () => journal.close() };
}

/**
 * Record a durable intent before moving. The underlying moveFile implementation performs
 * verified copy/move and preserves the source on failed verification.
 */
export async function journaledMove(
  run: JournalRun,
  file: ScannedFile,
  destination: FileSystemDirectoryHandle,
  intendedName = file.name,
  move: (f: ScannedFile, d: FileSystemDirectoryHandle, n: string) => Promise<string>,
  toPath?: string,
): Promise<string> {
  const original = await file.handle.getFile();
  const sourceSha256 = await hashBlobFull(original);
  const id = crypto.randomUUID();
  const now = Date.now();
  const op: OpRecord = {
    id,
    txId: crypto.randomUUID(),
    batchId: run.batch.id,
    seq: Number(run.batch.counts["completed"] ?? 0) + Number(run.batch.counts["failed"] ?? 0),
    action:
      intendedName !== file.name &&
      toPath === (file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "")
        ? "rename"
        : "move",
    fromDir: file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "",
    fromName: file.name,
    toDir: destination.name,
    ...(toPath === undefined ? {} : { toPath }),
    intendedName,
    size: original.size,
    lastModified: original.lastModified,
    sourceSha256,
    sourceHandle: file.handle,
    identity: { source: "handle", staging: "unconfirmed", final: "unconfirmed" },
    state: "hashed",
    updatedAt: now,
  };
  await run.journal.putOp(op); // If this fails, the file is not touched.
  const finalName = await move(file, destination, intendedName);
  const finalHandle = await destination.getFileHandle(finalName);
  const finalFile = await finalHandle.getFile();
  const finalSha256 = await hashBlobFull(finalFile);
  if (finalSha256 !== sourceSha256) {
    await run.journal.putOp({
      ...op,
      state: "needs-review",
      finalHandle,
      finalSha256,
      error: "Destination hash differs from the journaled source hash",
      updatedAt: Date.now(),
    });
    throw new Error(
      `Move verification failed for ${file.name}; the journal recorded the mismatch for recovery review.`,
    );
  }
  await run.journal.putOp({
    ...op,
    state: "native-moved",
    finalName,
    finalHandle,
    finalSha256,
    identity: { source: "handle", staging: "unconfirmed", final: "handle" },
    updatedAt: Date.now(),
  });
  run.batch = {
    ...run.batch,
    updatedAt: Date.now(),
    counts: { ...run.batch.counts, completed: Number(run.batch.counts["completed"] ?? 0) + 1 },
  };
  await run.journal.putBatch(run.batch);
  return finalName;
}

export async function finishJournalRun(
  run: JournalRun,
  status: "completed" | "completed-with-issues" | "stopped" = "completed",
  failed = 0,
) {
  run.batch = {
    ...run.batch,
    status,
    updatedAt: Date.now(),
    counts: { ...run.batch.counts, failed: Number(run.batch.counts["failed"] ?? 0) + failed },
  };
  await run.journal.putBatch(run.batch);
  run.close();
}
