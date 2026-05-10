import { useCallback, useRef, useState } from "react";
import { extractUIFromImage } from "../services/LocalVisionProcessor";
import { generateWithGroq } from "../services/groqClient";
import { cleanGeneratedCode } from "../pipeline/cleaning";
import { type UIGenerationRequest } from "../pipeline/generateUIPrompt";
import {
  hasRenderableUiContent,
  validateGeneratedCode,
} from "../pipeline/validation";
import { assembleAtoms, type GeneratedAtom } from "../pipeline/atomAssembler";
import {
  buildAtomPrompt,
  buildAtomRepairPrompt,
} from "../pipeline/atomPromptBuilder";
import {
  decomposeUI,
  estimateAtomTokens,
  type UIAtom,
} from "../pipeline/uiDecomposer";
import { analyzeScreenshot } from "../pipeline/screenshotAnalyzer";
import { autoCloseJsx } from "../utils/jsxAutoFixer";

export interface UIGenerationOptions {
  onLog?: (
    stage: string,
    message: string,
    type?: "info" | "success" | "error" | "warning",
  ) => void;
}

export interface UIGenerationResult {
  code: string;
  validationPassed: boolean;
  repairAttempted: boolean;
  timestamp: number;
  errors: string[];
}

interface UIGeneratorState {
  isGenerating: boolean;
  error: string | null;
  lastResult: UIGenerationResult | null;
}

interface AtomRunResult {
  atom: UIAtom;
  code: string;
  repaired: boolean;
}

function buildGenerationContext(request: UIGenerationRequest): string {
  // Prioritize screenshot description (which includes detailed analysis if available)
  // over the text prompt
  const parts: string[] = [];

  if (request.screenshotDescription?.trim()) {
    parts.push(
      `CRITICAL: Screenshot context (source of truth):\n${request.screenshotDescription.trim()}`,
    );
  }

  if (request.prompt?.trim()) {
    parts.push(`User request: ${request.prompt.trim()}`);
  }

  if (request.previousCode?.trim()) {
    parts.push(`Previous code context: ${request.previousCode.trim()}`);
  }

  if (parts.length === 0) {
    parts.push("Generate a clean, modern UI component");
  }

  return parts.join("\n\n");
}

function buildDecompositionInput(request: UIGenerationRequest): string {
  return (
    request.screenshotDescription?.trim() ||
    request.prompt.trim() ||
    "build this"
  );
}

function getAtomGenerationOptions(atom: UIAtom) {
  switch (atom.complexity) {
    case "simple":
      return { temperature: 0.35, maxTokens: 220, timeoutMs: 45000 };
    case "medium":
      return { temperature: 0.45, maxTokens: 320, timeoutMs: 50000 };
    case "complex":
    default:
      return { temperature: 0.5, maxTokens: 420, timeoutMs: 60000 };
  }
}

function stripAtomImports(code: string): string {
  return code
    .split(/\r?\n/)
    .filter((line) => !/^\s*import\s+/.test(line))
    .join("\n")
    .trim();
}

function normalizeAtomCode(code: string, atom: UIAtom): string {
  let normalized = cleanGeneratedCode(code);
  normalized = stripAtomImports(normalized);

  if (/export\s+default\s+function\s+\w+/i.test(normalized)) {
    normalized = normalized.replace(
      /export\s+default\s+function\s+(\w+)/i,
      "export function $1",
    );
  }

  if (/export\s+default\s+\w+/i.test(normalized)) {
    normalized = normalized.replace(
      /export\s+default\s+(\w+)/i,
      "export function $1",
    );
  }

  if (!/export\s+function\s+\w+/i.test(normalized)) {
    const functionMatch = normalized.match(/function\s+(\w+)\s*\(/i);
    if (functionMatch) {
      normalized = normalized.replace(
        /function\s+(\w+)\s*\(/i,
        "export function $1(",
      );
    } else {
      normalized = `export function ${atom.type}() {\n  return <div className="p-4">${atom.description}</div>;\n}`;
    }
  }

  return normalized.trim();
}

function looksLikePlaceholderLayout(code: string): boolean {
  const emptyDivCount = (code.match(/<div\s*\/>/g) ?? []).length;
  return (
    emptyDivCount >= 2 &&
    !/<\s*(Header|Nav|Hero|Form|Card|Input|Button|Footer|App)\b/.test(code)
  );
}

async function generateAtom(
  atom: UIAtom,
  generationContext: string,
  onLog?: UIGenerationOptions["onLog"],
): Promise<AtomRunResult> {
  const { temperature, maxTokens, timeoutMs } = getAtomGenerationOptions(atom);
  const prompt = buildAtomPrompt(atom, generationContext);

  onLog?.(
    "atom",
    `Generating ${atom.type} atom (~${estimateAtomTokens(atom)} tokens expected)...`,
    "info",
  );

  let streamBuffer = "";
  let lastStreamEmit = performance.now();

  const raw = await generateWithGroq(prompt.user, prompt.system, {
    temperature,
    maxTokens,
    timeoutMs,
    onToken: (token, _accumulated, model) => {
      streamBuffer += token;
      const now = performance.now();
      const shouldFlush =
        /\n/.test(streamBuffer) ||
        streamBuffer.length >= 120 ||
        now - lastStreamEmit >= 350;

      if (shouldFlush) {
        const preview = streamBuffer.replace(/\s+/g, " ").trim();
        if (preview) {
          onLog?.(
            "stream",
            `${atom.type} ${model}: ${preview.slice(-140)}`,
            "info",
          );
        }
        streamBuffer = "";
        lastStreamEmit = now;
      }
    },
  });

  if (streamBuffer.trim()) {
    onLog?.(
      "stream",
      `${atom.type}: ${streamBuffer.trim().slice(-140)}`,
      "info",
    );
  }

  let code = normalizeAtomCode(raw, atom);
  let repaired = false;

  // Validate each atom code before assembly
  // If code has obvious JSX issues or is too short, attempt repair
  const hasJsxErrors =
    /Expected corresponding|Unexpected token|expected\)|expected\}|expected identifier/i.test(
      code,
    );
  const isTooShort = code.length < 50;
  const isValidExport = /export\s+function\s+\w+/i.test(code);

  if (
    !isValidExport ||
    isTooShort ||
    hasJsxErrors ||
    (code.includes("<") && !code.includes(">"))
  ) {
    onLog?.(
      "repair",
      `${atom.type} code has issues (length: ${code.length}, validExport: ${isValidExport}, hasErrors: ${hasJsxErrors}), attempting repair...`,
      "warning",
    );

    const repairPrompt = buildAtomRepairPrompt(atom, code, [
      "Code has JSX syntax errors or is incomplete. Fix all unclosed tags and broken expressions.",
    ]);

    const repairedRaw = await generateWithGroq(
      repairPrompt.user,
      repairPrompt.system,
      {
        temperature: 0.2,
        maxTokens,
        timeoutMs,
      },
    );

    code = normalizeAtomCode(repairedRaw, atom);
    repaired = true;
  }

  return {
    atom,
    code,
    repaired,
  };
}

export async function generateUI(
  request: UIGenerationRequest,
  options: UIGenerationOptions = {},
): Promise<UIGenerationResult> {
  const log = options.onLog;
  const startTime = performance.now();
  const timings: Record<string, number> = {};

  let t = performance.now();
  log?.("pipeline", "Starting generation pipeline...", "info");

  let screenshotDescription = request.screenshotDescription;
  let screenshotAnalysis = null;

  if (request.screenshot) {
    log?.(
      "vision",
      "Analyzing screenshot with detailed vision model...",
      "info",
    );
    const visionStart = performance.now();
    try {
      screenshotAnalysis = await analyzeScreenshot(request.screenshot);
      screenshotDescription = screenshotAnalysis.uiGenerationPrompt;
      const visionTime = Math.round(performance.now() - visionStart);
      timings.vision = visionTime;
      log?.(
        "vision",
        `Screenshot analyzed in detail: ${screenshotAnalysis.elements.length} UI elements detected, ${screenshotAnalysis.layout} layout (${visionTime}ms)`,
        "success",
      );
    } catch (error) {
      log?.(
        "vision",
        `Detailed analysis failed, using basic extraction: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      const basicStart = performance.now();
      screenshotDescription = await extractUIFromImage(request.screenshot);
      const visionTime = Math.round(performance.now() - basicStart);
      timings.vision = visionTime;
      log?.(
        "vision",
        `Screenshot analyzed with basic extraction (${visionTime}ms)`,
        "success",
      );
    }
  }

  log?.("prompt", "Building atom generation context...", "info");
  const generationContext = buildGenerationContext({
    ...request,
    screenshotDescription,
  });
  const promptTime = Math.round(performance.now() - t);
  timings.prompt = promptTime;

  log?.("atom", "Decomposing prompt into UI atoms...", "info");
  t = performance.now();
  const atoms = decomposeUI(
    buildDecompositionInput({
      ...request,
      screenshotDescription,
    }),
  );
  const atomTime = Math.round(performance.now() - t);
  timings.atoms = atomTime;
  log?.(
    "atom",
    `Decomposed into ${atoms.length} atoms (${atoms.map((atom) => atom.type).join(", ")})`,
    "success",
  );

  log?.("llm", "Generating atoms with Groq...", "info");
  t = performance.now();
  const generatedAtoms: GeneratedAtom[] = [];
  let atomRepairAttempted = false;

  for (const atom of atoms) {
    const result = await generateAtom(atom, generationContext, log);
    generatedAtoms.push({ atom: result.atom, code: result.code });
    atomRepairAttempted = atomRepairAttempted || result.repaired;
    log?.("llm", `${atom.type} generated`, "success");
  }

  const llmTime = Math.round(performance.now() - t);
  timings.llm = llmTime;
  log?.("llm", `Atom generation completed (${llmTime}ms)`, "success");

  log?.("assembly", "Assembling atoms into App component...", "info");
  t = performance.now();
  const assembledCode = assembleAtoms(generatedAtoms);
  const assemblyTime = Math.round(performance.now() - t);
  timings.assembly = assemblyTime;

  log?.("cleanup", "Cleaning assembled code...", "info");
  t = performance.now();
  const cleaned = cleanGeneratedCode(autoCloseJsx(assembledCode));
  const cleanupTime = Math.round(performance.now() - t);
  timings.cleanup = cleanupTime;

  log?.("validation", "Validating assembled code...", "info");
  t = performance.now();
  const validation = validateGeneratedCode(cleaned, request.prompt);
  const validationTime = Math.round(performance.now() - t);
  timings.validation = validationTime;

  // Expose assembled and cleaned code to logs when validation fails to aid debugging
  if (!validation.valid) {
    try {
      log?.(
        "debug",
        `ASSEMBLED_CODE_START\n${assembledCode}\nASSEMBLED_CODE_END`,
      );
      log?.("debug", `CLEANED_CODE_START\n${cleaned}\nCLEANED_CODE_END`);
      console.log("[GenerateUI][DEBUG] Assembled code:\n", assembledCode);
      console.log("[GenerateUI][DEBUG] Cleaned code:\n", cleaned);
    } catch (e) {
      // ignore logging errors
    }
    try {
      // expose last debugging artifacts to the page for automated capture
      (window as any).__agentic_debug_last = {
        assembledCode,
        cleanedCode: cleaned,
        prompt: request.prompt,
      } as any;
    } catch (e) {
      // ignore
    }
  }

  if (validation.valid) {
    log?.(
      "validation",
      `Generated code is valid (${validationTime}ms)`,
      "success",
    );
    const totalTime = Math.round(performance.now() - startTime);
    timings.total = totalTime;
    console.log("[GenerateUI] Timing breakdown (ms):", timings);
    return {
      code: cleaned,
      validationPassed: true,
      repairAttempted: atomRepairAttempted,
      timestamp: Date.now(),
      errors: [],
    };
  }

  const totalTime = Math.round(performance.now() - startTime);
  timings.total = totalTime;
  console.log("[GenerateUI] Full timing breakdown (ms):", timings);

  // Final repair attempt: ask the model to output a single `export default function App()`
  // that matches the assembled UI and fixes validation errors. This is a last-resort
  // recovery so users get a runnable preview instead of nothing.
  try {
    log?.("repair", "Attempting final assembly repair with LLM...", "info");

    const repairSystem = `You are a React+Tailwind code generator. Produce exactly one file: a single default-exported App component named App that returns valid JSX and matches the provided UI description. Do NOT include imports or explanations. Use Tailwind classes only. Preserve the existing atom layout and never replace real components with empty placeholder divs.`;

    const repairUser = `Generation context (source of truth):\n${generationContext}\n\nAssembled components (for reference):\n\n${cleaned}\n\nValidation errors:\n${validation.errors.join("\n")}\n\nInstructions: Produce a corrected single-file App component that:\n1. Fixes ALL validation errors\n2. Has properly closed JSX tags (no unclosed <div>, <input>, etc.)\n3. Has balanced parentheses and braces\n4. Preserves the visual layout and visible content\n5. Matches the generation context above (especially screenshot-derived details)\n6. Returns only the code for: export default function App() { ... }`;

    const repairedRaw = await generateWithGroq(repairUser, repairSystem, {
      temperature: 0.15,
      maxTokens: 1000,
      timeoutMs: 60000,
    });

    const repairedClean = cleanGeneratedCode(autoCloseJsx(repairedRaw));
    const repairedValidation = validateGeneratedCode(
      repairedClean,
      request.prompt,
    );

    const cleanedHasUsefulLayout =
      hasRenderableUiContent(cleaned) && !looksLikePlaceholderLayout(cleaned);
    const repairedLooksEmpty = looksLikePlaceholderLayout(repairedClean);

    if (repairedLooksEmpty && cleanedHasUsefulLayout) {
      log?.(
        "repair",
        "Repair output collapsed into placeholders; preserving assembled layout instead.",
        "warning",
      );
      return {
        code: cleaned,
        validationPassed: validation.valid || repairedValidation.valid,
        repairAttempted: true,
        timestamp: Date.now(),
        errors:
          validation.errors.length > 0
            ? validation.errors
            : repairedValidation.errors,
      };
    }

    if (repairedValidation.valid && hasRenderableUiContent(repairedClean)) {
      log?.("repair", "Final repair succeeded", "success");
      return {
        code: repairedClean,
        validationPassed: true,
        repairAttempted: true,
        timestamp: Date.now(),
        errors: [],
      };
    }

    // If repair still fails but cleaned is better than original, use it
    if (
      validation.errors.length <= repairedValidation.errors.length &&
      cleanedHasUsefulLayout
    ) {
      log?.(
        "repair",
        "Repair did not improve; returning best available code with errors.",
        "warning",
      );
      return {
        code: cleaned,
        validationPassed: false,
        repairAttempted: true,
        timestamp: Date.now(),
        errors: validation.errors,
      };
    }

    log?.(
      "repair",
      "Final repair did not pass validation; reporting explicit errors.",
      "error",
    );

    // Do NOT return a generic fallback UI. Surface exact validation and repair errors
    // so the user sees what went wrong and can iterate or inspect debug artifacts.
    const combinedErrors = [
      ...validation.errors,
      ...(repairedValidation?.errors ?? []),
    ].filter(Boolean);

    return {
      code: "",
      validationPassed: false,
      repairAttempted: true,
      timestamp: Date.now(),
      errors:
        combinedErrors.length > 0
          ? combinedErrors
          : [
              "Final repair did not succeed and no specific errors were returned by the LLM.",
            ],
    };
  } catch (rerr) {
    console.error("[GenerateUI] Final repair failed:", rerr);
    return {
      code: "",
      validationPassed: false,
      repairAttempted: atomRepairAttempted,
      timestamp: Date.now(),
      errors: validation.errors.concat([String(rerr)]),
    };
  }
}

export function useUIGenerator() {
  const [state, setState] = useState<UIGeneratorState>({
    isGenerating: false,
    error: null,
    lastResult: null,
  });

  const activeRequestRef = useRef(0);

  const runGeneration = useCallback(async (request: UIGenerationRequest) => {
    const requestId = activeRequestRef.current + 1;
    activeRequestRef.current = requestId;

    setState((prev) => ({ ...prev, isGenerating: true, error: null }));

    try {
      const result = await generateUI(request);
      if (activeRequestRef.current === requestId) {
        setState({ isGenerating: false, error: null, lastResult: result });
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (activeRequestRef.current === requestId) {
        setState((prev) => ({ ...prev, isGenerating: false, error: message }));
      }

      return {
        code: "",
        validationPassed: false,
        repairAttempted: false,
        timestamp: Date.now(),
        errors: [message],
      } satisfies UIGenerationResult;
    }
  }, []);

  return {
    ...state,
    generateUI: runGeneration,
  };
}
