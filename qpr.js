// ============================================================================
// QUANTUM PHASE REVERSAL — GERMAN-SWISS STYLE DIGITDIFF BOT (Node.js)
// Multi-Asset + Phase-Shift Detection in 500-Tick Window + Z-Score + Volatility
// Structure similar to your other advanced bots (WebSocket + Telegram + State)
// ============================================================================

'use strict';

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ========== CONFIGURE THESE ==========
const TOKEN = '0P94g4WdSrSrzir';                // Deriv token
const TELEGRAM_TOKEN = '8218636914:AAGvaKFh8MT769-_9eOEiU4XKufL0aHRhZ4';   // Telegram bot token
const CHAT_ID = '752497117';                    // Your chat id
// =====================================

const STATE_FILE = path.join(__dirname, 'qpr-state.json');

class QuantumPhaseReversalBot {
    constructor() {
        // ====== CONFIG ======
        this.config = {
            assets: {
                // Tuned primarily for phase behavior & digit extraction
                'R_50': {
                    decimals: 4,
                    digitIndex: 3,
                    phaseWindow: 500,       // total window
                    phase1Len: 300,         // first phase length
                    phase2Len: 200,         // second phase length
                    minDominance2: 0.24,    // last 200: at least 24% same digit
                    minDominanceIncrease: 0.04, // dom2 - dom1 >= 4%
                    zWindows: [55, 144, 233],
                    minAvgZ: 1.2,           // minimum average Z-score
                    minConcentration: 0.020,// entropy-based concentration
                    weight: 1.0,            // relative priority
                },
                'R_25': {
                    decimals: 3,
                    digitIndex: 2,
                    phaseWindow: 500,
                    phase1Len: 300,
                    phase2Len: 200,
                    minDominance2: 0.24,
                    minDominanceIncrease: 0.04,
                    zWindows: [55, 144, 233],
                    minAvgZ: 1.2,
                    minConcentration: 0.018,
                    weight: 1.0,
                },

            },

            assets: {
                // -----------------------------------------------------
                // R_10 — Lowest volatility index, digits from 3rd decimal
                // ~Moderate thresholds: will generate rare but solid signals
                // -----------------------------------------------------
                'R_10': {
                    decimals: 3,
                    digitIndex: 2,
                    phaseWindow: 500,       // total window
                    phase1Len: 300,         // first phase length
                    phase2Len: 200,         // second phase length

                    minDominance2: 0.26,          // ≥ 26% of last 200 ticks are this digit (≈52/200)
                    minDominanceIncrease: 0.05,   // phase2 dominance ≥ phase1 + 5 percentage points

                    zWindows: [55, 144, 233, 377],
                    minAvgZ: 2.4,                 // strong but not ultra‑extreme saturation

                    minConcentration: 0.055,      // entropy-based concentration

                    weight: 1.2                   // slightly favor R_10 in scoring
                },

                'R_25': {
                    decimals: 3,
                    digitIndex: 2,
                    phaseWindow: 500,       // total window
                    phase1Len: 300,         // first phase length
                    phase2Len: 200,         // second phase length

                    minDominance2: 0.26,          // ≥ 26% of last 200 ticks are this digit (≈52/200)
                    minDominanceIncrease: 0.06,   // phase2 dominance ≥ phase1 + 5 percentage points

                    zWindows: [55, 144, 233, 377],
                    minAvgZ: 2.4,                 // strong but not ultra‑extreme saturation

                    minConcentration: 0.055,      // entropy-based concentration

                    weight: 1.1                   // slightly favor R_10 in scoring
                },

                // -----------------------------------------------------
                // R_50 — Good primary asset for QPR
                // Strictest settings here for highest reliability
                // -----------------------------------------------------
                'R_50': {
                    decimals: 4,
                    digitIndex: 3,
                    phaseWindow: 500,
                    phase1Len: 300,
                    phase2Len: 200,

                    minDominance2: 0.28,          // ≥ 28% (≈56/200) → very strong phase dominance
                    minDominanceIncrease: 0.06,   // at least +6 points vs phase1

                    zWindows: [55, 144, 233, 377],
                    minAvgZ: 2.8,                 // strong multi‑window saturation

                    minConcentration: 0.070,      // clearly skewed digit distribution

                    weight: 1.0
                },

                // -----------------------------------------------------
                // R_75 — More “chaotic” than R_50, so be stricter
                // -----------------------------------------------------
                'R_75': {
                    decimals: 4,
                    digitIndex: 3,
                    phaseWindow: 500,
                    phase1Len: 300,
                    phase2Len: 200,

                    minDominance2: 0.29,          // ≥ 29% (≈58/200)
                    minDominanceIncrease: 0.07,   // +7 points vs phase1

                    zWindows: [55, 144, 233, 377],
                    minAvgZ: 3.0,                 // very strong saturation

                    minConcentration: 0.075,

                    weight: 0.9                    // slightly down‑weighted vs R_50
                },

                // -----------------------------------------------------
                // R_100 — Highest synthetic volatility
                // Very strict to avoid noise → few trades, strong edge
                // -----------------------------------------------------
                'R_100': {
                    decimals: 2,
                    digitIndex: 1,
                    phaseWindow: 500,
                    phase1Len: 300,
                    phase2Len: 200,

                    minDominance2: 0.30,          // ≥ 30% (≈60/200)
                    minDominanceIncrease: 0.08,   // +8 points vs phase1

                    zWindows: [55, 144, 233, 377],
                    minAvgZ: 3.2,                 // extreme saturation across windows

                    minConcentration: 0.080,

                    weight: 0.8                    // a bit more conservative in scoring
                },

                // -----------------------------------------------------
                // RDBEAR & RDBULL — Directional synthetics (Bull/Bear)
                // Treat like high‑volatility indices with strong trends
                // Keep thresholds close to R_75/R_100, but slightly relaxed
                // -----------------------------------------------------
                'RDBULL': {
                    decimals: 4,                   // check actual format; most bull/bear use 4 decimals
                    digitIndex: 3,
                    phaseWindow: 500,
                    phase1Len: 300,
                    phase2Len: 200,

                    minDominance2: 0.29,
                    minDominanceIncrease: 0.07,

                    zWindows: [55, 144, 233, 377],
                    minAvgZ: 3.0,

                    minConcentration: 0.075,

                    weight: 0.8                    // slightly cautious, they can be noisier
                },

                'RDBEAR': {
                    decimals: 4,
                    digitIndex: 3,
                    phaseWindow: 500,
                    phase1Len: 300,
                    phase2Len: 200,

                    minDominance2: 0.29,
                    minDominanceIncrease: 0.07,

                    zWindows: [55, 144, 233, 377],
                    minAvgZ: 3.0,

                    minConcentration: 0.075,

                    weight: 0.8
                }
            },

            requiredHistoryLength: 1500,   // how many ticks to load per asset
            minHistoryForTrading: 800,     // minimum before analysis

            // Cooldown
            cooldownTicks: 30,             // ticks after ANY trade on an asset

            // Money management
            baseStake: 2.2,
            firstLossMultiplier: 11.3,
            subsequentMultiplier: 11.3,
            maxConsecutiveLosses: 4,
            takeProfit: 5000,
            stopLoss: -400,

            // Time filter (optional)
            avoidMinutesAroundHour: 3,
        };

        // ====== STATE ======
        this.assetList = Object.keys(this.config.assets);

        this.histories = {};
        this.historyLoaded = {};
        this.assetList.forEach(a => {
            this.histories[a] = [];
            this.historyLoaded[a] = false;
        });

        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.tradeInProgress = false;
        this.currentTradingAsset = null;

        // Trading stats
        this.stake = this.config.baseStake;
        this.consecutiveLosses = 0;
        this.x2 = 0;
        this.x3 = 0;
        this.x4 = 0;
        this.x5 = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.netProfit = 0;
        this.ticks = 0;

        // Per-asset metadata
        this.lastSignalDigit = {};
        this.ticksSinceLastTrade = {};
        this.assetList.forEach(a => {
            this.lastSignalDigit[a] = null;
            this.ticksSinceLastTrade[a] = 999;
        });

        // Telegram
        this.telegramBot = TELEGRAM_TOKEN
            ? new TelegramBot(TELEGRAM_TOKEN, { polling: false })
            : null;

        // Load state & connect
        this.loadState();
        this.connect();
        this.startHourlySummary();
        this.startAutoSave();
    }

    // ========================================================================
    // STATE PERSISTENCE
    // ========================================================================
    saveState() {
        try {
            const data = {
                savedAt: Date.now(),
                stake: this.stake,
                consecutiveLosses: this.consecutiveLosses,
                totalTrades: this.totalTrades,
                totalWins: this.totalWins,
                x2: this.x2, x3: this.x3, x4: this.x4, x5: this.x5,
                totalLosses: this.totalLosses,
                netProfit: this.netProfit,
            };
            fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error('State save error:', e.message);
        }
    }

    loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) return;
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const age = (Date.now() - data.savedAt) / 60000;
            if (age > 60) {
                console.log(`⚠️ Old state (${age.toFixed(1)} min), ignoring`);
                return;
            }
            this.stake = data.stake ?? this.stake;
            this.consecutiveLosses = data.consecutiveLosses ?? 0;
            this.totalTrades = data.totalTrades ?? 0;
            this.totalWins = data.totalWins ?? 0;
            this.x2 = data.x2 ?? 0;
            this.x3 = data.x3 ?? 0;
            this.x4 = data.x4 ?? 0;
            this.x5 = data.x5 ?? 0;
            this.totalLosses = data.totalLosses ?? 0;
            this.netProfit = data.netProfit ?? 0;
            console.log('✅ State restored:', {
                totalTrades: this.totalTrades,
                totalWins: this.totalWins,
                totalLosses: this.totalLosses,
                netProfit: this.netProfit.toFixed(2),
                stake: this.stake.toFixed(2),
            });
        } catch (e) {
            console.error('State load error:', e.message);
        }
    }

    startAutoSave() {
        setInterval(() => this.saveState(), 5000);
        console.log('💾 Auto-save every 5s enabled');
    }

    // ========================================================================
    // WEBSOCKET / CONNECTION
    // ========================================================================
    connect() {
        console.log('🔌 Connecting to Deriv API...');
        this.ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ WebSocket connected');
            this.connected = true;
            this.reconnectAttempts = 0;
            this.sendRequest({ authorize: TOKEN });
        });

        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                this.handleMessage(msg);
            } catch (e) {
                console.error('Parse error:', e.message);
            }
        });

        this.ws.on('close', () => {
            console.log('⚠️ WebSocket closed');
            this.connected = false;
            this.wsReady = false;
            // simple reconnect
            setTimeout(() => this.connect(), 5000);
        });

        this.ws.on('error', (e) => {
            console.error('WS error:', e.message);
        });
    }

    sendRequest(req) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(req));
        }
    }

    handleMessage(msg) {
        if (msg.error) {
            console.error('API Error:', msg.error.message);
            if (msg.msg_type === 'buy') this.tradeInProgress = false;
            return;
        }

        switch (msg.msg_type) {
            case 'authorize':
                this.handleAuthorize(msg);
                break;
            case 'history':
                this.handleTickHistory(msg);
                break;
            case 'tick':
                this.handleTickUpdate(msg.tick);
                break;
            case 'buy':
                this.handleBuy(msg);
                break;
            case 'proposal_open_contract':
                if (msg.proposal_open_contract?.is_sold) {
                    this.handleTradeResult(msg.proposal_open_contract);
                }
                break;
        }
    }

    handleAuthorize(msg) {
        console.log('✅ Authenticated as', msg.authorize.loginid);
        this.wsReady = true;
        this.initializeSubscriptions();
        this.sendTelegram(`
            🚀 <b>Quantum Phase Reversal Bot Started</b>
            Account: ${msg.authorize.loginid}
            Balance: $${parseFloat(msg.authorize.balance).toFixed(2)}
            Assets: ${this.assetList.join(', ')}
        `.trim());
    }

    initializeSubscriptions() {
        console.log('📊 Initializing subscriptions...');
        this.assetList.forEach(asset => {
            console.log(`   Requesting history for ${asset}...`);
            this.sendRequest({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks',
            });
            this.sendRequest({ ticks: asset, subscribe: 1 });
        });
    }

    // ========================================================================
    // TICKS & HISTORY
    // ========================================================================
    handleTickHistory(msg) {
        const asset = msg.echo_req.ticks_history;
        const prices = msg.history?.prices || [];
        this.histories[asset] = prices.map(p => this.getLastDigit(p, asset));
        this.historyLoaded[asset] = true;
        console.log(`📊 Loaded ${this.histories[asset].length} ticks for ${asset}`);
        console.log(`   Last 10: ${this.histories[asset].slice(-10).join(', ')}`);
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        if (!this.assetList.includes(asset)) return;

        const d = this.getLastDigit(tick.quote, asset);
        const h = this.histories[asset];

        this.ticks++;

        h.push(d);
        if (h.length > this.config.requiredHistoryLength) h.shift();

        this.ticksSinceLastTrade[asset]++;

        if (this.ticks % 20 === 0) {
            console.log(`📈 [${asset}] Tick #${h.length} | Digit: ${d}`);
            console.log(`   Last 10: ${h.slice(-10).join(', ')}`);
        }

        if (this.historyLoaded[asset] && !this.tradeInProgress) {
            this.scanForSignal(asset);
        }
    }

    getLastDigit(quote, asset) {
        const str = quote.toString();
        const [, dec = ''] = str.split('.');
        const cfg = this.config.assets[asset];
        if (!cfg) return 0;
        if (dec.length <= cfg.digitIndex) return 0;
        return +dec[cfg.digitIndex];
    }

    // ========================================================================
    // CORE: PHASE ANALYSIS + Z-SCORE + VOLATILITY
    // ========================================================================
    calculatePhaseAnalysis(asset) {
        const cfg = this.config.assets[asset];
        const h = this.histories[asset];
        const N = cfg.phaseWindow;
        const n1 = cfg.phase1Len;
        const n2 = cfg.phase2Len;

        if (h.length < N) return null;

        const lastN = h.slice(-N);
        const phase1 = lastN.slice(0, n1);
        const phase2 = lastN.slice(N - n2);

        const freq1 = Array(10).fill(0);
        const freq2 = Array(10).fill(0);

        phase1.forEach(d => freq1[d]++);
        phase2.forEach(d => freq2[d]++);

        const max1 = Math.max(...freq1);
        const dom1 = freq1.indexOf(max1);
        const dominance1 = max1 / n1;

        const max2 = Math.max(...freq2);
        const dom2 = freq2.indexOf(max2);
        const dominance2 = max2 / n2;

        const dominanceIncrease = dominance2 - dominance1;

        return {
            dom1,
            dom2,
            dominance1,
            dominance2,
            dominanceIncrease,
        };
    }

    calculateZScoreConfluence(asset, digit) {
        const cfg = this.config.assets[asset];
        const h = this.histories[asset];
        const windows = cfg.zWindows;

        let totalZ = 0;
        let count = 0;
        const details = [];

        for (const w of windows) {
            if (h.length < w) continue;
            const slice = h.slice(-w);
            const freq = Array(10).fill(0);
            slice.forEach(d => freq[d]++);
            const exp = w / 10;
            const sd = Math.sqrt(w * 0.1 * 0.9);
            const z = (freq[digit] - exp) / sd;
            totalZ += z;
            count++;
            details.push({ window: w, z, count: freq[digit], expected: exp });
        }

        if (count === 0) return null;
        const avgZ = totalZ / count;
        return { avgZ, details };
    }

    calculateConcentration(asset) {
        const h = this.histories[asset];
        if (h.length < 200) return null;
        const slice = h.slice(-200);
        const freq = Array(10).fill(0);
        slice.forEach(d => freq[d]++);

        let entropy = 0;
        for (let f of freq) {
            if (f > 0) {
                const p = f / slice.length;
                entropy -= p * Math.log2(p);
            }
        }
        const maxEntropy = Math.log2(10);
        const conc = 1 - (entropy / maxEntropy); // 0..1, but typically small (~0–0.1)

        return { conc, entropy, freq };
    }

    // ========================================================================
    // TRADE FILTERS
    // ========================================================================
    canTrade(asset) {
        const h = this.histories[asset];
        const len = h.length;
        const logPrefix = `[${asset}] canTrade`;

        let reason = null;

        if (this.tradeInProgress) reason = 'tradeInProgress';
        else if (!this.wsReady) reason = 'wsNotReady';
        else if (!this.historyLoaded[asset]) reason = 'historyNotLoaded';
        else if (len < this.config.minHistoryForTrading)
            reason = `notEnoughHistory(${len}/${this.config.minHistoryForTrading})`;
        else if (this.consecutiveLosses >= this.config.maxConsecutiveLosses)
            reason = `maxConsecLosses(${this.consecutiveLosses})`;
        else if (this.netProfit <= this.config.stopLoss)
            reason = `stopLossReached(${this.netProfit.toFixed(2)}`;
        else {
            const ticksSinceLast = this.ticksSinceLastTrade[asset];
            const requiredCooldown = this.config.cooldownTicks;
            if (ticksSinceLast < requiredCooldown) {
                reason = `cooldown(${ticksSinceLast}/${requiredCooldown})`;
            } else {
                const now = new Date();
                const m = now.getMinutes();
                if (m < this.config.avoidMinutesAroundHour ||
                    m > (60 - this.config.avoidMinutesAroundHour)) {
                    reason = `timeFilter(minute=${m})`;
                }
            }
        }

        const ok = (reason === null);
        if (!ok && this.ticks % 20 === 0) {
            console.log(`${logPrefix}=false → ${reason}`);
        } else if (ok && this.ticks % 20 === 0) {
            console.log(`${logPrefix}=true | len=${len}, consecLosses=${this.consecutiveLosses}, net=${this.netProfit.toFixed(2)}`);
        }
        return ok;
    }

    // ========================================================================
    // MAIN SIGNAL SCAN
    // ========================================================================
    scanForSignal(asset) {
        const h = this.histories[asset];
        const len = h.length;
        const cfg = this.config.assets[asset];
        if (!this.canTrade(asset)) return;

        // --- PHASE ANALYSIS ---
        const phase = this.calculatePhaseAnalysis(asset);
        if (!phase) return;

        const { dom1, dom2, dominance1, dominance2, dominanceIncrease } = phase;

        // Log occasionally
        if (this.ticks % 20 === 0) {
            console.log(
                `[${asset}] PHASE dom1=${dom1} (${(dominance1 * 100).toFixed(1)}%) ` +
                `dom2=${dom2} (${(dominance2 * 100).toFixed(1)}%) ` +
                `inc=${(dominanceIncrease * 100).toFixed(1)}%`
            );
        }

        // Basic phase shift conditions
        const condPhaseShift = (dom2 !== dom1);
        const condDom2Strong = (dominance2 >= cfg.minDominance2);
        const condIncrease = (dominanceIncrease >= cfg.minDominanceIncrease);

        if (!(condPhaseShift && condDom2Strong && condIncrease)) {
            // Too strict to log every tick; log occasionally
            if (this.ticks % 20 === 0) {
                console.log(
                    `[${asset}] PHASE REJECT ` +
                    `shift=${condPhaseShift} dom2Strong=${condDom2Strong} incOK=${condIncrease}`
                );
            }
            return;
        }

        // --- Z-SCORE CONFLUENCE ---
        const zConf = this.calculateZScoreConfluence(asset, dom2);
        if (!zConf) return;
        const { avgZ } = zConf;

        if (this.ticks % 20 === 0) {
            console.log(
                `[${asset}] ZCONF digit=${dom2} avgZ=${avgZ.toFixed(2)} ` +
                `(min=${cfg.minAvgZ})`
            );
        }

        if (avgZ < cfg.minAvgZ) {
            if (this.ticks % 20 === 0) console.log(`[${asset}] ZCONF REJECT avgZ too low`);
            return;
        }

        // --- CONCENTRATION / VOLATILITY ---
        const vol = this.calculateConcentration(asset);
        if (!vol) return;
        const { conc } = vol;

        if (this.ticks % 20 === 0) {
            console.log(
                `[${asset}] VOL conc=${conc.toFixed(4)} ` +
                `(min=${cfg.minConcentration})`
            );
        }

        if (conc < cfg.minConcentration) {
            if (this.ticks % 20 === 0) console.log(`[${asset}] VOL REJECT conc too low`);
            return;
        }

        // --- RECENT APPEARANCE ---
        const inRecent = h.slice(-9).includes(dom2);
        if (this.ticks % 20 === 0) {
            console.log(
                `[${asset}] RECENT digit=${dom2} inRecent=${inRecent}`
            );
        }
        if (!inRecent) return;

        // --- SAME DIGIT COOLDOWN ---
        if (this.lastSignalDigit[asset] === dom2 && this.ticks % 20 === 0) {
            console.log(
                `[${asset}] REJECT same digit as last signal: ${dom2}`
            );
            return;
        }

        // All conditions met → place trade
        this.lastSignalDigit[asset] = dom2;
        this.placeTrade(asset, dom2, {
            phase,
            avgZ,
            conc,
        });
    }

    // ========================================================================
    // TRADE EXECUTION & RESULT
    // ========================================================================
    placeTrade(asset, digit, analysis) {
        if (this.tradeInProgress) return;

        this.tradeInProgress = true;
        this.currentTradingAsset = asset;
        this.ticksSinceLastTrade[asset] = 0;

        const stake = this.stake;

        console.log(`\n🎯 QUANTUM PHASE REVERSAL SIGNAL — ${asset}`);
        console.log(`   Digit: ${digit}`);
        console.log(`   Stake: $${stake.toFixed(2)}`);
        console.log(`   Phase: dom1=${analysis.phase.dom1} (${(analysis.phase.dominance1 * 100).toFixed(1)}%), ` +
            `dom2=${analysis.phase.dom2} (${(analysis.phase.dominance2 * 100).toFixed(1)}%), ` +
            `inc=${(analysis.phase.dominanceIncrease * 100).toFixed(1)}%`);
        console.log(`   avgZ=${analysis.avgZ.toFixed(2)} conc=${analysis.conc.toFixed(4)}`);
        console.log(`   Last 10: ${this.histories[asset].slice(-10).join(', ')}`);

        this.sendRequest({
            buy: 1,
            price: stake,
            parameters: {
                amount: stake,
                basis: "stake",
                contract_type: "DIGITDIFF",
                currency: "USD",
                duration: 1,
                duration_unit: "t",
                symbol: asset,
                barrier: digit.toString(),
            }
        });

        this.sendTelegram(`
            🎯 <b>QUANTUM PHASE REVERSAL TRADE</b>

            📊 Asset: ${asset}
            🔢 Digit (differ): ${digit}
            🔢 Last 10 Digits: ${this.histories[asset].slice(-10).join(',')}
            💰 Stake: $${stake.toFixed(2)}

            <code>Phase:
            dom1=${analysis.phase.dom1} (${(analysis.phase.dominance1 * 100).toFixed(1)}%)
            dom2=${analysis.phase.dom2} (${(analysis.phase.dominance2 * 100).toFixed(1)}%)
            inc=${(analysis.phase.dominanceIncrease * 100).toFixed(1)}%
            Zavg=${analysis.avgZ.toFixed(2)}  Conc=${analysis.conc.toFixed(4)}
            </code>
        `.trim());
    }

    handleBuy(msg) {
        if (msg.error) {
            console.error('❌ Buy error:', msg.error.message);
            this.tradeInProgress = false;
            return;
        }
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: msg.buy.contract_id,
            subscribe: 1
        });
    }

    handleTradeResult(contract) {
        const asset = contract.underlying;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const exitDigit = this.getLastDigit(contract.exit_tick_display_value, asset);

        this.totalTrades++;
        if (won) this.totalWins++;
        else this.totalLosses++;
        this.netProfit += profit;

        console.log(`\n${won ? '✅ WIN' : '❌ LOSS'} — ${asset}`);
        console.log(`   Exit digit: ${exitDigit}`);
        console.log(`   Profit: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);
        console.log(`   Total: ${this.totalTrades}, W/L=${this.totalWins}/${this.totalLosses}, Net=$${this.netProfit.toFixed(2)}`);

        // Money management
        if (won) {
            this.consecutiveLosses = 0;
            this.stake = this.config.baseStake;
        } else {
            this.consecutiveLosses++;

            if (this.consecutiveLosses === 2) this.x2++;
            if (this.consecutiveLosses === 3) this.x3++;
            if (this.consecutiveLosses === 4) this.x4++;
            if (this.consecutiveLosses === 5) this.x5++;
            // if (this.consecutiveLosses === 1) {
            //     this.stake = this.config.baseStake * this.config.firstLossMultiplier;
            // } else {
            //     this.stake = this.stake * this.config.subsequentMultiplier;
            // }
            // this.stake = Math.round(this.stake * 100) / 100;

            if (this.consecutiveLosses === 2) {
                this.stake = this.config.baseStake;
            } else {
                this.stake = Math.ceil(this.stake * this.config.firstLossMultiplier * 100) / 100;
            }
        }

        this.sendTelegram(`
            ${won ? '✅ WIN' : '❌ LOSS'} — <b>QUANTUM PHASE REVERSAL</b>

            📊 Asset: ${asset}
            🔢 Exit digit: ${exitDigit}
            💸 P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}

            📈 Trades: ${this.totalTrades}
            ✅/❌: ${this.totalWins}/${this.totalLosses}
            🔢 x2-x5: ${this.x2}/${this.x3}/${this.x4}/${this.x5}
            💵 Net: $${this.netProfit.toFixed(2)}
            🔢 Next Stake: $${this.stake.toFixed(2)}
        `.trim());

        // Stop conditions
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses ||
            this.netProfit <= this.config.stopLoss) {
            console.log('🛑 Max losses/stop loss reached, disconnecting');
            this.sendTelegram(`🛑 <b>Stopping QUANTUM PHASE REVERSAL bot</b> — P&L: $${this.netProfit.toFixed(2)}`);
            this.disconnect();
            return;
        }

        if (this.netProfit >= this.config.takeProfit) {
            console.log('🎉 Take profit reached, disconnecting');
            this.sendTelegram(`🎉 <b>Take profit reached</b> — P&L: $${this.netProfit.toFixed(2)}`);
            this.disconnect();
            return;
        }

        this.tradeInProgress = false;
        this.currentTradingAsset = null;
    }

    // ========================================================================
    // HOURLY SUMMARY
    // ========================================================================
    startHourlySummary() {
        setInterval(() => {
            if (this.totalTrades === 0) return;
            const winRate = this.totalTrades > 0
                ? (this.totalWins / this.totalTrades * 100).toFixed(1)
                : '0.0';

            this.sendTelegram(`
            ⏰ <b>QUANTUM PHASE REVERSAL Hourly Summary</b>

            Trades: ${this.totalTrades}
            W/L: ${this.totalWins}/${this.totalLosses}
            Win rate: ${winRate}%
            x2-x5: ${this.x2}/${this.x3}/${this.x4}/${this.x5}
            Current Stake: $${this.stake.toFixed(2)}
            Net P&L: $${this.netProfit.toFixed(2)}
            `.trim());
        }, 60 * 60 * 1000);
    }

    // ========================================================================
    // TELEGRAM WRAPPER & CLEANUP
    // ========================================================================
    sendTelegram(text) {
        if (!this.telegramBot) return;
        this.telegramBot.sendMessage(CHAT_ID, text, { parse_mode: 'HTML' })
            .catch(err => console.error('Telegram error:', err.message));
    }

    disconnect() {
        console.log('🛑 Disconnecting bot...');
        this.saveState();
        if (this.ws) {
            try { this.ws.close(); } catch (e) { }
        }
    }
}

// START
console.log('═══════════════════════════════════════════════════');
console.log('  QUANTUM PHASE REVERSAL BOT — GERMAN-SWISS STYLE');
console.log('═══════════════════════════════════════════════════');
console.log(`  Started: ${new Date().toLocaleString()}`);
console.log('═══════════════════════════════════════════════════\n');

new QuantumPhaseReversalBot();
