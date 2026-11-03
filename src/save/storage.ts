export interface KeyValue { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

export function browserStorage(): KeyValue | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

export function tabStorage(): KeyValue | null {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { return null; }
}

export function read(store: KeyValue | null, key: string): string | null {
  try { return store?.getItem(key) ?? null; } catch { return null; }
}

export function write(store: KeyValue | null, key: string, value: string) {
  try { store?.setItem(key, value); return true; } catch { return false; }
}

export function remove(store: KeyValue | null, key: string) {
  try { store?.removeItem(key); } catch { /* storage blocked */ }
}

export function memoryStorage(): KeyValue & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: k => { data.delete(k); } };
}
