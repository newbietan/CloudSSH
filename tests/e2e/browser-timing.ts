import type { Page } from './fixtures';

/** Hold page rAF callbacks while leaving timers/actions usable; release one coalesced frame. */
export async function holdAnimationFrames(page: Page): Promise<() => Promise<void>> {
  const release = await page.evaluateHandle(() => {
    const requestFrame = window.requestAnimationFrame.bind(window);
    const cancelFrame = window.cancelAnimationFrame.bind(window);
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextId = -1;
    let released = false;
    window.requestAnimationFrame = (callback) => {
      const id = nextId--;
      callbacks.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      if (!callbacks.delete(id)) cancelFrame(id);
    };
    return () => {
      if (released) return;
      released = true;
      window.requestAnimationFrame = requestFrame;
      try {
        const timestamp = performance.now();
        for (const [id, callback] of [...callbacks]) {
          if (callbacks.delete(id)) callback(timestamp);
        }
      } finally {
        callbacks.clear();
        window.cancelAnimationFrame = cancelFrame;
      }
    };
  });
  return async () => {
    try {
      await release.evaluate((flush) => flush());
    } finally {
      await release.dispose();
    }
  };
}
