import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  // Excalidraw checks process.env.IS_PREACT; define it so the bundle doesn't break.
  define: {
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  optimizeDeps: {
    exclude: ["@zomme/frame", "@zomme/frame-react"],
  },
  plugins: [
    react(),
    // Excalidraw 0.18 self-hosting: ship its fonts next to the bundle so the
    // editor works offline (main.tsx points EXCALIDRAW_ASSET_PATH at ./fonts).
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/@excalidraw/excalidraw/dist/prod/fonts/*",
          dest: "fonts",
        },
      ],
    }),
  ],
  server: {
    port: 4204,
    cors: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
