import "dotenv/config";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB_NAME || "nwf_inventory";
const adminPassword = process.env.NWF_ADMIN_PASSWORD;
const testId = `NWF-SALE-TEST-${Date.now()}`;
const staffLoginId = `NWFSALE${Date.now()}`;
const staffPassword = randomBytes(24).toString("hex");

const client = new MongoClient(uri || "", {
  serverSelectionTimeoutMS: 10000
});

let connected = false;
let productCreated = false;
let staffCreated = false;

async function api(path, token, options = {}) {
  return fetch(`http://127.0.0.1:3000${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });
}

async function readJson(response) {
  const data = await response.json();
  return { status: response.status, data };
}

async function testSales() {
  if (!uri || !adminPassword) {
    throw new Error("Required environment variables are missing.");
  }

  try {
    await client.connect();
    connected = true;

    const db = client.db(databaseName);
    const users = db.collection("users");
    const products = db.collection("products");

    await products.insertOne({
      product_id: testId,
      supplier_name: "Temporary Sales Test",
      cost_price: 200,
      sale_price: 500,
      photo: null,
      category: "Test",
      subcategory: "Temporary Sales Test",
      stall_number: "TEST",
      quantity: 10,
      active: true,
      test_record: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    productCreated = true;
    console.log("TEMPORARY PRODUCT CREATED: Passed");

    await users.insertOne({
      loginId: staffLoginId,
      name: "Temporary Sales Tester",
      role: "STAFF",
      passwordHash: await bcrypt.hash(staffPassword, 12),
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    staffCreated = true;
    console.log("TEMPORARY STAFF CREATED: Passed");

    const adminLogin = await api("/api/auth/login", null, {
      method: "POST",
      body: JSON.stringify({
        loginId: "ANUPAM",
        password: adminPassword
      })
    });
    const admin = await readJson(adminLogin);

    if (admin.status !== 200 || !admin.data.token) {
      throw new Error("Main Admin login failed.");
    }
    const adminToken = admin.data.token;
    console.log("MAIN ADMIN LOGIN: Passed");

    // Normal cash sale: sell 2 units at the minimum price of 500.
    const saleResponse = await api("/api/sales", adminToken, {
      method: "POST",
      body: JSON.stringify({
        product_id: testId,
        quantity: 2,
        unit_price: 500,
        payment_method: "CASH"
      })
    });
    const sale = await readJson(saleResponse);

    if (
      sale.status !== 201 ||
      sale.data.sale?.remainingQuantity !== 8 ||
      sale.data.sale?.totalAmount !== 1000
    ) {
      throw new Error("Normal sale did not return the expected result.");
    }
    console.log("NORMAL CASH SALE: Passed");
    console.log("SALE STOCK DEDUCTION: Passed");

    // Staff login.
    const staffLoginResponse = await api("/api/auth/login", null, {
      method: "POST",
      body: JSON.stringify({
        loginId: staffLoginId,
        password: staffPassword
      })
    });
    const staff = await readJson(staffLoginResponse);

    if (staff.status !== 200 || !staff.data.token) {
      throw new Error("Temporary Staff login failed.");
    }
    console.log("STAFF LOGIN: Passed");

    // Below-minimum UPI sale should request approval, not deduct stock.
    const requestResponse = await api("/api/sales", staff.data.token, {
      method: "POST",
      body: JSON.stringify({
        product_id: testId,
        quantity: 1,
        unit_price: 450,
        payment_method: "UPI"
      })
    });
    const request = await readJson(requestResponse);

    if (
      request.status !== 202 ||
      request.data.status !== "PENDING_APPROVAL" ||
      !request.data.approvalRequestId
    ) {
      throw new Error("Below-minimum sale did not create a pending request.");
    }
    const approvalId = request.data.approvalRequestId;
    console.log("BELOW-MINIMUM SALE REQUEST: Passed");

    let product = await products.findOne({ product_id: testId });

    if (product?.quantity !== 8) {
      throw new Error("Stock changed before approval.");
    }
    console.log("PENDING REQUEST DOES NOT DEDUCT STOCK: Passed");

    // Main Admin approves the Staff member's request.
    const decisionResponse = await api(
      `/api/sales/approvals/${encodeURIComponent(approvalId)}`,
      adminToken,
      {
        method: "PATCH",
        body: JSON.stringify({ approved: true })
      }
    );
    const decision = await readJson(decisionResponse);

    if (
      decision.status !== 200 ||
      decision.data.status !== "APPROVED"
    ) {
      throw new Error(
        `Approval failed (HTTP ${decision.status}): ` +
        (decision.data.error || "Unexpected response")
      );
    }
    console.log("MAIN ADMIN APPROVAL: Passed");

    product = await products.findOne({ product_id: testId });

    if (product?.quantity !== 7) {
      throw new Error("Approval did not deduct stock correctly.");
    }
    console.log("APPROVED SALE STOCK DEDUCTION: Passed");

    const saleCount = await db.collection("sales")
      .countDocuments({ product_id: testId });
    const approvalRecord = await db.collection("sale_approvals")
      .findOne({ _id: (await import("mongodb")).ObjectId.createFromHexString(approvalId) });

    if (saleCount !== 2 || approvalRecord?.status !== "APPROVED") {
      throw new Error("Sale history or approval status was not saved correctly.");
    }
    console.log("SALES HISTORY AND APPROVAL STATUS: Passed");

    const activityCount = await db.collection("activity_logs")
      .countDocuments({ description: { $regex: testId } });

    if (activityCount < 3) {
      throw new Error("Expected sale and approval activity entries were not found.");
    }
    console.log("SALES AND APPROVAL ACTIVITY LOG: Passed");
  } finally {
    if (connected) {
      const db = client.db(databaseName);
      const safeCleanup = async (name, operation) => {
        try {
          await operation();
        } catch {
          console.error(`WARNING: Cleanup failed for ${name}.`);
          process.exitCode = 1;
        }
      };

      await safeCleanup("test sales", () =>
        db.collection("sales").deleteMany({ product_id: testId })
      );
      await safeCleanup("test approvals", () =>
        db.collection("sale_approvals").deleteMany({ product_id: testId })
      );
      await safeCleanup("test activities", () =>
        db.collection("activity_logs").deleteMany({
          description: { $regex: testId }
        })
      );

      if (productCreated) {
        await safeCleanup("test product", () =>
          db.collection("products").deleteOne({
            product_id: testId,
            test_record: true
          })
        );
      }

      if (staffCreated) {
        await safeCleanup("temporary staff", () =>
          db.collection("users").deleteOne({
            loginId: staffLoginId,
            role: "STAFF"
          })
        );
      }

      console.log("TEMPORARY TEST DATA CLEANUP ATTEMPTED");
      await client.close().catch(() => {});
    }
  }
}

testSales().catch(error => {
  console.error("Sales test failed:", error.message);
  process.exitCode = 1;
});
