import type { ChatStatus } from "@strudel-point/shared";
import { type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";

export interface ChatLine {
  id: string;
  /** "system" is local-only narration (a dropped file, a failed request) — never sent anywhere. */
  author: "user" | "bot" | "system";
  username: string;
  body: string;
  /** Only on a bot line: which room tools it ran to produce the reply. */
  toolsUsed?: string[];
  ts: number;
}

interface ChatPanelProps {
  status: ChatStatus | null;
  lines: ChatLine[];
  thinking: boolean;
  onSend: (message: string) => void;
  /** Called with a file dropped anywhere on the panel — sonified into the shared buffer. */
  onDropFile: (file: File) => void;
}

export function ChatPanel({ status, lines, thinking, onSend, onDropFile }: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const [dragover, setDragover] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Pin to the newest line. A chat that doesn't follow its own output is a chat you have to
  // scroll manually every time the bot answers.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, thinking]);

  const submit = () => {
    const message = draft.trim();
    if (!message) return;
    setDraft("");
    onSend(message);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, shift+enter newlines — but never swallow the editor's own chords, which
    // are global and which people hit reflexively even with focus in here.
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      submit();
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragover(false);
    const file = e.dataTransfer.files[0];
    if (file) onDropFile(file);
  };

  return (
    <div
      className={`chat${dragover ? " dragover" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragover(true);
      }}
      onDragLeave={() => setDragover(false)}
      onDrop={onDrop}
    >
      <div className="chat-transcript" ref={transcriptRef}>
        {lines.length === 0 && (
          <p className="chat-empty">
            ask for a pattern, or drop any file here — an image, a binary, anything — and its bytes become
            one.
          </p>
        )}
        {lines.map((line) => (
          <div key={line.id} className={`chat-line chat-line--${line.author}`}>
            {line.author !== "system" && <span className="chat-who">{line.username}</span>}
            <span className="chat-body">{line.body}</span>
            {line.toolsUsed && line.toolsUsed.length > 0 && (
              <span className="chat-tools">{line.toolsUsed.join(" · ")}</span>
            )}
          </div>
        ))}
        {thinking && <div className="chat-line chat-line--system">thinking…</div>}
      </div>

      {status && !status.enabled && (
        <p className="chat-notice">
          the bot is off{status.reason ? ` — ${status.reason}` : ""}. chat still reaches the room, and dropped
          files still become patterns.
        </p>
      )}

      <div className="chat-compose">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={status?.enabled ? "ask for a pattern…" : "message the room…"}
        />
        <button onClick={submit} disabled={!draft.trim() || thinking}>
          send
        </button>
      </div>
      <p className="chat-hint">
        {dragover ? "drop to sonify" : "enter sends · shift+enter for a newline · drop a file to sonify it"}
      </p>
    </div>
  );
}
