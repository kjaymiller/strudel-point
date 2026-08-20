import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// PatchBayProvider now mounts inside App itself, controlled by whichever channel is
// active (see App.tsx's Channel type) — it needs to be swapped out per channel, which
// only App's own state can drive.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
