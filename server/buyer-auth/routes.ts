/**
 * Buyer Authentication Routes
 *
 * Two pathways to a buyer account:
 *   1. Self-signup — buyer visits the platform, creates an account,
 *      completes profile, gets matched with CIMs.
 *   2. Broker-invited — broker adds buyer to a deal, account is auto-
 *      created, buyer receives a set-password email (Firmex-style).
 *
 * Both pathways converge on the same account. Sessions are stored in
 * express-session (httpOnly cookies). Passwords are hashed with bcrypt.
 */
import type { Express, Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { z } from "zod";
import { storage } from "../storage";
import { sendDirectEmail } from "../notifications/service.js";
import {
  calculateBuyerProfileCompletion,
  toPublicBuyerUser,
  type BuyerUser,
} from "@shared/schema";

const BCRYPT_ROUNDS = 10;
const RESET_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Middleware ──────────────────────────────────────────────────────────

export function requireBuyer(req: Request, res: Response, next: NextFunction) {
  if (!req.session.buyerId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

// ── Helpers ─────────────────────────────────────────────────────────────

function generateResetToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function baseUrl(req: Request): string {
  return process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
}

function setPasswordEmail(name: string, businessName: string | null, setPasswordUrl: string): string {
  return `
    <div style="font-family: Inter, system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #0a0a0a; color: #e5e5e5;">
      <h2 style="color: #14b8a6; margin-bottom: 16px;">You've been invited to Cimple</h2>
      <p>Hello ${name},</p>
      <p>
        ${businessName
          ? `You've been added as a prospective buyer for <strong>${businessName}</strong>.`
          : `A broker has added you to their deal.`}
        To view the confidential information memorandum, please set your password and sign in.
      </p>
      <p style="margin: 32px 0;">
        <a href="${setPasswordUrl}" style="background: #14b8a6; color: #0a0a0a; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Set password & sign in</a>
      </p>
      <p style="color: #888; font-size: 12px;">This link expires in 7 days. If you already have a Cimple account, just log in with your existing password.</p>
      <p style="color: #888; font-size: 12px;">Once signed in, you'll see all deals you've been given access to — plus new opportunities matched to your investment profile.</p>
    </div>
  `;
}

/**
 * Create a buyer account in "invited" state (no password set yet) and
 * send them a set-password email. Used by the broker-side invite flow.
 * Returns the created/existing user — idempotent by email.
 */
export async function inviteBuyerUser(opts: {
  email: string;
  name: string;
  phone?: string | null;
  company?: string | null;
  title?: string | null;
  linkedinUrl?: string | null;
  invitedByBroker?: string | null;
  invitedByDeal?: string | null;
  businessName?: string | null;
  baseUrl: string;
}): Promise<{ user: BuyerUser; isNew: boolean }> {
  // Idempotent: if the email already has an account, return it
  const existing = await storage.getBuyerUserByEmail(opts.email);
  if (existing) {
    return { user: existing, isNew: false };
  }

  const resetToken = generateResetToken();
  const user = await storage.createBuyerUser({
    email: opts.email.toLowerCase().trim(),
    passwordHash: null,
    name: opts.name,
    phone: opts.phone || null,
    company: opts.company || null,
    title: opts.title || null,
    linkedinUrl: opts.linkedinUrl || null,
    buyerCriteria: {},
    targetIndustries: [],
    targetLocations: [],
    buyerType: null,
    background: null,
    liquidFunds: null,
    hasProofOfFunds: false,
    profileCompletionPct: 0,
    emailVerified: false,
    source: "broker_invited",
    invitedByBroker: opts.invitedByBroker || null,
    invitedByDeal: opts.invitedByDeal || null,
    resetToken,
    resetTokenExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
  } as any);

  const url = `${opts.baseUrl}/buyer/set-password/${resetToken}`;
  await sendDirectEmail(
    opts.email,
    opts.businessName
      ? `You've been invited to view ${opts.businessName} on Cimple`
      : "You've been invited to Cimple",
    setPasswordEmail(opts.name, opts.businessName || null, url),
  );

  return { user, isNew: true };
}

// ── Route registration ──────────────────────────────────────────────────

export function registerBuyerAuthRoutes(app: Express) {
  // SIGNUP — self-serve path
  app.post("/api/buyer-auth/signup", async (req, res) => {
    try {
      const schema = z.object({
        email: z.string().email(),
        password: z.string().min(8),
        name: z.string().min(1),
      });
      const { email, password, name } = schema.parse(req.body);
      const normalized = email.toLowerCase().trim();

      const existing = await storage.getBuyerUserByEmail(normalized);
      if (existing && existing.passwordHash) {
        return res.status(409).json({ error: "An account with this email already exists" });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      let user: BuyerUser;
      if (existing) {
        // Was previously broker-invited; complete the account by setting password
        user = (await storage.updateBuyerUser(existing.id, {
          passwordHash,
          name,
          resetToken: null,
          resetTokenExpiresAt: null,
          lastLoginAt: new Date(),
        } as any)) as BuyerUser;
      } else {
        user = await storage.createBuyerUser({
          email: normalized,
          passwordHash,
          name,
          source: "self_signup",
          emailVerified: false,
          profileCompletionPct: calculateBuyerProfileCompletion({ name }),
          buyerCriteria: {},
          targetIndustries: [],
          targetLocations: [],
          hasProofOfFunds: false,
          lastLoginAt: new Date(),
        } as any);
      }

      req.session.buyerId = user.id;
      res.json({ user: toPublicBuyerUser(user) });
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid signup data", details: error.errors });
      }
      console.error("Signup error:", error);
      res.status(500).json({ error: "Failed to sign up" });
    }
  });

  // LOGIN
  app.post("/api/buyer-auth/login", async (req, res) => {
    try {
      const schema = z.object({
        email: z.string().email(),
        password: z.string(),
      });
      const { email, password } = schema.parse(req.body);

      const user = await storage.getBuyerUserByEmail(email.toLowerCase().trim());
      if (!user || !user.passwordHash) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const match = await bcrypt.compare(password, user.passwordHash);
      if (!match) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      await storage.updateBuyerUser(user.id, { lastLoginAt: new Date() } as any);
      req.session.buyerId = user.id;
      res.json({ user: toPublicBuyerUser(user) });
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid login data" });
      }
      console.error("Login error:", error);
      res.status(500).json({ error: "Failed to log in" });
    }
  });

  // LOGOUT
  app.post("/api/buyer-auth/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      res.json({ success: true });
    });
  });

  // CURRENT USER
  app.get("/api/buyer-auth/me", requireBuyer, async (req, res) => {
    try {
      const user = await storage.getBuyerUser(req.session.buyerId!);
      if (!user) {
        req.session.destroy(() => {});
        return res.status(401).json({ error: "Account not found" });
      }
      res.json({ user: toPublicBuyerUser(user) });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to load account" });
    }
  });

  // UPDATE PROFILE
  app.patch("/api/buyer-auth/me", requireBuyer, async (req, res) => {
    try {
      const body = req.body || {};
      const allowed = [
        "name", "phone", "company", "title", "linkedinUrl",
        "buyerCriteria", "targetIndustries", "targetLocations",
        "buyerType", "background", "liquidFunds", "hasProofOfFunds",
      ];
      const updates: any = {};
      for (const key of allowed) {
        if (body[key] !== undefined) updates[key] = body[key];
      }

      const current = await storage.getBuyerUser(req.session.buyerId!);
      if (!current) return res.status(404).json({ error: "Account not found" });

      const merged = { ...current, ...updates };
      updates.profileCompletionPct = calculateBuyerProfileCompletion(merged);

      const updated = await storage.updateBuyerUser(req.session.buyerId!, updates);
      res.json({ user: toPublicBuyerUser(updated!) });
    } catch (error: any) {
      console.error("Update profile error:", error);
      res.status(500).json({ error: "Failed to update profile" });
    }
  });

  // GET SET-PASSWORD TOKEN INFO (preview before form)
  app.get("/api/buyer-auth/set-password/:token", async (req, res) => {
    try {
      const user = await storage.getBuyerUserByResetToken(req.params.token);
      if (!user) return res.status(404).json({ error: "Invalid or expired link" });
      if (user.resetTokenExpiresAt && new Date(user.resetTokenExpiresAt) < new Date()) {
        return res.status(410).json({ error: "This link has expired. Please request a new one." });
      }
      res.json({
        email: user.email,
        name: user.name,
        invitedByDeal: user.invitedByDeal,
      });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to load invitation" });
    }
  });

  // CONSUME SET-PASSWORD TOKEN — initial password for broker-invited accounts
  app.post("/api/buyer-auth/set-password/:token", async (req, res) => {
    try {
      const schema = z.object({ password: z.string().min(8) });
      const { password } = schema.parse(req.body);

      const user = await storage.getBuyerUserByResetToken(req.params.token);
      if (!user) return res.status(404).json({ error: "Invalid or expired link" });
      if (user.resetTokenExpiresAt && new Date(user.resetTokenExpiresAt) < new Date()) {
        return res.status(410).json({ error: "This link has expired" });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const updated = await storage.updateBuyerUser(user.id, {
        passwordHash,
        resetToken: null,
        resetTokenExpiresAt: null,
        emailVerified: true,
        lastLoginAt: new Date(),
      } as any);

      req.session.buyerId = user.id;
      res.json({ user: toPublicBuyerUser(updated!) });
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }
      console.error("Set password error:", error);
      res.status(500).json({ error: "Failed to set password" });
    }
  });

  // REQUEST PASSWORD RESET
  app.post("/api/buyer-auth/request-reset", async (req, res) => {
    try {
      const { email } = z.object({ email: z.string().email() }).parse(req.body);
      const user = await storage.getBuyerUserByEmail(email.toLowerCase().trim());
      // Always return success (don't leak which emails exist)
      if (user) {
        const resetToken = generateResetToken();
        await storage.updateBuyerUser(user.id, {
          resetToken,
          resetTokenExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        } as any);
        const url = `${baseUrl(req)}/buyer/set-password/${resetToken}`;
        await sendDirectEmail(
          user.email,
          "Reset your Cimple password",
          setPasswordEmail(user.name, null, url),
        );
      }
      res.json({ success: true });
    } catch (error: any) {
      res.json({ success: true }); // Don't leak
    }
  });
}
