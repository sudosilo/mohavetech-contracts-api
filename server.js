import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import { pool, setupDatabase } from "./db.js";

const app = express();
app.use(express.json({ limit: "100kb" }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PATCH"],
    allowedHeaders: ["Content-Type", "X-Edit-Token"],
  })
);

const FIELD_LIMITS = {
  contract_type: 100,
  custom_type: 100,
  party_a_name: 200,
  party_a_email: 320,
  party_b_name: 200,
  party_b_email: 320,
  terms: 20000,
};

const DRAFT_COLUMNS =
  "id, to_char(created_date, 'YYYY-MM-DD') AS date, status, contract_type, custom_type, " +
  "party_a_name, party_a_email, party_b_name, party_b_email, terms, updated_at";

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function tokenMatches(token, storedHash) {
  if (typeof token !== "string" || !storedHash) return false;
  const given = Buffer.from(hashToken(token), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return given.length === stored.length && crypto.timingSafeEqual(given, stored);
}

function readFields(body) {
  const fields = {};
  for (const [name, max] of Object.entries(FIELD_LIMITS)) {
    const value = body ? body[name] : undefined;
    if (value === undefined) continue;
    if (typeof value !== "string") return { error: `${name} must be text` };
    if (value.length > max) return { error: `${name} is longer than ${max} characters` };
    fields[name] = value;
  }
  return { fields };
}

async function editTokenIsValid(req) {
  const { rows } = await pool.query("SELECT edit_token_hash FROM contracts WHERE id = $1", [
    req.params.id,
  ]);
  return rows.length > 0 && tokenMatches(req.get("X-Edit-Token"), rows[0].edit_token_hash);
}

const wrap = (handler) => (req, res, next) => handler(req, res).catch(next);

app.get(
  "/health",
  wrap(async (req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true, database: "connected" });
    } catch {
      res.status(500).json({ ok: false, database: "unreachable" });
    }
  })
);

app.post(
  "/contracts",
  wrap(async (req, res) => {
    const { fields, error } = readFields(req.body);
    if (error) return res.status(400).json({ error });

    const id = randomToken(12);
    const editToken = randomToken(24);
    const columns = ["id", "edit_token_hash", ...Object.keys(fields)];
    const values = [id, hashToken(editToken), ...Object.values(fields)];
    const slots = columns.map((_, i) => `$${i + 1}`).join(", ");

    const { rows } = await pool.query(
      `INSERT INTO contracts (${columns.join(", ")}) VALUES (${slots}) ` +
        "RETURNING to_char(created_date, 'YYYY-MM-DD') AS date",
      values
    );
    res.status(201).json({ id, date: rows[0].date, editToken });
  })
);

app.get(
  "/contracts/:id/draft",
  wrap(async (req, res) => {
    if (!(await editTokenIsValid(req))) return res.status(404).json({ error: "not found" });
    const { rows } = await pool.query(`SELECT ${DRAFT_COLUMNS} FROM contracts WHERE id = $1`, [
      req.params.id,
    ]);
    res.json(rows[0]);
  })
);

app.patch(
  "/contracts/:id/draft",
  wrap(async (req, res) => {
    if (!(await editTokenIsValid(req))) return res.status(404).json({ error: "not found" });
    const { fields, error } = readFields(req.body);
    if (error) return res.status(400).json({ error });
    const names = Object.keys(fields);
    if (names.length === 0) return res.status(400).json({ error: "nothing to update" });

    const assignments = names.map((name, i) => `${name} = $${i + 2}`).join(", ");
    const { rows } = await pool.query(
      `UPDATE contracts SET ${assignments}, updated_at = now() ` +
        `WHERE id = $1 AND status = 'drafting' RETURNING ${DRAFT_COLUMNS}`,
      [req.params.id, ...Object.values(fields)]
    );
    if (rows.length === 0) return res.status(409).json({ error: "this draft is locked" });
    res.json(rows[0]);
  })
);

app.use((req, res) => res.status(404).json({ error: "not found" }));

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid JSON" });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "request too large" });
  console.error(err);
  res.status(500).json({ error: "server error" });
});

const port = Number(process.env.PORT) || 8080;

setupDatabase()
  .then(() => app.listen(port, () => console.log(`listening on ${port}`)))
  .catch((err) => {
    console.error("database setup failed", err);
    process.exit(1);
  });
