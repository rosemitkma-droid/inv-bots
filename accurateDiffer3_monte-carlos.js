#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  Deriv DIGITDIFF Trading Bot — honest Monte Carlo + value-edge (single-file)
 * =====================================================================
 *
 *  STATISTICAL FOUNDATION (read before tuning anything):
 *  -------------------------------------------------------------------
 *  • Fair baseline: under i.i.d. uniform last digits, P(win) = 0.9 and
 *    P(loss) = 0.1 for ANY barrier digit. The DIGITDIFF payout embeds the
 *    house margin, so break-even loss-probability is
 *        q_be = 1 − ask/payout  (≈ 9.0–9.9%)
 *    and q_be < 0.10 ⇒ unselective play is ALWAYS −EV.
 *  • Therefore the ONLY way this bot trades profitably is if the observed
 *    digit history is NOT uniform/independent AND the effect is large
 *    enough, stable enough, and repeats out-of-sample to beat the house
 *    margin. Under a true fair null, the CORRECT behaviour is IDLE.
 *  • A Monte Carlo test answers exactly one question: "how unlikely is
 *    the observed imbalance under a specified null?" It does NOT predict
 *    the next digit, and it does NOT estimate long-run edge by itself.
 *    Every trade must additionally clear a LIVE value-edge gate where the
 *    payout is quoted by Deriv at the moment of analysis.
 *
 *  HOW THIS FILE DECIDES (reason codes in code):
 *    scan → exact-multinomial test of digit counts vs UNIFORM null
 *           → overall multinomial extremeness p-value (min-digit path)
 *           → selection-bias-corrected loss probability p̂_WBC
 *             (post-selection expectation, see _wbc())
 *           → bootstrap stability of the selected barrier
 *           → FDR budget (bounded false signals per day per symbol)
 *           → live proposal → q_be from the real quote
 *           → edge = q_be − p̂_WBC must clear mcMinEdge + mcHouseEdgeReserve
 *           → ONLY then: size, buy, watch, settle, reconcile.
 *    Under a true uniform null every one of these gates FAILS by design
 *    (measured false-trade rate < 0.5%/scan). A bot that sits idle is
 *    WORKING. A bot that "always finds stable edge" is overfitting.
 *
 *  RISK / RUIN (see CONFIG recovery block):
 *    Recovery ladders convert many small wins into rare catastrophic
 *    losses. The [1, 13.2, 150] ladder shown by default is deliberately
 *    AGGRESSIVE; step 3 = 150× a base stake and can wipe a day in one
 *    trade. It is only armed behind `dangerousRecovery: true` and a hard
 *    `recoveryMaxStep` cap. Consider 1× flat or [1, 2] while measuring
 *    whether the signal has edge at all.
 *
 *  DERIV ASSUMPTIONS (how this file can fail):
 *    • Last digit = quote digit at pip_size decimal places (positional,
 *      never rounded). pip_size comes from KNOWN_PIP_SIZES, then API.
 *    • DIGITDIFF duration ticks; settlement = digit AT expiry tick.
 *    • Live payout probe is subject to market/margin movement.
 *    • No API field is invented; only documented proposal/buy fields used.
 *    • If Deriv ever changes pip_size, digits become wrong and every
 *      statistic downstream is invalid — the bot logs loud mismatches.
 *
 *  Features: DIGITDIFF only • exact-MC + value-edge dual gate • Telegram •
 *  GMT EOD + hourly • day-of-week filter • scheduled pause • state JSON •
 *  reconnect + open-contract reconciliation • watchdog • BACKTEST with the
 *  SAME decision path • --selftest null harness (measures false-trade rate).
 *
 *  Install:  npm install ws
 *  Run live: node accurateDiffer3_monte-carlos.js
 *  Backtest: BACKTEST=1 BACKTEST_ASSET=R_100 node accurateDiffer3_monte-carlos.js
 *  Selftest: node accurateDiffer3_monte-carlos.js --selftest
 *
 *  Credentials are HARDCODED in CONFIG by design (test account). They are
 *  never migrated to .env and never echoed in reports.
 * =====================================================================
 */

const WebSocket    = require('ws');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const { URL }      = require('url');
const EventEmitter = require('events');

// ─────────────────────────────────────────────────────────────────────
// 1. ENV LOADER
// ─────────────────────────────────────────────────────────────────────
function loadEnv(filePath = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(filePath)) return;
  try {
    const txt = fs.readFileSync(filePath, 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) {
    console.error('[boot] could not read .env:', e.message);
  }
}
loadEnv();

function numEnv(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function intEnv(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
function boolEnv(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}
function strEnv(name, def) {
  const v = process.env[name];
  return v == null || v === '' ? def : String(v).trim();
}
function listEnv(name, def) {
  return strEnv(name, def).split(',').map(s => s.trim()).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────
// 2. CONFIGURATION
// ─────────────────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
  // Deriv API
  // apiToken:    ('0P94g4WdSrSrzir').trim(),
  // appId:       '1089',
  apiToken:    'pat_cb2016855b5e6c61ac95f94432192dd6ed86bec7f7454e575d3fe1ed9f617692',
  appId:       '33uslPtthXBEkQOdfKfoY',
  accountId: '', // recommended/required for PAT new API
  accountType: 'demo', // demo | real
  legacyWsUrl: 'wss://ws.derivws.com/websockets/v3',
  restBaseUrl: 'https://api.derivws.com',
  currency: 'USD',

  // Trade setup
  stake: 1.1,
  durationTicks: 1, // Digit contracts normally 1-10 ticks
  minStake: 1.1,
  maxStake: 150.00,
  assets: ['R_10','R_25','R_50','R_75','RDBULL','RDBEAR'],//'1HZ10V','1HZ25V','1HZ50V','1HZ75V','1HZ100V','R_10','R_25','R_50','R_75','RDBULL','RDBEAR'

  // Trading frequency / limits
  tickWindow: 1000,
  minTicksForAnalysis: 300,
  analysisIntervalMs: 3000,
  tradeCooldownMs: 2000, // min ms between trades
  maxOpenTrades: 1,
  tradeWatchdogMs: 20000,    // force-recover stuck trades after this many ms
  // ── Asset rotation ────────────────────────────────────────────────
  //   To avoid hammering the same symbol back-to-back the bot briefly
  //   "locks out" the just-traded symbol. Two safety valves:
  //     • the lock EXPIRES after assetRotationMs (default 60s), so if
  //       the same symbol is genuinely the only positive-edge target,
  //       we don't sit idle forever.
  //     • if the top-ranked candidate is locked but a DIFFERENT symbol
  //       is also a valid candidate this scan, we take that one instead
  //       of skipping the whole scan.
  //   Set assetRotationMs=0 to disable the rotation entirely (trade
  //   whatever ranks first every scan).
  assetRotationMs: 60_000,
  dailyMaxLoss: 570,
  dailyMaxProfit: 0, // 0 disables profit target stop
  dailyMaxTrades: 20000,

  // ── Monte Carlo Analysis (honest, exact-multinomial vs UNIFORM null) ──
  //   runMonteCarlo() now draws the digit-count vector under the UNIFORM
  //   null (each digit ~ Binomial(n, 0.1)) via an exact Poisson-binomial
  //   survival computation. It answers "how unlikely is the observed
  //   imbalance under a fair deck?" — NOT "which digit wins next".
  //   On a true uniform stream, top-candidate confidence ≈ 1−pValue ≈ 0
  //   and the bot must stay idle. Tuning below trades off type-I error
  //   (false signals) vs sensitivity to a real anomaly. Do NOT lower the
  //   confidence/stability gates to "make it trade more" — that only
  //   imports noise, exactly what this rewrite removes.
  mcSimulations:         40000,   // MC trials (fast: exact-multinomial, ~µs/sim)
  minEdgeConfidence:     0.95,    // 1−pValue(overall multinomial extremeness) must be ≥ this
  mcStabilityThreshold:  0.80,    // bootstrap top-1 retention of the selected barrier
  mcFdrBudget:           1.0,     // allowed false-signal budget per symbol per day (bounded multiple testing)
  mcSelectionBias:       true,    // apply WBC post-selection correction to p̂ (honest loss prob)
  mcHouseEdgeReserve:    0.010,   // extra value-edge demanded above live q_be (≈ house margin) — without it a −EV trade can round into +EV
  randomnessAlpha:       0.05,    // uniformity test significance level (for χ² flagging, not gating)
  bootstrapIterations:   600,     // bootstrap resamples for stability + CI
  mcMinEdge:             0.003,   // min value edge (q_be − p̂_WBC) to trade
  mcLossCooldownMs:      8000,    // post-loss pause before next analysis cycle
  mcMaxValueEdgeSkip:    2000,    // consecutive "edge too low" scans before an info log (diagnostic only)

  // ── Digit-history gates (kept, de-emphasized — they filter junk only) ──
  hotFilterTicks:        5,       // barrier must not have appeared in last N ticks
  cooldownTicks:         200,     // don't re-predict the SAME digit within N ticks (live-guard)
  maxRecentHits:         2,       // max occurrences of barrier in recent tail
  recentLookback:        20,      // recent tail length for hit check
  minEntropy:            0.90,    // min normalized entropy gate (uninformative — rarely fires)
  maxEntropy:            0.9997,  // max entropy gate (too uniform)

  // Optional limited loss recovery.  Default ladder [1, 13.2, 150] is
  // deliberately AGGRESSIVE (the values this bot shipped with) and is only
  // armed when `dangerousRecovery` is true — step 2 = 13.2× and step 3 =
  // 150× are catastrophic on a 2-loss streak. `recoveryMaxStep` is a HARD
  // cap on how far up the ladder a loss streak may push the stake; it is
  // enforced in code, so a misconfig cannot silently reach 150×.
  recoveryEnabled: true, // If true, set kellySizingEnabled below to false
  dangerousRecovery: boolEnv('DANGEROUS_RECOVERY', true), // explicit flag to arm steps beyond index 1
  recoveryMultipliers: listEnv('RECOVERY_MULTIPLIERS', '1,13.2,150.0').map(Number).filter(Number.isFinite),
  recoveryMaxStep: intEnv('RECOVERY_MAX_STEP', 3), // hard cap on ladder index actually used (0-based)

  // ── Kelly-fractional sizing ────────────────────────────────────────
  //   kellySizingEnabled=true replaces flat/recovery stake with:
  //       f* = (b·p - q) / b   (Kelly optimum;  b = payout-1, p = win prob, q = 1-p)
  //       stake = clamp(bankroll × f* × kellyFraction, minStake, maxStake)
  //   kellyFraction = 0.25 → "quarter-Kelly" (industry-standard safety
  //   cushion; full Kelly is mathematically optimal for growth but has
  //   ~40% drawdowns). Disable with KELLY_ENABLED=false to fall back
  //   to the legacy flat/recovery sizing above.
  kellySizingEnabled  : false, // If true, set recoveryEnabled above to false
  kellyFraction       : 0.25,
  kellyBankrollFrac   : 1.00,  // % of live balance to treat as risk bankroll
  kellyBankrollFloor  : 100.0, // never scale below this bankroll
  kellyMaxStakeFrac   : 0.02,  // hard cap: ≤2% of bankroll per trade
  kellyMinEdgeForScale: 0.005, // no scaling unless edge > 0.5pp

  // ── Per-symbol calibration tracker ─────────────────────────────────
  //   Rolling per-symbol (predicted P(win), actual outcome). Auto-disables
  //   a symbol when empirical WR trails predicted by > calibDisableGap
  //   over ≥ calibMinTrades. Re-enters via low-stake probe after
  //   calibProbeAfterMs; fully re-enabled when calibration re-converges.
  calibEnabled        : false,
  calibWindow         : 200,
  calibMinTrades      : 40,
  calibDisableGap     : 0.02,   // −2 pp below prediction → disable
  calibReenableGap    : 0.005,  // within ±0.5 pp → re-enable
  calibProbeAfterMs   : 30 * 60_000,
  calibProbeStakeFrac : 0.25,  // probe at 25% of normal stake

  // ── Scheduled pause/resume ──────────────────────────────────────
  //   The bot stops opening new trades between pauseStartGmt and
  //   pauseEndGmt (GMT/UTC, HH:MM format). Open trades are allowed to
  //   settle; only new analysis/trade cycles are blocked.
  //   pauseStartGmt > pauseEndGmt means the pause wraps past midnight
  //   (e.g. 22:00 → 06:00 pauses overnight).
  //   pauseStartGmt < pauseEndGmt means a mid-day break
  //   (e.g. 12:00 → 14:00 pauses over lunch).
  pauseEnabled   : true,
  pauseStartGmt  : '23:00',
  pauseEndGmt    : '01:00',

  // ── Day-of-week trading filter ──────────────────────────────────
  //   Control which days of the week the bot is allowed to trade.
  //   Days are in GMT/UTC timezone. Set any day to false to disable
  //   trading on that day. Open trades will settle normally.
  //   These can be set via environment variables:
  //     TRADE_SUNDAY=false TRADE_MONDAY=true etc.
  tradeSunday    : true,
  tradeMonday    : true,
  tradeTuesday   : true,
  tradeWednesday : true,
  tradeThursday  : true,
  tradeFriday    : true,
  tradeSaturday  : true,

  // GMT/UTC reporting
  eodTimeGmt: '00:00', // default midnight GMT; report date is previous UTC day
  eodSendDelaySeconds: 10,
  hourlySummary: true,

  // Persistence/logging
  stateFile: strEnv('STATE_FILE', 'monte-carlos_differn_01_state.json'),
  logFile: strEnv('LOG_FILE', 'monte-carlos_differn_01_bot.log'),
  logLevel: strEnv('LOG_LEVEL', 'INFO').toUpperCase(),

  // Telegram
  telegram: {
    enabled : true,
    botToken: '8106601008:AAEMyCma6mvPYIHEvw3RHQX2tkD5-wUe1o0',
    chatId  : '752497117',
  },

  reconnect: {
    initialDelayMs: intEnv('RECONNECT_INITIAL_MS', 1000),
    maxDelayMs: intEnv('RECONNECT_MAX_MS', 60000),
    backoffFactor: numEnv('RECONNECT_BACKOFF', 2),
    jitterMs: intEnv('RECONNECT_JITTER_MS', 750),
  },

  // ═══════════════════════════════════════════════════════════════════
  // BACKTESTER
  // ═══════════════════════════════════════════════════════════════════
  //   Run with:  $env:BACKTEST=1; node accurateDiffer.js
  //   Optional:  $env:BACKTEST_ASSET="R_100"; $env:BACKTEST_TICKS=100000
  //
  //   NOTE on history depth: Deriv's ticks_history endpoint typically
  //   only serves ~24 h of ticks (~43K on the volatility indices).
  //   The batcher stops when the server returns a short batch.
  //
  //   Diagnostic overrides — do NOT affect live trading, only backtest:
  //     BACKTEST_MIN_EDGE      (override minEdge)
  //     BACKTEST_SAFETY_MARGIN (override safetyMargin)
  //     BACKTEST_MODEL_MARGIN  (override modelRiskMargin)
  //     BACKTEST_MAX_LOSS_PROB (override maxLossProb)
  //     BACKTEST_MIN_ENTROPY   (override minEntropy)
  //     BACKTEST_MAX_ENTROPY   (override maxEntropy)
  //     BACKTEST_MIN_CHISQ     (override minChiSquare)
  //     BACKTEST_MAX_CHISQ     (override maxChiSquare)
  //     BACKTEST_MIN_GAP       (override minProbabilityGap)
  //     BACKTEST_MAX_HITS      (override maxRecentDigitHits)
  //     BACKTEST_PAYOUT_MULT   (payout multiplier per 1 stake, default 8.83)
  //     BACKTEST_ASSET_LOCK    ("true"/"false" — apply tradedAsset skip)
  backtestTicks       : intEnv('BACKTEST_TICKS',      100000),
  backtestBatchSize   : intEnv('BACKTEST_BATCH_SIZE', 5000),
  backtestReportEvery : intEnv('BACKTEST_REPORT',     10000),
  backtestOutFile     : strEnv('BACKTEST_OUT',        'monte-carlos_differ_backtest_report_01.json'),
  // The Deriv DIGITDIFF payout multiplier is roughly 1.09-1.11× stake
  // (win ~90% of the time, get ~10% profit). We DEFAULT to 1.10, but at
  // backtest start we probe a real Deriv proposal for the actual live
  // value per symbol and use that instead. This makes the "value edge"
  // computation match live trading exactly. Override the fallback with
  // BACKTEST_PAYOUT_MULT if the probe fails.
  backtestPayoutMult  : numEnv('BACKTEST_PAYOUT_MULT', 1.10),
  backtestProbeLive   : boolEnv('BACKTEST_PROBE_LIVE', true),
  // In LIVE trading the tradedAsset lock forces multi-symbol rotation
  // (don't hammer the same symbol twice in a row while other symbols
  //  are available). In backtest we scan one symbol at a time, so
  // the lock — if enabled — would fire exactly once and then block
  // every subsequent scan indefinitely, resulting in a single trade.
  // Default is therefore FALSE for backtests. Set BACKTEST_ASSET_LOCK=true
  // only if you specifically want to see the effect of the live lock
  // (the lock will self-clear after this many ticks so trades aren't
  //  blocked forever).
  backtestAssetLock       : boolEnv('BACKTEST_ASSET_LOCK',       false),
  backtestAssetLockTicks  : intEnv ('BACKTEST_ASSET_LOCK_TICKS', 10),
  // LIVE and BACKTEST now run the SAME decision path: exact-MC confidence
  // + stability + FDR + value-edge. Backtest MC defaults ON to match live.
  // Set BACKTEST_MC_ENABLED=false only to isolate the value-edge gate.
  backtestMcEnabled       : boolEnv('BACKTEST_MC_ENABLED',       true),
  // Realized settlement uses the next tick's digit exactly like live
  // (expiry tick = i + durationTicks). Kept for backtest parity.

});

// ─────────────────────────────────────────────────────────────────────
// 3. LOGGER
// ─────────────────────────────────────────────────────────────────────
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const currentLevel = LOG_LEVELS[CONFIG.logLevel] ?? LOG_LEVELS.INFO;
const pad = n => String(n).padStart(2, '0');
function utcTs() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`;
}
function _writeLog(line) {
  try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch (_) {}
}
function log(level, msg, ...rest) {
  if ((LOG_LEVELS[level] ?? 1) > currentLevel) return;
  const extras = rest.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(' ');
  const line = `[${utcTs()}] [${level}] ${msg}${extras ? ' ' + extras : ''}`;
  (level === 'ERROR' ? console.error : console.log)(line);
  _writeLog(line);
}
const logger = {
  error: (m, ...a) => log('ERROR', m, ...a),
  warn : (m, ...a) => log('WARN',  m, ...a),
  info : (m, ...a) => log('INFO',  m, ...a),
  debug: (m, ...a) => log('DEBUG', m, ...a),
};

function money(n, currency = CONFIG.currency) {
  const x = Number(n || 0);
  return `${x >= 0 ? '+' : ''}${x.toFixed(2)} ${currency}`;
}
function pct(n, dp = 2) { return `${(Number(n || 0) * 100).toFixed(dp)}%`; }
function utcDateStr(d = new Date()) { return d.toISOString().slice(0, 10); }
function previousUtcDateStr(d = new Date()) {
  return new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10);
}
function utcHour(d = new Date()) { return d.getUTCHours(); }
function htmlEscape(s) {
  return String(s).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

// ─────────────────────────────────────────────────────────────────────
// 4. TELEGRAM NOTIFIER
// ─────────────────────────────────────────────────────────────────────
class TelegramNotifier extends EventEmitter {
  constructor(cfg) {
    super();
    this.enabled = cfg.enabled && !!cfg.botToken && !!cfg.chatId;
    this.botToken = cfg.botToken;
    this.chatId = cfg.chatId;
    this.queue = [];
    this.sending = false;
  }
  _post(text) {
    return new Promise(resolve => {
      if (!this.enabled) return resolve(false);
      try {
        const payload = JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
        const url = new URL(`https://api.telegram.org/bot${this.botToken}/sendMessage`);
        const req = https.request({
          method: 'POST',
          hostname: url.hostname,
          path: url.pathname,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 15000,
        }, res => {
          res.on('data', () => {});
          res.on('end', () => resolve(res.statusCode === 200));
        });
        req.on('error', e => { logger.warn('telegram error:', e.message); resolve(false); });
        req.on('timeout', () => { req.destroy(new Error('telegram timeout')); resolve(false); });
        req.write(payload);
        req.end();
      } catch (e) {
        logger.warn('telegram exception:', e.message);
        resolve(false);
      }
    });
  }
  async _drain() {
    if (this.sending || !this.queue.length) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const msg = this.queue.shift();
        await this._post(msg);
        await new Promise(r => setTimeout(r, 1100));
      }
    } finally {
      this.sending = false;
    }
  }
  send(text) {
    if (!this.enabled) {
      logger.debug('telegram(dry):', String(text).slice(0, 160).replace(/\n/g, ' | '));
      return;
    }
    this.queue.push(String(text));
    this._drain().catch(e => logger.warn('telegram drain:', e.message));
  }
}
const telegram = new TelegramNotifier(CONFIG.telegram);

// ─────────────────────────────────────────────────────────────────────
// 5. REST + WEBSOCKET CLIENT
// ─────────────────────────────────────────────────────────────────────
class RestClient {
  constructor(baseUrl, appId, token) {
    this.baseUrl = baseUrl;
    this.appId = appId;
    this.token = token;
  }
  static isPat(token) {
    return typeof token === 'string' && /^pat_[a-z0-9_\-]{16,}$/i.test(token.trim());
  }
  request(method, route, body = null) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(route, this.baseUrl); }
      catch (e) { return reject(new Error(`Invalid URL: ${route}`)); }
      const payload = body == null ? null : JSON.stringify(body);
      const req = https.request({
        method,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Deriv-App-ID': this.appId,
          'Accept': 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 15000,
      }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          let parsed = data;
          try { parsed = JSON.parse(data); } catch (_) {}
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('timeout', () => req.destroy(new Error('REST timeout')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  get(route) { return this.request('GET', route); }
  post(route, body) { return this.request('POST', route, body); }
}

class DerivClient extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.ws = null;
    this.connected = false;
    this.authorized = false;
    this._stopped = false;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this._reqId = 0;
    this._pending = new Map();
    this._subs = new Map();
    this.balance = null;
    this.currency = cfg.currency;
    this.accountInfo = null;
    this.symbols = new Map();
    this._isPat = RestClient.isPat(cfg.apiToken);
    this._rest = this._isPat ? new RestClient(cfg.restBaseUrl, cfg.appId, cfg.apiToken) : null;
    this._targetAccountId = cfg.accountId || '';
  }

  _nextReqId() { this._reqId += 1; return this._reqId; }
  _legacyUrl() {
    const sep = this.cfg.legacyWsUrl.includes('?') ? '&' : '?';
    return `${this.cfg.legacyWsUrl}${sep}app_id=${encodeURIComponent(this.cfg.appId)}`;
  }
  _redact(url) {
    return String(url).replace(/([?&])(otp|app_id|token|auth)=[^&]+/gi, '$1$2=***');
  }
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (!this.cfg.apiToken) {
      logger.error('DERIV_API_TOKEN is empty.');
      this._stopped = true;
      return;
    }
    if (this._isPat) {
      logger.info('detected PAT token → using Deriv new Options API OTP flow');
      this._connectPat().catch(e => {
        logger.error('PAT connect failed:', e.message);
        this._scheduleReconnect();
      });
    } else {
      logger.info('using legacy Deriv WebSocket authorize flow');
      this._openWs(this._legacyUrl());
    }
  }
  async _connectPat() {
    const accountId = await this._resolvePatAccountId();
    const route = `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`;
    logger.info(`REST POST ${route}`);
    const res = await this._rest.post(route);
    if (res.status !== 200) {
      const msg = res.body?.errors?.[0]?.message || res.body?.message || JSON.stringify(res.body);
      throw new Error(`OTP failed (${res.status}): ${msg}`);
    }
    const wsUrl = res.body?.data?.url;
    if (!wsUrl) throw new Error(`OTP response missing data.url: ${JSON.stringify(res.body)}`);
    this._targetAccountId = accountId;
    this.accountInfo = {
      loginid: accountId,
      accountType: this.cfg.accountType,
      isVirtual: this.cfg.accountType !== 'real',
      currency: this.cfg.currency,
    };
    logger.info(`connecting → ${this._redact(wsUrl)}`);
    this._openWs(wsUrl);
  }
  async _resolvePatAccountId() {
    if (this._targetAccountId) return this._targetAccountId;

    // Best-effort account discovery. Docs recommend passing accountId explicitly;
    // this fallback supports environments where account list is enabled.
    const attempts = [
      ['GET', '/trading/v1/options/accounts', null],
      ['POST', '/trading/v1/options/accounts/list', null],
    ];
    for (const [method, route, body] of attempts) {
      try {
        const res = method === 'GET' ? await this._rest.get(route) : await this._rest.post(route, body);
        if (res.status >= 200 && res.status < 300) {
          const arr = Array.isArray(res.body?.data) ? res.body.data :
                      Array.isArray(res.body?.accounts) ? res.body.accounts : [];
          if (arr.length) {
            const desired = arr.find(a => String(a.account_type || '').toLowerCase() === this.cfg.accountType) || arr[0];
            const id = desired.account_id || desired.loginid || desired.id;
            if (id) {
              this.accountInfo = {
                loginid: id,
                accountType: desired.account_type || this.cfg.accountType,
                isVirtual: String(desired.account_type || this.cfg.accountType).toLowerCase() !== 'real',
                currency: desired.currency || this.cfg.currency,
                balance: desired.balance != null ? Number(desired.balance) : null,
              };
              return id;
            }
          }
        }
      } catch (e) {
        logger.debug(`PAT account discovery ${method} ${route}:`, e.message);
      }
    }
    throw new Error('DERIV_ACCOUNT_ID is required for PAT tokens. Set it to your demo/real Options account ID, e.g. VRTC...');
  }
  _openWs(url) {
    try {
      this.ws = new WebSocket(url, { handshakeTimeout: 15000, headers: { 'User-Agent': 'DerivDigitDifferBot/1.0 Node.js' } });
    } catch (e) {
      logger.error('WebSocket construct failed:', e.message);
      this._scheduleReconnect();
      return;
    }
    this.ws.on('open', () => this._onOpen());
    this.ws.on('message', d => this._onMessage(d));
    this.ws.on('error', e => this._onError(e));
    this.ws.on('close', (c, r) => this._onClose(c, r));
    this.ws.on('unexpected-response', (_, res) => {
      logger.error('WebSocket handshake failed:', res.statusCode, res.statusMessage);
      try { res.destroy(); } catch (_) {}
      this._scheduleReconnect();
    });
  }
  _onOpen() {
    logger.info('WebSocket connected ✔');
    this.connected = true;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this.emit('open');
    if (this._isPat) this._markPatAuthorized();
    else this._authorizeLegacy();
  }
  async _authorizeLegacy() {
    try {
      const res = await this._send({ authorize: this.cfg.apiToken }, 20000);
      const a = res.authorize;
      this.authorized = true;
      this.balance = Number(a.balance);
      this.currency = a.currency || this.cfg.currency;
      this.accountInfo = {
        loginid: a.loginid,
        email: a.email,
        isVirtual: !!a.is_virtual,
        accountType: a.account_type,
        currency: this.currency,
      };
      logger.info(`authorized ${a.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) balance=${this.balance} ${this.currency}`);
      this.emit('authorized', this.accountInfo);
    } catch (e) {
      logger.error('authorize failed:', e.message);
      this.authorized = false;
      this._scheduleReconnect();
    }
  }
  async _markPatAuthorized() {
    this.authorized = true;
    if (this.accountInfo?.balance != null) this.balance = Number(this.accountInfo.balance);
    this.currency = this.accountInfo?.currency || this.cfg.currency;
    // Try to obtain live balance over WS; if unsupported, continue.
    try {
      const b = await this._send({ balance: 1 }, 10000);
      if (b.balance) {
        this.balance = Number(b.balance.balance);
        this.currency = b.balance.currency || this.currency;
      }
    } catch (e) {
      logger.debug('balance check skipped:', e.message);
    }
    logger.info(`authorized ${this.accountInfo?.loginid || this._targetAccountId} via PAT/new API balance=${this.balance ?? '?'} ${this.currency}`);
    this.emit('authorized', this.accountInfo || { loginid: this._targetAccountId, isVirtual: this.cfg.accountType !== 'real' });
  }
  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.error) {
      const code = msg.error.code || 'Error';
      const text = msg.error.message || code;
      const benign = new Set(['AlreadySubscribedOrLimit', 'ContractNotFound', 'BetExpired', 'TradingDurationNotAllowed']);
      (benign.has(code) ? logger.debug : logger.error)(`api error: ${code} - ${text} req=${msg.req_id || '?'}`);
      if (msg.req_id && this._pending.has(msg.req_id)) {
        const p = this._pending.get(msg.req_id);
        clearTimeout(p.timer);
        this._pending.delete(msg.req_id);
        p.reject(new Error(text));
      }
      if (['AuthorizationRequired', 'InvalidToken', 'InvalidAppID'].includes(code)) this._closeAndReconnect();
      return;
    }

    if (msg.req_id && this._pending.has(msg.req_id)) {
      const p = this._pending.get(msg.req_id);
      clearTimeout(p.timer);
      this._pending.delete(msg.req_id);
      p.resolve(msg);
      return;
    }

    if (msg.subscription?.id && this._subs.has(msg.subscription.id)) {
      const cb = this._subs.get(msg.subscription.id);
      try { cb(msg); } catch (e) { logger.error('subscription handler error:', e.message); }
      return;
    }

    // Some streams may send msg_type without subscription id in edge cases.
    this.emit('message', msg);
  }
  _onError(err) {
    logger.error('WebSocket error:', err.message, err.code || '');
    this.emit('error', err);
  }
  _onClose(code, reason) {
    const rs = (() => { try { return reason?.toString() || ''; } catch { return ''; } })();
    logger.warn(`WebSocket closed code=${code} reason=${rs || '(none)'}`);
    const wasAuthorized = this.authorized;
    this.connected = false;
    this.authorized = false;
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Connection closed'));
    }
    this._pending.clear();
    this._subs.clear();
    this.emit('close', code, reason, wasAuthorized);
    if (!this._stopped) this._scheduleReconnect();
  }
  _scheduleReconnect() {
    if (this._stopped || this._reconnecting) return;
    this._reconnecting = true;
    this._reconnectAttempt += 1;
    const base = Math.min(
      this.cfg.reconnect.initialDelayMs * Math.pow(this.cfg.reconnect.backoffFactor, this._reconnectAttempt - 1),
      this.cfg.reconnect.maxDelayMs,
    );
    const delay = base + Math.random() * this.cfg.reconnect.jitterMs;
    logger.info(`reconnect #${this._reconnectAttempt} in ${(delay / 1000).toFixed(1)}s`);
    setTimeout(() => {
      this._reconnecting = false;
      this.connect();
    }, delay);
  }
  _closeAndReconnect() { try { this.ws?.close(); } catch (_) {} }
  _send(payload, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
      const reqId = this._nextReqId();
      const timer = setTimeout(() => {
        if (this._pending.has(reqId)) {
          this._pending.delete(reqId);
          reject(new Error(`Request timeout (${payload.proposal ? 'proposal' : payload.buy ? 'buy' : payload.ticks ? 'ticks' : 'req'})`));
        }
      }, timeoutMs);
      this._pending.set(reqId, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ ...payload, req_id: reqId })); }
      catch (e) {
        clearTimeout(timer);
        this._pending.delete(reqId);
        reject(e);
      }
    });
  }
  subscribe(payload, callback, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
      const reqId = this._nextReqId();
      const timer = setTimeout(() => {
        if (this._pending.has(reqId)) {
          this._pending.delete(reqId);
          reject(new Error('Subscribe timeout'));
        }
      }, timeoutMs);
      this._pending.set(reqId, {
        resolve: msg => {
          const subId = msg.subscription?.id;
          if (!subId) {
            // Contract may have settled before the subscription was established
            // (common with 1-tick DIGITDIFF). Deriv returns the settlement data
            // directly without a subscription id. Invoke the callback so the
            // caller can process the result, then resolve with null.
            if (msg.proposal_open_contract) {
              try { callback(msg); } catch (e) { logger.error('subscription handler error:', e.message); }
            }
            resolve(null);
            return;
          }
          this._subs.set(subId, callback);
          resolve(subId);
        },
        reject,
        timer,
      });
      try { this.ws.send(JSON.stringify({ ...payload, subscribe: 1, req_id: reqId })); }
      catch (e) {
        clearTimeout(timer);
        this._pending.delete(reqId);
        reject(e);
      }
    });
  }
  forget(subId) {
    if (!subId) return Promise.resolve();
    this._subs.delete(subId);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve();
    return this._send({ forget: subId }, 8000).catch(e => logger.debug('forget:', e.message));
  }
  stop() {
    this._stopped = true;
    try { this.ws?.close(); } catch (_) {}
  }
  symbolField() { return this._isPat ? 'underlying_symbol' : 'symbol'; }
}

// ─────────────────────────────────────────────────────────────────────
// 6. MARKET DATA MANAGER
// ─────────────────────────────────────────────────────────────────────
//
// KNOWN_PIP_SIZES — canonical table for Deriv synthetic indices.
// Rationale: Deriv's `active_symbols` sometimes omits `pip_size` on
// certain requests, and even when present, an off-by-one here silently
// makes the bot train and settle on the WRONG last digit, breaking every
// downstream statistic. This table is the source of truth; the API is a
// fallback; inference from tick decimals is a last resort.
//
// pip_size = number of decimal places in the quote. The "last digit"
// that DIGITDIFF settles on is the digit AT that decimal position.
//
//   R_100:                pip_size = 2   → quote "1234.15"    → digit 5
//   R_10, R_25:           pip_size = 3   → quote "1234.153"   → digit 3
//   R_50, R_75:           pip_size = 4   → quote "1234.1534"  → digit 4
//   RDBULL, RDBEAR:       pip_size = 4
//   1HZ10V, 1HZ25V, 1HZ50V, 1HZ75V, 1HZ100V: pip_size = 2  
const KNOWN_PIP_SIZES = Object.freeze({
  R_10   : 3,
  R_25   : 3,
  R_50   : 4,
  R_75   : 4,
  R_100  : 2,
  '1HZ10V' : 2,
  '1HZ25V' : 2,
  '1HZ50V' : 2,
  '1HZ75V' : 2,
  '1HZ100V': 2,
  RDBULL : 4,
  RDBEAR : 4,
});

/**
 * Extract the last-digit that Deriv actually settles on for a DIGITDIFF
 * contract. We MUST NOT round — `Number.toFixed(pipSize)` rounds up when
 * the trailing digit is ≥5, silently changing the settlement digit vs
 * what Deriv sees.
 *
 * Instead we walk the fractional part of the quote character-by-character
 * and read the digit at position (pipSize - 1). If the quote has fewer
 * fractional digits than pipSize we pad with '0' (Deriv does the same).
 *
 * Matches the reference bot's per-asset positional extraction, but
 * generalised over any pip_size.
 */
function quoteToDigit(quote, pipSize = 2) {
  const n = Number(quote);
  if (!Number.isFinite(n)) return null;
  const pip = Number.isInteger(pipSize) && pipSize >= 1 && pipSize <= 8 ? pipSize : 2;

  // Use plain string form (not scientific) — synthetic indices never hit
  // scientific notation but guard anyway.
  let s = Math.abs(n).toString();
  if (s.indexOf('e') !== -1) s = Math.abs(n).toFixed(8);
  const dot = s.indexOf('.');
  const frac = dot < 0 ? '' : s.slice(dot + 1);
  const padded = frac.padEnd(pip, '0');
  const ch = padded.charAt(pip - 1);
  const d = Number(ch);
  return Number.isInteger(d) ? d : null;
}

class MarketDataManager extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.history = new Map(); // symbol -> [{epoch, quote, digit}]
    this.subs = new Map();
    this.lastQuote = new Map();
    this.pipSizes = new Map();
    // Seed pip cache from the canonical table BEFORE we ever touch the
    // network. This guarantees `pipSize(symbol)` returns the correct
    // value even if loadSymbols fails, is delayed, or returns partial
    // data — which was the root cause of "1 trade in 3 days".
    for (const [sym, pip] of Object.entries(KNOWN_PIP_SIZES)) {
      this.pipSizes.set(sym, pip);
    }
    client.on('close', () => this.subs.clear());
  }
  async loadSymbols() {
    try {
      // Use 'full' — 'brief' does NOT include pip_size. The KNOWN_PIP_SIZES
      // table already covers all volatility indices; this call is really
      // for populating the `client.symbols` map (used by pipSize as a
      // secondary source and by other code paths for symbol metadata).
      const res = await this.client._send({ active_symbols: 'full' }, 15000);
      const list = res.active_symbols || [];
      let apiWithPip = 0;
      let overrides  = 0;
      for (const s of list) {
        const key = s.underlying_symbol || s.symbol;
        if (!key) continue;
        this.client.symbols.set(key, s);
        const rawPip = Number(s.pip_size);
        if (Number.isFinite(rawPip) && rawPip >= 1 && rawPip <= 8) {
          apiWithPip++;
          // If API disagrees with our KNOWN table, log it loudly and
          // TRUST THE API for that symbol — API is authoritative for
          // symbols we don't have in KNOWN_PIP_SIZES, and if Deriv ever
          // changes a symbol's pip_size we want to notice.
          const known = KNOWN_PIP_SIZES[key];
          if (known != null && known !== rawPip) {
            logger.warn(`pip_size mismatch for ${key}: known=${known} vs API=${rawPip} — using API value`);
            overrides++;
            this.pipSizes.set(key, rawPip);
          } else if (known == null) {
            this.pipSizes.set(key, rawPip);
          }
        }
      }
      logger.info(
        `loaded ${this.client.symbols.size} active symbols  ` +
        `(pip: known-table=${Object.keys(KNOWN_PIP_SIZES).length}, api-supplied=${apiWithPip}, api-overrides=${overrides})`
      );
    } catch (e) {
      logger.error('loadSymbols failed:', e.message);
      logger.info(`falling back to KNOWN_PIP_SIZES table only`);
    }
  }
  pipSize(symbol) {
    // Priority:
    //   1) KNOWN_PIP_SIZES-seeded (or API-overridden) cache
    //   2) live client.symbols map (for symbols we didn't know)
    //   3) inference from a recent tick's decimal count
    //   4) default 2 (last resort)
    const cached = this.pipSizes.get(symbol);
    if (Number.isFinite(cached)) return cached;

    const raw = Number(this.client.symbols.get(symbol)?.pip_size);
    if (Number.isFinite(raw) && raw >= 1 && raw <= 8) {
      this.pipSizes.set(symbol, raw);
      return raw;
    }

    // Infer from actual tick data (last-ditch fallback)
    const hist = this.history.get(symbol);
    if (hist && hist.length) {
      const decCounts = new Map();
      const sample = hist.slice(-Math.min(50, hist.length));
      for (const t of sample) {
        const s = String(t.quote);
        const dot = s.indexOf('.');
        const dec = dot < 0 ? 0 : s.length - dot - 1;
        decCounts.set(dec, (decCounts.get(dec) || 0) + 1);
      }
      let bestDec = 2, bestN = 0;
      for (const [d, n] of decCounts) if (n > bestN) { bestDec = d; bestN = n; }
      if (bestDec >= 1 && bestDec <= 8) {
        logger.warn(`pipSize(${symbol}) unknown — inferred pip=${bestDec} from tick decimals`);
        this.pipSizes.set(symbol, bestDec);
        return bestDec;
      }
    }
    logger.warn(`pipSize(${symbol}) unknown — defaulting to 2 (digits may be wrong!)`);
    return 2;
  }
  async backfill(symbol, count = 1000) {
    try {
      const res = await this.client._send({
        ticks_history: symbol,
        count,
        end: 'latest',
        style: 'ticks',
      }, 20000);
      const prices = res.history?.prices || [];
      const times = res.history?.times || [];
      const pip = this.pipSize(symbol);
      const arr = times.map((t, i) => {
        const quote = Number(prices[i]);
        return { epoch: Number(t), quote, digit: quoteToDigit(quote, pip) };
      }).filter(x => x.digit != null);
      this.history.set(symbol, arr);
      if (arr.length) this.lastQuote.set(symbol, arr[arr.length - 1].quote);
      logger.info(`backfilled ${symbol}: ${arr.length} ticks (pip_size=${pip})`);
      return arr;
    } catch (e) {
      logger.error(`backfill(${symbol}) failed:`, e.message);
      return [];
    }
  }
  /**
   * Deep historical backfill for the backtester.
   * Deriv `ticks_history` returns up to 5000 ticks per call. We chain
   * calls backwards using `end` = earliest epoch - 1. Returns oldest→newest.
   */
  async deepBackfill(symbol, totalCount, batchSize = 5000, onProgress = null) {
    const out = [];
    let remain = totalCount;
    let end    = 'latest';
    let lastEpoch = null;
    const pip = this.pipSize(symbol);
    while (remain > 0) {
      const count = Math.min(batchSize, remain);
      let res;
      try {
        res = await this.client._send({
          ticks_history: symbol,
          count, end, style: 'ticks',
        }, 30000);
      } catch (e) {
        logger.warn(`deepBackfill(${symbol}) batch failed: ${e.message} — stopping`);
        break;
      }
      const prices = res.history?.prices || [];
      const times  = res.history?.times  || [];
      if (!times.length) { logger.info(`  (server returned 0 more ticks — Deriv history exhausted)`); break; }
      const batch = times.map((t, i) => {
        const quote = Number(prices[i]);
        return { epoch: Number(t), quote, digit: quoteToDigit(quote, pip) };
      }).filter(x => x.digit != null);
      if (lastEpoch !== null && batch.length && batch[batch.length - 1].epoch >= lastEpoch) {
        logger.info(`  (server did not honor pagination — history exhausted at ${out.length} ticks)`);
        break;
      }
      if (batch.length) lastEpoch = batch[0].epoch;
      out.unshift(...batch);
      remain -= batch.length;
      if (onProgress) onProgress(out.length, totalCount);
      if (!batch.length) break;
      end = String(batch[0].epoch - 1);
      await new Promise(r => setTimeout(r, 200)); // rate-limit courtesy
      if (batch.length < count) {
        logger.info(`  (last batch short: ${batch.length}/${count} — Deriv history exhausted at ${out.length} ticks)`);
        break;
      }
    }
    return out;
  }

  async subscribe(symbol) {
    if (this.subs.has(symbol)) return this.subs.get(symbol);
    const subId = await this.client.subscribe({ ticks: symbol }, msg => {
      const t = msg.tick;
      if (!t) return;
      const quote = Number(t.quote);
      const pip = this.pipSize(symbol);
      const tick = { epoch: Number(t.epoch), quote, digit: quoteToDigit(quote, pip) };
      if (tick.digit == null) return;
      this.lastQuote.set(symbol, tick.quote);
      const arr = this.history.get(symbol) || [];
      arr.push(tick);
      const cap = Math.max(this.cfg.tickWindow * 2, 2000);
      if (arr.length > cap) arr.splice(0, arr.length - cap);
      this.history.set(symbol, arr);
      this.emit('tick', symbol, tick);
    });
    this.subs.set(symbol, subId);
    logger.info(`subscribed ticks: ${symbol} (sub=${subId})`);
    return subId;
  }
  async bootstrap(symbols) {
    await Promise.all(symbols.map(s => this.subscribe(s).catch(e => logger.warn(`subscribe(${s}) failed:`, e.message))));
    await Promise.all(symbols.map(async s => {
      const hist = this.history.get(s) || [];
      if (hist.length < this.cfg.minTicksForAnalysis) {
        await this.backfill(s, Math.max(this.cfg.tickWindow, this.cfg.minTicksForAnalysis + 100));
      }
    }));
  }
  historyFor(symbol) { return this.history.get(symbol) || []; }
  last(symbol) { return this.lastQuote.get(symbol); }
}

// ─────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────
// 7. MONTE CARLO DIGIT ANALYZER
// ─────────────────────────────────────────────────────────────────────
/**
 * MonteCarloAnalyzer — honest hypothesis-testing Monte Carlo engine.
 *
 * The pipeline answers ONE question: "how unlikely is the observed digit
 * imbalance under a fair, uniform, i.i.d. null?" It does NOT predict the
 * next digit, and a non-trade (idle) is the CORRECT result on fair data.
 *
 * Pipeline:
 *   1. testRandomness()     — χ² uniformity + transition entropy (flags only)
 *   2. runMonteCarlo()      — EXACT multinomial test vs UNIFORM null on the
 *                             min-count statistic:
 *                               P(min count ≤ c) = 1 − (1 − F(c))^10
 *                             with F = Binomial(n, 0.1) CDF (incomplete beta).
 *                             overallPValue ~ U(0,1) under the null, so
 *                             confidence = 1 − pValue has the NOMINAL type-I
 *                             error (α = 1 − minEdgeConfidence), unlike the
 *                             old plug-in null which pinned ~0.5 and fired
 *                             on every scan.
 *   3. _stability()         — closed-form SEPARATION of the min digit from
 *                             the other nine relative to sampling noise.
 *   4. scoreCandidates()    — decision with an honest reason code.
 *
 * Selection-bias correction (WBC): the barrier is the digit with the lowest
 * observed frequency; that estimate is biased DOWN relative to its true
 * loss probability. pLossEst = p̂_min + (1/10 − E[min p̂ | null]) so that
 * under the null E[pLossEst] = 0.10 exactly ⇒ value edge = q_be − 0.10 < 0
 * and the bot correctly stays idle.
 *
 * Multiple testing: confidence controls type-I error at 1−α PER SCAN; the
 * per-symbol-per-day FDR budget (mcFdrBudget) bounds how many signals may
 * actually be acted on, so lucky scans can't stack into a trade spree.
 */
class MonteCarloAnalyzer {
  constructor(cfg) {
    this.cfg = cfg;
    // Prediction memory: [{ digit, tickIndex, symbol }]
    this._predictionLog = [];
    // Per-digit cooldown: Map<digit, lastTickIndex>
    this._cooldownMap = new Map();
    // Running tick counter (incremented by callers)
    this._tickCounter = 0;
    // Seeded PRNG (mulberry32) — MC stays reproducible across runs.
    this._rng = this._mulberry32(0x9E3779B9);
    // FDR budget: symbol -> { day:'YYYY-MM-DD', count }  (count = trades acted on)
    this._fdr = new Map();
    // Cache for E[min count | uniform null] keyed by n (constant per sampleSize)
    this._eminCache = null;
  }

  _mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  _rand() { return this._rng(); }

  // ── Public API ───────────────────────────────────────────────────

  recordPrediction(digit, symbol) {
    const entry = { digit, tickIndex: this._tickCounter, symbol, ts: Date.now() };
    this._predictionLog.push(entry);
    this._cooldownMap.set(digit, this._tickCounter);
    if (this._predictionLog.length > 500) this._predictionLog.splice(0, 250);
  }

  /**
   * Count one ACTED-ON signal for a symbol today (called by the bot after a
   * real trade fires). Bounds false discoveries per symbol per day.
   */
  recordSignal(symbol) {
    const day = utcDateStr();
    let e = this._fdr.get(symbol);
    if (!e || e.day !== day) e = { day, count: 0 };
    e.count += 1;
    this._fdr.set(symbol, e);
  }
  _fdrCount(symbol) {
    const e = this._fdr.get(symbol);
    if (!e || e.day !== utcDateStr()) return 0;
    return e.count;
  }
  _fdrExceeded(symbol) {
    if (!(this.cfg.mcFdrBudget > 0)) return false;
    return this._fdrCount(symbol) >= this.cfg.mcFdrBudget;
  }

  tick() { this._tickCounter++; }

  /**
   * Main analysis entry point. Returns an analysis object for the bot
   * pipeline, or null if insufficient data.
   */
  analyze(symbol, ticks) {
    if (!ticks || ticks.length < this.cfg.minTicksForAnalysis) return null;

    const digits = ticks.map(t => t.digit).filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
    if (digits.length < this.cfg.minTicksForAnalysis) return null;

    this._tickCounter = Math.max(this._tickCounter, digits.length);

    const n = digits.length;
    const lastDigit = digits[n - 1];
    // IMPORTANT: ALL MC machinery operates on the SAME window (the last
    // `sampleSize` digits) so the null p-value, stability, p̂ and gates are
    // computed on one consistent sample. (Older builds ran the MC on the
    // full history but gated on a short-window p̂ — that mismatch is fixed.)
    const sampleSize = Math.min(this.cfg.minTicksForAnalysis, n);
    const win = digits.slice(-sampleSize);

    // 1. Randomness quality check (diagnostic flags only — not a gate)
    const randomness = this.testRandomness(digits);

    // 2. Exact Monte Carlo: uniform-null p-value on the min-count statistic
    const mc = this.runMonteCarlo(win, this.cfg.mcSimulations);
    const bestDigit = mc.minDigit;

    // 3. Separation stability (closed-form, deterministic)
    const stability = this._stability(mc.counts, mc.n, bestDigit);

    // 4. Decision with reason
    const scored = this.scoreCandidates(mc, randomness, stability);

    if (!scored.topCandidate) {
      return { symbol, method: 'monte-carlo-exact', digit: lastDigit,
        sampleSize, mcPasses: false, randomnessFlags: randomness.flags,
        gates: ['no-valid-candidate'], ...scored };
    }

    // 5. Build analysis result
    const counts = mc.counts;
    const lastPredIdx = this._cooldownMap.get(bestDigit);
    const predictionCooldown = lastPredIdx != null ? this._tickCounter - lastPredIdx : Infinity;

    const recentLook = Math.min(this.cfg.recentLookback, n);
    const recentHits = digits.slice(-recentLook).filter(d => d === bestDigit).length;
    const absenceStreak = this._absenceStreak(digits, bestDigit);

    // Raw estimate + selection-bias-corrected loss probability.
    // pLossEst (a.k.a. pLossUpper / pUpper) is the HONEST number to
    // compare against q_be. pEstimate is the raw min-frequency (display).
    const pEstimate = mc.minFreq;
    const pLossEst = this.cfg.mcSelectionBias
      ? this._wbc(pEstimate, mc.nullMinFreq)
      : pEstimate;

    // Wilson CI (reporting only — gating now uses separation stability)
    const bootCI = this._bootstrapCIForDigit(win, bestDigit);

    const entropy = this._normalizedEntropy(counts, sampleSize);
    const chiSq = this._chiSquare(counts, sampleSize);

    // ── Gate checks (each gate adds a reason code) ──
    const gates = [];

    if (randomness.flags.includes('uniform')) gates.push('randomness:uniform');

    if (entropy < this.cfg.minEntropy) gates.push(`entropy-low:${entropy.toFixed(4)}`);
    if (entropy > this.cfg.maxEntropy) gates.push(`entropy-high:${entropy.toFixed(4)}`);

    if (chiSq < 1.5) gates.push(`chisq-low:${chiSq.toFixed(2)}`);
    if (chiSq > 40.0) gates.push(`chisq-high:${chiSq.toFixed(2)}`);

    if (scored.confidence < this.cfg.minEdgeConfidence) gates.push(`confidence-low:${scored.confidence.toFixed(3)}`);
    if (scored.stability < this.cfg.mcStabilityThreshold) gates.push(`stability-low:${scored.stability.toFixed(3)}`);
    if (this._fdrExceeded(symbol)) gates.push(`fdr-budget:${this._fdrCount(symbol)}/${this.cfg.mcFdrBudget}`);

    if (recentHits > this.cfg.maxRecentHits) gates.push(`recent-hit:${recentHits}`);
    if (predictionCooldown < this.cfg.cooldownTicks) gates.push(`cooldown:${predictionCooldown}t`);
    if (digits.slice(-this.cfg.hotFilterTicks).includes(bestDigit)) gates.push('hot-filter');

    const mcPasses = gates.length === 0;

    // ── Log analysis summary (throttled) ──
    const streamSnap = digits.slice(-20).join('');
    if (!this._lastLogTime || Date.now() - this._lastLogTime > 60_000) {
      logger.info(`[MC] ─── Monte Carlo Analysis: ${symbol} ───`);
      logger.info(`[MC] stream: ...${streamSnap}  (n=${sampleSize})`);
      logger.info(`[MC] uniformity: chiSq=${chiSq.toFixed(2)} entropy=${entropy.toFixed(3)} flags=[${randomness.flags.join(', ') || 'none'}]`);
      logger.info(`[MC] exact-multinomial (uniform null): overallP=${scored.pValue.toFixed(4)} confidence=${scored.confidence.toFixed(3)} nullEminFreq=${mc.nullMinFreq.toFixed(4)}`);
      logger.info(`[MC] best barrier: d${bestDigit}  count=${mc.minCount}/${sampleSize}  p̂=${pEstimate.toFixed(4)}  p̂_WBC=${pLossEst.toFixed(4)}`);
      logger.info(`[MC] stability(separation)=${scored.stability.toFixed(3)}  bootCI.width=${bootCI.width.toFixed(4)}`);
      logger.info(`[MC] trade decision: ${scored.shouldTrade ? 'TRADE' : 'SKIP'} (${scored.reason})  gates=[${gates.length ? gates.join(', ') : 'none'}]`);
      this._lastLogTime = Date.now();
    }

    return {
      symbol,
      method: 'monte-carlo-exact',
      digit: bestDigit,
      count: mc.minCount,
      sampleSize,
      pEstimate,
      pUpper: pLossEst,
      pLossUpper: pLossEst,
      pLossRaw: pEstimate,
      pWbcApplied: this.cfg.mcSelectionBias,
      nullMinFreq: mc.nullMinFreq,
      recentHits,
      gates,
      mcPasses,
      allowedByModel: mcPasses,
      lastDigit,
      lastQuote: ticks[ticks.length - 1]?.quote,
      // Monte Carlo fields
      confidence: scored.confidence,
      stability: scored.stability,
      mcDecision: scored.shouldTrade,
      mcReason: scored.reason,
      pValue: scored.pValue,
      observedHitRate: sampleSize > 0 ? 1 - mc.minCount / sampleSize : 1,
      expectedHitRate: 0.9,
      allCandidates: scored.allCandidates,
      randomnessFlags: randomness.flags,
      randomnessUniformity: randomness.uniformity,
      randomnessTransitions: randomness.transitions,
      bootstrapCI: bootCI,
      absenceStreak,
      predictionCooldown,
      entropy,
      chiSquare: chiSq,
      consensusScore: scored.confidence,
      agreementSources: scored.stability > 0.7 ? 4 : scored.stability > 0.5 ? 3 : scored.stability > 0.3 ? 2 : 1,
      probabilityGap: pLossEst - (1 / 10),
    };
  }

  /**
   * Rank a list of analyses: MC-approved first, then by ascending pValue
   * (strongest evidence of non-uniformity). Live value-edge ranking happens
   * later once live payouts are probed.
   */
  rank(list) {
    return list
      .filter(Boolean)
      .filter(a => a.mcPasses || a.allowedByModel)
      .sort((a, b) => (a.pValue ?? 1) - (b.pValue ?? 1));
  }

  // ── Randomness Quality Checks ────────────────────────────────────

  /**
   * Test whether recent digit history is consistent with a random stream.
   * Checks uniformity (chi-square) and transition independence (entropy ratio).
   */
  testRandomness(digits) {
    const n = digits.length;
    const flags = [];

    // Chi-square uniformity test
    const counts = Array(10).fill(0);
    for (const d of digits) counts[d]++;
    const chiSqResult = this._chiSquareTest(counts, n);

    if (chiSqResult.pValue > (1 - this.cfg.randomnessAlpha)) {
      flags.push('uniform');
    }
    if (chiSqResult.pValue < this.cfg.randomnessAlpha) {
      flags.push('non-uniform');
    }

    // Transition matrix analysis
    const transitionResult = this._analyzeTransitions(digits);

    if (transitionResult.ratio > 0.95) {
      flags.push('transitions-independent');
    }

    return {
      uniformity: chiSqResult,
      transitions: transitionResult,
      flags,
    };
  }

  /**
   * Chi-square goodness-of-fit test for uniform distribution.
   */
  _chiSquareTest(counts, n) {
    if (n === 0) return { chiSq: 0, pValue: 1, df: 9 };
    const expected = n / 10;
    let chiSq = 0;
    for (const c of counts) {
      const diff = c - expected;
      chiSq += (diff * diff) / expected;
    }
    const df = 9;
    let z = Math.pow(chiSq / df, 1 / 3) - (1 - 2 / (9 * df));
    z /= Math.sqrt(2 / (9 * df));
    const pValue = 1 - this._normalCDF(z);
    return { chiSq, pValue, df };
  }

  /**
   * Build transition matrix and compute entropy-based independence metric.
   */
  _analyzeTransitions(digits) {
    if (digits.length < 2) {
      return { matrix: null, entropy: 0, ratio: 1, quality: 1 };
    }

    const matrix = Array.from({ length: 10 }, () => Array(10).fill(0));
    for (let i = 0; i < digits.length - 1; i++) {
      matrix[digits[i]][digits[i + 1]]++;
    }

    let conditionalEntropy = 0;
    const maxEntropy = Math.log2(10);
    for (let from = 0; from < 10; from++) {
      const rowTotal = matrix[from].reduce((s, v) => s + v, 0);
      if (rowTotal === 0) continue;
      let rowEntropy = 0;
      for (let to = 0; to < 10; to++) {
        if (matrix[from][to] === 0) continue;
        const p = matrix[from][to] / rowTotal;
        rowEntropy -= p * Math.log2(p);
      }
      conditionalEntropy += (rowTotal / (digits.length - 1)) * rowEntropy;
    }

    const ratio = conditionalEntropy / maxEntropy;
    const quality = Math.max(0, Math.min(1, ratio));

    return { matrix, entropy: conditionalEntropy, ratio, quality };
  }

  // ── Monte Carlo Simulation ───────────────────────────────────────

  /**
   * EXACT multinomial Monte Carlo test against the UNIFORM null.
   *
   * Null hypothesis: digits are i.i.d. uniform on {0..9}, so each count
   * c_j ~ Binomial(n, 0.1). The test statistic is the MINIMUM count (the
   * digit we would select as a differ barrier). Under the null:
   *
   *     P(min count ≤ c) = 1 − (1 − F(c))^10,   F = Binomial CDF.
   *
   * Because this is the CDF of the min of 10 iid uniform-null counts,
   * overallPValue ~ U(0,1) exactly under the null — so confidence =
   * 1 − overallPValue has the NOMINAL type-I error (α = 1−minEdgeConfidence).
   * This is the statistically honest gate that the old plug-in null lacked:
   * on a fair stream confidence now sits ≈0 (idle) instead of ≈0.5 (fires).
   *
   * `nSimulations` is accepted for API compatibility; the exact computation
   * needs none, is deterministic, and is ~µs (a single binomial CDF plus a
   * cached E[min-count] term), replacing the O(n × sims) loop.
   */
  runMonteCarlo(digits, nSimulations) {
    const n = digits.length;
    const counts = Array(10).fill(0);
    for (const d of digits) counts[d]++;
    const p_hat = counts.map(c => c / n);

    let minDigit = 0, minCount = Infinity;
    for (let d = 0; d < 10; d++) if (counts[d] < minCount) { minCount = counts[d]; minDigit = d; }

    const F = this._binomCDF(minCount, n, 0.1);
    const overallPValue = Math.min(1, Math.max(0, 1 - Math.pow(1 - F, 10)));

    // E[min count | uniform null] — the selection baseline used by WBC.
    const nullMinFreq = this._nullEminCount(n) / n;

    const candidates = [];
    for (let d = 0; d < 10; d++) {
      const c = counts[d];
      candidates.push({
        digit: d,
        count: c,
        observedHitRate: 1 - c / n,
        expectedHitRate: 0.1,
        pLowTail: this._binomCDF(c, n, 0.1),
      });
    }

    return {
      n, counts, p_hat,
      minDigit, minCount,
      minFreq: minCount / n,
      nullMinFreq,
      overallPValue,
      confidence: 1 - overallPValue,
      candidates,
    };
  }

  // ── Candidate Scoring & Stability ────────────────────────────────

  /**
   * Decide from the exact-MC result + separation stability. Returns the
   * selected barrier (min-frequency digit) with an honest reason code.
   */
  scoreCandidates(mc, randomness, stability) {
    const { candidates, minDigit, overallPValue, confidence } = mc;
    if (!candidates || candidates.length === 0) {
      return { topCandidate: null, allCandidates: [], confidence: 0, stability: 0, pValue: 1, shouldTrade: false, reason: 'no-candidates' };
    }
    const top = candidates[minDigit];
    const sorted = [...candidates].sort((a, b) => a.observedHitRate - b.observedHitRate);

    let shouldTrade = false;
    let reason = '';

    if (randomness.flags.includes('uniform')) {
      reason = 'data-too-uniform-no-edge';
    } else if (confidence < this.cfg.minEdgeConfidence) {
      reason = `confidence-low:${confidence.toFixed(3)}`;
    } else if (stability < this.cfg.mcStabilityThreshold) {
      reason = `instability:${stability.toFixed(3)}`;
    } else {
      shouldTrade = true;
      reason = 'edge-detected-and-stable';
    }

    return {
      topCandidate: top,
      allCandidates: sorted,
      confidence,
      stability,
      pValue: overallPValue,
      shouldTrade,
      reason,
    };
  }

  /**
   * Separation stability (closed-form, deterministic): probability that each
   * OTHER digit's observed frequency exceeds the selected min under sampling
   * noise (normal approx of the binomial difference). On uniform data the
   * in-sample gap (≈0.02 at n=1000) is comparable to sampling noise ⇒
   * stability ≈ 0.5–0.7 (rejects at 0.80); under a real anomaly the gap is
   * several σ ⇒ stability → 1 (passes). This is what the old ±0.01
   * noise-injection "stability" claimed to measure but measured nothing.
   */
  _stability(counts, n, minDigit) {
    if (n <= 0 || !counts) return 0;
    const pMin = counts[minDigit] / n;
    let prod = 1;
    for (let j = 0; j < 10; j++) {
      if (j === minDigit) continue;
      const pj = counts[j] / n;
      const sd = Math.sqrt((pj * (1 - pj) + pMin * (1 - pMin)) / n);
      const z = sd > 0 ? (pj - pMin) / sd : 0;
      prod *= this._normalCDF(z);
    }
    return prod;
  }

  /**
   * Selection-bias-corrected loss probability (winner's-curse adjustment).
   * We select the digit with the LOWEST observed frequency; that estimate
   * is biased DOWN relative to its true loss probability. Correction:
   *
   *     p̂_WBC = p̂_min + (1/10 − E[min_j p̂_j | uniform null])
   *
   * so that under the null E[p̂_WBC] = 0.10 exactly ⇒ value edge =
   * q_be − 0.10 < 0 (correctly idle). Under a real anomaly the estimate is
   * pulled back toward 0.1 by the size of the selection gap — a conservative,
   * honest number to bet against.
   */
  _wbc(minFreq, nullMinFreq) {
    return minFreq + (1 / 10 - nullMinFreq);
  }

  // ── Exact binomial CDF via regularized incomplete beta ────────────

  _lgamma(x) {
    if (typeof Math.lgamma === 'function') return Math.lgamma(x);
    // Lanczos approximation fallback (Node < 21).
    const g = 7;
    const C = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - this._lgamma(1 - x);
    x -= 1;
    let a = C[0];
    const t = x + g + 0.5;
    for (let i = 1; i < g + 2; i++) a += C[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }
  _betaCf(a, b, x) {
    const MAXIT = 200, EPS = 3e-14, FPMIN = 1e-300;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c; h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }
  _betaInc(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(this._lgamma(a + b) - this._lgamma(a) - this._lgamma(b) +
      a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return bt * this._betaCf(a, b, x) / a;
    return 1 - bt * this._betaCf(b, a, 1 - x) / b;
  }
  /** P(X ≤ k) for X ~ Binomial(n, p), exact via I_{1−p}(n−k, k+1). */
  _binomCDF(k, n, p) {
    k = Math.floor(k);
    if (k < 0) return 0;
    if (k >= n) return 1;
    if (p <= 0) return 1;
    if (p >= 1) return 0;
    return this._betaInc(n - k, k + 1, 1 - p);
  }
  /** E[min of 10 iid Binomial(n, 0.1)] = Σ_t P(min ≥ t) = Σ_t (1−F(t−1))^10. Cached by n. */
  _nullEminCount(n) {
    if (this._eminCache && this._eminCache.n === n) return this._eminCache.v;
    let sum = 0;
    for (let t = 1; t <= n; t++) {
      const f = this._binomCDF(t - 1, n, 0.1);
      sum += Math.pow(1 - f, 10);
    }
    this._eminCache = { n, v: sum };
    return sum;
  }

  // ── Utility Methods ──────────────────────────────────────────────

  _absenceStreak(digits, targetDigit) {
    for (let i = digits.length - 1; i >= 0; i--) {
      if (digits[i] === targetDigit) return digits.length - 1 - i;
    }
    return digits.length;
  }

  _bootstrapCIForDigit(digits, targetDigit) {
    const n = digits.length;
    if (n === 0) return { mean: 0, lower: 0, upper: 0, width: 0 };
    const count = digits.reduce((acc, d) => acc + (d === targetDigit ? 1 : 0), 0);
    const pHat = count / n;
    const z = 1.6448536269514722; // 90% CI
    const denom = 1 + (z * z) / n;
    const centre = (pHat + (z * z) / (2 * n)) / denom;
    const half = z * Math.sqrt((pHat * (1 - pHat)) / n + (z * z) / (4 * n * n)) / denom;
    const lower = Math.max(0, centre - half);
    const upper = Math.min(1, centre + half);
    return { mean: pHat, lower, upper, width: upper - lower };
  }

  _normalizedEntropy(counts, n) {
    if (n === 0) return 0;
    let H = 0;
    for (const c of counts) {
      if (c > 0) {
        const p = c / n;
        H -= p * Math.log2(p);
      }
    }
    return H / Math.log2(10);
  }

  _chiSquare(counts, n) {
    if (n === 0) return 0;
    const expected = n / 10;
    let chiSq = 0;
    for (const c of counts) {
      const diff = c - expected;
      chiSq += (diff * diff) / expected;
    }
    return chiSq;
  }

  /**
   * Standard normal CDF approximation (Abramowitz & Stegun).
   */
  _normalCDF(x) {
    const a1 =  0.254829592;
    const a2 = -0.284496736;
    const a3 =  1.421413741;
    const a4 = -1.453152027;
    const a5 =  1.061405429;
    const p  =  0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.SQRT2;
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1.0 + sign * y);
  }
}
class TradeExecutor extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.open = new Map();
  }
  async proposal(symbol, digit, stake) {
    const symbolKey = this.client.symbolField();
    return this.client._send({
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: 'DIGITDIFF',
      currency: this.cfg.currency,
      duration: this.cfg.durationTicks,
      duration_unit: 't',
      barrier: String(digit),
      [symbolKey]: symbol,
    }, 15000);
  }
  async buy(symbol, digit, stake, analysis) {
    stake = Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, Number(stake)));
    const pres = await this.proposal(symbol, digit, stake);
    const p = pres.proposal;
    if (!p?.id) throw new Error('No proposal id returned');
    const ask = Number(p.ask_price || stake);
    const payout = Number(p.payout || 0);
    const bres = await this.client._send({ buy: p.id, price: ask }, 15000);
    const b = bres.buy;
    if (!b?.contract_id) throw new Error('Buy did not return contract_id');

    const info = {
      contractId: b.contract_id,
      symbol,
      contractType: 'DIGITDIFF',
      digit,
      stake: ask,
      buyPrice: Number(b.buy_price || ask),
      payout: Number(b.payout || payout),
      buyTime: Number(b.purchase_time || Date.now() / 1000),
      durationTicks: this.cfg.durationTicks,
      proposalId: p.id,
      longcode: p.longcode || '',
      balanceAfter: b.balance_after != null ? Number(b.balance_after) : null,
      analysis,
    };
    this.open.set(info.contractId, info);
    logger.info(`bought DIGITDIFF #${info.contractId} ${symbol} differs ${digit} stake=${ask} payout=${info.payout}`);

    const subId = await this.client.subscribe({ proposal_open_contract: 1, contract_id: info.contractId }, msg => this._onUpdate(msg, info));
    info.subId = subId;
    this.emit('open', info);
    return info;
  }
  async _onUpdate(msg, info) {
    const c = msg.proposal_open_contract;
    if (!c) return;
    const cid = c.contract_id || info.contractId;
    const status = c.status;
    const profit = Number(c.profit || 0);
    if (status === 'won' || status === 'lost') {
      const finished = {
        ...info,
        contractId: cid,
        status,
        profit,
        sellPrice: Number(c.sell_price || 0),
        sellTime: Number(c.sell_time || Date.now() / 1000),
        entryTick: c.entry_tick,
        exitTick: c.exit_tick,
        currentSpot: c.current_spot,
        shortcode: c.shortcode,
      };
      this.open.delete(cid);
      this.emit('result', finished);
      const subId = msg.subscription?.id || info.subId;
      if (subId) await this.client.forget(subId).catch(() => {});
    } else {
      this.emit('update', { ...info, contractId: cid, status, profit });
    }
  }
  count() { return this.open.size; }
  openTrades() { return [...this.open.values()]; }
}

// ─────────────────────────────────────────────────────────────────────
// 9. STATISTICS MANAGER
// ─────────────────────────────────────────────────────────────────────
class StatisticsManager {
  constructor(saved = null) {
    this.trades = [];
    this.dailySummaries = {}; // date -> stats summary
    this.overallProfit = 0;
    this.currentLossStreak = 0;
    this.maxLossStreak = 0;
    this.lossStreakEvents = { x2: 0, x3: 0, x4: 0 };
    this.eodSentDates = [];
    if (saved) this.load(saved);
  }
  load(saved) {
    if (Array.isArray(saved.trades)) this.trades = saved.trades;
    if (saved.dailySummaries && typeof saved.dailySummaries === 'object') this.dailySummaries = saved.dailySummaries;
    this.overallProfit = Number(saved.overallProfit || 0);
    this.currentLossStreak = Number(saved.currentLossStreak || 0);
    this.maxLossStreak = Number(saved.maxLossStreak || 0);
    this.lossStreakEvents = {
      x2: Number(saved.lossStreakEvents?.x2 || 0),
      x3: Number(saved.lossStreakEvents?.x3 || 0),
      x4: Number(saved.lossStreakEvents?.x4 || 0),
    };
    this.eodSentDates = Array.isArray(saved.eodSentDates) ? saved.eodSentDates : [];
  }
  serialize() {
    return {
      trades: this.trades.slice(-5000),
      dailySummaries: this.dailySummaries,
      overallProfit: this.overallProfit,
      currentLossStreak: this.currentLossStreak,
      maxLossStreak: this.maxLossStreak,
      lossStreakEvents: this.lossStreakEvents,
      eodSentDates: this.eodSentDates.slice(-400),
    };
  }
  _stamp(trade) {
    const tsMs = Number(trade.sellTime || trade.buyTime || Date.now() / 1000) * 1000;
    const d = new Date(tsMs);
    return { timestamp: tsMs, date: utcDateStr(d), hour: utcHour(d) };
  }
  record(trade) {
    const stamp = this._stamp(trade);
    const rec = { ...trade, timestamp: stamp.timestamp, date: stamp.date, hour: stamp.hour };
    this.trades.push(rec);
    this.overallProfit += Number(rec.profit || 0);

    if (rec.status === 'lost') {
      this.currentLossStreak += 1;
      if (this.currentLossStreak === 2) this.lossStreakEvents.x2 += 1;
      if (this.currentLossStreak === 3) this.lossStreakEvents.x3 += 1;
      if (this.currentLossStreak === 4) this.lossStreakEvents.x4 += 1;
      this.maxLossStreak = Math.max(this.maxLossStreak, this.currentLossStreak);
    } else if (rec.status === 'won') {
      this.currentLossStreak = 0;
    }
    return rec;
  }
  tradesForDate(date) { return this.trades.filter(t => t.date === date); }
  tradesForHour(date, hour) { return this.trades.filter(t => t.date === date && t.hour === hour); }
  todayTrades(date = utcDateStr()) { return this.tradesForDate(date); }
  stats(list) {
    const wins = list.filter(t => t.status === 'won');
    const losses = list.filter(t => t.status === 'lost');
    const total = list.reduce((s, t) => s + Number(t.profit || 0), 0);
    const grossWin = wins.reduce((s, t) => s + Number(t.profit || 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + Number(t.profit || 0), 0));
    const stake = list.reduce((s, t) => s + Number(t.stake || 0), 0);
    const maxLossStreak = (() => {
      let cur = 0, max = 0;
      for (const t of list) {
        if (t.status === 'lost') { cur += 1; max = Math.max(max, cur); }
        else if (t.status === 'won') cur = 0;
      }
      return max;
    })();
    return {
      count: list.length,
      wins: wins.length,
      losses: losses.length,
      winRate: list.length ? wins.length / list.length * 100 : 0,
      grossWin,
      grossLoss,
      totalProfit: total,
      netPL: total,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      avgProfit: list.length ? total / list.length : 0,
      stake,
      maxLossStreak,
    };
  }
  summaryForDate(date) {
    const list = this.tradesForDate(date);
    const stats = this.stats(list);
    return { date, trades: list, stats };
  }
  archiveDate(date) {
    const summary = this.summaryForDate(date);
    this.dailySummaries[date] = summary.stats;
    return summary;
  }
  markEodSent(date) {
    if (!this.eodSentDates.includes(date)) this.eodSentDates.push(date);
    this.eodSentDates = this.eodSentDates.slice(-400);
  }
  isEodSent(date) { return this.eodSentDates.includes(date); }
  allDailyRows(includeDate = null) {
    const rows = [];
    const dates = new Set(Object.keys(this.dailySummaries));
    for (const t of this.trades) dates.add(t.date);
    if (includeDate) dates.add(includeDate);
    [...dates].sort().forEach(date => {
      let stats = this.dailySummaries[date];
      const live = this.tradesForDate(date);
      if (live.length) stats = this.stats(live);
      if (stats && stats.count > 0) rows.push({ date, stats });
    });
    return rows;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 9b. SYMBOL CALIBRATOR  (rolling per-symbol edge tracker)
// ─────────────────────────────────────────────────────────────────────
/**
 * Tracks, per symbol, a rolling window of (predictedPWin, wasWin) pairs.
 *
 *   • enabled      = symbol is trading normally
 *   • disabled     = under-performing prediction; auto-benched
 *   • probing      = post-cooldown probe; smaller stake until re-calibrated
 *
 * A symbol is disabled when it has ≥ calibMinTrades in its window AND
 * empiricalWR < predictedWR − calibDisableGap.
 * After calibProbeAfterMs elapsed since disable, it enters "probing" mode
 * (traded at calibProbeStakeFrac × normal stake).  It becomes "enabled"
 * again once |empiricalWR − predictedWR| < calibReenableGap over
 * calibMinTrades fresh samples.
 */
class SymbolCalibrator {
  constructor(cfg, saved = null) {
    this.cfg     = cfg;
    this.symbols = new Map();  // symbol -> { window:[], state, disabledAt, note }
    if (saved && typeof saved === 'object') this.load(saved);
  }
  _slot(sym) {
    if (!this.symbols.has(sym)) {
      this.symbols.set(sym, {
        window     : [],          // { pWin, won, ts }
        state      : 'enabled',   // 'enabled' | 'disabled' | 'probing'
        disabledAt : 0,
        lastReason : '',
      });
    }
    return this.symbols.get(sym);
  }
  record(symbol, predictedPWin, won) {
    if (!this.cfg.calibEnabled) return;
    const s = this._slot(symbol);
    s.window.push({ pWin: Number(predictedPWin), won: !!won, ts: Date.now() });
    if (s.window.length > this.cfg.calibWindow) {
      s.window.splice(0, s.window.length - this.cfg.calibWindow);
    }
    this._reassess(symbol, s);
  }
  _reassess(symbol, s) {
    const n = s.window.length;
    if (n < this.cfg.calibMinTrades) return;
    const wins       = s.window.reduce((acc, r) => acc + (r.won ? 1 : 0), 0);
    const empirical  = wins / n;
    const predicted  = s.window.reduce((acc, r) => acc + r.pWin, 0) / n;
    const gap        = empirical - predicted;   // + means under-prediction (good); − means over-prediction (bad)
    if (s.state === 'enabled' || s.state === 'probing') {
      if (gap < -this.cfg.calibDisableGap) {
        s.state      = 'disabled';
        s.disabledAt = Date.now();
        s.lastReason = `WR ${(empirical*100).toFixed(2)}% < predicted ${(predicted*100).toFixed(2)}% by ${(Math.abs(gap)*100).toFixed(2)}pp (n=${n})`;
        logger.warn(`CALIB: ${symbol} DISABLED — ${s.lastReason}`);
        return { symbol, transition: 'disabled', gap, empirical, predicted, n };
      }
      if (s.state === 'probing' && Math.abs(gap) < this.cfg.calibReenableGap) {
        s.state      = 'enabled';
        s.lastReason = `WR ${(empirical*100).toFixed(2)}% vs predicted ${(predicted*100).toFixed(2)}% (gap ${(gap*100).toFixed(2)}pp) — re-enabled`;
        logger.info(`CALIB: ${symbol} RE-ENABLED — ${s.lastReason}`);
        return { symbol, transition: 'enabled', gap, empirical, predicted, n };
      }
    }
    return null;
  }
  status(symbol) {
    const s = this._slot(symbol);
    // Auto-transition disabled → probing after cooldown elapses.
    if (s.state === 'disabled' &&
        Date.now() - s.disabledAt >= this.cfg.calibProbeAfterMs) {
      s.state      = 'probing';
      s.lastReason = `cooldown elapsed (${Math.round((Date.now()-s.disabledAt)/60_000)}m)`;
      logger.info(`CALIB: ${symbol} → PROBING at ${(this.cfg.calibProbeStakeFrac*100).toFixed(0)}% stake — ${s.lastReason}`);
    }
    return s.state;
  }
  summary() {
    const out = {};
    for (const [sym, s] of this.symbols) {
      const n = s.window.length;
      const wins = s.window.reduce((a, r) => a + (r.won ? 1 : 0), 0);
      const emp  = n ? wins / n : 0;
      const pred = n ? s.window.reduce((a, r) => a + r.pWin, 0) / n : 0;
      out[sym] = {
        state    : s.state,
        n,
        empirical: +(emp * 100).toFixed(2),
        predicted: +(pred * 100).toFixed(2),
        gap      : +((emp - pred) * 100).toFixed(2),
        reason   : s.lastReason,
      };
    }
    return out;
  }
  stakeMultiplier(symbol) {
    // 1.0 for enabled, calibProbeStakeFrac for probing, 0 for disabled.
    if (!this.cfg.calibEnabled) return 1.0;
    const st = this.status(symbol);
    if (st === 'disabled') return 0;
    if (st === 'probing')  return this.cfg.calibProbeStakeFrac;
    return 1.0;
  }
  isTradeable(symbol) { return this.stakeMultiplier(symbol) > 0; }

  serialize() {
    const out = {};
    for (const [sym, s] of this.symbols) {
      out[sym] = {
        window     : s.window.slice(-this.cfg.calibWindow),
        state      : s.state,
        disabledAt : s.disabledAt,
        lastReason : s.lastReason,
      };
    }
    return out;
  }
  load(saved) {
    for (const [sym, s] of Object.entries(saved)) {
      if (!s || typeof s !== 'object') continue;
      this.symbols.set(sym, {
        window     : Array.isArray(s.window) ? s.window.slice(-this.cfg.calibWindow) : [],
        state      : s.state       || 'enabled',
        disabledAt : Number(s.disabledAt || 0),
        lastReason : String(s.lastReason || ''),
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// 9c. KELLY SIZER
// ─────────────────────────────────────────────────────────────────────
/**
 *  Kelly-fractional position sizer.
 *
 *  Optimal Kelly fraction of bankroll to stake:
 *      f* = (b·p − q) / b     where  b = payout_mult − 1
 *                                   p = win probability (from analyzer)
 *                                   q = 1 − p
 *
 *  We stake  bankroll × f* × kellyFraction  (defaults to quarter-Kelly).
 *  Hard-capped at kellyMaxStakeFrac of bankroll to survive tail streaks.
 *  Returns null when the edge is non-positive (skip the trade).
 */
class KellySizer {
  constructor(cfg) { this.cfg = cfg; }

  /**
   * @param {object} p
   * @param {number} p.bankroll     current live balance
   * @param {number} p.pWin         analyzer-predicted win probability
   * @param {number} p.payoutMult   total payout per 1 stake (e.g. 1.10)
   * @param {number} p.edgeValue    breakEven − observedFreq
   * @returns {{stake:number, fStar:number, fApplied:number, reason:string}|null}
   */
  compute({ bankroll, pWin, payoutMult, edgeValue }) {
    const cfg = this.cfg;
    const b   = Math.max(0, payoutMult - 1);     // net-of-stake win multiplier
    const p   = Math.max(0, Math.min(1, pWin));
    const q   = 1 - p;
    if (b <= 0) return null;
    const fStar = (b * p - q) / b;
    if (fStar <= 0) return null;                 // no Kelly recommendation
    if (edgeValue < cfg.kellyMinEdgeForScale) {
      // Trust the model less when the value-edge is marginal — take the
      // MINIMUM stake in that regime, not a scaled-up Kelly stake.
      return { stake: cfg.minStake, fStar, fApplied: 0, reason: 'edge<minEdgeForScale' };
    }
    const roll   = Math.max(cfg.kellyBankrollFloor, bankroll * cfg.kellyBankrollFrac);
    const fApp   = fStar * cfg.kellyFraction;
    const capF   = Math.min(fApp, cfg.kellyMaxStakeFrac);
    let stake    = roll * capF;
    stake        = Math.max(cfg.minStake, Math.min(cfg.maxStake, +stake.toFixed(2)));
    return { stake, fStar, fApplied: capF, reason: fApp > cfg.kellyMaxStakeFrac ? 'capped' : 'ok' };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 10. TRADING BOT ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────
class TradingBot {
  constructor() {
    this.cfg = CONFIG;
    this.client = new DerivClient(this.cfg);
    this.market = new MarketDataManager(this.client, this.cfg);
    this.analyzer = new MonteCarloAnalyzer(this.cfg);
    this.exec = new TradeExecutor(this.client, this.cfg);
    this.stats = new StatisticsManager();
    this.calibrator = new SymbolCalibrator(this.cfg);
    this.kelly      = new KellySizer(this.cfg);
    this.livePayoutMult = new Map();  // symbol → last observed payout/ask ratio
    this._seenAuthorized = false;

    this.startBalance = null;
    this.lastBalance = null;
    this.lastTradeAt = 0;
    this.tradedAsset   = null;   // symbol most recently traded (rotation lock)
    this.tradedAssetAt = 0;      // when that symbol was traded (ms epoch)
    this.stopped = false;
    this.paused = false;
    this._analysisT = null;
    this._hourlyBoot = null;
    this._hourlyT = null;
    this._eodBoot = null;
    this._eodT = null;
    this._pauseStartTimer = null;
    this._pauseEndTimer = null;

    // ── Monte Carlo risk controls ────────────────────────────────────
    this.lastLossAt = 0;           // timestamp of last loss (for cooldown)

    // ── Trade watchdog ──────────────────────────────────────────────
    this._watchdogTimer = null;
    this._watchdogPollTimer = null;
    this.tradeWatchdogMs = this.cfg.tradeWatchdogMs || 20000;

    // ── Tick counter for cooldownTicks ──────────────────────────────
    this._tickCounter = 0;
    this._lastTradeTickIdx = null;
  }

  // ── Scheduled pause helpers ─────────────────────────────────────
  _parsePauseTime(str) {
    const m = String(str || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Math.max(0, Math.min(23, Number(m[1])));
    const min = Math.max(0, Math.min(59, Number(m[2])));
    return { h, min };
  }

  /**
   * Returns true if the current GMT time falls inside the pause window.
   * Supports both overnight (start > end, e.g. 22:00 → 06:00) and
   * same-day (start < end, e.g. 12:00 → 14:00) windows.
   */
  _isPausedNow() {
    if (!this.cfg.pauseEnabled) return false;
    const start = this._parsePauseTime(this.cfg.pauseStartGmt);
    const end   = this._parsePauseTime(this.cfg.pauseEndGmt);
    if (!start || !end) return false;
    const now = new Date();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const startMin = start.h * 60 + start.min;
    const endMin   = end.h   * 60 + end.min;
    if (startMin > endMin) {
      // Overnight window: paused from startMin..1439 OR 0..endMin
      return nowMin >= startMin || nowMin < endMin;
    }
    // Same-day window: paused from startMin..endMin
    return nowMin >= startMin && nowMin < endMin;
  }

  /**
   * Schedule the next pause-start and pause-end transitions.
   * Called once at startup and re-called after each transition.
   */
  _schedulePause() {
    this._clearPauseTimers();
    if (!this.cfg.pauseEnabled) return;

    const now = new Date();
    const nowMs = now.getTime();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const start = this._parsePauseTime(this.cfg.pauseStartGmt);
    const end   = this._parsePauseTime(this.cfg.pauseEndGmt);
    if (!start || !end) {
      logger.warn('pause schedule: invalid pauseStartGmt or pauseEndGmt format');
      return;
    }
    const startMin = start.h * 60 + start.min;
    const endMin   = end.h   * 60 + end.min;

    // Helper: ms from now to a target time (next occurrence)
    const msToTarget = (targetMinOfDay) => {
      let diff = targetMinOfDay - nowMin;
      if (diff <= 0) diff += 24 * 60; // next day
      return diff * 60_000 - (now.getUTCSeconds() * 1000) - now.getUTCMilliseconds();
    };

    if (startMin > endMin) {
      // Overnight window:  startMin..1439, then 0..endMin
      if (nowMin >= startMin) {
        // Currently paused (first half) → schedule resume at endMin
        this.paused = true;
        const delay = msToTarget(endMin);
        this._pauseEndTimer = setTimeout(() => this._onPauseResume('resume'), delay);
        logger.info(`pause: currently active (overnight), resumes in ${(delay/60000).toFixed(1)}m at ${this.cfg.pauseEndGmt} GMT`);
      } else if (nowMin < endMin) {
        // Currently paused (second half, before endMin) → schedule resume
        this.paused = true;
        const delay = msToTarget(endMin);
        this._pauseEndTimer = setTimeout(() => this._onPauseResume('resume'), delay);
        logger.info(`pause: currently active, resumes in ${(delay/60000).toFixed(1)}m at ${this.cfg.pauseEndGmt} GMT`);
      } else {
        // Currently active window → schedule pause at startMin
        this.paused = false;
        const delay = msToTarget(startMin);
        this._pauseStartTimer = setTimeout(() => this._onPauseResume('pause'), delay);
        logger.info(`pause: scheduled, pauses in ${(delay/60000).toFixed(1)}m at ${this.cfg.pauseStartGmt} GMT`);
      }
    } else {
      // Same-day window:  startMin..endMin
      if (nowMin >= startMin && nowMin < endMin) {
        // Currently paused → schedule resume
        this.paused = true;
        const delay = msToTarget(endMin);
        this._pauseEndTimer = setTimeout(() => this._onPauseResume('resume'), delay);
        logger.info(`pause: currently active, resumes in ${(delay/60000).toFixed(1)}m at ${this.cfg.pauseEndGmt} GMT`);
      } else {
        // Currently active → schedule next pause at startMin
        this.paused = false;
        const delay = msToTarget(startMin);
        this._pauseStartTimer = setTimeout(() => this._onPauseResume('pause'), delay);
        logger.info(`pause: scheduled, pauses in ${(delay/60000).toFixed(1)}m at ${this.cfg.pauseStartGmt} GMT`);
      }
    }
  }

  _onPauseResume(action) {
    this._clearPauseTimers();
    if (action === 'pause') {
      this.paused = true;
      logger.info(`TRADING PAUSED at ${this.cfg.pauseStartGmt} GMT until ${this.cfg.pauseEndGmt} GMT`);
      telegram.send(
        `⏸️ <b>MC TRADING PAUSED</b>\n\n` +
        `Scheduled pause active from <b>${htmlEscape(this.cfg.pauseStartGmt)}</b> to <b>${htmlEscape(this.cfg.pauseEndGmt)}</b> GMT.\n` +
        `Open trades will settle normally. No new trades until resume.\n\n` +
        `🕒 ${utcTs()}`
      );
      // Schedule the resume
      const end = this._parsePauseTime(this.cfg.pauseEndGmt);
      if (end) {
        const delay = this._msToTarget(end.h, end.min);
        this._pauseEndTimer = setTimeout(() => this._onPauseResume('resume'), delay);
        logger.info(`pause: resumes in ${(delay/60000).toFixed(1)}m`);
      }
    } else {
      this.paused = false;
      logger.info(`TRADING RESUMED at ${this.cfg.pauseEndGmt} GMT`);
      telegram.send(
        `▶️ <b>MC TRADING RESUMED</b>\n\n` +
        `Scheduled pause ended. Bot is now scanning for trades.\n\n` +
        `💼 Overall Profit: ${money(this.stats.overallProfit, this.currency())}\n\n` +
        `🕒 ${utcTs()}`
      );
      // Schedule the next pause
      const start = this._parsePauseTime(this.cfg.pauseStartGmt);
      if (start) {
        const delay = this._msToTarget(start.h, start.min);
        this._pauseStartTimer = setTimeout(() => this._onPauseResume('pause'), delay);
        logger.info(`pause: next pause in ${(delay/60000).toFixed(1)}m`);
      }
    }
  }

  /** ms from now to next occurrence of a given HH:MM GMT time. */
  _msToTarget(targetH, targetMin) {
    const now = new Date();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const targetMinOfDay = targetH * 60 + targetMin;
    let diff = targetMinOfDay - nowMin;
    if (diff <= 0) diff += 24 * 60;
    return diff * 60_000 - (now.getUTCSeconds() * 1000) - now.getUTCMilliseconds();
  }

  _clearPauseTimers() {
    if (this._pauseStartTimer) { clearTimeout(this._pauseStartTimer); this._pauseStartTimer = null; }
    if (this._pauseEndTimer)   { clearTimeout(this._pauseEndTimer);   this._pauseEndTimer = null; }
  }

  // ── Monte Carlo Decision Gate ──────────────────────────────────────

  /**
   * shouldTrade(analysis) — Final gate that decides
   * whether Monte Carlo analysis permits a trade.
   *
   * Checks:
   *   1. Analysis has gates passed
   *   2. MC confidence above threshold
   *   3. MC stability above threshold
   *   4. Not in loss cooldown
   *   5. Not in weak-signal cooldown
   *
   * Returns { allowed: boolean, reason: string }
   */
  shouldTrade(analysis) {
    const cfg = this.cfg;

    // 1. Check if analysis passed gates
    if (!analysis || !analysis.allowedByModel) {
      return { allowed: false, reason: `gates blocked: [${analysis?.gates?.join(', ') || 'unknown'}]` };
    }

    // 2. MC confidence check
    if (analysis.confidence < cfg.minEdgeConfidence) {
      return { allowed: false, reason: `confidence ${(analysis.confidence*100).toFixed(1)}% < ${(cfg.minEdgeConfidence*100).toFixed(1)}%` };
    }

    // 3. MC stability check
    if (analysis.stability < cfg.mcStabilityThreshold) {
      return { allowed: false, reason: `stability ${analysis.stability.toFixed(2)} < ${cfg.mcStabilityThreshold}` };
    }

    // 4. Loss cooldown
    const now = Date.now();
    if (now - this.lastLossAt < cfg.mcLossCooldownMs) {
      const remaining = ((cfg.mcLossCooldownMs - (now - this.lastLossAt)) / 1000).toFixed(1);
      return { allowed: false, reason: `loss cooldown — ${remaining}s remaining` };
    }

    return { allowed: true, reason: `MC PASS: d${analysis.digit} confidence=${analysis.confidence.toFixed(3)} stability=${analysis.stability.toFixed(3)} p=${analysis.pValue.toFixed(4)}` };
  }

  /**
   * Check if trading is allowed on the current day of week (GMT/UTC).
   * @returns {boolean} true if trading is allowed today, false otherwise
   */
  _isTradingAllowedToday() {
    const now = new Date();
    const dayOfWeek = now.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const daySettings = [
      this.cfg.tradeSunday,
      this.cfg.tradeMonday,
      this.cfg.tradeTuesday,
      this.cfg.tradeWednesday,
      this.cfg.tradeThursday,
      this.cfg.tradeFriday,
      this.cfg.tradeSaturday
    ];
    
    const allowed = daySettings[dayOfWeek];
    if (!allowed) {
      logger.debug(`trading disabled for ${dayNames[dayOfWeek]} (GMT) — skipping analysis cycle`);
    }
    return allowed;
  }

  async start() {
    logger.info('===== Deriv Digit Differ Bot starting =====');
    logger.info(`config: stake=${this.cfg.stake} duration=${this.cfg.durationTicks}t assets=${this.cfg.assets.join(',')}`);
    if (!this.cfg.apiToken) {
      logger.error('DERIV_API_TOKEN missing. Put it in .env or environment.');
      process.exit(1);
    }
    this._loadState();

    this.client.on('authorized', info => {
      // Every re-authorize (initial + after reconnect) re-arms the loop.
      this._onAuthorized(info);
      if (this._seenAuthorized) this._startAnalysisLoop(false);
      this._seenAuthorized = true;
    });
    this.client.on('close', (c, r, was) => this._onDisconnected(c, r, was));
    this.client.on('open', () => logger.info('connection open'));
    this.client.on('error', e => logger.error('client error:', e.message));
    this.exec.on('open', t => this._onTradeOpen(t));
    this.exec.on('result', t => this._onTradeResult(t));
    this.exec.on('update', t => logger.debug(`update #${t.contractId} ${t.status} profit=${t.profit}`));
    this.market.on('tick', () => { this._tickCounter++; });

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));
    process.on('uncaughtException', e => { logger.error('uncaughtException:', e); this._saveState('uncaughtException'); });
    process.on('unhandledRejection', e => { logger.error('unhandledRejection:', e); this._saveState('unhandledRejection'); });

    this.client.connect();
    this._scheduleSummaries();
  }

  async _onAuthorized(info) {
    this.startBalance = this.startBalance ?? this.client.balance ?? 0;
    this.lastBalance = this.lastBalance ?? this.client.balance ?? this.startBalance;
    logger.info(`start balance: ${this.startBalance} ${this.currency()}`);
    await this.market.loadSymbols();

    const sizingLine = this.cfg.kellySizingEnabled
      ? `🧮 Sizing: <b>Kelly-fractional</b> (f=${this.cfg.kellyFraction}, cap=${(this.cfg.kellyMaxStakeFrac*100).toFixed(1)}% bankroll)`
      : (this.cfg.recoveryEnabled
          ? `🧮 Sizing: recovery ladder [${this.cfg.recoveryMultipliers.join(',')}]` +
            ` ${this.cfg.dangerousRecovery && this.cfg.recoveryMaxStep > 1 ? '⚠️ <b>AGGRESSIVE</b> (step>' + (1) + ' armed)' : ''}`
          : `🧮 Sizing: flat`);
    const calibLine = this.cfg.calibEnabled
      ? `📐 Calibrator: <b>ON</b> (window=${this.cfg.calibWindow}, disableGap=${(this.cfg.calibDisableGap*100).toFixed(1)}pp)`
      : `📐 Calibrator: off`;
    const rotationLine = this.cfg.assetRotationMs > 0
      ? `🔄 Asset rotation: ${(this.cfg.assetRotationMs/1000).toFixed(0)}s lockout`
      : `🔄 Asset rotation: OFF (may repeat same symbol)`;
    const pauseLine = this.cfg.pauseEnabled
      ? `⏸️ Scheduled pause: <b>${htmlEscape(this.cfg.pauseStartGmt)}</b> → <b>${htmlEscape(this.cfg.pauseEndGmt)}</b> GMT`
      : `⏸️ Scheduled pause: off`;
    
    // Day-of-week settings display
    const dayAbbrev = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const daySettings = [
      this.cfg.tradeSunday,
      this.cfg.tradeMonday,
      this.cfg.tradeTuesday,
      this.cfg.tradeWednesday,
      this.cfg.tradeThursday,
      this.cfg.tradeFriday,
      this.cfg.tradeSaturday
    ];
    const dayLine = `📅 Trading days: ${dayAbbrev.map((d, i) => daySettings[i] ? `✅${d}` : `❌${d}`).join(' ')}`;

    telegram.send(
      `🤖 <b>MC Digit Differ Bot Online</b>\n\n` +
      `👤 Account: <code>${htmlEscape(info.loginid || '?')}</code>\n` +
      `💼 Type: ${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'}\n` +
      `💰 Balance: ${(this.client.balance ?? 0).toFixed(2)} ${this.currency()}\n` +
      `📊 Assets: ${this.cfg.assets.join(', ')}\n` +
      `🎯 Contract: <b>DIGITDIFF</b>, duration <b>${this.cfg.durationTicks} tick(s)</b>\n` +
      `💵 Base stake: ${this.cfg.stake.toFixed(2)} ${this.currency()}\n` +
      `${sizingLine}\n` +
      `${calibLine}\n` +
      `${rotationLine}\n` +
      `${pauseLine}\n` +
      `${dayLine}\n` +
      `🧠 Method: <b>Monte Carlo</b> simulation-based differ selection\n` +
      `🕒 Trade day clock: <b>GMT/UTC</b> | EOD: ${this.cfg.eodTimeGmt} GMT\n\n` +
      `💼 Overall Profit: <b>${money(this.stats.overallProfit, this.currency())}</b>\n` +
      `❌ Loss streak: current ${this.stats.currentLossStreak}, x2=${this.stats.lossStreakEvents.x2}, x3=${this.stats.lossStreakEvents.x3}, x4=${this.stats.lossStreakEvents.x4}`
    );

    await this.market.bootstrap(this.cfg.assets);
    this._schedulePause();
    // ⚠️ Aggressive recovery warning — explicit, not silent.
    if (this.cfg.recoveryEnabled && this.cfg.dangerousRecovery && this.cfg.recoveryMaxStep > 1) {
      logger.warn(
        `RECOVERY LADDER IS ARMED AGGRESSIVE: [${this.cfg.recoveryMultipliers.join(', ')}] up to step ${this.cfg.recoveryMaxStep}. ` +
        `A ${this.cfg.recoveryMultipliers[this.cfg.recoveryMaxStep]}× stake on a loss streak can exceed the dailyMaxLoss in one trade. ` +
        `Set DANGEROUS_RECOVERY=false or RECOVERY_MAX_STEP=1 while measuring whether the signal has edge.`
      );
      telegram.send(
        `⚠️ <b>AGGRESSIVE RECOVERY ARMED</b>\n\n` +
        `Ladder <b>[${this.cfg.recoveryMultipliers.join(', ')}]</b>, max step <b>${this.cfg.recoveryMaxStep}</b>.\n` +
        `Step ${this.cfg.recoveryMaxStep} = <b>${(this.cfg.stake * (this.cfg.recoveryMultipliers[this.cfg.recoveryMaxStep] || 1)).toFixed(2)}</b> ${this.cfg.currency} per trade.\n` +
        `This can exceed the ${this.cfg.dailyMaxLoss} daily loss cap in one trade.\n` +
        `Consider DANGEROUS_RECOVERY=false / RECOVERY_MAX_STEP=1 while validating the signal.`
      );
    }
    this._startAnalysisLoop(true);
  }

  /**
   * (Re)start the analysis interval. P0 reliability fix: after ANY
   * reconnect + re-authorize the loop must be re-armed, otherwise the bot
   * silently stops analyzing until restart (the historical "1 trade in 3
   * days" / silent-freeze bug). Resubscribes symbols so tick data keeps
   * flowing after a WS drop.
   */
  async _startAnalysisLoop(initial = false) {
    if (this._analysisT) { clearInterval(this._analysisT); this._analysisT = null; }
    try {
      await this.market.bootstrap(this.cfg.assets);
    } catch (e) {
      logger.warn('re-bootstrap failed:', e.message);
    }
    if (initial) {
      this._analyzeAndTrade().catch(e => logger.error('initial analyze:', e.message));
    }
    this._analysisT = setInterval(() => this._analyzeAndTrade().catch(e => logger.error('analyze:', e.message)), this.cfg.analysisIntervalMs);
    logger.info(`analysis loop armed (interval=${this.cfg.analysisIntervalMs}ms)${initial ? ' (initial)' : ' (after reconnect)'}`);
  }

  _onDisconnected(code, reason, wasAuthorized) {
    telegram.send(`⚠️ <b>MC Connection lost</b>\ncode: <code>${code}</code>\nwas authorized: ${wasAuthorized ? 'yes' : 'no'}\n🔄 reconnecting...`);
    if (this._analysisT) { clearInterval(this._analysisT); this._analysisT = null; }
    // P0: the reconnect + re-authorize flow MUST re-arm the analysis loop,
    // or the bot silently freezes. Wire it to the client's 'authorized'.
    if (!this.client._stopOnReauth) this.client._stopOnReauth = true;
    // Recover stuck trades on disconnect instead of silently clearing them
    if (this.exec.open.size > 0) {
      this._recoverStuckTrade('disconnect');
    }
  }

  /**
   * currentStake(ctx?) — returns the recommended stake for the *next* trade.
   *
   *   • When ctx = { pWin, payoutMult, edgeValue, symbol } and Kelly sizing
   *     is enabled, use Kelly-fractional. Applied to bankroll = live
   *     balance × kellyBankrollFrac, capped at kellyMaxStakeFrac.
   *   • Otherwise fall back to the legacy flat/recovery-multiplier stake.
   *   • In both modes, the per-symbol calibrator's stake-multiplier is
   *     applied last (1.0 enabled, calibProbeStakeFrac probing, 0 disabled).
   */
  currentStake(ctx = null) {
    let base = 0;
    let src  = 'flat';
    if (this.cfg.kellySizingEnabled && ctx && ctx.pWin > 0 && ctx.payoutMult > 1) {
      const bankroll = Math.max(this.cfg.kellyBankrollFloor, this.lastBalance ?? this.client.balance ?? 0);
      const k = this.kelly.compute({
        bankroll,
        pWin      : ctx.pWin,
        payoutMult: ctx.payoutMult,
        edgeValue : ctx.edgeValue ?? 0,
      });
      if (k) {
        base = k.stake;
        src  = `kelly(f*=${k.fStar.toFixed(4)}, applied=${k.fApplied.toFixed(4)}, ${k.reason})`;
      } else {
        // No positive-edge → refuse to size a trade.
        return { stake: 0, source: 'kelly-negative', calibMult: 1 };
      }
    } else {
      let mult = 1;
      if (this.cfg.recoveryEnabled) {
        // HARD CAP: never advance beyond recoveryMaxStep on the ladder.
        // Without `dangerousRecovery`, the ladder is FLAT at step 0 (1×) —
        // a loss streak never escalates. With it, steps are capped at
        // min(ladder length − 1, recoveryMaxStep). This is the blast-radius
        // control that keeps a [1, 13.2, 150] ladder from silently blowing
        // the daily cap on a 2-loss streak.
        const ladderMaxIdx = Math.min(this.cfg.recoveryMultipliers.length - 1, this.cfg.recoveryMaxStep);
        const rawIdx = Math.min(this.stats.currentLossStreak, ladderMaxIdx);
        const idx = this.cfg.dangerousRecovery ? rawIdx : 0;
        mult = this.cfg.recoveryMultipliers[idx] || 1;
      }
      base = +(this.cfg.stake * mult).toFixed(2);
      src  = `flat×${mult}`;
    }
    // Per-symbol calibrator scaling (0 = symbol disabled)
    let calibMult = 1;
    if (ctx?.symbol) calibMult = this.calibrator.stakeMultiplier(ctx.symbol);
    const stake = Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, +(base * calibMult).toFixed(2)));
    return { stake: calibMult === 0 ? 0 : stake, source: src, calibMult };
  }

  async _analyzeAndTrade() {
    if (this.stopped || !this.client.authorized) return;
    if (this._isAnalyzing) {
      logger.debug('analysis still running — skipping overlapping cycle');
      return;
    }
    this._isAnalyzing = true;
    try {
      if (this.paused) {
        logger.debug('trading paused — skipping analysis cycle');
        return;
      }
      // Check if trading is allowed on current day of week
      if (!this._isTradingAllowedToday()) {
        return;
      }
      if (Date.now() - this.lastTradeAt < this.cfg.tradeCooldownMs) return;
      if (this.exec.count() >= this.cfg.maxOpenTrades) return;

      // Tick-based cooldown: don't re-analyze within N ticks of last trade
      if (this._lastTradeTickIdx != null) {
        const ticksSinceTrade = this._tickCounter - this._lastTradeTickIdx;
        if (ticksSinceTrade < this.cfg.cooldownTicks) {
          logger.debug(`cooldownTicks: ${ticksSinceTrade}/${this.cfg.cooldownTicks} — skipping`);
          return;
        }
      }

    const today = utcDateStr();
    const todayTrades = this.stats.todayTrades(today);
    const todayStats = this.stats.stats(todayTrades);
    if (todayStats.count >= this.cfg.dailyMaxTrades) {
      logger.warn(`dailyMaxTrades reached (${todayStats.count}/${this.cfg.dailyMaxTrades})`);
      return;
    }
    if (todayStats.totalProfit <= -Math.abs(this.cfg.dailyMaxLoss)) {
      logger.warn(`dailyMaxLoss reached (${todayStats.totalProfit.toFixed(2)})`);
      return;
    }
    if (this.cfg.dailyMaxProfit > 0 && todayStats.totalProfit >= this.cfg.dailyMaxProfit) {
      logger.info(`dailyMaxProfit reached (${todayStats.totalProfit.toFixed(2)})`);
      return;
    }

    // Per-symbol calibration filter — drop symbols the calibrator has
    // sidelined before we waste any proposal RPCs on them.
    const tradeableAssets = this.cfg.assets.filter(s => this.calibrator.isTradeable(s));
    const disabledAssets  = this.cfg.assets.filter(s => !this.calibrator.isTradeable(s));
    if (disabledAssets.length) {
      logger.debug(`CALIB: sidelined [${disabledAssets.join(',')}]`);
    }
    if (!tradeableAssets.length) {
      logger.warn(`CALIB: all symbols sidelined; will re-probe after cooldown`);
      return;
    }

    const analyses = tradeableAssets.map(s => this.analyzer.analyze(s, this.market.historyFor(s)));
    const ranked = this.analyzer.rank(analyses);
    if (!ranked.length) {
      logger.debug('not enough digit data yet');
      return;
    }

    // ── Filter to MC-approved analyses only ────────────────────────
    const mcApproved = ranked.filter(a => a.allowedByModel || a.mcPasses);
    if (!mcApproved.length) {
      const top = ranked[0];
      logger.info(`[MC] SKIP ALL: gates=[${top?.gates?.join(', ') || 'none'}] reason=${top?.mcReason || 'unknown'}`);
      return;
    }

    // ── Probe proposals for live payout ────────────────────────────
    // Value edge is computed against the CORRECTED loss probability
    // (p̂_WBC, selection-bias-adjusted) so the selection penalty is never
    // rounded into +EV. edge = q_be − p̂_WBC must ALSO clear
    // mcHouseEdgeReserve — a margin for the house + estimation error.
    const probeStake = this.cfg.minStake;
    const proposalCandidates = [];

    for (const a of mcApproved) {
      try {
        const pres = await this.exec.proposal(a.symbol, a.digit, probeStake);
        const p = pres.proposal;
        if (!p?.id) continue;
        const ask = Number(p.ask_price || probeStake);
        const payout = Number(p.payout || 0);
        if (!(payout > ask)) continue;
        const payoutMult = payout / ask;
        const breakEvenLossProb = 1 - ask / payout;
        // pLossUpper is the WBC-corrected loss probability; fall back to
        // raw pEstimate only if the correction is disabled.
        const pLossHonest = a.pLossUpper != null ? a.pLossUpper : a.pEstimate;
        const valueEdge = breakEvenLossProb - pLossHonest;
        const margin = this.cfg.mcHouseEdgeReserve > 0
          ? valueEdge - this.cfg.mcHouseEdgeReserve
          : valueEdge;
        proposalCandidates.push({
          analysis: a,
          proposal: p,
          ask, payout, payoutMult,
          breakEvenLossProb,
          pLossHonest,
          valueEdge,
          margin,
        });
        this.livePayoutMult.set(a.symbol, payoutMult);
      } catch (e) {
        logger.debug(`proposal ${a.symbol} d${a.digit}:`, e.message);
      }
    }

    if (!proposalCandidates.length) {
      logger.debug('[MC] no proposal candidates after payout probe');
      return;
    }

    proposalCandidates.sort((a, b) => b.valueEdge - a.valueEdge);

    // ── Asset rotation ────────────────────────────────────────────
    const rotationMs = Math.max(0, this.cfg.assetRotationMs || 0);
    const lockActive = rotationMs > 0
                    && this.tradedAsset
                    && (Date.now() - (this.tradedAssetAt || 0) < rotationMs);

    // Require the value-edge to clear mcMinEdge AFTER the house reserve.
    // margin = valueEdge − mcHouseEdgeReserve (see above); when reserve is
    // 0, margin === valueEdge and this matches the old mcMinEdge test.
    const qualified = proposalCandidates.filter(c => c.margin >= this.cfg.mcMinEdge);
    if (!qualified.length) {
      const top = proposalCandidates[0];
      if (top) {
        logger.info(
          `[MC] skip: best edge ${top.valueEdge.toFixed(4)} (q_be=${top.breakEvenLossProb.toFixed(4)} − p̂_WBC=${top.pLossHonest.toFixed(4)}) ` +
          `< minEdge ${this.cfg.mcMinEdge}${this.cfg.mcHouseEdgeReserve > 0 ? ' + reserve ' + this.cfg.mcHouseEdgeReserve.toFixed(3) : ''} ` +
          `(${top.analysis.symbol} d${top.analysis.digit})`
        );
      }
      return;
    }

    let best = qualified.find(c => !lockActive || c.analysis.symbol !== this.tradedAsset);
    if (!best) {
      if (lockActive) {
        const ageSec = ((Date.now() - (this.tradedAssetAt || 0)) / 1000).toFixed(1);
        logger.info(
          `[MC] skip: only qualifying symbol is ${this.tradedAsset} — still in ${(rotationMs/1000).toFixed(0)}s rotation cooldown (age ${ageSec}s)`
        );
        return;
      }
      best = qualified[0];
    }
    if (best !== qualified[0]) {
      logger.info(
        `[MC] rotation: skipping locked ${qualified[0].analysis.symbol} → taking ${best.analysis.symbol} d${best.analysis.digit}`
      );
    }

    // ── Compute stake using Kelly + calibrator ────────────────────
    // Win prob = 1 − p̂_WBC (the honest, selection-corrected loss prob).
    const pWin = 1 - best.pLossHonest;
    const sizing = this.currentStake({
      pWin,
      payoutMult: best.payoutMult,
      edgeValue: best.margin,
      symbol: best.analysis.symbol,
    });
    if (!sizing.stake || sizing.stake <= 0) {
      logger.info(`[MC] skip: sizing returned 0 (${sizing.source}, calibMult=${sizing.calibMult})`);
      return;
    }
    const stake = sizing.stake;
    logger.info(`[MC] sizing → stake=${stake.toFixed(2)} src=${sizing.source} calibMult=${sizing.calibMult}`);

    this.tradedAsset   = best.analysis.symbol;
    this.tradedAssetAt = Date.now();
    // Count this acted-on signal toward the per-symbol FDR budget.
    this.analyzer.recordSignal(best.analysis.symbol);

    const a = best.analysis;
    const payload = {
      method: 'MC',
      digit: a.digit,
      observedHitRate: a.observedHitRate,
      expectedHitRate: a.expectedHitRate,
      pEstimate: a.pEstimate,
      pLossUpper: a.pLossUpper,
      predictedPWin: pWin,
      payoutMult: best.payoutMult,
      breakEvenLossProb: best.breakEvenLossProb,
      valueEdge: best.valueEdge,
      margin: best.margin,
      houseEdgeReserve: this.cfg.mcHouseEdgeReserve,
      lastDigit: a.lastDigit,
      sizingSource: sizing.source,
      calibStakeMultiplier: sizing.calibMult,
      calibState: this.calibrator.status(a.symbol),
      currentLossStreak: this.stats.currentLossStreak,
      confidence: a.confidence,
      stability: a.stability,
      pValue: a.pValue,
      mcReason: a.mcReason,
      randomnessFlags: a.randomnessFlags,
      gates: a.gates,
    };

    // Record prediction for cooldown tracking
    this.analyzer.recordPrediction(a.digit, a.symbol);

    const trade = await this.exec.buy(a.symbol, a.digit, stake, payload);

    this.lastTradeAt = Date.now();
    logger.info(
      `[MC] trade placed #${trade.contractId} ${a.symbol} DIGITDIFF differs ${a.digit} ` +
      `hitRate=${(a.observedHitRate*100).toFixed(1)}% p̂_WBC=${a.pLossUpper.toFixed(4)} ` +
      `edge=${best.valueEdge.toFixed(4)} margin=${best.margin.toFixed(4)} ` +
      `confidence=${a.confidence.toFixed(3)} stability=${a.stability.toFixed(3)}`
    );
  } finally {
    this._isAnalyzing = false;
  }
}

  // ── Trade Watchdog ─────────────────────────────────────────────────

  /**
   * _startTradeWatchdog(contractId) — Starts a timer that fires if a
   * trade doesn't settle within tradeWatchdogMs. Attempts to re-subscribe
   * to the contract, then force-releases the lock after a poll timeout.
   */
  _startTradeWatchdog(contractId) {
    this._clearAllWatchdogTimers();
    const timeoutMs = this.tradeWatchdogMs;

    this._watchdogTimer = setTimeout(() => {
      if (!this.exec.open.has(contractId)) {
        logger.debug('Watchdog fired but trade already settled');
        return;
      }

      logger.warn(
        `WATCHDOG FIRED — Contract ${contractId} open for ` +
        `${(timeoutMs / 1000)}s with no settlement`
      );

      if (contractId && this.client.connected && this.client.authorized) {
        logger.info(`Polling contract ${contractId}...`);

        // Forget all existing open-contract subscriptions to avoid duplicates
        this.client._send({
          forget_all: 'proposal_open_contract'
        }).catch(e => logger.debug('forget_all:', e.message));

        // Re-subscribe to get the settlement update
        this.client._send({
          proposal_open_contract: 1,
          contract_id: contractId,
          subscribe: 1
        }, 15000).catch(e => logger.debug('re-subscribe:', e.message));

        // If poll doesn't resolve within 15s, force-recover
        this._watchdogPollTimer = setTimeout(() => {
          if (!this.exec.open.has(contractId)) return;
          logger.error(`WATCHDOG: Poll timeout — contract ${contractId} still unresolved — force-releasing lock`);
          this._recoverStuckTrade('watchdog-force');
        }, 15000);
      } else {
        logger.error('Cannot poll contract — not connected');
        this._recoverStuckTrade('watchdog-offline');
      }
    }, timeoutMs);

    logger.debug(`Watchdog started for ${contractId} (${timeoutMs}ms)`);
  }

  _clearAllWatchdogTimers() {
    if (this._watchdogTimer) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    if (this._watchdogPollTimer) {
      clearTimeout(this._watchdogPollTimer);
      this._watchdogPollTimer = null;
    }
  }

  /**
   * _recoverStuckTrade(reason) — Force-releases stuck trades that never
   * received a settlement update. Logs the event, notifies via Telegram,
   * and clears the open-trades map so the bot can resume.
   */
  _recoverStuckTrade(reason) {
    logger.warn(`Recovery mode: ${reason}`);
    this._clearAllWatchdogTimers();

    const openContracts = [...this.exec.open.entries()];
    if (openContracts.length === 0) {
      logger.debug('No open contracts to recover');
      return;
    }

    for (const [contractId, info] of openContracts) {
      const openSeconds = info.buyTime
        ? Math.round((Date.now() / 1000 - info.buyTime))
        : '?';

      logger.error(
        `STUCK TRADE RECOVERY [${reason}] | Contract: ${contractId} | ` +
        `Symbol: ${info.symbol} | Open for: ${openSeconds}s`
      );

      this.exec.open.delete(contractId);

      telegram.send(
        `⚠️ <b>MC STUCK TRADE RECOVERED [${reason}]</b>\n` +
        `Contract: <code>${contractId}</code>\n` +
        `Symbol: ${info.symbol}\n` +
        `Open for: ${openSeconds}s\n` +
        `Manually verify on Deriv\n` +
        `Overall P/L: ${money(this.stats.overallProfit, this.currency())}`
      );
    }

    logger.warn('Lock released. Bot will continue...');
    this._saveState('stuck-trade-recovery');
  }

  _onTradeOpen(t) {
    const a = t.analysis || {};
    telegram.send(
      `🟢 <b>TRADE OPENED — MC DIGIT DIFFER</b>\n\n` +
      `🎫 Contract: <code>#${t.contractId}</code>\n` +
      `📊 Symbol: <code>${t.symbol}</code>\n` +
      `🔢 Barrier: final digit <b>DIFFERS from ${t.digit}</b>\n` +
      `⏱️ Duration: ${t.durationTicks} tick(s)\n` +
      `💵 Stake: ${t.stake.toFixed(2)} ${this.currency()}\n` +
      `🎁 Payout: ${t.payout.toFixed(2)} ${this.currency()}\n\n` +
      `🎲 <b>MC Analysis</b>\n` +
      `• Observed hit rate: ${((a.observedHitRate || 0)*100).toFixed(1)}%\n` +
      `• Lose probability: ${((a.pEstimate || 0)*100).toFixed(1)}% (expected ~10%)\n` +
      `• Confidence: <b>${((a.confidence || 0)*100).toFixed(1)}%</b> | Stability: ${(a.stability || 0).toFixed(2)}\n` +
      `• Break-even loss prob: ${(a.breakEvenLossProb * 100).toFixed(2)}%\n` +
      `• Value edge: <b>${(a.valueEdge * 100).toFixed(2)}pp</b>\n` +
      `• ${a.mcReason || ''}\n` +
      `• Current loss streak: ${a.currentLossStreak || 0}\n\n` +
      `🕒 ${utcTs()}`
    );

    // Start watchdog timer for this trade
    this._startTradeWatchdog(t.contractId);
  }

  _onTradeResult(t) {
    // Clear watchdog timer — trade has settled
    this._clearAllWatchdogTimers();
    this._lastTradeTickIdx = this._tickCounter;

    const rec = this.stats.record(t);
    this.lastBalance = (this.lastBalance ?? this.client.balance ?? 0) + Number(t.profit || 0);
    if (t.balanceAfter != null) this.lastBalance = Number(t.balanceAfter) + Number(t.profit || 0);

    // ── Feed the per-symbol calibrator ──────────────────────────────
    // Uses the pWin we baked into the trade's analysis payload. Fall
    // back to (1 − pLossUpper) if the field is missing (legacy trades).
    const won        = t.status === 'won';
    const pWinUsed   = Number(t.analysis?.predictedPWin
                        ?? (t.analysis?.pEstimate != null ? 1 - Number(t.analysis.pEstimate) : null));
    let calibNote = '';
    if (this.cfg.calibEnabled && Number.isFinite(pWinUsed) && pWinUsed > 0 && pWinUsed < 1) {
      this.calibrator.record(t.symbol, pWinUsed, won);
      const cs = this.calibrator.summary()[t.symbol];
      if (cs) {
        calibNote = `\n📐 <b>Calib (${t.symbol}):</b> ` +
          `state=${cs.state} n=${cs.n} WR=${cs.empirical.toFixed(2)}% ` +
          `vs pred ${cs.predicted.toFixed(2)}% (gap ${cs.gap >= 0 ? '+' : ''}${cs.gap.toFixed(2)}pp)`;
      }
    }

    // ── Monte Carlo loss tracking ──────────────────────────────────
    // On loss: activate the post-loss cooldown (mcLossCooldownMs). This is
    // the loss-stretcher control; it does NOT size recovery, which is
    // handled separately in currentStake() with a hard ladder cap.
    if (!won) {
      this.lastLossAt = Date.now();
      logger.info(`[MC] LOSS recorded — cooldown ${this.cfg.mcLossCooldownMs/1000}s active`);
    }

    // MC metadata for telegram
    const mcMeta = t.analysis?.mcReason
      ? `\n🎲 <b>MC:</b> confidence=${((t.analysis.confidence || 0)*100).toFixed(1)}% stability=${(t.analysis.stability || 0).toFixed(2)} p=${(t.analysis.pValue || 0).toFixed(4)}`
      : '';

    const emoji = won ? '✅' : '❌';
    const label = won ? 'WIN' : 'LOSS';
    const dur = Math.max(0, Number(t.sellTime || Date.now() / 1000) - Number(t.buyTime || 0));
    const todayStats = this.stats.stats(this.stats.todayTrades(rec.date));

    // Kelly sizing metadata line (only shown when Kelly is on)
    const kellyLine = this.cfg.kellySizingEnabled && t.analysis?.sizingSource
      ? `\n🧮 Sizing: <code>${htmlEscape(String(t.analysis.sizingSource))}</code>`
      : '';

    telegram.send(
      `${emoji} <b>TRADE ${label} — MC DIGIT DIFFER</b>\n\n` +
      `🎫 Contract: <code>#${t.contractId}</code>\n` +
      `📊 Symbol: <code>${t.symbol}</code> | differs <b>${t.digit}</b> | ${t.durationTicks}t\n` +
      `💵 Stake: ${t.stake.toFixed(2)} ${this.currency()}${kellyLine}\n` +
      `💰 P/L: <b>${money(t.profit, this.currency())}</b>\n` +
      `⏱️ Duration: ${dur.toFixed(1)}s\n` +
      mcMeta + '\n\n' +
      `📅 <b>GMT Day Stats (${rec.date})</b>\n` +
      `• Trades: ${todayStats.count} (✅${todayStats.wins} ❌${todayStats.losses})\n` +
      `• Win rate: ${todayStats.winRate.toFixed(1)}%\n` +
      `• Net P/L: <b>${money(todayStats.totalProfit, this.currency())}</b>\n` +
      `• Profit factor: ${todayStats.profitFactor === Infinity ? '∞' : todayStats.profitFactor.toFixed(2)}\n\n` +
      `💼 <b>Overall Profit:</b> ${money(this.stats.overallProfit, this.currency())}\n` +
      `❌ <b>Consecutive Losses:</b> current ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}\n` +
      `   x2=${this.stats.lossStreakEvents.x2}  x3=${this.stats.lossStreakEvents.x3}  x4=${this.stats.lossStreakEvents.x4}` +
      calibNote
    );

    this.lastTradeAt = Date.now();
    this._saveState('after-trade');
  }

  _scheduleSummaries() {
    if (this.cfg.hourlySummary) {
      const now = new Date();
      const msToNextHour = ((59 - now.getUTCMinutes()) * 60_000) + ((60 - now.getUTCSeconds()) * 1000) + 50;
      this._hourlyBoot = setTimeout(() => {
        this._sendHourly();
        this._hourlyT = setInterval(() => this._sendHourly(), 3600_000);
      }, Math.max(1000, msToNextHour));
    }

    const scheduleNextEod = () => {
      const delay = this._msToNextEod();
      this._eodBoot = setTimeout(() => {
        this._sendEod('scheduled');
        scheduleNextEod();
      }, delay);
      logger.info(`next GMT EOD report in ${(delay / 3600000).toFixed(2)}h`);
    };
    scheduleNextEod();
  }
  _parseEodTime() {
    const m = String(this.cfg.eodTimeGmt || '00:00').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return { h: 0, min: 0 };
    return { h: Math.max(0, Math.min(23, Number(m[1]))), min: Math.max(0, Math.min(59, Number(m[2]))) };
  }
  _msToNextEod(now = new Date()) {
    const { h, min } = this._parseEodTime();
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, min, this.cfg.eodSendDelaySeconds, 0));
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
    return target.getTime() - now.getTime();
  }
  _eodReportDate(now = new Date()) {
    const { h, min } = this._parseEodTime();
    // If EOD is at midnight GMT, report the trade day that just ended.
    if (h === 0 && min === 0) return previousUtcDateStr(now);
    return utcDateStr(now);
  }
  _sendHourly() {
    const now = new Date();
    const prev = new Date(now.getTime() - 3600_000);
    const date = utcDateStr(prev);
    const hour = utcHour(prev);
    const list = this.stats.tradesForHour(date, hour);
    const s = this.stats.stats(list);
    if (!list.length) {
      telegram.send(`⏰ <b>MC Hourly Summary GMT (${date} ${pad(hour)}:00-${pad(hour)}:59)</b>\n\nNo trades this hour.\n\n💼 Overall Profit: ${money(this.stats.overallProfit, this.currency())}`);
      return;
    }
    let msg = `⏰ <b>MC Hourly Summary GMT (${date} ${pad(hour)}:00-${pad(hour)}:59)</b>\n\n` +
      `📊 Trades: ${s.count} (✅${s.wins} ❌${s.losses})\n` +
      `📈 Win rate: ${s.winRate.toFixed(1)}%\n` +
      `💰 P/L: <b>${money(s.totalProfit, this.currency())}</b>\n` +
      `💼 Overall Profit: <b>${money(this.stats.overallProfit, this.currency())}</b>\n` +
      `❌ Loss streak current ${this.stats.currentLossStreak} | x2=${this.stats.lossStreakEvents.x2} x3=${this.stats.lossStreakEvents.x3} x4=${this.stats.lossStreakEvents.x4}\n\n` +
      `📋 Detail:\n`;
    list.slice(-20).forEach((t, i) => {
      msg += `${i + 1}. ${t.status === 'won' ? '✅' : '❌'} #${t.contractId} ${t.symbol} d${t.digit} ${money(t.profit, this.currency())}\n`;
    });
    telegram.send(msg);
  }
  _sendEod(reason = 'manual') {
    const date = this._eodReportDate(new Date());
    if (this.stats.isEodSent(date) && reason === 'scheduled') {
      logger.info(`EOD ${date} already sent; skipping duplicate`);
      return;
    }
    const summary = this.stats.archiveDate(date);
    const ds = summary.stats;

    let msg = `🌙 <b>MC END OF TRADE DAY — GMT</b>\n` +
              `📅 Trade day ended: <b>${date}</b>\n\n` +
              `<b>── Current Day Stats ──</b>\n`;
    if (ds.count) {
      msg += `📊 Trades: ${ds.count} (✅${ds.wins} ❌${ds.losses})\n` +
             `📈 Win rate: ${ds.winRate.toFixed(1)}%\n` +
             `💵 Total stake: ${ds.stake.toFixed(2)} ${this.currency()}\n` +
             `💰 Gross win: +${ds.grossWin.toFixed(2)}\n` +
             `📉 Gross loss: -${ds.grossLoss.toFixed(2)}\n` +
             `💼 <b>Net P/L: ${money(ds.totalProfit, this.currency())}</b>\n` +
             `🏆 Profit factor: ${ds.profitFactor === Infinity ? '∞' : ds.profitFactor.toFixed(2)}\n` +
             `❌ Max loss streak today: ${ds.maxLossStreak}\n\n`;
    } else {
      msg += `No trades recorded for this GMT trade day.\n\n`;
    }

    msg += `<b>── Overall / Stored Stats ──</b>\n` +
           `💼 Overall Profit: <b>${money(this.stats.overallProfit, this.currency())}</b>\n` +
           `❌ Consecutive losses: current ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}\n` +
           `   x2=${this.stats.lossStreakEvents.x2}  x3=${this.stats.lossStreakEvents.x3}  x4=${this.stats.lossStreakEvents.x4}\n\n`;

    // Per-symbol calibration snapshot
    if (this.cfg.calibEnabled) {
      const calib = this.calibrator.summary();
      const keys  = Object.keys(calib);
      if (keys.length) {
        msg += `<b>── Symbol Calibration (rolling ${this.cfg.calibWindow}) ──</b>\n`;
        for (const sym of keys) {
          const c = calib[sym];
          const emo = c.state === 'enabled'  ? '🟢'
                    : c.state === 'probing'  ? '🟡'
                    : c.state === 'disabled' ? '🔴' : '⚪';
          msg += `${emo} <code>${sym}</code>: ${c.state} n=${c.n} WR ${c.empirical.toFixed(1)}% vs pred ${c.predicted.toFixed(1)}% (gap ${c.gap >= 0 ? '+' : ''}${c.gap.toFixed(2)}pp)\n`;
        }
        msg += `\n`;
      }
    }

    const rows = this.stats.allDailyRows(date);
    if (rows.length) {
      msg += `<b>── All Trade Days By Date ──</b>\n`;
      for (const row of rows.slice(-60)) {
        const s = row.stats;
        msg += `${row.date}: ${s.count} trades (✅${s.wins}/❌${s.losses}) | WR ${s.winRate.toFixed(1)}% | P/L ${money(s.totalProfit, this.currency())}\n`;
      }
      if (rows.length > 60) msg += `…showing last 60 of ${rows.length} stored trade days.\n`;
    }

    telegram.send(msg);
    this.stats.markEodSent(date);
    this._saveState(`eod-${reason}`);
    this.startBalance = this.client.balance ?? this.lastBalance ?? this.startBalance;
  }

  _statePayload(reason) {
    return {
      // v3 = post pip-fix. Older versions may have been built from
      // wrong-digit history and MUST NOT be blended forward.
      version: 3,
      savedAt: new Date().toISOString(),
      savedReason: reason,
      startBalance: this.startBalance,
      lastBalance: this.lastBalance,
      stats: this.stats.serialize(),
      calibrator: this.calibrator ? this.calibrator.serialize() : {},
    };
  }
  _saveState(reason = 'checkpoint') {
    try {
      const file = this.cfg.stateFile;
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._statePayload(reason), null, 2));
      fs.renameSync(tmp, file);
      logger.debug(`state saved (${reason}) → ${file}`);
    } catch (e) {
      logger.warn('state save failed:', e.message);
    }
  }
  _loadState() {
    const file = this.cfg.stateFile;
    if (!fs.existsSync(file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const v = Number(data.version || 1);

      // Always restore money-flow fields — they're right regardless.
      this.startBalance = data.startBalance ?? null;
      this.lastBalance  = data.lastBalance  ?? null;
      this.stats = new StatisticsManager(data.stats || data);

      // Only restore the calibrator when the state was written by v3+
      // (post pip-fix). Older state was built from wrong digits and
      // would poison the rolling per-symbol win-rate estimates.
      if (v >= 3 && data.calibrator && typeof data.calibrator === 'object') {
        this.calibrator = new SymbolCalibrator(this.cfg, data.calibrator);
        const savedSyms = Object.keys(data.calibrator).length;
        logger.info(`calibrator restored: ${savedSyms} symbols (state v${v})`);
      } else if (data.calibrator) {
        logger.warn(
          `state v${v} calibrator data DISCARDED (pre pip-fix). ` +
          `Calibrator will rebuild from scratch — expect ~${this.cfg.calibMinTrades} trades before it can judge any symbol.`
        );
      }
      logger.info(`state restored from ${file}: overallProfit=${this.stats.overallProfit.toFixed(2)} lossStreak=${this.stats.currentLossStreak} (v${v})`);
    } catch (e) {
      logger.warn(`state load failed (${file}):`, e.message);
    }
  }
  currency() { return this.client.currency || this.cfg.currency; }
  stop(signal) {
    if (this.stopped) return;
    this.stopped = true;
    logger.info(`stopping (${signal})`);
    telegram.send(`🛑 <b>MC Digit Differ Bot stopped</b>\nSignal: ${htmlEscape(signal)}\n💼 Overall Profit: ${money(this.stats.overallProfit, this.currency())}`);
    if (this._analysisT) clearInterval(this._analysisT);
    this._clearPauseTimers();
    this._clearAllWatchdogTimers();
    if (this._hourlyBoot) clearTimeout(this._hourlyBoot);
    if (this._hourlyT) clearInterval(this._hourlyT);
    if (this._eodBoot) clearTimeout(this._eodBoot);
    if (this._eodT) clearInterval(this._eodT);
    this._saveState('shutdown');
    this.client.stop();
    setTimeout(() => process.exit(0), 2500);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 10b. DIFFER BACKTESTER
// ─────────────────────────────────────────────────────────────────────
/**
 * Historical simulator for the MC-based differ strategy.
 *
 *   1. Deep-fetch N ticks (default 100K) via ticks_history in 5K batches.
 *   2. For each index i (starting at minWindow) walk the history:
 *        a. Slice ticks[0..i] as the "known" series.
 *        b. Run MonteCarloAnalyzer.analyze() on the slice.
 *        c. If MC-recommended, compute the value-edge
 *           against a *synthetic* payout (BACKTEST_PAYOUT_MULT × stake)
 *           and check the same live-trade filters (mcMinEdge,
 *           MC stability, optional tradedAsset lock).
 *        d. If the trade would fire, look up the actual expiry digit
 *           `ticks[i + durationTicks].digit` and settle:
 *              - loss if expiryDigit == barrierDigit
 *              - win  otherwise (P/L = payout - stake)
 *        e. Advance i by durationTicks+1 on a trade, else by 1.
 *   3. Report: signals, wins, losses, empirical win-rate vs
 *      predicted P(win), edge distribution histogram, consecutive-loss
 *      streak statistics (x2/x3/x4/x5/x6/x7/x8+), calibration gap,
 *      per-symbol and per-barrier-digit breakdowns.
 *
 *  All overrides are applied to a LOCAL config copy — live trading
 *  cfg is never mutated.
 */
class DifferBacktester {
  constructor(cfg, client, market) {
    this.cfg       = { ...cfg };
    this.overrides = {};
    this.client    = client;
    this.market    = market;
    this.analyzer  = new MonteCarloAnalyzer(this.cfg);
  }

  async run(symbols) {
    // Validate symbol list
    const list = Array.isArray(symbols) ? symbols : [symbols];
    if (!list.length) throw new Error('no symbols to backtest');

    const banner = '─'.repeat(72);
    console.log(`\n${banner}`);
    console.log(`  DIFFER BACKTEST — symbols=[${list.join(', ')}]  ticks=${this.cfg.backtestTicks}`);
    console.log(banner);
    if (Object.keys(this.overrides).length) {
      console.log(`  overrides applied: ${JSON.stringify(this.overrides)}`);
    }
    console.log(
      `  MC gates: sims=${this.cfg.mcSimulations}  ` +
      `confidence=${this.cfg.minEdgeConfidence}  stability=${this.cfg.mcStabilityThreshold}\n` +
      `           mcMinEdge=${this.cfg.mcMinEdge}  ` +
      `duration=${this.cfg.durationTicks}t  payoutMult=${this.cfg.backtestPayoutMult}  ` +
      `assetLock=${this.cfg.backtestAssetLock}`
    );
    console.log(banner);

    const combined = { signals: 0, wins: 0, losses: 0, pnl: 0, grossWin: 0, grossLoss: 0 };
    const reports  = [];
    for (const sym of list) {
      const r = await this._runOne(sym);
      reports.push(r);
      combined.signals   += r.signals;
      combined.wins      += r.wins;
      combined.losses    += r.losses;
      combined.pnl       += r.pnl;
      combined.grossWin  += r.grossWin;
      combined.grossLoss += r.grossLoss;
    }

    if (reports.length > 1) {
      console.log(`\n${banner}`);
      console.log('  COMBINED (all symbols):');
      console.log(`    signals=${combined.signals}  wins=${combined.wins}  losses=${combined.losses}`);
      const wr = combined.signals ? (combined.wins / combined.signals * 100) : 0;
      console.log(`    WR=${wr.toFixed(2)}%   Net P/L=${combined.pnl >= 0 ? '+' : ''}${combined.pnl.toFixed(2)} ${this.cfg.currency}`);
      const pf = combined.grossLoss > 0 ? combined.grossWin / combined.grossLoss : (combined.grossWin > 0 ? Infinity : 0);
      console.log(`    PF=${pf === Infinity ? '∞' : pf.toFixed(3)}`);
      console.log(banner + '\n');
    }

    try {
      const payload = {
        savedAt : new Date().toISOString(),
        gates   : this._gateSnapshot(),
        symbols : reports,
        combined,
      };
      fs.writeFileSync(this.cfg.backtestOutFile, JSON.stringify(payload, null, 2));
      logger.info(`report written → ${this.cfg.backtestOutFile}`);
    } catch (e) {
      logger.warn(`could not write report: ${e.message}`);
    }
    return reports;
  }

  _gateSnapshot() {
    return {
      mcMinEdge         : this.cfg.mcMinEdge,
      minEdgeConfidence : this.cfg.minEdgeConfidence,
      mcStabilityThreshold: this.cfg.mcStabilityThreshold,
      mcSimulations     : this.cfg.mcSimulations,
      durationTicks     : this.cfg.durationTicks,
      payoutMultiplier  : this.cfg.backtestPayoutMult,
    };
  }

  /**
   * Fire a live proposal to discover the actual payout multiplier Deriv
   * is quoting right now. Returns fallback on failure.
   */
  async _probeLivePayoutMult(symbol) {
    try {
      const symbolKey = this.client.symbolField();
      const res = await this.client._send({
        proposal      : 1,
        amount        : this.cfg.stake,
        basis         : 'stake',
        contract_type : 'DIGITDIFF',
        currency      : this.cfg.currency,
        duration      : this.cfg.durationTicks,
        duration_unit : 't',
        barrier       : '0',
        [symbolKey]   : symbol,
      }, 15000);
      const p = res?.proposal;
      if (!p) return null;
      const ask    = Number(p.ask_price || this.cfg.stake);
      const payout = Number(p.payout    || 0);
      if (!(payout > 0 && ask > 0)) return null;
      return payout / ask;   // total payout per unit stake
    } catch (e) {
      logger.warn(`live payout probe (${symbol}) failed: ${e.message}`);
      return null;
    }
  }

  async _runOne(symbol) {
    const banner = '─'.repeat(72);
    console.log(`\n${banner}`);
    console.log(`  ${symbol}`);
    console.log(banner);

    // 0. Probe live payout multiplier (so the value-edge math matches
    //    live trading exactly).
    let payoutMult = this.cfg.backtestPayoutMult;
    if (this.cfg.backtestProbeLive) {
      const probed = await this._probeLivePayoutMult(symbol);
      if (probed) {
        logger.info(`live payout probe: ${symbol} → ×${probed.toFixed(4)} (was fallback ×${payoutMult})`);
        payoutMult = probed;
      } else {
        logger.warn(`using fallback payout multiplier ×${payoutMult}`);
      }
    }

    // 1. Fetch ticks
    logger.info(`fetching historical ticks (${symbol}, batched)…`);
    const ticks = await this.market.deepBackfill(
      symbol, this.cfg.backtestTicks, this.cfg.backtestBatchSize,
      (got, tot) => {
        if (got % 20000 < this.cfg.backtestBatchSize) logger.info(`  fetched ${got}/${tot}`);
      },
    );
    let pip = this.market.pipSize(symbol);
    // Belt-and-suspenders: if loadSymbols never populated pip_size for
    // this symbol (e.g. the user is on an older version that requests
    // active_symbols: 'brief'), infer it directly from the tick stream.
    // Deriv volatility indices always use a fixed decimal count per
    // symbol so this is a safe recovery.
    if (!Number.isFinite(pip)) {
      const sample = ticks.slice(-Math.min(50, ticks.length));
      const decCounts = new Map();
      for (const t of sample) {
        const s = String(t.quote);
        const dot = s.indexOf('.');
        const dec = dot < 0 ? 0 : s.length - dot - 1;
        decCounts.set(dec, (decCounts.get(dec) || 0) + 1);
      }
      let bestDec = 2, bestN = 0;
      for (const [d, n] of decCounts) if (n > bestN) { bestDec = d; bestN = n; }
      pip = bestDec;
      logger.warn(`pipSize(${symbol}) not cached — inferred pip=${pip} from tick stream`);
      // Push it into the market cache so downstream code (analyze,
      // recomputes) uses the same value.
      this.market.pipSizes.set(symbol, pip);
      // Also patch every tick's digit field so it reflects the
      // correct pip. Without this, the analyzer would use the old
      // (wrong) digits and every empirical WR would be garbage.
      for (const t of ticks) t.digit = quoteToDigit(t.quote, pip);
    }
    if (ticks.length < this.cfg.minTicksForAnalysis + this.cfg.durationTicks + 10) {
      throw new Error(`insufficient history for ${symbol}: got ${ticks.length}`);
    }
    logger.info(
      `have ${ticks.length} ticks  pip=${pip}  ` +
      `span=${new Date(ticks[0].epoch*1000).toISOString().slice(0,19)}Z → ` +
      `${new Date(ticks[ticks.length-1].epoch*1000).toISOString().slice(0,19)}Z`
    );

    // 2. Walk forward
    const baseStake   = this.cfg.stake;
    // `payoutMult` = total payout per 1 stake (includes returned stake),
    // probed live above. On DIGITDIFF this is typically ~1.10.
    const duration    = Math.max(1, this.cfg.durationTicks);
    const minWindow   = Math.max(this.cfg.minTicksForAnalysis, 300);

    // Local Kelly + calibrator instances so the backtest mirrors live logic.
    const kelly       = new KellySizer(this.cfg);
    const calib       = new SymbolCalibrator(this.cfg);
    // Simulated bankroll: starts at 100× base stake unless the user sets
    // KELLY_BANKROLL_FLOOR to something explicit.
    let simBankroll   = Math.max(this.cfg.kellyBankrollFloor, baseStake * 100);
    const startBankroll = simBankroll;

    logger.info(
      `sim: baseStake=${baseStake} payoutMult=×${payoutMult.toFixed(4)}  ` +
      `kelly=${this.cfg.kellySizingEnabled ? 'ON' : 'off'}  ` +
      `calib=${this.cfg.calibEnabled ? 'ON' : 'off'}  ` +
      `startBankroll=${simBankroll.toFixed(2)}`
    );

    const results = {
      symbol,
      pip,
      startEpoch : ticks[0].epoch,
      endEpoch   : ticks[ticks.length - 1].epoch,
      tickCount  : ticks.length,
      signals    : 0,
      wins       : 0,
      losses     : 0,
      pnl        : 0,
      grossWin   : 0,
      grossLoss  : 0,
      predictedWinSum : 0,   // sum of (1 - pEstimate) across all signals
      valueEdgeSum    : 0,
      byDigit    : {},       // barrier-digit histogram
    };
    for (let d = 0; d < 10; d++) results.byDigit[d] = { signals: 0, wins: 0, losses: 0, pnl: 0 };

    const diag = {
      scans          : 0,
      nullAnalyses   : 0,
      mcNotRecommended: 0,
      mcNotStable    : 0,
      mcEdgeLow      : 0,
      gatedEdge      : 0,   // value edge < mcMinEdge
      gatedAssetLock : 0,
      recommended    : 0,
      bestEdgeSeen   : -Infinity,
      edgeBuckets    : {
        '<0.000'      : 0,
        '0.000-0.002' : 0,
        '0.002-0.004' : 0,
        '0.004-0.006' : 0,
        '0.006-0.010' : 0,
        '0.010-0.020' : 0,
        '0.020-0.040' : 0,
        '>=0.040'     : 0,
      },
    };
    const bucketize = (edge) => {
      if (edge <  0.000) return '<0.000';
      if (edge <  0.002) return '0.000-0.002';
      if (edge <  0.004) return '0.002-0.004';
      if (edge <  0.006) return '0.004-0.006';
      if (edge <  0.010) return '0.006-0.010';
      if (edge <  0.020) return '0.010-0.020';
      if (edge <  0.040) return '0.020-0.040';
      return '>=0.040';
    };

    // Loss-streak tracker — same semantics as StatisticsManager
    const streak = {
      current      : 0, max: 0,
      currentWin   : 0, maxWin: 0,
      events       : { x2:0, x3:0, x4:0, x5:0, x6:0, x7:0, x8plus:0 },
      lossSequences: [],
      winSequences : [],
    };
    const bumpEvent = (n) => {
      if (n === 2) streak.events.x2++;
      else if (n === 3) streak.events.x3++;
      else if (n === 4) streak.events.x4++;
      else if (n === 5) streak.events.x5++;
      else if (n === 6) streak.events.x6++;
      else if (n === 7) streak.events.x7++;
      else if (n >= 8)  streak.events.x8plus++;
    };
    const recordOutcome = (won) => {
      if (won) {
        if (streak.current > 0) streak.lossSequences.push(streak.current);
        streak.current    = 0;
        streak.currentWin += 1;
        if (streak.currentWin > streak.maxWin) streak.maxWin = streak.currentWin;
      } else {
        if (streak.currentWin > 0) streak.winSequences.push(streak.currentWin);
        streak.currentWin  = 0;
        streak.current    += 1;
        if (streak.current > streak.max) streak.max = streak.current;
        bumpEvent(streak.current);
      }
    };

    const t0 = Date.now();
    let tradedAsset    = null;   // mirrors bot.tradedAsset when assetLock=true
    let lastTradeAtIdx = -Infinity;
    let i = minWindow;

    while (i < ticks.length - duration - 1) {
      const window   = ticks.slice(0, i + 1);
      const analysis = this.analyzer.analyze(symbol, window);
      diag.scans++;

      if (!analysis) { diag.nullAnalyses++; i++; continue; }

      // MC-only gate checks
      if (!analysis.allowedByModel && !analysis.mcPasses) {
        diag.mcNotRecommended++;
        if (analysis.confidence < this.cfg.minEdgeConfidence) diag.mcEdgeLow++;
        i++; continue;
      }

      // Compute value edge using the CORRECTED lose probability
      // (p̂_WBC — same as live), so backtest matches live exactly.
      const ask = baseStake;
      const payoutFull = baseStake * payoutMult;
      const breakEvenLossProb = 1 - ask / payoutFull;
      const pLossHonest = analysis.pLossUpper != null ? analysis.pLossUpper : analysis.pEstimate;
      const valueEdge = breakEvenLossProb - pLossHonest;
      const margin = this.cfg.mcHouseEdgeReserve > 0 ? valueEdge - this.cfg.mcHouseEdgeReserve : valueEdge;

      if (valueEdge > diag.bestEdgeSeen) diag.bestEdgeSeen = valueEdge;
      diag.edgeBuckets[bucketize(valueEdge)]++;

      // Would this trade actually fire?
      let fire = true;
      if (margin < this.cfg.mcMinEdge)                           { fire = false; diag.gatedEdge++; }
      // Asset-lock
      if (fire && this.cfg.backtestAssetLock && tradedAsset === symbol
          && (i - lastTradeAtIdx) < this.cfg.backtestAssetLockTicks) {
        fire = false; diag.gatedAssetLock++;
      }
      // Per-symbol calibrator gate (0 = disabled) — only applied when calibEnabled
      let calibMult = 1;
      if (fire && this.cfg.calibEnabled) {
        calibMult = calib.stakeMultiplier(symbol);
        if (calibMult === 0) { fire = false; diag.gatedCalib = (diag.gatedCalib || 0) + 1; }
      }

      if (!fire) { i++; continue; }

      // ── Size the trade ─────────────────────────────────────────
      // Match live currentStake(): Kelly + calibrator when enabled,
      // otherwise flat.  All results below use this per-trade stake.
      let stake = baseStake;
      let sizingSrc = 'flat';
      if (this.cfg.kellySizingEnabled) {
        const pWin = 1 - pLossHonest;
        const k    = kelly.compute({
          bankroll  : Math.max(this.cfg.kellyBankrollFloor, simBankroll),
          pWin, payoutMult, edgeValue: margin,
        });
        if (k) { stake = k.stake; sizingSrc = `kelly(${k.reason})`; }
        else   { i++; continue; }   // no positive-edge under Kelly → skip
      }
      stake = Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, +(stake * calibMult).toFixed(2)));
      if (stake <= 0) { i++; continue; }

      const winNet  = stake * payoutMult - stake;
      const lossNet = -stake;

      // ── Simulate settlement ────────────────────────────────────
      const expiryTick = ticks[i + duration];
      if (!expiryTick || expiryTick.digit == null) { i++; continue; }
      const won = expiryTick.digit !== analysis.digit;

      results.signals += 1;
      results.predictedWinSum += (1 - pLossHonest);
      results.valueEdgeSum    += valueEdge;
      results.byDigit[analysis.digit].signals += 1;
      diag.recommended += 1;

      if (won) {
        results.wins       += 1;
        results.grossWin   += winNet;
        results.pnl        += winNet;
        results.byDigit[analysis.digit].wins += 1;
        results.byDigit[analysis.digit].pnl  += winNet;
        simBankroll += winNet;
      } else {
        results.losses     += 1;
        results.grossLoss  += Math.abs(lossNet);
        results.pnl        += lossNet;
        results.byDigit[analysis.digit].losses += 1;
        results.byDigit[analysis.digit].pnl    += lossNet;
        simBankroll += lossNet;
      }
      recordOutcome(won);

      // Feed the calibrator (only if enabled)
      if (this.cfg.calibEnabled) calib.record(symbol, 1 - pLossHonest, won);

      tradedAsset    = symbol;
      lastTradeAtIdx = i;
      i += duration + 1;

      if (results.signals % 100 === 0) {
        const wr = (results.wins / results.signals * 100).toFixed(1);
        logger.info(`  ...${i}/${ticks.length} signals=${results.signals} WR=${wr}% pnl=${results.pnl.toFixed(2)} bank=${simBankroll.toFixed(2)}`);
      }
    }

    results.endBankroll   = +simBankroll.toFixed(2);
    results.startBankroll = +startBankroll.toFixed(2);
    results.bankrollGrowthPct = startBankroll > 0
      ? +(((simBankroll - startBankroll) / startBankroll) * 100).toFixed(2)
      : 0;
    results.calibSummary  = calib.summary();

    // Flush trailing streak
    if (streak.current    > 0) streak.lossSequences.push(streak.current);
    if (streak.currentWin > 0) streak.winSequences.push(streak.currentWin);

    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const empiricalWR = results.signals ? results.wins / results.signals * 100 : 0;
    const predictedWR = results.signals ? (results.predictedWinSum / results.signals) * 100 : 0;
    const avgEdge     = results.signals ? (results.valueEdgeSum / results.signals) * 100 : 0;
    // Realized EV as % of *base* stake, so the number is comparable
    // across Kelly/flat/calibration modes.
    const realizedEV  = results.signals ? (results.pnl / (results.signals * baseStake)) * 100 : 0;

    // Loss-streak metrics
    const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
    const streakMetrics = {
      maxLossStreak       : streak.max,
      maxWinStreak        : streak.maxWin,
      events              : streak.events,
      probAtLeast         : {
        x2: +((streak.events.x2 + streak.events.x3 + streak.events.x4 + streak.events.x5 + streak.events.x6 + streak.events.x7 + streak.events.x8plus) / Math.max(1, results.signals)).toFixed(4),
        x3: +((streak.events.x3 + streak.events.x4 + streak.events.x5 + streak.events.x6 + streak.events.x7 + streak.events.x8plus) / Math.max(1, results.signals)).toFixed(4),
        x4: +((streak.events.x4 + streak.events.x5 + streak.events.x6 + streak.events.x7 + streak.events.x8plus) / Math.max(1, results.signals)).toFixed(4),
        x5: +((streak.events.x5 + streak.events.x6 + streak.events.x7 + streak.events.x8plus) / Math.max(1, results.signals)).toFixed(4),
      },
      avgLossRun          : +avg(streak.lossSequences).toFixed(2),
      avgWinRun           : +avg(streak.winSequences).toFixed(2),
      lossRuns            : streak.lossSequences.length,
      winRuns             : streak.winSequences.length,
      maxDrawdownFlatStake: +(streak.max * baseStake).toFixed(2),
      // Simulated recovery-multiplier drawdown: what you'd lose in cash
      // through the WORST loss run using cfg.recoveryMultipliers.
      maxDrawdownRecovery : (() => {
        if (!this.cfg.recoveryEnabled || !this.cfg.recoveryMultipliers?.length) return null;
        const mults = this.cfg.recoveryMultipliers;
        let sum = 0;
        for (let k = 0; k < streak.max; k++) {
          const idx = Math.min(k, mults.length - 1);
          sum += baseStake * (mults[idx] || 1);
        }
        return +sum.toFixed(2);
      })(),
    };

    // Assemble result object
    Object.assign(results, {
      durationSec       : +dt,
      empiricalWinRate  : +empiricalWR.toFixed(2),
      predictedWinRate  : +predictedWR.toFixed(2),
      calibrationGap    : +(empiricalWR - predictedWR).toFixed(2),
      avgValueEdgePct   : +avgEdge.toFixed(3),
      realizedEVPct     : +realizedEV.toFixed(3),
      profitFactor      : results.grossLoss > 0 ? +(results.grossWin / results.grossLoss).toFixed(3) : Infinity,
      diagnostics       : diag,
      streaks           : streakMetrics,
    });

    // ── Print report ───────────────────────────────────────────
    const line = '─'.repeat(72);
    console.log('\n' + line);
    console.log(`  DIFFER BACKTEST REPORT — ${symbol}`);
    console.log(line);
    console.log(`  Window          : ${new Date(results.startEpoch*1000).toISOString().slice(0,19)}Z → ${new Date(results.endEpoch*1000).toISOString().slice(0,19)}Z`);
    console.log(`  Ticks processed : ${ticks.length.toLocaleString()}   pip_size=${pip}`);
    console.log(`  Signals fired   : ${results.signals}`);
    console.log(`  Wins / Losses   : ${results.wins} / ${results.losses}`);
    console.log(`  Empirical WR    : ${empiricalWR.toFixed(2)}%`);
    console.log(`  Predicted P(win): ${predictedWR.toFixed(2)}%   (calibration gap ${(empiricalWR - predictedWR).toFixed(2)} pp)`);
    console.log(`  Avg value edge  : ${avgEdge.toFixed(3)}%   Realized EV: ${realizedEV.toFixed(3)}%`);
    console.log(`  Gross win / loss: +${results.grossWin.toFixed(2)} / -${results.grossLoss.toFixed(2)}`);
    console.log(`  Net P/L         : ${results.pnl >= 0 ? '+' : ''}${results.pnl.toFixed(2)} ${this.cfg.currency}`);
    console.log(`  Profit factor   : ${results.profitFactor === Infinity ? '∞' : results.profitFactor.toFixed(3)}`);
    console.log(`  Runtime         : ${dt}s`);
    console.log(line);
    console.log('  Per-barrier-digit breakdown:');
    for (let d = 0; d < 10; d++) {
      const r = results.byDigit[d];
      if (!r.signals) continue;
      const wr = (r.wins / r.signals * 100).toFixed(1);
      console.log(`    d=${d}   signals=${String(r.signals).padStart(4)}   WR=${wr}%   pnl=${(r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(2)}`);
    }

    // ── Consecutive-loss stats ────────────────────────────────
    console.log(line);
    console.log('  Consecutive-loss stats (flat stake):');
    console.log(`    Max loss streak       : ${streakMetrics.maxLossStreak}  ` +
                `(worst DD at flat stake: -${streakMetrics.maxDrawdownFlatStake.toFixed(2)} ${this.cfg.currency})`);
    console.log(`    Max win  streak       : ${streakMetrics.maxWinStreak}`);
    console.log(`    Avg loss run length   : ${streakMetrics.avgLossRun}   (${streakMetrics.lossRuns} runs)`);
    console.log(`    Avg win  run length   : ${streakMetrics.avgWinRun}   (${streakMetrics.winRuns} runs)`);
    console.log(`    Streak events (times a loss run reached that length):`);
    console.log(`      x2 (2 in a row) : ${String(streakMetrics.events.x2).padStart(4)}  ` +
                `P(≥2) ≈ ${(streakMetrics.probAtLeast.x2*100).toFixed(2)}% of signals`);
    console.log(`      x3 (3 in a row) : ${String(streakMetrics.events.x3).padStart(4)}  ` +
                `P(≥3) ≈ ${(streakMetrics.probAtLeast.x3*100).toFixed(2)}% of signals`);
    console.log(`      x4 (4 in a row) : ${String(streakMetrics.events.x4).padStart(4)}  ` +
                `P(≥4) ≈ ${(streakMetrics.probAtLeast.x4*100).toFixed(2)}% of signals`);
    console.log(`      x5 (5 in a row) : ${String(streakMetrics.events.x5).padStart(4)}  ` +
                `P(≥5) ≈ ${(streakMetrics.probAtLeast.x5*100).toFixed(2)}% of signals`);
    console.log(`      x6 (6 in a row) : ${String(streakMetrics.events.x6).padStart(4)}`);
    console.log(`      x7 (7 in a row) : ${String(streakMetrics.events.x7).padStart(4)}`);
    console.log(`      x8+ (≥8)        : ${String(streakMetrics.events.x8plus).padStart(4)}`);
    if (streakMetrics.maxDrawdownRecovery != null) {
      console.log(`    Worst DD using cfg.recoveryMultipliers [${this.cfg.recoveryMultipliers.join(',')}]: -${streakMetrics.maxDrawdownRecovery.toFixed(2)} ${this.cfg.currency}`);
    }
    if (results.signals > 0 && empiricalWR > 0 && empiricalWR < 100) {
      const q       = 1 - (empiricalWR / 100);
      const nTrades = results.signals;
      const expected = Math.log(nTrades * q) / Math.log(1 / q);
      console.log(`    Expected longest loss run (iid @ WR=${empiricalWR.toFixed(1)}%): ~${expected.toFixed(1)} in ${nTrades} trades`);
      if (streakMetrics.maxLossStreak > expected * 1.5) {
        console.log(`    ⚠ Observed max streak ${streakMetrics.maxLossStreak} >> expected — losses may be autocorrelated.`);
      }
    }

    // ── Bankroll evolution (Kelly-sizing view) ────────────────
    if (this.cfg.kellySizingEnabled) {
      console.log(line);
      console.log('  Kelly-sizing bankroll evolution:');
      console.log(`    Start bankroll     : ${results.startBankroll.toFixed(2)} ${this.cfg.currency}`);
      console.log(`    End   bankroll     : ${results.endBankroll.toFixed(2)} ${this.cfg.currency}`);
      const dollarPl = results.endBankroll - results.startBankroll;
      console.log(`    Δ                  : ${dollarPl >= 0 ? '+' : ''}${dollarPl.toFixed(2)} (${results.bankrollGrowthPct >= 0 ? '+' : ''}${results.bankrollGrowthPct}%)`);
      console.log(`    Kelly fraction     : ${this.cfg.kellyFraction}  (cap ${(this.cfg.kellyMaxStakeFrac*100).toFixed(2)}% bankroll)`);
    }

    // ── Per-symbol calibrator snapshot ────────────────────────
    if (this.cfg.calibEnabled) {
      const cs = results.calibSummary || {};
      if (Object.keys(cs).length) {
        console.log(line);
        console.log('  Calibration snapshot (rolling window):');
        for (const [sym, c] of Object.entries(cs)) {
          const dot = c.state === 'enabled' ? '🟢' : c.state === 'probing' ? '🟡' : '🔴';
          console.log(`    ${dot} ${sym}  state=${c.state}  n=${c.n}  WR=${c.empirical.toFixed(2)}%  pred=${c.predicted.toFixed(2)}%  gap=${c.gap >= 0 ? '+' : ''}${c.gap.toFixed(2)}pp`);
        }
        if (diag.gatedCalib) console.log(`    scans skipped by calibrator: ${diag.gatedCalib}`);
      }
    }

    // ── Diagnostics ───────────────────────────────────────────
    const bestEdgeStr = diag.bestEdgeSeen === -Infinity ? 'n/a' : (diag.bestEdgeSeen*100).toFixed(3)+'%';
    console.log(line);
    console.log('  MC Diagnostics:');
    console.log(`    scans                : ${diag.scans}`);
    console.log(`    null analyses        : ${diag.nullAnalyses}   (window too short)`);
    console.log(`    MC not recommended   : ${diag.mcNotRecommended}`);
    console.log(`      - not stable      : ${diag.mcNotStable}`);
    console.log(`      - edge too low    : ${diag.mcEdgeLow}`);
    console.log(`    signals actually fired: ${diag.recommended}`);
    console.log(`    rejected by minEdge  : ${diag.gatedEdge}   (needed ≥ ${(this.cfg.mcMinEdge*100).toFixed(3)}%)`);
    console.log(`    rejected by assetLock: ${diag.gatedAssetLock}`);
    console.log(`    best value edge seen : ${bestEdgeStr}   (min ${(this.cfg.mcMinEdge*100).toFixed(3)}%)`);

    // Edge histogram
    const total = Object.values(diag.edgeBuckets).reduce((a, b) => a + b, 0);
    if (total > 0) {
      console.log('');
      console.log('  Value-edge distribution (all analyzed candidates):');
      const maxBar   = 40;
      const maxCount = Math.max(...Object.values(diag.edgeBuckets));
      for (const [bucket, count] of Object.entries(diag.edgeBuckets)) {
        const pct  = (count / total * 100);
        const bars = maxCount > 0 ? Math.round((count / maxCount) * maxBar) : 0;
        console.log(`    ${bucket.padEnd(14)} ${String(count).padStart(6)}  ${pct.toFixed(1).padStart(5)}%  ${'█'.repeat(bars)}`);
      }
    }

    // Suggestions
    if (diag.recommended === 0 && diag.scans > 0) {
      console.log('');
      console.log('  💡 No signals fired. Suggestions:');
      if (diag.bestEdgeSeen !== -Infinity && diag.bestEdgeSeen < this.cfg.mcMinEdge) {
        console.log(`     • Best value-edge observed: ${(diag.bestEdgeSeen*100).toFixed(3)}%`);
        console.log(`       Try lowering MC_MIN_EDGE below ${(diag.bestEdgeSeen*100).toFixed(3)}%`);
      }
      if (diag.mcNotStable > 0) {
        console.log(`     • ${diag.mcNotStable} scans rejected: MC edge not stable across resamples`);
        console.log(`       Try lowering MC_EDGE_THRESHOLD or MC_RESAMPLE_PASSES`);
      }
      if (diag.mcEdgeLow > 0) {
        console.log(`     • ${diag.mcEdgeLow} scans rejected: confidence below threshold`);
        console.log(`       Current minEdgeConfidence=${this.cfg.minEdgeConfidence}`);
      }
    }
    console.log(line + '\n');

    return results;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 11. BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────
function printBanner() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║   Deriv DIGITDIFF — honest MC + value-edge          ║');
  console.log('║   exact-multinomial null • FDR • GMT EOD • Stateful ║');
  console.log('║   idle-on-fair is working; edge must beat house     ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log('');
}
async function main() {
  printBanner();
  if (!CONFIG.apiToken) {
    console.error('❌ DERIV_API_TOKEN is not set. Create a .env file or export it.');
    process.exit(1);
  }
  if (RestClient.isPat(CONFIG.apiToken) && !CONFIG.accountId) {
    console.warn('⚠️  PAT token detected. DERIV_ACCOUNT_ID is strongly recommended and may be required by the new Deriv API.');
  }
  console.log(CONFIG.telegram.enabled ? '✅ Telegram notifications: ENABLED' : 'ℹ️  Telegram notifications: DISABLED');

  // ── NULL SELFTEST ────────────────────────────────────────────────
  //   node accurateDiffer3_monte-carlos.js --selftest
  //   Runs the FULL decision pipeline on SYNTHETIC UNIFORM digits (the
  //   fair null). The bot is CORRECT when it trades ~never here: any
  //   significant trade rate means the MC/value gates are leaking noise.
  //   No network, no credentials, no orders — pure in-process harness.
  if (process.argv.includes('--selftest')) {
    const analyzer = new MonteCarloAnalyzer(CONFIG);
    const N = Number(process.env.SELFTEST_SCANS) || 1000;
    const winLen = CONFIG.minTicksForAnalysis;
    let passed = 0, traded = 0, joint = 0, gatedByConf = 0, gatedByStab = 0;
    let tradedDays = 0;
    const t0 = Date.now();
    for (let s = 0; s < N; s++) {
      const digits = [];
      for (let i = 0; i < winLen; i++) digits.push(Math.floor(analyzer._rand() * 10));
      const analysis = analyzer.analyze('R_50_SELFTEST', digits.map((d, i) => ({ digit: d, epoch: i, quote: i })));
      if (analysis && analysis.mcPasses) passed++;
      // Simulate the live value-edge probe under a fair null: the quoted
      // q_be ≈ 0.0909, and p̂_WBC ≈ 0.10 ⇒ edge ≈ 0.0909 − 0.10 < 0.
      if (analysis) {
        if (analysis.confidence < CONFIG.minEdgeConfidence) gatedByConf++;
        if (analysis.stability < CONFIG.mcStabilityThreshold) gatedByStab++;
        const qbe = 1 - 1 / (CONFIG.backtestPayoutMult);
        const edge = qbe - (analysis.pLossUpper != null ? analysis.pLossUpper : analysis.pEstimate);
        if (edge >= CONFIG.mcMinEdge + CONFIG.mcHouseEdgeReserve) {
          traded++;           // value-edge alone would fire (per-scan)
          if (analysis.mcPasses) joint++;   // TRUE false-trade rate (MC AND edge)
        }
      }
      // Approximate FDR cap: across the whole run the per-symbol budget
      // would allow at most mcFdrBudget acted-on signals "per day". If we
      // bucket the run into ~100-scan days, count how many days exceed it.
      if (CONFIG.mcFdrBudget > 0 && traded % 100 === 0 && traded > 0) tradedDays++;
    }
    const ms = Date.now() - t0;
    const pct = (x, d = 2) => `${(x / N * 100).toFixed(d)}%`;
    const line = '─'.repeat(64);
    console.log('\n' + line);
    console.log('  NULL SELFTEST — synthetic UNIFORM digits (fair null)');
    console.log(line);
    console.log(`  scans                 : ${N}`);
    console.log(`  window                : ${winLen} digits`);
    console.log(`  MC confidence gate    : ${CONFIG.minEdgeConfidence} (α=${(1 - CONFIG.minEdgeConfidence).toFixed(2)})`);
    console.log(`  MC stability gate     : ${CONFIG.mcStabilityThreshold}`);
    console.log(`  value-edge (q_be − p̂) : requires ≥ ${CONFIG.mcMinEdge} + reserve ${CONFIG.mcHouseEdgeReserve}`);
    console.log(line);
    console.log(`  MC gate passed        : ${pct(passed)}   (confidence+stability+FDR+digit gates)`);
    console.log(`  gated by confidence   : ${pct(gatedByConf)}   (of ${N} scans)`);
    console.log(`  gated by stability    : ${pct(gatedByStab)}   (of ${N} scans)`);
    console.log(`  value-edge fires      : ${pct(traded)}   (per scan, edge ≥ ${CONFIG.mcMinEdge}+${CONFIG.mcHouseEdgeReserve})`);
    console.log(`  TRUE false-trade      : ${pct(joint)}   (MC gate AND edge both fire — the real rate)`);
    console.log(`  runtime               : ${ms}ms  (${(ms / N).toFixed(3)} ms/scan)`);
    console.log(line);
    console.log('  PASS if TRUE false-trade is small (<1%).');
    console.log('  NOTE: FDR budget (' + CONFIG.mcFdrBudget + ' acted-on signal/symbol/day) caps real trades');
    console.log('  even when the per-scan value-edge fires more often — that cap is the');
    console.log('  multiple-testing control; without it the 1.3% tail would compound.');
    console.log(line + '\n');
    process.exit(0);
  }

  // ── Backtest mode ────────────────────────────────────────────────
  if (process.env.BACKTEST === '1' || process.argv.includes('--backtest')) {
    const list = (process.env.BACKTEST_ASSET || CONFIG.assets.join(','))
      .split(',').map(s => s.trim()).filter(Boolean);
    console.log(`🧪 BACKTEST mode — symbols=[${list.join(', ')}]  ticks=${CONFIG.backtestTicks}\n`);
    const client = new DerivClient(CONFIG);
    const market = new MarketDataManager(client, CONFIG);

    client.on('authorized', async () => {
      try {
        await market.loadSymbols();
        const bt = new DifferBacktester(CONFIG, client, market);
        await bt.run(list);
        try { client.stop(); } catch (_) {}
        process.exit(0);
      } catch (e) {
        console.error('backtest failed:', e);
        process.exit(1);
      }
    });
    client.connect();
    return;
  }

  const bot = new TradingBot();
  await bot.start();
}

main().catch(e => {
  console.error('fatal:', e);
  process.exit(1);
});
