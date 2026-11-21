import { ObjectId } from 'mongodb';
import { verifiedActorSchema } from '../validators/index.js';
import { AppError } from './AppError.js';

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

const ROLE_MESSAGES = Object.freeze({
  customer: 'Customer access required.',
  technician: 'Technician access required.',
  admin: 'Admin access is required.'
});

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();

const actorIdsMatch = (actorId, userId) => {
  if (actorId === undefined || actorId === null || userId === undefined || userId === null) {
    return false;
  }

  if (actorId instanceof ObjectId && userId instanceof ObjectId) {
    return actorId.equals(userId);
  }

  const actorValue = String(actorId);
  const userValue = String(userId);

  if (actorValue === userValue) {
    return true;
  }

  if (!OBJECT_ID_PATTERN.test(actorValue) || !OBJECT_ID_PATTERN.test(userValue)) {
    return false;
  }

  return actorValue.toLowerCase() === userValue.toLowerCase();
};

export const requireCanonicalActor = async ({
  req,
  users,
  role,
  getActor = (request) => request.actor
}) => {
  const parsedActor = verifiedActorSchema.safeParse(getActor(req));

  if (!parsedActor.success) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
  }

  const actor = parsedActor.data;
  const forbidden = () => new AppError(403, 'FORBIDDEN', ROLE_MESSAGES[role]);

  if (actor.role !== role) {
    throw forbidden();
  }

  if (typeof users?.findCanonicalActorByEmail !== 'function') {
    throw forbidden();
  }

  const user = await users.findCanonicalActorByEmail(actor.email);

  if (
    !user ||
    user.role !== role ||
    normalizeEmail(user.email) !== actor.email ||
    !actorIdsMatch(actor.id, user._id)
  ) {
    throw forbidden();
  }

  return {
    id: user._id,
    email: normalizeEmail(user.email),
    role: user.role,
    name: user.name
  };
};

export const requireAnyCanonicalActor = async ({
  req,
  users,
  getActor = (request) => request.actor
}) => {
  const parsedActor = verifiedActorSchema.safeParse(getActor(req));

  if (!parsedActor.success) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
  }

  const actor = parsedActor.data;
  const forbidden = () =>
    new AppError(403, 'FORBIDDEN', 'Verified user access required.');

  if (typeof users?.findCanonicalActorByEmail !== 'function') {
    throw forbidden();
  }

  const user = await users.findCanonicalActorByEmail(actor.email);

  if (
    !user ||
    user.role !== actor.role ||
    normalizeEmail(user.email) !== actor.email ||
    !actorIdsMatch(actor.id, user._id)
  ) {
    throw forbidden();
  }

  return {
    id: user._id,
    email: normalizeEmail(user.email),
    role: user.role,
    name: user.name
  };
};
