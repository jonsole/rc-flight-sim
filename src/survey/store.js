// Survey storage in IndexedDB, so a reload or a closed tab loses nothing.
// Two stores: features (points and lines) and photos (JPEG blobs).
// If IndexedDB is unavailable (private window, blocked storage) it falls back
// to memory and says so through `persistent`.

const DB = 'rc-survey';

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function openStore() {
  let db = null;
  try {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('features', { keyPath: 'id' });
      open.result.createObjectStore('photos', { keyPath: 'id' });
    };
    db = await req(open);
  } catch (e) {
    console.warn('Survey: IndexedDB unavailable, keeping data in memory only', e);
  }
  const mem = { features: new Map(), photos: new Map() };

  const tx = (store, mode, fn) => {
    const t = db.transaction(store, mode);
    return req(fn(t.objectStore(store)));
  };
  return {
    persistent: !!db,
    all: (store) => (db ? tx(store, 'readonly', (s) => s.getAll()) : Promise.resolve([...mem[store].values()])),
    get: (store, id) => (db ? tx(store, 'readonly', (s) => s.get(id)) : Promise.resolve(mem[store].get(id))),
    put: (store, value) => (db ? tx(store, 'readwrite', (s) => s.put(value)) : Promise.resolve(mem[store].set(value.id, value))),
    remove: (store, id) => (db ? tx(store, 'readwrite', (s) => s.delete(id)) : Promise.resolve(mem[store].delete(id))),
    clear: (store) => (db ? tx(store, 'readwrite', (s) => s.clear()) : Promise.resolve(mem[store].clear())),
  };
}
