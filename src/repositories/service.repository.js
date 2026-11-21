import { ObjectId } from 'mongodb';
import {
  adminServiceQuerySchema,
  approvalDecisionSchema,
  availabilitySchema,
  paginationSchema,
  serviceCategorySchema,
  serviceQuerySchema,
  serviceSchema,
  serviceUpdateSchema,
  technicianServiceQuerySchema
} from '../validators/index.js';
import { toIncludeProjection } from '../utils/projections.js';
import { BaseRepository } from './base.repository.js';

export const PUBLIC_SERVICE_FIELDS = Object.freeze([
  '_id',
  'title',
  'category',
  'description',
  'image',
  'basePrice',
  'estimatedDuration',
  'serviceMode',
  'serviceArea',
  'technicianName',
  'createdAt',
  'updatedAt'
]);
export const TECHNICIAN_SERVICE_FIELDS = Object.freeze([
  ...PUBLIC_SERVICE_FIELDS,
  'technicianEmail',
  'approvalStatus',
  'isAvailable'
]);
export const ADMIN_SERVICE_FIELDS = TECHNICIAN_SERVICE_FIELDS;

const PUBLIC_SERVICE_FILTER = Object.freeze({
  approvalStatus: 'approved',
  isAvailable: true
});
const PUBLIC_SERVICE_PROJECTION = Object.freeze(
  toIncludeProjection(PUBLIC_SERVICE_FIELDS)
);
const SERVICE_INTERNAL_PROJECTION = Object.freeze(
  toIncludeProjection(TECHNICIAN_SERVICE_FIELDS)
);
const ADMIN_SERVICE_PROJECTION = Object.freeze(toIncludeProjection(ADMIN_SERVICE_FIELDS));

const SERVICE_SORTS = Object.freeze({
  newest: { createdAt: -1 },
  'price-asc': { basePrice: 1 },
  'price-desc': { basePrice: -1 }
});

const ADMIN_SERVICE_SORTS = Object.freeze({
  ...SERVICE_SORTS,
  'pending-first': { __approvalRank: 1, createdAt: -1 }
});

export class ServiceRepository extends BaseRepository {
  constructor(options) {
    super('services', {
      entityName: 'Service',
      projection: SERVICE_INTERNAL_PROJECTION,
      immutableFields: ['technicianEmail', 'approvalStatus', 'isAvailable'],
      ...options
    });
  }

  async findById(id) {
    const objectId = this.toObjectId(id, 'service id');

    return this.execute((collection) =>
      collection.findOne({ _id: objectId }, { projection: this.projection })
    );
  }

  async findPublicById(id, { includeTechnicianEmail = false } = {}) {
    const objectId = this.toObjectId(id, 'service id');
    const projection = includeTechnicianEmail
      ? { ...PUBLIC_SERVICE_PROJECTION, technicianEmail: 1 }
      : PUBLIC_SERVICE_PROJECTION;

    return this.execute((collection) =>
      collection
        .findOne({ _id: objectId, ...PUBLIC_SERVICE_FILTER }, { projection })
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
          { returnDocument: 'after', projection: this.projection }
        )
        .then((document) => this.requireFound(document))
    );
  }

  async deleteById(id) {
    const objectId = this.toObjectId(id, 'service id');

    return this.execute((collection) =>
      collection
        .findOneAndDelete({ _id: objectId }, { projection: this.projection })
        .then((document) => this.requireFound(document))
    );
  }

  async updateOwnedById(id, update, technicianEmail) {
    const objectId = this.toObjectId(id, 'service id');
    const normalizedEmail = this.normalizeEmail(technicianEmail);
    const clean = this.validateUpdate(serviceUpdateSchema, update);

    return this.execute((collection) =>
      collection
        .findOneAndUpdate(
          { _id: objectId, technicianEmail: normalizedEmail },
          this.buildSet({ ...clean, approvalStatus: 'pending' }),
          { returnDocument: 'after', projection: this.projection }
        )
        .then((document) => this.requireFound(document))
    );
  }

  async deleteOwnedById(id, technicianEmail) {
    const objectId = this.toObjectId(id, 'service id');
    const normalizedEmail = this.normalizeEmail(technicianEmail);

    return this.execute((collection) =>
      collection
        .findOneAndDelete(
          { _id: objectId, technicianEmail: normalizedEmail },
          { projection: this.projection }
        )
        .then((document) => this.requireFound(document))
    );
  }

  async updateAvailabilityOwnedById(id, isAvailable, technicianEmail) {
    const objectId = this.toObjectId(id, 'service id');
    const availability = this.parseOrThrow(
      availabilitySchema,
      isAvailable,
      'INVALID_AVAILABILITY',
      'Invalid availability value.'
    );
    const normalizedEmail = this.normalizeEmail(technicianEmail);

    return this.execute((collection) =>
      collection
        .findOneAndUpdate(
          { _id: objectId, technicianEmail: normalizedEmail },
          this.buildSet({ isAvailable: availability }),
          { returnDocument: 'after', projection: this.projection }
        )
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
        sort: SERVICE_SORTS[normalized.sort],
        projection: PUBLIC_SERVICE_PROJECTION
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

  async findAllForAdmin(query) {
    const normalized = this.validateQuery(adminServiceQuerySchema, query);
    const filter = {};

    if (normalized.approvalStatus) {
      filter.approvalStatus = normalized.approvalStatus;
    }

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

    return this.execute(async (collection) => {
      const pipeline = [{ $match: filter }];

      if (normalized.sort === 'pending-first') {
        pipeline.push({
          $addFields: {
            __approvalRank: {
              $cond: [{ $eq: ['$approvalStatus', 'pending'] }, 0, 1]
            }
          }
        });
      }

      pipeline.push({ $sort: ADMIN_SERVICE_SORTS[normalized.sort] });
      pipeline.push({ $project: ADMIN_SERVICE_PROJECTION });

      pipeline.push(
        { $skip: (normalized.page - 1) * normalized.limit },
        { $limit: normalized.limit }
      );

      const [items, total] = await Promise.all([
        collection.aggregate(pipeline).toArray(),
        collection.countDocuments(filter)
      ]);

      return this.buildPagedResult(items, total, normalized);
    });
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
          { returnDocument: 'after', projection: this.projection }
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
          { returnDocument: 'after', projection: this.projection }
        )
        .then((document) => this.requireFound(document))
    );
  }
}
