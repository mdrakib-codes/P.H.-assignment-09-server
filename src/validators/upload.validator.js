import { z } from 'zod';
import { urlSchema } from './shared.js';

export const UPLOAD_FIELD_NAME = 'image';
export const UPLOAD_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const UPLOAD_MAX_BODY_BYTES = 6 * 1024 * 1024;
export const UPLOAD_TIMEOUT_MS = 10000;

export const UPLOAD_IMAGE_EXTENSIONS = Object.freeze({
  'image/jpeg': Object.freeze(new Set(['jpg', 'jpeg'])),
  'image/png': Object.freeze(new Set(['png'])),
  'image/webp': Object.freeze(new Set(['webp'])),
  'image/gif': Object.freeze(new Set(['gif']))
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export const sniffImageMimeType = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }

  if (buffer.subarray(0, 3).equals(JPEG_SIGNATURE)) {
    return 'image/jpeg';
  }

  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }

  const prefix = buffer.subarray(0, 6).toString('ascii');
  if (prefix === 'GIF87a' || prefix === 'GIF89a') {
    return 'image/gif';
  }

  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
};

const sanitizeUploadFilename = (filename) => {
  const base = String(filename ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop();

  if (!base || base.includes('\0') || base.length > 255) {
    return null;
  }

  return base;
};

const getExtension = (filename) => {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
};

export const validateImageFile = ({
  buffer,
  filename,
  mimeType,
  fieldName = UPLOAD_FIELD_NAME,
  maxFileBytes = UPLOAD_MAX_FILE_BYTES
}) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > maxFileBytes) {
    return null;
  }

  const safeFilename = sanitizeUploadFilename(filename);
  if (!safeFilename) {
    return null;
  }

  const allowedExtensions = UPLOAD_IMAGE_EXTENSIONS[mimeType];
  if (!allowedExtensions || !allowedExtensions.has(getExtension(safeFilename))) {
    return null;
  }

  if (sniffImageMimeType(buffer) !== mimeType) {
    return null;
  }

  return {
    fieldName,
    filename: safeFilename,
    mimeType,
    size: buffer.length,
    buffer
  };
};

const positiveIntegerSchema = z.coerce.number().int().positive();

export const imgbbUploadResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    url: urlSchema,
    width: positiveIntegerSchema.optional(),
    height: positiveIntegerSchema.optional(),
    size: positiveIntegerSchema.optional()
  })
});
