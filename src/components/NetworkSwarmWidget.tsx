import React, { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Crown,
  Link2,
  Pin,
  PinOff,
  Radio,
  RefreshCcw,
  Server,
  Signal,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";

type SwarmMode = "master" | "worker" | "standalone";

interface NetworkSwarmWidgetProps {
  swarmMode: SwarmMode;
  activeConnectionCount: number;
  connectionStatus: string;
  isInitialized: boolean;
  isMasterHeartbeatHealthy: boolean;
  isProcessing: boolean;
  currentTask: string | null;
  peerId: string | null;
  connectedPeers: Array<{ id: string; open: boolean }>;
  onConnectToPeer: (targetPeerId: string) => Promise<void>;
  onDisconnectAll: () => void;
  onPromoteToMaster: () => void;
  isConnecting: boolean;
  networkError: string | null;
}

export const NetworkSwarmWidget: React.FC<NetworkSwarmWidgetProps> = ({
  swarmMode,
  activeConnectionCount,
  connectionStatus,
  isInitialized,
  isMasterHeartbeatHealthy,
  isProcessing,
  currentTask,
  peerId,
  connectedPeers,
  onConnectToPeer,
  onDisconnectAll,
  onPromoteToMaster,
  isConnecting,
  networkError,
}) => {
  const [heartbeatTick, setHeartbeatTick] = useState(0);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isPinned, setIsPinned] = useState(true);
  const [connectTargetId, setConnectTargetId] = useState("");

  const hasActiveNetwork = useMemo(
    () => isInitialized && activeConnectionCount > 0,
    [activeConnectionCount, isInitialized],
  );

  useEffect(() => {
    if (!hasActiveNetwork) {
      return;
    }

    const timer = window.setInterval(() => {
      setHeartbeatTick((prev) => prev + 1);
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [hasActiveNetwork]);

  const modeMeta = useMemo(() => {
    if (swarmMode === "master") {
      return {
        label: "Master",
        icon: Crown,
        accent: "text-amber-200",
        border: "border-amber-400/35",
        badge: "bg-amber-500/15 text-amber-200",
      };
    }

    if (swarmMode === "worker") {
      return {
        label: "Worker",
        icon: Server,
        accent: "text-cyan-200",
        border: "border-cyan-400/35",
        badge: "bg-cyan-500/15 text-cyan-200",
      };
    }

    return {
      label: "Standalone",
      icon: Users,
      accent: "text-zinc-300",
      border: "border-zinc-600/40",
      badge: "bg-zinc-700/70 text-zinc-300",
    };
  }, [swarmMode]);

  const heartbeatState = useMemo(() => {
    if (!isInitialized) {
      return {
        label: "Offline",
        icon: WifiOff,
        color: "text-zinc-500",
      };
    }

    if (swarmMode === "worker" && !isMasterHeartbeatHealthy) {
      return {
        label: "Master Lost",
        icon: WifiOff,
        color: "text-rose-300",
      };
    }

    if (hasActiveNetwork) {
      return {
        label: "Heartbeat OK",
        icon: Wifi,
        color: "text-emerald-300",
      };
    }

    return {
      label: "Idle",
      icon: Wifi,
      color: "text-zinc-400",
    };
  }, [hasActiveNetwork, isInitialized, isMasterHeartbeatHealthy, swarmMode]);

  const ModeIcon = modeMeta.icon;
  const HeartbeatIcon = heartbeatState.icon;
  const needsRecovery = swarmMode === "worker" && !isMasterHeartbeatHealthy;

  const handleConnectSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = connectTargetId.trim();

    if (!trimmed || isConnecting) {
      return;
    }

    await onConnectToPeer(trimmed);
    setConnectTargetId("");
  };

  return (
    <motion.aside
      initial={{ opacity: 0, y: -10, x: 10 }}
      animate={{ opacity: 1, y: 0, x: 0 }}
      drag={!isPinned}
      dragMomentum={false}
      className={`fixed right-5 top-5 z-40 w-72 rounded-2xl border bg-zinc-900/90 p-3 shadow-2xl backdrop-blur ${modeMeta.border} ${!isPinned ? "cursor-move" : ""}`}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-300">
              Network
            </span>
            <span
              className={`rounded-md px-1.5 py-0.5 text-[10px] ${modeMeta.badge}`}
            >
              {modeMeta.label}
            </span>
            {!isPinned && (
              <span className="rounded-md border border-cyan-400/30 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-200">
                draggable
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-400">PeerJS swarm status</p>
        </div>

        <div className="flex items-center gap-1">
          <div
            className={`inline-flex items-center gap-1 text-xs ${modeMeta.accent}`}
          >
            <ModeIcon className="h-4 w-4" />
            {modeMeta.label}
          </div>
          <button
            type="button"
            className="rounded-md border border-zinc-700 bg-zinc-800 p-1 text-zinc-300 transition hover:bg-zinc-700"
            title={isPinned ? "Unpin widget" : "Pin widget"}
            onClick={() => setIsPinned((prev) => !prev)}
          >
            {isPinned ? (
              <PinOff className="h-3.5 w-3.5" />
            ) : (
              <Pin className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            className="rounded-md border border-zinc-700 bg-zinc-800 p-1 text-zinc-300 transition hover:bg-zinc-700"
            title={isCollapsed ? "Expand" : "Collapse"}
            onClick={() => setIsCollapsed((prev) => !prev)}
          >
            {isCollapsed ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {!isCollapsed && (
        <div className="space-y-2">
          <div className="flex items-center justify-between rounded-lg border border-zinc-700 bg-zinc-950/70 px-2.5 py-2">
            <div className="flex items-center gap-2 text-xs text-zinc-300">
              <Signal className="h-3.5 w-3.5" />
              Connections
            </div>
            <div className="flex items-center gap-1">
              <span className="text-xs font-semibold text-zinc-100">
                {activeConnectionCount}
              </span>
              {hasActiveNetwork && (
                <span className="relative inline-flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-300" />
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-zinc-700 bg-zinc-950/70 px-2.5 py-2">
            <div
              className={`flex items-center gap-2 text-xs ${heartbeatState.color}`}
            >
              <HeartbeatIcon className="h-3.5 w-3.5" />
              {heartbeatState.label}
            </div>

            {hasActiveNetwork && (
              <motion.div
                key={heartbeatTick}
                initial={{ scale: 0.6, opacity: 0.6 }}
                animate={{ scale: 1.1, opacity: 1 }}
                transition={{ duration: 0.3 }}
                className="inline-flex items-center gap-1 text-[11px] text-emerald-300"
              >
                <Radio className="h-3.5 w-3.5" />
                ping
              </motion.div>
            )}
          </div>

          <div className="rounded-lg border border-zinc-700 bg-zinc-950/70 px-2.5 py-2">
            <div className="mb-1 flex items-center gap-2 text-xs text-zinc-300">
              <Link2 className="h-3.5 w-3.5" />
              Peer
            </div>
            <p className="truncate text-[11px] text-zinc-400">
              {peerId ?? "Not initialized"}
            </p>
            <p className="mt-1 text-[10px] uppercase tracking-wide text-zinc-500">
              {connectionStatus}
            </p>
          </div>

          <form
            onSubmit={handleConnectSubmit}
            className="rounded-lg border border-zinc-700 bg-zinc-950/70 px-2.5 py-2"
          >
            <div className="mb-1 flex items-center gap-2 text-xs text-zinc-300">
              <RefreshCcw className="h-3.5 w-3.5" />
              Connect To Peer
            </div>
            <div className="flex items-center gap-2">
              <input
                value={connectTargetId}
                onChange={(event) => setConnectTargetId(event.target.value)}
                placeholder="target peer id"
                className="h-7 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-cyan-400/50"
              />
              <button
                type="submit"
                disabled={isConnecting || !connectTargetId.trim()}
                className="rounded-md border border-cyan-400/40 bg-cyan-500/15 px-2 py-1 text-[11px] text-cyan-200 transition hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {isConnecting ? "..." : "Join"}
              </button>
            </div>
            {networkError && (
              <p className="mt-1 text-[10px] text-rose-300">{networkError}</p>
            )}
          </form>

          <div className="rounded-lg border border-zinc-700 bg-zinc-950/70 px-2.5 py-2">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-xs text-zinc-300">Peers</span>
              <button
                type="button"
                onClick={onDisconnectAll}
                disabled={connectedPeers.length === 0}
                className="rounded-md border border-rose-400/35 bg-rose-500/10 px-1.5 py-0.5 text-[10px] text-rose-200 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-45"
              >
                disconnect all
              </button>
            </div>
            <div className="space-y-1">
              {connectedPeers.length === 0 ? (
                <p className="text-[10px] text-zinc-500">
                  No linked peers yet.
                </p>
              ) : (
                connectedPeers.slice(0, 4).map((peer) => (
                  <div
                    key={peer.id}
                    className="flex items-center justify-between rounded border border-zinc-700 bg-zinc-900 px-2 py-1"
                  >
                    <span className="max-w-[170px] truncate text-[10px] text-zinc-300">
                      {peer.id}
                    </span>
                    <span
                      className={`rounded px-1 py-0.5 text-[9px] uppercase ${peer.open ? "bg-emerald-500/20 text-emerald-200" : "bg-zinc-700 text-zinc-300"}`}
                    >
                      {peer.open ? "open" : "closed"}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          {isProcessing && (
            <div className="rounded-lg border border-violet-400/35 bg-violet-500/10 px-2.5 py-2">
              <div className="mb-1 flex items-center gap-2 text-xs text-violet-200">
                <Activity className="h-3.5 w-3.5" />
                Swarm Task Active
              </div>
              <p className="line-clamp-2 text-[11px] text-violet-100/90">
                {currentTask ?? "Distributing workload across peers..."}
              </p>
            </div>
          )}

          {needsRecovery && (
            <div className="rounded-lg border border-amber-400/35 bg-amber-500/10 px-2.5 py-2">
              <div className="mb-1 flex items-center gap-2 text-xs text-amber-200">
                <WifiOff className="h-3.5 w-3.5" />
                Master unreachable
              </div>
              <p className="mb-2 text-[10px] leading-relaxed text-amber-100/90">
                Heartbeat timed out. You can recover by promoting this node.
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onPromoteToMaster}
                  className="rounded-md border border-amber-300/40 bg-amber-400/15 px-2 py-1 text-[10px] text-amber-100 transition hover:bg-amber-400/25"
                >
                  Promote To Master
                </button>
                <button
                  type="button"
                  onClick={onDisconnectAll}
                  className="rounded-md border border-zinc-600 bg-zinc-800 px-2 py-1 text-[10px] text-zinc-300 transition hover:bg-zinc-700"
                >
                  Reset Links
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </motion.aside>
  );
};

export default NetworkSwarmWidget;
