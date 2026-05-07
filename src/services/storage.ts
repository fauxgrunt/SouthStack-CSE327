export interface GenerationHistoryItem {
  id: string;
  timestamp: number;
  prompt: string;
  code: string;
  validationPassed: boolean;
  repairAttempted: boolean;
  screenshotDescription?: string;
}

const DB_NAME = "southstack-ui-builder";
const DB_VERSION = 1;
const STORE_NAME = "generation-history";
const MAX_ITEMS = 25;

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAllItems(): Promise<GenerationHistoryItem[]> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      const items = (request.result as GenerationHistoryItem[]).sort(
        (left, right) => right.timestamp - left.timestamp,
      );
      resolve(items);
    };

    request.onerror = () => reject(request.error);
  });
}

export async function listGenerationHistory(): Promise<
  GenerationHistoryItem[]
> {
  try {
    return (await getAllItems()).slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

export async function saveGenerationHistoryItem(
  item: Omit<GenerationHistoryItem, "id" | "timestamp">,
): Promise<GenerationHistoryItem> {
  const record: GenerationHistoryItem = {
    ...item,
    id: createId(),
    timestamp: Date.now(),
  };

  const db = await openDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });

  const allItems = await getAllItems();
  if (allItems.length > MAX_ITEMS) {
    const pruneDb = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = pruneDb.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      allItems.slice(MAX_ITEMS).forEach((entry) => store.delete(entry.id));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  return record;
}

export async function clearGenerationHistory(): Promise<void> {
  const db = await openDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
