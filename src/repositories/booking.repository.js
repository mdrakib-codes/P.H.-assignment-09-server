import { ObjectId } from 'mongodb';
import { AppError } from '../utils/AppError.js';
import {
  ACTIVE_BOOKING_STATUSES,
  ALLOWED_BOOKING_STATUS_TRANSITIONS,
  bookingQuerySchema,
  bookingSchema,
  bookingStatusUpdateSchema,
  paidPaymentStatusSchema
} from '../validators/index.js';
import { BaseRepository } from './base.repository.js';

export class BookingRepository extends BaseRepository {
  constructor(options) {
    super('bookings', {
      entityName: 'Booking',
      immutableFields: ['status', 'finalAmount', 'paymentStatus'],
      ...options
    });
  }

  async findById(id) {
    const objectId = this.toObjectId(id, 'booking id');

    return this.execute((collection) => collection.findOne({ _id: objectId }));
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
      await collection.insertOne(document);
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
        sort: { createdAt: -1 }
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
        sort: { createdAt: -1 }
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
      collection.findOne({
        customerEmail: normalizedEmail,
        serviceId: objectId,
        status: { $in: [...ACTIVE_BOOKING_STATUSES] }
      })
    );
  }

  async updateStatus(id, update) {
    const objectId = this.toObjectId(id, 'booking id');
    const next = this.parseOrThrow(
      bookingStatusUpdateSchema,
      update,
      'INVALID_BOOKING_UPDATE',
      'Invalid booking status update.'
    );

    return this.execute(async (collection) => {
      const booking = this.requireFound(
        await collection.findOne({ _id: objectId })
      );
      const allowed = ALLOWED_BOOKING_STATUS_TRANSITIONS[booking.status] ?? [];

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
        { _id: objectId, status: booking.status },
        this.buildSet(fields),
        { returnDocument: 'after' }
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
        await collection.findOne({ _id: objectId })
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
        { returnDocument: 'after' }
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
