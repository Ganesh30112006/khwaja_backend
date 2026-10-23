import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';

// Apply pending migrations on start so a new deployment always runs against the current schema.
const client = await pool.connect();
try {
  await migrate(client, (msg) => console.log(msg));
} finally {
  client.release();
}

const server = createApp().listen(config.port, () => {
  console.log(`Voter Desk API listening on port ${config.port}`);
});
server.on('error', (err) => {
  console.error(`Could not start the API on port ${config.port}:`, err.message);
  process.exit(1);
});

function shutdown() {
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
