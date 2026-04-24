import React, { useMemo, useState } from "react";
import {
  Crown,
  Loader2,
  Network,
  Server,
  Signal,
  UserRound,
  Wifi,
  WifiOff,
} from "lucide-react";

type JoinRole = "master" | "worker";

type SwarmStatus = "offline" | "master" | "worker";

interface SwarmConnectWidgetProps {
  status: SwarmStatus;
  peerId: string | null;
  connectedPeers: Array<{ id: string; open: boolean }>;
  isConnecting: boolean;
  networkError: string | null;
  onConnect: (params: {
    targetPeerId: string;
    role: JoinRole;
  }) => Promise<void>;
  onDisconnectAll: () => void;
}

const statusStyles: Record<
  SwarmStatus,
  { label: string; text: string; badge: string; dot: string }
> = {
  offline: {
    label: "Offline",
    text: "text-zinc-300",
    badge: "border-zinc-700 bg-zinc-900",
    dot: "bg-zinc-500",
  },
  master: {
    label: "Master",
    text: "text-amber-200",
    badge: "border-amber-500/40 bg-amber-500/10",
    dot: "bg-amber-300",
  },
  worker: {
    label: "Worker",
    text: "text-cyan-200",
    badge: "border-cyan-500/40 bg-cyan-500/10",
    dot: "bg-cyan-300",
  },
};

export const SwarmConnectWidget: React.FC<SwarmConnectWidgetProps> = ({
  status,
  peerId,
  connectedPeers,
  isConnecting,
  networkError,
  onConnect,
  onDisconnectAll,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [targetPeerId, setTargetPeerId] = useState("");
  const [role, setRole] = useState<JoinRole>("master");

  const statusMeta = statusStyles[status];

  const openPeers = useMemo(
    () => connectedPeers.filter((peer) => peer.open),
    [connectedPeers],
  );

  const handleConnect = async () => {
    await onConnect({
      targetPeerId: targetPeerId.trim(),
      role,
    });
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className={`inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 py-2 text-xs transition hover:border-zinc-500 hover:bg-zinc-800 md:px-3 md:py-2 ${statusMeta.badge} ${statusMeta.text}`}
      >
        <Network className="h-4 w-4" />
        <span className="hidden font-medium sm:inline">{statusMeta.label}</span>
        <span className="font-medium sm:hidden">
          {statusMeta.label.slice(0, 3)}
        </span>
        <span className={`h-2 w-2 rounded-full ${statusMeta.dot}`} />
      </button>

      {isOpen && (
        <>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="fixed inset-0 z-50 bg-black/45 backdrop-blur-sm md:hidden"
            aria-label="Close swarm connection panel"
          />

          <div className="fixed inset-x-0 bottom-0 z-[60] max-h-[92vh] w-full overflow-y-auto rounded-t-3xl border border-zinc-700 bg-zinc-900/98 p-4 shadow-2xl backdrop-blur md:absolute md:right-0 md:top-[calc(100%+10px)] md:bottom-auto md:max-h-none md:w-[340px] md:rounded-2xl md:bg-zinc-900/95">
            <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-zinc-700 md:hidden" />

            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-zinc-100">
                Swarm Connection
              </h3>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="rounded-md border border-zinc-700 px-3 py-2 text-[10px] text-zinc-400 transition hover:text-zinc-200"
              >
                Close
              </button>
            </div>

            <div className="mb-3 rounded-lg border border-zinc-700 bg-zinc-950/70 p-2">
              <div className="mb-1 flex items-center gap-2 text-[11px] text-zinc-400">
                <Signal className="h-3.5 w-3.5" />
                Local Peer ID
              </div>
              <p className="truncate text-xs text-zinc-200">
                {peerId ?? "Initializing PeerJS..."}
              </p>
            </div>

            <div className="mb-3">
              <label className="mb-1 block text-[11px] text-zinc-400">
                Room ID / Peer ID
              </label>
              <input
                value={targetPeerId}
                onChange={(event) => setTargetPeerId(event.target.value)}
                placeholder="Paste target peer ID"
                className="h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-cyan-400/50"
              />
            </div>

            <div className="mb-3">
              <span className="mb-1 block text-[11px] text-zinc-400">Role</span>
              <div className="flex flex-col gap-2 md:grid md:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setRole("master")}
                  className={`inline-flex min-h-11 items-center justify-center gap-1 rounded-lg border px-3 py-3 text-xs transition ${
                    role === "master"
                      ? "border-amber-400/50 bg-amber-500/10 text-amber-200"
                      : "border-zinc-700 bg-zinc-950 text-zinc-300 hover:bg-zinc-800"
                  }`}
                >
                  <Crown className="h-3.5 w-3.5" />
                  Join As Master
                </button>
                <button
                  type="button"
                  onClick={() => setRole("worker")}
                  className={`inline-flex min-h-11 items-center justify-center gap-1 rounded-lg border px-3 py-3 text-xs transition ${
                    role === "worker"
                      ? "border-cyan-400/50 bg-cyan-500/10 text-cyan-200"
                      : "border-zinc-700 bg-zinc-950 text-zinc-300 hover:bg-zinc-800"
                  }`}
                >
                  <Server className="h-3.5 w-3.5" />
                  Join As Worker
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                void handleConnect();
              }}
              disabled={
                isConnecting || (role === "master" && !targetPeerId.trim())
              }
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-3 py-3 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isConnecting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wifi className="h-3.5 w-3.5" />
              )}
              {isConnecting ? "Connecting..." : "Connect"}
            </button>

            {role === "worker" && !targetPeerId.trim() && (
              <p className="mt-2 text-[11px] text-zinc-500">
                Worker mode without target ID waits for a master to connect.
              </p>
            )}

            {networkError && (
              <p className="mt-2 text-[11px] text-rose-300">{networkError}</p>
            )}

            <div className="mt-4 rounded-lg border border-zinc-700 bg-zinc-950/60 p-2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[11px] text-zinc-400">
                  Connected Peers
                </span>
                <button
                  type="button"
                  onClick={onDisconnectAll}
                  disabled={connectedPeers.length === 0}
                  className="rounded-md border border-zinc-700 px-2 py-2 text-[10px] text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-40"
                >
                  Disconnect All
                </button>
              </div>

              {connectedPeers.length === 0 ? (
                <div className="inline-flex items-center gap-1 text-[11px] text-zinc-500">
                  <WifiOff className="h-3.5 w-3.5" />
                  No active peers yet.
                </div>
              ) : (
                <div className="space-y-1">
                  {connectedPeers.map((peer) => (
                    <div
                      key={peer.id}
                      className="flex items-center justify-between rounded border border-zinc-700 bg-zinc-900 px-2 py-1"
                    >
                      <div className="flex min-w-0 items-center gap-1 text-[11px] text-zinc-300">
                        <UserRound className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{peer.id}</span>
                      </div>
                      <span
                        className={`rounded px-1 py-0.5 text-[10px] ${
                          peer.open
                            ? "bg-emerald-500/20 text-emerald-200"
                            : "bg-zinc-700 text-zinc-300"
                        }`}
                      >
                        {peer.open ? "online" : "closed"}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {openPeers.length > 0 && (
                <p className="mt-2 text-[10px] text-zinc-500">
                  {openPeers.length} live peer{openPeers.length > 1 ? "s" : ""}{" "}
                  in room.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default SwarmConnectWidget;
