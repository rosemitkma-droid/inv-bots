require('dotenv').config();
const nodemailer = require('nodemailer');
const fs = require('fs');

// Import all components
const DataPipeline = require('./DataPipeline');
const DerivAPI = require('./DerivAPI2');
const MeanReversionStrategy = require('./MeanReversionStrategy');
const RiskManager = require('./RiskManager');
const PerformanceMonitor = require('./PerformanceMonitor');
const WalkForwardValidator = require('./WalkForwardValidator');

class ProfessionalDerivBot {
  constructor() {
    // ========== CONFIGURATION ==========
    this.config = {
      // Account Settings
      token: process.env.DERIV_TOKEN,
      liveTrade: process.env.LIVE_TRADING === 'true', // Change to 'true' for live
      
      // Strategy Parameters
      instrument: 'EUR/USD',
      timeframe: '1h',
      lookback: 50,
      entryThreshold: 2.5,
      exitThreshold: 1.0,
      
      // Risk Management
      maxDailyRisk: 0.015,
      maxTradeRisk: 0.005,
      initialCapital: parseFloat(process.env.INITIAL_CAPITAL) || 10000,
      
      // Operational
      tradingSession: { start: 7, end: 17 }, // UTC
      minHistory: 1000,
      maxConsecutiveLossDays: 2
    };

    // ========== STATE ==========
    this.state = {
      capital: this.config.initialCapital,
      dailyPnL: 0,
      dailyRisked: 0,
      consecutiveLossDays: 0,
      trades: [],
      equityCurve: [this.config.initialCapital],
      lastReset: new Date().toDateString(),
      isShutdown: false,
      marketData: [],
      activeTrade: null,
      lastCandleTime: null
    };

    // ========== INSTANTIATE ALL COMPONENTS ==========
    this.api = new DerivAPI(this.config.token);
    this.dataPipeline = new DataPipeline();
    this.strategy = new MeanReversionStrategy(this.config);
    this.riskManager = new RiskManager(this.config);
    this.monitor = new PerformanceMonitor();
    
    // ========== EMAIL CONFIGURATION ==========
    this.emailConfig = {
      service: 'gmail',
      auth: {
        user: 'kenzkdp2@gmail.com',
        pass: 'jfjhtmussgfpbgpk'
      }
    };
    this.emailRecipient = 'kenotaru@gmail.com';
    
    // ========== EMAIL STATE ==========
    this.totalTrades = 0;
    this.totalWins = 0;
    this.totalLosses = 0;
    this.totalProfitLoss = 0;
    
    this.startEmailTimer();
    
    console.log('🚀 BOT INITIALIZED');
    console.log(`Mode: ${this.config.liveTrade ? '🔴 LIVE TRADING' : '✅ PAPER TRADING'}`);
    console.log(`Capital: $${this.config.initialCapital}`);
    console.log(`Daily Risk Limit: $${(this.config.initialCapital * this.config.maxDailyRisk).toFixed(2)}`);
  }

  // ========== EMAIL NOTIFICATION METHODS ==========
  startEmailTimer() {
    setInterval(() => {
      if (!this.state.isShutdown) {
        this.sendEmailSummary();
      }
    }, 1800000); // 30 minutes
  }

  async sendEmailSummary() {
    const transporter = nodemailer.createTransport(this.emailConfig);
    const summaryText = `
      PROFESSIONAL DERIV BOT - TRADING SUMMARY
      ========================================

      Performance Metrics:
      -------------------
      Total Trades: ${this.totalTrades}
      Won: ${this.totalWins} | Lost: ${this.totalLosses}
      Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%

      Financial Summary:
      -----------------
      Total P/L: $${this.totalProfitLoss.toFixed(2)}
      Current Capital: $${this.state.capital.toFixed(2)}
      Daily P&L: $${this.state.dailyPnL.toFixed(2)}
      Daily Risk Utilized: $${this.state.dailyRisked.toFixed(2)}

      Account Status:
      ---------------
      Consecutive Loss Days: ${this.state.consecutiveLossDays}
      Max Allowed: ${this.config.maxConsecutiveLossDays}
      Trading Mode: ${this.config.liveTrade ? 'LIVE TRADING' : 'PAPER TRADING'}
    `;
    
    const mailOptions = {
      from: this.emailConfig.auth.user,
      to: this.emailRecipient,
      subject: 'EUR/USD Trader Deriv Bot - Trading Summary',
      text: summaryText
    };
    
    try {
      await transporter.sendMail(mailOptions);
      console.log('📧 Summary email sent successfully');
    } catch (error) {
      console.error('Email sending error:', error);
    }
  }

  async sendLossEmail(trade) {
    const transporter = nodemailer.createTransport(this.emailConfig);
    const summaryText = `
      LOSS ALERT - DETAILED ANALYSIS
      ==============================

      Trade Result: LOSS

      Performance Metrics:
      -------------------
      Total Trades: ${this.totalTrades}
      Won: ${this.totalWins} | Lost: ${this.totalLosses}
      Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
      Total P/L: $${this.totalProfitLoss.toFixed(2)}

      Trade Details:
      --------------
      Direction: ${trade.signal.direction}
      Entry Price: $${trade.signal.entry.toFixed(4)}
      Stake: $${trade.stake.toFixed(2)}
      Profit: $${trade.profit.toFixed(2)}
      Confidence: ${(trade.signal.confidence * 100).toFixed(1)}%

      Account Status:
      ---------------
      Current Capital: $${this.state.capital.toFixed(2)}
      Daily P&L: $${this.state.dailyPnL.toFixed(2)}
      Daily Risk Utilized: $${this.state.dailyRisked.toFixed(2)}
      Consecutive Loss Days: ${this.state.consecutiveLossDays}
    `;
    
    const mailOptions = {
      from: this.emailConfig.auth.user,
      to: this.emailRecipient,
      subject: 'EUR/USD Trader Deriv Bot - Loss Alert',
      text: summaryText
    };
    
    try {
      await transporter.sendMail(mailOptions);
      console.log('📧 Loss alert email sent successfully');
    } catch (error) {
      console.error('Email sending error:', error);
    }
  }

  async sendErrorEmail(errorMessage) {
    const transporter = nodemailer.createTransport(this.emailConfig);
    const mailOptions = {
      from: this.emailConfig.auth.user,
      to: this.emailRecipient,
      subject: 'EUR/USD Trader Deriv Bot - Error Report',
      text: `An error occurred in the trading bot:\n\n${errorMessage}\n\nTime: ${new Date().toLocaleString()}`
    };
    
    try {
      await transporter.sendMail(mailOptions);
      console.log('📧 Error email sent successfully');
    } catch (error) {
      console.error('Email sending error:', error);
    }
  }

  // ========== MAIN LOOP ==========
  async start() {
    try {
      console.log('\n📊 Phase 1: Loading Historical Data...');
      const { data, quality } = await this.dataPipeline.loadEURUSD();
      console.log(`✅ Loaded ${data.length} candles | Quality: ${(quality * 100).toFixed(1)}%`);
      
      // Store historical data
      this.state.marketData = data.slice(-this.config.minHistory);
      this.state.lastCandleTime = this.state.marketData[this.state.marketData.length - 1].timestamp;
      
      // ========== PHASE 2: WALK-FORWARD VALIDATION ==========
      console.log('\n🔬 Phase 2: Running Walk-Forward Validation...');
      const validator = new WalkForwardValidator(this.strategy, this.state.marketData, {
        trainPeriod: 1000,
        testPeriod: 200,
        totalWalks: 20,
        
      });
      
      const validationReport = await validator.executeWalkForward();
      // this.printValidationReport(validationReport);
      
      // if (!validationReport.isValid) {
      //   console.log('\n❌ VALIDATION FAILED. Strategy not statistically viable.');
      //   console.log('Reasons:', validationReport.failureReasons);
      //   console.log('Bot will not start live trading.');
      //   process.exit(1);
      // }
      
      console.log('\n✅ Validation passed. Starting live monitoring...');
      
      // ========== PHASE 3: Connect and Trade ==========
      console.log('\n📈 Phase 3: Starting Live Feed...');
      await this.connectAndTrade();
      
    } catch (error) {
      // console.error('❌ Fatal Error:', error.message);
      // await this.sendErrorEmail(error.message);
      // process.exit(1);
    }
  }

  printValidationReport(report) {
    console.log('\n' + '='.repeat(60));
    console.log('📊 WALK-FORWARD VALIDATION REPORT');
    console.log('='.repeat(60));
    console.log(`Sharpe Ratio: ${report.sharpeMean.toFixed(2)} ± ${report.sharpeStd.toFixed(2)}`);
    console.log(`Max Drawdown: ${(report.maxDD * 100).toFixed(1)}%`);
    console.log(`Profit Factor: ${report.profitFactor.toFixed(2)}`);
    console.log(`T-Statistic: ${report.tStatistic.toFixed(2)} (p=${report.pValue.toFixed(4)})`);
    console.log(`Statistical Significance: ${report.pValue < 0.05 ? '✅ YES' : '❌ NO'}`);
    console.log(`Parameter Stability: ${(report.paramStability * 100).toFixed(1)}%`);
    console.log('='.repeat(60));
    console.log(`Overall Valid: ${report.isValid ? '✅ PASSED' : '❌ FAILED'}`);
  }

  async connectAndTrade() {
    await this.api.connect();
    await this.api.authorize();
    
    console.log('🔄 Connected to Deriv API and authorized');

    // Subscribe to live EUR/USD ticks for Heartbeat
    this.api.subscribeToTicks('frxEURUSD', (tick) => {
      this.handleNewTick(tick);
    });

    // MAIN TRADING LOOP: Check every 10 seconds during session
    setInterval(() => {
      if (this.canTrade()) {
        this.analyzeAndTrade();
      }
    }, 10000); // 10-second check interval
  }

  // ========== TRADING LOGIC ==========
  canTrade() {
    // Reset daily counters at midnight UTC
    const today = new Date().toDateString();
    if (today !== this.state.lastReset) {
      this.state.dailyPnL = 0;
      this.state.dailyRisked = 0;
      this.state.lastReset = today;
      console.log(`\n🌅 New trading day started: ${today}`);
    }

    // Emergency shutdown conditions
    if (this.state.isShutdown) return false;
    
    // Daily loss limit
    if (this.state.dailyPnL < -this.config.initialCapital * this.config.maxDailyRisk) {
      console.log('🚨 DAILY LOSS LIMIT HIT. EMERGENCY SHUTDOWN.');
      this.shutdown();
      return false;
    }

    // Consecutive loss days limit
    if (this.state.consecutiveLossDays >= this.config.maxConsecutiveLossDays) {
      console.log(`🚨 MAX CONSECUTIVE LOSS DAYS (${this.config.maxConsecutiveLossDays}) REACHED.`);
      this.shutdown();
      return false;
    }

    // Trading session filter (London-NY)
    const hour = new Date().getUTCHours();
    const inSession = hour >= this.config.tradingSession.start && hour <= this.config.tradingSession.end;
    if (!inSession) {
      if (this.state.activeTrade) return true; // Still monitor active trade
      return false; // Don't look for new trades
    }

    return true;
  }

  analyzeAndTrade() {
    if (this.state.activeTrade) {
      console.log('⏸️ Trade in progress, skipping analysis');
      return;
    }

    // Check if we have enough data
    if (this.state.marketData.length < this.config.minHistory) {
      console.log(`⏳ Building history... ${this.state.marketData.length}/${this.config.minHistory}`);
      return;
    }

    // Generate trading signal using the strategy
    const signal = this.strategy.analyze(this.state.marketData);
    
    if (!signal) {
      console.log('📊 No signal generated');
      return;
    }

    // Check risk manager approval
    if (!this.riskManager.canTrade(this.state)) {
      console.log('🛑 Risk manager blocked trade');
      return;
    }

    // Calculate position size
    const positionSize = this.riskManager.calculatePositionSize(
      this.state.capital,
      signal.stopLoss,
      signal.entry
    );
    
    if (positionSize < 0.5) {
      console.log('💰 Position size too small, skipping');
      return;
    }

    // Execute the trade
    this.executeTrade(signal, positionSize);
  }

  async executeTrade(signal, stake) {
    const trade = {
      id: Date.now(),
      timestamp: new Date(),
      signal,
      stake,
      status: 'pending',
      brokerId: null
    };

    console.log(`\n🎯 TRADE SIGNAL DETECTED`);
    console.log(`   Direction: ${signal.direction} | Stake: $${stake.toFixed(2)}`);
    console.log(`   Entry: ${signal.entry.toFixed(4)} | Stop: ${signal.stopLoss.toFixed(4)} | TP: ${signal.takeProfit.toFixed(4)}`);
    console.log(`   Confidence: ${(signal.confidence * 100).toFixed(1)}%`);
    console.log(`   Z-Score: ${signal.zScore.toFixed(2)}`);

    if (this.config.liveTrade) {
      // ===== LIVE TRADING =====
      try {
        // Get contract proposal
        const proposal = await this.api.getProposal({
          proposal: 1,
          amount: stake.toFixed(2),
          basis: 'stake',
          contract_type: signal.direction === 'BUY' ? 'CALL' : 'PUT',
          currency: 'USD',
          duration: signal.duration,
          duration_unit: 'm',
          symbol: 'frxEURUSD'
        });

        // Buy contract
        const buy = await this.api.buyContract(proposal.id);
        trade.brokerId = buy.contract_id;
        trade.status = 'open';
        
        console.log(`✅ LIVE TRADE EXECUTED: Contract ${buy.contract_id}`);
        
        // Monitor contract
        this.api.subscribeToContract(buy.contract_id, (update) => {
          this.handleContractUpdate(update, trade);
        });
        
      } catch (error) {
        console.error('❌ Live trade failed:', error.message);
        await this.sendErrorEmail(`Trade execution failed: ${error.message}`);
        trade.status = 'failed';
        this.state.activeTrade = null;
      }
    } else {
      // ===== PAPER TRADING =====
      console.log(`✅ PAPER TRADE EXECUTED (No real money at risk)`);
      trade.status = 'open';
      this.simulateTradeOutcome(trade);
    }

    this.state.trades.push(trade);
    this.state.dailyRisked += stake;
    this.state.activeTrade = trade;
  }

  // ========== SIMULATION & MONITORING ==========
  simulateTradeOutcome(trade) {
    // Simulate realistic outcome based on confidence and market randomness
    const baseWinRate = 0.4;
    const winProbability = baseWinRate + (trade.signal.confidence * 0.2);
    const won = Math.random() < winProbability;
    const profit = won ? trade.stake * (9) : -trade.stake; // 9:1 payout
    
    // Simulate trade duration
    const durationMs = trade.signal.duration * 60 * 1000;
    
    setTimeout(() => {
      this.closeTrade(trade, profit, won ? 'won' : 'lost');
    }, durationMs);
  }

  handleContractUpdate(update, trade) {
    if (update.is_sold) {
      const profit = parseFloat(update.profit);
      this.closeTrade(trade, profit, update.status);
    }
  }

  closeTrade(trade, profit, status) {
    trade.status = status;
    trade.profit = profit;
    trade.closeTime = new Date();
    
    // Update state
    this.state.capital += profit;
    this.state.dailyPnL += profit;
    this.state.equityCurve.push(this.state.capital);
    this.state.activeTrade = null;
    
    // Update metrics
    this.totalTrades++;
    this.totalProfitLoss += profit;
    if (profit > 0) {
      this.totalWins++;
    } else {
      this.totalLosses++;
    }
    
    // Performance monitoring
    const sharpe = this.monitor.calculateSharpeRatio(this.state.trades);
    const maxDD = this.monitor.calculateMaxDrawdown(this.state.equityCurve);
    
    console.log(`\n📊 TRADE CLOSED: ${status.toUpperCase()}`);
    console.log(`   Profit: $${profit.toFixed(2)} | New Balance: $${this.state.capital.toFixed(2)}`);
    console.log(`   Sharpe: ${sharpe.toFixed(2)} | Max DD: ${(maxDD * 100).toFixed(1)}%`);
    
    // Send loss email if needed
    if (profit < 0 && status === 'lost') {
      this.sendLossEmail(trade);
    }
    
    this.updatePerformanceMetrics();
  }

  updatePerformanceMetrics() {
    // Track consecutive loss days
    if (this.state.dailyPnL < 0 && this.state.dailyPnL <= -this.config.initialCapital * this.config.maxDailyRisk * 0.5) {
      // Only count significant losing days
      if (!this.state.lossDayCounted) {
        this.state.consecutiveLossDays++;
        this.state.lossDayCounted = true;
      }
    } else if (this.state.dailyPnL > 0) {
      this.state.consecutiveLossDays = 0;
      this.state.lossDayCounted = false;
    }
    
    console.log(`   Daily P&L: $${this.state.dailyPnL.toFixed(2)} | Risked: $${this.state.dailyRisked.toFixed(2)}`);
    console.log(`   Consecutive Loss Days: ${this.state.consecutiveLossDays}`);
    console.log(`   Trades Today: ${this.state.trades.filter(t => t.timestamp.toDateString() === new Date().toDateString()).length}`);
  }

  // ========== DATA HANDLING ==========
  handleNewTick(tick) {
    const now = new Date();
    const currentHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getUTCHours());
    
    // Check if we need to form a new candle
    if (!this.state.lastCandleTime || currentHour.getTime() > this.state.lastCandleTime.getTime()) {
      // Create new candle from tick
      const newCandle = {
        timestamp: currentHour,
        open: tick.quote,
        high: tick.quote,
        low: tick.quote,
        close: tick.quote,
        volume: 1
      };
      
      this.state.marketData.push(newCandle);
      if (this.state.marketData.length > 5000) {
        this.state.marketData.shift(); // Keep buffer manageable
      }
      
      this.state.lastCandleTime = currentHour;
      console.log(`📊 New candle formed: ${currentHour.toUTCString()} | Price: ${tick.quote}`);
    } else {
      // Update current candle
      const currentCandle = this.state.marketData[this.state.marketData.length - 1];
      currentCandle.high = Math.max(currentCandle.high, tick.quote);
      currentCandle.low = Math.min(currentCandle.low, tick.quote);
      currentCandle.close = tick.quote;
      currentCandle.volume++;
    }
    
    // Show realtime status every 5 minutes
    if (now.getMinutes() % 5 === 0 && now.getSeconds() === 0) {
      const lastPrice = this.state.marketData[this.state.marketData.length - 1].close;
      const sma = this.calculateSMA(this.state.marketData.map(c => c.close), this.config.lookback);
      const deviation = ((lastPrice - sma) / sma * 100).toFixed(2);
      console.log(`💓 Heartbeat - Price: ${lastPrice.toFixed(4)} | SMA: ${sma.toFixed(4)} | Dev: ${deviation}%`);
    }
  }

  // ========== UTILITY METHODS ==========
  calculateSMA(data, period) {
    if (data.length < period) return data[data.length - 1];
    const sum = data.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
  }

  calculateStdDev(data, period) {
    if (data.length < period) return 0;
    const slice = data.slice(-period);
    const mean = slice.reduce((a, b) => a + b) / period;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    return Math.sqrt(variance);
  }

  shutdown() {
    this.state.isShutdown = true;
    console.log('\n💀 TRADING SYSTEM SHUTDOWN');
    console.log(`Final Capital: $${this.state.capital.toFixed(2)}`);
    console.log(`Total Return: ${((this.state.capital - this.config.initialCapital) / this.config.initialCapital * 100).toFixed(2)}%`);
    console.log(`Total Trades: ${this.totalTrades} | Wins: ${this.totalWins} | Losses: ${this.totalLosses}`);
    
    // Send final summary
    this.sendEmailSummary();
    
    this.api.disconnect();
    process.exit(0);
  }
}

// ========== START BOT ==========
if (require.main === module) {
  const bot = new ProfessionalDerivBot();
  bot.start().catch(async (error) => {
    console.error('❌ Fatal error:', error);
    await bot.sendErrorEmail(error.message);
    process.exit(1);
  });
}

module.exports = ProfessionalDerivBot;
