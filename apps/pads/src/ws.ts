import type { ChannelEvent, ClientMessage } from "@strudel-point/shared";
import { useCallback, useEffect, useRef, useState } from "react";

// Straight copy of apps/dj/src/ws.ts (itself a copy of apps/web/src/ws.ts) — see that
// file's comments for why /ws is *not* proxied through Vite (the browser connects to the
// gateway's own published port directly) while /api is. Kept as a separate copy rather
// than a shared import so the pads app never needs to depend on the web/dj apps' packages.

type JoinedAck = { type: "joined"; userId: string; channelId: string };
type ErrorAck = { type: "error"; message: string };
type IncomingMessage = ChannelEvent | JoinedAck | ErrorAck;

interface UseChannelSocketOpts {
  channelId: string;
  username: string;
  onEvent: (event: ChannelEvent) => void;
  onError: (message: string) => void;
}

export function useChannelSocket({ channelId, username, onEvent, onError }: UseChannelSocketOpts) {
  const wsRef = useRef<WebSocket | null>(null);
  const selfUserId = useRef<string | null>(null);
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let stopped = false;
    let retryDelay = 500;
    let ws: WebSocket;

    function connect() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const gatewayHost = import.meta.env.VITE_GATEWAY_WS_HOST || `${location.hostname}:8787`;
      ws = new WebSocket(`${proto}://${gatewayHost}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        retryDelay = 500;
        setConnected(true);
        ws.send(JSON.stringify({ type: "join", channelId, username } satisfies ClientMessage));
      };

      ws.onmessage = (e) => {
        let msg: IncomingMessage;
        try {
          msg = JSON.parse(e.data);
        } catch (err) {
          onErrorRef.current(`received malformed message from server: ${String(err)}`);
          return;
        }
        if (msg.type === "joined") {
          selfUserId.current = msg.userId;
          return;
        }
        if (msg.type === "error") {
          onErrorRef.current(msg.message);
          return;
        }
        if (msg.userId === selfUserId.current) return;
        onEventRef.current(msg);
      };

      ws.onclose = () => {
        setConnected(false);
        if (stopped) return;
        onErrorRef.current("disconnected from server, reconnecting...");
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 8000);
      };
    }

    connect();
    return () => {
      stopped = true;
      wsRef.current?.close();
    };
  }, [channelId, username]);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { connected, send };
}
