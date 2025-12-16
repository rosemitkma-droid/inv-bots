require('dotenv').config();
const nodemailer = require('nodemailer');
const DataPipeline = require('./DataPipeline');
const DerivAPI = require('./DerivAPI2');

class ProfessionalDerivBot {
  constructor() {
    // ========== CONFIGURATION ==========
    this.config = {
      // Account Settings
      token: process.env.DERIV_TOKEN,
      liveTrade: 'true', // Default False
      
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
      tradingSession: { start: 7, end: 17 }, // UTC (London-NY)
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
      activeTrade: null
    };

    // ========== COMPONENTS ==========
    this.api = new DerivAPI(this.config.token);
    this.data = new DataPipeline();
    
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
      this.sendEmailSummary();
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
    ===============================
   
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
      const { data, quality } = await this.data.loadEURUSD();
      console.log(`✅ Loaded ${data.length} candles | Quality: ${(quality * 100).toFixed(1)}%`);
      
      this.state.marketData = data.slice(-this.config.minHistory);
      
      console.log('\n📈 Phase 2: Starting Live Feed...');
      await this.connectAndTrade();
      
    } catch (error) {
      console.error('❌ Fatal Error:', error.message);
      process.exit(1);
    }
  }

  async connectAndTrade() {
    await this.api.connect();
    await this.api.authorize();

    // Subscribe to EUR/USD ticks
    this.api.subscribeToTicks('frxEURUSD', (tick) => {
      this.handleNewTick(tick);
    });

    // Check for trading opportunities every hour
    setInterval(() => {
      if (this.canTrade()) {
        this.analyzeAndTrade();
      }
    }, 60000); // Check every minute
  }

  // ========== TRADING LOGIC ==========
  canTrade() {
    // Reset daily counter
    const today = new Date().toDateString();
    if (today !== this.state.lastReset) {
      this.state.dailyPnL = 0;
      this.state.dailyRisked = 0;
      this.state.lastReset = today;
    }

    // Shutdown conditions
    if (this.state.isShutdown) return false;
    
    if (this.state.dailyPnL < -this.config.initialCapital * this.config.maxDailyRisk) {
      console.log('🚨 DAILY LOSS LIMIT HIT. SHUTTING DOWN.');
      this.shutdown();
      return false;
    }

    if (this.state.consecutiveLossDays >= this.config.maxConsecutiveLossDays) {
      console.log('🚨 MAX CONSECUTIVE LOSS DAYS REACHED.');
      this.shutdown();
      return false;
    }

    // Session filter
    const hour = new Date().getUTCHours();
    const inSession = hour >= this.config.tradingSession.start && hour <= this.config.tradingSession.end;
    if (!inSession) {
      console.log('⏸️ Outside trading session...');
      return false;
    }

    return true;
  }

  analyzeAndTrade() {
    if (this.state.activeTrade) return; // One trade at a time

    const signal = this.generateSignal(this.state.marketData);
    if (!signal) return;

    const positionSize = this.calculatePositionSize(signal);
    this.executeTrade(signal, positionSize);
  }

  generateSignal(data) {
    if (data.length < this.config.lookback + 10) return null;

    const closes = data.map(c => c.close);
    const current = closes[closes.length - 1];
    
    const sma = this.calculateSMA(closes, this.config.lookback);
    const stdDev = this.calculateStdDev(closes, this.config.lookback);
    const zScore = (current - sma) / stdDev;

    // Extreme deviation detected
    if (Math.abs(zScore) > this.config.entryThreshold) {
      return {
        direction: zScore > 0 ? 'PUT' : 'CALL', // PUT = price down, CALL = price up
        entry: current,
        confidence: Math.min(Math.abs(zScore) / 4, 1),
        duration: 60 // 1 hour contract
      };
    }
    return null;
  }

  calculatePositionSize(signal) {
    const dollarRisk = this.state.capital * this.config.maxTradeRisk;
    const positionSize = dollarRisk * signal.confidence;
    
    // Demo account limit: never risk more than $100
    return Math.min(positionSize, 100);
  }

  async executeTrade(signal, stake) {
    const trade = {
      id: Date.now(),
      signal,
      stake,
      status: 'pending',
      brokerId: null
    };

    console.log(`\n🎯 TRADE SIGNAL DETECTED`);
    console.log(`   Direction: ${signal.direction} | Stake: $${stake.toFixed(2)}`);
    console.log(`   Confidence: ${(signal.confidence * 100).toFixed(1)}%`);

    if (this.config.liveTrade) {
      // ===== LIVE TRADING (Uncomment after validation) =====
      try {
        const proposal = await this.api.getProposal({
          proposal: 1,
          amount: stake,
          basis: 'stake',
          contract_type: signal.direction,
          currency: 'USD',
          duration: signal.duration,
          duration_unit: 'm',
          symbol: 'frxEURUSD'
        });

        const buy = await this.api.buyContract(proposal.id);
        trade.brokerId = buy.contract_id;
        trade.status = 'open';
        
        console.log(`✅ LIVE TRADE EXECUTED: Contract ${buy.contract_id}`);
        this.api.subscribeToContract(buy.contract_id, (update) => this.handleContractUpdate(update, trade));
        
      } catch (error) {
        console.error('❌ Live trade failed:', error.message);
        trade.status = 'failed';
      }
    } else {
      // ===== PAPER TRADING =====
      console.log('✅ PAPER TRADE EXECUTED');
      trade.status = 'open';
      this.simulateTradeOutcome(trade);
    }

    this.state.trades.push(trade);
    this.state.dailyRisked += stake;
    this.state.activeTrade = trade;
  }

  // ========== SIMULATION & MONITORING ==========
  simulateTradeOutcome(trade) {
    // Simulate realistic outcome based on confidence
    const winProbability = trade.signal.confidence * 0.5 + 0.3; // 30-80% win rate
    const won = Math.random() < winProbability;
    const profit = won ? trade.stake * 8 : -trade.stake; // 9:1 payout
    
    setTimeout(() => {
      this.closeTrade(trade, profit, won ? 'won' : 'lost');
    }, trade.signal.duration * 60 * 1000);
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
    
    this.state.capital += profit;
    this.state.dailyPnL += profit;
    this.state.equityCurve.push(this.state.capital);
    this.state.activeTrade = null;
    
    // Update trade metrics
    this.totalTrades++;
    this.totalProfitLoss += profit;
    if (profit > 0) {
      this.totalWins++;
    } else {
      this.totalLosses++;
    }
    
    console.log(`\n📊 TRADE CLOSED: ${status.toUpperCase()}`);
    console.log(`   Profit: $${profit.toFixed(2)} | New Balance: $${this.state.capital.toFixed(2)}`);
    
    // Send loss alert email if trade resulted in a loss
    if (profit < 0) {
      this.sendLossEmail(trade);
    }
    
    this.updatePerformanceMetrics();
  }

  updatePerformanceMetrics() {
    if (this.state.dailyPnL < 0) {
      this.state.consecutiveLossDays++;
    } else {
      this.state.consecutiveLossDays = 0;
    }
    
    console.log(`   Daily P&L: $${this.state.dailyPnL.toFixed(2)}`);
    console.log(`   Consecutive Loss Days: ${this.state.consecutiveLossDays}`);
  }

  // ========== UTILITY METHODS ==========
  calculateSMA(data, period) {
    const sum = data.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
  }

  calculateStdDev(data, period) {
    const slice = data.slice(-period);
    const mean = slice.reduce((a, b) => a + b) / period;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    return Math.sqrt(variance);
  }

  isTradingSession() {
    const hour = new Date().getUTCHours();
    return hour >= 7 && hour <= 17;
  }

  handleNewTick(tick) {
    // Update market data with new tick
    console.log(`📡 New tick: ${tick.quote}`);
    // console.log(`Mode: ${this.config.liveTrade ? '🔴 LIVE TRADING': '✅ PAPER TRADING'}`);
  }

  shutdown() {
    this.state.isShutdown = true;
    console.log('\n💀 SYSTEM SHUTDOWN COMPLETE');
    console.log(`Final Capital: $${this.state.capital.toFixed(2)}`);
    console.log(`Total Return: ${((this.state.capital - this.config.initialCapital) / this.config.initialCapital * 100).toFixed(2)}%`);
    process.exit(0);
  }
}

// ========== START BOT ==========
if (require.main === module) {
  const bot = new ProfessionalDerivBot();
  bot.start().catch(console.error);
}

module.exports = ProfessionalDerivBot;
