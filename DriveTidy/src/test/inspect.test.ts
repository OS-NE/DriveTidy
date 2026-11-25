import { describe, expect, it } from "vitest";
import { createInspector, outcomeTone, summarize } from "@/lib/inspect";
import { Sha256 } from "@/lib/sha256";
import type { OpRecord } from "@/lib/journal";

const sha = (bytes: Uint8Array) => new Sha256().update(bytes).digestHex();
const enc = (text: string) => new TextEncoder().encode(text);

// --- minimal fake File System Access API ---
const notFound = () => new DOMException("not found", "NotFoundError");

class FakeFile {
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

class FakeDir {
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

const asRoot = (dir: FakeDir) => dir as unknown as FileSystemDirectoryHandle;

function op(bytes: Uint8Array, patch: Partial<OpRecord> = {}): OpRecord {
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

describe("recovery inspector", () => {
  it("treats a missing source folder as absent and still verifies the destination", async () => {
    const root = new FakeDir("root");
    const bytes = enc("hello world");
    const moved = root.mkdir("new").put("a.txt", bytes);
    const inspector = createInspector(asRoot(root), { kind: "restructure" });
    const { observation, result } = await inspector.inspect(
      op(bytes, { finalHandle: moved as unknown as FileSystemFileHandle }),
    );
    expect(observation.source).toBe("absent");
    expect(observation.dest).toBe("match");
    expect(observation.destSame).toBe(true);
    expect(result.outcome).toBe("completed");
  });

  it("reports a size mismatch as changed without reading the file", async () => {
    const root = new FakeDir("root");
    const bytes = enc("hello world");
    root.mkdir("old").mkdir("sub").put("a.txt", enc("hello"));
    const inspector = createInspector(asRoot(root), { kind: "restructure" });
    const { observation } = await inspector.inspect(op(bytes));
    expect(observation.source).toBe("differs");
    expect(inspector.stats).toEqual({ hashed: 0, sizeShortcuts: 1 });
  });

  it("still detects same-size content changes by hashing", async () => {
    const root = new FakeDir("root");
    root.mkdir("old").mkdir("sub").put("a.txt", enc("hellp world"));
    const inspector = createInspector(asRoot(root), { kind: "restructure" });
    const { observation } = await inspector.inspect(op(enc("hello world")));
    expect(observation.source).toBe("differs");
    expect(inspector.stats.hashed).toBe(1);
  });

  it("reports a vanished stored destination handle as absent when the path is known", async () => {
    const root = new FakeDir("root");
    root.mkdir("new");
    const bytes = enc("data");
    const ghost = new FakeFile("a.txt", bytes, true);
    const inspector = createInspector(asRoot(root), { kind: "restructure" });
    const known = await inspector.inspect(
      op(bytes, { finalHandle: ghost as unknown as FileSystemFileHandle }),
    );
    expect(known.observation.dest).toBe("absent");

    const unknownPath = op(bytes, {
      toDir: "somewhere/else",
      finalHandle: ghost as unknown as FileSystemFileHandle,
    });
    delete unknownPath.toPath;
    const unknown = await inspector.inspect(unknownPath);
    expect(unknown.observation.dest).toBe("unreadable");
  });

  it("recognises the bytes through a stored handle when the path no longer matches", async () => {
    const root = new FakeDir("root");
    const bytes = enc("moved elsewhere");
    const stored = new FakeFile("renamed.txt", bytes);
    const inspector = createInspector(asRoot(root), { kind: "restructure" });
    const { observation, result } = await inspector.inspect(
      op(bytes, { finalHandle: stored as unknown as FileSystemFileHandle }),
    );
    expect(observation.dest).toBe("match");
    expect(observation.destSame).toBe(false);
    expect(result.outcome).toBe("probable-completion");
  });

  it("resolves each folder once and reuses it across operations", async () => {
    const root = new FakeDir("root");
    const sub = root.mkdir("old").mkdir("sub");
    for (const name of ["a.txt", "b.txt", "c.txt"]) sub.put(name, enc(name));
    const inspector = createInspector(asRoot(root), { kind: "restructure" });
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      await inspector.inspect(op(enc(name), { fromName: name, toPath: "old/sub" }));
    }
    // "old" is looked up once from the root, not once per operation.
    expect(root.lookups).toBe(1);
  });

  it("flags lost access instead of guessing", async () => {
    const root = new FakeDir("root");
    const bytes = enc("x");
    const file = root.mkdir("old").mkdir("sub").put("a.txt", bytes);
    file.denied = true;
    const inspector = createInspector(asRoot(root), { kind: "restructure" });
    const { observation, result } = await inspector.inspect(op(bytes));
    expect(observation.access).toBe("missing");
    expect(result.outcome).toBe("waiting-for-access");
  });

  it("stops with an AbortError when cancelled", async () => {
    const root = new FakeDir("root");
    const controller = new AbortController();
    controller.abort();
    const inspector = createInspector(asRoot(root), { kind: "restructure" }, controller.signal);
    let name = "";
    try {
      await inspector.inspect(op(enc("x")));
    } catch (error) {
      name = (error as Error).name;
    }
    expect(name).toBe("AbortError");
  });
});

describe("inspection summary", () => {
  it("only counts identity-verified completions as safe to finalize", async () => {
    const root = new FakeDir("root");
    const bytes = enc("ok");
    const moved = root.mkdir("new").put("a.txt", bytes);
    const inspector = createInspector(asRoot(root), { kind: "restructure" });
    const done = await inspector.inspect(
      op(bytes, { id: "1", finalHandle: moved as unknown as FileSystemFileHandle }),
    );
    const missing = await inspector.inspect(op(enc("gone"), { id: "2", finalName: "nope.txt" }));

    const some = summarize([done, missing], 2);
    expect(some.completed).toBe(1);
    expect(some.attention).toBe(1);
    expect(some.safeToFinalize).toBe(false);
    expect(some.tones.good).toBe(1);
    expect(some.tones.bad).toBe(1);

    const all = summarize([done], 1);
    expect(all.safeToFinalize).toBe(true);
    expect(summarize([], 0).safeToFinalize).toBe(false);
  });

  it("maps outcomes to display tones", () => {
    expect(outcomeTone("completed")).toBe("good");
    expect(outcomeTone("not-started")).toBe("info");
    expect(outcomeTone("probable-completion")).toBe("warn");
    expect(outcomeTone("needs-review")).toBe("bad");
  });
});
