import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Excalidraw checks process.env.IS_PREACT; define it so the bundle doesn't break.
  define: {
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  optimizeDeps: {
    exclude: ["@zomme/frame", "@zomme/frame-react"],
  },
  plugins: [react()],
  server: {
    port: 4204,
    cors: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
