import { createClient } from "redis";

import { log } from "../log.js";

export const DIAGRAM_PNG_TTL_SECONDS = 3600;
export const DIAGRAM_PNG_KEY_PREFIX = "diagram:v1:png:";

export function diagramPngKey(id: string): string {
  return `${DIAGRAM_PNG_KEY_PREFIX}${id}`;
}

export type StorageHealth = "redis" | "down";

export interface DiagramStorage {
  /** Stores a PNG for the given id. Throws StorageUnavailableError when Redis is not usable. */
  put(id: string, png: Buffer): Promise<void>;
  /** Returns the PNG or null when the key does not exist. Throws StorageUnavailableError. */
  get(id: string): Promise<Buffer | null>;
  health(): StorageHealth;
  close(): Promise<void>;
}

export class StorageUnavailableError extends Error {
  constructor(message = "diagram storage is unavailable") {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

type RedisClient = ReturnType<typeof createClient>;

export interface RedisStorageOptions {
  url: string;
  ttlSeconds?: number;
  /** How long startup waits for the first connection before serving with storage "down". */
  connectTimeoutMs?: number;
}

/**
 * Redis-backed PNG storage. There is intentionally no in-memory fallback: a render that
 * cannot be stored must fail with 503 instead of returning an id that soon 404s.
 */
export class RedisDiagramStorage implements DiagramStorage {
  private readonly client: RedisClient;
  private readonly ttlSeconds: number;

  constructor(options: RedisStorageOptions) {
    this.ttlSeconds = options.ttlSeconds ?? DIAGRAM_PNG_TTL_SECONDS;
    this.client = createClient({
      url: options.url,
      disableOfflineQueue: true,
      socket: {
        reconnectStrategy: (retries) => Math.min(500 * 2 ** Math.min(retries, 6), 30_000),
      },
    });
    this.client.on("error", (error: Error) => {
      log.warn("redis_error", error.name);
    });
  }

  async connect(timeoutMs = 2000): Promise<boolean> {
    const connection = this.client
      .connect()
      .then(() => true)
      .catch((error: unknown) => {
        log.warn("redis_connect_failed", error instanceof Error ? error.name : "unknown");
        return false;
      });

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    });
    const connected = await Promise.race([connection, timedOut]);
    if (timer) clearTimeout(timer);
    return connected && this.client.isReady;
  }

  health(): StorageHealth {
    return this.client.isReady ? "redis" : "down";
  }

  async put(id: string, png: Buffer): Promise<void> {
    if (!this.client.isReady) throw new StorageUnavailableError();
    try {
      await this.client.set(diagramPngKey(id), png.toString("base64"), { EX: this.ttlSeconds });
    } catch (error) {
      log.error("redis_set_failed", error instanceof Error ? error.name : "unknown");
      throw new StorageUnavailableError();
    }
  }

  async get(id: string): Promise<Buffer | null> {
    if (!this.client.isReady) throw new StorageUnavailableError();
    try {
      const value = await this.client.get(diagramPngKey(id));
      return value === null ? null : Buffer.from(value, "base64");
    } catch (error) {
      log.error("redis_get_failed", error instanceof Error ? error.name : "unknown");
      throw new StorageUnavailableError();
    }
  }

  async close(): Promise<void> {
    if (!this.client.isOpen) return;
    try {
      await this.client.quit();
    } catch {
      this.client.destroy();
    }
  }
}
