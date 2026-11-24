import type { WebSocketRoute } from '@playwright/test';
import { expect, type Page, test } from './fixtures';
import { mockAnonymousSession } from './helpers';

const copy = (page: Page) => page.getByRole('button', { name: 'Copy to clipboard', exact: true });
const action = (page: Page) => page.locator('.terminal-remote-copy');
const terminal = (page: Page) => page.locator('.xterm-helper-textarea:visible');
const osc = (text: string, end = '\x07') => `\x1b]52;c;${Buffer.from(text).toString('base64')}${end}`;
const ready = (socket: WebSocketRoute) => socket.send(JSON.stringify({ type: 'status', event: 'shell_ready', message: '' }));

interface ClipboardProbe {
  writes: string[];
  reads: number;
  attempts: number;
  reject: boolean;
  hold: boolean;
  release?: () => void;
}
const probe = (page: Page) => page.evaluate(() => {
  const { writes, reads, attempts } = (window as any).clipboardTest as ClipboardProbe;
  return { writes, reads, attempts };
});

async function setup(page: Page) {
  await mockAnonymousSession(page);
  await page.route('**/api/known-hosts?**', route => route.request().method() === 'GET'
    ? route.fulfill({ status: 401, json: { error: 'unauthorized' } }) : route.fallback());
  await page.addInitScript(() => {
    const state: ClipboardProbe = { writes: [], reads: 0, attempts: 0, reject: false, hold: false };
    Object.defineProperty(window, 'clipboardTest', { value: state });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => {
        state.attempts++;
        if (state.hold) await new Promise<void>(resolve => { state.release = resolve; });
        if (state.reject) throw new DOMException('User activation required', 'NotAllowedError');
        state.writes.push(text);
      },
      readText: async () => { state.reads++; return 'private clipboard'; },
    } });
  });
  const sessions: WebSocketRoute[] = [];
  const inputs: string[] = [];
  await page.routeWebSocket('**/api/ssh*', socket => {
    socket.onMessage(data => {
      if (typeof data === 'string' && data.startsWith('{')) {
        const message = JSON.parse(data);
        if (message.host) sessions.push(socket);
        if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong', id: message.id }));
      } else inputs.push(data.toString());
    });
  });
  await page.goto('/?lang=en-US');
  const yank = async () => {
    const count = inputs.length;
    await terminal(page).focus();
    await page.keyboard.press('y');
    await expect.poll(() => inputs.slice(count)).toContain('y');
  };
  return { sessions, inputs, yank };
}

async function connect(page: Page, sessions: WebSocketRoute[], host: string) {
  const count = sessions.length;
  await page.locator('#host').fill(host);
  await page.locator('#username').fill('operator');
  await page.locator('#auth-tab-none').click();
  await page.locator('#connect-btn').click();
  await expect.poll(() => sessions.length).toBe(count + 1);
  return sessions[count];
}

test('Herdr: first copy writes directly; only one valid write per trusted terminal operation', async ({ page }) => {
  const { sessions, inputs, yank } = await setup(page);
  const socket = await connect(page, sessions, 'copy.example.com');
  socket.send(Buffer.from(osc('pre-shell')));
  ready(socket);
  socket.send(Buffer.from(osc('unsolicited')));
  await yank();
  socket.send(Buffer.from('\x1b]52;c;?\x07\x1b]52;c;\x07\x1b]52;p;eA==\x07'));
  const text = '由 Herdr 複製 🐾\n  <b>text</b>\t';
  const frame = osc(text);
  socket.send(Buffer.from(frame.slice(0, 9)));
  socket.send(Buffer.from(frame.slice(9) + osc('same gesture extra write')));
  await expect.poll(() => probe(page)).toEqual({ writes: [text], reads: 0, attempts: 1 });
  await expect(action(page)).toHaveCount(0);
  await expect(terminal(page)).toBeFocused();
  await yank();
  socket.send(Buffer.from(osc('next copy', '\x1b\\')));
  await expect.poll(() => probe(page)).toEqual({ writes: [text, 'next copy'], reads: 0, attempts: 2 });
  expect(inputs).toEqual(['y', 'y']);
});

test('a denied native write shows only a one-time retry and restores terminal focus', async ({ page }) => {
  const { sessions, inputs, yank } = await setup(page);
  const socket = await connect(page, sessions, 'gesture.example.com');
  ready(socket);
  await page.evaluate(() => { (window as any).clipboardTest.reject = true; });
  await yank();
  socket.send(Buffer.from(osc('retry this')));
  await expect(copy(page)).toBeVisible();
  await copy(page).evaluate(button => (button as HTMLButtonElement).click());
  expect(await probe(page)).toEqual({ writes: [], reads: 0, attempts: 1 });
  await page.evaluate(() => { (window as any).clipboardTest.reject = false; });
  await page.keyboard.press('Alt+Shift+KeyC');
  await expect(copy(page)).toBeFocused();
  await expect(copy(page)).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  await expect(terminal(page)).toBeFocused();
  await expect(action(page)).toHaveCount(0);
  await expect.poll(() => probe(page)).toEqual({ writes: ['retry this'], reads: 0, attempts: 2 });
  await yank();
  socket.send(Buffer.from(osc('then straight through')));
  await expect.poll(() => probe(page)).toEqual({ writes: ['retry this', 'then straight through'], reads: 0, attempts: 3 });
  expect(inputs).toEqual(['y', 'y']);
});

test('a second denial gives feedback without another prompt or a clipboard read', async ({ page }) => {
  const { sessions, yank } = await setup(page);
  const socket = await connect(page, sessions, 'hard-denial.example.com');
  ready(socket);
  await page.evaluate(() => {
    (window as any).clipboardTest.reject = true;
    document.execCommand = () => false;
  });
  await yank();
  socket.send(Buffer.from(osc('still denied')));
  await copy(page).click();
  await expect(page.getByRole('alert')).toContainText(/browser permissions/i);
  await expect(action(page)).toHaveCount(0);
  expect(await probe(page)).toEqual({ writes: [], reads: 0, attempts: 2 });
});

test('clipboard retry text has sufficient contrast in all built-in themes', async ({ page }) => {
  const { sessions, yank } = await setup(page);
  const socket = await connect(page, sessions, 'themes.example.com');
  ready(socket);
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--motion-fast', '0ms');
    (window as any).clipboardTest.reject = true;
  });
  await yank();
  socket.send(Buffer.from(osc('check the copy button')));
  await expect(copy(page)).toBeVisible();
  const ratios = await copy(page).evaluate(async button => {
    const { applyBuiltInTheme, THEMES } = await (window as any).eval("import('/src/theme.ts')");
    const luminance = (color: string) => {
      const rgb = (color.match(/[\d.]+/g) ?? []).map(Number);
      if (rgb.length !== 3 && !(rgb.length === 4 && rgb[3] === 1)) {
        throw new Error(`Expected an opaque button color, got ${color}`);
      }
      const [r, g, b] = rgb.slice(0, 3).map(channel => {
        const v = channel / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratios: Record<string, number> = {};
    for (const theme of Object.keys(THEMES)) {
      applyBuiltInTheme(theme);
      const css = getComputedStyle(button);
      const [low, high] = [luminance(css.color), luminance(css.backgroundColor)].sort((a, b) => a - b);
      ratios[theme] = (high + 0.05) / (low + 0.05);
    }
    return ratios;
  });
  expect(Object.keys(ratios)).toHaveLength(4);
  for (const [theme, ratio] of Object.entries(ratios)) {
    expect(ratio, `${theme} fallback button contrast`).toBeGreaterThanOrEqual(4.5);
  }
});

test('mouse release in a mouse-tracking TUI can initiate a remote copy', async ({ page }) => {
  const { sessions, inputs } = await setup(page);
  const socket = await connect(page, sessions, 'pointer.example.com');
  ready(socket);
  socket.send(Buffer.from('\x1b[?1000h\x1b[?1006h'));
  await expect(page.locator('.xterm:visible')).toHaveClass(/\benable-mouse-events\b/);
  await page.locator('.xterm-screen:visible').click({ position: { x: 40, y: 40 } });
  await expect.poll(() => inputs.join('')).toMatch(/\x1b\[<0;\d+;\d+m/);
  socket.send(Buffer.from(osc('copied with pointer')));
  await expect.poll(() => probe(page)).toEqual({ writes: ['copied with pointer'], reads: 0, attempts: 1 });
});

test('background output never replays; foreground copy works again without authorizing', async ({ page }) => {
  const { sessions, yank } = await setup(page);
  const socket = await connect(page, sessions, 'tabs.example.com');
  ready(socket);
  await yank();
  await page.evaluate(async hidden => {
    const { getTabManager } = await (window as any).eval("import('/src/main.ts')");
    const tm = getTabManager(), original = tm.getActiveTab();
    const xterm = original.terminal.terminal;
    const flush = () => new Promise<void>(resolve => xterm.write('', resolve));
    const output = (data: string) => original.terminal.ws.onmessage({ data: new TextEncoder().encode(data).buffer });
    xterm.write(''); // Consume xterm's synchronous first write after input.
    output(hidden);
    const other = tm.createTab('inactive tab test');
    output(hidden);
    tm.switchTab(original.id);
    await flush();
    output(hidden.slice(0, -2));
    await flush();
    tm.switchTab(other.id);
    tm.switchTab(original.id);
    output(hidden.slice(-2));
    await flush();
  }, osc('must never write'));
  expect(await probe(page)).toEqual({ writes: [], attempts: 0, reads: 0 });
  await yank();
  socket.send(Buffer.from(osc('foreground again')));
  await expect.poll(() => probe(page)).toEqual({ writes: ['foreground again'], attempts: 1, reads: 0 });
});

test('a late permission denial after leaving cannot resurrect a clipboard action', async ({ page }) => {
  const { sessions, yank } = await setup(page);
  const socket = await connect(page, sessions, 'denied.example.com');
  ready(socket);
  await page.evaluate(() => Object.assign((window as any).clipboardTest, { hold: true, reject: true }));
  await yank();
  socket.send(Buffer.from(osc('late denial')));
  await expect.poll(() => probe(page)).toEqual({ attempts: 1, writes: [], reads: 0 });
  await page.locator('#new-tab-btn').click();
  await page.locator('#back-to-terminal-from-auth-btn').click();
  await page.evaluate(() => { (window as any).clipboardTest.release(); });
  await expect(action(page)).toHaveCount(0);
  await page.evaluate(() => Object.assign((window as any).clipboardTest, { hold: false, reject: false }));
  await yank();
  socket.send(Buffer.from(osc('new copy')));
  await expect.poll(() => probe(page)).toEqual({ attempts: 2, writes: ['new copy'], reads: 0 });
});

test('only one browser write in flight and the latest eligible copy waits', async ({ page }) => {
  const { sessions, yank } = await setup(page);
  const socket = await connect(page, sessions, 'burst.example.com');
  ready(socket);
  await page.evaluate(() => { (window as any).clipboardTest.hold = true; });
  await yank();
  socket.send(Buffer.from(osc('in flight')));
  await expect.poll(() => probe(page)).toEqual({ writes: [], attempts: 1, reads: 0 });
  await yank();
  socket.send(Buffer.from(osc('waiting')));
  await expect.poll(() => page.evaluate(async () => {
    const { getTabManager } = await (window as any).eval("import('/src/main.ts')");
    return getTabManager().getActiveTab().terminal.remoteCopy.latest;
  })).toBe('waiting');
  await yank();
  socket.send(Buffer.from(osc('latest')));
  await expect.poll(() => page.evaluate(async () => {
    const { getTabManager } = await (window as any).eval("import('/src/main.ts')");
    return getTabManager().getActiveTab().terminal.remoteCopy.latest;
  })).toBe('latest');
  await page.evaluate(() => {
    (window as any).clipboardTest.hold = false;
    (window as any).clipboardTest.release();
  });
  await expect.poll(() => probe(page)).toEqual({ writes: ['in flight', 'latest'], attempts: 2, reads: 0 });
});

test('expired local interaction does not write; the blocked-write button expires', async ({ page }) => {
  await page.clock.install();
  const { sessions, yank } = await setup(page);
  const socket = await connect(page, sessions, 'expiry.example.com');
  ready(socket);
  await yank();
  await page.clock.fastForward(2_501);
  socket.send(Buffer.from(osc('too late')));
  await page.clock.fastForward(100);
  expect(await probe(page)).toEqual({ attempts: 0, reads: 0, writes: [] });
  await page.evaluate(() => { (window as any).clipboardTest.reject = true; });
  await yank();
  socket.send(Buffer.from(osc('blocked')));
  await expect(copy(page)).toBeVisible();
  await page.clock.fastForward(30_001);
  await expect(action(page)).toHaveCount(0);
  expect(await probe(page)).toEqual({ attempts: 1, reads: 0, writes: [] });
});

test('standalone share and unclassified resume URLs do not install remote copy', async ({ page }) => {
  await setup(page);
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket('**/api/ssh*', ws => { sockets.push(ws); });
  for (const query of ['share_ref=fixture&share_ticket=fixture', 'session=fixture&resume_token=fixture']) {
    const count = sockets.length;
    const endpoint = new URL('/api/ssh?' + query, page.url());
    endpoint.protocol = 'ws:';
    await page.goto('/?' + new URLSearchParams({ wsUrl: endpoint.href }));
    await expect.poll(() => sockets.length).toBe(count + 1);
    ready(sockets[count]);
    await terminal(page).focus();
    await page.keyboard.press('y');
    sockets[count].send(Buffer.from(osc('ignored') + 'display-marker'));
    await expect.poll(() => page.evaluate(async () => {
      const { getTabManager } = await (window as any).eval("import('/src/main.ts')");
      const buffer = getTabManager().getActiveTab().terminal.terminal.buffer.active;
      return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString(true)).join('');
    })).toContain('display-marker');
    await expect(action(page)).toHaveCount(0);
    expect((await probe(page)).attempts).toBe(0);
  }
});
