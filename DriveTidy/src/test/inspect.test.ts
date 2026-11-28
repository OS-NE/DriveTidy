import { describe, expect, it } from "vitest";
import { arrangeOps, createInspector, outcomeTone, reviewCsv, summarize } from "@/lib/inspect";
import { FakeDir, FakeFile, asRoot, enc, op } from "./fake-fs";

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

describe("arranging operations for review", () => {
  const row = (outcome: Parameters<typeof outcomeTone>[0]) =>
    ({
      observation: { access: "ok", source: "absent", dest: "match" },
      result: { outcome },
    }) as never;
  const ops = ["a", "b", "c", "d"].map((id, seq) => op(enc(id), { id, seq }));

  it("puts entries needing attention first, keeping journal order within a group", () => {
    const rows = {
      a: row("completed"),
      b: row("needs-review"),
      c: row("probable-completion"),
      d: row("conflict"),
    };
    expect(arrangeOps(ops, rows).map((o) => o.id)).toEqual(["b", "d", "c", "a"]);
  });

  it("filters by tone and keeps uninspected entries last", () => {
    const rows = { a: row("completed"), b: row("needs-review") };
    expect(arrangeOps(ops, rows, "bad").map((o) => o.id)).toEqual(["b"]);
    expect(arrangeOps(ops, rows).map((o) => o.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("leaves the journal order alone before anything is inspected", () => {
    expect(arrangeOps(ops, {}).map((o) => o.id)).toEqual(["a", "b", "c", "d"]);
    expect(arrangeOps(ops, {}, "bad")).toEqual([]);
  });
});

describe("review CSV export", () => {
  const rows = {
    a: {
      observation: { access: "ok", source: "absent", dest: "match", destSame: true },
      result: { outcome: "completed", label: "Moved", actions: [] },
    },
    b: {
      observation: { access: "ok", source: "match", dest: "absent" },
      result: { outcome: "needs-review", label: "File missing", actions: ["Re-plan", "Resume"] },
    },
  } as never;

  it("writes a header and one escaped row per operation", () => {
    const ops = [
      op(enc("a"), { id: "a", fromName: 'say "hi", ok.txt' }),
      op(enc("b"), { id: "b" }),
    ];
    const lines = reviewCsv(ops, rows).replace("\uFEFF", "").split("\r\n");
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe(
      "Group,Result,Original location,Destination,Journal step,Original,Destination status,Suggested next step",
    );
    expect(lines[1]).toBe(
      'verified complete,Moved,"old/sub/say ""hi"", ok.txt",new/a.txt,native-moved,not found,matches,',
    );
    expect(lines[2]).toBe(
      "needs review,File missing,old/sub/a.txt,new/a.txt,native-moved,matches,not found,Re-plan · Resume",
    );
  });

  it("neutralises spreadsheet formulas coming from file names", () => {
    const csv = reviewCsv([op(enc("a"), { id: "a", fromDir: "=cmd", fromName: "a.txt" })], rows);
    expect(csv.includes("'=cmd/a.txt")).toBe(true);
    const lonely = reviewCsv([op(enc("a"), { id: "a", toPath: "@x", finalName: "=1" })], rows);
    expect(lonely.includes("'@x/=1")).toBe(true);
  });

  it("marks operations that were not inspected", () => {
    const csv = reviewCsv([op(enc("z"), { id: "z" })], {});
    expect(csv.split("\r\n")[1]!.startsWith("not inspected,")).toBe(true);
  });
});
