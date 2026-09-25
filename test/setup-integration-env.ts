// Integration tests exercise services directly; no background workers.
process.env.WORKERS_ENABLED = 'false';
