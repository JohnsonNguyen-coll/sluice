// Node/Bun-only store. Import @sluice/sdk/file-store, never from a browser bundle.
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  open,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentStore, Channel, CallRecord } from "./store";
type State = {
  channels: Record<string, Channel>;
  calls: Record<string, CallRecord>;
};
export class FileAgentStore implements AgentStore {
  private path: string;
  constructor(path: string) {
    this.path = resolve(path);
  }
  private async state(): Promise<State> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as State;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { channels: {}, calls: {} };
      throw Error(
        "Agent state could not be read; do not reset signed payment history",
      );
    }
  }
  private async mutate<T>(action: (state: State) => T): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    let lock;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        lock = await open(this.path + ".lock", "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    if (!lock)
      throw Error(
        "Agent store is locked; another process may be using this signer",
      );
    try {
      const state = await this.state(),
        result = action(state),
        temporary = this.path + ".tmp";
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, this.path);
      return result;
    } finally {
      await lock.close();
      await unlink(this.path + ".lock");
    }
  }
  async channel(key: string) {
    return (await this.state()).channels[key] || null;
  }
  reserve(key: string, previous: Channel | null, next: Channel) {
    return this.mutate((state) => {
      if (
        JSON.stringify(state.channels[key] || null) !== JSON.stringify(previous)
      )
        return false;
      state.channels[key] = next;
      return true;
    });
  }
  save(record: CallRecord) {
    return this.mutate((state) => {
      state.calls[record.id] = record;
    });
  }
  async get(id: string) {
    return (await this.state()).calls[id] || null;
  }
  async list() {
    return Object.values((await this.state()).calls);
  }
}
