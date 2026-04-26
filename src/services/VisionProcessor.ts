interface GeminiApiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

const DEFAULT_MAX_DIMENSION = 1280;
const DEFAULT_MAX_BASE64_BYTES = 1_500_000;
const GEMINI_FLASH_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

function getBase64Payload(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(",");
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}

function estimateBase64Bytes(dataUrl: string): number {
  const payload = getBase64Payload(dataUrl);
  return Math.floor((payload.length * 3) / 4);
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
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

function buildGeminiVisionPrompt(): string {
  return [
    "Act as a UI layout analyst.",
    "Extract only the visible structure of the screenshot in simple plain text.",
    "Return one concise description that names the layout, major regions, and visible components.",
    "Examples: 'Dashboard with a sidebar, 3 cards across the top, and a primary content table below.'",
    "Do not output code, markdown, bullets, JSON, or extra commentary.",
  ].join(" ");
}

function extractGeminiTextResponse(payload: GeminiApiResponse): string | null {
  const text = payload.candidates
    ?.flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text || "")
    .join("\n")
    .trim();

  return text && text.length > 0 ? text : null;
}

function resolveImageMimeType(dataUrl: string): string {
  const match = dataUrl.match(/^data:([^;]+);base64,/i);
  return match?.[1] || "image/jpeg";
}

export async function extractUIFromImage(imageBase64: string): Promise<string> {
  const API_KEY = "AIzaSyCpVrx-ZsyYi07eS9UdwNWAQeLfuPLnC3M";

  try {
    const compressedImageBase64 = await compressBase64Image(imageBase64);
    const base64Payload = getBase64Payload(compressedImageBase64);
    const mimeType = resolveImageMimeType(compressedImageBase64);
    const endpoint = `${GEMINI_FLASH_ENDPOINT}?key=${encodeURIComponent(API_KEY)}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: buildGeminiVisionPrompt() },
              {
                inlineData: {
                  mimeType,
                  data: base64Payload,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1200,
          candidateCount: 1,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "<no error body>");
      console.error(
        `❌ [VisionProcessor] Error: Gemini request failed with status ${response.status}. Body: ${errorText}`,
      );
      throw new Error(
        `Gemini API request failed with status ${response.status}: ${errorText}`,
      );
    }

    const payload = (await response.json()) as GeminiApiResponse;

    if (payload.error?.message) {
      throw new Error(`Gemini API error: ${payload.error.message}`);
    }

    const extractedPrompt = extractGeminiTextResponse(payload);

    if (!extractedPrompt) {
      throw new Error(
        "Gemini response did not contain a usable UI description.",
      );
    }

    return extractedPrompt.trim();
  } catch (error) {
    console.error("[VisionProcessor] Gemini vision call failed", error);
    throw error;
  }
}
