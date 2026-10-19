import express from "express";

// Builds the Express app without listening, so tests can start it on any port.
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}
