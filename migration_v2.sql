-- ============================================================
-- HUFT CRM — Migration v2
-- Adds: brand role (Ilena), comments/replies, brand-review approval
--        gate, and Google Sheets sync config.
-- Run in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to run multiple times (idempotent).
-- ============================================================

-- ---- 1. Allow the new 'brand' role ------------------------------
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','business','content','design','brand'));

-- ---- 2. Allow the new 'brand_review' campaign stage -------------
-- Flow: brief → content → brand_review → design → done
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_stage_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_stage_check
  CHECK (stage IN ('brief','content','brand_review','design','done'));

-- Track the brand-lead approval explicitly
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS brand_approver    TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS brand_approved_at TIMESTAMPTZ;

-- RTBs and reference links (from the brief features). Stored as JSONB arrays.
-- Note: "references" is a reserved word in SQL, so it is always double-quoted.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS rtbs         JSONB DEFAULT '[]'::jsonb;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS "references" JSONB DEFAULT '[]'::jsonb;

-- ---- 3. Comments / replies on copy & art ------------------------
-- A flat thread per campaign+context; parent_id links a reply to its comment.
CREATE TABLE IF NOT EXISTS comments (
  id           TEXT         PRIMARY KEY DEFAULT substr(md5(random()::text), 1, 12),
  campaign_id  TEXT         NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  context      TEXT         NOT NULL DEFAULT 'copy'
                            CHECK (context IN ('copy','design')),
  parent_id    TEXT         REFERENCES comments(id) ON DELETE CASCADE,
  body         TEXT         NOT NULL,
  author_id    TEXT         REFERENCES users(id) ON DELETE SET NULL,
  author_name  TEXT,
  author_role  TEXT,
  resolved     BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_comments_campaign ON comments(campaign_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent   ON comments(parent_id);

-- ---- 4. Google Sheets sync config -------------------------------
-- One row holds the connected sheet + a row-hash set so we don't re-import.
CREATE TABLE IF NOT EXISTS sheet_sync (
  id            TEXT         PRIMARY KEY DEFAULT 'default',
  sheet_id      TEXT,                       -- the Google Sheet ID
  sheet_range   TEXT         DEFAULT 'Briefs!A:K',
  enabled       BOOLEAN      NOT NULL DEFAULT FALSE,
  last_synced   TIMESTAMPTZ,
  imported_keys JSONB        NOT NULL DEFAULT '[]'::jsonb,  -- hashes of rows already imported
  created_by    TEXT         REFERENCES users(id) ON DELETE SET NULL
);

-- ---- 5. Seed Ilena as brand lead --------------------------------
-- Password is 'huft@brand123' (bcrypt, distinct from admin). Change after first login.
INSERT INTO users (id, name, email, password, role)
VALUES (
  'brand0000001',
  'Ilena',
  'ilena@headsupfortails.com',
  '$2b$10$ew4z82a5hhDVnYmogonhquecx.oyIj0d8hmAVtCAQ2SzByWwp4Uoa',
  'brand'
) ON CONFLICT (email) DO UPDATE SET role = 'brand';
-- Ilena logs in with the email above and password huft@brand123.
-- Reset her password from the admin Team tab after first login.
