import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import { pool, setupDatabase } from "./db.js";
import { redis } from "./redis.js";
import { assistReady, assistAllowed, cleanupTerms, draftTerms } from "./assist.js";
import { chainReady, chainName, walletStatus, writeHash } from "./chain.js";
import { newPin, normalizePin, hashPin, pinMatches, countAttempt, clearAttempts } from "./pin.js";

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "400kb" }));

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
    const result = {
      ok: true,
      database: "connected",
      redis: "connected",
      assist: assistReady() ? "ready" : "missing key",
      chain: chainReady() ? "ready" : "missing wallet",
    };
    try {
      await pool.query("SELECT 1");
    } catch {
      result.ok = false;
      result.database = "unreachable";
    }
    try {
      await redis.ping();
    } catch {
      result.ok = false;
      result.redis = "unreachable";
    }
    res.status(result.ok ? 200 : 500).json(result);
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
    const signed = await pool.query(
      "SELECT party, typed_name, signed_at FROM signatures WHERE contract_id = $1 ORDER BY party",
      [req.params.id]
    );
    res.json({ ...rows[0], signatures: signed.rows });
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

const RECORD_COLUMNS =
  "id, to_char(created_date, 'YYYY-MM-DD') AS date, status, chain, tx_hash, doc_hash, " +
  "block_number, gas_paid, notarized_at";

app.get(
  "/contracts/:id/record",
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT ${RECORD_COLUMNS} FROM contracts WHERE id = $1 AND status <> 'drafting'`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "not found" });
    res.json({ ...rows[0], contract_text: "locked, enter the pin from the card to view" });
  })
);

app.post(
  "/contracts/:id/unlock",
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      "SELECT pin_hash, to_char(created_date, 'YYYY-MM-DD') AS date, contract_type, custom_type, " +
        "party_a_name, party_b_name, terms, notarized_at FROM contracts WHERE id = $1",
      [req.params.id]
    );
    if (rows.length === 0 || !rows[0].pin_hash) return res.status(404).json({ error: "not found" });

    const attempt = await countAttempt(req.params.id);
    if (!attempt.allowed) {
      res.set("Retry-After", String(attempt.retryAfterSeconds));
      return res.status(429).json({
        error: "too many wrong pins, try again later",
        retry_after_seconds: attempt.retryAfterSeconds,
      });
    }

    const { pin_hash, ...contract } = rows[0];
    if (!(await pinMatches(normalizePin(req.body && req.body.pin), pin_hash))) {
      return res.status(403).json({ error: "wrong pin", tries_left: attempt.triesLeft });
    }

    await clearAttempts(req.params.id);
    const signed = await pool.query(
      "SELECT party, typed_name, signed_at, drawing FROM signatures WHERE contract_id = $1 ORDER BY party",
      [req.params.id]
    );
    res.json({ ...contract, signatures: signed.rows });
  })
);

function textField(body, name, max) {
  const value = body ? body[name] : undefined;
  if (value === undefined || value === "") return { value: "" };
  if (typeof value !== "string") return { error: `${name} must be text` };
  if (value.length > max) return { error: `${name} is longer than ${max} characters` };
  return { value };
}

async function runAssist(req, res, requiredField, requiredMax, work) {
  if (!assistReady()) return res.status(503).json({ error: "assistant is not configured" });
  const required = textField(req.body, requiredField, requiredMax);
  if (required.error) return res.status(400).json({ error: required.error });
  if (!required.value.trim()) return res.status(400).json({ error: `${requiredField} is empty` });
  const extras = {};
  for (const name of ["contract_type", "party_a_name", "party_b_name"]) {
    const field = textField(req.body, name, 200);
    if (field.error) return res.status(400).json({ error: field.error });
    extras[name] = field.value;
  }
  if (!(await assistAllowed(req.ip))) {
    return res.status(429).json({ error: "assistant limit reached, try again in an hour" });
  }
  try {
    const suggestion = await work(required.value, extras);
    res.json({ suggestion });
  } catch (err) {
    console.error("assist failed", err.status, err.message);
    res.status(502).json({
      error: "assistant unavailable",
      detail: String(err.message || "").slice(0, 200),
    });
  }
}

app.post(
  "/assist/cleanup",
  wrap((req, res) =>
    runAssist(req, res, "terms", 20000, (terms, extras) =>
      cleanupTerms({ terms, contractType: extras.contract_type })
    )
  )
);

app.post(
  "/assist/draft",
  wrap((req, res) =>
    runAssist(req, res, "description", 5000, (description, extras) =>
      draftTerms({
        description,
        contractType: extras.contract_type,
        partyA: extras.party_a_name,
        partyB: extras.party_b_name,
      })
    )
  )
);

const devKeyHash =
  process.env.DEV_TOOLS_KEY && process.env.DEV_TOOLS_KEY.length >= 20
    ? hashToken(process.env.DEV_TOOLS_KEY)
    : null;

function devKeyOk(req) {
  return devKeyHash !== null && tokenMatches(req.get("X-Dev-Key"), devKeyHash);
}

const CONSENT_TEXT =
  "I agree to sign this agreement electronically. I understand my typed name and drawn " +
  "signature have the same effect as signing on paper, and that a fingerprint of the signed " +
  "agreement will be recorded on a public blockchain.";

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function contentHash(row) {
  return sha256(
    JSON.stringify({
      date: row.date,
      contract_type: row.contract_type,
      custom_type: row.custom_type,
      party_a_name: row.party_a_name,
      party_a_email: row.party_a_email,
      party_b_name: row.party_b_name,
      party_b_email: row.party_b_email,
      terms: row.terms,
    })
  );
}

function documentHash(row, signatures, salt) {
  return sha256(
    JSON.stringify({
      v: 2,
      salt,
      content_hash: contentHash(row),
      signatures: signatures.map((sig) => ({
        party: sig.party,
        typed_name: sig.typed_name,
        signed_at: new Date(sig.signed_at).toISOString(),
        drawing_hash: sha256(sig.drawing),
        consent_text: sig.consent_text,
      })),
    })
  );
}

const CONTENT_COLUMNS =
  "id, to_char(created_date, 'YYYY-MM-DD') AS date, status, contract_type, custom_type, " +
  "party_a_name, party_a_email, party_b_name, party_b_email, terms";

async function notarizeContract(id, fromStatuses) {
  const { rows } = await pool.query(
    `WITH prev AS (SELECT status FROM contracts WHERE id = $1 FOR UPDATE)
     UPDATE contracts c SET status = 'notarizing', updated_at = now()
     FROM prev WHERE c.id = $1 AND prev.status = ANY($2)
     RETURNING prev.status AS prev_status, c.id, to_char(c.created_date, 'YYYY-MM-DD') AS date,
       c.contract_type, c.custom_type, c.party_a_name, c.party_a_email, c.party_b_name,
       c.party_b_email, c.terms`,
    [id, fromStatuses]
  );
  if (rows.length === 0) return { error: "missing, busy, or already notarized", status: 409 };
  const row = rows[0];

  const signed = await pool.query(
    "SELECT party, typed_name, signed_at, drawing, consent_text FROM signatures WHERE contract_id = $1 ORDER BY party",
    [id]
  );
  const salt = crypto.randomBytes(16).toString("hex");
  const docHash = documentHash(row, signed.rows, salt);

  let written;
  try {
    written = await writeHash(docHash);
  } catch (err) {
    await pool.query("UPDATE contracts SET status = $2, updated_at = now() WHERE id = $1", [
      id,
      row.prev_status,
    ]);
    console.error("chain write failed", err.message);
    return { error: "chain write failed", detail: String(err.message).slice(0, 200), status: 502 };
  }

  const pin = newPin();
  await pool.query(
    `UPDATE contracts SET status = 'notarized', chain = $2, doc_hash = $3, doc_salt = $4,
       tx_hash = $5, block_number = $6, gas_paid = $7, notarized_at = now(),
       pin_hash = $8, updated_at = now()
     WHERE id = $1`,
    [id, chainName(), docHash, salt, written.txHash, written.blockNumber, written.gasPaid, await hashPin(pin)]
  );
  return {
    id,
    date: row.date,
    pin,
    tx_hash: written.txHash,
    block_number: written.blockNumber,
    gas_paid: written.gasPaid,
  };
}

app.get("/consent", (req, res) => res.json({ consent_text: CONSENT_TEXT }));

app.post(
  "/contracts/:id/sign",
  wrap(async (req, res) => {
    if (!(await editTokenIsValid(req))) return res.status(404).json({ error: "not found" });
    const body = req.body || {};
    const party = body.party;
    if (party !== "a" && party !== "b") return res.status(400).json({ error: "party must be a or b" });
    if (body.consent !== true) return res.status(400).json({ error: "consent is required to sign" });
    const typed = typeof body.typed_name === "string" ? body.typed_name.trim() : "";
    if (!typed || typed.length > 200) return res.status(400).json({ error: "type your full name to sign" });
    const drawing = typeof body.drawing === "string" ? body.drawing : "";
    if (!drawing.startsWith("data:image/png;base64,") || drawing.length > 300000) {
      return res.status(400).json({ error: "draw your signature to sign" });
    }

    const { rows } = await pool.query(`SELECT ${CONTENT_COLUMNS} FROM contracts WHERE id = $1`, [
      req.params.id,
    ]);
    const row = rows[0];
    if (!["drafting", "awaiting_signatures"].includes(row.status)) {
      return res.status(409).json({ error: "this agreement is no longer open for signing" });
    }
    const expectedName = (party === "a" ? row.party_a_name : row.party_b_name).trim();
    if (!row.party_a_name.trim() || !row.party_b_name.trim() || !row.terms.trim()) {
      return res.status(400).json({ error: "both party names and the terms are needed before signing" });
    }
    if (typed.toLowerCase() !== expectedName.toLowerCase()) {
      return res.status(400).json({ error: `the typed name must match ${expectedName}` });
    }

    const insert = await pool.query(
      `INSERT INTO signatures (contract_id, party, typed_name, drawing, consent_text, content_hash, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING RETURNING signed_at`,
      [row.id, party, typed, drawing, CONSENT_TEXT, contentHash(row), req.ip, String(req.get("user-agent") || "").slice(0, 300)]
    );
    if (insert.rows.length === 0) return res.status(409).json({ error: `party ${party} has already signed` });

    await pool.query(
      "UPDATE contracts SET status = 'awaiting_signatures', updated_at = now() WHERE id = $1 AND status = 'drafting'",
      [row.id]
    );

    const count = await pool.query("SELECT party FROM signatures WHERE contract_id = $1 ORDER BY party", [row.id]);
    const signedParties = count.rows.map((r) => r.party);
    if (signedParties.length < 2) {
      return res.json({ status: "awaiting_signatures", signed: signedParties });
    }

    await pool.query(
      "UPDATE contracts SET status = 'signed', updated_at = now() WHERE id = $1 AND status = 'awaiting_signatures'",
      [row.id]
    );
    if (!chainReady()) return res.json({ status: "signed", signed: signedParties });
    const result = await notarizeContract(row.id, ["signed"]);
    if (result.error) return res.json({ status: "signed", signed: signedParties, notarize_error: result.error });
    res.json({ status: "notarized", signed: signedParties, ...result });
  })
);

app.post(
  "/contracts/:id/notarize",
  wrap(async (req, res) => {
    if (!(await editTokenIsValid(req))) return res.status(404).json({ error: "not found" });
    if (!chainReady()) return res.status(503).json({ error: "house wallet is not configured" });
    const result = await notarizeContract(req.params.id, ["signed"]);
    if (result.error) return res.status(result.status).json(result);
    res.json({ status: "notarized", ...result });
  })
);

app.get(
  "/dev/wallet",
  wrap(async (req, res) => {
    if (!devKeyOk(req)) return res.status(404).json({ error: "not found" });
    res.json(await walletStatus());
  })
);

app.post(
  "/dev/contracts/:id/notarize",
  wrap(async (req, res) => {
    if (!devKeyOk(req)) return res.status(404).json({ error: "not found" });
    if (!chainReady()) return res.status(503).json({ error: "house wallet is not configured" });
    const result = await notarizeContract(req.params.id, ["drafting", "signed"]);
    if (result.error) return res.status(result.status).json(result);
    res.json(result);
  })
);

app.post(
  "/dev/contracts/:id/fake-notarize",
  wrap(async (req, res) => {
    if (!devKeyOk(req)) return res.status(404).json({ error: "not found" });
    const pin = newPin();
    const { rows } = await pool.query(
      `UPDATE contracts SET status = 'notarized', chain = 'polygon-amoy (simulated)',
         doc_hash = encode(sha256(convert_to(terms, 'UTF8')), 'hex'),
         tx_hash = $2, block_number = $3, gas_paid = '0', notarized_at = now(),
         pin_hash = $4, updated_at = now()
       WHERE id = $1 AND status <> 'notarized'
       RETURNING id, to_char(created_date, 'YYYY-MM-DD') AS date`,
      [
        req.params.id,
        "0x" + crypto.randomBytes(32).toString("hex"),
        crypto.randomInt(10000000, 99999999),
        await hashPin(pin),
      ]
    );
    if (rows.length === 0) return res.status(409).json({ error: "missing or already notarized" });
    res.json({ ...rows[0], pin });
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
