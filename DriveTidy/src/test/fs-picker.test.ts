import { afterEach, describe, expect, it, vi } from "vitest";
import { directoryDisplayName, fsEmbedded, isDriveRootDirectory, pickDirectory } from "@/lib/fs";

afterEach(() => vi.unstubAllGlobals());

describe("folder picker context", () => {
  it("blocks embedded access before calling the browser picker", async () => {
    const picker = vi.fn();
    vi.stubGlobal("window", { self: {}, top: {}, showDirectoryPicker: picker });
    expect(fsEmbedded()).toBe(true);
    await expect(pickDirectory()).rejects.toThrow("Open DriveTidy in a new tab");
    expect(picker).not.toHaveBeenCalled();
  });

  it("opens the read-write picker in a standalone tab", async () => {
    const context = {};
    const directory = { name: "Test drive" };
    const picker = vi.fn().mockResolvedValue(directory);
    const confirm = vi.fn();
    vi.stubGlobal("window", { self: context, top: context, showDirectoryPicker: picker, confirm });
    expect(fsEmbedded()).toBe(false);
    await expect(pickDirectory()).resolves.toBe(directory);
    expect(picker).toHaveBeenCalledWith({ mode: "readwrite", id: "drive-tidy" });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("requires confirmation before returning a drive-root handle", async () => {
    const context = {};
    const driveRoot = { name: "" };
    const picker = vi.fn().mockResolvedValue(driveRoot);
    const confirm = vi.fn().mockReturnValue(true);
    vi.stubGlobal("window", { self: context, top: context, showDirectoryPicker: picker, confirm });

    await expect(pickDirectory()).resolves.toBe(driveRoot);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("entire drive"));
    expect(isDriveRootDirectory(driveRoot as FileSystemDirectoryHandle)).toBe(true);
    expect(directoryDisplayName(driveRoot as FileSystemDirectoryHandle)).toBe("Drive root");
  });

  it("cancels a drive-root selection when confirmation is declined", async () => {
    const context = {};
    const driveRoot = { name: "" };
    const picker = vi.fn().mockResolvedValue(driveRoot);
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal("window", { self: context, top: context, showDirectoryPicker: picker, confirm });

    await expect(pickDirectory()).rejects.toMatchObject({ name: "AbortError" });
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
describe("pickDirectory concurrency", () => {
  it("opens only one native picker when clicked twice", async () => {
    let resolve!: (v: unknown) => void;
    const picker = vi.fn(() => new Promise((r) => (resolve = r)));
    const context = {};
    vi.stubGlobal("window", { self: context, top: context, showDirectoryPicker: picker });
    const { pickDirectory } = await import("@/lib/fs");
    const a = pickDirectory();
    const b = pickDirectory();
    resolve({ name: "Test drive" });
    expect(await a).toEqual({ name: "Test drive" });
    expect(await b).toEqual({ name: "Test drive" });
    expect(picker).toHaveBeenCalledTimes(1);
  });

  it("shows only one confirmation when a drive-root picker is clicked twice", async () => {
    let resolve!: (v: unknown) => void;
    const picker = vi.fn(() => new Promise((r) => (resolve = r)));
    const confirm = vi.fn().mockReturnValue(true);
    const context = {};
    vi.stubGlobal("window", { self: context, top: context, showDirectoryPicker: picker, confirm });
    const { pickDirectory } = await import("@/lib/fs");

    const a = pickDirectory();
    const b = pickDirectory();
    resolve({ name: "" });

    expect(await a).toEqual({ name: "" });
    expect(await b).toEqual({ name: "" });
    expect(picker).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
