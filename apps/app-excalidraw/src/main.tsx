import { frameSDK } from "@zomme/frame-react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// Attach the frame SDK's INIT listener DURING module execution — before the
// iframe `load` event the host waits on — instead of later, inside React's
// effect (where useFrameSDK calls initialize()). The host (z-frame) posts its
// INIT exactly once, right after `load`; if the listener is still queued behind
// React's commit/effect phase, that INIT is missed (postMessage isn't buffered)
// and the SDK times out into standalone mode → blank canvas, no scene. This is
// timing-sensitive: dev (http) tends to win the race, prod (tauri://) loses it.
// Eager init closes the race; useFrameSDK then reuses this same in-flight init
// (the SDK memoizes it). The rejection (true standalone, no parent) is expected
// and handled again by useFrameSDK, so swallow it here to avoid a noisy reject.
void frameSDK.initialize().catch(() => {});

// Excalidraw 0.18 loads its fonts from `EXCALIDRAW_ASSET_PATH` (default: a CDN,
// which fails offline in the Tauri shell). The fonts are copied next to the
// bundle (see vite.config.ts → viteStaticCopy → /fonts), and the guest is served
// from /excalidraw/, so a document-relative "./" resolves to /excalidraw/fonts/.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = "./";

// No StrictMode on purpose: it double-invokes effects, which would double the
// register/save round-trips during this PoC.
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
