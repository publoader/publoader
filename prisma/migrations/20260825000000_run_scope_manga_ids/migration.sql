-- A run that deliberately looked at only some titles.
--
-- Empty (the default, and every existing row) means the run covered the whole
-- catalogue: its allChapters snapshot means "this is everything the publisher
-- has", which is what the catalogue-wide removal passes assume. Non-empty means
-- the snapshot is authoritative for exactly these MangaDex title ids and says
-- nothing about the rest, so those passes must not run against it.
ALTER TABLE "runs" ADD COLUMN "scope_manga_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
