import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { badRequest } from '../utils/errors';
import { ok } from '../utils/http';
import { imageUpload, mapUploadError, saveEventImage } from '../services/uploads';

const r = Router();

/** POST /uploads/event-image  (multipart/form-data, field "file") → { url }. Organisers only. */
r.post(
  '/uploads/event-image',
  requireAuth,
  requireRole('organiser'),
  (req, res, next) => {
    imageUpload.single('file')(req, res, (err: unknown) => {
      if (err) return next(mapUploadError(err));
      if (!req.file) return next(badRequest('Choose an image to upload'));
      saveEventImage(req.file.buffer)
        .then((url) => ok(res, { url }, 201))
        .catch(next);
    });
  },
);

export default r;
