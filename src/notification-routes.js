import { Router } from "express";
import { ObjectId } from "mongodb";
import { requireAuth } from "./auth.js";

export function createNotificationsRouter(db) {
  const router = Router();
  const notifications = db.collection("notifications");
  const devices = db.collection("notification_devices");

  router.get("/unread-count", requireAuth(db), async (req, res) => {
    try {
      const count = await notifications.countDocuments({
        recipientLoginId: req.authUser.loginId,
        readAt: null
      });
      return res.status(200).json({ unreadCount: count });
    } catch {
      return res.status(500).json({ error: "Unable to load unread notification count." });
    }
  });

  router.get("/", requireAuth(db), async (req, res) => {
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 100)) : 50;
    const filter = { recipientLoginId: req.authUser.loginId };
    if (req.query.unreadOnly === "true") filter.readAt = null;

    try {
      const [items, unreadCount] = await Promise.all([
        notifications.find(filter)
          .sort({ createdAt: -1 })
          .limit(limit)
          .toArray(),
        notifications.countDocuments({ recipientLoginId: req.authUser.loginId, readAt: null })
      ]);

      return res.status(200).json({
        unreadCount,
        notifications: items.map(item => ({
          id: item._id.toString(),
          type: item.type,
          title: item.title,
          body: item.body,
          product_id: item.product_id ?? null,
          approval_request_id: item.approval_request_id ?? null,
          data: item.data ?? {},
          readAt: item.readAt ?? null,
          createdAt: item.createdAt
        }))
      });
    } catch {
      return res.status(500).json({ error: "Unable to load notifications." });
    }
  });

  router.post("/devices", requireAuth(db), async (req, res) => {
    const token = req.body?.token;
    if (typeof token !== "string" || token.trim().length < 20 || token.trim().length > 4096) {
      return res.status(400).json({ error: "A valid Firebase device token is required." });
    }

    try {
      const normalizedToken = token.trim();
      await devices.updateOne(
        { token: normalizedToken },
        {
          $set: {
            token: normalizedToken,
            loginId: req.authUser.loginId,
            role: req.authUser.role,
            active: true,
            updatedAt: new Date()
          },
          $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
      );
      return res.status(200).json({ registered: true });
    } catch {
      return res.status(500).json({ error: "Unable to register this device for push notifications." });
    }
  });

  router.patch("/:notificationId/read", requireAuth(db), async (req, res) => {
    if (!ObjectId.isValid(req.params.notificationId)) {
      return res.status(400).json({ error: "Invalid notification ID." });
    }

    try {
      const result = await notifications.updateOne(
        {
          _id: new ObjectId(req.params.notificationId),
          recipientLoginId: req.authUser.loginId,
          readAt: null
        },
        { $set: { readAt: new Date() } }
      );
      if (result.matchedCount === 0) {
        const exists = await notifications.findOne({
          _id: new ObjectId(req.params.notificationId),
          recipientLoginId: req.authUser.loginId
        }, { projection: { _id: 1 } });
        if (!exists) return res.status(404).json({ error: "Notification not found." });
      }
      return res.status(200).json({ markedRead: true });
    } catch {
      return res.status(500).json({ error: "Unable to mark notification as read." });
    }
  });

  router.post("/read-all", requireAuth(db), async (req, res) => {
    try {
      const result = await notifications.updateMany(
        { recipientLoginId: req.authUser.loginId, readAt: null },
        { $set: { readAt: new Date() } }
      );
      return res.status(200).json({ markedRead: result.modifiedCount });
    } catch {
      return res.status(500).json({ error: "Unable to mark notifications as read." });
    }
  });

  return router;
}
