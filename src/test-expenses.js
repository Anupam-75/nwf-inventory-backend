import "dotenv/config";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB_NAME || "nwf_inventory";
const password = process.env.NWF_ADMIN_PASSWORD;
const month = "2026-10";
const stallNumber = `NWF-TEST-${Date.now()}`;
const stallKey = stallNumber.toUpperCase();

const description =
  `Saved stall expenses for Stall ${stallNumber}, ${month}.`;

const client = new MongoClient(uri || "", {
  serverSelectionTimeoutMS: 15000
});

let connected = false;

async function api(path, token, options = {}) {
  return fetch(`http://127.0.0.1:3000${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
      ...options.headers
    }
  });
}

async function readJson(response) {
  return {
    status: response.status,
    data: await response.json()
  };
}

async function testExpenses() {
  if (!uri || !password) {
    throw new Error("Required environment variables are missing.");
  }

  try {
    await client.connect();
    connected = true;

    const db = client.db(databaseName);

    const loginResponse = await api("/api/auth/login", "", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loginId: "ANUPAM",
        password
      })
    });

    const login = await readJson(loginResponse);

    if (login.status !== 200 || !login.data.token) {
      throw new Error("Main Admin login failed.");
    }

    const token = login.data.token;
    console.log("MAIN ADMIN LOGIN: Passed");

    // Save the initial monthly expense record.
    const firstResponse = await api("/api/expenses/stalls", token, {
      method: "PUT",
      body: JSON.stringify({
        stall_number: stallNumber,
        month,
        rent: 1000,
        staff_salaries: 500,
        electricity: 250,
        other_expenses: 125,
        notes: "Temporary expense API test"
      })
    });

    const first = await readJson(firstResponse);

    if (
      first.status !== 200 ||
      first.data.expense?.total_expenses !== 1875
    ) {
      throw new Error(
        `Initial save failed (HTTP ${first.status}): ` +
        (first.data.error || "Unexpected total")
      );
    }

    console.log("INITIAL EXPENSE SAVE: Passed");
    console.log("INITIAL TOTAL: ₹1,875");

    // Update the same stall and month.
    const updateResponse = await api("/api/expenses/stalls", token, {
      method: "PUT",
      body: JSON.stringify({
        stall_number: stallNumber,
        month,
        rent: 1200,
        staff_salaries: 600,
        electricity: 300,
        other_expenses: 150,
        notes: "Updated temporary expense API test"
      })
    });

    const updated = await readJson(updateResponse);

    if (
      updated.status !== 200 ||
      updated.data.expense?.total_expenses !== 2250
    ) {
      throw new Error(
        `Expense update failed (HTTP ${updated.status}): ` +
        (updated.data.error || "Unexpected total")
      );
    }

    console.log("EXPENSE UPDATE: Passed");
    console.log("UPDATED TOTAL: ₹2,250");

    // Read the same stall/month back through the API.
    const listResponse = await api(
      `/api/expenses/stalls?stall_number=${encodeURIComponent(stallNumber)}&month=${month}`,
      token
    );

    const listed = await readJson(listResponse);

    if (
      listed.status !== 200 ||
      listed.data.count !== 1 ||
      listed.data.expenses?.[0]?.total_expenses !== 2250
    ) {
      throw new Error(
        `Expense retrieval failed (HTTP ${listed.status}).`
      );
    }

    console.log("EXPENSE HISTORY RETRIEVAL: Passed");

    const savedCount = await db.collection("stall_expenses")
      .countDocuments({ stall_key: stallKey, month });

    if (savedCount !== 1) {
      throw new Error("Expected exactly one record for this stall/month.");
    }

    console.log("NO DUPLICATE MONTHLY RECORD: Passed");
  } finally {
    if (connected) {
      const db = client.db(databaseName);

      try {
        await db.collection("stall_expenses").deleteMany({
          stall_key: stallKey,
          month
        });

        await db.collection("activity_logs").deleteMany({
          type: "EXPENSE_UPDATED",
          description
        });

        console.log("TEMPORARY EXPENSE TEST DATA REMOVED");
      } catch {
        console.error(
          "WARNING: Cleanup failed. Check the temporary test records."
        );
        process.exitCode = 1;
      }

      await client.close().catch(() => {});
    }
  }
}

testExpenses().catch(error => {
  console.error("Expense test failed:", error.message);
  process.exitCode = 1;
});
