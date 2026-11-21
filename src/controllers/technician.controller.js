import {
  bookingRepository,
  serviceRepository,
  userRepository
} from '../repositories/index.js';
import { BOOKING_RESPONSE_FIELDS } from '../repositories/booking.repository.js';
import { TECHNICIAN_SERVICE_FIELDS } from '../repositories/service.repository.js';
import { requireCanonicalActor } from '../utils/actorIdentity.js';
import { AppError } from '../utils/AppError.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { pickAllowedFields } from '../utils/projections.js';
import {
  bookingStatusUpdateSchema,
  serviceAvailabilityUpdateSchema,
  serviceCreateInputSchema,
  serviceUpdateSchema
} from '../validators/index.js';

const defaultGetActor = (req) => req.actor;

const parseInput = (schema, value, code, message) => {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new AppError(400, code, message);
  }

  return result.data;
};

const serviceResponse = (service) =>
  pickAllowedFields(service, TECHNICIAN_SERVICE_FIELDS);

const bookingResponse = (booking) =>
  pickAllowedFields(booking, BOOKING_RESPONSE_FIELDS);

export const createTechnicianController = ({
  bookings = bookingRepository,
  services = serviceRepository,
  users = userRepository,
  getActor = defaultGetActor
} = {}) => {
  if (typeof getActor !== 'function') {
    throw new TypeError('getActor must be a function.');
  }

  const requireTechnician = (req) =>
    requireCanonicalActor({ req, users, role: 'technician', getActor });

  return {
    createService: async (req, res) => {
      const technician = await requireTechnician(req);
      const input = parseInput(
        serviceCreateInputSchema,
        req.body,
        'INVALID_SERVICE_INPUT',
        'Invalid service data.'
      );
      const service = await services.create({
        ...input,
        technicianName: technician.name,
        technicianEmail: technician.email,
        approvalStatus: 'pending',
        isAvailable: true
      });

      return sendSuccess(res, {
        statusCode: 201,
        message: 'Service created successfully.',
        service: serviceResponse(service)
      });
    },

    listMyServices: async (req, res) => {
      const technician = await requireTechnician(req);
      const result = await services.findByTechnicianEmail(
        technician.email,
        req.query
      );

      return sendSuccess(res, {
        message: 'Services retrieved successfully.',
        ...result,
        items: result.items.map(serviceResponse)
      });
    },

    updateService: async (req, res) => {
      const technician = await requireTechnician(req);
      const input = parseInput(
        serviceUpdateSchema,
        req.body,
        'INVALID_SERVICE_UPDATE',
        'Invalid service data.'
      );
      const service = await services.updateOwnedById(
        req.params.id,
        input,
        technician.email
      );

      return sendSuccess(res, {
        message: 'Service updated successfully.',
        service: serviceResponse(service)
      });
    },

    deleteService: async (req, res) => {
      const technician = await requireTechnician(req);

      await services.deleteOwnedById(req.params.id, technician.email);

      return sendSuccess(res, {
        message: 'Service deleted successfully.'
      });
    },

    updateAvailability: async (req, res) => {
      const technician = await requireTechnician(req);
      const input = parseInput(
        serviceAvailabilityUpdateSchema,
        req.body,
        'INVALID_AVAILABILITY',
        'Invalid availability value.'
      );
      const service = await services.updateAvailabilityOwnedById(
        req.params.id,
        input.isAvailable,
        technician.email
      );

      return sendSuccess(res, {
        message: 'Service availability updated successfully.',
        service: serviceResponse(service)
      });
    },

    listAssignedBookings: async (req, res) => {
      const technician = await requireTechnician(req);
      const result = await bookings.findByTechnicianEmail(
        technician.email,
        req.query
      );

      return sendSuccess(res, {
        message: 'Bookings retrieved successfully.',
        ...result,
        items: result.items.map(bookingResponse)
      });
    },

    updateBookingStatus: async (req, res) => {
      const technician = await requireTechnician(req);
      const input = parseInput(
        bookingStatusUpdateSchema,
        req.body,
        'INVALID_BOOKING_UPDATE',
        'Invalid booking status update.'
      );
      const booking = await bookings.updateStatus(
        req.params.id,
        input,
        technician.email
      );

      return sendSuccess(res, {
        message: 'Booking status updated successfully.',
        booking: bookingResponse(booking)
      });
    }
  };
};

export const technicianController = createTechnicianController();
