const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(fs.readFileSync(path.join(__dirname, "index.html")));
    }

    if (req.method === "GET" && url.pathname === "/api/report") {
      const r = await pool.query("SELECT payload FROM report WHERE id = 1");
      return json(res, 200, r.rows[0] ? r.rows[0].payload : { garages: null });
    }

    if (req.method === "PUT" && url.pathname === "/api/report") {
      const key = process.env.UPLOAD_KEY || "";
      if (key && req.headers["x-upload-key"] !== key) {
        return json(res, 401, { error: "Wrong upload key" });
      }
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
