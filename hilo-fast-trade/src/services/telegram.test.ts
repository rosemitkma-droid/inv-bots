import { describe, expect, test, vi } from 'bun:test';
import { createTelegramNotifier } from './telegram';

function fakeFetch(body: Record<string, unknown>): () => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
}

describe('createTelegramNotifier', () => {
  test('disabled when token or chatId is missing', () => {
    expect(createTelegramNotifier(undefined, '123').enabled).toBe(false);
    expect(createTelegramNotifier('tok', undefined).enabled).toBe(false);
    expect(createTelegramNotifier('', '123').enabled).toBe(false);
    expect(createTelegramNotifier('tok', '').enabled).toBe(false);
  });

  test('enabled when both token and chatId are set', () => {
    expect(createTelegramNotifier('TOKEN', 'CHAT').enabled).toBe(true);
  });

  test('send() is a no-op when disabled', async () => {
    const n = createTelegramNotifier(undefined, '123');
    await expect(n.send('hello')).resolves.toBeUndefined();
  });

  test('send() posts to the correct Telegram endpoint', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const orig = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = async (url: string, init: Record<string, unknown>) => {
      calls.push({ url: url as string, body: init.body as Record<string, unknown> ? JSON.parse(init.body as string) : {} });
      return fakeFetch({ ok: true })().then((r) => r);
    };
    try {
      const n = createTelegramNotifier('MYTOKEN', 'MYCHAT');
      await n.send('hello world');
      expect(calls.length).toBe(1);
      expect(calls[0]!.url).toBe('https://api.telegram.org/botMYTOKEN/sendMessage');
      expect(calls[0]!.body).toMatchObject({
        chat_id: 'MYCHAT',
        text: 'hello world',
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } finally {
      (globalThis as Record<string, unknown>).fetch = orig;
    }
  });

  test('sendTradeOpen formats the message', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const orig = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = async (url: string, init: Record<string, unknown>) => {
      calls.push({ url: url as string, body: init.body as Record<string, unknown> ? JSON.parse(init.body as string) : {} });
      return fakeFetch({ ok: true })().then((r) => r);
    };
    try {
      const n = createTelegramNotifier('TOKEN', 'CHAT');
      await n.sendTradeOpen('14:30Z', 'NOTOUCH↑', '1000.50', '1.00', ' p=56.8% ev=+0.05');
      expect(calls[0]!.body.text).toContain('🔵 Trade Open');
      expect(calls[0]!.body.text).toContain('14:30Z');
      expect(calls[0]!.body.text).toContain('NOTOUCH↑ @ 1000.50');
      expect(calls[0]!.body.text).toContain('Stake: $1.00');
      expect(calls[0]!.body.text).toContain('p=56.8% ev=+0.05');
    } finally {
      (globalThis as Record<string, unknown>).fetch = orig;
    }
  });

  test('sendTradeResult formats the message', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const orig = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = async (url: string, init: Record<string, unknown>) => {
      calls.push({ url: url as string, body: init.body as Record<string, unknown> ? JSON.parse(init.body as string) : {} });
      return fakeFetch({ ok: true })().then((r) => r);
    };
    try {
      const n = createTelegramNotifier('TOKEN', 'CHAT');
      await n.sendTradeResult('+0.32', 'H won +0.58 · L lost -0.26');
      expect(calls[0]!.body.text).toContain('📊 Trade Result');
      expect(calls[0]!.body.text).toContain('P/L: +0.32');
      expect(calls[0]!.body.text).toContain('H won +0.58');
      expect(calls[0]!.body.text).toContain('L lost -0.26');
    } finally {
      (globalThis as Record<string, unknown>).fetch = orig;
    }
  });

  test('sendHourly formats the message', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const orig = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = async (url: string, init: Record<string, unknown>) => {
      calls.push({ url: url as string, body: init.body as Record<string, unknown> ? JSON.parse(init.body as string) : {} });
      return fakeFetch({ ok: true })().then((r) => r);
    };
    try {
      const n = createTelegramNotifier('TOKEN', 'CHAT');
      await n.sendHourly(12, '+3.40', '67%');
      expect(calls[0]!.body.text).toContain('⏱ Hourly Report');
      expect(calls[0]!.body.text).toContain('Blocks: 12');
      expect(calls[0]!.body.text).toContain('P/L: +3.40');
      expect(calls[0]!.body.text).toContain('Win rate: 67%');
    } finally {
      (globalThis as Record<string, unknown>).fetch = orig;
    }
  });

  test('sendSessionEnd formats the message', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const orig = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = async (url: string, init: Record<string, unknown>) => {
      calls.push({ url: url as string, body: init.body as Record<string, unknown> ? JSON.parse(init.body as string) : {} });
      return fakeFetch({ ok: true })().then((r) => r);
    };
    try {
      const n = createTelegramNotifier('TOKEN', 'CHAT');
      await n.sendSessionEnd(24, '+5.20', '71%', 'session TP hit: 5.20 >= 5');
      expect(calls[0]!.body.text).toContain('🏁 Session Ended');
      expect(calls[0]!.body.text).toContain('session TP hit');
      expect(calls[0]!.body.text).toContain('Blocks: 24');
      expect(calls[0]!.body.text).toContain('P/L: +5.20');
      expect(calls[0]!.body.text).toContain('Win rate: 71%');
    } finally {
      (globalThis as Record<string, unknown>).fetch = orig;
    }
  });

  test('warns on non-200 but does not throw', async () => {
    const orig = globalThis.fetch;
    const warnSpy = vi.fn();
    const origWarn = console.warn;
    console.warn = warnSpy;
    (globalThis as Record<string, unknown>).fetch = async () =>
      Promise.resolve(
        new Response('bad token', { status: 401, headers: { 'Content-Type': 'text/plain' } }),
      );
    try {
      const n = createTelegramNotifier('TOKEN', 'CHAT');
      await expect(n.send('hello')).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('telegram: send failed 401'));
    } finally {
      console.warn = origWarn;
      (globalThis as Record<string, unknown>).fetch = orig;
    }
  });

  test('warns on network error but does not throw', async () => {
    const orig = globalThis.fetch;
    const warnSpy = vi.fn();
    const origWarn = console.warn;
    console.warn = warnSpy;
    (globalThis as Record<string, unknown>).fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    try {
      const n = createTelegramNotifier('TOKEN', 'CHAT');
      await expect(n.send('hello')).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('telegram: send error'));
    } finally {
      console.warn = origWarn;
      (globalThis as Record<string, unknown>).fetch = orig;
    }
  });
});
