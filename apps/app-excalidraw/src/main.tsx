import { createRoot } from "react-dom/client";
import { App } from "./App";

// No StrictMode on purpose: it double-invokes effects, which would double the
// register/save round-trips during this PoC.
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
