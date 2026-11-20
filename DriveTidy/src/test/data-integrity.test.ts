import { describe, it, expect, beforeEach } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import { createHash } from "node:crypto";
import {
  findDuplicates,
  moveFile,
  nativeMoveUnsupported,
  SAMPLE_LIMIT,
  TransferError,
  type ScannedFile,
} from "@/lib/fs";
import { Sha256, hashBlobFull } from "@/lib/sha256";
import { clearActivity, useActivity } from "@/lib/activity";
import { renderHook } from "@testing-library/react";

const MB = 1024 * 1024;
const blob = (b: Uint8Array) => new NodeBlob([b]) as unknown as Blob;

// Minimal in-memory File System Access mock.
class MemDir {
  files = new Map<string, Uint8Array>();
  corrupt = false; // flip a byte while writing, keeping the size
  abortAfterChunks = -1;
  ctrl?: AbortController;
  async isSameEntry(o: unknown) {
    return o === this;
  }
  async removeEntry(name: string) {
    if (!this.files.delete(name)) throw new DOMException("missing", "NotFoundError");
  }
  beforeLookup?: (name: string) => void; // simulate outside changes right before the final source re-check
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (!opts?.create) this.beforeLookup?.(name);
    if (!this.files.has(name)) {
      if (!opts?.create) throw new DOMException("missing", "NotFoundError");
      this.files.set(name, new Uint8Array());
    }
    return fileHandle(this, name);
  }
}
function fileHandle(dir: MemDir, name: string) {
  return {
    kind: "file",
    name,
    getFile: async () => blob(dir.files.get(name)!),
    createWritable: async () => {
      const parts: Uint8Array[] = [];
      let n = 0;
      return {
        write: async (c: Uint8Array) => {
          if (dir.abortAfterChunks >= 0 && n++ >= dir.abortAfterChunks) dir.ctrl?.abort();
          parts.push(new Uint8Array(c));
          dir.files.set(name, concat(parts)); // partial content visible on disk, like a real drive
        },
        close: async () => {
          const all = concat(parts);
          if (dir.corrupt && all.length) {
            const i = all.length >> 1;
            all[i] = (all[i] ?? 0) ^ 0xff;
          }
          dir.files.set(name, all);
        },
        abort: async () => {},
      };
    },
  };
}
function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function scanned(dir: MemDir, name: string, path = name): ScannedFile {
  const data = dir.files.get(name)!;
  return {
    id: path,
    name,
    path,
    size: data.length,
    lastModified: 1,
    type: "",
    handle: fileHandle(dir, name) as unknown as FileSystemFileHandle,
    parent: dir as unknown as FileSystemDirectoryHandle,
  };
}
const log = () => renderHook(() => useActivity()).result.current;

beforeEach(() => clearActivity());

describe("incremental SHA-256", () => {
  const nodeHash = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");
  const bytes = (n: number) => new Uint8Array(n).map((_, i) => (i * 131 + 7) & 255);
  it.each([0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 4 * MB - 1, 4 * MB, 4 * MB + 1])(
    "matches Node for %i bytes",
    (n) => {
      const d = bytes(n);
      expect(new Sha256().update(d).digestHex()).toBe(nodeHash(d));
    },
  );
  it("matches Node when fed in uneven pieces spanning many 64-byte blocks", () => {
    const d = bytes(9 * MB + 13);
    const h = new Sha256();
    for (let o = 0, step = 1; o < d.length; o += step, step = (step * 7 + 3) % 1_000_003 || 1)
      h.update(d.subarray(o, o + step));
    expect(h.digestHex()).toBe(nodeHash(d));
  });
  it("hashBlobFull matches Node across 4 MB chunk boundaries", async () => {
    const d = bytes(8 * MB + 5);
    expect(await hashBlobFull(blob(d))).toBe(nodeHash(d));
  });
  it("matches Node's SHA-256 across chunk boundaries", () => {
    const data = new Uint8Array(1000).map((_, i) => (i * 7) & 255);
    const h = new Sha256();
    h.update(data.subarray(0, 3)).update(data.subarray(3, 130)).update(data.subarray(130));
    expect(h.digestHex()).toBe(createHash("sha256").update(data).digest("hex"));
    expect(new Sha256().digestHex()).toBe(createHash("sha256").digest("hex"));
  });
});

describe("large-file duplicate verification", () => {
  const size = SAMPLE_LIMIT + 8 * MB;
  it("A: sampled-fingerprint collision is NOT a verified duplicate", async () => {
    const d = new MemDir();
    const a = new Uint8Array(size).fill(7);
    const b = new Uint8Array(a);
    b[10 * MB] = 1; // unsampled region (outside head, middle and tail samples)
    d.files.set("a.bin", a);
    d.files.set("b.bin", b);
    const groups = await findDuplicates([scanned(d, "a.bin"), scanned(d, "b.bin")], () => {});
    expect(groups.some((g) => g.status === "verified")).toBe(false);
    expect(groups[0]?.status).toBe("failed");
  }, 60_000);

  it("B: identical large files are verified duplicates", async () => {
    const d = new MemDir();
    const a = new Uint8Array(size).map((_, i) => i & 255);
    d.files.set("a.bin", a);
    d.files.set("b.bin", new Uint8Array(a));
    const stages = new Set<string>();
    const groups = await findDuplicates([scanned(d, "a.bin"), scanned(d, "b.bin")], (_d, _t, s) =>
      stages.add(s),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.status).toBe("verified");
    expect(stages.has("verifying")).toBe(true);
  }, 60_000);
});

describe("cross-root duplicate comparison", () => {
  it("reports renamed copies only when the bytes match across separate roots", async () => {
    const primary = new MemDir();
    const external = new MemDir();
    primary.files.set("original.txt", new Uint8Array(Buffer.from("identical bytes")));
    external.files.set("renamed-copy.txt", new Uint8Array(Buffer.from("identical bytes")));
    external.files.set("same-size-different.txt", new Uint8Array(Buffer.from("different bytes")));
    const primaryCopy = scanned(primary, "original.txt", "Primary/original.txt");
    const renamedCopy = scanned(external, "renamed-copy.txt", "Secondary/renamed-copy.txt");
    const sameSizeDifferent = scanned(external, "same-size-different.txt", "Secondary/same-size-different.txt");

    const groups = await findDuplicates([primaryCopy, renamedCopy, sameSizeDifferent], () => {});

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ status: "verified" });
    expect(groups[0]?.files.map((file) => file.path)).toEqual([
      "Primary/original.txt",
      "Secondary/renamed-copy.txt",
    ]);
    expect([...primary.files.keys()]).toEqual(["original.txt"]);
    expect([...external.files.keys()]).toEqual(["renamed-copy.txt", "same-size-different.txt"]);
  });
});

describe("moveFile integrity", () => {
  const data = () => new Uint8Array(9 * MB).map((_, i) => (i * 31) & 255);

  it("C: same-size silent corruption keeps the original and removes the bad copy", async () => {
    const src = new MemDir();
    const dst = new MemDir();
    src.files.set("p.jpg", data());
    dst.corrupt = true;
    await expect(
      moveFile(scanned(src, "p.jpg"), dst as unknown as FileSystemDirectoryHandle),
    ).rejects.toMatchObject({ kind: "verification" });
    expect(src.files.has("p.jpg")).toBe(true);
    expect(dst.files.size).toBe(0);
    expect(
      log().some(
        (e) => e.kind === "failed" && e.path === "p.jpg" && /verification/i.test(e.reason),
      ),
    ).toBe(true);
  });

  it("D: an interrupted copy keeps the original and removes partial content", async () => {
    const src = new MemDir();
    const dst = new MemDir();
    src.files.set("v.mp4", data());
    const ctrl = new AbortController();
    dst.ctrl = ctrl;
    dst.abortAfterChunks = 0;
    const err = await moveFile(
      scanned(src, "v.mp4"),
      dst as unknown as FileSystemDirectoryHandle,
      "v.mp4",
      ctrl.signal,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TransferError);
    expect(err.kind).toBe("interrupted");
    expect(src.files.get("v.mp4")!.length).toBe(9 * MB);
    expect(dst.files.size).toBe(0);
    expect(log().some((e) => e.kind === "stopped" && e.path === "v.mp4")).toBe(true);
  });

  it("E: a successful copy is verified before the original is removed", async () => {
    const src = new MemDir();
    const dst = new MemDir();
    const bytes = data();
    src.files.set("ok.pdf", bytes);
    expect(
      await moveFile(scanned(src, "ok.pdf"), dst as unknown as FileSystemDirectoryHandle),
    ).toBe("ok.pdf");
    expect(src.files.has("ok.pdf")).toBe(false);
    expect(Buffer.compare(dst.files.get("ok.pdf")!, bytes)).toBe(0);
  });

  it("F: a mixed batch gives each file its own outcome", async () => {
    const src = new MemDir();
    const good = new MemDir();
    const bad = new MemDir();
    const cut = new MemDir();
    bad.corrupt = true;
    for (const n of ["1", "2", "3", "4"]) src.files.set(n, data());
    const ctrl = new AbortController();
    cut.ctrl = ctrl;
    cut.abortAfterChunks = 0;
    const jobs: [string, MemDir, AbortSignal?][] = [
      ["1", good],
      ["2", bad],
      ["3", cut, ctrl.signal],
      ["4", good],
    ];
    const outcomes: string[] = [];
    for (const [n, dest, sig] of jobs) {
      try {
        await moveFile(scanned(src, n), dest as unknown as FileSystemDirectoryHandle, n, sig);
        outcomes.push("moved");
      } catch (e) {
        outcomes.push((e as TransferError).kind);
      }
    }
    expect(outcomes).toEqual(["moved", "verification", "interrupted", "moved"]);
    expect([...src.files.keys()].sort()).toEqual(["2", "3"]);
    expect([...good.files.keys()].sort()).toEqual(["1", "4"]);
    expect(bad.files.size + cut.files.size).toBe(0);
  });
});

describe("native move and final source guard", () => {
  const data = () => new Uint8Array(5 * MB).map((_, i) => (i * 17) & 255);
  const withMove = (f: ScannedFile, move: () => Promise<void>) => ({
    ...f,
    handle: { ...(f.handle as object), move } as unknown as FileSystemFileHandle,
  });
  const asDir = (d: MemDir) => d as unknown as FileSystemDirectoryHandle;

  it("1: no native move → verified copy", async () => {
    const src = new MemDir();
    const dst = new MemDir();
    src.files.set("a", data());
    expect(await moveFile(scanned(src, "a"), asDir(dst))).toBe("a");
    expect(src.files.has("a")).toBe(false);
    expect(dst.files.get("a")?.length).toBe(5 * MB);
  });

  it("2: native move 'unsupported' (AbortError, NotSupportedError) → verified copy fallback", async () => {
    for (const name of ["AbortError", "NotSupportedError"]) {
      const src = new MemDir();
      const dst = new MemDir();
      src.files.set("a", data());
      await moveFile(
        withMove(scanned(src, "a"), async () => {
          throw new DOMException("no", name);
        }),
        asDir(dst),
      );
      expect(src.files.has("a")).toBe(false);
      expect(dst.files.has("a")).toBe(true);
    }
  });

  it("AbortError caused by the user's own Stop is never treated as 'unsupported'", () => {
    const c = new AbortController();
    c.abort();
    expect(nativeMoveUnsupported(new DOMException("x", "AbortError"), c.signal)).toBe(false);
    expect(nativeMoveUnsupported(new DOMException("x", "AbortError"))).toBe(true);
  });

  it("3: native move permission failure → reported, no copy, original kept", async () => {
    const src = new MemDir();
    const dst = new MemDir();
    src.files.set("a", data());
    const err = await moveFile(
      withMove(scanned(src, "a"), async () => {
        throw new DOMException("denied", "NotAllowedError");
      }),
      asDir(dst),
    ).catch((e) => e);
    expect(err.kind).toBe("failed");
    expect(src.files.has("a")).toBe(true);
    expect(dst.files.size).toBe(0);
  });

  it("4+5: fallback copy that fails verification keeps the original", async () => {
    const src = new MemDir();
    const dst = new MemDir();
    src.files.set("a", data());
    dst.corrupt = true;
    const err = await moveFile(
      withMove(scanned(src, "a"), async () => {
        throw new DOMException("no", "AbortError");
      }),
      asDir(dst),
    ).catch((e) => e);
    expect(err.kind).toBe("verification");
    expect(src.files.get("a")?.length).toBe(5 * MB);
    expect(dst.files.size).toBe(0);
  });

  it("source changed after verification but before deletion → not deleted, copy removed", async () => {
    const src = new MemDir();
    const dst = new MemDir();
    src.files.set("a", data());
    src.beforeLookup = (n) => {
      const d = src.files.get(n)!;
      const c = new Uint8Array(d);
      c[3] = (c[3] ?? 0) ^ 1;
      src.files.set(n, c);
    };
    const err = await moveFile(scanned(src, "a"), asDir(dst)).catch((e) => e);
    expect(err.kind).toBe("conflict");
    expect(src.files.get("a")?.[3]).toBe(data()[3]! ^ 1);
    expect(dst.files.size).toBe(0);
    expect(log().some((e) => e.kind === "failed" && /original kept/.test(e.reason))).toBe(true);
  });

  it("source replaced by a different entry → not deleted", async () => {
    const src = new MemDir();
    const dst = new MemDir();
    src.files.set("a", data());
    const f = scanned(src, "a");
    const orig = src.getFileHandle.bind(src);
    src.getFileHandle = async (n, o) =>
      ({ ...(await orig(n, o)), isSameEntry: async () => false }) as never;
    const err = await moveFile(f, asDir(dst)).catch((e) => e);
    expect(err.kind).toBe("conflict");
    expect(src.files.has("a")).toBe(true);
  });
});
