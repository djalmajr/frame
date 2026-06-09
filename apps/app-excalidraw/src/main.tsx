import { createRoot } from "react-dom/client";
import { App } from "./App";

// Excalidraw 0.18 loads its fonts from `EXCALIDRAW_ASSET_PATH` (default: a CDN,
// which fails offline in the Tauri shell). The fonts are copied next to the
// bundle (see vite.config.ts → viteStaticCopy → /fonts), and the guest is served
// from /excalidraw/, so a document-relative "./" resolves to /excalidraw/fonts/.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = "./";

// No StrictMode on purpose: it double-invokes effects, which would double the
// register/save round-trips during this PoC.
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
