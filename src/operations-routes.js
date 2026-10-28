import { Router } from "express";
import { ObjectId } from "mongodb";
import { requireAuth } from "./auth.js";

const OPERATIONS_ROLES = ["MAIN_ADMIN", "CO_ADMIN"];

function canManage(req, res) {
  if (!OPERATIONS_ROLES.includes(req.authUser.role)) {
    res.status(403).json({
      error: "Only Admin or Co-admin can manage this information."
    });
    return false;
  }
  return true;
}

function validText(value, max = 100) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= max
  );
}

function validAmount(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100000000
  );
}

function safeRecord(record) {
  const { _id, ...fields } = record;
  return { id: _id.toString(), ...fields };
}

export function createOperationsRouter(db) {
  const router = Router();

  const suppliers = db.collection("suppliers");
  const purchases = db.collection("purchases");
  const products = db.collection("products");
  const activities = db.collection("activity_logs");

  // SUPPLIERS: list
  router.get("/suppliers", requireAuth(db), async (req, res) => {
    if (!canManage(req, res)) return;

    try {
      const results = await suppliers
        .find({ active: { $ne: false } })
        .sort({ name: 1 })
        .limit(500)
        .toArray();

      return res.json({
        count: results.length,
        suppliers: results.map(safeRecord)
      });
    } catch {
      return res.status(500).json({
        error: "Unable to load suppliers."
      });
    }
  });

  // SUPPLIERS: create
  router.post("/suppliers", requireAuth(db), async (req, res) => {
    const user = req.authUser;
    if (!canManage(req, res)) return;

    const body = req.body ?? {};
    const name = validText(body.name, 100) ? body.name.trim() : "";

    if (!name) {
      return res.status(400).json({
        error: "Supplier name is required."
      });
    }

    for (const field of ["contactPerson", "phone", "notes"]) {
      if (
        body[field] !== undefined &&
        body[field] !== "" &&
        (typeof body[field] !== "string" || body[field].length > 300)
      ) {
        return res.status(400).json({
          error: `Invalid ${field}.`
        });
      }
    }

    const nameKey = name.toLocaleLowerCase("en-US");

    try {
      const existing = await suppliers.findOne({ nameKey });

      if (existing) {
        return res.status(409).json({
          error: "A supplier with this name already exists."
        });
      }

      const now = new Date();

      const record = {
        name,
        nameKey,
        contactPerson: body.contactPerson?.trim() || "",
        phone: body.phone?.trim() || "",
        notes: body.notes?.trim() || "",
        active: true,
        createdBy: user.loginId,
        createdAt: now,
        updatedAt: now
      };

      const result = await suppliers.insertOne(record);

      await activities.insertOne({
        _id: new ObjectId(),
        actorName: user.name,
        actorLoginId: user.loginId,
        type: "SUPPLIER_ADDED",
        description: `Added supplier ${name}.`,
        timestamp: now
      });

      return res.status(201).json({
        message: "Supplier added successfully.",
        supplier: { id: result.insertedId.toString(), ...record }
      });
    } catch {
      return res.status(500).json({
        error: "Unable to add supplier."
      });
    }
  });

  // PURCHASES: list. Unit costs are only returned to Main Admin.
  router.get("/purchases", requireAuth(db), async (req, res) => {
    const user = req.authUser;
    if (!canManage(req, res)) return;

    try {
      const projection = {
        product_id: 1,
        supplier_name: 1,
        quantity: 1,
        stall_number: 1,
        reference: 1,
        recorded_by: 1,
        recorded_at: 1
      };

      if (user.role === "MAIN_ADMIN") {
        projection.unit_cost = 1;
      }

      const results = await purchases
        .find({})
        .project(projection)
        .sort({ recorded_at: -1 })
        .limit(500)
        .toArray();

      return res.json({
        count: results.length,
        purchases: results.map(safeRecord)
      });
    } catch {
      return res.status(500).json({
        error: "Unable to load purchase history."
      });
    }
  });

  // PURCHASES: record a purchase.
  // This records purchase history only; use the stock-receipt
  // endpoint separately when the goods physically arrive.
  router.post("/purchases", requireAuth(db), async (req, res) => {
    const user = req.authUser;
    if (!canManage(req, res)) return;

    const body = req.body ?? {};

    if (!validText(body.product_id, 64)) {
      return res.status(400).json({
        error: "A valid product_id is required."
      });
    }

    if (
      !Number.isSafeInteger(body.quantity) ||
      body.quantity <= 0 ||
      body.quantity > 1000000
    ) {
      return res.status(400).json({
        error: "Quantity must be a positive whole number."
      });
    }

    if (
      !validText(body.supplier_name) ||
      !validText(body.stall_number)
    ) {
      return res.status(400).json({
        error: "Supplier name and stall number are required."
      });
    }

    if (
      body.reference !== undefined &&
      (typeof body.reference !== "string" || body.reference.length > 200)
    ) {
      return res.status(400).json({
        error: "Reference must be 200 characters or fewer."
      });
    }

    if (
      user.role !== "MAIN_ADMIN" &&
      Object.hasOwn(body, "unit_cost")
    ) {
      return res.status(403).json({
        error: "Only the Main Admin may record purchase cost details."
      });
    }

    if (
      user.role === "MAIN_ADMIN" &&
      body.unit_cost !== undefined &&
      !validAmount(body.unit_cost)
    ) {
      return res.status(400).json({
        error: "unit_cost must be a non-negative amount."
      });
    }

    try {
      const product = await products.findOne({
        product_id: {
          $regex: `^${body.product_id.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          $options: "i"
        },
        active: { $ne: false }
      });

      if (!product) {
        return res.status(404).json({
          error: "Active product not found."
        });
      }

      const now = new Date();

      const record = {
        product_id: product.product_id,
        supplier_name: body.supplier_name.trim(),
        quantity: body.quantity,
        stall_number: body.stall_number.trim(),
        reference: body.reference?.trim() || "",
        recorded_by: user.loginId,
        recorded_at: now
      };

      if (
        user.role === "MAIN_ADMIN" &&
        body.unit_cost !== undefined
      ) {
        record.unit_cost = body.unit_cost;
      }

      const result = await purchases.insertOne(record);

      await activities.insertOne({
        _id: new ObjectId(),
        actorName: user.name,
        actorLoginId: user.loginId,
        type: "PURCHASE_RECORDED",
        description:
          `Recorded purchase of ${body.quantity} unit(s) of ` +
          `${product.product_id} from ${body.supplier_name.trim()}.`,
        timestamp: now
      });

      return res.status(201).json({
        message: "Purchase recorded successfully.",
        note: "Stock quantity is unchanged. Use the stock-receipt endpoint when goods arrive.",
        purchase: {
          id: result.insertedId.toString(),
          ...record
        }
      });
    } catch {
      return res.status(500).json({
        error: "Unable to record the purchase."
      });
    }
  });

  return router;
}
