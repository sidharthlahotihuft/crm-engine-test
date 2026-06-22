-- ============================================================
-- HUFT CRM — Migration v3
-- Adds the AI-tagged image library.
-- Run in the CRM Supabase project (the one with `campaigns`).
-- Safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS image_library (
  id          TEXT        PRIMARY KEY DEFAULT substr(md5(random()::text), 1, 12),
  file_name   TEXT,
  file_data   TEXT,                      -- base64 data URL (same pattern as performance_reports)
  file_type   TEXT,
  product     TEXT,                      -- AI-detected product / sub-brand
  category    TEXT,                      -- AI-detected category (e.g. "dry food", "treats", "grooming")
  tags        JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- AI-detected descriptive tags
  description TEXT,                       -- AI one-line context of what the image shows
  notes       TEXT,                       -- optional human note added at upload
  uploaded_by TEXT        REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_imglib_product ON image_library(product);
CREATE INDEX IF NOT EXISTS idx_imglib_tags    ON image_library USING gin(tags);
