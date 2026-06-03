import { Frame } from "@zomme/frame-solid";
import { createSignal, For } from "solid-js";

interface Scene {
  appState?: Record<string, unknown>;
  elements?: unknown[];
}

/** Load the last persisted scene (host-side persistence; in asciimark this is Tauri writeFile). */
function loadInitialScene(): Scene | undefined {
  try {
    const raw = localStorage.getItem("excalidraw-scene");
    return raw ? (JSON.parse(raw) as Scene) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * PoC host (SolidJS): an Excalidraw editing panel embedded through the z-frame.
 *
 * The guest (`app-excalidraw`) is the real, editable Excalidraw editor running in
 * the iframe; the host loads the initial scene into it (`drawingData`) and persists
 * what it edits (`save`, an RPC). No preview, no edit/preview toggle — just the editor.
 */
export function App() {
  // `initialScene` is read once (constant signal) so saves don't re-push it and loop.
  const [initialScene] = createSignal<Scene | undefined>(loadInitialScene());
  const [log, setLog] = createSignal<string[]>([]);

  const append = (msg: string) =>
    setLog((lines) => [`${new Date().toLocaleTimeString()} — ${msg}`, ...lines].slice(0, 40));

  // Host persistence: the editor calls this (RPC) on every debounced change.
  const save = async (scene: Scene) => {
    try {
      localStorage.setItem("excalidraw-scene", JSON.stringify(scene));
    } catch {
      // ignore quota errors in the PoC
    }
    append(`save() ← guest: ${scene.elements?.length ?? 0} elementos persistidos`);
    return { at: Date.now(), ok: true };
  };

  const onReady = () => append("z-frame 'ready' — editor montado");
  const onSaved = (e: Event) =>
    append(`evento saved: ${JSON.stringify((e as CustomEvent).detail)}`);
  const onDirty = (e: Event) =>
    append(`evento dirty: ${JSON.stringify((e as CustomEvent).detail)}`);
  const onError = (e: Event) => append(`erro: ${JSON.stringify((e as CustomEvent).detail)}`);

  const bar =
    "padding:8px 12px;display:flex;gap:8px;align-items:center;background:#1e293b;color:#fff";

  return (
    <div style="display:flex;flex-direction:column;height:100vh;font-family:system-ui,sans-serif">
      <header style={bar}>
        <strong>shell-solid</strong>
        <span style="opacity:.7">editor: app-excalidraw @ 4204 (caminho B via z-frame)</span>
      </header>

      <div style="display:flex;flex:1;min-height:0">
        <Frame
          name="excalidraw"
          src="http://localhost:4204/"
          style="flex:1;height:100%;border:0"
          drawingData={initialScene()}
          save={save}
          onReady={onReady}
          onSaved={onSaved}
          onDirty={onDirty}
          onError={onError}
        />
        <aside style="width:320px;overflow:auto;padding:8px;border-left:1px solid #ddd;font:12px/1.5 monospace">
          <strong>load/save log</strong>
          <For each={log()}>{(line) => <div>{line}</div>}</For>
        </aside>
      </div>
    </div>
  );
}
