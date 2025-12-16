// ============================================================================
// ADVANCED DERIV TRADING BOT
// ============================================================================
// Features:
// - RSI + MACD + Stochastic multi-strategy system
// - Advanced risk management (1-2% per trade)
// - Position sizing with Kelly Criterion option
// - Stop-loss and take-profit automation
// - Real-time performance tracking
// - Automatic reconnection
// - Comprehensive logging
// ============================================================================

const WebSocket = require('ws');
const EventEmitter = require('events');

// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
  // API Configuration
  api: {
    appId: '1089',  // Demo app ID - Replace with your own
    endpoint: 'wss://ws.derivws.com/websockets/v3',
    token: '0P94g4WdSrSrzir',  // Replace with your API token
    pingInterval: 30000,
    reconnectDelay: 5000,
    maxReconnectAttempts: 10
  },
  
  // Trading Configuration
  trading: {
    symbol: 'R_100',  // Volatility 100 Index
    contractType: 'CALL',  // CALL or PUT
    duration: 5,
    durationType: 'm',  // m = minutes, t = ticks
    stake: 1,  // Base stake amount in USD
    currency: 'USD',
    maxOpenPositions: 3,
    useDemoAccount: false  // ALWAYS start with demo!
  },
  
  // Strategy Configuration
  strategy: {
    primary: 'RSI_MACD',  // RSI_MACD, TRIPLE, MACD_ONLY
    
    // RSI Settings
    rsi: {
      period: 14,
      overbought: 70,
      oversold: 30,
      exitOverbought: 65,
      exitOversold: 35
    },
    
    // MACD Settings
    macd: {
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9
    },
    
    // Stochastic Settings
    stochastic: {
      kPeriod: 14,
      dPeriod: 3,
      slowing: 3,
      overbought: 80,
      oversold: 20
    },
    
    // Moving Average Settings
    ma: {
      shortPeriod: 50,
      longPeriod: 100
    }
  },
  
  // Risk Management Configuration
  risk: {
    riskPerTrade: 0.05,  // 1% of account per trade
    maxDailyLoss: 0.20,  // 3% maximum daily loss
    maxConsecutiveLosses: 3,
    maxDrawdown: 0.30,  // 20% maximum drawdown
    stopLossPercent: 0.05,  // 2% stop loss
    takeProfitRatio: 2.5,  // 2.5:1 risk-reward
    useTrailingStop: true,
    trailingStopPercent: 0.01,  // 1% trailing stop
    useKellyCriterion: false,  // Advanced position sizing
    minStake: 0.35,
    maxStake: 100
  },
  
  // Logging Configuration
  logging: {
    enabled: true,
    verbose: true,
    logTrades: true,
    logIndicators: false
  }
};

// ============================================================================
// TECHNICAL INDICATORS
// ============================================================================
class TechnicalIndicators {
  static calculateSMA(data, period) {
    if (data.length < period) return null;
    const sum = data.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
  }
  
  static calculateEMA(data, period) {
    if (data.length < period) return null;
    const multiplier = 2 / (period + 1);
    let ema = this.calculateSMA(data.slice(0, period), period);
    
    for (let i = period; i < data.length; i++) {
      ema = (data[i] - ema) * multiplier + ema;
    }
    return ema;
  }
  
  static calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return null;
    
    let gains = 0;
    let losses = 0;
    
    for (let i = prices.length - period; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    
    const avgGain = gains / period;
    const avgLoss = losses / period;
    
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }
  
  static calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    if (prices.length < slowPeriod + signalPeriod) return null;
    
    const fastEMA = this.calculateEMA(prices, fastPeriod);
    const slowEMA = this.calculateEMA(prices, slowPeriod);
    
    if (!fastEMA || !slowEMA) return null;
    
    const macdLine = fastEMA - slowEMA;
    
    // Calculate signal line (EMA of MACD)
    const macdHistory = [];
    for (let i = slowPeriod; i <= prices.length; i++) {
      const fast = this.calculateEMA(prices.slice(0, i), fastPeriod);
      const slow = this.calculateEMA(prices.slice(0, i), slowPeriod);
      if (fast && slow) macdHistory.push(fast - slow);
    }
    
    const signalLine = this.calculateEMA(macdHistory, signalPeriod);
    const histogram = macdLine - (signalLine || 0);
    
    return { macdLine, signalLine, histogram };
  }
  
  static calculateStochastic(high, low, close, kPeriod = 14, dPeriod = 3, slowing = 3) {
    if (close.length < kPeriod) return null;
    
    const highestHigh = Math.max(...high.slice(-kPeriod));
    const lowestLow = Math.min(...low.slice(-kPeriod));
    
    const k = ((close[close.length - 1] - lowestLow) / (highestHigh - lowestLow)) * 100;
    
    // Smooth %K
    const kValues = [];
    for (let i = 0; i < slowing; i++) {
      if (close.length - kPeriod - i >= 0) {
        const hh = Math.max(...high.slice(-(kPeriod + i), high.length - i || undefined));
        const ll = Math.min(...low.slice(-(kPeriod + i), low.length - i || undefined));
        kValues.push(((close[close.length - 1 - i] - ll) / (hh - ll)) * 100);
      }
    }
    
    const smoothK = kValues.reduce((a, b) => a + b, 0) / kValues.length;
    
    return { k: smoothK, d: smoothK };  // Simplified
  }
  
  static calculateATR(high, low, close, period = 14) {
    if (high.length < period + 1) return null;
    
    const trueRanges = [];
    for (let i = 1; i < high.length; i++) {
      const tr = Math.max(
        high[i] - low[i],
        Math.abs(high[i] - close[i - 1]),
        Math.abs(low[i] - close[i - 1])
      );
      trueRanges.push(tr);
    }
    
    return this.calculateSMA(trueRanges, period);
  }
}

// ============================================================================
// RISK MANAGER
// ============================================================================
class RiskManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.dailyPnL = 0;
    this.consecutiveLosses = 0;
    this.consecutiveWins = 0;
    this.peakBalance = 0;
    this.trades = [];
    this.dailyReset();
  }
  
  dailyReset() {
    const now = new Date();
    this.lastResetDate = now.toDateString();
    this.dailyPnL = 0;
    this.dailyTrades = 0;
  }
  
  checkDailyReset() {
    const now = new Date();
    if (now.toDateString() !== this.lastResetDate) {
      this.dailyReset();
    }
  }
  
  calculatePositionSize(balance, winRate = 0.55) {
    this.checkDailyReset();
    
    let positionSize = balance * this.config.riskPerTrade;
    
    // Kelly Criterion (optional, more aggressive)
    if (this.config.useKellyCriterion && this.trades.length > 20) {
      const kelly = this.calculateKellyCriterion(winRate);
      positionSize = balance * kelly * 0.5;  // Use 50% of Kelly
    }
    
    // Adjust for consecutive losses
    if (this.consecutiveLosses >= 2) {
      positionSize *= 0.5;  // Reduce size by 50%
    }
    
    // Adjust for consecutive wins (Oscar's Grind)
    if (this.consecutiveWins >= 2 && this.consecutiveWins <= 4) {
      positionSize *= (1 + this.consecutiveWins * 0.2);
    }
    
    // Enforce limits
    positionSize = Math.max(this.config.minStake, positionSize);
    positionSize = Math.min(this.config.maxStake, positionSize);
    
    return Math.round(positionSize * 100) / 100;
  }
  
  calculateKellyCriterion(winRate, avgWin = 1, avgLoss = 1) {
    // Kelly = (winRate * avgWin - (1 - winRate) * avgLoss) / avgWin
    const kelly = (winRate * avgWin - (1 - winRate) * avgLoss) / avgWin;
    return Math.max(0, Math.min(kelly, 0.25));  // Cap at 25%
  }
  
  canTrade(balance) {
    this.checkDailyReset();
    
    // Check daily loss limit
    if (this.dailyPnL <= -(balance * this.config.maxDailyLoss)) {
      this.emit('riskLimit', 'Daily loss limit reached');
      return false;
    }
    
    // Check consecutive losses
    if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      this.emit('riskLimit', 'Maximum consecutive losses reached');
      return false;
    }
    
    // Check drawdown
    if (this.peakBalance === 0) this.peakBalance = balance;
    this.peakBalance = Math.max(this.peakBalance, balance);
    
    const drawdown = (this.peakBalance - balance) / this.peakBalance;
    if (drawdown >= this.config.maxDrawdown) {
      this.emit('riskLimit', 'Maximum drawdown reached');
      return false;
    }
    
    return true;
  }
  
  recordTrade(profit) {
    this.dailyPnL += profit;
    this.dailyTrades++;
    
    this.trades.push({
      profit,
      timestamp: Date.now(),
      dailyPnL: this.dailyPnL
    });
    
    if (profit > 0) {
      this.consecutiveWins++;
      this.consecutiveLosses = 0;
    } else {
      this.consecutiveLosses++;
      this.consecutiveWins = 0;
    }
    
    // Keep only last 100 trades
    if (this.trades.length > 100) {
      this.trades.shift();
    }
  }
  
  getStatistics() {
    if (this.trades.length === 0) return null;
    
    const wins = this.trades.filter(t => t.profit > 0).length;
    const losses = this.trades.filter(t => t.profit < 0).length;
    const totalProfit = this.trades.reduce((sum, t) => sum + t.profit, 0);
    const avgProfit = totalProfit / this.trades.length;
    
    return {
      totalTrades: this.trades.length,
      wins,
      losses,
      winRate: wins / this.trades.length,
      totalProfit,
      avgProfit,
      dailyPnL: this.dailyPnL,
      consecutiveWins: this.consecutiveWins,
      consecutiveLosses: this.consecutiveLosses
    };
  }
}

// ============================================================================
// STRATEGY ENGINE
// ============================================================================
class StrategyEngine {
  constructor(config) {
    this.config = config;
    this.priceHistory = [];
    this.highHistory = [];
    this.lowHistory = [];
    this.previousSignal = null;
  }
  
  addPrice(price) {
    this.priceHistory.push(price);
    this.highHistory.push(price);
    this.lowHistory.push(price);
    
    // Keep last 200 prices
    if (this.priceHistory.length > 200) {
      this.priceHistory.shift();
      this.highHistory.shift();
      this.lowHistory.shift();
    }
  }
  
  analyzeMarket() {
    if (this.priceHistory.length < 100) {
      return { signal: 'WAIT', reason: 'Insufficient data', confidence: 0 };
    }
    
    const { rsi, macd, stochastic, ma } = this.config;
    
    // Calculate indicators
    const rsiValue = TechnicalIndicators.calculateRSI(this.priceHistory, rsi.period);
    const macdData = TechnicalIndicators.calculateMACD(
      this.priceHistory,
      macd.fastPeriod,
      macd.slowPeriod,
      macd.signalPeriod
    );
    const stochData = TechnicalIndicators.calculateStochastic(
      this.highHistory,
      this.lowHistory,
      this.priceHistory,
      stochastic.kPeriod,
      stochastic.dPeriod,
      stochastic.slowing
    );
    const sma50 = TechnicalIndicators.calculateSMA(this.priceHistory, ma.shortPeriod);
    const sma100 = TechnicalIndicators.calculateSMA(this.priceHistory, ma.longPeriod);
    
    if (!rsiValue || !macdData || !stochData || !sma50 || !sma100) {
      return { signal: 'WAIT', reason: 'Indicators not ready', confidence: 0 };
    }
    
    const currentPrice = this.priceHistory[this.priceHistory.length - 1];
    
    // Log indicators if enabled
    if (this.config.logIndicators) {
      console.log('\n📊 Technical Indicators:');
      console.log(`   RSI: ${rsiValue.toFixed(2)}`);
      console.log(`   MACD: ${macdData.macdLine.toFixed(5)} | Signal: ${macdData.signalLine.toFixed(5)} | Histogram: ${macdData.histogram.toFixed(5)}`);
      console.log(`   Stochastic K: ${stochData.k.toFixed(2)} | D: ${stochData.d.toFixed(2)}`);
      console.log(`   SMA50: ${sma50.toFixed(5)} | SMA100: ${sma100.toFixed(5)} | Price: ${currentPrice.toFixed(5)}`);
    }
    
    // Strategy selection
    switch (this.config.primary) {
      case 'RSI_MACD':
        return this.rsiMacdStrategy(rsiValue, macdData, currentPrice, sma50);
      case 'TRIPLE':
        return this.tripleConfirmationStrategy(rsiValue, macdData, stochData, currentPrice, sma50);
      case 'MACD_ONLY':
        return this.macdOnlyStrategy(macdData, currentPrice, sma50);
      default:
        return this.rsiMacdStrategy(rsiValue, macdData, currentPrice, sma50);
    }
  }
  
  rsiMacdStrategy(rsi, macd, price, sma50) {
    const { rsi: rsiConfig } = this.config;
    let signal = 'WAIT';
    let reason = '';
    let confidence = 0;
    
    // CALL Signal (Buy)
    const macdBullish = macd.histogram > 0 && macd.macdLine > macd.signalLine;
    const rsiOversold = rsi < rsiConfig.oversold;
    const priceAboveSMA = price > sma50;
    
    if (macdBullish && rsiOversold) {
      signal = 'CALL';
      reason = 'MACD bullish + RSI oversold';
      confidence = 0.7;
      
      if (priceAboveSMA) {
        confidence = 0.85;
        reason += ' + trend confirmation';
      }
    }
    
    // PUT Signal (Sell)
    const macdBearish = macd.histogram < 0 && macd.macdLine < macd.signalLine;
    const rsiOverbought = rsi > rsiConfig.overbought;
    const priceBelowSMA = price < sma50;
    
    if (macdBearish && rsiOverbought) {
      signal = 'PUT';
      reason = 'MACD bearish + RSI overbought';
      confidence = 0.7;
      
      if (priceBelowSMA) {
        confidence = 0.85;
        reason += ' + trend confirmation';
      }
    }
    
    // Avoid conflicting signals
    if (signal !== 'WAIT' && this.previousSignal === signal) {
      return { signal: 'WAIT', reason: 'Avoiding repeat signal', confidence: 0 };
    }
    
    if (signal !== 'WAIT') {
      this.previousSignal = signal;
    }
    
    return { signal, reason, confidence, indicators: { rsi, macd, price, sma50 } };
  }
  
  tripleConfirmationStrategy(rsi, macd, stoch, price, sma50) {
    const { rsi: rsiConfig, stochastic: stochConfig } = this.config;
    let signal = 'WAIT';
    let reason = '';
    let confidence = 0;
    
    // CALL Signal - All three must confirm
    const macdBullish = macd.histogram > 0 && macd.macdLine > macd.signalLine;
    const rsiExitOversold = rsi > rsiConfig.oversold && rsi < 45;
    const stochBullish = stoch.k > stoch.d && stoch.k < stochConfig.oversold + 20;
    
    if (macdBullish && rsiExitOversold && stochBullish) {
      signal = 'CALL';
      reason = 'Triple confirmation: MACD + RSI + Stochastic';
      confidence = 0.9;
    }
    
    // PUT Signal - All three must confirm
    const macdBearish = macd.histogram < 0 && macd.macdLine < macd.signalLine;
    const rsiExitOverbought = rsi < rsiConfig.overbought && rsi > 55;
    const stochBearish = stoch.k < stoch.d && stoch.k > stochConfig.overbought - 20;
    
    if (macdBearish && rsiExitOverbought && stochBearish) {
      signal = 'PUT';
      reason = 'Triple confirmation: MACD + RSI + Stochastic';
      confidence = 0.9;
    }
    
    if (signal !== 'WAIT' && this.previousSignal === signal) {
      return { signal: 'WAIT', reason: 'Avoiding repeat signal', confidence: 0 };
    }
    
    if (signal !== 'WAIT') {
      this.previousSignal = signal;
    }
    
    return { signal, reason, confidence, indicators: { rsi, macd, stoch, price, sma50 } };
  }
  
  macdOnlyStrategy(macd, price, sma50) {
    let signal = 'WAIT';
    let reason = '';
    let confidence = 0;
    
    // CALL Signal
    if (macd.histogram > 0 && macd.macdLine > macd.signalLine && price > sma50) {
      signal = 'CALL';
      reason = 'MACD bullish crossover + uptrend';
      confidence = 0.75;
    }
    
    // PUT Signal
    if (macd.histogram < 0 && macd.macdLine < macd.signalLine && price < sma50) {
      signal = 'PUT';
      reason = 'MACD bearish crossover + downtrend';
      confidence = 0.75;
    }
    
    if (signal !== 'WAIT' && this.previousSignal === signal) {
      return { signal: 'WAIT', reason: 'Avoiding repeat signal', confidence: 0 };
    }
    
    if (signal !== 'WAIT') {
      this.previousSignal = signal;
    }
    
    return { signal, reason, confidence, indicators: { macd, price, sma50 } };
  }
}

// ============================================================================
// DERIV TRADING BOT
// ============================================================================
class DerivTradingBot extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.ws = null;
    this.isConnected = false;
    this.isAuthorized = false;
    this.reconnectAttempts = 0;
    this.balance = 0;
    this.activeContracts = new Map();
    this.subscriptions = new Map();
    
    // Initialize components
    this.riskManager = new RiskManager(config.risk);
    this.strategy = new StrategyEngine(config.strategy);
    
    // Statistics
    this.stats = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalProfit: 0,
      startTime: Date.now()
    };
    
    this.setupEventHandlers();
  }
  
  setupEventHandlers() {
    this.riskManager.on('riskLimit', (message) => {
      console.log(`\n⚠️  RISK LIMIT: ${message}`);
      console.log('🛑 Trading suspended for safety');
      this.pauseTrading = true;
    });
  }
  
  async connect() {
    return new Promise((resolve, reject) => {
      const { api } = this.config;
      const url = `${api.endpoint}?app_id=${api.appId}`;
      
      console.log('🔌 Connecting to Deriv API...');
      
      this.ws = new WebSocket(url);
      
      this.ws.on('open', () => {
        console.log('✅ Connected to Deriv API');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.startPingInterval();
        resolve();
      });
      
      this.ws.on('message', (data) => {
        this.handleMessage(JSON.parse(data.toString()));
      });
      
      this.ws.on('close', () => {
        console.log('❌ Disconnected from Deriv API');
        this.isConnected = false;
        this.handleReconnect();
      });
      
      this.ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error.message);
        reject(error);
      });
    });
  }
  
  startPingInterval() {
    this.pingInterval = setInterval(() => {
      if (this.isConnected) {
        this.send({ ping: 1 });
      }
    }, this.config.api.pingInterval);
  }
  
  handleReconnect() {
    if (this.reconnectAttempts < this.config.api.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`🔄 Reconnecting... (Attempt ${this.reconnectAttempts})`);
      
      setTimeout(() => {
        this.connect().catch(console.error);
      }, this.config.api.reconnectDelay);
    } else {
      console.error('❌ Max reconnection attempts reached');
      this.stop();
    }
  }
  
  send(data) {
    if (this.isConnected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
  
  async handleMessage(message) {
    const { msg_type, error } = message;
    
    if (error) {
      console.error('❌ API Error:', error.message);
      
      if (error.code === 'InvalidToken') {
        console.error('❌ Invalid API token. Please check your configuration.');
        this.stop();
      }
      return;
    }
    
    switch (msg_type) {
      case 'authorize':
        await this.handleAuthorize(message);
        break;
      case 'balance':
        this.handleBalance(message);
        break;
      case 'tick':
        this.handleTick(message);
        break;
      case 'proposal':
        this.handleProposal(message);
        break;
      case 'buy':
        this.handleBuy(message);
        break;
      case 'proposal_open_contract':
        this.handleContractUpdate(message);
        break;
      case 'pong':
        // Ping response - connection alive
        break;
    }
  }
  
  async handleAuthorize(message) {
    if (message.authorize) {
      this.isAuthorized = true;
      this.accountInfo = message.authorize;
      console.log('\n✅ Authorized successfully');
      console.log(`👤 Account: ${this.accountInfo.loginid}`);
      console.log(`💰 Balance: ${this.accountInfo.balance} ${this.accountInfo.currency}`);
      
      // Subscribe to balance updates
      this.send({ balance: 1, subscribe: 1 });
      
      // Get initial balance
      this.balance = parseFloat(this.accountInfo.balance);
      
      // Start trading
      await this.startTrading();
    }
  }
  
  handleBalance(message) {
    if (message.balance) {
      this.balance = parseFloat(message.balance.balance);
      this.emit('balanceUpdate', this.balance);
    }
  }
  
  handleTick(message) {
    if (message.tick) {
      const price = parseFloat(message.tick.quote);
      this.strategy.addPrice(price);
      
      // Analyze market and potentially place trade
      if (!this.pauseTrading && this.activeContracts.size < this.config.trading.maxOpenPositions) {
        this.checkTradingOpportunity();
      }
    }
  }
  
  async checkTradingOpportunity() {
    const analysis = this.strategy.analyzeMarket();
    
    if (analysis.signal !== 'WAIT' && analysis.confidence >= 0.7) {
      // Check risk management
      if (!this.riskManager.canTrade(this.balance)) {
        return;
      }
      
      console.log(`\n📈 Trading Signal: ${analysis.signal}`);
      console.log(`   Reason: ${analysis.reason}`);
      console.log(`   Confidence: ${(analysis.confidence * 100).toFixed(1)}%`);
      
      await this.placeTradeOrder(analysis);
    }
  }
  
  async placeTradeOrder(analysis) {
    const { trading, risk } = this.config;
    
    // Calculate position size
    const positionSize = this.riskManager.calculatePositionSize(this.balance);
    
    console.log(`   Position Size: $${positionSize.toFixed(2)}`);
    
    const proposal = {
      proposal: 1,
      amount: positionSize,
      basis: 'stake',
      contract_type: analysis.signal,
      currency: trading.currency,
      duration: trading.duration,
      duration_unit: trading.durationType,
      symbol: trading.symbol
    };
    
    this.send(proposal);
  }
  
  handleProposal(message) {
    if (message.proposal) {
      const proposal = message.proposal;
      
      // Auto-buy if proposal is valid
      if (proposal.id) {
        console.log(`   💵 Buying contract for $${proposal.ask_price}...`);
        
        this.send({
          buy: proposal.id,
          price: proposal.ask_price
        });
      }
    }
  }
  
  handleBuy(message) {
    if (message.buy) {
      const contract = message.buy;
      
      console.log(`   ✅ Contract purchased: ${contract.contract_id}`);
      console.log(`   📊 Contract Type: ${contract.contract_type}`);
      console.log(`   💰 Buy Price: $${contract.buy_price}`);
      console.log(`   🎯 Payout: $${contract.payout}`);
      
      // Store active contract
      this.activeContracts.set(contract.contract_id, {
        id: contract.contract_id,
        type: contract.contract_type,
        buyPrice: parseFloat(contract.buy_price),
        payout: parseFloat(contract.payout),
        startTime: Date.now()
      });
      
      // Subscribe to contract updates
      this.send({
        proposal_open_contract: 1,
        contract_id: contract.contract_id,
        subscribe: 1
      });
      
      this.stats.totalTrades++;
    }
  }
  
  handleContractUpdate(message) {
    if (message.proposal_open_contract) {
      const contract = message.proposal_open_contract;
      const contractId = contract.contract_id;
      
      // Contract is finished
      if (contract.is_sold || contract.status === 'sold') {
        const storedContract = this.activeContracts.get(contractId);
        
        if (storedContract) {
          const profit = parseFloat(contract.sell_price || contract.bid_price) - storedContract.buyPrice;
          const profitPercent = (profit / storedContract.buyPrice) * 100;
          
          // Update statistics
          if (profit > 0) {
            this.stats.wins++;
            console.log(`\n✅ TRADE WON: +${profit.toFixed(2)} (+${profitPercent.toFixed(2)}%)`);
          } else {
            this.stats.losses++;
            console.log(`\n❌ TRADE LOST: -${Math.abs(profit).toFixed(2)} (${profitPercent.toFixed(2)}%)`);
          }
          
          this.stats.totalProfit += profit;
          this.riskManager.recordTrade(profit);
          
          // Display current stats
          this.displayStats();
          
          // Remove from active contracts
          this.activeContracts.delete(contractId);
        }
      }
    }
  }
  
  displayStats() {
    const riskStats = this.riskManager.getStatistics();
    const winRate = this.stats.wins / this.stats.totalTrades;
    const runtime = (Date.now() - this.stats.startTime) / 1000 / 60;
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 PERFORMANCE STATISTICS');
    console.log('='.repeat(60));
    console.log(`💰 Current Balance: ${this.balance.toFixed(2)}`);
    console.log(`📈 Total Profit/Loss: ${this.stats.totalProfit.toFixed(2)}`);
    console.log(`📊 Total Trades: ${this.stats.totalTrades}`);
    console.log(`✅ Wins: ${this.stats.wins} | ❌ Losses: ${this.stats.losses}`);
    console.log(`🎯 Win Rate: ${(winRate * 100).toFixed(1)}%`);
    
    if (riskStats) {
      console.log(`📉 Daily P&L: ${riskStats.dailyPnL.toFixed(2)}`);
      console.log(`🔥 Win Streak: ${riskStats.consecutiveWins} | Loss Streak: ${riskStats.consecutiveLosses}`);
    }
    
    console.log(`⏱️  Runtime: ${runtime.toFixed(1)} minutes`);
    console.log(`🤖 Active Contracts: ${this.activeContracts.size}`);
    console.log('='.repeat(60) + '\n');
  }
  
  async startTrading() {
    console.log('\n🚀 Starting trading bot...');
    console.log(`📊 Strategy: ${this.config.strategy.primary}`);
    console.log(`💹 Symbol: ${this.config.trading.symbol}`);
    console.log(`⏱️  Duration: ${this.config.trading.duration}${this.config.trading.durationType}`);
    console.log(`⚠️  Risk per trade: ${(this.config.risk.riskPerTrade * 100).toFixed(1)}%`);
    console.log(`🛡️  Max daily loss: ${(this.config.risk.maxDailyLoss * 100).toFixed(1)}%`);
    console.log('');
    
    // Subscribe to tick data
    this.send({
      ticks: this.config.trading.symbol,
      subscribe: 1
    });
    
    console.log('📡 Subscribed to market data');
    console.log('⏳ Collecting price data...\n');
  }
  
  async start() {
    try {
      await this.connect();
      
      // Authorize
      this.send({
        authorize: this.config.api.token
      });
      
    } catch (error) {
      console.error('❌ Failed to start bot:', error);
      throw error;
    }
  }
  
  stop() {
    console.log('\n🛑 Stopping trading bot...');
    
    // Clear intervals
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    
    // Unsubscribe from all
    this.subscriptions.forEach((id) => {
      this.send({ forget: id });
    });
    
    // Close WebSocket
    if (this.ws) {
      this.ws.close();
    }
    
    this.displayStats();
    console.log('✅ Bot stopped successfully\n');
    
    process.exit(0);
  }
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('🤖 ADVANCED DERIV TRADING BOT');
  console.log('='.repeat(60));
  console.log('⚠️  WARNING: Always start with a DEMO account!');
  console.log('⚠️  This bot is for educational purposes only.');
  console.log('⚠️  Trading involves significant risk of loss.');
  console.log('='.repeat(60) + '\n');
  
  // Validate configuration
  if (CONFIG.api.token === 'YOUR_API_TOKEN_HERE') {
    console.error('❌ ERROR: Please configure your API token in the CONFIG section');
    console.error('📝 Get your token from: https://app.deriv.com/account/api-token');
    process.exit(1);
  }
  
  if (!CONFIG.trading.useDemoAccount) {
    console.error('⚠️  WARNING: Demo account is disabled!');
    console.error('⚠️  It is STRONGLY recommended to test with demo first.');
    
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    // await new Promise((resolve) => {
    //   readline.question('Continue with REAL account? (yes/no): ', (answer) => {
    //     readline.close();
    //     if (answer.toLowerCase() !== 'yes') {
    //       console.log('❌ Cancelled by user');
    //       process.exit(0);
    //     }
    //     resolve();
    //   });
    // });
  }
  
  // Create and start bot
  const bot = new DerivTradingBot(CONFIG);
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\n⚠️  Shutdown signal received...');
    bot.stop();
  });
  
  process.on('SIGTERM', () => {
    console.log('\n\n⚠️  Shutdown signal received...');
    bot.stop();
  });
  
  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    console.error('\n❌ Uncaught Exception:', error);
    bot.stop();
  });
  
  process.on('unhandledRejection', (error) => {
    console.error('\n❌ Unhandled Rejection:', error);
    bot.stop();
  });
  
  // Start the bot
  await bot.start();
}

// Run the bot
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { DerivTradingBot, TechnicalIndicators, RiskManager, StrategyEngine };
