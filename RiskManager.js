const winston = require('winston');
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}]: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/risk-manager.log' })
  ]
});

class RiskManager {
  constructor(config) {
    this.config = config;
    this.dailyLoss = 0;
    this.maxBalance = 0;
    this.consecutiveLosses = 0;
    this.tradeHistory = [];
    this.lastResetDate = new Date().toDateString();
    this.activeTrades = 0;
  }

  canTrade(balance, proposedStake) {
    // Reset daily loss at midnight
    this.checkDailyReset();

    // Check daily loss limit
    if (this.dailyLoss >= this.config.maxDailyLoss) {
      logger.warn(`Daily loss limit reached: $${this.dailyLoss}/${this.config.maxDailyLoss}`);
      return { allowed: false, reason: 'DAILY_LOSS_LIMIT' };
    }

    // Update max balance
    if (balance > this.maxBalance) {
      this.maxBalance = balance;
    }

    // Check drawdown limit
    const drawdown = ((this.maxBalance - balance) / this.maxBalance) * 100;
    if (drawdown >= this.config.maxDrawdownPercent) {
      logger.warn(`Max drawdown exceeded: ${drawdown.toFixed(2)}%`);
      return { allowed: false, reason: 'MAX_DRAWDOWN' };
    }

    // Check minimum balance
    if (balance < this.config.minBalanceToTrade) {
      return { allowed: false, reason: 'LOW_BALANCE' };
    }

    // Check consecutive losses
    if (this.consecutiveLosses >= this.config.stopAfterConsecutiveLosses) {
      logger.warn(`Consecutive loss limit reached: ${this.consecutiveLosses}`);
      return { allowed: false, reason: 'CONSECUTIVE_LOSSES' };
    }

    // Check concurrent trades
    if (this.activeTrades >= this.config.maxConcurrentTrades) {
      return { allowed: false, reason: 'MAX_CONCURRENT_TRADES' };
    }

    // Check proposed stake vs position size
    const maxPositionSize = balance * this.config.positionSizePercent;
    if (proposedStake > maxPositionSize) {
      logger.warn(`Proposed stake $${proposedStake} exceeds max position size $${maxPositionSize}`);
      return { allowed: false, reason: 'POSITION_SIZE_EXCEEDED' };
    }

    return { allowed: true };
  }

  calculatePositionSize(balance, signalConfidence) {
    const baseSize = balance * this.config.positionSizePercent;
    const confidenceMultiplier = signalConfidence === 'high' ? 1.5 : 1;
    const consecutiveLossMultiplier = Math.max(0.5, 1 - (this.consecutiveLosses * 0.1));
    
    return Math.floor(baseSize * confidenceMultiplier * consecutiveLossMultiplier);
  }

  recordTrade(trade) {
    this.tradeHistory.push(trade);
    this.activeTrades++;

    if (!trade.won) {
      this.dailyLoss += trade.amount;
      this.consecutiveLosses++;
    } else {
      this.consecutiveLosses = 0;
    }

    logger.info(`Trade recorded. Daily loss: $${this.dailyLoss}, Consecutive losses: ${this.consecutiveLosses}`);
  }

  recordClosedTrade(tradeResult) {
    this.activeTrades--;
    
    if (!tradeResult.won) {
      this.dailyLoss += tradeResult.amount;
      this.consecutiveLosses++;
    } else {
      this.consecutiveLosses = 0;
    }

    logger.info(`Trade closed. P&L: $${tradeResult.profit}, Daily loss: $${this.dailyLoss}`);
  }

  checkDailyReset() {
    const currentDate = new Date().toDateString();
    if (this.lastResetDate !== currentDate) {
      this.dailyLoss = 0;
      this.lastResetDate = currentDate;
      logger.info('Daily loss counter reset');
    }
  }

  getRiskMetrics(balance) {
    return {
      dailyLoss: this.dailyLoss,
      dailyLossLimit: this.config.maxDailyLoss,
      remainingDailyLoss: this.config.maxDailyLoss - this.dailyLoss,
      maxBalance: this.maxBalance,
      currentDrawdown: this.maxBalance ? ((this.maxBalance - balance) / this.maxBalance * 100).toFixed(2) : 0,
      consecutiveLosses: this.consecutiveLosses,
      activeTrades: this.activeTrades,
      canTrade: this.canTrade(balance, 0).allowed
    };
  }
}

module.exports = RiskManager;
