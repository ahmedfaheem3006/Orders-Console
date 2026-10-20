import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// In development the browser talks only to Vite; /api is forwarded to Express.
// Same origin for the browser means no CORS setup is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
  test: {
    environment: "jsdom",
  },
});
