import { MessageEvent } from "./constants";
import { FunctionManager } from "./helpers/function-manager";
import { createLogger } from "./helpers/logger";
import { validateMessage } from "./helpers/message-validators";
import { assertTestEnv } from "./helpers/test-guards";
import type {
  CustomEventMessage,
  FrameProps,
  FunctionCallMessage,
  FunctionReleaseMessage,
  FunctionResponseMessage,
} from "./types";

const logger = createLogger("z-frame");

/**
 * Web Component for embedding micro-frontend frames in iframes
 *
 * Provides secure iframe isolation with bidirectional PostMessage communication.
 * Supports dynamic attributes/properties, registered function calls, and event system.
 *
 * ## Event Naming Convention
 * - Internal events use `namespace:action` format: `frame:ready`, `route:change`
 * - Custom events use `kebab-case` format: `task-created`, `user-updated`
 *
 * ## Registered Functions
 * Child frames can register functions via `frameSDK.register()` that parent can call:
 * - Child: `frameSDK.register('refreshData', () => loadData())`
 * - Parent: `frame.refreshData()` → calls the registered function (returns Promise)
 *
 * @example
 * ```html
 * <z-frame
 *   src="http://localhost:3000"
 *   api-url="https://api.example.com"
 *   theme="dark"
 * ></z-frame>
 * ```
 *
 * @example
 * ```typescript
 * const frame = document.querySelector('z-frame');
 *
 * // Set properties via property binding (auto-detected)
 * frame.theme = 'dark';
 * frame.user = currentUser;
 *
 * // Send event to frame
 * frame.emit('route-change', { path: '/settings' });
 *
 * // Call registered function from child (returns Promise)
 * const stats = await frame.getStats();
 * await frame.refreshData();
 *
 * // Listen to frame events
 * frame.addEventListener('ready', () => console.log('Ready'));
 * frame.addEventListener('navigate', (e) => router.push(e.detail.path));
 * ```
 */
export class Frame extends HTMLElement {
  /**
   * Observed attributes for Web Component lifecycle
   */
  static get observedAttributes() {
    return ["pathname", "sandbox", "src"];
  }

  /**
   * Attribute getters for prop updates
   * Maps attribute names to functions that retrieve their values
   */
  private static readonly ATTR_GETTERS: Record<
    string,
    (instance: Frame, val?: string | null) => unknown
  > = {
    pathname: (instance) => instance.pathname,
    sandbox: (instance) => instance.sandbox,
    src: (_, val) => val,
  };

  /**
   * Attributes that require iframe recreate when changed
   */
  private static readonly RECREATE_ATTRS = new Set(["src", "sandbox"]);

  #iframe!: HTMLIFrameElement;
  #observer?: MutationObserver;
  #ready = false;
  #origin!: string;
  #port!: MessagePort;

  // Function call support
  #manager!: FunctionManager;

  // Cache for dynamically created methods
  _dynamicMethods = new Map<string, Function>();

  // Listener de CHILD_HELLO na window (handshake robusto); guardado p/ cleanup
  #helloHandler?: (event: MessageEvent) => void;

  // Storage for dynamic properties
  _propValues = new Map<string, unknown>();

  // Set of properties that have been defined with getter/setter
  _definedProps = new Set<string>();

  // Functions registered by child frame via frame:register event
  _registeredFunctions = new Map<string, Function>();

  /**
   * Creates a new z-frame element
   *
   * Initializes the function manager for cross-iframe communication.
   */
  constructor() {
    super();

    // Initialize function manager
    this.#manager = new FunctionManager((message, transferables = []) => {
      this._sendToIframe(message, transferables);
    });
  }

  /**
   * Get pathname for initial route
   * Normalizes to always start with / and defaults to /
   */
  get pathname(): string {
    const value = this.getAttribute("pathname");

    // Default to "/" if empty/null
    if (!value || value.trim() === "") {
      return "/";
    }

    // Ensure starts with /
    return value.startsWith("/") ? value : `/${value}`;
  }

  /**
   * Set pathname (syncs to HTML attribute)
   * Allows Angular/React/Vue property binding to work
   */
  set pathname(value: string | null) {
    if (value === null) {
      this.removeAttribute("pathname");
    } else {
      this.setAttribute("pathname", value);
    }
  }

  /**
   * Get sandbox permissions
   *
   * Note: Changing sandbox after initialization will recreate the iframe (reload the frame app)
   */
  get sandbox(): string {
    return (
      this.getAttribute("sandbox") ||
      "allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
    );
  }

  /**
   * Set sandbox permissions (syncs to HTML attribute)
   * Note: Changing sandbox after initialization will recreate the iframe (reload the frame app)
   */
  set sandbox(value: string | null) {
    if (value === null) {
      this.removeAttribute("sandbox");
    } else {
      this.setAttribute("sandbox", value);
    }
  }

  /**
   * Get frame source URL
   *
   * Note: Changing src after initialization will recreate the iframe (reload the frame app)
   */
  get src(): string | null {
    return this.getAttribute("src");
  }

  /**
   * Set frame source URL (syncs to HTML attribute)
   * Note: Changing src after initialization will recreate the iframe (reload the frame app)
   */
  set src(value: string | null) {
    if (value === null) {
      this.removeAttribute("src");
    } else {
      this.setAttribute("src", value);
    }
  }

  /**
   * Check if frame is ready
   * @public
   */
  get isReady(): boolean {
    return this.#ready;
  }

  /**
   * Get frame origin
   * @internal - For testing purposes only
   */
  get __origin(): string {
    assertTestEnv();
    return this.#origin;
  }

  /**
   * Get iframe element
   * @internal - For testing purposes only
   */
  get __iframe(): HTMLIFrameElement {
    assertTestEnv();
    return this.#iframe;
  }

  /**
   * Get ready state
   * @internal - For testing purposes only
   */
  get __ready(): boolean {
    assertTestEnv();
    return this.#ready;
  }

  /**
   * Get function manager (for testing function registry)
   * @internal - For testing purposes only
   */
  get __manager(): FunctionManager {
    assertTestEnv();
    return this.#manager;
  }

  /**
   * Set ready state (for testing)
   * @internal - For testing purposes only
   */
  set __ready(value: boolean) {
    assertTestEnv();
    this.#ready = value;
  }

  /**
   * Set iframe element (for testing)
   * @internal - For testing purposes only
   */
  set __iframe(value: HTMLIFrameElement | null) {
    assertTestEnv();
    this.#iframe = value as HTMLIFrameElement;
  }

  /**
   * Set origin (for testing)
   * @internal - For testing purposes only
   */
  set __origin(value: string) {
    assertTestEnv();
    this.#origin = value;
  }

  /**
   * Web Component lifecycle: called when an observed attribute changes
   */
  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (oldValue === newValue) return;

    // If element is connected and we have src, initialize
    if (this.isConnected && this.src && !this.#iframe) {
      try {
        this.#origin = new URL(this.src).origin;
        this._initialize();
      } catch (error) {
        console.error(`[z-frame] Initialization failed:`, error);
        this._emit("error", {
          message: error instanceof Error ? error.message : "Initialization failed",
          error,
        });
      }
    }

    // If src or sandbox changes after initialization, recreate iframe
    if (this.#iframe && Frame.RECREATE_ATTRS.has(name)) {
      // src: always has oldValue when iframe exists
      // sandbox: may be first-time set (oldValue === null) or normal change
      const shouldRecreate =
        (name === "src" && oldValue !== null && oldValue !== newValue) ||
        (name === "sandbox" &&
          ((oldValue !== null && oldValue !== newValue) ||
            (oldValue === null && newValue !== null)));

      if (shouldRecreate) {
        logger.log(`${name} changed - recreating iframe`);
        this._cleanup();
        this.#origin = new URL(this.src!).origin;
        this._initialize();
        return; // Don't send PROPS_UPDATE, new iframe gets INIT with all props
      }
    }

    // Handle dynamic attribute changes after frame is ready
    // Send PROPS_UPDATE for attributes that should be synced to frameSDK.props
    if (this.#ready) {
      const getter = Frame.ATTR_GETTERS[name];
      const value = getter ? getter(this, newValue) : newValue;
      this._sendPropUpdate({ [name]: value });
    }
  }

  /**
   * Web Component lifecycle: called when element is added to DOM
   *
   * Creates the iframe, sets up message listeners, and initializes
   * communication with the child frame.
   *
   * Note: Initialization is deferred to allow framework property bindings
   * (Angular/React/Vue) to set properties before iframe loads. We use
   * queueMicrotask to defer until after synchronous property assignments
   * and framework change detection, but before the next paint.
   */
  connectedCallback() {
    // Defer initialization using microtask queue
    // This runs after property bindings but before the next frame
    queueMicrotask(() => {
      // If src is set and not yet initialized, do it now
      if (this.src && !this.#iframe) {
        try {
          this.#origin = new URL(this.src).origin;
          this._initialize();
        } catch (error) {
          console.error(`[z-frame] Initialization failed:`, error);
          this._emit("error", {
            message: error instanceof Error ? error.message : "Initialization failed",
            error,
          });
        }
      }
    });
  }

  /**
   * Initialize the frame
   *
   * Orchestrates the full initialization process:
   * 1. Create and setup iframe
   * 2. Wait for iframe to load
   * 3. Collect and serialize props
   * 4. Send INIT message to child
   * 5. Setup attribute observer
   */
  private _initialize(): void {
    this._setupIframe();

    // Handshake robusto: além de enviar INIT quando o iframe dispara 'load'
    // (ótimo p/ children que registram cedo — SPAs client-side), reenviamos INIT
    // sempre que o child anuncia prontidão via CHILD_HELLO. Isso cobre children
    // que registram o listener tarde (SSR/code-split) e perderiam o INIT do 'load'.
    this.#helloHandler = (event: MessageEvent) => {
      if (event.source !== this.#iframe?.contentWindow) return;
      if ((event.data as { type?: string } | null)?.type === MessageEvent.CHILD_HELLO) {
        this._sendInit();
      }
    };
    window.addEventListener("message", this.#helloHandler);

    void this._waitForIframeLoad().then(
      () => this._sendInit(),
      () => undefined, // erro/timeout já logado e emitido em _waitForIframeLoad
    );

    this._setupAttributeObserver();
  }

  /** Cria e anexa o iframe (sem o canal — o canal é criado a cada _sendInit). */
  private _setupIframe(): void {
    this.#iframe = document.createElement("iframe");

    // Normalize URL construction to handle trailing slashes
    const src = this.src!;
    const pathname = this.pathname;

    // Remove trailing slash from src, pathname already starts with /
    const normalizedSrc = src.endsWith("/") ? src.slice(0, -1) : src;
    this.#iframe.src = normalizedSrc + pathname;

    this.#iframe.style.cssText = "border:none;display:block;height:100%;width:100%;";
    this.#iframe.setAttribute("sandbox", this.sandbox);

    this.appendChild(this.#iframe);
  }

  /**
   * Wait for iframe to load with timeout and error handling
   *
   * @throws Error if iframe fails to load or timeout occurs
   */
  private _waitForIframeLoad(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Iframe load timeout after 10s: ${this.src}`));
      }, 10000);

      const handler = (event: Event) => {
        cleanup();
        if (event.type === "error") {
          reject(new Error(`Failed to load iframe: ${this.src}`));
        } else {
          resolve();
        }
      };

      const cleanup = () => {
        clearTimeout(timeoutId);
        this.#iframe.removeEventListener("load", handler);
        this.#iframe.removeEventListener("error", handler);
      };

      this.#iframe.addEventListener("load", handler, { once: true });
      this.#iframe.addEventListener("error", handler, { once: true });
    }).catch((error) => {
      logger.error("Iframe initialization failed:", error);
      this._emit("error", { message: "Iframe load failed", error });
      throw error;
    });
  }

  /**
   * Collect all attributes and properties to send to child
   *
   * Collects HTML attributes (strings) and JavaScript properties (any type including functions).
   * JavaScript properties override HTML attributes with the same name.
   *
   * @returns Props object with all attributes and properties
   */
  private _collectAllProps(): Record<string, unknown> {
    // Start with all special props (use getters for normalization where needed)
    const props: Record<string, unknown> = {
      pathname: this.pathname, // Getter - normalized
      sandbox: this.sandbox, // Getter - has default value
      src: this.src, // Direct - always included for child context
    };

    // Collect custom HTML attributes (skip observed attributes already added above)
    const observedAttrs = Frame.observedAttributes;
    for (let i = 0; i < this.attributes.length; i++) {
      const attr = this.attributes[i];
      if (!observedAttrs.includes(attr.name)) {
        props[attr.name] = attr.value;
      }
    }

    // Collect dynamic properties from _propValues (override HTML attributes if same name)
    for (const [key, value] of this._propValues.entries()) {
      if (value !== undefined) {
        props[key] = value;
      }
    }

    return props;
  }

  /**
   * Send INIT message to child with serialized props
   *
   * @param channel - MessageChannel to transfer port2 to child
   * @param props - Props to serialize and send
   * @throws Error if contentWindow is not accessible
   */
  private _sendInit(): void {
    // Só antes do ready; depois disso o canal adotado já está estabelecido.
    if (this.#ready || !this.#iframe) return;
    const contentWindow = this.#iframe.contentWindow;
    if (!contentWindow) return;

    const props = this._collectAllProps();
    const { serialized, transferables } = this.#manager.serialize(props);

    // Canal novo a cada envio (load + hello). O child processa apenas o 1º INIT
    // que recebe e responde READY naquela porta; adotamos essa porta abaixo. As
    // demais portas ficam ociosas e são coletadas.
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      try {
        if ((event.data as { type?: string } | null)?.type === MessageEvent.READY && !this.#ready) {
          this.#port = channel.port1;
        }
        this._handleMessageFromIframe(event.data);
      } catch (error) {
        logger.error("Error handling message from iframe:", error);
        this._emit("error", { message: "Message handler error", error });
      }
    };

    contentWindow.postMessage(
      {
        payload: serialized as FrameProps,
        type: MessageEvent.INIT,
      },
      this.#origin,
      [channel.port2, ...transferables],
    );
  }

  /**
   * Send prop updates to child iframe
   *
   * Used when attributes change dynamically to keep frameSDK.props in sync
   *
   * @param updates - Object with prop keys and new values
   */
  _sendPropUpdate(updates: Record<string, unknown>): void {
    if (!this.#ready) return;

    const { serialized, transferables } = this.#manager.serialize(updates);

    this._sendToIframe(
      {
        type: MessageEvent.PROPS_UPDATE,
        payload: serialized,
      },
      transferables,
    );
  }

  /**
   * Setup MutationObserver to watch for attribute changes
   *
   * Observes attribute changes and syncs them to the child iframe via PROPS_UPDATE.
   * Skips observedAttributes as they're handled by attributeChangedCallback.
   */
  private _setupAttributeObserver(): void {
    // Convert to Set for O(1) lookup performance
    const observedAttrsSet = new Set(Frame.observedAttributes);

    this.#observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        const attrName = mutation.attributeName;
        // Skip observed attributes (handled by attributeChangedCallback)
        if (attrName && !observedAttrsSet.has(attrName)) {
          const value = this.getAttribute(attrName);
          const { serialized, transferables } = this.#manager.serialize(value);

          this._sendToIframe(
            {
              type: MessageEvent.PROPS_UPDATE,
              payload: { [attrName]: serialized },
            },
            transferables,
          );
        }
      });
    });

    this.#observer.observe(this, { attributes: true });
  }

  private _handleMessageFromIframe(data: unknown) {
    // Use shared validation utility to reduce code duplication
    const message = validateMessage(data, "[z-frame]");
    if (!message) {
      return; // Validation failed, error already logged
    }

    const { type } = message;

    switch (type) {
      case MessageEvent.READY:
        this.#ready = true;
        this._dispatchLocalEvent("ready");
        break;

      case MessageEvent.CUSTOM_EVENT: {
        const customMsg = message as CustomEventMessage;
        const payload = customMsg.payload;
        if (!payload?.name || typeof payload.name !== "string") {
          logger.warn("Invalid CUSTOM_EVENT message:", message);
          return;
        }

        // Deserialize payload data to convert function tokens into callable proxies
        const deserializedData = this.#manager.deserialize(payload.data);

        this._dispatchLocalEvent(payload.name, deserializedData);
        break;
      }

      case MessageEvent.FUNCTION_CALL: {
        const callMsg = message as FunctionCallMessage;
        if (!callMsg.callId || !callMsg.fnId) {
          logger.warn("Invalid FUNCTION_CALL message:", message);
          return;
        }
        this.#manager.handleFunctionCall(callMsg.callId, callMsg.fnId, callMsg.params);
        break;
      }

      case MessageEvent.FUNCTION_RESPONSE: {
        const respMsg = message as FunctionResponseMessage;
        const { callId, success, result, error: errorResult } = respMsg;
        if (!callId || typeof success !== "boolean") {
          logger.warn("Invalid FUNCTION_RESPONSE message:", message);
          return;
        }
        this.#manager.handleFunctionResponse(callId, success, result, errorResult);
        break;
      }

      case MessageEvent.FUNCTION_RELEASE: {
        const releaseMsg = message as FunctionReleaseMessage;
        if (!releaseMsg.fnId) {
          logger.warn("Invalid FUNCTION_RELEASE message:", message);
          return;
        }
        this.#manager.releaseFunction(releaseMsg.fnId);
        break;
      }

      case MessageEvent.FUNCTION_RELEASE_BATCH: {
        const batchMsg = message as { fnIds: string[] };
        if (!Array.isArray(batchMsg.fnIds)) {
          logger.warn("Invalid FUNCTION_RELEASE_BATCH message:", message);
          return;
        }
        for (const fnId of batchMsg.fnIds) {
          this.#manager.releaseFunction(fnId);
        }
        break;
      }

      default:
        console.warn(`[z-frame] Unknown message type: ${type}`);
    }
  }

  /**
   * Send event to child iframe
   *
   * @param eventName - Event name
   * @param data - Event data
   *
   * @example
   * ```typescript
   * frame.emit('route-change', { path: '/settings' });
   *
   * frame.emit('data-refresh', { force: true });
   * ```
   */
  emit(eventName: string, data?: unknown) {
    if (!eventName || !/^[a-zA-Z0-9_:.-]+$/.test(eventName)) {
      logger.error("Invalid event name:", eventName);
      return;
    }

    this._emitToChild(eventName, data);
  }

  /**
   * Internal method to send event to child iframe
   */
  _emitToChild(eventName: string, data?: unknown) {
    if (!this.#port) {
      logger.warn("MessagePort not ready, cannot emit event");
      return;
    }

    const { serialized, transferables } = this.#manager.serialize(data);

    this._sendToIframe(
      {
        name: eventName,
        data: serialized,
        type: MessageEvent.EVENT,
      },
      transferables,
    );
  }

  /**
   * Helper to dispatch custom events on this element
   *
   * Simplifies the boilerplate of creating and dispatching CustomEvent
   *
   * @param name - Event name
   * @param detail - Event detail payload
   * @param options - Optional bubbles/composed overrides (defaults: bubbles=true, composed=true)
   */
  private _emit(
    name: string,
    detail?: unknown,
    options: { bubbles?: boolean; composed?: boolean } = {},
  ) {
    this.dispatchEvent(
      new CustomEvent(name, {
        bubbles: options.bubbles ?? true,
        composed: options.composed ?? true,
        detail,
      }),
    );
  }

  /**
   * Dispatch custom event on parent (from child emissions)
   */
  private _dispatchLocalEvent(name: string, detail?: unknown) {
    if (!name || !/^[a-zA-Z0-9_:.-]+$/.test(name)) {
      logger.warn("Invalid event name:", name);
      return;
    }

    // Intercept frame:register event to store registered functions
    if (name === "register" && detail && typeof detail === "object") {
      for (const [fnName, fn] of Object.entries(detail as Record<string, unknown>)) {
        if (typeof fn === "function") {
          this._registeredFunctions.set(fnName, fn as Function);
        }
      }
    }

    // Intercept frame:unregister event to remove registered functions
    if (name === "unregister" && detail && typeof detail === "object") {
      const { functions } = detail as { functions?: string[] };
      if (Array.isArray(functions)) {
        for (const fnName of functions) {
          this._registeredFunctions.delete(fnName);
        }
      }
    }

    // Dispatch DOM CustomEvent
    this._emit(name, detail);

    // Try property handler (e.g., frame.handleReady)
    const handlerName = name.replace(/[:.-]/g, "");
    if (Object.hasOwn(this, handlerName)) {
      const handler = Reflect.get(this, handlerName);
      if (typeof handler === "function") {
        handler.call(this, detail);
      }
    }
  }

  /**
   * Send message to iframe via MessagePort with optional transferables
   *
   * Handles errors gracefully (e.g., DataCloneError, port closed, transferable already transferred)
   */
  private _sendToIframe(message: unknown, transferables: Transferable[] = []): boolean {
    if (!this.#port) {
      logger.error("MessagePort not ready");
      return false;
    }

    try {
      this.#port.postMessage(message, transferables);
      return true;
    } catch (error) {
      logger.error("Failed to send message:", error);

      this._emit("message-send-failed", {
        error: error instanceof Error ? error.message : String(error),
        message,
        transferablesCount: transferables.length,
      });

      return false;
    }
  }

  /**
   * Internal cleanup method called on disconnect or error
   */
  private _cleanup(): void {
    this.#observer?.disconnect();
    this.#observer = undefined;

    // Release tracked functions
    const functionIds = Array.from(this.#manager?.getTrackedFunctions() || []);
    if (functionIds.length > 0) {
      this._sendToIframe({
        fnIds: functionIds,
        type: MessageEvent.FUNCTION_RELEASE_BATCH,
      });
    }

    // Clean up port and handlers
    if (this.#port) {
      this.#port.onmessage = null;
      this.#port.close();
    }
    if (this.#helloHandler) {
      window.removeEventListener("message", this.#helloHandler);
      this.#helloHandler = undefined;
    }

    // Clean up remaining resources
    this.#manager?.cleanup();
    this._dynamicMethods?.clear();
    this._propValues?.clear();
    this._definedProps?.clear();
    this._registeredFunctions?.clear();
    this.#iframe?.remove();

    // Reset ready state
    this.#ready = false;
  }

  /**
   * Web Component lifecycle: called when element is removed from DOM
   *
   * Cleans up observers, releases tracked functions, closes port, and removes the iframe.
   */
  disconnectedCallback() {
    this._cleanup();
  }
}

/**
 * Setup Proxy on prototype to intercept property access and assignment.
 *
 * GET trap: Creates dynamic methods for camelCase property access
 *   - frame.refreshData() → calls registered function 'refreshData' in child
 *   - Returns Promise.reject if function not registered
 *
 * SET trap: Creates reactive getter/setter for dynamic properties
 *   - frame.myProp = value → syncs to iframe automatically
 */
// Properties that must never be exposed as dynamic RPC methods, because the
// host JS engine probes the element for them and would call the fabricated
// function with the wrong `this` (the prototype, or a foreign receiver),
// throwing "Illegal invocation" inside the `instance.src` error path.
//
// - Promise protocol (`then`/`catch`/`finally`): returning a function for `then`
//   makes the element a "thenable", so the moment it flows through a Promise
//   (`await frame`, `Promise.resolve(frame)`, or a reactive framework resolving
//   it during render) the runtime calls `.then()`.
// - Custom Element reaction callbacks: `customElements.define` reads these off
//   the prototype to register reactions. The class implements some, but the
//   proxy would fabricate a function for the ones it doesn't (notably
//   `adoptedCallback`), so the browser registers and later invokes it.
const RESERVED_DYNAMIC_PROPS = new Set([
  "then",
  "catch",
  "finally",
  "connectedCallback",
  "disconnectedCallback",
  "adoptedCallback",
  "attributeChangedCallback",
  "connectedMoveCallback",
  "formAssociatedCallback",
  "formDisabledCallback",
  "formResetCallback",
  "formStateRestoreCallback",
]);

const setupPrototypeProxy = () => {
  const proto = Frame.prototype;
  const protoOfProto = Object.getPrototypeOf(proto);

  const proxiedProto = new Proxy(protoOfProto, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (value !== undefined) return value;

      // Dynamic method pattern for camelCase function calls
      // frame.refreshData() → calls registered function 'refreshData'
      if (
        typeof prop === "string" &&
        /^[a-z][a-zA-Z0-9]*$/.test(prop) &&
        !RESERVED_DYNAMIC_PROPS.has(prop)
      ) {
        const instance = receiver as Frame;

        // Check if we have a cached method
        if (instance._dynamicMethods?.has(prop)) {
          return instance._dynamicMethods.get(prop);
        }

        // Create method that calls registered function or rejects
        const method = (...args: unknown[]): Promise<unknown> => {
          const fn = instance._registeredFunctions?.get(prop);
          if (fn) {
            // Call the registered function (already async via RPC)
            return Promise.resolve(fn(...args));
          }
          // Function not registered - reject with clear error
          return Promise.reject(
            new Error(`Function '${prop}' not registered by child frame '${instance.src}'`),
          );
        };

        instance._dynamicMethods?.set(prop, method);
        return method;
      }

      return undefined;
    },

    set(target, prop, value, receiver) {
      // Allow symbols and non-string props
      if (typeof prop !== "string") {
        return Reflect.set(target, prop, value, receiver);
      }

      // Allow private properties
      if (prop.startsWith("_")) {
        return Reflect.set(target, prop, value, receiver);
      }

      // Never turn the Promise protocol into a reactive prop — defining an own
      // `then` would re-introduce the thenable trap the getter guards against.
      if (RESERVED_DYNAMIC_PROPS.has(prop)) {
        return Reflect.set(target, prop, value, receiver);
      }

      const instance = receiver as Frame;

      // Observed attributes (src/pathname/sandbox) já têm setter na classe e nem
      // chegam aqui. Props herdadas (className/title/… no Element.prototype) caem
      // neste trap: delega em `target` (o protótipo real), NÃO em `receiver` (o
      // proxy) — senão o [[Set]] reentra este mesmo trap e recursa infinitamente.
      if (
        Frame.observedAttributes.includes(prop) ||
        prop in HTMLElement.prototype ||
        prop in Frame.prototype
      ) {
        return Reflect.set(target, prop, value, receiver);
      }

      // Dynamic property - create reactive getter/setter
      if (!instance._definedProps.has(prop)) {
        instance._definedProps.add(prop);
        Object.defineProperty(receiver, prop, {
          configurable: true,
          enumerable: true,
          get: () => instance._propValues.get(prop),
          set: (v) => {
            instance._propValues.set(prop, v);
            instance._sendPropUpdate({ [prop]: v });
          },
        });
      }

      // Set value and sync to iframe
      instance._propValues.set(prop, value);
      instance._sendPropUpdate({ [prop]: value });

      return true;
    },
  });

  Object.setPrototypeOf(proto, proxiedProto);
};

// Apply prototype proxy BEFORE registering custom element
setupPrototypeProxy();

// Register the custom element
if (!customElements.get("z-frame")) {
  customElements.define("z-frame", Frame);
} else {
  logger.warn("z-frame already registered");
}
