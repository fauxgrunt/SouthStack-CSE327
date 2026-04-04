import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DataConnection } from "peerjs";
import type { SwarmMode } from "../hooks/useSwarmManager";
import { useVoiceInput } from "../hooks/useVoiceInput";

type WorkflowMode = "codegen" | "debug";
type DeviceProfile = "low" | "high";
type ProfileMode = "auto" | DeviceProfile;

type DebugSourceInput = {
  fileName: string;
  content: string | AsyncIterable<string>;
};

interface SwarmControlPanelProps {
  // Swarm state
  peerId: string | null;
  connectionStatus: string;
  activeConnectionCount: number;
  swarmMode: SwarmMode;
  isProcessing: boolean;
  currentTask: string | null;
  isInitialized: boolean;

  // Actions
  connectToNode: (targetId: string) => Promise<DataConnection>;
  disconnectAll: () => void;
  distributeTask: (userPrompt: string) => Promise<unknown>;
  distributeDebugAnalysis?: (
    files: DebugSourceInput[],
    options?: {
      chunkSize?: number;
      sessionId?: string;
      prefetchWindow?: number;
    },
  ) => Promise<unknown>;
  getProgress: () => {
    total: number;
    completed: number;
    pending: number;
    failed: number;
    percentage: number;
  };
  getAllTasks?: () => Array<{
    taskId: string;
    assignment: { fileName: string; instructions: string };
    nodeId: string;
    status: "pending" | "completed" | "failed" | "timeout";
    code?: string;
    error?: string;
    timestamp: number;
  }>;
  isMasterHeartbeatHealthy?: boolean;
}

/**
 * SwarmControlPanel - UI for managing P2P swarm connections
 *
 * Allows users to:
 * - View their peer ID
 * - Connect to other nodes
 * - Manage swarm mode (Master/Worker/Standalone)
 * - Distribute tasks across the swarm
 */
export const SwarmControlPanel: React.FC<SwarmControlPanelProps> = ({
  peerId,
  connectionStatus,
  activeConnectionCount,
  swarmMode,
  isProcessing,
  currentTask,
  isInitialized,
  connectToNode,
  disconnectAll,
  distributeTask,
  distributeDebugAnalysis,
  getProgress,
  getAllTasks,
  isMasterHeartbeatHealthy = true,
}) => {
  const detectedProfile = useMemo<DeviceProfile>(() => {
    const nav = navigator as Navigator & { deviceMemory?: number };
    const deviceMemory = nav.deviceMemory ?? 8;
    const cores = navigator.hardwareConcurrency ?? 4;
    return deviceMemory <= 8 || cores <= 4 ? "low" : "high";
  }, []);

  const [profileMode, setProfileMode] = useState<ProfileMode>("auto");
  const [includeExtendedFileTypes, setIncludeExtendedFileTypes] =
    useState(false);
  const [highThroughputRepoIntake, setHighThroughputRepoIntake] =
    useState(false);

  const effectiveProfile: DeviceProfile =
    profileMode === "auto" ? detectedProfile : profileMode;

  const profileConfig = useMemo(() => {
    if (effectiveProfile === "low") {
      return {
        defaultChunkSize: 8000,
        defaultPrefetchWindow: 1,
        maxRepoFiles: 180,
        maxUploadFiles: 220,
      };
    }

    return {
      defaultChunkSize: 16000,
      defaultPrefetchWindow: 4,
      maxRepoFiles: highThroughputRepoIntake ? 2400 : 1200,
      maxUploadFiles: highThroughputRepoIntake ? 2600 : 1400,
    };
  }, [effectiveProfile, highThroughputRepoIntake]);

  const [targetPeerId, setTargetPeerId] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode>("codegen");
  const [githubRepoUrl, setGithubRepoUrl] = useState("");
  const [debugFiles, setDebugFiles] = useState<DebugSourceInput[]>([]);
  const [isLoadingRepo, setIsLoadingRepo] = useState(false);
  const [selectedChunkSize, setSelectedChunkSize] = useState(
    profileConfig.defaultChunkSize,
  );
  const [prefetchWindow, setPrefetchWindow] = useState(
    profileConfig.defaultPrefetchWindow,
  );
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [peerIdCopied, setPeerIdCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const directoryInputRef = useRef<HTMLInputElement | null>(null);

  const appendTaskPromptTranscript = useCallback((transcript: string) => {
    setTaskPrompt((prev) => {
      if (prev.trim().length === 0) {
        return transcript;
      }

      return `${prev}${/\s$/.test(prev) ? "" : " "}${transcript}`;
    });
  }, []);

  const taskPromptVoice = useVoiceInput(appendTaskPromptTranscript);

  const hasConnectedWorkers = activeConnectionCount > 0;
  const isTaskPromptEmpty = taskPrompt.trim().length === 0;
  const isCodegenMode = workflowMode === "codegen";
  const hasDebugInput =
    debugFiles.length > 0 || githubRepoUrl.trim().length > 0;
  const isTaskInputDisabled =
    !hasConnectedWorkers || isProcessing || !isCodegenMode;
  const canSubmitTask =
    !isProcessing &&
    hasConnectedWorkers &&
    ((isCodegenMode && !isTaskPromptEmpty) ||
      (!isCodegenMode && hasDebugInput));

  useEffect(() => {
    if (!directoryInputRef.current) {
      return;
    }

    directoryInputRef.current.setAttribute("webkitdirectory", "");
  }, []);

  useEffect(() => {
    setSelectedChunkSize(profileConfig.defaultChunkSize);
    setPrefetchWindow(profileConfig.defaultPrefetchWindow);
  }, [profileConfig.defaultChunkSize, profileConfig.defaultPrefetchWindow]);

  const progress = getProgress();

  const allTasks = getAllTasks ? getAllTasks() : [];
  const debugTasks = allTasks.filter((task) =>
    task.taskId.startsWith("debug_"),
  );
  const debugReports = debugTasks
    .filter((task) => task.status === "completed" && task.code)
    .sort((a, b) => b.timestamp - a.timestamp);

  const activeDebugTasks = debugTasks.filter(
    (task) => task.status === "pending",
  );
  const workerDebugMap = new Map<string, string[]>();

  activeDebugTasks.forEach((task) => {
    const existing = workerDebugMap.get(task.nodeId) ?? [];
    existing.push(task.assignment.fileName);
    workerDebugMap.set(task.nodeId, existing);
  });

  const workerDebugStatus = Array.from(workerDebugMap.entries());

  const streamLocalFile = (file: File): AsyncIterable<string> => {
    return {
      [Symbol.asyncIterator]: async function* () {
        const reader = file.stream().getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          if (value) {
            yield decoder.decode(value, { stream: true });
          }
        }
      },
    };
  };

  const handleFilesAdded = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }

    const nextFiles = Array.from(files)
      .slice(0, profileConfig.maxUploadFiles)
      .map((file) => {
        const relativePath = (file as File & { webkitRelativePath?: string })
          .webkitRelativePath;

        return {
          fileName:
            relativePath && relativePath.length > 0 ? relativePath : file.name,
          content: streamLocalFile(file),
        };
      });

    setDebugFiles((prev) => {
      const merged = new Map<string, DebugSourceInput>();
      [...prev, ...nextFiles].forEach((file) => {
        merged.set(file.fileName, file);
      });
      return Array.from(merged.values());
    });
  };

  const parseGitHubRepoUrl = (input: string) => {
    const url = new URL(input.trim());
    const segments = url.pathname.split("/").filter(Boolean);

    if (segments.length < 2) {
      throw new Error("Invalid GitHub repository URL");
    }

    const owner = segments[0];
    const repo = segments[1].replace(/\.git$/, "");
    const treeIndex = segments.indexOf("tree");
    const branch = treeIndex >= 0 ? segments[treeIndex + 1] : "main";
    const pathPrefix =
      treeIndex >= 0 ? segments.slice(treeIndex + 2).join("/") : "";

    return { owner, repo, branch, pathPrefix };
  };

  const streamGitHubFile = (
    owner: string,
    repo: string,
    branch: string,
    filePath: string,
  ): AsyncIterable<string> => {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;

    return {
      [Symbol.asyncIterator]: async function* () {
        const response = await fetch(rawUrl);

        if (!response.ok) {
          throw new Error(`Failed to fetch ${filePath}: ${response.status}`);
        }

        if (!response.body) {
          yield await response.text();
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          yield decoder.decode(value, { stream: true });
        }
      },
    };
  };

  const loadGitHubRepository = async (): Promise<DebugSourceInput[]> => {
    if (!githubRepoUrl.trim()) {
      return [];
    }

    const { owner, repo, branch, pathPrefix } =
      parseGitHubRepoUrl(githubRepoUrl);
    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;

    const treeResponse = await fetch(treeUrl);
    if (!treeResponse.ok) {
      throw new Error(
        `Failed to load repository tree (${treeResponse.status})`,
      );
    }

    const treeData = (await treeResponse.json()) as {
      tree?: Array<{ path: string; type: string }>;
    };

    const codeExtensions = includeExtendedFileTypes
      ? /\.(ts|tsx|js|jsx|py|go|rs|java|kt|swift|c|cpp|cs|php|rb|scala|sql|json|yaml|yml|md|txt|log|toml|ini|cfg)$/i
      : /\.(ts|tsx|js|jsx|py|go|rs|java|kt|swift|c|cpp|cs|php|rb|scala|sql|json|yaml|yml|md)$/i;

    const fileEntries = (treeData.tree ?? [])
      .filter((entry) => entry.type === "blob")
      .filter((entry) =>
        pathPrefix ? entry.path.startsWith(pathPrefix) : true,
      )
      .filter((entry) => codeExtensions.test(entry.path))
      .slice(0, profileConfig.maxRepoFiles);

    return fileEntries.map((entry) => ({
      fileName: entry.path,
      content: streamGitHubFile(owner, repo, branch, entry.path),
    }));
  };

  const handleCopyPeerId = async () => {
    if (peerId) {
      await navigator.clipboard.writeText(peerId);
      setPeerIdCopied(true);
      setTimeout(() => setPeerIdCopied(false), 2000);
    }
  };

  const handleConnect = async () => {
    if (!targetPeerId.trim()) {
      setError("Please enter a peer ID");
      return;
    }

    setIsConnecting(true);
    setError(null);

    try {
      await connectToNode(targetPeerId.trim());
      setTargetPeerId("");
      setError(null);
    } catch (err) {
      setError(`Connection failed: ${err}`);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDistribute = async () => {
    taskPromptVoice.stopListening();

    console.log("[SwarmUI] Distribute button clicked", {
      promptLength: taskPrompt.trim().length,
      mode: swarmMode,
      activeConnectionCount,
      isProcessing,
    });

    if (isProcessing) {
      setError("Swarm is currently processing another task");
      return;
    }

    if (activeConnectionCount === 0) {
      setError("No worker nodes connected");
      return;
    }

    setError(null);

    try {
      if (workflowMode === "codegen") {
        if (!taskPrompt.trim()) {
          setError("Please enter a task description");
          return;
        }

        console.log("[SwarmUI] Sending prompt to distributeTask", {
          prompt: taskPrompt.trim(),
        });
        await distributeTask(taskPrompt.trim());
        console.log("[SwarmUI] distributeTask call resolved successfully");
        setTaskPrompt("");
      } else {
        if (!distributeDebugAnalysis) {
          throw new Error("Debug analysis workflow is not available");
        }

        setIsLoadingRepo(true);
        const repoFiles = await loadGitHubRepository();
        const payloadFiles = [...debugFiles, ...repoFiles];

        if (payloadFiles.length === 0) {
          throw new Error(
            "Add uploaded files or a GitHub URL for debug analysis",
          );
        }

        await distributeDebugAnalysis(payloadFiles, {
          chunkSize: selectedChunkSize,
          prefetchWindow,
        });
      }
    } catch (err) {
      console.error("[SwarmUI] distributeTask call failed", err);
      setError(`Distribution failed: ${err}`);
    } finally {
      setIsLoadingRepo(false);
    }
  };

  const handleTaskPromptKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();

      if (canSubmitTask) {
        void handleDistribute();
      }
    }
  };

  const handleDisconnect = () => {
    disconnectAll();
    setError(null);
  };

  const getStatusColor = () => {
    switch (connectionStatus) {
      case "connected":
      case "ready":
        return "text-green-500";
      case "disconnected":
        return "text-gray-500";
      case "error":
        return "text-red-500";
      default:
        return "text-yellow-500";
    }
  };

  const getModeColor = () => {
    switch (swarmMode) {
      case "master":
        return "bg-blue-500";
      case "worker":
        return "bg-purple-500";
      default:
        return "bg-gray-500";
    }
  };

  const getModeIcon = () => {
    switch (swarmMode) {
      case "master":
        return "MASTER";
      case "worker":
        return "WORKER";
      default:
        return "STANDALONE";
    }
  };

  const heartbeatIndicatorColor = isMasterHeartbeatHealthy
    ? "bg-emerald-500"
    : "bg-red-500";

  const heartbeatLabel = isMasterHeartbeatHealthy
    ? "Heartbeat healthy"
    : "Master heartbeat lost";

  if (!isInitialized) {
    return (
      <div className="bg-gray-800 rounded-lg p-3 border border-gray-700">
        <p className="text-gray-400 text-sm">Initializing P2P Swarm...</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700">
      {/* Header */}
      <div
        className="flex items-center justify-between p-3 cursor-pointer hover:bg-gray-750"
        onClick={() => setShowPanel(!showPanel)}
      >
        <div className="flex items-center gap-3">
          <div className="text-2xl">{getModeIcon()}</div>
          <div>
            <h3 className="text-sm font-semibold text-white">Swarm Network</h3>
            <p className="text-xs text-gray-400">
              {swarmMode.charAt(0).toUpperCase() + swarmMode.slice(1)} Mode •{" "}
              {activeConnectionCount} nodes
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-gray-900 border border-gray-700">
            <span
              className={`w-2 h-2 rounded-full ${heartbeatIndicatorColor}`}
              title={heartbeatLabel}
            />
            <span className="text-[10px] text-gray-300">PING</span>
          </div>
          <span
            className={`text-xs font-medium px-2 py-1 rounded ${getModeColor()} text-white`}
          >
            {swarmMode.toUpperCase()}
          </span>
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform ${showPanel ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </div>
      </div>

      {/* Expandable Panel */}
      {showPanel && (
        <div className="border-t border-gray-700 p-3 space-y-3">
          {/* Status Bar */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-400">Status:</span>
            <span className={`font-medium ${getStatusColor()}`}>
              {connectionStatus.toUpperCase()}
            </span>
          </div>

          {/* Peer ID Display */}
          <div className="bg-gray-900 rounded p-2">
            <label className="text-xs text-gray-400 block mb-1">
              Your Peer ID:
            </label>
            <div className="flex items-center gap-2">
              <code className="text-xs text-green-400 flex-1 truncate">
                {peerId || "Connecting..."}
              </code>
              {peerId && (
                <button
                  onClick={handleCopyPeerId}
                  className={`text-xs px-2 py-1 rounded text-white font-medium transition-colors ${
                    peerIdCopied
                      ? "bg-green-600"
                      : "bg-gray-700 hover:bg-gray-600"
                  }`}
                >
                  {peerIdCopied ? "Copied!" : "Copy"}
                </button>
              )}
            </div>
          </div>

          {/* Connect to Node (Show only when standalone or master) */}
          {(swarmMode === "standalone" || swarmMode === "master") && (
            <div>
              <label className="text-xs text-gray-400 block mb-1">
                Connect to Worker Node:
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={targetPeerId}
                  onChange={(e) => setTargetPeerId(e.target.value)}
                  placeholder="Enter peer ID..."
                  className="flex-1 px-2 py-1 bg-gray-900 border border-gray-700 rounded text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  disabled={isConnecting}
                />
                <button
                  onClick={handleConnect}
                  disabled={isConnecting || !targetPeerId.trim()}
                  className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 rounded text-xs text-white font-medium"
                >
                  {isConnecting ? "..." : "Connect"}
                </button>
              </div>
            </div>
          )}

          {/* Active Connections */}
          {activeConnectionCount > 0 && (
            <div className="bg-gray-900 rounded p-2">
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-gray-400">
                  Active Connections:
                </label>
                <span className="text-xs font-semibold text-white">
                  {activeConnectionCount}
                </span>
              </div>
              <button
                onClick={handleDisconnect}
                className="w-full px-2 py-1 bg-red-600 hover:bg-red-700 rounded text-xs text-white font-medium"
              >
                Disconnect All
              </button>
            </div>
          )}

          {/* Task Distribution (Master only) */}
          {swarmMode === "master" && (
            <div className="bg-blue-900/20 border border-blue-500/30 rounded-lg p-3">
              <div className="flex gap-2 mb-3">
                <button
                  onClick={() => setWorkflowMode("codegen")}
                  className={`px-2.5 py-1 rounded text-xs font-semibold border ${
                    workflowMode === "codegen"
                      ? "bg-blue-600 border-blue-500 text-white"
                      : "bg-gray-900 border-gray-700 text-gray-300"
                  }`}
                >
                  Code Generation
                </button>
                <button
                  onClick={() => setWorkflowMode("debug")}
                  className={`px-2.5 py-1 rounded text-xs font-semibold border ${
                    workflowMode === "debug"
                      ? "bg-indigo-600 border-indigo-500 text-white"
                      : "bg-gray-900 border-gray-700 text-gray-300"
                  }`}
                >
                  Distributed Debugging
                </button>
              </div>

              <label className="text-xs text-blue-300 block mb-2 font-semibold tracking-wide">
                {workflowMode === "codegen"
                  ? "Distribute Task to Swarm:"
                  : "Distribute Debug Analysis:"}
              </label>

              {workflowMode === "codegen" ? (
                <>
                  <div className="mb-2 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={
                        taskPromptVoice.isListening
                          ? taskPromptVoice.stopListening
                          : taskPromptVoice.startListening
                      }
                      disabled={
                        !taskPromptVoice.isSupported || isTaskInputDisabled
                      }
                      className="px-2.5 py-1 rounded text-[11px] border border-gray-600 bg-gray-900 text-white hover:border-blue-400 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {taskPromptVoice.isListening ? "Stop Mic" : "Start Mic"}
                    </button>
                  </div>
                  <textarea
                    value={taskPrompt}
                    onChange={(e) => setTaskPrompt(e.target.value)}
                    onKeyDown={handleTaskPromptKeyDown}
                    placeholder={
                      hasConnectedWorkers
                        ? "Describe the feature, file outputs, and constraints..."
                        : "Connect at least one worker node to distribute a task"
                    }
                    className={`w-full px-3 py-2.5 bg-gray-900 border rounded-md text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 transition-colors mb-2 resize-y min-h-[92px] ${
                      isTaskInputDisabled
                        ? "border-gray-700 opacity-60 cursor-not-allowed"
                        : "border-gray-600 focus:border-blue-500 focus:ring-blue-500/30"
                    }`}
                    rows={4}
                    disabled={isTaskInputDisabled}
                  />
                  {!taskPromptVoice.isSupported && (
                    <p className="text-[11px] text-amber-300 mb-2">
                      Voice input is not supported in this browser.
                    </p>
                  )}
                  {taskPromptVoice.error && (
                    <p className="text-[11px] text-red-300 mb-2">
                      {taskPromptVoice.error}
                    </p>
                  )}
                </>
              ) : (
                <div className="space-y-2 mb-2">
                  <div className="bg-gray-900/80 border border-gray-700 rounded p-2 space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] text-gray-300 font-semibold">
                        Performance Profile
                      </p>
                      <span className="text-[10px] text-gray-400">
                        Detected: {detectedProfile.toUpperCase()} • Active:{" "}
                        {effectiveProfile.toUpperCase()}
                      </span>
                    </div>
                    <div className="flex gap-2">
                      {(["auto", "low", "high"] as const).map((mode) => (
                        <button
                          key={mode}
                          onClick={() => setProfileMode(mode)}
                          className={`px-2 py-1 rounded text-[11px] border ${
                            profileMode === mode
                              ? "bg-indigo-600 border-indigo-500 text-white"
                              : "bg-gray-800 border-gray-600 text-gray-300"
                          }`}
                          disabled={isProcessing}
                        >
                          {mode.toUpperCase()}
                        </button>
                      ))}
                    </div>

                    {effectiveProfile === "high" && (
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() =>
                            setHighThroughputRepoIntake((prev) => !prev)
                          }
                          className={`px-2 py-1 rounded text-[11px] border ${
                            highThroughputRepoIntake
                              ? "bg-cyan-700 border-cyan-500 text-white"
                              : "bg-gray-800 border-gray-600 text-gray-300"
                          }`}
                          disabled={isProcessing}
                        >
                          High Throughput Repo Intake
                        </button>
                        <button
                          onClick={() =>
                            setIncludeExtendedFileTypes((prev) => !prev)
                          }
                          className={`px-2 py-1 rounded text-[11px] border ${
                            includeExtendedFileTypes
                              ? "bg-cyan-700 border-cyan-500 text-white"
                              : "bg-gray-800 border-gray-600 text-gray-300"
                          }`}
                          disabled={isProcessing}
                        >
                          Extended File Types
                        </button>
                      </div>
                    )}
                  </div>

                  <input
                    type="url"
                    value={githubRepoUrl}
                    onChange={(e) => setGithubRepoUrl(e.target.value)}
                    placeholder="https://github.com/owner/repository[/tree/branch/path]"
                    className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded text-xs text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
                    disabled={isProcessing}
                  />

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="px-2.5 py-1.5 bg-gray-900 border border-gray-600 rounded text-xs text-white hover:border-indigo-400"
                      disabled={isProcessing}
                    >
                      Upload Files
                    </button>
                    <button
                      onClick={() => directoryInputRef.current?.click()}
                      className="px-2.5 py-1.5 bg-gray-900 border border-gray-600 rounded text-xs text-white hover:border-indigo-400"
                      disabled={isProcessing}
                    >
                      Upload Directory
                    </button>
                    <select
                      value={selectedChunkSize}
                      onChange={(e) =>
                        setSelectedChunkSize(Number(e.target.value))
                      }
                      className="px-2 py-1.5 bg-gray-900 border border-gray-600 rounded text-xs text-white"
                      disabled={isProcessing}
                    >
                      {effectiveProfile === "low" ? (
                        <>
                          <option value={6000}>Chunk 6k</option>
                          <option value={8000}>Chunk 8k</option>
                          <option value={12000}>Chunk 12k</option>
                          <option value={16000}>Chunk 16k</option>
                        </>
                      ) : (
                        <>
                          <option value={12000}>Chunk 12k</option>
                          <option value={16000}>Chunk 16k</option>
                          <option value={24000}>Chunk 24k</option>
                          <option value={32000}>Chunk 32k</option>
                          <option value={48000}>Chunk 48k</option>
                          <option value={64000}>Chunk 64k</option>
                        </>
                      )}
                    </select>
                    <select
                      value={prefetchWindow}
                      onChange={(e) =>
                        setPrefetchWindow(Number(e.target.value))
                      }
                      className="px-2 py-1.5 bg-gray-900 border border-gray-600 rounded text-xs text-white"
                      disabled={isProcessing}
                    >
                      {effectiveProfile === "low" ? (
                        <>
                          <option value={1}>Prefetch 1</option>
                          <option value={2}>Prefetch 2</option>
                        </>
                      ) : (
                        <>
                          <option value={2}>Prefetch 2</option>
                          <option value={4}>Prefetch 4</option>
                          <option value={6}>Prefetch 6</option>
                          <option value={8}>Prefetch 8</option>
                          <option value={12}>Prefetch 12</option>
                          <option value={16}>Prefetch 16</option>
                        </>
                      )}
                    </select>
                    <span className="text-[11px] text-gray-400">
                      Files staged: {debugFiles.length}
                    </span>
                    <span
                      className={`text-[11px] ${
                        effectiveProfile === "low"
                          ? "text-amber-300"
                          : "text-cyan-300"
                      }`}
                    >
                      {effectiveProfile === "low"
                        ? "Low-end tuned"
                        : "High-end utilities enabled"}
                    </span>
                  </div>

                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => void handleFilesAdded(e.target.files)}
                  />
                  <input
                    ref={directoryInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => void handleFilesAdded(e.target.files)}
                  />
                </div>
              )}

              <div className="flex items-center justify-between gap-3 mb-2">
                <p className="text-[11px] text-gray-400">
                  {workflowMode === "codegen"
                    ? "Enter to submit • Shift+Enter for new line"
                    : `Debug mode streams files with ${effectiveProfile.toUpperCase()} profile limits`}
                </p>
                {!hasConnectedWorkers && (
                  <p className="text-[11px] text-yellow-400">
                    No connected workers
                  </p>
                )}
              </div>
              <button
                onClick={handleDistribute}
                disabled={!canSubmitTask}
                className={`w-full px-3 py-2.5 rounded-md text-sm text-white font-semibold transition-colors flex items-center justify-center gap-2 ${
                  canSubmitTask
                    ? "bg-blue-600 hover:bg-blue-700"
                    : "bg-gray-700 text-gray-400 cursor-not-allowed"
                }`}
              >
                {isProcessing && (
                  <svg
                    className="w-4 h-4 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-90"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                    ></path>
                  </svg>
                )}
                {isProcessing
                  ? isLoadingRepo
                    ? "Loading repository..."
                    : "Distributing..."
                  : hasConnectedWorkers
                    ? workflowMode === "codegen"
                      ? "Distribute to Swarm"
                      : "Start Distributed Debug"
                    : "Connect Workers to Enable"}
              </button>
            </div>
          )}

          {/* Worker Status */}
          {swarmMode === "worker" && (
            <div className="bg-purple-900/20 border border-purple-500/30 rounded p-2">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-purple-400 text-sm">⚙️</span>
                <label className="text-xs text-purple-400 font-medium">
                  Worker Node Active
                </label>
              </div>
              {isProcessing && currentTask && (
                <div className="text-xs text-gray-300 mt-1">
                  <span className="text-purple-400">Processing:</span>{" "}
                  {currentTask}
                </div>
              )}
              {!isProcessing && (
                <p className="text-xs text-gray-400">Waiting for tasks...</p>
              )}
            </div>
          )}

          {/* Progress Tracker (Master only) */}
          {swarmMode === "master" && progress.total > 0 && (
            <div className="bg-gray-900 rounded p-2 space-y-2">
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-gray-400">Task Progress:</label>
                <span className="text-xs font-semibold text-white">
                  {progress.completed}/{progress.total}
                </span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-2">
                <div
                  className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${progress.percentage}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-gray-400 mt-1">
                <span>Pending: {progress.pending}</span>
                <span>Failed: {progress.failed}</span>
              </div>

              {workflowMode === "debug" && workerDebugStatus.length > 0 && (
                <div className="pt-2 border-t border-gray-700">
                  <p className="text-[11px] text-indigo-300 mb-1">
                    Workers Analyzing
                  </p>
                  <div className="space-y-1">
                    {workerDebugStatus.map(([workerId, files]) => (
                      <div
                        key={workerId}
                        className="text-[11px] text-gray-300 bg-gray-800 rounded px-2 py-1"
                      >
                        <span className="text-indigo-300">{workerId}</span>:{" "}
                        {files.slice(0, 3).join(", ")}
                        {files.length > 3 ? ` +${files.length - 3} more` : ""}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {swarmMode === "master" && debugReports.length > 0 && (
            <div className="bg-gray-900 rounded p-2 border border-indigo-500/20">
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-indigo-300 font-semibold">
                  Debug Report
                </label>
                <span className="text-[11px] text-gray-400">
                  {debugReports.length} completed
                </span>
              </div>

              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {debugReports.slice(0, 8).map((report) => (
                  <div key={report.taskId} className="bg-gray-800 rounded p-2">
                    <p className="text-[11px] text-indigo-300">
                      {report.assignment.fileName} • {report.nodeId}
                    </p>
                    <p className="text-[11px] text-gray-300 mt-1 whitespace-pre-wrap line-clamp-4">
                      {report.code}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Current Task */}
          {currentTask && (
            <div className="text-xs text-gray-300 bg-gray-900 rounded p-2">
              <span className="text-blue-400">Current:</span> {currentTask}
            </div>
          )}

          {/* Error Display */}
          {error && (
            <div className="bg-red-900/20 border border-red-500/50 rounded p-2">
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}

          {/* Info */}
          <div className="text-xs text-gray-500 pt-2 border-t border-gray-700">
            <p>Master nodes distribute tasks. Worker nodes execute them.</p>
            {!isMasterHeartbeatHealthy && swarmMode !== "master" && (
              <p className="text-red-400 mt-1">
                Master heartbeat lost. Local failover state has been saved.
              </p>
            )}
            {isProcessing && (
              <p className="text-yellow-400 mt-1">
                Note: Code generation and debug analysis run in parallel chunks.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
