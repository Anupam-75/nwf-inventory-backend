import "dotenv/config";
import bcrypt from "bcryptjs";
import { MongoClient } from "mongodb";
import { randomBytes } from "node:crypto";

const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB_NAME || "nwf_inventory";
const adminPassword = process.env.NWF_ADMIN_PASSWORD;

const suffix = Date.now().toString();
const productId = `NWF-MGMT-TEST-${suffix}`;
const stallNumber = `TEST-${suffix}`;
const staffLoginId = `NWFMT${suffix}`;
const staffPassword = randomBytes(24).toString("hex");

const saleTime = new Date("2026-10-15T12:00:00.000Z");
const client = new MongoClient(uri || "", {
  serverSelectionTimeoutMS: 15000
});

let connected = false;
let productCreated = false;
let staffCreated = false;
let salesCreated = false;

async function api(path, token, options = {}) {
  const headers = { ...options.headers };

  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body) headers["Content-Type"] = "application/json";

  return fetch(`http://127.0.0.1:3000${path}`, {
    ...options,
    headers
  });
}

async function jsonResponse(response) {
  return { status: response.status, data: await response.json() };
}

async function requireStatus(response, expected, label) {
  const result = await jsonResponse(response);

  if (result.status !== expected) {
    throw new Error(
      `${label}: expected HTTP ${expected}, received ${result.status}.`
    );
  }

  return result.data;
}

async function testManagement() {
  if (!uri || !adminPassword) {
    throw new Error("Required environment variables are missing.");
  }

  try {
    await client.connect();
    connected = true;

    const db = client.db(databaseName);

    // Create an isolated, low-stock test product.
    await db.collection("products").insertOne({
      product_id: productId,
      supplier_name: "Temporary Management Test",
      cost_price: 200,
      sale_price: 400,
      photo: null,
      category: "Test",
      subcategory: "Management Test",
      stall_number: stallNumber,
      quantity: 2,
      active: true,
      test_record: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    productCreated = true;

    // Create a temporary Staff account.
    await db.collection("users").insertOne({
      loginId: staffLoginId,
      name: "Temporary Management Tester",
      role: "STAFF",
      passwordHash: await bcrypt.hash(staffPassword, 12),
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    staffCreated = true;

    // Create two temporary sales: one belongs to Staff.
    await db.collection("sales").insertMany([
      {
        sale_id: `${productId}-STAFF`,
        product_id: productId,
        quantity: 1,
        unit_price: 400,
        total_amount: 400,
        payment_method: "CASH",
        sold_by: staffLoginId,
        sold_by_name: "Temporary Management Tester",
        stall_number: stallNumber,
        transaction_time: saleTime,
        cost_price_at_sale: 200,
        total_cost: 200,
        gross_profit: 200
      },
      {
        sale_id: `${productId}-OTHER`,
        product_id: productId,
        quantity: 1,
        unit_price: 400,
        total_amount: 400,
        payment_method: "UPI",
        sold_by: "ANOTHERUSER",
        sold_by_name: "Another Test User",
        stall_number: stallNumber,
        transaction_time: saleTime,
        cost_price_at_sale: 200,
        total_cost: 200,
        gross_profit: 200
      }
    ]);

    salesCreated = true;
    console.log("TEMPORARY TEST DATA CREATED");

    // Authenticate Main Admin.
    const adminData = await requireStatus(
      await api("/api/auth/login", null, {
        method: "POST",
        body: JSON.stringify({
          loginId: "ANUPAM",
          password: adminPassword
        })
      }),
      200,
      "Main Admin login"
    );

    const adminToken = adminData.token;
    console.log("MAIN ADMIN LOGIN: Passed");

    // Authenticate Staff.
    const staffData = await requireStatus(
      await api("/api/auth/login", null, {
        method: "POST",
        body: JSON.stringify({
          loginId: staffLoginId,
          password: staffPassword
        })
      }),
      200,
      "Staff login"
    );

    const staffToken = staffData.token;
    console.log("STAFF LOGIN: Passed");

    // Admin product listing includes cost.
    const adminProducts = await requireStatus(
      await api(
        `/api/management/products?product_id=${encodeURIComponent(productId)}`,
        adminToken
      ),
      200,
      "Admin product list"
    );

    const adminProduct = adminProducts.products.find(
      item => item.product_id === productId
    );

    if (!adminProduct || adminProduct.cost_price !== 200) {
      throw new Error("Admin product listing or cost visibility failed.");
    }

    console.log("ADMIN PRODUCT LIST AND COST: Passed");

    // Staff product listing must hide cost.
    const staffProducts = await requireStatus(
      await api(
        `/api/management/products?product_id=${encodeURIComponent(productId)}`,
        staffToken
      ),
      200,
      "Staff product list"
    );

    const staffProduct = staffProducts.products.find(
      item => item.product_id === productId
    );

    if (!staffProduct || "cost_price" in staffProduct) {
      throw new Error("Staff product listing exposed cost or missed the product.");
    }

    console.log("STAFF PRODUCT COST HIDDEN: Passed");

    // Stock alert should show the temporary quantity of two.
    const alerts = await requireStatus(
      await api("/api/management/stock-alerts?threshold=3", adminToken),
      200,
      "Stock alerts"
    );

    if (!alerts.products.some(item =>
      item.product_id === productId &&
      item.quantity === 2 &&
      item.status === "LOW_STOCK"
    )) {
      throw new Error("Low-stock alert did not include the test product.");
    }

    console.log("LOW-STOCK ALERT: Passed");

    // Main Admin can update the product's selling price.
    await requireStatus(
      await api(`/api/management/products/${encodeURIComponent(productId)}`,
        adminToken, {
          method: "PATCH",
          body: JSON.stringify({ sale_price: 450 })
        }),
      200,
      "Admin product update"
    );

    console.log("ADMIN PRICE UPDATE: Passed");

    // Staff must not be allowed to change prices.
    await requireStatus(
      await api(`/api/management/products/${encodeURIComponent(productId)}`,
        staffToken, {
          method: "PATCH",
          body: JSON.stringify({ sale_price: 1 })
        }),
      403,
      "Staff product update restriction"
    );

    console.log("STAFF PRICE-UPDATE RESTRICTION: Passed");

    // Activity access: Admin allowed, Staff denied.
    await requireStatus(
      await api("/api/management/activity?limit=10", adminToken),
      200,
      "Admin activity access"
    );

    await requireStatus(
      await api("/api/management/activity?limit=10", staffToken),
      403,
      "Staff activity restriction"
    );

    console.log("ACTIVITY PERMISSIONS: Passed");

    // Admin sees both sales; Staff sees only their own.
    const adminHistory = await requireStatus(
      await api(
        `/api/management/sales-history?month=2026-10&stall_number=${encodeURIComponent(stallNumber)}`,
        adminToken
      ),
      200,
      "Admin sales history"
    );

    const staffHistory = await requireStatus(
      await api(
        `/api/management/sales-history?month=2026-10&stall_number=${encodeURIComponent(stallNumber)}`,
        staffToken
      ),
      200,
      "Staff sales history"
    );

    if (adminHistory.count !== 2 || staffHistory.count !== 1) {
      throw new Error("Sales-history visibility was not scoped correctly.");
    }

    if ("total_cost" in staffHistory.sales[0]) {
      throw new Error("Staff sales history exposed cost information.");
    }

    console.log("ADMIN SALES HISTORY: Passed");
    console.log("STAFF SALES SCOPE AND COST PRIVACY: Passed");

    // Public reports must not be accessible without authentication.
    await requireStatus(
      await api("/api/reports/profit?month=2026-10", null),
      401,
      "Profit report authentication"
    );

    console.log("PROFIT REPORT AUTHENTICATION: Passed");
  } finally {
    if (connected) {
      const db = client.db(databaseName);
      let cleanupFailed = false;

      async function cleanup(label, operation) {
        try {
          await operation();
        } catch {
          cleanupFailed = true;
          console.error(`CLEANUP WARNING: ${label}`);
        }
      }

      if (salesCreated) {
        await cleanup("sales", () =>
          db.collection("sales").deleteMany({ product_id: productId })
        );
      }

      if (productCreated) {
        await cleanup("product", () =>
          db.collection("products").deleteOne({
            product_id: productId,
            test_record: true
          })
        );
      }

      if (staffCreated) {
        await cleanup("staff account", () =>
          db.collection("users").deleteOne({
            loginId: staffLoginId,
            role: "STAFF",
            name: "Temporary Management Tester"
          })
        );
      }

      console.log(
        cleanupFailed
          ? "CLEANUP NEEDS VERIFICATION"
          : "TEMPORARY TEST DATA REMOVED"
      );

      if (cleanupFailed) process.exitCode = 1;
      await client.close().catch(() => {});
    }
  }
}

testManagement().catch(error => {
  console.error("Management test failed:", error.message);
  process.exitCode = 1;
});
