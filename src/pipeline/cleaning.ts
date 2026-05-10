import { aggressiveSanitize } from "../utils/codeSanitizer";
import { autoCloseJsx } from "../utils/jsxAutoFixer";

// Remove known forbidden imports locally to reduce trivial validation failures
function removeForbiddenImports(code: string): string {
  if (!code) return code;
  const lines = code.split(/\r?\n/);
  const allowedLines = lines.filter((line) => {
    // Remove imports from UI libraries that are forbidden in preview
    if (
      /from\s+["'](?:react-bootstrap|@fortawesome\/|@material-ui|antd|framer-motion)["']/.test(
        line,
      )
    ) {
      return false;
    }
    // Remove FontAwesome named imports
    if (/from\s+["']@fortawesome\//.test(line)) return false;
    return true;
  });
  return allowedLines.join("\n");
}

export function stripCodeFences(code: string): string {
  let stripped = code
    .replace(/```(?:tsx|ts|jsx|js)?/gi, "")
    .replace(/```/g, "");
  // Remove a leading single-word language label (e.g. "javascript ", "jsx ")
  stripped = stripped.replace(
    /^\s*(?:javascript|js|jsx|ts|tsx|python)\b\s*/i,
    "",
  );
  return stripped;
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
  const withoutForbidden = removeForbiddenImports(normalized);
  return autoCloseJsx(withoutForbidden).trim();
}
