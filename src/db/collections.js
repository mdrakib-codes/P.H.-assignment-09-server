import { getDb } from '../config/database.js';

export const COLLECTION_NAMES = Object.freeze({
  users: 'users',
  services: 'services',
  bookings: 'bookings',
  payments: 'payments'
});

export const getCollection = (collectionKey) => {
  const name = COLLECTION_NAMES[collectionKey];

  if (!name) {
    throw new Error(`Unknown application collection: ${collectionKey}`);
  }

  return getDb().collection(name);
};

export const getUserCollection = () => getCollection('users');
export const getServiceCollection = () => getCollection('services');
export const getBookingCollection = () => getCollection('bookings');
export const getPaymentCollection = () => getCollection('payments');
