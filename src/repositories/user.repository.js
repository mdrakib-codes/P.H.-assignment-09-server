import { ObjectId } from 'mongodb';
import {
  publicRoleSchema,
  userQuerySchema,
  userRoleSchema,
  userSchema,
  userUpdateSchema
} from '../validators/index.js';
import { toIncludeProjection } from '../utils/projections.js';
import { BaseRepository } from './base.repository.js';

export const CANONICAL_ACTOR_FIELDS = Object.freeze(['name', 'email', 'role']);
export const USER_PROFILE_FIELDS = Object.freeze([
  '_id',
  'name',
  'email',
  'image',
  'role',
  'phone',
  'area',
  'bio',
  'createdAt',
  'updatedAt'
]);
export const ADMIN_USER_FIELDS = USER_PROFILE_FIELDS;
export const PUBLIC_TECHNICIAN_FIELDS = Object.freeze(['name', 'image', 'area', 'bio']);

const CANONICAL_ACTOR_PROJECTION = Object.freeze(
  toIncludeProjection(CANONICAL_ACTOR_FIELDS)
);
const ADMIN_USER_PROJECTION = Object.freeze(toIncludeProjection(ADMIN_USER_FIELDS));
const PUBLIC_TECHNICIAN_PROJECTION = Object.freeze({
  _id: 0,
  ...toIncludeProjection(PUBLIC_TECHNICIAN_FIELDS, { includeId: false })
});

export class UserRepository extends BaseRepository {
  constructor(options) {
    super('users', {
      entityName: 'User',
      projection: ADMIN_USER_PROJECTION,
      immutableFields: ['email', 'role'],
      ...options
    });
  }

  async findById(id) {
    const objectId = this.toObjectId(id, 'user id');

    return this.execute((collection) =>
      collection.findOne({ _id: objectId }, { projection: this.projection })
    );
  }

  async findCanonicalActorByEmail(email) {
    const normalizedEmail = this.normalizeEmail(email);

    return this.execute((collection) =>
      collection.findOne(
        { email: normalizedEmail },
        { projection: CANONICAL_ACTOR_PROJECTION }
      )
    );
  }

  async findByEmail(email) {
    return this.findCanonicalActorByEmail(email);
  }

  async findPublicTechnicianByEmail(email) {
    const normalizedEmail = this.normalizeEmail(email);

    return this.execute((collection) =>
      collection.findOne(
        { email: normalizedEmail },
        { projection: PUBLIC_TECHNICIAN_PROJECTION }
      )
    );
  }

  async create(data, { role } = {}) {
    const source =
      data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const cleanInput = { ...source };
    delete cleanInput.role;

    const safeRole = this.parseOrThrow(
      publicRoleSchema,
      role ?? 'customer',
      'INVALID_ROLE',
      'Invalid role.'
    );
    const user = this.parseOrThrow(
      userSchema,
      { ...cleanInput, role: safeRole },
      'INVALID_USER',
      'Invalid user data.'
    );
    const document = { ...user, _id: user._id ?? new ObjectId() };

    return this.execute(async (collection) => {
      await collection.insertOne(document);
      return this.findById(document._id);
    });
  }

  async findAll(query) {
    const normalized = this.validateQuery(userQuerySchema, query);
    const filter = {};

    if (normalized.role) {
      filter.role = normalized.role;
    }

    if (normalized.search) {
      const pattern = this.escapeRegex(normalized.search);
      filter.$or = [
        { name: { $regex: pattern, $options: 'i' } },
        { email: { $regex: pattern, $options: 'i' } }
      ];
    }

    return this.execute((collection) =>
      this.readPaginated(collection, filter, {
        query: normalized,
        sort: { createdAt: -1 }
      })
    );
  }

  async updateById(id, update) {
    const objectId = this.toObjectId(id, 'user id');
    const clean = this.validateUpdate(userUpdateSchema, update);

    return this.execute((collection) =>
      collection
        .findOneAndUpdate(
          { _id: objectId },
          this.buildSet(clean),
          { returnDocument: 'after', projection: this.projection }
        )
        .then((document) => this.requireFound(document))
    );
  }

  async updateRole(id, role) {
    const objectId = this.toObjectId(id, 'user id');
    const nextRole = this.parseOrThrow(
      userRoleSchema,
      role,
      'INVALID_ROLE',
      'Invalid role.'
    );

    return this.execute((collection) =>
      collection
        .findOneAndUpdate(
          { _id: objectId },
          this.buildSet({ role: nextRole }),
          { returnDocument: 'after', projection: this.projection }
        )
        .then((document) => this.requireFound(document))
    );
  }
}
