import { userRepository } from '../repositories/index.js';
import { USER_PROFILE_FIELDS } from '../repositories/user.repository.js';
import { requireAnyCanonicalActor } from '../utils/actorIdentity.js';
import { AppError } from '../utils/AppError.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { pickAllowedFields } from '../utils/projections.js';
import { userProfileUpdateSchema } from '../validators/index.js';

const defaultGetActor = (req) => req.actor;

const parseInput = (value, code, message) => {
  const result = userProfileUpdateSchema.safeParse(value);

  if (!result.success) {
    throw new AppError(400, code, message);
  }

  return result.data;
};

const profileResponse = (user) => pickAllowedFields(user, USER_PROFILE_FIELDS);

export const createUserController = ({
  users = userRepository,
  getActor = defaultGetActor
} = {}) => {
  if (typeof getActor !== 'function') {
    throw new TypeError('createUserController requires a getActor function.');
  }

  return {
    updateProfile: async (req, res) => {
      const actor = await requireAnyCanonicalActor({ req, users, getActor });
      const update = parseInput(
        req.body,
        'INVALID_PROFILE_UPDATE',
        'Invalid profile update.'
      );

      if (Object.keys(update).length === 0) {
        throw new AppError(
          400,
          'INVALID_PROFILE_UPDATE',
          'No profile fields provided.'
        );
      }

      const user = await users.updateById(actor.id, update);

      return sendSuccess(res, {
        message: 'Profile updated successfully.',
        user: profileResponse(user)
      });
    }
  };
};

export const userController = createUserController();
