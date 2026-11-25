import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkOllama,
  getOllamaConfig,
  nameWithOllama,
  saveOllamaConfig,
  suggestFoldersWithOllama,
} from "@/lib/ollama";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});
const input = {
  dataUrl: "data:image/jpeg;base64,AA==",
  originalName: "IMG_1.jpg",
  kind: "image" as const,
};

describe("Local Ollama provider", () => {
  it("reports a missing model with the pull command", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ models: [{ name: "llava:latest" }] }))),
    );
    const status = await checkOllama();
    expect(status).toMatchObject({ state: "missing" });
    expect(status.message).toContain("ollama pull llama3.2");
    expect(status.message).toContain("ollama pull llama3.2-vision");
  });
  it("uses the text model for folder suggestions and the vision model for renaming", async () => {
    saveOllamaConfig({ url: "http://localhost:11434", model: "mistral", visionModel: "llava" });
    expect(getOllamaConfig()).toMatchObject({ model: "mistral", visionModel: "llava" });
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            message: { content: '{"name":"red-car","description":"car","confidence":0.9}' },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    await nameWithOllama(input);
    let body = JSON.parse(
      (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.model).toBe("llava");
    await suggestFoldersWithOllama([
      {
        name: "a.jpg",
        extension: "jpg",
        category: "Images",
        currentFolder: "root",
        modified: "2024",
        size: 1,
      },
    ]).catch(() => undefined);
    body = JSON.parse((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe("mistral");
  });
  it("keeps a single saved model working for both roles (backward compatible)", () => {
    localStorage.setItem(
      "drivetidy.ollama",
      JSON.stringify({ url: "http://x", model: "qwen2.5vl" }),
    );
    expect(getOllamaConfig()).toMatchObject({ model: "qwen2.5vl", visionModel: "qwen2.5vl" });
  });
  it("names a file locally and sends only base64 image data", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            message: { content: '{"name":"red-car","description":"car","confidence":0.9}' },
            prompt_eval_count: 10,
            eval_count: 5,
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await nameWithOllama(input)).toMatchObject({
      ok: true,
      name: "red-car",
      usage: { totalTokens: 15 },
    });
    const body = JSON.parse(
      (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.messages[1].images).toEqual(["AA=="]);
  });
  it("stops the batch when Ollama is not running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fail");
      }),
    );
    expect(await nameWithOllama(input)).toMatchObject({ ok: false, stopBatch: true });
  });
});
