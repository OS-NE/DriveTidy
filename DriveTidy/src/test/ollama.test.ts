import { afterEach, describe, expect, it, vi } from "vitest";
import { checkOllama, nameWithOllama } from "@/lib/ollama";

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(await checkOllama()).toMatchObject({
      state: "missing",
      message: expect.stringContaining("ollama pull llama3.2-vision"),
    });
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
