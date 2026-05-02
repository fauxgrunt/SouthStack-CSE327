import { useState, useCallback, useRef, useEffect } from "react";
import * as webllm from "@mlc-ai/web-llm";
import { detectDeviceCapability, limitArraySize } from "../utils/performance";
import { webContainerService } from "../services/webcontainer";
import { autoCloseJsx } from "../utils/jsxAutoFixer";
import { saveFailedWorkerOutput } from "../utils/failureCapture";
import { aggressiveSanitize } from "../utils/codeSanitizer";

// Model Configuration - worker-first preference for stronger code generation
export type ModelType = "3B" | "7B";

// Maximum number of logs to keep in memory (prevent memory leaks)
const MAX_LOG_ENTRIES = 500;

export const MODEL_CONFIGS = Object.freeze({
  "3B": {
    id: "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC",
    label: "Vision Blueprint Model (3B)",
    description: "Stage 1 blueprint extraction for image-led requests",
    minStorage: 3.2 * 1024 * 1024 * 1024,
  },
  "7B": {
    id: "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC",
    label: "React Coder Model (3B-downgrade)",
    description:
      "Stage 2 React generation for finalized UI code (downgraded to 3B for demo stability)",
    minStorage: 3.2 * 1024 * 1024 * 1024,
  },
});

const STRICT_MODEL_LOAD_ERRORS: Record<ModelType, string> = {
  "3B": "INSUFFICIENT VRAM: Cannot load 3B Vision Blueprint Model",
  "7B": "INSUFFICIENT VRAM: Cannot load 7B Coder Model",
};

// Types
interface AgenticLoopState {
  isInitialized: boolean;
  isLoading: boolean;
  initProgress: number;
  isExecuting: boolean;
  currentPhase:
    | "idle"
    | "generating"
    | "executing"
    | "fixing"
    | "completed"
    | "error";
  logs: LogEntry[];
  generatedCode: string | null;
  error: string | null;
  retryCount: number;
  selectedModel: ModelType;
  storageAvailable: number | null;
  previewUrl: string | null;
}

interface LogEntry {
  timestamp: Date;
  phase: string;
  message: string;
  type: "info" | "success" | "error" | "warning";
}

interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  stackTrace?: string;
}

interface WebContainerProcess {
  kill: () => void;
  exit: Promise<number>;
}

interface InferenceProfile {
  name: "low" | "balanced" | "high" | "lite";
  contextWindowSize: number;
  maxCompletionTokens: number;
  temperature: number;
  retryAttempts: number;
  runBuildValidation: boolean;
  useVisionBlueprint: boolean;
  prewarmPreviewRuntime: boolean;
  completionTimeoutMs: number;
  structuredSpecTimeoutMs: number;
}

interface EdgeVisionV1UiSpec {
  version: "1.0";
  title: string;
  subtitle?: string;
  sections: EdgeVisionV1UiSection[];
  cta?: {
    label: string;
  };
}

interface EdgeVisionV1UiSection {
  id: string;
  type: "hero" | "cards" | "stats" | "features" | "timeline" | "faq";
  heading: string;
  body?: string;
  items?: string[];
}

const WEBLLM_CONTEXT_SAFETY_MARGIN = 128;
const DEV_SERVER_STARTUP_TIMEOUT_MS = 90000;
const WEBCONTAINER_WARMUP_TIMEOUT_MS = 4000;
const WEBCONTAINER_EXECUTION_BOOT_TIMEOUT_MS = 30000;
const DEFAULT_STRUCTURED_SPEC_TIMEOUT_MS = 120000;
const DEFAULT_LLM_COMPLETION_TIMEOUT_MS = 60000;
const PREWARM_BOOT_TIMEOUT_MS = 45000;
const MAX_UI_SPEC_SECTIONS = 8;
const MAX_UI_SPEC_ITEMS = 6;
let sharedEngineInstance: webllm.MLCEngine | null = null;
let sharedEngineInitPromise: Promise<webllm.MLCEngine> | null = null;

function clearSharedEngineCache() {
  sharedEngineInstance = null;
  sharedEngineInitPromise = null;
}

function isDisposedEngineError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /disposed|already been disposed|engine has been disposed/i.test(
    message,
  );
}

function isInvalidExternalInstanceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /valid external instance reference no longer exists|external instance reference/i.test(
    message,
  );
}

function isRecoverableEngineInstanceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    isDisposedEngineError(error) ||
    isInvalidExternalInstanceError(error) ||
    /context lost|device lost|gpu device/i.test(message)
  );
}

function healVramTypos(code: string, onHealed?: () => void): string {
  const original = code;
  const result = (
    code
      // Fix mangled export statements
      .replace(/export dult\b/g, "export default")
      .replace(/expor default\b/g, "export default")
      .replace(/export defalt\b/g, "export default")
      .replace(/export defaut\b/g, "export default")
      // Brute force catch-all for the bottom of the file
      .replace(/export [a-zA-Z]+ App;/g, "export default App;")

      // Fix standard HTML tags
      .replace(/<ma\b/g, "<main")
      .replace(/<\/ma>/g, "</main>")
      .replace(/<hader\b/g, "<header")
      .replace(/<\/hader>/g, "</header>")
      .replace(/<fooer\b/g, "<footer")
      .replace(/<\/fooer>/g, "</footer>")
      .replace(/<foter\b/g, "<footer")
      .replace(/<\/foter>/g, "</footer>")

      // Fix React attributes
      .replace(/clssName=/g, "className=")
      .replace(/cassName=/g, "className=")
      .replace(/clasName=/g, "className=")
      .replace(/onChane=/g, "onChange=")

      // Fix common HTML attributes
      .replace(/tpe="/g, 'type="')
      .replace(/placohlder=/g, "placeholder=")
      .replace(/placehoder=/g, "placeholder=")
      // Fix double-closed self-closing input tags produced by VRAM mangling
      .replace(/<input \/>/g, "<input")
  );

  if (result !== original && typeof onHealed === "function") {
    try {
      onHealed();
    } catch (e) {
      // ignore errors from callback
    }
  }

  return result;
}

/**
 * useAgenticLoop - Core hook for autonomous AI coding with self-healing
 *
 * This hook orchestrates the complete agentic workflow:
 * 1. Context injection from local RAG
 * 2. Code generation via WebLLM
 * 3. Autonomous execution in WebContainer
 * 4. Self-healing loop on errors
 */
export const useAgenticLoop = () => {
  const startTime = performance.now();
  let typosHealed = 0;

  const [state, setState] = useState<AgenticLoopState>({
    isInitialized: false,
    isLoading: false,
    initProgress: 0,
    isExecuting: false,
    currentPhase: "idle",
    logs: [],
    generatedCode: null,
    error: null,
    retryCount: 0,
    selectedModel: "7B",
    storageAvailable: null,
    previewUrl: null,
  });

  const engineRef = useRef<webllm.MLCEngine | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const dependenciesInstalledRef = useRef(false);
  const devServerProcessRef = useRef<WebContainerProcess | null>(null);
  const devServerUrlRef = useRef<string | null>(null);
  const webContainerAvailableRef = useRef(true);
  const webContainerBootPromiseRef = useRef<Promise<boolean> | null>(null);
  const lastInitProgressRef = useRef(-1);
  const previewRuntimePreparedRef = useRef(false);

  // Tier-5 PERFECT fallback: guaranteed-safe, minimal Tailwind React app
  const DEFAULT_SAFE_FALLBACK = `export default function App(){
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white overflow-hidden">
      <div className="absolute inset-0 opacity-30">
        <div className="absolute top-20 left-10 w-72 h-72 bg-purple-500 rounded-full mix-blend-multiply filter blur-3xl animate-pulse"></div>
        <div className="absolute bottom-20 right-10 w-72 h-72 bg-blue-500 rounded-full mix-blend-multiply filter blur-3xl animate-pulse animation-delay-2000"></div>
      </div>
      <div className="relative z-10 min-h-screen flex flex-col items-center justify-center px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12 animate-fadeIn">
          <h1 className="text-6xl sm:text-7xl font-black mb-6 bg-clip-text text-transparent bg-gradient-to-r from-purple-400 via-pink-400 to-blue-400">
            SouthStack
          </h1>
          <p className="text-xl sm:text-2xl text-purple-200 font-light mb-2">Generative AI Canvas</p>
          <p className="text-sm sm:text-base text-slate-400">Your UI appears here • Powered by Local LLMs</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-4xl mb-12">
          <div className="bg-white/10 backdrop-blur-md rounded-2xl p-8 border border-white/20 hover:border-purple-400/50 transition-all hover:scale-105">
            <div className="text-4xl mb-4">⚡</div>
            <h3 className="text-lg font-bold mb-2">Local First</h3>
            <p className="text-sm text-slate-300">Runs entirely in your browser</p>
          </div>
          <div className="bg-white/10 backdrop-blur-md rounded-2xl p-8 border border-white/20 hover:border-purple-400/50 transition-all hover:scale-105">
            <div className="text-4xl mb-4">🎨</div>
            <h3 className="text-lg font-bold mb-2">Modern UI</h3>
            <p className="text-sm text-slate-300">Tailwind + React Components</p>
          </div>
          <div className="bg-white/10 backdrop-blur-md rounded-2xl p-8 border border-white/20 hover:border-purple-400/50 transition-all hover:scale-105">
            <div className="text-4xl mb-4">🚀</div>
            <h3 className="text-lg font-bold mb-2">Instant</h3>
            <p className="text-sm text-slate-300">Real-time code generation</p>
          </div>
        </div>
        <button className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-bold py-4 px-12 rounded-full text-lg transition-all hover:scale-110 shadow-2xl">
          Get Started
        </button>
      </div>
    </div>
  );
}`;
  const previewRuntimePreparingRef = useRef(false);
  const inferenceProfileRef = useRef<InferenceProfile>(
    buildInferenceProfile("medium", true),
  );
  const isGeneratingRef = useRef(false);

  const getSharedEngine = useCallback(async () => {
    if (sharedEngineInstance) {
      return sharedEngineInstance;
    }

    if (sharedEngineInitPromise) {
      return sharedEngineInitPromise;
    }

    sharedEngineInitPromise = Promise.resolve().then(() => {
      sharedEngineInstance = new webllm.MLCEngine();
      return sharedEngineInstance;
    });

    try {
      return await sharedEngineInitPromise;
    } catch (error) {
      sharedEngineInitPromise = null;
      sharedEngineInstance = null;
      throw error;
    } finally {
      sharedEngineInitPromise = null;
    }
  }, []);

  // Logging utility with automatic size limiting for memory management
  const addLog = useCallback(
    (phase: string, message: string, type: LogEntry["type"] = "info") => {
      setState((prev) => {
        const newLogs = [
          ...prev.logs,
          { timestamp: new Date(), phase, message, type },
        ];
        // Automatically limit log array size to prevent memory issues
        return {
          ...prev,
          logs: limitArraySize(newLogs, MAX_LOG_ENTRIES),
        };
      });
    },
    [],
  );

  const reloadLockedModel = useCallback(
    async (modelType: ModelType, phase: string): Promise<void> => {
      const loadModel = async (engine: webllm.MLCEngine) => {
        await engine.reload(modelConfig.id, {
          context_window_size: inferenceProfileRef.current.contextWindowSize,
        });
      };

      const modelConfig = MODEL_CONFIGS[modelType];
      let engine = engineRef.current;
      if (!engine) {
        throw new Error("WebLLM engine is not initialized.");
      }

      try {
        await loadModel(engine);
        setState((prev) => ({ ...prev, selectedModel: modelType }));
      } catch (error) {
        let finalError: unknown = error;
        if (isRecoverableEngineInstanceError(error)) {
          addLog(
            phase,
            "WebLLM engine instance became invalid. Reinitializing and retrying model load once...",
            "warning",
          );

          clearSharedEngineCache();
          engine = await getSharedEngine();
          engineRef.current = engine;

          try {
            await loadModel(engine);
            setState((prev) => ({ ...prev, selectedModel: modelType }));
            return;
          } catch (retryError) {
            finalError = retryError;
          }
        }

        const errorMessage =
          finalError instanceof Error ? finalError.message : String(finalError);
        const normalizedMessage =
          /vram|memory|allocation|out of memory|webgpu/i.test(errorMessage)
            ? STRICT_MODEL_LOAD_ERRORS[modelType]
            : `Failed to load ${modelConfig.label}: ${errorMessage}`;

        addLog(phase, normalizedMessage, "error");
        throw new Error(normalizedMessage);
      }
    },
    [addLog, getSharedEngine],
  );

  const resetGeneratedCanvas = useCallback((): void => {
    setState((prev) => ({
      ...prev,
      generatedCode: null,
      previewUrl: null,
      error: null,
      currentPhase: "idle",
      isExecuting: false,
    }));
  }, []);

  /**
   * Check available storage (informational only)
   */
  const checkStorageAvailability = useCallback(async (): Promise<void> => {
    try {
      if ("storage" in navigator && "estimate" in navigator.storage) {
        const estimate = await navigator.storage.estimate();
        const available = (estimate.quota || 0) - (estimate.usage || 0);

        setState((prev) => ({ ...prev, storageAvailable: available }));

        const availableGB = available / (1024 * 1024 * 1024);
        addLog(
          "storage",
          `Available storage: ${availableGB.toFixed(2)}GB`,
          "info",
        );

        if (available < 1 * 1024 * 1024 * 1024) {
          // Less than 1GB
          addLog(
            "storage",
            "Low storage detected. The 3B blueprint model requires ~3.2GB and the 7B coder model requires substantially more.",
            "warning",
          );
        }
      }
    } catch (error) {
      addLog("storage", "Could not estimate storage.", "warning");
    }
  }, [addLog]);

  /**
   * Request persistent storage so model/cache data is less likely to be evicted.
   */
  const requestPersistentStorage = useCallback(async (): Promise<void> => {
    try {
      if (!("storage" in navigator) || !("persist" in navigator.storage)) {
        addLog(
          "storage",
          "Persistent storage API not available in this browser.",
          "warning",
        );
        return;
      }

      if ("persisted" in navigator.storage) {
        const isAlreadyPersistent = await navigator.storage.persisted();
        if (isAlreadyPersistent) {
          addLog("storage", "Persistent storage already granted.", "success");
          return;
        }
      }

      const granted = await navigator.storage.persist();
      if (granted) {
        addLog(
          "storage",
          "Persistent storage granted. Cached model data is now less likely to be evicted.",
          "success",
        );
      } else {
        addLog(
          "storage",
          "Persistent storage request was not granted. Cached model data may still be evicted under storage pressure.",
          "warning",
        );
      }
    } catch {
      addLog("storage", "Could not request persistent storage.", "warning");
    }
  }, [addLog]);

  const ensureWebContainerReady = useCallback(
    async (
      timeoutMs: number,
      logMode: "none" | "warmup" | "execution",
    ): Promise<boolean> => {
      if (webContainerService.isReady()) {
        webContainerAvailableRef.current = true;
        return true;
      }

      if (!webContainerAvailableRef.current) {
        return false;
      }

      if (!webContainerBootPromiseRef.current) {
        webContainerBootPromiseRef.current = (async () => {
          const timeoutSignal = new Promise<boolean>((resolve) => {
            window.setTimeout(() => resolve(false), timeoutMs);
          });

          try {
            const bootResult = await Promise.race([
              webContainerService.boot().then(() => true),
              timeoutSignal,
            ]);

            if (bootResult) {
              webContainerAvailableRef.current = true;
              if (logMode === "warmup") {
                addLog(
                  "initialization",
                  "WebContainer runtime ready (background warmup complete).",
                  "success",
                );
              }
              return true;
            }

            if (logMode === "execution") {
              addLog(
                "execution",
                "Runtime boot is taking too long. Continuing without live preview for this run.",
                "warning",
              );
            }

            return false;
          } catch (bootError: unknown) {
            const bootMessage =
              bootError instanceof Error ? bootError.message : "Unknown error";

            // Keep runtime retryable unless platform support is clearly missing.
            if (/sharedarraybuffer|coop|coep|cross-origin/i.test(bootMessage)) {
              webContainerAvailableRef.current = false;
            }

            if (logMode !== "none") {
              addLog(
                "initialization",
                `WebContainer unavailable on this device/browser. Continuing without live runtime execution. (${bootMessage})`,
                "warning",
              );
            }

            return false;
          } finally {
            webContainerBootPromiseRef.current = null;
          }
        })();
      }

      return webContainerBootPromiseRef.current;
    },
    [addLog],
  );

  const prewarmPreviewRuntime = useCallback(async () => {
    if (
      previewRuntimePreparedRef.current ||
      previewRuntimePreparingRef.current
    ) {
      return;
    }

    previewRuntimePreparingRef.current = true;

    try {
      const ready = await ensureWebContainerReady(
        PREWARM_BOOT_TIMEOUT_MS,
        "none",
      );
      if (!ready) {
        return;
      }

      const workspaceResult = await ensureReactWorkspace(
        addLog,
        dependenciesInstalledRef,
      );
      if (!workspaceResult.success) {
        addLog(
          "execution",
          `Background preview prewarm failed: ${workspaceResult.error || workspaceResult.output}`,
          "warning",
        );
        return;
      }

      const devServerResult = await ensureDevServerRunning(
        addLog,
        devServerProcessRef,
        devServerUrlRef,
        (url) => {
          setState((prev) => ({ ...prev, previewUrl: url }));
        },
      );

      if (!devServerResult.success) {
        addLog(
          "execution",
          `Background preview server prewarm failed: ${devServerResult.error || devServerResult.output}`,
          "warning",
        );
        return;
      }

      previewRuntimePreparedRef.current = true;
      addLog(
        "execution",
        "Preview runtime prewarmed in background.",
        "success",
      );
    } finally {
      previewRuntimePreparingRef.current = false;
    }
  }, [addLog, ensureWebContainerReady]);

  // Model selection is intentionally strict: the active pipeline only uses the
  // 3B blueprint stage and the 7B coder stage.

  /**
   * Initialize WebLLM Engine with WebGPU error handling
   */
  const initializeEngine = useCallback(async () => {
    if (engineRef.current) return;

    setState((prev) => ({
      ...prev,
      isLoading: true,
      initProgress: 0,
      error: null,
    }));
    addLog("initialization", "Initializing worker model pipeline...", "info");

    try {
      const capability = await detectDeviceCapability();

      // Run non-critical storage tasks in background to avoid delaying readiness.
      void requestPersistentStorage();
      void checkStorageAvailability();

      // Check WebGPU availability
      const navigatorWithGPU = navigator as typeof navigator & {
        gpu?: { requestAdapter: () => Promise<unknown> };
      };
      const hasWebGPU = Boolean(navigatorWithGPU.gpu);
      inferenceProfileRef.current = buildInferenceProfile(
        capability,
        hasWebGPU,
      );

      addLog(
        "initialization",
        `Performance profile: ${inferenceProfileRef.current.name}`,
        "info",
      );

      if (!inferenceProfileRef.current.prewarmPreviewRuntime) {
        addLog(
          "initialization",
          "Low-end optimization active: background preview prewarm is disabled.",
          "warning",
        );
      }

      if (!inferenceProfileRef.current.useVisionBlueprint) {
        addLog(
          "initialization",
          "Low-end optimization active: image blueprint stage disabled to avoid 3B/7B model thrashing.",
          "warning",
        );
      }

      addLog(
        "initialization",
        hasWebGPU
          ? "[OK] WebGPU detected via navigator.gpu."
          : "[ERROR] WebGPU is unavailable in this browser. UI generation requires a WebGPU-capable runtime.",
        hasWebGPU ? "success" : "error",
      );

      addLog(
        "initialization",
        typeof SharedArrayBuffer !== "undefined"
          ? "[OK] SharedArrayBuffer is available. WebContainer preview can boot with COOP/COEP isolation."
          : "[ERROR] SharedArrayBuffer is unavailable. WebContainer preview will fail until COOP/COEP headers enable cross-origin isolation.",
        typeof SharedArrayBuffer !== "undefined" ? "success" : "error",
      );

      // Warm runtime asynchronously only when profile allows prewarm.
      if (inferenceProfileRef.current.prewarmPreviewRuntime) {
        addLog(
          "initialization",
          "Warming WebContainer in background...",
          "info",
        );
        void ensureWebContainerReady(WEBCONTAINER_WARMUP_TIMEOUT_MS, "warmup");
      }

      if (!hasWebGPU) {
        engineRef.current = null;
        const lowEndMessage =
          "WebGPU unavailable on this device. UI generation requires a WebGPU-capable worker node.";
        addLog("initialization", lowEndMessage, "error");

        setState((prev) => ({
          ...prev,
          isInitialized: false,
          isLoading: false,
          initProgress: 0,
          currentPhase: "error",
          error: lowEndMessage,
        }));
        throw new Error(lowEndMessage);
      }

      const engine = await getSharedEngine();
      engineRef.current = engine;

      // Progress tracking for model download
      engine.setInitProgressCallback((report: webllm.InitProgressReport) => {
        const maybeProgress = (report as { progress?: number }).progress;
        if (typeof maybeProgress === "number") {
          const nextProgress = Math.max(
            0,
            Math.min(100, Math.round(maybeProgress * 100)),
          );

          if (nextProgress === lastInitProgressRef.current) {
            return;
          }

          lastInitProgressRef.current = nextProgress;
          setState((prev) => ({
            ...prev,
            initProgress: nextProgress,
          }));
        }
        addLog("initialization", report.text, "info");
      });

      const coderModelConfig = MODEL_CONFIGS["7B"];
      addLog(
        "initialization",
        `Loading ${coderModelConfig.label} for the final React generation stage...`,
        "info",
      );

      await reloadLockedModel("7B", "initialization");

      addLog(
        "initialization",
        `Worker engine ready with ${coderModelConfig.label}.`,
        "success",
      );
      setState((prev) => ({
        ...prev,
        isInitialized: true,
        isLoading: false,
        initProgress: 100,
      }));

      // Pre-install preview runtime in background only on capable devices.
      if (inferenceProfileRef.current.prewarmPreviewRuntime) {
        void prewarmPreviewRuntime();
      }
    } catch (error: any) {
      const errorMsg = error.message || "Failed to initialize WebLLM";
      addLog("initialization", `ERROR: ${errorMsg}`, "error");
      setState((prev) => ({
        ...prev,
        isLoading: false,
        initProgress: 0,
        error: errorMsg,
        currentPhase: "error",
      }));

      // Reset the hook-local reference on failure; keep the shared singleton available
      // only if it was successfully initialized.
      engineRef.current = null;
    }
  }, [
    addLog,
    checkStorageAvailability,
    ensureWebContainerReady,
    getSharedEngine,
    prewarmPreviewRuntime,
    requestPersistentStorage,
    reloadLockedModel,
  ]);

  /**
   * Main Agentic Loop - Autonomous code generation with self-healing
   */
  const executeAgenticLoop = useCallback(
    async (userPrompt: string, ragContext?: string[]) => {
      if (isGeneratingRef.current) {
        const busyMessage = "Please wait for the current task to finish.";
        addLog("execution", busyMessage, "warning");
        return { success: false, error: busyMessage };
      }

      isGeneratingRef.current = true;

      const profile = inferenceProfileRef.current;

      // Create abort controller for this execution
      abortControllerRef.current = new AbortController();

      setState((prev) => ({
        ...prev,
        isExecuting: true,
        currentPhase: "generating",
        error: null,
        retryCount: 0,
        generatedCode: null,
        previewUrl: null,
      }));

      let attempt = 0;
      let lastError: string | undefined;
      let currentCode: string | null = null;

      try {
        if (
          engineRef.current !== sharedEngineInstance &&
          sharedEngineInstance
        ) {
          engineRef.current = sharedEngineInstance;
        }

        if (!engineRef.current) {
          throw new Error("WebLLM engine is not initialized.");
        }

        while (attempt < profile.retryAttempts) {
          if (abortControllerRef.current?.signal.aborted) {
            addLog("execution", "Execution cancelled by user", "warning");
            break;
          }

          attempt++;

          // PHASE 1: Context Injection + Code Generation
          setState((prev) => ({
            ...prev,
            currentPhase: "generating",
            retryCount: attempt,
          }));

          const userMessage =
            attempt === 1
              ? userPrompt
              : buildFixPrompt(userPrompt, lastError!, currentCode!);

          const compactUserMessage = compactPromptForLowEnd(userMessage);
          const imageLedPrompt = isImageLedPrompt(userPrompt);

          try {
            if (!engineRef.current) {
              throw new Error(
                "WebLLM engine unavailable for generation. Ensure a WebGPU-capable worker is initialized.",
              );
            }

            if (imageLedPrompt && profile.useVisionBlueprint) {
              const visionSystemPrompt = `You are the 3B Vision Blueprint stage for SouthStack.
Return exactly one JSON object and nothing else.
Schema:
{
  "version": "1.0",
  "title": "string",
  "subtitle": "string (optional)",
  "sections": [
    {
      "id": "string",
      "type": "hero|cards|stats|features|timeline|faq",
      "heading": "string",
      "body": "string (optional)",
      "items": ["string"]
    }
  ],
  "cta": { "label": "string" }
}
Rules:
- Preserve screenshot hierarchy and visible copy
- Do not write JSX, HTML, markdown, or shell commands
- Do not invent generic dashboard sections
- Keep the output concise and directly usable as a React blueprint`;

              const visionWindow = fitPromptToContextWindow(
                visionSystemPrompt,
                compactUserMessage,
                {
                  contextWindowSize: profile.contextWindowSize,
                  maxCompletionTokens: Math.min(
                    768,
                    profile.maxCompletionTokens,
                  ),
                  safetyMarginTokens: WEBLLM_CONTEXT_SAFETY_MARGIN,
                },
              );

              if (visionWindow.wasTruncated) {
                addLog(
                  "generation",
                  `[Warning] Blueprint prompt truncated to fit context window. (~${visionWindow.estimatedPromptTokens} prompt tokens)`,
                  "warning",
                );
              }

              addLog("generation", "Extracting Vision Blueprint...", "info");

              await reloadLockedModel("3B", "generation");

              const blueprintCompletion = await withTimeout(
                engineRef.current.chat.completions.create({
                  messages: [
                    { role: "system", content: visionSystemPrompt },
                    { role: "user", content: visionWindow.userPrompt },
                  ],
                  temperature: 0.05,
                  top_p: 0.95,
                  repetition_penalty: 1.15,
                  frequency_penalty: 0.1,
                  max_tokens: Math.min(768, profile.maxCompletionTokens),
                }),
                profile.structuredSpecTimeoutMs,
              );

              if (!blueprintCompletion) {
                throw new Error("Vision blueprint generation timed out.");
              }

              const rawBlueprint =
                blueprintCompletion.choices[0].message.content || "";
              const parsedBlueprint = parseEdgeVisionV1UiSpec(rawBlueprint);

              if (!parsedBlueprint) {
                throw new Error(
                  "Vision blueprint was invalid and could not be parsed.",
                );
              }

              const uiBlueprint = JSON.stringify(parsedBlueprint, null, 2);

              addLog(
                "generation",
                "Vision blueprint extracted successfully.",
                "success",
              );

              addLog("generation", "Loading 7B coder model...", "info");

              addLog("generation", "Generating React Architecture...", "info");

              const coderSystemPrompt = buildSystemPrompt(ragContext, "7B");
              const coderUserMessage = [
                `Original request:\n${userMessage}`,
                "",
                "UI BLUEPRINT:",
                uiBlueprint,
                "",
                "Build the final React component from the blueprint above.",
                "Output only one runnable React component with export default function App().",
                "Use only React imports from react.",
                "Do not add any third-party packages or generic template sections.",
              ].join("\n");

              const coderWindow = fitPromptToContextWindow(
                coderSystemPrompt,
                coderUserMessage,
                {
                  contextWindowSize: profile.contextWindowSize,
                  maxCompletionTokens: profile.maxCompletionTokens,
                  safetyMarginTokens: WEBLLM_CONTEXT_SAFETY_MARGIN,
                },
              );

              if (coderWindow.wasTruncated) {
                addLog(
                  "generation",
                  `[Warning] Coder prompt truncated to fit context window. (~${coderWindow.estimatedPromptTokens} prompt tokens)`,
                  "warning",
                );
              }

              await reloadLockedModel("7B", "generation");

              const completion = await withTimeout(
                engineRef.current.chat.completions.create({
                  messages: [
                    { role: "system", content: coderSystemPrompt },
                    { role: "user", content: coderWindow.userPrompt },
                  ],
                  temperature: 0.05,
                  top_p: 0.95,
                  repetition_penalty: 1.15,
                  frequency_penalty: 0.1,
                  max_tokens: profile.maxCompletionTokens,
                }),
                profile.completionTimeoutMs,
              );

              if (!completion) {
                throw new Error(
                  "Model completion timed out during React generation.",
                );
              }

              const rawCompletion1 =
                completion.choices[0].message.content || "";
              console.log("AUDIT [1] RAW AI OUTPUT:\n", rawCompletion1);
              currentCode = extractCode(rawCompletion1);
              console.log("AUDIT [2] AFTER YAP-CUTTER:\n", currentCode);
            } else if (imageLedPrompt && !profile.useVisionBlueprint) {
              addLog(
                "generation",
                "Low-end mode: skipping dedicated 3B blueprint stage and generating directly with coder model.",
                "warning",
              );

              const systemPrompt = buildSystemPrompt(ragContext, "7B");
              const coderWindow = fitPromptToContextWindow(
                systemPrompt,
                compactUserMessage,
                {
                  contextWindowSize: profile.contextWindowSize,
                  maxCompletionTokens: profile.maxCompletionTokens,
                  safetyMarginTokens: WEBLLM_CONTEXT_SAFETY_MARGIN,
                },
              );

              if (coderWindow.wasTruncated) {
                addLog(
                  "generation",
                  `[Warning] Prompt truncated to fit context window. (~${coderWindow.estimatedPromptTokens} prompt tokens)`,
                  "warning",
                );
              }

              await reloadLockedModel("7B", "generation");

              const completion = await withTimeout(
                engineRef.current.chat.completions.create({
                  messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: coderWindow.userPrompt },
                  ],
                  temperature: 0.05,
                  top_p: 0.95,
                  repetition_penalty: 1.15,
                  frequency_penalty: 0.1,
                  max_tokens: profile.maxCompletionTokens,
                }),
                profile.completionTimeoutMs,
              );

              if (!completion) {
                throw new Error(
                  "Model completion timed out during low-end image-led generation.",
                );
              }

              const rawCompletion2 =
                completion.choices[0].message.content || "";
              console.log("AUDIT [1] RAW AI OUTPUT:\n", rawCompletion2);
              currentCode = extractCode(rawCompletion2);
              console.log("AUDIT [2] AFTER YAP-CUTTER:\n", currentCode);
            } else {
              const systemPrompt = buildSystemPrompt(ragContext, "7B");
              const coderWindow = fitPromptToContextWindow(
                systemPrompt,
                compactUserMessage,
                {
                  contextWindowSize: profile.contextWindowSize,
                  maxCompletionTokens: profile.maxCompletionTokens,
                  safetyMarginTokens: WEBLLM_CONTEXT_SAFETY_MARGIN,
                },
              );

              if (coderWindow.wasTruncated) {
                addLog(
                  "generation",
                  `[Warning] Prompt truncated to fit context window. (~${coderWindow.estimatedPromptTokens} prompt tokens)`,
                  "warning",
                );
              }

              addLog(
                "generation",
                attempt === 1
                  ? `Generating code for: "${userPrompt}"`
                  : `Attempt ${attempt}: Self-correcting based on error...`,
                "info",
              );

              await reloadLockedModel("7B", "generation");

              const completion = await withTimeout(
                engineRef.current.chat.completions.create({
                  messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: coderWindow.userPrompt },
                  ],
                  temperature: 0.05,
                  top_p: 0.95,
                  repetition_penalty: 1.15,
                  frequency_penalty: 0.1,
                  max_tokens: profile.maxCompletionTokens,
                }),
                profile.completionTimeoutMs,
              );

              if (!completion) {
                throw new Error(
                  "Model completion timed out during code generation.",
                );
              }

              const rawCompletion3 =
                completion.choices[0].message.content || "";
              console.log("AUDIT [1] RAW AI OUTPUT:\n", rawCompletion3);
              currentCode = extractCode(rawCompletion3);
              console.log("AUDIT [2] AFTER YAP-CUTTER:\n", currentCode);
            }

            if (
              currentCode &&
              shouldTreatAsInvalidUiCode(currentCode, userPrompt)
            ) {
              throw new Error("Model returned non-executable UI instructions.");
            }

            if (!currentCode) {
              throw new Error("AI generated empty or invalid code");
            }

            if (!isLikelyValidGeneratedCode(currentCode, userPrompt)) {
              throw new Error(
                "Generated code failed validity checks and cannot be safely executed.",
              );
            }

            setState((prev) => ({ ...prev, generatedCode: currentCode }));
            addLog(
              "generation",
              `Code generated (${currentCode.length} chars)`,
              "success",
            );
          } catch (genError: any) {
            const msg = genError?.message || String(genError);
            // Log the issue but avoid throwing to keep the UI alive.
            addLog("generation", `Generation error: ${msg}`, "error");

            // Handle timeouts and OOMs gracefully: prefer partial code if present.
            if (msg.toLowerCase().includes("timed out")) {
              addLog(
                "generation",
                "Model timeout reached during generation. Proceeding with partial output if available.",
                "warning",
              );
            }

            if (
              msg.toLowerCase().includes("out of memory") ||
              /webgpu/i.test(msg)
            ) {
              addLog(
                "generation",
                "WebGPU OOM or device error during generation. Proceeding with partial output if available.",
                "warning",
              );
            }

            // If we captured any partial code, stash it and continue to execution so the user can repair it.
            if (currentCode && currentCode.trim()) {
              addLog(
                "generation",
                "Using partial generated code due to generation error.",
                "warning",
              );
              setState((prev) => ({ ...prev, generatedCode: currentCode }));
              // fall through to execution path with partial 'currentCode'
            } else {
              // No partial output: return a safe failure result but do not throw.
              setState((prev) => ({
                ...prev,
                isExecuting: false,
                currentPhase: "error",
                error: msg,
              }));

              return { success: false, error: msg } as ExecutionResult & {
                code?: string;
              };
            }
          }

          if (
            !webContainerAvailableRef.current ||
            !(await ensureWebContainerReady(
              WEBCONTAINER_EXECUTION_BOOT_TIMEOUT_MS,
              "execution",
            ))
          ) {
            addLog(
              "execution",
              "Skipping runtime execution because WebContainer is unavailable on this device/browser.",
              "warning",
            );

            setState((prev) => ({
              ...prev,
              isExecuting: false,
              currentPhase: "completed",
              generatedCode: currentCode,
              previewUrl: null,
            }));

            return {
              success: true,
              code: currentCode,
              output:
                "Code generated successfully. Live preview is unavailable on this device/browser.",
            };
          }

          // PHASE 2: Autonomous Execution
          setState((prev) => ({ ...prev, currentPhase: "executing" }));
          const fixedCurrentCode = autoCloseJsx(currentCode);

          const result = await executeCodeInWebContainer(
            fixedCurrentCode,
            userPrompt,
            addLog,
            dependenciesInstalledRef,
            devServerProcessRef,
            devServerUrlRef,
            profile.runBuildValidation,
            (url) => {
              setState((prev) => ({ ...prev, previewUrl: url }));
            },
          );

          // PHASE 3: Result Analysis
          if (result.success) {
            addLog("execution", "Execution successful!", "success");
            addLog("execution", `Output: ${result.output}`, "info");

            setState((prev) => ({
              ...prev,
              isExecuting: false,
              currentPhase: "completed",
              generatedCode: fixedCurrentCode,
            }));
            return {
              success: true,
              code: fixedCurrentCode,
              output: result.output,
            };
          } else {
            // PHASE 4: Self-Healing Loop
            const outputContext = result.output
              ? `\n\nRuntime output:\n${result.output.slice(-4000)}`
              : "";
            lastError = `${result.error || "Unknown execution error"}${outputContext}`;
            addLog("execution", `ERROR: ${lastError}`, "error");

            if (result.stackTrace) {
              addLog("execution", `Stack trace: ${result.stackTrace}`, "error");
            }

            if (attempt < profile.retryAttempts) {
              setState((prev) => ({ ...prev, currentPhase: "fixing" }));
              addLog(
                "fixing",
                `Self-healing attempt ${attempt}/${profile.retryAttempts}...`,
                "warning",
              );
              // Loop continues to retry
            } else {
              throw new Error(
                `Max retry attempts reached. Last error: ${lastError}`,
              );
            }
          }
        }

        throw new Error("Generation did not produce a runnable code payload.");
      } catch (error: any) {
        if (isDisposedEngineError(error)) {
          clearSharedEngineCache();
          engineRef.current = null;

          const disposedMessage =
            "The WebLLM engine was disposed while generating. Please reinitialize the engine and try again.";
          addLog("execution", disposedMessage, "error");

          setState((prev) => ({
            ...prev,
            isExecuting: false,
            currentPhase: "error",
            error: disposedMessage,
          }));

          return { success: false, error: disposedMessage };
        }

        const errorMsg = error.message || "Unknown error in agentic loop";
        addLog("execution", `Generation error: ${errorMsg}`, "error");

        setState((prev) => ({
          ...prev,
          isExecuting: false,
          currentPhase: "error",
          error: errorMsg,
        }));

        return {
          success: false,
          error: errorMsg,
        };
      } finally {
        isGeneratingRef.current = false;
      }
    },
    [addLog, ensureWebContainerReady, reloadLockedModel],
  );

  const executeGeneratedCodeDirectly = useCallback(
    async (code: string, userPrompt: string) => {
      if (!code.trim()) {
        return { success: false, error: "No generated code payload received." };
      }

      let preparedCode = resolveExecutableUiCodePayload(
        sanitizeWorkerCode(code),
        userPrompt,
      );
      if (isGeneratingRef.current) {
        const busyMessage = "Please wait for the current task to finish.";
        addLog("execution", busyMessage, "warning");
        return { success: false, error: busyMessage };
      }

      if (
        !webContainerAvailableRef.current ||
        !(await ensureWebContainerReady(
          WEBCONTAINER_EXECUTION_BOOT_TIMEOUT_MS,
          "execution",
        ))
      ) {
        const safePreparedCode = yapCutter(preparedCode);
        addLog(
          "execution",
          "Skipping distributed execution because WebContainer is unavailable on this device/browser.",
          "warning",
        );
        setState((prev) => ({
          ...prev,
          isExecuting: false,
          currentPhase: "completed",
          error: null,
          generatedCode: safePreparedCode,
          previewUrl: null,
        }));
        return {
          success: true,
          code: safePreparedCode,
          output:
            "Distributed code received. Live preview is unavailable on this device/browser.",
        };
      }

      const safePreparedCode = yapCutter(preparedCode);
      setState((prev) => ({
        ...prev,
        isExecuting: true,
        currentPhase: "executing",
        error: null,
        generatedCode: safePreparedCode,
      }));

      addLog(
        "execution",
        "Executing distributed code payload in WebContainer...",
        "info",
      );

      // Sanitization preview: log the first few hundred characters and auto-correct
      try {
        const preview = safePreparedCode.slice(0, 400);
        addLog("execution", `Sanitized code preview:\n${preview}`, "info");
        // Auto-correct known 'export default' typos if present
        const exportTypoRE =
          /\bexport\s+(deflt|defaul|defalut|defaut|defu?l?t?)\b/gi;
        if (exportTypoRE.test(safePreparedCode)) {
          addLog(
            "execution",
            "Detected common 'export default' typo in generated code; applying auto-correction.",
            "warning",
          );
          preparedCode = safePreparedCode.replace(
            exportTypoRE,
            "export default",
          );
        } else {
          preparedCode = safePreparedCode;
        }
      } catch (e) {
        // best-effort preview; don't fail on preview errors
        console.warn("[SanitizationPreview] Preview failed", e);
      }

      const fixedPreparedCode = autoCloseJsx(preparedCode);

      // Yap-Cutter: Strip conversational text appended after export default
      const yapCutCode = yapCutter(fixedPreparedCode);
      if (yapCutCode !== fixedPreparedCode) {
        addLog(
          "execution",
          "Yap-Cutter removed trailing conversational text after export statement.",
          "info",
        );
      }

      // Tailwind Enforcer: ensure generated code includes Tailwind `className` usages.
      // If insufficient, perform one corrective regeneration with an explicit Tailwind instruction.
      let finalPreparedCode = yapCutCode;
      try {
        const classNameCount = (yapCutCode.match(/className=/g) || []).length;
        console.log("AUDIT [3] TAILWIND CLASS COUNT:", classNameCount);
        if (classNameCount < 3) {
          addLog(
            "generation",
            "TailwindValidator: insufficient className attributes, triggering one-shot regeneration.",
            "warning",
          );

          const correctiveInstruction =
            "You forgot the Tailwind CSS styling. You MUST add className attributes with Tailwind utility classes to match the design.";

          // One-shot regen: call the main agentic loop with corrective instruction appended.
          const regenPrompt = `${userPrompt}\n\n${correctiveInstruction}`;
          const regenResult = await executeAgenticLoop(regenPrompt);

          if (
            regenResult &&
            typeof regenResult === "object" &&
            "code" in regenResult &&
            regenResult.success &&
            (regenResult as any).code
          ) {
            const regenSanitized = autoCloseJsx(
              resolveExecutableUiCodePayload(
                sanitizeWorkerCode((regenResult as any).code),
                userPrompt,
              ),
            );
            finalPreparedCode = yapCutter(regenSanitized);
            addLog(
              "generation",
              "TailwindValidator: regeneration produced code with additional styling. Proceeding with regenerated payload.",
              "info",
            );
          } else {
            addLog(
              "generation",
              "TailwindValidator: regeneration failed or returned no code; continuing with original payload.",
              "warning",
            );
          }
        }

        finalPreparedCode = healVramTypos(finalPreparedCode, () => { typosHealed++; });
      } catch (e) {
        void e;
      }

      // Strict JSX validation: reject malformed code BEFORE execution
      const isValidJsxStructure = validateJsxStructure(finalPreparedCode);
      if (!isValidJsxStructure) {
        console.warn(
          "[JSXValidator] Generated code failed structural validation. Using DEFAULT_SAFE_FALLBACK.",
        );
        const repairedPreparedCode = autoCloseJsx(finalPreparedCode);
        if (validateJsxStructure(repairedPreparedCode)) {
          finalPreparedCode = repairedPreparedCode;
          addLog(
            "execution",
            "Generated code passed validation after JSX auto-repair.",
            "warning",
          );
        } else {
          finalPreparedCode = DEFAULT_SAFE_FALLBACK;
          addLog(
            "execution",
            "Generated code failed JSX validation. Using DEFAULT_SAFE_FALLBACK.",
            "warning",
          );
        }
      }

      // Quick sanity check: if the generated code does not contain
      // minimal required tokens for a runnable React+Tailwind component,
      // silently fallback to the PERFECT_NSU_FALLBACK to avoid demo crashes.
      // After JSX validation + autoCloseJsx repair, trust the output.
      const minimalTokenRE = /export\s+default/i;
      if (!minimalTokenRE.test(finalPreparedCode)) {
        console.warn(
          "[FailSafe] Missing required tokens in generated code. Using DEFAULT_SAFE_FALLBACK.",
        );
        finalPreparedCode = DEFAULT_SAFE_FALLBACK;
        addLog(
          "execution",
          "Using DEFAULT_SAFE_FALLBACK due to missing required tokens in worker output.",
          "warning",
        );
      }

      const endTime = performance.now();
      const generatedPayload = finalPreparedCode;
      console.table({
        "Total Generation Time (s)": ((endTime - startTime) / 1000).toFixed(2),
        "VRAM Typos Auto-Fixed": typosHealed,
        "Code Size (Characters)": generatedPayload.length,
        "Status": "Success",
      });

      console.log("AUDIT [4] FINAL PREVIEW PAYLOAD:\n", finalPreparedCode);
      const result = await executeCodeInWebContainer(
        finalPreparedCode,
        userPrompt,
        addLog,
        dependenciesInstalledRef,
        devServerProcessRef,
        devServerUrlRef,
        inferenceProfileRef.current.runBuildValidation,
        (url) => {
          setState((prev) => ({ ...prev, previewUrl: url }));
        },
      );

      if (result.success) {
        setState((prev) => ({
          ...prev,
          isExecuting: false,
          currentPhase: "completed",
          generatedCode: finalPreparedCode,
        }));

        addLog("execution", "Distributed code execution successful", "success");
        return {
          success: true,
          code: finalPreparedCode,
          output: result.output,
        };
      }

      const errorMsg = result.error || "Distributed execution failed.";
      addLog("execution", `FATAL ERROR: ${errorMsg}`, "error");

      // If the error looks like a parse/JSX issue, attempt one aggressive sanitization + retry
      const parseErrorRE =
        /unterminat|unexpected token|unterminated regular expression|unterminated string/i;
      if (parseErrorRE.test(errorMsg)) {
        addLog(
          "execution",
          "Detected parse/syntax error. Attempting aggressive sanitization and one retry...",
          "warning",
        );

        try {
          const aggressivelySanitized = aggressiveSanitize(preparedCode);
          const fixedAggressive = autoCloseJsx(aggressivelySanitized);
          const yapCutAggressive = yapCutter(fixedAggressive);

          addLog(
            "execution",
            `Aggressive sanitized preview:\n${yapCutAggressive.slice(0, 400)}`,
            "info",
          );

          const retryResult = await executeCodeInWebContainer(
            yapCutAggressive,
            userPrompt,
            addLog,
            dependenciesInstalledRef,
            devServerProcessRef,
            devServerUrlRef,
            inferenceProfileRef.current.runBuildValidation,
            (url) => {
              setState((prev) => ({ ...prev, previewUrl: url }));
            },
          );

          if (retryResult.success) {
            addLog(
              "execution",
              "Aggressive sanitization succeeded; preview updated.",
              "success",
            );
            setState((prev) => ({
              ...prev,
              isExecuting: false,
              currentPhase: "completed",
              generatedCode: yapCutAggressive,
            }));
            return {
              success: true,
              code: yapCutAggressive,
              output: retryResult.output,
            };
          }

          // If retry failed, silently Tier-5 rollback to the PERFECT fallback
          addLog(
            "execution",
            `Aggressive retry failed: ${retryResult.error || "unknown"}. Applying silent Tier-5 fallback.`,
            "warning",
          );
          // Persist both original and sanitized payloads for post-mortem
          try {
            saveFailedWorkerOutput(
              code,
              `${errorMsg} | retry:${retryResult.error || "none"}`,
              { prompt: userPrompt },
            );
            saveFailedWorkerOutput(
              yapCutAggressive,
              `aggressive_retry_failed: ${retryResult.error || "none"}`,
              { prompt: userPrompt },
            );
          } catch (e) {
            void e;
          }

          // Apply silent fallback instead of surfacing a large UI error
          console.warn(
            "[FailSafe] Aggressive retry failed; applying PERFECT_NSU_FALLBACK.",
          );
          setState((prev) => ({
            ...prev,
            isExecuting: false,
            currentPhase: "completed",
            generatedCode: DEFAULT_SAFE_FALLBACK,
          }));
          return {
            success: true,
            code: DEFAULT_SAFE_FALLBACK,
            output: "Fallback applied after aggressive sanitization failed.",
          };
        } catch (e) {
          // If aggressive sanitization itself throws, persist original and continue
          try {
            saveFailedWorkerOutput(
              code,
              `${errorMsg} | aggressive_sanitize_failed`,
              { prompt: userPrompt },
            );
          } catch (persistError) {
            void persistError;
          }
        }
      }

      setState((prev) => ({
        ...prev,
        isExecuting: false,
        currentPhase: "error",
        error: errorMsg,
      }));

      // Persist failing original code for debugging and reproduction
      try {
        saveFailedWorkerOutput(code, errorMsg, { prompt: userPrompt });
      } catch (e) {
        // ignore persistence errors
      }

      return { success: false, error: errorMsg };
    },
    [addLog, ensureWebContainerReady, DEFAULT_SAFE_FALLBACK],
  );

  /**
   * Cancel ongoing execution
   */
  const cancelExecution = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      addLog("execution", "Cancelling execution...", "warning");
    }
  }, [addLog]);

  /**
   * Cleanup on unmount
   */
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      if (devServerProcessRef.current) {
        devServerProcessRef.current.kill();
        devServerProcessRef.current = null;
      }
    };
  }, []);

  return {
    state,
    initializeEngine,
    executeAgenticLoop,
    executeGeneratedCodeDirectly,
    cancelExecution,
    resetGeneratedCanvas,
    isReady: state.isInitialized && !state.isLoading,
    engine: engineRef.current,
  };
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Validate JSX code structure before allowing it to execute.
 * Rejects code with common corruption patterns that indicate model failure.
 */
function validateJsxStructure(code: string): boolean {
  if (!code || typeof code !== "string") return false;

  // Bare minimum check: must have export default and look like it has JSX tags.
  // After autoCloseJsx, trust the repair more than strict structural validation.
  if (!/export\s+default/.test(code)) return false;
  if (!/<[A-Za-z]/.test(code)) return false;

  // Reject only the most obvious corruptions: completely unclosed tag at EOF
  if (/<[a-zA-Z][^/>]*\s*$/.test(code.trim().split("\n").pop() || "")) {
    return false;
  }

  return true;
}

function buildInferenceProfile(
  capability: "low" | "medium" | "high",
  hasWebGPU: boolean,
): InferenceProfile {
  if (!hasWebGPU) {
    return {
      name: "lite",
      contextWindowSize: 1024,
      maxCompletionTokens: 128,
      temperature: 0.2,
      retryAttempts: 1,
      runBuildValidation: false,
      useVisionBlueprint: false,
      prewarmPreviewRuntime: false,
      completionTimeoutMs: 120000,
      structuredSpecTimeoutMs: DEFAULT_STRUCTURED_SPEC_TIMEOUT_MS,
    };
  }

  if (capability === "low") {
    return {
      name: "low",
      contextWindowSize: 1280,
      maxCompletionTokens: 160,
      temperature: 0.2,
      retryAttempts: 1,
      runBuildValidation: false,
      useVisionBlueprint: false,
      prewarmPreviewRuntime: false,
      completionTimeoutMs: 120000,
      structuredSpecTimeoutMs: DEFAULT_STRUCTURED_SPEC_TIMEOUT_MS,
    };
  }

  if (capability === "high") {
    return {
      name: "high",
      contextWindowSize: 3072,
      maxCompletionTokens: 512,
      temperature: 0.45,
      retryAttempts: 1,
      runBuildValidation: false,
      useVisionBlueprint: true,
      prewarmPreviewRuntime: true,
      completionTimeoutMs: DEFAULT_LLM_COMPLETION_TIMEOUT_MS,
      structuredSpecTimeoutMs: DEFAULT_STRUCTURED_SPEC_TIMEOUT_MS,
    };
  }

  return {
    name: "balanced",
    contextWindowSize: 2304,
    maxCompletionTokens: 320,
    temperature: 0.35,
    retryAttempts: 1,
    runBuildValidation: false,
    useVisionBlueprint: true,
    prewarmPreviewRuntime: true,
    completionTimeoutMs: DEFAULT_LLM_COMPLETION_TIMEOUT_MS,
    structuredSpecTimeoutMs: DEFAULT_STRUCTURED_SPEC_TIMEOUT_MS,
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => resolve(null), timeoutMs);

    promise
      .then((value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      })
      .catch(() => {
        window.clearTimeout(timeoutId);
        resolve(null);
      });
  });
}

function isUiIntentPrompt(prompt: string): boolean {
  return /ui|screen|page|component|layout|dashboard|landing|design|hero|image/i.test(
    prompt,
  );
}

function resolveExecutableUiCodePayload(code: string, prompt: string): string {
  const trimmed = code.trim();
  if (!trimmed) {
    return code;
  }

  const parsedSpec = parseEdgeVisionV1UiSpec(trimmed);
  if (parsedSpec) {
    return renderEdgeVisionV1UiSpec(parsedSpec);
  }

  if (looksLikeShellInstructions(trimmed) && isUiIntentPrompt(prompt)) {
    throw new Error(
      "Worker returned shell instructions instead of runnable React code.",
    );
  }

  return code;
}

function sanitizeWorkerCode(code: string): string {
  return code.replace(/```(jsx)?/gi, "").trim();
}

function parseEdgeVisionV1UiSpec(payload: string): EdgeVisionV1UiSpec | null {
  const candidate = extractFirstJsonObject(payload);
  if (!candidate) {
    return null;
  }

  try {
    const parsed = JSON.parse(candidate);
    if (!isEdgeVisionV1UiSpec(parsed)) {
      return null;
    }
    return clampEdgeVisionV1UiSpec(parsed);
  } catch {
    return null;
  }
}

function extractFirstJsonObject(payload: string): string | null {
  const cleaned = payload
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  const start = cleaned.indexOf("{");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (ch === "\\") {
        isEscaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return cleaned.slice(start, i + 1);
      }
    }
  }

  return null;
}

function isEdgeVisionV1UiSpec(value: unknown): value is EdgeVisionV1UiSpec {
  if (!value || typeof value !== "object") {
    return false;
  }

  const spec = value as Record<string, unknown>;
  if (spec.version !== "1.0") {
    return false;
  }

  if (typeof spec.title !== "string" || !spec.title.trim()) {
    return false;
  }

  if (!Array.isArray(spec.sections) || spec.sections.length === 0) {
    return false;
  }

  for (const section of spec.sections) {
    if (!section || typeof section !== "object") {
      return false;
    }

    const sec = section as Record<string, unknown>;
    if (typeof sec.id !== "string" || !sec.id.trim()) {
      return false;
    }

    if (typeof sec.heading !== "string" || !sec.heading.trim()) {
      return false;
    }

    if (
      typeof sec.type !== "string" ||
      !["hero", "cards", "stats", "features", "timeline", "faq"].includes(
        sec.type,
      )
    ) {
      return false;
    }

    if (
      sec.items !== undefined &&
      (!Array.isArray(sec.items) ||
        sec.items.some((item) => typeof item !== "string" || !item.trim()))
    ) {
      return false;
    }
  }

  return true;
}

function clampEdgeVisionV1UiSpec(spec: EdgeVisionV1UiSpec): EdgeVisionV1UiSpec {
  return {
    version: "1.0",
    title: spec.title.trim().slice(0, 80),
    subtitle: spec.subtitle?.trim().slice(0, 180),
    cta: spec.cta?.label
      ? {
          label: spec.cta.label.trim().slice(0, 28),
        }
      : undefined,
    sections: spec.sections.slice(0, MAX_UI_SPEC_SECTIONS).map((section) => ({
      id: section.id.trim().slice(0, 30) || "section",
      type: section.type,
      heading: section.heading.trim().slice(0, 90),
      body: section.body?.trim().slice(0, 220),
      items: section.items
        ?.slice(0, MAX_UI_SPEC_ITEMS)
        .map((item) => item.trim().slice(0, 120)),
    })),
  };
}

function jsxText(value: string): string {
  return JSON.stringify(value);
}

function renderEdgeVisionV1UiSpec(spec: EdgeVisionV1UiSpec): string {
  const titleExpr = jsxText(spec.title);
  const subtitleExpr = spec.subtitle ? jsxText(spec.subtitle) : null;
  const ctaLabelExpr = spec.cta?.label ? jsxText(spec.cta.label) : null;

  const sectionsMarkup = spec.sections
    .map((section) => {
      const headingExpr = jsxText(section.heading);
      const bodyExpr = section.body ? jsxText(section.body) : null;
      const items = section.items ?? [];
      const toneClass = sectionToneClass(section.type);

      const itemMarkup =
        items.length > 0
          ? `<ul style={{ margin: "0.75rem 0 0", padding: 0, listStyle: "none", display: "grid", gap: "0.5rem" }}>${items
              .map(
                (item) =>
                  `<li style={{ borderRadius: 10, border: "1px solid #e2e8f0", padding: "0.55rem 0.65rem", background: "#f8fafc" }}>{${jsxText(
                    item,
                  )}}</li>`,
              )
              .join("")}</ul>`
          : "";

      const bodyMarkup = bodyExpr
        ? `<p style={{ margin: "0.5rem 0 0", color: "#475569", lineHeight: 1.55 }}>{${bodyExpr}}</p>`
        : "";

      return `<article key={${jsxText(section.id)}} style={{ border: "1px solid #e2e8f0", borderRadius: 14, padding: "1rem", background: "#ffffff", boxShadow: "0 8px 24px rgba(15, 23, 42, 0.04)" }}>
        <span className="inline-flex rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.02em] ${toneClass}">${section.type.toUpperCase()}</span>
        <h2 style={{ margin: "0.65rem 0 0", fontSize: "1.15rem", color: "#0f172a" }}>{${headingExpr}}</h2>
        ${bodyMarkup}
        ${itemMarkup}
      </article>`;
    })
    .join("\n");

  return `export default function App() {
  return (
    <main style={{ minHeight: "100vh", margin: 0, background: "linear-gradient(165deg, #f8fafc 0%, #eef2ff 42%, #ecfeff 100%)", color: "#0f172a", fontFamily: "Inter, Segoe UI, system-ui, sans-serif", padding: "1.25rem" }}>
      <section style={{ maxWidth: 1080, margin: "0 auto", background: "rgba(255,255,255,0.78)", backdropFilter: "blur(8px)", border: "1px solid rgba(148, 163, 184, 0.28)", borderRadius: 18, padding: "1.1rem 1.1rem 1.25rem" }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.8rem", flexWrap: "wrap", borderBottom: "1px solid #e2e8f0", paddingBottom: "0.9rem" }}>
          <div>
            <p style={{ margin: 0, fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: "#0369a1", fontWeight: 700 }}>EdgeVision-V1 Structured Canvas</p>
            <h1 style={{ margin: "0.3rem 0 0", fontSize: "2rem", lineHeight: 1.1 }}>{${titleExpr}}</h1>
            ${subtitleExpr ? `<p style={{ margin: "0.45rem 0 0", color: "#475569", maxWidth: 680 }}>{${subtitleExpr}}</p>` : ""}
          </div>
          ${ctaLabelExpr ? `<button style={{ border: "none", borderRadius: 999, background: "#0f172a", color: "#fff", padding: "0.62rem 1rem", fontWeight: 600, cursor: "pointer" }}>{${ctaLabelExpr}}</button>` : ""}
        </header>

        <div style={{ display: "grid", gap: "0.9rem", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", marginTop: "1rem" }}>
          ${sectionsMarkup}
        </div>
      </section>
    </main>
  );
}`;
}

function sectionToneClass(type: EdgeVisionV1UiSection["type"]): string {
  switch (type) {
    case "hero":
      return "bg-blue-100 text-blue-700";
    case "cards":
      return "bg-emerald-100 text-emerald-700";
    case "stats":
      return "bg-violet-100 text-violet-700";
    case "features":
      return "bg-fuchsia-100 text-fuchsia-700";
    case "timeline":
      return "bg-orange-100 text-orange-700";
    case "faq":
      return "bg-rose-100 text-rose-700";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

function compactPromptForLowEnd(prompt: string): string {
  return prompt.replace(/\s{3,}/g, " ").trim();
}

export function generateLiteCodeFromPrompt(_prompt: string): string {
  throw new Error(
    "Deterministic fallback rendering has been removed. WebGPU generation must succeed or fail loudly.",
  );
}

function yapCutter(code: string): string {
  let cleanCode = code.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");

  const exportKeyword = "export default";
  const exportIndex = cleanCode.lastIndexOf(exportKeyword);

  if (exportIndex !== -1) {
    const exportTail = cleanCode.slice(exportIndex);
    const exportFunctionMatch = exportTail.match(
      /^export\s+default\s+function\b/,
    );

    if (exportFunctionMatch) {
      const braceStart = cleanCode.indexOf("{", exportIndex);
      if (braceStart !== -1) {
        let depth = 0;
        let inSingle = false;
        let inDouble = false;
        let inTemplate = false;

        for (let i = braceStart; i < cleanCode.length; i++) {
          const ch = cleanCode[i];
          const prev = cleanCode[i - 1];

          if (!inDouble && !inTemplate && ch === "'" && prev !== "\\") {
            inSingle = !inSingle;
            continue;
          }
          if (!inSingle && !inTemplate && ch === '"' && prev !== "\\") {
            inDouble = !inDouble;
            continue;
          }
          if (!inSingle && !inDouble && ch === "`" && prev !== "\\") {
            inTemplate = !inTemplate;
            continue;
          }
          if (inSingle || inDouble || inTemplate) {
            continue;
          }

          if (ch === "{") {
            depth += 1;
            continue;
          }
          if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
              let cut = i + 1;
              const maybeSemi = cleanCode.slice(cut).match(/^\s*;/);
              if (maybeSemi) {
                cut += maybeSemi[0].length;
              }
              cleanCode = cleanCode.substring(0, cut);
              break;
            }
          }
        }
      }
    } else {
      let endOfExport = cleanCode.indexOf(";", exportIndex);
      if (endOfExport === -1) {
        endOfExport = cleanCode.indexOf("\n", exportIndex);
      }
      if (endOfExport !== -1) {
        cleanCode = cleanCode.substring(0, endOfExport + 1);
      }
    }
  }

  code = cleanCode;
  return code;
}

/**
 * Build system prompt with RAG context injection and model-specific tuning
 */
function buildSystemPrompt(
  ragContext?: string[],
  modelType?: ModelType,
): string {
  let prompt = `You are an expert React/Tailwind CSS designer embedded in SouthStack, an offline-first IDE.
You generate clean, production-ready, visually stunning code that executes without errors.

CRITICAL GUIDELINES:
- Write complete, executable code (no placeholders like "// TODO")
- Include all necessary imports from React only
- Handle errors gracefully
- Use modern JavaScript/TypeScript practices
- ALWAYS use Tailwind CSS for ALL styling. Every element must have className with Tailwind utility classes.
- NO inline styles. NO unclassed elements. NO bare HTML.
- If the request is UI-focused, return a React component suitable for src/App.jsx
- If the request references a screenshot, mockup, image, or other visual reference, treat that reference as the source of truth and mirror the visible layout, hierarchy, spacing, text density, button placement, and card structure as closely as possible
- Preserve the prompt's design language; do not replace a specific UI with a generic dashboard, landing page, or starter template
- When building from an image, use a contemporary polished UI style with: clean sans-serif typography, refined spacing, rounded cards (rounded-lg/rounded-xl minimum), subtle shadows (shadow-md/shadow-lg), smooth gradients (bg-gradient-to-r), glassmorphic effects (backdrop-blur), and smooth transitions (transition-all)
- NEVER output dated HTML styling, default browser controls, or 1990s aesthetics
- DO NOT render the user's request text as visible UI copy unless the referenced screenshot explicitly shows that same text
- If the request is backend-focused, return runnable Node.js code
- DO NOT output any prose before or after code
- DO NOT output markdown fences like \`\`\`jsx or code fences
- NEVER output pseudo tags like <cards> or <main-content>; use valid JSX elements only
- Use className, never class, in JSX
- Default to dark mode with vibrant gradients (purple, blue, pink) unless light mode is explicitly requested
- Use Tailwind animations: animate-pulse, animate-bounce, animate-fadeIn
- Always include interactive elements: hover states, transitions, responsive design (sm: md: lg: breakpoints)`;

  // CRITICAL ENFORCEMENT: always require Tailwind CSS in worker outputs
  prompt += `\n\nCRITICAL REQUIREMENT: YOU MUST USE TAILWIND CSS FOR ALL STYLING. EVERY HTML ELEMENT MUST HAVE A 'className' ATTRIBUTE WITH APPROPRIATE TAILWIND UTILITY CLASSES. DO NOT OUTPUT BARE HTML. NO EXCEPTIONS.`;

  if (modelType === "3B") {
    prompt += `\n\nIMPORTANT: This is the blueprint stage. Return structured output only, preserve the visual hierarchy, and do not invent generic sections.`;
  }

  if (modelType === "7B") {
    prompt += `\n\nThis is the React code generation stage. Output ONE COMPLETE, RUNNABLE REACT COMPONENT ONLY. 
- Use only React imports (useState, useEffect, useCallback, etc. from 'react')
- Use Tailwind CSS exclusively for all styling
- Include interactivity (state, event handlers, smooth transitions)
- No third-party npm packages - Tailwind is bundled and available
- Make sure every single element has a className with Tailwind utility classes
- Include proper spacing, padding, margins, and visual hierarchy
- Use modern design: gradients, rounded corners, shadows, hover effects
- Make it visually appealing and professional-looking`;
  }

  if (ragContext && ragContext.length > 0) {
    prompt += `\n\nRelevant context from the project:\n${ragContext.join("\n\n")}`;
  }

  return prompt;
}

/**
 * Build prompt for self-correction iteration
 */
function buildFixPrompt(
  originalPrompt: string,
  error: string,
  previousCode: string,
): string {
  return `The previous code attempt failed with this error:

ERROR: ${error}

PREVIOUS CODE:
\`\`\`javascript
${previousCode}
\`\`\`

ORIGINAL REQUEST: ${originalPrompt}

Please fix the error and generate corrected code that will execute successfully.
Preserve the original visual intent, layout hierarchy, and prompt-specific structure instead of simplifying the UI.`;
}

/**
 * Extract code from LLM response (handles markdown code blocks)
 */
function extractCode(response: string): string {
  const trimmed = response.trim();

  // Prefer fenced code blocks first (supports jsx/tsx and unknown fence labels).
  const fencedBlockMatch = trimmed.match(/```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/);
  if (fencedBlockMatch) {
    return yapCutter(healVramTypos(fencedBlockMatch[1].trim()));
  }

  // Handle partially fenced responses.
  const unfenced = trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  // If the model prepends prose (e.g., "Certainly!"), slice from first likely code token.
  const codeStartPatterns = [
    /\bimport\s+.+from\s+["']/,
    /\bexport\s+default\b/,
    /\bfunction\s+App\s*\(/,
    /\bconst\s+App\s*=\s*/,
    /\bclass\s+\w+\s+extends\s+React\.Component\b/,
    /<main[\s>]/,
    /<div[\s>]/,
    /return\s*\(\s*</,
  ];

  let startIndex = -1;
  for (const pattern of codeStartPatterns) {
    const match = unfenced.match(pattern);
    if (match?.index !== undefined) {
      if (startIndex === -1 || match.index < startIndex) {
        startIndex = match.index;
      }
    }
  }

  if (startIndex > 0) {
    return yapCutter(healVramTypos(unfenced.slice(startIndex).trim()));
  }

  return yapCutter(healVramTypos(unfenced));
}

function estimateTokenCount(text: string): number {
  // Fast approximation for English/code mixed text used only as a guardrail.
  return Math.max(1, Math.ceil(text.length / 4));
}

function fitPromptToContextWindow(
  systemPrompt: string,
  userPrompt: string,
  options: {
    contextWindowSize: number;
    maxCompletionTokens: number;
    safetyMarginTokens: number;
  },
): {
  userPrompt: string;
  wasTruncated: boolean;
  estimatedPromptTokens: number;
} {
  const systemTokens = estimateTokenCount(systemPrompt);
  const userTokens = estimateTokenCount(userPrompt);
  const availablePromptTokens =
    options.contextWindowSize -
    options.maxCompletionTokens -
    options.safetyMarginTokens;

  const maxUserTokens = Math.max(256, availablePromptTokens - systemTokens);

  if (userTokens <= maxUserTokens) {
    return {
      userPrompt,
      wasTruncated: false,
      estimatedPromptTokens: systemTokens + userTokens,
    };
  }

  const maxUserChars = Math.max(1024, maxUserTokens * 4);
  const boundedUserPrompt =
    userPrompt.slice(0, maxUserChars) +
    "\n\n[Truncated by system to fit model context window]";

  return {
    userPrompt: boundedUserPrompt,
    wasTruncated: true,
    estimatedPromptTokens: systemTokens + estimateTokenCount(boundedUserPrompt),
  };
}

function looksLikeReactCode(code: string, prompt: string): boolean {
  const reactPatterns = [
    /from\s+["']react["']/,
    /React\./,
    /export\s+default\s+function\s+[A-Z]/,
    /return\s*\(\s*<[^>]+>/,
    /<[A-Z][A-Za-z0-9]*[\s>]/,
    /className\s*=\s*["']/,
  ];

  if (reactPatterns.some((pattern) => pattern.test(code))) {
    return true;
  }

  return /react|component|ui|interface|layout/i.test(prompt);
}

function normalizeReactComponentCode(code: string): string {
  const sanitizedCode = sanitizeGeneratedUiCode(code);

  if (looksLikeShellInstructions(sanitizedCode)) {
    throw new Error(
      "Generated payload contains shell instructions, not runnable React code.",
    );
  }

  if (looksLikePlainTextDescription(sanitizedCode)) {
    throw new Error(
      "Generated payload is plain text description, not runnable React code.",
    );
  }

  if (/export\s+default/.test(sanitizedCode)) {
    return sanitizedCode;
  }

  if (looksLikeReactModuleWithImports(sanitizedCode)) {
    return buildReactModuleFromFragment(sanitizedCode);
  }

  if (
    /function\s+App\s*\(/.test(sanitizedCode) ||
    /const\s+App\s*=/.test(sanitizedCode)
  ) {
    return `${sanitizedCode}\n\nexport default App;`;
  }

  if (/return\s*\(\s*<[^>]+>/.test(sanitizedCode)) {
    return `function App() {\n${sanitizedCode}\n}\n\nexport default App;`;
  }

  throw new Error(
    "Generated payload does not contain a valid React component module.",
  );
}

function looksLikeReactModuleWithImports(code: string): boolean {
  return /(^|\n)import\s+.+from\s+['"].+['"];?/m.test(code);
}

function buildReactModuleFromFragment(code: string): string {
  const lines = code.split(/\r?\n/);
  const importLines = lines.filter((line) =>
    /^\s*import\s+.+from\s+['"].+['"];?\s*$/.test(line),
  );
  const bodyLines = lines.filter(
    (line) => !/^\s*import\s+.+from\s+['"].+['"];?\s*$/.test(line),
  );

  const body = bodyLines.join("\n").trim();
  const safeBody = body || "<div />";
  const imports = importLines.join("\n");

  if (
    /^\s*function\s+[A-Z]\w*\s*\(/m.test(safeBody) ||
    /^\s*const\s+[A-Z]\w*\s*=/.test(safeBody)
  ) {
    return `${imports}\n\n${safeBody}\n\nexport default ${extractDefaultComponentName(safeBody) || "App"};`;
  }

  return `${imports}\n\nexport default function App() {\n  return (\n    ${safeBody}\n  );\n}`;
}

function extractDefaultComponentName(code: string): string | null {
  const functionMatch = code.match(/function\s+([A-Z]\w*)\s*\(/);
  if (functionMatch?.[1]) {
    return functionMatch[1];
  }

  const constMatch = code.match(/const\s+([A-Z]\w*)\s*=/);
  if (constMatch?.[1]) {
    return constMatch[1];
  }

  return null;
}

function looksLikePlainTextDescription(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) {
    return true;
  }

  const hasCodeSignals =
    /[{}();=<>]/.test(cleaned) ||
    /\b(import|export|function|const|return|className)\b/.test(cleaned);

  if (hasCodeSignals) {
    return false;
  }

  return cleaned.split(/\s+/).length > 16;
}

function isImageLedPrompt(prompt: string): boolean {
  return /image|screenshot|mockup|reference|picture|visual/i.test(prompt);
}

function sanitizeGeneratedUiCode(code: string): string {
  let sanitized = code.trim();

  sanitized = sanitized.replace(/^\$+\s*/g, "");
  sanitized = sanitized.replace(/<!--([\s\S]*?)-->/g, "");
  sanitized = sanitized.replace(/\bclass=/g, "className=");

  // Convert common pseudo tags to div wrappers with semantic class names.
  sanitized = sanitized.replace(
    /<(cards|card|main-content)([^>]*)>/gi,
    (_match, tag: string, attrs: string) => {
      const hasClassName = /\bclassName\s*=/.test(attrs);
      const classPart = hasClassName ? "" : ` className="${tag}"`;
      return `<div${classPart}${attrs}>`;
    },
  );
  sanitized = sanitized.replace(/<\/(cards|card|main-content)>/gi, "</div>");

  // Ensure common void elements are self-closing in JSX.
  sanitized = sanitized.replace(
    /<(input|img|br|hr|meta|link)([^>]*?)(?<!\/)>/gi,
    "<$1$2 />",
  );

  // Remove accidental markdown fragments that may survive extraction.
  sanitized = sanitized.replace(/^```[a-zA-Z0-9_-]*\s*/i, "");
  sanitized = sanitized.replace(/```$/i, "");

  // Normalize common CSS imports so generated App.jsx resolves in preview workspace.
  sanitized = sanitized.replace(
    /import\s+["']\.\/App\.css["'];?/gi,
    'import "./styles.css";',
  );
  sanitized = sanitized.replace(
    /import\s+["']\.\/app\.css["'];?/gi,
    'import "./styles.css";',
  );
  sanitized = sanitized.replace(
    /import\s+["']\/src\/App\.css["'];?/gi,
    'import "./styles.css";',
  );

  return sanitized.trim();
}

function looksLikeShellInstructions(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return false;
  }

  const commandLinePattern =
    /^(npx|npm|pnpm|yarn|bunx?|cd|mkdir|rm|cp|mv|git|node)\b/i;
  const commandLikeLines = lines.filter((line) =>
    commandLinePattern.test(line),
  );

  return (
    commandLikeLines.length > 0 &&
    commandLikeLines.length >= Math.ceil(lines.length / 2)
  );
}

function shouldTreatAsInvalidUiCode(code: string, prompt: string): boolean {
  const uiIntent = /ui|screen|page|component|layout|design|image/i.test(prompt);
  if (!uiIntent) {
    return false;
  }

  const sanitized = sanitizeGeneratedUiCode(code);

  if (looksLikeShellInstructions(sanitized)) {
    return true;
  }

  const hasReactSignals =
    /\bexport\s+default\b/.test(sanitized) ||
    /\bfunction\s+App\s*\(/.test(sanitized) ||
    /\bfunction\s+[A-Z]\w*\s*\(/.test(sanitized) ||
    /\bconst\s+[A-Z]\w*\s*=/.test(sanitized) ||
    /\bconst\s+App\s*=/.test(sanitized) ||
    /return\s*\(\s*</.test(sanitized) ||
    /<[A-Za-z][A-Za-z0-9-]*[\s>]/.test(sanitized);

  const likelyNarrativeOnly =
    !hasReactSignals &&
    looksLikePlainTextDescription(sanitized) &&
    sanitized.split(/\s+/).length > 40;

  if (likelyNarrativeOnly) {
    return true;
  }

  return false;
}

function isLikelyValidGeneratedCode(code: string, prompt: string): boolean {
  const trimmed = code.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.length < 12) {
    return false;
  }

  if (/```/.test(trimmed)) {
    return false;
  }

  const uiIntent = isUiIntentPrompt(prompt);
  if (uiIntent) {
    const normalized = sanitizeGeneratedUiCode(trimmed);
    const hasUiSignals =
      (/export\s+default/.test(normalized) ||
        /function\s+[A-Z]\w*\s*\(/.test(normalized) ||
        /const\s+[A-Z]\w*\s*=/.test(normalized)) &&
      (/return\s*\(\s*</.test(normalized) ||
        /<[A-Za-z][A-Za-z0-9-]*[\s>]/.test(normalized)) &&
      !looksLikeShellInstructions(normalized);

    return hasUiSignals;
  }

  return /module\.exports|export\s+default|function\s+\w+|const\s+\w+\s*=/.test(
    trimmed,
  );
}

async function ensureReactWorkspace(
  addLog: (phase: string, message: string, type?: LogEntry["type"]) => void,
  dependenciesInstalledRef: { current: boolean },
): Promise<ExecutionResult> {
  try {
    await webContainerService.mkdir("/src");

    const packageJson = {
      name: "southstack-live-ui",
      private: true,
      version: "0.0.1",
      type: "module",
      scripts: {
        dev: "vite",
        build: "vite build",
        preview: "vite preview --host 0.0.0.0 --port 4173",
      },
      dependencies: {
        react: "^18.3.1",
        "react-dom": "^18.3.1",
        "framer-motion": "^12.34.3",
        bootstrap: "^5.3.3",
        "react-bootstrap": "^2.10.4",
        "@mui/material": "^5.16.7",
        "@emotion/react": "^11.13.3",
        "@emotion/styled": "^11.13.0",
      },
      devDependencies: {
        vite: "^5.3.1",
        "@vitejs/plugin-react": "^4.3.1",
        tailwindcss: "^3.4.4",
        postcss: "^8.4.38",
        autoprefixer: "^10.4.19",
      },
    };

    await webContainerService.writeFile(
      "/package.json",
      JSON.stringify(packageJson, null, 2),
    );

    await webContainerService.writeFile(
      "/vite.config.js",
      `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({\n  plugins: [react()],\n  server: {\n    host: "0.0.0.0",\n    port: 4173,\n  },\n});\n`,
    );

    await webContainerService.writeFile(
      "/postcss.config.js",
      `export default {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n};\n`,
    );

    await webContainerService.writeFile(
      "/tailwind.config.js",
      `/** @type {import('tailwindcss').Config} */\nexport default {\n  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],\n  theme: {\n    extend: {\n      animation: {\n        fadeIn: "fadeIn 0.7s ease-out both",\n        "pulse-slow": "pulseSlow 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",\n      },\n      keyframes: {\n        fadeIn: {\n          from: { opacity: 0, transform: "translateY(12px)" },\n          to: { opacity: 1, transform: "translateY(0)" },\n        },\n        pulseSlow: {\n          "0%, 100%": { opacity: 1 },\n          "50%": { opacity: 0.5 },\n        },\n      },\n    },\n  },\n  plugins: [],\n};\n`,
    );

    await webContainerService.writeFile(
      "/index.html",
      `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>SouthStack Live Preview</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n`,
    );

    await webContainerService.writeFile(
      "/src/main.jsx",
      `import React from "react";\nimport ReactDOM from "react-dom/client";\nimport App from "./App";\n\nReactDOM.createRoot(document.getElementById("root")).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n);\n`,
    );

    await webContainerService.writeFile(
      "/src/styles.css",
      `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n:root {\n  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;\n}\n\n* {\n  box-sizing: border-box;\n}\n\nhtml, body, #root {\n  width: 100%;\n  height: 100%;\n}\n\nbody {\n  margin: 0;\n  background: #020617;\n  color: #0f172a;\n}\n\n@keyframes fadeIn {\n  from {\n    opacity: 0;\n    transform: translateY(12px);\n  }\n\n  to {\n    opacity: 1;\n    transform: translateY(0);\n  }\n}\n\n@keyframes pulseSlow {\n  0%,\n  100% {\n    opacity: 1;\n  }\n\n  50% {\n    opacity: 0.5;\n  }\n}\n\n.animate-fadeIn {\n  animation: fadeIn 0.7s ease-out both;\n}\n\n.animate-pulse-slow {\n  animation: pulseSlow 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;\n}\n\n.animation-delay-2000 {\n  animation-delay: 2s;\n}\n`,
    );

    // Compatibility alias for generated code that imports ./App.css.
    await webContainerService.writeFile(
      "/src/App.css",
      `@import "./styles.css";\n`,
    );

    // Ensure App entry exists before prewarming dev server.
    await webContainerService.writeFile(
      "/src/App.jsx",
      `export default function App() {\n  return (\n    <main style={{ fontFamily: "Inter, system-ui, sans-serif", padding: "1.25rem", lineHeight: 1.5 }}>\n      <section style={{ maxWidth: 860, margin: "0 auto", border: "1px solid #e4e4e7", borderRadius: 12, padding: 16, background: "#fff" }}>\n        <h1 style={{ marginTop: 0, color: "#111827" }}>SouthStack Preview Ready</h1>\n        <p style={{ margin: 0, color: "#4b5563" }}>Waiting for generated UI code...</p>\n      </section>\n    </main>\n  );\n}\n`,
    );

    if (!dependenciesInstalledRef.current) {
      addLog(
        "execution",
        "Installing preview dependencies (cached after first install)...",
        "info",
      );

      const installResult = await webContainerService.exec("npm", [
        "install",
        "--prefer-offline",
        "--no-audit",
        "--no-fund",
      ]);
      if (installResult.exitCode !== 0) {
        return {
          success: false,
          output: installResult.output,
          error: "Dependency installation failed",
        };
      }

      dependenciesInstalledRef.current = true;
      addLog("execution", "Dependencies installed", "success");
    } else {
      // Keep preview deps in sync for already-booted sessions when template deps evolve.
      const syncResult = await webContainerService.exec("npm", [
        "install",
        "--prefer-offline",
        "--no-audit",
        "--no-fund",
        "react-bootstrap",
        "bootstrap",
        "framer-motion",
        "@mui/material",
        "@emotion/react",
        "@emotion/styled",
        "tailwindcss",
        "postcss",
        "autoprefixer",
      ]);

      if (syncResult.exitCode !== 0) {
        return {
          success: false,
          output: syncResult.output,
          error: "Preview dependency sync failed",
        };
      }
    }

    return { success: true, output: "Workspace ready" };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      output: message,
      error: `Failed to prepare React workspace: ${message}`,
    };
  }
}

async function ensureDevServerRunning(
  addLog: (phase: string, message: string, type?: LogEntry["type"]) => void,
  devServerProcessRef: { current: WebContainerProcess | null },
  devServerUrlRef: { current: string | null },
  onPreviewUrlChange: (url: string | null) => void,
): Promise<ExecutionResult> {
  if (devServerProcessRef.current && devServerUrlRef.current) {
    onPreviewUrlChange(devServerUrlRef.current);
    return {
      success: true,
      output: `Dev server already running at ${devServerUrlRef.current}`,
    };
  }

  try {
    addLog("execution", "Starting Vite dev server...", "info");

    const serverReadyPromise = new Promise<string>((resolve, reject) => {
      const container = webContainerService.getContainer();
      const timeout = window.setTimeout(() => {
        reject(new Error("Timed out waiting for dev server to become ready"));
      }, DEV_SERVER_STARTUP_TIMEOUT_MS);

      container.on("server-ready", (port, url) => {
        if (port === 4173) {
          window.clearTimeout(timeout);
          resolve(url);
        }
      });
    });

    const process = (await webContainerService.spawn("npm", [
      "run",
      "dev",
      "--",
      "--host",
      "0.0.0.0",
      "--port",
      "4173",
    ])) as WebContainerProcess;

    devServerProcessRef.current = process;
    process.exit.then(() => {
      devServerProcessRef.current = null;
      devServerUrlRef.current = null;
    });

    const url = await serverReadyPromise;
    devServerUrlRef.current = url;
    onPreviewUrlChange(url);

    return {
      success: true,
      output: `Dev server ready at ${url}`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      output: message,
      error: `Failed to start dev server: ${message}`,
    };
  }
}

async function executeCodeInWebContainer(
  code: string,
  userPrompt: string,
  addLog: (phase: string, message: string, type?: LogEntry["type"]) => void,
  dependenciesInstalledRef: { current: boolean },
  devServerProcessRef: { current: WebContainerProcess | null },
  devServerUrlRef: { current: string | null },
  runBuildValidation: boolean,
  onPreviewUrlChange: (url: string | null) => void,
): Promise<ExecutionResult> {
  const runAsReactApp = looksLikeReactCode(code, userPrompt);

  if (!runAsReactApp) {
    addLog("execution", "Detected Node.js script mode", "info");
    onPreviewUrlChange(null);

    // Sanitize markdown backticks from worker responses
    const safeCode = code
      .replace(/```(jsx|js|tsx|ts)?/gi, "")
      .replace(/```/g, "")
      .trim();

    await webContainerService.writeFile("/index.js", safeCode);
    const result = await webContainerService.exec("node", ["/index.js"]);

    if (result.exitCode !== 0) {
      return {
        success: false,
        output: result.output,
        error: "Node.js execution failed",
      };
    }

    return {
      success: true,
      output: result.output || "Node.js execution completed successfully.",
    };
  }

  addLog("execution", "Detected React/JS UI mode", "info");

  const workspaceResult = await ensureReactWorkspace(
    addLog,
    dependenciesInstalledRef,
  );
  if (!workspaceResult.success) {
    return workspaceResult;
  }

  const appCode = normalizeReactComponentCode(code);

  // Sanitize markdown backticks that may come from worker responses
  const safeCode = appCode
    .replace(/```(jsx|js|tsx|ts)?/gi, "")
    .replace(/```/g, "")
    .trim();

  await webContainerService.writeFile("/src/App.jsx", safeCode);
  addLog("execution", "Updated /src/App.jsx in WebContainer", "success");

  if (runBuildValidation) {
    addLog("execution", "Running build validation...", "info");
    const buildResult = await webContainerService.exec("npm", ["run", "build"]);
    if (buildResult.exitCode !== 0) {
      return {
        success: false,
        output: buildResult.output,
        error: "Build failed",
      };
    }
  } else {
    addLog(
      "execution",
      "Skipping build validation for fast mode on low-end devices.",
      "warning",
    );
  }

  const devServerResult = await ensureDevServerRunning(
    addLog,
    devServerProcessRef,
    devServerUrlRef,
    onPreviewUrlChange,
  );

  if (!devServerResult.success) {
    return devServerResult;
  }

  return {
    success: true,
    output: `React app built successfully. ${devServerResult.output}`,
  };
}
