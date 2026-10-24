import express, { Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import compression from "compression";
import { step1Router } from "./routes/step1/index.js";
import { step2Router } from "./routes/step2/index.js";
import { step3Router } from "./routes/step3/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
app.use(express.json({ limit: "10mb" })); // specs/blueprints/bundles can be large

// ==============================================================================
// 2. Step routers — one file per engineer, so nobody edits the same file
//    (agents/1_reverse_engineering/06_backend_server_shell.md §4)
// ==============================================================================
app.use(step1Router); // Eng 1 (REA):            /api/health, /api/pantry
app.use(step2Router); // Eng 2 (Requirements):   /api/extract, /api/specs
app.use(step3Router); // Eng 3 (Implementation): /api/implement, /api/blueprints, /api/synthesize, /api/refine

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
// In Docker container: /app/packages/backend/dist -> ../../frontend/dist resolves to /app/packages/frontend/dist
const frontendDist = path.resolve(__dirname, "../../frontend/dist");
const hasFrontendDist = fs.existsSync(path.join(frontendDist, "index.html"));

if (process.env.NODE_ENV === "production" || hasFrontendDist) {

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
