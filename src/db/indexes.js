import { ACTIVE_BOOKING_STATUSES } from '../validators/index.js';
import { CASE_INSENSITIVE_EMAIL_COLLATION } from './collations.js';

export const INDEX_DEFINITIONS = Object.freeze({
  users: [
    { name: 'user_email_uidx', key: { email: 1 }, unique: true },
    { name: 'user_role_idx', key: { role: 1 } }
  ],
  services: [
    {
      name: 'services_public_listing_idx',
      key: { approvalStatus: 1, isAvailable: 1, serviceMode: 1, createdAt: -1 }
    },
    {
      name: 'services_category_idx',
      key: { category: 1, approvalStatus: 1, isAvailable: 1 }
    },
    {
      name: 'services_technician_email_idx',
      key: { technicianEmail: 1, createdAt: -1 }
    }
  ],
  bookings: [
    { name: 'bookings_customer_email_idx', key: { customerEmail: 1, createdAt: -1 } },
    {
      name: 'bookings_technician_email_status_idx',
      key: { technicianEmail: 1, status: 1, createdAt: -1 }
    },
    {
      name: 'bookings_service_active_idx',
      key: { serviceId: 1, customerEmail: 1, status: 1 }
    },
    {
      name: 'bookings_active_customer_service_uidx',
      key: { customerEmail: 1, serviceId: 1 },
      unique: true,
      partialFilterExpression: {
        status: { $in: [...ACTIVE_BOOKING_STATUSES] }
      },
      collation: CASE_INSENSITIVE_EMAIL_COLLATION
    },
    { name: 'bookings_status_payment_idx', key: { status: 1, paymentStatus: 1 } },
    { name: 'bookings_created_at_idx', key: { createdAt: -1 } }
  ],
  payments: [
    {
      name: 'payments_booking_id_uidx',
      key: { bookingId: 1 },
      unique: true,
      partialFilterExpression: { bookingId: { $type: 'objectId' } }
    },
    {
      name: 'payments_stripe_session_id_uidx',
      key: { stripeSessionId: 1 },
      unique: true,
      partialFilterExpression: { stripeSessionId: { $type: 'string' } }
    },
    { name: 'payments_transaction_id_idx', key: { transactionId: 1 } },
    { name: 'payments_created_at_idx', key: { createdAt: -1 } }
  ]
});
