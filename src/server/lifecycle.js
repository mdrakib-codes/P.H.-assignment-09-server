export const createServerLifecycle = ({
  app,
  env,
  initializeDatabase,
  closeDatabase,
  logger = console
}) => {
  let server = null;
  let shuttingDown = false;

  const start = async () => {
    await initializeDatabase();

    server = app.listen(env.port, () => {
      logger.log(
        `[fixmate-server] ${env.nodeEnv} mode listening on http://localhost:${env.port}`
      );
    });

    server.on('error', (error) => {
      logger.error(`[fixmate-server] HTTP server error: ${error?.message || error}`);
      process.exit(1);
    });

    return server;
  };

  const shutdown = async (signal = 'SIGTERM') => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.log(`[fixmate-server] ${signal} received; closing server.`);

    if (server) {
      const currentServer = server;
      server = null;
      await new Promise((resolve, reject) => {
        currentServer.close((error) => (error ? reject(error) : resolve()));
      });
    }

    await closeDatabase();
    logger.log('[fixmate-server] Server and database closed.');
  };

  return { start, shutdown, getServer: () => server };
};
