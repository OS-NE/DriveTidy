import { isIgnoredFolder, isUnsafeFile } from "@/lib/organize";
import { logActivity } from "@/lib/activity";
import { blobsIdentical, hashBlobFull, readBytes, CHUNK } from "@/lib/sha256";
// Browser-only helpers around the File System Access API.

export interface ScannedFile {
  id: string;
  name: string;
  path: string; // relative to root, incl. name
  size: number;
  lastModified: number;
  type: string;
  handle: FileSystemFileHandle;
  parent: FileSystemDirectoryHandle;
  hash?: string;
}

type DirWithIter = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemHandle>;
};

export function fsSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

/** Folder access must start in a standalone tab, not the embedded preview. */
export function fsEmbedded(): boolean {
  return typeof window !== "undefined" && window.self !== window.top;
}

export function isDriveRootDirectory(handle: FileSystemDirectoryHandle): boolean {
  return handle.name.trim().length === 0;
}

export function directoryDisplayName(handle: FileSystemDirectoryHandle): string {
  return isDriveRootDirectory(handle) ? "Drive root" : handle.name;
}

const DRIVE_ROOT_SCAN_CONFIRMATION =
  "You selected an entire drive. The folder picker does not provide DriveTidy with its drive letter. DriveTidy will read file names and metadata during the scan; it will not change files. This may take a while. Continue?";

// Only one native picker can be open at a time; repeat clicks reuse the open one
// instead of throwing "File picker already active".
let activePicker: Promise<FileSystemDirectoryHandle> | null = null;

export async function pickDirectory(mode: "readwrite" | "read" = "readwrite"): Promise<FileSystemDirectoryHandle> {
  if (fsEmbedded()) {
    throw new Error("Open DriveTidy in a new tab to choose a drive or folder.");
  }
  if (activePicker) return activePicker;
  const w = window as unknown as {
    showDirectoryPicker: (o: { mode: string; id?: string }) => Promise<FileSystemDirectoryHandle>;
  };
  activePicker = (async () => {
    const selected = await w.showDirectoryPicker({
      mode,
      id: mode === "read" ? "drive-tidy-compare" : "drive-tidy",
    });
    if (isDriveRootDirectory(selected) && !window.confirm(DRIVE_ROOT_SCAN_CONFIRMATION)) {
      throw new DOMException("Drive-root scan was not confirmed.", "AbortError");
    }
    return selected;
  })();
  try {
    return await activePicker;
  } finally {
    activePicker = null;
  }
}

const SKIP = new Set([
  "$RECYCLE.BIN",
  "System Volume Information",
  ".Trashes",
  ".Spotlight-V100",
  ".fseventsd",
  "node_modules",
  ".git",
]);

export async function scanDirectory(
  root: FileSystemDirectoryHandle,
  onProgress: (count: number, path: string) => void,
  excludeFolder?: string,
  signal?: AbortSignal,
): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];
  async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
    for await (const entry of (dir as DirWithIter).values()) {
      if (signal?.aborted) throw new DOMException("Scan cancelled", "AbortError");
      const p = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === "directory") {
        if (p === excludeFolder) continue;
        if (SKIP.has(entry.name) || isIgnoredFolder(entry.name)) {
          logActivity(
            "skipped",
            p + "/",
            entry.name.startsWith(".") ? "Hidden folder" : "System or program folder",
          );
          continue;
        }
        try {
          await walk(entry as FileSystemDirectoryHandle, p);
        } catch (e) {
          if ((e as Error).name === "AbortError") throw e;
          logActivity("skipped", p + "/", "Folder could not be opened (permission denied)");
        }
      } else {
        if (
          entry.name.startsWith("._") ||
          entry.name === ".DS_Store" ||
          entry.name === "desktop.ini"
        ) {
          logActivity("skipped", p, "System metadata file");
          continue;
        }
        if (isUnsafeFile(entry.name)) {
          logActivity("skipped", p, "Program or script file (kept untouched for safety)");
          continue;
        }
        try {
          const fh = entry as FileSystemFileHandle;
          const f = await fh.getFile();
          out.push({
            id: p,
            name: entry.name,
            path: p,
            size: f.size,
            lastModified: f.lastModified,
            type: f.type,
            handle: fh,
            parent: dir,
          });
          if (out.length % 50 === 0) onProgress(out.length, p);
        } catch {
          logActivity("skipped", p, "File could not be read");
        }
      }
    }
  }
  await walk(root, "");
  onProgress(out.length, "");
  return out;
}

async function sha256(buf: BufferSource): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Files above this size are first fingerprinted from samples, then fully verified. */
export const SAMPLE_LIMIT = 64 * 1024 * 1024;

/**
 * Fast fingerprint. Files up to SAMPLE_LIMIT get a full SHA-256 (prefix "f:").
 * Larger files get head+middle+tail samples plus size (prefix "s"): a CANDIDATE
 * match only, never proof of identical content.
 */
export async function hashFile(f: ScannedFile): Promise<string> {
  const file = await f.handle.getFile();
  if (file.size <= SAMPLE_LIMIT) return "f:" + (await sha256(await readBytes(file, 0, file.size)));
  const C = 4 * 1024 * 1024;
  const mid = Math.floor(file.size / 2);
  const parts = await Promise.all([
    readBytes(file, 0, C),
    readBytes(file, mid, mid + C),
    readBytes(file, file.size - C, file.size),
  ]);
  const joined = new Uint8Array(C * 3);
  let o = 0;
  for (const p of parts) {
    joined.set(p, o);
    o += p.byteLength;
  }
  return "s" + file.size + ":" + (await sha256(joined));
}

/** Full-content SHA-256 of a scanned file, read in chunks (bounded memory). */
export async function fullHash(
  f: ScannedFile,
  signal?: AbortSignal,
  onBytes?: (n: number) => void,
): Promise<string> {
  return hashBlobFull(await f.handle.getFile(), signal, onBytes);
}

export type DuplicateStatus = "verified" | "potential" | "failed";
export interface DuplicateGroup {
  files: ScannedFile[];
  status: DuplicateStatus;
  reason?: string;
}
export type DuplicateStage = "candidates" | "verifying";

function sortGroup(g: ScannedFile[]) {
  return g.sort((a, b) => a.path.length - b.path.length || a.lastModified - b.lastModified);
}

/**
 * Size clustering → fingerprint candidates → mandatory full-content verification.
 * Only "verified" groups have had every byte proven identical.
 */
export async function findDuplicates(
  files: ScannedFile[],
  onProgress: (done: number, total: number, stage: DuplicateStage) => void,
  signal?: AbortSignal,
): Promise<DuplicateGroup[]> {
  const bySize = new Map<number, ScannedFile[]>();
  for (const f of files) {
    if (f.size === 0) continue;
    const arr = bySize.get(f.size) ?? [];
    arr.push(f);
    bySize.set(f.size, arr);
  }
  const candidates = [...bySize.values()].filter((g) => g.length > 1).flat();
  const byHash = new Map<string, ScannedFile[]>();
  let done = 0;
  for (const f of candidates) {
    signal?.throwIfAborted();
    try {
      f.hash = await hashFile(f);
      const arr = byHash.get(f.hash) ?? [];
      arr.push(f);
      byHash.set(f.hash, arr);
    } catch (e) {
      logActivity("skipped", f.path, `Duplicate check could not read file: ${errText(e)}`);
    }
    onProgress(++done, candidates.length, "candidates");
  }
  const out: DuplicateGroup[] = [];
  const toVerify: ScannedFile[][] = [];
  for (const [key, g] of byHash) {
    if (g.length < 2) continue;
    if (key.startsWith("f:")) out.push({ files: sortGroup(g), status: "verified" });
    else toVerify.push(g);
  }
  const totalBytes = toVerify.reduce((s, g) => s + g.length * (g[0]?.size ?? 0), 0);
  let doneBytes = 0;
  if (toVerify.length) onProgress(0, totalBytes, "verifying");
  for (const g of toVerify) {
    const byFull = new Map<string, ScannedFile[]>();
    let failure: string | undefined;
    for (const f of g) {
      signal?.throwIfAborted();
      try {
        const h = await fullHash(f, signal, (n) => {
          doneBytes += n;
          onProgress(doneBytes, totalBytes, "verifying");
        });
        const arr = byFull.get(h) ?? [];
        arr.push(f);
        byFull.set(h, arr);
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e;
        failure = `Could not fully read ${f.path}: ${errText(e)}`;
        break;
      }
    }
    if (failure) {
      out.push({ files: sortGroup(g), status: "failed", reason: failure });
      continue;
    }
    const leftovers: ScannedFile[] = [];
    for (const sub of byFull.values()) {
      if (sub.length > 1) out.push({ files: sortGroup(sub), status: "verified" });
      else leftovers.push(...sub);
    }
    if (leftovers.length)
      out.push({
        files: sortGroup(leftovers),
        status: "failed",
        reason: "Sampled fingerprints matched, but full contents differ — not duplicates",
      });
  }
  const rank = { verified: 0, potential: 1, failed: 2 } as const;
  return out.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      (b.files[0]?.size ?? 0) * (b.files.length - 1) -
        (a.files[0]?.size ?? 0) * (a.files.length - 1),
  );
}

/** Immediately before a destructive action: re-prove the copy is byte-identical to the kept original. */
export async function revalidateDuplicate(
  keep: ScannedFile,
  copy: ScannedFile,
  signal?: AbortSignal,
): Promise<void> {
  const [a, b] = await Promise.all([keep.handle.getFile(), copy.handle.getFile()]);
  if (a.size !== b.size || !(await blobsIdentical(a, b, signal))) {
    throw new Error(`${copy.path} no longer matches ${keep.path}; left untouched`);
  }
}

function errText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export async function ensureDir(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle> {
  let d = root;
  for (const seg of path.split("/").filter(Boolean))
    d = await d.getDirectoryHandle(seg, { create: true });
  return d;
}

async function exists(dir: FileSystemDirectoryHandle, name: string) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function freeName(dir: FileSystemDirectoryHandle, name: string) {
  if (!(await exists(dir, name))) return name;
  const i = name.lastIndexOf(".");
  const base = i > 0 ? name.slice(0, i) : name;
  const ext = i > 0 ? name.slice(i) : "";
  for (let n = 2; ; n++) {
    const c = `${base}-${n}${ext}`;
    if (!(await exists(dir, c))) return c;
  }
}

export type TransferFailure = "interrupted" | "verification" | "conflict" | "failed";
export class TransferError extends Error {
  constructor(
    public kind: TransferFailure,
    message: string,
  ) {
    super(message);
    this.name = kind === "interrupted" ? "AbortError" : "TransferError";
  }
}

// Native move() errors that mean "this browser/filesystem can't move this handle" → use the verified copy.
// Chromium rejects some moves of user-picked (non-OPFS) files with AbortError, so AbortError counts as
// "unsupported" ONLY when our own stop signal was not triggered. Permission errors (NotAllowedError,
// SecurityError) are real failures: they are reported, never retried as a copy.
const MOVE_UNSUPPORTED = new Set([
  "NotSupportedError",
  "InvalidModificationError",
  "InvalidStateError",
  "TypeError",
  "AbortError",
]);

export function nativeMoveUnsupported(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  return MOVE_UNSUPPORTED.has((e as Error)?.name) || e instanceof TypeError;
}

/**
 * Move (or rename, when dest === parent) a file safely.
 * Native move() is tried first; if the browser says it can't, fall back to:
 * write → close → read back → full byte-for-byte compare → re-check the source is unchanged → delete original.
 * On any failure or stop the partial/corrupt destination is removed and the original is untouched.
 * Limitation: browsers have no atomic "delete if unchanged", so a write landing in the instant between
 * the final source re-check and removeEntry() cannot be detected.
 */
export async function moveFile(
  f: ScannedFile,
  dest: FileSystemDirectoryHandle,
  newName = f.name,
  signal?: AbortSignal,
  failOnConflict = false,
): Promise<string> {
  signal?.throwIfAborted();
  const same = (await dest.isSameEntry(f.parent)) && newName === f.name;
  if (same) return newName;
  if (failOnConflict && await exists(dest, newName)) {
    throw new TransferError("conflict", `Destination ${newName} already exists; original left untouched.`);
  }
  const finalName = failOnConflict ? newName : await freeName(dest, newName);
  const mover = f.handle as FileSystemFileHandle & {
    move?: (d: FileSystemDirectoryHandle, n: string) => Promise<void>;
  };
  if (typeof mover.move === "function") {
    try {
      await mover.move(dest, finalName);
      return finalName;
    } catch (e) {
      if (signal?.aborted) {
        logActivity("stopped", f.path, "Stopped during move; original left in place");
        throw new TransferError("interrupted", `Stopped while moving ${f.path}`);
      }
      if (!nativeMoveUnsupported(e, signal)) {
        logActivity("failed", f.path, `Move failed: ${errText(e)}`);
        throw new TransferError("failed", `Could not move ${f.path}: ${errText(e)}`);
      }
      // Unsupported here: continue with the verified copy below. The source is untouched.
    }
  }
  signal?.throwIfAborted();
  const src = await f.handle.getFile();
  // A second guard narrows the race window for restore operations. The File System Access
  // API has no portable atomic "create only if absent", so this cannot eliminate all races.
  if (failOnConflict && await exists(dest, finalName)) {
    throw new TransferError("conflict", `Destination ${finalName} became occupied; original left untouched.`);
  }
  const out = await dest.getFileHandle(finalName, { create: true });
  const cleanup = async () => {
    try {
      await dest.removeEntry(finalName);
    } catch {
      /* ignore */
    }
  };
  let w: FileSystemWritableFileStream | undefined;
  try {
    w = await out.createWritable();
    for (let o = 0; o < src.size; o += CHUNK) {
      signal?.throwIfAborted();
      await w.write(await readBytes(src, o, Math.min(src.size, o + CHUNK)));
    }
    signal?.throwIfAborted();
    await w.close();
    w = undefined;
  } catch (e) {
    try {
      await w?.abort();
    } catch {
      /* ignore */
    }
    await cleanup();
    if (signal?.aborted || (e as Error)?.name === "AbortError") {
      logActivity("stopped", f.path, "Stopped mid-copy; partial copy removed, original untouched");
      throw new TransferError("interrupted", `Stopped while copying ${f.path}; original untouched`);
    }
    logActivity(
      "failed",
      f.path,
      `Copy failed (${errText(e)}); partial copy removed, original untouched`,
    );
    throw new TransferError("failed", `Copy of ${f.path} failed: ${errText(e)}`);
  }
  let identical = false;
  let why = "contents differ";
  try {
    const written = await out.getFile();
    identical = written.size === src.size && (await blobsIdentical(src, written, signal));
    if (written.size !== src.size) why = `size ${written.size} ≠ ${src.size}`;
  } catch (e) {
    why = errText(e);
    if (signal?.aborted) {
      await cleanup();
      logActivity(
        "stopped",
        f.path,
        "Stopped during verification; copy removed, original untouched",
      );
      throw new TransferError(
        "interrupted",
        `Stopped while verifying ${f.path}; original untouched`,
      );
    }
  }
  if (!identical) {
    await cleanup();
    logActivity(
      "failed",
      f.path,
      `Copy verification failed (${why}); bad copy removed, original untouched`,
    );
    throw new TransferError(
      "verification",
      `Copy verification failed for ${f.path} (${why}); original untouched`,
    );
  }
  // Final guard: the source must still be the same entry with the same contents we copied.
  let conflict: string | undefined;
  try {
    const current = await f.parent.getFileHandle(f.name);
    if (typeof current.isSameEntry === "function" && !(await current.isSameEntry(f.handle)))
      conflict = "source was replaced";
    else {
      const now = await current.getFile();
      if (now.size !== src.size || now.lastModified !== src.lastModified)
        conflict = "source changed during the move";
      else if (!(await blobsIdentical(now, await out.getFile(), signal)))
        conflict = "source contents changed during the move";
    }
  } catch (e) {
    if (signal?.aborted) conflict = "stopped before removing the original";
    else conflict = `source could not be re-checked (${errText(e)})`;
  }
  if (conflict) {
    await cleanup();
    logActivity("failed", f.path, `Move cancelled: ${conflict}; original kept, copy removed`);
    throw new TransferError("conflict", `Move of ${f.path} cancelled: ${conflict}; original kept`);
  }
  await f.parent.removeEntry(f.name);
  return finalName;
}

export interface ProblemFile {
  file: ScannedFile;
  reason: string;
}

/** Try to actually read a sample of the file; unreadable/corrupt files throw. */
export async function checkFileHealth(f: ScannedFile): Promise<string | null> {
  try {
    const file = await f.handle.getFile();
    if (file.size > 0) {
      const sample = file.slice(0, Math.min(file.size, 64 * 1024));
      const buf = await sample.arrayBuffer();
      if (buf.byteLength === 0) throw new Error("read returned no data");
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Unreadable file";
  }
}

/** Health-check every file, returning only the ones that fail to read. */
export async function findProblemFiles(
  files: ScannedFile[],
  onProgress: (done: number, total: number) => void,
): Promise<ProblemFile[]> {
  const out: ProblemFile[] = [];
  let done = 0;
  for (const f of files) {
    const reason = await checkFileHealth(f);
    if (reason) out.push({ file: f, reason });
    onProgress(++done, files.length);
  }
  return out;
}

export interface EmptyFolder {
  path: string; // relative to root
  handle: FileSystemDirectoryHandle;
  parent: FileSystemDirectoryHandle;
}

/** List empty folders, deepest first so parents emptied by child removals come later. */
export async function listEmptyFolders(
  root: FileSystemDirectoryHandle,
  excludeFolder?: string,
): Promise<EmptyFolder[]> {
  // walk returns whether the subtree has content; empties are collected deepest-first
  const empties: EmptyFolder[] = [];
  async function walk2(
    dir: FileSystemDirectoryHandle,
    prefix: string,
    parent: FileSystemDirectoryHandle,
  ): Promise<boolean> {
    let hasContent = false;
    const subdirs: { handle: FileSystemDirectoryHandle; path: string }[] = [];
    for await (const entry of (dir as DirWithIter).values()) {
      if (entry.kind === "directory") {
        const p = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (SKIP.has(entry.name) || isIgnoredFolder(entry.name) || p === excludeFolder) continue;
        subdirs.push({ handle: entry as FileSystemDirectoryHandle, path: p });
      } else {
        hasContent = true;
      }
    }
    for (const sub of subdirs) {
      const subHas = await walk2(sub.handle, sub.path, dir);
      if (subHas) hasContent = true;
    }
    if (!hasContent && prefix) empties.push({ path: prefix, handle: dir, parent });
    return hasContent;
  }
  await walk2(root, "", root);
  return empties;
}

/** Remove an empty folder; refuses (throws) if it is not empty. */
export async function removeEmptyFolder(f: EmptyFolder): Promise<void> {
  await f.parent.removeEntry(f.handle.name, { recursive: false });
}

/** Make a small JPEG data URL for AI: image directly, or a frame from a video. */
export async function thumbnailDataUrl(f: ScannedFile, max = 768): Promise<string> {
  const file = await f.handle.getFile();
  const url = URL.createObjectURL(file);
  let bitmap: ImageBitmap | undefined;
  let video: HTMLVideoElement | undefined;
  try {
    let source: CanvasImageSource;
    let w: number, h: number;
    if (file.type.startsWith("video/") || /\.(mp4|mov|webm|m4v|mkv)$/i.test(f.name)) {
      const v = document.createElement("video");
      video = v;
      v.muted = true;
      await new Promise<void>((res, rej) => {
        v.onloadeddata = () => res();
        v.onerror = () => rej(new Error("Cannot decode video"));
        v.src = url;
      });
      const time = Number.isFinite(v.duration) ? Math.min(2, v.duration / 3) : 0;
      if (time > 0)
        await new Promise<void>((res, rej) => {
          v.onseeked = () => res();
          v.onerror = () => rej(new Error("Cannot decode video frame"));
          v.currentTime = time;
        });
      source = v;
      w = v.videoWidth;
      h = v.videoHeight;
    } else {
      const img = await createImageBitmap(file);
      bitmap = img;
      source = img;
      w = img.width;
      h = img.height;
    }
    if (!w || !h) throw new Error("Cannot decode media dimensions");
    const s = Math.min(1, max / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    const context = c.getContext("2d");
    if (!context) throw new Error("Cannot create image preview");
    context.drawImage(source, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.8);
  } finally {
    bitmap?.close();
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    URL.revokeObjectURL(url);
  }
}
