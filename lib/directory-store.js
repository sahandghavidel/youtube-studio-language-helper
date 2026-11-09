const DB_NAME = "youtube-language-helper";
const DB_VERSION = 1;
const STORE_NAME = "handles";
const DIRECTORY_KEY = "selected-directory";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact(mode, operation) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    return await operation(store);
  } finally {
    database.close();
  }
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function saveDirectoryHandle(handle, key = DIRECTORY_KEY) {
  return transact("readwrite", (store) => requestPromise(store.put(handle, key)));
}

export function getDirectoryHandle(key = DIRECTORY_KEY) {
  return transact("readonly", (store) => requestPromise(store.get(key)));
}

export function clearDirectoryHandle() {
  return transact("readwrite", (store) => requestPromise(store.delete(DIRECTORY_KEY)));
}

export async function getWatchSelection(key, folder) {
  const value = await transact("readonly", store => requestPromise(store.get(key)));
  if (value && await folder.isSameEntry(value.folder)) return value.selection;
  return null;
}

export function saveWatchSelection(key, folder, selection) {
  return transact("readwrite", store => requestPromise(store.put({ folder, selection }, key)));
}
