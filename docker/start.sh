#!/bin/sh
# Applies pending migrations, then starts the app. For platforms without a
# separate pre-deploy step (e.g. Render's free plan). Already-applied
# migrations are skipped, so restarts are safe.
set -e

node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js

# exec: the app becomes PID 1 and receives shutdown signals directly.
exec node dist/main.js
