import { Excalidraw } from "@excalidraw/excalidraw";
import { frameSDK, useFrameSDK } from "@zomme/frame-react";
import { useCallback, useEffect, useRef } from "react";

interface Scene {
  appState?: Record<string, unknown>;
  elements?: readonly unknown[];
}

interface ExcalidrawFrameProps {
  /** Initial scene pushed by the host (loaded once on mount, re-applied if it changes). */
  drawingData?: Scene;
  /** Host persistence callback (RPC). Named without `on` so it crosses as a prop, not an event. */
  save?: (scene: Scene) => Promise<unknown>;
}

/**
 * Guest: a full, editable Excalidraw editor (no preview, no edit/preview toggle)
 * wired to the host through the Frame SDK.
 *
 * - load:  `props.drawingData` → Excalidraw `initialData` (and `updateScene` on change);
 * - save:  debounced `onChange` → `await props.save(scene)` (RPC into the host);
 * - host→editor: `getScene` registered for the host to pull the current scene;
 * - status: `emit("dirty"|"saved"|"error", …)`.
 */
export function App() {
  const { props, emit, sdkAvailable, watchProps } = useFrameSDK<ExcalidrawFrameProps>();
  const apiRef = useRef<any>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastSig = useRef<string>("");

  // Apply a new scene if the host pushes one after mount.
  useEffect(() => {
    return watchProps(["drawingData"], (changes) => {
      const next = changes.drawingData?.[0] as Scene | undefined;
      if (next && apiRef.current) {
        apiRef.current.updateScene({
          appState: (next.appState ?? {}) as any,
          elements: (next.elements ?? []) as any,
        });
      }
    });
  }, [watchProps]);

  // Expose actions the host can call.
  useEffect(() => {
    if (!sdkAvailable) return;
    return frameSDK.register({
      getScene: () => ({
        appState: apiRef.current?.getAppState?.() ?? {},
        elements: apiRef.current?.getSceneElements?.() ?? [],
      }),
    });
  }, [sdkAvailable]);

  const handleChange = useCallback(
    (elements: readonly any[], appState: any) => {
      // Ignore pure view changes (pan/zoom) — only persist element edits.
      const sig = JSON.stringify(elements);
      if (sig === lastSig.current) return;
      lastSig.current = sig;

      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        emit("dirty", { count: elements.length });
        try {
          await props.save?.({
            appState: { viewBackgroundColor: appState?.viewBackgroundColor },
            elements,
          });
          emit("saved", { at: Date.now(), count: elements.length });
        } catch (err) {
          emit("error", { message: (err as Error)?.message ?? String(err) });
        }
      }, 500);
    },
    [emit, props],
  );

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Excalidraw
        excalidrawAPI={(api: any) => {
          apiRef.current = api;
        }}
        initialData={
          props.drawingData
            ? {
                appState: (props.drawingData.appState ?? {}) as any,
                elements: (props.drawingData.elements ?? []) as any,
              }
            : undefined
        }
        onChange={handleChange}
      />
    </div>
  );
}
