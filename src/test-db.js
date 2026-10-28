import "dotenv/config";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB_NAME || "nwf_inventory";

if (!uri) {
  console.error("MONGODB_URI is missing.");
  process.exit(1);
}

const client = new MongoClient(uri, {
  serverSelectionTimeoutMS: 10000
});

async function testDatabase() {
  let insertedId;

  try {
    await client.connect();

    const database = client.db(databaseName);
    const collection = database.collection("backend_connection_checks");

    // Insert a temporary test record.
    const inserted = await collection.insertOne({
      purpose: "Temporary NWF backend connection test",
      createdAt: new Date()
    });

    insertedId = inserted.insertedId;

    // Read the record back.
    const found = await collection.findOne({
      _id: insertedId
    });

    if (!found) {
      throw new Error("The test record could not be read.");
    }

    console.log("INSERT: Passed");
    console.log("READ: Passed");

    // Delete only the record created by this test.
    const deleted = await collection.deleteOne({
      _id: insertedId
    });

    if (deleted.deletedCount !== 1) {
      throw new Error("The test record could not be deleted.");
    }

    insertedId = undefined;
    console.log("DELETE: Passed");
    console.log("MongoDB read/write test successful.");
  } catch (error) {
    console.error("Database test failed.");
    console.error("Error type:", error.name);
    process.exitCode = 1;
  } finally {
    // Clean up our own test record if an earlier operation failed.
    if (insertedId) {
      try {
        await client.db(databaseName)
          .collection("backend_connection_checks")
          .deleteOne({ _id: insertedId });
      } catch {
        console.error("Cleanup failed; check the test collection later.");
      }
    }

    await client.close().catch(() => {});
  }
}

testDatabase();
