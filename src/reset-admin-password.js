import "dotenv/config";
import bcrypt from "bcryptjs";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB_NAME || "nwf_inventory";
const password = process.env.NWF_ADMIN_PASSWORD;

async function resetPassword() {
  if (!uri) throw new Error("MONGODB_URI is missing.");
  if (!password || password.length < 12) {
    throw new Error("Choose a password with at least 12 characters.");
  }

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000
  });

  try {
    await client.connect();

    const result = await client
      .db(databaseName)
      .collection("users")
      .updateOne(
        { loginId: "ANUPAM", role: "MAIN_ADMIN" },
        {
          $set: {
            passwordHash: await bcrypt.hash(password, 12),
            updatedAt: new Date()
          }
        }
      );

    if (result.matchedCount !== 1) {
      throw new Error(
        "Main Admin account not found. No password was changed."
      );
    }

    console.log("Main Admin password updated successfully.");
  } finally {
    await client.close().catch(() => {});
  }
}

resetPassword().catch((error) => {
  console.error("Password reset failed:", error.message);
  process.exitCode = 1;
});
