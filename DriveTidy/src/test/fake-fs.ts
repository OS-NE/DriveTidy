// Shared fakes for tests that exercise recovery inspection without a real drive.
import { Sha256 } from "@/lib/sha256";
import type { OpRecord } from "@/lib/journal";

export const sha = (bytes: Uint8Array) => new Sha256().update(bytes).digestHex();
export const enc = (text: string) => new TextEncoder().encode(text);

// --- minimal fake File System Access API ---
const notFound = () => new DOMException("not found", "NotFoundError");

export class FakeFile {
  kind = "file" as const;
  constructor(
    public name: string,
    public bytes: Uint8Array,
    public gone = false,
    public denied = false,
  ) {}
  async getFile() {
    if (this.denied) throw new DOMException("denied", "NotAllowedError");
    if (this.gone) throw notFound();
    return new File([this.bytes as BlobPart], this.name);
  }
  async isSameEntry(other: unknown) {
    return other === this;
  }
}

export class FakeDir {
  kind = "directory" as const;
  files = new Map<string, FakeFile>();
  dirs = new Map<string, FakeDir>();
  lookups = 0;
  constructor(public name: string) {}
  async getDirectoryHandle(name: string) {
    this.lookups++;
    const dir = this.dirs.get(name);
    if (!dir) throw notFound();
    return dir;
  }
  async getFileHandle(name: string) {
    const file = this.files.get(name);
    if (!file) throw notFound();
    return file;
  }
  mkdir(name: string) {
    const dir = new FakeDir(name);
    this.dirs.set(name, dir);
    return dir;
  }
  put(name: string, bytes: Uint8Array) {
    const file = new FakeFile(name, bytes);
    this.files.set(name, file);
    return file;
  }
}

export const asRoot = (dir: FakeDir) => dir as unknown as FileSystemDirectoryHandle;

export function op(bytes: Uint8Array, patch: Partial<OpRecord> = {}): OpRecord {
  return {
    id: "op1",
    txId: "tx",
    batchId: "b",
    seq: 1,
    action: "move",
    fromDir: "old/sub",
    fromName: "a.txt",
    toDir: "new",
    toPath: "new",
    intendedName: "a.txt",
    finalName: "a.txt",
    size: bytes.length,
    lastModified: 0,
    sourceSha256: sha(bytes),
    identity: { source: "unconfirmed", staging: "unconfirmed", final: "unconfirmed" },
    state: "native-moved",
    updatedAt: 0,
    ...patch,
  };
}
