import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Brain,
  Bug,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Mic,
  Network,
  Package,
  RotateCcw,
  Wifi,
} from "lucide-react";

type LogType = "info" | "success" | "error" | "warning";

interface AgentLogEntry {
  timestamp: Date;
  phase: string;
  message: string;
  type: LogType;
}

interface SwarmLogEntry {
  id: string;
  timestamp: Date;
  message: string;
}

type StepStatus = "pending" | "active" | "complete" | "error";

interface ActivityStep {
  key:
    | "bootstrapping"
    | "listening"
    | "thinking"
    | "executing"
    | "analyzing-error"
    | "self-healing";
  label: string;
  status: StepStatus;
  summary: string;
  badge: string;
  details?: string;
  progress?: number;
  liveMetric?: string;
}

interface AgentActivityStreamProps {
  logs: AgentLogEntry[];
  swarmLogs?: SwarmLogEntry[];
  isInitialized: boolean;
  isLoading: boolean;
  initProgress: number;
  isListening: boolean;
  voiceError: string | null;
  thinkingSummaryOverride?: string | null;
  currentPhase:
    | "idle"
    | "generating"
    | "executing"
    | "fixing"
    | "completed"
    | "error";
  retryCount: number;
  generatedCode: string | null;
  error: string | null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function parseProgressPercent(message: string): number | null {
  const match = message.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return clampPercent(parsed);
}

function formatLogsForDisplay(
  relevantLogs: AgentLogEntry[],
  fallbackText?: string,
): string {
  if (relevantLogs.length === 0 && fallbackText) {
    return fallbackText;
  }

  return relevantLogs
    .slice(-10) // Show last 10 logs
    .map((log) => {
      const time = log.timestamp.toLocaleTimeString();
      const icon =
        log.type === "success"
          ? "✓"
          : log.type === "error"
            ? "✗"
            : log.type === "warning"
              ? "⚠"
              : "•";
      return `${icon} [${time}] ${log.message}`;
    })
    .join("\n");
}

function statusStyles(status: StepStatus) {
  switch (status) {
    case "active":
      return {
        container: "border-cyan-500/40 bg-cyan-500/10",
        iconWrap: "border-cyan-400/50 bg-cyan-500/20 text-cyan-200",
        badge: "border-cyan-400/40 bg-cyan-500/15 text-cyan-200",
      };
    case "complete":
      return {
        container: "border-emerald-500/40 bg-emerald-500/10",
        iconWrap: "border-emerald-400/50 bg-emerald-500/20 text-emerald-200",
        badge: "border-emerald-400/40 bg-emerald-500/15 text-emerald-200",
      };
    case "error":
      return {
        container: "border-rose-500/40 bg-rose-500/10",
        iconWrap: "border-rose-400/50 bg-rose-500/20 text-rose-200",
        badge: "border-rose-400/40 bg-rose-500/15 text-rose-200",
      };
    default:
      return {
        container: "border-zinc-700 bg-zinc-900",
        iconWrap: "border-zinc-600 bg-zinc-800 text-zinc-300",
        badge: "border-zinc-600 bg-zinc-800 text-zinc-300",
      };
  }
}

function StepIcon({ step }: { step: ActivityStep }) {
  if (step.status === "active") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  }

  if (step.status === "complete") {
    return <CheckCircle2 className="h-3.5 w-3.5" />;
  }

  if (step.status === "error") {
    return <AlertTriangle className="h-3.5 w-3.5" />;
  }

  switch (step.key) {
    case "bootstrapping":
      return <Package className="h-3.5 w-3.5" />;
    case "listening":
      return <Mic className="h-3.5 w-3.5" />;
    case "thinking":
      return <Brain className="h-3.5 w-3.5" />;
    case "executing":
      return <Package className="h-3.5 w-3.5" />;
    case "analyzing-error":
      return <Bug className="h-3.5 w-3.5" />;
    case "self-healing":
      return <RotateCcw className="h-3.5 w-3.5" />;
    default:
      return <CheckCircle2 className="h-3.5 w-3.5" />;
  }
}

export const AgentActivityStream: React.FC<AgentActivityStreamProps> = ({
  logs,
  swarmLogs,
  isInitialized,
  isLoading,
  initProgress,
  isListening,
  voiceError,
  thinkingSummaryOverride,
  currentPhase,
  retryCount,
  generatedCode,
  error,
}) => {
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({});
  const [thinkingTokenEstimate, setThinkingTokenEstimate] = useState(0);
  const thinkingStartRef = useRef<number | null>(null);

  const latestInitLog = useMemo(() => {
    for (let i = logs.length - 1; i >= 0; i -= 1) {
      if (logs[i].phase === "initialization") {
        return logs[i];
      }
    }

    return null;
  }, [logs]);

  const bootstrappingPercent = useMemo(() => {
    if (latestInitLog) {
      const fromMessage = parseProgressPercent(latestInitLog.message);
      if (fromMessage !== null) {
        return fromMessage;
      }
    }

    if (isInitialized) {
      return 100;
    }

    return isLoading ? Math.max(8, initProgress) : 0;
  }, [initProgress, isInitialized, isLoading, latestInitLog]);

  const bootstrappingLogs = useMemo(
    () => logs.filter((log) => log.phase === "initialization"),
    [logs],
  );

  const thinkingLogs = useMemo(
    () => logs.filter((log) => log.phase === "generating"),
    [logs],
  );

  const executionLogs = useMemo(
    () => logs.filter((log) => log.phase === "execution"),
    [logs],
  );

  const fixingLogs = useMemo(
    () => logs.filter((log) => log.phase === "fixing"),
    [logs],
  );

  const errorLogs = useMemo(
    () => logs.filter((log) => log.type === "error"),
    [logs],
  );

  const latestErrorLog =
    errorLogs.length > 0 ? errorLogs[errorLogs.length - 1] : null;

  useEffect(() => {
    if (currentPhase === "generating") {
      if (thinkingStartRef.current === null) {
        thinkingStartRef.current = Date.now();
      }

      const interval = window.setInterval(() => {
        const elapsedMs = Date.now() - (thinkingStartRef.current ?? Date.now());
        const estimated = Math.floor((elapsedMs / 1000) * 12);
        setThinkingTokenEstimate(Math.max(1, estimated));
      }, 180);

      return () => {
        window.clearInterval(interval);
      };
    }

    if (generatedCode) {
      const finalEstimate = Math.max(1, Math.ceil(generatedCode.length / 4));
      setThinkingTokenEstimate(finalEstimate);
    } else if (currentPhase === "idle") {
      setThinkingTokenEstimate(0);
    }

    thinkingStartRef.current = null;
    return undefined;
  }, [currentPhase, generatedCode]);

  const steps = useMemo<ActivityStep[]>(() => {
    const hasAnyError = Boolean(error || latestErrorLog);

    const bootstrapStatus: StepStatus = isLoading
      ? "active"
      : isInitialized
        ? "complete"
        : hasAnyError && !isInitialized
          ? "error"
          : "pending";

    const listeningStatus: StepStatus = isListening ? "active" : "pending";

    const thinkingStatus: StepStatus =
      currentPhase === "generating"
        ? "active"
        : generatedCode
          ? "complete"
          : currentPhase === "error"
            ? "error"
            : "pending";

    const executingStatus: StepStatus =
      currentPhase === "executing"
        ? "active"
        : currentPhase === "completed"
          ? "complete"
          : currentPhase === "error"
            ? "error"
            : "pending";

    const analyzingStatus: StepStatus =
      currentPhase === "error"
        ? "active"
        : latestErrorLog
          ? "complete"
          : "pending";

    const selfHealingStatus: StepStatus =
      currentPhase === "fixing"
        ? "active"
        : retryCount > 0 && currentPhase === "completed"
          ? "complete"
          : retryCount >= 3 && currentPhase === "error"
            ? "error"
            : retryCount > 0
              ? "complete"
              : "pending";

    return [
      {
        key: "bootstrapping",
        label: "[Bootstrapping]",
        status: bootstrapStatus,
        summary: isLoading
          ? "WebLLM engine download and initialization in progress."
          : isInitialized
            ? "Engine initialized and ready."
            : "Engine is waiting to initialize.",
        badge: `${Math.round(bootstrappingPercent)}%`,
        progress: bootstrappingPercent,
        details: formatLogsForDisplay(
          bootstrappingLogs,
          "No initialization logs yet. Click 'Initialize' to begin.",
        ),
      },
      {
        key: "listening",
        label: "[Listening]",
        status: listeningStatus,
        summary: isListening
          ? "Listening for audio input and preparing multimodal context."
          : "Audio/OCR listeners are idle.",
        badge: isListening ? "ACTIVE" : "IDLE",
        details: voiceError
          ? `✗ Voice error: ${voiceError}\n\nTry refreshing the page or checking your microphone permissions.`
          : isListening
            ? "🎤 Microphone active...\n\nWaiting for voice input. Speak clearly to describe the UI you want to build."
            : "Microphone is not currently active. Click the microphone icon to start voice mode.",
      },
      {
        key: "thinking",
        label: "[Thinking]",
        status: thinkingStatus,
        summary:
          currentPhase === "generating"
            ? thinkingSummaryOverride || "Generating code from your prompt..."
            : generatedCode
              ? "Generation complete."
              : "Awaiting prompt.",
        badge: `${thinkingTokenEstimate} tok`,
        liveMetric: `${thinkingTokenEstimate} tokens`,
        details:
          currentPhase === "generating" || generatedCode
            ? formatLogsForDisplay(
                thinkingLogs,
                "Thinking logs appear here as code is generated...",
              )
            : "Enter a prompt and click Generate to start the thinking process.",
      },
      {
        key: "executing",
        label: "[Executing]",
        status: executingStatus,
        summary:
          currentPhase === "executing"
            ? "Bundling code and starting WebContainer dev server."
            : currentPhase === "completed"
              ? "Execution finished and preview is up."
              : "Execution pipeline is idle.",
        badge:
          executionLogs.length > 0 ? `${executionLogs.length} logs` : "WAIT",
        details: formatLogsForDisplay(
          executionLogs,
          "Execution logs will appear here when code is generated and rendering begins.",
        ),
      },
      {
        key: "analyzing-error",
        label: "[Analyzing Error]",
        status: analyzingStatus,
        summary:
          currentPhase === "error"
            ? "Capturing stack trace and runtime diagnostics."
            : latestErrorLog
              ? "Last error captured for analysis."
              : "No active runtime errors.",
        badge: latestErrorLog ? "STACK" : "CLEAR",
        details: formatLogsForDisplay(
          errorLogs,
          "No errors encountered. System running smoothly.",
        ),
      },
      {
        key: "self-healing",
        label: "[Self-Healing]",
        status: selfHealingStatus,
        summary:
          currentPhase === "fixing"
            ? `Fixing an error... Attempt ${retryCount} of 3.`
            : retryCount > 0
              ? `Self-healing has run ${retryCount} time(s).`
              : "Auto-repair loop is standing by.",
        badge: `Attempt ${Math.min(retryCount, 3)}/3`,
        details: formatLogsForDisplay(
          fixingLogs,
          retryCount === 0
            ? "Auto-repair has not been triggered yet."
            : `Self-healing has corrected ${retryCount} issue(s).`,
        ),
      },
    ];
  }, [
    bootstrappingPercent,
    bootstrappingLogs,
    currentPhase,
    error,
    errorLogs,
    executionLogs,
    fixingLogs,
    generatedCode,
    isInitialized,
    isListening,
    isLoading,
    latestErrorLog,
    latestInitLog,
    retryCount,
    thinkingLogs,
    thinkingSummaryOverride,
    thinkingTokenEstimate,
    voiceError,
  ]);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-300">
          Agent Activity Stream
        </h3>
        <span className="text-[11px] text-zinc-500">Glass Box Mode</span>
      </div>

      <div className="space-y-2">
        {steps.map((step, index) => {
          const styles = statusStyles(step.status);
          const isExpanded = Boolean(expandedMap[step.key]);

          return (
            <motion.div
              key={step.key}
              layout
              className={`relative rounded-lg border p-3 ${styles.container}`}
            >
              {index < steps.length - 1 && (
                <div className="absolute left-[17px] top-[44px] h-[calc(100%-28px)] w-px bg-zinc-700/70" />
              )}

              <div className="flex items-start gap-3">
                <div
                  className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${styles.iconWrap}`}
                >
                  <StepIcon step={step} />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-zinc-100">
                      {step.label}
                    </span>
                    <span
                      className={`rounded-md border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${styles.badge}`}
                    >
                      {step.badge}
                    </span>
                    {step.liveMetric && step.status === "active" && (
                      <span className="text-[10px] text-zinc-400">
                        {step.liveMetric}
                      </span>
                    )}
                  </div>

                  <p className="text-xs leading-relaxed text-zinc-300">
                    {step.summary}
                  </p>

                  {typeof step.progress === "number" && (
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                      <motion.div
                        className="h-full rounded-full bg-cyan-400"
                        initial={false}
                        animate={{ width: `${clampPercent(step.progress)}%` }}
                        transition={{ duration: 0.25 }}
                      />
                    </div>
                  )}

                  {step.details && (
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedMap((prev) => ({
                          ...prev,
                          [step.key]: !prev[step.key],
                        }))
                      }
                      className="mt-2 inline-flex items-center gap-1 text-[11px] text-zinc-400 transition hover:text-zinc-200"
                    >
                      {isExpanded ? (
                        <ChevronUp className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" />
                      )}
                      Expand Details
                    </button>
                  )}

                  <AnimatePresence initial={false}>
                    {isExpanded && step.details && (
                      <motion.pre
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="mt-2 overflow-x-auto rounded-md border border-zinc-700 bg-zinc-950 p-2 text-[10px] leading-relaxed text-zinc-400"
                      >
                        {step.details}
                      </motion.pre>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      {swarmLogs && swarmLogs.length > 0 && (
        <div className="mt-3 rounded-lg border border-sky-500/35 bg-sky-500/10 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-sky-100">
              <Network className="h-3.5 w-3.5" />
              [Swarm] Distributed Activity
            </div>
            <span className="text-[10px] uppercase tracking-wide text-sky-200/80">
              {swarmLogs.length} event{swarmLogs.length > 1 ? "s" : ""}
            </span>
          </div>

          <div className="space-y-1.5">
            {swarmLogs.slice(-8).map((log) => (
              <div
                key={log.id}
                className="rounded-md border border-sky-400/25 bg-zinc-950/70 px-2.5 py-2"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-sky-200/85">
                    <Wifi className="h-3 w-3" />
                    Swarm
                  </span>
                  <span className="text-[10px] text-zinc-500">
                    {log.timestamp.toLocaleTimeString()}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-sky-100">
                  {log.message}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default AgentActivityStream;
