import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";

const TOKEN_ISSUER = "nwf-inventory-api";
const TOKEN_AUDIENCE = "nwf-inventory-app";

export function requireAuth(db) {
  const users = db.collection("users");
  const secret = process.env.JWT_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET is missing or too short.");
  }

  return async (req, res, next) => {
    const header = req.headers.authorization;

    if (
      typeof header !== "string" ||
      !header.startsWith("Bearer ")
    ) {
      return res.status(401).json({
        error: "Authentication required."
      });
    }

    let payload;

    try {
      payload = jwt.verify(header.slice(7), secret, {
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE,
        algorithms: ["HS256"]
      });
    } catch {
      return res.status(401).json({
        error: "Invalid or expired token."
      });
    }

    if (
      !payload ||
      typeof payload === "string" ||
      typeof payload.sub !== "string" ||
      !ObjectId.isValid(payload.sub)
    ) {
      return res.status(401).json({
        error: "Invalid token."
      });
    }

    try {
      const user = await users.findOne(
        {
          _id: new ObjectId(payload.sub),
          isActive: true
        },
        {
          projection: { passwordHash: 0 }
        }
      );

      if (!user) {
        return res.status(401).json({
          error: "Account is inactive or no longer exists."
        });
      }

      // Read current role from MongoDB, not from the token.
      req.authUser = user;
      next();
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

      const passwordMatches = user
        ? await bcrypt.compare(password, user.passwordHash)
        : false;

      if (!passwordMatches) {
        return res.status(401).json({
          error: "Invalid login ID or password."
        });
      }

      const token = jwt.sign(
        {},
        secret,
        {
          subject: user._id.toString(),
          expiresIn: "30m",
          issuer: TOKEN_ISSUER,
          audience: TOKEN_AUDIENCE,
          algorithm: "HS256"
        }
      );

      return res.status(200).json({
        token,
        tokenType: "Bearer",
        expiresInSeconds: 1800,
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
