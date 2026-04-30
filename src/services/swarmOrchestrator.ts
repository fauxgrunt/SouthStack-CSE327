// cSpell:words peerjs webllm
import * as webllm from "@mlc-ai/web-llm";
import { MODEL_CONFIGS } from "../hooks/useAgenticLoop";
import type { DataConnection } from "peerjs";
import type { SwarmTaskPayload } from "../hooks/useSwarm";

export interface DebugSourceFile {
  fileName: string;
  content: string | Iterable<string> | AsyncIterable<string>;
}

export interface DebugChunkBuildOptions {
  chunkSize?: number;
  sessionId?: string;
}

const DEBUG_ANALYSIS_PROMPT = `You are a senior performance and reliability engineer.
Analyze the provided code chunk and output concise findings with:
1) BUGS: concrete correctness issues
2) BOTTLENECKS: performance or scalability concerns
3) RISKS: reliability/security/maintainability risks
4) ACTIONS: prioritized fixes with short rationale

Respond in plain text with clear headings.`;

const STRICT_MODEL_LOAD_ERRORS = {
  blueprint: "INSUFFICIENT VRAM: Cannot load 3B Vision Blueprint Model",
  coder: "INSUFFICIENT VRAM: Cannot load 7B Coder Model",
} as const;
const BLUEPRINT_STAGE_TIMEOUT_MS = 300000;
const CODER_STAGE_TIMEOUT_MS = 300000;

function isAllocationFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /vram|memory|allocation|out of memory|webgpu/i.test(message);
}

function normalizeWorkerModelError(
  error: unknown,
  fallbackMessage: string,
  strictMessage: string,
): string {
  if (isAllocationFailure(error)) {
    return strictMessage;
  }

  const message = error instanceof Error ? error.message : String(error);
  return `${fallbackMessage}: ${message}`;
}

function isWorkerPreloadFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch\.worker\.js|preload|pre-loading|pre loading|failed to fetch|worker bootstrap/i.test(
    message,
  );
}

function buildPromptFirstBlueprint(taskPayload: SwarmTaskPayload): string {
  const summary = taskPayload.instructions
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);

  return JSON.stringify(
    {
      version: "1.0",
      title: "Low-end prompt-first blueprint",
      subtitle:
        "Recreate the visible UI faithfully using the task instructions and shared context.",
      sections: [
        {
          id: "primary",
          type: "hero",
          heading: "Match the screenshot composition",
          body: "Preserve spacing, alignment, card geometry, colors, and footer placement from the provided reference.",
          items: [summary],
        },
      ],
      cta: {
        label: taskPayload.sharedContext?.trim() ? "Build UI" : "Next",
      },
    },
    null,
    2,
  );
}

async function createCompletionWithWorkerGuard<T>(
  promiseFactory: () => Promise<T>,
  label: string,
  timeoutMs = 25000,
): Promise<T | null> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new Error(`${label} timed out while waiting for worker startup.`),
        );
      }, timeoutMs);
    });

    return (await Promise.race([promiseFactory(), timeoutPromise])) as T;
  } catch (error) {
    if (isWorkerPreloadFailure(error)) {
      console.warn(
        `[WorkerGuard] ${label} preload failure; continuing without blocking.`,
        error,
      );
      return null;
    }

    throw error;
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<string> {
  return (
    typeof value === "object" && value !== null && Symbol.asyncIterator in value
  );
}

function isIterable(value: unknown): value is Iterable<string> {
  return (
    typeof value === "object" && value !== null && Symbol.iterator in value
  );
}

async function* streamTextChunks(
  content: string | Iterable<string> | AsyncIterable<string>,
  chunkSize: number,
): AsyncGenerator<string> {
  if (typeof content === "string") {
    for (let i = 0; i < content.length; i += chunkSize) {
      yield content.slice(i, i + chunkSize);
    }
    return;
  }

  let buffer = "";

  if (isAsyncIterable(content)) {
    for await (const piece of content) {
      buffer += piece;
      while (buffer.length >= chunkSize) {
        yield buffer.slice(0, chunkSize);
        buffer = buffer.slice(chunkSize);
      }
    }
  } else if (isIterable(content)) {
    for (const piece of content) {
      buffer += piece;
      while (buffer.length >= chunkSize) {
        yield buffer.slice(0, chunkSize);
        buffer = buffer.slice(chunkSize);
      }
    }
  }

  if (buffer.length > 0) {
    yield buffer;
  }
}

/**
 * Fault-Tolerant JSON Extraction
 *
 * Extracts and parses JSON from LLM output that may contain:
 * - Markdown code blocks (```json...```)
 * - Conversational prefix/suffix text
 * - Malformed JSON
 *
 * @param llmOutput - Raw output from the LLM
 * @returns Parsed TaskAssignment array or safe default
 */
export function extractAndParseJSON(llmOutput: string): TaskAssignment[] {
  console.log("[JSONExtractor] Attempting to extract JSON from LLM output...");

  let jsonString = llmOutput;

  // Step 1: Remove markdown code blocks if present
  // Handles: ```json\n[...]\n``` or ```\n[...]\n```
  const markdownMatch = jsonString.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (markdownMatch) {
    jsonString = markdownMatch[1].trim();
    console.log("[JSONExtractor] Removed markdown code block wrapper");
  }

  // Step 2: Find the first [ and last ] to extract the JSON array
  const firstBracket = jsonString.indexOf("[");
  const lastBracket = jsonString.lastIndexOf("]");

  if (
    firstBracket === -1 ||
    lastBracket === -1 ||
    firstBracket >= lastBracket
  ) {
    console.error("[JSONExtractor] No valid JSON array brackets found");
    throw new Error("Task decomposition did not produce a valid JSON array.");
  }

  jsonString = jsonString.substring(firstBracket, lastBracket + 1);
  console.log(
    "[JSONExtractor] Extracted array:",
    jsonString.substring(0, 100) + "...",
  );

  // Step 3: Attempt to parse JSON
  try {
    const parsed = JSON.parse(jsonString);

    // Validate structure
    if (!Array.isArray(parsed)) {
      console.error("[JSONExtractor] Parsed result is not an array");
      throw new Error("Task decomposition payload is not an array.");
    }

    if (parsed.length === 0) {
      console.error("[JSONExtractor] Parsed array is empty");
      throw new Error("Task decomposition returned zero tasks.");
    }

    // Validate each task has required fields
    const validTasks = parsed.filter((task) => {
      if (!task.fileName || !task.instructions) {
        console.warn("[JSONExtractor] Skipping invalid task:", task);
        return false;
      }
      return true;
    });

    if (validTasks.length === 0) {
      console.error("[JSONExtractor] No valid tasks found after filtering");
      throw new Error("Task decomposition returned invalid task entries.");
    }

    console.log(
      `[JSONExtractor] Successfully extracted ${validTasks.length} valid tasks`,
    );
    return validTasks;
  } catch (error) {
    console.error("[JSONExtractor] JSON parse failed:", error);

    // Step 4: Attempt basic cleanup and retry
    try {
      // Fix common JSON issues
      const cleanedJson = jsonString
        .replace(/,\s*]/g, "]") // Remove trailing commas
        .replace(/,\s*}/g, "}") // Remove trailing commas in objects
        .replace(/\n/g, " ") // Remove newlines
        .replace(/'/g, '"'); // Replace single quotes with double quotes

      const retryParsed = JSON.parse(cleanedJson);

      if (Array.isArray(retryParsed) && retryParsed.length > 0) {
        const validTasks = retryParsed.filter(
          (task) => task.fileName && task.instructions,
        );
        if (validTasks.length > 0) {
          console.log(
            `[JSONExtractor] Retry successful: ${validTasks.length} tasks`,
          );
          return validTasks;
        }
      }
    } catch (retryError) {
      console.error("[JSONExtractor] Retry parse also failed:", retryError);
    }

    throw new Error("Task decomposition JSON parse failed after retry.");
  }
}

/**
 * System Prompt for Swarm Manager
 *
 * This prompt instructs the AI to act as a technical project manager
 * that breaks down user requests into modular, independent tasks.
 */
export const SWARM_MANAGER_PROMPT = `You are a Technical Project Manager AI. Your role is to analyze user requests and break them down into modular, independent files or functions.

CRITICAL RULES:
1. Do NOT write any code yourself
2. Only decompose the task into smaller subtasks
3. Each subtask should be a single file or function
4. Make tasks as independent as possible to allow parallel execution
5. Output MUST be valid JSON only - no other text

OUTPUT FORMAT:
You must respond with ONLY a JSON array in this exact format:
[
  {
    "fileName": "components/Button.tsx",
    "instructions": "Create a reusable Button component with props for variant (primary, secondary), size (sm, md, lg), and onClick handler. Include TypeScript types."
  },
  {
    "fileName": "utils/validation.ts",
    "instructions": "Create email and password validation functions. Email should check format, password should check minimum 8 chars with at least one number."
  }
]

REQUIREMENTS:
- Each object must have exactly two keys: "fileName" and "instructions"
- fileName should be a valid file path with extension
- instructions should be clear, specific, and actionable
- Break complex tasks into 2-8 subtasks
- Ensure subtasks can be executed independently
- Do not include any explanation outside the JSON array`;

/**
 * System Prompt for Worker Nodes
 *
 * This prompt instructs worker nodes to execute the final React coding stage.
 */
export const WORKER_PROMPT = `You are a React code generator. Your ONLY goal is pixel-perfect visual fidelity.
Replicate the colors, layout, text, spacing, and visual hierarchy from the provided UI BLUEPRINT exactly using standard Tailwind CSS.
Generate one clean, static React component with export default function App().
Use only React imports. Do not add third-party packages.
Output ONLY raw JSX code with no explanations.`;

const VISION_BLUEPRINT_PROMPT = `You are the 3B vision blueprint stage in the SouthStack worker pipeline.
Return exactly one JSON object and nothing else.
Schema:
{
  "version": "1.0",
  "title": "string",
  "subtitle": "string (optional)",
  "sections": [
    {
      "id": "string",
      "type": "hero|cards|stats|features|timeline|faq",
      "heading": "string",
      "body": "string (optional)",
      "items": ["string"]
    }
  ],
  "cta": { "label": "string" }
}
Rules:
- Preserve the visible hierarchy, copy, spacing, and interaction cues from the prompt
- Do not generate JSX, markdown, or shell commands
- Do not invent generic dashboard sections or placeholder text`;

/**
 * Build worker prompt with shared context
 */
function buildWorkerPromptWithContext(sharedContext?: string): string {
  if (!sharedContext) {
    return WORKER_PROMPT;
  }

  return `${WORKER_PROMPT}

SHARED PROJECT CONTEXT:
${sharedContext}

Ensure your code integrates properly with the above context.`;
}

/**
 * Task Assignment Interface
 */
export interface TaskAssignment {
  fileName: string;
  instructions: string;
}

function extractFirstJsonObject(payload: string): string | null {
  const cleaned = payload
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  const start = cleaned.indexOf("{");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = start; index < cleaned.length; index += 1) {
    const ch = cleaned[index];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (ch === "\\") {
        isEscaped = true;
        continue;
      }

      if (ch === '"') {
        inString = false;
      }

      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return cleaned.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseVisionBlueprint(payload: string): string | null {
  const candidate = extractFirstJsonObject(payload);
  if (!candidate) {
    return null;
  }

  try {
    const parsed = JSON.parse(candidate) as {
      version?: unknown;
      title?: unknown;
      sections?: unknown;
    };

    if (parsed.version !== "1.0") {
      return null;
    }

    if (typeof parsed.title !== "string" || !parsed.title.trim()) {
      return null;
    }

    if (!Array.isArray(parsed.sections) || parsed.sections.length === 0) {
      return null;
    }

    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

export async function createDebugAnalysisPayloads(
  files: DebugSourceFile[],
  options: DebugChunkBuildOptions = {},
): Promise<SwarmTaskPayload[]> {
  const payloads: SwarmTaskPayload[] = [];

  for await (const payload of createDebugAnalysisPayloadStream(
    files,
    options,
  )) {
    payloads.push(payload);
  }

  return payloads;
}

export async function* createDebugAnalysisPayloadStream(
  files: DebugSourceFile[],
  options: DebugChunkBuildOptions = {},
): AsyncGenerator<SwarmTaskPayload> {
  const chunkSize = options.chunkSize ?? 12_000;
  const sessionId = options.sessionId ?? `debug_session_${Date.now()}`;
  let payloadIndex = 0;

  for (const file of files) {
    let chunkIndex = 0;

    for await (const chunk of streamTextChunks(file.content, chunkSize)) {
      const taskId = `debug_${Date.now()}_${payloadIndex}`;
      const payload: SwarmTaskPayload = {
        type: "DEBUG_ANALYSIS",
        taskId,
        fileName: file.fileName,
        instructions:
          "Analyze this chunk for bugs, bottlenecks, and reliability risks.",
        codeChunk: chunk,
        chunkIndex,
        sessionId,
      };

      yield payload;
      payloadIndex += 1;
      chunkIndex += 1;
    }
  }
}

/**
 * Orchestrate Swarm - Break down user prompt into tasks and distribute
 *
 * @param userPrompt - The user's request to break down
 * @param engine - The WebLLM MLCEngine instance
 * @param activeConnections - Array of active peer connections
 * @param sendTaskToNode - Function to send task to a specific node
 * @returns Array of task assignments and their assigned connection IDs
 */
export async function orchestrateSwarm(
  userPrompt: string,
  engine: webllm.MLCEngine,
  activeConnections: DataConnection[],
  sendTaskToNode: (conn: DataConnection, payload: SwarmTaskPayload) => boolean,
): Promise<{ taskId: string; assignment: TaskAssignment; nodeId: string }[]> {
  console.log("[Orchestrator] Starting task decomposition...");
  console.log("[Orchestrator] Active connections:", activeConnections.length);

  // Step 1: Use the AI to break down the user prompt
  const messages = [
    {
      role: "system" as const,
      content: SWARM_MANAGER_PROMPT,
    },
    {
      role: "user" as const,
      content: `Break down this request into modular tasks:\n\n${userPrompt}`,
    },
  ];

  let response: string;
  try {
    console.log("[Orchestrator] Requesting task decomposition from AI...");
    const completion = await createCompletionWithWorkerGuard(
      () =>
        engine.chat.completions.create({
          messages,
          temperature: 0.7,
          max_tokens: 1000, // Reduced from 2000 for faster decomposition
        }),
      `Task decomposition for ${userPrompt.slice(0, 32)}`,
    );

    if (!completion) {
      throw new Error("Failed to decompose task with AI");
    }

    response = completion.choices[0]?.message?.content || "";
    console.log(
      "[Orchestrator] AI Response received:",
      response.substring(0, 200) + "...",
    );
  } catch (error) {
    console.error("[Orchestrator] Failed to get AI decomposition:", error);
    throw new Error("Failed to decompose task with AI");
  }

  // Step 2: Parse the JSON response using fault-tolerant extraction
  const tasks: TaskAssignment[] = extractAndParseJSON(response);

  console.log("[Orchestrator] Parsed tasks:", tasks);

  // Step 3: Distribute tasks to worker nodes (round-robin)
  if (activeConnections.length === 0) {
    throw new Error(
      "No active worker connections available for swarm execution.",
    );
  }

  const assignments: {
    taskId: string;
    assignment: TaskAssignment;
    nodeId: string;
  }[] = [];

  // Create shared context from the original user prompt
  const sharedContext = `Original Request: ${userPrompt}\n\nThis file is part of a larger project. Ensure compatibility with other modules.`;

  tasks.forEach((task, index) => {
    // Round-robin assignment
    const connectionIndex = index % activeConnections.length;
    const targetConnection = activeConnections[connectionIndex];

    const taskId = `task_${Date.now()}_${index}`;

    const payload: SwarmTaskPayload = {
      taskId,
      fileName: task.fileName,
      instructions: task.instructions,
      type: "TASK_ASSIGN",
      sharedContext, // Include shared context
    };

    const success = sendTaskToNode(targetConnection, payload);

    if (success) {
      assignments.push({
        taskId,
        assignment: task,
        nodeId: targetConnection.peer,
      });
      console.log(
        `[Orchestrator] Task ${taskId} assigned to node ${targetConnection.peer}`,
      );
    } else {
      console.error(
        `[Orchestrator] Failed to assign task ${taskId} to node ${targetConnection.peer}`,
      );
    }
  });

  console.log(
    `[Orchestrator] Distributed ${assignments.length} tasks across ${activeConnections.length} nodes`,
  );

  return assignments;
}

/**
 * Execute task on local worker node
 *
 * @param taskPayload - The task to execute
 * @param engine - The WebLLM MLCEngine instance
 * @returns Generated code string
 */
export async function executeWorkerTask(
  taskPayload: SwarmTaskPayload,
  engine: webllm.MLCEngine,
): Promise<string> {
  console.log(`[Worker] Executing task ${taskPayload.taskId}...`);
  console.log(`[Worker] File: ${taskPayload.fileName}`);
  console.log(`[Worker] Instructions: ${taskPayload.instructions}`);

  // Build context-aware prompt
  const systemPrompt = buildWorkerPromptWithContext(taskPayload.sharedContext);

  const messages = [
    {
      role: "system" as const,
      content: systemPrompt,
    },
    {
      role: "user" as const,
      content: `File: ${taskPayload.fileName}\n\nInstructions: ${taskPayload.instructions}\n\nGenerate the complete code for this file:`,
    },
  ];

  try {
    console.log(
      `[Worker] Starting LLM generation for ${taskPayload.fileName}...`,
    );
    const startTime = Date.now();

    const completion = await createCompletionWithWorkerGuard(
      () =>
        engine.chat.completions.create({
          messages,
          temperature: 0.2, // Lower temperature for faster, more stable generation
          max_tokens: 720, // Keep the output compact for quicker streaming
        }),
      `Worker task ${taskPayload.taskId}`,
    );

    if (!completion) {
      return "";
    }

    const generatedCode = completion.choices[0]?.message?.content || "";
    const elapsed = Date.now() - startTime;

    // Clean up the code (remove markdown blocks if any)
    const cleanCode = generatedCode
      .replace(/```[\w]*\n/g, "")
      .replace(/```$/g, "")
      .trim();

    console.log(
      `[Worker] Task ${taskPayload.taskId} completed in ${elapsed}ms. Generated ${cleanCode.length} chars`,
    );

    return cleanCode;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(
      `[Worker] Failed to execute task ${taskPayload.taskId}:`,
      error,
    );

    if (isAllocationFailure(error)) {
      console.error(
        `[Worker] Allocation failure during task ${taskPayload.taskId}: ${msg}`,
      );
      // Return empty result so caller can handle it without crashing the worker.
      return "";
    }

    // For other errors, try to return partial output if available (none here), otherwise empty string.
    return "";
  }
}

export interface WorkerStreamingCallbacks {
  onLog?: (message: string) => void;
  onChunk?: (chunk: string) => void;
}

function extractStreamContentChunk(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const candidate = payload as {
    choices?: Array<{
      delta?: { content?: string };
      message?: { content?: string };
    }>;
  };

  const choice = candidate.choices?.[0];
  const delta = choice?.delta?.content;
  if (typeof delta === "string") {
    return delta;
  }

  const message = choice?.message?.content;
  if (typeof message === "string") {
    return message;
  }

  return "";
}

export async function executeWorkerTaskWithStreaming(
  taskPayload: SwarmTaskPayload,
  engine: webllm.MLCEngine,
  callbacks: WorkerStreamingCallbacks = {},
): Promise<string> {
  const emitLog = (message: string) => {
    callbacks.onLog?.(message);
    console.log(`[Worker:Stream] ${message}`);
  };

  emitLog("Task received. Warming up local AI engine...");
  emitLog("AI Engine active. Allocating GPU memory...");
  emitLog("Extracting Vision Blueprint...");

  let uiBlueprint = "{}";

  if (taskPayload.skipBlueprint) {
    emitLog(
      "Low-end mode active; skipping the 3B blueprint stage and using a prompt-first blueprint shell.",
    );
    uiBlueprint = buildPromptFirstBlueprint(taskPayload);
  } else {
    let blueprintCompletion: Awaited<
      ReturnType<typeof engine.chat.completions.create>
    > | null = null;
    try {
      blueprintCompletion = await createCompletionWithWorkerGuard(
        () =>
          engine.chat.completions.create({
            messages: [
              {
                role: "system" as const,
                content: VISION_BLUEPRINT_PROMPT,
              },
              {
                role: "user" as const,
                content: `File: ${taskPayload.fileName}\n\nInstructions: ${taskPayload.instructions}\n\nCreate the blueprint JSON now.`,
              },
            ],
            temperature: 0.05,
            top_p: 0.95,
            repetition_penalty: 1.15,
            frequency_penalty: 0.1,
            max_tokens: 640,
          }),
        `Worker blueprint ${taskPayload.taskId}`,
        BLUEPRINT_STAGE_TIMEOUT_MS,
      );

      if (!blueprintCompletion) {
        emitLog(
          "Worker blueprint initialization failed or timed out; continuing with empty blueprint.",
        );
      }
    } catch (error) {
      const message = normalizeWorkerModelError(
        error,
        "Worker vision blueprint generation failed",
        STRICT_MODEL_LOAD_ERRORS.blueprint,
      );
      emitLog(message);
      console.error(
        "[Worker:Stream] Blueprint error, continuing with empty blueprint:",
        error,
      );
    }

    const parsedBlueprint = parseVisionBlueprint(
      blueprintCompletion?.choices[0]?.message?.content || "",
    );

    if (!parsedBlueprint) {
      emitLog(
        "Vision blueprint parse failed; continuing with an empty blueprint shell.",
      );
    }

    uiBlueprint = parsedBlueprint || "{}";
  }

  emitLog("Vision blueprint extracted successfully.");
  emitLog("Loading 7B coder stage...");

  // Explicitly reload the 7B coder model after releasing 3B memory.
  emitLog("Generating React Architecture...");

  try {
    const reloadResult = await createCompletionWithWorkerGuard(
      async () => {
        await engine.reload(MODEL_CONFIGS["7B"].id);
        return true;
      },
      `Worker coder reload ${taskPayload.taskId}`,
      CODER_STAGE_TIMEOUT_MS,
    );

    if (!reloadResult) {
      emitLog(
        "7B coder load encountered a preload/runtime issue; continuing without blocking.",
      );
      return "";
    }
    emitLog("7B coder model loaded successfully.");
  } catch (err) {
    const message = normalizeWorkerModelError(
      err,
      "Failed to load 7B coder model",
      STRICT_MODEL_LOAD_ERRORS.coder,
    );
    emitLog(message);
    console.error("[Worker:Stream] Failed to reload 7B model:", err);
    return "";
  }

  const systemPrompt = buildWorkerPromptWithContext(taskPayload.sharedContext);
  const messages = [
    {
      role: "system" as const,
      content: systemPrompt,
    },
    {
      role: "user" as const,
      content: `UI BLUEPRINT:\n${uiBlueprint}\n\nFile: ${taskPayload.fileName}\n\nInstructions: ${taskPayload.instructions}\n\nGenerate the complete code for this file:`,
    },
  ];

  let streamResponse: unknown;
  try {
    streamResponse = (await createCompletionWithWorkerGuard(
      () =>
        engine.chat.completions.create({
          messages,
          temperature: 0.05,
          top_p: 0.95,
          repetition_penalty: 1.15,
          frequency_penalty: 0.1,
          max_tokens: 900,
          stream: true,
        }),
      `Streaming worker task ${taskPayload.taskId}`,
      CODER_STAGE_TIMEOUT_MS,
    )) as unknown;

    if (!streamResponse) {
      return "";
    }
  } catch (error) {
    const errorMsg = normalizeWorkerModelError(
      error,
      "Failed to generate code",
      STRICT_MODEL_LOAD_ERRORS.coder,
    );
    emitLog(errorMsg);
    console.error("[Worker:Stream] Engine error:", error);
    return "";
  }

  let generatedCode = "";

  try {
    if (streamResponse && Symbol.asyncIterator in Object(streamResponse)) {
      for await (const chunkPayload of streamResponse as AsyncIterable<unknown>) {
        const chunk = extractStreamContentChunk(chunkPayload);
        if (!chunk) {
          continue;
        }

        generatedCode += chunk;
        callbacks.onChunk?.(chunk);
      }
    } else {
      const singleChunk = extractStreamContentChunk(streamResponse);
      if (singleChunk) {
        generatedCode = singleChunk;
        callbacks.onChunk?.(singleChunk);
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    emitLog(`Stream iteration error: ${errorMsg}`);
    console.error("[Worker:Stream] Stream iteration error:", error);
    // Return partial generated code so far instead of failing hard.
    const partial = generatedCode.trim();
    if (partial) {
      emitLog("Returning partial generated code due to stream error.");
      return partial
        .replace(/```[\w]*\n/g, "")
        .replace(/```/g, "")
        .trim();
    }
    return "";
  }

  const cleanCode = generatedCode
    .replace(/```[\w]*\n/g, "")
    .replace(/```/g, "")
    .trim();

  if (!cleanCode) {
    emitLog("Worker stream produced an empty code payload.");
    return "";
  }

  return cleanCode;
}

export async function executeDebugAnalysisTask(
  taskPayload: SwarmTaskPayload,
  engine: webllm.MLCEngine,
): Promise<string> {
  const chunk = taskPayload.codeChunk ?? "";
  const chunkSize = chunk.length;

  console.log("[DebugWorker] Starting analysis", {
    taskId: taskPayload.taskId,
    fileName: taskPayload.fileName,
    chunkIndex: taskPayload.chunkIndex,
    chunkSize,
  });

  const messages = [
    {
      role: "system" as const,
      content: DEBUG_ANALYSIS_PROMPT,
    },
    {
      role: "user" as const,
      content: [
        `Session: ${taskPayload.sessionId ?? "unknown"}`,
        `File: ${taskPayload.fileName}`,
        `Chunk Index: ${taskPayload.chunkIndex ?? 0}`,
        "Code Chunk:",
        chunk,
      ].join("\n\n"),
    },
  ];

  const completion = await createCompletionWithWorkerGuard(
    () =>
      engine.chat.completions.create({
        messages,
        temperature: 0.1,
        max_tokens: 600,
      }),
    `Debug analysis ${taskPayload.taskId}`,
  );

  if (!completion) {
    return "No findings.";
  }

  return completion.choices[0]?.message?.content?.trim() || "No findings.";
}

export type SwarmTaskSnapshot = Array<{
  taskId: string;
  assignment: TaskAssignment;
  nodeId: string;
  status: "pending" | "completed" | "failed" | "timeout";
  code?: string;
  error?: string;
  timestamp: number;
}>;

/**
 * Create a completion tracker for managing distributed task results
 */
export class SwarmTaskTracker {
  private tasks: Map<
    string,
    {
      assignment: TaskAssignment;
      nodeId: string;
      status: "pending" | "completed" | "failed" | "timeout";
      code?: string;
      error?: string;
      timestamp: number;
      timeoutHandle?: ReturnType<typeof setTimeout>;
    }
  > = new Map();

  private readonly TASK_TIMEOUT_MS = 600000; // 10 minutes

  addTask(taskId: string, assignment: TaskAssignment, nodeId: string) {
    this.tasks.set(taskId, {
      assignment,
      nodeId,
      status: "pending",
      timestamp: Date.now(),
    });
  }

  /**
   * Start timeout monitoring for a task
   */
  startTimeout(taskId: string, onTimeout: (taskId: string) => void) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.timeoutHandle = setTimeout(() => {
      if (task.status === "pending") {
        console.warn(
          `[Tracker] Task ${taskId} timed out after ${this.TASK_TIMEOUT_MS}ms`,
        );
        task.status = "timeout";
        onTimeout(taskId);
      }
    }, this.TASK_TIMEOUT_MS);
  }

  /**
   * Clear timeout for a task (called when task completes)
   */
  clearTimeout(taskId: string) {
    const task = this.tasks.get(taskId);
    if (task?.timeoutHandle) {
      clearTimeout(task.timeoutHandle);
      task.timeoutHandle = undefined;
    }
  }

  completeTask(taskId: string, code: string) {
    const task = this.tasks.get(taskId);
    if (task) {
      this.clearTimeout(taskId);
      task.status = "completed";
      task.code = code;
      console.log(`[Tracker] Task ${taskId} marked as completed`);
    }
  }

  failTask(taskId: string, error: string) {
    const task = this.tasks.get(taskId);
    if (task) {
      this.clearTimeout(taskId);
      task.status = "failed";
      task.error = error;
      console.log(`[Tracker] Task ${taskId} marked as failed:`, error);
    }
  }

  /**
   * Mark task as timed out
   */
  timeoutTask(taskId: string) {
    const task = this.tasks.get(taskId);
    if (task) {
      this.clearTimeout(taskId);
      task.status = "timeout";
      task.error = "Task execution timed out";
      console.log(`[Tracker] Task ${taskId} marked as timed out`);
    }
  }

  getTask(taskId: string) {
    return this.tasks.get(taskId);
  }

  getAllTasks() {
    return Array.from(this.tasks.entries()).map(([id, task]) => ({
      taskId: id,
      ...task,
    }));
  }

  getPendingTasks() {
    return this.getAllTasks().filter((t) => t.status === "pending");
  }

  getPendingTasksForNode(nodeId: string) {
    return this.getPendingTasks().filter((t) => t.nodeId === nodeId);
  }

  reassignTask(taskId: string, nextNodeId: string) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return false;
    }

    this.clearTimeout(taskId);
    task.nodeId = nextNodeId;
    task.status = "pending";
    task.error = undefined;
    task.timestamp = Date.now();
    return true;
  }

  getCompletedTasks() {
    return this.getAllTasks().filter((t) => t.status === "completed");
  }

  getTimedOutTasks() {
    return this.getAllTasks().filter((t) => t.status === "timeout");
  }

  isAllCompleted() {
    return this.getAllTasks().every(
      (t) =>
        t.status === "completed" ||
        t.status === "failed" ||
        t.status === "timeout",
    );
  }

  getProgress() {
    const all = this.getAllTasks();
    const completed = all.filter((t) => t.status === "completed").length;
    return {
      total: all.length,
      completed,
      pending: all.filter((t) => t.status === "pending").length,
      failed: all.filter((t) => t.status === "failed").length,
      timedOut: all.filter((t) => t.status === "timeout").length,
      percentage: all.length > 0 ? (completed / all.length) * 100 : 0,
    };
  }

  toSnapshot(): SwarmTaskSnapshot {
    return this.getAllTasks().map((task) => ({
      taskId: task.taskId,
      assignment: task.assignment,
      nodeId: task.nodeId,
      status: task.status,
      code: task.code,
      error: task.error,
      timestamp: task.timestamp,
    }));
  }

  restoreFromSnapshot(snapshot: SwarmTaskSnapshot) {
    this.clear();

    snapshot.forEach((task) => {
      this.tasks.set(task.taskId, {
        assignment: task.assignment,
        nodeId: task.nodeId,
        status: task.status,
        code: task.code,
        error: task.error,
        timestamp: task.timestamp,
      });
    });
  }

  clear() {
    // Clear all timeouts before clearing tasks
    this.tasks.forEach((_, taskId) => {
      this.clearTimeout(taskId);
    });
    this.tasks.clear();
  }
}
