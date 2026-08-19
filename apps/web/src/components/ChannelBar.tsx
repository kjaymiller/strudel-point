type AutosaveState = "idle" | "saving" | "saved" | "error";

interface ChannelBarProps {
  channelId: string;
  username: string;
  connected: boolean;
  peerCount: number;
  autosaveState: AutosaveState;
  onEvaluate: () => void;
  onHush: () => void;
  onSave: () => void;
  onOpenRooms: () => void;
}

const AUTOSAVE_LABEL: Record<AutosaveState, string> = {
  idle: "",
  saving: "saving…",
  saved: "saved",
  error: "autosave failed",
};

export function ChannelBar({
  channelId,
  username,
  connected,
  peerCount,
  autosaveState,
  onEvaluate,
  onHush,
  onSave,
  onOpenRooms,
}: ChannelBarProps) {
  return (
    <div className="topbar">
      <h1>strudel-point</h1>
      <span className="presence">
        <span className="dot" style={{ background: connected ? "#7ee0c1" : "#e05252" }} />
        <button
          className="secondary"
          style={{ padding: "2px 8px", fontSize: 12 }}
          onClick={onOpenRooms}
          title="switch rooms"
        >
          #{channelId}
        </button>
        · {username} · {peerCount} peer{peerCount === 1 ? "" : "s"}
      </span>
      {autosaveState !== "idle" && (
        <span className="presence" style={{ color: autosaveState === "error" ? "#e05252" : undefined }}>
          {AUTOSAVE_LABEL[autosaveState]}
        </span>
      )}
      <div className="spacer" />
      <button className="secondary" onClick={onHush}>
        hush (⌘.)
      </button>
      <button className="secondary" onClick={onSave}>
        save
      </button>
      <button onClick={onEvaluate}>evaluate (⌘⏎)</button>
    </div>
  );
}
