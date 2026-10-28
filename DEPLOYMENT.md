# NWF Inventory — Production Security Patch and Deployment Guide

This patch is a preparation step, not a declaration that the app is production-ready.
Apply it to a backed-up copy of your existing projects, build and test locally, and
complete the deployment gates below before using the app for real business records.

## What the backend patch changes

- Reads the hosting platform's `PORT` and supports `HOST=0.0.0.0` in production.
- Supports an explicit trusted proxy hop count (`TRUST_PROXY_HOPS`) for the hosting reverse proxy.
- Fails at startup when `MONGODB_URI` is missing or `JWT_SECRET` is absent/too short.
- Protects `/db-health` behind Main Admin authentication and stops revealing the database name.
- Registers the inventory router once, returns generic JSON for unknown routes/errors, and handles `SIGTERM`.
- Pins a documented Node.js range and adds a syntax-check script.
- Adds Render configuration using secret environment variables rather than committed secrets.

## What the Android patch changes

- Uses `http://10.0.2.2:3000` only for debug builds.
- Requires `NWF_API_BASE_URL` to be a valid HTTPS URL for a release build. A release build without that URL is intentionally blocked.
- Disables cleartext traffic and Android backup in the main/release manifest; the existing debug manifest can still allow emulator HTTP.
- Removes hardcoded demo account passwords and hardcoded demo product defaults.
- Encrypts the local cache using AES-GCM with an Android Keystore key and migrates existing plaintext cache on next app start. Account passwords are no longer read or stored in the local cache.

## Apply backend files

1. Back up your backend project before replacing anything.
2. Extract `NWF-backend-production-patch.zip` into `~/nwf-inventory-backend`, keeping the archive's folder paths.
3. Run:

   ```bash
   cd ~/nwf-inventory-backend
   npm test
   npm audit --omit=dev
   ```

4. `npm test` checks JavaScript syntax. `npm audit --omit=dev` must complete on a working network; resolve any high/critical production findings before deploying. Do not use `npm audit fix --force` blindly.
5. Keep your real `.env` file. This patch does not replace or contain it. Confirm `.env` remains ignored by Git (`git check-ignore -v .env`).
6. Start the local backend with `npm run dev`; confirm MongoDB connects and test login, product search, inventory receiving, sales, approvals, staff management, suppliers, purchases, expenses, reports, and activity.

## Apply Android files

1. Back up your Android project and extract `NWF-android-production-security-patch.zip` into `~/AndroidStudioProjects/NWFInventory`.
2. Run:

   ```bash
   cd ~/AndroidStudioProjects/NWFInventory
   ./gradlew assembleDebug
   ```

3. Install and test the debug app against the local backend. The emulator URL remains `http://10.0.2.2:3000`.
4. Check the encrypted-cache migration by launching the updated app. Existing cached business data should still load if readable; it will be rewritten encrypted. Demo login credentials are no longer a valid login route—sign-in must use active MongoDB accounts.
5. Do not build a release until the hosted HTTPS API is deployed and working. After deployment, use the service URL without a trailing slash:

   ```bash
   ./gradlew assembleRelease -PNWF_API_BASE_URL=https://YOUR-SERVICE.onrender.com
   ```

   Replace the placeholder with your actual HTTPS API host. The release build task is intentionally configured to fail if no HTTPS URL is provided.

## Deploy backend to Render

The included `render.yaml` uses a paid `starter` web service so it does not spin down on idle. Review the plan and cost in Render before creating it; do not confirm a paid service unless you approve the charge.

1. Use a **private** Git repository. Never add `.env`, secret files, database dumps, Android signing keys, or passwords to Git.
2. Commit the backend project with `render.yaml` at the repository root.
3. Create/import the Render Blueprint, inspect the proposed service and plan, then deploy.
4. Add `MONGODB_URI` in Render's Environment screen using your existing Atlas connection string. Never put it in `render.yaml` or source code.
5. Render generates a new `JWT_SECRET` for production. Keep production's secret separate from local development's secret.
6. Confirm `NODE_ENV=production`, `HOST=0.0.0.0`, `TRUST_PROXY_HOPS=1`, and `MONGODB_DB_NAME=nwf_inventory`. Render supplies `PORT`.
7. Review Render's outbound IP information for the service, then add the required service egress addresses to the Atlas IP access list. Do not use `0.0.0.0/0`. Keep your current development IP entry until local development is no longer needed.
8. In Atlas, confirm `nwf_app_user` can access only the `nwf_inventory` database with the minimum permissions required by the app. Do not use an Atlas project-owner credential as the application user.
9. Check `https://YOUR-SERVICE.onrender.com/health`. It should return a generic successful status without database details.
10. Sign in through Android and test all workflows again against the deployed backend before releasing to staff.

## Backup and launch gates

- Take a backup of the current Atlas data before the production cutover. Free Atlas clusters do not provide Atlas Cloud Backups; use a tested `mongodump`/`mongorestore` or export workflow if applicable.
- Test that you can restore a backup before relying on it.
- Run `npm audit --omit=dev` from a network-enabled environment. The patch authoring environment could not reach the npm audit registry due to DNS/network failure, so this check is still outstanding.
- Build the Android debug app and test all connected features; then build release with the actual HTTPS URL.
- Verify Staff cannot access Admin-only functions, the Main Admin cannot be deactivated or demoted, and expired/inactive sessions are rejected.
- Confirm backups, restore procedure, logs, and account recovery are understood before real sales use.

## Important limitations

- The source review archive did not contain the full Android project/Gradle wrapper, so the Android Gradle build cannot be confirmed here. Run it on your Mac.
- This patch does not configure a custom domain, object storage for product photos, website CORS, automated security monitoring, or a tested backup schedule.
- A deployment can still fail if the Atlas network access list does not allow the Render service or the environment variables are missing/mistyped.
