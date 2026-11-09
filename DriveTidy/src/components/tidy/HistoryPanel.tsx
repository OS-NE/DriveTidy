import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { openJournal, isUnfinished, type BatchRecord, type Journal, type OpRecord, type Unreadable } from "@/lib/journal";
import { restoreQuarantinedBatch } from "@/lib/restore";
import { classify, type Observation, type Classification } from "@/lib/recovery";
import { hashBlobFull } from "@/lib/sha256";

type Row = BatchRecord | Unreadable;

export function useJournalBatches() {
  const [journal, setJournal] = useState<Journal | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reload = async (j = journal) => { if (j) setRows(await j.listBatches()); };
  useEffect(() => {
    if (typeof indexedDB === "undefined") { setError("History unavailable in this browser"); return; }
    let j: Journal | undefined;
    openJournal().then(async (x) => { j = x; setJournal(x); setRows(await x.listBatches()); }).catch((e) => setError(e.message));
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
  const [recoveryRows, setRecoveryRows] = useState<Record<string, { observation: Observation; result: Classification }>>({});
  const backupInput = useRef<HTMLInputElement>(null);
  const [backupBusy, setBackupBusy] = useState(false);

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
      toast.success("History backup exported. It contains file paths and operation metadata, not file contents.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBackupBusy(false);
    }
  };

  const importHistory = async (file?: File) => {
    if (!journal || !file || backupBusy) return;
    setBackupBusy(true);
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error("Backup is larger than the 50 MB import limit.");
      const json = await file.text();
      const preview = JSON.parse(json) as { batches?: unknown[]; ops?: unknown[] };
      const batchCount = Array.isArray(preview.batches) ? preview.batches.length : 0;
      const opCount = Array.isArray(preview.ops) ? preview.ops.length : 0;
      if (!confirm(`Import ${batchCount} archived history records and ${opCount} file-operation entries?\n\nImported entries will be read-only history. They will not reconnect to drives or enable file recovery. Existing history will not be overwritten.`)) return;
      const result = await journal.importBackup(json);
      await reload();
      toast.success(`Imported ${result.batches} history records and ${result.operations} file operations.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBackupBusy(false);
      if (backupInput.current) backupInput.current.value = "";
    }
  };

  if (error) return <p className="text-sm text-destructive">{error}. Scanning still works; file changes that need history are disabled.</p>;

  const visible = rows.filter((r) => "unreadable" in r || showDismissed || r.visibility !== "dismissed");
  const toggle = async (id: string) => {
    if (open === id) return setOpen(null);
    setOpen(id); setOps(journal ? await journal.opsFor(id) : []);
  };

  const inspectRecovery = async (batch: BatchRecord) => {
    if (!journal || reviewing) return;
    setReviewing(batch.id);
    try {
      const rootRecord = await journal.getRoot(batch.rootId);
      if (!rootRecord?.handle) throw new Error("The original drive handle is unavailable. Reconnect the same drive first.");
      const rootHandle = rootRecord.handle;
      const permissionHandle = rootHandle as FileSystemDirectoryHandle & {
        queryPermission?: (descriptor: { mode: "read" }) => Promise<PermissionState>;
        requestPermission?: (descriptor: { mode: "read" }) => Promise<PermissionState>;
      };
      let permission = await permissionHandle.queryPermission?.({ mode: "read" });
      if (permission === "prompt") permission = await permissionHandle.requestPermission?.({ mode: "read" });
      if (permission === "denied") throw new Error("DriveTidy needs read access to inspect this drive. Reconnect it and grant permission.");

      const operations = await journal.opsFor(batch.id);
      const inspected: typeof recoveryRows = {};
      const directoryAt = async (base: FileSystemDirectoryHandle, path: string) => {
        let current = base;
        for (const part of path.split("/").filter(Boolean)) current = await current.getDirectoryHandle(part);
        return current;
      };
      const readFile = async (dir: FileSystemDirectoryHandle, name: string) => {
        try { return await dir.getFileHandle(name); }
        catch (e) { if ((e as DOMException).name === "NotFoundError") return null; throw e; }
      };

      for (const op of operations) {
        let observation: Observation = { access: "ok", source: "unreadable", dest: "unreadable" };
        try {
          const sourceDir = await directoryAt(rootHandle, op.fromDir);
          const sourceHandle = await readFile(sourceDir, op.fromName);
          if (!sourceHandle) observation.source = "absent";
          else {
            const sourceFile = await sourceHandle.getFile();
            const sourceHash = await hashBlobFull(sourceFile);
            observation.source = sourceHash === op.sourceSha256 ? "match" : "differs";
            if (op.sourceHandle && typeof sourceHandle.isSameEntry === "function") {
              observation.sourceSame = await sourceHandle.isSameEntry(op.sourceHandle);
            }
          }

          let destinationDir: FileSystemDirectoryHandle | null = null;
          let destinationPathKnown = false;
          try {
            if (typeof op.toPath === "string") {
              destinationPathKnown = true;
              destinationDir = await directoryAt(rootHandle, op.toPath);
            } else if (batch.kind === "quarantine-move") {
              destinationPathKnown = true;
              destinationDir = await directoryAt(rootHandle, ["_DriveTidy_Quarantine", op.fromDir].filter(Boolean).join("/"));
            } else if (!op.toDir || op.toDir === rootHandle.name) {
              destinationDir = rootHandle;
              destinationPathKnown = true;
            }
          } catch (e) {
            if ((e as DOMException).name !== "NotFoundError") throw e;
          }

          const destinationName = op.finalName ?? op.intendedName;
          const destinationHandle = destinationDir ? await readFile(destinationDir, destinationName) : null;
          if (destinationHandle) {
            const destinationFile = await destinationHandle.getFile();
            const destinationHash = await hashBlobFull(destinationFile);
            observation.dest = destinationHash === (op.finalSha256 ?? op.sourceSha256) ? "match" : "differs";
            if (op.finalHandle && typeof destinationHandle.isSameEntry === "function") {
              observation.destSame = await destinationHandle.isSameEntry(op.finalHandle);
            }
          } else if (op.finalHandle) {
            // A stored handle can prove the bytes still exist, but not their current path.
            const finalFile = await op.finalHandle.getFile();
            const finalHash = await hashBlobFull(finalFile);
            observation.dest = finalHash === (op.finalSha256 ?? op.sourceSha256) ? "match" : "differs";
            observation.destSame = false;
          } else {
            observation.dest = destinationPathKnown ? "absent" : "unreadable";
          }
        } catch (e) {
          if ((e as DOMException).name === "NotAllowedError" || (e as DOMException).name === "SecurityError") {
            observation = { access: "missing", source: "unreadable", dest: "unreadable" };
          }
        }
        inspected[op.id] = { observation, result: classify(op.state, observation) };
      }
      setRecoveryRows((current) => ({ ...current, ...inspected }));
      setOpen(batch.id);
      setOps(operations);
      toast.success(`Inspected ${operations.length} journaled file operation${operations.length === 1 ? "" : "s"}. No files were changed.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setReviewing(null);
    }
  };

  const confirmRecoveredMove = async (batch: BatchRecord, op: OpRecord) => {
    if (!journal) return;
    const review = recoveryRows[op.id];
    if (!review || review.result.outcome !== "completed" || !review.observation.destSame) {
      toast.error("This move is not proven complete. Review it again before confirming.");
      return;
    }
    if (!confirm(`Confirm that "${op.fromName}" was moved successfully? This updates the recovery journal only; it does not change any files.`)) return;
    try {
      await journal.putOp({ ...op, state: "native-moved", updatedAt: Date.now(), error: undefined });
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
    if (!confirm("Restore verified quarantined files to their original folders? DriveTidy checks for existing files and skips conflicts rather than intentionally overwriting them.")) return;
    setRestoring(batch.id);
    try {
      const root = await journal.getRoot(batch.rootId);
      if (!root?.handle) throw new Error("The original drive handle is unavailable. Reconnect the same drive before restoring.");
      const operations = await journal.opsFor(batch.id);
      const result = await restoreQuarantinedBatch(root.handle, journal, batch, operations);
      await reload();
      if (open === batch.id) setOps(await journal.opsFor(batch.id));
      toast.success(`Restored ${result.restored} files${result.alreadyRestored ? ` · ${result.alreadyRestored} already restored` : ""}${result.skipped ? ` · ${result.skipped} skipped` : ""}`);
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
        <p className="text-sm text-muted-foreground">Export a portable history backup or import one as read-only archive. Backups contain paths and operation metadata, never file contents. Imported records cannot perform recovery actions.</p>
        <div className="flex flex-wrap gap-2">
          <input
            ref={backupInput}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(event) => void importHistory(event.target.files?.[0])}
          />
          <Button variant="outline" size="sm" disabled={!journal || backupBusy} onClick={exportHistory}>{backupBusy ? "Working…" : "Export backup"}</Button>
          <Button variant="outline" size="sm" disabled={!journal || backupBusy} onClick={() => backupInput.current?.click()}>Import backup</Button>
          <Button variant="outline" size="sm" onClick={() => setShowDismissed((v) => !v)}>{showDismissed ? "Hide dismissed" : "Show dismissed"}</Button>
        </div>
      </div>
      {visible.length === 0 && <p className="text-sm text-muted-foreground">No recorded operations yet.</p>}
      {visible.map((r) =>
        "unreadable" in r ? (
          <div key={r.id} className="rounded-md border p-3 text-sm">Unreadable record – needs review</div>
        ) : (
          <div key={r.id} className="rounded-md border p-3 text-sm space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{r.title}</span>
              <Badge variant={isUnfinished(r) ? "destructive" : "secondary"}>{r.status}</Badge>
              {r.importedAt && <Badge variant="outline">Imported archive</Badge>}
              {r.irreversible && <Badge variant="outline">Irreversible</Badge>}
              {r.dryRun && <Badge variant="outline">Plan only</Badge>}
              {r.durability === "relaxed" && <Badge variant="outline">Relaxed save</Badge>}
              <span className="text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</span>
              <div className="ml-auto flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => toggle(r.id)}>{open === r.id ? "Hide files" : "Files"}</Button>
                {isUnfinished(r) && !r.importedAt && (
                  <Button size="sm" variant="outline" disabled={!!reviewing} onClick={() => inspectRecovery(r)}>
                    {reviewing === r.id ? "Inspecting…" : "Review recovery"}
                  </Button>
                )}
                {r.kind === "quarantine-move" && !isUnfinished(r) && !r.importedAt && (
                  <Button size="sm" variant="outline" disabled={!!restoring} onClick={() => restore(r)}>
                    {restoring === r.id ? "Restoring…" : "Restore files"}
                  </Button>
                )}
                {r.visibility !== "dismissed" && <Button size="sm" variant="ghost" onClick={async () => { await journal?.setVisibility(r.id, "dismissed"); reload(); }}>Dismiss</Button>}
                {!isUnfinished(r) && <Button size="sm" variant="ghost" onClick={async () => { if (confirm("Remove this record from history? Files are not changed.")) { await journal?.deleteRecord(r.id); reload(); } }}>Delete record</Button>}
              </div>
            </div>
            {open === r.id && (
              <ul className="space-y-1 text-xs">
                {ops.length === 0 && <li className="text-muted-foreground">No files recorded.</li>}
                {ops.map((o) => {
                  const review = recoveryRows[o.id];
                  return (
                    <li key={o.id} className="rounded border border-border/60 p-2">
                      <div><span className="font-mono">{o.fromDir}/{o.fromName}</span> → <span className="font-mono">{o.toPath ?? o.toDir}/{o.finalName ?? o.intendedName}</span> · {o.state}{o.error ? ` · ${o.error}` : ""}</div>
                      {review && (
                        <div className="mt-1 space-y-1">
                          <Badge variant={["needs-review", "conflict", "waiting-for-access"].includes(review.result.outcome) ? "destructive" : "secondary"}>{review.result.label}</Badge>
                          <div className="text-muted-foreground">Source: {review.observation.source} · Destination: {review.observation.dest}</div>
                          {review.result.actions.length > 0 && <div className="text-muted-foreground">Suggested next step: {review.result.actions.join(" · ")}</div>}
                          {review.result.outcome === "completed" && review.observation.destSame && o.state !== "native-moved" && (
                            <Button size="sm" variant="outline" onClick={() => confirmRecoveredMove(r, o)}>
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
  const pending = rows.filter((r): r is BatchRecord => !("unreadable" in r) && isUnfinished(r) && !r.importedAt && r.visibility === "active");
  if (!pending.length) return null;
  return (
    <div role="status" className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
      <p>DriveTidy found an unfinished operation from a previous session. Some files may already have been moved. No automatic recovery actions have been performed. Review the operation history before continuing.</p>
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={onReview}>Review</Button>
        <Button size="sm" variant="outline" onClick={async () => { for (const b of pending) await journal?.setVisibility(b.id, "dismissed"); reload(); }}>Dismiss</Button>
      </div>
    </div>
  );
}
