import { checkDatabaseHealth, getDatabaseStatus } from '../config/database.js';
import { sendError, sendSuccess } from '../utils/apiResponse.js';

export const createHealthController = ({
  checkDatabase = checkDatabaseHealth,
  getState = getDatabaseStatus,
  now = () => new Date().toISOString()
} = {}) => ({
  getLiveness: (req, res) =>
    sendSuccess(res, {
      message: 'FixMate server is alive.',
      status: 'ok',
      timestamp: now()
    }),
  getReadiness: async (req, res) => {
    let database = 'unavailable';
    let state = 'unknown';

    try {
      state = String(getState() ?? 'unknown');
      database = (await checkDatabase()) === 'connected' ? 'connected' : 'disconnected';
    } catch {
      database = 'unavailable';
    }

    const timestamp = now();

    if (database === 'connected') {
      return sendSuccess(res, {
        message: 'FixMate server is ready.',
        status: 'ok',
        database,
        state,
        timestamp
      });
    }

    return sendError(res, {
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'FixMate server is not ready.',
      details: {
        status: 'unavailable',
        database,
        state,
        timestamp
      }
    });
  }
});

export const healthController = createHealthController();
export const getLiveness = healthController.getLiveness;
export const getReadiness = healthController.getReadiness;
export const getHealth = getReadiness;
