export type FailedWorkerRecord = {
  id: string;
  timestamp: number;
  prompt?: string;
  error?: string;
  codeSnippet?: string;
  fullCode?: string;
};

const STORAGE_KEY = "southstack_failed_outputs";

export function saveFailedWorkerOutput(
  fullCode: string,
  error?: string,
  meta?: { prompt?: string },
): void {
  try {
    const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    const record: FailedWorkerRecord = {
      id: `failed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      prompt: meta?.prompt,
      error: error ? String(error).slice(0, 1000) : undefined,
      codeSnippet: fullCode.slice(0, 400),
      fullCode: typeof fullCode === "string" ? fullCode : String(fullCode),
    };

    existing.push(record);
    // Keep only last 50 entries
    const trimmed = existing.slice(-50);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    // Also emit a console message for developer visibility
    console.warn("[FailureCapture] Saved failed worker output:", record.id);
  } catch (e) {
    console.error("[FailureCapture] Failed to persist worker output", e);
  }
}

export function getFailedWorkerOutputs(): FailedWorkerRecord[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

export function clearFailedWorkerOutputs(): void {
  localStorage.removeItem(STORAGE_KEY);
}
