-- Per-tenant report settings (currently: custom P&L section headings).
-- Stored as JSONB so additional report preferences can be added later
-- without another migration. A NULL value means "use built-in defaults".
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS report_settings JSONB;
