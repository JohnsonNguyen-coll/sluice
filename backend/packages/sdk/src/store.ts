import type { SignedReceipt, SignedVoucher } from "./protocol";
export type Channel = {
  nonce: string;
  cumulativeAmount: string;
  pending?: SignedVoucher;
};
export type CallRecord = {
  id: string;
  voucher: SignedVoucher;
  receipt?: SignedReceipt;
  flag?: string;
  createdAt: number;
};
export interface AgentStore {
  channel(key: string): Promise<Channel | null>;
  reserve(
    key: string,
    previous: Channel | null,
    next: Channel,
  ): Promise<boolean>;
  save(record: CallRecord): Promise<void>;
  get(id: string): Promise<CallRecord | null>;
  list(): Promise<CallRecord[]>;
}
export class MemoryAgentStore implements AgentStore {
  private channels = new Map<string, Channel>();
  private calls = new Map<string, CallRecord>();
  async channel(key: string) {
    return structuredClone(this.channels.get(key) || null);
  }
  async reserve(key: string, previous: Channel | null, next: Channel) {
    if (
      JSON.stringify(this.channels.get(key) || null) !==
      JSON.stringify(previous)
    )
      return false;
    this.channels.set(key, structuredClone(next));
    return true;
  }
  async save(record: CallRecord) {
    this.calls.set(record.id, structuredClone(record));
  }
  async get(id: string) {
    return structuredClone(this.calls.get(id) || null);
  }
  async list() {
    return structuredClone([...this.calls.values()]);
  }
}
export class IndexedDBAgentStore implements AgentStore {
  private database: Promise<IDBDatabase>;
  constructor(name = "sluice-agentpay") {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("channels");
        request.result.createObjectStore("calls", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  private async read<T>(table: string, key?: string): Promise<T> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(table, "readonly");
      const request =
        key === undefined
          ? tx.objectStore(table).getAll()
          : tx.objectStore(table).get(key);
      request.onsuccess = () => resolve((request.result ?? null) as T);
      request.onerror = () => reject(request.error);
    });
  }
  channel(key: string) {
    return this.read<Channel | null>("channels", key);
  }
  async reserve(
    key: string,
    previous: Channel | null,
    next: Channel,
  ): Promise<boolean> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("channels", "readwrite"),
        store = tx.objectStore("channels");
      let accepted = false;
      const request = store.get(key);
      request.onsuccess = () => {
        if (
          JSON.stringify(request.result ?? null) === JSON.stringify(previous)
        ) {
          store.put(next, key);
          accepted = true;
        }
      };
      tx.oncomplete = () => resolve(accepted);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async save(record: CallRecord) {
    const db = await this.database;
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction("calls", "readwrite");
      tx.objectStore("calls").put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  get(id: string) {
    return this.read<CallRecord | null>("calls", id);
  }
  list() {
    return this.read<CallRecord[]>("calls");
  }
}
