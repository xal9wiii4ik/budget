-- Creates the dedicated test database alongside the dev database.
-- Runs once, on first initialization of the postgres data volume.
-- If the budget_pg_data volume predates this script, recreate it with
-- `docker compose down -v` so this runs.
CREATE DATABASE budget_test;
