const TelegramBot = require('node-telegram-bot-api');

class TelegramNotifier {
  constructor(token, chatId, enabled = false) {
    this.enabled = enabled;
    this.chatId = chatId;
    
    if (this.enabled && token && chatId) {
      this.bot = new TelegramBot(token, { polling: false });
    }
  }

  async sendMessage(message) {
    if (!this.enabled || !this.bot) {
      console.log(`Telegram disabled: ${message}`);
      return;
    }

    try {
      await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error(`Telegram notification failed: ${error.message}`);
    }
  }

  async notifyTrade(signal, stake, balance) {
    const message = `
📊 *TRADE EXECUTED*
Direction: *${signal.direction}*
Stake: $${stake}
Confidence: ${signal.confidence}
Signal Strength: ${(signal.strength * 100).toFixed(2)}%
Balance: $${balance.toFixed(2)}
    `;
    await this.sendMessage(message);
  }

  async notifyRiskLimit(reason, metrics) {
    const message = `
🚨 *RISK LIMIT TRIGGERED*
Reason: *${reason}*
Daily Loss: $${metrics.dailyLoss}/${metrics.dailyLossLimit}
Drawdown: ${metrics.currentDrawdown}%
Consecutive Losses: ${metrics.consecutiveLosses}
Trading: *PAUSED*
    `;
    await this.sendMessage(message);
  }

  async notifyProfit(profit, balance) {
    const message = `
💰 *TRADE CLOSED*
Profit: *$${profit.toFixed(2)}*
Balance: $${balance.toFixed(2)}
    `;
    await this.sendMessage(message);
  }

  async notifyStartup(config) {
    const message = `
🚀 *BOT STARTED*
Strategy: ${config.strategy.name}
Symbol: ${config.bot.defaultSymbol}
Demo Mode: ${config.bot.demoMode ? 'YES' : 'NO'}
Daily Loss Limit: $${config.risk.maxDailyLoss}
Max Drawdown: ${config.risk.maxDrawdownPercent}%
    `;
    await this.sendMessage(message);
  }
}

module.exports = TelegramNotifier;
