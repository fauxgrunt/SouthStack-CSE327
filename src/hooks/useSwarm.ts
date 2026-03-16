import { useState, useEffect, useRef, useCallback } from "react";
import Peer, { DataConnection } from "peerjs";

/**
 * Swarm Task Payload Interface
 */
export interface SwarmTaskPayload {
  taskId: string;
  fileName: string;
  instructions: string;
  type?: "TASK_ASSIGN" | "TASK_COMPLETE" | "STATUS_UPDATE";
  sharedContext?: string; // Shared project context for coordinated code generation
}

type SwarmMessageEnvelope = {
  type: "TASK_DISPATCH" | "TASK_ASSIGN" | "TASK_COMPLETE" | "STATUS_UPDATE";
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

  const peerRef = useRef<Peer | null>(null);
  const dataHandlerRef = useRef<
    ((data: unknown, conn: DataConnection) => void) | null
  >(null);
  const registeredConnectionHandlersRef = useRef(new WeakSet<DataConnection>());

  const normalizeIncomingData = useCallback((rawData: unknown) => {
    console.log("[WEBRTC WORKER] Received data:", rawData);

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
          console.log("[WEBRTC WORKER] TASK_DISPATCH envelope unpacked:", dispatch);
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
    if (!peerRef.current) {
      try {
        // Initialize PeerJS with configuration
        const peer = new Peer({
          config: {
            iceServers: [
              { urls: "stun:stun.l.google.com:19302" },
              { urls: "stun:global.stun.twilio.com:3478" },
            ],
          },
        });

        // Handle successful peer connection
        peer.on("open", (id) => {
          console.log("[Swarm] Peer initialized with ID:", id);
          setPeerId(id);
          setIsInitialized(true);
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
          console.error("[Swarm] Peer error:", error);
          setConnectionStatus("error");
        });

        // Handle disconnection
        peer.on("disconnected", () => {
          console.log("[Swarm] Peer disconnected");
          setConnectionStatus("disconnected");
          // Attempt to reconnect
          if (!peer.destroyed) {
            peer.reconnect();
          }
        });

        peerRef.current = peer;
      } catch (error) {
        console.error("[Swarm] Failed to initialize peer:", error);
        setConnectionStatus("error");
      }
    }

    // Cleanup on unmount
    return () => {
      if (peerRef.current) {
        peerRef.current.destroy();
        peerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Setup event listeners for a connection
   */
  const setupConnectionHandlers = useCallback(
    (conn: DataConnection) => {
      if (registeredConnectionHandlersRef.current.has(conn)) {
        return;
      }

      registeredConnectionHandlersRef.current.add(conn);

      conn.on("open", () => {
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
        console.log("[WEBRTC WORKER] Received data:", rawData);
        const data = normalizeIncomingData(rawData);
        console.log("[Swarm] Data received from", conn.peer, ":", data);

        // Call custom data handler if registered
        if (dataHandlerRef.current) {
          dataHandlerRef.current(data, conn);
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
    [normalizeIncomingData],
  );

  /**
   * Connect to a target node (Master Node function)
   */
  const connectToNode = useCallback(
    (targetId: string): Promise<DataConnection> => {
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
          setIsMaster(true);
          resolve(conn);
        });

        conn.on("error", (error) => {
          reject(error);
        });

        // Timeout after 10 seconds
        setTimeout(() => {
          if (!conn.open) {
            reject(new Error("Connection timeout"));
          }
        }, 10000);
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

  /**
   * Register a custom data handler
   */
  const onData = useCallback(
    (handler: (data: unknown, conn: DataConnection) => void) => {
      dataHandlerRef.current = handler;
    },
    [],
  );

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
    activeConnectionCount: connections.filter((c) => c.open).length,

    // Actions
    connectToNode,
    broadcastTask,
    sendTaskToNode,
    onData,
    disconnectFromNode,
    disconnectAll,
  };
};
