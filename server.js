const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

// Only the admin (you) can upload. Everyone else gets read-only access.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

// id 1 = latest report (what everyone sees), id 2 = the report before it (fallback).
async function init() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS report (id INT PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())"
  );
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const given = String(req.headers["x-admin-password"] || "");
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(fs.readFileSync(path.join(__dirname, "index.html")));
    }

    // Admin login check: returns ok only when the password is right.
    if (req.method === "POST" && url.pathname === "/api/login") {
      if (!ADMIN_PASSWORD) return json(res, 500, { error: "Admin password is not set on the server" });
      return json(res, isAdmin(req) ? 200 : 401, isAdmin(req) ? { ok: true } : { error: "Wrong password" });
    }

    // Everyone reads the latest report. If nothing newer exists, the previous one is shown.
    if (req.method === "GET" && url.pathname === "/api/report") {
      let r = await pool.query("SELECT payload FROM report WHERE id = 1");
      if (!r.rows[0]) r = await pool.query("SELECT payload FROM report WHERE id = 2");
      return json(res, 200, r.rows[0] ? r.rows[0].payload : { garages: null });
    }

    // Only the admin can upload. The current report moves to slot 2, the new one goes to slot 1.
    if (req.method === "PUT" && url.pathname === "/api/report") {
      if (!isAdmin(req)) return json(res, 401, { error: "Admin login needed" });
      let payload;
      try {
        payload = JSON.parse(await readBody(req, 5 * 1024 * 1024));
      } catch (e) {
        return json(res, 400, { error: "Could not read the report data" });
      }
      if (!payload || !Array.isArray(payload.garages) || payload.garages.length === 0) {
        return json(res, 400, { error: "No garage rows in the file" });
      }
      await pool.query(
        "INSERT INTO report (id, payload, updated_at) SELECT 2, payload, updated_at FROM report WHERE id = 1 ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at"
      );
      await pool.query(
        "INSERT INTO report (id, payload, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()",
        [JSON.stringify(payload)]
      );
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: "Server error" });
  }
});

const port = process.env.PORT || 10000;
init()
  .then(() => server.listen(port, () => console.log("Listening on " + port)))
  .catch((e) => { console.error("Database setup failed", e); process.exit(1); });
