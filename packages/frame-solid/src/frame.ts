import "@zomme/frame";
import { createEffect, onCleanup, onMount } from "solid-js";

const RESERVED = new Set([
  "name",
  "src",
  "sandbox",
  "base",
  "pathname",
  "class",
  "id",
  "style",
  "ref",
  "children",
]);

const isEventKey = (key: string) => /^on[A-Z]/.test(key);

export interface FrameProps {
  /** Frame identifier — `<z-frame name>`. */
  name: string;
  /** URL loaded inside the iframe — `<z-frame src>`. */
  src: string;
  /** iframe sandbox permissions. Defaults to "allow-scripts allow-same-origin". */
  sandbox?: string;
  /** Base path for the guest router. */
  base?: string;
  /** Initial pathname pushed to the guest. */
  pathname?: string;
  /** Host-side styling of the `<z-frame>` element. */
  class?: string;
  id?: string;
  style?: string;
  /**
   * Any other key is forwarded to the guest:
   * - `on<Event>` functions are wired with `addEventListener("<event>")` on the
   *   element (e.g. `onReady`, `onError`, `onNavigate`, or any custom event the
   *   guest emits via `frameSDK.emit("<event>", …)`).
   * - everything else (data objects AND plain functions *without* the `on`
   *   prefix, e.g. `drawingData`, `save`) is assigned as a DOM **property** and
   *   reaches the guest through `frameSDK.props` (functions become async RPC).
   *
   * So name guest callbacks WITHOUT the `on` prefix (`save`, not `onSave`) — an
   * `on*` function is treated as an event listener, never as an RPC prop.
   */
  [key: string]: unknown;
}

/**
 * Solid host wrapper for the `<z-frame>` custom element (from `@zomme/frame`).
 *
 * Mirrors `@zomme/frame-react`'s `<Frame>`: reactive string attributes,
 * `on<Event>` handlers wired as DOM events, and every other prop assigned as a
 * property so it crosses into the guest via the SDK. Written without JSX so the
 * package builds with a plain `bun build` (no Solid JSX transform required).
 *
 * @example
 * ```tsx
 * <Frame
 *   name="excalidraw"
 *   src="/excalidraw/index.html"
 *   class="size-full"
 *   drawingData={scene()}
 *   save={persistScene}
 *   onSaved={(e) => toast("saved")}
 *   onError={(e) => console.error((e as CustomEvent).detail)}
 * />
 * ```
 */
export function Frame(props: FrameProps): HTMLElement {
  const el = document.createElement("z-frame");
  const attached: [string, EventListener][] = [];

  const setAttr = (name: string, value: unknown) => {
    if (value == null) el.removeAttribute(name);
    else el.setAttribute(name, String(value));
  };

  // Reactive string attributes.
  createEffect(() => setAttr("name", props.name));
  createEffect(() => setAttr("src", props.src));
  createEffect(() => setAttr("sandbox", props.sandbox ?? "allow-scripts allow-same-origin"));
  createEffect(() => setAttr("base", props.base));
  createEffect(() => setAttr("pathname", props.pathname));
  createEffect(() => setAttr("style", props.style));
  createEffect(() => {
    if (props.id != null) el.id = String(props.id);
  });
  createEffect(() => {
    if (typeof props.class === "string") el.className = props.class;
  });

  // `on<Event>` handlers → DOM events. Registered once; the listener reads the
  // current prop at dispatch time, so the handler reference may change freely.
  onMount(() => {
    for (const key of Object.keys(props)) {
      if (!isEventKey(key) || typeof props[key] !== "function") continue;
      const eventName = key.slice(2).toLowerCase();
      const handler: EventListener = (event) => {
        const fn = props[key];
        if (typeof fn === "function") (fn as (e: Event) => void)(event);
      };
      el.addEventListener(eventName, handler);
      attached.push([eventName, handler]);
    }
  });
  onCleanup(() => {
    for (const [eventName, handler] of attached) el.removeEventListener(eventName, handler);
  });

  // Data + non-`on` functions → DOM properties (forwarded to the guest).
  createEffect(() => {
    for (const key of Object.keys(props)) {
      if (RESERVED.has(key) || isEventKey(key)) continue;
      (el as unknown as Record<string, unknown>)[key] = props[key];
    }
  });

  return el;
}
