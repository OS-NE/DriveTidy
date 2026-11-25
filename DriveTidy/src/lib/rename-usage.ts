import type { ToolProvider } from "./ai-provider";

export type NamingUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};
export type BatchUsage = {
  provider: ToolProvider;
  estimatedRequests: number;
  actualRequests: number;
  successfulRequests: number;
  reportedRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export function normalizeNamingUsage(
  usage:
    | {
        inputTokens?: number | undefined;
        outputTokens?: number | undefined;
        totalTokens?: number | undefined;
      }
    | undefined,
): NamingUsage {
  const token = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  return {
    inputTokens: token(usage?.inputTokens),
    outputTokens: token(usage?.outputTokens),
    totalTokens: token(usage?.totalTokens),
  };
}

export function addNamingUsage(
  batch: BatchUsage,
  success: boolean,
  usage?: NamingUsage,
): BatchUsage {
  return {
    ...batch,
    actualRequests: batch.actualRequests + 1,
    successfulRequests: batch.successfulRequests + Number(success),
    reportedRequests: batch.reportedRequests + Number(usage?.totalTokens != null),
    inputTokens: batch.inputTokens + (usage?.inputTokens ?? 0),
    outputTokens: batch.outputTokens + (usage?.outputTokens ?? 0),
    totalTokens: batch.totalTokens + (usage?.totalTokens ?? 0),
  };
}
