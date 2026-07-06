-- ---------------------------------------------------------------------------
-- push-test/reload-schema-cache.sql
--
-- PostgREST maintains an in-memory cache of the database schema. When
-- you create a new table it doesn't notice until either (a) the cache
-- TTL expires (~30s on Supabase) or (b) you send it a NOTIFY message
-- to reload. This is the standard Supabase workaround for "could not
-- find the table in the schema cache" errors right after a migration.
--
-- Run this once in the SQL editor after applying migrate.sql, then
-- retry your query.
-- ---------------------------------------------------------------------------

NOTIFY pgrst, 'reload schema';
