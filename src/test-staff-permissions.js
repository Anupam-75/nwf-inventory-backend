import "dotenv/config";
import { randomBytes } from "node:crypto";

const adminPassword = process.env.NWF_ADMIN_PASSWORD;
const tempLoginId = `NWFTEST${Date.now()}`;
const tempPassword = randomBytes(32).toString("hex");

async function request(path, options = {}) {
  return fetch(`http://127.0.0.1:3000${path}`, options);
}

async function testStaffPermissions() {
  if (!adminPassword) {
    throw new Error("Main Admin password was not provided.");
  }

  let adminToken;
  let temporaryAccountCreated = false;

  try {
    const loginResponse = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loginId: "ANUPAM",
        password: adminPassword
      })
    });

    const admin = await loginResponse.json();

    if (!loginResponse.ok || !admin.token) {
      throw new Error("Main Admin login failed.");
    }

    adminToken = admin.token;
    console.log("MAIN ADMIN LOGIN: Passed");

    const createResponse = await request("/api/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        loginId: tempLoginId,
        name: "Temporary Permission Test",
        password: tempPassword,
        role: "STAFF"
      })
    });

    const created = await createResponse.json();

    if (!createResponse.ok) {
      throw new Error(
        `Temporary staff creation failed (HTTP ${createResponse.status}): ` +
        (created.error || "Unknown error")
      );
    }

    temporaryAccountCreated = true;
    console.log("TEMPORARY STAFF ACCOUNT: Created");

    const staffLoginResponse = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loginId: tempLoginId,
        password: tempPassword
      })
    });

    const staffLogin = await staffLoginResponse.json();

    if (!staffLoginResponse.ok || !staffLogin.token) {
      throw new Error("Temporary Staff login failed.");
    }

    console.log("STAFF LOGIN: Passed");

    const usersResponse = await request("/api/users", {
      headers: {
        Authorization: `Bearer ${staffLogin.token}`
      }
    });

    const usersResult = await usersResponse.json();

    if (usersResponse.status !== 403) {
      throw new Error(
        `Expected Staff access to be denied; received HTTP ${usersResponse.status}.`
      );
    }

    console.log("STAFF BLOCKED FROM ACCOUNT MANAGEMENT: Passed");
  } finally {
    if (temporaryAccountCreated && adminToken) {
      const cleanupResponse = await request(
        `/api/users/${encodeURIComponent(tempLoginId)}/deactivate`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`
          }
        }
      );

      if (!cleanupResponse.ok) {
        console.error(
          "WARNING: Temporary account deactivation failed. " +
          "Check the account in Atlas before continuing."
        );
        throw new Error("Temporary account cleanup failed.");
      }

      console.log("TEMPORARY STAFF ACCOUNT DEACTIVATED");
    }
  }
}

testStaffPermissions().catch((error) => {
  console.error("Permission test failed:", error.message);
  process.exitCode = 1;
});
