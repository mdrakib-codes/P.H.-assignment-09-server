import { Router } from 'express';
import { createImageMultipartParser } from '../middleware/multipart.js';

export const createUploadRoutes = ({
  controller,
  requireActor,
  multipartParser = createImageMultipartParser()
} = {}) => {
  if (typeof requireActor !== 'function') {
    throw new TypeError('createUploadRoutes requires a requireActor middleware.');
  }

  if (typeof multipartParser !== 'function') {
    throw new TypeError('createUploadRoutes requires a multipartParser middleware.');
  }

  if (!controller || typeof controller.uploadImage !== 'function') {
    throw new TypeError('createUploadRoutes requires an uploadImage controller.');
  }

  const router = Router();

  router.post('/imgbb', requireActor, multipartParser, controller.uploadImage);

  return router;
};
