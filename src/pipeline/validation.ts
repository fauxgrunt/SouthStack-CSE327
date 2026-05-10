import * as ts from "typescript";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Detect if the prompt/code context requires form inputs.
 */
export function requiresFormInputs(prompt?: string): boolean {
  if (!prompt) return false;
  const formKeywords =
    /\b(login|sign in|authenticate|form|username|password|email|input|submit|register|credentials|sign-in)\b/i;
  return formKeywords.test(prompt);
}

/** Check if code contains input elements */
export function hasInputElements(code: string): boolean {
  return /<input\s+[^>]*type\s*=\s*["'](text|password|email|number|tel|search|url|date|time|checkbox|radio)["']/i.test(
    code,
  );
}

/** Check if code contains any form-like elements */
export function hasFormElements(code: string): boolean {
  return /<(form|input|textarea|select)[^>]*>/i.test(code);
}

export function hasRenderableUiContent(code: string): boolean {
  if (
    /<(h[1-6]|p|span|label|button|a|input|textarea|select|img|svg|form|nav|header|footer|main|section|article|aside|ul|ol|li)\b/i.test(
      code,
    )
  ) {
    return true;
  }

  return />\s*[^<\s][^<]*\s*</.test(code);
}

export function validateGeneratedCode(
  code: string,
  prompt?: string,
): ValidationResult {
  const result = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: "App.tsx",
    reportDiagnostics: true,
  });

  const errors: string[] = (result.diagnostics ?? []).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      " ",
    );
    if (!diagnostic.file || diagnostic.start === undefined) return message;
    const pos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${pos.line + 1}:${pos.character + 1} ${message}`;
  });

  if (!/export\s+default\s+/i.test(code)) {
    errors.push("Generated code must export a default App component.");
  }

  if (!/function\s+App\s*\(|const\s+App\s*=/.test(code)) {
    errors.push("Generated code must define an App component.");
  }

  const defaultExportMatches = code.match(/export\s+default/gi) ?? [];
  if (defaultExportMatches.length !== 1) {
    errors.push("Generated code must contain exactly one default export.");
  }

  if (/from\s+["']react-dom(\/client)?["']/i.test(code)) {
    errors.push("Generated code must not import from react-dom.");
  }

  if (!hasRenderableUiContent(code)) {
    errors.push(
      "Generated code must include visible UI content, not only empty layout wrappers.",
    );
  }

  // Semantic validation: if prompt mentions forms/login, ensure code has inputs
  if (prompt && requiresFormInputs(prompt)) {
    if (!hasInputElements(code)) {
      errors.push(
        "Generated code must include at least one <input> element (prompt mentions form/login/authentication).",
      );
    }
    if (!hasFormElements(code)) {
      errors.push(
        "Generated code must include form elements when prompt mentions authentication or data entry.",
      );
    }
  }

  const importLines = code
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("import "));

  for (const importLine of importLines) {
    if (!/from\s+["']react(\/.*)?["']/.test(importLine)) {
      errors.push(`Generated code contains a forbidden import: ${importLine}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export const FALLBACK_UI = `export default function App() {
  return (
    <main className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/5 p-8 shadow-2xl">
        <p className="text-xs uppercase tracking-[0.35em] text-cyan-300">Fallback UI</p>
        <h1 className="mt-3 text-2xl font-semibold">Generation needed repair</h1>
        <p className="mt-2 text-sm text-slate-300">Showing a safe fallback so you can keep iterating.</p>

        <form className="mt-6 space-y-4">
          <label className="block text-sm text-slate-200">
            Username
            <input
              type="text"
              className="mt-1 w-full rounded-xl border border-white/15 bg-slate-900/70 px-3 py-2 text-sm text-white outline-none"
              placeholder="you@example.com"
            />
          </label>
          <label className="block text-sm text-slate-200">
            Password
            <input
              type="password"
              className="mt-1 w-full rounded-xl border border-white/15 bg-slate-900/70 px-3 py-2 text-sm text-white outline-none"
              placeholder="••••••••"
            />
          </label>
          <button
            type="submit"
            className="w-full rounded-xl bg-cyan-400 px-4 py-2 font-semibold text-slate-950 hover:bg-cyan-300"
          >
            Continue
          </button>
        </form>
      </div>
    </main>
  );
}`;
