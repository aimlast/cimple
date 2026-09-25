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
import { hashResetToken } from "./reset-token";
import {
  calculateBuyerProfileCompletion,
  toPublicBuyerUser,
  buyerCriteriaSchema,
  cleanBuyerCriteria,
  withFieldSources,
  initialFieldSources,
  BUYER_CRITERIA_FIELDS,
  type BuyerUser,
} from "@shared/schema";

// The buyer's own profile editor. The client sends its whole form; only these
// keys are read, each type-checked. Unknown keys are ignored.
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const tagList = z.array(z.string().trim().min(1).max(120)).max(40).nullable().optional();
const buyerSelfProfileSchema = z.object({
  name: z.string().trim().min(1, "Your name is required").max(160).optional(),
  phone: optText(60),
  company: optText(200),
  title: optText(160),
  linkedinUrl: optText(300),
  buyerType: optText(40),
  background: optText(4000),
  liquidFunds: optText(80),
  hasProofOfFunds: z.boolean().nullable().optional(),
  targetIndustries: tagList,
  targetLocations: tagList,
  buyerCriteria: z.record(z.unknown()).nullable().optional(),
}).strip();

/**
 * Validate the criteria object key by key. A value that's invalid but
 * unchanged from what's stored (older data) is kept as-is so it never blocks
 * a save; an invalid NEW value is rejected with the field's name.
 */
function validateCriteria(next: Record<string, unknown>, stored: Record<string, unknown>): { ok: true; value: Record<string, any> } | { ok: false; error: string } {
  const shape = (buyerCriteriaSchema as any).shape as Record<string, z.ZodTypeAny>;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(next)) {
    const def = shape[k];
    if (!def) continue;                                   // unknown key — dropped
    const r = def.safeParse(v);
    if (r.success) out[k] = r.data;
    else if (JSON.stringify(v) === JSON.stringify(stored[k])) out[k] = v;
    else return { ok: false, error: `“${BUYER_CRITERIA_FIELDS[k]?.label ?? k}” isn't a valid value` };
  }
  return { ok: true, value: cleanBuyerCriteria(out) };
}

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
  // Idempotent: if the email already has an account, return it — without
  // any set-password/reset token pending on it (another brokerage's invite or
  // the buyer's own reset request): a broker flow never sees or reuses it.
  const existing = await storage.getBuyerUserByEmail(opts.email);
  if (existing) {
    return { user: { ...existing, resetToken: null, resetTokenExpiresAt: null }, isNew: false };
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
    resetToken: hashResetToken(resetToken), // plaintext lives only in the email link
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
      if (existing) {
        // Broker-invited account that hasn't set a password yet. Claiming it
        // here would let anyone who knows the email take over a buyer's deal
        // access with zero proof of ownership — the set-password link (or a
        // password-reset email, which proves inbox ownership) is the only way in.
        return res.status(409).json({
          error: "An invitation already exists for this email. Use the link from your broker's email, or request a password reset to receive a fresh link.",
          code: "INVITED_ACCOUNT_EXISTS",
        });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      let user: BuyerUser;
      {
        user = await storage.createBuyerUser({
          email: normalized,
          passwordHash,
          name,
          source: "self_signup",
          fieldSources: initialFieldSources({ name }, "buyer"),
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
    // Clear only the buyer identity — destroying the whole session would also
    // sign out a broker logged in from the same browser (broker logout mirrors this).
    delete req.session.buyerId;
    req.session.save(() => res.json({ success: true }));
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
      const parsed = buyerSelfProfileSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return res.status(400).json({ error: issue?.message && issue.message !== "Required" ? issue.message : `Please check “${issue?.path?.join(".")}”` });
      }
      const updates: any = {};
      for (const [key, value] of Object.entries(parsed.data)) {
        if (value !== undefined) updates[key] = value;
      }

      const current = await storage.getBuyerUser(req.session.buyerId!);
      if (!current) return res.status(404).json({ error: "Account not found" });

      if (updates.buyerCriteria !== undefined) {
        const v = validateCriteria((updates.buyerCriteria as Record<string, unknown>) || {}, (current.buyerCriteria as Record<string, unknown>) || {});
        if (!v.ok) return res.status(400).json({ error: v.error });
        updates.buyerCriteria = v.value;
      }
      for (const k of ["targetIndustries", "targetLocations"]) if (updates[k] === null) updates[k] = [];
      if (updates.hasProofOfFunds === null) delete updates.hasProofOfFunds;

      const merged = { ...current, ...updates };
      updates.profileCompletionPct = calculateBuyerProfileCompletion(merged);

      // Record that the buyer wrote whatever this save actually changed.
      const updated = await storage.updateBuyerUser(req.session.buyerId!, withFieldSources(current, updates, "buyer"));
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
          resetToken: hashResetToken(resetToken),
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
