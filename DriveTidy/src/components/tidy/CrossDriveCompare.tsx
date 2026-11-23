import { useMemo, useState } from "react";
import { Copy, FolderPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import {
  directoryDisplayName,
  findDuplicates,
  pickDirectory,
  scanDirectory,
  type DuplicateGroup,
  type DuplicateStage,
  type ScannedFile,
} from "@/lib/fs";
import { formatBytes } from "@/lib/organize";

interface Source {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
  files: ScannedFile[];
}

export function CrossDriveCompare({
  root,
  files,
}: {
  root: FileSystemDirectoryHandle;
  files: ScannedFile[];
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<[number, number, DuplicateStage] | null>(null);
  const [scanProgress, setScanProgress] = useState<[number, string] | null>(null);
  const [stopper, setStopper] = useState<AbortController | null>(null);
  const allFiles = useMemo(() => {
    const prefix = (file: ScannedFile, sourceId: string, sourceName: string): ScannedFile => ({
      ...file,
      id: `${sourceId}:${file.id}`,
      path: `${sourceName}/${file.path}`,
    });
    return [
      ...files.map((file) => prefix(file, "primary", directoryDisplayName(root))),
      ...sources.flatMap((source) =>
        source.files.map((file) => prefix(file, source.id, source.name)),
      ),
    ];
  }, [files, root.name, sources]);

  const addSource = async () => {
    let scanStarted = false;
    try {
      const handle = await pickDirectory("read");
      for (const source of sources) {
        if (await handle.isSameEntry(source.handle)) {
          toast("That location is already in the comparison.");
          return;
        }
      }
      if (await handle.isSameEntry(root)) {
        toast("That is the current drive. Choose a different location.");
        return;
      }
      const controller = new AbortController();
      setStopper(controller);
      setBusy(true);
      setScanProgress([0, ""]);
      scanStarted = true;
      const scanned = await scanDirectory(
        handle,
        (count, path) => setScanProgress([count, path]),
        undefined,
        controller.signal,
      );
      const locationName = directoryDisplayName(handle);
      const sameName =
        1 +
        [root, ...sources.map((source) => source.handle)].filter(
          (existing) => directoryDisplayName(existing) === locationName,
        ).length;
      const name = sameName > 1 ? `${locationName} (${sameName})` : locationName;
      setSources((current) => [
        ...current,
        { id: crypto.randomUUID(), name, handle, files: scanned },
      ]);
      setGroups(null);
      toast.success(`Added ${scanned.length.toLocaleString()} files from ${name}.`);
    } catch (error) {
      if ((error as Error).name !== "AbortError")
        toast.error(error instanceof Error ? error.message : String(error));
      else if (scanStarted) toast("Location scan stopped. Nothing was changed.");
      else toast("Folder selection canceled. Nothing was scanned.");
    } finally {
      setBusy(false);
      setStopper(null);
      setScanProgress(null);
    }
  };

  const compare = async () => {
    if (allFiles.length === 0) return;
    const controller = new AbortController();
    setStopper(controller);
    setBusy(true);
    try {
      const found = await findDuplicates(
        allFiles,
        (done, total, stage) => setProgress([done, total, stage]),
        controller.signal,
      );
      setGroups(found);
    } catch (error) {
      if ((error as Error).name === "AbortError") toast("Comparison stopped. Nothing was changed.");
      else toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      setStopper(null);
      setProgress(null);
    }
  };

  const verified = (groups ?? []).filter((group) => group.status === "verified");
  const reclaimable = verified.reduce(
    (sum, group) => sum + (group.files[0]?.size ?? 0) * (group.files.length - 1),
    0,
  );

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h3 className="flex items-center gap-2 font-semibold">
            <Copy className="h-4 w-4" />
            Compare drives and synced cloud folders
          </h3>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Choose additional external drives or folders, then compare them with /{directoryDisplayName(root)}.
            Google Drive and OneDrive work through folders available on this PC. Files stay local;
            online-only files may need to be available on this PC. Matches are verified with
            SHA-256. This comparison only creates a report.
          </p>
        </div>
        <Button variant="outline" onClick={addSource} disabled={busy}>
          <FolderPlus className="h-4 w-4" />
          Add drive or folder
        </Button>
        <Button onClick={compare} disabled={busy || allFiles.length === 0}>
          Compare {allFiles.length.toLocaleString()} files
        </Button>
      </div>
      {sources.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {sources.map((source) => (
            <span
              key={source.id}
              className="inline-flex items-center gap-1 rounded bg-secondary py-1 pl-2 font-mono text-xs"
            >
              {source.name} · {source.files.length.toLocaleString()} files
              <button
                type="button"
                className="rounded p-1 hover:bg-background"
                aria-label={`Remove ${source.name} from comparison`}
                onClick={() => {
                  setSources((current) => current.filter((item) => item.id !== source.id));
                  setGroups(null);
                }}
                disabled={busy}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {scanProgress && (
        <div className="space-y-1">
          <Progress className="animate-pulse" value={100} />
          <p className="truncate font-mono text-xs text-muted-foreground">
            Scanning {scanProgress[0].toLocaleString()} files · {scanProgress[1]}
          </p>
          <Button size="sm" variant="ghost" onClick={() => stopper?.abort()}>
            Stop
          </Button>
        </div>
      )}
      {progress && (
        <div className="space-y-1">
          <Progress value={(progress[0] / Math.max(1, progress[1])) * 100} />
          <p className="font-mono text-xs text-muted-foreground">
            {progress[2] === "candidates"
              ? `Hashing candidates ${progress[0]} / ${progress[1]}`
              : `Verifying full contents ${formatBytes(progress[0])} / ${formatBytes(progress[1])}`}
          </p>
          <Button size="sm" variant="ghost" onClick={() => stopper?.abort()}>
            Stop
          </Button>
        </div>
      )}
      {groups && (
        <div className="space-y-2">
          <p className="font-mono text-xs text-muted-foreground">
            {verified.length} verified duplicate groups · {formatBytes(reclaimable)} duplicate data
            · {groups.length - verified.length} possible or unreadable groups
          </p>
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No duplicates found across the selected locations.
            </p>
          ) : (
            groups.map((group, index) => (
              <div
                key={`${index}-${group.files[0]?.id}`}
                className="rounded-md border border-border p-3"
              >
                <p
                  className={
                    group.status === "verified"
                      ? "text-sm font-semibold text-primary"
                      : "text-sm font-semibold text-muted-foreground"
                  }
                >
                  {group.status === "verified" ? "Verified identical contents" : "Not confirmed"} ·{" "}
                  {group.files.length} files · {formatBytes(group.files[0]?.size ?? 0)} each
                </p>
                {group.files.map((file) => (
                  <p key={file.id} className="break-all font-mono text-xs text-muted-foreground">
                    {file.path}
                  </p>
                ))}
                {group.reason && (
                  <p className="mt-1 text-xs text-muted-foreground">{group.reason}</p>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
