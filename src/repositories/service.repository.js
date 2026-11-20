import { ObjectId } from 'mongodb';
import {
  approvalDecisionSchema,
  availabilitySchema,
  paginationSchema,
  serviceCategorySchema,
  serviceQuerySchema,
  serviceSchema,
  serviceUpdateSchema,
  technicianServiceQuerySchema
} from '../validators/index.js';
import { BaseRepository } from './base.repository.js';

const PUBLIC_SERVICE_FILTER = Object.freeze({
  approvalStatus: 'approved',
  isAvailable: true
});

const SERVICE_SORTS = Object.freeze({
  newest: { createdAt: -1 },
  'price-asc': { basePrice: 1 },
  'price-desc': { basePrice: -1 }
});

export class ServiceRepository extends BaseRepository {
  constructor(options) {
    super('services', {
      entityName: 'Service',
      immutableFields: ['technicianEmail', 'approvalStatus', 'isAvailable'],
      ...options
    });
  }

  async findById(id) {
    const objectId = this.toObjectId(id, 'service id');

    return this.execute((collection) => collection.findOne({ _id: objectId }));
  }

  async findPublicById(id) {
    const objectId = this.toObjectId(id, 'service id');

    return this.execute((collection) =>
      collection
        .findOne({ _id: objectId, ...PUBLIC_SERVICE_FILTER })
        .then((document) => this.requireFound(document))
    );
  }

  async create(data) {
    const service = this.parseOrThrow(
      serviceSchema,
      {
        ...data,
        approvalStatus: 'pending',
        isAvailable: true
      },
      'INVALID_SERVICE',
      'Invalid service data.'
    );
    const document = { ...service, _id: service._id ?? new ObjectId() };

    return this.execute(async (collection) => {
      await collection.insertOne(document);
      return this.findById(document._id);
    });
  }

  async updateById(id, update) {
    const objectId = this.toObjectId(id, 'service id');
    const clean = this.validateUpdate(serviceUpdateSchema, update);

    return this.execute((collection) =>
      collection
        .findOneAndUpdate(
          { _id: objectId },
          this.buildSet({ ...clean, approvalStatus: 'pending' }),
          { returnDocument: 'after' }
        )
        .then((document) => this.requireFound(document))
    );
  }

  async deleteById(id) {
    const objectId = this.toObjectId(id, 'service id');

    return this.execute((collection) =>
      collection
        .findOneAndDelete({ _id: objectId })
        .then((document) => this.requireFound(document))
    );
  }

  async findPublicServices(query) {
    const normalized = this.validateQuery(serviceQuerySchema, query);
    const filter = { ...PUBLIC_SERVICE_FILTER };

    if (normalized.category) {
      filter.category = normalized.category;
    }

    if (normalized.serviceMode) {
      filter.serviceMode = normalized.serviceMode;
    }

    if (normalized.search) {
      const pattern = this.escapeRegex(normalized.search);
      filter.$or = [
        { title: { $regex: pattern, $options: 'i' } },
        { category: { $regex: pattern, $options: 'i' } },
        { description: { $regex: pattern, $options: 'i' } }
      ];
    }

    return this.execute((collection) =>
      this.readPaginated(collection, filter, {
        query: normalized,
        sort: SERVICE_SORTS[normalized.sort]
      })
    );
  }

  async findByTechnicianEmail(email, query) {
    const normalizedEmail = this.normalizeEmail(email);
    const normalizedQuery = this.validateQuery(
      technicianServiceQuerySchema,
      query
    );
    const filter = { technicianEmail: normalizedEmail };

    if (normalizedQuery.approvalStatus) {
      filter.approvalStatus = normalizedQuery.approvalStatus;
    }

    return this.execute((collection) =>
      this.readPaginated(collection, filter, {
        query: normalizedQuery,
        sort: { createdAt: -1 }
      })
    );
  }

  async findByCategory(category, query) {
    const categoryValue = this.parseOrThrow(
      serviceCategorySchema,
      category,
      'INVALID_CATEGORY',
      'Invalid service category.'
    );

    return this.findPublicServices({ ...query, category: categoryValue });
  }

  async findPendingApproval(query) {
    const normalized = this.validateQuery(paginationSchema, query);

    return this.execute((collection) =>
      this.readPaginated(
        collection,
        { approvalStatus: 'pending' },
        { query: normalized, sort: { createdAt: 1 } }
      )
    );
  }

  async updateApprovalStatus(id, status) {
    const objectId = this.toObjectId(id, 'service id');
    const decision = this.parseOrThrow(
      approvalDecisionSchema,
      status,
      'INVALID_APPROVAL_STATUS',
      'Invalid approval status.'
    );

    return this.execute((collection) =>
      collection
        .findOneAndUpdate(
          { _id: objectId },
          this.buildSet({ approvalStatus: decision }),
          { returnDocument: 'after' }
        )
        .then((document) => this.requireFound(document))
    );
  }

  async updateAvailability(id, isAvailable) {
    const objectId = this.toObjectId(id, 'service id');
    const availability = this.parseOrThrow(
      availabilitySchema,
      isAvailable,
      'INVALID_AVAILABILITY',
      'Invalid availability value.'
    );

    return this.execute((collection) =>
      collection
        .findOneAndUpdate(
          { _id: objectId },
          this.buildSet({ isAvailable: availability }),
          { returnDocument: 'after' }
        )
        .then((document) => this.requireFound(document))
    );
  }
}
