import { useCallback, useEffect, useRef, useState } from "react";
import type { ChannelEvent, ClientMessage } from "@strudel-point/shared";

type JoinedAck = { type: "joined"; userId: string; channelId: string };
type ErrorAck = { type: "error"; message: string };
type IncomingMessage = ChannelEvent | JoinedAck | ErrorAck;

interface UseChannelSocketOpts {
  channelId: string;
  username: string;
  onEvent: (event: ChannelEvent) => void;
  onError: (message: string) => void;
  /**
   * Fired with our own userId once the gateway acks the join — the earliest point at which
   * we can fetch the room roster and know which entry in it is us. Fires again on every
   * reconnect, since each join is issued a fresh userId.
   */
  onJoined?: (selfUserId: string) => void;
}

/** Connects to the gateway's /ws endpoint and joins a channel. Reconnects with backoff on drop. */
export function useChannelSocket({ channelId, username, onEvent, onError, onJoined }: UseChannelSocketOpts) {
  const wsRef = useRef<WebSocket | null>(null);
  const selfUserId = useRef<string | null>(null);
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onJoinedRef = useRef(onJoined);
  onJoinedRef.current = onJoined;

  useEffect(() => {
    let stopped = false;
    let retryDelay = 500;
    let ws: WebSocket;

    function connect() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      // Deliberately not going through Vite's /ws proxy: under Bun, that proxy (Vite's
      // http-proxy dependency) never observes the 'upgrade' event on a proxied 101
      // response, so the connection just hangs forever with no error. Connecting
      // straight to the gateway's own published port sidesteps it. /api is unaffected —
      // plain HTTP proxying works fine — so it still goes through Vite. See the `ports:`
      // comment on the gateway service in docker-compose.yml.
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
          onJoinedRef.current?.(msg.userId);
          return;
        }
        if (msg.type === "error") {
          onErrorRef.current(msg.message);
          return;
        }
        // The gateway echoes every event back through Kafka, including the sender's own —
        // the sender already applied its own action locally, so drop the echo here.
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
