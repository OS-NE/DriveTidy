import { beginJournalRun, journaledMove, finishJournalRun } from "@/lib/safe-operations";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  findDuplicates,
  moveFile,
  ensureDir,
  revalidateDuplicate,
  type DuplicateGroup,
  type DuplicateStage,
  type ScannedFile,
} from "@/lib/fs";
import { logActivity } from "@/lib/activity";
import { formatBytes } from "@/lib/organize";
import { FilePreview } from "./FilePreview";
import { ResultsPager, RESULTS_PAGE_SIZE } from "./ResultsPager";

export function DuplicatesPanel({
  root,
  files,
  onChanged,
}: {
  root: FileSystemDirectoryHandle;
  files: ScannedFile[];
  onChanged: () => void;
}) {
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [progress, setProgress] = useState<[number, number, DuplicateStage] | null>(null);
  const [stopper, setStopper] = useState<AbortController | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [folder, setFolder] = useState("_Duplicates");
  const [confirmQuarantine, setConfirmQuarantine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const rows = useMemo(
    () =>
      (groups ?? []).flatMap((g, group) =>
        g.files.map((f, i) => ({
          f,
          i,
          group,
          copies: g.files.length,
          status: g.status,
          reason: g.reason,
          keep: g.files[0]!,
        })),
      ),
    [groups],
  );
  const verified = useMemo(() => (groups ?? []).filter((g) => g.status === "verified"), [groups]);
  const verifiedIds = useMemo(
    () => new Set(verified.flatMap((g) => g.files.slice(1).map((f) => f.id))),
    [verified],
  );

  const scan = async () => {
    setProgress([0, 1, "candidates"]);
    const ac = new AbortController();
    setStopper(ac);
    try {
      const g = await findDuplicates(files, (d, t, stage) => setProgress([d, t, stage]), ac.signal);
      setGroups(g);
      setPage(0);
      // Only fully verified copies are pre-selected; the first (shortest path / oldest) is kept.
      setSelected(
        new Set(
          g
            .filter((x) => x.status === "verified")
            .flatMap((x) => x.files.slice(1).map((f) => f.id)),
        ),
      );
    } catch (e) {
      if ((e as Error).name === "AbortError")
        toast("Duplicate check stopped. Nothing was changed.");
      else toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
      setStopper(null);
    }
  };

  const wasted = useMemo(
    () => verified.reduce((s, g) => s + (g.files[0]?.size ?? 0) * (g.files.length - 1), 0),
    [verified],
  );
  // Only verified copies can ever be acted on, whatever the checkbox state.
  const chosenRows = useMemo(
    () => rows.filter(({ f }) => selected.has(f.id) && verifiedIds.has(f.id)),
    [rows, selected, verifiedIds],
  );
  const chosen = chosenRows.map(({ f }) => f);
  const chosenBytes = chosen.reduce((s, f) => s + f.size, 0);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const run = async (mode: "move" | "quarantine") => {
    setBusy(true);
    let ok = 0,
      fail = 0;
    let journalRun: Awaited<ReturnType<typeof beginJournalRun>> | null = null;
    try {
      const quarantineFolder = "_DriveTidy_Quarantine";
      journalRun = await beginJournalRun(
        root,
        mode === "move" ? "duplicates-move" : "quarantine-move",
        mode === "move" ? "Move verified duplicates" : "Quarantine verified duplicates",
      );
      const dest = await ensureDir(root, mode === "move" ? folder : quarantineFolder);
      for (const { f, keep } of chosenRows) {
        try {
          // Re-prove identity right before acting: files may have changed since the scan.
          await revalidateDuplicate(keep, f);
          const sub = await ensureDir(dest, f.path.split("/").slice(0, -1).join("/"));
          await journaledMove(journalRun, f, sub, f.name, (file, dir, name) => moveFile(file, dir, name), [mode === "move" ? folder : quarantineFolder, f.path.split("/").slice(0, -1).join("/")].filter(Boolean).join("/"));
          logActivity(
            "moved",
            f.path,
            mode === "move"
              ? `Verified duplicate of ${keep.path} moved to ${folder}`
              : `Verified duplicate of ${keep.path} moved to _DriveTidy_Quarantine for review`,
          );
          ok++;
        } catch (e) {
          fail++;
          logActivity("failed", f.path, e instanceof Error ? e.message : String(e));
        }
      }
      if (journalRun) await finishJournalRun(journalRun, fail ? "completed-with-issues" : "completed", fail);
      toast.success(
        `${mode === "move" ? "Moved" : "Quarantined"} ${ok} files${fail ? `, ${fail} failed` : ""}`,
      );
      setGroups(null);
      onChanged();
    } catch (e) {
      if (journalRun) await finishJournalRun(journalRun, "completed-with-issues", 1).catch(() => undefined);
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!groups) {
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center">
        <p className="text-muted-foreground">
          Compares file sizes, then fingerprints, then verifies every byte of large matches. Nothing
          is changed until you confirm.
        </p>
        {progress ? (
          <div className="mx-auto mt-6 max-w-sm space-y-2">
            <Progress value={(progress[0] / Math.max(1, progress[1])) * 100} />
            <p className="font-mono text-xs text-muted-foreground">
              {progress[2] === "candidates"
                ? `Step 1 · finding candidates ${progress[0]} / ${progress[1]}`
                : `Step 2 · verifying full contents ${formatBytes(progress[0])} / ${formatBytes(progress[1])}`}
            </p>
            <Button variant="outline" size="sm" onClick={() => stopper?.abort()}>
              Stop
            </Button>
          </div>
        ) : (
          <Button className="mt-6" onClick={scan} disabled={!files.length}>
            Find duplicates in {files.length} files
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
        <div className="mr-auto">
          <div className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            {verified.length} verified groups · {formatBytes(wasted)} reclaimable
            {groups.length > verified.length
              ? ` · ${groups.length - verified.length} not duplicates / unverified`
              : ""}
          </div>
          <div className="text-sm">
            {chosen.length} selected ({formatBytes(chosenBytes)})
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            className="w-40 font-mono"
            aria-label="Duplicates folder"
          />
          <Button disabled={busy || !chosen.length || !folder.trim()} onClick={() => run("move")}>
            Move to folder
          </Button>
        </div>
        <Button
          variant="outline"
          disabled={busy || !chosen.length}
          onClick={() => setConfirmQuarantine(true)}
        >
          Quarantine selected
        </Button>
        <Button variant="ghost" onClick={scan} disabled={busy || !!progress}>
          Rescan
        </Button>
      </div>
      {verified.length === 0 && groups.length > 0 && (
        <p className="text-center text-sm text-muted-foreground">
          Some files looked alike but full verification showed they differ — nothing to remove.
        </p>
      )}
      {groups.length === 0 && (
        <p className="py-10 text-center text-muted-foreground">No duplicates found. Clean drive.</p>
      )}
      <ResultsPager page={page} total={rows.length} onPage={setPage} />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {rows
          .slice(page * RESULTS_PAGE_SIZE, (page + 1) * RESULTS_PAGE_SIZE)
          .map(({ f, i, group, copies, status, reason }) => (
            <label
              key={f.id}
              title={reason}
              className={`flex gap-3 rounded-md border p-2 ${status === "verified" ? "cursor-pointer" : "opacity-70"} ${selected.has(f.id) && status === "verified" ? "border-destructive/60 bg-destructive/5" : "border-border"}`}
            >
              <FilePreview file={f} className="h-16 w-16 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs text-muted-foreground">
                  Group {group + 1} · {copies} files · {formatBytes(f.size)}
                </div>
                <div
                  className={`font-mono text-xs ${status === "verified" ? "text-primary" : "text-destructive"}`}
                >
                  {status === "verified"
                    ? "✓ Verified duplicate"
                    : status === "potential"
                      ? "Potential match · not verified"
                      : "✗ Not a duplicate / verification failed"}
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={selected.has(f.id) && status === "verified"}
                    disabled={status !== "verified" || i === 0}
                    onCheckedChange={() => toggle(f.id)}
                    aria-label={`Select ${f.name}`}
                  />
                  <span className="truncate text-sm font-medium">{f.name}</span>
                </div>
                <div
                  className="mt-1 truncate font-mono text-xs text-muted-foreground"
                  title={f.path}
                >
                  {f.path}
                </div>
                <div className="font-mono text-xs text-muted-foreground">
                  {status !== "verified"
                    ? (reason ?? "kept")
                    : selected.has(f.id) && i !== 0
                      ? "remove"
                      : i === 0
                        ? "keep (original)"
                        : "keep"}
                </div>
              </div>
            </label>
          ))}
      </div>
      <ResultsPager page={page} total={rows.length} onPage={setPage} />
      <AlertDialog open={confirmQuarantine} onOpenChange={setConfirmQuarantine}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Quarantine {chosen.length} verified duplicates?</AlertDialogTitle>
            <AlertDialogDescription>
              Only fully verified copies are included, and each is re-checked against its kept original
              immediately before moving. DriveTidy moves them into _DriveTidy_Quarantine and preserves
              their relative folders. This does not permanently delete data; review the quarantined
              files and remove them yourself when you are certain.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => run("quarantine")}>Move to quarantine</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
