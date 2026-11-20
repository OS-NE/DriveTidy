import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CrossDriveCompare } from "@/components/tidy/CrossDriveCompare";
import type { DuplicateGroup, ScannedFile } from "@/lib/fs";

const fsMocks = vi.hoisted(() => ({
  directoryDisplayName: vi.fn((handle: FileSystemDirectoryHandle) => handle.name || "Drive root"),
  pickDirectory: vi.fn(),
  scanDirectory: vi.fn(),
  findDuplicates: vi.fn(),
}));

vi.mock("@/lib/fs", () => fsMocks);

function directory(name: string): FileSystemDirectoryHandle {
  const handle = {
    name,
    kind: "directory",
    isSameEntry: async (other: FileSystemHandle) => other === handle,
  };
  return handle as unknown as FileSystemDirectoryHandle;
}

function file(root: FileSystemDirectoryHandle, name: string, size = 8): ScannedFile {
  return {
    id: name,
    name,
    path: name,
    size,
    lastModified: 1,
    type: "text/plain",
    handle: { name } as unknown as FileSystemFileHandle,
    parent: root,
  };
}

describe("cross-drive duplicate comparison", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scans another location and reports verified matches across the roots", async () => {
    const primaryRoot = directory("Primary");
    const secondaryRoot = directory("Secondary");
    const primary = file(primaryRoot, "original.txt");
    const secondary = file(secondaryRoot, "renamed-copy.txt");
    fsMocks.pickDirectory.mockResolvedValue(secondaryRoot);
    fsMocks.scanDirectory.mockResolvedValue([secondary]);
    fsMocks.findDuplicates.mockImplementation(async (allFiles: ScannedFile[]) => {
      expect(allFiles.map((item) => item.path)).toEqual([
        "Primary/original.txt",
        "Secondary/renamed-copy.txt",
      ]);
      return [{ files: allFiles, status: "verified" } satisfies DuplicateGroup];
    });

    render(<CrossDriveCompare root={primaryRoot} files={[primary]} />);
    fireEvent.click(screen.getByRole("button", { name: /Add drive or folder/i }));
    await screen.findByText("Secondary · 1 files");
    fireEvent.click(screen.getByRole("button", { name: "Compare 2 files" }));

    expect(await screen.findByText(/Verified identical contents/)).toBeInTheDocument();
    expect(fsMocks.pickDirectory).toHaveBeenCalledWith("read");
    expect(fsMocks.scanDirectory).toHaveBeenCalledWith(
      secondaryRoot,
      expect.any(Function),
      undefined,
      expect.any(AbortSignal),
    );
  });

  it("removes a selected location and compares only the remaining files", async () => {
    const primaryRoot = directory("Primary");
    const secondaryRoot = directory("Secondary");
    fsMocks.pickDirectory.mockResolvedValue(secondaryRoot);
    fsMocks.scanDirectory.mockResolvedValue([file(secondaryRoot, "other.txt")]);
    fsMocks.findDuplicates.mockResolvedValue([]);

    render(<CrossDriveCompare root={primaryRoot} files={[file(primaryRoot, "one.txt")]} />);
    fireEvent.click(screen.getByRole("button", { name: /Add drive or folder/i }));
    await screen.findByText("Secondary · 1 files");
    fireEvent.click(screen.getByRole("button", { name: "Remove Secondary from comparison" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare 1 files" }));

    await waitFor(() => expect(fsMocks.findDuplicates).toHaveBeenCalledTimes(1));
    expect(fsMocks.findDuplicates.mock.calls[0]?.[0]).toHaveLength(1);
  });

  it("does not scan or add a location when the folder picker is cancelled", async () => {
    fsMocks.pickDirectory.mockRejectedValue(new DOMException("cancelled", "AbortError"));

    const primaryRoot = directory("Primary");
    render(<CrossDriveCompare root={primaryRoot} files={[file(primaryRoot, "one.txt")]} />);
    fireEvent.click(screen.getByRole("button", { name: /Add drive or folder/i }));

    await waitFor(() => expect(fsMocks.pickDirectory).toHaveBeenCalledWith("read"));
    expect(fsMocks.scanDirectory).not.toHaveBeenCalled();
    expect(screen.queryByText(/files from/)).not.toBeInTheDocument();
  });

  it("disambiguates selected roots that have the same display name", async () => {
    const primaryRoot = directory("");
    const secondaryRoot = directory("");
    fsMocks.pickDirectory.mockResolvedValue(secondaryRoot);
    fsMocks.scanDirectory.mockResolvedValue([file(secondaryRoot, "copy.txt")]);
    fsMocks.findDuplicates.mockImplementation(async (allFiles: ScannedFile[]) => {
      expect(allFiles.map((item) => item.path)).toEqual([
        "Drive root/original.txt",
        "Drive root (2)/copy.txt",
      ]);
      return [];
    });

    render(<CrossDriveCompare root={primaryRoot} files={[file(primaryRoot, "original.txt")]} />);
    fireEvent.click(screen.getByRole("button", { name: /Add drive or folder/i }));
    await screen.findByText("Drive root (2) · 1 files");
    fireEvent.click(screen.getByRole("button", { name: "Compare 2 files" }));
    await waitFor(() => expect(fsMocks.findDuplicates).toHaveBeenCalledTimes(1));
  });
});
