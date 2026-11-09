// Pure planning logic (no browser APIs) so it can be unit tested.

export type Category = "3D Print" | "Images" | "Videos" | "Audio" | "Documents" | "Archives" | "Code" | "Other";

const EXT: Record<Exclude<Category, "Other">, string[]> = {
  "3D Print": ["stl", "3mf", "gcode", "gco", "g", "nc", "obj", "step", "stp", "iges", "igs", "scad", "ply", "blend", "f3d", "amf", "ctm", "wrl", "x3d", "3ds", "x3g", "sldprt", "sldasm", "prt"],
  Images: ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tiff", "svg", "raw", "cr2", "nef"],
  Videos: ["mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv", "flv", "3gp"],
  Audio: ["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma"],
  Documents: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "rtf", "odt", "csv", "epub"],
  Archives: ["zip", "rar", "7z", "tar", "gz", "bz2", "iso"],
  Code: ["js", "ts", "tsx", "py", "java", "c", "cpp", "html", "css", "json", "xml", "sh"],
};

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function categoryOf(name: string): Category {
  const e = extOf(name);
  for (const [cat, list] of Object.entries(EXT)) if (list.includes(e)) return cat as Category;
  return "Other";
}

export type Strategy = "category" | "type" | "date" | "category-date";

/** Group in linear time without repeatedly copying every preceding file. */
export function groupFolderPlan<T>(plan: { f: T; folder: string }[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const { f, folder } of plan) {
    const group = groups.get(folder);
    if (group) group.push(f);
    else groups.set(folder, [f]);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export interface PlanInput {
  path: string; // relative path incl. name
  name: string;
  lastModified: number;
}

export function targetFolder(f: PlanInput, strategy: Strategy): string {
  const d = new Date(f.lastModified);
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, "0");
  switch (strategy) {
    case "category":
      return categoryOf(f.name);
    case "type":
      return (extOf(f.name) || "no-extension").toUpperCase();
    case "date":
      return `${y}/${y}-${m}`;
    case "category-date":
      return `${categoryOf(f.name)}/${y}/${y}-${m}`;
  }
}

/** A filename looks "poorly named" when it is a camera/screenshot/random default. */
export function isPoorlyNamed(name: string): boolean {
  const base = name.replace(/\.[^.]+$/, "");
  return (
    /^(img|dsc|dscn|dcim|pxl|mvimg|vid|mov|wp|photo|image|video|screenshot|untitled|new|file|download)[-_ ]?\d*/i.test(base) ||
    /^[\d\-_ .()]+$/.test(base) ||
    /^[a-f0-9-]{16,}$/i.test(base) ||
    base.length <= 2
  );
}

/** Turn an AI suggestion into a safe, clean filename slug. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "file";
}

/** Auto-apply threshold for AI rename confidence (0..1). */
export const AUTO_RENAME_CONFIDENCE = 0.8;

export function shouldAutoRename(confidence: number): boolean {
  return confidence >= AUTO_RENAME_CONFIDENCE;
}

/** Files analyzed per AI-rename run; the user continues batch by batch. */
export const RENAME_BATCH_SIZE = 200;

/** Batch sizes the user can pick for an AI-rename run. */
export const RENAME_BATCH_SIZES = [10, 20, 50, 100, 200] as const;

/** One naming request per file; failures may stop a run before this maximum. */
export function estimateRenameRequests(remainingFiles: number, batchSize: number = RENAME_BATCH_SIZE) {
  return { batch: Math.min(remainingFiles, batchSize), remaining: remainingFiles };
}

/** Pick the next chunk of candidates not yet analyzed, in drive order. */
export function nextRenameBatch<T extends { id: string }>(
  candidates: T[],
  processedIds: ReadonlySet<string>,
  max: number,
): T[] {
  const out: T[] = [];
  for (const f of candidates) {
    if (processedIds.has(f.id)) continue;
    out.push(f);
    if (out.length >= max) break;
  }
  return out;
}

/** Give a unique name inside a set of names already taken, e.g. "a.jpg" -> "a-2.jpg". */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const e = extOf(name);
  const base = e ? name.slice(0, -(e.length + 1)) : name;
  for (let i = 2; ; i++) {
    const n = e ? `${base}-${i}.${e}` : `${base}-${i}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    b /= 1024;
    i++;
  } while (b >= 1024 && i < u.length - 1);
  return `${b.toFixed(1)} ${u[i]}`;
}

/** Executable/script extensions skipped during scans so Chrome never raises dangerous-file prompts. */
export const UNSAFE_EXTS = new Set([
  // Windows executables, installers, libraries
  "exe", "msi", "msp", "msc", "bat", "cmd", "com", "scr", "pif", "cpl", "dll", "sys", "drv", "ocx", "efi",
  "appx", "appxbundle", "msix", "msixbundle", "gadget", "application", "xbap", "cab", "mui",
  // Shortcuts, registry, config that Chrome flags
  "lnk", "reg", "inf", "url", "scf", "website", "settingcontent-ms", "library-ms", "search-ms", "desktop",
  // Windows scripts
  "js", "mjs", "cjs", "jse", "vbs", "vbe", "wsf", "wsh", "wsc", "hta", "ps1", "psm1", "psd1", "ps1xml", "psc1", "msh", "msh1", "msh2",
  // Unix / mac
  "sh", "bash", "zsh", "csh", "ksh", "fish", "command", "tool", "run", "bin", "out", "elf", "so", "dylib", "app", "dmg", "pkg", "mpkg", "kext",
  // Linux / mobile packages
  "deb", "rpm", "apk", "aab", "xapk", "ipa", "snap", "flatpak", "appimage",
  // Interpreted languages and bytecode
  "py", "pyw", "pyc", "pyo", "pyz", "pyzw", "pyd", "ipynb", "rb", "rbw", "pl", "pm", "php", "phtml", "lua", "tcl", "r", "groovy",
  "jar", "class", "war", "ear", "jnlp", "swf",
  // Office macro files and compiled help
  "docm", "dotm", "xlsm", "xltm", "xlam", "pptm", "potm", "ppam", "sldm", "chm", "hlp",
  // Markup/config files Chrome can flag as potentially harmful
  "xml", "xsl", "xslt", "dtd", "rss", "atom", "xhtml", "config", "ini", "plist", "yaml", "yml", "toml", "env", "properties",
  // Other risky
  "iso", "img", "vhd", "vhdx", "vmdk", "crx", "xpi", "xll", "ade", "adp", "mde", "accde", "ins", "isp", "job", "lib", "obj",
]);

const SYSTEM_DIRS = new Set([
  "appdata", "$recycle.bin", "system volume information", "windows", "program files", "program files (x86)",
  "programdata", "$windows.~bt", "$windows.~ws", "recovery", "node_modules", "library",
]);

const UNSAFE_DOTFILES = new Set([".env", ".htaccess", ".htpasswd", ".npmrc", ".netrc", ".aws", ".ssh", ".gitconfig"]);

export function isUnsafeFile(name: string): boolean {
  return UNSAFE_EXTS.has(extOf(name)) || UNSAFE_DOTFILES.has(name.toLowerCase());
}

/** Hidden (dot-prefixed, incl. .cache), AppData, and OS/system folders are never scanned. */
export function isIgnoredFolder(name: string): boolean {
  return name.startsWith(".") || name.startsWith("$") || SYSTEM_DIRS.has(name.toLowerCase());
}
