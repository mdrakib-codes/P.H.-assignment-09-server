import { connectDatabase } from '../config/database.js';
import { initializeCollectionsAndIndexes } from './initialize.js';

export * from './collections.js';
export * from './indexes.js';
export { initializeCollectionsAndIndexes };

export const initializeDatabase = async () => {
  const db = await connectDatabase();
  return initializeCollectionsAndIndexes(db);
};
