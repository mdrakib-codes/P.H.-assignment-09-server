import { ObjectId } from 'mongodb';
import { CASE_INSENSITIVE_EMAIL_COLLATION } from '../db/collations.js';
import { AppError } from '../utils/AppError.js';
import {
  ACTIVE_BOOKING_STATUSES,
  bookingQuerySchema,
  bookingSchema,
  bookingStatusUpdateSchema,
  paidPaymentStatusSchema,
  TECHNICIAN_ALLOWED_BOOKING_STATUS_TRANSITIONS
} from '../validators/index.js';
import { toIncludeProjection } from '../utils/projections.js';
import { BaseRepository } from './base.repository.js';

export const BOOKING_RESPONSE_FIELDS = Object.freeze([
  '_id',
  'serviceId',
  'serviceTitle',
  'serviceImage',
  'category',
  'basePrice',
  'technicianName',
  'technicianEmail',
  'customerName',
  'customerEmail',
  'customerPhone',
  'address',
  'preferredDate',
  'problemDescription',
  'status',
  'finalAmount',
  'paymentStatus',
  'createdAt',
  'updatedAt'
]);

const SAFE_BOOKING_PROJECTION = Object.freeze(
  toIncludeProjection(BOOKING_RESPONSE_FIELDS)
);

const DUPLICATE_KEY_CODE = 11000;
const ACTIVE_BOOKING_CONFLICT_MESSAGE =
  'An active booking already exists for this service.';

const isDuplicateKeyError = (error) => error?.code === DUPLICATE_KEY_CODE;

export class BookingRepository extends BaseRepository {
  constructor(options) {
    super('bookings', {
      entityName: 'Booking',
      projection: SAFE_BOOKING_PROJECTION,
      immutableFields: ['status', 'finalAmount', 'paymentStatus'],
      ...options
    });
  }

  async findById(id) {
    const objectId = this.toObjectId(id, 'booking id');

    return this.execute((collection) =>
      collection.findOne({ _id: objectId }, { projection: this.projection })
    );
  }

  async create(data) {
    const booking = this.parseOrThrow(
      bookingSchema,
      {
        ...data,
        status: 'requested',
        finalAmount: undefined,
        paymentStatus: 'unpaid'
      },
      'INVALID_BOOKING',
      'Invalid booking data.'
    );
    const document = { ...booking, _id: booking._id ?? new ObjectId() };

    return this.execute(async (collection) => {
      try {
        await collection.insertOne(document);
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new AppError(
            409,
            'DUPLICATE_ACTIVE_BOOKING',
            ACTIVE_BOOKING_CONFLICT_MESSAGE
          );
        }
        throw error;
      }
      return this.findById(document._id);
    });
  }

  async findByCustomerEmail(email, query) {
    const normalizedEmail = this.normalizeEmail(email);
    const normalizedQuery = this.validateQuery(bookingQuerySchema, query);
    const filter = this.buildFilter(normalizedQuery, {
      customerEmail: normalizedEmail
    });

    return this.execute((collection) =>
      this.readPaginated(collection, filter, {
        query: normalizedQuery,
        sort: { createdAt: -1 },
        collation: CASE_INSENSITIVE_EMAIL_COLLATION
      })
    );
  }

  async findByTechnicianEmail(email, query) {
    const normalizedEmail = this.normalizeEmail(email);
    const normalizedQuery = this.validateQuery(bookingQuerySchema, query);
    const filter = this.buildFilter(normalizedQuery, {
      technicianEmail: normalizedEmail
    });

    return this.execute((collection) =>
      this.readPaginated(collection, filter, {
        query: normalizedQuery,
        sort: { createdAt: -1 },
        collation: CASE_INSENSITIVE_EMAIL_COLLATION
      })
    );
  }

  async findAll(query) {
    const normalized = this.validateQuery(bookingQuerySchema, query);

    return this.execute((collection) =>
      this.readPaginated(collection, this.buildFilter(normalized), {
        query: normalized,
        sort: { createdAt: -1 }
      })
    );
  }

  async findActiveByCustomerAndService(customerEmail, serviceId) {
    const normalizedEmail = this.normalizeEmail(customerEmail);
    const objectId = this.toObjectId(serviceId, 'service id');

    return this.execute((collection) =>
      collection.findOne(
        {
          customerEmail: normalizedEmail,
          serviceId: objectId,
          status: { $in: [...ACTIVE_BOOKING_STATUSES] }
        },
        {
          collation: CASE_INSENSITIVE_EMAIL_COLLATION,
          projection: { _id: 1 }
        }
      )
    );
  }

  async cancelById(id, customerEmail) {
    const objectId = this.toObjectId(id, 'booking id');
    const normalizedEmail = this.normalizeEmail(customerEmail);

    return this.execute(async (collection) => {
      const filter = {
        _id: objectId,
        customerEmail: normalizedEmail,
        status: 'requested'
      };
      const updated = await collection.findOneAndUpdate(
        filter,
        this.buildSet({ status: 'cancelled' }),
        {
          returnDocument: 'after',
          projection: this.projection,
          collation: CASE_INSENSITIVE_EMAIL_COLLATION
        }
      );

      if (updated) {
        return updated;
      }

      const existing = await collection.findOne(
        {
          _id: objectId,
          customerEmail: normalizedEmail
        },
        {
          projection: { _id: 1 },
          collation: CASE_INSENSITIVE_EMAIL_COLLATION
        }
      );

      if (!existing) {
        throw new AppError(404, 'NOT_FOUND', 'Booking not found.');
      }

      throw new AppError(
        409,
        'BOOKING_CANNOT_BE_CANCELLED',
        'Only a requested booking can be cancelled.'
      );
    });
  }

  async updateStatus(id, update, technicianEmail) {
    const objectId = this.toObjectId(id, 'booking id');
    const next = this.parseOrThrow(
      bookingStatusUpdateSchema,
      update,
      'INVALID_BOOKING_UPDATE',
      'Invalid booking status update.'
    );
    const ownerFilter = { technicianEmail: this.normalizeEmail(technicianEmail) };

    return this.execute(async (collection) => {
      const booking = this.requireFound(
        await collection.findOne(
          { _id: objectId, ...ownerFilter },
          { collation: CASE_INSENSITIVE_EMAIL_COLLATION }
        )
      );
      const allowed =
        TECHNICIAN_ALLOWED_BOOKING_STATUS_TRANSITIONS[booking.status] ?? [];

      if (!allowed.includes(next.status)) {
        throw new AppError(
          409,
          'INVALID_STATUS_TRANSITION',
          'Invalid booking status transition.'
        );
      }

      const fields = { status: next.status };

      if (next.status === 'completed') {
        if (next.finalAmount === undefined) {
          throw new AppError(
            400,
            'FINAL_AMOUNT_REQUIRED',
            'finalAmount is required when completing a booking.'
          );
        }
        fields.finalAmount = next.finalAmount;
      } else if (next.finalAmount !== undefined) {
        throw new AppError(
          400,
          'FINAL_AMOUNT_NOT_ALLOWED',
          'finalAmount can only be set when completing a booking.'
        );
      }

      const updated = await collection.findOneAndUpdate(
        { _id: objectId, ...ownerFilter, status: booking.status },
        this.buildSet(fields),
        {
          returnDocument: 'after',
          projection: this.projection,
          collation: CASE_INSENSITIVE_EMAIL_COLLATION
        }
      );

      if (!updated) {
        throw new AppError(
          409,
          'STATUS_CONFLICT',
          'Booking status changed during update.'
        );
      }

      return updated;
    });
  }

  async updatePaymentStatus(id, paymentStatus = 'paid') {
    const objectId = this.toObjectId(id, 'booking id');
    const nextStatus = this.parseOrThrow(
      paidPaymentStatusSchema,
      paymentStatus,
      'INVALID_PAYMENT_STATUS',
      'Invalid payment status.'
    );

    return this.execute(async (collection) => {
      const booking = this.requireFound(
        await collection.findOne({ _id: objectId }, { projection: this.projection })
      );

      if (booking.status !== 'completed' || booking.paymentStatus !== 'unpaid') {
        throw new AppError(
          409,
          'PAYMENT_NOT_ALLOWED',
          'Payment is not allowed for this booking.'
        );
      }

      const updated = await collection.findOneAndUpdate(
        {
          _id: objectId,
          status: 'completed',
          paymentStatus: 'unpaid'
        },
        this.buildSet({ paymentStatus: nextStatus }),
        { returnDocument: 'after', projection: this.projection }
      );

      if (!updated) {
        throw new AppError(
          409,
          'PAYMENT_CONFLICT',
          'Booking payment state changed during update.'
        );
      }

      return updated;
    });
  }

  buildFilter(query, base = {}) {
    const filter = { ...base };

    if (query.status) {
      filter.status = query.status;
    }

    if (query.paymentStatus) {
      filter.paymentStatus = query.paymentStatus;
    }

    return filter;
  }
}
