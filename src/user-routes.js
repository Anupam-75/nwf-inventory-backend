import { Router } from "express";
import bcrypt from "bcryptjs";
import { requireAuth } from "./auth.js";

const ALLOWED_ROLES = ["MAIN_ADMIN", "CO_ADMIN", "STAFF"];
const WEAK_PINS = new Set(["0000", "1111", "2222", "3333", "4444", "5555", "6666", "7777", "8888", "9999", "1234", "4321", "0123", "9876"]);

function validText(value, maxLength = 100) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength
  );
}

function validStaffPin(value) {
  return typeof value === "string" && /^\d{4}$/.test(value) && !WEAK_PINS.has(value);
}

function isMainAdmin(req, res) {
  if (req.authUser.role !== "MAIN_ADMIN") {
    res.status(403).json({
      error: "Only the Main Admin can manage accounts."
    });
    return false;
  }

  return true;
}

export function createUserRouter(db) {
  const router = Router();
  const users = db.collection("users");

  // List accounts. Only the Main Admin may view this list.
  router.get("/", requireAuth(db), async (req, res) => {
    if (!isMainAdmin(req, res)) return;

    try {
      const accounts = await users
        .find({})
        .project({
          _id: 0,
          loginId: 1,
          name: 1,
          role: 1,
          isActive: 1,
          createdAt: 1,
          updatedAt: 1
        })
        .sort({ loginId: 1 })
        .toArray();

      return res.status(200).json({ accounts });
    } catch {
      return res.status(500).json({
        error: "Unable to load accounts."
      });
    }
  });

  // Staff and Co-admin accounts use a four-digit numeric PIN as their password.
  // Main Admin credentials are not managed through this endpoint.
  router.post("/", requireAuth(db), async (req, res) => {
    if (!isMainAdmin(req, res)) return;

    const body = req.body ?? {};
    const loginId = validText(body.loginId, 50)
      ? body.loginId.trim().toUpperCase()
      : "";
    const name = validText(body.name, 100)
      ? body.name.trim()
      : "";
    const pin = body.password;
    const role = body.role;

    if (!/^[A-Z0-9_-]{2,50}$/.test(loginId)) {
      return res.status(400).json({
        error: "Login ID must use 2–50 letters, numbers, underscores, or hyphens."
      });
    }

    if (!name) {
      return res.status(400).json({
        error: "A valid name is required."
      });
    }

    if (!validStaffPin(pin)) {
      return res.status(400).json({
        error: "Choose a four-digit PIN. Avoid repeated digits and simple sequences such as 1234."
      });
    }

    if (!["CO_ADMIN", "STAFF"].includes(role)) {
      return res.status(400).json({
        error: "New accounts must have the CO_ADMIN or STAFF role."
      });
    }

    try {
      const passwordHash = await bcrypt.hash(pin, 12);

      await users.insertOne({
        loginId,
        name,
        role,
        passwordHash,
        authVersion: 0,
        failedLoginAttempts: 0,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      return res.status(201).json({
        message: "Account created successfully. Share its four-digit PIN securely.",
        account: { loginId, name, role, isActive: true }
      });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({
          error: "That login ID already exists."
        });
      }

      return res.status(500).json({
        error: "Unable to create the account."
      });
    }
  });

  // Main Admin can reset the four-digit PIN of any active Staff or Co-admin.
  // Incrementing authVersion invalidates every previous session for that account.
  const resetPinHandler = async (req, res) => {
    if (!isMainAdmin(req, res)) return;

    const loginId = typeof req.params.loginId === "string"
      ? req.params.loginId.trim().toUpperCase()
      : "";
    const pin = req.body?.pin;

    if (!/^[A-Z0-9_-]{2,50}$/.test(loginId)) {
      return res.status(400).json({ error: "Invalid login ID." });
    }

    if (!validStaffPin(pin)) {
      return res.status(400).json({
        error: "Choose a four-digit PIN. Avoid repeated digits and simple sequences such as 1234."
      });
    }

    try {
      const passwordHash = await bcrypt.hash(pin, 12);
      const result = await users.updateOne(
        {
          loginId,
          role: { $in: ["CO_ADMIN", "STAFF"] },
          isActive: true
        },
        {
          $set: {
            passwordHash,
            failedLoginAttempts: 0,
            updatedAt: new Date()
          },
          $unset: { lockedUntil: "" },
          $inc: { authVersion: 1 }
        }
      );

      if (result.matchedCount !== 1) {
        return res.status(404).json({
          error: "Active Staff or Co-admin account not found."
        });
      }

      return res.status(200).json({
        message: "Four-digit PIN updated. The account must sign in again on other devices.",
        loginId
      });
    } catch {
      return res.status(500).json({ error: "Unable to reset the account PIN." });
    }
  };

  router.post("/:loginId/pin", requireAuth(db), resetPinHandler);

  // Promote or demote an existing Co-admin or Staff account.
  const updateRoleHandler = async (req, res) => {
    if (!isMainAdmin(req, res)) return;

    const loginId = req.params.loginId.trim().toUpperCase();
    const newRole = req.body?.role;

    if (!ALLOWED_ROLES.includes(newRole)) {
      return res.status(400).json({
        error: "Invalid role."
      });
    }

    if (newRole === "MAIN_ADMIN") {
      return res.status(403).json({
        error: "The Main Admin role cannot be assigned through this endpoint."
      });
    }

    try {
      const result = await users.updateOne(
        {
          loginId,
          role: { $ne: "MAIN_ADMIN" },
          isActive: true
        },
        {
          $set: {
            role: newRole,
            updatedAt: new Date()
          }
        }
      );

      if (result.matchedCount !== 1) {
        return res.status(404).json({
          error: "Active non-Main-Admin account not found."
        });
      }

      return res.status(200).json({
        message: "Account role updated.",
        loginId,
        role: newRole
      });
    } catch {
      return res.status(500).json({
        error: "Unable to update the account role."
      });
    }
  };
  router.patch("/:loginId/role", requireAuth(db), updateRoleHandler);
  router.post("/:loginId/role", requireAuth(db), updateRoleHandler);

  // Deactivate, rather than delete, to preserve historical records.
  const deactivateUserHandler = async (req, res) => {
    if (!isMainAdmin(req, res)) return;

    const loginId = req.params.loginId.trim().toUpperCase();

    if (loginId === req.authUser.loginId) {
      return res.status(403).json({
        error: "You cannot deactivate your own Main Admin account."
      });
    }

    try {
      const result = await users.updateOne(
        {
          loginId,
          role: { $ne: "MAIN_ADMIN" },
          isActive: true
        },
        {
          $set: {
            isActive: false,
            updatedAt: new Date()
          },
          $inc: { authVersion: 1 }
        }
      );

      if (result.matchedCount !== 1) {
        return res.status(404).json({
          error: "Active non-Main-Admin account not found."
        });
      }

      return res.status(200).json({
        message: "Account deactivated.",
        loginId,
        isActive: false
      });
    } catch {
      return res.status(500).json({
        error: "Unable to deactivate the account."
      });
    }
  };
  router.patch("/:loginId/deactivate", requireAuth(db), deactivateUserHandler);
  router.post("/:loginId/deactivate", requireAuth(db), deactivateUserHandler);

  return router;
}
