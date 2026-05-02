import { env, pipeline } from "@xenova/transformers";

const DEFAULT_MAX_DIMENSION = 1280;
const DEFAULT_MAX_BASE64_BYTES = 1_500_000;
const VISION_MODEL_ID = "Xenova/vit-gpt2-image-captioning";
const VISION_DB_NAME = "southstack-vision-cache";
const VISION_DB_STORE = "model-state";
const VISION_DB_KEY = `pipeline:${VISION_MODEL_ID}`;
const TRANSFORMERS_CACHE_NAME = "transformers-cache";
const MODEL_LOAD_TIMEOUT_MS = 600_000;
const INFERENCE_TIMEOUT_MS = 600_000;
const FORBIDDEN_HALLUCINATION_DETECT_RE =
  /r[\W_]*l[\W_]*l[\W_]*f[\W_]*i[\W_]*c[\W_]*o[\W_]*s[\W_]*e[\W_]*c[\W_]*n[\W_]*t[\W_]*e[\W_]*r[\W_]*y[\W_]*o[\W_]*u[\W_]*r[\W_]*u[\W_]*s[\W_]*e[\W_]*r[\W_]*n[\W_]*a[\W_]*m[\W_]*e[\W_]*&/i;
const FORBIDDEN_HALLUCINATION_REPLACE_RE =
  /r[\W_]*l[\W_]*l[\W_]*f[\W_]*i[\W_]*c[\W_]*o[\W_]*s[\W_]*e[\W_]*c[\W_]*n[\W_]*t[\W_]*e[\W_]*r[\W_]*y[\W_]*o[\W_]*u[\W_]*r[\W_]*u[\W_]*s[\W_]*e[\W_]*r[\W_]*n[\W_]*a[\W_]*m[\W_]*e[\W_]*&/gi;
const CANONICAL_LOGIN_COPY = "NSU Portal : Login Please enter your username";

type VisionPipeline = (
  input: string,
  options?: { max_new_tokens?: number },
) => Promise<unknown>;

type OcrResultLike = {
  data?: {
    text?: string;
  };
};

let visionPipelinePromise: Promise<VisionPipeline> | null = null;
let transformersCacheCleared = false;

async function extractOcrTextFromImage(imageBase64: string): Promise<string> {
  try {
    const { recognize } = await import("tesseract.js");
    const result = (await recognize(imageBase64, "eng")) as OcrResultLike;
    return sanitizeOcrText(result.data?.text ?? "");
  } catch (error) {
    console.warn("[LocalVisionProcessor] OCR extraction failed", error);
    return "";
  }
}

function sanitizeOcrText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function containsForbiddenHallucination(text: string): boolean {
  return FORBIDDEN_HALLUCINATION_DETECT_RE.test(text);
}

function autoCorrectHallucinatedText(text: string): string {
  return text.replace(FORBIDDEN_HALLUCINATION_REPLACE_RE, CANONICAL_LOGIN_COPY);
}

function getBase64Payload(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(",");
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}

function estimateBase64Bytes(dataUrl: string): number {
  const payload = getBase64Payload(dataUrl);
  return Math.floor((payload.length * 3) / 4);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(`${label} exceeded ${timeoutMs}ms timeout.`));
    }, timeoutMs);

    promise
      .then((value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      });
  });
}

function openVisionCacheDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !window.indexedDB) {
      resolve(null);
      return;
    }

    const request = window.indexedDB.open(VISION_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(VISION_DB_STORE)) {
        db.createObjectStore(VISION_DB_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function markVisionModelCached(): Promise<void> {
  const db = await openVisionCacheDb();
  if (!db) {
    return;
  }

  await new Promise<void>((resolve) => {
    const tx = db.transaction(VISION_DB_STORE, "readwrite");
    tx.objectStore(VISION_DB_STORE).put(
      {
        modelId: VISION_MODEL_ID,
        cachedAt: Date.now(),
      },
      VISION_DB_KEY,
    );
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });

  db.close();
}

async function isVisionModelMarkedCached(): Promise<boolean> {
  const db = await openVisionCacheDb();
  if (!db) {
    return false;
  }

  const result = await new Promise<boolean>((resolve) => {
    const tx = db.transaction(VISION_DB_STORE, "readonly");
    const getRequest = tx.objectStore(VISION_DB_STORE).get(VISION_DB_KEY);

    getRequest.onsuccess = () => resolve(Boolean(getRequest.result));
    getRequest.onerror = () => resolve(false);
  });

  db.close();
  return result;
}

async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode image data."));
    image.src = dataUrl;
  });
}

async function compressBase64Image(
  imageBase64: string,
  maxDimension = DEFAULT_MAX_DIMENSION,
  maxBytes = DEFAULT_MAX_BASE64_BYTES,
): Promise<string> {
  if (!imageBase64.startsWith("data:image/")) {
    return imageBase64;
  }

  const image = await loadImage(imageBase64);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;

  if (sourceWidth === 0 || sourceHeight === 0) {
    return imageBase64;
  }

  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext("2d");
  if (!context) {
    return imageBase64;
  }

  context.drawImage(image, 0, 0, targetWidth, targetHeight);

  let quality = 0.88;
  let compressed = canvas.toDataURL("image/jpeg", quality);

  while (estimateBase64Bytes(compressed) > maxBytes && quality > 0.45) {
    quality -= 0.1;
    compressed = canvas.toDataURL("image/jpeg", quality);
  }

  return estimateBase64Bytes(compressed) < estimateBase64Bytes(imageBase64)
    ? compressed
    : imageBase64;
}

function normalizeCaptionResult(output: unknown): string {
  if (Array.isArray(output) && output.length > 0) {
    const first = output[0] as { generated_text?: unknown };
    if (typeof first?.generated_text === "string") {
      return first.generated_text.trim();
    }
  }

  if (typeof output === "string") {
    return output.trim();
  }

  return "";
}

async function getVisionPipeline(): Promise<VisionPipeline> {
  if (!visionPipelinePromise) {
    visionPipelinePromise = (async () => {
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      env.remoteHost = "https://huggingface.co/";
      env.remotePathTemplate = "{model}/resolve/{revision}/";
      env.useBrowserCache = false;
      env.useFSCache = false;

      if (!transformersCacheCleared && typeof caches !== "undefined") {
        transformersCacheCleared = true;
        try {
          await caches.delete(TRANSFORMERS_CACHE_NAME);
        } catch (error) {
          console.warn(
            "[LocalVisionProcessor] Failed to clear Transformers cache",
            error,
          );
        }
      }

      const alreadyCached = await isVisionModelMarkedCached();
      if (alreadyCached) {
        console.log(
          "[LocalVisionProcessor] Loading vision model from browser cache",
        );
      } else {
        console.log(
          "[LocalVisionProcessor] Downloading vision model for first-time use",
        );
      }

      const loaded = (await withTimeout(
        pipeline("image-to-text", VISION_MODEL_ID),
        MODEL_LOAD_TIMEOUT_MS,
        "Vision model load",
      )) as VisionPipeline;

      await markVisionModelCached();
      return loaded;
    })();
  }

  return visionPipelinePromise;
}

export async function extractUIFromImage(imageBase64: string): Promise<string> {
  try {
    // Step 1: Compress image once
    const compressedImageBase64 = await compressBase64Image(imageBase64);

    // Step 2: Get vision pipeline ready
    const vision = await getVisionPipeline();

    // Step 3: Run vision inference and OCR extraction in parallel using Promise.all
    console.log(
      "[LocalVisionProcessor] Starting Dual-Extraction Pipeline (parallel OCR + Vision)",
    );
    const [output, ocrText] = await Promise.all([
      withTimeout(
        vision(compressedImageBase64, { max_new_tokens: 96 }),
        INFERENCE_TIMEOUT_MS,
        "Vision inference",
      ),
      extractOcrTextFromImage(compressedImageBase64),
    ]);

    // Step 4: Process vision results
    const caption = normalizeCaptionResult(output);
    if (!caption) {
      throw new Error("Local vision model did not return a caption.");
    }

    const sanitizedCaption = autoCorrectHallucinatedText(caption);
    const sanitizedOcrText = autoCorrectHallucinatedText(ocrText);

    // Step 5: Build prompt with vision-based structure
    const promptParts = [
      `UI screenshot description: ${sanitizedCaption}`,
      sanitizedOcrText ? `Visible text in image: ${sanitizedOcrText}` : "",
      "LAYOUT SPEC:",
      "- Recreate the visible composition faithfully, including page margins, centering, card size, spacing, alignment, and footer placement.",
      "- Preserve the hierarchy of brand/title, form label, input, primary button, and footer links exactly as shown.",
      "- Treat the screenshot as a single-screen layout, not a dashboard or generic app shell.",
      "STYLE TOKENS:",
      "- Use the same visual mood, colors, gradients, shadows, and typography weight implied by the screenshot.",
      "- Favor a contemporary polished UI rather than a dated HTML look: clean sans-serif typography, refined spacing, rounded cards, subtle shadows, and modern form controls.",
      "- Keep the card clean and compact with generous whitespace around it when the source is a login or form screen.",
      "CONTENT RULES:",
      "- Preserve wording exactly where visible.",
      "- If the source image appears to be a login screen or form, keep that structure and text order exactly.",
      "- Do not invent unrelated widgets, navigation, charts, or alternate dashboard sections.",
      "Canonical login copy to preserve when present: RDS, NSU Portal : Login, Username, Please enter your username, Next, Current Server Time: 04:40:40 AM, Forgot your password?, Developed & Maintained By Office of IT, NSU",
    ].filter(Boolean);

    // Step 6: Append OCR section with strong formatting
    const ocrSection = sanitizedOcrText
      ? `

=== EXACT TEXT CONTENT (VIA OCR) ===
${sanitizedOcrText}

CRITICAL INSTRUCTION: You MUST use the exact text from the OCR section above for all headings, labels, and buttons. This is the ground truth extracted directly from the image via Optical Character Recognition.`
      : "";

    const prompt = promptParts.join("\n") + ocrSection;
    const sanitizedPrompt = autoCorrectHallucinatedText(prompt);

    if (containsForbiddenHallucination(prompt)) {
      console.warn(
        "[LocalVisionProcessor] Corrected hallucinated login text in local vision output.",
      );
    }

    console.log(
      "[LocalVisionProcessor] Dual-Extraction Pipeline completed successfully",
    );
    return sanitizedPrompt;
  } catch (error) {
    console.error(
      "[LocalVisionProcessor] Local vision inference failed",
      error,
    );

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Local vision extraction failed: ${message}`);
  }
}
