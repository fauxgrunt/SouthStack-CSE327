import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  CircleX,
  Code2,
  Copy,
  Eye,
  Loader2,
  Mic,
  Play,
  SendHorizonal,
  Sparkles,
} from "lucide-react";
import { useAgenticLoop } from "../hooks/useAgenticLoop";
import type { ImageUiTaskMessage } from "../hooks/useSwarmManager";
import { useSwarmManager } from "../hooks/useSwarmManager";
import { useUIBuilder } from "../hooks/useUIBuilder";
import { useVoiceInput } from "../hooks/useVoiceInput";
import { extractUIFromImage } from "../services/VisionProcessor";
import { limitArraySize } from "../utils/performance";
import { AgentActivityStream } from "./AgentActivityStream";
import { CollaborativeCodeEditor } from "./CollaborativeCodeEditor";
import { SwarmConnectWidget } from "./SwarmConnectWidget";

type ActiveTab = "preview" | "code";

type LogType = "info" | "success" | "error" | "warning";

const MAX_SWARM_LOGS = 200;
const MAX_BUILDER_LOGS = 500;

interface AgentLogEntry {
  timestamp: Date;
  phase: string;
  message: string;
  type: LogType;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

interface SwarmActivityLog {
  id: string;
  timestamp: Date;
  message: string;
}

export const AgenticIDE: React.FC = () => {
  const {
    state,
    initializeEngine,
    executeAgenticLoop,
    cancelExecution,
    isReady,
    engine,
  } = useAgenticLoop();

  const [activeTab, setActiveTab] = useState<ActiveTab>("preview");
  const [userPrompt, setUserPrompt] = useState("");
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [pauseAgentEdits, setPauseAgentEdits] = useState(false);
  const [canvasCode, setCanvasCode] = useState<string | null>(null);

  const [isConnectingPeer, setIsConnectingPeer] = useState(false);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [swarmActivityLogs, setSwarmActivityLogs] = useState<
    SwarmActivityLog[]
  >([]);
  const [isDistributedProcessing, setIsDistributedProcessing] = useState(false);

  const [attachedImageDataUrl, setAttachedImageDataUrl] = useState<
    string | null
  >(null);
  const [attachedImageName, setAttachedImageName] = useState<string | null>(
    null,
  );
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [isAnalyzingImage, setIsAnalyzingImage] = useState(false);
  const [multimodalError, setMultimodalError] = useState<string | null>(null);
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);

  const [isLogsExpanded, setIsLogsExpanded] = useState(false);
  const [builderLogs, setBuilderLogs] = useState<AgentLogEntry[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const activeDistributedTaskRef = useRef<string | null>(null);
  const isProcessingImageRef = useRef(false);

  const handleCopyCode = useCallback(async () => {
    if (!canvasCode) return;
    try {
      await navigator.clipboard.writeText(canvasCode);
      const id = `copied_${Date.now()}`;
      setCopiedCodeId(id);
      setTimeout(() => setCopiedCodeId(null), 2000);
    } catch {
      setMultimodalError("Failed to copy code to clipboard");
    }
  }, [canvasCode]);

  const handleSwarmFileWrite = useCallback(
    async (_fileName: string, _content: string) => {
      return;
    },
    [],
  );

  const swarmManager = useSwarmManager(engine, handleSwarmFileWrite);

  const appendPromptTranscript = useCallback((transcript: string) => {
    setUserPrompt((prev) => {
      if (prev.trim().length === 0) {
        return transcript;
      }
      return `${prev}${/\s$/.test(prev) ? "" : " "}${transcript}`;
    });
  }, []);

  const promptVoice = useVoiceInput(appendPromptTranscript);

  const appendSwarmLog = useCallback((message: string) => {
    setSwarmActivityLogs((prev) => {
      const newLogs = [
        ...prev,
        {
          id: `swarm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          timestamp: new Date(),
          message,
        },
      ];
      return limitArraySize(newLogs, MAX_SWARM_LOGS);
    });
  }, []);

  const handleBuilderLog = useCallback(
    (phase: string, message: string, type: LogType = "info") => {
      setBuilderLogs((prev) => {
        const newLogs = [
          ...prev,
          {
            timestamp: new Date(),
            phase,
            message,
            type,
          },
        ];
        return limitArraySize(newLogs, MAX_BUILDER_LOGS);
      });
    },
    [],
  );

  const {
    previewUrl,
    isBuilding,
    error: uiBuilderError,
  } = useUIBuilder(canvasCode, {
    onLog: handleBuilderLog,
  });

  const peerStatus = useMemo(() => {
    const connected =
      swarmManager.connectionStatus === "connected" &&
      swarmManager.activeConnectionCount > 0;

    if (!swarmManager.isInitialized) {
      return {
        label: "Peer Offline",
        tone: "text-zinc-400 border-zinc-700 bg-zinc-900",
      };
    }

    if (!connected) {
      return {
        label: "Peer Ready",
        tone: "text-zinc-300 border-zinc-700 bg-zinc-900",
      };
    }

    if (swarmManager.swarmMode === "master") {
      return {
        label: "Swarm: Master Connected",
        tone: "text-emerald-200 border-emerald-500/40 bg-emerald-500/10",
      };
    }

    return {
      label: "Swarm: Worker Connected",
      tone: "text-cyan-200 border-cyan-500/40 bg-cyan-500/10",
    };
  }, [
    swarmManager.activeConnectionCount,
    swarmManager.connectionStatus,
    swarmManager.isInitialized,
    swarmManager.swarmMode,
  ]);

  const shouldOffloadToWorker = useMemo(
    () =>
      swarmManager.swarmMode === "master" &&
      swarmManager.connectionStatus === "connected" &&
      swarmManager.activeConnectionCount > 0,
    [
      swarmManager.activeConnectionCount,
      swarmManager.connectionStatus,
      swarmManager.swarmMode,
    ],
  );

  const isAgentBusy = useMemo(
    () =>
      isDistributedProcessing ||
      isAnalyzingImage ||
      isBuilding ||
      state.currentPhase === "generating" ||
      state.currentPhase === "executing" ||
      state.currentPhase === "fixing",
    [isAnalyzingImage, isBuilding, isDistributedProcessing, state.currentPhase],
  );

  const minimalAgentStatus = useMemo(() => {
    if (isAgentBusy) {
      return "Agent working";
    }

    if (state.error || uiBuilderError || multimodalError) {
      return "Agent needs attention";
    }

    return "Agent idle";
  }, [isAgentBusy, multimodalError, state.error, uiBuilderError]);

  const mergedLogs = useMemo(() => {
    return [...state.logs, ...builderLogs].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
  }, [builderLogs, state.logs]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [userPrompt]);

  const readFileAsDataUrl = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
          return;
        }

        reject(new Error("Could not read image data URL."));
      };

      reader.onerror = () => {
        reject(new Error("Failed to read selected image."));
      };

      reader.readAsDataURL(file);
    });
  }, []);

  const handleImageFile = useCallback(
    async (file: File) => {
      // Prevent concurrent image processing
      if (isProcessingImageRef.current) {
        return;
      }

      isProcessingImageRef.current = true;
      setMultimodalError(null);
      setIsProcessingImage(true);

      try {
        const imageDataUrl = await readFileAsDataUrl(file);
        setAttachedImageDataUrl(imageDataUrl);
        setAttachedImageName(file.name);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Image attachment failed unexpectedly.";
        setMultimodalError(`Image attachment failed: ${message}`);
      } finally {
        setIsProcessingImage(false);
        isProcessingImageRef.current = false;
      }
    },
    [readFileAsDataUrl],
  );

  const handleSendPrompt = async () => {
    const trimmed = userPrompt.trim();
    if (
      !trimmed ||
      !isReady ||
      state.isExecuting ||
      isAnalyzingImage ||
      isBuilding
    ) {
      return;
    }

    promptVoice.stopListening();
    setUserPrompt("");
    setActiveTab("preview");
    setMultimodalError(null);

    const userMessage: ChatMessage = {
      id: `user_${Date.now()}`,
      role: "user",
      content: trimmed,
      timestamp: new Date(),
    };
    setChatHistory((prev) => [...prev, userMessage]);

    if (shouldOffloadToWorker) {
      const taskId = `p2p_ui_${Date.now()}`;
      activeDistributedTaskRef.current = taskId;
      setIsDistributedProcessing(true);

      const distributedPrompt = trimmed;
      let imageDescription: string | undefined;

      if (attachedImageDataUrl) {
        setIsAnalyzingImage(true);
        try {
          imageDescription = await extractUIFromImage(attachedImageDataUrl);
          appendSwarmLog(
            "[Swarm] Master: Image converted to textual UI description.",
          );
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Image analysis failed unexpectedly.";
          setMultimodalError(`Image analysis failed: ${message}`);
        } finally {
          setIsAnalyzingImage(false);
        }
      }

      const payload: ImageUiTaskMessage = {
        type: "IMAGE_UI_TASK",
        taskId,
        prompt: distributedPrompt,
        imageDescription,
        imageName: attachedImageName ?? undefined,
      };

      appendSwarmLog("[Swarm] Master: Offloading prompt to Worker node...");

      const sent = swarmManager.sendData(payload);
      if (!sent) {
        setIsDistributedProcessing(false);
        activeDistributedTaskRef.current = null;
        setMultimodalError("No open worker channel available for offload.");
        setChatHistory((prev) => [
          ...prev,
          {
            id: `assistant_${Date.now()}_offload_failed`,
            role: "assistant",
            content:
              "I could not dispatch this prompt to a worker. Check swarm connection and retry.",
            timestamp: new Date(),
          },
        ]);
      } else {
        setChatHistory((prev) => [
          ...prev,
          {
            id: `assistant_${Date.now()}_offload`,
            role: "assistant",
            content:
              "Task dispatched to worker. Master is waiting for distributed generation.",
            timestamp: new Date(),
          },
        ]);
      }

      setAttachedImageDataUrl(null);
      setAttachedImageName(null);
      return;
    }

    let finalPrompt = trimmed;

    if (attachedImageDataUrl) {
      setIsAnalyzingImage(true);
      try {
        const extractedUiPrompt =
          await extractUIFromImage(attachedImageDataUrl);
        finalPrompt = [
          trimmed,
          "",
          "[IMAGE ANALYSIS REQUIREMENTS]",
          extractedUiPrompt,
        ].join("\n");

        setChatHistory((prev) => [
          ...prev,
          {
            id: `assistant_${Date.now()}_image_context`,
            role: "assistant",
            content: "Image context extracted. Generating UI...",
            timestamp: new Date(),
          },
        ]);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Image analysis failed unexpectedly.";
        setMultimodalError(`Image analysis failed: ${message}`);
      } finally {
        setIsAnalyzingImage(false);
      }
    }

    const result = await executeAgenticLoop(finalPrompt);

    if (result && typeof result === "object" && "success" in result) {
      if (result.success && "code" in result && result.code) {
        setCanvasCode(result.code);
      }

      setChatHistory((prev) => [
        ...prev,
        {
          id: `assistant_${Date.now()}_local_result`,
          role: "assistant",
          content: result.success
            ? "Canvas updated. Preview is rebuilding now."
            : `I hit an error and could not complete this request. ${result.error || "Unknown error."}`,
          timestamp: new Date(),
        },
      ]);
    }

    setAttachedImageDataUrl(null);
    setAttachedImageName(null);
  };

  useEffect(() => {
    swarmManager.onImageUiStatus((payload) => {
      if (swarmManager.swarmMode === "master") {
        appendSwarmLog(`[Swarm] Worker: ${payload.message}`);
      }
    });

    swarmManager.onImageUiTask(async (payload, conn) => {
      if (swarmManager.swarmMode !== "worker") {
        return;
      }

      const sendStatus = (message: string) => {
        swarmManager.sendMessageToNode(conn, {
          type: "IMAGE_UI_STATUS",
          taskId: payload.taskId,
          message,
        });
      };

      sendStatus("Task received. Worker preparing generation pipeline...");

      try {
        if (!engine) {
          throw new Error("Worker engine is not initialized.");
        }

        let workerPrompt = payload.prompt;

        if (payload.imageDescription) {
          sendStatus("Applying image description context...");
          workerPrompt = [
            payload.prompt,
            "",
            "[IMAGE ANALYSIS REQUIREMENTS]",
            payload.imageDescription,
          ].join("\n");
        } else if (payload.imageBase64) {
          // Backward compatibility with older masters that still send base64 payloads.
          sendStatus("Analyzing image reference...");
          const extractedUiPrompt = await extractUIFromImage(
            payload.imageBase64,
          );
          workerPrompt = [
            payload.prompt,
            "",
            "[IMAGE ANALYSIS REQUIREMENTS]",
            extractedUiPrompt,
          ].join("\n");
        }

        sendStatus("Generating UI code...");
        const distributedResult = await executeAgenticLoop(workerPrompt);

        if (!distributedResult?.success || !distributedResult.code) {
          throw new Error(
            distributedResult?.error ||
              "Worker failed to generate a valid code payload.",
          );
        }

        swarmManager.sendMessageToNode(conn, {
          type: "IMAGE_UI_RESULT",
          taskId: payload.taskId,
          prompt: workerPrompt,
          code: distributedResult.code,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Worker execution failed unexpectedly.";

        swarmManager.sendMessageToNode(conn, {
          type: "IMAGE_UI_RESULT",
          taskId: payload.taskId,
          prompt: payload.prompt,
          error: message,
        });
      }
    });

    swarmManager.onImageUiResult(async (payload) => {
      if (swarmManager.swarmMode !== "master") {
        return;
      }

      if (payload.taskId !== activeDistributedTaskRef.current) {
        return;
      }

      setIsDistributedProcessing(false);
      activeDistributedTaskRef.current = null;

      if (payload.error || !payload.code) {
        const message = payload.error || "No distributed code returned.";
        setMultimodalError(`Distributed worker failed: ${message}`);
        setChatHistory((prev) => [
          ...prev,
          {
            id: `assistant_${Date.now()}_distributed_error`,
            role: "assistant",
            content: `Distributed generation failed: ${message}`,
            timestamp: new Date(),
          },
        ]);
        return;
      }

      appendSwarmLog("[Swarm] Worker complete. Rebuilding preview locally...");
      setCanvasCode(payload.code);

      setChatHistory((prev) => [
        ...prev,
        {
          id: `assistant_${Date.now()}_distributed_complete`,
          role: "assistant",
          content:
            "Worker returned code successfully. Rebuilding live preview now.",
          timestamp: new Date(),
        },
      ]);
    });

    return () => {
      swarmManager.onImageUiTask(null);
      swarmManager.onImageUiStatus(null);
      swarmManager.onImageUiResult(null);
    };
  }, [appendSwarmLog, engine, executeAgenticLoop, swarmManager]);

  const handleConnectToPeer = useCallback(
    async ({
      targetPeerId,
      role,
    }: {
      targetPeerId: string;
      role: "master" | "worker";
    }) => {
      setNetworkError(null);
      setIsConnectingPeer(true);

      try {
        if (role === "worker") {
          if (!targetPeerId.trim()) {
            swarmManager.setWorkerMode();
          } else {
            await swarmManager.connectToNode(targetPeerId, { asMaster: false });
            swarmManager.setWorkerMode();
          }
          return;
        }

        if (!targetPeerId.trim()) {
          throw new Error("Peer ID is required when joining as master.");
        }

        await swarmManager.connectToNode(targetPeerId, { asMaster: true });
        swarmManager.promoteToMaster();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to connect.";
        setNetworkError(message);
      } finally {
        setIsConnectingPeer(false);
      }
    },
    [swarmManager],
  );

  const connectedPeers = useMemo(
    () =>
      swarmManager.connections.map((conn) => ({
        id: conn.peer,
        open: conn.open,
      })),
    [swarmManager.connections],
  );

  const swarmHeaderStatus = useMemo<"offline" | "master" | "worker">(() => {
    if (!swarmManager.isInitialized) {
      return "offline";
    }

    if (swarmManager.swarmMode === "master") {
      return "master";
    }

    if (
      swarmManager.swarmMode === "worker" ||
      swarmManager.activeConnectionCount > 0
    ) {
      return "worker";
    }

    return "offline";
  }, [
    swarmManager.activeConnectionCount,
    swarmManager.isInitialized,
    swarmManager.swarmMode,
  ]);

  const mobileHeaderStatus = useMemo(() => {
    if (state.isLoading) {
      return "Booting";
    }

    if (state.isInitialized) {
      return isAgentBusy ? "Working" : "Ready";
    }

    return "Offline";
  }, [isAgentBusy, state.isInitialized, state.isLoading]);

  const handlePromptKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      void handleSendPrompt();
    }
  };

  const detectedLanguage = useMemo(() => {
    if (!canvasCode) {
      return "javascript";
    }

    if (canvasCode.includes("tsx") || canvasCode.includes("jsx")) {
      return "tsx";
    }

    return "javascript";
  }, [canvasCode]);

  // Quick actions palette (Cmd+K / Ctrl+K)
  const [showQuickActions, setShowQuickActions] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowQuickActions((prev) => !prev);
      }
      // Close palette with Escape
      if (e.key === "Escape") {
        setShowQuickActions(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-3 pb-40 pt-3 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3 sm:p-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-100 sm:text-2xl md:text-3xl">
              SouthStack Generative Canvas
            </h1>
            <p className="mt-1 hidden text-sm text-zinc-400 md:block">
              Describe what you want. Watch the UI appear.
            </p>
          </div>

          <div className="flex w-full flex-col gap-2 md:w-auto md:flex-row md:items-center md:justify-end md:gap-2">
            <div className="flex items-center gap-2 overflow-x-auto whitespace-nowrap rounded-full border border-zinc-800 bg-zinc-950/40 px-2 py-1 md:hidden">
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] ${peerStatus.tone}`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${peerStatus.tone.includes("emerald") ? "bg-emerald-300" : peerStatus.tone.includes("cyan") ? "bg-cyan-300" : "bg-zinc-500"}`}
                />
                {peerStatus.label}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-300">
                <Sparkles className="h-3 w-3" />
                {mobileHeaderStatus}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 md:flex-nowrap md:justify-end">
              <div className="hidden md:block">
                <span
                  className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] ${peerStatus.tone}`}
                >
                  {peerStatus.label}
                </span>
              </div>

              <SwarmConnectWidget
                status={swarmHeaderStatus}
                peerId={swarmManager.peerId}
                connectedPeers={connectedPeers}
                isConnecting={isConnectingPeer}
                networkError={networkError}
                onConnect={handleConnectToPeer}
                onDisconnectAll={swarmManager.disconnectAll}
              />

              {!state.isInitialized ? (
                <button
                  onClick={initializeEngine}
                  disabled={state.isLoading}
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-100 transition hover:border-zinc-500 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60 md:px-4 md:py-2 md:text-sm"
                >
                  {state.isLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  <span className="hidden sm:inline">
                    {state.isLoading ? "Bootstrapping" : "Initialize"}
                  </span>
                  <span className="sm:hidden">
                    {state.isLoading ? "Boot" : "Init"}
                  </span>
                </button>
              ) : (
                <div className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                  <Sparkles className="h-4 w-4" />
                  <span className="hidden sm:inline">Ready</span>
                  <span className="sm:hidden">OK</span>
                </div>
              )}

              {state.isExecuting && (
                <button
                  onClick={cancelExecution}
                  className="inline-flex min-h-11 items-center rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-300 transition hover:bg-rose-500/20"
                >
                  Stop
                </button>
              )}
            </div>
          </div>
        </header>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
            <div className="relative flex rounded-xl border border-zinc-700 bg-zinc-900 p-1">
              <button
                onClick={() => setActiveTab("preview")}
                className={`relative z-10 inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  activeTab === "preview"
                    ? "text-zinc-100"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Eye className="h-3.5 w-3.5" />
                Preview
              </button>
              <button
                onClick={() => setActiveTab("code")}
                className={`relative z-10 inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  activeTab === "code"
                    ? "text-zinc-100"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Code2 className="h-3.5 w-3.5" />
                Code
              </button>
              {activeTab === "preview" ? (
                <motion.div
                  layoutId="canvas-tab"
                  className="absolute inset-y-1 left-1 right-[50%] rounded-lg bg-zinc-700"
                />
              ) : (
                <motion.div
                  layoutId="canvas-tab"
                  className="absolute inset-y-1 left-[50%] right-1 rounded-lg bg-zinc-700"
                />
              )}
            </div>

            <button
              type="button"
              onClick={() => setIsLogsExpanded((prev) => !prev)}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800"
            >
              {isLogsExpanded ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              {isLogsExpanded ? "Collapse System Logs" : "Expand System Logs"}
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                {minimalAgentStatus}
              </span>
            </button>
          </div>

          <AnimatePresence initial={false}>
            {isLogsExpanded && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="border-b border-zinc-800 bg-zinc-950/60 px-3 py-3"
              >
                <AgentActivityStream
                  logs={mergedLogs}
                  swarmLogs={swarmActivityLogs}
                  isInitialized={state.isInitialized}
                  isLoading={state.isLoading}
                  initProgress={state.initProgress}
                  isListening={promptVoice.isListening}
                  voiceError={promptVoice.error}
                  currentPhase={isAgentBusy ? "executing" : state.currentPhase}
                  retryCount={state.retryCount}
                  generatedCode={canvasCode}
                  error={state.error || uiBuilderError || multimodalError}
                />
              </motion.div>
            )}
          </AnimatePresence>

          <div className="h-[calc(100vh-320px)] min-h-[460px] bg-zinc-950/60 p-3">
            <AnimatePresence mode="wait" initial={false}>
              {activeTab === "preview" ? (
                <motion.div
                  key="preview-tab"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className="h-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950"
                >
                  {previewUrl ? (
                    <iframe
                      title="SouthStack Live Preview"
                      src={previewUrl}
                      className="h-full w-full"
                      sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                    />
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                      <Eye className="h-8 w-8 text-zinc-500" />
                      <h3 className="text-sm font-semibold text-zinc-300">
                        Your generated UI appears here
                      </h3>
                      <p className="max-w-md text-xs leading-relaxed text-zinc-500">
                        Send a prompt to generate code, then we bundle and
                        launch it in WebContainer for live preview.
                      </p>
                    </div>
                  )}
                </motion.div>
              ) : (
                <motion.div
                  key="code-tab"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className="h-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 flex flex-col"
                >
                  {canvasCode && (
                    <div className="border-b border-zinc-800 bg-zinc-900/50 px-4 py-2 flex items-center justify-between">
                      <div className="flex items-center gap-4 text-[11px] text-zinc-400">
                        <span>{canvasCode.split("\n").length} lines</span>
                        <span>{canvasCode.length} chars</span>
                      </div>
                      <button
                        onClick={handleCopyCode}
                        className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-zinc-800 disabled:opacity-50"
                        title="Copy code to clipboard"
                      >
                        {copiedCodeId ? (
                          <>
                            <Check className="h-3.5 w-3.5" />
                            Copied!
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" />
                            Copy
                          </>
                        )}
                      </button>
                    </div>
                  )}
                  <div className="flex-1 overflow-hidden">
                    <CollaborativeCodeEditor
                      generatedCode={canvasCode}
                      language={detectedLanguage}
                      isAgentBusy={isAgentBusy}
                      pauseAgentEdits={pauseAgentEdits}
                      onPauseAgentEditsChange={setPauseAgentEdits}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </section>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-800 bg-zinc-950/95 px-3 py-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void handleImageFile(file);
              }
              event.currentTarget.value = "";
            }}
          />

          {attachedImageDataUrl && (
            <div className="rounded-lg border border-zinc-700 bg-zinc-900/80 p-2">
              <div className="flex items-start gap-3">
                <div className="relative h-16 w-24 overflow-hidden rounded-md border border-zinc-700 bg-zinc-950">
                  <img
                    src={attachedImageDataUrl}
                    alt={attachedImageName ?? "Attached image"}
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setAttachedImageDataUrl(null);
                      setAttachedImageName(null);
                    }}
                    className="absolute right-1 top-1 rounded-full bg-zinc-950/80 p-0.5 text-zinc-200 transition hover:bg-zinc-800"
                    title="Remove attached image"
                  >
                    <CircleX className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="min-w-0 flex-1 pt-0.5">
                  <p className="truncate text-xs font-medium text-zinc-200">
                    {attachedImageName ?? "Image attached"}
                  </p>
                  <p className="mt-1 text-[11px] text-zinc-500">
                    This image is included in the next generation task.
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-zinc-700 bg-zinc-900 p-2">
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="text-[11px] text-zinc-500">
                {shouldOffloadToWorker
                  ? "Master mode: prompt will be processed by worker"
                  : "Local mode: prompt will run on this device"}
              </span>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] ${peerStatus.tone}`}
              >
                {peerStatus.label}
              </span>
            </div>

            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                disabled={isAgentBusy || isProcessingImage}
                className="mb-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                title="Camera/Image"
              >
                {isProcessingImage ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Camera className="h-4 w-4" />
                )}
              </button>

              <button
                type="button"
                onClick={
                  promptVoice.isListening
                    ? promptVoice.stopListening
                    : promptVoice.startListening
                }
                disabled={!promptVoice.isSupported || isAgentBusy}
                className="mb-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                title="Voice input"
              >
                <Mic className="h-4 w-4" />
              </button>

              <textarea
                ref={textareaRef}
                value={userPrompt}
                onChange={(event) => setUserPrompt(event.target.value)}
                onKeyDown={handlePromptKeyDown}
                placeholder="Describe the UI you want to generate..."
                className="min-w-0 max-h-[220px] min-h-[72px] flex-1 resize-none bg-transparent px-1 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                disabled={!isReady || isAgentBusy}
              />

              <button
                onClick={() => {
                  void handleSendPrompt();
                }}
                disabled={!isReady || isAgentBusy || !userPrompt.trim()}
                className="mb-1 inline-flex min-h-11 items-center gap-2 rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-900 transition hover:bg-zinc-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
              >
                {isAgentBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <SendHorizonal className="h-3.5 w-3.5" />
                )}
                Send
              </button>
            </div>
          </div>

          {(promptVoice.error || multimodalError || uiBuilderError) && (
            <p className="text-xs text-rose-300">
              {promptVoice.error || multimodalError || uiBuilderError}
            </p>
          )}

          {chatHistory.length > 0 && (
            <div className="max-h-28 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
              {chatHistory.slice(-3).map((message) => (
                <p
                  key={message.id}
                  className="mb-1 text-xs text-zinc-400 last:mb-0"
                >
                  <span className="font-medium text-zinc-300">
                    {message.role === "user" ? "You" : "Agent"}:
                  </span>
                  {message.content}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Quick Actions Palette (Cmd+K) */}
      <AnimatePresence>
        {showQuickActions && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-start justify-center pt-20"
            onClick={() => setShowQuickActions(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: -10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -10 }}
              onClick={(e) => e.stopPropagation()}
              className="w-[320px] rounded-xl border border-zinc-700 bg-zinc-900 p-3 shadow-2xl"
            >
              <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold px-2 py-1 mb-2">
                Quick Actions
              </p>
              <div className="space-y-1">
                <button
                  onClick={() => {
                    if (canvasCode && detectedLanguage === "tsx") {
                      setActiveTab("preview");
                    }
                    setShowQuickActions(false);
                  }}
                  className="w-full text-left px-2.5 py-2 text-xs rounded-lg hover:bg-zinc-800 transition text-zinc-300"
                >
                  <span className="font-medium">View Preview</span>
                  <p className="text-[10px] text-zinc-500 mt-0.5">
                    Switch to preview tab
                  </p>
                </button>
                <button
                  onClick={() => {
                    setActiveTab("code");
                    setShowQuickActions(false);
                  }}
                  className="w-full text-left px-2.5 py-2 text-xs rounded-lg hover:bg-zinc-800 transition text-zinc-300"
                >
                  <span className="font-medium">View Code</span>
                  <p className="text-[10px] text-zinc-500 mt-0.5">
                    Switch to code tab
                  </p>
                </button>
                <button
                  onClick={() => {
                    handleCopyCode();
                    setShowQuickActions(false);
                  }}
                  disabled={!canvasCode}
                  className="w-full text-left px-2.5 py-2 text-xs rounded-lg hover:bg-zinc-800 transition text-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span className="font-medium">Copy Code</span>
                  <p className="text-[10px] text-zinc-500 mt-0.5">
                    Copy to clipboard
                  </p>
                </button>
                <button
                  onClick={() => {
                    setIsLogsExpanded((prev) => !prev);
                    setShowQuickActions(false);
                  }}
                  className="w-full text-left px-2.5 py-2 text-xs rounded-lg hover:bg-zinc-800 transition text-zinc-300"
                >
                  <span className="font-medium">Toggle Logs</span>
                  <p className="text-[10px] text-zinc-500 mt-0.5">
                    {isLogsExpanded ? "Hide" : "Show"} system logs
                  </p>
                </button>
                <button
                  onClick={() => {
                    setChatHistory([]);
                    setCanvasCode(null);
                    setShowQuickActions(false);
                  }}
                  className="w-full text-left px-2.5 py-2 text-xs rounded-lg hover:bg-zinc-800 transition text-zinc-300"
                >
                  <span className="font-medium">Clear Canvas</span>
                  <p className="text-[10px] text-zinc-500 mt-0.5">
                    Reset chat and code
                  </p>
                </button>
                <div className="border-t border-zinc-800 my-2 pt-2">
                  <p className="text-[10px] text-zinc-500 px-2 py-1">
                    Press{" "}
                    <kbd className="px-1 py-0.5 bg-zinc-800 rounded text-[9px]">
                      Esc
                    </kbd>{" "}
                    to close
                  </p>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default AgenticIDE;
