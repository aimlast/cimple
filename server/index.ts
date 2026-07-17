import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";
import path from "path";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import * as Sentry from "@sentry/node";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { startReminderScheduler } from "./reminders/decision-reminders";

// Error monitoring — activates only when SENTRY_DSN is set (free tier is
// plenty for beta). Without it this is a no-op.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0.1,
  });
  console.log("[sentry] Error monitoring active");
}

// Last-resort safety nets: log (and report) instead of dying silently.
// Uncaught exceptions still exit (state may be corrupt) — Railway restarts
// the container — but now the reason lands in the logs and Sentry first.
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] Unhandled promise rejection:", reason);
  Sentry.captureException(reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal] Uncaught exception:", err);
  Sentry.captureException(err);
  // Give the log/Sentry flush a moment, then exit so Railway restarts clean
  setTimeout(() => process.exit(1), 2000);
});

const app = express();

// Security headers. CSP is disabled because the app serves its own SPA with
// inline Vite chunks; the rest (HSTS, nosniff, frameguard, etc.) applies.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);

// Trust the first proxy (Railway's reverse proxy terminates SSL).
// Without this, express-session sees HTTP and refuses to set Secure cookies,
// which breaks buyer login in production.
app.set("trust proxy", 1);

// ── Marketing site ────────────────────────────────────────────────────
// cimple.ca (apex + www) serves the landing page; the product lives at
// app.cimple.ca. /landing previews the same page on any host.
const LANDING_HOSTS = new Set(["cimple.ca", "www.cimple.ca"]);
const landingFile = path.resolve(process.cwd(), "server", "landing", "index.html");
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  const host = (req.get("host") || "").split(":")[0].toLowerCase();
  if (req.path === "/landing" || (LANDING_HOSTS.has(host) && req.path === "/")) {
    return res.sendFile(landingFile);
  }
  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false }));

// ── Session middleware (broker + buyer auth) ──────────────────────────
// Buyers log in with email + password (`req.session.buyerId`); brokers log
// in with username + password (`req.session.brokerId`). Both live in the
// same httpOnly session cookie.
//
// In production a real SESSION_SECRET is mandatory — the hardcoded fallback
// would make every session cookie forgeable.
if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET environment variable must be set in production");
}
// Sessions persist in Postgres so brokers and buyers stay logged in across
// deploys and restarts (the previous in-memory store wiped every session on
// each redeploy). The store creates its own small pg pool + table.
const PgSession = connectPgSimple(session);
// Explicit pool with an error handler: managed Postgres drops idle
// connections periodically, and an unhandled pool 'error' event kills the
// whole Node process (this was crashing production every few hours).
const sessionPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
});
sessionPool.on("error", (err) => {
  console.warn("[session-store] pg pool error (recovered):", err.message);
});
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-session-secret-change-me",
    resave: false,
    saveUninitialized: false,
    store: new PgSession({
      pool: sessionPool,
      tableName: "user_sessions",
      createTableIfMissing: true,
      pruneSessionInterval: 60 * 60, // prune expired sessions hourly
    }),
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  }),
);

// ── Rate limiting ──────────────────────────────────────────────────────
// Auth endpoints: tight limit against credential stuffing / brute force.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again in a few minutes." },
});
for (const p of [
  "/api/broker-auth/login",
  "/api/broker-auth/request-reset",
  "/api/broker-auth/reset-password",
  "/api/buyer-auth/login",
  "/api/buyer-auth/signup",
  "/api/buyer-auth/request-reset",
  "/api/early-access",
]) {
  app.use(p, authLimiter);
}

// AI-backed endpoints: modest per-IP ceiling against cost abuse. Normal
// interview usage is well under this (one call per conversational turn).
const aiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again shortly." },
});
app.use("/api/interview", aiLimiter);
app.use("/api/deals/:dealId/questions", aiLimiter);
app.use("/api/deals/:dealId/generate-content", aiLimiter);
app.use("/api/deals/:dealId/generate-blind", aiLimiter);
app.use("/api/deals/:dealId/generate-dd", aiLimiter);
app.use("/api/deals/:dealId/generate-layout", aiLimiter);

// Session type augmentation
declare module "express-session" {
  interface SessionData {
    buyerId?: string;
    brokerId?: string;
  }
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    // Report unexpected errors to monitoring; don't re-throw (the old
    // `throw err` after responding could crash the process).
    if (status >= 500) {
      Sentry.captureException(err);
      console.error("[error]", err);
    }
    if (!res.headersSent) {
      res.status(status).json({ message });
    }
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  const host = process.env.HOST || "0.0.0.0";
  server.listen(port, host, () => {
    log(`serving on port ${port}`);
    // Start the buyer-decision reminder scheduler (runs every 6 hours)
    startReminderScheduler();
  });

  // Graceful shutdown: Railway sends SIGTERM when replacing a deployment.
  // Without this handler Node exits non-zero and Railway emails a false
  // "Deploy Crashed" alert on every redeploy.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received — shutting down gracefully`);
    server.close(() => {
      sessionPool.end().finally(() => process.exit(0));
    });
    // Force-exit if in-flight requests hang past Railway's grace period
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
})();
