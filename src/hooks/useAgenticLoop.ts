import { useState, useCallback, useRef, useEffect } from "react";
import * as webllm from "@mlc-ai/web-llm";
import { limitArraySize } from "../utils/performance";

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

interface WebContainerMock {
  writeFile: (path: string, content: string) => Promise<void>;
  executeCommand: (command: string) => Promise<ExecutionResult>;
  readFile: (path: string) => Promise<string>;
}

const MAX_RETRY_ATTEMPTS = 3;

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
    isExecuting: false,
    currentPhase: "idle",
    logs: [],
    generatedCode: null,
    error: null,
    retryCount: 0,
    selectedModel: "0.5B", // Default to lightweight model
    storageAvailable: null,
  });

  const engineRef = useRef<webllm.MLCEngine | null>(null);
  const webContainerRef = useRef<WebContainerMock | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

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

    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    addLog(
      "initialization",
      "Initializing Standard 0.5B Optimized Engine...",
      "info",
    );

    try {
      // Ask for non-evictable storage quota before model download/caching.
      await requestPersistentStorage();

      // Check storage availability (informational only)
      await checkStorageAvailability();

      // Check WebGPU availability
      const navigatorWithGPU = navigator as typeof navigator & {
        gpu?: { requestAdapter: () => Promise<unknown> };
      };
      if (!navigatorWithGPU.gpu) {
        throw new Error(
          "WebGPU not supported in this browser. Please use Chrome/Edge 113+",
        );
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
        addLog("initialization", report.text, "info");
      });

      // Load the model with OOM and Quota protection
      try {
        await engine.reload(modelConfig.id, {
          context_window_size: 2048, // Optimized context window for 0.5B
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

      // Initialize mocked WebContainer
      webContainerRef.current = createMockedWebContainer();

      addLog(
        "initialization",
        "Standard 0.5B Engine ready - fully offline!",
        "success",
      );
      setState((prev) => ({ ...prev, isInitialized: true, isLoading: false }));
    } catch (error: any) {
      const errorMsg = error.message || "Failed to initialize WebLLM";
      addLog("initialization", `ERROR: ${errorMsg}`, "error");
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: errorMsg,
        currentPhase: "error",
      }));

      // Cleanup on failure
      engineRef.current = null;
    }
  }, [
    addLog,
    checkStorageAvailability,
    requestPersistentStorage,
    state.selectedModel,
    state.storageAvailable,
  ]);

  /**
   * Main Agentic Loop - Autonomous code generation with self-healing
   */
  const executeAgenticLoop = useCallback(
    async (userPrompt: string, ragContext?: string[]) => {
      if (!engineRef.current || !webContainerRef.current) {
        addLog("execution", "Engine not initialized", "error");
        return;
      }

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
        while (attempt < MAX_RETRY_ATTEMPTS) {
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

          addLog(
            "generation",
            attempt === 1
              ? `Generating code for: "${userPrompt}"`
              : `Attempt ${attempt}: Self-correcting based on error...`,
            "info",
          );

          try {
            const completion = await engineRef.current.chat.completions.create({
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage },
              ],
              temperature: 0.7,
              max_tokens: 1024,
            });

            currentCode = extractCode(
              completion.choices[0].message.content || "",
            );

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

          // PHASE 2: Autonomous Execution
          setState((prev) => ({ ...prev, currentPhase: "executing" }));
          addLog("execution", "Writing code to virtual filesystem...", "info");

          const targetFile = "index.js";
          await webContainerRef.current.writeFile(targetFile, currentCode);

          addLog("execution", `Executing: node ${targetFile}`, "info");
          const result = await webContainerRef.current.executeCommand(
            `node ${targetFile}`,
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
            lastError = result.error || "Unknown execution error";
            addLog("execution", `ERROR: ${lastError}`, "error");

            if (result.stackTrace) {
              addLog("execution", `Stack trace: ${result.stackTrace}`, "error");
            }

            if (attempt < MAX_RETRY_ATTEMPTS) {
              setState((prev) => ({ ...prev, currentPhase: "fixing" }));
              addLog(
                "fixing",
                `Self-healing attempt ${attempt}/${MAX_RETRY_ATTEMPTS}...`,
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
    };
  }, []);

  return {
    state,
    initializeEngine,
    executeAgenticLoop,
    cancelExecution,
    isReady: state.isInitialized && !state.isLoading,
    engine: engineRef.current,
  };
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

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
- Ensure code runs in Node.js environment`;

  // Prompt tuning for smaller models
  if (modelType === "0.5B") {
    prompt += `\n\nIMPORTANT: Be extremely concise. Use only standard Node.js core modules (fs, http, path, etc.). Do not explain the code. Focus on minimal, working implementations.`;
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

/**
 * Create mocked WebContainer for demonstration
 * In production, replace with actual @webcontainer/api
 */
function createMockedWebContainer(): WebContainerMock {
  const virtualFS = new Map<string, string>();

  return {
    async writeFile(path: string, content: string): Promise<void> {
      virtualFS.set(path, content);
      await new Promise((resolve) => setTimeout(resolve, 100)); // Simulate I/O
    },

    async executeCommand(command: string): Promise<ExecutionResult> {
      await new Promise((resolve) => setTimeout(resolve, 200)); // Simulate execution

      // Mock execution based on code analysis
      const [cmd, ...args] = command.split(" ");

      if (cmd === "node" && args[0]) {
        const code = virtualFS.get(args[0]);

        if (!code) {
          return {
            success: false,
            output: "",
            error: `Cannot find module '${args[0]}'`,
            stackTrace: `Error: Cannot find module '${args[0]}'\n    at Object.<anonymous>`,
          };
        }

        // Simple heuristic: check for common error patterns
        if (code.includes("throw new Error") && !code.includes("try {")) {
          return {
            success: false,
            output: "",
            error: "Unhandled Error thrown",
            stackTrace:
              "Error: Unhandled Error thrown\n    at Object.<anonymous> (index.js:5:11)",
          };
        }

        if (
          code.includes("require(") &&
          !code.includes("express") &&
          !code.includes("fs")
        ) {
          // Simulate missing module error
          const match = code.match(/require\(['"]([^'"]+)['"]\)/);
          if (match) {
            return {
              success: false,
              output: "",
              error: `Cannot find module '${match[1]}'`,
              stackTrace: `Error: Cannot find module '${match[1]}'\n    at Function.Module._resolveFilename`,
            };
          }
        }

        // Success case
        return {
          success: true,
          output:
            "Server running on http://localhost:3000\nExecution completed successfully.",
        };
      }

      return {
        success: false,
        output: "",
        error: `Command not found: ${cmd}`,
      };
    },

    async readFile(path: string): Promise<string> {
      const content = virtualFS.get(path);
      if (!content) {
        throw new Error(`File not found: ${path}`);
      }
      return content;
    },
  };
}
