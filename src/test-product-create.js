import "dotenv/config";
import { MongoClient } from "mongodb";

const password = process.env.NWF_ADMIN_PASSWORD;
const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB_NAME || "nwf_inventory";
const productId = `NWF-TEST-${Date.now()}`;

async function testProductCreation() {
  if (!password || !uri) {
    throw new Error("Required environment variables are missing.");
  }

  const loginResponse = await fetch(
    "http://127.0.0.1:3000/api/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId: "ANUPAM", password })
    }
  );

  const login = await loginResponse.json();

  if (!loginResponse.ok || !login.token) {
    throw new Error("Admin login failed.");
  }

  console.log("ADMIN LOGIN: Passed");

  let created = false;

  try {
    const response = await fetch(
      "http://127.0.0.1:3000/api/products",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${login.token}`
        },
        body: JSON.stringify({
          product_id: productId,
          supplier_name: "Temporary Test Supplier",
          sale_price: 799,
          cost_price: 350,
          photo: null,
          category: "Test",
          subcategory: "Temporary Product",
          stall_number: "TEST",
          quantity: 2
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        `Product creation failed (HTTP ${response.status}): ` +
        (result.error || "Unknown error")
      );
    }

    created = true;

    if (result.product?.cost_price !== 350) {
      throw new Error("Main Admin cost-price handling failed.");
    }

    console.log("PRODUCT CREATION: Passed");
    console.log("MAIN ADMIN COST PRICE: Passed");

    const lookupResponse = await fetch(
      `http://127.0.0.1:3000/api/catalog/products/${encodeURIComponent(productId)}`
    );

    const lookup = await lookupResponse.json();

    if (
      !lookupResponse.ok ||
      lookup.product?.product_id !== productId
    ) {
      throw new Error("Product lookup failed.");
    }

    if ("cost_price" in lookup.product) {
      throw new Error("Public catalogue exposed the cost price.");
    }

    console.log("PUBLIC CATALOGUE LOOKUP: Passed");
    console.log("PUBLIC COST PRICE HIDDEN: Passed");
  } finally {
    if (created) {
      const client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 10000
      });

      try {
        await client.connect();

        const cleanup = await client
          .db(databaseName)
          .collection("products")
          .deleteOne({
            product_id: productId,
            supplier_name: "Temporary Test Supplier",
            category: "Test",
            subcategory: "Temporary Product",
            stall_number: "TEST"
          });

        if (cleanup.deletedCount !== 1) {
          throw new Error("Temporary product was not confirmed removed.");
        }

        console.log("TEMPORARY TEST PRODUCT REMOVED");
      } finally {
        await client.close().catch(() => {});
      }
    }
  }
}

testProductCreation().catch((error) => {
  console.error("Test failed:", error.message);
  process.exitCode = 1;
});
