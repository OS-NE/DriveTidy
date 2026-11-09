import { afterEach, describe, expect, it, vi } from "vitest";
import { fsEmbedded, pickDirectory } from "@/lib/fs";

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
    vi.stubGlobal("window", { self: context, top: context, showDirectoryPicker: picker });
    expect(fsEmbedded()).toBe(false);
    await expect(pickDirectory()).resolves.toBe(directory);
    expect(picker).toHaveBeenCalledWith({ mode: "readwrite", id: "drive-tidy" });
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
    resolve("handle");
    expect(await a).toBe("handle");
    expect(await b).toBe("handle");
    expect(picker).toHaveBeenCalledTimes(1);
  });
});
