import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PendingSettlementStore } from "@x402/core/facilitator";

/** Keeps broadcast deposit hashes across process restarts on the x402 volume. */
export class FilePendingSettlementStore implements PendingSettlementStore {
  constructor(private readonly directory: string) {}

  private path(key: string) {
    const digest = createHash("sha256").update(key).digest("hex");
    return join(this.directory, `${digest}.json`);
  }

  async get(key: string) {
    try {
      const value = JSON.parse(await readFile(this.path(key), "utf8")) as unknown;
      if (typeof value !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(value))
        throw Error("Invalid persisted x402 transaction hash");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async set(key: string, txHash: string) {
    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash))
      throw Error("Invalid x402 transaction hash");
    await mkdir(this.directory, { recursive: true });
    const target = this.path(key);
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(txHash), { flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async delete(key: string) {
    await unlink(this.path(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
