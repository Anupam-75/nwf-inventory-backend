import "dotenv/config";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB_NAME || "nwf_inventory";
const productId = `NWF-INV-TEST-${Date.now()}`;
const adminPassword = process.env.NWF_ADMIN_PASSWORD;

async function testStockReceipt() {
  if (!uri || !adminPassword) {
    throw new Error("Required environment variables are missing.");
  }

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000
  });

  let productCreated = false;

  try {
    await client.connect();

    const db = client.db(databaseName);
    const products = db.collection("products");

    // Create an isolated temporary test product.
    await products.insertOne({
      product_id: productId,
      supplier_name: "Temporary Test Supplier",
      cost_price: 100,
      sale_price: 300,
      photo: null,
      category: "Test",
      subcategory: "Temporary Stock Test",
      stall_number: "TEST",
      quantity: 5,
      active: true,
      test_record: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    productCreated = true;
    console.log("TEMPORARY PRODUCT CREATED: Passed");

    // Authenticate as the Main Admin.
    const loginResponse = await fetch(
      "http://127.0.0.1:3000/api/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          loginId: "ANUPAM",
          password: adminPassword
        })
      }
    );

    const login = await loginResponse.json();

    if (!loginResponse.ok || !login.token) {
      throw new Error("Main Admin login failed.");
    }

    console.log("MAIN ADMIN LOGIN: Passed");

    // Receive three units through the API.
    const receiptResponse = await fetch(
      "http://127.0.0.1:3000/api/inventory/receive",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${login.token}`
        },
        body: JSON.stringify({
          product_id: productId,
          quantity_received: 3,
          supplier_name: "Temporary Test Supplier",
          stall_number: "TEST",
          unit_cost: 120
        })
      }
    );

    const receiptResult = await receiptResponse.json();

    if (!receiptResponse.ok) {
      throw new Error(
        `Receipt failed (HTTP ${receiptResponse.status}): ` +
        (receiptResult.error || "Unknown error")
      );
    }

    if (receiptResult.available_quantity !== 8) {
      throw new Error("The API returned an unexpected stock quantity.");
    }

    console.log("STOCK RECEIPT API: Passed");

    const product = await products.findOne({
      product_id: productId
    });

    if (!product || product.quantity !== 8) {
      throw new Error("Saved product quantity was not 8.");
    }

    if (product.cost_price !== 120) {
      throw new Error("Main Admin cost-price update failed.");
    }

    console.log("DATABASE QUANTITY UPDATED: Passed");
    console.log("MAIN ADMIN COST UPDATE: Passed");

    const receiptCount = await db
      .collection("stock_receipts")
      .countDocuments({ product_id: productId });

    if (receiptCount !== 1) {
      throw new Error("Expected exactly one stock receipt.");
    }

    console.log("STOCK RECEIPT HISTORY: Passed");

    const activityCount = await db
      .collection("activity_logs")
      .countDocuments({
        description: { $regex: productId }
      });

    if (activityCount < 1) {
      throw new Error("Stock receipt activity was not found.");
    }

    console.log("ACTIVITY LOG ENTRY: Passed");
  } finally {
    try {
      if (productCreated) {
        const db = client.db(databaseName);

        // Delete only records associated with this unique test ID.
        await db.collection("products").deleteOne({
          product_id: productId,
          test_record: true
        });

        await db.collection("stock_receipts").deleteMany({
          product_id: productId
        });

        await db.collection("activity_logs").deleteMany({
          description: { $regex: productId }
        });

        console.log("TEMPORARY TEST RECORDS REMOVED");
      }
    } finally {
      await client.close().catch(() => {});
    }
  }
}

testStockReceipt().catch((error) => {
  console.error("Inventory test failed:", error.message);
  process.exitCode = 1;
});
