import { describe, expect, it } from 'vitest';
import { Deferred, UploadWaiter } from '../frontend/src/sftp-transfer';

describe('Deferred 异步原语', () => {
  it('正常 resolve 并返回预期值', async () => {
    const deferred = new Deferred<string>();
    deferred.resolve('success');
    expect(await deferred.promise).toBe('success');
  });

  it('调用 reject 抛出异常', async () => {
    const deferred = new Deferred<number>();
    deferred.reject(new Error('failed'));
    await expect(deferred.promise).rejects.toThrow('failed');
  });
});

describe('UploadWaiter 上传状态同步器', () => {
  it('等待上传就绪并在 resolveReady 时完成', async () => {
    const waiter = new UploadWaiter();
    const readyPromise = waiter.waitReady();
    waiter.resolveReady();
    const result = await readyPromise;
    expect(result).toEqual({ status: 'ready' });
  });

  it('同名冲突时返回 conflict 状态与原始文件大小', async () => {
    const waiter = new UploadWaiter();
    const readyPromise = waiter.waitReady();
    waiter.resolveConflict({ path: '/remote/app.js', existingSize: 1024 });
    const result = await readyPromise;
    expect(result).toEqual({
      status: 'conflict',
      conflict: { path: '/remote/app.js', existingSize: 1024 },
    });
  });

  it('支持排队与消费上传进度', async () => {
    const waiter = new UploadWaiter();
    // 进度先产生、后等待
    waiter.resolveProgress(100);
    waiter.resolveProgress(200);

    const first = await waiter.waitProgress();
    const second = await waiter.waitProgress();
    expect(first).toBe(100);
    expect(second).toBe(200);

    // 先等待、后产生
    const nextPromise = waiter.waitProgress();
    waiter.resolveProgress(300);
    expect(await nextPromise).toBe(300);
  });

  it('等待完成并重置内部状态', async () => {
    const waiter = new UploadWaiter();
    const completePromise = waiter.waitComplete();
    waiter.resolveComplete();
    await expect(completePromise).resolves.toBeUndefined();
  });

  it('调用 reject 拒绝所有处于等待中的承诺', async () => {
    const waiter = new UploadWaiter();
    const readyPromise = waiter.waitReady();
    waiter.reject('network aborted');
    await expect(readyPromise).rejects.toThrow('network aborted');
  });
});
