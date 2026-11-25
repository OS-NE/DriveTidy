import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { RefreshCw, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { TOOL_PROVIDERS, type ProviderStatus } from "@/lib/ai-provider";
import { checkOllama } from "@/lib/ollama";
import { OllamaSetup } from "./OllamaSetup";

type ProviderChecks = {
  statuses: Partial<Record<string, ProviderStatus>>;
  checking: Partial<Record<string, boolean>>;
  checkedAt: Partial<Record<string, string>>;
  verifyProvider: () => Promise<void>;
  updateStatus: (status: ProviderStatus) => void;
};
const ProviderContext = createContext<ProviderChecks | null>(null);

export function ProviderSettingsProvider({ children }: { children: ReactNode }) {
  const [statuses, setStatuses] = useState<ProviderChecks["statuses"]>({});
  const [checking, setChecking] = useState<ProviderChecks["checking"]>({});
  const [checkedAt, setCheckedAt] = useState<ProviderChecks["checkedAt"]>({});
  const requests = useRef(0);
  const active = useRef(false);
  const check = useCallback(async (verify: boolean) => {
    if (active.current) return;
    active.current = true;
    const request = ++requests.current;
    setChecking((values) => ({ ...values, ollama: true }));
    try {
      const status = await checkOllama();
      if (requests.current === request) setStatuses((values) => ({ ...values, ollama: status }));
    } catch {
      if (requests.current === request)
        setStatuses((values) => ({
          ...values,
          ollama: { state: "error", message: "Could not check local AI" },
        }));
    } finally {
      if (requests.current === request) {
        if (verify)
          setCheckedAt((values) => ({ ...values, ollama: new Date().toLocaleTimeString() }));
        setChecking((values) => ({ ...values, ollama: false }));
      }
      active.current = false;
    }
  }, []);
  useEffect(() => {
    void check(false);
  }, [check]);
  const verifyProvider = useCallback(() => check(true), [check]);
  const updateStatus = useCallback((status: ProviderStatus) => {
    setStatuses((values) => ({ ...values, ollama: status }));
  }, []);
  return (
    <ProviderContext.Provider
      value={{ statuses, checking, checkedAt, verifyProvider, updateStatus }}
    >
      {children}
    </ProviderContext.Provider>
  );
}

export function useProviderSettings() {
  const context = useContext(ProviderContext);
  if (!context) throw new Error("Provider settings must be inside the tool.");
  return context;
}

export function ProviderSettings() {
  const { statuses, checking, checkedAt, verifyProvider } = useProviderSettings();
  const status = statuses["ollama"];
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Settings className="h-4 w-4" />
          Settings
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>Local AI settings</DialogTitle>
        </DialogHeader>
        <div
          role="group"
          aria-label={TOOL_PROVIDERS.ollama.label}
          className="flex flex-wrap items-center justify-between gap-3 py-5"
        >
          <div className="min-w-0 space-y-2">
            <h2 className="text-sm font-semibold">{TOOL_PROVIDERS.ollama.label}</h2>
            <Badge
              role="status"
              variant={
                status?.state === "ready"
                  ? "default"
                  : status && ["missing", "invalid", "denied"].includes(status.state)
                    ? "destructive"
                    : "secondary"
              }
              className="max-w-full whitespace-normal"
            >
              {checking["ollama"] ? "Checking local AI…" : (status?.message ?? "Checking…")}
            </Badge>
            {checkedAt["ollama"] && (
              <p className="text-xs text-muted-foreground">Last checked {checkedAt["ollama"]}</p>
            )}
            <OllamaSetup onSaved={() => void verifyProvider()} />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void verifyProvider()}
            disabled={checking["ollama"]}
            aria-label={`Test connection for ${TOOL_PROVIDERS.ollama.label}`}
          >
            <RefreshCw
              className={`h-4 w-4 ${checking["ollama"] ? "animate-spin motion-reduce:animate-none" : ""}`}
            />
            Test connection
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          DriveTidy only uses AI running on your own PC. Photos never leave your computer and
          renaming is always free.
        </p>
      </DialogContent>
    </Dialog>
  );
}
