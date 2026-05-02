/**
 * Detects if a user prompt is a simple "build this" style request.
 * When combined with an attached image, skips task decomposition
 * and goes directly to code generation for faster turnaround.
 */

const BUILD_PROMPT_PATTERNS = [
  /^build\s+(this|it|that|a\s+ui|a\s+page|a\s+screen|me)?$/i,
  /^create\s+(this|it|that|a\s+ui|a\s+page|a\s+screen)?$/i,
  /^generate\s+(this|it|that|a\s+ui|a\s+page|a\s+screen)?$/i,
  /^make\s+(this|it|that|a\s+ui|a\s+page|a\s+screen)?$/i,
  /^implement\s+(this|it|that|a\s+ui|a\s+page|a\s+screen)?$/i,
  /^code\s+(this|it|that)?$/i,
  /^convert\s+to\s+react$/i,
  /^convert\s+to\s+code$/i,
  /^replicate\s+(this|it)?$/i,
  /^recreate\s+(this|it)?$/i,
  /^from\s+image$/i,
  /^build\.?$/i,
  /^create\.?$/i,
  /^generate\.?$/i,
];

/**
 * Check if a prompt is a simple "build this" style request.
 * These prompts indicate the user wants direct code generation from an image.
 *
 * @param prompt - The user's input prompt
 * @returns true if this is a "build this" style request, false otherwise
 */
export function isBuildThisPrompt(prompt: string): boolean {
  const normalized = prompt.trim();
  return BUILD_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Check if we should skip task decomposition and go directly to code generation.
 * This happens when:
 * 1. The prompt is a simple "build this" style request
 * 2. An image is attached (visual reference present)
 * 3. We're not in low-end mode
 *
 * @param prompt - The user's input prompt
 * @param hasAttachedImage - Whether an image is attached
 * @param lowEndMode - Whether running in low-end mode
 * @returns true if we should skip decomposition and go direct-to-code
 */
export function shouldSkipDecomposition(
  prompt: string,
  hasAttachedImage: boolean,
  lowEndMode: boolean = false,
): boolean {
  if (lowEndMode) {
    return false; // Always use task decomposition on low-end
  }

  if (!hasAttachedImage) {
    return false; // Need an image reference
  }

  return isBuildThisPrompt(prompt);
}

/**
 * Log the auto-detection decision for debugging.
 *
 * @param prompt - The user's input prompt
 * @param hasAttachedImage - Whether an image is attached
 * @param lowEndMode - Whether running in low-end mode
 * @param isSkipping - Whether we're skipping decomposition
 */
export function logAutoDetectionDecision(
  prompt: string,
  hasAttachedImage: boolean,
  lowEndMode: boolean,
  isSkipping: boolean,
): void {
  console.log(`[BuildPromptDetector] Analyzing: "${prompt}"`, {
    isBuildPrompt: isBuildThisPrompt(prompt),
    hasAttachedImage,
    lowEndMode,
    skippingDecomposition: isSkipping,
  });
}
