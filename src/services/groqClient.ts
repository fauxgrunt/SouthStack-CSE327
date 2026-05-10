import Groq from "groq-sdk";

const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const FALLBACK_GROQ_MODELS = ["llama-3.1-8b-instant"];
const LAST_GROQ_MODEL = FALLBACK_GROQ_MODELS[FALLBACK_GROQ_MODELS.length - 1];

function resolveGroqApiKey(): string {
  const apiKey = import.meta.env.VITE_GROQ_API_KEY?.trim();
  return apiKey || "";
}

function resolveGroqModelCandidates(): string[] {
  const configuredModel = import.meta.env.VITE_GROQ_MODEL?.trim();
  return [
    ...(configuredModel ? [configuredModel] : []),
    DEFAULT_GROQ_MODEL,
    ...FALLBACK_GROQ_MODELS,
  ];
}

export function hasGroqApiKey(): boolean {
  return resolveGroqApiKey().length > 0;
}

export function assertGroqConfigured(): void {
  if (!hasGroqApiKey()) {
    throw new Error(
      "Groq API key not configured. Add VITE_GROQ_API_KEY to .env.local and restart the dev server.",
    );
  }
}

function createGroqClient(): Groq {
  assertGroqConfigured();
  return new Groq({
    apiKey: resolveGroqApiKey(),
    dangerouslyAllowBrowser: true,
  });
}

export interface GenerationOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  model?: string;
  onToken?: (token: string, accumulated: string, model: string) => void;
}

/**
 * Generate code using Groq's Mixtral model (free tier)
 * Supports up to 32K context window
 */
export async function generateWithGroq(
  userPrompt: string,
  systemPrompt: string,
  options: GenerationOptions = {},
): Promise<string> {
  const {
    temperature = 0.7,
    maxTokens = 1024,
    timeoutMs = 30000,
    model: requestedModel,
  } = options;

  try {
    const groq = createGroqClient();

    const modelCandidates = [
      ...(requestedModel ? [requestedModel] : []),
      ...resolveGroqModelCandidates(),
    ];

    for (const model of modelCandidates) {
      // Create abort controller for timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const stream = (await groq.chat.completions.create(
          {
            messages: [
              {
                role: "system",
                content: systemPrompt,
              },
              {
                role: "user",
                content: userPrompt,
              },
            ],
            model,
            max_tokens: maxTokens,
            temperature,
            stream: true,
          },
          {
            signal: controller.signal as any,
          } as any,
        )) as AsyncIterable<{
          choices?: Array<{
            delta?: {
              content?: string;
            };
          }>;
        }>;

        let content = "";
        for await (const chunk of stream) {
          const token = chunk.choices?.[0]?.delta?.content ?? "";
          if (token) {
            content += token;
            options.onToken?.(token, content, model);
          }
        }

        if (!content) {
          throw new Error("Empty response from Groq API");
        }

        return content;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isModelDeprecated =
          message.includes("model_decommissioned") ||
          message.includes("decommissioned") ||
          message.includes("no longer supported");

        if (isModelDeprecated && model !== LAST_GROQ_MODEL) {
          continue;
        }

        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error(
      "Groq generation failed: no supported models were available.",
    );
  } catch (error) {
    if (error instanceof Error) {
      if (
        error.message.includes("api_key") ||
        error.message.includes("GROQ_API_KEY")
      ) {
        throw new Error(
          "Groq API key not configured. Add VITE_GROQ_API_KEY to .env.local and restart the dev server.",
        );
      }
      throw new Error(`Groq generation failed: ${error.message}`);
    }
    throw error;
  }
}
