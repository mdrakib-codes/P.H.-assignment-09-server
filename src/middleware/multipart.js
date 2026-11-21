import express from 'express';
import { AppError } from '../utils/AppError.js';
import {
  UPLOAD_FIELD_NAME,
  UPLOAD_MAX_BODY_BYTES,
  UPLOAD_MAX_FILE_BYTES,
  validateImageFile
} from '../validators/upload.validator.js';

const CRLF = Buffer.from([0x0d, 0x0a]);
const CRLF_CRLF = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a]);
const DASHES = Buffer.from('--');
const BOUNDARY_PATTERN = /boundary=(?:"([^"]+)"|([^;,\s]+))/i;
const BOUNDARY_CHAR_PATTERN = /^[0-9A-Za-z'()+_,\-./:=? ]{1,70}$/;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_HEADER_LINES = 32;

const invalidUpload = () =>
  new AppError(400, 'INVALID_UPLOAD_INPUT', 'Invalid image upload.');

const headerValue = (headersText, name) => {
  const line = headersText
    .split('\r\n')
    .find((entry) => entry.toLowerCase().startsWith(`${name}:`));

  if (!line) {
    return null;
  }

  return line.slice(line.indexOf(':') + 1).trim();
};

const parseDisposition = (headersText) => {
  const value = headerValue(headersText, 'content-disposition');

  if (!value || !/^form-data\b/i.test(value)) {
    return null;
  }

  const nameMatch = /(?:^|;)\s*name=(?:"([^"]*)"|([^;]*))/i.exec(value);
  const filenameMatch = /(?:^|;)\s*filename=(?:"([^"]*)"|([^;]*))/i.exec(value);

  return {
    name: (nameMatch?.[1] ?? nameMatch?.[2] ?? '').trim(),
    filename: filenameMatch
      ? (filenameMatch[1] ?? filenameMatch[2] ?? '').trim()
      : null
  };
};

const findBoundary = (body, start, nextBoundaryToken) => {
  let index = body.indexOf(nextBoundaryToken, start);

  while (index !== -1) {
    const after = index + nextBoundaryToken.length;
    const tail = body.subarray(after, after + 2);

    if (tail.equals(CRLF) || tail.equals(DASHES)) {
      return index;
    }

    index = body.indexOf(nextBoundaryToken, index + 1);
  }

  return -1;
};

export const parseMultipartImage = (
  body,
  contentTypeHeader,
  { fieldName = UPLOAD_FIELD_NAME, maxFileBytes = UPLOAD_MAX_FILE_BYTES } = {}
) => {
  if (!Buffer.isBuffer(body)) {
    throw invalidUpload();
  }

  const boundaryMatch = BOUNDARY_PATTERN.exec(String(contentTypeHeader ?? ''));
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2] || '';

  if (!BOUNDARY_CHAR_PATTERN.test(boundary)) {
    throw invalidUpload();
  }

  const boundaryToken = Buffer.from(`--${boundary}`);
  const plainBoundaryToken = Buffer.from(boundary);
  const nextBoundaryToken = Buffer.concat([CRLF, boundaryToken]);

  if (!body.subarray(0, boundaryToken.length).equals(boundaryToken)) {
    throw invalidUpload();
  }

  let position = boundaryToken.length;
  let sawClosing = false;
  let upload = null;
  let partCount = 0;

  while (position < body.length) {
    if (!body.subarray(position, position + 2).equals(CRLF)) {
      throw invalidUpload();
    }

    position += 2;

    if (body.subarray(position, position + 2).equals(DASHES)) {
      position += 2;

      if (
        !body.subarray(position, position + plainBoundaryToken.length).equals(plainBoundaryToken)
      ) {
        throw invalidUpload();
      }

      position += plainBoundaryToken.length;
      const remaining = body.subarray(position);

      if (remaining.length > 0 && !remaining.equals(CRLF)) {
        throw invalidUpload();
      }

      sawClosing = true;
      break;
    }

    const headerEnd = body.indexOf(CRLF_CRLF, position);

    if (headerEnd === -1 || headerEnd - position > MAX_HEADER_BYTES) {
      throw invalidUpload();
    }

    const headersText = body.subarray(position, headerEnd).toString('utf8');

    if (headersText.split('\r\n').length > MAX_HEADER_LINES) {
      throw invalidUpload();
    }

    position = headerEnd + CRLF_CRLF.length;

    const boundaryIndex = findBoundary(body, position, nextBoundaryToken);

    if (boundaryIndex === -1) {
      throw invalidUpload();
    }

    const content = body.subarray(position, boundaryIndex);
    position = boundaryIndex + nextBoundaryToken.length;
    partCount += 1;

    if (partCount > 1) {
      throw invalidUpload();
    }

    const disposition = parseDisposition(headersText);

    if (!disposition || disposition.name !== fieldName || !disposition.filename) {
      throw invalidUpload();
    }

    const mimeType =
      headerValue(headersText, 'content-type')?.split(';')[0].trim().toLowerCase() || '';
    const file = validateImageFile({
      buffer: content,
      filename: disposition.filename,
      mimeType,
      fieldName,
      maxFileBytes
    });

    if (!file) {
      throw invalidUpload();
    }

    upload = file;

    if (body.subarray(position, position + 2).equals(DASHES)) {
      position += 2;
      const remaining = body.subarray(position);

      if (remaining.length > 0 && !remaining.equals(CRLF)) {
        throw invalidUpload();
      }

      sawClosing = true;
      break;
    }
  }

  if (!sawClosing || !upload || partCount !== 1) {
    throw invalidUpload();
  }

  return upload;
};

export const createImageMultipartParser = ({
  fieldName = UPLOAD_FIELD_NAME,
  maxFileBytes = UPLOAD_MAX_FILE_BYTES,
  maxBodyBytes = UPLOAD_MAX_BODY_BYTES,
  rawParser
} = {}) => {
  if (typeof fieldName !== 'string' || fieldName.length === 0) {
    throw new TypeError('createImageMultipartParser requires a field name.');
  }

  const readRawBody =
    typeof rawParser === 'function'
      ? rawParser
      : express.raw({ type: 'multipart/form-data', limit: maxBodyBytes });

  return (req, res, next) =>
    readRawBody(req, res, (error) => {
      if (error) {
        return next(error);
      }

      try {
        const contentType = req.get?.('content-type') ?? req.headers?.['content-type'] ?? '';
        req.upload = parseMultipartImage(req.body, contentType, { fieldName, maxFileBytes });
        return next();
      } catch (parseError) {
        return next(parseError);
      }
    });
};

export const imageMultipartParser = createImageMultipartParser();
