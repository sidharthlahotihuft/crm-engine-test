-- ============================================================
-- HUFT CRM Creative Engine — Supabase / PostgreSQL Schema
-- Run this in Supabase: Dashboard → SQL Editor → New query
-- ============================================================

-- ---- Users -------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id          TEXT         PRIMARY KEY DEFAULT substr(md5(random()::text), 1, 12),
  name        TEXT         NOT NULL,
  email       TEXT         NOT NULL UNIQUE,
  password    TEXT         NOT NULL,
  role        TEXT         NOT NULL DEFAULT 'content'
                           CHECK (role IN ('admin','business','content','design')),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_login  TIMESTAMPTZ
);

-- Default admin (password: huft@admin123 — change after first login)
INSERT INTO users (id, name, email, password, role)
VALUES (
  'admin000001',
  'Admin',
  'admin@headsupfortails.com',
  '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lHHi',
  'admin'
) ON CONFLICT (email) DO NOTHING;

-- ---- Audiences ---------------------------------------------
CREATE TABLE IF NOT EXISTS audiences (
  id               TEXT         PRIMARY KEY DEFAULT substr(md5(random()::text), 1, 12),
  name             TEXT         NOT NULL,
  description      TEXT,
  segment_code     TEXT,
  pet_type         TEXT         DEFAULT 'both'
                                CHECK (pet_type IN ('dog','cat','both','other')),
  lifecycle_stage  TEXT,
  trigger_event    TEXT,
  key_insight      TEXT,
  size_estimate    TEXT,
  channel_pref     TEXT,
  notes            TEXT,
  created_by       TEXT         REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---- Campaigns ---------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id                  TEXT         PRIMARY KEY DEFAULT substr(md5(random()::text), 1, 12),
  name                TEXT,
  channel             TEXT         DEFAULT 'WhatsApp',
  product             TEXT,
  audience_id         TEXT         REFERENCES audiences(id) ON DELETE SET NULL,
  audience_label      TEXT,
  segment             TEXT,
  objective           TEXT,
  offer               TEXT,
  crm_type            TEXT         DEFAULT 'D2C',
  stage               TEXT         NOT NULL DEFAULT 'brief'
                                   CHECK (stage IN ('brief','content','design','done')),
  data                JSONB        DEFAULT '{}'::jsonb,
  copy_approver       TEXT,
  copy_approved_at    TIMESTAMPTZ,
  design_approver     TEXT,
  design_approved_at  TIMESTAMPTZ,
  go_live_date        DATE,
  campaign_week       TEXT,
  campaign_month      TEXT,
  tat_brief_due       TIMESTAMPTZ,
  tat_content_due     TIMESTAMPTZ,
  tat_design_due      TIMESTAMPTZ,
  brief_started_at    TIMESTAMPTZ,
  content_started_at  TIMESTAMPTZ,
  design_started_at   TIMESTAMPTZ,
  went_live_at        TIMESTAMPTZ,
  created_by          TEXT         REFERENCES users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS campaigns_updated_at ON campaigns;
CREATE TRIGGER campaigns_updated_at
  BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---- Rules -------------------------------------------------
CREATE TABLE IF NOT EXISTS rules (
  id          TEXT         PRIMARY KEY DEFAULT substr(md5(random()::text), 1, 12),
  type        TEXT         NOT NULL CHECK (type IN ('copy','prompt')),
  text        TEXT         NOT NULL,
  active      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by  TEXT         REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---- Feedback ----------------------------------------------
CREATE TABLE IF NOT EXISTS feedback (
  id           TEXT         PRIMARY KEY DEFAULT substr(md5(random()::text), 1, 12),
  stage        TEXT         NOT NULL CHECK (stage IN ('brief','content','design')),
  text         TEXT         NOT NULL,
  by_name      TEXT,
  campaign_id  TEXT         REFERENCES campaigns(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---- Performance Reports -----------------------------------
CREATE TABLE IF NOT EXISTS performance_reports (
  id           TEXT         PRIMARY KEY DEFAULT substr(md5(random()::text), 1, 12),
  campaign_id  TEXT         NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  report_month TEXT         NOT NULL,
  file_name    TEXT,
  file_data    TEXT,
  file_type    TEXT,
  notes        TEXT,
  metrics      JSONB,
  uploaded_by  TEXT         REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---- Indexes -----------------------------------------------
CREATE INDEX IF NOT EXISTS idx_campaigns_stage   ON campaigns(stage);
CREATE INDEX IF NOT EXISTS idx_campaigns_updated ON campaigns(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaigns_month   ON campaigns(campaign_month);
CREATE INDEX IF NOT EXISTS idx_feedback_stage    ON feedback(stage);
CREATE INDEX IF NOT EXISTS idx_reports_campaign  ON performance_reports(campaign_id);
CREATE INDEX IF NOT EXISTS idx_reports_month     ON performance_reports(report_month);
