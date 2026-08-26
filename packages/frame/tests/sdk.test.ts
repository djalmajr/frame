import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { MessageEvent as MessageType } from "../src/constants";
import { FrameSDK } from "../src/sdk";

/**
 * Captured outgoing message posted by the SDK on its MessagePort
 */
interface SentMessage {
  message: any;
  transferables?: Transferable[];
}

const PARENT_ORIGIN = "http://localhost:4200";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("FrameSDK", () => {
  let sdk: FrameSDK;
  let openChannels: MessageChannel[];

  /**
   * Dispatch a synthetic INIT on window, the way the parent frame does it:
   * a real MessagePort travels in `ports` (sdk.initialize() requires it).
   * The port's postMessage is replaced with a capture so every message the
   * SDK sends to the parent lands in `sent`, deterministically.
   */
  const dispatchInit = (payload: Record<string, unknown> = {}, origin = PARENT_ORIGIN) => {
    const channel = new MessageChannel();
    openChannels.push(channel);

    const sent: SentMessage[] = [];
    (channel.port2 as any).postMessage = (message: any, transferables?: Transferable[]) => {
      sent.push({ message, transferables });
    };

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: MessageType.INIT, payload },
        origin,
        ports: [channel.port2],
      } as any),
    );

    return { channel, sent };
  };

  /** Initialize the SDK and return the captured parent-bound traffic */
  const initializeSdk = async (payload: Record<string, unknown> = {}) => {
    const initPromise = sdk.initialize();
    const env = dispatchInit(payload);
    await initPromise;
    return env;
  };

  /** Deliver a message from the parent to the SDK (as the port would) */
  const deliver = (data: unknown) => {
    (sdk as any)._handleMessage({ data });
  };

  beforeEach(() => {
    sdk = new FrameSDK();
    openChannels = [];
  });

  afterEach(() => {
    sdk.cleanup();
    for (const channel of openChannels) {
      channel.port1.close();
      channel.port2.close();
    }
  });

  describe("initialization", () => {
    it("should resolve when INIT arrives with a MessagePort", async () => {
      await initializeSdk({ apiUrl: "https://api.test.com", theme: "dark" });

      expect(sdk.isInitialized).toBe(true);
      expect(sdk.props).toBeDefined();
      expect(sdk.props.apiUrl).toBe("https://api.test.com");
      expect(sdk.props.theme).toBe("dark");
      expect(sdk.__parentOrigin).toBe(PARENT_ORIGIN);
    });

    it("should send READY on the received port after initialization", async () => {
      const { sent } = await initializeSdk();

      const readyMessage = sent.find((item) => item.message.type === MessageType.READY);
      expect(readyMessage).toBeDefined();
    });

    it("should reject when INIT carries no MessagePort", async () => {
      const initPromise = sdk.initialize();

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: MessageType.INIT, payload: {} },
          origin: PARENT_ORIGIN,
        } as any),
      );

      await expect(initPromise).rejects.toThrow("No MessagePort received in INIT message");
    });

    it("should reject on timeout when INIT never arrives", async () => {
      await expect(sdk.initialize(undefined, 25)).rejects.toThrow("Initialization timeout");
    });

    it("should reject when origin validation fails", async () => {
      const initPromise = sdk.initialize("https://expected.example.com");
      dispatchInit({}, "http://evil.example.com");

      await expect(initPromise).rejects.toThrow("Origin mismatch");
    });

    it("should accept INIT from the expected origin", async () => {
      const initPromise = sdk.initialize(PARENT_ORIGIN);
      dispatchInit({ theme: "light" });

      await initPromise;
      expect(sdk.isInitialized).toBe(true);
    });

    it("should resolve immediately on duplicate initialize()", async () => {
      await initializeSdk();
      await sdk.initialize(); // must not hang waiting for a second INIT
      expect(sdk.isInitialized).toBe(true);
    });

    it("should share one in-flight initialization across concurrent callers", async () => {
      const first = sdk.initialize();
      const second = sdk.initialize();
      dispatchInit({ theme: "dark" });

      await Promise.all([first, second]);
      expect(sdk.props.theme).toBe("dark");
    });

    it("should ignore a duplicate INIT message", async () => {
      const { sent } = await initializeSdk({ theme: "first" });

      dispatchInit({ theme: "second" });

      expect(sdk.props.theme).toBe("first");
      const readyMessages = sent.filter((item) => item.message.type === MessageType.READY);
      expect(readyMessages).toHaveLength(1);
    });

    it("should deserialize function tokens in props", async () => {
      await initializeSdk({
        onSuccess: { __fn: "test-fn-id", __meta: { name: "onSuccess" } },
      });

      expect(typeof sdk.props.onSuccess).toBe("function");
    });

    it("should announce CHILD_HELLO to the parent until INIT arrives", async () => {
      const ownParentDescriptor = Object.getOwnPropertyDescriptor(window, "parent");
      const posted: Array<{ message: any; targetOrigin: string }> = [];
      const fakeParent = {
        postMessage: (message: any, targetOrigin: string) => {
          posted.push({ message, targetOrigin });
        },
      };
      Object.defineProperty(window, "parent", { configurable: true, value: fakeParent });

      try {
        const initPromise = sdk.initialize();

        // First hello fires synchronously inside initialize()
        expect(posted.length).toBeGreaterThanOrEqual(1);
        expect(posted[0].message.type).toBe(MessageType.CHILD_HELLO);
        expect(posted[0].targetOrigin).toBe("*");

        // INIT arrival must stop the re-announce interval (no timers left over)
        dispatchInit();
        await initPromise;
        expect(sdk.isInitialized).toBe(true);
      } finally {
        if (ownParentDescriptor) {
          Object.defineProperty(window, "parent", ownParentDescriptor);
        } else {
          Reflect.deleteProperty(window, "parent");
        }
      }
    });

    it("should not announce CHILD_HELLO when there is no parent frame", async () => {
      // In happy-dom window.parent === window: the hello ping must not arm
      expect(window.parent).toBe(window as any);
      await initializeSdk();
      expect(sdk.isInitialized).toBe(true);
    });
  });

  describe("emit", () => {
    let sent: SentMessage[];

    beforeEach(async () => {
      ({ sent } = await initializeSdk());
    });

    it("should emit custom event to parent", () => {
      sdk.emit("user-action", { type: "click", id: 123 });

      const emitCall = sent.find((item) => item.message.type === MessageType.CUSTOM_EVENT);
      expect(emitCall).toBeDefined();
      expect(emitCall!.message.payload.name).toBe("user-action");
      expect(emitCall!.message.payload.data).toEqual({ type: "click", id: 123 });
    });

    it("should emit event without data", () => {
      sdk.emit("data-loaded");

      const emitCall = sent.find((item) => item.message.type === MessageType.CUSTOM_EVENT);
      expect(emitCall).toBeDefined();
      expect(emitCall!.message.payload.name).toBe("data-loaded");
    });

    it("should reject invalid event names", () => {
      sdk.emit("invalid name!");

      const emitCall = sent.find((item) => item.message.type === MessageType.CUSTOM_EVENT);
      expect(emitCall).toBeUndefined();
    });

    it("should serialize functions in event data", () => {
      const callback = () => "test";
      sdk.emit("action", { callback });

      const emitCall = sent.find((item) => item.message.type === MessageType.CUSTOM_EVENT);
      expect(emitCall!.message.payload.data.callback).toHaveProperty("__fn");
    });

    it("should collect transferables from event data", () => {
      const buffer = new ArrayBuffer(8);
      sdk.emit("data", { buffer });

      const emitCall = sent.find((item) => item.message.type === MessageType.CUSTOM_EVENT);
      expect(emitCall!.transferables).toContain(buffer);
    });
  });

  describe("register", () => {
    let sent: SentMessage[];

    beforeEach(async () => {
      ({ sent } = await initializeSdk());
    });

    const findEvent = (name: string) =>
      sent.find(
        (item) =>
          item.message.type === MessageType.CUSTOM_EVENT && item.message.payload.name === name,
      );

    it("should register single function with name", () => {
      const refresh = mock(() => "refreshed");
      const unregister = sdk.register("refresh", refresh);

      const registerCall = findEvent("register");
      expect(registerCall).toBeDefined();
      expect(registerCall!.message.payload.data.refresh).toHaveProperty("__fn");
      expect(typeof unregister).toBe("function");
    });

    it("should register multiple functions with object", () => {
      const unregister = sdk.register({
        refresh: mock(() => "refreshed"),
        export: mock(async (format: string) => `exported-${format}`),
        close: mock(() => undefined),
      });

      const registerCall = findEvent("register");
      expect(registerCall).toBeDefined();
      expect(registerCall!.message.payload.data.refresh).toHaveProperty("__fn");
      expect(registerCall!.message.payload.data.export).toHaveProperty("__fn");
      expect(registerCall!.message.payload.data.close).toHaveProperty("__fn");
      expect(typeof unregister).toBe("function");
    });

    it("should throw TypeError if single function registration receives non-function", () => {
      expect(() => sdk.register("invalid", "not-a-function" as any)).toThrow(TypeError);
      expect(() => sdk.register("invalid", 123 as any)).toThrow(TypeError);
      expect(() => sdk.register("invalid", null as any)).toThrow(TypeError);
    });

    it("should throw TypeError if object registration contains non-function values", () => {
      expect(() =>
        sdk.register({ validFn: () => {}, invalidValue: "not-a-function" } as any),
      ).toThrow(TypeError);
      expect(() => sdk.register({ fn1: () => {}, fn2: 123 } as any)).toThrow(TypeError);
    });

    it("should throw TypeError if first parameter is neither string nor object", () => {
      expect(() => sdk.register(123 as any)).toThrow(TypeError);
      expect(() => sdk.register(null as any)).toThrow(TypeError);
      expect(() => sdk.register(undefined as any)).toThrow(TypeError);
    });

    it("should emit unregister event when cleanup function is called", () => {
      const unregister = sdk.register(
        "refresh",
        mock(() => "refreshed"),
      );
      sent.length = 0;

      unregister();

      const unregisterCall = findEvent("unregister");
      expect(unregisterCall).toBeDefined();
      expect(unregisterCall!.message.payload.data.functions).toContain("refresh");
    });

    it("should emit unregister with multiple function names", () => {
      const unregister = sdk.register({
        refresh: mock(() => {}),
        export: mock(() => {}),
        close: mock(() => {}),
      });
      sent.length = 0;

      unregister();

      const unregisterCall = findEvent("unregister");
      expect(unregisterCall).toBeDefined();
      expect(unregisterCall!.message.payload.data.functions).toContain("refresh");
      expect(unregisterCall!.message.payload.data.functions).toContain("export");
      expect(unregisterCall!.message.payload.data.functions).toContain("close");
    });
  });

  describe("event listeners", () => {
    beforeEach(async () => {
      await initializeSdk();
    });

    it("should call listener when event received", () => {
      const handler = mock(() => {});
      sdk.on("custom-event", handler);

      deliver({ type: MessageType.EVENT, name: "custom-event", data: { value: 42 } });

      expect(handler).toHaveBeenCalledWith({ value: 42 });
    });

    it("should remove event listener with off()", () => {
      const handler = mock(() => {});
      sdk.on("test-event", handler);
      sdk.off("test-event", handler);

      deliver({ type: MessageType.EVENT, name: "test-event", data: {} });

      expect(handler).not.toHaveBeenCalled();
    });

    it("should return dispose function from on()", () => {
      const handler = mock(() => {});
      const dispose = sdk.on("test-event", handler);
      expect(typeof dispose).toBe("function");

      dispose();
      deliver({ type: MessageType.EVENT, name: "test-event", data: { value: 42 } });

      expect(handler).not.toHaveBeenCalled();
    });

    it("should buffer events received before a handler registers, then replay", () => {
      deliver({ type: MessageType.EVENT, name: "early-event", data: { value: 1 } });

      const handler = mock(() => {});
      sdk.on("early-event", handler);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ value: 1 });

      // Buffer is cleared after replay: a second handler gets nothing
      const lateHandler = mock(() => {});
      sdk.on("early-event", lateHandler);
      expect(lateHandler).not.toHaveBeenCalled();
    });

    it("should keep calling other handlers when one throws", () => {
      const throwing = mock(() => {
        throw new Error("boom");
      });
      const normal = mock(() => {});
      sdk.on("evt", throwing);
      sdk.on("evt", normal);

      expect(() => deliver({ type: MessageType.EVENT, name: "evt", data: {} })).not.toThrow();
      expect(throwing).toHaveBeenCalledTimes(1);
      expect(normal).toHaveBeenCalledTimes(1);
    });
  });

  describe("message handling", () => {
    beforeEach(async () => {
      await initializeSdk({ theme: "light" });
    });

    it("should ignore unknown message types", () => {
      const handler = mock(() => {});
      sdk.on("test-event", handler);

      deliver({ type: "__EVIL__", name: "test-event", data: {} });

      expect(handler).not.toHaveBeenCalled();
    });

    it("should ignore malformed messages", () => {
      expect(() => deliver(null)).not.toThrow();
      expect(() => deliver("string")).not.toThrow();
      expect(() => deliver({ notype: true })).not.toThrow();
      expect(() => deliver({ type: 42 })).not.toThrow();
    });

    it("should update props on PROPS_UPDATE", () => {
      deliver({ type: MessageType.PROPS_UPDATE, payload: { theme: "dark" } });

      expect(sdk.props.theme).toBe("dark");
    });

    it("should skip forbidden property names in PROPS_UPDATE", () => {
      deliver({
        type: MessageType.PROPS_UPDATE,
        payload: JSON.parse('{"__proto__": {"hacked": true}, "safe": "ok"}'),
      });

      expect(sdk.props.safe).toBe("ok");
      expect(({} as any).hacked).toBeUndefined();
    });

    it("should deserialize function tokens in PROPS_UPDATE", () => {
      deliver({
        type: MessageType.PROPS_UPDATE,
        payload: { onUpdate: { __fn: "fn-id", __meta: { name: "onUpdate" } } },
      });

      expect(typeof sdk.props.onUpdate).toBe("function");
    });

    it("should release function on FUNCTION_RELEASE", () => {
      const fnId = "test-fn-id";
      const manager = sdk.__functionManager;
      manager.__functionRegistry.set(fnId, () => {});
      manager.__trackedFunctions.add(fnId);

      deliver({ type: MessageType.FUNCTION_RELEASE, fnId });

      expect(manager.__functionRegistry.has(fnId)).toBe(false);
      expect(manager.__trackedFunctions.has(fnId)).toBe(false);
    });

    it("should release functions on FUNCTION_RELEASE_BATCH", () => {
      const manager = sdk.__functionManager;
      for (const fnId of ["fn-1", "fn-2"]) {
        manager.__functionRegistry.set(fnId, () => {});
        manager.__trackedFunctions.add(fnId);
      }

      deliver({ type: MessageType.FUNCTION_RELEASE_BATCH, fnIds: ["fn-1", "fn-2"] });

      expect(manager.__functionRegistry.size).toBe(0);
      expect(manager.__trackedFunctions.size).toBe(0);
    });
  });

  describe("function calls", () => {
    let sent: SentMessage[];

    beforeEach(async () => {
      ({ sent } = await initializeSdk());
    });

    it("should execute registered function on FUNCTION_CALL and respond", async () => {
      const testFn = mock(() => "result");
      sdk.__functionManager.__functionRegistry.set("fn-1", testFn);

      deliver({
        type: MessageType.FUNCTION_CALL,
        callId: "call-1",
        fnId: "fn-1",
        params: [1, 2, 3],
      });
      await tick();

      expect(testFn).toHaveBeenCalledWith(1, 2, 3);
      const response = sent.find((item) => item.message.type === MessageType.FUNCTION_RESPONSE);
      expect(response).toBeDefined();
      expect(response!.message.success).toBe(true);
      expect(response!.message.result).toBe("result");
      expect(response!.message.callId).toBe("call-1");
    });

    it("should respond with error when the function throws", async () => {
      sdk.__functionManager.__functionRegistry.set(
        "fn-1",
        mock(() => {
          throw new Error("Test error");
        }),
      );

      deliver({ type: MessageType.FUNCTION_CALL, callId: "call-1", fnId: "fn-1", params: [] });
      await tick();

      const response = sent.find((item) => item.message.type === MessageType.FUNCTION_RESPONSE);
      expect(response!.message.success).toBe(false);
      expect(response!.message.error).toBe("Test error");
    });

    it("should respond with error when the function is not registered", async () => {
      deliver({ type: MessageType.FUNCTION_CALL, callId: "call-1", fnId: "ghost", params: [] });
      await tick();

      const response = sent.find((item) => item.message.type === MessageType.FUNCTION_RESPONSE);
      expect(response!.message.success).toBe(false);
      expect(response!.message.error).toContain("Function not found");
    });

    it("should resolve pending call on FUNCTION_RESPONSE success", () => {
      const resolver = {
        resolve: mock(() => {}),
        reject: mock(() => {}),
        timeout: setTimeout(() => {}, 1000),
      };
      sdk.__functionManager.__pendingFunctionCalls.set("call-1", resolver);

      deliver({
        type: MessageType.FUNCTION_RESPONSE,
        callId: "call-1",
        success: true,
        result: { data: "result" },
      });

      expect(resolver.resolve).toHaveBeenCalledWith({ data: "result" });
      expect(resolver.reject).not.toHaveBeenCalled();
      expect(sdk.__functionManager.__pendingFunctionCalls.has("call-1")).toBe(false);
    });

    it("should reject pending call on FUNCTION_RESPONSE error", () => {
      const resolver = {
        resolve: mock(() => {}),
        reject: mock(() => {}),
        timeout: setTimeout(() => {}, 1000),
      };
      sdk.__functionManager.__pendingFunctionCalls.set("call-1", resolver);

      deliver({
        type: MessageType.FUNCTION_RESPONSE,
        callId: "call-1",
        success: false,
        error: "Test error",
      });

      expect(resolver.reject).toHaveBeenCalled();
      expect(resolver.resolve).not.toHaveBeenCalled();
    });
  });

  describe("watch API", () => {
    beforeEach(async () => {
      await initializeSdk({ theme: "light" });
    });

    it("should watch all property changes", () => {
      const handler = mock(() => {});
      sdk.watch(handler);

      deliver({ type: MessageType.PROPS_UPDATE, payload: { theme: "dark" } });

      expect(handler).toHaveBeenCalledTimes(1);
      const changes = handler.mock.calls[0][0] as any;
      expect(changes.theme).toEqual(["dark", "light"]);
    });

    it("should watch specific properties only", () => {
      const handler = mock(() => {});
      sdk.watch(["theme"], handler);

      deliver({ type: MessageType.PROPS_UPDATE, payload: { theme: "dark" } });
      expect(handler).toHaveBeenCalledTimes(1);

      deliver({ type: MessageType.PROPS_UPDATE, payload: { apiUrl: "https://new-api.com" } });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should provide [new, old] tuple across successive changes", () => {
      const handler = mock(() => {});
      sdk.watch(["theme"], handler);

      deliver({ type: MessageType.PROPS_UPDATE, payload: { theme: "dark" } });
      deliver({ type: MessageType.PROPS_UPDATE, payload: { theme: "blue" } });

      expect(handler).toHaveBeenCalledTimes(2);
      expect((handler.mock.calls[0][0] as any).theme).toEqual(["dark", "light"]);
      expect((handler.mock.calls[1][0] as any).theme).toEqual(["blue", "dark"]);
    });

    it("should return unwatch function", () => {
      const handler = mock(() => {});
      const unwatch = sdk.watch(handler);

      unwatch();
      deliver({ type: MessageType.PROPS_UPDATE, payload: { theme: "dark" } });

      expect(handler).not.toHaveBeenCalled();
    });

    it("should support multiple watchers on same property", () => {
      const handler1 = mock(() => {});
      const handler2 = mock(() => {});
      sdk.watch(["theme"], handler1);
      sdk.watch(["theme"], handler2);

      deliver({ type: MessageType.PROPS_UPDATE, payload: { theme: "dark" } });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it("should handle errors in watch handlers gracefully", () => {
      const errorHandler = mock(() => {
        throw new Error("Handler error");
      });
      const normalHandler = mock(() => {});
      sdk.watch(errorHandler);
      sdk.watch(normalHandler);

      expect(() =>
        deliver({ type: MessageType.PROPS_UPDATE, payload: { theme: "dark" } }),
      ).not.toThrow();

      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(normalHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe("cleanup", () => {
    it("should release tracked functions on beforeunload", async () => {
      const { sent } = await initializeSdk();

      sdk.register(
        "refresh",
        mock(() => {}),
      );
      const registerCall = sent.find(
        (item) =>
          item.message.type === MessageType.CUSTOM_EVENT &&
          item.message.payload.name === "register",
      );
      const fnId = registerCall!.message.payload.data.refresh.__fn;

      window.dispatchEvent(new Event("beforeunload"));

      const releaseCall = sent.find(
        (item) => item.message.type === MessageType.FUNCTION_RELEASE_BATCH,
      );
      expect(releaseCall).toBeDefined();
      expect(releaseCall!.message.fnIds).toContain(fnId);
    });

    it("should clear listeners and watchers on cleanup", async () => {
      await initializeSdk();
      sdk.on(
        "evt",
        mock(() => {}),
      );
      sdk.watch(mock(() => {}));

      sdk.cleanup();

      expect((sdk as any)._eventListeners.size).toBe(0);
      expect((sdk as any)._watchHandlers.size).toBe(0);
      expect((sdk as any)._propOldValues.size).toBe(0);
    });

    it("should be safe to call cleanup before initialization", () => {
      expect(() => sdk.cleanup()).not.toThrow();
    });
  });
});
