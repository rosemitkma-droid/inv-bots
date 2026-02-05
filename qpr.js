// ============================================================================
// QUANTUM PHASE REVERSAL — GERMAN-SWISS STYLE DIGITDIFF BOT (Node.js)
// Multi-Asset + Phase-Shift Detection in 500-Tick Window + Z-Score + Volatility
// Structure similar to your other advanced bots (WebSocket + Telegram + State)
// ============================================================================

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const TOKEN = "0P94g4WdSrSrzir";
const TELEGRAM_TOKEN = "8218636914:AAGvaKFh8MT769-_9eOEiU4XKufL0aHRhZ4";
const CHAT_ID = "752497117";

const STATE_FILE = path.join(__dirname, 'qpr-00003-state.json');

class QuantumPhaseReversalBot {
    constructor() {
        // ====== CONFIGURATION ======
        this.config = {
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

                    minDominance2: 0.15,          // ≥ 26% of last 200 ticks are this digit (≈52/200)
                    minDominanceIncrease: 0.035,   // phase2 dominance ≥ phase1 + 5 percentage points

                    zWindows: [55, 144, 233, 377],
                    minAvgZ: 1.4,                 // strong but not ultra‑extreme saturation

                    minConcentration: 0.022,      // entropy-based concentration

                    weight: 1.2                   // slightly favor R_10 in scoring
                },

                'R_25': {
                    decimals: 3,
                    digitIndex: 2,
                    phaseWindow: 500,       // total window
                    phase1Len: 300,         // first phase length
                    phase2Len: 200,         // second phase length

                    minDominance2: 0.15,          // ≥ 26% of last 200 ticks are this digit (≈52/200)
                    minDominanceIncrease: 0.036,   // phase2 dominance ≥ phase1 + 5 percentage points

                    zWindows: [55, 144, 233, 377],
                    minAvgZ: 1.4,                 // strong but not ultra‑extreme saturation

                    minConcentration: 0.022,      // entropy-based concentration

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

                    minDominance2: 0.15,          // ≥ 28% (≈56/200) → very strong phase dominance
                    minDominanceIncrease: 0.036,   // at least +6 points vs phase1

                    zWindows: [55, 144, 233, 377],
                    minAvgZ: 1.8,                 // strong multi‑window saturation

                    minConcentration: 0.023,      // clearly skewed digit distribution

                    weight: 1.1
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

                    minDominance2: 0.15,          // ≥ 29% (≈58/200)
                    minDominanceIncrease: 0.037,   // +7 points vs phase1

                    zWindows: [55, 144, 233, 377],
                    minAvgZ: 2.0,                 // very strong saturation

                    minConcentration: 0.023,

                    weight: 1.0                    // slightly down‑weighted vs R_50
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

                    minDominance2: 0.16,          // ≥ 30% (≈60/200)
                    minDominanceIncrease: 0.038,   // +8 points vs phase1

                    zWindows: [55, 144, 233, 377],
                    minAvgZ: 2.2,                 // extreme saturation across windows

                    minConcentration: 0.023,

                    weight: 0.9                    // a bit more conservative in scoring
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

                    minDominance2: 0.15,
                    minDominanceIncrease: 0.037,

                    zWindows: [55, 144, 233, 377],
                    minAvgZ: 2.0,

                    minConcentration: 0.023,

                    weight: 0.9                    // slightly cautious, they can be noisier
                },

                'RDBEAR': {
                    decimals: 4,
                    digitIndex: 3,
                    phaseWindow: 500,
                    phase1Len: 300,
                    phase2Len: 200,

                    minDominance2: 0.15,
                    minDominanceIncrease: 0.037,

                    zWindows: [55, 144, 233, 377],
                    minAvgZ: 2.0,

                    minConcentration: 0.023,

                    weight: 0.9
                },
            },

            requiredHistoryLength: 1500,   // how many ticks to load per asset
            minHistoryForTrading: 800,     // minimum before analysis

            // Cooldown
            cooldownTicks: 30,             // ticks after ANY trade on an asset

            // Money management
            baseStake: 2.2,
            firstLossMultiplier: 11.3,
            subsequentMultiplier: 11.3,
            maxConsecutiveLosses: 6,
            takeProfit: 5000,
            stopLoss: -400,

            // Time filter (optional)
            avoidMinutesAroundHour: 3,
        };

        // ====== TRADING STATE ======
        this.histories = {};
        this.assetList = Object.keys(this.config.assets);
        this.assetList.forEach(a => this.histories[a] = []);



        // Trading state
        this.stake = this.config.baseStake;
        this.consecutiveLosses = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.x2 = 0; this.x3 = 0; this.x4 = 0; this.x5 = 0;
        this.netProfit = 0;
        this.ticks = 0;

        // Per-asset state
        this.lastTradeDigit = {};
        this.lastTradeTime = {};
        this.ticksSinceLastTrade = {};
        this.tradesThisHour = {};
        this.assetConsecutiveLosses = {};
        this.suspendedAssets = {};
        // Per-asset metadata
        this.lastSignalDigit = {};
        this.assetList.forEach(a => {
            this.lastTradeDigit[a] = null;
            this.lastTradeTime[a] = 0;
            this.lastSignalDigit[a] = null;
            this.ticksSinceLastTrade[a] = 999;
            this.tradesThisHour[a] = 0;
            this.assetConsecutiveLosses[a] = 0;
            this.suspendedAssets[a] = false;
        });

        this.tradeInProgress = false;
        this.currentTradingAsset = null;
        this.endOfDay = false;
        this.isWinTrade = false;

        // Performance tracking
        this.recentTrades = [];
        this.assetPerformance = {};
        this.assetList.forEach(a => {
            this.assetPerformance[a] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
        });

        // Hourly stats
        this.hourly = { trades: 0, wins: 0, losses: 0, pnl: 0 };

        // WebSocket
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.historyLoaded = {};
        this.assetList.forEach(a => this.historyLoaded[a] = false);

        // Reconnection
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 50;
        this.reconnectDelay = 5000;
        this.isReconnecting = false;

        // Telegram
        this.telegramBot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

        // Initialize
        this.loadState();
        this.connect();
        this.startHourlySummary();
        this.startHourlyReset();
        this.startAutoSave();
        this.checkTimeForDisconnectReconnect();
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
        else if (this.suspendedAssets[asset]) reason = 'assetSuspended';
        else if (this.consecutiveLosses >= this.config.maxConsecutiveLosses)
            reason = `maxConsecLosses(${this.consecutiveLosses})`;
        else if (this.netProfit <= this.config.stopLoss)
            reason = `stopLossReached(${this.netProfit.toFixed(2)})`;
        else {
            const ticksSinceLast = this.ticksSinceLastTrade[asset];
            let requiredCooldown = this.config.cooldownTicks;

            if (this.consecutiveLosses > 0) {
                requiredCooldown = this.config.cooldownAfterLoss;
            }
            if (this.assetConsecutiveLosses[asset] >= 2) {
                requiredCooldown = this.config.suspensionAfterDoubleLoss;
            }

            if (ticksSinceLast < requiredCooldown) {
                reason = `cooldown(${ticksSinceLast}/${requiredCooldown})`;
            } else if (this.tradesThisHour[asset] >= this.config.maxTradesPerHour) {
                reason = `maxTradesPerHour(${this.tradesThisHour[asset]})`;
            }
            // else {
            //     const now = new Date();
            //     const minute = now.getMinutes();
            //     if (minute < this.config.avoidMinutesAroundHour ||
            //         minute > (60 - this.config.avoidMinutesAroundHour)) {
            //         reason = `timeFilter(min=${minute})`;
            //     }
            // }
        }

        const ok = (reason === null);

        if (!ok && len > 0 && len % 500 === 0) {
            console.log(`${logPrefix}=false → ${reason}`);
        } else if (ok && len > 0 && len % 500 === 0) {
            // console.log(
            //     `${logPrefix}=true | len=${len}, consecLosses=${this.consecutiveLosses}, net=${this.netProfit.toFixed(2)}`
            // );
        }

        return ok;
    }

    suspendAsset(asset) {
        this.suspendedAssets[asset] = true;
        console.log(`🚫 ${asset} suspended for ${this.config.suspensionDuration / 1000}s`);

        setTimeout(() => {
            this.suspendedAssets[asset] = false;
            this.assetConsecutiveLosses[asset] = 0;
            console.log(`✅ ${asset} reactivated`);
        }, this.config.suspensionDuration);
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
                    `shift=${condPhaseShift} dom2Strong=${condDom2Strong}(${dominance2}|${cfg.minDominance2}) incOK=${condIncrease}(${dominanceIncrease.toFixed(3)}|${cfg.minDominanceIncrease})`
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
    // TRADE EXECUTION
    // ========================================================================
    placeTrade(asset, digit, analysis) {
        if (this.tradeInProgress) return;

        // Calculate stake with cap
        let tradeStake = this.stake;
        if (tradeStake > this.config.maxStake) {
            tradeStake = this.config.maxStake;
            console.log(`⚠️ Stake capped at $${this.config.maxStake}`);
        }

        this.tradeInProgress = true;
        this.currentTradingAsset = asset;
        this.lastTradeDigit[asset] = digit;
        this.lastTradeTime[asset] = Date.now();
        this.ticksSinceLastTrade[asset] = 0;
        this.tradesThisHour[asset]++;

        console.log(`\n🎯 QUANTUM PHASE REVERSAL SIGNAL — ${asset}`);
        console.log(`   Digit: ${digit}`);
        console.log(`   Stake: $${tradeStake.toFixed(2)}`);
        console.log(`   Phase: dom1=${analysis.phase.dom1} (${(analysis.phase.dominance1 * 100).toFixed(1)}%), ` +
            `dom2=${analysis.phase.dom2} (${(analysis.phase.dominance2 * 100).toFixed(1)}%), ` +
            `inc=${(analysis.phase.dominanceIncrease * 100).toFixed(1)}%`);
        console.log(`   avgZ=${analysis.avgZ.toFixed(2)} conc=${analysis.conc.toFixed(4)}`);
        console.log(`   Last 10: ${this.histories[asset].slice(-10).join(', ')}`);

        this.sendRequest({
            buy: 1,
            price: tradeStake,
            parameters: {
                amount: tradeStake,
                basis: "stake",
                contract_type: "DIGITDIFF",
                currency: "USD",
                duration: 1,
                duration_unit: "t",
                symbol: asset,
                barrier: digit.toString()
            }
        });

        this.sendTelegram(`
            🎯 <b>QUANTUM PHASE REVERSAL TRADE</b>

            📊 Asset: ${asset}
            🔢 Digit (differ): ${digit}
            🔢 Last 10 Digits: ${this.histories[asset].slice(-10).join(',')}
            💰 Stake: $${tradeStake.toFixed(2)}
            📊 Losses: ${this.consecutiveLosses}

            <code>Phase:
            dom1=${analysis.phase.dom1} (${(analysis.phase.dominance1 * 100).toFixed(1)}%)
            dom2=${analysis.phase.dom2} (${(analysis.phase.dominance2 * 100).toFixed(1)}%)
            inc=${(analysis.phase.dominanceIncrease * 100).toFixed(1)}%
            Zavg=${analysis.avgZ.toFixed(2)}  Conc=${analysis.conc.toFixed(4)}
            </code>
        `.trim());
    }

    // ========================================================================
    // TRADE RESULT HANDLING
    // ========================================================================
    handleTradeResult(contract) {
        const won = contract.status === "won";
        const profit = parseFloat(contract.profit);
        const asset = contract.underlying;
        const exitDigit = this.getLastDigit(contract.exit_tick_display_value, asset);

        this.totalTrades++;
        this.hourly.trades++;
        this.hourly.pnl += profit;
        this.netProfit += profit;

        // Asset performance tracking
        this.assetPerformance[asset].trades++;
        this.assetPerformance[asset].pnl += profit;

        // Track for adaptive thresholds
        this.recentTrades.push({ won, profit, asset, time: Date.now() });
        if (this.recentTrades.length > this.config.recentTradesForAdaptation) {
            this.recentTrades.shift();
        }

        console.log(`\n${won ? '✅ WIN' : '❌ LOSS'} — ${asset}`);
        console.log(`   Exit Digit: ${exitDigit}`);
        console.log(`   Profit: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);
        console.log(`   Net P&L: $${this.netProfit.toFixed(2)}`);

        if (won) {
            this.totalWins++;
            this.hourly.wins++;
            this.assetPerformance[asset].wins++;
            this.consecutiveLosses = 0;
            this.assetConsecutiveLosses[asset] = 0;
            this.stake = this.config.baseStake;
            this.isWinTrade = true;
        } else {
            this.isWinTrade = false;
            this.hourly.losses++;
            this.assetPerformance[asset].losses++;
            this.consecutiveLosses++;
            this.assetConsecutiveLosses[asset]++;

            if (this.consecutiveLosses === 2) this.x2++;
            if (this.consecutiveLosses === 3) this.x3++;
            if (this.consecutiveLosses === 4) this.x4++;
            if (this.consecutiveLosses === 5) this.x5++;

            // Money management (modified for safety)
            // if (this.consecutiveLosses === 1) {
            //     this.stake = this.config.baseStake * this.config.firstLossMultiplier;
            // } else {
            //     this.stake = this.config.baseStake *
            //         Math.pow(this.config.subsequentMultiplier, this.consecutiveLosses - 1);
            // }
            // this.stake = Math.min(Math.round(this.stake * 100) / 100, this.config.maxStake);

            if (this.consecutiveLosses === 2) {
                this.stake = this.config.baseStake;
            } else {
                this.stake = Math.ceil(this.stake * this.config.firstLossMultiplier * 100) / 100;
            }

            // Asset suspension check
            if (this.assetConsecutiveLosses[asset] >= this.config.suspendAssetAfterLosses) {
                this.suspendAsset(asset);
            }
        }

        // Trade alert
        this.sendTelegram(`
            ${won ? '✅' : '❌'} <b>${won ? 'WIN' : 'LOSS'} — ATHENA v9</b>

            📊 Asset: ${asset}
            🔢 Exit: ${exitDigit}
            last10Digits: ${this.histories[asset].slice(-10).join(',')}
            💸 P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}
            📈 Total: ${this.totalTrades} | W/L: ${this.totalWins}/${this.totalTrades - this.totalWins}
            🔢 x2-x5: ${this.x2}/${this.x3}/${this.x4}/${this.x5}
            📈 Win Rate: ${this.totalWins / this.totalTrades * 100}%
            💰 Next: $${this.stake.toFixed(2)}
            💵 Net: $${this.netProfit.toFixed(2)}
            ${this.assetConsecutiveLosses[asset] >= 2 ? `\n🚫 ${asset} SUSPENDED` : ''}
        `.trim());

        // Stop conditions
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses || this.netProfit <= this.config.stopLoss) {
            console.log('🛑 Max consecutive losses reached');
            this.sendTelegram(`🛑 <b>MAX LOSSES!</b>\nFinal P&L: $${this.netProfit.toFixed(2)}`);
            this.disconnect();
            return;
        }

        // Take profit
        if (this.netProfit >= this.config.takeProfit) {
            console.log('🎉 Take profit reached!');
            this.sendTelegram(`🎉 <b>TAKE PROFIT!</b>\nFinal P&L: $${this.netProfit.toFixed(2)}`);
            this.disconnect();
            return;
        }

        this.tradeInProgress = false;
        this.currentTradingAsset = null;
    }

    // ========================================================================
    // TICK HANDLING
    // ========================================================================
    handleTickUpdate(tick) {
        const asset = tick.symbol;
        if (!this.assetList.includes(asset)) return;

        const lastDigit = this.getLastDigit(tick.quote, asset);

        this.ticks = this.ticks + 1;

        this.histories[asset].push(lastDigit);
        if (this.histories[asset].length > this.config.requiredHistoryLength) {
            this.histories[asset].shift();
        }

        // Increment cooldown counter
        this.ticksSinceLastTrade[asset]++;

        // Log periodically
        if (this.tradeInProgress) {
            console.log(` 📈 [${asset}] Last 10: ${this.histories[asset].slice(-10).join(', ')}`);
        }

        // Scan for signals
        if (this.historyLoaded[asset] && !this.tradeInProgress && !this.suspendedAssets[asset]) {
            this.scanForSignal(asset);
        }
    }

    // ========================================================================
    // WEBSOCKET & UTILITIES
    // ========================================================================
    connect() {
        console.log('🔌 Connecting to Deriv API...');
        this.ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ Connected');
            this.connected = true;
            this.reconnectAttempts = 0;
            this.sendRequest({ authorize: TOKEN });
        });

        this.ws.on('message', (data) => {
            try {
                this.handleMessage(JSON.parse(data));
            } catch (e) {
                console.error('Parse error:', e.message);
            }
        });

        this.ws.on('close', () => {
            this.connected = false;
            this.wsReady = false;
            if (!this.isReconnecting && this.reconnectAttempts < this.maxReconnectAttempts && !this.endOfDay) {
                this.reconnect();
            }
        });

        this.ws.on('error', (e) => console.error('WS Error:', e.message));
    }

    reconnect() {
        this.isReconnecting = true;
        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s...`);
        setTimeout(() => {
            this.isReconnecting = false;
            this.connect();
        }, delay);
    }

    handleMessage(msg) {
        if (msg.error) {
            console.error('API Error:', msg.error.message);
            if (msg.msg_type === 'buy') {
                this.tradeInProgress = false;
            }
            return;
        }

        switch (msg.msg_type) {
            case 'authorize':
                console.log('✅ Authenticated');
                this.wsReady = true;
                this.initializeSubscriptions();
                this.sendTelegram(`
                    🚀 <b>QUANTUM PHASE REVERSAL BOT STARTED</b>

                    📊 Assets: ${this.assetList.join(', ')}
                    💰 Base Stake: $${this.config.baseStake}
                    🎯 Min Score: ${this.config.minTotalScore}
                    ⚠️ Max Stake: $${this.config.maxStake}
                `.trim());
                break;
            case 'history':
                this.handleTickHistory(msg);
                break;
            case 'tick':
                this.handleTickUpdate(msg.tick);
                break;
            case 'buy':
                if (!msg.error) {
                    this.sendRequest({
                        proposal_open_contract: 1,
                        contract_id: msg.buy.contract_id,
                        subscribe: 1
                    });
                } else {
                    this.tradeInProgress = false;
                }
                break;
            case 'proposal_open_contract':
                if (msg.proposal_open_contract?.is_sold) {
                    this.handleTradeResult(msg.proposal_open_contract);
                }
                break;
        }
    }

    initializeSubscriptions() {
        console.log('📊 Initializing subscriptions...');
        this.assetList.forEach(asset => {
            console.log(`   Subscribing to ${asset}...`);
            this.sendRequest({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });
            this.sendRequest({ ticks: asset, subscribe: 1 });
        });
    }

    handleTickHistory(msg) {
        const asset = msg.echo_req.ticks_history;
        const prices = msg.history?.prices || [];
        this.histories[asset] = prices.map(p => this.getLastDigit(p, asset));
        this.historyLoaded[asset] = true;
        console.log(`📊 Loaded ${this.histories[asset].length} ticks for ${asset}`);
    }

    // getLastDigit(quote, asset) {
    //     const str = quote.toString();
    //     const [, dec = ''] = str.split('.');
    //     const assetConfig = this.config.assets[asset];
    //     if (!assetConfig) return 0;
    //     return dec.length > assetConfig.digitIndex ? +dec[assetConfig.digitIndex] : 0;
    // }

    getLastDigit(quote, asset) {
        const str = quote.toString();
        const [, dec = ''] = str.split('.');
        const cfg = this.config.assets[asset];
        if (!cfg) return 0;
        if (dec.length <= cfg.digitIndex) return 0;
        return +dec[cfg.digitIndex];
    }

    sendRequest(req) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(req));
        }
    }

    sendTelegram(text) {
        this.telegramBot.sendMessage(CHAT_ID, text, { parse_mode: "HTML" }).catch(() => { });
    }

    disconnect() {
        console.log('🛑 Disconnecting...');
        this.saveState();
        this.endOfDay = true;
        if (this.ws) this.ws.close();
    }

    // State persistence
    saveState() {
        try {
            fs.writeFileSync(STATE_FILE, JSON.stringify({
                savedAt: Date.now(),
                stake: this.stake,
                consecutiveLosses: this.consecutiveLosses,
                totalTrades: this.totalTrades,
                totalWins: this.totalWins,
                x2: this.x2, x3: this.x3, x4: this.x4, x5: this.x5,
                netProfit: this.netProfit,
                recentTrades: this.recentTrades,
                assetPerformance: this.assetPerformance
            }, null, 2));
        } catch (e) { }
    }

    loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) return;
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (Date.now() - data.savedAt > 30 * 60 * 1000) return;
            Object.assign(this, data);
            console.log('✅ State restored');
        } catch (e) { }
    }

    startAutoSave() {
        setInterval(() => this.saveState(), 5000);
    }

    startHourlyReset() {
        setInterval(() => {
            this.assetList.forEach(a => {
                this.tradesThisHour[a] = 0;
            });
            console.log('🔄 Hourly trade counters reset');
        }, 3600000);
    }

    startHourlySummary() {
        setInterval(() => {
            if (this.hourly.trades === 0) return;
            const winRate = ((this.hourly.wins / this.hourly.trades) * 100).toFixed(1);

            let assetBreakdown = '';
            this.assetList.forEach(a => {
                const perf = this.assetPerformance[a];
                if (perf.trades > 0) {
                    const aWR = ((perf.wins / perf.trades) * 100).toFixed(0);
                    assetBreakdown += `\n├ ${a}: ${perf.trades}T ${aWR}% $${perf.pnl.toFixed(2)}`;
                }
            });

            this.sendTelegram(`
⏰ <b>HOURLY — QUANTUM PHASE REVERSAL BOT</b>

📊 Trades: ${this.hourly.trades}
✅/❌ W/L: ${this.hourly.wins}/${this.hourly.losses}
📈 Win Rate: ${winRate}%
💰 P&L: ${this.hourly.pnl >= 0 ? '+' : ''}$${this.hourly.pnl.toFixed(2)}

<b>By Asset:</b>${assetBreakdown}

<b>Session:</b>
├ Total: ${this.totalTrades}
├ W/L: ${this.totalWins}/${this.totalTrades - this.totalWins}
├ x2-x5: ${this.x2}/${this.x3}/${this.x4}/${this.x5}
└ Net: $${this.netProfit.toFixed(2)}
            `.trim());
            this.hourly = { trades: 0, wins: 0, losses: 0, pnl: 0 };
        }, 3600000);
    }

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentDay = gmtPlus1Time.getUTCDay(); // 0: Sunday, 1: Monday, ..., 6: Saturday
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            // Weekend logic: Saturday 11pm to Monday 8am GMT+1 -> Disconnect and stay disconnected
            const isWeekend = (currentDay === 0) || // Sunday
                (currentDay === 6 && currentHours >= 23) || // Saturday after 11pm
                (currentDay === 1 && currentHours < 8);    // Monday before 8am

            if (isWeekend) {
                if (!this.endOfDay) {
                    console.log("Weekend trading suspension (Saturday 11pm - Monday 8am). Disconnecting...");
                    this.disconnect();
                    this.endOfDay = true;
                }
                return; // Prevent any reconnection logic during the weekend
            }

            if (this.endOfDay && currentHours === 8 && currentMinutes >= 0) {
                console.log("It's 8:00 AM GMT+1, reconnecting the bot.");
                this.resetDailyStats();
                this.endOfDay = false;
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 17 && currentMinutes >= 0) {
                    console.log("It's past 5:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000);
    }

    resetDailyStats() {
        this.tradeInProgress = false;
        this.isWinTrade = false;
    }
}

// START
console.log('═══════════════════════════════════════════════════');
console.log('  QUANTUM PHASE REVERSAL BOT');
console.log('  Multi-Asset + Advanced Fractal + Weighted Fibonacci');
console.log('═══════════════════════════════════════════════════');
console.log(`  Started: ${new Date().toLocaleString()}`);
console.log('═══════════════════════════════════════════════════\n');

new QuantumPhaseReversalBot();
