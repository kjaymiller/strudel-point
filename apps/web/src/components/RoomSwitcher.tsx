import type { Channel } from "@strudel-point/shared";
import { useEffect, useRef, useState } from "react";

interface RoomSwitcherProps {
  open: boolean;
  currentChannelId: string;
  onClose: () => void;
  onSwitch: (channelId: string) => void;
}

// Room ids ride in the URL hash as-is (see channelIdFromLocation in App.tsx) — keep this
// permissive but reject whitespace/`#` so a typo can't produce an unreachable room.
function isValidRoomId(id: string): boolean {
  return id.length > 0 && !/[\s#]/.test(id);
}

export function RoomSwitcher({ open, currentChannelId, onClose, onSwitch }: RoomSwitcherProps) {
  const [rooms, setRooms] = useState<Channel[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newRoomId, setNewRoomId] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoadError(null);
    fetch("/api/channels")
      .then((res) => {
        if (!res.ok) throw new Error(`request failed with ${res.status}`);
        return res.json();
      })
      .then(setRooms)
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, [open]);

  if (!open) return null;

  const go = (id: string) => {
    const trimmed = id.trim();
    if (!isValidRoomId(trimmed)) return;
    onSwitch(trimmed);
    setNewRoomId("");
  };

  return (
    <dialog open style={{ position: "fixed", inset: 0, margin: "auto", width: 380, zIndex: 10 }}>
      <h2 style={{ margin: "0 0 8px" }}>Rooms</h2>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(inputRef.current?.value ?? "");
        }}
        style={{ display: "flex", gap: 8, marginBottom: 12 }}
      >
        <input
          ref={inputRef}
          autoFocus
          placeholder="join or create a room…"
          value={newRoomId}
          onChange={(e) => setNewRoomId(e.target.value)}
        />
        <button type="submit" disabled={!isValidRoomId(newRoomId.trim())}>
          go
        </button>
      </form>

      {loadError && <p style={{ color: "var(--muted)", fontSize: 13 }}>couldn't load rooms: {loadError}</p>}
      {!loadError && rooms.length === 0 && (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>no other rooms yet</p>
      )}
      <div style={{ maxHeight: 280, overflowY: "auto" }}>
        {rooms.map((room) => (
          <div
            key={room.id}
            className="track"
            style={room.id === currentChannelId ? { opacity: 0.6 } : undefined}
            onClick={() => room.id !== currentChannelId && go(room.id)}
          >
            <div className="title">
              #{room.id} {room.id === currentChannelId && "(here)"}
            </div>
            <div className="meta">
              {room.peerCount} peer{room.peerCount === 1 ? "" : "s"} · last active{" "}
              {new Date(room.lastActiveAt).toLocaleString()}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
        <button type="button" className="secondary" onClick={onClose}>
          close
        </button>
      </div>
    </dialog>
  );
}
