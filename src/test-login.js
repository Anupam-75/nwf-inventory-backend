import "dotenv/config";

const password = process.env.NWF_ADMIN_PASSWORD;

async function testLogin() {
  if (!password) {
    throw new Error("Password was not provided securely.");
  }

  const response = await fetch("http://127.0.0.1:3000/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      loginId: "ANUPAM",
      password
    })
  });

  const data = await response.json();

  if (!response.ok || !data.token) {
    console.error("LOGIN: Failed");
    console.error("HTTP status:", response.status);
    console.error("Reason:", data.error || "Authentication failed");
    process.exitCode = 1;
    return;
  }

  console.log("LOGIN: Passed");
  console.log("ROLE:", data.user.role);
  console.log("TOKEN: Received (value hidden)");

  const profileResponse = await fetch(
    "http://127.0.0.1:3000/api/auth/me",
    {
      headers: {
        Authorization: `Bearer ${data.token}`
      }
    }
  );

  const profile = await profileResponse.json();

  if (!profileResponse.ok) {
    console.error("TOKEN VERIFICATION: Failed");
    console.error("HTTP status:", profileResponse.status);
    process.exitCode = 1;
    return;
  }

  console.log("TOKEN VERIFICATION: Passed");
  console.log("USER:", profile.user.loginId);
}

testLogin().catch(() => {
  console.error("Test could not complete. Check the server and try again.");
  process.exitCode = 1;
});
