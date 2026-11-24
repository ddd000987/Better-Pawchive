/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* IndexedDB wrapper for the watch page (uploaded covers and paginated post cache). */

const DB_NAME = 'pawchivePro-watch'
const DB_VERSION = 1

export type WatchStoreName = 'covers' | 'pages'

let dbPromise: Promise<IDBDatabase | null> | null = null

export function openWatchDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  if (typeof indexedDB === 'undefined') {
    console.warn('[PawchivePro] IndexedDB unavailable')
    dbPromise = Promise.resolve(null)
    return dbPromise
  }

  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('covers')) {
          db.createObjectStore('covers')
        }
        if (!db.objectStoreNames.contains('pages')) {
          db.createObjectStore('pages')
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => {
        console.warn('[PawchivePro] failed to open watch IndexedDB', req.error)
        resolve(null)
      }
      req.onblocked = () => {
        console.warn('[PawchivePro] watch IndexedDB open blocked')
        resolve(null)
      }
    } catch (e) {
      console.warn('[PawchivePro] failed to open watch IndexedDB', e)
      resolve(null)
    }
  })

  return dbPromise
}

export async function idbGet<T>(
  storeName: WatchStoreName,
  key: string
): Promise<T | undefined> {
  const db = await openWatchDb()
  if (!db) return undefined
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly')
      const req = tx.objectStore(storeName).get(key)
      req.onsuccess = () => resolve(req.result as T | undefined)
      req.onerror = () => {
        console.warn(`[PawchivePro] idbGet(${storeName}) failed`, req.error)
        resolve(undefined)
      }
    } catch (e) {
      console.warn(`[PawchivePro] idbGet(${storeName}) failed`, e)
      resolve(undefined)
    }
  })
}

export async function idbPut(
  storeName: WatchStoreName,
  key: string,
  value: unknown
): Promise<void> {
  const db = await openWatchDb()
  if (!db) return
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite')
      tx.objectStore(storeName).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => {
        console.warn(`[PawchivePro] idbPut(${storeName}) failed`, tx.error)
        resolve()
      }
      tx.onabort = () => {
        console.warn(`[PawchivePro] idbPut(${storeName}) aborted`, tx.error)
        resolve()
      }
    } catch (e) {
      console.warn(`[PawchivePro] idbPut(${storeName}) failed`, e)
      resolve()
    }
  })
}

export async function idbDelete(
  storeName: WatchStoreName,
  key: string
): Promise<void> {
  const db = await openWatchDb()
  if (!db) return
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite')
      tx.objectStore(storeName).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => {
        console.warn(`[PawchivePro] idbDelete(${storeName}) failed`, tx.error)
        resolve()
      }
      tx.onabort = () => {
        console.warn(`[PawchivePro] idbDelete(${storeName}) aborted`, tx.error)
        resolve()
      }
    } catch (e) {
      console.warn(`[PawchivePro] idbDelete(${storeName}) failed`, e)
      resolve()
    }
  })
}
