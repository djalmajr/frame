import { frameSDK } from "@zomme/frame/sdk";
import type { PropChanges } from "@zomme/frame/types";
import { createSignal, onCleanup, onMount } from "solid-js";
import { createStore, reconcile } from "solid-js/store";

/**
 * Solid guest primitive — mirror of `@zomme/frame-react`'s `useFrameSDK`.
 *
 * Initializes the SDK, exposes reactive `props` (a Solid store kept in sync with
 * the parent), and proxies `emit`/`on`/`watch`/`register`. Use inside the app
 * that runs *in* the iframe. Safe in standalone mode (no parent): `sdkAvailable`
 * stays `false` and `props` stays empty.
 */
export function createFrameSDK<T extends Record<string, unknown> = Record<string, unknown>>() {
  const [props, setProps] = createStore<T>({ ...(frameSDK.props as unknown as T) });
  const [isReady, setIsReady] = createSignal(false);
  const [sdkAvailable, setSdkAvailable] = createSignal(false);

  let unwatch: (() => void) | undefined;
  const sync = () => setProps(reconcile({ ...(frameSDK.props as unknown as T) }));

  const setup = () => {
    sync();
    unwatch = frameSDK.watch(() => sync());
    setIsReady(true);
    setSdkAvailable(true);
  };

  onMount(() => {
    if (frameSDK.isInitialized) {
      setup();
      return;
    }
    frameSDK
      .initialize()
      .then(setup)
      .catch((error) => {
        console.warn("frameSDK not available, running in standalone mode", error);
        setIsReady(true);
        setSdkAvailable(false);
      });
  });

  onCleanup(() => unwatch?.());

  const emit = (event: string, data?: unknown) => {
    if (sdkAvailable()) frameSDK.emit(event, data);
  };
  const on = (event: string, handler: (data: unknown) => void) => frameSDK.on(event, handler);
  const watch = (handler: (changes: PropChanges<T>) => void) => frameSDK.watch(handler as never);
  const watchProps = <K extends keyof T>(
    names: K[],
    handler: (changes: PropChanges<T, K>) => void,
  ) => frameSDK.watch(names as string[], handler as never);
  const register = frameSDK.register.bind(frameSDK);

  return { props, isReady, sdkAvailable, emit, on, watch, watchProps, register };
}
