interface VisionApiResponse {
  uiPrompt?: string;
  description?: string;
  layoutPrompt?: string;
  prompt?: string;
  result?: string;
}

const DEFAULT_VISION_ENDPOINT = "/api/vision/extract-ui";
const DEFAULT_MAX_DIMENSION = 1280;
const DEFAULT_MAX_BASE64_BYTES = 1_500_000;

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

function readVisionPrompt(payload: VisionApiResponse): string | null {
  const candidates = [
    payload.uiPrompt,
    payload.layoutPrompt,
    payload.prompt,
    payload.description,
    payload.result,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function buildFallbackUiPrompt(): string {
  return [
    "Create a mobile-first React UI that mirrors the attached screenshot/mockup.",
    "Infer the visual structure, spacing, typography hierarchy, and component grouping from the image.",
    "Output a polished page with reusable sections, semantic HTML, and responsive behavior for narrow screens.",
    "Include all visible controls from the design (buttons, inputs, cards, navigation, labels, and helper text).",
  ].join(" ");
}

export async function extractUIFromImage(imageBase64: string): Promise<string> {
  const endpoint =
    import.meta.env.VITE_VISION_API_URL || DEFAULT_VISION_ENDPOINT;
  const apiKey = import.meta.env.VITE_VISION_API_KEY;

  try {
    const compressedImageBase64 = await compressBase64Image(imageBase64);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        imageBase64: compressedImageBase64,
        task: "extract-ui-layout",
      }),
    });

    if (!response.ok) {
      throw new Error(`Vision API returned status ${response.status}`);
    }

    const payload = (await response.json()) as VisionApiResponse;
    const extractedPrompt = readVisionPrompt(payload);

    if (!extractedPrompt) {
      throw new Error(
        "Vision API response did not contain a usable UI prompt.",
      );
    }

    return extractedPrompt;
  } catch {
    // Fallback keeps the generation flow alive while the API endpoint is stubbed.
    return buildFallbackUiPrompt();
  }
}
