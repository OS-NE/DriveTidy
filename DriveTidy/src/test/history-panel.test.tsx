import "fake-indexeddb/auto";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryPanel } from "@/components/tidy/HistoryPanel";
import { openJournal } from "@/lib/journal";
import type { BatchRecord, Journal, OpRecord } from "@/lib/journal";
import { FakeDir, asRoot, enc, op } from "./fake-fs";

vi.mock("@/lib/journal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/journal")>()),
  openJournal: vi.fn(),
}));

const batch = (patch: Partial<BatchRecord> = {}): BatchRecord => ({
  id: "batch1",
  kind: "restructure",
  rootId: "root1",
  title: "Tidy photos",
  createdAt: Date.UTC(2026, 10, 20),
  updatedAt: Date.UTC(2026, 10, 20),
  status: "interrupted",
  visibility: "active",
  irreversible: false,
  durability: "strict",
  counts: {},
  schema: 1,
  ...patch,
});

/** A journal held in memory, with the few methods the History panel calls. */
function fakeJournal(initial: BatchRecord, ops: OpRecord[], root: FileSystemDirectoryHandle) {
  let current = initial;
  return {
    listBatches: vi.fn(async () => [current]),
    opsFor: vi.fn(async () => ops),
    getRoot: vi.fn(async () => ({ id: current.rootId, name: "root", firstSeen: 0, handle: root })),
    putBatch: vi.fn(async (next: BatchRecord) => {
      current = next;
    }),
    putOp: vi.fn(async () => undefined),
    setVisibility: vi.fn(async () => undefined),
    deleteRecord: vi.fn(async () => undefined),
    close: vi.fn(),
  };
}

/**
 * A drive where one move is proven complete (same file, original gone), one file is missing
 * everywhere, and one destination matches but its identity was never stored.
 */
function scenario() {
  const root = new FakeDir("root");
  const target = root.mkdir("new");
  const a = enc("alpha");
  const c = enc("charlie");
  const movedA = target.put("a.txt", a);
  target.put("c.txt", c);
  const ops = [
    op(a, {
      id: "a",
      fromDir: "old",
      fromName: "a.txt",
      batchId: "batch1",
      finalHandle: movedA as unknown as FileSystemFileHandle,
    }),
    op(enc("bravo"), { id: "b", fromDir: "old", fromName: "b.txt", batchId: "batch1" }),
    op(c, { id: "c", fromDir: "old", fromName: "c.txt", finalName: "c.txt", batchId: "batch1" }),
  ];
  return { root, target, ops };
}

function mount(ops: OpRecord[], root: FakeDir) {
  const journal = fakeJournal(batch(), ops, asRoot(root));
  vi.mocked(openJournal).mockResolvedValue(journal as unknown as Journal);
  render(<HistoryPanel />);
  return journal;
}

const reviewButton = () => screen.findByRole("button", { name: "Review recovery" });

async function inspect() {
  fireEvent.click(await reviewButton());
  return screen.findByLabelText("Inspection summary");
}

const rowOrder = () =>
  screen
    .getAllByRole("listitem")
    .map((item) => /old\/([abc])\.txt/.exec(item.textContent ?? "")?.[1]);

describe("History panel recovery review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("summarises the inspection and lists entries that need attention first", async () => {
    const { root, ops } = scenario();
    mount(ops, root);

    const summary = await inspect();
    expect(within(summary).getByText("1 verified complete")).toBeTruthy();
    expect(within(summary).getByText("1 needs a decision")).toBeTruthy();
    expect(within(summary).getByText("1 needs review")).toBeTruthy();
    expect(within(summary).getByText(/Finalizing stays unavailable/)).toBeTruthy();

    // needs review (b), then needs a decision (c), then verified complete (a)
    expect(rowOrder()).toEqual(["b", "c", "a"]);
    expect(screen.queryByRole("button", { name: /Finalize verified batch/ })).toBeNull();
  });

  it("is read-only: inspecting never writes to the journal or the drive", async () => {
    const { root, target, ops } = scenario();
    const journal = mount(ops, root);
    await inspect();

    expect(journal.putBatch).not.toHaveBeenCalled();
    expect(journal.putOp).not.toHaveBeenCalled();
    expect([...target.files.keys()].sort()).toEqual(["a.txt", "c.txt"]);
  });

  it("filters the file list by outcome group and back to all", async () => {
    const { root, ops } = scenario();
    mount(ops, root);
    await inspect();

    fireEvent.click(screen.getByRole("button", { name: /needs review \(1\)/ }));
    expect(rowOrder()).toEqual(["b"]);

    fireEvent.click(screen.getByRole("button", { name: /^All \(3\)/ }));
    expect(rowOrder()).toEqual(["b", "c", "a"]);
  });

  it("exports the rows on screen as CSV, in the same order", async () => {
    const { root, ops } = scenario();
    mount(ops, root);
    await inspect();

    const createObjectURL = vi.fn(() => "blob:review");
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    fireEvent.click(screen.getByRole("button", { name: /Export 3 rows/ }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(text).toContain("Group,Result,Original location");
    expect(text.indexOf("old/b.txt")).toBeLessThan(text.indexOf("old/c.txt"));
    expect(text.indexOf("old/c.txt")).toBeLessThan(text.indexOf("old/a.txt"));
  });

  it("offers to finalize only when every entry is verified, and then only changes the record", async () => {
    const root = new FakeDir("root");
    const target = root.mkdir("new");
    const bytes = [enc("one"), enc("two")];
    const ops = bytes.map((data, index) => {
      const name = `f${index}.txt`;
      const moved = target.put(name, data);
      return op(data, {
        id: name,
        fromDir: "old",
        fromName: name,
        finalName: name,
        batchId: "batch1",
        finalHandle: moved as unknown as FileSystemFileHandle,
      });
    });
    const journal = mount(ops, root);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await inspect();
    const finalize = await screen.findByRole("button", { name: /Finalize verified batch/ });
    fireEvent.click(finalize);

    await waitFor(() => expect(journal.putBatch).toHaveBeenCalledTimes(1));
    expect(journal.putBatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: "batch1", status: "completed" }),
    );
    expect(journal.putOp).not.toHaveBeenCalled();
    expect([...target.files.keys()].sort()).toEqual(["f0.txt", "f1.txt"]);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Review recovery" })).toBeNull(),
    );
  });

  it("does not finalize when the user declines the confirmation", async () => {
    const root = new FakeDir("root");
    const target = root.mkdir("new");
    const data = enc("one");
    const moved = target.put("f.txt", data);
    const journal = mount(
      [
        op(data, {
          id: "f",
          fromDir: "old",
          fromName: "f.txt",
          finalName: "f.txt",
          batchId: "batch1",
          finalHandle: moved as unknown as FileSystemFileHandle,
        }),
      ],
      root,
    );
    vi.spyOn(window, "confirm").mockReturnValue(false);

    await inspect();
    fireEvent.click(await screen.findByRole("button", { name: /Finalize verified batch/ }));
    expect(journal.putBatch).not.toHaveBeenCalled();
  });
});
