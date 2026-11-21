export const pickAllowedFields = (document, fields) => {
  if (!document || typeof document !== 'object') {
    return document;
  }

  return fields.reduce((result, field) => {
    if (document[field] !== undefined) {
      result[field] = document[field];
    }
    return result;
  }, {});
};

export const toIncludeProjection = (fields, options = {}) =>
  fields.reduce(
    (projection, field) => {
      projection[field] = 1;
      return projection;
    },
    options.includeId === false ? {} : { _id: 1 }
  );

export const toExcludeProjection = (fields) =>
  fields.reduce((projection, field) => {
    projection[field] = 0;
    return projection;
  }, {});
