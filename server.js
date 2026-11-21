import app from './src/app.js';
import { env } from './src/config/env.js';
import { closeDatabase } from './src/config/database.js';
import { initializeDatabase } from './src/db/index.js';
import { createServerLifecycle } from './src/server/lifecycle.js';
import { createProcessHandlers } from './src/server/processHandlers.js';

let lifecycle;
const handlers = createProcessHandlers({
  getLifecycle: () => lifecycle,
  logger: console
});

lifecycle = createServerLifecycle({
  app,
  env,
  initializeDatabase,
  closeDatabase,
  onServerError: (error) => handlers.handleFatal('HTTP_SERVER_ERROR', error)
});

handlers.install();

try {
  await lifecycle.start();
} catch (error) {
  await handlers.handleFatal('STARTUP_ERROR', error);
}
