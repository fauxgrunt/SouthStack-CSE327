import { useCallback, useEffect, useMemo, useState } from "react";
import { executeGeneration } from "../pipeline/uiGenerationPipeline";
import type { UIGenerationRequest } from "../pipeline/generateUIPrompt";
import { webContainerService } from "../services/webcontainer";
import { hasGroqApiKey } from "../services/groqClient";
import { useGenerationHistory } from "./useGenerationHistory";
import { useUIBuilder } from "./useUIBuilder";

export type AgenticPhase =
  | "idle"
  | "initialize"
  | "generate"
  | "complete"
  | "error";

export interface AgenticLogEntry {
  timestamp: Date;
  stage: string;
  message: string;
  type: "info" | "success" | "error" | "warning";
}

export interface AgenticLoopState {
  currentPhase: AgenticPhase;
  isInitialized: boolean;
  isLoading: boolean;
  isGenerating: boolean;
  error: string | null;
  generatedCode: string | null;
  previewUrl: string | null;
  logs: AgenticLogEntry[];
}

interface ExecuteRequest extends UIGenerationRequest {}

const initialState: AgenticLoopState = {
  currentPhase: "idle",
  isInitialized: false,
  isLoading: false,
  isGenerating: false,
  error: null,
  generatedCode: null,
  previewUrl: null,
  logs: [],
};

export function buildHardenedCoderSystemPrompt(): string {
  return [
    "You are a browser-first Groq-powered React UI builder.",
    "Generate a single, self-contained App component.",
    "Use Tailwind CSS only.",
    "Never output multiple files.",
    "Prefer deterministic, accessible, production-ready layouts.",
    "Return valid JSX only.",
  ].join("\n");
}

export const useAgenticLoop = () => {
  const [state, setState] = useState<AgenticLoopState>(initialState);
  const [isBootstrapped, setIsBootstrapped] = useState(false);
  const { history, addHistoryItem, clearHistory } = useGenerationHistory();

  const addLog = useCallback(
    (
      stage: string,
      message: string,
      type: AgenticLogEntry["type"] = "info",
    ) => {
      const consoleMethod =
        type === "error"
          ? console.error
          : type === "warning"
            ? console.warn
            : console.log;
      consoleMethod(`[AgenticLoop:${stage}] ${message}`);

      setState((prev) => ({
        ...prev,
        logs: [
          ...prev.logs,
          { timestamp: new Date(), stage, message, type },
        ].slice(-200),
      }));
    },
    [],
  );

  const { previewUrl, error: previewError } = useUIBuilder(
    state.generatedCode,
    {
      onLog: addLog,
    },
  );

  useEffect(() => {
    setState((prev) => ({
      ...prev,
      previewUrl,
      error: previewError ?? prev.error,
    }));
  }, [previewError, previewUrl]);

  const initializeEngine = useCallback(async () => {
    if (isBootstrapped) {
      setState((prev) => ({
        ...prev,
        currentPhase: "complete",
        isInitialized: true,
        isLoading: false,
      }));
      return;
    }

    setState((prev) => ({
      ...prev,
      isLoading: true,
      currentPhase: "initialize",
      error: null,
    }));
    addLog("init", "Starting Groq-first runtime initialization...", "info");

    try {
      if (!hasGroqApiKey()) {
        const message =
          "Groq API key not configured. Add VITE_GROQ_API_KEY to .env.local and restart the dev server.";
        setState((prev) => ({
          ...prev,
          isLoading: false,
          currentPhase: "error",
          error: message,
        }));
        addLog("init", `✗ ${message}`, "error");
        return;
      }

      addLog("init", "✓ Groq API key detected", "success");

      addLog(
        "init",
        "Booting WebContainer runtime (this may take a moment)...",
        "info",
      );
      try {
        await webContainerService.boot();
        addLog("init", "✓ WebContainer initialized", "success");
      } catch (bootError: any) {
        const bootMsg =
          bootError instanceof Error ? bootError.message : String(bootError);

        // Check if it's a timeout - allow Groq-only mode
        if (/timeout|Failed to boot/i.test(bootMsg)) {
          addLog(
            "init",
            `⚠ WebContainer unavailable (${bootMsg}). Switching to code-generation-only mode.`,
            "warning",
          );
          addLog(
            "init",
            "✓ Groq code generation is ready (live preview will be code-only)",
            "success",
          );
        } else {
          // For other errors, treat as fatal
          throw bootError;
        }
      }

      setIsBootstrapped(true);

      setState((prev) => ({
        ...prev,
        isInitialized: true,
        isLoading: false,
        currentPhase: "complete",
      }));
      addLog(
        "init",
        "✅ Ready! Groq code generation is initialized. You can generate UI code and view it directly.",
        "success",
      );
      console.log(
        "[Init] Groq-first runtime initialized (WebContainer may be unavailable)",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState((prev) => ({
        ...prev,
        isLoading: false,
        currentPhase: "error",
        error: message,
      }));
      addLog("init", `✗ Initialization failed: ${message}`, "error");
      console.error("[Init] Initialization error:", error);
    }
  }, [addLog, isBootstrapped]);

  const executeAgenticLoop = useCallback(
    async (request: ExecuteRequest) => {
      try {
        console.log("[AgenticLoop] Starting generation with request:", request);
        setState((prev) => ({
          ...prev,
          isGenerating: true,
          currentPhase: "generate",
          error: null,
        }));
        addLog("gen", "Generating component...", "info");

        const result = await executeGeneration(request, {
          onLog: addLog,
          onCodeReady: (code) => {
            console.log("[AgenticLoop] Code ready:", code.substring(0, 100));
            setState((prev) => ({ ...prev, generatedCode: code }));
          },
        });

        console.log("[AgenticLoop] Generation result:", result);

        await addHistoryItem({
          prompt: request.prompt,
          code: result.code,
          validationPassed: result.validationPassed,
          repairAttempted: result.repairAttempted,
          screenshotDescription: request.screenshotDescription,
        });

        setState((prev) => ({
          ...prev,
          isGenerating: false,
          currentPhase: result.validationPassed ? "complete" : "error",
          // Keep code available for preview/editing even when validation fails.
          generatedCode: result.code,
          error: result.validationPassed
            ? null
            : result.errors.join("; ") ||
              "Generated code needed fallback repair.",
        }));
        addLog(
          "gen",
          result.validationPassed
            ? "✓ Component ready"
            : "✗ Generation failed and was rejected",
          result.validationPassed ? "success" : "error",
        );

        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[AgenticLoop] Generation error:", message, error);
        setState((prev) => ({
          ...prev,
          isGenerating: false,
          currentPhase: "error",
          error: message,
        }));
        addLog("gen", `✗ ${message}`, "error");
        throw error;
      }
    },
    [addHistoryItem, addLog],
  );

  const resetGeneratedCanvas = useCallback(() => {
    setState((prev) => ({
      ...prev,
      generatedCode: null,
      previewUrl: null,
      error: null,
      currentPhase: isBootstrapped ? "complete" : "idle",
    }));
  }, [isBootstrapped]);

  const cancelExecution = useCallback(() => {
    setState((prev) => ({ ...prev, isGenerating: false }));
  }, []);

  const isReady = useMemo(() => state.isInitialized, [state.isInitialized]);

  return {
    state,
    isReady,
    engine: null,
    history,
    initializeEngine,
    executeAgenticLoop,
    resetGeneratedCanvas,
    cancelExecution,
    clearHistory,
    generatedCode: state.generatedCode,
    previewUrl: state.previewUrl,
    addLog,
    buildHardenedCoderSystemPrompt,
  };
};
