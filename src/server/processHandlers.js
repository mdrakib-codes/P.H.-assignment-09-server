import { redactSecrets } from '../utils/redact.js';

export const createProcessHandlers = ({
  getLifecycle,
  logger = console,
  exit = (code) => process.exit(code),
  processEmitter = process
} = {}) => {
  let installed = false;
  let exited = false;
  let fatalHandled = false;
  const listeners = new Map();

  const formatError = (error) =>
    redactSecrets(error?.stack || error?.message || error);

  const exitOnce = (code) => {
    if (exited) {
      return;
    }
    exited = true;
    exit(code);
  };

  const shutdownLifecycle = async (reason) => {
    const lifecycle =
      typeof getLifecycle === 'function' ? getLifecycle() : getLifecycle;

    if (lifecycle && typeof lifecycle.shutdown === 'function') {
      await lifecycle.shutdown(reason);
    }
  };

  const handleSignal = (signal) =>
    shutdownLifecycle(signal)
      .catch((error) => {
        logger.error(`[fixmate-server] Shutdown failed: ${formatError(error)}`);
        return false;
      })
      .then((result) => exitOnce(result === false ? 1 : 0));

  const handleFatal = (type, error) => {
    if (fatalHandled) {
      return Promise.resolve();
    }

    fatalHandled = true;
    logger.error(`[fixmate-server] ${type}: ${formatError(error)}`);

    return shutdownLifecycle(type)
      .catch((shutdownError) => {
        logger.error(
          `[fixmate-server] Shutdown failed after ${type}: ${formatError(shutdownError)}`
        );
      })
      .then(() => exitOnce(1));
  };

  const install = () => {
    if (installed) {
      return;
    }
    installed = true;

    const bindings = [
      ['SIGINT', () => handleSignal('SIGINT')],
      ['SIGTERM', () => handleSignal('SIGTERM')],
      ['unhandledRejection', (reason) => handleFatal('unhandledRejection', reason)],
      ['uncaughtException', (error) => handleFatal('uncaughtException', error)]
    ];

    for (const [event, listener] of bindings) {
      listeners.set(event, listener);
      processEmitter.on(event, listener);
    }
  };

  const remove = () => {
    if (!installed) {
      return;
    }

    for (const [event, listener] of listeners) {
      processEmitter.removeListener(event, listener);
    }
    listeners.clear();
    installed = false;
  };

  return {
    install,
    remove,
    handleSignal,
    handleFatal,
    hasExited: () => exited,
    hasHandledFatal: () => fatalHandled
  };
};
