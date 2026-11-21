import { userRepository } from '../repositories/index.js';
import { imgbbClient } from '../services/imgbb.service.js';
import { requireAnyCanonicalActor } from '../utils/actorIdentity.js';
import { AppError } from '../utils/AppError.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { pickAllowedFields } from '../utils/projections.js';

const UPLOAD_RESPONSE_FIELDS = ['url', 'width', 'height', 'size'];
const defaultGetActor = (req) => req.actor;

export const createUploadController = ({
  images = imgbbClient,
  users = userRepository,
  getActor = defaultGetActor
} = {}) => {
  if (
    typeof getActor !== 'function' ||
    !images ||
    typeof images.uploadImage !== 'function'
  ) {
    throw new TypeError(
      'createUploadController requires a getActor function and an image provider.'
    );
  }

  return {
    uploadImage: async (req, res) => {
      await requireAnyCanonicalActor({ req, users, getActor });

      const file = req.upload;

      if (!file || !Buffer.isBuffer(file.buffer)) {
        throw new AppError(
          400,
          'INVALID_UPLOAD_INPUT',
          'A valid image file is required.'
        );
      }

      const result = await images.uploadImage(file);

      if (!result || typeof result.url !== 'string') {
        throw new AppError(
          502,
          'IMAGE_PROVIDER_INVALID_RESPONSE',
          'Image upload service returned an invalid response.'
        );
      }

      return sendSuccess(res, {
        message: 'Image uploaded successfully.',
        image: pickAllowedFields(result, UPLOAD_RESPONSE_FIELDS)
      });
    }
  };
};

export const uploadController = createUploadController();
