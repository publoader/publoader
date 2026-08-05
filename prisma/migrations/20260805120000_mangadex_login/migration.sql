-- Replace "Login with Discord" with "Login with MangaDex".
--
-- The Discord columns only ever backed the dashboard login (the bot's own
-- allowlist lives in env, not here), so they go with it. Any operator that was
-- Discord-only signs in with a password — or gets invited by MangaDex username
-- — after this migration.

ALTER TABLE "admin_users" DROP COLUMN IF EXISTS "discord_id";
ALTER TABLE "admin_users" DROP COLUMN IF EXISTS "discord_username";

ALTER TABLE "admin_users" ADD COLUMN "mangadex_id" TEXT;
ALTER TABLE "admin_users" ADD COLUMN "mangadex_username" TEXT;
ALTER TABLE "admin_users" ADD COLUMN "md_client_id" TEXT;
ALTER TABLE "admin_users" ADD COLUMN "md_client_secret" TEXT;

CREATE UNIQUE INDEX "admin_users_mangadex_id_key" ON "admin_users"("mangadex_id");
CREATE UNIQUE INDEX "admin_users_mangadex_username_key" ON "admin_users"("mangadex_username");
