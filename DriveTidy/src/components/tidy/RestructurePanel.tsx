import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { ArrowRight, Folder, Trash2 } from "lucide-react";
import { ensureDir, moveFile, listEmptyFolders, removeEmptyFolder, type EmptyFolder, type ScannedFile } from "@/lib/fs";
import { beginJournalRun, journaledMove, finishJournalRun } from "@/lib/safe-operations";
import { targetFolder, extOf, isUnsafeFile, groupFolderPlan, type Strategy } from "@/lib/organize";
import { logActivity } from "@/lib/activity";

interface Rule { ext: string; folder: string }

export function RestructurePanel({ root, files, onChanged }: { root: FileSystemDirectoryHandle; files: ScannedFile[]; onChanged: () => void }) {
  const [strategy, setStrategy] = useState<Strategy>("category-date");
  const [base, setBase] = useState("Organized");
  const [rules, setRules] = useState<Rule[]>([]);
  const [newRule, setNewRule] = useState<Rule>({ ext: "", folder: "" });
  const [progress, setProgress] = useState<number | null>(null);
  const [cleanEmptied, setCleanEmptied] = useState(true);
  const [cleanExisting, setCleanExisting] = useState(false);
  const [emptyPreview, setEmptyPreview] = useState<EmptyFolder[] | null>(null);
  const [removing, setRemoving] = useState(false);
  const stopRef = useRef<AbortController | null>(null);
  const [report, setReport] = useState<{ moved: { from: string; to: string }[]; fail: number; remaining: number } | null>(null);

  const plan = useMemo(() => {
    const b = base.trim().replace(/^\/+|\/+$/g, "");
    return files
      .filter((f) => !isUnsafeFile(f.name))
      .filter((f) => !b || !f.path.startsWith(b + "/"))
      .map((f) => {
        const rule = rules.find((r) => r.ext.replace(".", "").toLowerCase() === extOf(f.name));
        const folder = [b, rule ? rule.folder : targetFolder(f, strategy)].filter(Boolean).join("/");
        return { f, folder };
      })
      .filter((p) => p.f.path.split("/").slice(0, -1).join("/") !== p.folder);
  }, [files, strategy, base, rules]);

  const tree = useMemo(() => groupFolderPlan(plan), [plan]);

  const apply = async () => {
    setProgress(0);
    const ac = new AbortController();
    stopRef.current = ac;
    const moved: { from: string; to: string }[] = [];
    let fail = 0, stopped = false;
    let journalRun: Awaited<ReturnType<typeof beginJournalRun>> | null = null;
    try { journalRun = await beginJournalRun(root, "restructure", "Restructure files"); }
    catch (e) { setProgress(null); toast.error(e instanceof Error ? e.message : String(e)); return; }
    for (const [i, p] of plan.entries()) {
      if (ac.signal.aborted) { stopped = true; break; }
      try {
        const name = await journaledMove(journalRun, p.f, await ensureDir(root, p.folder), p.f.name, (f, d, n) => moveFile(f, d, n, ac.signal), p.folder);
        const to = `${p.folder}/${name}`;
        moved.push({ from: p.f.path, to });
        logActivity("moved", p.f.path, `Moved to ${to}`);
      } catch (e) {
        if (ac.signal.aborted) {
          stopped = true;
          logActivity("stopped", p.f.path, "Stopped mid-move; file left in its original place");
          break;
        }
        fail++;
        logActivity("failed", p.f.path, `Move failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      setProgress(((i + 1) / plan.length) * 100);
    }
    stopRef.current = null;
    setProgress(null);
    try { await finishJournalRun(journalRun, stopped ? "stopped" : fail ? "completed-with-issues" : "completed", fail); }
    catch (e) { toast.error(`Files were moved, but the final journal update failed: ${String(e)}. Review History before further changes.`); }
    const ok = moved.length;
    if (stopped) {
      setReport({ moved, fail, remaining: plan.length - ok - fail });
    } else toast.success(`Moved ${ok} files${fail ? `, ${fail} failed` : ""}`);
    if (cleanEmptied || cleanExisting) {
      try {
        // Deepest-first list of folders now empty; exclude the destination base folder.
        const srcDirs = new Set(plan.map((p) => p.f.path.split("/").slice(0, -1).join("/")).filter(Boolean));
        const empties = (await listEmptyFolders(root, base.trim().replace(/^\/+|\/+$/g, "") || undefined))
          .filter((e) => cleanExisting || [...srcDirs].some((d) => d === e.path || d.startsWith(e.path + "/")));
        if (empties.length) setEmptyPreview(empties);
        else toast.info("No empty folders to remove.");
      } catch { /* cleanup scan is best-effort */ }
    }
    onChanged();
  };

  const removeEmpties = async () => {
    if (!emptyPreview) return;
    setRemoving(true);
    let ok = 0, fail = 0;
    for (const e of emptyPreview) {
      try {
        await removeEmptyFolder(e);
        ok++;
      } catch { fail++; } // non-empty or locked folders are skipped, never force-deleted
    }
    setRemoving(false);
    setEmptyPreview(null);
    toast.success(`Removed ${ok} empty folders${fail ? `, ${fail} skipped (not empty)` : ""}`);
    onChanged();
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 rounded-lg border border-border bg-card p-4 md:grid-cols-3">
        <div className="space-y-1">
          <label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Organize by</label>
          <Select value={strategy} onValueChange={(v) => setStrategy(v as Strategy)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="category">Category (Images, Videos…)</SelectItem>
              <SelectItem value="type">File type (JPG, PDF…)</SelectItem>
              <SelectItem value="date">Date (Year / Month)</SelectItem>
              <SelectItem value="category-date">Category → Year → Month</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Into folder</label>
          <Input value={base} onChange={(e) => setBase(e.target.value)} className="font-mono" placeholder="(drive root)" />
        </div>
        <div className="space-y-1">
          <label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Custom rule</label>
          <div className="flex gap-2">
            <Input value={newRule.ext} onChange={(e) => setNewRule({ ...newRule, ext: e.target.value })} placeholder="ext" className="w-20 font-mono" />
            <Input value={newRule.folder} onChange={(e) => setNewRule({ ...newRule, folder: e.target.value })} placeholder="Folder/Sub" className="font-mono" />
            <Button variant="secondary" disabled={!newRule.ext || !newRule.folder} onClick={() => { setRules([...rules, newRule]); setNewRule({ ext: "", folder: "" }); }}>Add</Button>
          </div>
          <div className="flex flex-wrap gap-1 pt-1">
            {rules.map((r, i) => (
              <button key={i} onClick={() => setRules(rules.filter((_, j) => j !== i))} className="rounded bg-secondary px-2 py-0.5 font-mono text-xs text-secondary-foreground hover:bg-destructive/20" title="Remove rule">
                .{r.ext.replace(".", "")} → {r.folder} ×
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={cleanEmptied} onCheckedChange={(v) => setCleanEmptied(v === true)} />
          Remove folders emptied by this move
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={cleanExisting} onCheckedChange={(v) => setCleanExisting(v === true)} />
          Also clean up other empty folders
        </label>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground"><span className="font-semibold text-foreground">{plan.length}</span> files will move into <span className="font-semibold text-foreground">{tree.length}</span> folders.</p>
        {progress !== null
          ? <Button variant="destructive" onClick={() => stopRef.current?.abort()}>Stop</Button>
          : <Button onClick={apply} disabled={!plan.length}>Apply restructure</Button>}
      </div>
      {progress !== null && <Progress value={progress} />}

      <div className="grid gap-3 md:grid-cols-2">
        {tree.slice(0, 80).map(([folder, fs]) => (
          <div key={folder} className="rounded-lg border border-border bg-card p-3">
            <div className="mb-2 flex items-center gap-2 font-mono text-sm text-primary"><Folder className="h-4 w-4" />{folder}<span className="ml-auto text-xs text-muted-foreground">{fs.length}</span></div>
            <ul className="space-y-1">
              {fs.slice(0, 5).map((f) => (
                <li key={f.id} className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                  <span className="truncate" title={f.path}>{f.path}</span><ArrowRight className="h-3 w-3 shrink-0" />
                </li>
              ))}
              {fs.length > 5 && <li className="font-mono text-xs text-muted-foreground">+ {fs.length - 5} more</li>}
            </ul>
          </div>
        ))}
      </div>

      <AlertDialog open={!!report} onOpenChange={(o) => { if (!o) setReport(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stopped — {report?.moved.length ?? 0} files were moved</AlertDialogTitle>
            <AlertDialogDescription>
              Nothing else was changed. {report?.remaining ?? 0} files were left where they were{report?.fail ? `, and ${report.fail} failed to move` : ""}. Any file that was mid-copy stays in its original place.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-64 space-y-1 overflow-auto rounded-md border border-border p-3">
            {(report?.moved ?? []).slice(0, 500).map((m) => (
              <li key={m.from} className="font-mono text-xs text-muted-foreground">{m.from} → <span className="text-foreground">{m.to}</span></li>
            ))}
            {!report?.moved.length && <li className="text-xs text-muted-foreground">No files were moved.</li>}
          </ul>
          <AlertDialogFooter><AlertDialogAction>OK</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!emptyPreview} onOpenChange={(o) => { if (!o && !removing) setEmptyPreview(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {emptyPreview?.length ?? 0} empty folders?</AlertDialogTitle>
            <AlertDialogDescription>
              Only folders that are completely empty are listed. Anything that still contains files is skipped — no files are deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-64 space-y-1 overflow-auto rounded-md border border-border p-3">
            {(emptyPreview ?? []).map((e) => (
              <li key={e.path} className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                <Trash2 className="h-3 w-3 shrink-0" />{e.path}
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Keep folders</AlertDialogCancel>
            <AlertDialogAction onClick={removeEmpties} disabled={removing}>{removing ? "Removing…" : "Remove empty folders"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
