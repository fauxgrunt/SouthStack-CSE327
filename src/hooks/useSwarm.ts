import { useState, useEffect, useRef, useCallback } from "react";
import Peer, { DataConnection } from "peerjs";

const DEFAULT_PEER_SIGNAL_PORT = 9000;
const DEFAULT_PEER_SIGNAL_PATH = "/peerjs";
const PEER_INIT_TIMEOUT_MS = 30000;
const PEER_INIT_MAX_RETRIES = 2;
const LOCAL_PEER_FALLBACK_PREFIX = "local-peer";

type LocalSignalingConfig = {
  host: string;
  port: number;
  path: string;
  secure: boolean;
};

function normalizeSignalingHost(
  candidateHost: string | undefined,
  fallbackHost: string,
): string {
  const trimmed = candidateHost?.trim() ?? "";
  if (!trimmed) {
    return fallbackHost;
  }

  const lowered = trimmed.toLowerCase();
  if (lowered === "0.0.0.0" || lowered === "::") {
    return fallbackHost;
  }

  return trimmed;
}

function normalizeSignalingPath(candidatePath: string | undefined): string {
  const trimmed = candidatePath?.trim() ?? "";
  if (!trimmed) {
    return DEFAULT_PEER_SIGNAL_PATH;
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolveLocalSignalingConfig(): LocalSignalingConfig {
  const env = import.meta.env as {
    VITE_PEER_SIGNAL_HOST?: string;
    VITE_PEER_SIGNAL_PORT?: string;
    VITE_PEER_SIGNAL_PATH?: string;
    VITE_PEER_SIGNAL_SECURE?: string;
  };

  const fallbackHost = window.location.hostname?.trim() || "localhost";
  const host = normalizeSignalingHost(env.VITE_PEER_SIGNAL_HOST, fallbackHost);
  const port = Number(env.VITE_PEER_SIGNAL_PORT || DEFAULT_PEER_SIGNAL_PORT);
  const path = normalizeSignalingPath(env.VITE_PEER_SIGNAL_PATH);
  const secure = env.VITE_PEER_SIGNAL_SECURE === "true";

  if (!host) {
    throw new Error("Missing local signaling host for PeerJS.");
  }

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("Invalid local signaling port for PeerJS.");
  }

  return { host, port, path, secure };
}

function describePeerError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  if (typeof error === "object" && error !== null) {
    const typed = error as {
      type?: unknown;
      message?: unknown;
      data?: unknown;
    };

    if (typeof typed.message === "string" && typed.message.trim()) {
      return typed.message.trim();
    }

    if (typeof typed.type === "string" && typed.type.trim()) {
      return typed.type.trim();
    }

    if (typeof typed.data === "string" && typed.data.trim()) {
      return typed.data.trim();
    }
  }

  return "Unknown signaling error. Ensure npm run dev:swarm is running.";
}

function createLocalPeerId(): string {
  const timePart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `${LOCAL_PEER_FALLBACK_PREFIX}-${timePart}-${randomPart}`;
}

/**
 * Swarm Task Payload Interface
 */
export interface SwarmTaskPayload {
  taskId: string;
  fileName: string;
  instructions: string;
  type?:
    | "TASK_ASSIGN"
    | "TASK_COMPLETE"
    | "STATUS_UPDATE"
    | "WORKER_STATUS"
    | "DEBUG_ANALYSIS"
    | "DEBUG_REQUEST_NEXT"
    | "DEBUG_ANALYSIS_RESULT";
  sharedContext?: string; // Shared project context for coordinated code generation
  codeChunk?: string;
  chunkIndex?: number;
  sessionId?: string;
}

type SwarmMessageEnvelope = {
  type:
    | "TASK_DISPATCH"
    | "TASK_ASSIGN"
    | "TASK_COMPLETE"
    | "STATUS_UPDATE"
    | "STATE"
    | "PING"
    | "PONG"
    | "WORKER_STATUS"
    | "DEBUG_ANALYSIS"
    | "DEBUG_REQUEST_NEXT"
    | "DEBUG_ANALYSIS_RESULT"
    | "SWARM_STATE_SYNC";
  payload?: unknown;
  timestamp?: number;
};

/**
 * Task Complete Response Interface
 */
export interface TaskCompletePayload {
  type: "TASK_COMPLETE";
  taskId: string;
  fileName: string;
  code: string;
}

export interface SwarmStatePayload {
  type: "STATE";
  state: "ENGINE_READY";
}

/**
 * useSwarm - Custom React Hook for P2P Node Communication
 *
 * Manages peer-to-peer connections using PeerJS for distributed task execution.
 * Supports both master and worker node modes.
 */
export const useSwarm = () => {
  const [peerId, setPeerId] = useState<string | null>(null);
  const [connections, setConnections] = useState<DataConnection[]>([]);
  const [isMaster, setIsMaster] = useState<boolean>(false);
  const [isInitialized, setIsInitialized] = useState<boolean>(false);
  const [connectionStatus, setConnectionStatus] =
    useState<string>("disconnected");
  const [initError, setInitError] = useState<string | null>(null);
  const [isMasterHeartbeatHealthy, setIsMasterHeartbeatHealthy] =
    useState<boolean>(true);
  const [peerBootstrapNonce, setPeerBootstrapNonce] = useState(0);

  const peerRef = useRef<Peer | null>(null);
  const dataHandlerRef = useRef<
    ((data: unknown, conn: DataConnection) => void) | null
  >(null);
  const registeredConnectionHandlersRef = useRef(new WeakSet<DataConnection>());
  const onMasterLostRef = useRef<(() => void) | null>(null);
  const lastPingRef = useRef<number>(Date.now());
  const masterLostNotifiedRef = useRef(false);
  const isMasterRef = useRef(false);
  const peerInitRetryCountRef = useRef(0);

  useEffect(() => {
    isMasterRef.current = isMaster;
  }, [isMaster]);

  const setArrayBufferBinaryMode = useCallback((conn: DataConnection) => {
    const dataChannel = (conn as unknown as { dataChannel?: RTCDataChannel })
      .dataChannel;

    if (!dataChannel) {
      return;
    }

    if (dataChannel.binaryType !== "arraybuffer") {
      dataChannel.binaryType = "arraybuffer";
    }
  }, []);

  const normalizeIncomingData = useCallback((rawData: unknown) => {
    if (
      typeof rawData === "string" &&
      (rawData.includes('"type":"PING"') || rawData.includes('"type":"PONG"'))
    ) {
      return JSON.parse(rawData) as {
        type: "PING" | "PONG";
        timestamp?: number;
      };
    }

    console.log("[WEBRTC WORKER] Received data:", rawData);

    if (rawData instanceof ArrayBuffer) {
      return {
        type: "BINARY_BUFFER",
        payload: rawData,
        byteLength: rawData.byteLength,
      };
    }

    if (typeof rawData === "string") {
      try {
        const parsed = JSON.parse(rawData);
        console.log("[WEBRTC WORKER] Parsed JSON payload:", parsed);

        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "type" in parsed &&
          (parsed as SwarmMessageEnvelope).type === "TASK_DISPATCH" &&
          "payload" in parsed
        ) {
          const dispatch = parsed as SwarmMessageEnvelope;
          console.log(
            "[WEBRTC WORKER] TASK_DISPATCH envelope unpacked:",
            dispatch,
          );
          return dispatch.payload;
        }

        return parsed;
      } catch (error) {
        console.warn(
          "[Swarm] Received non-JSON string payload:",
          rawData,
          error,
        );
        return rawData;
      }
    }

    return rawData;
  }, []);

  /**
   * Initialize Peer instance
   */
  useEffect(() => {
    let initTimeoutId: number | null = null;

    if (!peerRef.current) {
      try {
        const signaling = resolveLocalSignalingConfig();
        setConnectionStatus("initializing");
        setIsInitialized(false);
        setInitError(null);

        // Initialize PeerJS against local signaling infrastructure only.
        const peer = new Peer({
          host: signaling.host,
          port: signaling.port,
          path: signaling.path,
          secure: signaling.secure,
          config: {
            iceServers: [],
          },
        });

        // Handle successful peer connection
        peer.on("open", (id) => {
          if (initTimeoutId !== null) {
            window.clearTimeout(initTimeoutId);
            initTimeoutId = null;
          }

          peerInitRetryCountRef.current = 0;

          console.log("[Swarm] Peer initialized with ID:", id);
          setPeerId(id);
          setIsInitialized(true);
          setInitError(null);
          setConnectionStatus("ready");
        });

        // Handle incoming connections (Worker Node mode)
        peer.on("connection", (conn) => {
          console.log("[Swarm] Incoming connection from:", conn.peer);
          setupConnectionHandlers(conn);

          if (conn.open) {
            setConnections((prev) => {
              // Avoid duplicates
              if (prev.find((c) => c.peer === conn.peer)) {
                return prev;
              }
              return [...prev, conn];
            });
          }
        });

        // Handle errors
        peer.on("error", (error) => {
          if (initTimeoutId !== null) {
            window.clearTimeout(initTimeoutId);
            initTimeoutId = null;
          }

          console.error("[Swarm] Peer error:", error);
          const message = describePeerError(error);
          setIsInitialized(false);
          setInitError(
            `PeerJS signaling failed (${signaling.host}:${signaling.port}${signaling.path}): ${message}`,
          );
          setConnectionStatus("error");
        });

        initTimeoutId = window.setTimeout(() => {
          if (peer.destroyed || peer.id) {
            return;
          }

          const retryCount = peerInitRetryCountRef.current;

          if (retryCount < PEER_INIT_MAX_RETRIES) {
            peerInitRetryCountRef.current = retryCount + 1;
            setInitError(
              `PeerJS initialization is slow (attempt ${retryCount + 1}/${PEER_INIT_MAX_RETRIES + 1}). Retrying...`,
            );

            if (!peer.destroyed) {
              peer.destroy();
            }

            peerRef.current = null;
            setConnectionStatus("initializing");
            window.setTimeout(() => {
              setPeerBootstrapNonce((prev) => prev + 1);
            }, 800);
            return;
          }

          const fallbackPeerId = createLocalPeerId();
          console.warn(
            "[Swarm] Peer bootstrap timed out; using local demo peer ID",
            {
              fallbackPeerId,
              signaling,
            },
          );

          setPeerId(fallbackPeerId);
          setIsInitialized(true);
          setConnectionStatus("standalone");
          setInitError(
            `PeerJS initialization timed out after ${PEER_INIT_TIMEOUT_MS}ms. Using local demo peer ID ${fallbackPeerId} so the UI can keep running on this device.`,
          );

          if (!peer.destroyed) {
            peer.destroy();
          }

          peerRef.current = null;
        }, PEER_INIT_TIMEOUT_MS);

        // Handle disconnection
        peer.on("disconnected", () => {
          console.log("[Swarm] Peer disconnected");
          setIsInitialized(false);
          setConnectionStatus("disconnected");
          // Attempt to reconnect
          if (!peer.destroyed) {
            peer.reconnect();
          }
        });

        peerRef.current = peer;
      } catch (error) {
        console.error("[Swarm] Failed to initialize peer:", error);
        const message = error instanceof Error ? error.message : String(error);
        setIsInitialized(false);
        setInitError(message);
        setConnectionStatus("error");
      }
    }

    // Cleanup on unmount
    return () => {
      if (initTimeoutId !== null) {
        window.clearTimeout(initTimeoutId);
      }

      if (peerRef.current) {
        peerRef.current.destroy();
        peerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerBootstrapNonce]);

  /**
   * Setup event listeners for a connection
   */
  const setupConnectionHandlers = useCallback(
    (conn: DataConnection) => {
      if (registeredConnectionHandlersRef.current.has(conn)) {
        return;
      }

      registeredConnectionHandlersRef.current.add(conn);
      setArrayBufferBinaryMode(conn);

      conn.on("open", () => {
        setArrayBufferBinaryMode(conn);
        console.log("[WEBRTC MASTER] Channel Open", { peer: conn.peer });
        setConnectionStatus("connected");

        setConnections((prev) => {
          if (prev.find((c) => c.peer === conn.peer)) {
            return prev;
          }
          return [...prev, conn];
        });
      });

      conn.on("data", (rawData) => {
        const data = normalizeIncomingData(rawData);

        if (typeof data === "object" && data !== null && "type" in data) {
          const message = data as { type: string; timestamp?: number };

          if (message.type === "PING") {
            lastPingRef.current = Date.now();
            masterLostNotifiedRef.current = false;
            setIsMasterHeartbeatHealthy(true);

            if (conn.open) {
              conn.send(
                JSON.stringify({
                  type: "PONG",
                  timestamp: Date.now(),
                }),
              );
            }

            return;
          }

          if (message.type === "PONG") {
            return;
          }
        }

        console.log("[Swarm] Data received from", conn.peer, ":", data);

        // Call custom data handler if registered, but never block delivery.
        if (dataHandlerRef.current) {
          try {
            dataHandlerRef.current(data, conn);
          } catch (error) {
            console.warn(
              "[Swarm] Data handler failed; keeping raw payload available.",
              { peer: conn.peer, error, data },
            );
          }
        } else {
          console.warn(
            "[Swarm] No data handler registered; raw payload kept.",
            {
              peer: conn.peer,
              data,
            },
          );
        }
      });

      conn.on("close", () => {
        console.log("[Swarm] Connection closed with:", conn.peer);
        setConnections((prev) => prev.filter((c) => c.peer !== conn.peer));
      });

      conn.on("error", (error) => {
        console.error("[Swarm] Connection error with", conn.peer, ":", error);
      });
    },
    [normalizeIncomingData, setArrayBufferBinaryMode],
  );

  useEffect(() => {
    if (!isMaster) {
      return;
    }

    const interval = setInterval(() => {
      const ping = JSON.stringify({
        type: "PING",
        timestamp: Date.now(),
      });

      connections.forEach((conn) => {
        if (!conn.open) {
          return;
        }

        try {
          conn.send(ping);
        } catch (error) {
          console.warn("[Swarm:Heartbeat] Failed to send PING", {
            peer: conn.peer,
            error,
          });
        }
      });
    }, 5000);

    return () => {
      clearInterval(interval);
    };
  }, [connections, isMaster]);

  useEffect(() => {
    if (isMaster || connections.length === 0) {
      return;
    }

    const monitor = setInterval(() => {
      const elapsed = Date.now() - lastPingRef.current;

      if (elapsed <= 600000 || masterLostNotifiedRef.current) {
        return;
      }

      masterLostNotifiedRef.current = true;
      setIsMasterHeartbeatHealthy(false);
      console.warn("[Swarm:Heartbeat] Master heartbeat timeout", {
        elapsedMs: elapsed,
      });

      if (onMasterLostRef.current) {
        onMasterLostRef.current();
      }
    }, 1000);

    return () => {
      clearInterval(monitor);
    };
  }, [connections.length, isMaster]);

  useEffect(() => {
    if (isMaster) {
      setIsMasterHeartbeatHealthy(true);
    }
  }, [isMaster]);

  /**
   * Connect to a target node (Master Node function)
   */
  const connectToNode = useCallback(
    (
      targetId: string,
      options?: { asMaster?: boolean },
    ): Promise<DataConnection> => {
      return new Promise((resolve, reject) => {
        if (!peerRef.current) {
          reject(new Error("Peer not initialized"));
          return;
        }

        if (!targetId || targetId === peerId) {
          reject(new Error("Invalid target ID"));
          return;
        }

        // Check if already connected
        const existing = connections.find((c) => c.peer === targetId);
        if (existing && existing.open) {
          console.log("[Swarm] Already connected to:", targetId);
          resolve(existing);
          return;
        }

        console.log("[Swarm] Connecting to node:", targetId);
        const conn = peerRef.current.connect(targetId, {
          reliable: true,
        });

        setupConnectionHandlers(conn);

        conn.on("open", () => {
          setConnections((prev) => {
            // Avoid duplicates
            if (prev.find((c) => c.peer === targetId)) {
              return prev;
            }
            return [...prev, conn];
          });
          const nextMasterState = options?.asMaster ?? isMasterRef.current;
          setIsMaster(nextMasterState);
          setConnectionStatus("connected");
          masterLostNotifiedRef.current = false;
          if (!nextMasterState) {
            setIsMasterHeartbeatHealthy(true);
          }
          resolve(conn);
        });

        conn.on("error", (error) => {
          reject(error);
        });

        // Timeout after 10 minutes
        setTimeout(() => {
          if (!conn.open) {
            reject(new Error("Connection timeout"));
          }
        }, 600000);
      });
    },
    [peerId, connections, setupConnectionHandlers],
  );

  /**
   * Broadcast task to all active connections
   */
  const broadcastTask = useCallback(
    (taskPayload: SwarmTaskPayload) => {
      if (connections.length === 0) {
        console.warn("[Swarm] No active connections to broadcast to");
        return 0;
      }

      let sentCount = 0;
      connections.forEach((conn) => {
        if (conn.open) {
          try {
            conn.send(taskPayload);
            console.log("[Swarm] Task broadcasted to:", conn.peer, taskPayload);
            sentCount++;
          } catch (error) {
            console.error("[Swarm] Failed to send to", conn.peer, ":", error);
          }
        }
      });

      return sentCount;
    },
    [connections],
  );

  /**
   * Send task to a specific connection
   */
  const sendTaskToNode = useCallback(
    (conn: DataConnection, taskPayload: SwarmTaskPayload) => {
      const envelope: SwarmMessageEnvelope = {
        type: "TASK_DISPATCH",
        payload: taskPayload,
        timestamp: Date.now(),
      };
      const payloadAsJson = JSON.stringify(envelope);

      const sendWhenOpen = () => {
        const dataChannelState = (
          conn as unknown as { dataChannel?: RTCDataChannel }
        ).dataChannel?.readyState;

        if (!conn.open) {
          console.warn("[WEBRTC MASTER] conn.open is false; waiting for open", {
            peer: conn.peer,
            taskId: taskPayload.taskId,
          });
          return false;
        }

        if (dataChannelState && dataChannelState !== "open") {
          console.warn("[WEBRTC MASTER] dataChannel not open yet", {
            peer: conn.peer,
            taskId: taskPayload.taskId,
            dataChannelState,
          });
          return false;
        }

        try {
          console.log("[WEBRTC MASTER] Sending payload:", envelope);
          conn.send(payloadAsJson);
          return true;
        } catch (error) {
          console.error("[WEBRTC MASTER] Failed to send payload", {
            peer: conn.peer,
            taskId: taskPayload.taskId,
            error,
          });
          return false;
        }
      };

      if (sendWhenOpen()) {
        return true;
      }

      // No READY/ACK handshake: dispatch as soon as open fires.
      conn.once("open", () => {
        console.log("[WEBRTC MASTER] Channel Open", {
          peer: conn.peer,
          queuedTaskId: taskPayload.taskId,
        });
        void sendWhenOpen();
      });

      return true;
    },
    [],
  );

  const sendStateToNode = useCallback(
    (conn: DataConnection, payload: SwarmStatePayload) => {
      if (!conn.open) {
        return false;
      }

      try {
        conn.send(JSON.stringify(payload));
        return true;
      } catch (error) {
        console.warn("[WEBRTC MASTER] Failed to send state payload", {
          peer: conn.peer,
          error,
        });
        return false;
      }
    },
    [],
  );

  /**
   * Register a custom data handler
   */
  const onData = useCallback(
    (handler: (data: unknown, conn: DataConnection) => void) => {
      dataHandlerRef.current = handler;
    },
    [],
  );

  const onMasterLost = useCallback((handler: () => void) => {
    onMasterLostRef.current = handler;
  }, []);

  const promoteToMaster = useCallback(() => {
    setIsMaster(true);
    setConnectionStatus("connected");
    setIsMasterHeartbeatHealthy(true);
    masterLostNotifiedRef.current = false;
    console.log("[Swarm] Promoted current node to master mode");
  }, []);

  const setWorkerMode = useCallback(() => {
    setIsMaster(false);
    setConnectionStatus((prev) =>
      prev === "connected" ? "connected" : "ready",
    );
    setIsMasterHeartbeatHealthy(true);
    masterLostNotifiedRef.current = false;
    console.log("[Swarm] Set current node to worker mode");
  }, []);

  /**
   * Disconnect from a specific node
   */
  const disconnectFromNode = useCallback(
    (targetId: string) => {
      const conn = connections.find((c) => c.peer === targetId);
      if (conn) {
        conn.close();
        setConnections((prev) => prev.filter((c) => c.peer !== targetId));
        console.log("[Swarm] Disconnected from:", targetId);
      }
    },
    [connections],
  );

  /**
   * Disconnect from all nodes
   */
  const disconnectAll = useCallback(() => {
    connections.forEach((conn) => conn.close());
    setConnections([]);
    setIsMaster(false);
    console.log("[Swarm] Disconnected from all nodes");
  }, [connections]);

  return {
    // State
    peerId,
    connections,
    isMaster,
    isInitialized,
    connectionStatus,
    initError,
    isMasterHeartbeatHealthy,
    activeConnectionCount: connections.filter((c) => c.open).length,

    // Actions
    connectToNode,
    broadcastTask,
    sendTaskToNode,
    onData,
    onMasterLost,
    promoteToMaster,
    setWorkerMode,
    disconnectFromNode,
    disconnectAll,
    sendStateToNode,
  };
};
