import { useEffect, useCallback, useMemo, useRef, useState } from "react";
import * as webllm from "@mlc-ai/web-llm";
import type { DataConnection } from "peerjs";
import {
  useSwarm,
  SwarmTaskPayload,
  TaskCompletePayload,
  SwarmStatePayload,
} from "./useSwarm";
import {
  createDebugAnalysisPayloadStream,
  DebugSourceFile,
  executeDebugAnalysisTask,
  orchestrateSwarm,
  executeWorkerTask,
  SwarmTaskTracker,
  SwarmTaskSnapshot,
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

const SWARM_TRACKER_STORAGE_KEY = "southstack.swarm.tracker.v1";
const SWARM_MASTER_LOST_STORAGE_KEY = "southstack.swarm.masterLost.v1";
const MAX_DEBUG_PREFETCH_WINDOW = 16;
const MIN_DEBUG_CHUNK_SIZE = 4000;
const MAX_DEBUG_CHUNK_SIZE = 64000;

interface PersistedSwarmState {
  savedAt: number;
  distributedTasks: TaskAssignment[];
  tracker: SwarmTaskSnapshot;
  debugQueue: SwarmTaskPayload[];
}

export interface ImageUiTaskMessage {
  type: "IMAGE_UI_TASK";
  taskId: string;
  prompt: string;
  imageBase64?: string;
  imageName?: string;
  imageDescription?: string;
}

export interface ImageUiStatusMessage {
  type: "IMAGE_UI_STATUS";
  taskId: string;
  message: string;
}

export interface ImageUiResultMessage {
  type: "IMAGE_UI_RESULT";
  taskId: string;
  prompt: string;
  code?: string;
  error?: string;
}

export interface WorkerLogMessage {
  type: "WORKER_LOG";
  taskId?: string;
  message: string;
}

export interface WorkerStreamMessage {
  type: "WORKER_STREAM";
  taskId?: string;
  chunk: string;
}

export interface WorkerCompleteMessage {
  type: "WORKER_COMPLETE";
  taskId?: string;
  code: string;
}

interface SwarmRoleSyncMessage {
  type: "SWARM_ROLE_SYNC";
  masterPeerId: string;
  sourceRole: "master" | "worker";
}

interface SwarmStateSyncMessage {
  type: "STATE";
  state: "ENGINE_READY";
}

type LocalRoleIntent = "auto" | "master" | "worker";

type ImageUiTaskHandler = (
  payload: ImageUiTaskMessage,
  conn: DataConnection,
) => void | Promise<void>;

type ImageUiStatusHandler = (
  payload: ImageUiStatusMessage,
  conn: DataConnection,
) => void | Promise<void>;

type ImageUiResultHandler = (
  payload: ImageUiResultMessage,
  conn: DataConnection,
) => void | Promise<void>;

type WorkerLogHandler = (
  payload: WorkerLogMessage,
  conn: DataConnection,
) => void | Promise<void>;

type WorkerStreamHandler = (
  payload: WorkerStreamMessage,
  conn: DataConnection,
) => void | Promise<void>;

type WorkerCompleteHandler = (
  payload: WorkerCompleteMessage,
  conn: DataConnection,
) => void | Promise<void>;

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
    onMasterLost,
    peerId,
    promoteToMaster,
    sendStateToNode,
    setWorkerMode,
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
  const debugQueueRef = useRef<SwarmTaskPayload[]>([]);
  const debugPayloadStreamRef = useRef<AsyncGenerator<SwarmTaskPayload> | null>(
    null,
  );
  const debugPayloadsGeneratedRef = useRef(0);
  const debugPayloadsDispatchedRef = useRef(0);
  const currentTaskRef = useRef<string | null>(null);
  const isProcessingRef = useRef(false);
  const inflightPayloadsRef = useRef<Map<string, SwarmTaskPayload>>(new Map());
  const dispatchCursorRef = useRef(0);
  const knownMasterPeerIdRef = useRef<string | null>(null);
  const localRoleIntentRef = useRef<LocalRoleIntent>("auto");
  const readyPeerIdsRef = useRef<Set<string>>(new Set());
  const openPeerSetRef = useRef<Set<string>>(new Set());
  const imageUiTaskHandlerRef = useRef<ImageUiTaskHandler | null>(null);
  const imageUiStatusHandlerRef = useRef<ImageUiStatusHandler | null>(null);
  const imageUiResultHandlerRef = useRef<ImageUiResultHandler | null>(null);
  const workerLogHandlerRef = useRef<WorkerLogHandler | null>(null);
  const workerStreamHandlerRef = useRef<WorkerStreamHandler | null>(null);
  const workerCompleteHandlerRef = useRef<WorkerCompleteHandler | null>(null);
  const handleTaskTimeoutRef = useRef<(taskId: string) => Promise<void>>(
    async () => {
      // no-op until callback is initialized
    },
  );

  const sendMessageToNode = useCallback(
    (conn: DataConnection, payload: unknown) => {
      if (!conn.open) {
        return false;
      }

      try {
        conn.send(payload);
        return true;
      } catch (error) {
        console.warn("[SwarmManager] Failed to send custom message", {
          peer: conn.peer,
          error,
        });
        return false;
      }
    },
    [],
  );

  const sendData = useCallback(
    (payload: unknown, targetPeerId?: string) => {
      const targetConnection = targetPeerId
        ? connections.find((conn) => conn.peer === targetPeerId && conn.open)
        : connections.find((conn) => conn.open);

      if (!targetConnection) {
        return false;
      }

      return sendMessageToNode(targetConnection, payload);
    },
    [connections, sendMessageToNode],
  );

  const syncSwarmRole = useCallback(
    (
      masterPeerId: string,
      targetPeerId?: string,
      sourceRole: "master" | "worker" = "master",
    ) => {
      if (!masterPeerId.trim()) {
        return false;
      }

      const payload: SwarmRoleSyncMessage = {
        type: "SWARM_ROLE_SYNC",
        masterPeerId,
        sourceRole,
      };

      return sendData(payload, targetPeerId);
    },
    [sendData],
  );

  const getReadyWorkerConnections = useCallback(() => {
    return connections.filter(
      (conn) => conn.open && readyPeerIdsRef.current.has(conn.peer),
    );
  }, [connections]);

  const sendImageUiTask = useCallback(
    (payload: ImageUiTaskMessage) => {
      const readyConnections = getReadyWorkerConnections();

      if (readyConnections.length === 0) {
        console.warn(
          "[SwarmManager] No ENGINE_READY worker available for image task dispatch",
          {
            connectedPeers: connections
              .filter((conn) => conn.open)
              .map((conn) => conn.peer),
            readyPeers: Array.from(readyPeerIdsRef.current),
          },
        );
        return false;
      }

      return sendMessageToNode(readyConnections[0], payload);
    },
    [connections, getReadyWorkerConnections, sendMessageToNode],
  );

  const setLocalRoleIntent = useCallback((intent: LocalRoleIntent) => {
    localRoleIntentRef.current = intent;
  }, []);

  const onImageUiTask = useCallback((handler: ImageUiTaskHandler | null) => {
    imageUiTaskHandlerRef.current = handler;
  }, []);

  const onImageUiStatus = useCallback(
    (handler: ImageUiStatusHandler | null) => {
      imageUiStatusHandlerRef.current = handler;
    },
    [],
  );

  const onImageUiResult = useCallback(
    (handler: ImageUiResultHandler | null) => {
      imageUiResultHandlerRef.current = handler;
    },
    [],
  );

  const onWorkerLog = useCallback((handler: WorkerLogHandler | null) => {
    workerLogHandlerRef.current = handler;
  }, []);

  const onWorkerStream = useCallback((handler: WorkerStreamHandler | null) => {
    workerStreamHandlerRef.current = handler;
  }, []);

  const onWorkerComplete = useCallback(
    (handler: WorkerCompleteHandler | null) => {
      workerCompleteHandlerRef.current = handler;
    },
    [],
  );

  // Initialize file write queue
  if (!fileQueueRef.current) {
    fileQueueRef.current = new FileWriteQueue(writeFile);
  }

  useEffect(() => {
    currentTaskRef.current = currentTask;
  }, [currentTask]);

  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  const getOpenConnections = useCallback(() => {
    return connections.filter((conn) => conn.open);
  }, [connections]);

  const pickNextOpenConnection = useCallback(
    (excludePeerId?: string) => {
      const openConnections = getOpenConnections().filter(
        (conn) => conn.peer !== excludePeerId,
      );

      if (openConnections.length === 0) {
        return null;
      }

      const index = dispatchCursorRef.current % openConnections.length;
      dispatchCursorRef.current += 1;
      return openConnections[index];
    },
    [getOpenConnections],
  );

  const buildTaskPayloadFromTracker = useCallback((taskId: string) => {
    const existing = inflightPayloadsRef.current.get(taskId);
    if (existing) {
      return existing;
    }

    const tracked = taskTrackerRef.current.getTask(taskId);
    if (!tracked) {
      return null;
    }

    return {
      taskId,
      type: taskId.startsWith("debug_") ? "DEBUG_ANALYSIS" : "TASK_ASSIGN",
      fileName: tracked.assignment.fileName,
      instructions: tracked.assignment.instructions,
    } as SwarmTaskPayload;
  }, []);

  const reassignPendingTasksForNode = useCallback(
    async (failedNodeId: string, reason: string) => {
      if (swarmModeRef.current !== "master") {
        return 0;
      }

      const pendingForNode =
        taskTrackerRef.current.getPendingTasksForNode(failedNodeId);

      if (pendingForNode.length === 0) {
        return 0;
      }

      let reassignedCount = 0;

      for (const task of pendingForNode) {
        const nextConn = pickNextOpenConnection(failedNodeId);
        if (!nextConn) {
          console.warn(
            "[SwarmManager:Master] No available workers for reassignment",
            {
              failedNodeId,
              taskId: task.taskId,
              reason,
            },
          );
          continue;
        }

        const payload = buildTaskPayloadFromTracker(task.taskId);
        if (!payload) {
          console.warn(
            "[SwarmManager:Master] Missing payload for reassignment",
            {
              taskId: task.taskId,
              failedNodeId,
            },
          );
          taskTrackerRef.current.failTask(
            task.taskId,
            `Unable to rebuild payload after worker loss (${failedNodeId})`,
          );
          continue;
        }

        const sent = sendTaskToNode(nextConn, payload);
        if (!sent) {
          continue;
        }

        taskTrackerRef.current.reassignTask(task.taskId, nextConn.peer);
        taskTrackerRef.current.startTimeout(task.taskId, (nextTaskId) => {
          void handleTaskTimeoutRef.current(nextTaskId);
        });
        inflightPayloadsRef.current.set(task.taskId, payload);
        reassignedCount += 1;

        console.warn("[SwarmManager:Master] Reassigned pending task", {
          taskId: task.taskId,
          from: failedNodeId,
          to: nextConn.peer,
          reason,
        });
      }

      if (reassignedCount > 0) {
        setCurrentTask(
          `Recovered ${reassignedCount} task(s) after worker drop`,
        );
      }

      return reassignedCount;
    },
    [buildTaskPayloadFromTracker, pickNextOpenConnection, sendTaskToNode],
  );

  const persistSwarmState = useCallback(() => {
    if (swarmModeRef.current !== "master") {
      return;
    }

    const snapshot: PersistedSwarmState = {
      savedAt: Date.now(),
      distributedTasks,
      tracker: taskTrackerRef.current.toSnapshot(),
      debugQueue: debugQueueRef.current,
    };

    localStorage.setItem(SWARM_TRACKER_STORAGE_KEY, JSON.stringify(snapshot));
  }, [distributedTasks]);

  useEffect(() => {
    const raw = localStorage.getItem(SWARM_TRACKER_STORAGE_KEY);

    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw) as PersistedSwarmState;

      if (Array.isArray(parsed.tracker) && parsed.tracker.length > 0) {
        taskTrackerRef.current.restoreFromSnapshot(parsed.tracker);
        setDistributedTasks(parsed.distributedTasks ?? []);
        debugQueueRef.current = parsed.debugQueue ?? [];
        debugPayloadStreamRef.current = null;

        if (parsed.tracker.some((task) => task.status === "pending")) {
          setIsProcessing(true);
          setCurrentTask("Resumed previous swarm session");
        }

        console.log("[SwarmManager] Restored persisted tracker state", {
          tasks: parsed.tracker.length,
          queuedDebugChunks: debugQueueRef.current.length,
          savedAt: parsed.savedAt,
        });
      }
    } catch (error) {
      console.warn(
        "[SwarmManager] Failed to restore persisted tracker state",
        error,
      );
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      if (swarmModeRef.current === "master") {
        persistSwarmState();
      }
    }, 5000);

    return () => {
      clearInterval(interval);
    };
  }, [persistSwarmState]);

  /**
   * Handle task timeout - execute locally as fallback
   */
  const handleTaskTimeout = useCallback(
    async (taskId: string) => {
      const tracked = taskTrackerRef.current.getTask(taskId);
      if (!tracked) {
        return;
      }

      const reassigned = await reassignPendingTasksForNode(
        tracked.nodeId,
        `timeout:${taskId}`,
      );
      if (reassigned > 0) {
        return;
      }

      if (taskId.startsWith("debug_")) {
        if (!engine) {
          taskTrackerRef.current.failTask(taskId, "Debug analysis timed out");
          inflightPayloadsRef.current.delete(taskId);
          return;
        }

        const payload = buildTaskPayloadFromTracker(taskId);
        if (!payload) {
          taskTrackerRef.current.failTask(
            taskId,
            "Debug analysis timed out and payload was unavailable",
          );
          inflightPayloadsRef.current.delete(taskId);
          return;
        }

        try {
          const analysis = await executeDebugAnalysisTask(payload, engine);
          taskTrackerRef.current.completeTask(taskId, analysis);
          inflightPayloadsRef.current.delete(taskId);

          const reportFileName = `debug-reports/${payload.fileName.replace(/[\\/:*?"<>|]/g, "_")}.chunk-${payload.chunkIndex ?? 0}.${taskId}.md`;
          await fileQueueRef.current!.enqueue(reportFileName, analysis);
        } catch (error) {
          taskTrackerRef.current.failTask(
            taskId,
            `Debug timeout fallback failed: ${error}`,
          );
        }

        persistSwarmState();
        return;
      }

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

      console.log(
        `[SwarmManager:Master] Executing timed-out task locally: ${taskId}`,
      );
      setCurrentTask(`Fallback: ${tracked.assignment.fileName}`);

      try {
        // Create task payload for local execution
        const taskPayload: SwarmTaskPayload = {
          taskId,
          fileName: tracked.assignment.fileName,
          instructions: tracked.assignment.instructions,
          type: "TASK_ASSIGN",
        };

        // Execute locally
        const generatedCode = await executeWorkerTask(taskPayload, engine);

        // Queue the file write
        await fileQueueRef.current!.enqueue(
          tracked.assignment.fileName,
          generatedCode,
        );

        // Update tracker
        taskTrackerRef.current.completeTask(taskId, generatedCode);
        inflightPayloadsRef.current.delete(taskId);
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

      persistSwarmState();
    },
    [
      engine,
      persistSwarmState,
      reassignPendingTasksForNode,
      buildTaskPayloadFromTracker,
    ],
  );

  useEffect(() => {
    handleTaskTimeoutRef.current = handleTaskTimeout;
  }, [handleTaskTimeout]);

  const createAndDispatchFallbackTask = useCallback(
    (userPrompt: string) => {
      const targetConnection = pickNextOpenConnection();

      if (!targetConnection) {
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
    [pickNextOpenConnection, sendTaskToNode],
  );

  const ensureDebugQueueBuffered = useCallback(async (targetSize: number) => {
    while (
      debugQueueRef.current.length < targetSize &&
      debugPayloadStreamRef.current
    ) {
      const next = await debugPayloadStreamRef.current.next();

      if (next.done) {
        debugPayloadStreamRef.current = null;
        break;
      }

      debugQueueRef.current.push(next.value);
      debugPayloadsGeneratedRef.current += 1;
    }
  }, []);

  const dispatchNextDebugChunk = useCallback(
    async (conn: DataConnection) => {
      if (!conn.open) {
        return false;
      }

      await ensureDebugQueueBuffered(1);

      const nextPayload = debugQueueRef.current.shift();

      if (!nextPayload) {
        return false;
      }

      const sent = sendTaskToNode(conn, nextPayload);

      if (!sent) {
        debugQueueRef.current.unshift(nextPayload);
        return false;
      }

      const assignment: TaskAssignment = {
        fileName: nextPayload.fileName,
        instructions: nextPayload.instructions,
      };

      taskTrackerRef.current.addTask(nextPayload.taskId, assignment, conn.peer);
      inflightPayloadsRef.current.set(nextPayload.taskId, nextPayload);
      taskTrackerRef.current.startTimeout(
        nextPayload.taskId,
        handleTaskTimeout,
      );
      debugPayloadsDispatchedRef.current += 1;

      console.log("[SwarmManager:Master] Dispatched debug chunk", {
        taskId: nextPayload.taskId,
        fileName: nextPayload.fileName,
        chunkIndex: nextPayload.chunkIndex,
        nodeId: conn.peer,
        bufferedChunks: debugQueueRef.current.length,
      });

      await ensureDebugQueueBuffered(4);
      persistSwarmState();
      return true;
    },
    [
      ensureDebugQueueBuffered,
      handleTaskTimeout,
      inflightPayloadsRef,
      persistSwarmState,
      sendTaskToNode,
    ],
  );

  const distributeDebugAnalysis = useCallback(
    async (
      files: DebugSourceFile[],
      options: {
        chunkSize?: number;
        sessionId?: string;
        prefetchWindow?: number;
      } = {},
    ) => {
      if (activeConnectionCount === 0) {
        throw new Error("No active worker connections");
      }

      if (isProcessing) {
        throw new Error("Already processing a task");
      }

      setIsProcessing(true);
      setCurrentTask("Preparing distributed debug analysis...");
      taskTrackerRef.current.clear();
      inflightPayloadsRef.current.clear();
      setDistributedTasks([]);
      debugPayloadsGeneratedRef.current = 0;
      debugPayloadsDispatchedRef.current = 0;

      const sessionId = options.sessionId ?? `debug_session_${Date.now()}`;
      const prefetchWindow = Math.max(
        1,
        Math.min(MAX_DEBUG_PREFETCH_WINDOW, options.prefetchWindow ?? 4),
      );
      debugPayloadStreamRef.current = createDebugAnalysisPayloadStream(files, {
        chunkSize: Math.max(
          MIN_DEBUG_CHUNK_SIZE,
          Math.min(MAX_DEBUG_CHUNK_SIZE, options.chunkSize ?? 16000),
        ),
        sessionId,
      });

      debugQueueRef.current = [];
      await ensureDebugQueueBuffered(
        Math.max(connections.length, prefetchWindow),
      );

      const openConnections = connections.filter((conn) => conn.open);
      let dispatched = 0;

      for (const conn of openConnections) {
        if (await dispatchNextDebugChunk(conn)) {
          dispatched += 1;
        }
      }

      setCurrentTask(
        `Debug session ${sessionId}: dispatched ${dispatched} initial chunks`,
      );

      console.log("[SwarmManager:Master] Debug analysis session started", {
        sessionId,
        generatedChunks: debugPayloadsGeneratedRef.current,
        initialDispatch: dispatched,
        prefetchWindow,
      });

      persistSwarmState();
      return {
        sessionId,
        generatedChunks: debugPayloadsGeneratedRef.current,
        initialDispatch: dispatched,
      };
    },
    [
      activeConnectionCount,
      connections,
      ensureDebugQueueBuffered,
      dispatchNextDebugChunk,
      isProcessing,
      persistSwarmState,
    ],
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
          inflightPayloadsRef.current.delete(payload.taskId);

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

          persistSwarmState();
        }

        if (genericPayload.type === "DEBUG_ANALYSIS_RESULT") {
          const payload = genericPayload as {
            type: "DEBUG_ANALYSIS_RESULT";
            taskId: string;
            fileName: string;
            analysis: string;
            chunkIndex?: number;
          };

          taskTrackerRef.current.completeTask(payload.taskId, payload.analysis);
          inflightPayloadsRef.current.delete(payload.taskId);

          const reportFileName = `debug-reports/${payload.fileName.replace(/[\\/:*?"<>|]/g, "_")}.chunk-${payload.chunkIndex ?? 0}.${payload.taskId}.md`;
          await fileQueueRef.current!.enqueue(reportFileName, payload.analysis);

          const dispatchedNext = await dispatchNextDebugChunk(conn);
          const allDone =
            !dispatchedNext &&
            debugQueueRef.current.length === 0 &&
            !debugPayloadStreamRef.current &&
            taskTrackerRef.current.getPendingTasks().length === 0;

          if (allDone) {
            setIsProcessing(false);
            setCurrentTask("Distributed debug analysis completed");
          } else {
            setCurrentTask(
              `Debug chunks remaining: ${debugQueueRef.current.length}`,
            );
          }

          persistSwarmState();
        }

        if (genericPayload.type === "DEBUG_REQUEST_NEXT") {
          const sent = await dispatchNextDebugChunk(conn);

          if (
            !sent &&
            debugQueueRef.current.length === 0 &&
            !debugPayloadStreamRef.current
          ) {
            console.log(
              "[SwarmManager:Master] No more debug chunks for worker",
              {
                worker: conn.peer,
              },
            );
          }

          persistSwarmState();
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
    [dispatchNextDebugChunk, persistSwarmState],
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

        if (genericPayload.type === "SWARM_STATE_SYNC") {
          const payload = (genericPayload.payload ?? genericPayload) as
            | PersistedSwarmState
            | undefined;

          if (
            payload &&
            Array.isArray(payload.tracker) &&
            Array.isArray(payload.distributedTasks) &&
            Array.isArray(payload.debugQueue)
          ) {
            localStorage.setItem(
              SWARM_TRACKER_STORAGE_KEY,
              JSON.stringify({
                ...payload,
                savedAt: Date.now(),
              }),
            );
            knownMasterPeerIdRef.current = conn.peer;
          }

          return;
        }

        // Handle task assignment
        if (
          genericPayload.type === "TASK_ASSIGN" ||
          genericPayload.type === "TASK_DISPATCH" ||
          genericPayload.type === "DEBUG_ANALYSIS"
        ) {
          const payload = genericPayload as unknown as SwarmTaskPayload;
          knownMasterPeerIdRef.current = conn.peer;

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
            const isDebugTask = payload.type === "DEBUG_ANALYSIS";

            let response:
              | TaskCompletePayload
              | {
                  type: "DEBUG_ANALYSIS_RESULT";
                  taskId: string;
                  fileName: string;
                  analysis: string;
                  chunkIndex?: number;
                };

            if (isDebugTask) {
              console.log("[WORKER] Calling executeDebugAnalysisTask...");
              const analysis = await executeDebugAnalysisTask(payload, engine);
              console.log(
                `[WORKER] Debug analysis generated (${analysis.length} chars)`,
              );

              response = {
                type: "DEBUG_ANALYSIS_RESULT",
                taskId: payload.taskId,
                fileName: payload.fileName,
                analysis,
                chunkIndex: payload.chunkIndex,
              };
            } else {
              // Execute the task using local AI engine
              console.log("[WORKER] Calling executeWorkerTask...");
              const generatedCode = await executeWorkerTask(payload, engine);
              console.log(
                `[WORKER] Code generated successfully (${generatedCode.length} chars)`,
              );

              // Send result back to master
              response = {
                type: "TASK_COMPLETE",
                taskId: payload.taskId,
                fileName: payload.fileName,
                code: generatedCode,
              };
            }

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

            if (payload.type === "DEBUG_ANALYSIS" && conn.open) {
              conn.send({
                type: "DEBUG_REQUEST_NEXT",
                taskId: payload.taskId,
                fileName: payload.fileName,
              });
            }

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

  const handleSwarmData = useCallback(
    (data: unknown, conn: DataConnection) => {
      const mode = swarmModeRef.current;

      if (typeof data === "object" && data !== null && "type" in data) {
        const typed = data as { type?: string; payload?: unknown };

        if (typed.type === "TASK_DISPATCH" && typed.payload) {
          console.log("[SwarmManager] Routing TASK_DISPATCH to worker handler");
          void handleWorkerDataRef.current(typed.payload, conn);
          return;
        }

        if (typed.type === "STATE") {
          const stateMessage = typed as SwarmStateSyncMessage;

          if (stateMessage.state === "ENGINE_READY") {
            readyPeerIdsRef.current.add(conn.peer);
            console.log("[SwarmManager] Marked peer as ENGINE_READY", {
              peer: conn.peer,
              readyPeers: Array.from(readyPeerIdsRef.current),
            });
          }

          return;
        }

        if (typed.type === "SWARM_ROLE_SYNC") {
          const roleSync = typed as SwarmRoleSyncMessage;

          if (!roleSync.masterPeerId || !peerId) {
            return;
          }

          knownMasterPeerIdRef.current = roleSync.masterPeerId;

          if (roleSync.masterPeerId === peerId) {
            if (localRoleIntentRef.current === "worker") {
              setWorkerMode();
              return;
            }

            if (roleSync.sourceRole === "master") {
              promoteToMaster();
            }
          } else {
            setWorkerMode();
          }

          return;
        }

        if (typed.type === "IMAGE_UI_TASK" && imageUiTaskHandlerRef.current) {
          void imageUiTaskHandlerRef.current(typed as ImageUiTaskMessage, conn);
          return;
        }

        if (
          typed.type === "IMAGE_UI_STATUS" &&
          imageUiStatusHandlerRef.current
        ) {
          void imageUiStatusHandlerRef.current(
            typed as ImageUiStatusMessage,
            conn,
          );
          return;
        }

        if (
          typed.type === "IMAGE_UI_RESULT" &&
          imageUiResultHandlerRef.current
        ) {
          void imageUiResultHandlerRef.current(
            typed as ImageUiResultMessage,
            conn,
          );
          return;
        }

        if (typed.type === "WORKER_LOG" && workerLogHandlerRef.current) {
          void workerLogHandlerRef.current(typed as WorkerLogMessage, conn);
          return;
        }

        if (typed.type === "WORKER_STREAM" && workerStreamHandlerRef.current) {
          void workerStreamHandlerRef.current(
            typed as WorkerStreamMessage,
            conn,
          );
          return;
        }

        if (
          typed.type === "WORKER_COMPLETE" &&
          workerCompleteHandlerRef.current
        ) {
          void workerCompleteHandlerRef.current(
            typed as WorkerCompleteMessage,
            conn,
          );
          return;
        }

        if (typed.type === "TASK_ASSIGN") {
          console.log("[SwarmManager] Routing TASK_ASSIGN to worker handler");
          void handleWorkerDataRef.current(typed, conn);
          return;
        }

        if (typed.type === "DEBUG_ANALYSIS") {
          console.log(
            "[SwarmManager] Routing DEBUG_ANALYSIS to worker handler",
          );
          void handleWorkerDataRef.current(typed, conn);
          return;
        }

        if (typed.type === "SWARM_STATE_SYNC") {
          console.log(
            "[SwarmManager] Routing SWARM_STATE_SYNC to worker handler",
          );
          void handleWorkerDataRef.current(typed, conn);
          return;
        }

        if (
          typed.type === "TASK_COMPLETE" ||
          typed.type === "STATUS_UPDATE" ||
          typed.type === "DEBUG_ANALYSIS_RESULT" ||
          typed.type === "DEBUG_REQUEST_NEXT"
        ) {
          console.log(
            "[SwarmManager] Routing response/update to master handler",
          );
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
    },
    [peerId, promoteToMaster, setWorkerMode],
  );

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

  useEffect(() => {
    if (swarmMode !== "master") {
      return;
    }

    const sync = () => {
      const snapshot: PersistedSwarmState = {
        savedAt: Date.now(),
        distributedTasks,
        tracker: taskTrackerRef.current.toSnapshot(),
        debugQueue: debugQueueRef.current,
      };

      const message = {
        type: "SWARM_STATE_SYNC",
        payload: snapshot,
      };

      connections.forEach((conn) => {
        if (!conn.open) {
          return;
        }

        try {
          conn.send(message);
        } catch (error) {
          console.warn("[SwarmManager:Master] Failed to sync swarm state", {
            peer: conn.peer,
            error,
          });
        }
      });
    };

    sync();
    const interval = setInterval(sync, 4000);
    return () => {
      clearInterval(interval);
    };
  }, [connections, distributedTasks, swarmMode]);

  useEffect(() => {
    if (swarmMode !== "worker" || !engine) {
      return;
    }

    const readyMessage: SwarmStatePayload = {
      type: "STATE",
      state: "ENGINE_READY",
    };

    connections.forEach((conn) => {
      if (!conn.open || readyPeerIdsRef.current.has(conn.peer)) {
        return;
      }

      const sent = sendStateToNode(conn, readyMessage);
      if (sent) {
        readyPeerIdsRef.current.add(conn.peer);
        console.log("[SwarmManager] Broadcast ENGINE_READY", {
          peer: conn.peer,
        });
      }
    });
  }, [connections, engine, sendStateToNode, swarmMode]);

  useEffect(() => {
    const currentOpenPeers = new Set(
      connections.filter((conn) => conn.open).map((conn) => conn.peer),
    );
    const previousOpenPeers = openPeerSetRef.current;
    openPeerSetRef.current = currentOpenPeers;

    if (swarmMode !== "master") {
      return;
    }

    const droppedPeers: string[] = [];
    previousOpenPeers.forEach((peer) => {
      if (!currentOpenPeers.has(peer)) {
        droppedPeers.push(peer);
      }
    });

    if (droppedPeers.length === 0) {
      return;
    }

    droppedPeers.forEach((peer) => {
      void reassignPendingTasksForNode(peer, "disconnect");
    });
  }, [connections, reassignPendingTasksForNode, swarmMode]);

  const recoverAsElectedMaster = useCallback(async () => {
    const raw = localStorage.getItem(SWARM_TRACKER_STORAGE_KEY);
    if (!raw) {
      setCurrentTask("Promoted to master mode");
      return;
    }

    try {
      const parsed = JSON.parse(raw) as PersistedSwarmState;

      taskTrackerRef.current.restoreFromSnapshot(parsed.tracker ?? []);
      setDistributedTasks(parsed.distributedTasks ?? []);
      debugQueueRef.current = parsed.debugQueue ?? [];
      debugPayloadStreamRef.current = null;

      const pending = taskTrackerRef.current.getPendingTasks();
      if (pending.length === 0) {
        setIsProcessing(false);
        setCurrentTask("Promoted to master mode");
        return;
      }

      setIsProcessing(true);
      setCurrentTask(
        `Recovered ${pending.length} pending task(s) as new master`,
      );

      for (const task of pending) {
        const payload = buildTaskPayloadFromTracker(task.taskId);
        if (!payload) {
          taskTrackerRef.current.failTask(
            task.taskId,
            "Recovery failed: payload unavailable",
          );
          continue;
        }

        const conn = pickNextOpenConnection();
        if (conn && sendTaskToNode(conn, payload)) {
          taskTrackerRef.current.reassignTask(task.taskId, conn.peer);
          taskTrackerRef.current.startTimeout(task.taskId, handleTaskTimeout);
          inflightPayloadsRef.current.set(task.taskId, payload);
          continue;
        }

        if (!engine) {
          taskTrackerRef.current.startTimeout(task.taskId, handleTaskTimeout);
          continue;
        }

        try {
          if (task.taskId.startsWith("debug_")) {
            const analysis = await executeDebugAnalysisTask(payload, engine);
            taskTrackerRef.current.completeTask(task.taskId, analysis);
            const reportFileName = `debug-reports/${payload.fileName.replace(/[\\/:*?"<>|]/g, "_")}.chunk-${payload.chunkIndex ?? 0}.${task.taskId}.md`;
            await fileQueueRef.current!.enqueue(reportFileName, analysis);
          } else {
            const generatedCode = await executeWorkerTask(payload, engine);
            await fileQueueRef.current!.enqueue(
              payload.fileName,
              generatedCode,
            );
            taskTrackerRef.current.completeTask(task.taskId, generatedCode);
          }
        } catch (error) {
          taskTrackerRef.current.failTask(
            task.taskId,
            `Recovery local execution failed: ${error}`,
          );
        }
      }

      if (taskTrackerRef.current.isAllCompleted()) {
        setIsProcessing(false);
        setCurrentTask("Recovered and completed all pending tasks");
      }

      persistSwarmState();
    } catch (error) {
      console.warn("[SwarmManager] Failed to recover replicated state", error);
      setCurrentTask("Promoted to master mode (state recovery unavailable)");
    }
  }, [
    buildTaskPayloadFromTracker,
    engine,
    handleTaskTimeout,
    persistSwarmState,
    pickNextOpenConnection,
    sendTaskToNode,
  ]);

  const electNextMasterPeer = useCallback(
    (candidatePeerIds: string[], previousMasterPeerId?: string | null) => {
      const sortedCandidates = Array.from(new Set(candidatePeerIds)).sort(
        (a, b) => a.localeCompare(b),
      );

      if (sortedCandidates.length === 0) {
        return null;
      }

      if (!previousMasterPeerId) {
        return sortedCandidates[0];
      }

      const previousIndex = sortedCandidates.indexOf(previousMasterPeerId);
      if (previousIndex === -1) {
        return sortedCandidates[0];
      }

      const nextIndex = (previousIndex + 1) % sortedCandidates.length;
      return sortedCandidates[nextIndex];
    },
    [],
  );

  useEffect(() => {
    if (swarmMode === "master" && peerId) {
      knownMasterPeerIdRef.current = peerId;
    }
  }, [peerId, swarmMode]);

  useEffect(() => {
    onMasterLost(() => {
      if (localRoleIntentRef.current === "worker") {
        console.warn(
          "[SwarmManager] Master heartbeat lost while pinned to worker mode; waiting for external master",
          {
            peerId,
            knownMaster: knownMasterPeerIdRef.current,
          },
        );
        setWorkerMode();
        return;
      }

      const payload = {
        savedAt: Date.now(),
        activeTaskId: activeTaskRef.current,
        currentTask: currentTaskRef.current,
        isProcessing: isProcessingRef.current,
      };

      localStorage.setItem(
        SWARM_MASTER_LOST_STORAGE_KEY,
        JSON.stringify(payload),
      );

      const candidates = [
        ...(peerId ? [peerId] : []),
        ...connections.filter((conn) => conn.open).map((conn) => conn.peer),
      ];
      const electedMaster =
        electNextMasterPeer(candidates, knownMasterPeerIdRef.current) ?? peerId;

      if (!electedMaster || !peerId) {
        return;
      }

      if (
        knownMasterPeerIdRef.current &&
        electedMaster === knownMasterPeerIdRef.current
      ) {
        console.warn(
          "[SwarmManager] Master heartbeat lost and old master is still elected",
          {
            electedMaster,
            previousMaster: knownMasterPeerIdRef.current,
          },
        );
      }

      if (electedMaster !== peerId) {
        console.warn(
          "[SwarmManager] Master lost, waiting for elected peer takeover",
          {
            electedMaster,
            localPeer: peerId,
          },
        );
        return;
      }

      console.warn("[SwarmManager] Local peer elected as new master", {
        electedMaster,
      });
      promoteToMaster();
      void recoverAsElectedMaster();
    });
  }, [
    connections,
    electNextMasterPeer,
    onMasterLost,
    peerId,
    promoteToMaster,
    recoverAsElectedMaster,
    setWorkerMode,
  ]);

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
      inflightPayloadsRef.current.clear();
      debugQueueRef.current = [];
      debugPayloadStreamRef.current = null;
      debugPayloadsGeneratedRef.current = 0;
      debugPayloadsDispatchedRef.current = 0;

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

          inflightPayloadsRef.current.set(taskId, {
            taskId,
            type: "TASK_ASSIGN",
            fileName: assignment.fileName,
            instructions: assignment.instructions,
          });

          taskTrackerRef.current.addTask(taskId, assignment, nodeId);
          // Start timeout for this task
          taskTrackerRef.current.startTimeout(taskId, handleTaskTimeout);
        });

        setDistributedTasks(assignments.map((a) => a.assignment));
        setCurrentTask(`Distributed ${assignments.length} tasks`);
        persistSwarmState();

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
      inflightPayloadsRef,
      persistSwarmState,
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
    distributeDebugAnalysis,
    getProgress,
    getAllTasks,

    // Custom message hooks
    sendMessageToNode,
    sendData,
    syncSwarmRole,
    sendImageUiTask,
    setLocalRoleIntent,
    onImageUiTask,
    onImageUiStatus,
    onImageUiResult,
    onWorkerLog,
    onWorkerStream,
    onWorkerComplete,

    // Standalone/Worker functions
    executeLocalTask,
  };
};
