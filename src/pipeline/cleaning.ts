import { aggressiveSanitize } from "../utils/codeSanitizer";
import { autoCloseJsx } from "../utils/jsxAutoFixer";

export function stripCodeFences(code: string): string {
  return code.replace(/```(?:tsx|ts|jsx|js)?/gi, "").replace(/```/g, "");
}

export function normalizeToAppExport(code: string): string {
  const trimmed = code.trim();

  // If already has the right export, return as-is
  if (/export\s+default\s+function\s+App\s*\(/i.test(trimmed)) {
    return trimmed;
  }

  // If has function App but no export, add the export
  if (/function\s+App\s*\(/i.test(trimmed)) {
    return `${trimmed}\n\nexport default App;`;
  }

  // If has const App but no export, add the export
  if (/const\s+App\s*=\s*/i.test(trimmed)) {
    return `${trimmed}\n\nexport default App;`;
  }

  // Otherwise, return the code as-is (don't fallback to generic UI)
  // Let validation catch the error so repair can handle it
  return trimmed;
}

export function cleanGeneratedCode(code: string): string {
  const stripped = stripCodeFences(code);
  const sanitized = aggressiveSanitize(stripped);
  const normalized = normalizeToAppExport(sanitized);
  return autoCloseJsx(normalized).trim();
}
