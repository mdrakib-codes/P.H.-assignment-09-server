import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { UPLOAD_TIMEOUT_MS, imgbbUploadResponseSchema } from '../validators/upload.validator.js';

const IMGBB_ENDPOINT = 'https://api.imgbb.com/1/upload';

const providerError = (statusCode, code, message) =>
  new AppError(statusCode, code, message);

export const createImgbbClient = ({
  apiKey = env.imgbbApiKey,
  fetchImpl = fetch,
  endpoint = IMGBB_ENDPOINT,
  timeoutMs = UPLOAD_TIMEOUT_MS
} = {}) => {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createImgbbClient requires a fetch implementation.');
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('createImgbbClient requires a positive timeoutMs.');
  }

  return {
    async uploadImage({ buffer, mimeType, filename }) {
      if (
        !apiKey ||
        typeof apiKey !== 'string' ||
        !Buffer.isBuffer(buffer) ||
        buffer.length === 0 ||
        typeof mimeType !== 'string' ||
        typeof filename !== 'string' ||
        filename.length === 0
      ) {
        throw providerError(
          503,
          'IMAGE_PROVIDER_NOT_CONFIGURED',
          'Image upload is not configured.'
        );
      }

      const form = new FormData();
      form.append('key', apiKey);
      form.append('image', new Blob([buffer], { type: mimeType }), filename);

      let response;

      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch {
        throw providerError(
          502,
          'IMAGE_PROVIDER_UNAVAILABLE',
          'Image upload service is unavailable.'
        );
      }

      if (
        !response ||
        typeof response.ok !== 'boolean' ||
        typeof response.status !== 'number' ||
        typeof response.json !== 'function'
      ) {
        throw providerError(
          502,
          'IMAGE_PROVIDER_INVALID_RESPONSE',
          'Image upload service returned an invalid response.'
        );
      }

      if (response.status === 429) {
        throw providerError(
          503,
          'IMAGE_PROVIDER_UNAVAILABLE',
          'Image upload service is rate limited. Please try again later.'
        );
      }

      if (!response.ok) {
        throw providerError(
          502,
          'IMAGE_PROVIDER_UNAVAILABLE',
          'Image upload service is unavailable.'
        );
      }

      let payload;

      try {
        payload = await response.json();
      } catch {
        throw providerError(
          502,
          'IMAGE_PROVIDER_INVALID_RESPONSE',
          'Image upload service returned an invalid response.'
        );
      }

      const parsed = imgbbUploadResponseSchema.safeParse(payload);

      if (!parsed.success) {
        throw providerError(
          502,
          'IMAGE_PROVIDER_INVALID_RESPONSE',
          'Image upload service returned an invalid response.'
        );
      }

      return {
        url: parsed.data.data.url,
        width: parsed.data.data.width,
        height: parsed.data.data.height,
        size: parsed.data.data.size
      };
    }
  };
};

export const imgbbClient = createImgbbClient();
