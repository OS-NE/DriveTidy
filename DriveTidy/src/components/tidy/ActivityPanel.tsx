import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { clearActivity, droppedActivity, useActivity, type ActivityKind } from "@/lib/activity";

const FILTERS: (ActivityKind | "all")[] = ["all", "skipped", "moved", "failed", "stopped"];

export function ActivityPanel() {
  const entries = useActivity();
  const [filter, setFilter] = useState<ActivityKind | "all">("all");
  const shown = useMemo(() => {
    const list = filter === "all" ? entries : entries.filter((e) => e.kind === filter);
    return list.slice(-500).reverse();
  }, [entries, filter]);
  const count = (k: ActivityKind) => entries.filter((e) => e.kind === k).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? "default" : "secondary"}
            onClick={() => setFilter(f)}
          >
            {f} · {f === "all" ? entries.length : count(f)}
          </Button>
        ))}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={clearActivity}>
          Clear log
        </Button>
      </div>
      {droppedActivity() > 0 && (
        <p className="text-xs text-muted-foreground">
          Oldest {droppedActivity()} entries were trimmed.
        </p>
      )}
      <ul className="max-h-[32rem] divide-y divide-border overflow-auto rounded-lg border border-border bg-card">
        {shown.map((e) => (
          <li key={e.id} className="flex gap-3 px-3 py-2 font-mono text-xs">
            <span className="w-16 shrink-0 text-muted-foreground">
              {new Date(e.time).toLocaleTimeString()}
            </span>
            <span
              className={`w-16 shrink-0 uppercase ${e.kind === "failed" || e.kind === "stopped" ? "text-destructive" : e.kind === "moved" ? "text-primary" : "text-muted-foreground"}`}
            >
              {e.kind}
            </span>
            <span className="min-w-0 flex-1 truncate" title={e.path}>
              {e.path}
            </span>
            <span className="shrink-0 text-muted-foreground">{e.reason}</span>
          </li>
        ))}
        {!shown.length && (
          <li className="px-3 py-6 text-center text-sm text-muted-foreground">No activity yet.</li>
        )}
      </ul>
    </div>
  );
}
