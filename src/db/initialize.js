import { COLLECTION_NAMES } from './collections.js';
import { INDEX_DEFINITIONS } from './indexes.js';

const isNamespaceExists = (error) =>
  error?.code === 48 || error?.codeName === 'NamespaceExists';

export const initializeCollectionsAndIndexes = async (db) => {
  const created = [];

  for (const name of Object.values(COLLECTION_NAMES)) {
    try {
      await db.createCollection(name);
      created.push(name);
    } catch (error) {
      if (!isNamespaceExists(error)) {
        throw error;
      }
    }
  }

  const indexes = {};

  for (const [collectionKey, definitions] of Object.entries(INDEX_DEFINITIONS)) {
    const collectionName = COLLECTION_NAMES[collectionKey];
    indexes[collectionName] = await db
      .collection(collectionName)
      .createIndexes(definitions);
  }

  return { created, indexes };
};
