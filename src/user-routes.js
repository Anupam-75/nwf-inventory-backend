import { Router } from "express";
import bcrypt from "bcryptjs";
import { requireAuth } from "./auth.js";

const ALLOWED_ROLES = ["MAIN_ADMIN", "CO_ADMIN", "STAFF"];

function validText(value, maxLength = 100) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength
  );
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

  // Create a Co-admin or Staff account.
  // A new Main Admin cannot be created through this endpoint.
  router.post("/", requireAuth(db), async (req, res) => {
    if (!isMainAdmin(req, res)) return;

    const body = req.body ?? {};
    const loginId = validText(body.loginId, 50)
      ? body.loginId.trim().toUpperCase()
      : "";
    const name = validText(body.name, 100)
      ? body.name.trim()
      : "";
    const password = body.password;
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

    if (
      typeof password !== "string" ||
      password.length < 12 ||
      password.length > 200
    ) {
      return res.status(400).json({
        error: "Password must be between 12 and 200 characters."
      });
    }

    if (!["CO_ADMIN", "STAFF"].includes(role)) {
      return res.status(400).json({
        error: "New accounts must have the CO_ADMIN or STAFF role."
      });
    }

    try {
      const passwordHash = await bcrypt.hash(password, 12);

      await users.insertOne({
        loginId,
        name,
        role,
        passwordHash,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      return res.status(201).json({
        message: "Account created successfully.",
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

      // Main Admin status cannot be changed or reassigned here.
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
  // POST is used by Android HttpURLConnection; PATCH remains available to other clients.
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
            }
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
  // POST is used by Android HttpURLConnection; PATCH remains available to other clients.
  router.patch("/:loginId/deactivate", requireAuth(db), deactivateUserHandler);
  router.post("/:loginId/deactivate", requireAuth(db), deactivateUserHandler);

  return router;
}
