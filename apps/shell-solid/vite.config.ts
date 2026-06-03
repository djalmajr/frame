import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  // Workspace packages are excluded from pre-bundling so edits are picked up immediately.
  optimizeDeps: {
    exclude: ["@zomme/frame", "@zomme/frame-solid"],
  },
  plugins: [solid()],
  server: {
    port: 4003,
    strictPort: true,
    cors: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
