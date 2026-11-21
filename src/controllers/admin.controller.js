import {
  bookingRepository,
  paymentRepository,
  serviceRepository,
  userRepository
} from '../repositories/index.js';
import { BOOKING_RESPONSE_FIELDS } from '../repositories/booking.repository.js';
import { PAYMENT_ADMIN_FIELDS } from '../repositories/payment.repository.js';
import { ADMIN_SERVICE_FIELDS } from '../repositories/service.repository.js';
import { ADMIN_USER_FIELDS } from '../repositories/user.repository.js';
import { requireCanonicalActor } from '../utils/actorIdentity.js';
import { AppError } from '../utils/AppError.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { pickAllowedFields } from '../utils/projections.js';
import {
  objectIdSchema,
  serviceApprovalUpdateSchema,
  userRoleUpdateSchema
} from '../validators/index.js';

const defaultGetActor = (req) => req.actor;

const parseInput = (schema, value, code, message) => {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new AppError(400, code, message);
  }

  return result.data;
};

const userResponse = (user) => pickAllowedFields(user, ADMIN_USER_FIELDS);
const serviceResponse = (service) => pickAllowedFields(service, ADMIN_SERVICE_FIELDS);
const bookingResponse = (booking) => pickAllowedFields(booking, BOOKING_RESPONSE_FIELDS);
const paymentResponse = (payment) => pickAllowedFields(payment, PAYMENT_ADMIN_FIELDS);

export const createAdminController = ({
  users = userRepository,
  services = serviceRepository,
  bookings = bookingRepository,
  payments = paymentRepository,
  getActor = defaultGetActor
} = {}) => {
  if (typeof getActor !== 'function') {
    throw new TypeError('createAdminController requires a getActor function.');
  }

  const requireAdmin = async (req, res, next) => {
    try {
      req.admin = await requireCanonicalActor({
        req,
        users,
        role: 'admin',
        getActor
      });
      return next();
    } catch (error) {
      return next(error);
    }
  };

  return {
    requireAdmin,
    listUsers: async (req, res) => {
      const result = await users.findAll(req.query);

      return sendSuccess(res, {
        message: 'Users retrieved successfully.',
        ...result,
        items: result.items.map(userResponse)
      });
    },
    updateUserRole: async (req, res) => {
      const id = parseInput(
        objectIdSchema,
        req.params.id,
        'INVALID_OBJECT_ID',
        'Invalid user id.'
      );
      const update = parseInput(
        userRoleUpdateSchema,
        req.body,
        'INVALID_ROLE_UPDATE',
        'Invalid role update.'
      );

      const adminId = req.admin?.id ?? req.admin?._id;

      if (String(id) === String(adminId)) {
        throw new AppError(
          403,
          'SELF_ROLE_CHANGE_FORBIDDEN',
          'Admins cannot change their own role.'
        );
      }

      const user = await users.updateRole(id, update.role);

      return sendSuccess(res, {
        message: 'User role updated successfully.',
        user: userResponse(user)
      });
    },
    listServices: async (req, res) => {
      const result = await services.findAllForAdmin(req.query);

      return sendSuccess(res, {
        message: 'Services retrieved successfully.',
        ...result,
        items: result.items.map(serviceResponse)
      });
    },
    updateServiceApproval: async (req, res) => {
      const id = parseInput(
        objectIdSchema,
        req.params.id,
        'INVALID_OBJECT_ID',
        'Invalid service id.'
      );
      const update = parseInput(
        serviceApprovalUpdateSchema,
        req.body,
        'INVALID_APPROVAL_UPDATE',
        'Invalid approval update.'
      );
      const service = await services.updateApprovalStatus(id, update.approvalStatus);

      return sendSuccess(res, {
        message: 'Service approval updated successfully.',
        service: serviceResponse(service)
      });
    },
    listBookings: async (req, res) => {
      const result = await bookings.findAll(req.query);

      return sendSuccess(res, {
        message: 'Bookings retrieved successfully.',
        ...result,
        items: result.items.map(bookingResponse)
      });
    },
    listPayments: async (req, res) => {
      const result = await payments.findAllWithRevenue(req.query);

      return sendSuccess(res, {
        message: 'Payments retrieved successfully.',
        ...result,
        items: result.items.map(paymentResponse)
      });
    }
  };
};

export const adminController = createAdminController();
