import { describe, it, expect } from "vitest";
import { isUnsafeFile, isIgnoredFolder } from "@/lib/organize";

describe("scan safety", () => {
  it("skips executables and scripts", () => {
    for (const n of [
      "a.js",
      "tool.py",
      "x.pyc",
      "macro.xlsm",
      "setup.EXE",
      "run.bat",
      "x.ps1",
      "y.cmd",
    ])
      expect(isUnsafeFile(n)).toBe(true);
    expect(isUnsafeFile("photo.jpg")).toBe(false);
  });
  it("skips markup and config files like .xml", () => {
    for (const n of [
      "data.xml",
      "style.xsl",
      "site.dtd",
      "feed.rss",
      "page.xhtml",
      "app.config",
      "settings.ini",
      "values.yaml",
      "Makefile.toml",
      ".env",
      "list.properties",
    ])
      expect(isUnsafeFile(n)).toBe(true);
    expect(isUnsafeFile("report.pdf")).toBe(false);
  });
  it("ignores AppData, .cache and hidden folders", () => {
    for (const n of ["AppData", ".cache", ".hidden", "$RECYCLE.BIN", "System Volume Information"])
      expect(isIgnoredFolder(n)).toBe(true);
    expect(isIgnoredFolder("Photos")).toBe(false);
  });
});
