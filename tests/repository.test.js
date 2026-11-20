process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/fixmate_test';

import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { test } from 'node:test';

const {
  BookingRepository,
  PaymentRepository,
  ServiceRepository,
  UserRepository,
  repositories
} = await import('../src/repositories/index.js');

const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const objectId = new ObjectId();
const otherObjectId = new ObjectId();

const baseUser = {
  name: 'Test User',
  email: 'Test.User@Example.COM'
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
  technicianEmail: 'ADA@Example.COM'
};

const baseBooking = {
  serviceId: objectId.toHexString(),
  serviceTitle: 'Phone screen repair',
  serviceImage: 'https://cdn.example.com/service.jpg',
  category: 'Smartphone',
  basePrice: 75,
  technicianName: 'Ada Technician',
  technicianEmail: 'Ada@Example.com',
  customerName: 'Test Customer',
  customerEmail: 'Customer@Example.COM',
  customerPhone: '555-1000',
  address: '12 Main Street',
  preferredDate: tomorrow,
  problemDescription: 'The screen is cracked and the touch panel is unresponsive.'
};

const basePayment = {
  bookingId: objectId.toHexString(),
  serviceTitle: 'Phone screen repair',
  customerName: 'Test Customer',
  customerEmail: 'Customer@Example.com',
  technicianName: 'Ada Technician',
  technicianEmail: 'Ada@Example.com',
  amount: 75,
  transactionId: 'txn_test_123',
  stripeSessionId: 'cs_test_123'
};

const makeCursor = (calls, documents) => {
  const cursor = {
    sort(value) {
      calls.push({ type: 'sort', value });
      return cursor;
    },
    skip(value) {
      calls.push({ type: 'skip', value });
      return cursor;
    },
    limit(value) {
      calls.push({ type: 'limit', value });
      return cursor;
    },
    async toArray() {
      calls.push({ type: 'toArray' });
      return documents;
    }
  };

  return cursor;
};

const makeCollection = ({
  findOneResult = null,
  updateResult = null,
  deleteResult = null,
  documents = [],
  total = 0,
  insertError = null,
  updateError = null
} = {}) => {
  const calls = [];
  const inserted = [];
  let stored = findOneResult;

  return {
    calls,
    inserted,
    async insertOne(document) {
      calls.push({ type: 'insertOne', document });
      if (insertError) {
        throw insertError;
      }
      inserted.push(document);
      stored = document;
      return { acknowledged: true, insertedId: document._id };
    },
    async findOne(filter, options) {
      calls.push({ type: 'findOne', filter, options });
      return stored;
    },
    async findOneAndUpdate(filter, update, options) {
      calls.push({ type: 'findOneAndUpdate', filter, update, options });
      if (updateError) {
        throw updateError;
      }
      return updateResult;
    },
    async findOneAndDelete(filter, options) {
      calls.push({ type: 'findOneAndDelete', filter, options });
      return deleteResult;
    },
    find(filter, options) {
      calls.push({ type: 'find', filter, options });
      return makeCursor(calls, documents);
    },
    async countDocuments(filter) {
      calls.push({ type: 'countDocuments', filter });
      return total;
    }
  };
};

const makeRepo = (Repository, collection, options = {}) =>
  new Repository({
    ...options,
    collectionFactory: () => collection
  });

test('repository singletons map to the four application collections', () => {
  assert.deepEqual(Object.keys(repositories), [
    'users',
    'services',
    'bookings',
    'payments'
  ]);
  assert.deepEqual(
    Object.values(repositories).map((repository) => repository.collectionName),
    ['users', 'services', 'bookings', 'payments']
  );
  assert.equal(repositories.users.projection.passwordHash, 0);
});

test('invalid ObjectIds are rejected before any database access', async () => {
  const collection = makeCollection();
  const repository = makeRepo(UserRepository, collection);

  await assert.rejects(
    () => repository.findById('not-an-object-id'),
    (error) =>
      error.statusCode === 400 && error.code === 'INVALID_OBJECT_ID'
  );

  assert.equal(collection.calls.length, 0);
});

test('user email lookups normalize email and exclude sensitive fields', async () => {
  const collection = makeCollection({
    findOneResult: { _id: objectId, name: 'Test User' }
  });
  const repository = makeRepo(UserRepository, collection);

  const user = await repository.findByEmail('  Test.User@Example.COM  ');

  assert.ok(user);
  assert.equal(collection.calls[0].filter.email, 'test.user@example.com');
  assert.equal(collection.calls[0].options.projection.passwordHash, 0);
  assert.equal(collection.calls[0].options.projection.tokens, 0);
});

test('user creation normalizes email and ignores client/admin roles', async () => {
  const collection = makeCollection();
  const repository = makeRepo(UserRepository, collection);

  const user = await repository.create(
    { ...baseUser, role: 'admin' },
    { role: 'admin' }
  );

  assert.equal(user.email, 'test.user@example.com');
  assert.equal(user.role, 'customer');
  assert.equal(collection.inserted[0].email, 'test.user@example.com');
  assert.equal(collection.inserted[0].role, 'customer');
});

test('user updates reject role/email changes and apply updatedAt', async () => {
  const collection = makeCollection({
    updateResult: { _id: objectId, name: 'Updated User' }
  });
  const repository = makeRepo(UserRepository, collection);

  await assert.rejects(
    () => repository.updateById(objectId, { role: 'admin' }),
    (error) => error.statusCode === 400 && error.code === 'INVALID_UPDATE'
  );
  await assert.rejects(
    () => repository.updateById(objectId, { email: 'new@example.com' }),
    (error) => error.statusCode === 400 && error.code === 'INVALID_UPDATE'
  );

  await repository.updateById(objectId, { name: 'Updated User' });

  const updateCall = collection.calls.find(
    (call) => call.type === 'findOneAndUpdate'
  );
  assert.equal(updateCall.update.$set.name, 'Updated User');
  assert.ok(updateCall.update.$set.updatedAt instanceof Date);
  assert.equal(updateCall.update.$set._id, undefined);
  assert.equal(updateCall.update.$set.createdAt, undefined);
});

test('user listing applies role/search filters, pagination, and safe projection', async () => {
  const collection = makeCollection({
    documents: [{ _id: objectId, name: 'A+B User' }],
    total: 7
  });
  const repository = makeRepo(UserRepository, collection);

  const result = await repository.findAll({
    role: 'customer',
    search: 'a+b',
    page: '2',
    limit: '3'
  });

  assert.equal(result.total, 7);
  assert.equal(result.totalPages, 3);
  assert.equal(collection.calls[0].filter.role, 'customer');
  assert.equal(collection.calls[0].filter.$or[0].name.$regex, 'a\\+b');
  assert.equal(collection.calls[0].options.projection.passwordHash, 0);
  assert.equal(collection.calls[1].value.createdAt, -1);
  assert.equal(collection.calls[2].value, 3);
  assert.equal(collection.calls[3].value, 3);
});

test('missing documents produce a centralized 404 AppError', async () => {
  const collection = makeCollection({ updateResult: null });
  const repository = makeRepo(UserRepository, collection);

  await assert.rejects(
    () => repository.updateById(objectId, { name: 'Nobody' }),
    (error) => error.statusCode === 404 && error.code === 'NOT_FOUND'
  );
});

test('service creation forces pending approval and updateById resets approval', async () => {
  const collection = makeCollection({
    updateResult: { _id: objectId, title: 'Updated service' }
  });
  const repository = makeRepo(ServiceRepository, collection);

  const service = await repository.create({
    ...baseService,
    approvalStatus: 'approved',
    isAvailable: false
  });

  assert.equal(service.approvalStatus, 'pending');
  assert.equal(service.isAvailable, true);
  assert.equal(service.technicianEmail, 'ada@example.com');

  await repository.updateById(service._id, { title: 'Updated service' });

  const updateCall = collection.calls.find(
    (call) => call.type === 'findOneAndUpdate'
  );
  assert.equal(updateCall.update.$set.title, 'Updated service');
  assert.equal(updateCall.update.$set.approvalStatus, 'pending');
  assert.ok(updateCall.update.$set.updatedAt instanceof Date);
});

test('public service listing applies approval, availability, search, sort, and pagination', async () => {
  const collection = makeCollection({
    documents: [{ _id: objectId }],
    total: 2
  });
  const repository = makeRepo(ServiceRepository, collection);

  const result = await repository.findPublicServices({
    category: 'Smartphone',
    serviceMode: 'Home Visit',
    search: 'screen+',
    sort: 'price-asc',
    page: '1',
    limit: '2'
  });

  const findCall = collection.calls.find((call) => call.type === 'find');
  assert.equal(findCall.filter.approvalStatus, 'approved');
  assert.equal(findCall.filter.isAvailable, true);
  assert.equal(findCall.filter.category, 'Smartphone');
  assert.equal(findCall.filter.serviceMode, 'Home Visit');
  assert.equal(findCall.filter.$or[0].title.$regex, 'screen\\+');
  assert.equal(collection.calls[1].value.basePrice, 1);
  assert.equal(result.totalPages, 1);
});

test('service approval and availability methods validate server-controlled fields', async () => {
  const collection = makeCollection({
    updateResult: { _id: objectId, approvalStatus: 'approved' }
  });
  const repository = makeRepo(ServiceRepository, collection);

  await assert.rejects(
    () => repository.updateApprovalStatus(objectId, 'approved!'),
    (error) =>
      error.statusCode === 400 && error.code === 'INVALID_APPROVAL_STATUS'
  );

  await repository.updateApprovalStatus(objectId, 'approved');
  await repository.updateAvailability(objectId, false);

  const calls = collection.calls.filter(
    (call) => call.type === 'findOneAndUpdate'
  );
  assert.equal(calls[0].update.$set.approvalStatus, 'approved');
  assert.equal(calls[1].update.$set.isAvailable, false);
});

test('service delete reports missing services', async () => {
  const collection = makeCollection({ deleteResult: null });
  const repository = makeRepo(ServiceRepository, collection);

  await assert.rejects(
    () => repository.deleteById(objectId),
    (error) => error.statusCode === 404 && error.code === 'NOT_FOUND'
  );
});

test('booking creation normalizes emails and ignores client status/amount/payment', async () => {
  const collection = makeCollection();
  const repository = makeRepo(BookingRepository, collection);

  const booking = await repository.create({
    ...baseBooking,
    customerEmail: '  Customer@Example.COM  ',
    status: 'completed',
    finalAmount: 999,
    paymentStatus: 'paid'
  });

  assert.equal(booking.status, 'requested');
  assert.equal(booking.paymentStatus, 'unpaid');
  assert.equal(booking.finalAmount, 75);
  assert.equal(booking.customerEmail, 'customer@example.com');
  assert.ok(booking.serviceId instanceof ObjectId);
});

test('booking status transitions follow the documented pipeline', async () => {
  const invalidCollection = makeCollection({
    findOneResult: { _id: objectId, status: 'requested' }
  });
  const invalidRepository = makeRepo(BookingRepository, invalidCollection);

  await assert.rejects(
    () => invalidRepository.updateStatus(objectId, { status: 'completed' }),
    (error) =>
      error.statusCode === 409 && error.code === 'INVALID_STATUS_TRANSITION'
  );

  const missingAmountCollection = makeCollection({
    findOneResult: { _id: objectId, status: 'in-progress' }
  });
  const missingAmountRepository = makeRepo(
    BookingRepository,
    missingAmountCollection
  );

  await assert.rejects(
    () =>
      missingAmountRepository.updateStatus(objectId, { status: 'completed' }),
    (error) =>
      error.statusCode === 400 && error.code === 'FINAL_AMOUNT_REQUIRED'
  );

  const collection = makeCollection({
    findOneResult: { _id: objectId, status: 'in-progress' },
    updateResult: { _id: objectId, status: 'completed', finalAmount: 90 }
  });
  const repository = makeRepo(BookingRepository, collection);

  await repository.updateStatus(objectId, {
    status: 'completed',
    finalAmount: 90
  });

  const updateCall = collection.calls.find(
    (call) => call.type === 'findOneAndUpdate'
  );
  assert.deepEqual(updateCall.filter, { _id: objectId, status: 'in-progress' });
  assert.equal(updateCall.update.$set.status, 'completed');
  assert.equal(updateCall.update.$set.finalAmount, 90);
  assert.ok(updateCall.update.$set.updatedAt instanceof Date);
});

test('booking payment status update requires completed unpaid state', async () => {
  const collection = makeCollection({
    findOneResult: { _id: objectId, status: 'completed', paymentStatus: 'unpaid' },
    updateResult: { _id: objectId, status: 'completed', paymentStatus: 'paid' }
  });
  const repository = makeRepo(BookingRepository, collection);

  await repository.updatePaymentStatus(objectId);

  const updateCall = collection.calls.find(
    (call) => call.type === 'findOneAndUpdate'
  );
  assert.deepEqual(updateCall.filter, {
    _id: objectId,
    status: 'completed',
    paymentStatus: 'unpaid'
  });
  assert.equal(updateCall.update.$set.paymentStatus, 'paid');

  const blockedCollection = makeCollection({
    findOneResult: { _id: objectId, status: 'completed', paymentStatus: 'paid' }
  });
  const blockedRepository = makeRepo(BookingRepository, blockedCollection);

  await assert.rejects(
    () => blockedRepository.updatePaymentStatus(objectId),
    (error) => error.statusCode === 409 && error.code === 'PAYMENT_NOT_ALLOWED'
  );
});

test('booking filters normalize emails and support active-duplicate queries', async () => {
  const collection = makeCollection({ documents: [], total: 0 });
  const repository = makeRepo(BookingRepository, collection);

  await repository.findActiveByCustomerAndService(
    '  Customer@Example.COM  ',
    objectId.toHexString()
  );

  assert.deepEqual(collection.calls[0].filter, {
    customerEmail: 'customer@example.com',
    serviceId: objectId,
    status: { $in: ['requested', 'accepted', 'in-progress'] }
  });

  await repository.findByTechnicianEmail('  ADA@Example.COM  ', {
    status: 'accepted',
    paymentStatus: 'unpaid',
    limit: '2'
  });

  const findCall = collection.calls.find((call) => call.type === 'find');
  assert.equal(findCall.filter.technicianEmail, 'ada@example.com');
  assert.equal(findCall.filter.status, 'accepted');
  assert.equal(findCall.filter.paymentStatus, 'unpaid');
  assert.equal(collection.calls[4].value, 2);
});

test('payment creation forces paid state and maps duplicate keys', async () => {
  const collection = makeCollection();
  const repository = makeRepo(PaymentRepository, collection);

  const payment = await repository.create({
    ...basePayment,
    customerEmail: '  Customer@Example.COM  ',
    paymentStatus: 'unpaid'
  });

  assert.equal(payment.paymentStatus, 'paid');
  assert.equal(payment.customerEmail, 'customer@example.com');

  const error = new Error('duplicate key');
  error.code = 11000;
  const duplicateCollection = makeCollection({ insertError: error });
  const duplicateRepository = makeRepo(PaymentRepository, duplicateCollection);

  await assert.rejects(
    () => duplicateRepository.create(basePayment),
    (failure) =>
      failure.statusCode === 409 && failure.code === 'DUPLICATE_KEY'
  );
});

test('payment lookup methods validate identifiers and normalize session IDs', async () => {
  const collection = makeCollection({ findOneResult: { _id: objectId } });
  const repository = makeRepo(PaymentRepository, collection);

  await repository.findByStripeSessionId('  cs_test_123  ');
  await repository.findByTransactionId('  txn_test_123  ');
  await repository.findByBookingId(objectId.toHexString());

  assert.equal(collection.calls[0].filter.stripeSessionId, 'cs_test_123');
  assert.equal(collection.calls[1].filter.transactionId, 'txn_test_123');
  assert.ok(collection.calls[2].filter.bookingId instanceof ObjectId);

  await assert.rejects(
    () => repository.findByBookingId('bad-id'),
    (error) =>
      error.statusCode === 400 && error.code === 'INVALID_OBJECT_ID'
  );
});

test('remaining list methods apply their documented filters', async () => {
  const categoryCollection = makeCollection({ total: 1 });
  const categoryRepository = makeRepo(ServiceRepository, categoryCollection);

  await categoryRepository.findByCategory('AC', { limit: '1' });

  assert.equal(categoryCollection.calls[0].filter.category, 'AC');
  assert.equal(categoryCollection.calls[0].filter.approvalStatus, 'approved');

  const pendingCollection = makeCollection({ total: 1 });
  const pendingRepository = makeRepo(ServiceRepository, pendingCollection);

  await pendingRepository.findPendingApproval({ limit: '1' });

  assert.equal(pendingCollection.calls[0].filter.approvalStatus, 'pending');
  assert.equal(pendingCollection.calls[1].value.createdAt, 1);

  const customerCollection = makeCollection({ total: 1 });
  const bookingRepository = makeRepo(BookingRepository, customerCollection);

  await bookingRepository.findByCustomerEmail('  Customer@Example.COM  ', {
    status: 'requested'
  });

  assert.equal(customerCollection.calls[0].filter.customerEmail, 'customer@example.com');
  assert.equal(customerCollection.calls[0].filter.status, 'requested');

  const allCollection = makeCollection({ total: 1 });
  const allRepository = makeRepo(BookingRepository, allCollection);

  await allRepository.findAll({ paymentStatus: 'paid' });

  assert.equal(allCollection.calls[0].filter.paymentStatus, 'paid');
});

test('user role updates validate role values and apply updatedAt', async () => {
  const collection = makeCollection({
    updateResult: { _id: objectId, role: 'technician' }
  });
  const repository = makeRepo(UserRepository, collection);

  await assert.rejects(
    () => repository.updateRole(objectId, 'superadmin'),
    (error) => error.statusCode === 400 && error.code === 'INVALID_ROLE'
  );

  await repository.updateRole(objectId, 'technician');

  const updateCall = collection.calls.find(
    (call) => call.type === 'findOneAndUpdate'
  );
  assert.equal(updateCall.update.$set.role, 'technician');
  assert.ok(updateCall.update.$set.updatedAt instanceof Date);
});

test('invalid query parameters and connection failures use AppError codes', async () => {
  const serviceRepository = makeRepo(ServiceRepository, makeCollection());

  await assert.rejects(
    () => serviceRepository.findPublicServices({ limit: 0 }),
    (error) => error.statusCode === 400 && error.code === 'INVALID_QUERY'
  );

  const error = new Error('MongoDB is not connected.');
  const disconnectedRepository = new UserRepository({
    collectionFactory: () => {
      throw error;
    }
  });

  await assert.rejects(
    () => disconnectedRepository.findById(objectId),
    (failure) =>
      failure.statusCode === 503 && failure.code === 'DATABASE_UNAVAILABLE'
  );
});

test('unexpected database errors become safe generic AppErrors', async () => {
  const collection = makeCollection({
    updateResult: null,
    updateError: new Error('internal detail must not escape')
  });
  const repository = makeRepo(UserRepository, collection);

  await assert.rejects(
    () => repository.updateById(objectId, { name: 'Updated' }),
    (error) =>
      error.statusCode === 500 &&
      error.code === 'DATABASE_ERROR' &&
      error.message === 'Database operation failed.'
  );
});
