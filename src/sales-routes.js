import { Router } from "express";
import { ObjectId } from "mongodb";
import { requireAuth } from "./auth.js";
import { notifyAllActiveUsers, notifyRoles, notifyUsers } from "./notification-service.js";

const SELLING_ROLES = ["MAIN_ADMIN", "CO_ADMIN", "STAFF"];
const APPROVER_ROLES = ["MAIN_ADMIN", "CO_ADMIN"];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function productFilter(productId) {
  return {
    product_id: {
      $regex: `^${escapeRegex(productId)}$`,
      $options: "i"
    },
    active: { $ne: false }
  };
}

function validMoney(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 100000000
  );
}

function activity(actor, type, description, now) {
  return {
    _id: new ObjectId(),
    actorName: actor.name,
    actorLoginId: actor.loginId,
    type,
    description,
    timestamp: now
  };
}

function saleDocument({
  product,
  quantity,
  unitPrice,
  paymentMethod,
  seller,
  saleId,
  now,
  approvedBy = null,
  costPriceAtSale = product.cost_price ?? null
}) {
  const costKnown =
    typeof costPriceAtSale === "number" &&
    Number.isFinite(costPriceAtSale);

  const totalAmount = quantity * unitPrice;
  const totalCost = costKnown
    ? quantity * costPriceAtSale
    : null;

  return {
    sale_id: saleId,
    product_id: product.product_id,
    quantity,
    unit_price: unitPrice,
    total_amount: totalAmount,
    payment_method: paymentMethod,
    sold_by: seller.loginId,
    sold_by_name: seller.name,
    stall_number: product.stall_number,
    transaction_time: now,
    approved_by: approvedBy,
    cost_price_at_sale: costKnown ? costPriceAtSale : null,
    total_cost: totalCost,
    gross_profit: costKnown ? totalAmount - totalCost : null
  };
}

export function createSalesRouter(db, client) {
  const router = Router();

  const products = db.collection("products");
  const sales = db.collection("sales");
  const approvals = db.collection("sale_approvals");
  const activities = db.collection("activity_logs");

  // Record a sale or request approval for a below-minimum price.
  router.post("/", requireAuth(db), async (req, res) => {
    const user = req.authUser;
    const body = req.body ?? {};

    if (!SELLING_ROLES.includes(user.role)) {
      return res.status(403).json({
        error: "You are not allowed to record sales."
      });
    }

    if (
      typeof body.product_id !== "string" ||
      !body.product_id.trim() ||
      body.product_id.trim().length > 64
    ) {
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

    if (!validMoney(body.unit_price)) {
      return res.status(400).json({
        error: "unit_price must be a positive amount."
      });
    }

    const paymentMethod =
      typeof body.payment_method === "string"
        ? body.payment_method.trim().toUpperCase()
        : "";

    if (!["CASH", "UPI"].includes(paymentMethod)) {
      return res.status(400).json({
        error: "payment_method must be CASH or UPI."
      });
    }

    const normalizedId = body.product_id.trim().toUpperCase();
    const session = client.startSession();

    try {
      let result;

      await session.withTransaction(async () => {
        const product = await products.findOne(
          productFilter(normalizedId),
          { session }
        );

        if (!product) {
          throw new Error("PRODUCT_NOT_FOUND");
        }

        if (
          !Number.isSafeInteger(product.quantity) ||
          product.quantity < body.quantity
        ) {
          throw new Error("INSUFFICIENT_STOCK");
        }

        const belowMinimum =
          body.unit_price < product.sale_price;

        // Main Admin can directly override the minimum price.
        // Staff and Co-admin must request approval for a lower price.
        if (belowMinimum && user.role !== "MAIN_ADMIN") {
          const now = new Date();
          const requestId = new ObjectId();

          await approvals.insertOne(
            {
              _id: requestId,
              product_id: product.product_id,
              product_description: [
                product.category,
                product.subcategory
              ].filter(Boolean).join(" • "),
              quantity: body.quantity,
              requested_price: body.unit_price,
              minimum_price: product.sale_price,
              payment_method: paymentMethod,
              requested_by: user.loginId,
              requested_by_name: user.name,
              requester_role: user.role,
              cost_price_at_request: product.cost_price ?? null,
              stall_number: product.stall_number,
              request_time: now,
              status: "PENDING"
            },
            { session }
          );

          await activities.insertOne(
            activity(
              user,
              "SALE_APPROVAL",
              `Requested below-minimum-price approval for ${product.product_id}, quantity ${body.quantity}.`,
              now
            ),
            { session }
          );

          result = {
            kind: "approval",
            requestId: requestId.toString()
          };

          return;
        }

        const now = new Date();
        const saleId = new ObjectId().toString();

        const stockUpdate = await products.updateOne(
          {
            _id: product._id,
            quantity: { $gte: body.quantity },
            active: { $ne: false }
          },
          {
            $inc: { quantity: -body.quantity },
            $set: { updatedAt: now }
          },
          { session }
        );

        if (stockUpdate.modifiedCount !== 1) {
          throw new Error("INSUFFICIENT_STOCK");
        }

        const sale = saleDocument({
          product,
          quantity: body.quantity,
          unitPrice: body.unit_price,
          paymentMethod,
          seller: user,
          saleId,
          now
        });

        await sales.insertOne(sale, { session });

        await activities.insertOne(
          activity(
            user,
            "SALE",
            `Sold ${body.quantity} unit(s) of ${product.product_id} for ${paymentMethod}.`,
            now
          ),
          { session }
        );

        result = {
          kind: "sale",
          saleId,
          productId: product.product_id,
          quantitySold: body.quantity,
          remainingQuantity: product.quantity - body.quantity,
          totalAmount: sale.total_amount
        };
      });

      if (result?.kind === "approval") {
        await notifyRoles(db, APPROVER_ROLES, {
          type: "SALE_APPROVAL",
          title: "Sale approval needed",
          body: `${user.name} requested approval for ${normalizedId}, quantity ${body.quantity}.`,
          product_id: normalizedId,
          approval_request_id: result.requestId,
          data: { approval_request_id: result.requestId }
        });
        return res.status(202).json({
          status: "PENDING_APPROVAL",
          message: "The requested price requires approval.",
          approvalRequestId: result.requestId
        });
      }

      if (result?.kind === "sale") {
        await notifyRoles(db, APPROVER_ROLES, {
          type: "SALE_UPDATE",
          title: "Sale recorded",
          body: `${result.productId}: ${result.quantitySold} unit(s), total ₹${Number(result.totalAmount).toFixed(2)}.`,
          product_id: result.productId,
          data: { sale_id: result.saleId }
        });
        if (result.remainingQuantity === 0) {
          await notifyAllActiveUsers(db, {
            type: "OUT_OF_STOCK",
            title: "Product out of stock",
            body: `${result.productId} has reached zero available units.`,
            product_id: result.productId,
            dedupeKey: `OUT_OF_STOCK:${result.productId}`
          });
        } else if (result.remainingQuantity <= 3) {
          await notifyAllActiveUsers(db, {
            type: "LOW_STOCK",
            title: "Low stock alert",
            body: `${result.productId} has only ${result.remainingQuantity} unit(s) left.`,
            product_id: result.productId,
            dedupeKey: `LOW_STOCK:${result.productId}`
          });
        }
      }

      return res.status(201).json({
        status: "COMPLETED",
        sale: result
      });
    } catch (error) {
      if (error.message === "PRODUCT_NOT_FOUND") {
        return res.status(404).json({
          error: "Active product not found."
        });
      }

      if (error.message === "INSUFFICIENT_STOCK") {
        return res.status(409).json({
          error: "Insufficient stock available."
        });
      }

      console.error("Sale transaction failed:", error.name);

      return res.status(500).json({
        error: "Unable to complete the sale."
      });
    } finally {
      await session.endSession();
    }
  });

  // Only Main Admin and Co-admin can see pending requests.
  router.get(
    "/approvals/pending",
    requireAuth(db),
    async (req, res) => {
      if (!APPROVER_ROLES.includes(req.authUser.role)) {
        return res.status(403).json({
          error: "You cannot view sale approval requests."
        });
      }

      try {
        const pending = await approvals
          .find({ status: "PENDING" })
          .project({
            _id: 1,
            product_id: 1,
            product_description: 1,
            quantity: 1,
            requested_price: 1,
            minimum_price: 1,
            payment_method: 1,
            requested_by: 1,
            requested_by_name: 1,
            stall_number: 1,
            request_time: 1,
            status: 1
          })
          .sort({ request_time: 1 })
          .limit(200)
          .toArray();

        return res.status(200).json({
          count: pending.length,
          approvals: pending.map(item => ({
            ...item,
            request_id: item._id.toString(),
            _id: undefined
          }))
        });
      } catch {
        return res.status(500).json({
          error: "Unable to load pending approvals."
        });
      }
    }
  );

  // Approve or reject a pending request.
  const decideApproval = async (req, res) => {
      const user = req.authUser;

      if (!APPROVER_ROLES.includes(user.role)) {
        return res.status(403).json({
          error: "You cannot decide sale approvals."
        });
      }

      if (!ObjectId.isValid(req.params.requestId)) {
        return res.status(400).json({
          error: "Invalid approval request ID."
        });
      }

      if (typeof req.body?.approved !== "boolean") {
        return res.status(400).json({
          error: "approved must be true or false."
        });
      }

      const requestObjectId = new ObjectId(req.params.requestId);
      const session = client.startSession();

      try {
        let decisionResult;

        await session.withTransaction(async () => {
          const request = await approvals.findOne(
            {
              _id: requestObjectId,
              status: "PENDING"
            },
            { session }
          );

          if (!request) {
            throw new Error("APPROVAL_NOT_PENDING");
          }

          if (request.requested_by === user.loginId) {
            throw new Error("CANNOT_APPROVE_OWN_REQUEST");
          }

          const now = new Date();

          if (req.body.approved) {
            const product = await products.findOne(
              productFilter(request.product_id),
              { session }
            );

            if (!product || product.quantity < request.quantity) {
              throw new Error("INSUFFICIENT_STOCK");
            }

            const updateResult = await products.updateOne(
              {
                _id: product._id,
                quantity: { $gte: request.quantity },
                active: { $ne: false }
              },
              {
                $inc: { quantity: -request.quantity },
                $set: { updatedAt: now }
              },
              { session }
            );

            if (updateResult.modifiedCount !== 1) {
              throw new Error("INSUFFICIENT_STOCK");
            }

            const saleId = new ObjectId().toString();

            const sale = saleDocument({
              product,
              quantity: request.quantity,
              unitPrice: request.requested_price,
              paymentMethod: request.payment_method,
              seller: {
                loginId: request.requested_by,
                name: request.requested_by_name
              },
              saleId,
              now,
              approvedBy: user.loginId,
              costPriceAtSale:
                request.cost_price_at_request ?? null
            });

            await sales.insertOne(sale, { session });

            const statusUpdate = await approvals.updateOne(
              {
                _id: requestObjectId,
                status: "PENDING"
              },
              {
                $set: {
                  status: "APPROVED",
                  decided_by: user.loginId,
                  decision_time: now,
                  sale_id: saleId
                }
              },
              { session }
            );

            if (statusUpdate.modifiedCount !== 1) {
              throw new Error("APPROVAL_NOT_PENDING");
            }

            await activities.insertOne(
              activity(
                user,
                "SALE_APPROVAL",
                `Approved below-minimum-price request for ${request.product_id}.`,
                now
              ),
              { session }
            );

            decisionResult = {
              status: "APPROVED",
              saleId,
              requestId: request._id.toString(),
              requestedBy: request.requested_by,
              productId: request.product_id,
              quantity: request.quantity,
              totalAmount: sale.total_amount,
              remainingQuantity: product.quantity - request.quantity
            };
          } else {
            const statusUpdate = await approvals.updateOne(
              {
                _id: requestObjectId,
                status: "PENDING"
              },
              {
                $set: {
                  status: "REJECTED",
                  decided_by: user.loginId,
                  decision_time: now
                }
              },
              { session }
            );

            if (statusUpdate.modifiedCount !== 1) {
              throw new Error("APPROVAL_NOT_PENDING");
            }

            await activities.insertOne(
              activity(
                user,
                "SALE_APPROVAL",
                `Rejected below-minimum-price request for ${request.product_id}.`,
                now
              ),
              { session }
            );

            decisionResult = {
              status: "REJECTED",
              requestId: request._id.toString(),
              requestedBy: request.requested_by,
              productId: request.product_id,
              quantity: request.quantity
            };
          }
        });

        if (decisionResult?.requestedBy) {
          await notifyUsers(db, [decisionResult.requestedBy], {
            type: "SALE_APPROVAL_RESULT",
            title: decisionResult.status === "APPROVED" ? "Sale approved" : "Sale rejected",
            body: decisionResult.status === "APPROVED"
              ? `Your sale request for ${decisionResult.productId} was approved.`
              : `Your sale request for ${decisionResult.productId} was rejected.`,
            product_id: decisionResult.productId,
            approval_request_id: decisionResult.requestId,
            data: { approval_request_id: decisionResult.requestId }
          });
        }

        if (decisionResult?.status === "APPROVED") {
          await notifyRoles(db, APPROVER_ROLES, {
            type: "SALE_UPDATE",
            title: "Approved sale completed",
            body: `${decisionResult.productId}: ${decisionResult.quantity} unit(s), total ₹${Number(decisionResult.totalAmount).toFixed(2)}.`,
            product_id: decisionResult.productId,
            data: { sale_id: decisionResult.saleId }
          });
          if (decisionResult.remainingQuantity === 0) {
            await notifyAllActiveUsers(db, {
              type: "OUT_OF_STOCK",
              title: "Product out of stock",
              body: `${decisionResult.productId} has reached zero available units.`,
              product_id: decisionResult.productId,
              dedupeKey: `OUT_OF_STOCK:${decisionResult.productId}`
            });
          } else if (decisionResult.remainingQuantity <= 3) {
            await notifyAllActiveUsers(db, {
              type: "LOW_STOCK",
              title: "Low stock alert",
              body: `${decisionResult.productId} has only ${decisionResult.remainingQuantity} unit(s) left.`,
              product_id: decisionResult.productId,
              dedupeKey: `LOW_STOCK:${decisionResult.productId}`
            });
          }
        }

        return res.status(200).json({
          message: "Approval decision recorded.",
          ...decisionResult
        });
      } catch (error) {
        if (error.message === "APPROVAL_NOT_PENDING") {
          return res.status(409).json({
            error: "This request is no longer pending."
          });
        }

        if (error.message === "CANNOT_APPROVE_OWN_REQUEST") {
          return res.status(403).json({
            error: "You cannot approve or reject your own request."
          });
        }

        if (error.message === "INSUFFICIENT_STOCK") {
          return res.status(409).json({
            error: "Product not found or insufficient stock remains."
          });
        }

        console.error("Approval decision failed:", error.name);

        return res.status(500).json({
          error: "Unable to record the approval decision."
        });
      } finally {
        await session.endSession();
      }
  };

  // PATCH remains available for clients that support it. POST is an Android-friendly alias.
  router.patch("/approvals/:requestId", requireAuth(db), decideApproval);
  router.post("/approvals/:requestId/decision", requireAuth(db), decideApproval);

  return router;
}
