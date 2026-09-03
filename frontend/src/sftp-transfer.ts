/**
 * SFTP 传输队列与异步同步原语（UploadWaiter, Deferred）。
 */

export class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

export interface UploadConflict {
  path: string;
  existingSize: number;
}

export type UploadStartResult =
  | { status: 'ready' }
  | { status: 'conflict'; conflict: UploadConflict };

export class UploadWaiter {
  private ready: Deferred<UploadStartResult> | null = null;
  private progress: Deferred<number> | null = null;
  private complete: Deferred<void> | null = null;
  private progressQueue: number[] = [];
  private progressQueueHead = 0;

  waitReady(): Promise<UploadStartResult> {
    this.ready = new Deferred<UploadStartResult>();
    return this.ready.promise;
  }

  resolveReady(): void {
    this.ready?.resolve({ status: 'ready' });
    this.ready = null;
  }

  resolveConflict(conflict: UploadConflict): void {
    this.ready?.resolve({ status: 'conflict', conflict });
    this.ready = null;
  }

  waitProgress(): Promise<number> {
    const queued = this.progressQueue[this.progressQueueHead];
    if (queued !== undefined) {
      this.progressQueueHead++;
      this.compactProgressQueue();
      return Promise.resolve(queued);
    }

    this.progress = new Deferred<number>();
    return this.progress.promise;
  }

  resolveProgress(loaded: number): void {
    if (this.progress) {
      this.progress.resolve(loaded);
      this.progress = null;
      return;
    }

    this.progressQueue.push(loaded);
  }

  waitComplete(): Promise<void> {
    this.complete = new Deferred<void>();
    return this.complete.promise;
  }

  resolveComplete(): void {
    this.complete?.resolve();
    this.reset();
  }

  reject(message: string): void {
    const error = new Error(message);
    this.ready?.reject(error);
    this.progress?.reject(error);
    this.complete?.reject(error);
    this.reset();
  }

  reset(): void {
    this.ready = null;
    this.progress = null;
    this.complete = null;
    this.progressQueue = [];
    this.progressQueueHead = 0;
  }

  private compactProgressQueue(): void {
    if (this.progressQueueHead > 32 && this.progressQueueHead * 2 > this.progressQueue.length) {
      this.progressQueue = this.progressQueue.slice(this.progressQueueHead);
      this.progressQueueHead = 0;
    }
  }
}
