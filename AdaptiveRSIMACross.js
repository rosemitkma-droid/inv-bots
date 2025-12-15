require('dotenv').config();
const WebSocket = require('ws'); // ADD THIS
const fs = require('fs');
const winston = require('winston');
const config = require('./config.json');

if (!fs.existsSync('./logs')) {
  fs.mkdirSync('./logs');
}

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      return `${timestamp} [${level}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/bot.log' })
  ]
});

const DerivAPI = require('./DERIVAPI');
const StrategyEngine = require('./StrategyEngine');
const RiskManager = require('./RiskManager');
const TelegramBot = require('./TelegramBot');

class DerivBot {
  constructor() {
    this.config = config;
    this.isRunning = false;
    this.lastTick = null;
    
    this.derivAPI = new DerivAPI({
      appId: process.env.DERIV_APP_ID,
      token: process.env.DERIV_API_TOKEN
    });

    this.strategyEngine = new StrategyEngine(this.config.strategy);
    this.riskManager = new RiskManager(this.config.risk);
    this.telegram = new TelegramBot(
      process.env.TELEGRAM_BOT_TOKEN,
      process.env.TELEGRAM_CHAT_ID,
      this.config.telegram.enabled
    );

    this.derivAPI.onTick = (tick) => this.onTick(tick);
    this.derivAPI.onTrade = (tradeData) => this.onTradeExecuted(tradeData);

    this.balance = 0;
    this.currentStake = this.config.staking.baseStake;
    this.lastTradeResult = null;
    this.tradesToday = 0;
  }

  async start() {
    try {
      logger.info('Starting Deriv Advanced Bot...');
      
      // CRITICAL: Connect and wait for authorization
      await this.derivAPI.connect();
      
      // Now safe to subscribe
      const symbol = process.env.TRADE_SYMBOL || this.config.bot.defaultSymbol;
      this.derivAPI.subscribeToTicks(symbol);
      
      this.balance = await this.derivAPI.getBalance();
      this.riskManager.maxBalance = this.balance;
      
      await this.telegram.notifyStartup(this.config);
      
      this.isRunning = true;
      logger.info(`Bot running. Monitoring ${symbol}...`);
      
      this.keepAlive();
      
    } catch (error) {
      logger.error(`Startup failed: ${error.message}`);
      process.exit(1); // Hard exit on failure
    }
  }

  async onTick(tick) {
    if (!this.isRunning) return;
    
    this.lastTick = tick;
    const tickHistory = this.derivAPI.tickHistory;

    const signal = this.strategyEngine.generateSignal(tickHistory);
    
    if (!signal) return;

    const proposedStake = this.riskManager.calculatePositionSize(
      this.balance, 
      signal.confidence
    );

    const stake = this.applyStakingSystem(proposedStake);
    
    const riskCheck = this.riskManager.canTrade(this.balance, stake);
    
    if (!riskCheck.allowed) {
      logger.warn(`Trade blocked: ${riskCheck.reason}`);
      
      if (this.config.telegram.notifyOnRiskLimit) {
        const metrics = this.riskManager.getRiskMetrics(this.balance);
        await this.telegram.notifyRiskLimit(riskCheck.reason, metrics);
      }
      
      if (['DAILY_LOSS_LIMIT', 'MAX_DRAWDOWN', 'CONSECUTIVE_LOSSES'].includes(riskCheck.reason)) {
        await this.stop();
      }
      return;
    }

    try {
      const proposal = {
        symbol: process.env.TRADE_SYMBOL || this.config.bot.defaultSymbol,
        contract_type: signal.direction,
        amount: stake,
        duration: parseInt(process.env.TRADE_DURATION) || 5
      };

      logger.info(`Executing trade: ${signal.direction} $${stake}`);
      await this.derivAPI.buy(proposal);
      
      this.riskManager.recordTrade({
        amount: stake,
        direction: signal.direction,
        timestamp: Date.now(),
        won: null
      });

      this.tradesToday++;
      
      if (this.config.telegram.notifyOnTrade) {
        await this.telegram.notifyTrade(signal, stake, this.balance);
      }

    } catch (error) {
      logger.error(`Trade execution failed: ${error.message}`);
    }
  }

  applyStakingSystem(baseStake) {
    const stakingConfig = this.config.staking;
    
    if (stakingConfig.system === 'martingale') {
      if (this.lastTradeResult === false) {
        this.currentStake = Math.min(
          this.currentStake * stakingConfig.martingaleMultiplier,
          stakingConfig.maxStake
        );
      } else {
        this.currentStake = stakingConfig.baseStake;
      }
    }
    
    return Math.max(this.currentStake, baseStake);
  }

  async onTradeExecuted(tradeData) {
    logger.info(`Trade executed: ${tradeData.contract_id}`);
    
    // Subscribe to contract updates
    const requestId = this.derivAPI.generateRequestId();
    this.derivAPI.ws.send(JSON.stringify({
      proposal_open_contract: 1,
      contract_id: tradeData.contract_id,
      subscribe: 1,
      req_id: requestId
    }));

    // Override handleMessage temporarily to catch contract updates
    const originalHandler = this.derivAPI.handleMessage.bind(this.derivAPI);
    this.derivAPI.handleMessage = (response) => {
      if (response.msg_type === 'proposal_open_contract' && response.proposal_open_contract) {
        const poc = response.proposal_open_contract;
        if (poc.is_sold) {
          this.handleTradeClosure(poc);
        }
      }
      originalHandler(response);
    };
  }

  async handleTradeClosure(contract) {
    const profit = parseFloat(contract.profit);
    const won = profit > 0;
    const buyPrice = parseFloat(contract.buy_price);

    this.lastTradeResult = won;
    this.balance = await this.derivAPI.getBalance();
    
    this.riskManager.recordClosedTrade({
      amount: buyPrice,
      profit: profit,
      won: won
    });

    logger.info(`Trade closed. Profit: $${profit.toFixed(2)}, Balance: $${this.balance.toFixed(2)}`);

    if (this.config.telegram.notifyOnProfit) {
      await this.telegram.notifyProfit(profit, this.balance);
    }

    if (this.balance > this.riskManager.maxBalance) {
      this.riskManager.maxBalance = this.balance;
    }
  }

  async stop() {
    this.isRunning = false;
    logger.warn('Bot stopped');
    
    const metrics = this.riskManager.getRiskMetrics(this.balance);
    await this.telegram.sendMessage(`🛑 Bot stopped. Final balance: $${this.balance.toFixed(2)}`);
    
    process.exit(0);
  }

  keepAlive() {
    setInterval(() => {
      if (this.isRunning && this.derivAPI.ws) {
        if (this.derivAPI.ws.readyState === WebSocket.OPEN) {
          this.derivAPI.ws.send(JSON.stringify({ ping: 1 }));
        }

        if (new Date().getMinutes() === 0) {
          const metrics = this.riskManager.getRiskMetrics(this.balance);
          logger.info(`Hourly status: Balance $${this.balance.toFixed(2)}, Daily Loss $${metrics.dailyLoss}/${metrics.dailyLossLimit}, Drawdown ${metrics.currentDrawdown}%`);
        }
      }
    }, 60000);
  }
}

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  if (bot) {
    await bot.stop();
  }
});

process.on('uncaughtException', async (error) => {
  logger.error(`Uncaught exception: ${error.message}`);
  logger.error(error.stack);
  if (bot) {
    await bot.stop();
  }
  process.exit(1);
});

const bot = new DerivBot();
bot.start().catch(console.error);
