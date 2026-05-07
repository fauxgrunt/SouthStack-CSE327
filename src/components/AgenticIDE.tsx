import React, { useCallback, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { Camera, Copy, Loader2, Play, Power, Trash2 } from "lucide-react";
import { useAgenticLoop } from "../hooks/useAgenticLoop";
import { useVoiceInput } from "../hooks/useVoiceInput";

type ActiveTab = "preview" | "code";

export const AgenticIDE: React.FC = () => {
  const {
    state,
    initializeEngine,
    executeAgenticLoop,
    resetGeneratedCanvas,
    isReady,
    history,
    clearHistory,
  } = useAgenticLoop();

  const [activeTab, setActiveTab] = useState<ActiveTab>("preview");
  const [prompt, setPrompt] = useState("");
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(
    null,
  );
  const [screenshotName, setScreenshotName] = useState<string | null>(null);
  const [refinement, setRefinement] = useState("");
  const [copied, setCopied] = useState(false);
  const [selectedLogIndex, setSelectedLogIndex] = useState<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const appendTranscript = useCallback((transcript: string) => {
    setPrompt((prev) => (prev.trim() ? `${prev} ${transcript}` : transcript));
  }, []);

  const voice = useVoiceInput(appendTranscript);

  const generatedCode = state.generatedCode ?? "";
  const previewUrl = state.previewUrl;
  const busy = state.isLoading || state.isGenerating;
  const latestLog = state.logs[state.logs.length - 1];
  const visibleLogs = useMemo(() => state.logs.slice(-8), [state.logs]);
  const selectedLog =
    selectedLogIndex !== null ? (visibleLogs[selectedLogIndex] ?? null) : null;

  const canGenerate = useMemo(
    () => Boolean(prompt.trim()) && !busy && isReady,
    [busy, prompt, isReady],
  );

  const readFileAsDataUrl = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
          return;
        }
        reject(new Error("Failed to read screenshot."));
      };
      reader.onerror = () => reject(new Error("Failed to read screenshot."));
      reader.readAsDataURL(file);
    });
  }, []);

  const handleScreenshotChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      const dataUrl = await readFileAsDataUrl(file);
      setScreenshotDataUrl(dataUrl);
      setScreenshotName(file.name);
    },
    [readFileAsDataUrl],
  );

  const handleGenerate = useCallback(async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      console.warn("No prompt provided");
      return;
    }

    voice.stopListening();

    try {
      console.log("Starting generation with prompt:", trimmedPrompt);
      const result = await executeAgenticLoop({
        prompt: refinement.trim() || trimmedPrompt,
        screenshot: screenshotDataUrl ?? undefined,
        previousCode: generatedCode || undefined,
      });

      console.log("Generation complete:", result);
      setActiveTab("preview");
      setRefinement("");
      setPrompt("");
      setScreenshotDataUrl(null);
      setScreenshotName(null);
    } catch (error) {
      console.error("Generation error:", error);
    }
  }, [
    executeAgenticLoop,
    generatedCode,
    prompt,
    refinement,
    screenshotDataUrl,
    voice,
  ]);

  const handleCopy = useCallback(async () => {
    if (!generatedCode) {
      return;
    }

    await navigator.clipboard.writeText(generatedCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [generatedCode]);

  const renderProgressLogs = (compact = false) => (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      <div className="flex items-center justify-between gap-3">
        <div
          className={
            compact
              ? "text-[10px] uppercase tracking-[0.25em] text-slate-500"
              : "font-semibold text-white"
          }
        >
          Progress log
        </div>
        {selectedLog ? (
          <button
            type="button"
            onClick={() => setSelectedLogIndex(null)}
            className="text-[10px] text-cyan-300 hover:text-cyan-200"
          >
            Clear selection
          </button>
        ) : null}
      </div>

      <div className="space-y-1.5 max-h-48 overflow-y-auto rounded-2xl border border-white/10 bg-slate-900/70 p-3">
        {visibleLogs.length === 0 ? (
          <p className="text-slate-500 text-xs">Waiting for progress...</p>
        ) : (
          visibleLogs.map((log, idx) => {
            const isSelected = selectedLogIndex === idx;
            return (
              <button
                key={`${log.stage}-${idx}`}
                type="button"
                onClick={() => setSelectedLogIndex(isSelected ? null : idx)}
                className={`w-full rounded-xl border px-3 py-2 text-left text-xs transition ${
                  isSelected
                    ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100"
                    : "border-white/5 bg-white/5 text-slate-300 hover:bg-white/10"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold uppercase tracking-[0.18em] text-[10px] text-cyan-300">
                    {log.stage}
                  </span>
                  <span
                    className={`h-2 w-2 rounded-full ${
                      log.type === "success"
                        ? "bg-emerald-400"
                        : log.type === "error"
                          ? "bg-rose-400"
                          : log.type === "warning"
                            ? "bg-amber-400"
                            : "bg-slate-500"
                    }`}
                  />
                </div>
                <div className="mt-1 leading-5">{log.message}</div>
              </button>
            );
          })
        )}
      </div>

      {selectedLog ? (
        <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-300">
          <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">
            Selected log
          </div>
          <div className="mt-1 font-semibold text-cyan-300">
            {selectedLog.stage}
          </div>
          <div className="mt-1 leading-5">{selectedLog.message}</div>
        </div>
      ) : null}
    </div>
  );

  // Show initialization screen if not ready
  if (!isReady) {
    return (
      <div className="min-h-screen bg-[radial-gradient(circle_at_top,_#0f172a,_#020617_52%,_#020617)] text-slate-100 flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-2xl">
          <div className="rounded-3xl border border-white/10 bg-white/5 px-8 py-12 shadow-2xl shadow-cyan-950/20 backdrop-blur-xl text-center">
            <p className="text-[11px] uppercase tracking-[0.4em] text-cyan-300">
              PixelForge
            </p>
            <h1 className="mt-4 text-4xl font-bold">Local UI Builder</h1>
            <p className="mt-3 text-slate-300 text-sm max-w-xl mx-auto">
              Generate React components locally with WebGPU acceleration
            </p>

            {state.currentPhase === "idle" ? (
              <button
                onClick={() => initializeEngine()}
                className="mt-8 inline-flex items-center gap-2 rounded-2xl bg-cyan-400 px-6 py-4 text-base font-semibold text-slate-950 transition hover:bg-cyan-300"
              >
                <Power className="h-5 w-5" />
                Initialize Runtime
              </button>
            ) : (
              <div className="mt-8 w-full space-y-6">
                {/* Progress Indicator */}
                <div className="space-y-2">
                  <div className="flex items-center justify-center gap-2 mb-4">
                    <Loader2 className="h-5 w-5 animate-spin text-cyan-400" />
                    <span className="text-cyan-300 font-semibold">
                      {state.currentPhase === "initialize"
                        ? "Initializing Runtime..."
                        : "Setting up..."}
                    </span>
                  </div>

                  {/* Progress Steps */}
                  <div className="space-y-2 text-left">
                    <div className="flex items-center gap-3">
                      <div
                        className={`h-2 w-2 rounded-full ${state.logs.some((l) => l.stage === "init" && l.message.includes("Downloading")) ? "bg-emerald-400" : "bg-slate-600"}`}
                      ></div>
                      <span
                        className={`text-xs ${state.logs.some((l) => l.stage === "init" && l.message.includes("Downloading")) ? "text-slate-300" : "text-slate-500"}`}
                      >
                        Downloading WebLLM model (~3.2GB)
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div
                        className={`h-2 w-2 rounded-full ${state.logs.some((l) => l.stage === "init" && l.message.includes("Booting")) ? "bg-emerald-400" : "bg-slate-600"}`}
                      ></div>
                      <span
                        className={`text-xs ${state.logs.some((l) => l.stage === "init" && l.message.includes("Booting")) ? "text-slate-300" : "text-slate-500"}`}
                      >
                        Booting WebContainer runtime
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div
                        className={`h-2 w-2 rounded-full ${state.logs.some((l) => l.type === "success") ? "bg-emerald-400" : "bg-slate-600"}`}
                      ></div>
                      <span
                        className={`text-xs ${state.logs.some((l) => l.type === "success") ? "text-slate-300" : "text-slate-500"}`}
                      >
                        Preparing editor
                      </span>
                    </div>
                  </div>
                </div>

                {renderProgressLogs(false)}
              </div>
            )}

            {state.error && (
              <div className="mt-6 rounded-xl bg-rose-950/50 border border-rose-500/30 px-4 py-3 text-sm text-rose-300">
                {state.error}
              </div>
            )}

            <p className="mt-8 text-xs text-slate-500">
              First-time initialization downloads ~3.2GB model to IndexedDB
              (cached for offline use)
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Normal UI once ready
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_#0f172a,_#020617_52%,_#020617)] text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 py-4 sm:px-6 lg:px-8">
        <header className="rounded-3xl border border-white/10 bg-white/5 px-6 py-5 shadow-2xl shadow-cyan-950/20 backdrop-blur-xl">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[11px] uppercase tracking-[0.4em] text-cyan-300">
                PixelForge
              </p>
              <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">
                Local UI Builder
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
                Describe a UI or upload a screenshot. Get instant React code.
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-xs text-slate-300">
              <div className="text-emerald-400 font-semibold">✓ Ready</div>
              <div className="mt-1 text-slate-500">WebLLM initialized</div>
            </div>
          </div>
        </header>

        <main className="grid flex-1 gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
          {/* Left Panel: Input */}
          <section className="rounded-3xl border border-white/10 bg-slate-950/80 p-5 shadow-xl shadow-slate-950/30 backdrop-blur-xl flex flex-col">
            <div className="flex items-center justify-between gap-2 mb-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.35em] text-cyan-300">
                  Input
                </p>
                <h2 className="mt-1 text-sm font-semibold text-white">
                  Describe or upload
                </h2>
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-slate-200 hover:bg-white/10"
              >
                <Camera className="h-3 w-3" />
                Screenshot
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleScreenshotChange}
              />
            </div>

            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Enter your UI description or paste a refinement..."
              className="flex-1 min-h-[180px] w-full rounded-2xl border border-white/10 bg-white/5 p-3 text-xs leading-5 text-slate-100 outline-none placeholder:text-slate-500 focus:border-cyan-400/40"
            />

            {screenshotName && (
              <div className="mt-3 rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-xs text-slate-300">
                📷 {screenshotName}
              </div>
            )}

            <textarea
              value={refinement}
              onChange={(event) => setRefinement(event.target.value)}
              placeholder="Optional: refine existing code..."
              className="mt-3 h-20 w-full rounded-2xl border border-white/10 bg-white/5 p-3 text-xs leading-5 text-slate-100 outline-none placeholder:text-slate-500 focus:border-cyan-400/40"
            />

            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                disabled={!canGenerate}
                onClick={handleGenerate}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-2.5 text-xs font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                Generate
              </button>
              <button
                type="button"
                onClick={() => {
                  setPrompt("");
                  setRefinement("");
                  setScreenshotDataUrl(null);
                  setScreenshotName(null);
                  resetGeneratedCanvas();
                }}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs text-slate-200 hover:bg-white/10"
              >
                <Trash2 className="h-4 w-4" />
                Reset
              </button>
            </div>

            <div className="mt-6 rounded-2xl border border-white/10 bg-slate-900/80 p-3 text-xs text-slate-400">
              <div className="font-semibold text-white mb-2">History</div>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {history.length === 0 ? (
                  <p className="text-slate-500">No history yet</p>
                ) : (
                  history.slice(0, 5).map((item) => (
                    <div
                      key={item.id}
                      className="rounded-lg bg-white/5 px-2 py-1"
                    >
                      <div className="text-slate-200 line-clamp-2">
                        {item.prompt}
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-500">
                        {new Date(item.timestamp).toLocaleTimeString()}
                      </div>
                    </div>
                  ))
                )}
              </div>
              {history.length > 0 && (
                <button
                  onClick={clearHistory}
                  className="mt-2 text-xs text-cyan-300 hover:text-cyan-200 w-full"
                >
                  Clear
                </button>
              )}
            </div>
          </section>

          {/* Right Panel: Output */}
          <section className="flex min-h-[70vh] flex-col rounded-3xl border border-white/10 bg-slate-950/80 shadow-xl shadow-slate-950/30 backdrop-blur-xl">
            {busy && latestLog ? (
              <div className="border-b border-white/10 bg-cyan-400/5 px-5 py-3 text-xs text-cyan-200">
                <span className="font-semibold uppercase tracking-[0.2em] text-cyan-300">
                  {latestLog.stage}
                </span>{" "}
                {latestLog.message}
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-4 border-b border-white/10 px-5 py-3">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setActiveTab("preview")}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    activeTab === "preview"
                      ? "bg-cyan-400 text-slate-950"
                      : "bg-white/5 text-slate-300 hover:bg-white/10"
                  }`}
                >
                  Preview
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab("code")}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    activeTab === "code"
                      ? "bg-cyan-400 text-slate-950"
                      : "bg-white/5 text-slate-300 hover:bg-white/10"
                  }`}
                >
                  Code
                </button>
              </div>
              <button
                type="button"
                onClick={handleCopy}
                disabled={!generatedCode}
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Copy className="h-3.5 w-3.5" />
                {copied ? "Copied" : "Copy"}
              </button>
            </div>

            {busy ? (
              <div className="border-b border-white/10 px-5 py-4">
                {renderProgressLogs(true)}
              </div>
            ) : null}

            <div className="flex-1 p-4 overflow-hidden">
              {state.error ? (
                <div className="flex h-full items-center justify-center rounded-2xl border border-rose-500/30 bg-rose-950/20 px-6 text-center">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.35em] text-rose-300">
                      Generation error
                    </p>
                    <p className="mt-3 text-sm text-rose-200">{state.error}</p>
                  </div>
                </div>
              ) : activeTab === "preview" ? (
                previewUrl ? (
                  <iframe
                    src={previewUrl}
                    title="Generated preview"
                    className="h-full w-full rounded-2xl border border-white/10 bg-slate-900"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/5 text-center text-slate-400">
                    {busy ? (
                      <div className="flex flex-col items-center gap-2">
                        <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
                        <p className="text-sm">Generating preview...</p>
                      </div>
                    ) : (
                      <p className="text-sm">Preview will appear here</p>
                    )}
                  </div>
                )
              ) : (
                <div className="h-full rounded-2xl border border-white/10 bg-slate-900/80 overflow-hidden">
                  <Editor
                    height="100%"
                    defaultLanguage="tsx"
                    value={
                      generatedCode ||
                      "export default function App() {\n  return null;\n}"
                    }
                    theme="vs-dark"
                    options={{
                      minimap: { enabled: false },
                      fontSize: 13,
                      wordWrap: "on",
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      readOnly: true,
                    }}
                  />
                </div>
              )}
            </div>

            {state.error && (
              <div className="border-t border-white/10 px-5 py-4 bg-rose-950/20 border-t-rose-500/30">
                <p className="text-sm text-rose-300">
                  <span className="font-semibold">Error:</span> {state.error}
                </p>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
};
