import { Router } from "express";
import { requireAuth } from "./auth.js";

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function text(value, max = 100) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= max;
}

function adminOnly(req, res) {
  if (req.authUser.role !== "MAIN_ADMIN") {
    res.status(403).json({
      error: "Only the Main Admin can perform this operation."
    });
    return false;
  }
  return true;
}

function monthRange(month) {
  if (
    typeof month !== "string" ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)
  ) {
    return null;
  }

  const [year, monthNumber] = month.split("-").map(Number);
  if (year < 2000 || year > 2098) return null;

  const offset = 330 * 60 * 1000; // India Standard Time
  return {
    start: new Date(Date.UTC(year, monthNumber - 1, 1) - offset),
    end: new Date(
      Date.UTC(
        monthNumber === 12 ? year + 1 : year,
        monthNumber === 12 ? 0 : monthNumber,
        1
      ) - offset
    )
  };
}

export function createManagementRouter(db) {
  const router = Router();
  const products = db.collection("products");
  const sales = db.collection("sales");
  const activities = db.collection("activity_logs");

  // Search and list products for authenticated users.
  // Cost price is included only for Main Admin.
  router.get("/products", requireAuth(db), async (req, res) => {
    try {
      const filter = { active: { $ne: false } };
      const fields = [
        "product_id",
        "supplier_name",
        "category",
        "subcategory",
        "stall_number"
      ];

      for (const field of fields) {
        const value = req.query[field];
        if (value === undefined) continue;

        if (typeof value !== "string" || value.length > 100) {
          return res.status(400).json({ error: `Invalid ${field} filter.` });
        }

        filter[field] = {
          $regex: escapeRegex(value.trim()),
          $options: "i"
        };
      }

      const projection = {
        _id: 0,
        product_id: 1,
        supplier_name: 1,
        sale_price: 1,
        photo: 1,
        category: 1,
        subcategory: 1,
        stall_number: 1,
        quantity: 1,
        active: 1
      };

      if (req.authUser.role === "MAIN_ADMIN") {
        projection.cost_price = 1;
      }

      const results = await products
        .find(filter)
        .project(projection)
        .sort({ product_id: 1 })
        .limit(200)
        .toArray();

      return res.json({ count: results.length, products: results });
    } catch {
      return res.status(500).json({ error: "Unable to load products." });
    }
  });

  // Only Main Admin can edit product details and prices.
  // Quantity is intentionally managed by receipts and sales.
  router.patch(
    "/products/:productId",
    requireAuth(db),
    async (req, res) => {
      if (!adminOnly(req, res)) return;

      const productId = req.params.productId.trim();
      if (!text(productId, 64)) {
        return res.status(400).json({ error: "Invalid product ID." });
      }

      const body = req.body ?? {};
      const update = {};
      const allowedText = [
        "supplier_name",
        "category",
        "subcategory",
        "stall_number"
      ];

      for (const field of allowedText) {
        if (body[field] === undefined) continue;
        if (!text(body[field], 100)) {
          return res.status(400).json({ error: `Invalid ${field}.` });
        }
        update[field] = body[field].trim();
      }

      if (body.sale_price !== undefined) {
        if (
          typeof body.sale_price !== "number" ||
          !Number.isFinite(body.sale_price) ||
          body.sale_price <= 0
        ) {
          return res.status(400).json({
            error: "sale_price must be a positive amount."
          });
        }
        update.sale_price = body.sale_price;
      }

      if (body.cost_price !== undefined) {
        if (
          typeof body.cost_price !== "number" ||
          !Number.isFinite(body.cost_price) ||
          body.cost_price < 0
        ) {
          return res.status(400).json({
            error: "cost_price must be zero or greater."
          });
        }
        update.cost_price = body.cost_price;
      }

      if (body.photo !== undefined) {
        if (
          body.photo !== null &&
          (typeof body.photo !== "string" || body.photo.length > 2000)
        ) {
          return res.status(400).json({ error: "Invalid photo reference." });
        }
        update.photo = body.photo;
      }

      if (body.active !== undefined) {
        if (typeof body.active !== "boolean") {
          return res.status(400).json({ error: "active must be true or false." });
        }
        update.active = body.active;
      }

      if (Object.keys(update).length === 0) {
        return res.status(400).json({ error: "No valid fields supplied." });
      }

      update.updatedAt = new Date();

      try {
        const filter = {
          product_id: {
            $regex: `^${escapeRegex(productId)}$`,
            $options: "i"
          }
        };

        const result = await products.updateOne(filter, { $set: update });

        if (result.matchedCount !== 1) {
          return res.status(404).json({ error: "Product not found." });
        }

        return res.json({ message: "Product updated successfully." });
      } catch {
        return res.status(500).json({ error: "Unable to update product." });
      }
    }
  );

  // Delete is a soft delete: historical sales retain their product snapshots.
  // Only Main Admin may remove a product from active catalogue and stock lists.
  router.delete(
    "/products/:productId",
    requireAuth(db),
    async (req, res) => {
      if (!adminOnly(req, res)) return;

      const productId = req.params.productId.trim();
      if (!text(productId, 64)) {
        return res.status(400).json({ error: "Invalid product ID." });
      }

      const filter = {
        product_id: {
          $regex: `^${escapeRegex(productId)}$`,
          $options: "i"
        },
        active: { $ne: false }
      };

      try {
        const result = await products.updateOne(filter, {
          $set: { active: false, updatedAt: new Date() }
        });

        if (result.matchedCount !== 1) {
          return res.status(404).json({
            error: "Active product not found. It may already be deleted."
          });
        }

        try {
          await activities.insertOne({
            actorName: req.authUser.name ?? req.authUser.loginId,
            actorLoginId: req.authUser.loginId,
            type: "PRODUCT_DELETED",
            description: `Soft-deleted product ${productId}; historical sales were preserved.`,
            timestamp: new Date()
          });
        } catch {
          // The product update must not be reported as failed just because
          // the optional audit record could not be written.
        }

        return res.status(200).json({
          message: "Product removed from active inventory. Historical sales were preserved.",
          product_id: productId,
          deleted: true
        });
      } catch {
        return res.status(500).json({ error: "Unable to delete product." });
      }
    }
  );

  // Low-stock and out-of-stock alerts.
  router.get("/stock-alerts", requireAuth(db), async (req, res) => {
    const threshold = req.query.threshold === undefined
      ? 3
      : Number(req.query.threshold);

    if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > 10) {
      return res.status(400).json({
        error: "threshold must be a whole number between 1 and 10."
      });
    }

    try {
      const items = await products
        .find({
          active: { $ne: false },
          quantity: { $lte: threshold }
        })
        .project({
          _id: 0,
          product_id: 1,
          supplier_name: 1,
          category: 1,
          subcategory: 1,
          stall_number: 1,
          quantity: 1
        })
        .sort({ quantity: 1, product_id: 1 })
        .limit(500)
        .toArray();

      return res.json({
        threshold,
        outOfStock: items.filter(item => item.quantity === 0).length,
        lowStock: items.filter(item => item.quantity > 0).length,
        products: items.map(item => ({
          ...item,
          status: item.quantity === 0 ? "OUT_OF_STOCK" : "LOW_STOCK"
        }))
      });
    } catch {
      return res.status(500).json({ error: "Unable to load stock alerts." });
    }
  });

  // Main Admin and Co-admin can view recent activity.
  router.get("/activity", requireAuth(db), async (req, res) => {
    if (!["MAIN_ADMIN", "CO_ADMIN"].includes(req.authUser.role)) {
      return res.status(403).json({
        error: "You cannot access the activity log."
      });
    }

    const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      return res.status(400).json({ error: "limit must be from 1 to 200." });
    }

    try {
      const results = await activities
        .find({})
        .project({
          _id: 0,
          actorName: 1,
          actorLoginId: 1,
          type: 1,
          description: 1,
          timestamp: 1
        })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();

      return res.json({ count: results.length, activities: results });
    } catch {
      return res.status(500).json({ error: "Unable to load activity." });
    }
  });

  // Sales history. Staff can see only their own sales.
  // Cost and profit fields are exposed only to Main Admin.
  router.get("/sales-history", requireAuth(db), async (req, res) => {
    const range = monthRange(req.query.month);

    if (!range) {
      return res.status(400).json({
        error: "A valid month is required in YYYY-MM format."
      });
    }

    const filter = {
      transaction_time: { $gte: range.start, $lt: range.end }
    };

    if (req.authUser.role === "STAFF") {
      filter.sold_by = req.authUser.loginId;
    }

    if (req.query.stall_number !== undefined) {
      if (!text(req.query.stall_number, 50)) {
        return res.status(400).json({ error: "Invalid stall number." });
      }

      filter.stall_number = {
        $regex: `^${escapeRegex(req.query.stall_number.trim())}$`,
        $options: "i"
      };
    }

    const projection = {
      _id: 0,
      sale_id: 1,
      product_id: 1,
      quantity: 1,
      unit_price: 1,
      total_amount: 1,
      payment_method: 1,
      sold_by: 1,
      sold_by_name: 1,
      stall_number: 1,
      transaction_time: 1,
      approved_by: 1
    };

    if (req.authUser.role === "MAIN_ADMIN") {
      projection.cost_price_at_sale = 1;
      projection.total_cost = 1;
      projection.gross_profit = 1;
    }

    try {
      const results = await sales
        .find(filter)
        .project(projection)
        .sort({ transaction_time: -1 })
        .limit(500)
        .toArray();

      return res.json({
        month: req.query.month,
        count: results.length,
        sales: results
      });
    } catch {
      return res.status(500).json({ error: "Unable to load sales history." });
    }
  });

  return router;
}
