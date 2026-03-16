// cSpell:words peerjs webllm
import * as webllm from "@mlc-ai/web-llm";
import type { DataConnection } from "peerjs";
import type { SwarmTaskPayload } from "../hooks/useSwarm";

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
    return createFallbackTasks(llmOutput);
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
      return createFallbackTasks(llmOutput);
    }

    if (parsed.length === 0) {
      console.error("[JSONExtractor] Parsed array is empty");
      return createFallbackTasks(llmOutput);
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
      return createFallbackTasks(llmOutput);
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

    // Step 5: Return safe fallback
    return createFallbackTasks(llmOutput);
  }
}

/**
 * Create fallback tasks when JSON extraction fails
 * Returns a safe default task array so the app doesn't crash
 */
function createFallbackTasks(llmOutput: string): TaskAssignment[] {
  console.warn("[JSONExtractor] Using fallback task generation");

  // Create a single task that includes the full prompt
  return [
    {
      fileName: "generated/main.ts",
      instructions: `The AI returned an invalid response. Original output: ${llmOutput.substring(0, 500)}... Please implement the requested functionality in this file.`,
    },
  ];
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
 * This prompt instructs worker nodes to execute code generation tasks.
 */
export const WORKER_PROMPT = `You are a Code Generation AI Worker. Your role is to write ONLY the code requested - nothing else.

CRITICAL RULES:
1. Write ONLY code - no explanations, no markdown, no commentary
2. Follow the exact instructions provided
3. Generate production-ready, well-structured code
4. Include necessary imports and types
5. Do NOT include markdown code blocks (\`\`\` tags)
6. Start directly with the code
7. Consider the shared project context when writing your code

The code you generate will be written directly to a file, so it must be syntactically correct and complete.`;

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
    const completion = await engine.chat.completions.create({
      messages,
      temperature: 0.7,
      max_tokens: 1000, // Reduced from 2000 for faster decomposition
    });

    response = completion.choices[0]?.message?.content || "";
    console.log("[Orchestrator] AI Response received:", response.substring(0, 200) + "...");
  } catch (error) {
    console.error("[Orchestrator] Failed to get AI decomposition:", error);
    throw new Error("Failed to decompose task with AI");
  }

  // Step 2: Parse the JSON response using fault-tolerant extraction
  const tasks: TaskAssignment[] = extractAndParseJSON(response);

  console.log("[Orchestrator] Parsed tasks:", tasks);

  // Step 3: Distribute tasks to worker nodes (round-robin)
  if (activeConnections.length === 0) {
    console.warn(
      "[Orchestrator] No active connections - cannot distribute tasks",
    );
    return [];
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
    console.log(`[Worker] Starting LLM generation for ${taskPayload.fileName}...`);
    const startTime = Date.now();
    
    const completion = await engine.chat.completions.create({
      messages,
      temperature: 0.3, // Lower temperature for more consistent code generation
      max_tokens: 800, // Reduced from 4000 for faster generation (~10-15 seconds)
    });

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
    console.error(
      `[Worker] Failed to execute task ${taskPayload.taskId}:`,
      error,
    );
    throw error;
  }
}

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

  private readonly TASK_TIMEOUT_MS = 60000; // 60 seconds

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

  clear() {
    // Clear all timeouts before clearing tasks
    this.tasks.forEach((_, taskId) => {
      this.clearTimeout(taskId);
    });
    this.tasks.clear();
  }
}
