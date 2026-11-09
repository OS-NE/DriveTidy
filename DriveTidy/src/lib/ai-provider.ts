// DriveTidy uses only local AI (Ollama) running on the user's own PC.
// There is no cloud AI provider and no API keys anywhere in the app.
export type ProviderStatus = { state: "configured" | "ready" | "missing" | "invalid" | "denied" | "error"; message: string };

export const TOOL_PROVIDERS = {
  ollama: { label: "Local AI · Ollama (free)" },
} as const;
export type ToolProvider = keyof typeof TOOL_PROVIDERS;
