import { beginJournalRun, journaledMove, finishJournalRun } from "@/lib/safe-operations";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Sparkles, Check, X, RefreshCw } from "lucide-react";
import { moveFile, thumbnailDataUrl, type ScannedFile } from "@/lib/fs";
import {
  categoryOf,
  extOf,
  isPoorlyNamed,
  isRenameableMedia,
  dateBasedName,
  slugify,
  shouldAutoRename,
  nextRenameBatch,
  AUTO_RENAME_CONFIDENCE,
  RENAME_BATCH_SIZE,
  RENAME_BATCH_SIZES,
} from "@/lib/organize";
import { useProviderSettings } from "./ProviderSettings";
import { FilePreview } from "./FilePreview";
import { ResultsPager, RESULTS_PAGE_SIZE } from "./ResultsPager";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TOOL_PROVIDERS } from "@/lib/ai-provider";
import { nameWithOllama } from "@/lib/ollama";
import { addNamingUsage, type BatchUsage } from "@/lib/rename-usage";

type Status = "pending" | "review" | "renamed" | "skipped" | "error";
interface Item {
  f: ScannedFile;
  status: Status;
  name?: string;
  description?: string;
  confidence?: number;
  error?: string;
}

export function RenamePanel({ files, onChanged }: { files: ScannedFile[]; onChanged: () => void }) {
  const [onlyPoor, setOnlyPoor] = useState(true);
  const [auto, setAuto] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState<[number, number] | null>(null);
  const [page, setPage] = useState(0);
  const [batchSize, setBatchSize] = useState<number>(RENAME_BATCH_SIZE);
  const [namingBasis, setNamingBasis] = useState<"ai" | "date">("ai");
  const [batchSummary, setBatchSummary] = useState<BatchUsage | null>(null);
  const settings = useProviderSettings();
  const providerStatus = settings.statuses["ollama"];
  const checking = settings.checking["ollama"] ?? false;
  const setProviderStatus = settings.updateStatus;
  const providerBlocked =
    !providerStatus || ["missing", "invalid", "denied"].includes(providerStatus.state);

  const candidates = useMemo(
    () =>
      files.filter(
        (f) => isRenameableMedia(f.name) && f.size > 0 && (!onlyPoor || isPoorlyNamed(f.name)),
      ),
    [files, onlyPoor],
  );

  const processed = useMemo(() => new Set(items.map((i) => i.f.id)), [items]);
  const remainingCount = useMemo(
    () => candidates.filter((f) => !processed.has(f.id)).length,
    [candidates, processed],
  );
  const nextBatch = useMemo(
    () => nextRenameBatch(candidates, processed, batchSize),
    [candidates, processed, batchSize],
  );

  const update = (id: string, patch: Partial<Item>) =>
    setItems((xs) => xs.map((x) => (x.f.id === id ? { ...x, ...patch } : x)));

  const rename = async (it: Item, name: string) => {
    const ext = extOf(it.f.name);
    const newName = `${slugify(name)}${ext ? "." + ext : ""}`;
    const run = await beginJournalRun(it.f.parent, "rename", `Rename ${it.f.name}`);
    try {
      const final = await journaledMove(
        run,
        it.f,
        it.f.parent,
        newName,
        (file, dir, name) => moveFile(file, dir, name),
        it.f.path.includes("/") ? it.f.path.slice(0, it.f.path.lastIndexOf("/")) : "",
      );
      await finishJournalRun(run);
      update(it.f.id, { status: "renamed", name: final });
    } catch (error) {
      await finishJournalRun(run, "completed-with-issues", 1).catch(() => undefined);
      throw error;
    }
  };

  const analyze = async (retryItems?: Item[]) => {
    const batch: Item[] = retryItems ?? nextBatch.map((f) => ({ f, status: "pending" as const }));
    if (!batch.length) return;
    setBatchSummary(null);
    let usage: BatchUsage = {
      provider: "ollama",
      estimatedRequests: batch.length,
      actualRequests: 0,
      successfulRequests: 0,
      reportedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    if (retryItems) {
      // Retry in place: reset failed items to pending without rescanning the drive.
      const retryIds = new Set(retryItems.map((r) => r.f.id));
      setItems((xs) =>
        xs.map((x) => (retryIds.has(x.f.id) ? { f: x.f, status: "pending" as const } : x)),
      );
    } else {
      setItems((xs) => {
        const have = new Set(xs.map((x) => x.f.id));
        return [...xs, ...batch.filter((b) => !have.has(b.f.id))];
      });
    }
    setRunning([0, batch.length]);
    let autoCount = 0;
    for (const [i, it] of batch.entries()) {
      let requested = false;
      let counted = false;
      try {
        if (namingBasis === "date") {
          const name = dateBasedName(it.f.lastModified);
          const next: Item = {
            ...it,
            status: "review",
            name,
            description: "Named from file date & time",
            confidence: 1,
          };
          if (auto) {
            try {
              await rename(next, name);
              autoCount++;
            } catch (e) {
              update(it.f.id, { ...next, status: "error", error: String(e) });
            }
          } else update(it.f.id, next);
          setRunning([i + 1, batch.length]);
          continue;
        }
        const dataUrl = await thumbnailDataUrl(it.f);
        requested = true;
        const kind = categoryOf(it.f.name) === "Videos" ? ("video" as const) : ("image" as const);
        const r = await nameWithOllama({ dataUrl, originalName: it.f.name, kind });
        usage = addNamingUsage(usage, r.ok, "usage" in r ? r.usage : undefined);
        counted = true;
        if (!r.ok) {
          setProviderStatus({
            state: "providerState" in r ? r.providerState : "missing",
            message: r.error,
          });
          update(it.f.id, { status: "error", error: r.error });
          if (r.stopBatch) {
            toast.error(r.error);
            const unstarted = new Set(batch.slice(i + 1).map((item) => item.f.id));
            setItems((xs) => xs.filter((item) => !unstarted.has(item.f.id)));
            break;
          }
        } else {
          setProviderStatus({ state: "ready", message: "Connected · naming working" });
          const next: Item = {
            ...it,
            status: "review",
            name: slugify(r.name),
            description: r.description,
            confidence: r.confidence,
          };
          if (auto && shouldAutoRename(r.confidence)) {
            try {
              await rename(next, slugify(r.name));
              autoCount++;
            } catch (e) {
              update(it.f.id, { ...next, status: "error", error: String(e) });
            }
          } else update(it.f.id, next);
        }
      } catch (e) {
        if (requested && !counted) usage = addNamingUsage(usage, false);
        update(it.f.id, { status: "error", error: e instanceof Error ? e.message : String(e) });
      }
      setRunning([i + 1, batch.length]);
    }
    setRunning(null);
    setBatchSummary(usage);
    if (autoCount) {
      toast.success(`Auto-renamed ${autoCount} files`);
      onChanged();
    }
  };

  const review = items.filter((i) => i.status === "review");
  const failed = items.filter((i) => i.status === "error");
  const sorted = useMemo(
    () => [...items].sort((a, b) => Number(b.status === "review") - Number(a.status === "review")),
    [items],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 border-b border-border pb-4">
        <span className="text-sm font-medium">{TOOL_PROVIDERS.ollama.label}</span>
        <span className="text-xs text-muted-foreground">
          Free · runs on your PC · photos never leave it
        </span>
        <Badge
          role="status"
          variant={
            providerStatus?.state === "ready"
              ? "default"
              : providerBlocked
                ? "destructive"
                : "secondary"
          }
        >
          {running
            ? "Connected · analyzing…"
            : checking
              ? "Checking local AI…"
              : (providerStatus?.message ?? "Checking…")}
        </Badge>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void settings.verifyProvider()}
          disabled={checking || !!running}
        >
          <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
          Check connection
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-6 rounded-lg border border-border bg-card p-4">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={onlyPoor} onCheckedChange={setOnlyPoor} />
          Only poorly named (IMG_1234, DSC…)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={auto} onCheckedChange={setAuto} />
          Auto-rename at ≥{Math.round(AUTO_RENAME_CONFIDENCE * 100)}% confidence
        </label>
        <span className="flex items-center gap-2 text-sm">
          <span id="batch-size-label">Batch size</span>
          <Select
            value={String(batchSize)}
            onValueChange={(v) => setBatchSize(Number(v))}
            disabled={!!running}
          >
            <SelectTrigger aria-labelledby="batch-size-label" className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RENAME_BATCH_SIZES.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </span>
        <span className="flex items-center gap-2 text-sm">
          <span id="naming-basis-label">Rename basis</span>
          <Select
            value={namingBasis}
            onValueChange={(v) => setNamingBasis(v as "ai" | "date")}
            disabled={!!running}
          >
            <SelectTrigger aria-labelledby="naming-basis-label" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ai">AI content description</SelectItem>
              <SelectItem value="date">File date &amp; time (no AI)</SelectItem>
            </SelectContent>
          </Select>
        </span>
        <Button
          className="ml-auto"
          onClick={() => void analyze()}
          disabled={!nextBatch.length || !!running || checking || providerBlocked}
        >
          <Sparkles className="h-4 w-4" />
          {items.length
            ? `Analyze next ${nextBatch.length}`
            : `Analyze ${nextBatch.length} photos & videos`}
        </Button>
      </div>
      {running && (
        <div className="space-y-1">
          <Progress value={(running[0] / running[1]) * 100} />
          <p className="font-mono text-xs text-muted-foreground">
            looking at {running[0]} / {running[1]}
          </p>
        </div>
      )}
      {batchSummary && (
        <section aria-label="Batch usage summary" className="space-y-3 border-b border-border py-4">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-sm font-semibold">Batch complete</h2>
            <span className="text-xs text-muted-foreground">{TOOL_PROVIDERS.ollama.label}</span>
          </div>
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Estimated requests</dt>
              <dd className="font-mono">Up to {batchSummary.estimatedRequests.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Actual naming requests sent</dt>
              <dd className="font-mono">
                {batchSummary.actualRequests.toLocaleString()} ·{" "}
                {batchSummary.successfulRequests.toLocaleString()} successful
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                Reported tokens{" "}
                {batchSummary.reportedRequests < batchSummary.actualRequests ? "(partial)" : ""}
              </dt>
              <dd className="font-mono">
                {batchSummary.reportedRequests
                  ? batchSummary.totalTokens.toLocaleString()
                  : "Unavailable"}
              </dd>
            </div>
          </dl>
          {batchSummary.reportedRequests > 0 && (
            <p className="text-xs text-muted-foreground">
              Input: {batchSummary.inputTokens.toLocaleString()} · Output:{" "}
              {batchSummary.outputTokens.toLocaleString()} · Usage reported for{" "}
              {batchSummary.reportedRequests} of {batchSummary.actualRequests} requests.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Local AI is free — no credits or charges. Unreported usage is unknown, not zero.
          </p>
        </section>
      )}
      {items.length > 0 && (
        <div className="flex flex-wrap gap-4 font-mono text-xs text-muted-foreground">
          <span>review: {review.length}</span>
          <span>renamed: {items.filter((i) => i.status === "renamed").length}</span>
          <span>errors: {items.filter((i) => i.status === "error").length}</span>
          {remainingCount > 0 && (
            <span>
              {remainingCount} left of {candidates.length}
            </span>
          )}
          <div className="ml-auto flex gap-2">
            {failed.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                disabled={!!running || checking || providerBlocked}
                onClick={() => void analyze(failed)}
              >
                <RefreshCw className="h-4 w-4" />
                Retry {failed.length} failed
              </Button>
            )}
            {review.length > 0 && (
              <Button
                size="sm"
                variant="secondary"
                disabled={!!running}
                onClick={async () => {
                  for (const r of review) {
                    if (!r.name) continue;
                    await rename(r, r.name).catch((e) =>
                      update(r.f.id, { status: "error", error: String(e) }),
                    );
                  }
                  onChanged();
                }}
              >
                Approve all {review.length}
              </Button>
            )}
            {remainingCount > 0 && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void analyze()}
                disabled={!!running || checking || providerBlocked}
              >
                {running ? "working…" : `Continue with ${Math.min(batchSize, remainingCount)} more`}
              </Button>
            )}
          </div>
        </div>
      )}
      <div className="space-y-2">
        <ResultsPager page={page} total={sorted.length} onPage={setPage} />
        {sorted.slice(page * RESULTS_PAGE_SIZE, (page + 1) * RESULTS_PAGE_SIZE).map((it) => (
          <div
            key={it.f.id}
            className="grid items-center gap-4 rounded-lg border border-border bg-card p-3 md:grid-cols-[96px_1fr_1fr_auto]"
          >
            <FilePreview file={it.f} className="h-24 w-24" />
            <div className="min-w-0">
              <div className="font-mono text-xs uppercase text-muted-foreground">before</div>
              <div className="truncate font-mono text-sm" title={it.f.path}>
                {it.f.name}
              </div>
              {it.description && (
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{it.description}</p>
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 font-mono text-xs uppercase text-muted-foreground">
                after
                {it.confidence !== undefined && (
                  <Badge variant={shouldAutoRename(it.confidence) ? "default" : "secondary"}>
                    {Math.round(it.confidence * 100)}%
                  </Badge>
                )}
              </div>
              {it.status === "review" ? (
                <div className="flex items-center gap-1">
                  <Input
                    value={it.name}
                    onChange={(e) => update(it.f.id, { name: e.target.value })}
                    className="font-mono"
                  />
                  <span className="font-mono text-xs text-muted-foreground">
                    .{extOf(it.f.name)}
                  </span>
                </div>
              ) : (
                <div
                  className={`truncate font-mono text-sm ${it.status === "error" ? "text-destructive" : it.status === "renamed" ? "text-primary" : "text-muted-foreground"}`}
                >
                  {it.status === "pending"
                    ? "…"
                    : it.status === "error"
                      ? it.error
                      : it.status === "skipped"
                        ? "kept original"
                        : it.name}
                </div>
              )}
            </div>
            <div className="flex gap-1">
              {it.status === "review" && (
                <>
                  <Button
                    size="icon"
                    aria-label="Approve"
                    disabled={!!running || !it.name?.trim()}
                    onClick={() => {
                      if (!it.name) return;
                      void rename(it, it.name)
                        .then(onChanged)
                        .catch((e) => toast.error(String(e)));
                    }}
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Skip"
                    onClick={() => update(it.f.id, { status: "skipped" })}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </>
              )}
            </div>
          </div>
        ))}
        <ResultsPager page={page} total={sorted.length} onPage={setPage} />
      </div>
      {!items.length && (
        <p className="py-10 text-center text-muted-foreground">
          {candidates.length} photos & videos match. Rename by AI content description or by file
          date &amp; time, in batches of {batchSize} — continue until all are done.
        </p>
      )}
    </div>
  );
}
