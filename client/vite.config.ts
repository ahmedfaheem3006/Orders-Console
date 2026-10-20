import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// In development the browser talks only to Vite; /api is forwarded to Express.
// Same origin for the browser means no CORS setup is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 127.0.0.1, not "localhost": the API binds IPv4 loopback only, and "localhost"
      // can resolve to ::1 first on some systems.
      "/api": "http://127.0.0.1:3001",
    },
  },
  test: {
    environment: "jsdom",
  },
});
