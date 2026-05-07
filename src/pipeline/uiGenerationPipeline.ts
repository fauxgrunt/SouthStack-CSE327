import { generateUI, type UIGenerationResult } from "../hooks/useUIGenerator";
import type { UIGenerationRequest } from "./generateUIPrompt";

export interface GenerationPipelineOptions {
  onLog?: (
    stage: string,
    message: string,
    type?: "info" | "success" | "error" | "warning",
  ) => void;
  onCodeReady?: (code: string) => void;
}

export interface PhaseTimings {
  generation: number;
  validation: number;
  total: number;
  [key: string]: number;
}

export async function executeGeneration(
  request: UIGenerationRequest,
  options: GenerationPipelineOptions = {},
): Promise<UIGenerationResult & { phaseTimings?: PhaseTimings }> {
  const pipelineStart = performance.now();
  const timings: PhaseTimings = { generation: 0, validation: 0, total: 0 };

  options.onLog?.("pipeline", "Starting generation", "info");

  try {
    // Phase 1: Generate UI
    const genStart = performance.now();
    const result = await generateUI(request, {
      onLog: options.onLog,
    });
    const genDuration = Math.round(performance.now() - genStart);
    timings.generation = genDuration;
    options.onLog?.(
      "telemetry",
      `Generation phase completed in ${genDuration}ms`,
      "info",
    );

    // Phase 2: Validation
    const valStart = performance.now();
    const valDuration = Math.round(performance.now() - valStart);
    timings.validation = valDuration;

    options.onLog?.(
      "validation",
      result.validationPassed
        ? `Code validated successfully (${valDuration}ms)`
        : `Code required repair; using the repaired output (${valDuration}ms)`,
      result.validationPassed ? "success" : "warning",
    );

    // Callback with code
    options.onCodeReady?.(result.code);

    // Final timing summary
    const totalDuration = Math.round(performance.now() - pipelineStart);
    timings.total = totalDuration;

    console.log("[Telemetry] Phase timings (ms):", timings);
    console.log(
      "[Telemetry] Generation breakdown:",
      `Generation=${timings.generation}ms, Validation=${timings.validation}ms, Total=${timings.total}ms`,
    );

    options.onLog?.(
      "telemetry",
      `📊 Total generation time: ${totalDuration}ms (generation: ${genDuration}ms, validation: ${valDuration}ms)`,
      "success",
    );
    options.onLog?.("pipeline", "Generation complete", "success");

    return { ...result, phaseTimings: timings };
  } catch (error) {
    const totalDuration = Math.round(performance.now() - pipelineStart);
    console.error(
      "[Telemetry] Generation failed after " + totalDuration + "ms",
    );
    throw error;
  }
}
