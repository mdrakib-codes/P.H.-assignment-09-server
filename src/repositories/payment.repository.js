import { ObjectId } from 'mongodb';
import {
  adminPaymentQuerySchema,
  paymentSchema,
  stripeSessionIdSchema,
  transactionIdSchema
} from '../validators/index.js';
import { toIncludeProjection } from '../utils/projections.js';
import { BaseRepository } from './base.repository.js';

export const PAYMENT_ADMIN_FIELDS = Object.freeze([
  '_id',
  'bookingId',
  'serviceTitle',
  'amount',
  'currency',
  'paymentStatus',
  'paidAt',
  'createdAt',
  'updatedAt'
]);
const PAYMENT_INTERNAL_FIELDS = Object.freeze([
  'bookingId',
  'serviceTitle',
  'customerEmail',
  'amount',
  'currency',
  'stripeSessionId',
  'paymentStatus',
  'paidAt',
  'createdAt',
  'updatedAt'
]);

const PAYMENT_ADMIN_PROJECTION = Object.freeze(toIncludeProjection(PAYMENT_ADMIN_FIELDS));
const PAYMENT_INTERNAL_PROJECTION = Object.freeze(
  toIncludeProjection(PAYMENT_INTERNAL_FIELDS)
);

export class PaymentRepository extends BaseRepository {
  constructor(options) {
    super('payments', {
      entityName: 'Payment',
      projection: PAYMENT_ADMIN_PROJECTION,
      immutableFields: [
        'bookingId',
        'amount',
        'currency',
        'transactionId',
        'stripeSessionId',
        'paymentStatus',
        'paidAt'
      ],
      ...options
    });
  }

  async findById(id) {
    const objectId = this.toObjectId(id, 'payment id');

    return this.execute((collection) =>
      collection.findOne({ _id: objectId }, { projection: PAYMENT_INTERNAL_PROJECTION })
    );
  }

  async create(data) {
    const payment = this.parseOrThrow(
      paymentSchema,
      {
        ...data,
        paymentStatus: 'paid'
      },
      'INVALID_PAYMENT',
      'Invalid payment data.'
    );
    const document = { ...payment, _id: payment._id ?? new ObjectId() };

    return this.execute(async (collection) => {
      await collection.insertOne(document);
      return this.findById(document._id);
    });
  }

  async findAllWithRevenue(query) {
    const normalized = this.validateQuery(adminPaymentQuerySchema, query);
    const filter = {};

    if (normalized.paymentStatus) {
      filter.paymentStatus = normalized.paymentStatus;
    }

    if (normalized.currency) {
      filter.currency = normalized.currency;
    }

    return this.execute(async (collection) => {
      const [result, revenueDocuments] = await Promise.all([
        this.readPaginated(collection, filter, {
          query: normalized,
          sort: { createdAt: -1 }
        }),
        collection.find(filter, { projection: { amount: 1, _id: 0 } }).toArray()
      ]);
      const totalRevenue = revenueDocuments.reduce(
        (total, payment) => total + Number(payment.amount ?? 0),
        0
      );

      return {
        ...result,
        totalRevenue: Math.round(totalRevenue * 100) / 100
      };
    });
  }

  async findByBookingId(bookingId) {
    const objectId = this.toObjectId(bookingId, 'booking id');

    return this.execute((collection) =>
      collection.findOne(
        { bookingId: objectId },
        { projection: PAYMENT_INTERNAL_PROJECTION }
      )
    );
  }

  async findByStripeSessionId(stripeSessionId) {
    const sessionId = this.parseOrThrow(
      stripeSessionIdSchema,
      stripeSessionId,
      'INVALID_STRIPE_SESSION_ID',
      'Invalid Stripe session ID.'
    );

    return this.execute((collection) =>
      collection.findOne(
        { stripeSessionId: sessionId },
        { projection: PAYMENT_INTERNAL_PROJECTION }
      )
    );
  }

  async findByTransactionId(transactionId) {
    const cleanId = this.parseOrThrow(
      transactionIdSchema,
      transactionId,
      'INVALID_TRANSACTION_ID',
      'Invalid transaction ID.'
    );

    return this.execute((collection) =>
      collection.findOne(
        { transactionId: cleanId },
        { projection: PAYMENT_INTERNAL_PROJECTION }
      )
    );
  }
}
