import { useState, useRef, useCallback, useEffect } from "react";
import { io, Socket } from "socket.io-client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { check, relaunch } from "@tauri-apps/plugin-updater";
import { relaunch as relaunchProcess } from "@tauri-apps/plugin-process";

type View = "initial" | "sender" | "receiver";
type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

const SIGNALING_SERVER = "https://hermes-server-nwgk.onrender.com";

// Unique device ID generation with fingerprint
function getOrCreateDeviceId(): string {
  const stored = localStorage.getItem("hermes-device-id");
  if (stored) return stored;

  // Generate fingerprint-based ID
  const fingerprint = [
    navigator.userAgent,
    navigator.language,
    screen.width + "x" + screen.height,
    new Date().getTimezoneOffset(),
    navigator.hardwareConcurrency || "unknown",
  ].join("|");

  // Hash to 6 chars + random suffix
  let hash = 0;
  for (let i = 0; i < fingerprint.length; i++) {
    const char = fingerprint.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  const hashPart = Math.abs(hash).toString(36).substring(0, 4).toUpperCase();
  const randomPart = Math.random().toString(36).substring(2, 4).toUpperCase();
  const deviceId = `${hashPart}${randomPart}`;

  localStorage.setItem("hermes-device-id", deviceId);
  return deviceId;
}

const HermesIcon = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14" />
    <path d="M12 5l7 7-7 7" />
    <circle cx="5" cy="12" r="2" fill="currentColor" stroke="none" />
  </svg>
);

const FileIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

const CloseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const MinimizeIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const MaximizeIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
    <rect x="3" y="3" width="18" height="18" rx="1" />
  </svg>
);

interface FileItem {
  file: File;
  name: string;
  size: number;
  type: string;
}

interface ReceivedFile {
  name: string;
  size: number;
  type: string;
  data: ArrayBuffer;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export default function App() {
  const [view, setView] = useState<View>("initial");
  const [myId, setMyId] = useState<string>("");
  const [joinId, setJoinId] = useState("");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [senderStatus, setSenderStatus] = useState("Initializing...");
  const [receiverStatus, setReceiverStatus] = useState("Ready to connect");
  const [progress, setProgress] = useState(0);
  const [copied, setCopied] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [transferSpeed, setTransferSpeed] = useState("");
  const [updateAvailable, setUpdateAvailable] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const receivedChunksRef = useRef<{ [key: string]: ArrayBuffer[] }>({});
  const currentFileRef = useRef<{ name: string; size: number; type: string; received: number } | null>(null);
  const transferStartTimeRef = useRef<number>(0);

  // Connect to signaling server
  const connectSignaling = useCallback(() => {
    if (socketRef.current?.connected) return;

    const socket = io(SIGNALING_SERVER, {
      transports: ["websocket"],
      upgrade: false,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("Connected to signaling server");
      setConnectionState("connected");
      socket.emit("register", myId);
    });

    socket.on("connect_error", () => {
      setConnectionState("error");
    });

    socket.on("signal", async (data: { from: string; signal: RTCSessionDescriptionInit | RTCIceCandidateInit }) => {
      console.log("Received signal from", data.from);
      await handleSignal(data.from, data.signal);
    });

    socket.on("disconnect", () => {
      setConnectionState("disconnected");
    });

    return socket;
  }, [myId]);

  // Initialize device ID on mount
  useEffect(() => {
    const deviceId = getOrCreateDeviceId();
    setMyId(deviceId);
    setSenderStatus("Ready. Create a transfer to begin.");

    // Automatically try to connect to the signaling server on startup
    connectSignaling();

    // Check for updates
    async function checkUpdates() {
      try {
        const update = await check();
        if (update) {
          setUpdateAvailable(true);
        }
      } catch (e) {
        console.error("Update check failed", e);
      }
    }
    checkUpdates();
  }, [connectSignaling]);

  // WebRTC: Create peer connection
  const createPeerConnection = useCallback((targetId: string, isInitiator: boolean) => {
    const config: RTCConfiguration = {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    };

    const pc = new RTCPeerConnection(config);
    peerConnectionRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit("signal", {
          targetId,
          signal: event.candidate,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log("Connection state:", pc.connectionState);
      if (pc.connectionState === "connected") {
        setConnectionState("connected");
        if (isInitiator) {
          setSenderStatus("Receiver connected! Ready to send.");
        } else {
          setReceiverStatus("Connected to sender! Waiting for files...");
        }
      } else if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
        setConnectionState("error");
      }
    };

    // Data channel for file transfer
    if (isInitiator) {
      const channel = pc.createDataChannel("fileTransfer");
      setupDataChannel(channel);
      dataChannelRef.current = channel;
    } else {
      pc.ondatachannel = (event) => {
        setupDataChannel(event.channel);
        dataChannelRef.current = event.channel;
      };
    }

    return pc;
  }, []);

  // Setup data channel handlers
  const setupDataChannel = (channel: RTCDataChannel) => {
    channel.onopen = () => {
      console.log("Data channel opened");
    };

    channel.onmessage = (event) => {
      if (typeof event.data === "string") {
        // Metadata message
        const msg = JSON.parse(event.data);
        handleControlMessage(msg);
      } else {
        // Binary data
        handleFileChunk(event.data);
      }
    };

    channel.onclose = () => {
      console.log("Data channel closed");
    };

    channel.onerror = (error) => {
      console.error("Data channel error:", error);
    };
  };

  // Handle control messages
  const handleControlMessage = (msg: { type: string; name?: string; size?: number; fileType?: string; done?: boolean }) => {
    switch (msg.type) {
      case "file-start":
        if (msg.name && msg.size) {
          currentFileRef.current = { name: msg.name, size: msg.size, type: msg.fileType || "", received: 0 };
          receivedChunksRef.current[msg.name] = [];
          transferStartTimeRef.current = Date.now();
          setReceiverStatus(`Receiving: ${msg.name}`);
          setProgress(0);
        }
        break;

      case "file-done":
        if (currentFileRef.current) {
          const chunks = receivedChunksRef.current[currentFileRef.current.name];
          const totalLength = chunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
          const merged = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            merged.set(new Uint8Array(chunk), offset);
            offset += chunk.byteLength;
          }

          const receivedFile: ReceivedFile = {
            name: currentFileRef.current.name,
            size: currentFileRef.current.size,
            type: currentFileRef.current.type,
            data: merged.buffer,
          };

          setReceivedFiles((prev) => [...prev, receivedFile]);
          setReceiverStatus(`Received: ${currentFileRef.current.name}`);
          setProgress(100);
          currentFileRef.current = null;
        }
        break;

      case "transfer-complete":
        setReceiverStatus("All files received!");
        break;
    }
  };

  // Handle incoming file chunks
  const handleFileChunk = (chunk: ArrayBuffer) => {
    if (!currentFileRef.current) return;

    receivedChunksRef.current[currentFileRef.current.name].push(chunk);
    currentFileRef.current.received += chunk.byteLength;

    const percent = (currentFileRef.current.received / currentFileRef.current.size) * 100;
    setProgress(percent);

    // Calculate speed
    const elapsed = (Date.now() - transferStartTimeRef.current) / 1000;
    const speed = currentFileRef.current.received / elapsed;
    setTransferSpeed(`${formatBytes(speed)}/s`);
  };

  // Handle signaling messages
  const handleSignal = async (from: string, signal: RTCSessionDescriptionInit | RTCIceCandidateInit) => {
    const pc = peerConnectionRef.current;
    if (!pc) {
      // Create connection as receiver
      createPeerConnection(from, false);
    }

    if ("type" in signal && (signal.type === "offer" || signal.type === "answer")) {
      await peerConnectionRef.current!.setRemoteDescription(new RTCSessionDescription(signal));
      if (signal.type === "offer") {
        const answer = await peerConnectionRef.current!.createAnswer();
        await peerConnectionRef.current!.setLocalDescription(answer);
        socketRef.current?.emit("signal", {
          targetId: from,
          signal: answer,
        });
      }
    } else if ("candidate" in signal) {
      await peerConnectionRef.current!.addIceCandidate(new RTCIceCandidate(signal));
    }
  };

  // Initialize as sender
  const handleGenerate = async () => {
    if (!myId) return;

    setView("sender");
    setSenderStatus("Connecting to signaling server...");
    setConnectionState("connecting");

    connectSignaling();
    setSenderStatus(`Your ID: ${myId}. Share this ID with the receiver.`);
  };

  // Connect to peer as receiver
  const handleJoin = async () => {
    if (!joinId.trim() || joinId.trim().length < 4) return;

    setView("receiver");
    setReceiverStatus("Connecting to peer...");
    setConnectionState("connecting");

    connectSignaling();

    // Wait a moment for registration, then create connection
    setTimeout(async () => {
      const pc = createPeerConnection(joinId.trim().toUpperCase(), true);

      // Check if peer is online
      socketRef.current?.emit("check-peer", joinId.trim().toUpperCase(), (response: { online: boolean }) => {
        if (!response.online) {
          setReceiverStatus("Peer not found. Check the ID and try again.");
          setConnectionState("error");
          return;
        }

        // Create and send offer
        pc.createOffer()
          .then((offer) => pc.setLocalDescription(offer))
          .then(() => {
            socketRef.current?.emit("signal", {
              targetId: joinId.trim().toUpperCase(),
              signal: pc.localDescription,
            });
          });
      });
    }, 500);
  };

  // Send files via WebRTC
  const sendFiles = async () => {
    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== "open") {
      setSenderStatus("Connection not ready. Please wait...");
      return;
    }

    setSenderStatus("Sending files...");
    transferStartTimeRef.current = Date.now();

    for (let i = 0; i < files.length; i++) {
      const fileItem = files[i];
      const file = fileItem.file;

      // Send metadata
      channel.send(JSON.stringify({
        type: "file-start",
        name: file.name,
        size: file.size,
        fileType: file.type,
      }));

      // Send file in chunks (16KB chunks)
      const chunkSize = 16384;
      const buffer = await file.arrayBuffer();
      let sent = 0;

      for (let offset = 0; offset < buffer.byteLength; offset += chunkSize) {
        const chunk = buffer.slice(offset, Math.min(offset + chunkSize, buffer.byteLength));
        channel.send(chunk);
        sent += chunk.byteLength;

        // Update progress
        const totalProgress = ((i / files.length) + (sent / file.size) / files.length) * 100;
        setProgress(totalProgress);

        // Calculate speed
        const elapsed = (Date.now() - transferStartTimeRef.current) / 1000;
        const speed = sent / elapsed;
        setTransferSpeed(`${formatBytes(speed)}/s`);

        // Small delay to prevent overwhelming the channel
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      // Send completion signal
      channel.send(JSON.stringify({ type: "file-done" }));
    }

    channel.send(JSON.stringify({ type: "transfer-complete" }));
    setSenderStatus("Transfer complete!");
    setProgress(100);
    setTransferSpeed("");
  };

  // Handle file drop
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const droppedFiles = Array.from(e.dataTransfer.files).map((f) => ({
      file: f,
      name: f.name,
      size: f.size,
      type: f.type,
    }));
    setFiles((prev) => [...prev, ...droppedFiles]);
    setSenderStatus(`${droppedFiles.length + files.length} file(s) ready to send`);
  }, [files]);

  // Handle file selection
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const selected = Array.from(e.target.files).map((f) => ({
      file: f,
      name: f.name,
      size: f.size,
      type: f.type,
    }));
    setFiles((prev) => [...prev, ...selected]);
    setSenderStatus(`${selected.length + files.length} file(s) ready to send`);
  };

  // Remove file from queue
  const removeFile = (index: number) => {
    const updated = files.filter((_, i) => i !== index);
    setFiles(updated);
    setSenderStatus(updated.length > 0 ? `${updated.length} file(s) ready` : "Waiting for receiver...");
  };

  // Copy ID to clipboard
  const copyId = () => {
    navigator.clipboard.writeText(myId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Download received file
  const downloadFile = (file: ReceivedFile) => {
    const blob = new Blob([file.data], { type: file.type || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Download all files as zip (simplified - just download individually)
  const downloadAllFiles = () => {
    receivedFiles.forEach((file) => downloadFile(file));
  };

  // Reset and go back
  const handleBack = () => {
    setView("initial");
    setFiles([]);
    setReceivedFiles([]);
    setProgress(0);
    setJoinId("");
    setTransferSpeed("");
    setSenderStatus("Ready. Create a transfer to begin.");
    setReceiverStatus("Ready to connect");

    // Cleanup connections
    dataChannelRef.current?.close();
    peerConnectionRef.current?.close();
    dataChannelRef.current = null;
    peerConnectionRef.current = null;
    setConnectionState("disconnected");
  };

  const isStatusDone = receivedFiles.length > 0;

  return (
    <div
      className="fixed inset-0 overflow-hidden"
      style={{
        background: "#f3f3f3",
      }}
    >
      {/* Window */}
      <div
        className="relative h-full w-full overflow-hidden select-none flex flex-col"
        style={{
          background: "#f3f3f3",
        }}
      >
        {/* Title Bar */}
        <div
          data-tauri-drag-region
          className="flex items-center justify-between px-4 cursor-default"
          style={{
            height: 36,
            background: "rgba(235, 235, 235, 0.9)",
            borderBottom: "1px solid rgba(0,0,0,0.06)",
            WebkitAppRegion: "drag"
          }}
        >
          <div className="flex items-center gap-2" data-tauri-drag-region>
            <div
              className="flex items-center justify-center rounded-md"
              style={{ width: 20, height: 20, background: "linear-gradient(135deg, #0078d4, #005a9e)" }}
            >
              <HermesIcon />
            </div>
            <span className="text-xs font-medium" style={{ color: "#1a1a1a", fontSize: 12 }}>
              Hermes — File Transfer
            </span>
          </div>
          {/* Connection Status Indicator */}
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-white/50 border border-black/5" style={{ marginLeft: 'auto', marginRight: '12px' }}>
            <div
              className="w-1.5 h-1.5 rounded-full"
              style={{
                background: connectionState === "connected" ? "#107c10" : connectionState === "connecting" ? "#ffc107" : "#c42b1c",
                boxShadow: connectionState === "connected" ? "0 0 4px #107c10" : "none"
              }}
            />
            <span className="text-[10px] font-medium" style={{ color: "#666", fontSize: '10px' }}>
              {connectionState === "connected" ? "Connected" : connectionState === "connecting" ? "Connecting..." : "Disconnected"}
            </span>
          </div>
          {/* Window Controls */}
          <div className="flex items-center" style={{ WebkitAppRegion: "no-drag", position: "relative", zIndex: 10 }}>
            <button
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                try {
                  const win = getCurrentWindow();
                  await win.minimize();
                } catch (err) {
                  console.error("Minimize failed", err);
                }
              }}
              className="flex items-center justify-center transition-colors duration-100 relative z-20"
              style={{ width: 46, height: 36, color: "#555", cursor: "pointer" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(0,0,0,0.06)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <MinimizeIcon />
            </button>
            <button
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                try {
                  const win = getCurrentWindow();
                  await win.toggleMaximize();
                } catch (err) {
                  console.error("Maximize failed", err);
                }
              }}
              className="flex items-center justify-center transition-colors duration-100 relative z-20"
              style={{ width: 46, height: 36, color: "#555", cursor: "pointer" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(0,0,0,0.06)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <MaximizeIcon />
            </button>
            <button
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                try {
                  const win = getCurrentWindow();
                  await win.close();
                } catch (err) {
                  console.error("Close failed", err);
                }
              }}
              className="flex items-center justify-center transition-colors duration-100 relative z-20"
              style={{ width: 46, height: 36, color: "#555", cursor: "pointer" }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "#c42b1c";
                e.currentTarget.style.color = "white";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "#555";
              }}
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-8 flex flex-col items-center flex-1 overflow-y-auto">
          {/* Header */}
          <div className="flex flex-col items-center mb-6">
            <div
              className="flex items-center justify-center mb-3"
              style={{
                width: 56,
                height: 56,
                borderRadius: 16,
                background: "linear-gradient(135deg, #0078d4 0%, #005a9e 100%)",
                boxShadow: "0 4px 16px rgba(0,120,212,0.4)",
              }}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                <polyline points="13 2 13 9 20 9" />
                <line x1="8" y1="13" x2="16" y2="13" />
                <line x1="8" y1="17" x2="11" y2="17" />
              </svg>
            </div>
            <h1 className="text-xl font-semibold" style={{ color: "#1a1a1a", letterSpacing: "-0.3px" }}>
              Hermes
            </h1>
            <p className="text-xs mt-0.5" style={{ color: "#666" }}>
              Peer-to-peer file transfer
            </p>
          </div>

          {/* ── INITIAL VIEW ── */}
          {view === "initial" && (
            <div className="w-full flex flex-col gap-4 mt-2">
              {/* Create transfer card */}
              <div
                className="rounded-xl p-5 flex flex-col gap-3"
                style={{
                  background: "rgba(255,255,255,0.7)",
                  border: "1px solid rgba(0,0,0,0.07)",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.05)",
                }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <div
                    className="flex items-center justify-center rounded-md"
                    style={{ width: 28, height: 28, background: "rgba(0,120,212,0.1)" }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0078d4" strokeWidth={2} strokeLinecap="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="16" />
                      <line x1="8" y1="12" x2="16" y2="12" />
                    </svg>
                  </div>
                  <span className="text-sm font-semibold" style={{ color: "#1a1a1a" }}>Send Files</span>
                </div>
                <p className="text-xs" style={{ color: "#666" }}>
                  Create a new transfer session and share the ID with the receiver.
                </p>
                <button
                  onClick={handleGenerate}
                  className="w-full flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-all duration-150"
                  style={{
                    padding: "10px 20px",
                    background: "linear-gradient(135deg, #0078d4, #005a9e)",
                    color: "white",
                    border: "none",
                    boxShadow: "0 2px 8px rgba(0,120,212,0.35)",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.filter = "brightness(1.08)")}
                  onMouseLeave={(e) => (e.currentTarget.style.filter = "none")}
                  onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.98)")}
                  onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  Create Transfer ID
                </button>
              </div>

              {/* Divider */}
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px" style={{ background: "rgba(0,0,0,0.1)" }} />
                <span className="text-xs font-medium" style={{ color: "#999" }}>or</span>
                <div className="flex-1 h-px" style={{ background: "rgba(0,0,0,0.1)" }} />
              </div>

              {/* Join transfer card */}
              <div
                className="rounded-xl p-5 flex flex-col gap-3"
                style={{
                  background: "rgba(255,255,255,0.7)",
                  border: "1px solid rgba(0,0,0,0.07)",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.05)",
                }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <div
                    className="flex items-center justify-center rounded-md"
                    style={{ width: 28, height: 28, background: "rgba(16,124,16,0.1)" }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#107c10" strokeWidth={2} strokeLinecap="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </div>
                  <span className="text-sm font-semibold" style={{ color: "#1a1a1a" }}>Receive Files</span>
                </div>
                <p className="text-xs" style={{ color: "#666" }}>
                  Enter the transfer ID shared by the sender to receive files.
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={joinId}
                    onChange={(e) => setJoinId(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === "Enter" && handleJoin()}
                    placeholder="Enter ID (e.g. AB12CD)"
                    maxLength={8}
                    className="flex-1 text-sm rounded-lg outline-none transition-all duration-150"
                    style={{
                      padding: "10px 14px",
                      background: "rgba(255,255,255,0.8)",
                      border: "1px solid rgba(0,0,0,0.12)",
                      color: "#1a1a1a",
                      fontFamily: "'Segoe UI', sans-serif",
                      letterSpacing: "1px",
                    }}
                    onFocus={(e) => (e.target.style.border = "1px solid #0078d4")}
                    onBlur={(e) => (e.target.style.border = "1px solid rgba(0,0,0,0.12)")}
                  />
                  <button
                    onClick={handleJoin}
                    disabled={joinId.trim().length < 4}
                    className="rounded-lg text-sm font-medium transition-all duration-150"
                    style={{
                      padding: "10px 18px",
                      background: joinId.trim().length >= 4 ? "linear-gradient(135deg, #107c10, #0b5c0b)" : "rgba(0,0,0,0.06)",
                      color: joinId.trim().length >= 4 ? "white" : "#999",
                      border: "none",
                      cursor: joinId.trim().length >= 4 ? "pointer" : "not-allowed",
                      boxShadow: joinId.trim().length >= 4 ? "0 2px 8px rgba(16,124,16,0.3)" : "none",
                    }}
                    onMouseEnter={(e) => { if (joinId.trim().length >= 4) e.currentTarget.style.filter = "brightness(1.1)"; }}
                    onMouseLeave={(e) => (e.currentTarget.style.filter = "none")}
                  >
                    Join
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── SENDER VIEW ── */}
          {view === "sender" && (
            <div className="w-full flex flex-col gap-4">
              {/* ID Display */}
              <div
                className="rounded-xl p-4 flex items-center justify-between"
                style={{
                  background: "rgba(0,120,212,0.06)",
                  border: "1px solid rgba(0,120,212,0.18)",
                }}
              >
                <div>
                  <p className="text-xs font-medium mb-1" style={{ color: "#666" }}>Your Transfer ID</p>
                  <p
                    className="text-2xl font-bold tracking-widest"
                    style={{ color: "#0078d4", fontVariantNumeric: "tabular-nums", letterSpacing: "6px" }}
                  >
                    {myId}
                  </p>
                </div>
                <button
                  onClick={copyId}
                  className="flex items-center gap-1.5 rounded-lg text-xs font-medium transition-all duration-150"
                  style={{
                    padding: "8px 14px",
                    background: copied ? "rgba(16,124,16,0.1)" : "rgba(0,120,212,0.1)",
                    color: copied ? "#107c10" : "#0078d4",
                    border: `1px solid ${copied ? "rgba(16,124,16,0.2)" : "rgba(0,120,212,0.2)"}`,
                  }}
                >
                  {copied ? (
                    <>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      Copied!
                    </>
                  ) : (
                    <>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                      Copy ID
                    </>
                  )}
                </button>
              </div>

              {/* Drop Zone */}
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                className="rounded-xl flex flex-col items-center justify-center gap-2 cursor-pointer transition-all duration-200"
                style={{
                  minHeight: 120,
                  border: `2px dashed ${isDragging ? "#0078d4" : "rgba(0,0,0,0.15)"}`,
                  background: isDragging ? "rgba(0,120,212,0.05)" : "rgba(255,255,255,0.5)",
                  padding: "24px",
                }}
              >
                <div
                  className="flex items-center justify-center rounded-xl mb-1"
                  style={{ width: 44, height: 44, background: isDragging ? "rgba(0,120,212,0.12)" : "rgba(0,0,0,0.05)" }}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={isDragging ? "#0078d4" : "#888"} strokeWidth={1.8} strokeLinecap="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </div>
                <p className="text-sm font-medium" style={{ color: isDragging ? "#0078d4" : "#444" }}>
                  {isDragging ? "Release to add files" : "Drag & drop files here"}
                </p>
                <p className="text-xs" style={{ color: "#999" }}>or click to browse</p>
              </div>
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />

              {/* File List */}
              {files.length > 0 && (
                <div
                  className="rounded-xl overflow-hidden"
                  style={{ border: "1px solid rgba(0,0,0,0.07)", background: "rgba(255,255,255,0.6)" }}
                >
                  <div className="px-4 py-2.5" style={{ borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
                    <p className="text-xs font-semibold" style={{ color: "#666" }}>{files.length} FILE{files.length !== 1 ? "S" : ""} QUEUED</p>
                  </div>
                  <div style={{ maxHeight: 140, overflowY: "auto" }}>
                    {files.map((f, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 px-4 py-2.5 transition-colors duration-100"
                        style={{ borderBottom: i < files.length - 1 ? "1px solid rgba(0,0,0,0.04)" : "none" }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(0,0,0,0.03)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        <div
                          className="flex items-center justify-center rounded-md flex-shrink-0"
                          style={{ width: 30, height: 30, background: "rgba(0,120,212,0.08)" }}
                        >
                          <FileIcon />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium truncate" style={{ color: "#1a1a1a" }}>{f.name}</p>
                          <p className="text-xs" style={{ color: "#999" }}>{formatBytes(f.size)}</p>
                        </div>
                        <button
                          onClick={() => removeFile(i)}
                          className="flex items-center justify-center rounded-md transition-colors duration-100"
                          style={{ width: 22, height: 22, color: "#999" }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(196,43,28,0.1)"; e.currentTarget.style.color = "#c42b1c"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#999"; }}
                        >
                          <CloseIcon />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Send Button */}
              {files.length > 0 && (
                <button
                  onClick={sendFiles}
                  disabled={connectionState !== "connected"}
                  className="w-full flex items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-all duration-150"
                  style={{
                    padding: "12px",
                    background: connectionState === "connected"
                      ? "linear-gradient(135deg, #0078d4, #005a9e)"
                      : "rgba(0,0,0,0.1)",
                    color: connectionState === "connected" ? "white" : "#999",
                    border: "none",
                    boxShadow: connectionState === "connected" ? "0 2px 12px rgba(0,120,212,0.4)" : "none",
                    cursor: connectionState === "connected" ? "pointer" : "not-allowed",
                  }}
                  onMouseEnter={(e) => { if (connectionState === "connected") e.currentTarget.style.filter = "brightness(1.08)"; }}
                  onMouseLeave={(e) => (e.currentTarget.style.filter = "none")}
                  onMouseDown={(e) => { if (connectionState === "connected") e.currentTarget.style.transform = "scale(0.98)"; }}
                  onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                  {connectionState === "connected" ? "Send Files" : "Waiting for connection..."}
                </button>
              )}

              {/* Connection Status */}
              {view === "sender" && connectionState !== "disconnected" && (
                <div className="flex items-center gap-2 text-xs" style={{ color: "#666" }}>
                  <div
                    className="rounded-full"
                    style={{
                      width: 8,
                      height: 8,
                      background: connectionState === "connected" ? "#107c10" : connectionState === "connecting" ? "#ffc107" : "#c42b1c",
                      animation: connectionState === "connecting" ? "pulse 1s ease-in-out infinite" : "none",
                    }}
                  />
                  {connectionState === "connected" ? "Connected to peer" : connectionState === "connecting" ? "Connecting..." : "Connection error"}
                </div>
              )}

              {/* Status */}
              <StatusBar text={senderStatus} type={files.length > 0 ? "ready" : "waiting"} />
            </div>
          )}

          {/* ── RECEIVER VIEW ── */}
          {view === "receiver" && (
            <div className="w-full flex flex-col gap-4">
              <div
                className="rounded-xl p-4 flex items-center gap-3"
                style={{
                  background: "rgba(16,124,16,0.06)",
                  border: "1px solid rgba(16,124,16,0.18)",
                }}
              >
                <div
                  className="flex items-center justify-center rounded-full flex-shrink-0"
                  style={{ width: 36, height: 36, background: "rgba(16,124,16,0.12)" }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#107c10" strokeWidth={2.5} strokeLinecap="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-semibold" style={{ color: "#107c10" }}>Connected to Transfer</p>
                  <p className="text-xs" style={{ color: "#666" }}>Session ID: <span className="font-bold" style={{ letterSpacing: 2 }}>{joinId}</span></p>
                </div>
              </div>

              {/* Progress */}
              <div
                className="rounded-xl p-5 flex flex-col gap-4"
                style={{ background: "rgba(255,255,255,0.7)", border: "1px solid rgba(0,0,0,0.07)" }}
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold" style={{ color: "#1a1a1a" }}>Transfer Progress</p>
                  <div className="flex items-center gap-2">
                    {transferSpeed && progress > 0 && progress < 100 && (
                      <span className="text-xs" style={{ color: "#666" }}>{transferSpeed}</span>
                    )}
                    <span className="text-sm font-bold" style={{ color: "#0078d4" }}>{Math.round(progress)}%</span>
                  </div>
                </div>

                {/* Progress Bar */}
                <div
                  className="rounded-full overflow-hidden"
                  style={{ height: 6, background: "rgba(0,0,0,0.08)" }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${progress}%`,
                      background: isStatusDone
                        ? "linear-gradient(90deg, #107c10, #0b5c0b)"
                        : "linear-gradient(90deg, #0078d4, #005a9e)",
                      boxShadow: isStatusDone ? "0 0 8px rgba(16,124,16,0.4)" : "0 0 8px rgba(0,120,212,0.4)",
                    }}
                  />
                </div>

                {/* Animated Receiver Icon */}
                <div className="flex flex-col items-center gap-3 py-4">
                  <div
                    className="flex items-center justify-center rounded-2xl"
                    style={{
                      width: 64,
                      height: 64,
                      background: isStatusDone ? "rgba(16,124,16,0.1)" : "rgba(0,120,212,0.08)",
                      animation: !isStatusDone && progress > 0 ? "pulse 1.5s ease-in-out infinite" : "none",
                    }}
                  >
                    {isStatusDone ? (
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#107c10" strokeWidth={2} strokeLinecap="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#0078d4" strokeWidth={1.8} strokeLinecap="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    )}
                  </div>
                  <p className="text-sm font-medium text-center" style={{ color: "#444" }}>{receiverStatus}</p>
                </div>
              </div>

              {isStatusDone && (
                <button
                  onClick={downloadAllFiles}
                  className="w-full flex items-center justify-center gap-2 rounded-lg text-sm font-semibold"
                  style={{
                    padding: "12px",
                    background: "linear-gradient(135deg, #107c10, #0b5c0b)",
                    color: "white",
                    border: "none",
                    boxShadow: "0 2px 12px rgba(16,124,16,0.35)",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.filter = "brightness(1.08)")}
                  onMouseLeave={(e) => (e.currentTarget.style.filter = "none")}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Save Files ({receivedFiles.length})
                </button>
              )}

              {/* Received Files List */}
              {receivedFiles.length > 0 && (
                <div
                  className="rounded-xl overflow-hidden"
                  style={{ border: "1px solid rgba(0,0,0,0.07)", background: "rgba(255,255,255,0.6)" }}
                >
                  <div className="px-4 py-2.5" style={{ borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
                    <p className="text-xs font-semibold" style={{ color: "#666" }}>{receivedFiles.length} FILE{receivedFiles.length !== 1 ? "S" : ""} RECEIVED</p>
                  </div>
                  <div style={{ maxHeight: 140, overflowY: "auto" }}>
                    {receivedFiles.map((f, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 px-4 py-2.5 transition-colors duration-100 cursor-pointer"
                        style={{ borderBottom: i < receivedFiles.length - 1 ? "1px solid rgba(0,0,0,0.04)" : "none" }}
                        onClick={() => downloadFile(f)}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(0,0,0,0.03)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        <div
                          className="flex items-center justify-center rounded-md flex-shrink-0"
                          style={{ width: 30, height: 30, background: "rgba(16,124,16,0.08)" }}
                        >
                          <FileIcon />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium truncate" style={{ color: "#1a1a1a" }}>{f.name}</p>
                          <p className="text-xs" style={{ color: "#999" }}>{formatBytes(f.size)}</p>
                        </div>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#107c10" strokeWidth={2}>
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" />
                          <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <StatusBar text={receiverStatus} type={isStatusDone ? "done" : "waiting"} />
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="px-8 py-3 flex items-center justify-between"
          style={{ borderTop: "1px solid rgba(0,0,0,0.06)", background: "rgba(240,240,240,0.8)" }}
        >
          {view !== "initial" && (
            <button
              onClick={handleBack}
              className="text-xs flex items-center gap-1.5 transition-colors duration-150"
              style={{ color: "#666", background: "none", border: "none", cursor: "pointer" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#0078d4")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#666")}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <line x1="19" y1="12" x2="5" y2="12" />
                <polyline points="12 19 5 12 12 5" />
              </svg>
              Back
            </button>
          )}
          {view === "initial" && <span />}
          <p className="text-xs flex items-center gap-1" style={{ color: "#aaa" }}>
            Hermes v1.0.6 · Secure P2P
            {updateAvailable && (
              <span
                onClick={() => relaunchProcess()}
                className="ml-1 px-1.5 py-0.5 rounded bg-blue-500 text-white cursor-pointer hover:bg-blue-600 transition-colors"
                style={{ fontSize: '9px', fontWeight: 'bold' }}
              >
                Update Available!
              </span>
            )}
          </p>
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.7; transform: scale(0.96); }
        }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); border-radius: 4px; }
        html, body, #root {
          width: 100%;
          height: 100%;
          margin: 0;
          padding: 0;
          overflow: hidden;
        }
      `}</style>
    </div>
  );
}

function StatusBar({ text, type }: { text: string; type: "waiting" | "ready" | "done" }) {
  const colors = {
    waiting: { bg: "rgba(0,0,0,0.04)", dot: "#aaa", text: "#777" },
    ready: { bg: "rgba(0,120,212,0.06)", dot: "#0078d4", text: "#0078d4" },
    done: { bg: "rgba(16,124,16,0.06)", dot: "#107c10", text: "#107c10" },
  };
  const c = colors[type];
  return (
    <div
      className="flex items-center gap-2 rounded-lg px-3 py-2"
      style={{ background: c.bg }}
    >
      <div
        className="rounded-full flex-shrink-0"
        style={{
          width: 7,
          height: 7,
          background: c.dot,
          boxShadow: type !== "waiting" ? `0 0 6px ${c.dot}` : "none",
          animation: type === "waiting" ? "pulse 2s ease-in-out infinite" : "none",
        }}
      />
      <p className="text-xs font-medium" style={{ color: c.text }}>{text}</p>
    </div>
  );
}
