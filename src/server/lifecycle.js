import { redactSecrets } from '../utils/redact.js';

const DEFAULT_SERVER_TIMEOUTS = Object.freeze({
  requestTimeout: 30000,
  headersTimeout: 10000,
  keepAliveTimeout: 5000
});
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const SHUTDOWN_DEADLINE_MESSAGE = 'Shutdown deadline exceeded.';

export const createServerLifecycle = ({
  app,
  env,
  initializeDatabase,
  closeDatabase,
  logger = console,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  serverTimeouts = {},
  onServerError
} = {}) => {
  let server = null;
  let startupPromise = null;
  let shutdownPromise = null;
  let shuttingDown = false;

  const configureServerTimeouts = (currentServer) => {
    const timeouts = { ...DEFAULT_SERVER_TIMEOUTS, ...serverTimeouts };

    if (typeof currentServer.setTimeout === 'function') {
      currentServer.setTimeout(timeouts.requestTimeout);
    }
    currentServer.requestTimeout = timeouts.requestTimeout;
    currentServer.headersTimeout = timeouts.headersTimeout;
    currentServer.keepAliveTimeout = timeouts.keepAliveTimeout;
  };

  const closeHttpServer = (currentServer) =>
    new Promise((resolve, reject) => {
      const finish = (error) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(error);
          return;
        }
        resolve();
      };

      try {
        currentServer.close(finish);
        currentServer.closeIdleConnections?.();
      } catch (error) {
        finish(error);
      }
    });

  const createDeadline = () => {
    let timer;
    const promise = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(SHUTDOWN_DEADLINE_MESSAGE)),
        shutdownTimeoutMs
      );
    });

    return {
      promise,
      clear: () => clearTimeout(timer)
    };
  };

  const withDeadline = (operation, deadline) =>
    Promise.race([Promise.resolve(operation), deadline.promise]);

  const closeDatabaseWithDeadline = (deadline) => {
    try {
      return withDeadline(closeDatabase(), deadline);
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const recordFailure = (step, error, failures) => {
    logger.error(`[fixmate-server] ${step} failed: ${redactSecrets(error?.message || error)}`);
    failures.push(error);
  };

  const start = () => {
    if (shutdownPromise) {
      return Promise.reject(new Error('Server is shutting down.'));
    }

    if (startupPromise) {
      return startupPromise;
    }

    startupPromise = (async () => {
      await initializeDatabase();

      if (shuttingDown) {
        return null;
      }

      const currentServer = app.listen(env.port, () => {
        logger.log(
          `[fixmate-server] ${env.nodeEnv} mode listening on http://localhost:${env.port}`
        );
      });

      configureServerTimeouts(currentServer);
      server = currentServer;

      currentServer.on('error', (error) => {
        logger.error(
          `[fixmate-server] HTTP server error: ${redactSecrets(error?.message || error)}`
        );
        onServerError?.(error);
      });

      if (shuttingDown) {
        return null;
      }

      return currentServer;
    })();

    return startupPromise;
  };

  const shutdown = (reason = 'SIGTERM') => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shuttingDown = true;
    const deadline = createDeadline();

    shutdownPromise = (async () => {
      const failures = [];

      try {
        logger.log(`[fixmate-server] ${reason} received; closing server.`);

        if (startupPromise) {
          try {
            await withDeadline(startupPromise, deadline);
          } catch (error) {
            recordFailure('Startup wait', error, failures);
          }
        }

        const currentServer = server;
        server = null;

        if (currentServer) {
          try {
            await withDeadline(closeHttpServer(currentServer), deadline);
          } catch (error) {
            recordFailure('HTTP close', error, failures);
          }
        }

        try {
          await closeDatabaseWithDeadline(deadline);
        } catch (error) {
          recordFailure('Database close', error, failures);
        }

        if (failures.length > 0) {
          throw failures[0];
        }

        logger.log('[fixmate-server] Server and database closed.');
      } finally {
        deadline.clear();
      }
    })();

    return shutdownPromise;
  };

  return {
    start,
    shutdown,
    getServer: () => server,
    isShuttingDown: () => shuttingDown
  };
};
