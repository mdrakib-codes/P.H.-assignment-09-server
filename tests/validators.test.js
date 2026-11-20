import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { test } from 'node:test';
import {
  bookingSchema,
  objectIdSchema,
  paymentSchema,
  publicRoleSchema,
  serviceSchema,
  userSchema
} from '../src/validators/index.js';

const objectId = new ObjectId().toHexString();
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

const baseUser = {
  name: 'Test User',
  email: '  Test.User@Example.COM  ',
  phone: '555-1000'
};

const baseService = {
  title: 'Phone screen repair',
  category: 'Smartphone',
  description: 'Replace a damaged screen with a genuine display.',
  image: 'https://cdn.example.com/service.jpg',
  basePrice: 75,
  estimatedDuration: '1-2 hours',
  serviceMode: 'Home Visit',
  serviceArea: 'Downtown',
  technicianName: 'Ada Technician',
  technicianEmail: '  ADA@Example.COM '
};

const baseBooking = {
  serviceId: objectId,
  serviceTitle: 'Phone screen repair',
  serviceImage: 'https://cdn.example.com/service.jpg',
  category: 'Smartphone',
  basePrice: 75,
  technicianName: 'Ada Technician',
  technicianEmail: 'Ada@Example.com',
  customerName: 'Test Customer',
  customerEmail: ' Customer@Example.COM ',
  customerPhone: '555-1000',
  address: '12 Main Street',
  preferredDate: tomorrow,
  problemDescription: 'The screen is cracked and the touch panel is unresponsive.'
};

const basePayment = {
  bookingId: objectId,
  serviceTitle: 'Phone screen repair',
  customerName: 'Test Customer',
  customerEmail: 'Customer@Example.com',
  technicianName: 'Ada Technician',
  technicianEmail: 'Ada@Example.com',
  amount: 75,
  transactionId: 'txn_test_123',
  stripeSessionId: 'cs_test_123'
};

test('user schema normalizes email, defaults role, and rejects invalid roles', () => {
  const user = userSchema.parse(baseUser);
  assert.equal(user.email, 'test.user@example.com');
  assert.equal(user.role, 'customer');
  assert.equal(user.phone, '555-1000');
  assert.throws(() => userSchema.parse({ ...baseUser, role: 'superadmin' }));
});

test('public role input coerces admin to customer', () => {
  assert.equal(publicRoleSchema.parse('admin'), 'customer');
  assert.equal(publicRoleSchema.parse('technician'), 'technician');
});

test('objectId schema accepts ObjectId instances and 24-character hex strings', () => {
  assert.ok(objectIdSchema.parse(objectId) instanceof ObjectId);
  assert.ok(objectIdSchema.parse(new ObjectId()) instanceof ObjectId);
  assert.throws(() => objectIdSchema.parse('not-an-object-id'));
});

test('service schema applies defaults, normalizes email, and enforces enums', () => {
  const service = serviceSchema.parse(baseService);
  assert.equal(service.approvalStatus, 'pending');
  assert.equal(service.isAvailable, true);
  assert.equal(service.technicianEmail, 'ada@example.com');
  assert.throws(() => serviceSchema.parse({ ...baseService, category: 'Unknown' }));
  assert.throws(() => serviceSchema.parse({ ...baseService, basePrice: -1 }));
});

test('booking schema applies defaults, derives finalAmount, and validates rules', () => {
  const booking = bookingSchema.parse(baseBooking);
  assert.equal(booking.status, 'requested');
  assert.equal(booking.paymentStatus, 'unpaid');
  assert.equal(booking.finalAmount, 75);
  assert.equal(booking.customerEmail, 'customer@example.com');

  assert.throws(() =>
    bookingSchema.parse({ ...baseBooking, preferredDate: yesterday })
  );
  assert.throws(() =>
    bookingSchema.parse({ ...baseBooking, problemDescription: 'too short' })
  );
});

test('payment schema applies defaults and enforces payment constraints', () => {
  const payment = paymentSchema.parse(basePayment);
  assert.equal(payment.currency, 'usd');
  assert.equal(payment.paymentStatus, 'paid');
  assert.equal(payment.stripeSessionId, 'cs_test_123');

  const withoutSession = paymentSchema.parse({ ...basePayment, stripeSessionId: undefined });
  assert.equal(withoutSession.stripeSessionId, undefined);

  assert.throws(() => paymentSchema.parse({ ...basePayment, currency: 'eur' }));
  assert.throws(() => paymentSchema.parse({ ...basePayment, amount: 0 }));
  assert.throws(() => paymentSchema.parse({ ...basePayment, bookingId: 'invalid' }));
});
