import { createExpenseRouter } from "./expense-routes.js";
import { createReportsRouter } from "./reports-routes.js";
import { createManagementRouter } from "./management-routes.js";
import { createOperationsRouter } from "./operations-routes.js";
import { createSalesRouter } from "./sales-routes.js";
import "dotenv/config";
import express from "express";
import helmet from "helmet";
import { MongoClient } from "mongodb";
import { createAuthRouter, requireAuth } from "./auth.js";
import { createInventoryRouter } from "./inventory-routes.js";
import { createUserRouter } from "./user-routes.js";

const app = express();

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "100kb" }));

const port = Number(process.env.PORT || 3000);
const host =
  process.env.HOST ||
  (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
const mongoUri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB_NAME || "nwf_inventory";
const jwtSecret = process.env.JWT_SECRET;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("PORT must be a valid TCP port.");
  process.exit(1);
}

if (
  !Number.isInteger(trustProxyHops) ||
  trustProxyHops < 0 ||
  trustProxyHops > 5
) {
  console.error("TRUST_PROXY_HOPS must be an integer from 0 to 5.");
  process.exit(1);
}
app.set("trust proxy", trustProxyHops);

if (!mongoUri) {
  console.error("MONGODB_URI is missing from the environment.");
  process.exit(1);
}

if (typeof jwtSecret !== "string" || jwtSecret.length < 32) {
  console.error("JWT_SECRET must be set to a random value of at least 32 characters.");
  process.exit(1);
}

let httpServer;
let shuttingDown = false;

const client = new MongoClient(mongoUri, {
  serverSelectionTimeoutMS: 10000
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeExactFilter(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  return {
    $regex: `^${escapeRegex(value.trim())}$`,
    $options: "i"
  };
}

function validText(value, maxLength = 100) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength
  );
}

function validPrice(value, allowZero = false) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (allowZero ? value >= 0 : value > 0)
  );
}

async function startServer() {
  try {
    await client.connect();

    const db = client.db(databaseName);
    const products = db.collection("products");

    await db.command({ ping: 1 });

    await products.createIndex(
      { product_id: 1 },
      {
        unique: true,
        collation: { locale: "en", strength: 2 }
      }
    );

    app.get("/health", (_req, res) => {
      res.status(200).json({
        status: "ok",
        service: "NWF Inventory API"
      });
    });

    // Detailed database readiness is restricted to the Main Admin.
    // The hosting provider should use the public, non-sensitive /health route.
    app.get("/db-health", requireAuth(db), async (req, res) => {
      if (req.authUser.role !== "MAIN_ADMIN") {
        return res.status(403).json({ error: "Forbidden." });
      }

      try {
        await db.command({ ping: 1 });
        return res.status(200).json({
          status: "ok",
          database: "connected"
        });
      } catch {
        return res.status(503).json({
          status: "error",
          database: "unavailable"
        });
      }
    });

    // API routers are registered once each.
    app.use("/api/auth", createAuthRouter(db));
    app.use("/api/users", createUserRouter(db));
    app.use("/api/inventory", createInventoryRouter(db, client));
    app.use("/api/operations", createOperationsRouter(db));
    app.use("/api/sales", createSalesRouter(db, client));
    app.use("/api/expenses", createExpenseRouter(db, client));
    app.use("/api/reports", createReportsRouter(db));
    app.use("/api/management", createManagementRouter(db));
    // Create products: Main Admin and Co-admin only.
    app.post(
      "/api/products",
requireAuth(db),
      async (req, res) => {
        const user = req.authUser;

        if (!["MAIN_ADMIN", "CO_ADMIN"].includes(user.role)) {
          return res.status(403).json({
            error: "You are not allowed to add products."
          });
        }

        const body = req.body ?? {};

        const requiredFields = [
          "product_id",
          "supplier_name",
          "category",
          "subcategory",
          "stall_number"
        ];

        for (const field of requiredFields) {
          if (!validText(body[field], 100)) {
            return res.status(400).json({
              error: `A valid ${field} is required.`
            });
          }
        }

        if (!/^[A-Za-z0-9_-]{1,64}$/.test(body.product_id.trim())) {
          return res.status(400).json({
            error: "Invalid product ID."
          });
        }

        if (!validPrice(body.sale_price)) {
          return res.status(400).json({
            error: "sale_price must be a positive minimum selling price."
          });
        }

        if (
          !Number.isSafeInteger(body.quantity) ||
          body.quantity < 0
        ) {
          return res.status(400).json({
            error: "Quantity must be a non-negative whole number."
          });
        }

        if (
          body.photo !== undefined &&
          body.photo !== null &&
          (typeof body.photo !== "string" || body.photo.length > 2000)
        ) {
          return res.status(400).json({
            error: "Invalid photo reference."
          });
        }

        if (
          user.role !== "MAIN_ADMIN" &&
          Object.hasOwn(body, "cost_price")
        ) {
          return res.status(403).json({
            error: "Only the Main Admin may provide a cost price."
          });
        }

        if (
          user.role === "MAIN_ADMIN" &&
          body.cost_price !== undefined &&
          body.cost_price !== null &&
          !validPrice(body.cost_price, true)
        ) {
          return res.status(400).json({
            error: "Cost price must be zero or greater."
          });
        }

        const product = {
          product_id: body.product_id.trim().toUpperCase(),
          supplier_name: body.supplier_name.trim(),
          sale_price: body.sale_price,
          photo: body.photo?.trim() || null,
          category: body.category.trim(),
          subcategory: body.subcategory.trim(),
          stall_number: body.stall_number.trim(),
          quantity: body.quantity,
          active: true,
          createdBy: user.loginId,
          createdAt: new Date(),
          updatedAt: new Date()
        };

        if (
          user.role === "MAIN_ADMIN" &&
          body.cost_price !== undefined
        ) {
          product.cost_price = body.cost_price;
        }

        try {
          await products.insertOne(product);

          const responseProduct = { ...product };

          if (user.role !== "MAIN_ADMIN") {
            delete responseProduct.cost_price;
          }

          return res.status(201).json({
            message: "Product created successfully.",
            product: responseProduct
          });
        } catch (error) {
          if (error.code === 11000) {
            return res.status(409).json({
              error: "That product ID already exists."
            });
          }

          return res.status(500).json({
            error: "Unable to create the product."
          });
        }
      }
    );

    // Public catalogue: cost and profit fields are excluded.
    app.get("/api/catalog/products", async (req, res) => {
      try {
        const filter = { active: { $ne: false } };

        const fields = [
          "product_id",
          "supplier_name",
          "category",
          "subcategory",
          "stall_number"
        ];

        for (const field of fields) {
          const value = req.query[field];

          if (value === undefined) continue;

          if (
            typeof value !== "string" ||
            value.length > 100
          ) {
            return res.status(400).json({
              error: `Invalid ${field} filter.`
            });
          }

          const exactFilter = makeExactFilter(value);

          if (exactFilter) filter[field] = exactFilter;
        }

        const foundProducts = await products
          .find(filter)
          .project({
            _id: 0,
            product_id: 1,
            supplier_name: 1,
            sale_price: 1,
            photo: 1,
            category: 1,
            subcategory: 1,
            stall_number: 1,
            quantity: 1,
            active: 1
          })
          .sort({ product_id: 1 })
          .limit(200)
          .toArray();

        return res.status(200).json({
          count: foundProducts.length,
          products: foundProducts
        });
      } catch {
        return res.status(500).json({
          error: "Unable to load the product catalogue."
        });
      }
    });

    // Public lookup by product ID.
    app.get(
      "/api/catalog/products/:productId",
      async (req, res) => {
        try {
          const productId = req.params.productId.trim();

          if (!productId || productId.length > 100) {
            return res.status(400).json({
              error: "Invalid product ID."
            });
          }

          const product = await products.findOne(
            {
              product_id: makeExactFilter(productId),
              active: { $ne: false }
            },
            {
              projection: {
                _id: 0,
                product_id: 1,
                supplier_name: 1,
                sale_price: 1,
                photo: 1,
                category: 1,
                subcategory: 1,
                stall_number: 1,
                quantity: 1,
                active: 1
              }
            }
          );

          if (!product) {
            return res.status(404).json({
              error: "Product not found."
            });
          }

          return res.status(200).json({ product });
        } catch {
          return res.status(500).json({
            error: "Unable to find the product."
          });
        }
      }
    );

    // Avoid exposing framework-generated HTML for missing API routes.
    app.use((_req, res) => {
      return res.status(404).json({ error: "Route not found." });
    });

    // Keep unexpected errors generic for clients; log only the error type.
    app.use((error, _req, res, next) => {
      if (res.headersSent) return next(error);

      if (error instanceof SyntaxError && Object.hasOwn(error, "body")) {
        return res.status(400).json({ error: "Invalid JSON request body." });
      }

      console.error("Unhandled request error:", error?.name || "Error");
      return res.status(500).json({ error: "Internal server error." });
    });

    httpServer = app.listen(port, host, () => {
      console.log("NWF Inventory API is running.");
      console.log(`Listening on ${host}:${port}`);
      console.log("MongoDB connection established.");
      console.log("Authentication and API routes registered.");
    });
} catch (error) {
  console.error("Could not start the backend.");
  console.error("Error type:", error?.name || "Error");
  console.error("Error code:", error?.code ?? "not provided");
  if (process.env.NODE_ENV !== "production") {
    console.error("Details:", error?.message || "No additional details.");
  }
  await client.close().catch(() => {});
  process.exit(1);
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down gracefully.`);

  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  await client.close().catch(() => {});
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

startServer();
