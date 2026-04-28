import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ErrorBoundary } from "./ErrorBoundary";
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
import { useVoiceInput } from "../hooks/useVoiceInput";
import type { SwarmTaskPayload } from "../hooks/useSwarm";
import { executeWorkerTaskWithStreaming } from "../services/swarmOrchestrator";
import { extractUIFromImage } from "../services/LocalVisionProcessor";
import { limitArraySize } from "../utils/performance";
import { AgentActivityStream } from "./AgentActivityStream";
import { CollaborativeCodeEditor } from "./CollaborativeCodeEditor";
import { SwarmConnectWidget } from "./SwarmConnectWidget";

type ActiveTab = "split" | "preview" | "code";

const MAX_SWARM_LOGS = 200;

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

function isLowEndRuntime(): boolean {
  const cores = navigator.hardwareConcurrency || 2;
  const memory = (navigator as { deviceMemory?: number }).deviceMemory || 4;
  return cores <= 4 || memory <= 4;
}

function sanitizeDistributedWorkerCode(code: string): string {
  const withoutFences = code
    .replace(/```(?:jsx|tsx|js|ts)?/gi, "")
    .replace(/```/g, "")
    .trim();

  const lines = withoutFences.split(/\r?\n/);
  const safeImportPattern =
    /^\s*import\s+.+from\s+["'](react|\.\/styles\.css|\.\/App\.css)["'];?\s*$/i;

  const sanitizedLines = lines.filter((line) => {
    if (!/^\s*import\s+/i.test(line)) {
      return true;
    }

    return safeImportPattern.test(line);
  });

  return sanitizedLines.join("\n").trim();
}

// NOTE: Retry helpers removed to enforce single-shot, fatal-on-failure behavior.

export const AgenticIDE: React.FC = () => {
  const {
    state,
    initializeEngine,
    executeAgenticLoop,
    executeGeneratedCodeDirectly,
    cancelExecution,
    resetGeneratedCanvas,
    isReady,
    engine,
  } = useAgenticLoop();

  const [activeTab, setActiveTab] = useState<ActiveTab>("split");
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
  const [workerTerminalLines, setWorkerTerminalLines] = useState<string[]>([]);
  const [workerStreamPreview, setWorkerStreamPreview] = useState("");

  const [focusRequest, setFocusRequest] = useState<number>(0);

  const [isLogsExpanded, setIsLogsExpanded] = useState(false);
  const lowEndMode = useMemo(() => isLowEndRuntime(), []);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const activeDistributedTaskRef = useRef<string | null>(null);
  const activeDistributedPromptRef = useRef<string>("");
  const activeDistributedImageTaskRef = useRef<ImageUiTaskMessage | null>(null);
  const distributedRetryCountRef = useRef(0);
  const isProcessingImageRef = useRef(false);
  const workerTerminalRef = useRef<HTMLDivElement | null>(null);
  const surfacedBrowserIssueRef = useRef<string | null>(null);

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

  const handlePreviewError = useCallback((_err: Error) => {
    setActiveTab("code");
    setFocusRequest((prev) => prev + 1);
    setMultimodalError(
      "Live preview failed due to incomplete syntax. Editor focused.",
    );
  }, []);

  const handleSwarmFileWrite = useCallback(
    async (_fileName: string, _content: string) => {
      return;
    },
    [],
  );

  const swarmManager = useSwarmManager(engine, handleSwarmFileWrite);

  useEffect(() => {
    if (swarmManager.connectionStatus === "error" && swarmManager.initError) {
      setNetworkError(swarmManager.initError);
      return;
    }

    if (swarmManager.connectionStatus === "ready") {
      setNetworkError(null);
    }
  }, [
    swarmManager.connectionStatus,
    swarmManager.initError,
    swarmManager.isInitialized,
  ]);

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

  const appendWorkerTerminalLine = useCallback((line: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setWorkerTerminalLines((prev) =>
      limitArraySize([...prev, `[${timestamp}] ${line}`], 600),
    );
  }, []);

  useEffect(() => {
    if (
      !state.error ||
      !/WebGPU|SharedArrayBuffer|COOP|COEP|navigator\.gpu/i.test(state.error)
    ) {
      surfacedBrowserIssueRef.current = null;
      return;
    }

    if (surfacedBrowserIssueRef.current === state.error) {
      return;
    }

    surfacedBrowserIssueRef.current = state.error;
    const browserIssueLine = `[Browser capability check] ${state.error}`;
    appendSwarmLog(browserIssueLine);
    appendWorkerTerminalLine(browserIssueLine);
  }, [appendSwarmLog, appendWorkerTerminalLine, state.error]);

  useEffect(() => {
    if (!workerTerminalRef.current) {
      return;
    }

    workerTerminalRef.current.scrollTop =
      workerTerminalRef.current.scrollHeight;
  }, [workerStreamPreview, workerTerminalLines]);

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
      state.currentPhase === "generating" ||
      state.currentPhase === "executing" ||
      state.currentPhase === "fixing",
    [isAnalyzingImage, isDistributedProcessing, state.currentPhase],
  );

  const minimalAgentStatus = useMemo(() => {
    if (isAgentBusy) {
      return "Agent working";
    }

    if (state.error || multimodalError) {
      return "Agent needs attention";
    }

    return "Agent idle";
  }, [isAgentBusy, multimodalError, state.error]);

  const mergedLogs = useMemo(() => {
    return state.logs;
  }, [state.logs]);

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

  const dataUrlToImageBytes = useCallback(
    async (
      dataUrl: string,
    ): Promise<{ bytes: ArrayBuffer; mimeType: string }> => {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const bytes = await blob.arrayBuffer();
      return {
        bytes,
        mimeType: blob.type || "image/png",
      };
    },
    [],
  );

  const imageBytesToDataUrl = useCallback(
    async (bytes: ArrayBuffer, mimeType: string): Promise<string> => {
      const blob = new Blob([bytes], { type: mimeType || "image/png" });
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === "string") {
            resolve(reader.result);
            return;
          }
          reject(new Error("Failed to reconstruct image data URL."));
        };
        reader.onerror = () =>
          reject(new Error("Failed to decode image bytes."));
        reader.readAsDataURL(blob);
      });
    },
    [],
  );

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
    if (!trimmed || !isReady || state.isExecuting || isAnalyzingImage) {
      return;
    }

    promptVoice.stopListening();
    resetGeneratedCanvas();
    setUserPrompt("");
    setActiveTab("split");
    setMultimodalError(null);

    const userMessage: ChatMessage = {
      id: `user_${Date.now()}`,
      role: "user",
      content: trimmed,
      timestamp: new Date(),
    };
    setChatHistory((prev) => [...prev, userMessage]);

    if (shouldOffloadToWorker) {
      setActiveTab("split");
      const taskId = `p2p_ui_${Date.now()}`;
      activeDistributedTaskRef.current = taskId;
      setIsDistributedProcessing(true);
      setWorkerTerminalLines([]);
      setWorkerStreamPreview("");
      appendWorkerTerminalLine("Master queued distributed image task.");

      const distributedPrompt = trimmed;
      let imageBytes: ArrayBuffer | undefined;
      let imageMimeType: string | undefined;
      let imageDescription: string | undefined;

      if (attachedImageDataUrl) {
        setIsAnalyzingImage(true);
        try {
          if (lowEndMode) {
            imageDescription = [
              "Low-end mode is active; heavy image analysis has been skipped for performance.",
              "Use the attached user prompt as the primary source of truth and produce a faithful modern UI recreation.",
            ].join("\n");
            appendWorkerTerminalLine(
              "Low-end mode: skipped local vision extraction to reduce CPU/GPU pressure.",
            );
          } else {
            const converted = await dataUrlToImageBytes(attachedImageDataUrl);
            imageBytes = converted.bytes;
            imageMimeType = converted.mimeType;
            imageDescription = await extractUIFromImage(attachedImageDataUrl);
            appendSwarmLog(
              "[Swarm] Master: Packed image into raw pixel buffer.",
            );
            appendWorkerTerminalLine(
              `Packed ${converted.bytes.byteLength} image bytes for worker inference.`,
            );
          }
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Image analysis failed unexpectedly.";
          setMultimodalError(`Image analysis failed: ${message}`);
          setIsDistributedProcessing(false);
          activeDistributedTaskRef.current = null;
          setChatHistory((prev) => [
            ...prev,
            {
              id: `assistant_${Date.now()}_image_analysis_failed`,
              role: "assistant",
              content:
                "Image analysis failed. Task was not dispatched to workers. Fix Vision API and retry.",
              timestamp: new Date(),
            },
          ]);
          appendWorkerTerminalLine(`Image analysis failed: ${message}`);
          return;
        } finally {
          setIsAnalyzingImage(false);
        }
      }

      const payload: ImageUiTaskMessage = {
        type: "IMAGE_UI_TASK",
        taskId,
        prompt: distributedPrompt,
        imageBytes,
        imageMimeType,
        imageDescription,
        imageName: attachedImageName ?? undefined,
      };

      activeDistributedPromptRef.current =
        imageDescription || distributedPrompt;
      activeDistributedImageTaskRef.current = payload;
      distributedRetryCountRef.current = 0;

      appendSwarmLog("[Swarm] Master: Offloading prompt to Worker node...");
      appendWorkerTerminalLine("Dispatching structure prompt to worker...");

      const sent = swarmManager.sendImageUiTask(payload);
      if (!sent) {
        setIsDistributedProcessing(false);
        activeDistributedTaskRef.current = null;
        setMultimodalError(
          "No ENGINE_READY worker channel is available for offload.",
        );
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
        appendWorkerTerminalLine(
          "Dispatch failed: no ENGINE_READY worker channel available.",
        );
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
        appendWorkerTerminalLine(
          "Task dispatched. Waiting for worker stream...",
        );
      }

      setAttachedImageDataUrl(null);
      setAttachedImageName(null);
      return;
    }

    if (attachedImageDataUrl) {
      setIsAnalyzingImage(true);
      try {
        const extractedUiPrompt =
          await extractUIFromImage(attachedImageDataUrl);

        // Single-shot generation: do not retry automatically. Fail loudly on first failure.
        const generatedResult = await executeAgenticLoop(extractedUiPrompt);

        const _generatedCode = (generatedResult as { code?: string })?.code;
        if (!generatedResult || !_generatedCode) {
          const message =
            (generatedResult as { error?: string })?.error ||
            "Image-to-code generation failed.";
          setMultimodalError(`Image-to-code generation incomplete: ${message}`);
          setChatHistory((prev) => [
            ...prev,
            {
              id: `assistant_${Date.now()}_image_codegen_partial`,
              role: "assistant",
              content: `Image-to-code generation returned partial results: ${message}`,
              timestamp: new Date(),
            },
          ]);
          // If partial code exists, use it to update the canvas so user can repair.
          if (_generatedCode) {
            const sanitized = sanitizeDistributedWorkerCode(_generatedCode);
            setCanvasCode(sanitized);
          }
          // Continue; do not throw to keep UI stable.
        } else {
          const sanitized = sanitizeDistributedWorkerCode(_generatedCode);
          setCanvasCode(sanitized);

          setChatHistory((prev) => [
            ...prev,
            {
              id: `assistant_${Date.now()}_image_context`,
              role: "assistant",
              content: "Image context extracted. Canvas preview is updating.",
              timestamp: new Date(),
            },
          ]);

          setChatHistory((prev) => [
            ...prev,
            {
              id: `assistant_${Date.now()}_image_codegen_result`,
              role: "assistant",
              content: "Image-to-code generation completed successfully.",
              timestamp: new Date(),
            },
          ]);
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Image analysis failed unexpectedly.";
        setMultimodalError(`Image analysis failed: ${message}`);
        setChatHistory((prev) => [
          ...prev,
          {
            id: `assistant_${Date.now()}_image_analysis_failed_local`,
            role: "assistant",
            content: `Image-to-code generation failed. ${message}`,
            timestamp: new Date(),
          },
        ]);
      } finally {
        setIsAnalyzingImage(false);
      }

      setAttachedImageDataUrl(null);
      setAttachedImageName(null);
      return;
    }

    const result = await executeAgenticLoop(trimmed);

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

    swarmManager.onWorkerStatus((payload) => {
      if (swarmManager.swarmMode !== "master") {
        return;
      }

      if (!activeDistributedTaskRef.current) {
        return;
      }

      if (
        payload.taskId &&
        payload.taskId !== activeDistributedTaskRef.current
      ) {
        return;
      }

      appendSwarmLog(`[Worker] ${payload.message}`);
      appendWorkerTerminalLine(payload.message);
    });

    swarmManager.onWorkerStream((payload) => {
      if (swarmManager.swarmMode !== "master") {
        return;
      }

      if (!activeDistributedTaskRef.current) {
        return;
      }

      if (
        payload.taskId &&
        payload.taskId !== activeDistributedTaskRef.current
      ) {
        return;
      }

      setWorkerStreamPreview((prev) => {
        const next = `${prev}${payload.chunk}`;
        return next.length > 120000 ? next.slice(next.length - 120000) : next;
      });
    });

    swarmManager.onWorkerComplete(async (payload) => {
      if (swarmManager.swarmMode !== "master") {
        return;
      }

      if (!activeDistributedTaskRef.current) {
        return;
      }

      if (
        payload.taskId &&
        payload.taskId !== activeDistributedTaskRef.current
      ) {
        return;
      }

      setIsDistributedProcessing(false);
      activeDistributedTaskRef.current = null;

      const workerOutput =
        payload.code || activeDistributedPromptRef.current || "";
      const safeCode = sanitizeDistributedWorkerCode(workerOutput);
      if (!safeCode.trim()) {
        const message = "Worker returned empty code after sanitization.";
        console.warn("[AgenticIDE] Distributed worker fallback:", {
          message,
          workerOutput,
        });
        appendWorkerTerminalLine(
          "Worker output sanitized to empty; forwarding fallback payload to editor.",
        );
      }

      appendWorkerTerminalLine(
        "Worker stream complete. Executing sanitized code...",
      );
      setCanvasCode(safeCode || workerOutput);

      const previewResult = await executeGeneratedCodeDirectly(
        safeCode || workerOutput,
        activeDistributedPromptRef.current || "distributed streamed task",
      );

      setChatHistory((prev) => [
        ...prev,
        {
          id: `assistant_${Date.now()}_distributed_complete`,
          role: "assistant",
          content: previewResult.success
            ? "Worker returned code successfully. Preview updated."
            : `Worker returned code, but preview failed: ${previewResult.error || "Unknown error."}`,
          timestamp: new Date(),
        },
      ]);
    });

    swarmManager.onImageUiTask(async (payload, conn) => {
      if (swarmManager.swarmMode !== "worker") {
        return;
      }

      const ENGINE_WARMUP_TIMEOUT_MS = 300000;

      const sendStatus = (message: string) => {
        swarmManager.sendMessageToNode(conn, {
          type: "IMAGE_UI_STATUS",
          taskId: payload.taskId,
          message,
        });
      };

      sendStatus("Task received. Worker preparing generation pipeline...");

      try {
        const workerEngine = engine;

        if (!workerEngine) {
          console.warn(
            "[ImageUI] Worker engine unavailable; continuing with prompt-only fallback.",
          );
          sendStatus(
            "Worker engine unavailable; continuing with prompt-only fallback.",
          );
          return;
        }

        // Ensure engine is ready before using it
        sendStatus("Ensuring engine is warmed up...");
        let isEngineReady = false;
        try {
          // Try a minimal test call to verify engine is working
          const testMessages = [
            { role: "system" as const, content: "You are a test." },
            { role: "user" as const, content: "Say OK." },
          ];
          const testResult = await Promise.race([
            workerEngine.chat.completions.create({
              messages: testMessages,
              max_tokens: 10,
              temperature: 0.1,
            }),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("Engine warmup timeout")),
                ENGINE_WARMUP_TIMEOUT_MS,
              ),
            ),
          ]);
          isEngineReady = Boolean(testResult);
          if (isEngineReady) {
            sendStatus("Engine warmup successful.");
          }
        } catch (warmupError) {
          const warmupMsg =
            warmupError instanceof Error
              ? warmupError.message
              : "Unknown warmup error";
          console.warn("[ImageUI] Engine warmup failed:", warmupError);
          sendStatus(`Engine warmup issue (continuing anyway): ${warmupMsg}`);
        }

        let layoutDescription = payload.imageDescription?.trim() || "";

        if (lowEndMode && !layoutDescription) {
          sendStatus(
            "Low-end mode active: skipping heavy local image analysis and using prompt-first reconstruction.",
          );
        }

        if (!lowEndMode && !layoutDescription && payload.imageBytes) {
          sendStatus("Analyzing raw image pixels on worker...");
          try {
            const reconstructed = await imageBytesToDataUrl(
              payload.imageBytes,
              payload.imageMimeType || "image/png",
            );
            layoutDescription = await extractUIFromImage(reconstructed);
          } catch (imgError) {
            const imgErrorMsg =
              imgError instanceof Error
                ? imgError.message
                : "Image analysis failed";
            console.error("[ImageUI] Image analysis error:", imgError);
            sendStatus(
              `Image analysis failed; continuing with prompt fallback: ${imgErrorMsg}`,
            );
          }
        }

        if (!lowEndMode && !layoutDescription && payload.imageBase64) {
          sendStatus("Analyzing image reference...");
          try {
            layoutDescription = await extractUIFromImage(payload.imageBase64);
          } catch (imgError) {
            const imgErrorMsg =
              imgError instanceof Error
                ? imgError.message
                : "Image analysis failed";
            console.error("[ImageUI] Image base64 analysis error:", imgError);
            sendStatus(
              `Image analysis failed; continuing with prompt fallback: ${imgErrorMsg}`,
            );
          }
        }

        if (!layoutDescription) {
          layoutDescription = payload.prompt.trim();
        }

        if (!layoutDescription) {
          console.warn(
            "[ImageUI] No structural description available; continuing with prompt-only generation.",
          );
          layoutDescription =
            payload.prompt.trim() || "Best-effort UI reconstruction.";
        }

        const emitWorkerLog = (message: string) => {
          swarmManager.sendMessageToNode(conn, {
            type: "WORKER_STATUS",
            taskId: payload.taskId,
            message,
          });
        };

        const emitWorkerChunk = (chunk: string) => {
          if (!chunk) {
            return;
          }

          swarmManager.sendMessageToNode(conn, {
            type: "WORKER_STREAM",
            chunk,
          });
        };

        const taskPayload: SwarmTaskPayload = {
          type: "TASK_ASSIGN",
          taskId: payload.taskId,
          fileName: "src/App.jsx",
          instructions: [
            payload.prompt.trim(),
            "",
            "[STRUCTURAL DESCRIPTION]",
            layoutDescription,
            "",
            "Build a faithful React + Tailwind implementation from this structure.",
            "Preserve the exact composition, whitespace, card placement, label alignment, and visual hierarchy from the screenshot description.",
            "Do not collapse the UI into a generic template, dashboard, or split workspace.",
            "If the source is a login card, keep it centered with the same relative spacing and footer layout.",
            "Use a contemporary polished visual style: clean sans-serif typography, refined spacing, rounded cards, subtle shadows, and modern form controls. Avoid dated HTML styling, browser-default controls, and 1990s aesthetics.",
            "Return only one complete React component.",
            "Use only React and useState from react.",
            "No external packages, no placeholder template content, no safe-mode fallback, and no generic boilerplate.",
            "Implement native drag-and-drop and editable text exactly as instructed.",
          ]
            .filter(Boolean)
            .join("\n"),
        };

        const generatedCode = await executeWorkerTaskWithStreaming(
          taskPayload,
          workerEngine,
          {
            onLog: emitWorkerLog,
            onChunk: emitWorkerChunk,
          },
        );

        if (!generatedCode.trim()) {
          console.warn(
            "[ImageUI] Worker returned an empty code payload; forwarding anyway.",
          );
        }

        swarmManager.sendMessageToNode(conn, {
          type: "WORKER_COMPLETE",
          code: generatedCode,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Worker execution failed unexpectedly.";

        swarmManager.sendMessageToNode(conn, {
          type: "WORKER_STATUS",
          taskId: payload.taskId,
          message: `Worker failed: ${message}`,
        });

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

      const workerOutput = payload.code || payload.prompt || "";

      if (payload.error || !payload.code) {
        const message = payload.error || "No distributed code returned.";
        console.warn("[AgenticIDE] Distributed worker fallback:", {
          message,
          workerOutput,
        });

        setMultimodalError(null);
        setChatHistory((prev) => [
          ...prev,
          {
            id: `assistant_${Date.now()}_distributed_error`,
            role: "assistant",
            content: `Distributed generation returned a fallback payload: ${message}. Continuing to the editor.`,
            timestamp: new Date(),
          },
        ]);
      }

      appendSwarmLog("[Swarm] Worker complete. Rendering code and preview...");
      setCanvasCode(workerOutput);

      const previewResult = await executeGeneratedCodeDirectly(
        workerOutput,
        payload.prompt,
      );

      setChatHistory((prev) => [
        ...prev,
        {
          id: `assistant_${Date.now()}_distributed_complete`,
          role: "assistant",
          content: previewResult.success
            ? "Worker returned code successfully. Preview updated."
            : `Worker returned code, but preview failed: ${previewResult.error || "Unknown error."}`,
          timestamp: new Date(),
        },
      ]);
    });

    return () => {
      swarmManager.onImageUiTask(null);
      swarmManager.onImageUiStatus(null);
      swarmManager.onImageUiResult(null);
      swarmManager.onWorkerStatus(null);
      swarmManager.onWorkerLog(null);
      swarmManager.onWorkerStream(null);
      swarmManager.onWorkerComplete(null);
    };
  }, [
    appendSwarmLog,
    appendWorkerTerminalLine,
    dataUrlToImageBytes,
    engine,
    executeGeneratedCodeDirectly,
    imageBytesToDataUrl,
    lowEndMode,
    swarmManager,
  ]);

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
        const trimmedTargetPeerId = targetPeerId.trim();
        if (!trimmedTargetPeerId) {
          throw new Error(
            "Peer ID is required for both Master and Worker connection.",
          );
        }

        if (role === "worker") {
          swarmManager.setLocalRoleIntent("worker");
          await swarmManager.connectToNode(trimmedTargetPeerId, {
            asMaster: false,
          });
          swarmManager.setWorkerMode();
          swarmManager.syncSwarmRole(
            trimmedTargetPeerId,
            trimmedTargetPeerId,
            "worker",
          );
          return;
        }

        swarmManager.setLocalRoleIntent("master");
        await swarmManager.connectToNode(trimmedTargetPeerId, {
          asMaster: true,
        });
        swarmManager.promoteToMaster();

        if (swarmManager.peerId) {
          swarmManager.syncSwarmRole(
            swarmManager.peerId,
            trimmedTargetPeerId,
            "master",
          );
        }
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

  const canvasIsBusy =
    state.isLoading ||
    state.isExecuting ||
    isDistributedProcessing ||
    isAnalyzingImage;

  const previewFrameKey = `${state.previewUrl ?? "preview"}:${canvasCode ?? "empty"}`;

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
    <div className="h-screen w-full overflow-hidden bg-gradient-to-br from-slate-950 via-zinc-950 to-slate-900 text-zinc-100">
      <div className="flex h-full w-full flex-row overflow-hidden">
        <aside className="flex h-full w-[30%] min-w-[340px] max-w-[460px] flex-col overflow-hidden border-r border-zinc-800/80 bg-zinc-950/95">
          <div className="shrink-0 border-b border-zinc-800/80 px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-300">
                  Command Center
                </p>
                <h1 className="mt-1 text-xl font-semibold tracking-tight text-zinc-50">
                  SouthStack Generative Canvas
                </h1>
                <p className="mt-1 text-sm text-zinc-400">
                  Describe what you want. The canvas updates instantly.
                </p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <span
                  className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] ${peerStatus.tone}`}
                >
                  {peerStatus.label}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-300 md:hidden">
                  <Sparkles className="h-3 w-3" />
                  {mobileHeaderStatus}
                </span>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
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
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-100 transition hover:border-zinc-500 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {state.isLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  {state.isLoading ? "Bootstrapping" : "Initialize"}
                </button>
              ) : (
                <div className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                  <Sparkles className="h-4 w-4" />
                  Ready
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

              <button
                type="button"
                onClick={() => setIsLogsExpanded((prev) => !prev)}
                className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300 transition hover:bg-zinc-800"
              >
                {isLogsExpanded ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
                {isLogsExpanded ? "Hide logs" : "Show logs"}
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4">
            <div className="shrink-0 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3">
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
                <div className="mb-3 rounded-xl border border-zinc-700 bg-zinc-950/60 p-2">
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
                  className="min-h-[76px] max-h-[180px] min-w-0 flex-1 resize-none rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                  disabled={!isReady || isAgentBusy}
                />

                <button
                  onClick={() => {
                    void handleSendPrompt();
                  }}
                  disabled={!isReady || isAgentBusy || !userPrompt.trim()}
                  className="mb-1 inline-flex min-h-11 items-center gap-2 rounded-xl bg-zinc-100 px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:bg-zinc-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
                >
                  {isAgentBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <SendHorizonal className="h-3.5 w-3.5" />
                  )}
                  Send
                </button>
              </div>

              {(promptVoice.error || multimodalError) && (
                <p className="mt-2 text-xs text-rose-300">
                  {promptVoice.error || multimodalError}
                </p>
              )}

              {chatHistory.length > 0 && (
                <div className="mt-3 max-h-24 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                  {chatHistory.slice(-3).map((message) => (
                    <p
                      key={message.id}
                      className="mb-1 text-xs text-zinc-400 last:mb-0"
                    >
                      <span className="font-medium text-zinc-300">
                        {message.role === "user" ? "You" : "Agent"}:
                      </span>{" "}
                      {message.content}
                    </p>
                  ))}
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.18em] text-cyan-300">
                    System Logs
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    Scrolls internally and never pushes layout down.
                  </p>
                </div>
                <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-400">
                  {minimalAgentStatus}
                </span>
              </div>

              <div className="max-h-full overflow-y-auto pr-1">
                {isLogsExpanded ? (
                  <AgentActivityStream
                    logs={mergedLogs}
                    swarmLogs={swarmActivityLogs}
                    isInitialized={state.isInitialized}
                    isLoading={state.isLoading}
                    initProgress={state.initProgress}
                    isListening={promptVoice.isListening}
                    voiceError={promptVoice.error}
                    currentPhase={
                      isAgentBusy ? "executing" : state.currentPhase
                    }
                    retryCount={state.retryCount}
                    generatedCode={canvasCode}
                    error={state.error || multimodalError}
                  />
                ) : (
                  <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/60 px-4 py-6 text-center text-xs text-zinc-500">
                    Expand logs to inspect model and swarm activity.
                  </div>
                )}
              </div>

              <div className="mt-3 rounded-2xl border border-zinc-800 bg-black p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.18em] text-emerald-300">
                      Terminal
                    </p>
                    <p className="text-[11px] text-zinc-500">
                      Fixed-height, internal scroll only.
                    </p>
                  </div>
                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300">
                    Live
                  </span>
                </div>
                <div
                  ref={workerTerminalRef}
                  className="max-h-64 overflow-y-auto rounded-xl bg-black p-2 font-mono text-[11px] leading-5 text-green-400"
                >
                  {workerTerminalLines.length === 0 &&
                    workerStreamPreview.length === 0 && (
                      <p className="text-zinc-500">
                        Waiting for worker logs...
                      </p>
                    )}
                  {workerTerminalLines.map((line, index) => (
                    <p key={`worker-log-${index}`}>{line}</p>
                  ))}
                  {workerStreamPreview && (
                    <>
                      <p className="mt-3 text-cyan-300">--- STREAM ---</p>
                      <pre className="whitespace-pre-wrap break-words text-zinc-300">
                        {workerStreamPreview}
                      </pre>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </aside>

        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-gradient-to-br from-slate-950 via-zinc-950 to-slate-900">
          <div className="shrink-0 border-b border-zinc-800/80 bg-zinc-950/70 px-4 py-3 backdrop-blur">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-[0.22em] text-violet-300">
                  The Canvas
                </p>
                <h2 className="mt-1 text-lg font-semibold tracking-tight text-zinc-50 sm:text-xl">
                  Gemini-style split workspace
                </h2>
                <p className="text-sm text-zinc-400">
                  Code editor on one side, live preview on the other.
                </p>
              </div>

              <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/80 p-1">
                <button
                  onClick={() => setActiveTab("split")}
                  className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium transition ${
                    activeTab === "split"
                      ? "bg-zinc-200 text-zinc-900"
                      : "text-zinc-400 hover:text-zinc-100"
                  }`}
                >
                  Split
                </button>
                <button
                  onClick={() => setActiveTab("code")}
                  className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium transition ${
                    activeTab === "code"
                      ? "bg-zinc-200 text-zinc-900"
                      : "text-zinc-400 hover:text-zinc-100"
                  }`}
                >
                  <Code2 className="h-3.5 w-3.5" />
                  Code
                </button>
                <button
                  onClick={() => setActiveTab("preview")}
                  className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium transition ${
                    activeTab === "preview"
                      ? "bg-zinc-200 text-zinc-900"
                      : "text-zinc-400 hover:text-zinc-100"
                  }`}
                >
                  <Eye className="h-3.5 w-3.5" />
                  Preview
                </button>
              </div>
            </div>
          </div>

          <div className="relative flex min-h-0 flex-1 overflow-hidden p-4">
            {canvasIsBusy && !state.previewUrl && (
              <div className="pointer-events-none absolute inset-4 z-10 overflow-hidden rounded-[28px] border border-cyan-500/20 bg-zinc-950/70 backdrop-blur-md">
                <div className="flex h-full items-center justify-center px-6 py-8">
                  <div className="max-w-xl text-center">
                    <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-cyan-400/30 bg-cyan-500/10 shadow-[0_0_40px_rgba(34,211,238,0.15)]">
                      <Loader2 className="h-7 w-7 animate-spin text-cyan-300" />
                    </div>
                    <p className="text-[11px] uppercase tracking-[0.24em] text-cyan-300">
                      Generating UI...
                    </p>
                    <h3 className="mt-2 text-2xl font-semibold text-zinc-50">
                      The models are shaping the canvas.
                    </h3>
                    <p className="mt-3 text-sm leading-6 text-zinc-400">
                      The 3B blueprint stage and 7B coder stage are still
                      running. The preview will mount automatically as soon as
                      the code lands in WebContainer.
                    </p>
                    <div className="mt-6 space-y-3 text-left">
                      <div className="h-4 overflow-hidden rounded-full bg-zinc-800">
                        <div className="h-full w-2/3 animate-pulse rounded-full bg-gradient-to-r from-cyan-500 via-sky-400 to-violet-400" />
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        <div className="h-28 rounded-2xl border border-zinc-800 bg-zinc-900/60 animate-pulse" />
                        <div className="h-28 rounded-2xl border border-zinc-800 bg-zinc-900/60 animate-pulse" />
                        <div className="h-28 rounded-2xl border border-zinc-800 bg-zinc-900/60 animate-pulse" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div
              className={`grid h-full min-h-0 w-full gap-4 ${activeTab === "split" ? "grid-cols-2" : "grid-cols-1"}`}
            >
              {(activeTab === "split" || activeTab === "code") && (
                <section className="flex min-h-0 flex-col overflow-hidden rounded-[28px] border border-zinc-800 bg-zinc-950/80 shadow-[0_24px_80px_rgba(2,6,23,0.45)]">
                  <div className="shrink-0 border-b border-zinc-800/80 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[11px] uppercase tracking-[0.18em] text-cyan-300">
                          Code Editor
                        </p>
                        <p className="text-[11px] text-zinc-500">
                          Live-streamed from the 7B coder stage.
                        </p>
                      </div>
                      {canvasCode && (
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
                      )}
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <CollaborativeCodeEditor
                      generatedCode={canvasCode}
                      language={detectedLanguage}
                      isAgentBusy={isAgentBusy}
                      pauseAgentEdits={pauseAgentEdits}
                      onPauseAgentEditsChange={setPauseAgentEdits}
                      focusRequest={focusRequest}
                    />
                  </div>
                </section>
              )}

              {(activeTab === "split" || activeTab === "preview") && (
                <section className="flex min-h-0 flex-col overflow-hidden rounded-[28px] border border-zinc-800 bg-zinc-950/80 shadow-[0_24px_80px_rgba(2,6,23,0.45)]">
                  <div className="shrink-0 border-b border-zinc-800/80 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[11px] uppercase tracking-[0.18em] text-violet-300">
                          Live Preview
                        </p>
                        <p className="text-[11px] text-zinc-500">
                          Automatically remounts when the generated code
                          updates.
                        </p>
                      </div>
                      <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-400">
                        {state.previewUrl ? "Mounted" : "Waiting"}
                      </span>
                    </div>
                  </div>

                  <div className="relative min-h-0 flex-1 overflow-hidden bg-zinc-950">
                    {state.previewUrl ? (
                      <ErrorBoundary
                        fallback={
                          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                            <div className="text-4xl">⚠️</div>
                            <h3 className="text-sm font-semibold text-zinc-300">
                              AI generated incomplete syntax due to hardware
                              limits
                            </h3>
                            <p className="max-w-md text-xs leading-relaxed text-zinc-500">
                              Please add the missing bracket in the Code Editor
                              to render the UI.
                            </p>
                          </div>
                        }
                        onError={handlePreviewError}
                      >
                        <iframe
                          key={previewFrameKey}
                          title="SouthStack Live Preview"
                          src={state.previewUrl}
                          className="h-full w-full bg-white"
                          sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                        />
                      </ErrorBoundary>
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                        <Eye className="h-8 w-8 text-zinc-500" />
                        <h3 className="text-sm font-semibold text-zinc-300">
                          Your generated UI appears here
                        </h3>
                        <p className="max-w-md text-xs leading-relaxed text-zinc-500">
                          Send a prompt, then the code will be written to the
                          active WebContainer file and mounted automatically.
                        </p>
                      </div>
                    )}
                  </div>
                </section>
              )}
            </div>
          </div>
        </main>
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
                    resetGeneratedCanvas();
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
