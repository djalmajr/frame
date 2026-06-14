import { convertToExcalidrawElements, Excalidraw, getCommonBounds } from "@excalidraw/excalidraw";
// Excalidraw 0.18 no longer auto-injects its stylesheet — import it explicitly.
import "@excalidraw/excalidraw/index.css";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { frameSDK, useFrameSDK } from "@zomme/frame-react";
import { useCallback, useEffect, useRef } from "react";

interface Scene {
  appState?: Record<string, unknown>;
  elements?: readonly unknown[];
  /** Binary blobs backing image elements (Excalidraw's top-level `files` map),
   *  keyed by fileId. Must round-trip or images reopen broken. */
  files?: Record<string, unknown>;
}

/**
 * Where a generated diagram lands relative to what's already on the canvas.
 * MIRRORS the host's `ExcalidrawApplyMode` (apps/desktop/.../excalidraw-frame.tsx)
 * — keep the two string unions in sync.
 */
type ApplyMode = "replace-selection" | "append" | "replace-all";

interface ApplyMermaidInput {
  /** Mermaid source (flowchart/sequence/class/ER — the only editable types). */
  mermaid: string;
  mode: ApplyMode;
}

interface ApplyMermaidResult {
  ok: boolean;
  /** The mode actually used (replace-selection silently degrades to append when
   *  there is no selection, so the host/model learns what really happened). */
  mode: ApplyMode;
  added: number;
  removed: number;
  error?: string;
}

/** Gap (px) left between existing content and an appended diagram. */
const APPEND_GAP = 80;

type AnyElement = { id: string; x: number; y: number; [k: string]: unknown };

/** Translate a fresh element group by (dx, dy). Arrow `points` are relative to
 *  the element's x/y, so moving x/y moves the whole shape — including bound
 *  text and arrow waypoints — keeping the group's internal layout intact. */
function translate(elements: readonly AnyElement[], dx: number, dy: number): AnyElement[] {
  if (dx === 0 && dy === 0) return elements as AnyElement[];
  return elements.map((el) => ({ ...el, x: el.x + dx, y: el.y + dy }));
}

interface Binding {
  elementId: string;
  focus?: number;
  gap?: number;
}

/** Absolute coordinate of an arrow endpoint (start = first point, end = last).
 *  Arrow `points` are relative to the element's x/y. */
function endpoint(arrow: AnyElement, which: "start" | "end"): { x: number; y: number } {
  const pts = (arrow.points as number[][] | undefined) ?? [[0, 0]];
  const p = which === "start" ? pts[0] : pts[pts.length - 1];
  return { x: arrow.x + (p?.[0] ?? 0), y: arrow.y + (p?.[1] ?? 0) };
}

/** Expand a raw Excalidraw selection into the full set of element ids to remove
 *  on a replace-selection. Excalidraw's `selectedElementIds` usually holds only
 *  the container shapes — NOT their bound text labels (which visually belong to
 *  the shape) nor the connectors that live entirely inside the selection. Pull
 *  those in so replacing a block removes the WHOLE block, never leaving an
 *  orphaned label floating over the new content. */
function expandSelection(current: readonly AnyElement[], selectedIds: Record<string, true>): Set<string> {
  const sel = new Set(current.filter((el) => selectedIds[el.id]).map((el) => el.id));
  // Arrows whose BOTH endpoints are selected are internal to the block.
  for (const el of current) {
    if (el.type !== "arrow" || sel.has(el.id)) continue;
    const s = (el.startBinding as Binding | null | undefined)?.elementId;
    const e = (el.endBinding as Binding | null | undefined)?.elementId;
    if (s && e && sel.has(s) && sel.has(e)) sel.add(el.id);
  }
  // Text bound (containerId) to anything now in the set — i.e. shape AND arrow
  // labels — moves/deletes with its owner.
  for (const el of current) {
    if (el.type !== "text" || sel.has(el.id)) continue;
    const cid = el.containerId as string | null | undefined;
    if (typeof cid === "string" && sel.has(cid)) sel.add(el.id);
  }
  return sel;
}

/** Re-stitch boundary arrows after a replace-selection. Arrows in `base` (the
 *  kept elements) that were bound to a now-deleted element have a dangling
 *  endpoint; re-bind each to the nearest shape of the freshly inserted block
 *  (`placed`), so the new block stays wired into the surrounding diagram instead
 *  of leaving floating arrows. Because `placed` is positioned at the old
 *  selection's top-left, "nearest new shape to the old endpoint" reconnects the
 *  flow sensibly. Returns new `base`/`placed` arrays (inputs are not mutated). */
function restitchBoundary(
  base: readonly AnyElement[],
  placed: readonly AnyElement[],
  deletedIds: Set<string>,
): { base: AnyElement[]; placed: AnyElement[] } {
  // Only shapes are bind targets — not labels (text) or other arrows.
  const targets = placed.filter((el) => el.type !== "arrow" && el.type !== "text");
  if (targets.length === 0) return { base: base as AnyElement[], placed: placed as AnyElement[] };

  // Clone placed so we can append to `boundElements` without mutating inputs.
  const placedClones = placed.map((el) => ({
    ...el,
    boundElements: Array.isArray(el.boundElements) ? [...(el.boundElements as unknown[])] : [],
  }));
  const cloneById = new Map(placedClones.map((el) => [el.id, el]));
  const center = (el: AnyElement) => ({
    x: el.x + ((el.width as number) ?? 0) / 2,
    y: el.y + ((el.height as number) ?? 0) / 2,
  });
  const nearest = (x: number, y: number): AnyElement | null => {
    let best: AnyElement | null = null;
    let bestD = Infinity;
    for (const t of targets) {
      const c = center(t);
      const d = (c.x - x) ** 2 + (c.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = cloneById.get(t.id) ?? null;
      }
    }
    return best;
  };

  const newBase = base.map((el) => {
    if (el.type !== "arrow") return el;
    const sb = el.startBinding as Binding | null | undefined;
    const eb = el.endBinding as Binding | null | undefined;
    const reSb = sb && deletedIds.has(sb.elementId);
    const reEb = eb && deletedIds.has(eb.elementId);
    if (!reSb && !reEb) return el;
    const next: AnyElement = { ...el };
    if (reSb) {
      const ep = endpoint(el, "start");
      const tgt = nearest(ep.x, ep.y);
      if (tgt) {
        next.startBinding = { ...sb, elementId: tgt.id, focus: 0 };
        (tgt.boundElements as unknown[]).push({ id: el.id, type: "arrow" });
      }
    }
    if (reEb) {
      const ep = endpoint(el, "end");
      const tgt = nearest(ep.x, ep.y);
      if (tgt) {
        next.endBinding = { ...eb, elementId: tgt.id, focus: 0 };
        (tgt.boundElements as unknown[]).push({ id: el.id, type: "arrow" });
      }
    }
    return next;
  });

  return { base: newBase, placed: placedClones };
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
    // Register image blobs before the scene references them, or the image
    // elements render broken (e.g. a pasted image, or a Mermaid image fallback).
    if (scene.files && Object.keys(scene.files).length > 0) {
      api.addFiles?.(Object.values(scene.files) as any);
    }
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
      // Persist image blobs alongside elements so images survive a reopen.
      files: api.getFiles?.() ?? {},
    });
  }, []);

  // Host-callable RPC: render a Mermaid diagram into THIS canvas. Conversion has
  // to happen here, in the iframe — `parseMermaidToExcalidraw` drives mermaid's
  // real renderer, which needs a DOM (the host's logic layer / Rust can't).
  //
  // `regenerateIds: true` gives every generated element a fresh random id (and
  // rewrites bindings to match), so appending the SAME diagram twice can't
  // collide with existing ids and silently merge instead of adding.
  const applyMermaid = useCallback(
    async ({ mermaid, mode }: ApplyMermaidInput): Promise<ApplyMermaidResult> => {
      const api = apiRef.current;
      if (!api) return { ok: false, mode, added: 0, removed: 0, error: "Editor not ready" };

      let fresh: AnyElement[];
      // `files` is populated when Mermaid falls back to an image (unsupported
      // types like pie/gantt come in as one image element + its blob); we must
      // register the blob or the image renders broken.
      let files: Record<string, unknown> | undefined;
      try {
        const result = await parseMermaidToExcalidraw(mermaid);
        files = result.files as Record<string, unknown> | undefined;
        fresh = convertToExcalidrawElements(result.elements, {
          regenerateIds: true,
        }) as AnyElement[];
      } catch (err) {
        return {
          ok: false,
          mode,
          added: 0,
          removed: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      if (fresh.length === 0) {
        return { ok: false, mode, added: 0, removed: 0, error: "Mermaid produced no shapes" };
      }

      const current = (api.getSceneElements?.() ?? []) as AnyElement[];
      const selectedIds: Record<string, true> =
        (api.getAppState?.()?.selectedElementIds as Record<string, true>) ?? {};

      let effectiveMode = mode;
      let placed: AnyElement[];
      let base: AnyElement[];
      let removed = 0;

      if (mode === "replace-all") {
        placed = fresh;
        base = [];
        removed = current.length;
      } else if (mode === "replace-selection" && current.some((el) => selectedIds[el.id])) {
        // Remove the WHOLE selected block — shapes + their bound labels + any
        // connectors internal to it — not just the raw selectedElementIds.
        const removeSet = expandSelection(current, selectedIds);
        const selected = current.filter((el) => removeSet.has(el.id));
        const [sMinX, sMinY] = getCommonBounds(selected as never);
        const [nMinX, nMinY] = getCommonBounds(fresh as never);
        placed = translate(fresh, sMinX - nMinX, sMinY - nMinY);
        base = current.filter((el) => !removeSet.has(el.id));
        removed = selected.length;
        // Re-wire arrows that connected the rest of the diagram to the replaced
        // block: rebind their dangling endpoints to the nearest shape of the new
        // block, so the expanded block stays stitched into the surrounding flow
        // instead of leaving floating arrows.
        const stitched = restitchBoundary(base, placed, removeSet);
        base = stitched.base;
        placed = stitched.placed;
      } else {
        // append (and replace-selection with nothing selected → degrade to append).
        effectiveMode = "append";
        if (current.length === 0) {
          placed = fresh;
        } else {
          const [cMinX, , , cMaxY] = getCommonBounds(current as never);
          const [nMinX, nMinY] = getCommonBounds(fresh as never);
          placed = translate(fresh, cMinX - nMinX, cMaxY + APPEND_GAP - nMinY);
        }
        base = current;
      }

      const nextElements = [...base, ...placed];
      const selection: Record<string, true> = {};
      for (const el of placed) selection[el.id] = true;

      // Register image blobs (Mermaid fallback) before the scene references them.
      if (files && Object.keys(files).length > 0) {
        api.addFiles?.(Object.values(files) as never);
      }
      api.updateScene({
        elements: nextElements as never,
        appState: { selectedElementIds: selection } as never,
      });
      // Bring the new diagram into view without yanking the whole canvas around.
      api.scrollToContent?.(placed as never, { fitToContent: true, animate: true });
      // Persist immediately (don't wait on the coalesced onChange) so a quick
      // tab switch right after generating can't drop it.
      send();

      return { ok: true, mode: effectiveMode, added: placed.length, removed };
    },
    [send],
  );

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
      applyMermaid,
    });
  }, [sdkAvailable, applyMermaid]);

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
                files: (props.drawingData.files ?? {}) as any,
              }
            : undefined
        }
        onChange={handleChange}
      />
    </div>
  );
}
