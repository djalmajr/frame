import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register happy-dom globally BEFORE any other imports.
// disableIframePageLoading keeps <iframe src> off the network: connected
// iframes fail fast with a synchronous 'error' event instead of fetching.
GlobalRegistrator.register({ settings: { disableIframePageLoading: true } });

// happy-dom's MessagePort is an empty stub ("TODO: Implement"), while the
// MessageChannel global comes from Bun and actually delivers messages.
// Align the MessagePort global with the constructor MessageChannel really
// produces, so `instanceof MessagePort` checks (isTransferable) match the
// ports the code under test passes around.
const probeChannel = new MessageChannel();
(globalThis as { MessagePort: unknown }).MessagePort = probeChannel.port1.constructor;
probeChannel.port1.close();
probeChannel.port2.close();

// Import and register z-frame custom element after DOM is ready
await import("../src/frame");
