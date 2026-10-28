import "dotenv/config";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB_NAME || "nwf_inventory";
const password = process.env.NWF_ADMIN_PASSWORD;
const suffix = Date.now().toString();

const productId = `NWF-OPS-TEST-${suffix}`;
const supplierName = `Temporary Supplier ${suffix}`;
const reference = `NWF-OPS-REF-${suffix}`;

const client = new MongoClient(uri || "", {
  serverSelectionTimeoutMS: 10000
});

let connected = false;
let productInsertedId = null;
let supplierCreated = false;
let purchaseCreated = false;

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

async function jsonResponse(response) {
  return {
    status: response.status,
    data: await response.json()
  };
}

async function testOperations() {
  if (!uri || !password) {
    throw new Error("Required environment variables are missing.");
  }

  try {
    await client.connect();
    connected = true;

    const db = client.db(databaseName);

    const loginResponse = await api("/api/auth/login", null, {
      method: "POST",
      body: JSON.stringify({
        loginId: "ANUPAM",
        password
      })
    });

    const login = await jsonResponse(loginResponse);

    if (login.status !== 200 || !login.data.token) {
      throw new Error("Main Admin login failed.");
    }

    const token = login.data.token;
    console.log("MAIN ADMIN LOGIN: Passed");

    // Create a uniquely named temporary supplier through the API.
    const supplierResponse = await api(
      "/api/operations/suppliers",
      token,
      {
        method: "POST",
        body: JSON.stringify({
          name: supplierName,
          contactPerson: "Temporary Test",
          phone: "",
          notes: "Temporary automated test"
        })
      }
    );

    const supplier = await jsonResponse(supplierResponse);

    if (supplier.status !== 201) {
      throw new Error(
        `Supplier creation failed (HTTP ${supplier.status}): ` +
        (supplier.data.error || "Unknown error")
      );
    }

    supplierCreated = true;
    console.log("SUPPLIER CREATION: Passed");

    const listResponse = await api(
      "/api/operations/suppliers",
      token
    );

    const supplierList = await jsonResponse(listResponse);

    if (
      supplierList.status !== 200 ||
      !supplierList.data.suppliers?.some(
        item => item.name === supplierName
      )
    ) {
      throw new Error("The temporary supplier was not found in the list.");
    }

    console.log("SUPPLIER LIST: Passed");

    // Insert only a temporary product directly into the database.
    const products = db.collection("products");

    const insertResult = await products.insertOne({
      product_id: productId,
      supplier_name: supplierName,
      cost_price: 100,
      sale_price: 300,
      photo: null,
      category: "Test",
      subcategory: "Temporary Purchase Test",
      stall_number: "TEST",
      quantity: 4,
      active: true,
      test_record: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    productInsertedId = insertResult.insertedId;
    console.log("TEMPORARY PRODUCT CREATED: Passed");

    // Record purchase history. This must not change stock.
    const purchaseResponse = await api(
      "/api/operations/purchases",
      token,
      {
        method: "POST",
        body: JSON.stringify({
          product_id: productId,
          supplier_name: supplierName,
          quantity: 3,
          unit_cost: 125,
          stall_number: "TEST",
          reference
        })
      }
    );

    const purchase = await jsonResponse(purchaseResponse);

    if (purchase.status !== 201) {
      throw new Error(
        `Purchase recording failed (HTTP ${purchase.status}): ` +
        (purchase.data.error || "Unknown error")
      );
    }

    purchaseCreated = true;
    console.log("PURCHASE RECORDING: Passed");

    const purchaseListResponse = await api(
      "/api/operations/purchases",
      token
    );

    const purchaseList = await jsonResponse(purchaseListResponse);

    if (
      purchaseList.status !== 200 ||
      !purchaseList.data.purchases?.some(
        item => item.reference === reference
      )
    ) {
      throw new Error("The saved purchase was not found in history.");
    }

    console.log("PURCHASE HISTORY: Passed");

    const product = await products.findOne({
      _id: productInsertedId
    });

    if (product?.quantity !== 4) {
      throw new Error("Recording a purchase unexpectedly changed stock.");
    }

    console.log("PURCHASE DOES NOT CHANGE STOCK: Passed");
  } finally {
    if (connected) {
      const db = client.db(databaseName);

      try {
        if (purchaseCreated) {
          await db.collection("purchases").deleteMany({
            product_id: productId,
            reference
          });
        }

        await db.collection("activity_logs").deleteMany({
          $or: [
            {
              type: "SUPPLIER_ADDED",
              description: `Added supplier ${supplierName}.`
            },
            {
              type: "PURCHASE_RECORDED",
              description:
                `Recorded purchase of 3 unit(s) of ${productId} from ${supplierName}.`
            }
          ]
        });

        if (supplierCreated) {
          await db.collection("suppliers").deleteMany({
            nameKey: supplierName.toLocaleLowerCase("en-US")
          });
        }

        if (productInsertedId) {
          await db.collection("products").deleteOne({
            _id: productInsertedId,
            test_record: true
          });
        }

        console.log("TEMPORARY TEST DATA CLEANUP FINISHED");
      } catch {
        console.error(
          "WARNING: Cleanup failed. Check the temporary test records before continuing."
        );
        process.exitCode = 1;
      } finally {
        await client.close().catch(() => {});
      }
    }
  }
}

testOperations().catch(error => {
  console.error("Operations test failed:", error.message);
  process.exitCode = 1;
});
