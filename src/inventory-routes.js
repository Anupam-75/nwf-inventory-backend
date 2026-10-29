import { Router } from "express";
import { ObjectId } from "mongodb";
import { requireAuth } from "./auth.js";
import { notifyAllActiveUsers, resolveStockAlerts } from "./notification-service.js";

function validText(value, maxLength = 100) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength
  );
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createInventoryRouter(db, client) {
  const router = Router();
  const products = db.collection("products");
  const receipts = db.collection("stock_receipts");
  const activities = db.collection("activity_logs");

  router.post("/receive", requireAuth(db), async (req, res) => {
    const user = req.authUser;

    if (!["MAIN_ADMIN", "CO_ADMIN"].includes(user.role)) {
      return res.status(403).json({
        error: "Staff cannot add inventory."
      });
    }

    const body = req.body ?? {};
    const productId = body.product_id?.trim();

    if (!validText(productId, 64)) {
      return res.status(400).json({
        error: "A valid product_id is required."
      });
    }

    if (
      !Number.isSafeInteger(body.quantity_received) ||
      body.quantity_received <= 0
    ) {
      return res.status(400).json({
        error: "quantity_received must be a positive whole number."
      });
    }

    if (!validText(body.supplier_name)) {
      return res.status(400).json({
        error: "A valid supplier_name is required."
      });
    }

    if (!validText(body.stall_number)) {
      return res.status(400).json({
        error: "A valid stall_number is required."
      });
    }

    if (
      user.role !== "MAIN_ADMIN" &&
      Object.hasOwn(body, "unit_cost")
    ) {
      return res.status(403).json({
        error: "Only the Main Admin may update product cost."
      });
    }

    if (
      user.role === "MAIN_ADMIN" &&
      body.unit_cost !== undefined &&
      (
        typeof body.unit_cost !== "number" ||
        !Number.isFinite(body.unit_cost) ||
        body.unit_cost < 0
      )
    ) {
      return res.status(400).json({
        error: "unit_cost must be a non-negative number."
      });
    }

    const normalizedId = productId.toUpperCase();
    const productFilter = {
      product_id: {
        $regex: `^${escapeRegex(normalizedId)}$`,
        $options: "i"
      },
      active: { $ne: false }
    };

    const session = client.startSession();
    const now = new Date();
    const receiptId = new ObjectId();
    const activityId = new ObjectId();

    try {
      let availableQuantity = null;

      await session.withTransaction(async () => {
        const product = await products.findOne(
          productFilter,
          { session }
        );

        if (!product) {
          throw new Error("PRODUCT_NOT_FOUND");
        }

        if (
          !Number.isSafeInteger(product.quantity) ||
          product.quantity < 0 ||
          product.quantity >
            Number.MAX_SAFE_INTEGER - body.quantity_received
        ) {
          throw new Error("INVALID_OR_OVERFLOWING_STOCK");
        }

        const update = {
          $inc: {
            quantity: body.quantity_received
          },
          $set: {
            supplier_name: body.supplier_name.trim(),
            stall_number: body.stall_number.trim(),
            updatedAt: now
          }
        };

        if (
          user.role === "MAIN_ADMIN" &&
          body.unit_cost !== undefined
        ) {
          update.$set.cost_price = body.unit_cost;
        }

        const result = await products.updateOne(
          {
            _id: product._id,
            quantity: product.quantity,
            active: { $ne: false }
          },
          update,
          { session }
        );

        if (result.modifiedCount !== 1) {
          throw new Error("STOCK_UPDATE_CONFLICT");
        }

        availableQuantity =
          product.quantity + body.quantity_received;

        const receipt = {
          _id: receiptId,
          product_id: product.product_id,
          quantity_received: body.quantity_received,
          supplier_name: body.supplier_name.trim(),
          stall_number: body.stall_number.trim(),
          received_by: user.loginId,
          received_at: now
        };

        if (
          user.role === "MAIN_ADMIN" &&
          body.unit_cost !== undefined
        ) {
          receipt.unit_cost = body.unit_cost;
        }

        await receipts.insertOne(receipt, { session });

        await activities.insertOne(
          {
            _id: activityId,
            actorName: user.name,
            type: "STOCK_RECEIVED",
            description:
              `Received ${body.quantity_received} unit(s) of ` +
              `${product.product_id} for Stall ${body.stall_number.trim()}.`,
            timestamp: now,
            actorLoginId: user.loginId
          },
          { session }
        );
      });

      await resolveStockAlerts(db, normalizedId);
      await notifyAllActiveUsers(db, {
        type: "STOCK_RESTOCKED",
        title: "Inventory restocked",
        body: `${normalizedId}: ${body.quantity_received} unit(s) received. Available now: ${availableQuantity}.`,
        product_id: normalizedId,
        data: { available_quantity: availableQuantity }
      });

      return res.status(200).json({
        message: "Stock received successfully.",
        product_id: normalizedId,
        quantity_received: body.quantity_received,
        available_quantity: availableQuantity
      });
    } catch (error) {
      if (error.message === "PRODUCT_NOT_FOUND") {
        return res.status(404).json({
          error: "Active product not found."
        });
      }

      if (error.message === "INVALID_OR_OVERFLOWING_STOCK") {
        return res.status(409).json({
          error: "Product quantity is invalid or too large."
        });
      }

      if (error.message === "STOCK_UPDATE_CONFLICT") {
        return res.status(409).json({
          error: "Stock changed during the operation. Please retry."
        });
      }

      console.error("Stock receipt failed:", error.name);

      return res.status(500).json({
        error: "Unable to receive stock. No partial transaction was committed."
      });
    } finally {
      await session.endSession();
    }
  });

  return router;
}
