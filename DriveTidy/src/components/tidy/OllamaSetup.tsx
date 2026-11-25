import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getOllamaConfig, saveOllamaConfig, OLLAMA_DEFAULTS } from "@/lib/ollama";

export function OllamaSetup({ onSaved }: { onSaved: () => void }) {
  const [url, setUrl] = useState(OLLAMA_DEFAULTS.url);
  const [model, setModel] = useState(OLLAMA_DEFAULTS.model);
  const [visionModel, setVisionModel] = useState(OLLAMA_DEFAULTS.visionModel);
  useEffect(() => {
    const c = getOllamaConfig();
    setUrl(c.url);
    setModel(c.model);
    setVisionModel(c.visionModel);
  }, []);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer text-foreground">Set up free local AI</summary>
      <ol className="mt-2 list-decimal space-y-1 pl-4">
        <li>Install Ollama from ollama.com.</li>
        <li>
          Run <code className="font-mono">ollama pull {model}</code> and{" "}
          <code className="font-mono">ollama pull {visionModel}</code>
        </li>
        <li>
          Allow this app to talk to it: set the environment variable{" "}
          <code className="font-mono break-all">OLLAMA_ORIGINS={origin || "*"}</code>, then restart
          Ollama.
        </li>
        <li>If your browser asks to allow access to devices on your local network, click Allow.</li>
      </ol>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span>Ollama address</span>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="space-y-1">
          <span>Text model (folder suggestions)</span>
          <Input value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <label className="space-y-1">
          <span>Vision model (photo &amp; video renaming)</span>
          <Input value={visionModel} onChange={(e) => setVisionModel(e.target.value)} />
        </label>
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="mt-2"
        onClick={() => {
          saveOllamaConfig({
            url: url.trim() || OLLAMA_DEFAULTS.url,
            model: model.trim() || OLLAMA_DEFAULTS.model,
            visionModel: visionModel.trim() || OLLAMA_DEFAULTS.visionModel,
          });
          onSaved();
        }}
      >
        Save &amp; test
      </Button>
    </details>
  );
}
