/**
 * Telegram notification service for HiLo-Fast.
 *
 * Sends trade-open, trade-result, hourly summary, session-end, and end-of-day
 * messages via the Telegram Bot API. Requires both `token` and `chatId` to be set —
 * every send() is a no-op when not configured.
 *
 * All HTTP calls use `fetch` with AbortSignal + timeout. Failures are logged
 * but never throw — notifications are best-effort and must never break the
 * trading loop.
 */

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const REQUEST_TIMEOUT_MS = 10_000;

export interface TelegramNotifier {
  /** Raw HTML text — caller handles formatting. */
  send(text: string): Promise<void>;
  /** Convenience: formatted trade-open message. */
  sendTradeOpen(blockTime: string, label: string, barrier: string, stakeUsd: string, evTag?: string): Promise<void>;
  /** Convenience: formatted trade-result message. */
  sendTradeResult(pnl: string, legs: string, stats: { trades: number; wins: number; losses: number; winRate: string; netPnl: string }): Promise<void>;
  /** Convenience: formatted hourly summary. */
  sendHourly(trades: number, pnl: string, winRate: string, stats: { totalTrades: number; wins: number; losses: number; netPnl: string }): Promise<void>;
  /** Convenience: formatted session-end message. */
  sendSessionEnd(trades: number, pnl: string, winRate: string, reason: string): Promise<void>;
  /** Convenience: formatted end-of-day summary (GMT+1). */
  sendEndOfDay(dateStr: string, stats: { trades: number; wins: number; losses: number; winRate: string; netPnl: string }): Promise<void>;
  /** Returns whether the notifier is configured. */
  get enabled(): boolean;
}

export function createTelegramNotifier(
  token: string | undefined,
  chatId: string | undefined,
): TelegramNotifier {
  const enabled = Boolean(token && chatId);

  async function post(text: string): Promise<void> {
    if (!enabled) return;
    const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.warn(`telegram: send failed ${res.status} ${detail}`);
      }
    } catch (err) {
      console.warn(`telegram: send error — ${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    get enabled() { return enabled; },

    async send(text: string): Promise<void> {
      await post(text);
    },

    async sendTradeOpen(blockTime: string, label: string, barrier: string, stakeUsd: string, evTag?: string): Promise<void> {
      const evLine = evTag ? `\n${evTag}` : '';
      await post(
        `<b>🔵 Trade Open</b> ${blockTime}\n` +
        `${label} @ ${barrier}\n` +
        `Stake: $${stakeUsd}${evLine}`,
      );
    },

    async sendTradeResult(pnl: string, legs: string, stats: { trades: number; wins: number; losses: number; winRate: string; netPnl: string }): Promise<void> {
      await post(
        `<b>📊 Trade Result</b>\n` +
        `P/L: ${pnl}\n` +
        `${legs}\n\n` +
        `📈 <b>Session Stats</b>\n` +
        `Total Trades: ${stats.trades} (Win: ${stats.wins} / Loss: ${stats.losses})\n` +
        `Win Ratio: ${stats.winRate}\n` +
        `Net P/L: ${stats.netPnl}`,
      );
    },

    async sendHourly(trades: number, pnl: string, winRate: string, stats: { totalTrades: number; wins: number; losses: number; netPnl: string }): Promise<void> {
      await post(
        `<b>⏱ Hourly Report</b>\n` +
        `Blocks Traded (Hour): ${trades}\n` +
        `Hour P/L: ${pnl}\n\n` +
        `📈 <b>Session Summary</b>\n` +
        `Total Trades: ${stats.totalTrades} (Win: ${stats.wins} / Loss: ${stats.losses})\n` +
        `Win Rate: ${winRate}\n` +
        `Net P/L: ${stats.netPnl}`,
      );
    },

    async sendSessionEnd(trades: number, pnl: string, winRate: string, reason: string): Promise<void> {
      await post(
        `<b>🏁 Session Ended</b> — ${reason}\n` +
        `Blocks: ${trades}\n` +
        `P/L: ${pnl}\n` +
        `Win rate: ${winRate}`,
      );
    },

    async sendEndOfDay(dateStr: string, stats: { trades: number; wins: number; losses: number; winRate: string; netPnl: string }): Promise<void> {
      await post(
        `🌙 <b>End of Day Report (${dateStr} GMT+1)</b>\n` +
        `Total Trades: ${stats.trades} (Win: ${stats.wins} / Loss: ${stats.losses})\n` +
        `Win Rate: ${stats.winRate}\n` +
        `Net P/L: ${stats.netPnl}`,
      );
    },
  };
}
