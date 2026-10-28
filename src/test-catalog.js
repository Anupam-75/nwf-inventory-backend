import "dotenv/config";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB_NAME || "nwf_inventory";
const testId = `NWF-API-TEST-${Date.now()}`;

if (!uri) {
  console.error("MONGODB_URI is missing.");
  process.exit(1);
}

const client = new MongoClient(uri, {
  serverSelectionTimeoutMS: 10000
});

async function testCatalog() {
  let inserted = false;

  try {
    await client.connect();

    const collection = client
      .db(databaseName)
      .collection("products");

    await collection.insertOne({
      product_id: testId,
      supplier_name: "Temporary Test Supplier",
      sale_price: 799,
      photo: null,
      category: "Test Category",
      subcategory: "Test Product",
      stall_number: "TEST",
      quantity: 5,
      active: true,
      test_record: true
    });

    inserted = true;
    console.log("Temporary test product created.");

    const response = await fetch(
      `http://127.0.0.1:3000/api/catalog/products/${encodeURIComponent(testId)}`
    );

    const result = await response.json();

    if (!response.ok || result.product?.product_id !== testId) {
      throw new Error("The catalogue API did not return the test product.");
    }

    if ("cost_price" in result.product) {
      throw new Error("The public API exposed a cost price.");
    }

    console.log("PRODUCT LOOKUP: Passed");
    console.log("QUANTITY:", result.product.quantity);
    console.log("COST PRICE HIDDEN: Passed");
  } catch (error) {
    console.error("Catalogue test failed:", error.message);
    process.exitCode = 1;
  } finally {
    try {
      if (inserted) {
        const cleanup = await client
          .db(databaseName)
          .collection("products")
          .deleteOne({
            product_id: testId,
            test_record: true
          });

        console.log(
          cleanup.deletedCount === 1
            ? "TEMPORARY TEST RECORD REMOVED"
            : "Warning: Check whether the temporary record remains."
        );
      }
    } catch {
      console.error("Cleanup failed; check the temporary test record.");
      process.exitCode = 1;
    }

    await client.close().catch(() => {});
  }
}

testCatalog();
