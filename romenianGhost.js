const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = "0P94g4WdSrSrzir";
const TELEGRAM_TOKEN = "8288121368:AAHYRb0Stk5dWUWN1iTYbdO3fyIEwIuZQR8";
const CHAT_ID = "752497117";

class BlackFibonacci {
    constructor() {
        // Configuration
        this.config = {
            requiredHistoryLength: 3000,
            minHistoryForTrading: 2000,
            asset: 'R_10'
        };

        // Trading state
        this.history = [];
        this.stake = 2.20;
        this.consecutiveLosses = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.x2 = 0;
        this.x3 = 0;
        this.x4 = 0;
        this.x5 = 0;
        this.netProfit = 0;
        this.lastTradeDigit = null;
        this.tradeInProgress = false;

        // Hourly stats
        this.hourly = { trades: 0, wins: 0, losses: 0, pnl: 0 };

        // WebSocket state
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.historyLoaded = false;

        // Telegram bot
        this.telegramBot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

        // Start connection
        this.connect();

        // Setup hourly summary
        this.startHourlySummary();
    }

    connect() {
        console.log('🔌 Connecting to Deriv API...');

        this.ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ Connected to Deriv API');
            this.connected = true;
            this.authenticate();
        });

        this.ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                this.handleMessage(message);
            } catch (error) {
                console.error('❌ Error parsing message:', error.message);
            }
        });

        this.ws.on('error', (error) => {
            console.error('❌ WebSocket error:', error.message);
        });

        this.ws.on('close', (code, reason) => {
            console.log(`⚠️ Disconnected from Deriv API (Code: ${code}, Reason: ${reason || 'None'})`);
            this.connected = false;
            this.wsReady = false;
            this.reconnect();
        });
    }

    reconnect() {
        console.log('🔄 Reconnecting in 5 seconds...');
        setTimeout(() => {
            this.connect();
        }, 5000);
    }

    authenticate() {
        console.log('🔐 Authenticating...');
        this.sendRequest({ authorize: TOKEN });
    }

    handleMessage(message) {
        // Handle errors
        if (message.error) {
            console.error('❌ API Error:', message.error.message);
            if (message.error.code === 'AuthorizationRequired' || message.error.code === 'InvalidToken') {
                console.log('⚠️ Auth error detected, reconnecting...');
                this.ws.close();
            }
            return;
        }

        // Handle authorization
        if (message.msg_type === 'authorize') {
            console.log('✅ Authenticated successfully');
            console.log(`💰 Balance: $${message.authorize.balance} ${message.authorize.currency}`);
            this.wsReady = true;
            this.initializeSubscriptions();
            this.sendTelegram(`
🚀 <b>BLACK FIBONACCI 9.1 FINAL — GHOST MODE ACTIVATED</b>

💰 Balance: $${message.authorize.balance} ${message.authorize.currency}
📊 Subscribing to ${this.config.requiredHistoryLength} ticks history for ${this.config.asset}
⏰ ${new Date().toLocaleString()}
            `.trim());
        }

        // Handle tick history
        else if (message.msg_type === 'history') {
            const asset = message.echo_req.ticks_history;
            this.handleTickHistory(asset, message.history);
        }

        // Handle live ticks
        else if (message.msg_type === 'tick') {
            this.handleTickUpdate(message.tick);
        }

        // Handle trade placement
        else if (message.msg_type === 'buy') {
            if (message.error) {
                console.error('❌ Error placing trade:', message.error.message);
                this.sendTelegram(`❌ <b>Trade Error:</b> ${message.error.message}`);
                this.tradeInProgress = false;
                return;
            }
            console.log('✅ Trade placed successfully');
            console.log(`   Contract ID: ${message.buy.contract_id}`);
            this.subscribeToContract(message.buy.contract_id);
        }

        // Handle contract updates
        else if (message.msg_type === 'proposal_open_contract') {
            if (message.proposal_open_contract.is_sold) {
                this.handleTradeResult(message.proposal_open_contract);
            }
        }
    }

    initializeSubscriptions() {
        console.log('📊 Initializing subscriptions...');

        // Request historical data
        console.log(`   Requesting ${this.config.requiredHistoryLength} ticks for ${this.config.asset}...`);
        this.sendRequest({
            ticks_history: this.config.asset,
            adjust_start_time: 1,
            count: this.config.requiredHistoryLength,
            end: 'latest',
            start: 1,
            style: 'ticks'
        });

        // Subscribe to live ticks
        console.log(`   Subscribing to live ticks for ${this.config.asset}...`);
        this.sendRequest({
            ticks: this.config.asset,
            subscribe: 1
        });
    }

    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V'].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

    handleTickHistory(asset, history) {
        this.history = history.prices.map(price => this.getLastDigit(price, asset));
        this.historyLoaded = true;
        console.log(`📊 Loaded ${this.history.length} ticks for ${asset}`);
        console.log(`   Last 10 digits: ${this.history.slice(-10).join(', ')}`);

        if (this.history.length >= this.config.minHistoryForTrading) {
            console.log(`✅ History ready for trading (${this.history.length}/${this.config.requiredHistoryLength} ticks)`);
        } else {
            console.log(`⚠️ Insufficient history for trading (${this.history.length}/${this.config.minHistoryForTrading} required)`);
        }
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const lastDigit = this.getLastDigit(tick.quote, asset);

        this.history.push(lastDigit);
        if (this.history.length > this.config.requiredHistoryLength) {
            this.history.shift();
        }

        // Log tick updates periodically
        if (this.history.length % 50 === 0) {
            console.log(`📈 [${asset}] Tick #${this.history.length} | Quote: ${tick.quote} | Digit: ${lastDigit}`);
            console.log(`   Last 10: ${this.history.slice(-10).join(', ')}`);
        }

        // Scan for signals if ready
        if (this.historyLoaded && this.history.length >= this.config.minHistoryForTrading && !this.tradeInProgress) {
            this.scanForSignal();
        }
    }

    scanForSignal() {
        const windows = [13, 21, 34, 55, 89, 144, 233, 377, 610, 987];
        const scores = Array(10).fill(0);

        // Calculate Z-scores across Fibonacci windows
        for (const w of windows) {
            if (this.history.length < w) continue;
            const slice = this.history.slice(-w);
            const counts = Array(10).fill(0);
            slice.forEach(d => counts[d]++);
            const exp = w / 10;
            const sd = Math.sqrt(w * 0.1 * 0.9);

            for (let i = 0; i < 10; i++) {
                scores[i] += (counts[i] - exp) / sd;
            }
        }

        // Find saturated digit
        let maxZ = -99, sat = -1;
        for (let i = 0; i < 10; i++) {
            if (scores[i] > maxZ) {
                maxZ = scores[i];
                sat = i;
            }
        }

        // Calculate volatility (concentration)
        // ULTRA-LOW VOLATILITY CHECK — ROMANIAN GHOST EXACT
        const last500 = this.history.slice(-500);
        const freq = Array(10).fill(0);
        last500.forEach(d => freq[d]++);

        let entropy = 0;
        for (let f of freq) {
            if (f > 0) {
                const p = f / 500;
                entropy -= p * Math.log2(p);
            }
        }

        // Check conditions
        const inRecent = this.history.slice(-9).includes(sat);

        const concentration = 1 - (entropy / Math.log2(10));
        const ultraLow = concentration > 0.0071;  // THIS IS THE REAL THRESHOLD

        // Log analysis every 100 ticks
        if (this.history.length % 100 === 0) {
            console.log(`Z=${maxZ.toFixed(2)} | Digit=${sat} | Conc=${concentration.toFixed(4)} | UltraLow=${ultraLow} | InRecent=${inRecent}`);
        }

        // Trade signal
        if (ultraLow && maxZ >= 11.15 && inRecent && sat !== this.lastTradeDigit) {
            this.placeTrade(sat, maxZ, conc);
        }
    }

    placeTrade(digit, zScore, concentration) {
        if (this.tradeInProgress) return;

        this.tradeInProgress = true;
        this.lastTradeDigit = digit;

        console.log(`\n🎯 TRADE SIGNAL DETECTED!`);
        console.log(`   Digit: ${digit}`);
        console.log(`   Z-Score: ${zScore.toFixed(2)}`);
        console.log(`   Concentration: ${concentration.toFixed(3)}`);
        console.log(`   Stake: $${this.stake.toFixed(2)}`);
        console.log(`   Consecutive Losses: ${this.consecutiveLosses}`);

        this.sendRequest({
            buy: 1,
            price: this.stake,
            parameters: {
                amount: this.stake,
                basis: "stake",
                contract_type: "DIGITDIFF",
                currency: "USD",
                duration: 1,
                duration_unit: "t",
                symbol: this.config.asset,
                barrier: digit.toString()
            }
        });

        this.sendTelegram(`
🎯 <b>TRADE SIGNAL</b>

📊 Digit: ${digit}
📈 Z-Score: ${zScore.toFixed(2)}
🔬 Concentration: ${concentration.toFixed(3)}
💰 Stake: $${this.stake.toFixed(2)}
📉 Consecutive Losses: ${this.consecutiveLosses}
⏰ ${new Date().toLocaleTimeString()}
        `.trim());
    }

    subscribeToContract(contractId) {
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });
    }

    handleTradeResult(contract) {
        const won = contract.status === "won";
        const profit = parseFloat(contract.profit);
        const exitDigit = this.getLastDigit(contract.exit_tick_display_value, this.config.asset);

        this.totalTrades++;
        this.hourly.trades++;
        this.hourly.pnl += profit;
        this.netProfit += profit;

        const result = won ? '✅ WIN' : '❌ LOSS';
        console.log(`\n${result}`);
        console.log(`   Exit Digit: ${exitDigit}`);
        console.log(`   Profit: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);
        console.log(`   Total Trades: ${this.totalTrades}`);
        console.log(`   Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(1)}%`);
        console.log(`   Net P&L: $${this.netProfit.toFixed(2)}\n`);

        if (won) {
            this.totalWins++;
            this.hourly.wins++;
            this.consecutiveLosses = 0;
            this.stake = 2.20;
        } else {
            this.hourly.losses++;
            this.consecutiveLosses++;

            if (this.consecutiveLosses === 2) this.x2++;
            if (this.consecutiveLosses === 3) this.x3++;
            if (this.consecutiveLosses === 4) this.x4++;
            if (this.consecutiveLosses === 5) this.x5++;

            this.stake = this.consecutiveLosses === 1
                ? 3.96
                : 2.20 * Math.pow(11.3, this.consecutiveLosses - 1);
            this.stake = Math.round(this.stake * 100) / 100;

            // Send loss alert
            this.sendTelegram(`
                ❌ <b>LOSS TRADE</b>

                📊 Exit Digit: ${exitDigit}
                💸 Profit: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}
                📈 Total Trades: ${this.totalTrades}
                ✅/❌ W/L: ${this.totalWins}/${this.totalTrades - this.totalWins}
                🔢 x2-x5 Losses: ${this.x2}/${this.x3}/${this.x4}/${this.x5}
                💰 Next Stake: $${this.stake.toFixed(2)}
                💵 Net P&L: $${this.netProfit.toFixed(2)}
                ⏰ ${new Date().toLocaleString()}
            `.trim());
        }

        this.tradeInProgress = false;
    }

    startHourlySummary() {
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1);
        nextHour.setMinutes(0);
        nextHour.setSeconds(0);
        nextHour.setMilliseconds(0);

        const timeUntilNextHour = nextHour.getTime() - now.getTime();

        setTimeout(() => {
            this.sendHourlySummary();
            setInterval(() => {
                this.sendHourlySummary();
            }, 3600000);
        }, timeUntilNextHour);

        console.log(`📱 Hourly summaries scheduled. First in ${Math.ceil(timeUntilNextHour / 60000)} minutes.`);
    }

    sendHourlySummary() {
        if (this.hourly.trades === 0) {
            console.log('📊 No trades this hour, skipping summary');
            return;
        }

        const winRate = this.hourly.trades > 0
            ? ((this.hourly.wins / this.hourly.trades) * 100).toFixed(1)
            : 0;

        console.log(`\n📊 HOURLY SUMMARY`);
        console.log(`   Trades: ${this.hourly.trades}`);
        console.log(`   W/L: ${this.hourly.wins}/${this.hourly.losses}`);
        console.log(`   Win Rate: ${winRate}%`);
        console.log(`   P&L: ${this.hourly.pnl >= 0 ? '+' : ''}$${this.hourly.pnl.toFixed(2)}\n`);

        this.sendTelegram(`
            ⏰ <b>HOURLY SUMMARY</b>

            📊 <b>Last Hour</b>
            ├ Trades: ${this.hourly.trades}
            ├ W/L: ${this.hourly.wins}/${this.hourly.losses}
            ├ Win Rate: ${winRate}%
            └ P&L: ${this.hourly.pnl >= 0 ? '+' : ''}$${this.hourly.pnl.toFixed(2)}

            📈 <b>Session Total</b>
            ├ Total Trades: ${this.totalTrades}
            ├ Total W/L: ${this.totalWins}/${this.totalTrades - this.totalWins}
            ├ x2-x5: ${this.x2}/${this.x3}/${this.x4}/${this.x5}
            └ Net P&L: $${this.netProfit.toFixed(2)}

            ⏰ ${new Date().toLocaleString()}
        `.trim());

        this.hourly = { trades: 0, wins: 0, losses: 0, pnl: 0 };
    }

    sendRequest(request) {
        if (!this.connected || !this.ws || this.ws.readyState !== 1) {
            console.warn('⚠️ Cannot send request: WebSocket not ready');
            return false;
        }

        try {
            this.ws.send(JSON.stringify(request));
            return true;
        } catch (error) {
            console.error('❌ Error sending request:', error.message);
            return false;
        }
    }

    sendTelegram(text) {
        this.telegramBot.sendMessage(CHAT_ID, text, { parse_mode: "HTML" })
            .catch(error => {
                console.error('❌ Telegram error:', error.message);
            });
    }
}

// Start the bot
console.log('═══════════════════════════════════════════════════');
console.log('  BLACK FIBONACCI 9.1 FINAL — GHOST MODE');
console.log('═══════════════════════════════════════════════════');
console.log(`  Started: ${new Date().toLocaleString()}`);
console.log('═══════════════════════════════════════════════════\n');

new BlackFibonacci();
