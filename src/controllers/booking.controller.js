import {
  bookingRepository,
  serviceRepository,
  userRepository
} from '../repositories/index.js';
import { BOOKING_RESPONSE_FIELDS } from '../repositories/booking.repository.js';
import { requireCanonicalActor } from '../utils/actorIdentity.js';
import { AppError } from '../utils/AppError.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { pickAllowedFields } from '../utils/projections.js';
import { bookingCreateInputSchema, emailSchema } from '../validators/index.js';

const defaultGetActor = (req) => req.actor;

const parseInput = (schema, value) => {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new AppError(400, 'INVALID_BOOKING_INPUT', 'Invalid booking data.');
  }

  return result.data;
};

export const createBookingController = ({
  bookings = bookingRepository,
  services = serviceRepository,
  users = userRepository,
  getActor = defaultGetActor
} = {}) => {
  if (typeof getActor !== 'function') {
    throw new TypeError('getActor must be a function.');
  }

  const requireCustomer = (req) =>
    requireCanonicalActor({ req, users, role: 'customer', getActor });

  return {
    create: async (req, res) => {
      const customer = await requireCustomer(req);
      const input = parseInput(bookingCreateInputSchema, req.body);
      const service = await services.findPublicById(input.serviceId, {
        includeTechnicianEmail: true
      });
      const technicianEmail = emailSchema.safeParse(service.technicianEmail);

      if (technicianEmail.success && technicianEmail.data === customer.email) {
        throw new AppError(
          403,
          'SELF_BOOKING_NOT_ALLOWED',
          'A technician cannot book their own service.'
        );
      }

      const activeBooking = await bookings.findActiveByCustomerAndService(
        customer.email,
        input.serviceId
      );

      if (activeBooking) {
        throw new AppError(
          409,
          'DUPLICATE_ACTIVE_BOOKING',
          'An active booking already exists for this service.'
        );
      }

      const booking = await bookings.create({
        serviceId: input.serviceId,
        serviceTitle: service.title,
        serviceImage: service.image,
        category: service.category,
        basePrice: service.basePrice,
        technicianName: service.technicianName,
        technicianEmail: service.technicianEmail,
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: input.customerPhone,
        address: input.address,
        preferredDate: input.preferredDate,
        problemDescription: input.problemDescription,
        status: 'requested',
        finalAmount: service.basePrice,
        paymentStatus: 'unpaid'
      });

      return sendSuccess(res, {
        statusCode: 201,
        message: 'Booking created successfully.',
        booking: pickAllowedFields(booking, BOOKING_RESPONSE_FIELDS)
      });
    },

    listMine: async (req, res) => {
      const customer = await requireCustomer(req);
      const result = await bookings.findByCustomerEmail(customer.email, req.query);

      return sendSuccess(res, {
        message: 'Bookings retrieved successfully.',
        ...result,
        items: result.items.map((booking) =>
          pickAllowedFields(booking, BOOKING_RESPONSE_FIELDS)
        )
      });
    },

    cancel: async (req, res) => {
      const customer = await requireCustomer(req);
      const booking = await bookings.cancelById(req.params.id, customer.email);

      return sendSuccess(res, {
        message: 'Booking cancelled successfully.',
        booking: pickAllowedFields(booking, BOOKING_RESPONSE_FIELDS)
      });
    }
  };
};

export const bookingController = createBookingController();
