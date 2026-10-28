import "dotenv/config";

const password = process.env.NWF_ADMIN_PASSWORD;

async function testUsers() {
  if (!password) {
    throw new Error("Password was not provided securely.");
  }

  const loginResponse = await fetch(
    "http://127.0.0.1:3000/api/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loginId: "ANUPAM",
        password
      })
    }
  );

  const login = await loginResponse.json();

  if (!loginResponse.ok || !login.token) {
    throw new Error("Main Admin login failed.");
  }

  console.log("MAIN ADMIN LOGIN: Passed");

  const response = await fetch(
    "http://127.0.0.1:3000/api/users",
    {
      headers: {
        Authorization: `Bearer ${login.token}`
      }
    }
  );

  const data = await response.json();

  if (!response.ok || !Array.isArray(data.accounts)) {
    throw new Error(
      `Account list failed with HTTP ${response.status}.`
    );
  }

  console.log("ACCOUNT LIST: Passed");
  console.log(
    "MAIN ADMIN ACCOUNT FOUND:",
    data.accounts.some(account => account.loginId === "ANUPAM")
  );

  const sensitiveFieldsExposed = data.accounts.some(
    account =>
      Object.hasOwn(account, "password") ||
      Object.hasOwn(account, "passwordHash")
  );

  if (sensitiveFieldsExposed) {
    throw new Error("Sensitive account fields were exposed.");
  }

  console.log("PASSWORD HASHES HIDDEN: Passed");
  console.log("ACCOUNTS RETURNED:", data.accounts.length);
}

testUsers().catch(error => {
  console.error("User-management test failed:", error.message);
  process.exitCode = 1;
});
