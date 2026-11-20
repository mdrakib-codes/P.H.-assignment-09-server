import app from './src/app.js';
import { env } from './src/config/env.js';
import { closeDatabase } from './src/config/database.js';
import { initializeDatabase } from './src/db/index.js';
import { createServerLifecycle } from './src/server/lifecycle.js';
import { redactSecrets } from './src/utils/redact.js';

const lifecycle = createServerLifecycle({
  app,
  env,
  initializeDatabase,
  closeDatabase
});

const handleSignal = (signal) => {
  lifecycle
    .shutdown(signal)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(
        `[fixmate-server] Shutdown failed: ${redactSecrets(error?.message || error)}`
      );
      process.exit(1);
    });
};

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));

try {
  await lifecycle.start();
} catch (error) {
  console.error(
    `[fixmate-server] Startup failed: ${redactSecrets(error?.message || error)}`
  );
  process.exit(1);
}
