import { COLLECTION_NAMES, getCollection } from '../db/collections.js';
import { AppError } from '../utils/AppError.js';
import { emailSchema, objectIdSchema } from '../validators/index.js';

const CONNECTION_ERROR_NAMES = new Set([
  'MongoServerSelectionError',
  'MongoNetworkError',
  'MongoNotConnectedError',
  'MongoTimeoutError',
  'MongoConnectionClosed'
]);

const isConnectionError = (error) => {
  const message = String(error?.message || '');

  return (
    CONNECTION_ERROR_NAMES.has(error?.name) ||
    error?.codeName === 'ServerSelectionTimeoutError' ||
    message === 'MongoDB is not connected.' ||
    message === 'MongoDB client is not connected.' ||
    /server selection|connection closed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(message)
  );
};

export class BaseRepository {
  constructor(
    collectionKey,
    {
      entityName = collectionKey,
      projection,
      immutableFields = [],
      collectionFactory = getCollection
    } = {}
  ) {
    this.collectionKey = collectionKey;
    this.entityName = entityName;
    this.projection = projection;
    this.immutableFields = new Set(['_id', 'createdAt', ...immutableFields]);
    this._collectionFactory = collectionFactory;
  }

  get collectionName() {
    return COLLECTION_NAMES[this.collectionKey];
  }

  get collection() {
    return this._collectionFactory(this.collectionKey);
  }

  async execute(operation) {
    try {
      return await operation(this.collection);
    } catch (error) {
      this.handleError(error);
    }
  }

  handleError(error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (error?.code === 11000) {
      throw new AppError(
        409,
        'DUPLICATE_KEY',
        'A record with these unique values already exists.'
      );
    }

    if (isConnectionError(error)) {
      throw new AppError(
        503,
        'DATABASE_UNAVAILABLE',
        'Database is temporarily unavailable.'
      );
    }

    throw new AppError(500, 'DATABASE_ERROR', 'Database operation failed.');
  }

  parseOrThrow(schema, value, code, message) {
    const result = schema.safeParse(value);

    if (!result.success) {
      throw new AppError(400, code, message);
    }

    return result.data;
  }

  toObjectId(value, label = 'id') {
    try {
      return objectIdSchema.parse(value);
    } catch {
      throw new AppError(400, 'INVALID_OBJECT_ID', `Invalid ${label}.`);
    }
  }

  normalizeEmail(value) {
    try {
      return emailSchema.parse(value);
    } catch {
      throw new AppError(400, 'INVALID_EMAIL', 'Invalid email address.');
    }
  }

  validateQuery(schema, query) {
    const result = schema.safeParse(query ?? {});

    if (!result.success) {
      throw new AppError(400, 'INVALID_QUERY', 'Invalid query parameters.');
    }

    return result.data;
  }

  validateUpdate(schema, update) {
    if (!update || typeof update !== 'object' || Array.isArray(update)) {
      throw new AppError(400, 'INVALID_UPDATE', 'Invalid update data.');
    }

    const result = schema.safeParse(update);

    if (!result.success) {
      throw new AppError(400, 'INVALID_UPDATE', 'Invalid update data.');
    }

    const clean = { ...result.data };

    for (const field of this.immutableFields) {
      delete clean[field];
    }

    if (Object.keys(clean).length === 0) {
      throw new AppError(400, 'INVALID_UPDATE', 'No updatable fields provided.');
    }

    return clean;
  }

  requireFound(document) {
    if (!document) {
      throw new AppError(404, 'NOT_FOUND', `${this.entityName} not found.`);
    }

    return document;
  }

  buildSet(fields) {
    return {
      $set: {
        ...fields,
        updatedAt: new Date()
      }
    };
  }

  escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  buildPagedResult(items, total, { page, limit }) {
    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    };
  }

  async readPaginated(
    collection,
    filter,
    { query, sort = { createdAt: -1 }, projection = this.projection, collation }
  ) {
    const findOptions = projection ? { projection } : {};
    const countOptions = collation ? { collation } : undefined;

    if (collation) {
      findOptions.collation = collation;
    }

    const [items, total] = await Promise.all([
      collection
        .find(filter, findOptions)
        .sort(sort)
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .toArray(),
      collection.countDocuments(filter, countOptions)
    ]);

    return this.buildPagedResult(items, total, query);
  }
}
