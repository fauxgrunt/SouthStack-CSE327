import { useState, useCallback, useRef, useEffect } from "react";
import * as webllm from "@mlc-ai/web-llm";
import { detectDeviceCapability, limitArraySize } from "../utils/performance";
import { webContainerService } from "../services/webcontainer";

// Model Configuration - OPTIMIZED FOR 0.5B ONLY
export type ModelType = "0.5B";

// Maximum number of logs to keep in memory (prevent memory leaks)
const MAX_LOG_ENTRIES = 500;

export const MODEL_CONFIGS = {
  "0.5B": {
    id: "Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC",
    label: "Standard (0.5B)",
    description: "Optimized lightweight model - ~500MB",
    minStorage: 600 * 1024 * 1024, // 600MB
  },
  // 1.5B Model removed for optimized single-model deployment
  // "1.5B": {
  //   id: "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC",
  //   label: "Pro (1.5B)",
  //   description: "Advanced model - ~1.5GB (Requires dedicated GPU)",
  //   minStorage: 1.6 * 1024 * 1024 * 1024, // 1.6GB
  // },
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
}

const WEBLLM_CONTEXT_SAFETY_MARGIN = 128;

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
    selectedModel: "0.5B", // Default to lightweight model
    storageAvailable: null,
    previewUrl: null,
  });

  const engineRef = useRef<webllm.MLCEngine | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const dependenciesInstalledRef = useRef(false);
  const devServerProcessRef = useRef<WebContainerProcess | null>(null);
  const devServerUrlRef = useRef<string | null>(null);
  const webContainerAvailableRef = useRef(true);
  const inferenceProfileRef = useRef<InferenceProfile>(
    buildInferenceProfile("medium", true),
  );
  const liteModeRef = useRef(false);

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
   * Check available storage (informational only - 0.5B model is always used)
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
    addLog(
      "initialization",
      "Initializing Standard 0.5B Optimized Engine...",
      "info",
    );

    try {
      const capability = await detectDeviceCapability();

      // Ask for non-evictable storage quota before model download/caching.
      await requestPersistentStorage();

      // Check storage availability (informational only)
      await checkStorageAvailability();

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

      try {
        await webContainerService.boot();
        webContainerAvailableRef.current = true;
        addLog("initialization", "WebContainer runtime ready", "success");
      } catch (bootError: unknown) {
        webContainerAvailableRef.current = false;
        const bootMessage =
          bootError instanceof Error ? bootError.message : "Unknown error";
        addLog(
          "initialization",
          `WebContainer unavailable on this device/browser. Continuing without live runtime execution. (${bootMessage})`,
          "warning",
        );
      }

      if (!hasWebGPU) {
        liteModeRef.current = true;
        addLog(
          "initialization",
          "WebGPU unavailable. Running in Lite mode for low-end device compatibility.",
          "warning",
        );

        setState((prev) => ({
          ...prev,
          isInitialized: true,
          isLoading: false,
          initProgress: 100,
        }));
        return;
      }

      const modelConfig = MODEL_CONFIGS["0.5B"];
      addLog(
        "initialization",
        `Loading Standard 0.5B Optimized Engine (~500MB)...`,
        "info",
      );

      const engine = new webllm.MLCEngine();
      engineRef.current = engine;

      // Progress tracking for model download
      engine.setInitProgressCallback((report: webllm.InitProgressReport) => {
        const maybeProgress = (report as { progress?: number }).progress;
        if (typeof maybeProgress === "number") {
          setState((prev) => ({
            ...prev,
            initProgress: Math.max(
              0,
              Math.min(100, Math.round(maybeProgress * 100)),
            ),
          }));
        }
        addLog("initialization", report.text, "info");
      });

      // Load the model with OOM and Quota protection
      try {
        await engine.reload(modelConfig.id, {
          context_window_size: inferenceProfileRef.current.contextWindowSize,
        });
      } catch (loadError: any) {
        // Handle Quota Exceeded Error (Storage limit)
        if (
          loadError.name === "QuotaExceededError" ||
          loadError.message?.includes("quota") ||
          loadError.message?.includes("storage")
        ) {
          throw new Error(
            "Storage limit reached. Please free up disk space or switch to the 0.5B Standard model. " +
              "You may need to clear browser cache or delete unused PWA data.",
          );
        }

        // Handle WebGPU OOM errors
        if (
          loadError.message?.includes("out of memory") ||
          loadError.message?.includes("OOM") ||
          loadError.message?.includes("allocation failed")
        ) {
          throw new Error(
            "WebGPU Out of Memory. Try closing other tabs or freeing up VRAM. " +
              "The 0.5B model requires ~1GB VRAM.",
          );
        }
        throw loadError;
      }

      addLog(
        "initialization",
        "Standard 0.5B Engine ready - fully offline!",
        "success",
      );
      setState((prev) => ({
        ...prev,
        isInitialized: true,
        isLoading: false,
        initProgress: 100,
      }));
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

      // Cleanup on failure
      engineRef.current = null;
    }
  }, [addLog, checkStorageAvailability, requestPersistentStorage]);

  /**
   * Main Agentic Loop - Autonomous code generation with self-healing
   */
  const executeAgenticLoop = useCallback(
    async (userPrompt: string, ragContext?: string[]) => {
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
              currentCode = generateLiteCodeFromPrompt(boundedUserMessage);
              addLog(
                "generation",
                "Lite generation mode: using ultra-fast local template synthesis.",
                "warning",
              );
            } else {
              const completion =
                await engineRef.current.chat.completions.create({
                  messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: boundedUserMessage },
                  ],
                  temperature: profile.temperature,
                  max_tokens: profile.maxCompletionTokens,
                });

              currentCode = extractCode(
                completion.choices[0].message.content || "",
              );
            }

            if (!currentCode) {
              throw new Error("AI generated empty or invalid code");
            }

            setState((prev) => ({ ...prev, generatedCode: currentCode }));
            addLog(
              "generation",
              `Code generated (${currentCode.length} chars)`,
              "success",
            );
          } catch (genError: any) {
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
            !webContainerService.isReady()
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

        // If we exit the loop without success
        throw new Error(
          "Failed to generate working code after all retry attempts",
        );
      } catch (error: any) {
        const errorMsg = error.message || "Unknown error in agentic loop";
        addLog("execution", `FATAL ERROR: ${errorMsg}`, "error");

        setState((prev) => ({
          ...prev,
          isExecuting: false,
          currentPhase: "error",
          error: errorMsg,
        }));

        return { success: false, error: errorMsg };
      }
    },
    [addLog, state.selectedModel],
  );

  const executeGeneratedCodeDirectly = useCallback(
    async (code: string, userPrompt: string) => {
      if (!code.trim()) {
        return { success: false, error: "No generated code payload received." };
      }

      if (!webContainerAvailableRef.current || !webContainerService.isReady()) {
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
          generatedCode: code,
          previewUrl: null,
        }));
        return {
          success: true,
          code,
          output:
            "Distributed code received. Live preview is unavailable on this device/browser.",
        };
      }

      setState((prev) => ({
        ...prev,
        isExecuting: true,
        currentPhase: "executing",
        error: null,
        generatedCode: code,
      }));

      addLog(
        "execution",
        "Executing distributed code payload in WebContainer...",
        "info",
      );

      const result = await executeCodeInWebContainer(
        code,
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
          generatedCode: code,
        }));

        addLog("execution", "Distributed code execution successful", "success");
        return { success: true, code, output: result.output };
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
    [addLog],
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
      contextWindowSize: 2048,
      maxCompletionTokens: 320,
      temperature: 0.3,
      retryAttempts: 1,
      runBuildValidation: false,
    };
  }

  if (capability === "high") {
    return {
      name: "high",
      contextWindowSize: 4096,
      maxCompletionTokens: 1024,
      temperature: 0.7,
      retryAttempts: 3,
      runBuildValidation: true,
    };
  }

  return {
    name: "balanced",
    contextWindowSize: 3072,
    maxCompletionTokens: 640,
    temperature: 0.5,
    retryAttempts: 2,
    runBuildValidation: false,
  };
}

function compactPromptForLowEnd(prompt: string): string {
  return prompt.replace(/\s{3,}/g, " ").trim();
}

function generateLiteCodeFromPrompt(prompt: string): string {
  const title = prompt
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/["`]/g, "");

  return `export default function App() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.25rem", lineHeight: 1.5 }}>
      <section style={{ maxWidth: 720, margin: "0 auto", border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
        <h1 style={{ marginTop: 0 }}>Fast Preview</h1>
        <p style={{ color: "#333" }}><strong>Request:</strong> ${title}</p>
        <p style={{ color: "#555" }}>
          Running in Lite mode for low-end hardware. This keeps generation responsive on weak GPUs/CPUs and phones.
        </p>
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
- If the request is backend-focused, return runnable Node.js code`;

  // Prompt tuning for smaller models
  if (modelType === "0.5B") {
    prompt += `\n\nIMPORTANT: Be concise and output code only. For UI requests, output one React component with a default export. For backend requests, prefer Node.js core modules.`;
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

Please fix the error and generate corrected code that will execute successfully.`;
}

/**
 * Extract code from LLM response (handles markdown code blocks)
 */
function extractCode(response: string): string {
  // Try to extract from markdown code blocks
  const codeBlockMatch = response.match(
    /```(?:javascript|js|typescript|ts)?\n([\s\S]*?)\n```/,
  );
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // If no code block, return trimmed response
  return response.trim();
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
  if (/export\s+default/.test(code)) {
    return code;
  }

  if (/function\s+App\s*\(/.test(code) || /const\s+App\s*=/.test(code)) {
    return `${code}\n\nexport default App;`;
  }

  if (/return\s*\(\s*<[^>]+>/.test(code)) {
    return `function App() {\n${code}\n}\n\nexport default App;`;
  }

  return `export default function App() {\n  return (\n    <pre style={{ whiteSpace: \"pre-wrap\", fontFamily: \"monospace\", padding: \"1rem\" }}>\n      ${JSON.stringify(code)}\n    </pre>\n  );\n}`;
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
      `import { defineConfig } from \"vite\";\nimport react from \"@vitejs/plugin-react\";\n\nexport default defineConfig({\n  plugins: [react()],\n  server: {\n    host: \"0.0.0.0\",\n    port: 4173,\n  },\n});\n`,
    );

    await webContainerService.writeFile(
      "/index.html",
      `<!doctype html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"UTF-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n    <title>SouthStack Live Preview</title>\n  </head>\n  <body>\n    <div id=\"root\"></div>\n    <script type=\"module\" src=\"/src/main.jsx\"></script>\n  </body>\n</html>\n`,
    );

    await webContainerService.writeFile(
      "/src/main.jsx",
      `import React from \"react\";\nimport ReactDOM from \"react-dom/client\";\nimport App from \"./App\";\n\nReactDOM.createRoot(document.getElementById(\"root\")).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n);\n`,
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
      }, 15000);

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
    await webContainerService.writeFile("/index.js", code);
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
  await webContainerService.writeFile("/src/App.jsx", appCode);
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
