import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { fail } from "./errors";
export const managedTemplates = [
  {
    id: "text-analysis",
    name: "Text analysis",
    description:
      "Count words, characters, sentences and estimated reading time.",
    example: {
      text: "Hello from Sluice. This API performs real text analysis.",
    },
  },
  {
    id: "json-validation",
    name: "JSON validation",
    description:
      "Validate JSON text and report its type, size and top-level structure.",
    example: { text: '{"hello":"world","items":[1,2,3]}' },
  },
] as const;
export function encryptionKey(
  env: Record<string, string | undefined> = process.env,
) {
  const value = env.MANAGED_PROVIDER_ENCRYPTION_KEY;
  if (!value || !/^[a-f0-9]{64}$/i.test(value))
    fail(
      503,
      "MANAGED_NOT_CONFIGURED",
      "Hosted APIs need a server-side encryption key",
    );
  return Buffer.from(value, "hex");
}
export function encryptSigner(secret: Hex, context: string, key: Buffer) {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context));
  const bytes = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [
    "v1",
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    bytes.toString("base64url"),
  ].join(".");
}
export function decryptSigner(
  value: string,
  context: string,
  key: Buffer,
): Hex {
  try {
    const [version, iv, tag, bytes, ...extra] = value.split(".");
    if (version !== "v1" || extra.length) throw Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const secret = Buffer.concat([
      decipher.update(Buffer.from(bytes, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    if (!/^0x[a-f0-9]{64}$/i.test(secret)) throw Error();
    return secret as Hex;
  } catch {
    fail(
      503,
      "SIGNER_UNAVAILABLE",
      "The hosted provider signer could not be unlocked",
    );
  }
}
export function runManagedTool(kind: string, input: Record<string, unknown>) {
  if (typeof input.text !== "string" || Buffer.byteLength(input.text) > 24000)
    fail(
      400,
      "INVALID_TOOL_INPUT",
      "Supply text as a string of at most 24 KiB",
    );
  if (kind === "text-analysis") {
    const text = input.text,
      words = text.match(/\S+/gu) || [],
      sentences = text.trim()
        ? text.split(/[.!?。！？]+/u).filter((part) => part.trim()).length
        : 0;
    return {
      characters: Array.from(text).length,
      utf8Bytes: Buffer.byteLength(text),
      words: words.length,
      sentences,
      lines: text ? text.split(/\r\n|\r|\n/).length : 0,
      estimatedReadingSeconds: Math.ceil((words.length / 200) * 60),
      readingWordsPerMinute: 200,
    };
  }
  if (kind === "json-validation") {
    try {
      const value: unknown = JSON.parse(input.text),
        type =
          value === null
            ? "null"
            : Array.isArray(value)
              ? "array"
              : typeof value;
      return {
        valid: true,
        type,
        utf8Bytes: Buffer.byteLength(input.text),
        ...(Array.isArray(value)
          ? { items: value.length }
          : value && typeof value === "object"
            ? {
                keys: Object.keys(value),
                properties: Object.keys(value).length,
              }
            : {}),
      };
    } catch {
      return { valid: false, error: "Invalid JSON syntax" };
    }
  }
  fail(400, "INVALID_TEMPLATE", "Choose an available hosted API template");
}
