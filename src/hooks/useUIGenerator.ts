import { useCallback, useRef, useState } from "react";
import { extractUIFromImage } from "../services/LocalVisionProcessor";
import { generateWithWebLLM } from "../services/webllm";
import { cleanGeneratedCode } from "../pipeline/cleaning";
import {
  buildRepairPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  type UIGenerationRequest,
} from "../pipeline/generateUIPrompt";
import { validateGeneratedCode } from "../pipeline/validation";

export interface UIGenerationOptions {
  onLog?: (
    stage: string,
    message: string,
    type?: "info" | "success" | "error" | "warning",
  ) => void;
}

export interface UIGenerationResult {
  code: string;
  validationPassed: boolean;
  repairAttempted: boolean;
  timestamp: number;
  errors: string[];
}

interface UIGeneratorState {
  isGenerating: boolean;
  error: string | null;
  lastResult: UIGenerationResult | null;
}

export async function generateUI(
  request: UIGenerationRequest,
  options: UIGenerationOptions = {},
): Promise<UIGenerationResult> {
  const log = options.onLog;
  const startTime = performance.now();
  const timings: Record<string, number> = {};

  let t = performance.now();
  log?.("pipeline", "Starting generation pipeline...", "info");

  let screenshotDescription = request.screenshotDescription;
  if (request.screenshot) {
    log?.("vision", "Analyzing screenshot with vision model...", "info");
    const visionStart = performance.now();
    screenshotDescription = await extractUIFromImage(request.screenshot);
    const visionTime = Math.round(performance.now() - visionStart);
    timings.vision = visionTime;
    log?.("vision", `Screenshot analyzed (${visionTime}ms)`, "success");
  }

  const systemPrompt = buildSystemPrompt();
  log?.("prompt", "Building generation prompt...", "info");
  const userPrompt = buildUserPrompt({
    ...request,
    screenshotDescription,
  });
  const promptTime = Math.round(performance.now() - t);
  timings.prompt = promptTime;

  log?.("llm", "Generating React component with LLM...", "info");
  t = performance.now();
  const rawCode = await generateWithWebLLM(userPrompt, systemPrompt, {
    temperature: 0.7,
    maxTokens: 1500,
    timeoutMs: 180000,
  });
  const llmTime = Math.round(performance.now() - t);
  timings.llm = llmTime;
  log?.("llm", `Generation completed (${llmTime}ms)`, "success");

  log?.("cleanup", "Cleaning generated code...", "info");
  t = performance.now();
  const cleaned = cleanGeneratedCode(rawCode);
  const cleanupTime = Math.round(performance.now() - t);
  timings.cleanup = cleanupTime;

  log?.("validation", "Validating generated code...", "info");
  t = performance.now();
  const validation = validateGeneratedCode(cleaned);
  const validationTime = Math.round(performance.now() - t);
  timings.validation = validationTime;

  if (validation.valid) {
    log?.(
      "validation",
      `Generated code is valid (${validationTime}ms)`,
      "success",
    );
    const totalTime = Math.round(performance.now() - startTime);
    timings.total = totalTime;
    console.log("[GenerateUI] Timing breakdown (ms):", timings);
    return {
      code: cleaned,
      validationPassed: true,
      repairAttempted: false,
      timestamp: Date.now(),
      errors: [],
    };
  }

  log?.(
    "repair",
    `Initial output failed validation; attempting repair (${validationTime}ms)...`,
    "warning",
  );
  t = performance.now();
  const repairPrompt = buildRepairPrompt(cleaned, validation.errors);
  const repairedCode = await generateWithWebLLM(repairPrompt, systemPrompt, {
    temperature: 0.3,
    maxTokens: 1200,
    timeoutMs: 120000,
  });
  const repairTime = Math.round(performance.now() - t);
  timings.repair = repairTime;

  log?.("repair", `Validating repaired code (${repairTime}ms)...`, "info");
  const repaired = cleanGeneratedCode(repairedCode);
  const repairedValidation = validateGeneratedCode(repaired);

  if (repairedValidation.valid) {
    log?.("repair", "Repair succeeded!", "success");
  } else {
    log?.("repair", "Repair failed; returning validation error", "error");
  }

  const totalTime = Math.round(performance.now() - startTime);
  timings.total = totalTime;
  console.log("[GenerateUI] Full timing breakdown (ms):", timings);

  return {
    code: repairedValidation.valid ? repaired : "",
    validationPassed: repairedValidation.valid,
    repairAttempted: true,
    timestamp: Date.now(),
    errors: repairedValidation.valid ? [] : repairedValidation.errors,
  };
}

export function useUIGenerator() {
  const [state, setState] = useState<UIGeneratorState>({
    isGenerating: false,
    error: null,
    lastResult: null,
  });

  const activeRequestRef = useRef(0);

  const runGeneration = useCallback(async (request: UIGenerationRequest) => {
    const requestId = activeRequestRef.current + 1;
    activeRequestRef.current = requestId;

    setState((prev) => ({ ...prev, isGenerating: true, error: null }));

    try {
      const result = await generateUI(request);
      if (activeRequestRef.current === requestId) {
        setState({ isGenerating: false, error: null, lastResult: result });
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (activeRequestRef.current === requestId) {
        setState((prev) => ({ ...prev, isGenerating: false, error: message }));
      }

      return {
        code: "",
        validationPassed: false,
        repairAttempted: false,
        timestamp: Date.now(),
        errors: [message],
      } satisfies UIGenerationResult;
    }
  }, []);

  return {
    ...state,
    generateUI: runGeneration,
  };
}
