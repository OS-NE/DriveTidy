import { describe, it, expect } from "vitest";
import { shouldAutoRename, categoryOf, isPoorlyNamed, uniqueName, targetFolder, nextRenameBatch, groupFolderPlan, estimateRenameRequests } from "@/lib/organize";

describe("organize rules", () => {
  it("estimates one request per remaining file, bounded to 200 for the next batch", () => {
    expect(estimateRenameRequests(350)).toEqual({ batch: 200, remaining: 350 });
    expect(estimateRenameRequests(150)).toEqual({ batch: 150, remaining: 150 });
    expect(estimateRenameRequests(0)).toEqual({ batch: 0, remaining: 0 });
  });
  it("bounds the next batch to a user-chosen batch size", () => {
    expect(estimateRenameRequests(350, 10)).toEqual({ batch: 10, remaining: 350 });
    expect(estimateRenameRequests(350, 50)).toEqual({ batch: 50, remaining: 350 });
    expect(estimateRenameRequests(15, 100)).toEqual({ batch: 15, remaining: 15 });
    const files = Array.from({ length: 75 }, (_, i) => ({ id: String(i) }));
    expect(nextRenameBatch(files, new Set(), 20)).toHaveLength(20);
    expect(nextRenameBatch(files, new Set(), 200)).toHaveLength(75);
  });
  it("groups a drive-sized folder without losing or reordering files", () => {
    const plan = Array.from({ length: 50000 }, (_, f) => ({ f, folder: "Images" }));
    const groups = groupFolderPlan(plan);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.[1]).toHaveLength(50000);
    expect(groups[0]?.[1][49999]).toBe(49999);
  });
  it("auto-renames only at high confidence (>= 0.8), otherwise queues for review", () => {
    expect(shouldAutoRename(0.8)).toBe(true);
    expect(shouldAutoRename(0.79)).toBe(false);
  });
  it("categorizes by extension", () => {
    expect(categoryOf("a.JPG")).toBe("Images");
    expect(categoryOf("clip.mp4")).toBe("Videos");
    expect(categoryOf("benchy.gcode")).toBe("3D Print");
    expect(categoryOf("part.stl")).toBe("3D Print");
    expect(categoryOf("model.3mf")).toBe("3D Print");
    expect(categoryOf("weird.xyz")).toBe("Other");
  });
  it("detects camera-default names", () => {
    expect(isPoorlyNamed("IMG_2034.jpg")).toBe(true);
    expect(isPoorlyNamed("beach-sunset-goa.jpg")).toBe(false);
  });
  it("avoids name collisions", () => {
    expect(uniqueName("a.jpg", new Set(["a.jpg", "a-2.jpg"]))).toBe("a-3.jpg");
  });
  it("builds date folders", () => {
    expect(targetFolder({ path: "x.jpg", name: "x.jpg", lastModified: new Date(2024, 2, 5).getTime() }, "category-date")).toBe("Images/2024/2024-03");
  });
  it("serves rename batches beyond the first run, skipping processed files", () => {
    const all = Array.from({ length: 350 }, (_, i) => ({ id: String(i), name: `f${i}.jpg` }));
    const first = nextRenameBatch(all, new Set(), 200);
    expect(first.length).toBe(200);
    const second = nextRenameBatch(all, new Set(first.map((f) => f.id)), 200);
    expect(second.length).toBe(150);
    expect(second[0]?.id).toBe("200");
    expect(nextRenameBatch(all, new Set(all.map((f) => f.id)), 200)).toHaveLength(0);
  });
});
