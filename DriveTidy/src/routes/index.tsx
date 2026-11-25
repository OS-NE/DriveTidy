import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  HardDrive,
  FolderOpen,
  Copy,
  FolderTree,
  Sparkles,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import {
  directoryDisplayName,
  fsSupported,
  fsEmbedded,
  pickDirectory,
  scanDirectory,
  type ScannedFile,
} from "@/lib/fs";
import { categoryOf, formatBytes, isPoorlyNamed } from "@/lib/organize";
import { DuplicatesPanel } from "@/components/tidy/DuplicatesPanel";
import { HealthPanel } from "@/components/tidy/HealthPanel";
import { RestructurePanel } from "@/components/tidy/RestructurePanel";
import { RenamePanel } from "@/components/tidy/RenamePanel";
import { ProviderSettings, ProviderSettingsProvider } from "@/components/tidy/ProviderSettings";
import { ActivityPanel } from "@/components/tidy/ActivityPanel";
import { HistoryPanel, RecoveryNotice } from "@/components/tidy/HistoryPanel";
import { ListChecks } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "DriveTidy — Private drive organizer" },
      {
        name: "description",
        content:
          "Organize messy drives, pen drives and external disks — privately, on your own PC.",
      },
      { property: "og:title", content: "DriveTidy — Private drive organizer" },
      {
        property: "og:description",
        content: "Find duplicates, restructure folders, and rename photos with free local AI.",
      },
      { name: "robots", content: "noindex, nofollow" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <ProviderSettingsProvider>
      <Index />
    </ProviderSettingsProvider>
  ),
});

const FEATURES = [
  {
    title: "Duplicate finder",
    description: "Content-hash matching. Quarantine verified copies for safe review.",
  },
  { title: "Restructure", description: "By category, type, date, or your own rules." },
  { title: "AI renamer", description: "IMG_4021.jpg → golden-retriever-on-beach.jpg" },
];

function Index() {
  const [supported, setSupported] = useState(true);
  const [tab, setTab] = useState("dupes");
  const [standaloneUrl, setStandaloneUrl] = useState<string>();
  const [root, setRoot] = useState<FileSystemDirectoryHandle | null>(null);
  const [files, setFiles] = useState<ScannedFile[]>([]);
  const [scan, setScan] = useState<{ count: number; path: string } | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setSupported(fsSupported());
    if (fsEmbedded()) setStandaloneUrl(window.location.href);
  }, []);

  const abortRef = useRef<AbortController | null>(null);
  const doScan = async (r: FileSystemDirectoryHandle) => {
    const ac = new AbortController();
    abortRef.current = ac;
    setScan({ count: 0, path: "" });
    setError(undefined);
    try {
      setFiles(
        await scanDirectory(r, (count, path) => setScan({ count, path }), undefined, ac.signal),
      );
    } catch (e) {
      if ((e as Error).name === "AbortError")
        setError("Scan stopped. Rescan any time to try again.");
      else setError(e instanceof Error ? e.message : String(e));
    }
    abortRef.current = null;
    setScan(null);
  };

  const pick = async () => {
    try {
      const r = await pickDirectory();
      setRoot(r);
      await doScan(r);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    }
  };

  const stats = useMemo(() => {
    const by = new Map<string, number>();
    for (const f of files) by.set(categoryOf(f.name), (by.get(categoryOf(f.name)) ?? 0) + 1);
    return {
      total: files.reduce((s, f) => s + f.size, 0),
      poor: files.filter(
        (f) => isPoorlyNamed(f.name) && ["Images", "Videos"].includes(categoryOf(f.name)),
      ).length,
      by: [...by.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [files]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-6 py-4">
          <HardDrive className="h-6 w-6 text-primary" />
          <span className="font-display text-xl font-bold tracking-tight">DriveTidy</span>
          {root && (
            <div className="ml-auto flex items-center gap-2">
              <span className="rounded bg-secondary px-2 py-1 font-mono text-xs">
                /{directoryDisplayName(root)}
              </span>
              <Button variant="ghost" size="sm" onClick={() => doScan(root)} disabled={!!scan}>
                <RefreshCw className="h-4 w-4" />
                Rescan
              </Button>
              <Button variant="outline" size="sm" onClick={pick} disabled={!!scan}>
                Change drive
              </Button>
            </div>
          )}
          <div className={`flex items-center gap-1 ${!root ? "ml-auto" : ""}`}>
            <ProviderSettings />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        {!root ? (
          <section className="grid gap-10 py-10 md:grid-cols-[1.2fr_1fr] md:items-center">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
                drive organizer
              </p>
              <h1 className="mt-3 font-display text-5xl font-bold leading-[1.05] tracking-tight md:text-6xl">
                Your drive is a mess.
                <br />
                Let's fix it.
              </h1>
              <p className="mt-5 max-w-lg text-lg text-muted-foreground">
                Pick any folder, internal drive, pen drive or external hard drive. Find duplicates,
                sort everything into tidy folders, and let free local AI give your photos and videos
                real names.
              </p>
              {standaloneUrl ? (
                <>
                  <Button asChild size="lg" className="mt-8">
                    <a href={standaloneUrl} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-5 w-5" />
                      Open in new tab
                    </a>
                  </Button>
                  <p className="mt-3 text-sm text-muted-foreground">
                    This embedded preview can't access drives. Open DriveTidy in a new tab, then
                    choose your drive or folder.
                  </p>
                </>
              ) : (
                <Button size="lg" className="mt-8" onClick={pick} disabled={!supported}>
                  <FolderOpen className="h-5 w-5" />
                  Choose a drive or folder
                </Button>
              )}
              {!supported && (
                <p className="mt-3 text-sm text-destructive">
                  Your browser can't open local drives. Use Chrome or Edge on a computer, and open
                  the app in its own tab.
                </p>
              )}
              {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
              <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
                <ShieldCheck className="h-4 w-4 text-primary" />
                Files stay on your computer. Only small previews go to the AI running on your own
                PC.
              </p>
            </div>
            <div className="space-y-3">
              {FEATURES.map((feature, index) => {
                const I = [Copy, FolderTree, Sparkles][index] ?? Copy;
                return (
                  <div
                    key={feature.title}
                    className="flex gap-4 rounded-lg border border-border bg-card p-4"
                  >
                    <I className="h-5 w-5 shrink-0 text-primary" />
                    <div>
                      <div className="font-semibold">{feature.title}</div>
                      <div className="text-sm text-muted-foreground">{feature.description}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : scan ? (
          <div className="mx-auto max-w-md py-20 text-center">
            <p className="font-display text-2xl font-bold">
              Scanning /{directoryDisplayName(root)}
            </p>
            <Progress className="mt-6 animate-pulse" value={100} />
            <p className="mt-3 font-mono text-sm">{scan.count} files</p>
            <p className="truncate font-mono text-xs text-muted-foreground">{scan.path}</p>
            <Button
              variant="destructive"
              className="mt-6"
              onClick={() => abortRef.current?.abort()}
            >
              Stop scan
            </Button>
            <p className="mt-3 text-xs text-muted-foreground">
              Program files, scripts, AppData and hidden folders are skipped.
            </p>
          </div>
        ) : (
          <>
            <section className="mb-8 grid gap-3 sm:grid-cols-3">
              <Stat label="files" value={files.length.toLocaleString()} />
              <Stat label="total size" value={formatBytes(stats.total)} />
              <Stat label="poorly named media" value={String(stats.poor)} />
              <div className="flex flex-wrap gap-2 sm:col-span-3">
                {stats.by.map(([c, n]) => (
                  <span
                    key={c}
                    className="rounded bg-secondary px-2 py-1 font-mono text-xs text-secondary-foreground"
                  >
                    {c} · {n}
                  </span>
                ))}
              </div>
            </section>
            {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
            <RecoveryNotice onReview={() => setTab("history")} />
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="mb-4">
                <TabsTrigger value="dupes">
                  <Copy className="h-4 w-4" />
                  Duplicates
                </TabsTrigger>
                <TabsTrigger value="restructure">
                  <FolderTree className="h-4 w-4" />
                  Restructure
                </TabsTrigger>
                <TabsTrigger value="rename">
                  <Sparkles className="h-4 w-4" />
                  AI Rename
                </TabsTrigger>
                <TabsTrigger value="health">
                  <ShieldAlert className="h-4 w-4" />
                  Problem files
                </TabsTrigger>
                <TabsTrigger value="activity">
                  <ListChecks className="h-4 w-4" />
                  Activity log
                </TabsTrigger>
                <TabsTrigger value="history">
                  <ListChecks className="h-4 w-4" />
                  History
                </TabsTrigger>
              </TabsList>
              <TabsContent value="dupes">
                <DuplicatesPanel root={root} files={files} onChanged={() => doScan(root)} />
              </TabsContent>
              <TabsContent value="health">
                <HealthPanel root={root} files={files} onChanged={() => doScan(root)} />
              </TabsContent>
              <TabsContent value="restructure">
                <RestructurePanel root={root} files={files} onChanged={() => doScan(root)} />
              </TabsContent>
              <TabsContent value="rename">
                <RenamePanel files={files} onChanged={() => {}} />
              </TabsContent>
              <TabsContent value="activity">
                <ActivityPanel />
              </TabsContent>
              <TabsContent value="history">
                <HistoryPanel />
              </TabsContent>
            </Tabs>
          </>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-display text-3xl font-bold">{value}</div>
    </div>
  );
}
