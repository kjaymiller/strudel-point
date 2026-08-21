import { useRef } from "react";

interface SaveDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (title: string) => void;
}

export function SaveDialog({ open, onClose, onSave }: SaveDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  return (
    <dialog open style={{ position: "fixed", inset: 0, margin: "auto", width: 320, zIndex: 10 }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(inputRef.current?.value.trim() || "untitled");
        }}
      >
        <h2 style={{ margin: "0 0 8px" }}>Save track</h2>
        <input ref={inputRef} autoFocus placeholder="title" />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="secondary" onClick={onClose}>
            cancel
          </button>
          <button type="submit">save</button>
        </div>
      </form>
    </dialog>
  );
}
