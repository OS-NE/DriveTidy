import { beginJournalRun, journaledMove, finishJournalRun } from "@/lib/safe-operations";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { ShieldAlert } from "lucide-react";
import { findProblemFiles, moveFile, ensureDir, type ProblemFile, type ScannedFile } from "@/lib/fs";
import { formatBytes } from "@/lib/organize";
import { FilePreview } from "./FilePreview";
import { ResultsPager, RESULTS_PAGE_SIZE } from "./ResultsPager";

export function HealthPanel({ root, files, onChanged }: { root: FileSystemDirectoryHandle; files: ScannedFile[]; onChanged: () => void }) {
  const [problems, setProblems] = useState<ProblemFile[] | null>(null);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [folder, setFolder] = useState("_Quarantine");
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);

  const scan = async () => {
    setProgress([0, 1]);
    try {
      const p = await findProblemFiles(files, (d, t) => setProgress([d, t]));
      setProblems(p);
      setPage(0);
      setSelected(new Set(p.map((x) => x.file.id)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setProgress(null); }
  };

  const chosen = useMemo(() => (problems ?? []).filter((p) => selected.has(p.file.id)), [problems, selected]);
  const chosenBytes = chosen.reduce((s, p) => s + p.file.size, 0);
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const run = async () => {
    setBusy(true);
    let ok = 0, fail = 0;
    let journalRun: Awaited<ReturnType<typeof beginJournalRun>> | null = null;
    const quarantinePath = folder.trim().replace(/^\/+|\/+$/g, "");
    try {
      if (!quarantinePath) throw new Error("Choose a quarantine folder name.");
      const dest = await ensureDir(root, quarantinePath);
      journalRun = await beginJournalRun(root, "quarantine-move", "Quarantine problem files");
      for (const p of chosen) {
        try {
          const relativeParent = p.file.path.split("/").slice(0, -1).join("/");
          const sub = await ensureDir(dest, relativeParent);
          await journaledMove(
            journalRun,
            p.file,
            sub,
            p.file.name,
            (file, dir, name) => moveFile(file, dir, name),
            [quarantinePath, relativeParent].filter(Boolean).join("/"),
          );
          ok++;
        } catch (error) {
          fail++;
          toast.error(`${p.file.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await finishJournalRun(journalRun, fail ? "completed-with-issues" : "completed", fail);
      toast.success(`Quarantined ${ok} files${fail ? `, ${fail} failed` : ""}`);
      setProblems(null);
      onChanged();
    } catch (e) {
      if (journalRun) await finishJournalRun(journalRun, "completed-with-issues", 1).catch(() => undefined);
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  if (!problems) {
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center">
        <ShieldAlert className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="mt-3 text-muted-foreground">Tries to read every file and lists the ones that fail — unreadable, locked, or corrupted. Nothing changes until you confirm.</p>
        {progress ? (
          <div className="mx-auto mt-6 max-w-sm space-y-2">
            <Progress value={(progress[0] / Math.max(1, progress[1])) * 100} />
            <p className="font-mono text-xs text-muted-foreground">checking {progress[0]} / {progress[1]}</p>
          </div>
        ) : (
          <Button className="mt-6" onClick={scan} disabled={!files.length}>Check {files.length} files</Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
        <div className="mr-auto">
          <div className="font-mono text-xs uppercase tracking-wider text-muted-foreground">{problems.length} problem files</div>
          <div className="text-sm">{chosen.length} selected ({formatBytes(chosenBytes)})</div>
        </div>
        <div className="flex items-center gap-2">
          <Input value={folder} onChange={(e) => setFolder(e.target.value)} className="w-40 font-mono" aria-label="Quarantine folder" />
          <Button disabled={busy || !chosen.length || !folder.trim()} onClick={run}>Move to quarantine</Button>
        </div>
        <Button variant="ghost" onClick={scan} disabled={busy || !!progress}>Recheck</Button>
      </div>
      {problems.length === 0 && <p className="py-10 text-center text-muted-foreground">Every file read fine. Nothing to quarantine.</p>}
      <ResultsPager page={page} total={problems.length} onPage={setPage} />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {problems.slice(page * RESULTS_PAGE_SIZE, (page + 1) * RESULTS_PAGE_SIZE).map((p) => (
          <label key={p.file.id} className={`flex cursor-pointer gap-3 rounded-md border p-2 ${selected.has(p.file.id) ? "border-destructive/60 bg-destructive/5" : "border-border"}`}>
            <FilePreview file={p.file} className="h-16 w-16 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-mono text-xs text-destructive">{p.reason}</div>
              <div className="flex items-center gap-2">
                <Checkbox checked={selected.has(p.file.id)} onCheckedChange={() => toggle(p.file.id)} />
                <span className="truncate text-sm font-medium">{p.file.name}</span>
              </div>
              <div className="mt-1 truncate font-mono text-xs text-muted-foreground" title={p.file.path}>{p.file.path}</div>
              <div className="font-mono text-xs text-muted-foreground">{formatBytes(p.file.size)}</div>
            </div>
          </label>
        ))}
      </div>
      <ResultsPager page={page} total={problems.length} onPage={setPage} />
    </div>
  );
}

