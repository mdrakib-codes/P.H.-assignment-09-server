import { BookingRepository } from './booking.repository.js';
import { PaymentRepository } from './payment.repository.js';
import { ServiceRepository } from './service.repository.js';
import { UserRepository } from './user.repository.js';

export { BaseRepository } from './base.repository.js';
export { BookingRepository } from './booking.repository.js';
export { PaymentRepository } from './payment.repository.js';
export { ServiceRepository } from './service.repository.js';
export { UserRepository } from './user.repository.js';

export const userRepository = new UserRepository();
export const serviceRepository = new ServiceRepository();
export const bookingRepository = new BookingRepository();
export const paymentRepository = new PaymentRepository();

export const repositories = Object.freeze({
  users: userRepository,
  services: serviceRepository,
  bookings: bookingRepository,
  payments: paymentRepository
});
