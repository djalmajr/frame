import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { MessageEvent as MessageType } from "../src/constants";
import type { Frame } from "../src/frame";

const SRC = "http://localhost:3000";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

interface PostedMessage {
  message: any;
  origin: string;
  transfer: Transferable[];
}

/** Mock iframe whose contentWindow captures INIT posts (window.postMessage path) */
const createMockIframe = () => {
  const posted: PostedMessage[] = [];
  const iframe = {
    contentWindow: {
      postMessage: (message: any, origin: string, transfer: Transferable[] = []) => {
        posted.push({ message, origin, transfer });
      },
    },
    remove: mock(() => {}),
    src: "",
    setAttribute: mock(() => {}),
    style: { cssText: "" },
  };
  return { iframe, posted };
};

describe("Frame", () => {
  let frame: Frame;
  let childPorts: MessagePort[];

  /**
   * Complete the real handshake: _sendInit() posts INIT carrying port2 of the
   * channel the frame just created; the "child" answers READY on that port,
   * which makes the frame adopt port1. All later traffic flows over the real
   * (Bun) MessageChannel.
   */
  const connectChild = async () => {
    const { iframe, posted } = createMockIframe();
    frame.__origin = SRC;
    frame.__iframe = iframe as any;
    (frame as any)._sendInit();

    const init = posted[0];
    const childPort = init.transfer[0] as MessagePort;
    childPorts.push(childPort);

    const received: any[] = [];
    childPort.onmessage = (event: any) => received.push(event.data);
    childPort.postMessage({ type: MessageType.READY });
    await tick(); // Bun MessagePort delivery is a macrotask

    return { iframe, posted, childPort, received, init };
  };

  beforeEach(() => {
    childPorts = [];
    frame = document.createElement("z-frame") as Frame;
    frame.setAttribute("src", SRC);

    // happy-dom probes `on<type>` on dispatchEvent (real browsers never
    // consult arbitrary on* props); the prototype proxy would fabricate a
    // rejecting RPC method for it. Predefine inert own props so the probe
    // sees undefined. `undefined` values are also skipped by _collectAllProps.
    (frame as any).onready = undefined;
  });

  afterEach(() => {
    frame.disconnectedCallback();
    for (const port of childPorts) {
      port.close();
    }
  });

  describe("attributes and getters", () => {
    it("should default pathname to /", () => {
      expect(frame.pathname).toBe("/");
    });

    it("should normalize pathname to start with /", () => {
      frame.setAttribute("pathname", "settings");
      expect(frame.pathname).toBe("/settings");
    });

    it("should sync pathname property to attribute and remove on null", () => {
      frame.pathname = "/dashboard";
      expect(frame.getAttribute("pathname")).toBe("/dashboard");

      frame.pathname = null;
      expect(frame.hasAttribute("pathname")).toBe(false);
      expect(frame.pathname).toBe("/");
    });

    it("should default sandbox to the permissive baseline", () => {
      expect(frame.sandbox).toBe(
        "allow-scripts allow-same-origin allow-forms allow-popups allow-modals",
      );
    });

    it("should sync sandbox property to attribute", () => {
      frame.sandbox = "allow-scripts";
      expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    });

    it("should expose src via getter/setter", () => {
      expect(frame.src).toBe(SRC);
      frame.src = "http://localhost:4000";
      expect(frame.getAttribute("src")).toBe("http://localhost:4000");
    });

    it("should not be ready before the handshake", () => {
      expect(frame.isReady).toBe(false);
    });
  });

  describe("allow (Permissions Policy)", () => {
    it("should default to empty string", () => {
      expect(frame.allow).toBe("");
    });

    it("should sync allow property to attribute and remove on null", () => {
      frame.allow = "camera; microphone";
      expect(frame.getAttribute("allow")).toBe("camera; microphone");

      frame.allow = null;
      expect(frame.hasAttribute("allow")).toBe(false);
      expect(frame.allow).toBe("");
    });

    it("should create the iframe with the allow attribute when set beforehand", () => {
      frame.setAttribute("allow", "camera; geolocation");
      (frame as any)._setupIframe();

      const iframe = frame.__iframe;
      expect(iframe.getAttribute("allow")).toBe("camera; geolocation");
    });

    it("should create the iframe without allow when not set", () => {
      (frame as any)._setupIframe();

      expect(frame.__iframe.hasAttribute("allow")).toBe(false);
    });

    it("should recreate the iframe when allow changes after creation", () => {
      (frame as any)._setupIframe();
      const first = frame.__iframe;
      expect(first.hasAttribute("allow")).toBe(false);

      frame.allow = "camera *";

      const second = frame.__iframe;
      expect(second).not.toBe(first);
      expect(second.getAttribute("allow")).toBe("camera *");
      expect(first.parentNode).toBe(null); // old iframe was removed
    });

    it("should recreate the iframe without allow when the attribute is removed", () => {
      frame.setAttribute("allow", "camera");
      (frame as any)._setupIframe();
      const first = frame.__iframe;

      frame.allow = null;

      const second = frame.__iframe;
      expect(second).not.toBe(first);
      expect(second.hasAttribute("allow")).toBe(false);
    });

    it("should include allow in the collected props", () => {
      expect((frame as any)._collectAllProps().allow).toBe("");

      frame.setAttribute("allow", "camera");
      expect((frame as any)._collectAllProps().allow).toBe("camera");
    });

    it("should send allow in the INIT payload", async () => {
      frame.setAttribute("allow", "fullscreen");
      const { init } = await connectChild();

      expect(init.message.type).toBe(MessageType.INIT);
      expect(init.message.payload.allow).toBe("fullscreen");
    });
  });

  describe("iframe recreation for sandbox and src", () => {
    it("should recreate the iframe when sandbox changes", () => {
      (frame as any)._setupIframe();
      const first = frame.__iframe;

      frame.sandbox = "allow-scripts";

      const second = frame.__iframe;
      expect(second).not.toBe(first);
      expect(second.getAttribute("sandbox")).toBe("allow-scripts");
    });

    it("should recreate the iframe when src changes", () => {
      (frame as any)._setupIframe();
      const first = frame.__iframe;

      frame.src = "http://localhost:4000";

      const second = frame.__iframe;
      expect(second).not.toBe(first);
      expect(second.src).toContain("http://localhost:4000");
      expect(frame.__origin).toBe("http://localhost:4000");
    });
  });

  describe("initialization (_sendInit)", () => {
    it("should post INIT to the frame origin with a MessagePort", async () => {
      const { init } = await connectChild();

      expect(init.message.type).toBe(MessageType.INIT);
      expect(init.origin).toBe(SRC);
      expect(init.transfer[0]).toBeInstanceOf(MessagePort);
    });

    it("should include special and custom attributes in the INIT payload", async () => {
      frame.setAttribute("api-url", "https://api.example.com");
      const { init } = await connectChild();

      const payload = init.message.payload;
      expect(payload.src).toBe(SRC);
      expect(payload.pathname).toBe("/");
      expect(payload.sandbox).toBe(frame.sandbox);
      expect(payload.allow).toBe("");
      expect(payload["api-url"]).toBe("https://api.example.com");
    });

    it("should include dynamic properties in the INIT payload", async () => {
      (frame as any).theme = "dark";
      const { init } = await connectChild();

      expect(init.message.payload.theme).toBe("dark");
    });

    it("should become ready when the child answers READY", async () => {
      const readyHandler = mock(() => {});
      frame.addEventListener("ready", readyHandler);

      await connectChild();

      expect(frame.isReady).toBe(true);
      expect(readyHandler).toHaveBeenCalledTimes(1);
    });

    it("should not resend INIT after the handshake completed", async () => {
      const { posted } = await connectChild();

      (frame as any)._sendInit();

      expect(posted).toHaveLength(1);
    });

    it("should do nothing without an iframe", () => {
      const bare = document.createElement("z-frame") as Frame;
      expect(() => (bare as any)._sendInit()).not.toThrow();
    });
  });

  describe("CHILD_HELLO handshake", () => {
    it("should (re)send INIT when the child announces itself", () => {
      frame.__origin = SRC;
      (frame as any)._initialize();

      // Swap in a capturing iframe; the hello handler reads #iframe dynamically
      const { iframe, posted } = createMockIframe();
      frame.__iframe = iframe as any;

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: MessageType.CHILD_HELLO },
          source: iframe.contentWindow,
        } as any),
      );

      expect(posted).toHaveLength(1);
      expect(posted[0].message.type).toBe(MessageType.INIT);

      // A second hello re-sends INIT while the handshake is still open
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: MessageType.CHILD_HELLO },
          source: iframe.contentWindow,
        } as any),
      );
      expect(posted).toHaveLength(2);
    });

    it("should ignore CHILD_HELLO from foreign sources", () => {
      frame.__origin = SRC;
      (frame as any)._initialize();

      const { iframe, posted } = createMockIframe();
      frame.__iframe = iframe as any;

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: MessageType.CHILD_HELLO },
          source: { postMessage: () => {} },
        } as any),
      );

      expect(posted).toHaveLength(0);
    });
  });

  describe("message handling", () => {
    it("should handle READY message", () => {
      const readyHandler = mock(() => {});
      frame.addEventListener("ready", readyHandler);

      (frame as any)._handleMessageFromIframe({ type: MessageType.READY });

      expect(frame.isReady).toBe(true);
      expect(readyHandler).toHaveBeenCalledTimes(1);
    });

    it("should dispatch CUSTOM_EVENT as DOM event with detail", () => {
      const eventHandler = mock(() => {});
      frame.addEventListener("user-action", eventHandler);

      (frame as any)._handleMessageFromIframe({
        type: MessageType.CUSTOM_EVENT,
        payload: { name: "user-action", data: { type: "click", id: 123 } },
      });

      expect(eventHandler).toHaveBeenCalledTimes(1);
      expect((eventHandler.mock.calls[0][0] as CustomEvent).detail).toEqual({
        type: "click",
        id: 123,
      });
    });

    it("should ignore CUSTOM_EVENT without a valid name", () => {
      expect(() =>
        (frame as any)._handleMessageFromIframe({
          type: MessageType.CUSTOM_EVENT,
          payload: { data: {} },
        }),
      ).not.toThrow();
    });

    it("should intercept register events and store child functions", () => {
      (frame as any)._handleMessageFromIframe({
        type: MessageType.CUSTOM_EVENT,
        payload: { name: "register", data: { refresh: { __fn: "fn-1" } } },
      });

      expect(frame._registeredFunctions.has("refresh")).toBe(true);
      expect(typeof frame._registeredFunctions.get("refresh")).toBe("function");
    });

    it("should intercept unregister events and drop child functions", () => {
      frame._registeredFunctions.set("refresh", () => {});

      (frame as any)._handleMessageFromIframe({
        type: MessageType.CUSTOM_EVENT,
        payload: { name: "unregister", data: { functions: ["refresh"] } },
      });

      expect(frame._registeredFunctions.has("refresh")).toBe(false);
    });

    it("should call property handlers with normalized event name", () => {
      const handler = mock(() => {});
      (frame as any).statechange = handler;

      (frame as any)._handleMessageFromIframe({
        type: MessageType.CUSTOM_EVENT,
        payload: { name: "state:change", data: { value: 1 } },
      });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should release functions on FUNCTION_RELEASE", () => {
      const fnId = "test-fn-id";
      frame.__manager.__functionRegistry.set(fnId, () => {});
      frame.__manager.__trackedFunctions.add(fnId);

      (frame as any)._handleMessageFromIframe({ type: MessageType.FUNCTION_RELEASE, fnId });

      expect(frame.__manager.__functionRegistry.has(fnId)).toBe(false);
      expect(frame.__manager.__trackedFunctions.has(fnId)).toBe(false);
    });

    it("should release functions on FUNCTION_RELEASE_BATCH", () => {
      for (const fnId of ["fn-1", "fn-2"]) {
        frame.__manager.__functionRegistry.set(fnId, () => {});
        frame.__manager.__trackedFunctions.add(fnId);
      }

      (frame as any)._handleMessageFromIframe({
        type: MessageType.FUNCTION_RELEASE_BATCH,
        fnIds: ["fn-1", "fn-2"],
      });

      expect(frame.__manager.__functionRegistry.size).toBe(0);
    });

    it("should ignore malformed and unknown messages", () => {
      expect(() => (frame as any)._handleMessageFromIframe(null)).not.toThrow();
      expect(() => (frame as any)._handleMessageFromIframe("string")).not.toThrow();
      expect(() => (frame as any)._handleMessageFromIframe({ type: "__EVIL__" })).not.toThrow();
    });
  });

  describe("dynamic RPC methods", () => {
    it("should call a registered child function through the dynamic method", async () => {
      const refresh = mock(() => "refreshed");
      frame._registeredFunctions.set("refresh", refresh);

      const result = await (frame as any).refresh();

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(result).toBe("refreshed");
    });

    it("should reject when the function was not registered", async () => {
      await expect((frame as any).ghostFunction()).rejects.toThrow(
        "Function 'ghostFunction' not registered",
      );
    });

    it("should not fabricate methods for the Promise protocol", async () => {
      expect((frame as any).then).toBeUndefined();
      expect((frame as any).catch).toBeUndefined();
      expect((frame as any).finally).toBeUndefined();

      // The element must not behave as a thenable
      const resolved = await Promise.resolve(frame);
      expect(resolved).toBe(frame);
    });
  });

  describe("events to child (emit)", () => {
    it("should send EVENT messages over the adopted port", async () => {
      const { received } = await connectChild();

      frame.emit("route-change", { path: "/settings" });
      await tick();

      const eventMessage = received.find((message) => message.type === MessageType.EVENT);
      expect(eventMessage).toBeDefined();
      expect(eventMessage.name).toBe("route-change");
      expect(eventMessage.data).toEqual({ path: "/settings" });
    });

    it("should reject invalid event names", async () => {
      const { received } = await connectChild();
      const before = received.length;

      frame.emit("invalid name!");
      await tick();

      expect(received).toHaveLength(before);
    });

    it("should not throw when the port is not ready yet", () => {
      expect(() => frame.emit("too-early", {})).not.toThrow();
    });
  });

  describe("dynamic properties", () => {
    it("should store values locally before the handshake", () => {
      (frame as any).theme = "dark";

      expect((frame as any).theme).toBe("dark");
      expect((frame as any)._collectAllProps().theme).toBe("dark");
    });

    it("should send PROPS_UPDATE when a property changes after ready", async () => {
      const { received } = await connectChild();

      (frame as any).theme = "dark";
      await tick();

      const update = received.find((message) => message.type === MessageType.PROPS_UPDATE);
      expect(update).toBeDefined();
      expect(update.payload.theme).toBe("dark");
    });

    it("should serialize function properties into tokens", async () => {
      const { received } = await connectChild();

      (frame as any).onSuccess = () => "ok";
      await tick();

      const update = received.find((message) => message.type === MessageType.PROPS_UPDATE);
      expect(update.payload.onSuccess).toHaveProperty("__fn");
    });

    it("should not intercept private properties", async () => {
      const { received } = await connectChild();
      const before = received.length;

      (frame as any)._privateProperty = "test";
      await tick();

      expect((frame as any)._privateProperty).toBe("test");
      expect(received).toHaveLength(before);
    });

    it("should sync non-observed attribute changes after ready", async () => {
      const { received } = await connectChild();
      (frame as any)._setupAttributeObserver();

      frame.setAttribute("theme", "dark");
      await tick(10); // MutationObserver microtask + port macrotask

      const update = received.find((message) => message.type === MessageType.PROPS_UPDATE);
      expect(update).toBeDefined();
      expect(update.payload.theme).toBe("dark");
    });
  });

  describe("pathname behavior after initialization", () => {
    it("should navigate the iframe directly when no child is connected", () => {
      const { iframe } = createMockIframe();
      frame.__origin = SRC;
      frame.__iframe = iframe as any;

      frame.setAttribute("pathname", "/dashboard");

      expect(iframe.src).toBe(`${SRC}/dashboard`);
    });

    it("should send PROPS_UPDATE instead when the child completed the handshake", async () => {
      const { iframe, received } = await connectChild();

      frame.setAttribute("pathname", "/dashboard");
      await tick();

      expect(iframe.src).toBe(""); // no hard navigation
      const update = received.find((message) => message.type === MessageType.PROPS_UPDATE);
      expect(update).toBeDefined();
      expect(update.payload.pathname).toBe("/dashboard");
    });
  });

  describe("cleanup", () => {
    it("should clean up manager, iframe, and ready state on disconnect", async () => {
      const { iframe } = await connectChild();
      frame.__manager.__functionRegistry.set("fn-1", () => {});
      frame.__manager.__trackedFunctions.add("fn-1");

      frame.disconnectedCallback();

      expect(frame.__manager.__functionRegistry.size).toBe(0);
      expect(frame.__manager.__trackedFunctions.size).toBe(0);
      expect(iframe.remove).toHaveBeenCalled();
      expect(frame.isReady).toBe(false);
    });

    it("should reject pending function calls on disconnect", async () => {
      await connectChild();
      const resolver = {
        resolve: mock(() => {}),
        reject: mock(() => {}),
        timeout: setTimeout(() => {}, 1000),
      };
      frame.__manager.__pendingFunctionCalls.set("call-1", resolver);

      frame.disconnectedCallback();

      expect(resolver.reject).toHaveBeenCalled();
      expect(frame.__manager.__pendingFunctionCalls.size).toBe(0);
    });
  });
});
