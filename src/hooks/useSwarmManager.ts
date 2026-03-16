import { useEffect, useCallback, useMemo, useRef, useState } from "react";
import * as webllm from "@mlc-ai/web-llm";
import type { DataConnection } from "peerjs";
import { useSwarm, SwarmTaskPayload, TaskCompletePayload } from "./useSwarm";
import {
  orchestrateSwarm,
  executeWorkerTask,
  SwarmTaskTracker,
  TaskAssignment,
} from "../services/swarmOrchestrator";

/**
 * Swarm Mode - Master or Worker
 */
export type SwarmMode = "master" | "worker" | "standalone";

/**
 * File Write Function Type
 */
export type FileWriteFunction = (
  fileName: string,
  content: string,
) => Promise<void>;

/**
 * Sequential File Write Queue
 *
 * Prevents concurrent write operations that can crash WebContainer
 * Processes file writes one at a time in FIFO order
 */
class FileWriteQueue {
  private queue: Array<{
    fileName: string;
    content: string;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private isProcessing = false;
  private writeFile: FileWriteFunction;

  constructor(writeFile: FileWriteFunction) {
    this.writeFile = writeFile;
  }

  /**
   * Add a file write operation to the queue
   */
  async enqueue(fileName: string, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ fileName, content, resolve, reject });
      console.log(
        `[FileQueue] Queued: ${fileName} (Queue size: ${this.queue.length})`,
      );
      this.processQueue();
    });
  }

  /**
   * Process the queue sequentially
   */
  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.queue.length > 0) {
      const operation = this.queue.shift();
      if (!operation) break;

      try {
        console.log(`[FileQueue] Writing: ${operation.fileName}`);
        await this.writeFile(operation.fileName, operation.content);
        console.log(`[FileQueue] Success: ${operation.fileName}`);
        operation.resolve();
      } catch (error) {
        console.error(`[FileQueue] Failed: ${operation.fileName}`, error);
        operation.reject(error as Error);
      }
    }

    this.isProcessing = false;
  }

  /**
   * Get current queue size
   */
  getQueueSize(): number {
    return this.queue.length;
  }
}

/**
 * useSwarmManager - Integrated hook for managing distributed AI task execution
 *
 * Handles both Master and Worker node functionality:
 * - Master: Decomposes tasks and distributes to workers
 * - Worker: Receives tasks, executes them, and sends results back
 */
export const useSwarmManager = (
  engine: webllm.MLCEngine | null,
  writeFile: FileWriteFunction,
) => {
  const swarm = useSwarm();
  const {
    activeConnectionCount,
    connectionStatus,
    connections,
    isInitialized,
    isMaster,
    onData,
    sendTaskToNode,
  } = swarm;

  const swarmMode = useMemo<SwarmMode>(() => {
    if (isMaster) {
      return "master";
    }

    if (activeConnectionCount > 0 || connectionStatus === "connected") {
      return "worker";
    }

    return "standalone";
  }, [isMaster, activeConnectionCount, connectionStatus]);

  const [isProcessing, setIsProcessing] = useState(false);
  const [currentTask, setCurrentTask] = useState<string | null>(null);
  const [distributedTasks, setDistributedTasks] = useState<TaskAssignment[]>(
    [],
  );

  const taskTrackerRef = useRef<SwarmTaskTracker>(new SwarmTaskTracker());
  const fileQueueRef = useRef<FileWriteQueue | null>(null);
  const activeTaskRef = useRef<string | null>(null); // Track active task to prevent state corruption
  const swarmModeRef = useRef<SwarmMode>(swarmMode);

  // Initialize file write queue
  if (!fileQueueRef.current) {
    fileQueueRef.current = new FileWriteQueue(writeFile);
  }

  /**
   * Handle task timeout - execute locally as fallback
   */
  const handleTaskTimeout = useCallback(
    async (taskId: string) => {
      if (!engine) {
        console.error(
          "[SwarmManager:Master] Cannot execute timed-out task: Engine not initialized",
        );
        taskTrackerRef.current.failTask(
          taskId,
          "Timeout - Engine not available for local execution",
        );
        return;
      }

      const task = taskTrackerRef.current.getTask(taskId);
      if (!task) {
        console.error(
          `[SwarmManager:Master] Cannot find timed-out task: ${taskId}`,
        );
        return;
      }

      console.log(
        `[SwarmManager:Master] Executing timed-out task locally: ${taskId}`,
      );
      setCurrentTask(`Fallback: ${task.assignment.fileName}`);

      try {
        // Create task payload for local execution
        const taskPayload: SwarmTaskPayload = {
          taskId,
          fileName: task.assignment.fileName,
          instructions: task.assignment.instructions,
          type: "TASK_ASSIGN",
        };

        // Execute locally
        const generatedCode = await executeWorkerTask(taskPayload, engine);

        // Queue the file write
        await fileQueueRef.current!.enqueue(
          task.assignment.fileName,
          generatedCode,
        );

        // Update tracker
        taskTrackerRef.current.completeTask(taskId, generatedCode);
        console.log(
          `[SwarmManager:Master] Successfully executed timed-out task locally: ${taskId}`,
        );
      } catch (error) {
        console.error(
          `[SwarmManager:Master] Failed to execute timed-out task locally: ${taskId}`,
          error,
        );
        taskTrackerRef.current.failTask(
          taskId,
          `Local execution failed: ${error}`,
        );
      } finally {
        setCurrentTask(null);
      }

      // Check if all tasks are complete
      if (taskTrackerRef.current.isAllCompleted()) {
        console.log(
          "[SwarmManager:Master] All tasks completed (including fallbacks)!",
        );
        setIsProcessing(false);
      }
    },
    [engine],
  );

  const createAndDispatchFallbackTask = useCallback(
    (userPrompt: string) => {
      const openConnections = connections.filter((c) => c.open);

      if (openConnections.length === 0) {
        throw new Error("No active worker connections");
      }

      const taskId = `task_raw_${Date.now()}`;
      const fallbackAssignment: TaskAssignment = {
        fileName: "swarm/raw-task.ts",
        instructions: userPrompt,
      };

      const payload: SwarmTaskPayload = {
        type: "TASK_ASSIGN",
        taskId,
        fileName: fallbackAssignment.fileName,
        instructions: fallbackAssignment.instructions,
        sharedContext:
          "Decomposition bypassed. Execute this as a direct single-task request.",
      };

      const targetConnection = openConnections[0];
      const sent = sendTaskToNode(targetConnection, payload);

      if (!sent) {
        throw new Error("Failed to dispatch fallback task");
      }

      console.warn(
        "[SwarmManager:Master] Decomposition bypass active - dispatched raw task",
        {
          taskId,
          nodeId: targetConnection.peer,
          fileName: fallbackAssignment.fileName,
        },
      );

      return [
        {
          taskId,
          assignment: fallbackAssignment,
          nodeId: targetConnection.peer,
        },
      ];
    },
    [connections, sendTaskToNode],
  );

  /**
   * Handle incoming data on Master Node
   */
  const handleMasterData = useCallback(
    async (data: unknown, conn: DataConnection) => {
      console.log("[SwarmManager:Master] Received data:", data);

      // Type guard
      if (typeof data === "object" && data !== null && "type" in data) {
        const genericPayload = data as { type: string; [key: string]: unknown };
        console.log(
          "[SwarmManager:Master] Parsed message type:",
          genericPayload.type,
        );

        // Handle task completion from worker
        if (genericPayload.type === "TASK_COMPLETE") {
          const payload = genericPayload as unknown as TaskCompletePayload;

          console.log(
            `[SwarmManager:Master] Task ${payload.taskId} completed by ${conn.peer}`,
          );
          console.log(
            `[SwarmManager:Master] Queueing file write: ${payload.fileName}`,
          );

          // Update tracker (this also clears the timeout)
          taskTrackerRef.current.completeTask(payload.taskId, payload.code);

          // Queue the file write (prevents concurrent write crashes)
          try {
            await fileQueueRef.current!.enqueue(payload.fileName, payload.code);
            console.log(
              `[SwarmManager:Master] Successfully wrote ${payload.fileName}`,
            );
          } catch (error) {
            console.error(
              `[SwarmManager:Master] Failed to write ${payload.fileName}:`,
              error,
            );
            taskTrackerRef.current.failTask(
              payload.taskId,
              `File write error: ${error}`,
            );
          }

          // Log progress
          const progress = taskTrackerRef.current.getProgress();
          console.log(
            `[SwarmManager:Master] Progress: ${progress.completed}/${progress.total} (${progress.percentage.toFixed(0)}%)`,
          );

          // Check if all tasks are complete
          if (taskTrackerRef.current.isAllCompleted()) {
            console.log("[SwarmManager:Master] All tasks completed!");
            setIsProcessing(false);
            setCurrentTask(null);
          }
        }

        // Handle status updates from worker
        if (
          genericPayload.type === "STATUS_UPDATE" &&
          "message" in genericPayload
        ) {
          console.log(
            `[SwarmManager:Master] Status update from ${conn.peer}:`,
            genericPayload.message,
          );
        }
      }
    },
    [],
  );

  /**
   * Handle incoming data on Worker Node
   */
  const handleWorkerData = useCallback(
    async (data: unknown, conn: DataConnection) => {
      console.log("[WORKER] Received routed data:", {
        fromPeer: conn.peer,
        data,
      });

      const resolvedData =
        typeof data === "object" && data !== null && "type" in data
          ? (() => {
              const typed = data as { type?: string; payload?: unknown };
              if (typed.type === "TASK_DISPATCH" && "payload" in typed) {
                return typed.payload;
              }
              return data;
            })()
          : data;

      // Type guard
      if (
        typeof resolvedData === "object" &&
        resolvedData !== null &&
        "type" in resolvedData
      ) {
        const genericPayload = resolvedData as {
          type: string;
          [key: string]: unknown;
        };
        console.log("[WORKER] Parsed message type:", genericPayload.type);

        // Handle task assignment
        if (
          genericPayload.type === "TASK_ASSIGN" ||
          genericPayload.type === "TASK_DISPATCH"
        ) {
          const payload = genericPayload as unknown as SwarmTaskPayload;

          console.log(
            `[WORKER] Task received: ${payload.taskId}, file: ${payload.fileName}`,
          );
          console.log(`[WORKER] Engine available: ${!!engine}`);
          console.log(
            `[WORKER] Currently processing: ${activeTaskRef.current}`,
          );

          if (activeTaskRef.current) {
            console.warn(
              `[WORKER] Already processing task ${activeTaskRef.current}, rejecting new task`,
            );
            return;
          }

          activeTaskRef.current = payload.taskId;
          console.log("[WORKER] State update -> isProcessing=true");
          setIsProcessing(true);
          console.log("[WORKER] State update -> currentTask set", {
            currentTask: `Generating ${payload.fileName}...`,
          });
          setCurrentTask(`Generating ${payload.fileName}...`);

          if (!engine) {
            console.error(
              "[WORKER] Engine not initialized; sending error response",
            );
            conn.send({
              type: "TASK_COMPLETE",
              taskId: payload.taskId,
              fileName: payload.fileName,
              code: "// Error: Engine not initialized",
              error: "Engine not initialized",
            });

            activeTaskRef.current = null;
            console.log("[WORKER] State update -> isProcessing=false");
            setIsProcessing(false);
            console.log("[WORKER] State update -> currentTask cleared");
            setCurrentTask(null);
            return;
          }

          console.log(
            `[WORKER] Starting execution of task ${payload.taskId}...`,
          );

          try {
            // Execute the task using local AI engine
            console.log("[WORKER] Calling executeWorkerTask...");
            const generatedCode = await executeWorkerTask(payload, engine);
            console.log(
              `[WORKER] Code generated successfully (${generatedCode.length} chars)`,
            );

            // Send result back to master
            const response: TaskCompletePayload = {
              type: "TASK_COMPLETE",
              taskId: payload.taskId,
              fileName: payload.fileName,
              code: generatedCode,
            };

            console.log(
              `[WORKER] Sending response back to master node ${conn.peer}`,
            );

            if (!conn.open) {
              console.error(
                "[WORKER] Connection to master closed before response",
              );
              activeTaskRef.current = null;
              console.log("[WORKER] State update -> isProcessing=false");
              setIsProcessing(false);
              console.log("[WORKER] State update -> currentTask cleared");
              setCurrentTask(null);
              return;
            }

            conn.send(response);
            console.log(
              `[WORKER] Task ${payload.taskId} completed and sent back`,
            );

            activeTaskRef.current = null;
            console.log("[WORKER] State update -> isProcessing=false");
            setIsProcessing(false);
            console.log("[WORKER] State update -> currentTask cleared");
            setCurrentTask(null);
            console.log("[WORKER] Ready for next task");
          } catch (error) {
            console.error(`[WORKER] Task ${payload.taskId} failed:`, error);

            // Send error back to master
            if (conn.open) {
              conn.send({
                type: "TASK_COMPLETE",
                taskId: payload.taskId,
                fileName: payload.fileName,
                code: `// Error generating code: ${error}`,
                error: String(error),
              });
            } else {
              console.error(
                "[WORKER] Cannot send error response - connection closed",
              );
            }

            activeTaskRef.current = null;
            console.log("[WORKER] State update -> isProcessing=false");
            setIsProcessing(false);
            console.log("[WORKER] State update -> currentTask cleared");
            setCurrentTask(null);
          }
        }
      } else {
        console.warn(
          "[WORKER] Ignoring message with unexpected format:",
          resolvedData,
        );
      }
    },
    [engine],
  );

  const handleMasterDataRef = useRef(handleMasterData);
  const handleWorkerDataRef = useRef(handleWorkerData);

  useEffect(() => {
    swarmModeRef.current = swarmMode;
  }, [swarmMode]);

  useEffect(() => {
    handleMasterDataRef.current = handleMasterData;
  }, [handleMasterData]);

  useEffect(() => {
    handleWorkerDataRef.current = handleWorkerData;
  }, [handleWorkerData]);

  const handleSwarmData = useCallback((data: unknown, conn: DataConnection) => {
    const mode = swarmModeRef.current;

    if (typeof data === "object" && data !== null && "type" in data) {
      const typed = data as { type?: string; payload?: unknown };

      if (typed.type === "TASK_DISPATCH" && typed.payload) {
        console.log("[SwarmManager] Routing TASK_DISPATCH to worker handler");
        void handleWorkerDataRef.current(typed.payload, conn);
        return;
      }

      if (typed.type === "TASK_ASSIGN") {
        console.log("[SwarmManager] Routing TASK_ASSIGN to worker handler");
        void handleWorkerDataRef.current(typed, conn);
        return;
      }

      if (typed.type === "TASK_COMPLETE" || typed.type === "STATUS_UPDATE") {
        console.log("[SwarmManager] Routing response/update to master handler");
        void handleMasterDataRef.current(typed, conn);
        return;
      }
    }

    if (mode === "master") {
      void handleMasterDataRef.current(data, conn);
      return;
    }

    if (mode === "worker") {
      void handleWorkerDataRef.current(data, conn);
    }
  }, []);

  /**
   * Register one stable data handler and route by latest mode
   */
  useEffect(() => {
    if (!isInitialized) {
      return;
    }

    console.log("[SwarmManager] Registering stable data dispatcher");
    onData(handleSwarmData);

    return () => {
      console.log("[SwarmManager] Cleaning up stable data dispatcher");
      onData(() => {
        // No-op handler to release references on unmount.
      });
    };
  }, [isInitialized, onData, handleSwarmData]);

  /**
   * Distribute a user request across the swarm (Master only)
   */
  const distributeTask = useCallback(
    async (userPrompt: string) => {
      if (activeConnectionCount === 0) {
        throw new Error("No active worker connections");
      }

      if (isProcessing) {
        throw new Error("Already processing a task");
      }

      setIsProcessing(true);
      setCurrentTask("Decomposing task...");
      taskTrackerRef.current.clear();

      try {
        console.log("[SwarmManager:Master] Starting task distribution...");
        console.log("[SwarmManager:Master] Distribution request:", {
          userPrompt,
          activeConnections: connections
            .filter((c) => c.open)
            .map((c) => c.peer),
        });

        let assignments: {
          taskId: string;
          assignment: TaskAssignment;
          nodeId: string;
        }[];

        if (!engine) {
          console.warn(
            "[SwarmManager:Master] Engine unavailable. Bypassing decomposition and dispatching raw task.",
          );
          assignments = createAndDispatchFallbackTask(userPrompt);
        } else {
          try {
            assignments = await Promise.race([
              orchestrateSwarm(
                userPrompt,
                engine,
                connections.filter((c) => c.open),
                sendTaskToNode,
              ),
              new Promise<never>((_, reject) => {
                setTimeout(() => {
                  reject(
                    new Error("Task decomposition timed out after 20 seconds"),
                  );
                }, 20000);
              }),
            ]);
          } catch (decompositionError) {
            console.error(
              "[SwarmManager:Master] Decomposition step failed. Falling back to raw dispatch.",
              decompositionError,
            );
            assignments = createAndDispatchFallbackTask(userPrompt);
          }
        }

        // Track all tasks and START TIMEOUT MONITORING
        assignments.forEach(({ taskId, assignment, nodeId }) => {
          console.log("[SwarmManager:Master] Assignment created:", {
            taskId,
            nodeId,
            fileName: assignment.fileName,
            instructions: assignment.instructions,
          });
          taskTrackerRef.current.addTask(taskId, assignment, nodeId);
          // Start timeout for this task
          taskTrackerRef.current.startTimeout(taskId, handleTaskTimeout);
        });

        setDistributedTasks(assignments.map((a) => a.assignment));
        setCurrentTask(`Distributed ${assignments.length} tasks`);

        console.log(
          `[SwarmManager:Master] Successfully distributed ${assignments.length} tasks with timeout monitoring`,
        );

        return assignments;
      } catch (error) {
        console.error(
          "[SwarmManager:Master] Failed to distribute task:",
          error,
        );
        setIsProcessing(false);
        setCurrentTask(null);
        throw error;
      }
    },
    [
      engine,
      activeConnectionCount,
      isProcessing,
      connections,
      sendTaskToNode,
      handleTaskTimeout,
      createAndDispatchFallbackTask,
    ],
  );

  /**
   * Execute a task locally (Standalone mode)
   */
  const executeLocalTask = useCallback(
    async (fileName: string, instructions: string) => {
      if (!engine) {
        throw new Error("Engine not initialized");
      }

      setIsProcessing(true);
      setCurrentTask(fileName);

      try {
        const taskPayload: SwarmTaskPayload = {
          taskId: `local_${Date.now()}`,
          fileName,
          instructions,
          type: "TASK_ASSIGN",
        };

        const code = await executeWorkerTask(taskPayload, engine);
        await writeFile(fileName, code);

        setIsProcessing(false);
        setCurrentTask(null);

        return code;
      } catch (error) {
        setIsProcessing(false);
        setCurrentTask(null);
        throw error;
      }
    },
    [engine, writeFile],
  );

  /**
   * Get task progress (Master only)
   */
  const getProgress = useCallback(() => {
    return taskTrackerRef.current.getProgress();
  }, []);

  /**
   * Get all task details (Master only)
   */
  const getAllTasks = useCallback(() => {
    return taskTrackerRef.current.getAllTasks();
  }, []);

  return {
    // Swarm state
    ...swarm,
    swarmMode,
    isProcessing,
    currentTask,
    distributedTasks,

    // Master functions
    distributeTask,
    getProgress,
    getAllTasks,

    // Standalone/Worker functions
    executeLocalTask,
  };
};
