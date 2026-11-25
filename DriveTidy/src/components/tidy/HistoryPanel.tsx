import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  openJournal,
  isUnfinished,
  type BatchRecord,
  type Journal,
  type OpRecord,
  type Unreadable,
} from "@/lib/journal";
import { restoreQuarantinedBatch } from "@/lib/restore";
import { classify, type Observation, type Classification } from "@/lib/recovery";
import { hashBlobFull } from "@/lib/sha256";
import {
  decryptJournalBackup,
  encryptJournalBackup,
  isEncryptedJournalBackup,
} from "@/lib/journal-crypto";

type Row = BatchRecord | Unreadable;

export function useJournalBatches() {
  const [journal, setJournal] = useState<Journal | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reload = async (j = journal) => {
    if (j) setRows(await j.listBatches());
  };
  useEffect(() => {
    if (typeof indexedDB === "undefined") {
      setError("History unavailable in this browser");
      return;
    }
    let j: Journal | undefined;
    openJournal()
      .then(async (x) => {
        j = x;
        setJournal(x);
        setRows(await x.listBatches());
      })
      .catch((e) => setError(e.message));
    return () => j?.close();
  }, []);
  return { journal, rows, error, reload };
}

export function HistoryPanel() {
  const { journal, rows, error, reload } = useJournalBatches();
  const [showDismissed, setShowDismissed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [ops, setOps] = useState<OpRecord[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [reviewProgress, setReviewProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const reviewAbort = useRef<AbortController | null>(null);
  const [recoveryRows, setRecoveryRows] = useState<
    Record<string, { observation: Observation; result: Classification }>
  >({});
  const [recoverySummaries, setRecoverySummaries] = useState<
    Record<string, { total: number; completed: number; safeToFinalize: boolean }>
  >({});
  const backupInput = useRef<HTMLInputElement>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMode, setBackupMode] = useState<"encrypt-export" | "encrypted-import" | null>(null);
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backupPassphraseConfirm, setBackupPassphraseConfirm] = useState("");
  const [pendingBackupFile, setPendingBackupFile] = useState<File | null>(null);

  const importJson = async (json: string): Promise<boolean> => {
    if (!journal) return false;
    const preview = JSON.parse(json) as { batches?: unknown[]; ops?: unknown[] };
    const batchCount = Array.isArray(preview.batches) ? preview.batches.length : 0;
    const opCount = Array.isArray(preview.ops) ? preview.ops.length : 0;
    if (
      !confirm(
        `Import ${batchCount} archived history records and ${opCount} file-operation entries?\n\nImported entries will be read-only history. They will not reconnect to drives or enable file recovery. Existing history will not be overwritten.`,
      )
    )
      return false;
    const result = await journal.importBackup(json);
    await reload();
    toast.success(
      `Imported ${result.batches} history records and ${result.operations} file operations.`,
    );
    return true;
  };

  const exportHistory = async () => {
    if (!journal || backupBusy) return;
    setBackupBusy(true);
    try {
      const json = await journal.exportBackup();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `drivetidy-history-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast.success(
        "History backup exported. It contains file paths and operation metadata, not file contents.",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBackupBusy(false);
    }
  };

  const exportEncryptedHistory = async () => {
    if (
      !journal ||
      backupBusy ||
      backupPassphrase.length < 12 ||
      backupPassphrase !== backupPassphraseConfirm
    )
      return;
    setBackupBusy(true);
    try {
      const json = await journal.exportBackup();
      const encrypted = await encryptJournalBackup(json, backupPassphrase);
      const url = URL.createObjectURL(new Blob([encrypted], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `drivetidy-history-encrypted-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast.success(
        "Encrypted history backup exported. Keep the passphrase separately; it cannot be recovered.",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBackupBusy(false);
      setBackupMode(null);
      setBackupPassphrase("");
      setBackupPassphraseConfirm("");
    }
  };

  const importHistory = async (file?: File) => {
    if (!journal || !file || backupBusy) return;
    setBackupBusy(true);
    try {
      if (file.size > 50 * 1024 * 1024)
        throw new Error("Backup is larger than the 50 MB import limit.");
      const json = await file.text();
      const preview: unknown = JSON.parse(json);
      if (isEncryptedJournalBackup(preview)) {
        setPendingBackupFile(file);
        setBackupPassphrase("");
        setBackupMode("encrypted-import");
        return;
      }
      const imported = await importJson(json);
      if (imported) {
        setBackupMode(null);
        setBackupPassphrase("");
        setBackupPassphraseConfirm("");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBackupBusy(false);
      if (backupInput.current) backupInput.current.value = "";
    }
  };

  const importEncryptedHistory = async () => {
    if (!journal || !pendingBackupFile || backupBusy || !backupPassphrase) return;
    setBackupBusy(true);
    try {
      if (pendingBackupFile.size > 70 * 1024 * 1024)
        throw new Error("Encrypted backup is larger than the 50 MB import limit.");
      const json = await decryptJournalBackup(await pendingBackupFile.text(), backupPassphrase);
      const imported = await importJson(json);
      if (imported) {
        setBackupMode(null);
        setPendingBackupFile(null);
        setBackupPassphrase("");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBackupBusy(false);
      if (backupInput.current) backupInput.current.value = "";
    }
  };

  if (error)
    return (
      <p className="text-sm text-destructive">
        {error}. Scanning still works; file changes that need history are disabled.
      </p>
    );

  const visible = rows.filter(
    (r) => "unreadable" in r || showDismissed || r.visibility !== "dismissed",
  );
  const toggle = async (id: string) => {
    if (open === id) return setOpen(null);
    setOpen(id);
    setOps(journal ? await journal.opsFor(id) : []);
  };

  const inspectRecovery = async (batch: BatchRecord) => {
    if (!journal || reviewing) return;
    const controller = new AbortController();
    reviewAbort.current = controller;
    setReviewing(batch.id);
    setReviewProgress({ done: 0, total: 0 });
    try {
      const rootRecord = await journal.getRoot(batch.rootId);
      if (!rootRecord?.handle)
        throw new Error(
          "The original drive handle is unavailable. Reconnect the same drive first.",
        );
      const rootHandle = rootRecord.handle;
      const permissionHandle = rootHandle as FileSystemDirectoryHandle & {
        queryPermission?: (descriptor: { mode: "read" }) => Promise<PermissionState>;
        requestPermission?: (descriptor: { mode: "read" }) => Promise<PermissionState>;
      };
      let permission = await permissionHandle.queryPermission?.({ mode: "read" });
      if (permission === "prompt")
        permission = await permissionHandle.requestPermission?.({ mode: "read" });
      if (permission === "denied")
        throw new Error(
          "DriveTidy needs read access to inspect this drive. Reconnect it and grant permission.",
        );

      const operations = await journal.opsFor(batch.id);
      const inspected: typeof recoveryRows = {};
      const directoryAt = async (base: FileSystemDirectoryHandle, path: string) => {
        let current = base;
        for (const part of path.split("/").filter(Boolean))
          current = await current.getDirectoryHandle(part);
        return current;
      };
      const optionalDirectoryAt = async (base: FileSystemDirectoryHandle, path: string) => {
        try {
          return await directoryAt(base, path);
        } catch (error) {
          if ((error as DOMException).name === "NotFoundError") return null;
          throw error;
        }
      };
      const readFile = async (dir: FileSystemDirectoryHandle | null, name: string) => {
        if (!dir) return null;
        try {
          return await dir.getFileHandle(name);
        } catch (error) {
          if ((error as DOMException).name === "NotFoundError") return null;
          throw error;
        }
      };

      setReviewProgress({ done: 0, total: operations.length });
      for (let index = 0; index < operations.length; index++) {
        controller.signal.throwIfAborted();
        const op = operations[index]!;
        let observation: Observation = { access: "ok", source: "unreadable", dest: "unreadable" };

        // Missing source parent folders are normal after "remove emptied folders".
        // Treat the source as absent, but continue inspecting the destination.
        try {
          const sourceDir = await optionalDirectoryAt(rootHandle, op.fromDir);
          const sourceHandle = await readFile(sourceDir, op.fromName);
          if (!sourceHandle) observation.source = "absent";
          else {
            const sourceFile = await sourceHandle.getFile();
            const sourceHash = await hashBlobFull(sourceFile, controller.signal);
            observation.source = sourceHash === op.sourceSha256 ? "match" : "differs";
            if (op.sourceHandle && typeof sourceHandle.isSameEntry === "function") {
              observation.sourceSame = await sourceHandle.isSameEntry(op.sourceHandle);
            }
          }
        } catch (error) {
          if (controller.signal.aborted) throw error;
          if (["NotAllowedError", "SecurityError"].includes((error as DOMException).name)) {
            observation = { access: "missing", source: "unreadable", dest: "unreadable" };
          } else {
            observation.source = "unreadable";
          }
        }

        if (observation.access !== "missing") {
          try {
            let destinationPathKnown = false;
            let destinationPath = "";
            if (typeof op.toPath === "string") {
              destinationPathKnown = true;
              destinationPath = op.toPath;
            } else if (batch.kind === "quarantine-move") {
              destinationPathKnown = true;
              destinationPath = ["_DriveTidy_Quarantine", op.fromDir].filter(Boolean).join("/");
            } else if (!op.toDir || op.toDir === rootHandle.name) {
              destinationPathKnown = true;
              destinationPath = "";
            }
            const destinationDir = destinationPathKnown
              ? await optionalDirectoryAt(rootHandle, destinationPath)
              : null;
            const destinationName = op.finalName ?? op.intendedName;
            const destinationHandle = await readFile(destinationDir, destinationName);
            if (destinationHandle) {
              const destinationFile = await destinationHandle.getFile();
              const destinationHash = await hashBlobFull(destinationFile, controller.signal);
              observation.dest =
                destinationHash === (op.finalSha256 ?? op.sourceSha256) ? "match" : "differs";
              if (op.finalHandle && typeof destinationHandle.isSameEntry === "function") {
                observation.destSame = await destinationHandle.isSameEntry(op.finalHandle);
              }
            } else if (op.finalHandle) {
              // A stored handle can prove the bytes still exist, but not their current path.
              const finalFile = await op.finalHandle.getFile();
              const finalHash = await hashBlobFull(finalFile, controller.signal);
              observation.dest =
                finalHash === (op.finalSha256 ?? op.sourceSha256) ? "match" : "differs";
              observation.destSame = false;
            } else {
              observation.dest = destinationPathKnown ? "absent" : "unreadable";
            }
          } catch (error) {
            if (controller.signal.aborted) throw error;
            if (["NotAllowedError", "SecurityError"].includes((error as DOMException).name)) {
              observation = { ...observation, access: "missing", dest: "unreadable" };
            } else {
              observation.dest = "unreadable";
            }
          }
        }

        inspected[op.id] = { observation, result: classify(op.state, observation) };
        setReviewProgress({ done: index + 1, total: operations.length });
      }
      setRecoveryRows((current) => ({ ...current, ...inspected }));
      setOpen(batch.id);
      setOps(operations);
      const inspectedRows = Object.values(inspected) as Array<{
        observation: Observation;
        result: Classification;
      }>;
      const completed = inspectedRows.filter(
        (row) => row.result.outcome === "completed" && row.observation.destSame === true,
      ).length;
      const attention = operations.length - completed;
      setRecoverySummaries((current) => ({
        ...current,
        [batch.id]: {
          total: operations.length,
          completed,
          safeToFinalize: operations.length > 0 && completed === operations.length,
        },
      }));
      toast.success(
        `Inspected ${operations.length} journaled operations: ${completed} identity-verified complete, ${attention} needing review. No files were changed.`,
      );
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        toast.info("Recovery inspection cancelled. No files were changed.");
      } else {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    } finally {
      reviewAbort.current = null;
      setReviewProgress(null);
      setReviewing(null);
    }
  };

  const finalizeRecoveredBatch = async (batch: BatchRecord) => {
    if (!journal) return;
    const summary = recoverySummaries[batch.id];
    if (!summary?.safeToFinalize || summary.total !== summary.completed) {
      toast.error(
        "This batch is not fully identity-verified. Keep it unfinished and review the remaining entries.",
      );
      return;
    }
    if (
      !confirm(
        `Mark "${batch.title}" as completed in DriveTidy history? All ${summary.total} recorded destinations were verified against their stored file identities and hashes. This changes journal metadata only; it does not change files.`,
      )
    )
      return;
    try {
      await journal.putBatch({
        ...batch,
        status: "completed",
        updatedAt: Date.now(),
        counts: {
          ...batch.counts,
          completed: summary.completed,
          failed: Number(batch.counts.failed ?? 0),
        },
      });
      await reload();
      toast.success("History record finalized. No files were changed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const confirmRecoveredMove = async (batch: BatchRecord, op: OpRecord) => {
    if (!journal) return;
    const review = recoveryRows[op.id];
    if (!review || review.result.outcome !== "completed" || !review.observation.destSame) {
      toast.error("This move is not proven complete. Review it again before confirming.");
      return;
    }
    if (
      !confirm(
        `Confirm that "${op.fromName}" was moved successfully? This updates the recovery journal only; it does not change any files.`,
      )
    )
      return;
    try {
      const cleared: OpRecord = { ...op, state: "native-moved", updatedAt: Date.now() };
      delete cleared.error;
      await journal.putOp(cleared);
      const refreshed = await journal.opsFor(batch.id);
      setOps(refreshed);
      setRecoveryRows((current) => ({
        ...current,
        [op.id]: {
          ...review,
          result: { outcome: "completed", label: "Move confirmed in history", actions: [] },
        },
      }));
      toast.success("Recovery record updated. No files were changed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const restore = async (batch: BatchRecord) => {
    if (!journal || restoring) return;
    if (
      !confirm(
        "Restore verified quarantined files to their original folders? DriveTidy checks for existing files and skips conflicts rather than intentionally overwriting them.",
      )
    )
      return;
    setRestoring(batch.id);
    try {
      const root = await journal.getRoot(batch.rootId);
      if (!root?.handle)
        throw new Error(
          "The original drive handle is unavailable. Reconnect the same drive before restoring.",
        );
      const operations = await journal.opsFor(batch.id);
      const result = await restoreQuarantinedBatch(root.handle, journal, batch, operations);
      await reload();
      if (open === batch.id) setOps(await journal.opsFor(batch.id));
      toast.success(
        `Restored ${result.restored} files${result.alreadyRestored ? ` · ${result.alreadyRestored} already restored` : ""}${result.skipped ? ` · ${result.skipped} skipped` : ""}`,
      );
      if (result.failures.length) toast.error(result.failures.slice(0, 3).join("\n"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Export a portable history backup or import one as read-only archive. Backups contain paths
          and operation metadata, never file contents. Imported records cannot perform recovery
          actions.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            ref={backupInput}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(event) => void importHistory(event.target.files?.[0])}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!journal || backupBusy || backupMode !== null}
            onClick={exportHistory}
          >
            {backupBusy ? "Working…" : "Export backup"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!journal || backupBusy}
            onClick={() => {
              setBackupMode(backupMode === "encrypt-export" ? null : "encrypt-export");
              setBackupPassphrase("");
              setBackupPassphraseConfirm("");
            }}
          >
            Encrypted export
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!journal || backupBusy || backupMode !== null}
            onClick={() => backupInput.current?.click()}
          >
            Import backup
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowDismissed((v) => !v)}>
            {showDismissed ? "Hide dismissed" : "Show dismissed"}
          </Button>
        </div>
      </div>
      {backupMode && (
        <div className="rounded-md border border-border bg-card p-3 space-y-2">
          <p className="text-sm font-medium">
            {backupMode === "encrypt-export"
              ? "Encrypt history backup"
              : "Unlock encrypted history backup"}
          </p>
          <p className="text-xs text-muted-foreground">
            {backupMode === "encrypt-export"
              ? "Use at least 12 characters. The passphrase is never saved; if lost, this backup cannot be opened."
              : "The decrypted history remains archived and read-only."}
          </p>
          <input
            aria-label="Backup passphrase"
            type="password"
            autoComplete="new-password"
            value={backupPassphrase}
            onChange={(event) => setBackupPassphrase(event.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
          {backupMode === "encrypt-export" && (
            <input
              aria-label="Confirm backup passphrase"
              type="password"
              autoComplete="new-password"
              value={backupPassphraseConfirm}
              onChange={(event) => setBackupPassphraseConfirm(event.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={
                backupBusy ||
                (backupMode === "encrypt-export"
                  ? backupPassphrase.length < 12 || backupPassphrase !== backupPassphraseConfirm
                  : !backupPassphrase)
              }
              onClick={() =>
                backupMode === "encrypt-export"
                  ? void exportEncryptedHistory()
                  : void importEncryptedHistory()
              }
            >
              {backupBusy
                ? "Working…"
                : backupMode === "encrypt-export"
                  ? "Create encrypted backup"
                  : "Decrypt and import"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={backupBusy}
              onClick={() => {
                setBackupMode(null);
                setPendingBackupFile(null);
                setBackupPassphrase("");
                setBackupPassphraseConfirm("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {reviewing && reviewProgress && (
        <div className="rounded-md border border-border bg-card p-3 space-y-2">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>
              Inspecting recovery records: {reviewProgress.done.toLocaleString()} /{" "}
              {reviewProgress.total.toLocaleString()}
            </span>
            <Button size="sm" variant="outline" onClick={() => reviewAbort.current?.abort()}>
              Cancel inspection
            </Button>
          </div>
          <Progress
            value={reviewProgress.total ? (reviewProgress.done / reviewProgress.total) * 100 : 0}
          />
          <p className="text-xs text-muted-foreground">
            This is a read-only check. File contents are never moved, renamed or deleted during
            inspection. Large files can take longer because their contents are verified.
          </p>
        </div>
      )}
      {visible.length === 0 && (
        <p className="text-sm text-muted-foreground">No recorded operations yet.</p>
      )}
      {visible.map((r) =>
        "unreadable" in r ? (
          <div key={r.id} className="rounded-md border p-3 text-sm">
            Unreadable record – needs review
          </div>
        ) : (
          <div key={r.id} className="rounded-md border p-3 text-sm space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{r.title}</span>
              <Badge variant={isUnfinished(r) ? "destructive" : "secondary"}>{r.status}</Badge>
              {r.importedAt && <Badge variant="outline">Imported archive</Badge>}
              {r.irreversible && <Badge variant="outline">Irreversible</Badge>}
              {r.dryRun && <Badge variant="outline">Plan only</Badge>}
              {r.durability === "relaxed" && <Badge variant="outline">Relaxed save</Badge>}
              <span className="text-muted-foreground">
                {new Date(r.createdAt).toLocaleString()}
              </span>
              <div className="ml-auto flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => toggle(r.id)}>
                  {open === r.id ? "Hide files" : "Files"}
                </Button>
                {isUnfinished(r) && recoverySummaries[r.id]?.safeToFinalize && (
                  <Button size="sm" variant="outline" onClick={() => finalizeRecoveredBatch(r)}>
                    Finalize verified batch
                  </Button>
                )}
                {isUnfinished(r) && !r.importedAt && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!reviewing}
                    onClick={() => inspectRecovery(r)}
                  >
                    {reviewing === r.id ? "Inspecting…" : "Review recovery"}
                  </Button>
                )}
                {r.kind === "quarantine-move" && !isUnfinished(r) && !r.importedAt && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!restoring}
                    onClick={() => restore(r)}
                  >
                    {restoring === r.id ? "Restoring…" : "Restore files"}
                  </Button>
                )}
                {r.visibility !== "dismissed" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await journal?.setVisibility(r.id, "dismissed");
                      reload();
                    }}
                  >
                    Dismiss
                  </Button>
                )}
                {!isUnfinished(r) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      if (confirm("Remove this record from history? Files are not changed.")) {
                        await journal?.deleteRecord(r.id);
                        reload();
                      }
                    }}
                  >
                    Delete record
                  </Button>
                )}
              </div>
            </div>
            {open === r.id && (
              <ul className="space-y-1 text-xs">
                {ops.length === 0 && <li className="text-muted-foreground">No files recorded.</li>}
                {ops.map((o) => {
                  const review = recoveryRows[o.id];
                  return (
                    <li key={o.id} className="rounded border border-border/60 p-2">
                      <div>
                        <span className="font-mono">
                          {o.fromDir}/{o.fromName}
                        </span>{" "}
                        →{" "}
                        <span className="font-mono">
                          {o.toPath ?? o.toDir}/{o.finalName ?? o.intendedName}
                        </span>{" "}
                        · {o.state}
                        {o.error ? ` · ${o.error}` : ""}
                      </div>
                      {review && (
                        <div className="mt-1 space-y-1">
                          <Badge
                            variant={
                              ["needs-review", "conflict", "waiting-for-access"].includes(
                                review.result.outcome,
                              )
                                ? "destructive"
                                : "secondary"
                            }
                          >
                            {review.result.label}
                          </Badge>
                          <div className="text-muted-foreground">
                            Source: {review.observation.source} · Destination:{" "}
                            {review.observation.dest}
                          </div>
                          {review.result.actions.length > 0 && (
                            <div className="text-muted-foreground">
                              Suggested next step: {review.result.actions.join(" · ")}
                            </div>
                          )}
                          {review.result.outcome === "completed" &&
                            review.observation.destSame &&
                            o.state !== "native-moved" && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => confirmRecoveredMove(r, o)}
                              >
                                Confirm this move
                              </Button>
                            )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ),
      )}
    </div>
  );
}

export function RecoveryNotice({ onReview }: { onReview: () => void }) {
  const { journal, rows, reload } = useJournalBatches();
  const pending = rows.filter(
    (r): r is BatchRecord =>
      !("unreadable" in r) && isUnfinished(r) && !r.importedAt && r.visibility === "active",
  );
  if (!pending.length) return null;
  return (
    <div
      role="status"
      className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
    >
      <p>
        DriveTidy found an unfinished operation from a previous session. Some files may already have
        been moved. No automatic recovery actions have been performed. Review the operation history
        before continuing.
      </p>
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={onReview}>
          Review
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            for (const b of pending) await journal?.setVisibility(b.id, "dismissed");
            reload();
          }}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
