#!/usr/bin/env node

/**
 * Deriv Multiplier Trading Bot - Production-Grade Node.js Version
 * 
 * Features:
 * - Candle-based trading strategy (Buy on bullish, Sell on bearish)
 * - Auto-close 6 seconds before candle end
 * - Martingale on loss with configurable steps
 * - Take profit target
 * - Session stop loss
 * - Daily loss limit
 * - Max consecutive losses protection
 * - Max drawdown protection
 * - News filter
 * - Session filter (Asian, London, New York, Overlap)
 * - Trend filter (EMA)
 * - RSI filter
 * - Volatility/Candle size filter
 * - Confirmation candle filter
 * - Cooldown after loss
 * - Telegram notifications
 * - Auto-reconnection with exponential backoff
 * - Comprehensive trade analytics
 * 
 * Usage:
 *   DERIV_API_TOKEN=your_token node deriv-bot-node.js
 */

const WebSocket = require('ws');
const readline = require('readline');
const https = require('https');

// ============ CONFIGURATION ============
const CONFIG = {
  // API Settings
  apiToken: '0P94g4WdSrSrzir',
  wsUrl: 'wss://ws.derivws.com/websockets/v3?app_id=1089',

  // Trading Settings
  asset: 'R_100',//frxXAUUSD, frxEURUSD, frxGBPUSD, frxUSDCAD, frxUSDCHF, frxUSDJPY, frxNZDUS
  // 'R_75', 'R_100', '1HZ25V', '1HZ50V', '1HZ100V' 'stpRNG',
  multiplier: 100,//x100 Assest Specific Multiplier
  timeFrame: 180,//300 seconds
  stake: 1,

  // Take Profit / Stop Loss
  takeProfit: 1000,
  stopLoss: 124,
  dailyLossLimit: 0,
  maxDrawdown: 0, // Percentage
  maxConsecutiveLosses: 10,

  // Martingale Settings
  martingale: true,
  martingaleMultiplier: 1,
  lossesB4Multiplier: 4,
  martingaleSteps: 10,

  // Cooldown
  cooldownAfterLoss: 0, // seconds

  // News Filter
  newsFilter: false,
  newsCurrencies: ['USD', 'XAU'],
  newsImpact: ['high', 'medium'],
  newsMinutesBefore: 30,
  newsMinutesAfter: 15,

  // Session Filter
  sessionFilter: false,
  sessionAsian: true,
  sessionLondon: true,
  sessionNewYork: true,
  sessionOverlap: true,

  // Strategy Filters
  useTrendFilter: false,
  trendEMAPeriod: 20,
  useRSIFilter: false,
  rsiPeriod: 14,
  rsiOverbought: 70,
  rsiOversold: 30,
  useVolatilityFilter: false,
  minCandleSize: 0,
  maxCandleSize: 100,
  requireConfirmation: false,

  // Telegram Notifications
  telegramEnabled: true,
  telegramBotToken: '8306232249:AAGMwjFngs68Lcq27oGmqewQgthXTJJRxP0',
  telegramChatId: '752497117',
};

// Asset to currency mapping
const ASSET_CURRENCIES = {
  'frxAUDUSD': ['AUD', 'USD'],
  'frxEURUSD': ['EUR', 'USD'],
  'frxGBPUSD': ['GBP', 'USD'],
  'frxUSDCAD': ['USD', 'CAD'],
  'frxUSDCHF': ['USD', 'CHF'],
  'frxUSDJPY': ['USD', 'JPY'],
  'frxNZDUSD': ['NZD', 'USD'],
  'frxXAUUSD': ['XAU', 'USD'],
};

// ============ STATE ============
let ws = null;
let isConnected = false;
let isAuthorized = false;
let isBotRunning = false;
let isCoolingDown = false;
let hasOpenTrade = false;
let contractId = null;
let currentStake = CONFIG.stake;
let martingaleCount = 0;
let netProfit = 0;
let accountBalance = 0;
let peakBalance = 0;
let dailyProfit = 0;
let dailyDate = new Date().toDateString();
let consecutiveWins = 0;
let consecutiveLosses = 0;
let pendingDirection = null;
let previousCandle = null;
let currentCandle = null;
let candleEndEpoch = 0;
let closeTimer = null;
let candleTimer = null;
let newsCheckTimer = null;
let cooldownTimer = null;
let reconnectAttempts = 0;

// Price/Candle history for indicators
let priceHistory = [];
let candleHistory = [];

// News events cache
let newsEvents = [];
let isNewsBlocked = false;
let newsBlockReason = '';

// Trading statistics
let tradingStats = {
  totalTrades: 0,
  winningTrades: 0,
  losingTrades: 0,
  winRate: 0,
  netProfit: 0,
  grossProfit: 0,
  grossLoss: 0,
  averageWin: 0,
  averageLoss: 0,
  profitFactor: 0,
  maxDrawdown: 0,
  maxConsecutiveWins: 0,
  maxConsecutiveLosses: 0,
};

// Trade history
let trades = [];

// ============ COLORS ============
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

// ============ LOGGING ============
function log(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  let color = colors.white;
  let symbol = 'ℹ';

  switch (type) {
    case 'success': color = colors.green; symbol = '✓'; break;
    case 'error': color = colors.red; symbol = '✕'; break;
    case 'warning': color = colors.yellow; symbol = '⚠'; break;
    case 'trade': color = colors.cyan; symbol = '💰'; break;
    case 'candle': color = colors.magenta; symbol = '🕯️'; break;
  }

  console.log(`${colors.gray}[${timestamp}]${colors.reset} ${color}${symbol} ${message}${colors.reset}`);
}

// ============ TELEGRAM NOTIFICATIONS ============
function sendTelegramMessage(message) {
  if (!CONFIG.telegramEnabled || !CONFIG.telegramBotToken || !CONFIG.telegramChatId) return;

  const data = JSON.stringify({
    chat_id: CONFIG.telegramChatId,
    text: message,
    parse_mode: 'HTML',
  });

  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${CONFIG.telegramBotToken}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length,
    },
  };

  const req = https.request(options, (res) => {
    if (res.statusCode !== 200) {
      log('Telegram notification failed', 'warning');
    }
  });

  req.on('error', () => { });
  req.write(data);
  req.end();
}

// ============ TECHNICAL INDICATORS ============
function calculateEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1];
  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  return ema;
}

function calculateRSI(prices, period) {
  if (prices.length < period + 1) return 50;

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

function getPipSize(asset) {
  if (asset.includes('JPY')) return 0.01;
  if (asset.includes('XAU')) return 0.1;
  return 0.0001;
}

// ============ SESSION FILTER ============
function getCurrentSessions() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const sessions = [];

  if (utcHour >= 0 && utcHour < 8) sessions.push('asian');
  if (utcHour >= 8 && utcHour < 16) sessions.push('london');
  if (utcHour >= 13 && utcHour < 21) sessions.push('newYork');
  if (utcHour >= 13 && utcHour < 16) sessions.push('overlap');

  return sessions;
}

function isSessionAllowed() {
  if (!CONFIG.sessionFilter) return true;

  const currentSessions = getCurrentSessions();

  if (CONFIG.sessionOverlap && currentSessions.includes('overlap')) return true;
  if (CONFIG.sessionLondon && currentSessions.includes('london')) return true;
  if (CONFIG.sessionNewYork && currentSessions.includes('newYork')) return true;
  if (CONFIG.sessionAsian && currentSessions.includes('asian')) return true;

  return false;
}

// ============ NEWS FILTER ============
function generateMockNewsEvents() {
  const now = new Date();
  const events = [];
  const currencies = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD'];
  const impacts = ['low', 'medium', 'high'];
  const titles = {
    high: ['Interest Rate Decision', 'Non-Farm Payrolls', 'CPI m/m', 'GDP q/q', 'Retail Sales m/m'],
    medium: ['Employment Change', 'Trade Balance', 'PPI m/m', 'Industrial Production'],
    low: ['Building Permits', 'Consumer Confidence', 'Manufacturing PMI'],
  };

  for (let i = 0; i < 8; i++) {
    const hoursAhead = Math.floor(Math.random() * 8) - 2;
    const impact = impacts[Math.floor(Math.random() * impacts.length)];
    const eventTime = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

    events.push({
      id: `news_${i}`,
      title: titles[impact][Math.floor(Math.random() * titles[impact].length)],
      currency: currencies[Math.floor(Math.random() * currencies.length)],
      impact,
      timestamp: eventTime,
    });
  }

  return events.sort((a, b) => a.timestamp - b.timestamp);
}

function checkNewsBlock() {
  if (!CONFIG.newsFilter) {
    isNewsBlocked = false;
    newsBlockReason = '';
    return;
  }

  const assetCurrencies = ASSET_CURRENCIES[CONFIG.asset] || [];
  const now = new Date();

  const relevantNews = newsEvents.filter(event => {
    if (!CONFIG.newsCurrencies.includes(event.currency) && !assetCurrencies.includes(event.currency)) return false;
    if (!CONFIG.newsImpact.includes(event.impact)) return false;
    return true;
  });

  for (const event of relevantNews) {
    const eventTime = new Date(event.timestamp);
    const startBlock = new Date(eventTime.getTime() - CONFIG.newsMinutesBefore * 60 * 1000);
    const endBlock = new Date(eventTime.getTime() + CONFIG.newsMinutesAfter * 60 * 1000);

    if (now >= startBlock && now <= endBlock) {
      const wasBlocked = isNewsBlocked;
      isNewsBlocked = true;
      newsBlockReason = `${event.currency} - ${event.title} (${event.impact})`;
      if (!wasBlocked) {
        log(`📰 News Filter: Trading paused - ${newsBlockReason}`, 'warning');
      }
      return;
    }
  }

  if (isNewsBlocked) {
    log('📰 News Filter: Trading resumed', 'success');
  }
  isNewsBlocked = false;
  newsBlockReason = '';
}

// ============ STRATEGY FILTERS ============
function checkStrategyFilters(direction, candle) {
  // Trend Filter (EMA)
  if (CONFIG.useTrendFilter && priceHistory.length >= CONFIG.trendEMAPeriod) {
    const ema = calculateEMA(priceHistory, CONFIG.trendEMAPeriod);
    const trend = candle.close > ema ? 'up' : 'down';

    if ((direction === 'buy' && trend === 'down') || (direction === 'sell' && trend === 'up')) {
      return { allowed: false, reason: `Trend filter: ${trend.toUpperCase()} trend, skipping ${direction.toUpperCase()}` };
    }
  }

  // RSI Filter
  if (CONFIG.useRSIFilter && priceHistory.length >= CONFIG.rsiPeriod + 1) {
    const rsi = calculateRSI(priceHistory, CONFIG.rsiPeriod);

    if (direction === 'buy' && rsi >= CONFIG.rsiOverbought) {
      return { allowed: false, reason: `RSI filter: Overbought (${rsi.toFixed(1)}), skipping BUY` };
    }
    if (direction === 'sell' && rsi <= CONFIG.rsiOversold) {
      return { allowed: false, reason: `RSI filter: Oversold (${rsi.toFixed(1)}), skipping SELL` };
    }
  }

  // Volatility Filter
  if (CONFIG.useVolatilityFilter) {
    const pipSize = getPipSize(CONFIG.asset);
    const candleSizePips = Math.abs(candle.close - candle.open) / pipSize;

    if (candleSizePips < CONFIG.minCandleSize) {
      return { allowed: false, reason: `Volatility filter: Candle too small (${candleSizePips.toFixed(1)} pips)` };
    }
    if (candleSizePips > CONFIG.maxCandleSize) {
      return { allowed: false, reason: `Volatility filter: Candle too large (${candleSizePips.toFixed(1)} pips)` };
    }
  }

  // Confirmation Candle
  if (CONFIG.requireConfirmation && candleHistory.length >= 2) {
    const prev = candleHistory[candleHistory.length - 2];
    const prevDirection = prev.close > prev.open ? 'buy' : 'sell';

    if (prevDirection !== direction) {
      return { allowed: false, reason: `Confirmation filter: Previous candle was ${prevDirection.toUpperCase()}` };
    }
  }

  return { allowed: true, reason: '' };
}

// ============ RISK MANAGEMENT ============
function checkRiskLimits(profit, newNetProfit) {
  // Session Stop Loss
  if (CONFIG.stopLoss > 0 && newNetProfit <= -CONFIG.stopLoss) {
    return { shouldStop: true, reason: `Session Stop Loss reached: -$${CONFIG.stopLoss}` };
  }

  // Daily Loss Limit
  const today = new Date().toDateString();
  if (today !== dailyDate) {
    dailyDate = today;
    dailyProfit = 0;
  }
  dailyProfit += profit;

  if (CONFIG.dailyLossLimit > 0 && dailyProfit <= -CONFIG.dailyLossLimit) {
    return { shouldStop: true, reason: `Daily Loss Limit reached: -$${CONFIG.dailyLossLimit}` };
  }

  // Max Consecutive Losses
  if (CONFIG.maxConsecutiveLosses > 0 && consecutiveLosses >= CONFIG.maxConsecutiveLosses) {
    return { shouldStop: true, reason: `Max Consecutive Losses reached: ${CONFIG.maxConsecutiveLosses}` };
  }

  // Max Drawdown
  if (CONFIG.maxDrawdown > 0 && accountBalance > 0) {
    const currentBalance = accountBalance + newNetProfit;
    const drawdown = ((peakBalance - currentBalance) / peakBalance) * 100;
    if (drawdown >= CONFIG.maxDrawdown) {
      return { shouldStop: true, reason: `Max Drawdown reached: ${drawdown.toFixed(1)}%` };
    }
  }

  return { shouldStop: false, reason: '' };
}

function updateTradingStats(profit) {
  const isWin = profit >= 0;

  tradingStats.totalTrades++;
  if (isWin) {
    tradingStats.winningTrades++;
    tradingStats.grossProfit += profit;
    consecutiveWins++;
    consecutiveLosses = 0;
  } else {
    tradingStats.losingTrades++;
    tradingStats.grossLoss += Math.abs(profit);
    consecutiveLosses++;
    consecutiveWins = 0;
  }

  tradingStats.netProfit = tradingStats.grossProfit - tradingStats.grossLoss;
  tradingStats.winRate = (tradingStats.winningTrades / tradingStats.totalTrades) * 100;
  tradingStats.averageWin = tradingStats.winningTrades > 0 ? tradingStats.grossProfit / tradingStats.winningTrades : 0;
  tradingStats.averageLoss = tradingStats.losingTrades > 0 ? tradingStats.grossLoss / tradingStats.losingTrades : 0;
  tradingStats.profitFactor = tradingStats.grossLoss > 0 ? tradingStats.grossProfit / tradingStats.grossLoss : tradingStats.grossProfit;

  // Update peak and drawdown
  const currentBalance = accountBalance + tradingStats.netProfit;
  if (currentBalance > peakBalance) {
    peakBalance = currentBalance;
  }
  const drawdown = peakBalance > 0 ? ((peakBalance - currentBalance) / peakBalance) * 100 : 0;
  if (drawdown > tradingStats.maxDrawdown) {
    tradingStats.maxDrawdown = drawdown;
  }

  // Update streak records
  if (consecutiveWins > tradingStats.maxConsecutiveWins) {
    tradingStats.maxConsecutiveWins = consecutiveWins;
  }
  if (consecutiveLosses > tradingStats.maxConsecutiveLosses) {
    tradingStats.maxConsecutiveLosses = consecutiveLosses;
  }
}

// ============ WEBSOCKET ============
function sendMessage(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function connect() {
  if (ws) {
    ws.close();
  }

  log('Connecting to Deriv WebSocket...', 'info');

  ws = new WebSocket(CONFIG.wsUrl);

  ws.on('open', () => {
    isConnected = true;
    reconnectAttempts = 0;
    log('WebSocket connected', 'success');

    sendMessage({ authorize: CONFIG.apiToken });
  });

  ws.on('message', handleMessage);

  ws.on('error', (error) => {
    log(`WebSocket error: ${error.message}`, 'error');
  });

  ws.on('close', () => {
    isConnected = false;
    isAuthorized = false;
    log('WebSocket disconnected', 'warning');

    // Auto-reconnect if bot was running
    if (isBotRunning) {
      reconnect();
    }
  });
}

function reconnect() {
  const maxAttempts = 5;
  if (reconnectAttempts >= maxAttempts) {
    log(`Max reconnection attempts (${maxAttempts}) reached`, 'error');
    stopBot('Max reconnection attempts reached');
    return;
  }

  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);

  log(`Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}/${maxAttempts})...`, 'warning');

  setTimeout(() => {
    if (!isConnected) {
      connect();
    }
  }, delay);
}

function handleMessage(data) {
  try {
    const msg = JSON.parse(data);

    if (msg.error) {
      log(`Error: ${msg.error.message}`, 'error');
      if (msg.error.code === 'InvalidToken') {
        isAuthorized = false;
      }
      if (msg.msg_type === 'proposal' || msg.msg_type === 'buy') {
        hasOpenTrade = false;
        log('Trade cancelled due to error', 'warning');
      }
      return;
    }

    switch (msg.msg_type) {
      case 'authorize':
        isAuthorized = true;
        accountBalance = msg.authorize.balance;
        peakBalance = accountBalance;
        log(`Authorized as ${msg.authorize.loginid}`, 'success');
        log(`Balance: $${accountBalance}`, 'info');
        startBot();
        break;

      case 'candles':
        handleCandleData(msg);
        break;

      case 'ohlc':
        handleCandleData(msg);
        break;

      case 'proposal':
        if (msg.proposal) {
          const proposalId = msg.proposal.id;
          log(`Proposal received: ${proposalId} - Buying...`, 'info');

          sendMessage({
            buy: proposalId,
            price: currentStake,
            subscribe: 1,
          });

          sendMessage({ forget: proposalId });
        }
        break;

      case 'buy':
        if (msg.buy) {
          contractId = msg.buy.contract_id;
          log(`Trade opened: Contract ID ${contractId}`, 'success');
          sendTelegramMessage(`🔔 New Trade\n${pendingDirection.toUpperCase()} ${CONFIG.asset}\nStake: $${currentStake.toFixed(2)}\nMultiplier: x${CONFIG.multiplier}`);
        }
        break;

      case 'proposal_open_contract':
        handleTradeUpdate(msg);
        break;

      case 'sell':
        log('Trade sell confirmed', 'info');
        break;
    }
  } catch (error) {
    log(`Parse error: ${error.message}`, 'error');
  }
}

function handleCandleData(data) {
  // Initial candles history
  if (data.candles && data.candles.length >= 2) {
    candleHistory = data.candles.map(c => ({ ...c }));
    priceHistory = data.candles.map(c => c.close);

    previousCandle = data.candles[data.candles.length - 2];
    currentCandle = data.candles[data.candles.length - 1];
    candleEndEpoch = currentCandle.epoch + CONFIG.timeFrame;

    log(`Received ${data.candles.length} candles for indicators`, 'info');
  }

  // Streaming OHLC updates
  if (data.ohlc) {
    const ohlc = data.ohlc;
    const ohlcEpoch = ohlc.open_time || ohlc.epoch;

    const newCandle = {
      open: parseFloat(ohlc.open),
      high: parseFloat(ohlc.high),
      low: parseFloat(ohlc.low),
      close: parseFloat(ohlc.close),
      epoch: ohlcEpoch,
    };

    // New candle formed
    if (currentCandle && ohlcEpoch !== currentCandle.epoch) {
      log(`🕯️ NEW CANDLE formed at epoch ${ohlcEpoch}`, 'candle');

      const completedCandle = currentCandle;
      previousCandle = completedCandle;

      // Update history
      priceHistory.push(completedCandle.close);
      if (priceHistory.length > 100) priceHistory.shift();

      candleHistory.push(completedCandle);
      if (candleHistory.length > 50) candleHistory.shift();

      const wasBullish = completedCandle.close > completedCandle.open;
      const direction = wasBullish ? 'buy' : 'sell';

      log(`Completed: O=${completedCandle.open.toFixed(5)} C=${completedCandle.close.toFixed(5)} ${wasBullish ? '📈 BULLISH' : '📉 BEARISH'}`, 'info');

      if (isBotRunning && !hasOpenTrade && !isCoolingDown) {
        if (isNewsBlocked) {
          log(`📰 Signal skipped due to news: ${direction.toUpperCase()}`, 'warning');
        } else if (!isSessionAllowed()) {
          log(`⏰ Session filter: Trading not allowed in current session`, 'warning');
        } else {
          const strategyCheck = checkStrategyFilters(direction, completedCandle);
          if (!strategyCheck.allowed) {
            log(`📊 ${strategyCheck.reason}`, 'warning');
          } else {
            log(`Signal: Opening ${direction.toUpperCase()}`, 'info');
            openTrade(direction);

            const nextCandleEnd = ohlcEpoch + CONFIG.timeFrame;
            scheduleTradeClose(nextCandleEnd);
          }
        }
      }

      candleEndEpoch = ohlcEpoch + CONFIG.timeFrame;
    }

    currentCandle = newCandle;
  }
}

function handleTradeUpdate(data) {
  if (data.proposal_open_contract) {
    const contract = data.proposal_open_contract;
    contractId = contract.contract_id;

    if (contract.is_sold === 1 || contract.status === 'sold') {
      const profit = contract.profit || (contract.sell_price ? contract.sell_price - contract.buy_price : 0);

      // Update stats
      updateTradingStats(profit);

      // Store trade
      trades.unshift({
        id: contract.contract_id,
        asset: CONFIG.asset,
        direction: pendingDirection,
        stake: currentStake,
        profit,
        timestamp: new Date(),
      });

      // Update net profit
      netProfit += profit;

      const profitStr = `${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`;
      log(`Trade closed: ${profitStr} | Net: $${netProfit.toFixed(2)}`, profit >= 0 ? 'success' : 'error');

      // Send notification
      if (profit >= 0) {
        sendTelegramMessage(`✅ Trade Won\nProfit: ${profitStr}\nNet P/L: $${netProfit.toFixed(2)}`);
      } else {
        sendTelegramMessage(`❌ Trade Lost\nLoss: ${profitStr}\nNet P/L: $${netProfit.toFixed(2)}`);
      }

      // Check take profit
      if (CONFIG.takeProfit > 0 && netProfit >= CONFIG.takeProfit) {
        log(`🎯 Take Profit target reached! Net: $${netProfit.toFixed(2)}`, 'success');
        stopBot('Take profit target achieved');
        return;
      }

      // Check risk limits
      const riskCheck = checkRiskLimits(profit, netProfit);
      if (riskCheck.shouldStop) {
        stopBot(riskCheck.reason);
        return;
      }

      // Calculate next stake
      currentStake = calculateNextStake(profit);
      hasOpenTrade = false;
      contractId = null;

      // Apply cooldown after loss
      if (profit < 0 && CONFIG.cooldownAfterLoss > 0) {
        isCoolingDown = true;
        log(`⏳ Cooling down for ${CONFIG.cooldownAfterLoss} seconds...`, 'warning');
        cooldownTimer = setTimeout(() => {
          isCoolingDown = false;
          log('✅ Cooldown complete, ready to trade', 'info');
        }, CONFIG.cooldownAfterLoss * 1000);
      }
    }
  }
}

function openTrade(direction) {
  if (hasOpenTrade || isCoolingDown) return;

  hasOpenTrade = true;
  pendingDirection = direction;

  sendMessage({
    proposal: 1,
    amount: currentStake,
    basis: 'stake',
    contract_type: direction === 'buy' ? 'MULTUP' : 'MULTDOWN',
    currency: 'USD',
    symbol: CONFIG.asset,
    multiplier: CONFIG.multiplier,
  });

  log(`Requesting ${direction.toUpperCase()} proposal: ${CONFIG.asset} @ $${currentStake.toFixed(2)} x${CONFIG.multiplier}`, 'trade');
}

function closeTrade() {
  if (contractId && hasOpenTrade) {
    sendMessage({
      sell: contractId,
      price: 0,
    });
    log(`Closing trade (contract: ${contractId})`, 'info');
  }
}

function scheduleTradeClose(candleEnd) {
  if (closeTimer) clearTimeout(closeTimer);

  const now = Math.floor(Date.now() / 1000);
  const closeTime = candleEnd - 6;
  const delay = (closeTime - now) * 1000;

  if (delay > 0) {
    log(`Scheduled trade close in ${Math.round(delay / 1000)}s`, 'info');
    closeTimer = setTimeout(() => {
      if (hasOpenTrade) {
        closeTrade();
        log('Auto-closing trade 6 seconds before candle close', 'warning');
      }
    }, delay);
  }
}

function calculateNextStake(lastProfit) {
  if (lastProfit >= 0) {
    martingaleCount = 0;
    return CONFIG.stake;
  }

  if (CONFIG.martingale && martingaleCount >= CONFIG.lossesB4Multiplier) {
    CONFIG.martingaleMultiplier = 2;
  }

  if (CONFIG.martingale && martingaleCount < CONFIG.martingaleSteps) {
    martingaleCount++;
    const newStake = currentStake * CONFIG.martingaleMultiplier;
    log(`Martingale step ${martingaleCount}: Stake increased to $${newStake.toFixed(2)}`, 'warning');
    return newStake;
  }

  martingaleCount = 0;
  return CONFIG.stake;
}

function subscribeToCandles() {
  const candleCount = Math.max(50, CONFIG.trendEMAPeriod + 10, CONFIG.rsiPeriod + 10);

  sendMessage({
    ticks_history: CONFIG.asset,
    adjust_start_time: 1,
    count: candleCount,
    end: 'latest',
    granularity: CONFIG.timeFrame,
    style: 'candles',
    subscribe: 1,
  });

  log(`Subscribed to ${CONFIG.asset} candles (${CONFIG.timeFrame}s)`, 'info');
  startCandleTimer();
}

function startCandleTimer() {
  if (candleTimer) clearInterval(candleTimer);

  candleTimer = setInterval(() => {
    if (candleEndEpoch > 0 && isBotRunning) {
      const now = Math.floor(Date.now() / 1000);
      const remaining = Math.max(0, candleEndEpoch - now);

      const isNewsBlockedStr = isNewsBlocked ? ' | 📰 NEWS PAUSE' : '';
      const sessionStr = !isSessionAllowed() ? ' | ⏰ SESSION BLOCKED' : '';

      process.stdout.write(`\r⏱️ Candle: ${remaining}s | P/L: ${netProfit >= 0 ? '+' : ''}$${netProfit.toFixed(2)} | Trades: ${tradingStats.totalTrades} | Win Rate: ${tradingStats.winRate.toFixed(1)}%${isNewsBlockedStr}${sessionStr}   `);
    }
  }, 1000);
}

// ============ BOT CONTROL ============
function startBot() {
  if (!isAuthorized) {
    log('Cannot start bot: Not authorized', 'error');
    return;
  }

  // Reset stats
  netProfit = 0;
  dailyProfit = 0;
  consecutiveWins = 0;
  consecutiveLosses = 0;
  martingaleCount = 0;
  currentStake = CONFIG.stake;
  tradingStats = {
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRate: 0,
    netProfit: 0,
    grossProfit: 0,
    grossLoss: 0,
    averageWin: 0,
    averageLoss: 0,
    profitFactor: 0,
    maxDrawdown: 0,
    maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0,
  };
  trades = [];

  isBotRunning = true;
  subscribeToCandles();

  // Start news monitoring
  if (CONFIG.newsFilter) {
    newsEvents = generateMockNewsEvents();
    checkNewsBlock();
    newsCheckTimer = setInterval(() => {
      checkNewsBlock();
    }, 10000);
    log('📰 News filter enabled', 'info');
  }

  log('🤖 Bot started - Waiting for candle signals...', 'success');
  sendTelegramMessage('🤖 Bot Started\nWaiting for trade signals...');
}

function stopBot(reason = 'Manual stop') {
  console.log(''); // New line after the status display

  isBotRunning = false;

  if (closeTimer) clearTimeout(closeTimer);
  if (candleTimer) clearInterval(candleTimer);
  if (newsCheckTimer) clearInterval(newsCheckTimer);
  if (cooldownTimer) clearTimeout(cooldownTimer);

  sendMessage({ forget_all: 'candles' });
  candleEndEpoch = 0;
  isNewsBlocked = false;
  isCoolingDown = false;

  log(`⛔ Bot stopped: ${reason}`, 'warning');
  log(`Final P/L: ${netProfit >= 0 ? '+' : ''}$${netProfit.toFixed(2)} | Trades: ${tradingStats.totalTrades} | Win Rate: ${tradingStats.winRate.toFixed(1)}%`, 'info');

  sendTelegramMessage(`⛔ Bot Stopped: ${reason}\nNet P/L: $${netProfit.toFixed(2)}\nTotal Trades: ${tradingStats.totalTrades}\nWin Rate: ${tradingStats.winRate.toFixed(1)}%`);
}

function showStatus() {
  console.log('');
  console.log(`${colors.cyan}═══════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}           BOT STATUS${colors.reset}`);
  console.log(`${colors.cyan}═══════════════════════════════════════${colors.reset}`);
  console.log(`  Connected:     ${isConnected ? colors.green + 'Yes' : colors.red + 'No'}${colors.reset}`);
  console.log(`  Authorized:    ${isAuthorized ? colors.green + 'Yes' : colors.red + 'No'}${colors.reset}`);
  console.log(`  Bot Running:   ${isBotRunning ? colors.green + 'Yes' : colors.yellow + 'No'}${colors.reset}`);
  console.log(`  Balance:       $${(accountBalance + netProfit).toFixed(2)}`);
  console.log(`  Net P/L:       ${netProfit >= 0 ? colors.green : colors.red}${netProfit >= 0 ? '+' : ''}$${netProfit.toFixed(2)}${colors.reset}`);
  console.log(`${colors.cyan}───────────────────────────────────────${colors.reset}`);
  console.log(`  Total Trades:  ${tradingStats.totalTrades}`);
  console.log(`  Win Rate:      ${tradingStats.winRate.toFixed(1)}%`);
  console.log(`  Profit Factor: ${tradingStats.profitFactor.toFixed(2)}`);
  console.log(`  Max Drawdown:  ${tradingStats.maxDrawdown.toFixed(1)}%`);
  console.log(`  Current Stake: $${currentStake.toFixed(2)}`);
  console.log(`  Martingale:    ${martingaleCount}/${CONFIG.martingaleSteps}`);
  console.log(`${colors.cyan}───────────────────────────────────────${colors.reset}`);
  console.log(`  News Blocked:  ${isNewsBlocked ? colors.orange + 'Yes - ' + newsBlockReason : 'No'}${colors.reset}`);
  console.log(`  Session OK:    ${isSessionAllowed() ? colors.green + 'Yes' : colors.red + 'No'}${colors.reset}`);
  console.log(`  Cooling Down:  ${isCoolingDown ? colors.yellow + 'Yes' : 'No'}${colors.reset}`);
  console.log(`${colors.cyan}═══════════════════════════════════════${colors.reset}`);
  console.log('');
}

function showHistory() {
  console.log('');
  console.log(`${colors.cyan}═══════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}         TRADE HISTORY (Last 10)${colors.reset}`);
  console.log(`${colors.cyan}═══════════════════════════════════════${colors.reset}`);

  if (trades.length === 0) {
    console.log('  No trades yet');
  } else {
    trades.slice(0, 10).forEach((trade, i) => {
      const color = trade.profit >= 0 ? colors.green : colors.red;
      const dir = trade.direction === 'buy' ? '📈' : '📉';
      console.log(`  ${i + 1}. ${dir} ${trade.asset} | Stake: $${trade.stake.toFixed(2)} | P/L: ${color}${trade.profit >= 0 ? '+' : ''}$${trade.profit.toFixed(2)}${colors.reset}`);
    });
  }

  console.log(`${colors.cyan}───────────────────────────────────────${colors.reset}`);
  console.log(`  Net Profit: ${netProfit >= 0 ? colors.green : colors.red}${netProfit >= 0 ? '+' : ''}$${netProfit.toFixed(2)}${colors.reset}`);
  console.log(`${colors.cyan}═══════════════════════════════════════${colors.reset}`);
  console.log('');
}

function showConfig() {
  console.log('');
  console.log(`${colors.cyan}═══════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}         CONFIGURATION${colors.reset}`);
  console.log(`${colors.cyan}═══════════════════════════════════════${colors.reset}`);
  console.log(`  ${colors.bright}Trading:${colors.reset}`);
  console.log(`    Asset:        ${CONFIG.asset}`);
  console.log(`    Multiplier:   x${CONFIG.multiplier}`);
  console.log(`    TimeFrame:    ${CONFIG.timeFrame}s`);
  console.log(`    Stake:        $${CONFIG.stake}`);
  console.log(`${colors.cyan}───────────────────────────────────────${colors.reset}`);
  console.log(`  ${colors.bright}Risk Management:${colors.reset}`);
  console.log(`    Take Profit:  ${CONFIG.takeProfit > 0 ? '$' + CONFIG.takeProfit : 'Disabled'}`);
  console.log(`    Stop Loss:    ${CONFIG.stopLoss > 0 ? '$' + CONFIG.stopLoss : 'Disabled'}`);
  console.log(`    Daily Limit:  ${CONFIG.dailyLossLimit > 0 ? '$' + CONFIG.dailyLossLimit : 'Disabled'}`);
  console.log(`    Max Drawdown: ${CONFIG.maxDrawdown > 0 ? CONFIG.maxDrawdown + '%' : 'Disabled'}`);
  console.log(`    Max Consec:   ${CONFIG.maxConsecutiveLosses} losses`);
  console.log(`${colors.cyan}───────────────────────────────────────${colors.reset}`);
  console.log(`  ${colors.bright}Martingale:${colors.reset}`);
  console.log(`    Enabled:      ${CONFIG.martingale ? 'Yes' : 'No'}`);
  console.log(`    Multiplier:   x${CONFIG.martingaleMultiplier}`);
  console.log(`    Max Steps:    ${CONFIG.martingaleSteps}`);
  console.log(`${colors.cyan}───────────────────────────────────────${colors.reset}`);
  console.log(`  ${colors.bright}Filters:${colors.reset}`);
  console.log(`    News Filter:  ${CONFIG.newsFilter ? 'Enabled' : 'Disabled'}`);
  console.log(`    Session:      ${CONFIG.sessionFilter ? 'Enabled' : 'Disabled'}`);
  console.log(`    Trend (EMA):  ${CONFIG.useTrendFilter ? 'Enabled (' + CONFIG.trendEMAPeriod + ')' : 'Disabled'}`);
  console.log(`    RSI Filter:   ${CONFIG.useRSIFilter ? 'Enabled (' + CONFIG.rsiPeriod + ')' : 'Disabled'}`);
  console.log(`    Volatility:   ${CONFIG.useVolatilityFilter ? 'Enabled' : 'Disabled'}`);
  console.log(`    Confirmation: ${CONFIG.requireConfirmation ? 'Enabled' : 'Disabled'}`);
  console.log(`${colors.cyan}───────────────────────────────────────${colors.reset}`);
  console.log(`  ${colors.bright}Notifications:${colors.reset}`);
  console.log(`    Telegram:     ${CONFIG.telegramEnabled ? 'Enabled' : 'Disabled'}`);
  console.log(`${colors.cyan}═══════════════════════════════════════${colors.reset}`);
  console.log('');
}

function showNews() {
  console.log('');
  console.log(`${colors.cyan}═══════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}         NEWS FILTER STATUS${colors.reset}`);
  console.log(`${colors.cyan}═══════════════════════════════════════${colors.reset}`);
  console.log(`  Enabled:      ${CONFIG.newsFilter ? 'Yes' : 'No'}`);
  console.log(`  Blocked:      ${isNewsBlocked ? colors.red + 'YES - ' + newsBlockReason + colors.reset : 'No'}`);
  console.log(`  Currencies:   ${CONFIG.newsCurrencies.join(', ')}`);
  console.log(`  Impact:       ${CONFIG.newsImpact.join(', ')}`);
  console.log(`  Before:       ${CONFIG.newsMinutesBefore} min`);
  console.log(`  After:        ${CONFIG.newsMinutesAfter} min`);
  console.log(`${colors.cyan}───────────────────────────────────────${colors.reset}`);
  console.log(`  ${colors.bright}Upcoming News (Next 4 hours):${colors.reset}`);

  const now = new Date();
  const upcoming = newsEvents.filter(e => new Date(e.timestamp) > now && new Date(e.timestamp) < new Date(now.getTime() + 4 * 60 * 60 * 1000));

  if (upcoming.length === 0) {
    console.log('    No upcoming news');
  } else {
    upcoming.forEach(event => {
      const time = new Date(event.timestamp).toLocaleTimeString();
      const impactColor = event.impact === 'high' ? colors.red : event.impact === 'medium' ? colors.yellow : colors.gray;
      console.log(`    ${time} | ${impactColor}${event.impact.toUpperCase()}${colors.reset} | ${event.currency} | ${event.title}`);
    });
  }
  console.log(`${colors.cyan}═══════════════════════════════════════${colors.reset}`);
  console.log('');
}

function showHelp() {
  console.log('');
  console.log(`${colors.cyan}═══════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}           AVAILABLE COMMANDS${colors.reset}`);
  console.log(`${colors.cyan}═══════════════════════════════════════${colors.reset}`);
  console.log(`  ${colors.green}start${colors.reset}    - Start the trading bot`);
  console.log(`  ${colors.green}stop${colors.reset}     - Stop the trading bot`);
  console.log(`  ${colors.green}status${colors.reset}   - Show current bot status`);
  console.log(`  ${colors.green}history${colors.reset}  - Show trade history`);
  console.log(`  ${colors.green}config${colors.reset}   - Show current configuration`);
  console.log(`  ${colors.green}news${colors.reset}     - Show news filter status`);
  console.log(`  ${colors.green}close${colors.reset}    - Manually close current trade`);
  console.log(`  ${colors.green}help${colors.reset}     - Show this help message`);
  console.log(`  ${colors.green}quit${colors.reset}     - Exit the bot`);
  console.log(`${colors.cyan}═══════════════════════════════════════${colors.reset}`);
  console.log('');
}

// ============ MAIN ============
async function main() {
  console.log('');
  console.log(`${colors.cyan}╔═══════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.cyan}║     DERIV MULTIPLIER TRADING BOT - PRODUCTION     ║${colors.reset}`);
  console.log(`${colors.cyan}║            Node.js Version v2.0                   ║${colors.reset}`);
  console.log(`${colors.cyan}╚═══════════════════════════════════════════════════╝${colors.reset}`);
  console.log('');

  // Check for API token
  if (!CONFIG.apiToken) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    CONFIG.apiToken = await new Promise(resolve => {
      rl.question(`${colors.yellow}Enter your Deriv API token: ${colors.reset}`, answer => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  if (!CONFIG.apiToken) {
    log('No API token provided. Exiting.', 'error');
    process.exit(1);
  }

  // Connect to WebSocket
  connect();

  // Setup readline for commands
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on('line', (input) => {
    const cmd = input.trim().toLowerCase();

    switch (cmd) {
      case 'start':
        if (isBotRunning) {
          log('Bot is already running', 'warning');
        } else {
          startBot();
        }
        break;

      case 'stop':
        if (!isBotRunning) {
          log('Bot is not running', 'warning');
        } else {
          stopBot();
        }
        break;

      case 'status':
        showStatus();
        break;

      case 'history':
        showHistory();
        break;

      case 'config':
        showConfig();
        break;

      case 'news':
        showNews();
        break;

      case 'close':
        if (hasOpenTrade) {
          closeTrade();
        } else {
          log('No open trade to close', 'warning');
        }
        break;

      case 'help':
        showHelp();
        break;

      case 'quit':
      case 'exit':
        if (isBotRunning) stopBot();
        if (ws) ws.close();
        log('Goodbye!', 'info');
        process.exit(0);
        break;

      default:
        if (cmd) {
          log(`Unknown command: ${cmd}. Type 'help' for available commands.`, 'warning');
        }
    }
  });

  console.log(`${colors.gray}Type 'help' for available commands${colors.reset}`);
  console.log('');
}

main().catch(console.error);
