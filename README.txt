NWF Inventory backend - Android POST route aliases

Replace only src/user-routes.js. This keeps the existing PATCH endpoints and adds POST aliases for:
- POST /api/users/:loginId/role
- POST /api/users/:loginId/deactivate

The aliases reuse the same authenticated handlers and Main Admin safeguards as PATCH. No .env file, database URI, password, or JWT secret is included.

Apply from your backend root (assuming ZIP is in Downloads):
  cd ~/nwf-inventory-backend
  cp src/user-routes.js "$HOME/Desktop/user-routes.js.backup"
  unzip -o "$HOME/Downloads/NWF-staff-backend-post-alias.zip" -d .
  node --check src/user-routes.js
  npm run dev

Keep the backend terminal open and confirm MongoDB connects before launching the Android app.
