import { ObjectId } from 'mongodb';
import {
  paymentSchema,
  stripeSessionIdSchema,
  transactionIdSchema
} from '../validators/index.js';
import { BaseRepository } from './base.repository.js';

export class PaymentRepository extends BaseRepository {
  constructor(options) {
    super('payments', {
      entityName: 'Payment',
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

    return this.execute((collection) => collection.findOne({ _id: objectId }));
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

  async findByBookingId(bookingId) {
    const objectId = this.toObjectId(bookingId, 'booking id');

    return this.execute((collection) =>
      collection.findOne({ bookingId: objectId })
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
      collection.findOne({ stripeSessionId: sessionId })
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
      collection.findOne({ transactionId: cleanId })
    );
  }
}
