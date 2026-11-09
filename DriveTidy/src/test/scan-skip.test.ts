import { describe, it, expect } from "vitest";
import { scanDirectory } from "@/lib/fs";

function file(name: string) {
  let opened = false;
  return {
    kind: "file" as const,
    name,
    get opened() { return opened; },
    getFile: async () => { opened = true; return new File(["x"], name); },
  };
}
function dir(name: string, children: unknown[]) {
  return { kind: "directory" as const, name, values: async function* () { yield* children; } };
}

describe("scanDirectory skips risky files", () => {
  it("never opens scripts, programs or markup files and keeps normal files", async () => {
    const risky = ["tool.py", "a.js", "setup.exe", "run.bat", "m.xlsm", "x.pyc", "data.xml"].map(file);
    const safe = [file("photo.jpg"), file("notes.pdf")];
    const hidden = file("secret.jpg");
    const root = dir("", [...risky, ...safe, dir("AppData", [hidden]), dir(".cache", [hidden])]);
    const out = await scanDirectory(root as unknown as FileSystemDirectoryHandle, () => {});
    expect(out.map((f) => f.name).sort()).toEqual(["notes.pdf", "photo.jpg"]);
    expect(risky.some((f) => f.opened)).toBe(false);
    expect(hidden.opened).toBe(false);
  });
});
