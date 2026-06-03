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
 * Load: the host pushes `drawingData`. Excalidraw is heavy, so the push can land
 * BEFORE the editor's `excalidrawAPI` is ready — in that case we stash it and
 * apply it the moment the API arrives (the previous bug: the push was dropped
 * because `apiRef` was still null and `drawingData` never changed again, so the
 * file looked empty on reopen even though it was saved on disk).
 *
 * Save: the guest does NOT own persistence/debounce. On every (coalesced) change
 * it pushes the current scene to the host via `props.save`; the host keeps the
 * latest, debounces the disk write, and flushes on teardown — so a tab switch
 * that unmounts this iframe never drops the latest edit.
 */
export function App() {
  const { props, sdkAvailable } = useFrameSDK<ExcalidrawFrameProps>();
  const apiRef = useRef<any>(null);
  const pendingScene = useRef<Scene | undefined>(props.drawingData);
  const lastAppliedSig = useRef<string>("");
  const sendTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastSig = useRef<string>("");
  const propsRef = useRef(props);
  propsRef.current = props;

  const applyScene = useCallback((scene: Scene | undefined) => {
    const api = apiRef.current;
    if (!api || !scene) return;
    api.updateScene({
      appState: (scene.appState ?? {}) as any,
      elements: (scene.elements ?? []) as any,
    });
  }, []);

  const send = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    void propsRef.current.save?.({
      appState: { viewBackgroundColor: api.getAppState?.()?.viewBackgroundColor },
      elements: api.getSceneElements?.() ?? [],
    });
  }, []);

  // Apply the scene the host pushes. `props` is reactive (useSyncExternalStore),
  // so this fires whenever drawingData arrives — including the initial handshake
  // delivery that `watchProps` (change-only) can miss. Stash it so a push that
  // lands before the editor API is ready is still applied (see applyScene). Sig-
  // gated so an unrelated prop re-render never re-applies and clobbers edits.
  useEffect(() => {
    const dd = props.drawingData;
    const sig = dd ? JSON.stringify(dd.elements ?? []) : "";
    if (!dd || sig === lastAppliedSig.current) return;
    lastAppliedSig.current = sig;
    pendingScene.current = dd;
    applyScene(dd);
  }, [props.drawingData, applyScene]);

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
    (elements: readonly any[]) => {
      // Ignore pure view changes (pan/zoom) — only push on element edits.
      const sig = JSON.stringify(elements);
      if (sig === lastSig.current) return;
      lastSig.current = sig;
      // Coalesce rapid strokes, then push the current scene to the host.
      clearTimeout(sendTimer.current);
      sendTimer.current = setTimeout(send, 80);
    },
    [send],
  );

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Excalidraw
        excalidrawAPI={(api: any) => {
          apiRef.current = api;
          // Apply whatever the host already pushed (or the initial prop) now that
          // the editor API exists.
          applyScene(pendingScene.current ?? propsRef.current.drawingData);
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
