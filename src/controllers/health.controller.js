import { checkDatabaseHealth } from '../config/database.js';
import { sendSuccess } from '../utils/apiResponse.js';

export const getHealth = async (req, res) => {
  const database = await checkDatabaseHealth();

  return sendSuccess(res, {
    message: 'FixMate server is healthy.',
    status: 'ok',
    database,
    timestamp: new Date().toISOString()
  });
};
