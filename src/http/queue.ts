export interface QueueStats {
  /** Jobs accepted but not started yet. */
  size: number;
  /** Jobs currently running. */
  inflight: number;
}

export interface RenderQueueOptions {
  concurrency?: number;
  maxQueue?: number;
}

interface PendingJob {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class QueueFullError extends Error {
  constructor() {
    super("render queue is full");
    this.name = "QueueFullError";
  }
}

/**
 * Small bounded queue. Concurrency defaults to 1 because one Chromium renderer is shared by
 * the whole service; the queue is capped so a burst is rejected with 429 instead of piling up.
 */
export class RenderQueue {
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private readonly waiting: PendingJob[] = [];
  private running = 0;

  constructor(options: RenderQueueOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.maxQueue = Math.max(0, options.maxQueue ?? 4);
  }

  get stats(): QueueStats {
    return { size: this.waiting.length, inflight: this.running };
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running < this.concurrency) {
      this.running += 1;
      return this.start(task);
    }
    if (this.waiting.length >= this.maxQueue) return Promise.reject(new QueueFullError());

    return new Promise<T>((resolve, reject) => {
      this.waiting.push({
        task: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
  }

  private async start<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } finally {
      this.running -= 1;
      this.pump();
    }
  }

  private pump(): void {
    while (this.running < this.concurrency && this.waiting.length > 0) {
      const job = this.waiting.shift();
      if (!job) return;
      this.running += 1;
      this.start(job.task).then(job.resolve, job.reject);
    }
  }
}
