import express, { Request, Response, NextFunction } from "express";
import path from "path";
import cors from "cors";
import compression from "compression";
import { getModel, resolvedModelTable } from "./models.js";

export const app = express();
const PORT = process.env.PORT || 3001;

// ==============================================================================
// 1. Compression Middleware with SSE Anti-Buffering Filter
// ==============================================================================
// Crucial: Compression buffering will choke Server-Sent Events (SSE) streaming.
// We explicitly bypass compression when the client requests text/event-stream.
app.use(
  compression({
    filter: (req: Request, res: Response) => {
      if (req.headers.accept === "text/event-stream") {
        return false;
      }
      return compression.filter(req, res);
    }
  })
);

app.use(cors());
app.use(express.json());

// ==============================================================================
// 2. Health & Diagnostic Endpoints
// ==============================================================================
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "splice-backend",
    node_env: process.env.NODE_ENV || "development",
    rea_mode: process.env.REA_MODE || "mock",
    model: getModel("decomp_worker"),
    models: resolvedModelTable(),
    timestamp: Date.now()
  });
});

// SSE Streaming Route Skeleton with Anti-Buffering Headers
app.post("/api/extract", (req: Request, res: Response) => {
  // Enforce zero-buffering headers for real-time SSE delivery
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  if (typeof (res as any).flushHeaders === "function") {
    (res as any).flushHeaders();
  }

  const sendEvent = (stage: string, message: string, data?: any) => {
    res.write(`data: ${JSON.stringify({ stage, message, data, timestamp: Date.now() })}\n\n`);
  };

  sendEvent("connected", "REA extraction pipeline initialized.");
  
  // Note: Full extraction and cache replay logic will be wired by Worker 1
  res.write(`data: ${JSON.stringify({ stage: "complete", message: "SSE stream ready" })}\n\n`);
  res.end();
});

// Stubs for Worker 2 routes
app.post("/api/synthesize", (req: Request, res: Response) => {
  res.json({ message: "Synthesize route ready for Worker 2 implementation" });
});

app.post("/api/refine", (req: Request, res: Response) => {
  res.json({ message: "Refine route ready for Worker 2 implementation" });
});

// ==============================================================================
// 3. API 404 Guard
// ==============================================================================
// Catch-all for undefined /api routes: Must return JSON 404 and NEVER fall through
// to the SPA static index.html handler.
app.all("/api/*", (req: Request, res: Response) => {
  res.status(404).json({
    error: `API endpoint not found: ${req.method} ${req.path}`,
    status: 404
  });
});

// ==============================================================================
// 4. Production Static Serving & SPA Fallback
// ==============================================================================
if (process.env.NODE_ENV === "production") {
  // In Docker container: /app/packages/backend/dist -> ../../frontend/dist resolves to /app/packages/frontend/dist
  const frontendDist = path.resolve(__dirname, "../../frontend/dist");

  // Serve static assets (JS, CSS, images, icons)
  app.use(express.static(frontendDist));

  // SPA fallback for client-side routing (Vite React app)
  app.get("*", (req: Request, res: Response, next: NextFunction) => {
    // Defense-in-depth: explicitly ignore /api routes even if somehow reached
    if (req.path.startsWith("/api")) {
      return next();
    }

    res.sendFile(path.join(frontendDist, "index.html"), (err) => {
      if (err) {
        res.status(500).send("Frontend build not found. Verify @splice/frontend build was run.");
      }
    });
  });
}

// ==============================================================================
// 5. Server Initialization
// ==============================================================================
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`[Splice Backend] Server running on port ${PORT} (mode: ${process.env.NODE_ENV || "development"})`);
    console.log(`[Splice Backend] REA Engine Mode: ${process.env.REA_MODE || "mock"}`);
  });
}
