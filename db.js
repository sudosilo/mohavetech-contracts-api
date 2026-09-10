import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contracts (
      id TEXT PRIMARY KEY,
      created_date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'drafting',
      contract_type TEXT NOT NULL DEFAULT '',
      custom_type TEXT NOT NULL DEFAULT '',
      party_a_name TEXT NOT NULL DEFAULT '',
      party_a_email TEXT NOT NULL DEFAULT '',
      party_b_name TEXT NOT NULL DEFAULT '',
      party_b_email TEXT NOT NULL DEFAULT '',
      terms TEXT NOT NULL DEFAULT '',
      edit_token_hash TEXT NOT NULL,
      esign_request_id TEXT,
      signed_file_key TEXT,
      doc_hash TEXT,
      chain TEXT,
      tx_hash TEXT,
      block_number BIGINT,
      gas_paid TEXT,
      notarized_at TIMESTAMPTZ,
      pin_hash TEXT
    )
  `);
  await pool.query("ALTER TABLE contracts ADD COLUMN IF NOT EXISTS doc_salt TEXT");
}
