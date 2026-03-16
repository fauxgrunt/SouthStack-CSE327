import React, { useState } from "react";
import type { DataConnection } from "peerjs";
import type { SwarmMode } from "../hooks/useSwarmManager";

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
  getProgress: () => {
    total: number;
    completed: number;
    pending: number;
    failed: number;
    percentage: number;
  };
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
  getProgress,
}) => {
  const [targetPeerId, setTargetPeerId] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [peerIdCopied, setPeerIdCopied] = useState(false);

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
    console.log("[SwarmUI] Distribute button clicked", {
      promptLength: taskPrompt.trim().length,
      mode: swarmMode,
      activeConnectionCount,
      isProcessing,
    });

    if (!taskPrompt.trim()) {
      setError("Please enter a task description");
      return;
    }

    if (activeConnectionCount === 0) {
      setError("No worker nodes connected");
      return;
    }

    setError(null);

    try {
      console.log("[SwarmUI] Sending prompt to distributeTask", {
        prompt: taskPrompt.trim(),
      });
      await distributeTask(taskPrompt.trim());
      console.log("[SwarmUI] distributeTask call resolved successfully");
      setTaskPrompt("");
    } catch (err) {
      console.error("[SwarmUI] distributeTask call failed", err);
      setError(`Distribution failed: ${err}`);
    }
  };

  const handleDisconnect = () => {
    disconnectAll();
    setError(null);
  };

  const progress = getProgress();

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
          {swarmMode === "master" && activeConnectionCount > 0 && (
            <div className="bg-blue-900/20 border border-blue-500/30 rounded p-2">
              <label className="text-xs text-blue-400 block mb-1 font-medium">
                Distribute Task to Swarm:
              </label>
              <textarea
                value={taskPrompt}
                onChange={(e) => setTaskPrompt(e.target.value)}
                placeholder="Describe what you want to build..."
                className="w-full px-2 py-1 bg-gray-900 border border-gray-700 rounded text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 mb-2"
                rows={3}
                disabled={isProcessing}
              />
              <button
                onClick={handleDistribute}
                disabled={isProcessing || !taskPrompt.trim()}
                className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 rounded text-xs text-white font-medium"
              >
                {isProcessing ? "Processing..." : "Distribute to Swarm"}
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
            <div className="bg-gray-900 rounded p-2">
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
            {isProcessing && (
              <p className="text-yellow-400 mt-1">
                Note: Code generation typically takes 10-20 seconds per task.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
