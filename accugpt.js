#!/usr/bin/env node
'use strict';

/**
 * Deriv multi-asset Accumulator bot.
 *
 * This bot implements a conservative accumulator method synthesized from common
 * accumulator-risk principles: trade only calm/mean-reverting ticks, prefer low
 * growth rates, rotate across several synthetic assets, stop after loss streaks,
 * and persist all state. No strategy is guaranteed profitable. Run on demo first.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const WebSocket = require('ws');

const CONFIG = {
  appId: '33uslPtthXBEkQOdfKfoY',
  token: 'pat_8e0a3285bd6e74f52a67985b8069f4bea42aa96ce65d129c60ebb838ed1065ee',
  endpoint: 'wss://ws.derivws.com/websockets/v3',
  telegramBotToken: '8218636914:AAGvaKFh8MT769-_9eOEiU4XKufL0aHRhZ4',
  telegramChatId: '752497117',
  currency: 'USD',
  stake: Number(1),
  multiplier: Number(10),
  multiplier2: Number(110),
  multiplier3: Number(1000),
  maxStake: Number(1000),
  confidence: Number(0.77), //0.72
  confidence2: Number(0.77), 
  momentum: Number(0.00004), //0.0008
  drift: Number(0.0000025), //0.00025 
  drift2: Number(-0.0000005), //0.00025 
  volume: Number(0.00020),
  rangePosition: Number(0.04),
  growthRate: Number(0.02),
  maxOpenSeconds: Number(240),
  targetProfitPct: Number(0.12),
  stopLossPct: Number(0.99),
  maxTradesPerHour: Number(8000),
  maxDailyLoss: Number(110),
  dailyProfitTarget: Number(10000),
  cooldownAfterLossMs: Number(180000),
  tradeWatchdogMs: Number(180000),
  pollTimeoutMs: Number(90000),
  tickWindow: Number(80),
  reconnectBaseMs: Number(1000),
  reconnectMaxMs: Number(60000),
  stateFile: path.join(__dirname, 'bot-state_05.json'),
  symbols: ('R_10,R_25,R_50,R_75,R_100').split(',').map((s) => s.trim()).filter(Boolean),
  dryRun: false,
};

const sep = CONFIG.endpoint.includes('?') ? '&' : '?';
CONFIG.endpoint = `${CONFIG.endpoint}${sep}app_id=${CONFIG.appId}`;

const _isPat = /^pat_[a-z0-9_\-]{16,}$/i.test(CONFIG.token.trim());

async function restApi(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, 'https://api.derivws.com');
    const payload = body != null ? JSON.stringify(body) : null;
    const req = https.request({
      method, hostname: url.hostname, path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${CONFIG.token}`,
        'Deriv-App-ID': CONFIG.appId,
        'Accept': 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 15000,
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on('timeout', () => req.destroy(new Error('REST timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function patConnect() {
  try {
    console.log('PAT token detected — using OTP flow');
    const accRes = await restApi('GET', '/trading/v1/options/accounts');
    if (accRes.status !== 200) throw new Error(`Account list failed (${accRes.status})`);
    const accounts = Array.isArray(accRes.body?.data) ? accRes.body.data : [];
    if (!accounts.length) throw new Error('No Options accounts found');
    const acct = accounts.find(a => (a.account_type || '').toLowerCase() === 'demo') || accounts[0];
    console.log(`Account: ${acct.account_id} (${acct.account_type})`);

    const otpRes = await restApi('POST', `/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`);
    if (otpRes.status !== 200) throw new Error(`OTP failed (${otpRes.status})`);
    const wsUrl = otpRes.body?.data?.url;
    if (!wsUrl) throw new Error('OTP response missing data.url');

    console.log('Connecting via PAT OTP...');
    ws = new WebSocket(wsUrl);
    ws.on('open', async () => {
      connected = true;
      reconnectAttempt = 0;
      console.log('Connected and authorized via PAT');
      await notify('✅ Deriv bot connected and authorized (PAT).');
      for (const symbol of CONFIG.symbols) subscribeTicks(symbol);
    });
    ws.on('message', (raw) => handleMessage(raw));
    ws.on('error', async (error) => {
      console.error('WebSocket error:', error.message);
      await notify(`⚠️ Network/server error: ${error.message}`);
    });
    ws.on('close', () => {
      connected = false;
      proposalPending = false;
      console.error('Disconnected. Reconnecting...');
      setTimeout(connect, reconnectDelay());
    });
  } catch (error) {
    console.error('PAT connection failed:', error.message);
    await notify(`❌ PAT connection failed: ${error.message}. Reconnecting...`);
    proposalPending = false;
    setTimeout(connect, reconnectDelay());
  }
}

const state = loadState();
let ws;
let connected = false;
let reconnectAttempt = 0;
let requestId = 1;
let currentContract = null;
let contractSubscriptionId = null;
let watchdogTimer = null;
let hourlyTimer = null;
let hourlyBootTimer = null;
let endDayTimer = null;
let tradingPausedUntil = 0;
let proposalPending = false;
let lastTradeAttempt = 0;
const pending = new Map();
const tickBooks = new Map(CONFIG.symbols.map((symbol) => [symbol, []]));

function defaultState() {
  return {
    startedAt: new Date().toISOString(),
    activeDay: gmtDateKey(),
    overallProfit: 0,
    totalTrades: 0,
    wins: 0,
    losses: 0,
    consecutiveLosses: 0,
    lossStreakBuckets: { x2: 0, x3: 0, x4: 0 },
    days: {},
    trades: [],
    stuckTrades: [],
  };
}

function loadState() {
  try {
    if (!fs.existsSync(CONFIG.stateFile)) return defaultState();
    return { ...defaultState(), ...JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8')) };
  } catch (error) {
    console.error('State load failed, starting fresh:', error.message);
    return defaultState();
  }
}

function saveState() {
  const tmp = `${CONFIG.stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, CONFIG.stateFile);
}

function gmtDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function gmtHourKey(date = new Date()) {
  return date.toISOString().slice(0, 13) + ':00Z';
}

function ensureDay(day = gmtDateKey()) {
  if (!state.days[day]) {
    state.days[day] = { profit: 0, trades: 0, wins: 0, losses: 0, consecutiveLosses: 0, lossStreakBuckets: { x2: 0, x3: 0, x4: 0 }, hourly: {} };
  }
  return state.days[day];
}

function ensureHour(day, hour = gmtHourKey()) {
  const d = ensureDay(day);
  if (!d.hourly[hour]) d.hourly[hour] = { profit: 0, trades: 0, wins: 0, losses: 0 };
  return d.hourly[hour];
}

function connect() {
  if (_isPat) { patConnect(); return; }

  ws = new WebSocket(CONFIG.endpoint);

  ws.on('open', async () => {
    connected = true;
    reconnectAttempt = 0;
    console.log('Connected to Deriv');
    try {
      await api({ authorize: CONFIG.token });
      await notify('✅ Deriv bot connected and authorized.');
      for (const symbol of CONFIG.symbols) subscribeTicks(symbol);
    } catch (error) {
      console.error('Authorization failed:', error.message);
      await notify(`❌ Authorization failed: ${error.message}`);
      ws.close();
    }
  });

  ws.on('message', (raw) => handleMessage(raw));
  ws.on('error', async (error) => {
    console.error('WebSocket error:', error.message);
    await notify(`⚠️ Network/server error: ${error.message}`);
  });
  ws.on('close', () => {
    connected = false;
    proposalPending = false;
    console.error('Disconnected. Reconnecting...');
    setTimeout(connect, reconnectDelay());
  });
}


function reconnectDelay() {
  reconnectAttempt += 1;
  return Math.min(CONFIG.reconnectMaxMs, CONFIG.reconnectBaseMs * 2 ** Math.min(reconnectAttempt, 8));
}

function api(payload, timeoutMs = 15000) {
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('WebSocket is not connected'));
  const req_id = requestId++;
  ws.send(JSON.stringify({ ...payload, req_id }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(req_id);
      reject(new Error(`API timeout for ${Object.keys(payload)[0]}`));
    }, timeoutMs);
    pending.set(req_id, { resolve, reject, timer });
  });
}

function handleMessage(raw) {
  let message;
  try { message = JSON.parse(raw); } catch { return; }

  if (message.error) {
    const p = pending.get(message.req_id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(message.req_id);
      p.reject(new Error(message.error.message || 'Deriv API error'));
    }
    console.error('Deriv API error:', message.error.message);
    return;
  }

  const p = pending.get(message.req_id);
  if (p) {
    clearTimeout(p.timer);
    pending.delete(message.req_id);
    p.resolve(message);
  }

  if (message.msg_type === 'tick') onTick(message.tick);
  if (message.msg_type === 'proposal_open_contract') onContractUpdate(message.proposal_open_contract);
}

function subscribeTicks(symbol) {
  api({ ticks: symbol, subscribe: 1 }).catch((error) => console.error(`Tick subscribe failed for ${symbol}:`, error.message));
}

function onTick(tick) {
  const book = tickBooks.get(tick.symbol);
  if (!book) return;
  book.push({ price: Number(tick.quote), epoch: Number(tick.epoch) });
  if (book.length > CONFIG.tickWindow) book.shift();
  evaluateMarket().catch((error) => console.error('Evaluation error:', error.message));
}

function indicators(book) {
  if (book.length < 35) return null;
  const prices = book.map((t) => t.price);
  const returns = [];
  for (let i = 1; i < prices.length; i++) returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  const recent = returns.slice(-20);
  const drift = recent.reduce((a, b) => a + b, 0) / recent.length;
  const vol = Math.sqrt(recent.reduce((a, r) => a + (r - drift) ** 2, 0) / recent.length);
  const min = Math.min(...prices.slice(-30));
  const max = Math.max(...prices.slice(-30));
  const last = prices.at(-1);
  const range = Math.max(max - min, Number.EPSILON);
  const rangePosition = (last - min) / range;
  const momentum5 = (last - prices.at(-6)) / prices.at(-6);
  const calmScore = 1 / (1 + vol * 10000);
  const meanReversionScore = 1 - Math.abs(rangePosition - 0.5) * 2;
  const momentumPenalty = Math.min(1, Math.abs(momentum5) * 1000);
  const score = calmScore * 0.45 + meanReversionScore * 0.4 + (1 - momentumPenalty) * 0.15;
  return { drift, vol, rangePosition, momentum5, score };
}

async function evaluateMarket() {
  rolloverDayIfNeeded();
  if (currentContract || proposalPending || Date.now() < tradingPausedUntil || Date.now() - lastTradeAttempt < 5000 || CONFIG.dryRun) return;
  const day = ensureDay();
  if (day.profit <= -Math.abs(CONFIG.maxDailyLoss) || day.profit >= CONFIG.dailyProfitTarget) return;
  if (hourTradeCount() >= CONFIG.maxTradesPerHour) return;

//   const ranked = CONFIG.symbols
//     .map((symbol) => ({ symbol, stats: indicators(tickBooks.get(symbol) || []) }))
//     .filter((x) => x.stats && state.consecutiveLosses <= 0 ? x.stats.score >= CONFIG.confidence : x.stats.score >= CONFIG.confidence2 && Math.abs(x.stats.drift) < CONFIG.drift && Math.abs(x.stats.momentum5) < CONFIG.momentum && x.stats.vol > CONFIG.volume && x.stats.rangePosition > CONFIG.rangePosition)
//     .sort((a, b) => b.stats.score - a.stats.score);

const ranked = CONFIG.symbols
    .map((symbol) => ({ symbol, stats: indicators(tickBooks.get(symbol) || []) }))
    .filter((x) => x.stats && x.stats.score >= CONFIG.confidence && Math.abs(x.stats.drift) < CONFIG.drift && Math.abs(x.stats.drift) > CONFIG.drift2 && Math.abs(x.stats.momentum5) < CONFIG.momentum && x.stats.rangePosition < CONFIG.rangePosition)
    .sort((a, b) => b.stats.score - a.stats.score);

if (!ranked.length) return;
  await openAccumulator(ranked[0]);
}

function hourTradeCount() {
  return ensureHour(gmtDateKey()).trades;
}

function nextStake() {
  const base = CONFIG.stake * (state.consecutiveLosses === 1 ? CONFIG.multiplier : state.consecutiveLosses === 2 ? CONFIG.multiplier2 : state.consecutiveLosses === 3 ? CONFIG.multiplier3 : 1);
  return Math.min(CONFIG.maxStake, Math.max(0.35, Number(base.toFixed(2))));
}

async function openAccumulator(candidate) {
  if (proposalPending) return;
  proposalPending = true;
  lastTradeAttempt = Date.now();
  const stake = nextStake();
  const analysis = candidate.stats;
  const growthRate = Math.max(0.01, Math.min(0.05, +(+CONFIG.growthRate).toFixed(4)));
  const symbolKey = _isPat ? 'underlying_symbol' : 'symbol';

  try {
    const pres = await api({
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: 'ACCU',
      currency: CONFIG.currency,
      [symbolKey]: candidate.symbol,
      growth_rate: growthRate,
    }, 20000);
    const p = pres.proposal;
    if (!p?.id) throw new Error('No proposal id returned');
    const bres = await api({ buy: p.id, price: p.ask_price }, 20000);
    const b = bres.buy;
    if (!b?.contract_id) throw new Error('Buy did not return contract_id');
    const contractId = b.contract_id;
    currentContract = {
      id: contractId,
      symbol: candidate.symbol,
      stake,
      openedAt: Date.now(),
      analysis,
      buyPrice: Number(b.buy_price || stake),
    };
    proposalPending = false;
    await notify(`📈 Trade opened\nSymbol: ${candidate.symbol}\nStake: ${stake} ${CONFIG.currency}\nGrowth: ${(growthRate * 100).toFixed(2)}%\nScore: ${analysis.score.toFixed(3)} Vol: ${analysis.vol.toExponential(2)}\nDrift: ${analysis.drift}\nMomentum: ${analysis.momentum5}\nRange: ${analysis.rangePosition}\nOverall P/L: ${state.overallProfit.toFixed(2)} ${CONFIG.currency}\nConsecutive losses: ${state.consecutiveLosses}`);
    await api({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
    startWatchdog(contractId);
  } catch (error) {
    console.error('Open trade failed:', error.message);
    await notify(`❌ Trade open failed: ${error.message}`);
    proposalPending = false;
  }
}

async function onContractUpdate(contract) {
  if (!currentContract || String(contract.contract_id) !== String(currentContract.id)) return;
  const bid = Number(contract.bid_price || contract.sell_price || 0);
  const pnl = bid - currentContract.buyPrice;
  const pnlPct = currentContract.buyPrice ? pnl / currentContract.buyPrice : 0;
  contractSubscriptionId = contract.id || contractSubscriptionId;

  if (contract.is_sold || contract.status === 'sold') {
    await finalizeTrade(contract, Number(contract.profit || pnl));
    return;
  }

  const ageSeconds = (Date.now() - currentContract.openedAt) / 1000;
  if (pnlPct >= CONFIG.targetProfitPct || pnlPct <= -CONFIG.stopLossPct || ageSeconds >= CONFIG.maxOpenSeconds) {
    try {
      await api({ sell: currentContract.id, price: 0 });
    } catch (error) {
      console.error('Sell failed:', error.message);
    }
  }
}

function startWatchdog(contractId) {
  clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(() => recoverStuckTrade(contractId), CONFIG.tradeWatchdogMs);
}

async function recoverStuckTrade(contractId) {
  if (!currentContract || String(currentContract.id) !== String(contractId)) return;
  const deadline = Date.now() + CONFIG.pollTimeoutMs;
  await notify(`⏱️ Watchdog triggered for contract ${contractId}. Polling settlement...`);
  while (Date.now() < deadline && currentContract) {
    try {
      const res = await api({ proposal_open_contract: 1, contract_id: contractId }, 10000);
      const contract = res.proposal_open_contract;
      if (contract && (contract.is_sold || contract.status === 'sold')) {
        await finalizeTrade(contract, Number(contract.profit || 0));
        return;
      }
      if (contract && contract.is_valid_to_sell) await api({ sell: contractId, price: 0 }, 10000).catch(() => {});
    } catch (error) {
      console.error('Watchdog poll error:', error.message);
    }
    await sleep(5000);
  }
  if (currentContract && String(currentContract.id) === String(contractId)) {
    state.stuckTrades.push({ ...currentContract, forcedRecoveredAt: new Date().toISOString() });
    await notify(`🧯 Forced recovery for stuck contract ${contractId}. Bot state cleared; verify contract manually in Deriv.`);
    currentContract = null;
    proposalPending = false;
    saveState();
  }
}

async function finalizeTrade(contract, profit) {
  clearTimeout(watchdogTimer);
  const dayKey = gmtDateKey();
  const day = ensureDay(dayKey);
  const hour = ensureHour(dayKey);
  const won = profit > 0;
  const trade = {
    contractId: contract.contract_id,
    symbol: currentContract.symbol,
    stake: currentContract.stake,
    profit,
    won,
    openedAt: new Date(currentContract.openedAt).toISOString(),
    closedAt: new Date().toISOString(),
    analysis: currentContract.analysis,
  };

  state.trades.push(trade);
  if (state.trades.length > 1000) state.trades = state.trades.slice(-1000);
  state.totalTrades += 1;
  state.overallProfit += profit;
  day.trades += 1; hour.trades += 1;
  day.profit += profit; hour.profit += profit;

  if (won) {
    state.wins += 1; day.wins += 1; hour.wins += 1;
    state.consecutiveLosses = 0; day.consecutiveLosses = 0;
    // CONFIG.confidence = CONFIG.confidence2;
  } else {
    state.losses += 1; day.losses += 1; hour.losses += 1;
    state.consecutiveLosses += 1; day.consecutiveLosses += 1;
    if (state.consecutiveLosses === 2) state.lossStreakBuckets.x2 += 1;
    if (state.consecutiveLosses === 3) state.lossStreakBuckets.x3 += 1;
    if (state.consecutiveLosses === 4) state.lossStreakBuckets.x4 += 1;
    if (day.consecutiveLosses === 2) day.lossStreakBuckets.x2 += 1;
    if (day.consecutiveLosses === 3) day.lossStreakBuckets.x3 += 1;
    if (day.consecutiveLosses === 4) day.lossStreakBuckets.x4 += 1;
    tradingPausedUntil = Date.now() + CONFIG.cooldownAfterLossMs * Math.min(state.consecutiveLosses, 4);
    // CONFIG.confidence += 0.05;
  }

  currentContract = null;
  proposalPending = false;
  saveState();
  await notify(formatTradeResult(trade, day));
}

function formatTradeResult(trade, day) {
  return `🏁 Trade result\nContract: ${trade.contractId}\nSymbol: ${trade.symbol}\nResult: ${trade.won ? 'WIN' : 'LOSS'}\nP/L: ${trade.profit.toFixed(2)} ${CONFIG.currency}\nDay P/L: ${day.profit.toFixed(2)} ${CONFIG.currency}\nDay W/L: ${day.wins}/${day.losses}\nOverall P/L: ${state.overallProfit.toFixed(2)} ${CONFIG.currency}\nConsecutive losses: ${state.consecutiveLosses}\nLoss streaks x2/x3/x4: ${state.lossStreakBuckets.x2}/${state.lossStreakBuckets.x3}/${state.lossStreakBuckets.x4}`;
}

function scheduleReports() {
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setUTCHours(nextHour.getUTCHours() + 1, 0, 0, 0);
  const msToNextHour = nextHour.getTime() - now.getTime();
  hourlyBootTimer = setTimeout(() => {
    sendHourlyReport();
    hourlyTimer = setInterval(() => sendHourlyReport(), 3600_000);
  }, msToNextHour);
  scheduleEndOfDayReport();
  console.log(`Hourly report: first in ${(msToNextHour / 60000).toFixed(1)}m, then every 60m`);
}

function scheduleEndOfDayReport() {
  clearTimeout(endDayTimer);
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5));
  endDayTimer = setTimeout(async () => {
    await sendEndOfDayReport();
    rolloverDayIfNeeded(true);
    scheduleEndOfDayReport();
  }, next.getTime() - now.getTime());
}

function money(n) {
  const x = Number(n || 0);
  return `${x >= 0 ? '+' : ''}${x.toFixed(2)} ${CONFIG.currency}`;
}
function pad(n) { return String(n).padStart(2, '0'); }

async function sendHourlyReport() {
  const now = new Date();
  const prev = new Date(now.getTime() - 3600_000);
  const hour = prev.getUTCHours();
  const date = prev.toISOString().slice(0, 10);
  const trades = (state.trades || []).filter(t => {
    const d = new Date(t.closedAt || t.openedAt);
    return d.getUTCHours() === hour && d.toISOString().slice(0, 10) === date;
  });
  const wins = trades.filter(t => t.won);
  const losses = trades.filter(t => !t.won);
  const total = trades.reduce((s, t) => s + Number(t.profit || 0), 0);
  const gw = wins.reduce((s, t) => s + Number(t.profit || 0), 0);
  const gl = Math.abs(losses.reduce((s, t) => s + Number(t.profit || 0), 0));
  const pf = gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);

  if (!trades.length) {
    await notify(`⏰ Hourly summary (${pad(hour)}:00 – ${pad(hour)}:59)\n\nNo trades this hour.`);
    return;
  }

  let msg =
    `⏰ Hourly Summary (${pad(hour)}:00 – ${pad(hour)}:59)\n\n` +
    `📊 Trades: ${trades.length}  ✅${wins.length}  ❌${losses.length}\n` +
    `📈 Win rate: ${trades.length ? ((wins.length / trades.length) * 100).toFixed(1) : 0}%\n` +
    `💰 P/L: ${money(total)}\n` +
    `🏆 Profit factor: ${pf === Infinity ? '∞' : pf.toFixed(2)}\n` +
    `📋 Detail:\n`;
  trades.forEach((t, i) => {
    const e = t.won ? '✅' : '❌';
    msg += `  ${i + 1}. ${e} #${t.contractId} ${t.symbol} ${money(t.profit)}\n`;
  });
  await notify(msg);
}

async function sendEndOfDayReport() {
  const lines = ['🌙 End of Trade Day report (GMT)'];
  for (const date of Object.keys(state.days).sort()) {
    const d = state.days[date];
    lines.push(`${date}: trades=${d.trades}, W/L=${d.wins}/${d.losses}, P/L=${d.profit.toFixed(2)} ${CONFIG.currency}, streak x2/x3/x4=${d.lossStreakBuckets.x2}/${d.lossStreakBuckets.x3}/${d.lossStreakBuckets.x4}`);
  }
  lines.push(`Overall P/L: ${state.overallProfit.toFixed(2)} ${CONFIG.currency}`);
  await notify(lines.join('\n'));
}

function rolloverDayIfNeeded(force = false) {
  const today = gmtDateKey();
  if (force || state.activeDay !== today) {
    ensureDay(today);
    state.activeDay = today;
    saveState();
  }
}

async function notify(text) {
  console.log(text);
  if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) return;
  try {
    const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CONFIG.telegramChatId, text, disable_web_page_preview: true }),
    });
    if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
  } catch (error) {
    console.error('Telegram notification failed:', error.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on('SIGINT', async () => {
  saveState();
  await notify('🛑 Bot stopped by SIGINT. State saved.');
  process.exit(0);
});
process.on('uncaughtException', async (error) => {
  console.error('Uncaught exception:', error);
  saveState();
  await notify(`🔥 Uncaught exception: ${error.message}`);
});
process.on('unhandledRejection', async (error) => {
  console.error('Unhandled rejection:', error);
  await notify(`🔥 Unhandled rejection: ${error.message || error}`);
});

if (!CONFIG.token) {
  console.error('DERIV_TOKEN is required. Create an API token in Deriv, then run: DERIV_TOKEN=... npm start');
  process.exit(1);
}
ensureDay();
scheduleReports();
connect();
