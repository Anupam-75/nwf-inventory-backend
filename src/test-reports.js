import "dotenv/config";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB_NAME || "nwf_inventory";
const password = process.env.NWF_ADMIN_PASSWORD;
const month = "2026-10";
const testKey = `NWF-REPORT-TEST-${Date.now()}`;
const stallKey = testKey.toUpperCase();
const transactionTime = new Date("2026-10-15T12:00:00.000Z");

const client = new MongoClient(uri || "", {
  serverSelectionTimeoutMS: 15000
});

let connected = false;
let salesInserted = false;
let expenseInserted = false;

async function testReports() {
  if (!uri || !password) {
    throw new Error("Required environment variables are missing.");
  }

  try {
    await client.connect();
    connected = true;

    const db = client.db(databaseName);

    const loginResponse = await fetch(
      "http://127.0.0.1:3000/api/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          loginId: "ANUPAM",
          password
        })
      }
    );

    const login = await loginResponse.json();

    if (!loginResponse.ok || !login.token) {
      throw new Error("Main Admin login failed.");
    }

    console.log("MAIN ADMIN LOGIN: Passed");

    const sales = db.collection("sales");

    await sales.insertMany([
      {
        sale_id: `${testKey}-CASH`,
        product_id: testKey,
        quantity: 2,
        unit_price: 100,
        total_amount: 200,
        payment_method: "CASH",
        total_cost: 80,
        gross_profit: 120,
        transaction_time: transactionTime,
        stall_number: stallKey
      },
      {
        sale_id: `${testKey}-UPI`,
        product_id: testKey,
        quantity: 1,
        unit_price: 50,
        total_amount: 50,
        payment_method: "UPI",
        total_cost: 20,
        gross_profit: 30,
        transaction_time: transactionTime,
        stall_number: stallKey
      }
    ]);

    salesInserted = true;

    await db.collection("stall_expenses").insertOne({
      stall_number: stallKey,
      stall_key: stallKey,
      month,
      rent: 20,
      staff_salaries: 10,
      electricity: 5,
      other_expenses: 5,
      test_record: true
    });

    expenseInserted = true;
    console.log("TEMPORARY REPORT DATA CREATED");

    const response = await fetch(
      `http://127.0.0.1:3000/api/reports/profit?month=${month}&stall_number=${encodeURIComponent(stallKey)}`,
      {
        headers: {
          Authorization: `Bearer ${login.token}`
        }
      }
    );

    const report = await response.json();

    if (!response.ok) {
      throw new Error(
        `Report request failed (HTTP ${response.status}): ` +
        (report.error || "Unknown error")
      );
    }

    const summary = report.summary;

    const expected = {
      salesCount: 2,
      unitsSold: 3,
      revenue: 250,
      cashRevenue: 200,
      upiRevenue: 50,
      costOfGoodsSold: 100,
      grossProfitOnKnownCostSales: 150,
      unknownCostSales: 0
    };

    for (const [field, value] of Object.entries(expected)) {
      if (summary[field] !== value) {
        throw new Error(
          `${field}: expected ${value}, received ${summary[field]}`
        );
      }
    }

    if (
      summary.expenses.total !== 40 ||
      summary.netProfit !== 110
    ) {
      throw new Error(
        `Unexpected expense or net profit total. ` +
        `Expenses: ${summary.expenses.total}; ` +
        `net profit: ${summary.netProfit}`
      );
    }

    console.log("SALES REVENUE: Passed (₹250)");
    console.log("CASH / UPI BREAKDOWN: Passed");
    console.log("COST OF GOODS SOLD: Passed (₹100)");
    console.log("GROSS PROFIT: Passed (₹150)");
    console.log("STALL EXPENSES: Passed (₹40)");
    console.log("NET PROFIT: Passed (₹110)");

    const unauthorized = await fetch(
      `http://127.0.0.1:3000/api/reports/profit?month=${month}`
    );

    if (unauthorized.status !== 401) {
      throw new Error(
        `Unauthenticated access expected 401, received ${unauthorized.status}.`
      );
    }

    console.log("REPORT AUTHENTICATION: Passed");
  } finally {
    if (connected) {
      const db = client.db(databaseName);

      try {
        if (salesInserted) {
          await db.collection("sales").deleteMany({
            product_id: testKey
          });
        }

        if (expenseInserted) {
          await db.collection("stall_expenses").deleteMany({
            stall_key: stallKey,
            month,
            test_record: true
          });
        }

        console.log("TEMPORARY REPORT DATA CLEANUP FINISHED");
      } catch {
        console.error(
          "WARNING: Cleanup failed. Verify temporary report records."
        );
        process.exitCode = 1;
      } finally {
        await client.close().catch(() => {});
      }
    }
  }
}

testReports().catch(error => {
  console.error("Report test failed:", error.message);
  process.exitCode = 1;
});
