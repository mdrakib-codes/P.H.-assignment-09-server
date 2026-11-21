import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { test } from 'node:test';
import {
  bookingCreateInputSchema,
  bookingSchema,
  dateOnlySchema,
  objectIdSchema,
  paymentSchema,
  publicRoleSchema,
  serviceSchema,
  stripeSessionIdSchema,
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

const baseBookingInput = {
  serviceId: objectId,
  customerPhone: '555-1000',
  address: '12 Main Street',
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

test('dateOnlySchema accepts real calendar dates and rejects impossible dates', () => {
  assert.equal(dateOnlySchema.parse('2024-02-29'), '2024-02-29');

  for (const invalid of [
    '2026-02-30',
    '2027-02-30',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00'
  ]) {
    assert.throws(() => dateOnlySchema.parse(invalid), /Invalid calendar date|YYYY-MM-DD/);
  }
});

test('booking input rejects impossible and past preferred dates', () => {
  const today = new Date().toISOString().slice(0, 10);

  assert.equal(
    bookingCreateInputSchema.parse({ ...baseBookingInput, preferredDate: today }).preferredDate,
    today
  );
  assert.throws(
    () => bookingCreateInputSchema.parse({ ...baseBookingInput, preferredDate: '2027-02-30' }),
    /Invalid calendar date/
  );
  assert.throws(
    () => bookingCreateInputSchema.parse({ ...baseBookingInput, preferredDate: yesterday }),
    /cannot be in the past/
  );
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
    bookingSchema.parse({ ...baseBooking, preferredDate: '2027-02-30' })
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

test('Stripe session ID schema accepts test and live IDs but rejects malformed values', () => {
  assert.equal(stripeSessionIdSchema.parse('cs_test_ABC123'), 'cs_test_ABC123');
  assert.equal(stripeSessionIdSchema.parse('cs_live_ABC123'), 'cs_live_ABC123');

  for (const invalid of [
    '',
    '  cs_test_ABC123',
    'cs_test_ABC123  ',
    'cs_test_ABC 123',
    `cs_test_${'a'.repeat(300)}`,
    'cs_sandbox_ABC123',
    'cs_test_',
    'pi_test_ABC123'
  ]) {
    assert.throws(() => stripeSessionIdSchema.parse(invalid));
  }
});
