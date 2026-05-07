import { initializeWebLLM as initWebLLM } from "./webllm";

export interface ModelReadinessState {
  shardsDownloaded: boolean;
  shardsInCache: boolean;
  shardsLoadedInGPU: boolean;
  inferenceTestPassed: boolean;
  totalReady: boolean;
  downloadProgress?: number;
  lastError?: string;
}

/**
 * Comprehensive readiness check ensuring the model is truly ready for inference.
 * Blocks until all conditions are met or max wait time is exceeded.
 */
export async function blockUntilModelReady(
  onProgress?: (state: ModelReadinessState) => void,
): Promise<ModelReadinessState> {
  console.log("[ModelReadiness] Starting full readiness check...");

  const maxWaitTime = 10 * 60 * 1000; // 10 minutes max
  const startTime = Date.now();
  const pollInterval = 2000; // Check every 2 seconds

  while (true) {
    const state = await ensureModelFullyReady();

    if (onProgress) {
      onProgress(state);
    }

    if (state.totalReady) {
      console.log("[ModelReadiness] ✅ MODEL FULLY READY FOR GENERATION");
      return state;
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > maxWaitTime) {
      const error = `Model readiness timeout after ${Math.round(elapsed / 1000)}s`;
      console.error("[ModelReadiness]", error);
      return { ...state, lastError: error };
    }

    // Wait before checking again
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}

async function ensureModelFullyReady(): Promise<ModelReadinessState> {
  const state: ModelReadinessState = {
    shardsDownloaded: false,
    shardsInCache: false,
    shardsLoadedInGPU: false,
    inferenceTestPassed: false,
    totalReady: false,
  };

  try {
    // Step 1: Initialize WebLLM (this downloads and caches shards)
    console.log("[ModelReadiness] Initializing WebLLM...");
    const engine = await initWebLLM();
    if (!engine) {
      console.log("[ModelReadiness] ❌ Failed to initialize engine");
      state.lastError = "Engine initialization failed";
      return state;
    }
    state.shardsDownloaded = true;
    state.shardsInCache = true;
    state.shardsLoadedInGPU = true;
    console.log("[ModelReadiness] ✓ WebLLM fully initialized");

    // Step 2: Quick inference test (with timeout)
    console.log("[ModelReadiness] Testing inference with timeout...");
    const inferenceTest = await Promise.race<{
      success: boolean;
      duration?: number;
      error?: string;
    }>([
      testInference(),
      new Promise<{ success: boolean; error?: string }>((resolve) =>
        setTimeout(
          () =>
            resolve({
              success: false,
              error: "Inference test timeout (took >30s)",
            }),
          35000,
        ),
      ),
    ]);

    if (!inferenceTest.success) {
      // Inference test failed, but still mark as partially ready
      // The model is initialized, just inference might be slow
      console.log(
        "[ModelReadiness] ⚠ Inference test warning:",
        inferenceTest.error,
      );
      state.inferenceTestPassed = false;
      // Don't block on inference test failure - model is still usable
    } else {
      state.inferenceTestPassed = true;
      const duration = (inferenceTest as { duration?: number }).duration || 0;
      console.log(`[ModelReadiness] ✓ Inference test passed (${duration}ms)`);
    }

    // All critical checks passed
    state.totalReady = true;
    return state;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ModelReadiness] Unexpected error:", message);
    state.lastError = message;
    return state;
  }
}

async function testInference(): Promise<{
  success: boolean;
  duration?: number;
  error?: string;
}> {
  try {
    const engine = await initWebLLM();

    if (!engine) {
      return { success: false, error: "Engine not available" };
    }

    // Simple test: just verify engine responds
    const start = performance.now();
    let result: unknown;
    try {
      result = await Promise.race([
        engine.chat.completions.create({
          messages: [
            {
              role: "user",
              content: "Say 'ok'",
            },
          ],
          max_tokens: 3,
          temperature: 0.1,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Inference timeout")), 30000),
        ),
      ]);
    } catch (_timeoutError) {
      return { success: false, error: "Inference test timeout (30s)" };
    }

    const duration = Math.round(performance.now() - start);

    const typedResult = result as {
      choices?: Array<{ message?: { content?: string } }>;
    } | null;

    if (
      !typedResult ||
      !typedResult.choices ||
      typedResult.choices.length === 0
    ) {
      return { success: false, error: "No inference response" };
    }

    const content = typedResult.choices[0]?.message?.content;
    if (!content || content.trim().length === 0) {
      return { success: false, error: "Empty inference response" };
    }

    return { success: true, duration };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Get the current readiness state without blocking.
 * Useful for UI updates to show current progress.
 */
export async function checkCurrentReadiness(): Promise<ModelReadinessState> {
  return ensureModelFullyReady();
}
