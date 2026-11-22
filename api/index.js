import app from '../src/app.js';
import { initializeDatabase } from '../src/db/index.js';

await initializeDatabase();

export default app;
