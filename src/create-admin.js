import "dotenv/config";
import bcrypt from "bcryptjs";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB_NAME || "nwf_inventory";

const loginId = "ANUPAM";
const displayName = "Anupam";

if (!uri) {
  console.error("MONGODB_URI is missing from .env.");
  process.exit(1);
}

async function createAdmin() {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000
  });

  try {
    const password = process.env.NWF_ADMIN_PASSWORD;

    if (!password || password.length < 12) {
      throw new Error(
        "Admin password must be at least 12 characters."
      );
    }

    await client.connect();

    const db = client.db(databaseName);
    const users = db.collection("users");

    // Prevent duplicate login IDs and admin accounts.
    await users.createIndex({ loginId: 1 }, { unique: true });

    const existingAdmin = await users.findOne({
      role: "MAIN_ADMIN"
    });

    if (existingAdmin) {
      throw new Error(
        "A Main Admin already exists. No changes were made."
      );
    }

    const existingUser = await users.findOne({ loginId });

    if (existingUser) {
      throw new Error(
        "The login ID ANUPAM already exists. No changes were made."
      );
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await users.insertOne({
      loginId,
      name: displayName,
      role: "MAIN_ADMIN",
      passwordHash,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    console.log("Main Admin account created successfully.");
    console.log("Login ID: ANUPAM");
    console.log("Role: MAIN_ADMIN");
    console.log("Password stored as a bcrypt hash.");
    console.log("Keep your password private.");
  } catch (error) {
    console.error("Admin setup failed:", error.message);
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}

createAdmin();
