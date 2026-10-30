import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";

const TOKEN_ISSUER = "nwf-inventory-api";
const TOKEN_AUDIENCE = "nwf-inventory-app";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_FAILED_ATTEMPTS = 5;
const ACCOUNT_LOCK_MS = 15 * 60 * 1000;

export function requireAuth(db) {
  const users = db.collection("users");
  const secret = process.env.JWT_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET is missing or too short.");
  }

  return async (req, res, next) => {
    const header = req.headers.authorization;

    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required." });
    }

    let payload;
    try {
      payload = jwt.verify(header.slice(7), secret, {
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE,
        algorithms: ["HS256"]
      });
    } catch {
      return res.status(401).json({ error: "Invalid or expired token." });
    }

    if (
      !payload ||
      typeof payload === "string" ||
      typeof payload.sub !== "string" ||
      !ObjectId.isValid(payload.sub)
    ) {
      return res.status(401).json({ error: "Invalid token." });
    }

    try {
      const user = await users.findOne(
        { _id: new ObjectId(payload.sub), isActive: true },
        { projection: { passwordHash: 0 } }
      );

      if (!user) {
        return res.status(401).json({
          error: "Account is inactive or no longer exists."
        });
      }

      // Old tokens without authVersion remain valid until their original expiry.
      // Resetting a password/PIN increments the DB value and revokes old sessions.
      const tokenVersion = Number.isSafeInteger(payload.authVersion)
        ? payload.authVersion
        : 0;
      const currentVersion = Number.isSafeInteger(user.authVersion)
        ? user.authVersion
        : 0;

      if (tokenVersion !== currentVersion) {
        return res.status(401).json({
          error: "Your session was changed. Please sign in again."
        });
      }

      req.authUser = user;
      return next();
    } catch {
      return res.status(503).json({
        error: "Authentication service is temporarily unavailable."
      });
    }
  };
}

export function createAuthRouter(db) {
  const router = Router();
  const users = db.collection("users");
  const secret = process.env.JWT_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET is missing or too short.");
  }

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: "Too many login attempts. Please try again later."
    }
  });

  router.post("/login", loginLimiter, async (req, res) => {
    const { loginId, password } = req.body ?? {};

    if (
      typeof loginId !== "string" ||
      typeof password !== "string" ||
      loginId.trim().length < 1 ||
      loginId.trim().length > 50 ||
      password.length < 1 ||
      password.length > 200
    ) {
      return res.status(400).json({
        error: "Enter a valid login ID and password."
      });
    }

    try {
      const normalizedId = loginId.trim().toUpperCase();
      const user = await users.findOne({
        loginId: normalizedId,
        isActive: true
      });

      if (!user) {
        // Keep the response uniform for unknown IDs and wrong passwords.
        await bcrypt.compare(password, "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy");
        return res.status(401).json({ error: "Invalid login ID or password." });
      }

      const now = Date.now();
      const lockedUntil = user.lockedUntil ? new Date(user.lockedUntil).getTime() : 0;
      if (Number.isFinite(lockedUntil) && lockedUntil > now) {
        return res.status(429).json({
          error: "This account is temporarily locked after too many incorrect PIN/password attempts. Try again in 15 minutes."
        });
      }

      let failedAttempts = Number.isSafeInteger(user.failedLoginAttempts)
        ? user.failedLoginAttempts
        : 0;
      if (user.lockedUntil && lockedUntil <= now) {
        failedAttempts = 0;
        await users.updateOne(
          { _id: user._id },
          { $set: { failedLoginAttempts: 0 }, $unset: { lockedUntil: "" } }
        );
      }

      const passwordMatches = await bcrypt.compare(password, user.passwordHash);
      if (!passwordMatches) {
        const nextFailures = failedAttempts + 1;
        if (nextFailures >= MAX_FAILED_ATTEMPTS) {
          await users.updateOne(
            { _id: user._id, isActive: true },
            {
              $set: {
                failedLoginAttempts: nextFailures,
                lockedUntil: new Date(now + ACCOUNT_LOCK_MS)
              }
            }
          );
          return res.status(429).json({
            error: "This account is temporarily locked after five incorrect attempts. Try again in 15 minutes."
          });
        }

        await users.updateOne(
          { _id: user._id, isActive: true },
          { $set: { failedLoginAttempts: nextFailures } }
        );
        return res.status(401).json({ error: "Invalid login ID or password." });
      }

      await users.updateOne(
        { _id: user._id },
        { $set: { failedLoginAttempts: 0 }, $unset: { lockedUntil: "" } }
      );

      const authVersion = Number.isSafeInteger(user.authVersion) ? user.authVersion : 0;
      const token = jwt.sign(
        { authVersion },
        secret,
        {
          subject: user._id.toString(),
          expiresIn: SESSION_TTL_SECONDS,
          issuer: TOKEN_ISSUER,
          audience: TOKEN_AUDIENCE,
          algorithm: "HS256"
        }
      );

      return res.status(200).json({
        token,
        tokenType: "Bearer",
        expiresInSeconds: SESSION_TTL_SECONDS,
        user: {
          loginId: user.loginId,
          name: user.name,
          role: user.role
        }
      });
    } catch {
      return res.status(503).json({
        error: "Login service is temporarily unavailable."
      });
    }
  });

  router.get("/me", requireAuth(db), (req, res) => {
    return res.status(200).json({
      user: {
        loginId: req.authUser.loginId,
        name: req.authUser.name,
        role: req.authUser.role
      }
    });
  });

  return router;
}
