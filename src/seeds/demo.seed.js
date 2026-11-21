import { ObjectId } from 'mongodb';
import { CASE_INSENSITIVE_EMAIL_COLLATION } from '../db/collations.js';
import { redactSecrets } from '../utils/redact.js';
import {
  ACTIVE_BOOKING_STATUSES,
  bookingSchema,
  paymentSchema,
  SERVICE_CATEGORIES,
  serviceSchema,
  userSchema
} from '../validators/index.js';

export const SEED_VERSION = 'demo-2026-11';
export const SEED_CONFIRMATION_TOKEN = 'SEED_DEMO_DATA';

const DAY_MS = 86_400_000;

const USER_IDS = Object.freeze({
  admin: seedId('1', 1),
  technicianMaya: seedId('1', 2),
  technicianNoah: seedId('1', 3),
  customerOlivia: seedId('1', 4),
  customerLiam: seedId('1', 5),
  customerEmma: seedId('1', 6)
});
const SERVICE_IDS = Object.freeze(Array.from({ length: 14 }, (_, index) => seedId('2', index + 1)));
const BOOKING_IDS = Object.freeze(Array.from({ length: 6 }, (_, index) => seedId('3', index + 1)));

const MAYA = Object.freeze({ name: 'Maya Morgan', email: 'technician.maya@fixmate.demo' });
const NOAH = Object.freeze({ name: 'Noah Patel', email: 'technician.noah@fixmate.demo' });

const OWNER_FIELDS = Object.freeze({
  users: Object.freeze([
    'name',
    'email',
    'image',
    'role',
    'phone',
    'area',
    'bio'
  ]),
  services: Object.freeze([
    'title',
    'category',
    'description',
    'image',
    'basePrice',
    'estimatedDuration',
    'serviceMode',
    'serviceArea',
    'technicianName',
    'technicianEmail',
    'approvalStatus',
    'isAvailable'
  ]),
  bookings: Object.freeze([
    'serviceId',
    'serviceTitle',
    'serviceImage',
    'category',
    'basePrice',
    'technicianName',
    'technicianEmail',
    'customerName',
    'customerEmail',
    'customerPhone',
    'address',
    'problemDescription',
    'status',
    'finalAmount',
    'paymentStatus'
  ])
});

function seedId(scope, index) {
  return new ObjectId(`${scope}${index.toString(16).padStart(2, '0')}`.padStart(24, '0'));
}

const resolveNow = (value) => {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error('Seed clock is invalid.');
  }

  return date;
};

const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);
const toDateOnly = (date) => date.toISOString().slice(0, 10);
const toIdString = (value) =>
  value && typeof value.toHexString === 'function' ? value.toHexString() : String(value ?? '');
const sameId = (left, right) => toIdString(left) === toIdString(right);

const comparableValue = (value) => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  if (value && typeof value.toHexString === 'function') {
    return value.toHexString();
  }
  if (typeof value === 'string') {
    return value.trim().toLowerCase();
  }
  return value;
};

const fieldDifferences = (existing, expected, fields) =>
  fields.filter(
    (field) =>
      comparableValue(existing?.[field]) !== comparableValue(expected?.[field])
  );

const assertUnique = (values, label) => {
  const seen = new Set();

  for (const value of values) {
    const key = toIdString(value);

    if (seen.has(key)) {
      throw new Error(`Duplicate seed ${label}: ${key}`);
    }

    seen.add(key);
  }

  return seen;
};

export const isAtlasUri = (uri) =>
  typeof uri === 'string' &&
  (uri.startsWith('mongodb+srv://') || /@[^/]*\.mongodb\.net/i.test(uri));

export const checkSeedGuards = ({
  apply = false,
  confirmation = '',
  allowDevelopment = false,
  nodeEnv = 'development',
  mongodbUri = ''
} = {}) => {
  if (nodeEnv === 'production') {
    return { ok: false, reason: 'PRODUCTION_BLOCKED' };
  }
  if (isAtlasUri(mongodbUri)) {
    return { ok: false, reason: 'ATLAS_BLOCKED' };
  }
  if (apply && confirmation !== SEED_CONFIRMATION_TOKEN) {
    return { ok: false, reason: 'PLAN_NOT_CONFIRMED' };
  }
  if (apply && !allowDevelopment) {
    return { ok: false, reason: 'DEVELOPMENT_NOT_CONFIRMED' };
  }
  return { ok: true };
};

export const parseSeedArgs = (argv = []) => {
  const result = { apply: false, confirmation: '', allowDevelopment: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--apply') {
      result.apply = true;
      continue;
    }

    if (argument === '--allow-development') {
      result.allowDevelopment = true;
      continue;
    }

    if (argument === '--confirm') {
      result.confirmation = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (argument.startsWith('--confirm=')) {
      result.confirmation = argument.slice('--confirm='.length);
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return result;
};

const buildUsers = (base) =>
  [
    {
      _id: USER_IDS.admin,
      name: 'Avery Admin',
      email: 'admin@fixmate.demo',
      image: 'https://cdn.fixmate.invalid/demo/users/avery-admin.png',
      role: 'admin',
      phone: '+1 555 0100',
      area: 'Central District',
      bio: 'Demo administrator for service approval and operations.',
      createdAt: addDays(base, -60),
      updatedAt: addDays(base, -60)
    },
    {
      _id: USER_IDS.technicianMaya,
      name: MAYA.name,
      email: MAYA.email,
      image: 'https://cdn.fixmate.invalid/demo/users/maya-morgan.png',
      role: 'technician',
      phone: '+1 555 0101',
      area: 'North District',
      bio: 'Certified repair technician for devices, cooling and home electrical work.',
      createdAt: addDays(base, -58),
      updatedAt: addDays(base, -58)
    },
    {
      _id: USER_IDS.technicianNoah,
      name: NOAH.name,
      email: NOAH.email,
      image: 'https://cdn.fixmate.invalid/demo/users/noah-patel.png',
      role: 'technician',
      phone: '+1 555 0102',
      area: 'South District',
      bio: 'Field technician specializing in appliances, entertainment systems and wiring.',
      createdAt: addDays(base, -57),
      updatedAt: addDays(base, -57)
    },
    {
      _id: USER_IDS.customerOlivia,
      name: 'Olivia Chen',
      email: 'customer.olivia@fixmate.demo',
      image: 'https://cdn.fixmate.invalid/demo/users/olivia-chen.png',
      role: 'customer',
      phone: '+1 555 0201',
      area: 'North District',
      bio: '',
      createdAt: addDays(base, -40),
      updatedAt: addDays(base, -40)
    },
    {
      _id: USER_IDS.customerLiam,
      name: 'Liam Rivera',
      email: 'customer.liam@fixmate.demo',
      image: 'https://cdn.fixmate.invalid/demo/users/liam-rivera.png',
      role: 'customer',
      phone: '+1 555 0202',
      area: 'South District',
      bio: '',
      createdAt: addDays(base, -35),
      updatedAt: addDays(base, -35)
    },
    {
      _id: USER_IDS.customerEmma,
      name: 'Emma Brooks',
      email: 'customer.emma@fixmate.demo',
      image: 'https://cdn.fixmate.invalid/demo/users/emma-brooks.png',
      role: 'customer',
      phone: '+1 555 0203',
      area: 'Central District',
      bio: '',
      createdAt: addDays(base, -30),
      updatedAt: addDays(base, -30)
    }
  ].map((user) => userSchema.parse(user));

const buildServices = (base) =>
  [
    {
      _id: SERVICE_IDS[0],
      title: 'iPhone 15 Pro Screen Repair',
      category: 'Smartphone',
      description: 'Replace cracked or unresponsive screens with calibrated display testing.',
      image: 'https://cdn.fixmate.invalid/demo/services/smartphone-screen.png',
      basePrice: 129,
      estimatedDuration: '90 minutes',
      serviceMode: 'Home Visit',
      serviceArea: 'North District',
      technicianName: MAYA.name,
      technicianEmail: MAYA.email
    },
    {
      _id: SERVICE_IDS[1],
      title: 'Samsung Galaxy Battery Replacement',
      category: 'Smartphone',
      description: 'Diagnose battery health and fit a compatible replacement with safety checks.',
      image: 'https://cdn.fixmate.invalid/demo/services/smartphone-battery.png',
      basePrice: 89,
      estimatedDuration: '60 minutes',
      serviceMode: 'Shop Drop-off',
      serviceArea: 'South District',
      technicianName: NOAH.name,
      technicianEmail: NOAH.email
    },
    {
      _id: SERVICE_IDS[2],
      title: 'Laptop Overheating Diagnostics',
      category: 'Laptop & PC',
      description: 'Inspect cooling systems, clean dust buildup and verify safe operating temperatures.',
      image: 'https://cdn.fixmate.invalid/demo/services/laptop-cooling.png',
      basePrice: 75,
      estimatedDuration: '75 minutes',
      serviceMode: 'Shop Drop-off',
      serviceArea: 'North District',
      technicianName: MAYA.name,
      technicianEmail: MAYA.email
    },
    {
      _id: SERVICE_IDS[3],
      title: 'Desktop RAM Upgrade',
      category: 'Laptop & PC',
      description: 'Install compatible memory modules and verify stability with a boot test.',
      image: 'https://cdn.fixmate.invalid/demo/services/desktop-memory.png',
      basePrice: 95,
      estimatedDuration: '60 minutes',
      serviceMode: 'Home Visit',
      serviceArea: 'South District',
      technicianName: NOAH.name,
      technicianEmail: NOAH.email
    },
    {
      _id: SERVICE_IDS[4],
      title: 'Split AC Deep Cleaning',
      category: 'AC',
      description: 'Clean filters, coils and drainage paths to restore airflow and reduce odors.',
      image: 'https://cdn.fixmate.invalid/demo/services/ac-cleaning.png',
      basePrice: 110,
      estimatedDuration: '120 minutes',
      serviceMode: 'Home Visit',
      serviceArea: 'North District',
      technicianName: MAYA.name,
      technicianEmail: MAYA.email
    },
    {
      _id: SERVICE_IDS[5],
      title: 'AC Gas Refill And Leak Check',
      category: 'AC',
      description: 'Test refrigerant pressure, locate leaks and refill only after safety checks.',
      image: 'https://cdn.fixmate.invalid/demo/services/ac-refrigerant.png',
      basePrice: 140,
      estimatedDuration: '150 minutes',
      serviceMode: 'Home Visit',
      serviceArea: 'South District',
      technicianName: NOAH.name,
      technicianEmail: NOAH.email
    },
    {
      _id: SERVICE_IDS[6],
      title: 'Refrigerator Compressor Inspection',
      category: 'Refrigerator',
      description: 'Measure compressor behavior and identify cooling faults before replacement.',
      image: 'https://cdn.fixmate.invalid/demo/services/refrigerator-compressor.png',
      basePrice: 120,
      estimatedDuration: '90 minutes',
      serviceMode: 'Home Visit',
      serviceArea: 'North District',
      technicianName: MAYA.name,
      technicianEmail: MAYA.email
    },
    {
      _id: SERVICE_IDS[7],
      title: 'Fridge Thermostat Replacement',
      category: 'Refrigerator',
      description: 'Replace a faulty thermostat and confirm stable temperature cycles.',
      image: 'https://cdn.fixmate.invalid/demo/services/refrigerator-thermostat.png',
      basePrice: 85,
      estimatedDuration: '75 minutes',
      serviceMode: 'Shop Drop-off',
      serviceArea: 'South District',
      technicianName: NOAH.name,
      technicianEmail: NOAH.email
    },
    {
      _id: SERVICE_IDS[8],
      title: 'LED TV Panel Diagnosis',
      category: 'TV',
      description: 'Test power, backlight and signal boards to isolate display panel failures.',
      image: 'https://cdn.fixmate.invalid/demo/services/tv-panel.png',
      basePrice: 100,
      estimatedDuration: '90 minutes',
      serviceMode: 'Shop Drop-off',
      serviceArea: 'North District',
      technicianName: MAYA.name,
      technicianEmail: MAYA.email
    },
    {
      _id: SERVICE_IDS[9],
      title: 'Smart TV Software Reset',
      category: 'TV',
      description: 'Refresh smart TV firmware settings and restore safe network configuration.',
      image: 'https://cdn.fixmate.invalid/demo/services/tv-software.png',
      basePrice: 60,
      estimatedDuration: '45 minutes',
      serviceMode: 'Home Visit',
      serviceArea: 'South District',
      technicianName: NOAH.name,
      technicianEmail: NOAH.email
    },
    {
      _id: SERVICE_IDS[10],
      title: 'Washing Machine Drum Cleaning',
      category: 'Washing Machine',
      description: 'Remove residue from drum and seals, then run a sanitized test cycle.',
      image: 'https://cdn.fixmate.invalid/demo/services/washer-drum.png',
      basePrice: 80,
      estimatedDuration: '90 minutes',
      serviceMode: 'Home Visit',
      serviceArea: 'North District',
      technicianName: MAYA.name,
      technicianEmail: MAYA.email
    },
    {
      _id: SERVICE_IDS[11],
      title: 'Front Load Washer Pump Replacement',
      category: 'Washing Machine',
      description: 'Replace a failing drain pump and verify leak-free operation.',
      image: 'https://cdn.fixmate.invalid/demo/services/washer-pump.png',
      basePrice: 135,
      estimatedDuration: '120 minutes',
      serviceMode: 'Home Visit',
      serviceArea: 'South District',
      technicianName: NOAH.name,
      technicianEmail: NOAH.email
    },
    {
      _id: SERVICE_IDS[12],
      title: 'Ceiling Wiring Safety Check',
      category: 'Electrical',
      description: 'Inspect ceiling wiring, joints and insulation for safe household operation.',
      image: 'https://cdn.fixmate.invalid/demo/services/electrical-wiring.png',
      basePrice: 70,
      estimatedDuration: '60 minutes',
      serviceMode: 'Home Visit',
      serviceArea: 'North District',
      technicianName: MAYA.name,
      technicianEmail: MAYA.email
    },
    {
      _id: SERVICE_IDS[13],
      title: 'Circuit Breaker Replacement',
      category: 'Electrical',
      description: 'Replace a faulty breaker and verify load balance at the distribution panel.',
      image: 'https://cdn.fixmate.invalid/demo/services/electrical-breaker.png',
      basePrice: 115,
      estimatedDuration: '90 minutes',
      serviceMode: 'Home Visit',
      serviceArea: 'South District',
      technicianName: NOAH.name,
      technicianEmail: NOAH.email
    }
  ].map((service) =>
    serviceSchema.parse({
      ...service,
      approvalStatus: 'approved',
      isAvailable: true,
      createdAt: addDays(base, -45),
      updatedAt: addDays(base, -45)
    })
  );

const buildBookings = ({ base, users, services }) => {
  const userById = new Map(users.map((user) => [toIdString(user._id), user]));
  const specifications = [
    {
      customerId: USER_IDS.customerOlivia,
      serviceIndex: 0,
      status: 'requested',
      preferredOffset: 2,
      createdOffset: -9,
      address: '18 North Avenue, North District',
      problemDescription: 'The screen cracked after a drop and touch input is unreliable.'
    },
    {
      customerId: USER_IDS.customerLiam,
      serviceIndex: 1,
      status: 'accepted',
      preferredOffset: 3,
      createdOffset: -8,
      address: '42 South Street, South District',
      problemDescription: 'Battery drains quickly and the phone shuts down under light use.'
    },
    {
      customerId: USER_IDS.customerEmma,
      serviceIndex: 2,
      status: 'in-progress',
      preferredOffset: 4,
      createdOffset: -7,
      address: '7 Central Lane, Central District',
      problemDescription: 'The laptop becomes very hot and the fan runs constantly.'
    },
    {
      customerId: USER_IDS.customerOlivia,
      serviceIndex: 3,
      status: 'completed',
      preferredOffset: 1,
      createdOffset: -12,
      address: '18 North Avenue, North District',
      problemDescription: 'Desktop freezes during design work and needs additional memory.'
    },
    {
      customerId: USER_IDS.customerLiam,
      serviceIndex: 4,
      status: 'rejected',
      preferredOffset: 5,
      createdOffset: -6,
      address: '42 South Street, South District',
      problemDescription: 'The AC emits a musty odor and airflow has dropped noticeably.'
    },
    {
      customerId: USER_IDS.customerEmma,
      serviceIndex: 5,
      status: 'cancelled',
      preferredOffset: 6,
      createdOffset: -5,
      address: '7 Central Lane, Central District',
      problemDescription: 'Cooling stopped after a storm and the outdoor unit needs inspection.'
    }
  ];

  return specifications.map((specification, index) => {
    const service = services[specification.serviceIndex];
    const customer = userById.get(toIdString(specification.customerId));
    const createdAt = addDays(base, specification.createdOffset);

    return bookingSchema.parse({
      _id: BOOKING_IDS[index],
      serviceId: service._id,
      serviceTitle: service.title,
      serviceImage: service.image,
      category: service.category,
      basePrice: service.basePrice,
      technicianName: service.technicianName,
      technicianEmail: service.technicianEmail,
      customerName: customer.name,
      customerEmail: customer.email,
      customerPhone: customer.phone,
      address: specification.address,
      preferredDate: toDateOnly(addDays(base, specification.preferredOffset)),
      problemDescription: specification.problemDescription,
      status: specification.status,
      finalAmount: service.basePrice,
      paymentStatus: 'unpaid',
      createdAt,
      updatedAt: createdAt
    });
  });
};

export const validateSeedDataset = (dataset) => {
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) {
    throw new Error('Seed dataset must be an object.');
  }

  const users = (dataset.users ?? []).map((user) => userSchema.parse(user));
  const services = (dataset.services ?? []).map((service) => serviceSchema.parse(service));
  const bookings = (dataset.bookings ?? []).map((booking) => bookingSchema.parse(booking));
  const payments = (dataset.payments ?? []).map((payment) => paymentSchema.parse(payment));

  if (payments.length > 0) {
    throw new Error('Demo seed must not include payment records.');
  }

  if (users.filter((user) => user.role === 'technician').length < 2) {
    throw new Error('Demo seed requires at least two technicians.');
  }

  if (services.filter((service) => service.approvalStatus === 'approved').length < 12) {
    throw new Error('Demo seed requires at least twelve approved services.');
  }

  const categories = new Set(services.map((service) => service.category));

  if (!SERVICE_CATEGORIES.every((category) => categories.has(category))) {
    throw new Error('Demo seed must cover every service category.');
  }

  assertUnique(users.map((user) => user._id), 'user ids');
  assertUnique(
    users.map((user) => user.email),
    'user emails'
  );
  assertUnique(services.map((service) => service._id), 'service ids');
  assertUnique(bookings.map((booking) => booking._id), 'booking ids');

  const serviceIds = new Set(services.map((service) => toIdString(service._id)));
  const activePairs = new Set();

  for (const booking of bookings) {
    if (!users.some((user) => user.email === booking.customerEmail)) {
      throw new Error('Booking customer does not reference a seeded user.');
    }

    if (!serviceIds.has(toIdString(booking.serviceId))) {
      throw new Error('Booking service does not reference a seeded service.');
    }

    const service = services.find(
      (candidate) => toIdString(candidate._id) === toIdString(booking.serviceId)
    );

    if (!users.some((user) => user.email === service.technicianEmail)) {
      throw new Error('Booking technician does not reference a seeded user.');
    }

    if (ACTIVE_BOOKING_STATUSES.includes(booking.status)) {
      const key = `${booking.customerEmail}|${toIdString(booking.serviceId)}`;

      if (activePairs.has(key)) {
        throw new Error('Demo seed contains duplicate active booking pairs.');
      }

      activePairs.add(key);
    }
  }

  return {
    version: dataset.version ?? SEED_VERSION,
    users,
    services,
    bookings,
    payments
  };
};

export const buildSeedData = ({ now = new Date() } = {}) => {
  const base = resolveNow(now);
  const users = buildUsers(base);
  const services = buildServices(base);
  const bookings = buildBookings({ base, users, services });

  return validateSeedDataset({
    version: SEED_VERSION,
    users,
    services,
    bookings,
    payments: []
  });
};

export const SEED_IDS = Object.freeze({
  users: USER_IDS,
  services: SERVICE_IDS,
  bookings: BOOKING_IDS
});

const buildSpecifications = (dataset) => [
  ...dataset.users.map((document) => ({
    collectionKey: 'users',
    document,
    identityFields: OWNER_FIELDS.users,
    naturalFilter: { email: document.email },
    naturalOptions: undefined,
    naturalLabel: `email=${document.email}`
  })),
  ...dataset.services.map((document) => ({
    collectionKey: 'services',
    document,
    identityFields: OWNER_FIELDS.services,
    naturalFilter: { title: document.title, technicianEmail: document.technicianEmail },
    naturalOptions: undefined,
    naturalLabel: `title=${document.title}`
  })),
  ...dataset.bookings.map((document) => ({
    collectionKey: 'bookings',
    document,
    identityFields: OWNER_FIELDS.bookings,
    naturalFilter: ACTIVE_BOOKING_STATUSES.includes(document.status)
      ? {
          customerEmail: document.customerEmail,
          serviceId: document.serviceId,
          status: { $in: [...ACTIVE_BOOKING_STATUSES] }
        }
      : null,
    naturalOptions: { collation: CASE_INSENSITIVE_EMAIL_COLLATION },
    naturalLabel: `customer=${document.customerEmail} service=${toIdString(document.serviceId)}`
  }))
];

const summarizeDocument = (specification) => ({
  collection: specification.collectionKey,
  _id: toIdString(specification.document._id),
  naturalKey: specification.naturalLabel
});

export const analyzeSeedPlan = async (collections, dataset) => {
  const validated = validateSeedDataset(dataset);
  const plan = { inserts: [], skips: [], conflicts: [] };

  for (const collectionKey of ['users', 'services', 'bookings', 'payments']) {
    const collection = collections?.[collectionKey];

    if (!collection || typeof collection.findOne !== 'function') {
      throw new Error(`Seed collection ${collectionKey} is unavailable.`);
    }
  }

  for (const specification of buildSpecifications(validated)) {
    const collection = collections?.[specification.collectionKey];

    if (!collection || typeof collection.findOne !== 'function') {
      throw new Error(`Seed collection ${specification.collectionKey} is unavailable.`);
    }

    const existingById = await collection.findOne({ _id: specification.document._id });
    const existingByNatural = specification.naturalFilter
      ? await collection.findOne(specification.naturalFilter, specification.naturalOptions)
      : null;
    const summary = summarizeDocument(specification);

    if (existingById) {
      const differences = fieldDifferences(
        existingById,
        specification.document,
        specification.identityFields
      );

      if (differences.length > 0) {
        plan.conflicts.push({ ...summary, reason: 'SEED_ID_CONFLICT', differences });
        continue;
      }

      if (
        existingByNatural &&
        !sameId(existingByNatural._id, specification.document._id)
      ) {
        plan.conflicts.push({
          ...summary,
          reason: 'SEED_NATURAL_KEY_CONFLICT',
          differences: ['_id']
        });
        continue;
      }

      plan.skips.push({ ...summary, reason: 'ALREADY_PRESENT' });
      continue;
    }

    if (existingByNatural) {
      plan.conflicts.push({
        ...summary,
        reason: 'SEED_NATURAL_KEY_CONFLICT',
        differences: ['_id']
      });
      continue;
    }

    plan.inserts.push(summary);
  }

  return {
    version: validated.version,
    plan,
    counts: {
      users: validated.users.length,
      services: validated.services.length,
      bookings: validated.bookings.length,
      payments: validated.payments.length,
      inserts: plan.inserts.length,
      skips: plan.skips.length,
      conflicts: plan.conflicts.length
    }
  };
};

const printPlan = (analysis, mode, logger) => {
  logger.info(`Demo seed ${mode === 'apply' ? 'apply' : 'dry-run'} plan`);
  logger.info(
    `Users: insert=${analysis.plan.inserts.filter((item) => item.collection === 'users').length} keep=${analysis.plan.skips.filter((item) => item.collection === 'users').length} conflict=${analysis.plan.conflicts.filter((item) => item.collection === 'users').length}`
  );
  logger.info(
    `Services: insert=${analysis.plan.inserts.filter((item) => item.collection === 'services').length} keep=${analysis.plan.skips.filter((item) => item.collection === 'services').length} conflict=${analysis.plan.conflicts.filter((item) => item.collection === 'services').length}`
  );
  logger.info(
    `Bookings: insert=${analysis.plan.inserts.filter((item) => item.collection === 'bookings').length} keep=${analysis.plan.skips.filter((item) => item.collection === 'bookings').length} conflict=${analysis.plan.conflicts.filter((item) => item.collection === 'bookings').length}`
  );
  logger.info(`Payments: insert=0 keep=0 conflict=0`);

  for (const conflict of analysis.plan.conflicts) {
    logger.error(
      `CONFLICT collection=${conflict.collection} id=${conflict._id} reason=${conflict.reason} fields=${conflict.differences.join(',')}`
    );
  }
};

const failure = (reason, analysis, extra = {}) => ({
  success: false,
  reason,
  analysis,
  changes: [],
  skipped: analysis?.plan?.skips ?? [],
  errors: [],
  ...extra
});

export const seedDemoData = async (collections, options = {}) => {
  const {
    apply = false,
    confirmation = '',
    allowDevelopment = false,
    nodeEnv = 'development',
    mongodbUri = '',
    now = new Date(),
    logger = console,
    dataset = buildSeedData({ now })
  } = options;

  const guard = checkSeedGuards({ apply, confirmation, allowDevelopment, nodeEnv, mongodbUri });

  if (!guard.ok) {
    logger.error(`Seed aborted: ${guard.reason}`);
    return failure(guard.reason);
  }

  let validated;

  try {
    validated = validateSeedDataset(dataset);
  } catch (error) {
    const message = redactSecrets(error?.message || error);
    logger.error(`Seed validation failed: ${message}`);
    return failure('INVALID_SEED_DATA', undefined, { errors: [message] });
  }

  let analysis;

  try {
    analysis = await analyzeSeedPlan(collections, validated);
  } catch (error) {
    const message = redactSecrets(error?.message || error);
    logger.error(`Seed analysis failed: ${message}`);
    return failure('SEED_ANALYSIS_FAILED', undefined, { errors: [message] });
  }

  printPlan(analysis, apply ? 'apply' : 'dry-run', logger);

  if (analysis.plan.conflicts.length > 0) {
    logger.error('Seed aborted: existing data conflicts with the demo dataset.');
    return failure('SEED_CONFLICT', analysis);
  }

  if (!apply) {
    return {
      success: true,
      mode: 'dry-run',
      reason: 'DRY_RUN',
      analysis,
      changes: [],
      skipped: analysis.plan.skips
    };
  }

  if (analysis.plan.inserts.length === 0) {
    logger.info('Seed already present; no records were written.');
    return {
      success: true,
      mode: 'apply',
      reason: 'ALREADY_SEEDED',
      analysis,
      changes: [],
      skipped: analysis.plan.skips
    };
  }

  const changes = [];
  const errors = [];
  const documentsByCollection = {
    users: new Map(validated.users.map((document) => [toIdString(document._id), document])),
    services: new Map(validated.services.map((document) => [toIdString(document._id), document])),
    bookings: new Map(validated.bookings.map((document) => [toIdString(document._id), document]))
  };

  for (const item of analysis.plan.inserts) {
    const collection = collections[item.collection];
    const document = documentsByCollection[item.collection].get(item._id);

    try {
      const result = await collection.updateOne(
        { _id: document._id },
        { $setOnInsert: document },
        { upsert: true }
      );
      changes.push({ ...item, result });
      logger.info(`INSERTED collection=${item.collection} id=${item._id}`);
    } catch (error) {
      const message = redactSecrets(error?.message || error);
      errors.push({ ...item, error: message });
      logger.error(`FAILED collection=${item.collection} id=${item._id} message=${message}`);
    }
  }

  let after;

  try {
    after = await analyzeSeedPlan(collections, validated);
  } catch (error) {
    const message = redactSecrets(error?.message || error);
    errors.push({ collection: 'verification', error: message });
    logger.error(`Seed verification failed: ${message}`);
  }

  const success =
    errors.length === 0 &&
    after?.plan.inserts.length === 0 &&
    after?.plan.conflicts.length === 0;

  logger.info(
    success
      ? 'Seed complete: demo data is present and no existing records were overwritten.'
      : 'Seed failed: inserted records require verification before retry.'
  );

  return {
    success,
    mode: 'apply',
    reason: success ? 'SEED_COMPLETE' : 'SEED_VERIFICATION_FAILED',
    analysis,
    after,
    changes,
    skipped: analysis.plan.skips,
    errors
  };
};
