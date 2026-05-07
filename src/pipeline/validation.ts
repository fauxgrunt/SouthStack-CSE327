import * as ts from "typescript";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateGeneratedCode(code: string): ValidationResult {
  const result = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: "App.tsx",
    reportDiagnostics: true,
  });

  const errors = (result.diagnostics ?? []).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      " ",
    );

    if (!diagnostic.file || diagnostic.start === undefined) {
      return message;
    }

    const position = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start,
    );
    return `${position.line + 1}:${position.character + 1} ${message}`;
  });

  if (!/export\s+default\s+(function\s+App|App)/i.test(code)) {
    errors.push("Generated code must export a default App component.");
  }

  if (!/function\s+App\s*\(|const\s+App\s*=/.test(code)) {
    errors.push("Generated code must define an App component.");
  }

  const defaultExportMatches = code.match(/export\s+default/gi) ?? [];
  if (defaultExportMatches.length !== 1) {
    errors.push("Generated code must contain exactly one default export.");
  }

  if (
    /from\s+[\"']react-dom[\"']/i.test(code) ||
    /from\s+[\"']react-dom\/client[\"']/i.test(code)
  ) {
    errors.push("Generated code must not import from react-dom.");
  }

  if (/<\/?[A-Z][A-Za-z0-9]*(?:\s|>|\/)/.test(code)) {
    errors.push(
      "Generated code must not use custom JSX components; use built-in HTML/SVG elements only.",
    );
  }

  const importLines = code
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("import "));

  for (const importLine of importLines) {
    if (!/from\s+[\"']react([\/]?[\w-]+)?[\"']/.test(importLine)) {
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
      <div className="max-w-md rounded-3xl border border-white/10 bg-white/5 p-8 text-center">
        <p className="text-xs uppercase tracking-[0.35em] text-cyan-300">Fallback UI</p>
        <h1 className="mt-3 text-3xl font-semibold">Generation failed</h1>
        <p className="mt-3 text-sm text-slate-300">The model output could not be validated. Try refining the prompt.</p>
      </div>
    </main>
  );
}`;
