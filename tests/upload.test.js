process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/fixmate_test';
process.env.NODE_ENV ||= 'test';

import assert from 'node:assert/strict';
import express from 'express';
import { ObjectId } from 'mongodb';
import { after, test } from 'node:test';

const { UserRepository } = await import('../src/repositories/index.js');
const { createUploadController } = await import('../src/controllers/upload.controller.js');
const uploadRoutesModule = await import('../src/routes/upload.routes.js');
const { createUploadRoutes } = uploadRoutesModule;
const { createImageMultipartParser } = await import('../src/middleware/multipart.js');
const { createImgbbClient } = await import('../src/services/imgbb.service.js');
const { notFound } = await import('../src/middleware/notFound.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { UPLOAD_MAX_FILE_BYTES } = await import('../src/validators/upload.validator.js');

const servers = [];
const PNG_BUFFER = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(12, 1)
]);
const JPEG_BUFFER = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(12, 2)]);

const canonicalUser = {
  _id: new ObjectId(),
  name: 'Canonical Uploader',
  email: 'uploader@example.com',
  role: 'customer'
};

const validActor = {
  id: canonicalUser._id.toHexString(),
  email: canonicalUser.email,
  role: 'customer',
  name: 'Untrusted Display Name'
};

const project = (document, projection) => {
  if (!projection) {
    return { ...document };
  }

  return Object.entries(projection).reduce((result, [key, value]) => {
    if (value === 1 && key in document) {
      result[key] = document[key];
    }
    return result;
  }, {});
};

const makeUserCollection = (users) => ({
  async findOne(filter, options) {
    const user = users.find((item) => item.email === filter.email);
    return user ? project(user, options?.projection) : null;
  }
});

const makeProvider = ({
  result = {
    url: 'https://i.ibb.co/example/avatar.png',
    width: 640,
    height: 480,
    size: PNG_BUFFER.length,
    internalId: 'provider-internal-id',
    secret: 'do-not-expose'
  }
} = {}) => {
  const calls = [];

  return {
    calls,
    async uploadImage(file) {
      calls.push(file);
      return result;
    }
  };
};

const makeParser = (overrides = {}) =>
  createImageMultipartParser({
    maxBodyBytes: UPLOAD_MAX_FILE_BYTES + 64 * 1024,
    ...overrides
  });

const startServer = async ({
  provider = makeProvider(),
  actor = validActor,
  attachActor = true,
  multipartParser = makeParser()
} = {}) => {
  const users = new UserRepository({
    collectionFactory: () => makeUserCollection([canonicalUser])
  });
  const controller = createUploadController({ images: provider, users });
  const requireActor = (req, res, next) => {
    if (attachActor) {
      req.actor = actor;
    }
    return next();
  };
  const app = express();

  app.use('/api/uploads', createUploadRoutes({ controller, requireActor, multipartParser }));
  app.use(notFound);
  app.use(errorHandler);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/api/uploads/imgbb`,
    provider
  };
};

const postForm = (url, form, headers = {}) =>
  fetch(url, { method: 'POST', body: form, headers }).then(async (response) => ({
    status: response.status,
    body: await response.json()
  }));

const makeForm = ({
  fieldName = 'image',
  filename = 'avatar.png',
  mimeType = 'image/png',
  buffer = PNG_BUFFER
} = {}) => {
  const form = new FormData();
  form.append(fieldName, new Blob([buffer], { type: mimeType }), filename);
  return form;
};

const makeFetchResponse = ({ ok = true, status = 200, payload = {} } = {}) => ({
  ok,
  status,
  async json() {
    return payload;
  }
});

after(async () => {
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('upload route factory and controller require injected dependencies', () => {
  assert.throws(() => createUploadRoutes({ controller: {} }), /requireActor middleware/);
  assert.throws(
    () =>
      createUploadRoutes({
        controller: { uploadImage: async () => {} },
        requireActor: () => {},
        multipartParser: null
      }),
    /multipartParser middleware/
  );
  assert.throws(
    () => createUploadRoutes({ requireActor: () => {}, multipartParser: () => {} }),
    /uploadImage controller/
  );
  assert.throws(
    () => createUploadController({ images: {} }),
    /image provider/
  );
  assert.equal('default' in uploadRoutesModule, false);
});

test('verified actor can upload a validated image and receives only hosted metadata', async () => {
  const provider = makeProvider();
  const { baseUrl } = await startServer({ provider });
  const response = await postForm(baseUrl, makeForm());

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.message, 'Image uploaded successfully.');
  assert.deepEqual(Object.keys(response.body.image).sort(), [
    'height',
    'size',
    'url',
    'width'
  ]);
  assert.equal(response.body.image.url, 'https://i.ibb.co/example/avatar.png');
  assert.equal(response.body.image.width, 640);
  assert.equal(response.body.image.height, 480);
  assert.equal(response.body.image.size, PNG_BUFFER.length);
  assert.equal(response.body.image.secret, undefined);
  assert.equal(response.body.image.internalId, undefined);

  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].fieldName, 'image');
  assert.equal(provider.calls[0].filename, 'avatar.png');
  assert.equal(provider.calls[0].mimeType, 'image/png');
  assert.equal(provider.calls[0].size, PNG_BUFFER.length);
  assert.ok(provider.calls[0].buffer.equals(PNG_BUFFER));
});

test('path separators are stripped from uploaded filenames before provider calls', async () => {
  const provider = makeProvider();
  const { baseUrl } = await startServer({ provider });
  const response = await postForm(
    baseUrl,
    makeForm({ filename: '../../avatar.png' })
  );

  assert.equal(response.status, 200);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].filename, 'avatar.png');
});

test('missing or malformed actors fail closed before provider calls', async () => {
  const missingProvider = makeProvider();
  const missing = await startServer({
    provider: missingProvider,
    attachActor: false
  });
  const missingResponse = await postForm(missing.baseUrl, makeForm(), {
    'x-user-id': canonicalUser._id.toHexString(),
    'x-user-email': canonicalUser.email,
    'x-user-role': 'customer'
  });

  assert.equal(missingResponse.status, 401);
  assert.equal(missingResponse.body.error.code, 'UNAUTHORIZED');
  assert.equal(missingProvider.calls.length, 0);

  const malformedProvider = makeProvider();
  const malformed = await startServer({
    provider: malformedProvider,
    actor: { ...validActor, email: 'not-an-email' }
  });
  const malformedResponse = await postForm(malformed.baseUrl, makeForm());

  assert.equal(malformedResponse.status, 401);
  assert.equal(malformedResponse.body.error.code, 'UNAUTHORIZED');
  assert.equal(malformedProvider.calls.length, 0);
});

test('unverified canonical identity mismatch fails closed before provider calls', async () => {
  const provider = makeProvider();
  const { baseUrl } = await startServer({
    provider,
    actor: { ...validActor, id: new ObjectId().toHexString() }
  });
  const response = await postForm(baseUrl, makeForm());

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'FORBIDDEN');
  assert.equal(provider.calls.length, 0);
});

test('invalid uploads are rejected before provider calls', async () => {
  const provider = makeProvider();
  const { baseUrl } = await startServer({ provider });
  const noFile = new FormData();
  noFile.append('note', 'not an image');

  const extraField = makeForm();
  extraField.append('note', 'unexpected field');

  const malformed = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data' },
    body: 'not-multipart'
  });
  const malformedBody = await malformed.json();

  const cases = [
    [noFile, 400, 'INVALID_UPLOAD_INPUT'],
    [makeForm({ fieldName: 'photo' }), 400, 'INVALID_UPLOAD_INPUT'],
    [makeForm({ filename: 'avatar.txt', mimeType: 'text/plain' }), 400, 'INVALID_UPLOAD_INPUT'],
    [makeForm({ filename: 'avatar.jpg' }), 400, 'INVALID_UPLOAD_INPUT'],
    [makeForm({ buffer: JPEG_BUFFER }), 400, 'INVALID_UPLOAD_INPUT'],
    [
      makeForm({ buffer: Buffer.concat([PNG_BUFFER, Buffer.alloc(UPLOAD_MAX_FILE_BYTES)]) }),
      400,
      'INVALID_UPLOAD_INPUT'
    ],
    [extraField, 400, 'INVALID_UPLOAD_INPUT']
  ];

  assert.equal(malformed.status, 400);
  assert.equal(malformedBody.error.code, 'INVALID_UPLOAD_INPUT');

  for (const [form, status, code] of cases) {
    const response = await postForm(baseUrl, form);
    assert.equal(response.status, status);
    assert.equal(response.body.error.code, code);
  }

  assert.equal(provider.calls.length, 0);
});

test('missing ImgBB configuration returns a sanitized server error', async () => {
  const provider = createImgbbClient({
    apiKey: '',
    fetchImpl: async () => {
      throw new Error('fetch should not be called');
    }
  });
  const { baseUrl } = await startServer({ provider });
  const response = await postForm(baseUrl, makeForm());
  const payload = JSON.stringify(response.body);

  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'INTERNAL_SERVER_ERROR');
  assert.equal(response.body.message, 'Something went wrong.');
  assert.doesNotMatch(payload, /IMAGE_PROVIDER_NOT_CONFIGURED|api[_-]?key|imgbb/i);
});

test('ImgBB client sends the key only in the outbound multipart form', async () => {
  const calls = [];
  const client = createImgbbClient({
    apiKey: 'imgbb_secret_123',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return makeFetchResponse({
        payload: {
          success: true,
          data: {
            url: 'https://i.ibb.co/example/avatar.png',
            width: '640',
            height: 480,
            size: PNG_BUFFER.length,
            expiration: '24h',
            image: { url: 'https://i.ibb.co/example/raw.png' }
          }
        }
      });
    }
  });

  const result = await client.uploadImage({
    buffer: PNG_BUFFER,
    mimeType: 'image/png',
    filename: 'avatar.png'
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.imgbb.com/1/upload');
  assert.equal(calls[0].init.method, 'POST');
  assert.ok(calls[0].init.body instanceof FormData);
  assert.ok(calls[0].init.signal instanceof AbortSignal);

  const entries = [...calls[0].init.body.entries()];
  assert.deepEqual(entries.map(([name]) => name), ['key', 'image']);
  assert.equal(entries[0][1], 'imgbb_secret_123');
  assert.equal(entries[1][1].name ?? entries[1][2], 'avatar.png');

  assert.deepEqual(result, {
    url: 'https://i.ibb.co/example/avatar.png',
    width: 640,
    height: 480,
    size: PNG_BUFFER.length
  });
});

test('ImgBB provider failures stay sanitized and fail closed', async () => {
  const file = {
    buffer: PNG_BUFFER,
    mimeType: 'image/png',
    filename: 'avatar.png'
  };

  const network = createImgbbClient({
    apiKey: 'imgbb_secret_123',
    fetchImpl: async () => {
      throw new Error('secret network detail');
    }
  });
  await assert.rejects(
    () => network.uploadImage(file),
    (error) =>
      error.statusCode === 502 &&
      error.code === 'IMAGE_PROVIDER_UNAVAILABLE' &&
      !/secret network detail/.test(error.message)
  );

  const rateLimited = createImgbbClient({
    apiKey: 'imgbb_secret_123',
    fetchImpl: async () => makeFetchResponse({ ok: false, status: 429 })
  });
  await assert.rejects(
    () => rateLimited.uploadImage(file),
    (error) => error.statusCode === 503 && error.code === 'IMAGE_PROVIDER_UNAVAILABLE'
  );

  const invalid = createImgbbClient({
    apiKey: 'imgbb_secret_123',
    fetchImpl: async () =>
      makeFetchResponse({ payload: { success: true, data: { url: 'not-a-url' } } })
  });
  await assert.rejects(
    () => invalid.uploadImage(file),
    (error) => error.statusCode === 502 && error.code === 'IMAGE_PROVIDER_INVALID_RESPONSE'
  );
});
