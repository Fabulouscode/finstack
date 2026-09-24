-- Runs once, on first initialisation of the Postgres volume.
-- Integration and e2e tests use a separate database so they never touch dev data.
CREATE DATABASE finstack_test;
