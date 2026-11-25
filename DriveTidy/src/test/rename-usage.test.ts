import { describe, expect, it } from "vitest";
import { addNamingUsage, normalizeNamingUsage, type BatchUsage } from "@/lib/rename-usage";
const batch: BatchUsage = {
  provider: "ollama",
  estimatedRequests: 200,
  actualRequests: 0,
  successfulRequests: 0,
  reportedRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};
describe("Batch usage accounting", () => {
  it("compares estimated requests with actual requests and sums reported tokens", () => {
    const first = addNamingUsage(batch, true, {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    const result = addNamingUsage(first, true, {
      inputTokens: 200,
      outputTokens: 30,
      totalTokens: 230,
    });
    expect(result).toEqual({
      ...batch,
      actualRequests: 2,
      successfulRequests: 2,
      reportedRequests: 2,
      inputTokens: 300,
      outputTokens: 50,
      totalTokens: 350,
    });
  });
  it("counts failed requests without inventing unreported tokens", () => {
    const result = addNamingUsage(batch, false);
    expect(result.actualRequests).toBe(1);
    expect(result.successfulRequests).toBe(0);
    expect(result.reportedRequests).toBe(0);
    expect(normalizeNamingUsage(undefined)).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
  });
  it("preserves reported zero tokens while rejecting invalid values", () => {
    expect(normalizeNamingUsage({ inputTokens: 0, outputTokens: -1, totalTokens: NaN })).toEqual({
      inputTokens: 0,
      outputTokens: null,
      totalTokens: null,
    });
  });
});
