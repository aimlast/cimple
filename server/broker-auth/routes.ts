/**
 * Broker Authentication
 *
 * Session-based login for brokers (username + password against the `users`
 * table), mirroring the buyer auth system. Sets `req.session.brokerId`.
 *
 * Until this existed there was NO broker authentication at all — every
 * broker endpoint was open to the internet and all data was effectively
 * global. `requireBroker` + `getOwnedDeal` are the enforcement primitives
 * the rest of routes.ts uses to scope data per brokerage.
 *
 * Legacy note: pre-auth user rows stored plaintext passwords. On the first
 * successful login the stored password is transparently upgraded to a
 * bcrypt hash.
 */
import type { Express, Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { z } from "zod";
import { eq, and, gt, sql } from "drizzle-orm";
import { db } from "../db";
import { users, type Deal, type User } from "@shared/schema";
import { storage } from "../storage";
import { sendDirectEmail } from "../notifications/service.js";

const BCRYPT_ROUNDS = 10;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Middleware ──────────────────────────────────────────────────────────

export function requireBroker(req: Request, res: Response, next: NextFunction) {
  if (!req.session.brokerId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

/**
 * Loads a deal only if it belongs to the given broker. Returns null both for
 * missing deals and for deals owned by another brokerage, so callers respond
 * 404 either way and never leak which deal ids exist.
 */
export async function getOwnedDeal(
  dealId: string,
  brokerId: string | undefined,
): Promise<Deal | null> {
  if (!brokerId) return null;
  const deal = await storage.getDeal(dealId);
  if (!deal || deal.brokerId !== brokerId) return null;
  return deal;
}

/**
 * True when the request carries a seller invite token (X-Seller-Token header
 * or ?token= query) that maps to this deal. This is how a logged-out seller
 * proves they're allowed to act on their own deal.
 */
export async function sellerTokenMatchesDeal(
  req: Request,
  dealId: string,
): Promise<boolean> {
  const token =
    (req.headers["x-seller-token"] as string | undefined) ||
    (typeof req.query.token === "string" ? req.query.token : undefined);
  if (!token) return false;
  const invite = await storage.getSellerInviteByToken(token);
  return !!invite && invite.dealId === dealId;
}

/**
 * Dual-auth gate for endpoints shared by brokers and sellers (the interview,
 * document upload, the seller's document checklist). Access is granted when
 * either the broker session owns the deal OR a seller token maps to it.
 * Previously these endpoints trusted the raw dealId in the URL with no check —
 * anyone who knew or guessed a deal id could read or drive its interview.
 */
export async function canAccessDeal(
  req: Request,
  dealId: string,
): Promise<boolean> {
  if (req.session.brokerId) {
    const owned = await getOwnedDeal(dealId, req.session.brokerId);
    if (owned) return true;
  }
  return sellerTokenMatchesDeal(req, dealId);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function toPublicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}

async function verifyPassword(user: User, password: string): Promise<boolean> {
  const stored = user.password;
  if (stored.startsWith("$2")) {
    return bcrypt.compare(password, stored);
  }
  // Legacy plaintext row — constant-time-ish compare, then upgrade to a hash
  if (stored === password) {
    try {
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      await db.update(users).set({ password: passwordHash }).where(eq(users.id, user.id));
      console.log(`[broker-auth] Upgraded plaintext password to bcrypt for user ${user.username}`);
    } catch (err) {
      console.error("[broker-auth] Password hash upgrade failed (login still allowed):", err);
    }
    return true;
  }
  return false;
}

// ── Routes ──────────────────────────────────────────────────────────────

export function registerBrokerAuthRoutes(app: Express) {
  app.post("/api/broker-auth/login", async (req, res) => {
    try {
      const schema = z.object({
        username: z.string().min(1),
        password: z.string().min(1),
      });
      const { username, password } = schema.parse(req.body);

      const user = await storage.getUserByUsername(username.trim());
      if (!user || user.role !== "broker") {
        return res.status(401).json({ error: "Invalid username or password" });
      }

      const ok = await verifyPassword(user, password);
      if (!ok) {
        return res.status(401).json({ error: "Invalid username or password" });
      }

      req.session.brokerId = user.id;
      res.json({ user: toPublicUser(user) });
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid login data" });
      }
      console.error("[broker-auth] Login error:", error);
      res.status(500).json({ error: "Failed to log in" });
    }
  });

  // Clears only the broker identity — a buyer logged in from the same
  // browser (common while demoing with the role switcher) stays logged in.
  app.post("/api/broker-auth/logout", (req, res) => {
    req.session.brokerId = undefined;
    req.session.save(() => res.json({ success: true }));
  });

  app.get("/api/broker-auth/me", requireBroker, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.brokerId!);
      if (!user) {
        req.session.brokerId = undefined;
        return res.status(401).json({ error: "Not authenticated" });
      }
      res.json({ user: toPublicUser(user) });
    } catch (error: any) {
      console.error("[broker-auth] Me error:", error);
      res.status(500).json({ error: "Failed to load user" });
    }
  });

  // Broker workspace preferences (firm info, notification prefs, deal
  // defaults). Stored as jsonb on the user row; the Settings page owns the
  // shape. Patches shallow-merge so each tab can save independently.
  app.get("/api/broker-auth/settings", requireBroker, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.brokerId!);
      res.json({ settings: (user as User | undefined)?.settings ?? {} });
    } catch (error: any) {
      console.error("[broker-auth] Settings load error:", error);
      res.status(500).json({ error: "Failed to load settings" });
    }
  });

  app.patch("/api/broker-auth/settings", requireBroker, async (req, res) => {
    try {
      const patch = req.body;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return res.status(400).json({ error: "Settings must be an object" });
      }
      const user = await storage.getUser(req.session.brokerId!);
      const current = ((user as User | undefined)?.settings ?? {}) as Record<string, unknown>;
      const merged = { ...current, ...patch };
      await db.update(users).set({ settings: merged }).where(eq(users.id, req.session.brokerId!));
      res.json({ settings: merged });
    } catch (error: any) {
      console.error("[broker-auth] Settings save error:", error);
      res.status(500).json({ error: "Failed to save settings" });
    }
  });

  // ── Password management ─────────────────────────────────────────────

  app.post("/api/broker-auth/change-password", requireBroker, async (req, res) => {
    try {
      const schema = z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(8, "New password must be at least 8 characters"),
      });
      const { currentPassword, newPassword } = schema.parse(req.body);

      const user = await storage.getUser(req.session.brokerId!);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const ok = await verifyPassword(user, currentPassword);
      if (!ok) return res.status(401).json({ error: "Current password is incorrect" });

      const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      await db.update(users).set({ password: passwordHash }).where(eq(users.id, user.id));
      res.json({ success: true });
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: error.errors?.[0]?.message || "Invalid password data" });
      }
      console.error("[broker-auth] Change password error:", error);
      res.status(500).json({ error: "Failed to change password" });
    }
  });

  // Forgot password: always responds 200 (no account enumeration). When the
  // account exists and has an email, a one-hour reset link is sent.
  app.post("/api/broker-auth/request-reset", async (req, res) => {
    try {
      const schema = z.object({ username: z.string().min(1) });
      const { username } = schema.parse(req.body);

      const user = await storage.getUserByUsername(username.trim());
      if (user && user.role === "broker" && user.email) {
        const token = crypto.randomBytes(32).toString("hex");
        await db
          .update(users)
          .set({ resetToken: token, resetTokenExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) })
          .where(eq(users.id, user.id));

        const baseUrl = process.env.APP_URL || "https://cimple-production.up.railway.app";
        await sendDirectEmail(
          user.email,
          "Reset your Cimple password",
          `<p>Hi${user.name ? ` ${user.name}` : ""},</p>
           <p>A password reset was requested for your Cimple broker account. This link is valid for one hour:</p>
           <p><a href="${baseUrl}/broker/reset-password/${token}">Reset your password</a></p>
           <p>If you didn't request this, you can safely ignore this email.</p>`,
        );
      } else if (user && user.role === "broker" && !user.email) {
        console.warn(`[broker-auth] Reset requested for ${username} but the account has no email on file`);
      }

      res.json({ success: true, message: "If that account exists, a reset link is on its way." });
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Username is required" });
      }
      console.error("[broker-auth] Request reset error:", error);
      res.status(500).json({ error: "Failed to request reset" });
    }
  });

  app.post("/api/broker-auth/reset-password", async (req, res) => {
    try {
      const schema = z.object({
        token: z.string().min(10),
        newPassword: z.string().min(8, "Password must be at least 8 characters"),
      });
      const { token, newPassword } = schema.parse(req.body);

      const rows = await db
        .select()
        .from(users)
        .where(and(eq(users.resetToken, token), gt(users.resetTokenExpiresAt, sql`NOW()`)));
      const user = rows[0];
      if (!user) {
        return res.status(400).json({ error: "This reset link is invalid or has expired. Request a new one." });
      }

      const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      await db
        .update(users)
        .set({ password: passwordHash, resetToken: null, resetTokenExpiresAt: null })
        .where(eq(users.id, user.id));

      // Log them in right away
      req.session.brokerId = user.id;
      res.json({ success: true, user: toPublicUser(user) });
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: error.errors?.[0]?.message || "Invalid reset data" });
      }
      console.error("[broker-auth] Reset password error:", error);
      res.status(500).json({ error: "Failed to reset password" });
    }
  });
}
