import { Router } from "express";
import { requireAuth } from "./auth.js";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    return false;
  }

  const year = Number(value.slice(0, 4));
  return year >= 2000 && year <= 2098;
}

// Report months use India Standard Time (UTC+05:30).
function monthRange(month) {
  const [year, monthNumber] = month.split("-").map(Number);

  const start = new Date(
    Date.UTC(year, monthNumber - 1, 1) - IST_OFFSET_MS
  );

  const end = new Date(
    Date.UTC(
      monthNumber === 12 ? year + 1 : year,
      monthNumber === 12 ? 0 : monthNumber,
      1
    ) - IST_OFFSET_MS
  );

  return { start, end };
}

function mainAdminOnly(req, res) {
  if (req.authUser.role !== "MAIN_ADMIN") {
    res.status(403).json({
      error: "Only the Main Admin can access profit reports."
    });
    return false;
  }

  return true;
}

const emptySales = () => ({
  salesCount: 0,
  unitsSold: 0,
  revenue: 0,
  cashRevenue: 0,
  upiRevenue: 0,
  costOfGoodsSold: 0,
  grossProfitOnKnownCostSales: 0,
  knownCostSales: 0,
  unknownCostSales: 0,
  unknownCostRevenue: 0
});

const emptyExpenses = () => ({
  rent: 0,
  staffSalaries: 0,
  electricity: 0,
  otherExpenses: 0
});

function totalExpenses(expenses) {
  return (
    expenses.rent +
    expenses.staffSalaries +
    expenses.electricity +
    expenses.otherExpenses
  );
}

function buildSalesPipeline(match) {
  return [
    { $match: match },
    {
      $group: {
        _id: { $ifNull: ["$stall_number", "UNASSIGNED"] },
        stallNumber: { $first: "$stall_number" },
        salesCount: { $sum: 1 },
        unitsSold: { $sum: { $ifNull: ["$quantity", 0] } },
        revenue: { $sum: { $ifNull: ["$total_amount", 0] } },
        cashRevenue: {
          $sum: {
            $cond: [
              { $eq: ["$payment_method", "CASH"] },
              { $ifNull: ["$total_amount", 0] },
              0
            ]
          }
        },
        upiRevenue: {
          $sum: {
            $cond: [
              { $eq: ["$payment_method", "UPI"] },
              { $ifNull: ["$total_amount", 0] },
              0
            ]
          }
        },
        costOfGoodsSold: {
          $sum: {
            $cond: [
              { $isNumber: "$total_cost" },
              "$total_cost",
              0
            ]
          }
        },
        grossProfitOnKnownCostSales: {
          $sum: {
            $cond: [
              { $isNumber: "$gross_profit" },
              "$gross_profit",
              0
            ]
          }
        },
        knownCostSales: {
          $sum: { $cond: [{ $isNumber: "$total_cost" }, 1, 0] }
        },
        unknownCostSales: {
          $sum: { $cond: [{ $isNumber: "$total_cost" }, 0, 1] }
        },
        unknownCostRevenue: {
          $sum: {
            $cond: [
              { $isNumber: "$total_cost" },
              0,
              { $ifNull: ["$total_amount", 0] }
            ]
          }
        }
      }
    }
  ];
}

export function createReportsRouter(db) {
  const router = Router();

  const sales = db.collection("sales");
  const expenses = db.collection("stall_expenses");

  router.get("/profit", requireAuth(db), async (req, res) => {
    if (!mainAdminOnly(req, res)) return;

    const month = req.query.month;
    const stallNumber = req.query.stall_number;

    if (!validMonth(month)) {
      return res.status(400).json({
        error: "A valid month is required in YYYY-MM format."
      });
    }

    if (
      stallNumber !== undefined &&
      (
        typeof stallNumber !== "string" ||
        !stallNumber.trim() ||
        stallNumber.trim().length > 50
      )
    ) {
      return res.status(400).json({
        error: "Invalid stall_number filter."
      });
    }

    try {
      const { start, end } = monthRange(month);

      const salesMatch = {
        transaction_time: { $gte: start, $lt: end }
      };

      const expenseMatch = { month };

      if (stallNumber !== undefined) {
        const escapedStall = escapeRegex(stallNumber.trim());

        salesMatch.stall_number = {
          $regex: `^${escapedStall}$`,
          $options: "i"
        };

        expenseMatch.stall_key = stallNumber.trim().toUpperCase();
      }

      const [salesByStall, expensesByStall] = await Promise.all([
        sales.aggregate(buildSalesPipeline(salesMatch)).toArray(),

        expenses.aggregate([
          { $match: expenseMatch },
          {
            $group: {
              _id: {
                $ifNull: [
                  "$stall_key",
                  { $toUpper: "$stall_number" }
                ]
              },
              stallNumber: { $first: "$stall_number" },
              rent: { $sum: { $ifNull: ["$rent", 0] } },
              staffSalaries: {
                $sum: { $ifNull: ["$staff_salaries", 0] }
              },
              electricity: {
                $sum: { $ifNull: ["$electricity", 0] }
              },
              otherExpenses: {
                $sum: { $ifNull: ["$other_expenses", 0] }
              }
            }
          }
        ]).toArray()
      ]);

      const salesMap = new Map(
        salesByStall.map(record => [String(record._id), record])
      );

      const expenseMap = new Map(
        expensesByStall.map(record => [String(record._id), record])
      );

      const stallKeys = new Set([
        ...salesMap.keys(),
        ...expenseMap.keys()
      ]);

      const byStall = [...stallKeys].map(key => {
        const sale = salesMap.get(key) ?? {
          _id: key,
          stallNumber: expenseMap.get(key)?.stallNumber,
          ...emptySales()
        };

        const expense = expenseMap.get(key) ?? {
          ...emptyExpenses()
        };

        const expenseTotal = totalExpenses(expense);

        const netProfit =
          sale.unknownCostSales > 0
            ? null
            : roundMoney(
                sale.grossProfitOnKnownCostSales - expenseTotal
              );

        return {
          stallNumber:
            sale.stallNumber ?? expense.stallNumber ?? key,
          salesCount: sale.salesCount,
          unitsSold: sale.unitsSold,
          revenue: roundMoney(sale.revenue),
          cashRevenue: roundMoney(sale.cashRevenue),
          upiRevenue: roundMoney(sale.upiRevenue),
          costOfGoodsSold: roundMoney(sale.costOfGoodsSold),
          grossProfitOnKnownCostSales: roundMoney(
            sale.grossProfitOnKnownCostSales
          ),
          knownCostSales: sale.knownCostSales,
          unknownCostSales: sale.unknownCostSales,
          unknownCostRevenue: roundMoney(sale.unknownCostRevenue),
          expenses: {
            rent: roundMoney(expense.rent),
            staffSalaries: roundMoney(expense.staffSalaries),
            electricity: roundMoney(expense.electricity),
            otherExpenses: roundMoney(expense.otherExpenses),
            total: roundMoney(expenseTotal)
          },
          netProfit
        };
      });

      const summary = byStall.reduce((acc, stall) => {
        acc.salesCount += stall.salesCount;
        acc.unitsSold += stall.unitsSold;
        acc.revenue += stall.revenue;
        acc.cashRevenue += stall.cashRevenue;
        acc.upiRevenue += stall.upiRevenue;
        acc.costOfGoodsSold += stall.costOfGoodsSold;
        acc.grossProfitOnKnownCostSales +=
          stall.grossProfitOnKnownCostSales;
        acc.knownCostSales += stall.knownCostSales;
        acc.unknownCostSales += stall.unknownCostSales;
        acc.unknownCostRevenue += stall.unknownCostRevenue;

        for (const field of [
          "rent",
          "staffSalaries",
          "electricity",
          "otherExpenses",
          "total"
        ]) {
          acc.expenses[field] += stall.expenses[field];
        }

        return acc;
      }, {
        salesCount: 0,
        unitsSold: 0,
        revenue: 0,
        cashRevenue: 0,
        upiRevenue: 0,
        costOfGoodsSold: 0,
        grossProfitOnKnownCostSales: 0,
        knownCostSales: 0,
        unknownCostSales: 0,
        unknownCostRevenue: 0,
        expenses: {
          rent: 0,
          staffSalaries: 0,
          electricity: 0,
          otherExpenses: 0,
          total: 0
        }
      });

      for (const field of [
        "revenue",
        "cashRevenue",
        "upiRevenue",
        "costOfGoodsSold",
        "grossProfitOnKnownCostSales",
        "unknownCostRevenue"
      ]) {
        summary[field] = roundMoney(summary[field]);
      }

      for (const field of Object.keys(summary.expenses)) {
        summary.expenses[field] = roundMoney(summary.expenses[field]);
      }

      summary.netProfit =
        summary.unknownCostSales > 0
          ? null
          : roundMoney(
              summary.grossProfitOnKnownCostSales -
              summary.expenses.total
            );

      return res.status(200).json({
        month,
        timezone: "Asia/Kolkata",
        stallFilter: stallNumber?.trim() ?? null,
        summary,
        byStall
      });
    } catch (error) {
      console.error("Profit report failed:", error.name);

      return res.status(500).json({
        error: "Unable to generate the profit report."
      });
    }
  });

  return router;
}
