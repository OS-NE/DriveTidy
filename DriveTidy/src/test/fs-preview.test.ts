import { afterEach, expect, it, vi } from "vitest";
import { thumbnailDataUrl, type ScannedFile } from "@/lib/fs";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("releases the decoded image and URL when creating a thumbnail fails", async () => {
  const close = vi.fn();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn().mockResolvedValue({ width: 6000, height: 4000, close }),
  );
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn().mockReturnValue("blob:test"),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const f = {
    name: "IMG_1.jpg",
    handle: { getFile: async () => new File(["image"], "IMG_1.jpg", { type: "image/jpeg" }) },
  } as unknown as ScannedFile;
  await expect(thumbnailDataUrl(f)).rejects.toThrow("Cannot create image preview");
  expect(close).toHaveBeenCalledOnce();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
});
