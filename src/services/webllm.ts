import * as webllm from "@mlc-ai/web-llm";

const MODEL_ID = "Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC";

let engineInstance: webllm.MLCEngine | null = null;
let engineInitPromise: Promise<webllm.MLCEngine> | null = null;

export async function initializeWebLLM(
  onProgress?: (report: webllm.InitProgressReport) => void,
): Promise<webllm.MLCEngine> {
  if (engineInstance) {
    if (onProgress) {
      engineInstance.setInitProgressCallback(onProgress);
    }

    return engineInstance;
  }

  if (engineInitPromise) {
    return engineInitPromise;
  }

  engineInitPromise = (async () => {
    const engine = new webllm.MLCEngine();

    if (onProgress) {
      engine.setInitProgressCallback(onProgress);
    }

    await engine.reload(MODEL_ID, {
      context_window_size: 2048,
    });

    engineInstance = engine;
    return engine;
  })();

  try {
    return await engineInitPromise;
  } finally {
    engineInitPromise = null;
  }
}

export async function generateWithWebLLM(
  userPrompt: string,
  systemPrompt: string,
  options?: {
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    onProgress?: (report: webllm.InitProgressReport) => void;
  },
): Promise<string> {
  const engine = await initializeWebLLM(options?.onProgress);
  const timeoutMs = options?.timeoutMs ?? 180000;
  const startedAt = performance.now();

  const completionPromise = engine.chat.completions.create({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: options?.temperature ?? 0.7,
    max_tokens: options?.maxTokens ?? 1500,
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(`[WebLLM] Generation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    completionPromise.finally(() => window.clearTimeout(timeoutId));
  });

  const completion = await Promise.race([completionPromise, timeoutPromise]);

  console.log(
    `[WebLLM] Generation completed in ${Math.round(performance.now() - startedAt)}ms`,
  );

  return completion.choices[0]?.message?.content?.trim() ?? "";
}

export function getWebLLMModelId(): string {
  return MODEL_ID;
}
