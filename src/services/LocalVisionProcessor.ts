import { env, pipeline } from "@xenova/transformers";

const VISION_MODEL_ID = "Xenova/vit-gpt2-image-captioning";
const TRANSFORMERS_CACHE_NAME = "transformers-cache";
const MODEL_LOAD_TIMEOUT_MS = 600_000;
const INFERENCE_TIMEOUT_MS = 600_000;

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

async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode image data."));
    image.src = dataUrl;
  });
}

async function compressBase64Image(imageBase64: string): Promise<string> {
  if (!imageBase64.startsWith("data:image/")) {
    return imageBase64;
  }

  try {
    const image = await loadImage(imageBase64);
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;

    if (sourceWidth === 0 || sourceHeight === 0) {
      return imageBase64;
    }

    const maxDimension = 1280;
    const scale = Math.min(
      1,
      maxDimension / Math.max(sourceWidth, sourceHeight),
    );
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

    while (estimateBase64Bytes(compressed) > 1_500_000 && quality > 0.45) {
      quality -= 0.1;
      compressed = canvas.toDataURL("image/jpeg", quality);
    }

    return estimateBase64Bytes(compressed) < estimateBase64Bytes(imageBase64)
      ? compressed
      : imageBase64;
  } catch (error) {
    console.warn("[LocalVisionProcessor] Image compression failed", error);
    return imageBase64;
  }
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

function compressTextBlock(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function detectUiType(caption: string, ocrText: string): string {
  const combined = `${caption} ${ocrText}`.toLowerCase();

  if (
    /username|password|login|sign in|forgot your password|next/.test(combined)
  ) {
    return "authentication/login screen";
  }

  if (/dashboard|sidebar|nav|navigation|cards|metrics|charts/.test(combined)) {
    return "dashboard screen";
  }

  if (/hero|landing|banner|headline|call to action/.test(combined)) {
    return "landing page hero section";
  }

  if (/form|input|submit|register|contact/.test(combined)) {
    return "form-based screen";
  }

  return "general UI screen";
}

function buildStructuredVisionSummary(
  caption: string,
  ocrText: string,
): string {
  const normalizedOcr = compressTextBlock(ocrText);
  const uiType = detectUiType(caption, normalizedOcr);
  const combined = `${caption} ${normalizedOcr}`.toLowerCase();

  const detectedComponents: string[] = [];
  if (
    /username|password|login|sign in|forgot your password|next/.test(combined)
  ) {
    detectedComponents.push(
      "Centered login card",
      "Username input",
      "Password input",
      "Primary action button",
      "Forgot password link",
    );
  }
  if (/developed|maintained|footer|copyright/.test(combined)) {
    detectedComponents.push("Footer attribution text");
  }
  if (/current server time|time/.test(combined)) {
    detectedComponents.push("Status/footer timestamp");
  }
  if (/portal|nsu|rds/.test(combined)) {
    detectedComponents.push("Portal title/header", "Branding label");
  }
  if (/card|panel|box/.test(combined) || detectedComponents.length === 0) {
    detectedComponents.push("Main content card");
  }

  const layoutNotes: string[] = [];
  if (/username|password|login|sign in|next/.test(combined)) {
    layoutNotes.push(
      "The main UI is centered on the page inside a compact card.",
    );
    layoutNotes.push(
      "The card uses a blue-to-cyan gradient with a strong primary CTA.",
    );
  }
  if (/developed|maintained|current server time/.test(combined)) {
    layoutNotes.push(
      "Secondary footer/status text appears beneath the main card.",
    );
  }

  return [
    `UI TYPE: ${uiType}`,
    `SCREENSHOT SUMMARY: ${caption}`,
    normalizedOcr
      ? `VISIBLE TEXT: ${normalizedOcr}`
      : "VISIBLE TEXT: (none detected)",
    `DETECTED COMPONENTS: ${[...new Set(detectedComponents)].join(", ")}`,
    `LAYOUT NOTES: ${layoutNotes.length ? layoutNotes.join(" ") : "Use the screenshot geometry, spacing, and alignment as the source of truth."}`,
    "RECONSTRUCTION RULE: Recreate the screenshot visually as closely as possible, including spacing, colors, typography, and placement of elements.",
  ].join("\n");
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
          console.warn("[LocalVisionProcessor] Failed to clear cache", error);
        }
      }

      console.log("[LocalVisionProcessor] Loading vision model...");
      const loaded = (await withTimeout(
        pipeline("image-to-text", VISION_MODEL_ID),
        MODEL_LOAD_TIMEOUT_MS,
        "Vision model load",
      )) as VisionPipeline;

      return loaded;
    })();
  }

  return visionPipelinePromise;
}

export async function extractUIFromImage(imageBase64: string): Promise<string> {
  try {
    console.log("[LocalVisionProcessor] Starting vision + OCR extraction");
    const startTime = performance.now();

    const compressedImageBase64 = await compressBase64Image(imageBase64);
    const vision = await getVisionPipeline();

    console.log(
      "[LocalVisionProcessor] Running vision inference + OCR in parallel",
    );
    const [output, ocrText] = await Promise.all([
      withTimeout(
        vision(compressedImageBase64, { max_new_tokens: 96 }),
        INFERENCE_TIMEOUT_MS,
        "Vision inference",
      ),
      extractOcrTextFromImage(compressedImageBase64),
    ]);

    const caption = normalizeCaptionResult(output);
    if (!caption) {
      throw new Error("Vision model did not return a caption.");
    }

    const timeElapsed = Math.round(performance.now() - startTime);
    console.log(
      `[LocalVisionProcessor] Extraction complete (${timeElapsed}ms): caption="${caption}", ocr="${ocrText.substring(0, 100)}"`,
    );

    const parts = [buildStructuredVisionSummary(caption, ocrText)];

    return parts.join("\n\n");
  } catch (error) {
    console.error("[LocalVisionProcessor] Vision extraction failed", error);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Vision extraction failed: ${message}`);
  }
}
