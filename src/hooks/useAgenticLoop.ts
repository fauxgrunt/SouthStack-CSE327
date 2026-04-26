import { useState, useCallback, useRef, useEffect } from "react";
import * as webllm from "@mlc-ai/web-llm";
import { detectDeviceCapability, limitArraySize } from "../utils/performance";
import { webContainerService } from "../services/webcontainer";

// Model Configuration - worker-first preference for stronger code generation
export type ModelType = "1.5B" | "3B" | "0.5B";

// Maximum number of logs to keep in memory (prevent memory leaks)
const MAX_LOG_ENTRIES = 500;

export const MODEL_CONFIGS = {
  "1.5B": {
    id: "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC",
    label: "Worker Preferred (1.5B)",
    description: "Balanced quality for distributed worker generation",
    minStorage: 1.6 * 1024 * 1024 * 1024,
  },
  "3B": {
    id: "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC",
    label: "Worker Fallback (3B)",
    description: "Higher quality fallback when available",
    minStorage: 3.2 * 1024 * 1024 * 1024,
  },
  "0.5B": {
    id: "Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC",
    label: "Emergency Fallback (0.5B)",
    description: "Last-resort lightweight fallback model",
    minStorage: 600 * 1024 * 1024, // 600MB
  },
};

const WORKER_MODEL_PREFERENCE: ModelType[] = ["1.5B", "3B", "0.5B"];

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
}

interface GeminiLikeUiSpec {
  version: "1.0";
  title: string;
  subtitle?: string;
  sections: GeminiLikeUiSection[];
  cta?: {
    label: string;
  };
}

interface GeminiLikeUiSection {
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
const STRUCTURED_SPEC_TIMEOUT_MS = 1500;
const LLM_COMPLETION_TIMEOUT_MS = 25000;
const PREWARM_BOOT_TIMEOUT_MS = 45000;
const MAX_UI_SPEC_SECTIONS = 8;
const MAX_UI_SPEC_ITEMS = 6;
const GENERIC_TEMPLATE_MARKERS = [
  "visual fidelity target",
  "prompt-aligned layout",
  "fast reference-based preview while full generation completes.",
  "generated ui",
  "overview",
  "detail panel",
  "recent activity",
];
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
    selectedModel: "1.5B",
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
  const previewRuntimePreparingRef = useRef(false);
  const inferenceProfileRef = useRef<InferenceProfile>(
    buildInferenceProfile("medium", true),
  );
  const liteModeRef = useRef(false);
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
            "Low storage detected. 0.5B model requires ~600MB.",
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

  // Model change functionality removed - 0.5B is the only available model

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

      const isLowEndRuntime = !hasWebGPU;

      addLog(
        "initialization",
        `Performance profile: ${inferenceProfileRef.current.name}`,
        "info",
      );

      // Warm runtime asynchronously so engine readiness is not blocked by WebContainer boot.
      addLog("initialization", "Warming WebContainer in background...", "info");
      void ensureWebContainerReady(WEBCONTAINER_WARMUP_TIMEOUT_MS, "warmup");

      if (isLowEndRuntime) {
        liteModeRef.current = true;
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

      // Load preferred worker model with fallback chain (1.5B -> 3B -> 0.5B)
      let loadedModelType: ModelType | null = null;
      let lastLoadError: unknown = null;

      for (const modelType of WORKER_MODEL_PREFERENCE) {
        const modelConfig = MODEL_CONFIGS[modelType];
        addLog(
          "initialization",
          `Attempting model: ${modelConfig.label}`,
          "info",
        );

        try {
          await engine.reload(modelConfig.id, {
            context_window_size: inferenceProfileRef.current.contextWindowSize,
          });
          loadedModelType = modelType;
          setState((prev) => ({ ...prev, selectedModel: modelType }));
          break;
        } catch (loadError: unknown) {
          lastLoadError = loadError;
          const message =
            loadError instanceof Error ? loadError.message : String(loadError);
          addLog(
            "initialization",
            `Model ${modelConfig.label} unavailable: ${message}. Trying fallback...`,
            "warning",
          );
        }
      }

      if (!loadedModelType) {
        const message =
          lastLoadError instanceof Error
            ? lastLoadError.message
            : String(lastLoadError || "Unknown model load error");
        throw new Error(
          `All worker model candidates failed to load. ${message}`,
        );
      }

      addLog(
        "initialization",
        `Worker engine ready with ${MODEL_CONFIGS[loadedModelType].label}.`,
        "success",
      );
      setState((prev) => ({
        ...prev,
        isInitialized: true,
        isLoading: false,
        initProgress: 100,
      }));

      // Pre-install preview runtime in background to reduce first-generation latency.
      void prewarmPreviewRuntime();
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

          const systemPrompt = buildSystemPrompt(
            ragContext,
            state.selectedModel,
          );
          const userMessage =
            attempt === 1
              ? userPrompt
              : buildFixPrompt(userPrompt, lastError!, currentCode!);

          const compactUserMessage = compactPromptForLowEnd(userMessage);

          const {
            userPrompt: boundedUserMessage,
            wasTruncated,
            estimatedPromptTokens,
          } = fitPromptToContextWindow(systemPrompt, compactUserMessage, {
            contextWindowSize: profile.contextWindowSize,
            maxCompletionTokens: profile.maxCompletionTokens,
            safetyMarginTokens: WEBLLM_CONTEXT_SAFETY_MARGIN,
          });

          if (wasTruncated) {
            addLog(
              "generation",
              `[Warning] Prompt truncated to fit context window. (~${estimatedPromptTokens} prompt tokens)`,
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

          try {
            if (!engineRef.current || liteModeRef.current) {
              throw new Error(
                "WebLLM engine unavailable for generation. Ensure a WebGPU-capable worker is initialized.",
              );
            }

            {
              const uiIntent = isUiIntentPrompt(boundedUserMessage);

              if (attempt === 1 && uiIntent && profile.name !== "low") {
                currentCode = await withTimeout(
                  generateUiCodeFromStructuredSpec(
                    engineRef.current,
                    boundedUserMessage,
                    profile.maxCompletionTokens,
                  ),
                  STRUCTURED_SPEC_TIMEOUT_MS,
                );

                if (currentCode) {
                  addLog(
                    "generation",
                    "Structured UI architecture engaged: spec compiled to deterministic JSX.",
                    "success",
                  );
                } else {
                  addLog(
                    "generation",
                    "Structured spec phase timed out. Falling back to fast direct generation.",
                    "warning",
                  );
                }
              }

              if (!currentCode) {
                const completion = await withTimeout(
                  engineRef.current.chat.completions.create({
                    messages: [
                      { role: "system", content: systemPrompt },
                      { role: "user", content: boundedUserMessage },
                    ],
                    temperature: profile.temperature,
                    max_tokens: profile.maxCompletionTokens,
                  }),
                  LLM_COMPLETION_TIMEOUT_MS,
                );

                if (!completion) {
                  throw new Error(
                    "Model completion timed out. Falling back to safe fast generation.",
                  );
                }

                currentCode = extractCode(
                  completion.choices[0].message.content || "",
                );
              }
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
            if (genError.message?.includes("timed out")) {
              addLog(
                "generation",
                "Model timeout reached during generation.",
                "error",
              );
              throw new Error("Model completion timed out.");
            }

            // Handle WebGPU OOM during generation
            if (genError.message?.includes("out of memory")) {
              throw new Error(
                "WebGPU OOM during generation. The model may be overloaded. " +
                  "Try refreshing the page to reset GPU memory.",
              );
            }
            throw genError;
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
          const result = await executeCodeInWebContainer(
            currentCode,
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
              generatedCode: currentCode,
            }));
            return { success: true, code: currentCode, output: result.output };
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
    [addLog, ensureWebContainerReady, state.selectedModel],
  );

  const executeGeneratedCodeDirectly = useCallback(
    async (code: string, userPrompt: string) => {
      if (!code.trim()) {
        return { success: false, error: "No generated code payload received." };
      }

      const preparedCode = resolveExecutableUiCodePayload(
        sanitizeWorkerCode(code),
        userPrompt,
      );
      assertNoGenericTemplatePayload(
        preparedCode,
        "distributed execution payload",
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
          generatedCode: preparedCode,
          previewUrl: null,
        }));
        return {
          success: true,
          code: preparedCode,
          output:
            "Distributed code received. Live preview is unavailable on this device/browser.",
        };
      }

      setState((prev) => ({
        ...prev,
        isExecuting: true,
        currentPhase: "executing",
        error: null,
        generatedCode: preparedCode,
      }));

      addLog(
        "execution",
        "Executing distributed code payload in WebContainer...",
        "info",
      );

      const result = await executeCodeInWebContainer(
        preparedCode,
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
          generatedCode: preparedCode,
        }));

        addLog("execution", "Distributed code execution successful", "success");
        return { success: true, code: preparedCode, output: result.output };
      }

      const errorMsg = result.error || "Distributed execution failed.";
      setState((prev) => ({
        ...prev,
        isExecuting: false,
        currentPhase: "error",
        error: errorMsg,
      }));
      addLog("execution", `FATAL ERROR: ${errorMsg}`, "error");
      return { success: false, error: errorMsg };
    },
    [addLog, ensureWebContainerReady],
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
    isReady: state.isInitialized && !state.isLoading,
    engine: engineRef.current,
  };
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function buildInferenceProfile(
  capability: "low" | "medium" | "high",
  hasWebGPU: boolean,
): InferenceProfile {
  if (!hasWebGPU) {
    return {
      name: "lite",
      contextWindowSize: 1536,
      maxCompletionTokens: 256,
      temperature: 0.2,
      retryAttempts: 1,
      runBuildValidation: false,
    };
  }

  if (capability === "low") {
    return {
      name: "low",
      contextWindowSize: 1536,
      maxCompletionTokens: 128,
      temperature: 0.2,
      retryAttempts: 1,
      runBuildValidation: false,
    };
  }

  if (capability === "high") {
    return {
      name: "high",
      contextWindowSize: 3072,
      maxCompletionTokens: 448,
      temperature: 0.45,
      retryAttempts: 1,
      runBuildValidation: false,
    };
  }

  return {
    name: "balanced",
    contextWindowSize: 2304,
    maxCompletionTokens: 320,
    temperature: 0.35,
    retryAttempts: 1,
    runBuildValidation: false,
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

async function generateUiCodeFromStructuredSpec(
  engine: webllm.MLCEngine,
  prompt: string,
  maxCompletionTokens: number,
): Promise<string | null> {
  const specSystemPrompt = `You generate only valid JSON for UI specs.
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
- 2 to 6 sections maximum
- concise text; no markdown
- no HTML, no JSX, no shell commands`;

  const completion = await engine.chat.completions.create({
    messages: [
      { role: "system", content: specSystemPrompt },
      {
        role: "user",
        content:
          `Create a UI spec for a faithful implementation of this request. ` +
          `Mirror any screenshot or mockup instructions, preserve layout hierarchy, ` +
          `avoid generic templates, and do not echo the request text as visible copy unless the screenshot shows it: ${prompt}`,
      },
    ],
    temperature: 0.2,
    max_tokens: Math.min(1024, Math.max(384, maxCompletionTokens + 128)),
  });

  const raw = completion.choices[0].message.content || "";
  const parsedSpec = parseGeminiLikeUiSpec(raw);

  if (!parsedSpec) {
    return null;
  }

  return renderGeminiLikeUiSpec(parsedSpec);
}

function resolveExecutableUiCodePayload(code: string, prompt: string): string {
  const trimmed = code.trim();
  if (!trimmed) {
    return code;
  }

  const parsedSpec = parseGeminiLikeUiSpec(trimmed);
  if (parsedSpec) {
    return renderGeminiLikeUiSpec(parsedSpec);
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

function parseGeminiLikeUiSpec(payload: string): GeminiLikeUiSpec | null {
  const candidate = extractFirstJsonObject(payload);
  if (!candidate) {
    return null;
  }

  try {
    const parsed = JSON.parse(candidate);
    if (!isGeminiLikeUiSpec(parsed)) {
      return null;
    }
    return clampGeminiLikeUiSpec(parsed);
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

function isGeminiLikeUiSpec(value: unknown): value is GeminiLikeUiSpec {
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

function clampGeminiLikeUiSpec(spec: GeminiLikeUiSpec): GeminiLikeUiSpec {
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

function renderGeminiLikeUiSpec(spec: GeminiLikeUiSpec): string {
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
            <p style={{ margin: 0, fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: "#0369a1", fontWeight: 700 }}>Gemini-Style Structured Canvas</p>
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

function sectionToneClass(type: GeminiLikeUiSection["type"]): string {
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

export function generateLiteCodeFromPrompt(prompt: string): string {
  const imageRequirements = extractImageAnalysisRequirements(prompt);

  if (imageRequirements) {
    return renderDeterministicLiteMimicFromImageDescription(imageRequirements);
  }

  return buildPromptAwareUiFallback(prompt, "lite");
}

function extractImageAnalysisRequirements(prompt: string): string | null {
  const marker = "[IMAGE ANALYSIS REQUIREMENTS]";
  const start = prompt.indexOf(marker);

  if (start < 0) {
    return null;
  }

  const block = prompt.slice(start + marker.length).trim();
  if (!block) {
    return null;
  }

  const bounded = block.slice(0, 2400).trim();
  return bounded.length > 0 ? bounded : null;
}

interface LiteLayoutTokens {
  layout: "sidebar-content" | "topbar-content" | "single-column";
  contentStyle: "dashboard" | "form" | "catalog" | "marketing" | "mixed";
  density: "compact" | "comfortable";
  emphasis: "data" | "action" | "narrative";
  sections: string[];
}

const DEFAULT_LITE_LAYOUT_TOKENS: LiteLayoutTokens = {
  layout: "single-column",
  contentStyle: "mixed",
  density: "comfortable",
  emphasis: "narrative",
  sections: ["header", "content-grid"],
};

function parseLiteLayoutTokens(description: string): LiteLayoutTokens {
  const marker = "[LAYOUT TOKENS]";
  const start = description.indexOf(marker);

  if (start < 0) {
    return DEFAULT_LITE_LAYOUT_TOKENS;
  }

  const afterMarker = description.slice(start + marker.length);
  const referenceMarkerIndex = afterMarker.indexOf("[REFERENCE DESCRIPTION]");
  const tokenText =
    referenceMarkerIndex >= 0
      ? afterMarker.slice(0, referenceMarkerIndex)
      : afterMarker;

  const lines = tokenText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const map = new Map<string, string>();
  for (const line of lines) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      map.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
    }
  }

  const layout = map.get("layout");
  const contentStyle = map.get("contentStyle");
  const density = map.get("density");
  const emphasis = map.get("emphasis");
  const sections = (map.get("sections") || "")
    .split(",")
    .map((section) => section.trim())
    .filter(Boolean);

  return {
    layout:
      layout === "sidebar-content" ||
      layout === "topbar-content" ||
      layout === "single-column"
        ? layout
        : DEFAULT_LITE_LAYOUT_TOKENS.layout,
    contentStyle:
      contentStyle === "dashboard" ||
      contentStyle === "form" ||
      contentStyle === "catalog" ||
      contentStyle === "marketing" ||
      contentStyle === "mixed"
        ? contentStyle
        : DEFAULT_LITE_LAYOUT_TOKENS.contentStyle,
    density:
      density === "compact" || density === "comfortable"
        ? density
        : DEFAULT_LITE_LAYOUT_TOKENS.density,
    emphasis:
      emphasis === "data" || emphasis === "action" || emphasis === "narrative"
        ? emphasis
        : DEFAULT_LITE_LAYOUT_TOKENS.emphasis,
    sections:
      sections.length > 0 ? sections : DEFAULT_LITE_LAYOUT_TOKENS.sections,
  };
}

function extractReferenceDescription(description: string): string {
  const marker = "[REFERENCE DESCRIPTION]";
  const start = description.indexOf(marker);

  if (start < 0) {
    return description;
  }

  const text = description.slice(start + marker.length).trim();
  return text.length > 0 ? text : description;
}

function extractMeaningfulReferenceLines(referenceText: string): string[] {
  return referenceText
    .split(/\r?\n|[.;]+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 8)
    .slice(0, 14);
}

function toHeadlineCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function deriveLiteMimicTitle(
  lines: string[],
  tokens: LiteLayoutTokens,
): string {
  const firstLine = lines[0] ?? "";
  const candidate = firstLine
    .replace(/^(create|build|design|generate)\s+/i, "")
    .trim();

  if (candidate.length >= 10) {
    return toHeadlineCase(candidate);
  }

  if (tokens.contentStyle === "dashboard") {
    return "Operations Dashboard";
  }

  if (tokens.contentStyle === "form") {
    return "Account Workflow";
  }

  if (tokens.contentStyle === "catalog") {
    return "Content Catalog";
  }

  if (tokens.contentStyle === "marketing") {
    return "Landing Experience";
  }

  return "Reference-Matched UI";
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function renderDeterministicLiteMimicFromImageDescription(
  description: string,
): string {
  const tokens = parseLiteLayoutTokens(description);
  const referenceText = extractReferenceDescription(description);
  const lines = extractMeaningfulReferenceLines(referenceText);
  const title = deriveLiteMimicTitle(lines, tokens);
  const subtitle =
    lines[1] ??
    "Deterministic low-latency render synthesized from visual layout signals.";

  const navItems = lines.slice(2, 7).map((line, idx) => {
    return toHeadlineCase(line) || `Section ${idx + 1}`;
  });

  const cardSource =
    lines.length > 0
      ? lines
      : [
          "Primary content block aligned with the source image hierarchy",
          "Secondary support block preserving spacing and visual rhythm",
          "Control cluster placed near the dominant interaction area",
          "Summary/details region matching card density from the screenshot",
        ];

  const groupedCards = chunkArray(cardSource.slice(0, 9), 3).slice(0, 3);

  const layoutClass = tokens.layout;
  const compact = tokens.density === "compact";
  const mainGap = compact ? "0.7rem" : "1rem";
  const cardPadding = compact ? "0.8rem" : "1rem";

  return `export default function App() {
  const navItems = ${JSON.stringify(navItems.length > 0 ? navItems : ["Overview", "Workspace", "Details"])};
  const groupedCards = ${JSON.stringify(groupedCards.length > 0 ? groupedCards : [["Primary content area"], ["Secondary content area"]])};

  return (
    <main style={{ minHeight: "100vh", margin: 0, background: "#eef0f4", padding: "1.25rem", fontFamily: "Inter, system-ui, sans-serif", color: "#0f172a" }}>
      <section style={{ maxWidth: 1120, margin: "0 auto", borderRadius: 20, border: "1px solid #d4d8df", background: "#f8fafc", overflow: "hidden", boxShadow: "0 16px 48px rgba(15, 23, 42, 0.08)" }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", padding: "1rem 1.2rem", borderBottom: "1px solid #dbe1ea", background: "#f6f8fb", flexWrap: "wrap" }}>
          <div>
            <p style={{ margin: 0, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#64748b", fontWeight: 700 }}>Visual Fidelity Mode</p>
            <h1 style={{ margin: "0.35rem 0 0", fontSize: "clamp(1.7rem, 4.5vw, 2.9rem)", lineHeight: 1.05, letterSpacing: "-0.02em" }}>{${JSON.stringify(title)}}</h1>
            <p style={{ margin: "0.55rem 0 0", color: "#475569", maxWidth: 760, lineHeight: 1.5 }}>{${JSON.stringify(subtitle)}}</p>
          </div>
          <button style={{ border: "none", borderRadius: 999, background: "#0f172a", color: "#fff", padding: "0.58rem 0.95rem", fontSize: 12, fontWeight: 700 }}>Action</button>
        </header>

        <div style={{ display: "grid", gridTemplateColumns: ${JSON.stringify(layoutClass === "sidebar-content" ? "220px 1fr" : "1fr")}, gap: ${JSON.stringify(mainGap)}, padding: "1rem" }}>
          ${
            layoutClass === "sidebar-content"
              ? `<aside style={{ borderRadius: 14, border: "1px solid #dbe1ea", background: "#ffffff", padding: "0.75rem" }}>
            <p style={{ margin: "0 0 0.5rem", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#64748b", fontWeight: 700 }}>Navigation</p>
            <div style={{ display: "grid", gap: "0.45rem" }}>
              {navItems.map((item) => (
                <div key={item} style={{ borderRadius: 10, border: "1px solid #e2e8f0", background: "#f8fafc", padding: "0.55rem 0.65rem", fontSize: 13, color: "#1e293b", fontWeight: 600 }}>{item}</div>
              ))}
            </div>
          </aside>`
              : ""
          }

          <div style={{ display: "grid", gap: ${JSON.stringify(mainGap)} }}>
            ${
              layoutClass === "topbar-content"
                ? `<div style={{ borderRadius: 12, border: "1px solid #dbe1ea", background: "#ffffff", padding: "0.65rem 0.75rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.6rem", flexWrap: "wrap" }}>
              <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
                {navItems.slice(0, 4).map((item) => (
                  <span key={item} style={{ borderRadius: 999, border: "1px solid #e2e8f0", background: "#f8fafc", padding: "0.28rem 0.6rem", fontSize: 12, color: "#334155", fontWeight: 600 }}>{item}</span>
                ))}
              </div>
              <span style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>Status: synced</span>
            </div>`
                : ""
            }

            <div style={{ display: "grid", gap: ${JSON.stringify(mainGap)}, gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }}>
              {groupedCards.flat().map((line, idx) => (
                <article key={idx + "-" + line} style={{ borderRadius: 14, border: "1px solid #dbe1ea", background: "#ffffff", padding: ${JSON.stringify(cardPadding)}, boxShadow: "0 8px 24px rgba(15, 23, 42, 0.04)" }}>
                  <h3 style={{ margin: "0 0 0.45rem", fontSize: "1.05rem", color: "#0f172a" }}>{"Panel " + (idx + 1)}</h3>
                  <p style={{ margin: 0, color: "#334155", lineHeight: 1.5 }}>{line}</p>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}`;
}

/**
 * Build system prompt with RAG context injection and model-specific tuning
 */
function buildSystemPrompt(
  ragContext?: string[],
  modelType?: ModelType,
): string {
  let prompt = `You are an expert coding assistant embedded in SouthStack, an offline-first IDE.
You generate clean, production-ready code that executes without errors.

Guidelines:
- Write complete, executable code (no placeholders like "// TODO")
- Include all necessary imports
- Handle errors gracefully
- Use modern JavaScript/TypeScript practices
- If the request is UI-focused, return a React component suitable for src/App.jsx
- If the request references a screenshot, mockup, image, or other visual reference, treat that reference as the source of truth and mirror the visible layout, hierarchy, spacing, text density, button placement, and card structure as closely as possible
- Preserve the prompt's design language; do not replace a specific UI with a generic dashboard, landing page, or starter template
- Prefer exact composition over invention when the prompt is image-led
- Do not render the user's request text as visible UI copy unless the referenced screenshot explicitly shows that same text
- If the request is backend-focused, return runnable Node.js code
- Do not output any prose before or after code
- Do not output markdown fences like \`\`\`jsx
- Never output pseudo tags like <cards> or <main-content>; use valid JSX elements only
- Use className, never class, in JSX`;

  // Prompt tuning for smaller models
  if (modelType === "0.5B") {
    prompt += `\n\nIMPORTANT: Output code only. Do not include explanations, markdown, or code fences. For UI requests, output one React component with a default export. For screenshot-driven requests, keep the structure faithful to the source image even if the result is visually dense. For backend requests, prefer Node.js core modules.`;
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
    return fencedBlockMatch[1].trim();
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
    return unfenced.slice(startIndex).trim();
  }

  return unfenced;
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
  return /(^|\n)import\s+.+from\s+['\"].+['\"];?/m.test(code);
}

function buildReactModuleFromFragment(code: string): string {
  const lines = code.split(/\r?\n/);
  const importLines = lines.filter((line) =>
    /^\s*import\s+.+from\s+['\"].+['\"];?\s*$/.test(line),
  );
  const bodyLines = lines.filter(
    (line) => !/^\s*import\s+.+from\s+['\"].+['\"];?\s*$/.test(line),
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

type FallbackCard = {
  title: string;
  body: string;
  accent: string;
  accentLabel: string;
};

function buildPromptAwareUiFallback(
  prompt: string,
  mode: "lite" | "emergency",
): string {
  const normalizedPrompt = prompt.replace(/\s+/g, " ").trim();
  const lowerPrompt = normalizedPrompt.toLowerCase();
  const title = deriveFallbackTitle(
    normalizedPrompt,
    isImageLedPrompt(normalizedPrompt),
  );
  const isImageLed = /image|screenshot|mockup|reference|picture|visual/i.test(
    normalizedPrompt,
  );
  const cards = buildFallbackCards(lowerPrompt, isImageLed);
  const panelLabel = isImageLed
    ? "Visual fidelity target"
    : "Prompt-aligned layout";
  const background = isImageLed
    ? "#f3f4f6"
    : mode === "lite"
      ? "#f8fafc"
      : "#f4f4f5";
  const surface = "#ffffff";
  const border = isImageLed ? "#d4d4d8" : "#e4e4e7";
  const accent = isImageLed
    ? "#111827"
    : lowerPrompt.includes("dashboard")
      ? "#0f766e"
      : "#111111";
  const subtitle = isImageLed
    ? "Fast reference-based preview while full generation completes."
    : mode === "lite"
      ? "Fast local synthesis for low-end hardware."
      : "Fallback render to keep preview stable.";
  const borderStyle = `1px solid ${border}`;

  return `export default function App() {
  const cards = ${JSON.stringify(cards)};

  return (
    <main style={{ minHeight: "100vh", margin: 0, padding: "1.5rem", background: ${JSON.stringify(background)}, fontFamily: "Inter, system-ui, sans-serif", color: "#0f172a" }}>
      <section style={{ maxWidth: 1120, margin: "0 auto", background: ${JSON.stringify(surface)}, borderRadius: 24, border: ${JSON.stringify(borderStyle)}, overflow: "hidden", boxShadow: "0 24px 80px rgba(15, 23, 42, 0.08)" }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", padding: "1.05rem 1.35rem", borderBottom: ${JSON.stringify(borderStyle)}, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: "#64748b", fontWeight: 700 }}>{${JSON.stringify(panelLabel)}}</p>
            <h1 style={{ margin: "0.35rem 0 0", fontSize: "clamp(2rem, 5vw, 3.35rem)", lineHeight: 1.04, color: "#0f172a", letterSpacing: "-0.03em" }}>{${JSON.stringify(title)}}</h1>
            <p style={{ margin: "0.7rem 0 0", maxWidth: 760, color: "#475569", lineHeight: 1.55 }}>{${JSON.stringify(subtitle)}}</p>
          </div>
          <button style={{ border: "none", borderRadius: 999, background: ${JSON.stringify(accent)}, color: "#fff", padding: "0.65rem 1rem", fontSize: 13, fontWeight: 700, boxShadow: "0 10px 28px rgba(15, 23, 42, 0.16)" }}>
            ${mode === "lite" ? "Preview" : "Action"}
          </button>
        </header>

        <div style={{ padding: "1.25rem", display: "grid", gap: "1rem" }}>
          <div style={{ display: "grid", gap: "0.85rem", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
            {cards.map((card) => (
              <article key={card.title} style={{ borderRadius: 18, border: ${JSON.stringify(borderStyle)}, padding: "1rem", background: "#ffffff", boxShadow: "0 10px 30px rgba(15, 23, 42, 0.04)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
                  <h2 style={{ margin: 0, fontSize: "1.05rem", color: "#0f172a" }}>{card.title}</h2>
                  <span style={{ display: "inline-flex", borderRadius: 999, padding: "0.2rem 0.55rem", background: card.accent, color: "#fff", fontSize: 11, fontWeight: 700 }}>{card.accentLabel}</span>
                </div>
                <p style={{ margin: "0.65rem 0 0", color: "#475569", lineHeight: 1.55 }}>{card.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}`;
}

function isImageLedPrompt(prompt: string): boolean {
  return /image|screenshot|mockup|reference|picture|visual/i.test(prompt);
}

function deriveFallbackTitle(prompt: string, isImageLed: boolean): string {
  if (isImageLed) {
    return "Generated UI";
  }

  if (/dashboard|analytics|stats|metrics/.test(prompt)) {
    return "Dashboard Surface";
  }

  if (/form|input|signup|login|checkout|contact/.test(prompt)) {
    return "Form Layout";
  }

  if (/table|grid|list|catalog|gallery/.test(prompt)) {
    return "Content Grid";
  }

  if (/hero|landing|marketing|home/.test(prompt)) {
    return "Landing Surface";
  }

  return "Generated UI";
}

function buildFallbackCards(
  prompt: string,
  isImageLed: boolean,
): FallbackCard[] {
  const baseCards: FallbackCard[] = [];

  if (/dashboard|analytics|stats|metrics/.test(prompt)) {
    baseCards.push(
      {
        title: "Overview",
        body: "Surface the primary numbers, status indicators, and the layout rhythm the prompt expects.",
        accent: "#0f766e",
        accentLabel: "Metrics",
      },
      {
        title: "Detail Panel",
        body: "Keep the secondary panel, supporting chart, or side content aligned with the reference structure.",
        accent: "#1d4ed8",
        accentLabel: "Panel",
      },
      {
        title: "Recent Activity",
        body: "Show the most visible list, activity stream, or table area with the same density as the source.",
        accent: "#7c3aed",
        accentLabel: "Feed",
      },
    );
  } else if (/form|input|signup|login|checkout|contact/.test(prompt)) {
    baseCards.push(
      {
        title: "Primary Form",
        body: "Place the main inputs where the prompt or image implies the user should begin.",
        accent: "#0f766e",
        accentLabel: "Form",
      },
      {
        title: "Supporting Copy",
        body: "Keep helper text, instructions, and microcopy in the same visual rhythm as the reference.",
        accent: "#1d4ed8",
        accentLabel: "Copy",
      },
      {
        title: "Action Area",
        body: "Keep the primary button hierarchy, spacing, and emphasis consistent with the source UI.",
        accent: "#7c3aed",
        accentLabel: "Action",
      },
    );
  } else if (/table|grid|list|catalog|gallery/.test(prompt)) {
    baseCards.push(
      {
        title: "Primary Grid",
        body: "Render the visible collection or table density from the prompt instead of flattening it into a generic card set.",
        accent: "#0f766e",
        accentLabel: "Grid",
      },
      {
        title: "Filters",
        body: "Preserve the top controls, filter chips, and utility actions that frame the content area.",
        accent: "#1d4ed8",
        accentLabel: "Filter",
      },
      {
        title: "Supporting Details",
        body: "Keep metadata, labels, and auxiliary content aligned with the original structure.",
        accent: "#7c3aed",
        accentLabel: "Meta",
      },
    );
  } else if (isImageLed) {
    baseCards.push(
      {
        title: "Visual Match",
        body: "Mirror the screenshot's composition, spacing, and hierarchy before adding any embellishment.",
        accent: "#0f766e",
        accentLabel: "Exact",
      },
      {
        title: "Controls",
        body: "Keep buttons, fields, labels, and chrome in the same relative positions as the reference UI.",
        accent: "#1d4ed8",
        accentLabel: "UI",
      },
      {
        title: "Polish",
        body: "Refine the surface while retaining the original layout language and visual weight.",
        accent: "#7c3aed",
        accentLabel: "Refine",
      },
    );
  } else {
    baseCards.push(
      {
        title: "Primary Surface",
        body: "Build the largest visible content block first so the output reflects the request rather than a starter template.",
        accent: "#0f766e",
        accentLabel: "Main",
      },
      {
        title: "Supporting Area",
        body: "Keep the secondary content, notes, or supporting controls aligned with the requested composition.",
        accent: "#1d4ed8",
        accentLabel: "Support",
      },
      {
        title: "Interactions",
        body: "Place the visible actions and status elements where a user would expect them from the prompt.",
        accent: "#7c3aed",
        accentLabel: "Action",
      },
    );
  }

  return baseCards;
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

function assertNoGenericTemplatePayload(code: string, context: string): void {
  const normalized = sanitizeGeneratedUiCode(code).toLowerCase();
  const matchedMarkers = GENERIC_TEMPLATE_MARKERS.filter((marker) =>
    normalized.includes(marker),
  );

  if (matchedMarkers.length >= 2) {
    throw new Error(
      `Blocked generic template payload in ${context}. Matched markers: ${matchedMarkers.join(", ")}`,
    );
  }
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
      "/index.html",
      `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>SouthStack Live Preview</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n`,
    );

    await webContainerService.writeFile(
      "/src/main.jsx",
      `import React from "react";\nimport ReactDOM from "react-dom/client";\nimport App from "./App";\n\nReactDOM.createRoot(document.getElementById("root")).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n);\n`,
    );

    await webContainerService.writeFile(
      "/src/styles.css",
      `:root {\n  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;\n}\n\n* {\n  box-sizing: border-box;\n}\n\nbody {\n  margin: 0;\n  background: #f8fafc;\n  color: #0f172a;\n}\n`,
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

  assertNoGenericTemplatePayload(safeCode, "WebContainer /src/App.jsx write");

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
