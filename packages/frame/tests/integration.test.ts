import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Frame } from "../src/frame";
import { FrameSDK } from "../src/sdk";

const SRC = "http://localhost:3000";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real end-to-end handshake between the two halves of the library:
 *
 * 1. The parent's _sendInit() posts INIT through the (mocked) iframe
 *    contentWindow, carrying port2 of a real MessageChannel.
 * 2. The test forwards that INIT to the child window, exactly like the
 *    browser would deliver it inside the iframe.
 * 3. sdk.initialize() adopts the port and answers READY, which the parent
 *    receives over the channel and becomes ready.
 *
 * From then on every message (events, props, RPC) flows over the real
 * MessageChannel — nothing is short-circuited.
 */
describe("integration: Frame <-> FrameSDK", () => {
  let frame: Frame;
  let sdk: FrameSDK;
  let handshakePorts: MessagePort[];

  const handshake = async (setup?: (frame: Frame) => void) => {
    frame = document.createElement("z-frame") as Frame;
    frame.setAttribute("src", SRC);

    // happy-dom probes `on<type>` on dispatchEvent (real browsers never
    // consult arbitrary on* props); the prototype proxy would fabricate a
    // rejecting RPC method for it. Predefine inert own props for the
    // camelCase events these tests listen to.
    (frame as any).onready = undefined;
    (frame as any).onregister = undefined;
    (frame as any).onunregister = undefined;

    setup?.(frame);

    const posted: Array<{ message: any; origin: string; transfer: Transferable[] }> = [];
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
    frame.__origin = SRC;
    frame.__iframe = iframe as any;

    sdk = new FrameSDK();
    const initPromise = sdk.initialize();

    (frame as any)._sendInit();
    const init = posted[0];
    const ports = init.transfer.filter(
      (item: unknown): item is MessagePort => item instanceof MessagePort,
    );
    handshakePorts.push(...ports);

    window.dispatchEvent(
      new MessageEvent("message", { data: init.message, origin: SRC, ports } as any),
    );

    await initPromise; // SDK adopted the port and sent READY
    await tick(); // READY delivery to the parent is a macrotask

    return { iframe, posted };
  };

  beforeEach(() => {
    handshakePorts = [];
  });

  afterEach(() => {
    sdk?.cleanup();
    frame?.disconnectedCallback();
    for (const port of handshakePorts) {
      port.close();
    }
  });

  describe("initialization flow", () => {
    it("should complete the INIT/READY handshake", async () => {
      await handshake();

      expect(sdk.isInitialized).toBe(true);
      expect(frame.isReady).toBe(true);
      expect(sdk.__parentOrigin).toBe(SRC);
    });

    it("should deliver special props and custom attributes to the child", async () => {
      await handshake((el) => {
        el.setAttribute("api-url", "https://api.example.com");
        el.setAttribute("pathname", "/home");
      });

      expect(sdk.props.src).toBe(SRC);
      expect(sdk.props.pathname).toBe("/home");
      expect(sdk.props.sandbox).toBe(frame.sandbox);
      expect(sdk.props["api-url"]).toBe("https://api.example.com");
    });

    it("should deliver allow as empty string by default", async () => {
      await handshake();

      expect(sdk.props.allow).toBe("");
    });

    it("should deliver the configured allow value in the INIT props", async () => {
      await handshake((el) => {
        el.setAttribute("allow", "camera; microphone");
      });

      expect(sdk.props.allow).toBe("camera; microphone");
    });

    it("should make parent function props callable in the child", async () => {
      const onSave = mock((data: { id: number }) => `saved-${data.id}`);
      await handshake((el) => {
        (el as any).onSave = onSave;
      });

      expect(typeof sdk.props.onSave).toBe("function");

      const result = await (sdk.props.onSave as (data: unknown) => Promise<string>)({ id: 42 });

      expect(onSave).toHaveBeenCalledWith({ id: 42 });
      expect(result).toBe("saved-42");
    });
  });

  describe("bidirectional events", () => {
    beforeEach(async () => {
      await handshake();
    });

    it("should emit event from child to parent", async () => {
      const parentHandler = mock(() => {});
      frame.addEventListener("user-action", parentHandler);

      sdk.emit("user-action", { type: "click", id: 123 });
      await tick();

      expect(parentHandler).toHaveBeenCalledTimes(1);
      expect((parentHandler.mock.calls[0][0] as CustomEvent).detail).toEqual({
        type: "click",
        id: 123,
      });
    });

    it("should use the exact event name for addEventListener", async () => {
      const handler1 = mock(() => {});
      const handler2 = mock(() => {});
      frame.addEventListener("state:change", handler1);
      frame.addEventListener("state-change", handler2);

      sdk.emit("state:change", { value: 1 });
      await tick();

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).not.toHaveBeenCalled();
    });

    it("should emit event from parent to child", async () => {
      const childHandler = mock(() => {});
      sdk.on("route-change", childHandler);

      frame.emit("route-change", { path: "/settings" });
      await tick();

      expect(childHandler).toHaveBeenCalledTimes(1);
      expect(childHandler).toHaveBeenCalledWith({ path: "/settings" });
    });

    it("should deserialize functions sent in child event data", async () => {
      const parentHandler = mock(() => {});
      frame.addEventListener("custom-event-test", parentHandler);

      const action = mock(() => "test result");
      sdk.emit("custom-event-test", { action, data: { id: 123 } });
      await tick();

      expect(parentHandler).toHaveBeenCalledTimes(1);
      const detail = (parentHandler.mock.calls[0][0] as CustomEvent).detail as any;

      // The function arrived as a callable proxy, not a serialized token
      expect(typeof detail.action).toBe("function");

      const result = await detail.action();
      expect(action).toHaveBeenCalledTimes(1);
      expect(result).toBe("test result");
    });
  });

  describe("register() and dynamic RPC methods", () => {
    beforeEach(async () => {
      await handshake();
    });

    it("should expose child functions as callable parent methods", async () => {
      const refreshFn = mock(() => "refreshed");
      const exportFn = mock(async (format: string) => `exported-${format}`);

      sdk.register({ refresh: refreshFn, export: exportFn });
      await tick();

      expect(frame._registeredFunctions.has("refresh")).toBe(true);
      expect(frame._registeredFunctions.has("export")).toBe(true);

      const refreshResult = await (frame as any).refresh();
      const exportResult = await (frame as any).export("csv");

      expect(refreshFn).toHaveBeenCalledTimes(1);
      expect(exportFn).toHaveBeenCalledWith("csv");
      expect(refreshResult).toBe("refreshed");
      expect(exportResult).toBe("exported-csv");
    });

    it("should dispatch the register event with callable proxies", async () => {
      const parentHandler = mock(() => {});
      frame.addEventListener("register", parentHandler);

      const ping = mock(() => "pong");
      sdk.register("ping", ping);
      await tick();

      expect(parentHandler).toHaveBeenCalledTimes(1);
      const detail = (parentHandler.mock.calls[0][0] as CustomEvent).detail as any;
      expect(typeof detail.ping).toBe("function");

      const result = await detail.ping();
      expect(ping).toHaveBeenCalledTimes(1);
      expect(result).toBe("pong");
    });

    it("should pass complex data through registered function calls", async () => {
      const saveFn = mock((data: { id: number; name: string; items: string[] }) => ({
        success: true,
        savedId: data.id,
      }));

      sdk.register("save", saveFn);
      await tick();

      const result = await (frame as any).save({
        id: 42,
        name: "Test Item",
        items: ["a", "b", "c"],
      });

      expect(saveFn).toHaveBeenCalledWith({ id: 42, name: "Test Item", items: ["a", "b", "c"] });
      expect(result).toEqual({ success: true, savedId: 42 });
    });

    it("should remove functions when the child unregisters", async () => {
      const unregisterHandler = mock(() => {});
      frame.addEventListener("unregister", unregisterHandler);

      const unregister = sdk.register({
        refresh: mock(() => {}),
        export: mock(() => {}),
      });
      await tick();
      expect(frame._registeredFunctions.has("refresh")).toBe(true);

      unregister();
      await tick();

      expect(unregisterHandler).toHaveBeenCalledTimes(1);
      expect(frame._registeredFunctions.has("refresh")).toBe(false);
      expect(frame._registeredFunctions.has("export")).toBe(false);
      await expect((frame as any).refresh()).rejects.toThrow("not registered");
    });

    it("should handle multiple register calls independently", async () => {
      sdk.register(
        "fn1",
        mock(() => "one"),
      );
      await tick();
      sdk.register(
        "fn2",
        mock(() => "two"),
      );
      await tick();

      expect(await (frame as any).fn1()).toBe("one");
      expect(await (frame as any).fn2()).toBe("two");
    });
  });

  describe("property updates", () => {
    beforeEach(async () => {
      await handshake((el) => {
        el.setAttribute("theme", "light");
      });
    });

    it("should deliver initial attributes and live property updates", async () => {
      expect(sdk.props.theme).toBe("light");

      (frame as any).theme = "dark";
      await tick();

      expect(sdk.props.theme).toBe("dark");
    });

    it("should trigger child watch handlers with [new, old] tuples", async () => {
      const handler = mock(() => {});
      sdk.watch(["theme"], handler);

      (frame as any).theme = "dark";
      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
      expect((handler.mock.calls[0][0] as any).theme).toEqual(["dark", "light"]);
    });

    it("should sync observed attribute changes (pathname) to child props", async () => {
      frame.setAttribute("pathname", "/settings");
      await tick();

      expect(sdk.props.pathname).toBe("/settings");
    });

    it("should deserialize function values in live prop updates", async () => {
      const onUpdate = mock(() => "updated");
      (frame as any).onUpdate = onUpdate;
      await tick();

      expect(typeof sdk.props.onUpdate).toBe("function");
      const result = await (sdk.props.onUpdate as () => Promise<string>)();
      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(result).toBe("updated");
    });
  });

  describe("error handling", () => {
    beforeEach(async () => {
      await handshake();
    });

    it("should propagate child function errors to the parent caller", async () => {
      sdk.register(
        "explode",
        mock(() => {
          throw new Error("Child error");
        }),
      );
      await tick();

      await expect((frame as any).explode()).rejects.toThrow("Child error");
    });

    it("should propagate parent function errors to the child caller", async () => {
      const onFail = mock(() => {
        throw new Error("Parent error");
      });
      (frame as any).onFail = onFail;
      await tick();

      await expect((sdk.props.onFail as () => Promise<unknown>)()).rejects.toThrow("Parent error");
    });

    it("should reject dynamic calls to functions never registered", async () => {
      await expect((frame as any).ghostFunction()).rejects.toThrow(
        "Function 'ghostFunction' not registered",
      );
    });
  });
});
