import { ObjectId } from "mongodb";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

const NOTIFICATION_COLLECTION = "notifications";
const DEVICE_COLLECTION = "notification_devices";
let firebaseInitAttempted = false;
let firebaseMessaging = null;

function getFirebaseMessaging() {
  if (firebaseInitAttempted) return firebaseMessaging;
  firebaseInitAttempted = true;

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    // In-app notifications continue working when push credentials have not been configured.
    return null;
  }

  try {
    const existing = getApps().find(app => app.name === "nwf-inventory-push");
    const app = existing ?? initializeApp(
      { credential: cert(JSON.parse(serviceAccountJson)) },
      "nwf-inventory-push"
    );
    firebaseMessaging = getMessaging(app);
    return firebaseMessaging;
  } catch (error) {
    console.error("Firebase push is not configured correctly:", error?.message ?? "initialization failed");
    return null;
  }
}

function cleanData(data = {}) {
  const output = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null) {
      output[key] = typeof value === "string" ? value : String(value);
    }
  }
  return output;
}

async function pushToRecipient(db, loginId, notification) {
  const messaging = getFirebaseMessaging();
  if (!messaging) return;

  const devices = await db.collection(DEVICE_COLLECTION)
    .find({ loginId, active: true })
    .project({ token: 1 })
    .toArray();

  if (devices.length === 0) return;

  const data = cleanData({
    notificationId: notification._id.toString(),
    type: notification.type,
    product_id: notification.product_id,
    approval_request_id: notification.approval_request_id,
    ...notification.data
  });

  await Promise.allSettled(devices.map(async device => {
    try {
      await messaging.send({
        token: device.token,
        notification: {
          title: notification.title,
          body: notification.body
        },
        data,
        android: {
          priority: "high",
          notification: { channelId: "nwf_inventory_alerts" }
        }
      });
    } catch (error) {
      const code = error?.code;
      if (code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token") {
        await db.collection(DEVICE_COLLECTION).updateOne(
          { token: device.token },
          { $set: { active: false, updatedAt: new Date() } }
        );
      } else {
        console.error("Push notification delivery failed:", code ?? "unknown error");
      }
    }
  }));
}

/** Persist one notification for each user; push delivery is best-effort and never blocks a business transaction. */
export async function notifyUsers(db, loginIds, details) {
  try {
    const normalized = [...new Set((loginIds ?? [])
      .filter(value => typeof value === "string" && value.trim())
      .map(value => value.trim().toUpperCase()))];
    if (normalized.length === 0) return;

    const users = await db.collection("users")
      .find({ loginId: { $in: normalized }, isActive: true })
      .project({ loginId: 1 })
      .toArray();

    for (const user of users) {
      const recipientLoginId = user.loginId;
      if (details.dedupeKey) {
        const existingUnread = await db.collection(NOTIFICATION_COLLECTION).findOne({
          recipientLoginId,
          dedupeKey: details.dedupeKey,
          readAt: null
        });
        if (existingUnread) continue;
      }

      const now = new Date();
      const item = {
        _id: new ObjectId(),
        recipientLoginId,
        type: details.type,
        title: details.title,
        body: details.body,
        product_id: details.product_id ?? null,
        approval_request_id: details.approval_request_id ?? null,
        data: details.data ?? {},
        dedupeKey: details.dedupeKey ?? null,
        readAt: null,
        createdAt: now
      };
      await db.collection(NOTIFICATION_COLLECTION).insertOne(item);
      await pushToRecipient(db, recipientLoginId, item).catch(error => {
        console.error("Push notification could not be sent:", error?.message ?? "unknown error");
      });
    }
  } catch (error) {
    // Notification errors must not turn a completed sale/restock into a failed API response.
    console.error("Unable to persist notification:", error?.message ?? "unknown error");
  }
}

export async function notifyRoles(db, roles, details) {
  try {
    const users = await db.collection("users")
      .find({ role: { $in: roles }, isActive: true })
      .project({ loginId: 1 })
      .toArray();
    await notifyUsers(db, users.map(user => user.loginId), details);
  } catch (error) {
    console.error("Unable to resolve notification recipients:", error?.message ?? "unknown error");
  }
}

export async function notifyAllActiveUsers(db, details) {
  try {
    const users = await db.collection("users")
      .find({ isActive: true })
      .project({ loginId: 1 })
      .toArray();
    await notifyUsers(db, users.map(user => user.loginId), details);
  } catch (error) {
    console.error("Unable to resolve notification recipients:", error?.message ?? "unknown error");
  }
}

/** Resolve unread stock alerts after a restock without deleting their historical entries. */
export async function resolveStockAlerts(db, productId) {
  try {
    await db.collection(NOTIFICATION_COLLECTION).updateMany({
      product_id: productId,
      type: { $in: ["LOW_STOCK", "OUT_OF_STOCK"] },
      readAt: null
    }, {
      $set: { readAt: new Date(), resolvedAt: new Date() }
    });
  } catch (error) {
    console.error("Unable to resolve stock alerts:", error?.message ?? "unknown error");
  }
}
