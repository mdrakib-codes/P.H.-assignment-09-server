import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { corsOptions } from './config/cors.js';
import routes from './routes/index.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();

app.disable('x-powered-by');
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/api', routes);
app.use(notFound);
app.use(errorHandler);

export default app;
