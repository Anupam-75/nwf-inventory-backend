import { Router } from "express";
import { ObjectId } from "mongodb";
import { requireAuth } from "./auth.js";

const ALLOWED_ROLES = ["MAIN_ADMIN", "CO_ADMIN"];

function canManage(req, res) {
  if (!ALLOWED_ROLES.includes(req.authUser.role)) {
    res.status(403).json({
      error: "Only Admin or Co-admin can manage stall expenses."
    });
    return false;
  }

  return true;
}

function validAmount(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100000000
  );
}

function validText(value, maxLength = 100) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength
  );
}

export function createExpenseRouter(db, client) {
  const router = Router();
  const expenses = db.collection("stall_expenses");
  const activities = db.collection("activity_logs");

  // List monthly expenses. No profit calculations are returned here.
  router.get("/stalls", requireAuth(db), async (req, res) => {
    if (!canManage(req, res)) return;

    try {
      const filter = {};

      if (req.query.stall_number !== undefined) {
        if (!validText(req.query.stall_number, 50)) {
          return res.status(400).json({
            error: "Invalid stall number."
          });
        }

        filter.stall_key = req.query.stall_number.trim().toUpperCase();
      }

      if (req.query.month !== undefined) {
        if (
          typeof req.query.month !== "string" ||
          !/^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month)
        ) {
          return res.status(400).json({
            error: "Month must use YYYY-MM format."
          });
        }

        filter.month = req.query.month;
      }

      const records = await expenses
        .find(filter)
        .project({ _id: 0, stall_key: 0 })
        .sort({ month: -1, stall_number: 1 })
        .limit(500)
        .toArray();

      return res.status(200).json({
        count: records.length,
        expenses: records.map(record => ({
          ...record,
          total_expenses:
            record.rent +
            record.staff_salaries +
            record.electricity +
            record.other_expenses
        }))
      });
    } catch {
      return res.status(500).json({
        error: "Unable to load stall expenses."
      });
    }
  });

  // Save or replace the expense record for a stall and month.
  router.put("/stalls", requireAuth(db), async (req, res) => {
    const user = req.authUser;

    if (!canManage(req, res)) return;

    const body = req.body ?? {};

    if (!validText(body.stall_number, 50)) {
      return res.status(400).json({
        error: "A valid stall_number is required."
      });
    }

    if (
      typeof body.month !== "string" ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.month)
    ) {
      return res.status(400).json({
        error: "Month must use YYYY-MM format."
      });
    }

    const amountFields = [
      "rent",
      "staff_salaries",
      "electricity",
      "other_expenses"
    ];

    for (const field of amountFields) {
      if (!validAmount(body[field])) {
        return res.status(400).json({
          error: `${field} must be a non-negative amount.`
        });
      }
    }

    if (
      body.notes !== undefined &&
      (typeof body.notes !== "string" || body.notes.length > 500)
    ) {
      return res.status(400).json({
        error: "Notes must be 500 characters or fewer."
      });
    }

    const stallNumber = body.stall_number.trim();
    const stallKey = stallNumber.toUpperCase();
    const now = new Date();
    const session = client.startSession();

    try {
      let savedRecord;

      await session.withTransaction(async () => {
        const record = {
          stall_number: stallNumber,
          stall_key: stallKey,
          month: body.month,
          rent: body.rent,
          staff_salaries: body.staff_salaries,
          electricity: body.electricity,
          other_expenses: body.other_expenses,
          notes: body.notes?.trim() || "",
          updated_by: user.loginId,
          updated_at: now
        };

        await expenses.updateOne(
          {
            stall_key: stallKey,
            month: body.month
          },
          {
            $set: record,
            $setOnInsert: {
              created_by: user.loginId,
              created_at: now
            }
          },
          {
            upsert: true,
            session
          }
        );

        savedRecord = await expenses.findOne(
          {
            stall_key: stallKey,
            month: body.month
          },
          { session }
        );

        await activities.insertOne(
          {
            _id: new ObjectId(),
            actorName: user.name,
            actorLoginId: user.loginId,
            type: "EXPENSE_UPDATED",
            description:
              `Saved stall expenses for Stall ${stallNumber}, ${body.month}.`,
            timestamp: now
          },
          { session }
        );
      });

      const {
        _id,
        stall_key,
        ...responseRecord
      } = savedRecord;

      return res.status(200).json({
        message: "Stall expenses saved successfully.",
        expense: {
          ...responseRecord,
          total_expenses:
            responseRecord.rent +
            responseRecord.staff_salaries +
            responseRecord.electricity +
            responseRecord.other_expenses
        }
      });
    } catch (error) {
      console.error("Expense save failed:", error.name);

      return res.status(500).json({
        error: "Unable to save expenses. Please retry."
      });
    } finally {
      await session.endSession();
    }
  });

  return router;
}
