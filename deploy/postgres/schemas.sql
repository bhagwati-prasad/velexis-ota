REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- ---- Base schemas (the baselines use CREATE SCHEMA IF NOT EXISTS, so these stay owned by the migrator) --
CREATE SCHEMA IF NOT EXISTS platform AUTHORIZATION velexis_migrator;
CREATE SCHEMA IF NOT EXISTS reference AUTHORIZATION velexis_migrator;

GRANT USAGE ON SCHEMA platform, reference TO velexis_platform_app;
GRANT USAGE ON SCHEMA reference TO velexis_ota_app;
-- USAGE only. SELECT on the platform tables the OTA backend may read is granted table by table, and
-- column by column on accounts, in platform/backend/migrations/platform/R__ota_read_access.sql (ADR-0004 list).
GRANT USAGE ON SCHEMA platform TO velexis_ota_app;

-- Tables and sequences the migrator creates later get these privileges automatically.
ALTER DEFAULT PRIVILEGES FOR ROLE velexis_migrator IN SCHEMA platform
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO velexis_platform_app;
ALTER DEFAULT PRIVILEGES FOR ROLE velexis_migrator IN SCHEMA platform
  GRANT USAGE, SELECT ON SEQUENCES TO velexis_platform_app;
ALTER DEFAULT PRIVILEGES FOR ROLE velexis_migrator IN SCHEMA reference
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO velexis_platform_app;
ALTER DEFAULT PRIVILEGES FOR ROLE velexis_migrator IN SCHEMA reference
  GRANT USAGE, SELECT ON SEQUENCES TO velexis_platform_app;
ALTER DEFAULT PRIVILEGES FOR ROLE velexis_migrator IN SCHEMA reference
  GRANT SELECT ON TABLES TO velexis_ota_app;

-- Tenant schemas: created by the OTA provisioning job as velexis_provisioner (CREATE SCHEMA ... AUTHORIZATION
-- velexis_provisioner), which then runs
--   GRANT USAGE ON SCHEMA tenant_<key> TO velexis_ota_app;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tenant_<key> TO velexis_ota_app;
--   ALTER DEFAULT PRIVILEGES FOR ROLE velexis_provisioner IN SCHEMA tenant_<key> GRANT ... TO velexis_ota_app;
-- The platform role never receives any privilege on a tenant schema, and the provisioner none on platform.
