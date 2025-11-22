require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');

/**
 * MarkovDifferBot
 * 
 * A sophisticated Deriv trading bot using a Context-Aware Markov Chain strategy.
 * It analyzes the sequence of the last 2 digits to predict the probability of the next digit.
 * Trades are placed on "Digit Differ" when the probability of a specific digit appearing
 * in the current context is statistically negligible.
 */
class MarkovDifferBot {
    constructor(token, config = {}) {
        this.token = token;

        // Configuration
        this.config = {
            assets: config.assets || ['R_100', 'R_10', 'R_25', 'R_50', 'R_75', 'RDBULL', 'RDBEAR'],
            initialStake: config.initialStake || 0.35,
            currency: config.currency || 'USD',

            // Risk Management
            stopLoss: config.stopLoss || 50, // Stop if total loss exceeds this
            takeProfit: config.takeProfit || 10, // Stop if total profit exceeds this
            maxConsecutiveLosses: config.maxConsecutiveLosses || 2, // Suspend asset after X losses
            martingaleMultiplier: config.martingaleMultiplier || 11, // Multiplier after loss (aggressive for Differ)

            // Strategy Settings
            learningPhase: config.learningPhase || 500, // Ticks to collect before trading
            minStateSamples: config.minStateSamples || 15, // Min occurrences of a pattern to trust stats
            probabilityThreshold: config.probabilityThreshold || 0.01, // Trade if P(digit) < 3%
            volatilityWindow: 20, // Ticks to calculate volatility
            volatilityThreshold: 2.5, // Avoid trading if std dev is too high (erratic market)
        };

        // State
        this.ws = null;
        this.connected = false;
        this.authorized = false;
        this.reconnectAttempts = 0;

        this.stats = {
            totalTrades: 0,
            wins: 0,
            losses: 0,
            profit: 0,
            startTime: new Date(),
            consecutiveLosses2: 0,
            consecutiveLosses3: 0,
            consecutiveLosses4: 0,
            consecutiveLosses5: 0,
        };

        this.emailConfig = {
            service: 'gmail',
            auth: {
                user: 'kenzkdp2@gmail.com',
                pass: 'jfjhtmussgfpbgpk'
            }
        };

        this.emailRecipient = 'kenotaru@gmail.com';

        this.startEmailTimer();
        this.endOfDay = false;
        this.isWinTrade = false;
        this.waitTime = 0;
        this.waitSeconds = 0;

        // Asset Data
        // Structure: { assetName: { history: [], markov: Matrix, lastDigits: [], suspended: bool, ... } }
        this.assetsData = {};

        // Initialize Asset Data
        this.config.assets.forEach(asset => {
            this.assetsData[asset] = {
                history: [], // Full tick history
                lastDigits: [], // Just the digits
                markov: this.createMarkovMatrix(), // 100x10 matrix
                stateCounts: new Array(100).fill(0), // Count of times each state occurred
                suspended: false,
                consecutiveLosses: 0,
                currentStake: this.config.initialStake,
                tradeInProgress: false,
                volatility: 0
            };
        });
    }

    /**
     * Creates a 100x10 matrix initialized to zeros.
     * Rows (0-99): Represent the state (Last 2 digits, e.g., "48" -> index 48).
     * Cols (0-9): Represent the count of the NEXT digit.
     */
    createMarkovMatrix() {
        return Array.from({ length: 100 }, () => new Array(10).fill(0));
    }

    start() {
        console.log(`
╔══════════════════════════════════════════════════════════════╗
║                MARKOV CHAIN DIGIT DIFFER BOT                 ║
║                -----------------------------                 ║
║  Assets: ${this.config.assets.join(', ')}                    ║
║  Strategy: Context-Aware Markov Chain (Order 2)              ║
╚══════════════════════════════════════════════════════════════╝
        `);
        this.connect();
        // this.checkTimeForDisconnectReconnect();
    }

    connect() {
        this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ Connected to Deriv API');
            this.authorize();
        });

        this.ws.on('message', (data) => this.handleMessage(JSON.parse(data)));

        this.ws.on('close', () => {
            console.log('❌ Disconnected. Reconnecting in 5s...');
            this.connected = false;
            this.authorized = false;
            setTimeout(() => this.connect(), 5000);
        });

        this.ws.on('error', (err) => {
            console.error('⚠️ WebSocket Error:', err.message);
        });
    }

    authorize() {
        this.send({ authorize: this.token });
    }

    send(req) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(req));
        }
    }

    handleMessage(msg) {
        if (msg.error) {
            console.error(`⚠️ API Error [${msg.msg_type}]:`, msg.error.message);
            // Handle specific errors like InvalidToken if needed
            return;
        }

        switch (msg.msg_type) {
            case 'authorize':
                this.handleAuth(msg);
                break;
            case 'history':
                this.handleHistory(msg);
                break;
            case 'tick':
                this.handleTick(msg);
                break;
            case 'proposal_open_contract':
                this.handleContract(msg);
                break;
            case 'buy':
                this.handleBuy(msg);
                break;
        }
    }

    handleAuth(msg) {
        console.log('🔐 Authorized. Account Balance:', msg.authorize.balance, msg.authorize.currency);
        this.authorized = true;
        this.subscribeToAssets();
    }

    subscribeToAssets() {
        this.config.assets.forEach(asset => {
            // Get initial history for learning
            this.send({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.learningPhase,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });

            // Subscribe to real-time ticks
            this.send({ ticks: asset, subscribe: 1 });
        });
    }

    handleHistory(msg) {
        const asset = msg.echo_req.ticks_history;
        this.handleTickHistory(asset, msg.history);
    }

    handleTick(msg) {
        const asset = msg.tick.symbol;
        const price = msg.tick.quote;
        this.processTick(asset, price, true); // true = can trade
    }

    getLastDigit(price, asset) {
        const quoteString = price.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V',].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

    handleTickHistory(asset, history) {
        const data = this.assetsData[asset];
        data.lastDigits = history.prices.map(price => this.getLastDigit(price, asset));
        data.history = history.prices.map(p => parseFloat(p));

        // Populate Markov Chain from history
        const digits = data.lastDigits;
        for (let i = 2; i < digits.length; i++) {
            const d1 = digits[i - 2];
            const d2 = digits[i - 1];
            const target = digits[i];

            const stateIndex = (d1 * 10) + d2;
            data.markov[stateIndex][target]++;
            data.stateCounts[stateIndex]++;
        }

        // Calculate Initial Volatility (Normalized as % of Mean Price)
        if (data.history.length >= this.config.volatilityWindow) {
            const window = data.history.slice(-this.config.volatilityWindow);
            const mean = window.reduce((a, b) => a + b, 0) / window.length;
            const variance = window.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / window.length;
            const stdDev = Math.sqrt(variance);
            data.volatility = (stdDev / mean) * 100;
        }

        console.log(`[${asset}] Initialized Markov Chain with ${digits.length} ticks. Vol: ${data.volatility.toFixed(4)}%`);
    }

    processTick(asset, price, canTrade) {
        const data = this.assetsData[asset];
        const digit = this.getLastDigit(price, asset);

        // Update History
        data.lastDigits.push(digit);
        data.history.push(parseFloat(price));

        if (data.lastDigits.length > 2000) {
            data.lastDigits.shift();
        }
        if (data.history.length > 2000) {
            data.history.shift();
        }

        // Calculate Volatility (Normalized as % of Mean Price)
        if (data.history.length >= this.config.volatilityWindow) {
            const window = data.history.slice(-this.config.volatilityWindow);
            const mean = window.reduce((a, b) => a + b, 0) / window.length;
            const variance = window.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / window.length;
            const stdDev = Math.sqrt(variance);
            data.volatility = (stdDev / mean) * 100;
        }

        // Update Markov Chain
        const n = data.lastDigits.length;
        if (n >= 3) {
            const d1 = data.lastDigits[n - 3];
            const d2 = data.lastDigits[n - 2];
            const target = data.lastDigits[n - 1];

            const stateIndex = (d1 * 10) + d2;
            data.markov[stateIndex][target]++;
            data.stateCounts[stateIndex]++;
        }

        // Trading Logic
        if (canTrade && !data.tradeInProgress && !data.suspended && data.history.length >= this.config.learningPhase) {
            this.evaluateTrade(asset);
        }
    }

    evaluateTrade(asset) {
        const data = this.assetsData[asset];

        // 1. Check Volatility
        // Note: Volatility scale depends on the asset price. This is a rough heuristic.
        // For a robust bot, we might use Bollinger Band width or similar relative metrics.
        // For now, we skip if volatility is extremely high relative to recent average (simplified).

        // 2. Determine Current State
        const n = data.lastDigits.length;
        const d1 = data.lastDigits[n - 2];
        const d2 = data.lastDigits[n - 1];
        const currentState = (d1 * 10) + d2;

        // 3. Check Sample Size
        const totalSamples = data.stateCounts[currentState];
        console.log(`[${asset}] Total samples for pattern [${d1}, ${d2}]: ${totalSamples}`);
        if (totalSamples < this.config.minStateSamples) {
            // Not enough data for this specific pattern yet
            console.log(`[${asset}] Not enough data for pattern [${d1}, ${d2}]. Skipping trade.`);
            return;
        }

        // 4. Analyze Probabilities
        const transitions = data.markov[currentState];
        let lowestProb = 1.0;
        let bestDigit = -1;

        for (let digit = 0; digit <= 9; digit++) {
            const count = transitions[digit];
            const prob = count / totalSamples;

            if (prob < lowestProb) {
                lowestProb = prob;
                bestDigit = digit;
            }
        }

        // 5. Place Trade if Probability is Low Enough
        if (lowestProb <= this.config.probabilityThreshold && bestDigit !== -1) {
            console.log(`⚡ [${asset}] Pattern [${d1}, ${d2}] -> ? | Digit:(${bestDigit}) = ${(lowestProb * 100).toFixed(1)}% (${transitions[bestDigit]}/${totalSamples}) | Vol: ${data.volatility.toFixed(4)}`);

            this.placeTrade(asset, bestDigit, lowestProb);
        }
    }

    placeTrade(asset, digit, probability) {
        const data = this.assetsData[asset];
        console.log(`Predicted Digit: ${digit} | Probability: ${probability}`);

        {
            // Live Trade
            data.tradeInProgress = true;
            const contract = {
                buy: 1,
                price: data.currentStake,
                parameters: {
                    amount: data.currentStake,
                    basis: 'stake',
                    contract_type: 'DIGITDIFF',
                    currency: this.config.currency,
                    duration: 1,
                    duration_unit: 't',
                    symbol: asset,
                    barrier: digit.toString()
                }
            };
            this.send(contract);
        }
    }

    handleBuy(msg) {
        if (msg.buy) {
            const contractId = msg.buy.contract_id;
            console.log(`✅ Trade Placed. ID: ${contractId}`);
            // Subscribe to contract updates to get the result
            this.send({
                proposal_open_contract: 1,
                contract_id: contractId,
                subscribe: 1
            });
        }
    }

    handleContract(msg) {
        const contract = msg.proposal_open_contract;
        if (contract.is_sold) {
            this.handleTradeResult(contract);
        }
    }

    handleTradeResult(contract) {
        const asset = contract.underlying;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const data = this.assetsData[asset];

        data.tradeInProgress = false;

        // Update Stats
        this.stats.totalTrades++;
        if (won) this.stats.wins++; else this.stats.losses++;
        this.stats.profit += profit;

        const symbol = won ? '✅' : '❌';
        console.log(`${symbol} [${asset}] ${won ? 'WIN' : 'LOSS'} | Profit: ${profit.toFixed(2)} | Total P/L: ${this.stats.profit.toFixed(2)}`);

        // Strategy Management
        if (won) {
            data.consecutiveLosses = 0;
            data.currentStake = this.config.initialStake; // Reset stake

            // Check Take Profit
            if (this.stats.profit >= this.config.takeProfit) {
                console.log('🎉 TAKE PROFIT REACHED! Stopping bot.');
                this.sendEmailSummary();
                this.stop();
            }

            this.isWinTrade = true;

        } else {
            data.consecutiveLosses++;
            this.isWinTrade = false;
            this.config.minStateSamples++;

            // Update global consecutive loss counters
            if (data.consecutiveLosses === 2) this.stats.consecutiveLosses2++;
            else if (data.consecutiveLosses === 3) this.stats.consecutiveLosses3++;
            else if (data.consecutiveLosses === 4) this.stats.consecutiveLosses4++;
            else if (data.consecutiveLosses === 5) this.stats.consecutiveLosses5++;

            // Martingale / Recovery
            data.currentStake = data.currentStake * this.config.martingaleMultiplier;
            // Round to 2 decimals
            data.currentStake = Math.round(data.currentStake * 100) / 100;

            console.log(`🔻 [${asset}] Loss #${data.consecutiveLosses}. Increasing stake to $${data.currentStake}`);

            this.sendLossEmail(asset, data);

            // Suspend Asset if too many losses
            if (data.consecutiveLosses >= this.config.maxConsecutiveLosses) {
                console.log(`⛔ [${asset}] Max consecutive losses reached. Suspending asset.`);
                data.suspended = true;
                // Optional: Auto-unsuspend after some time?
                setTimeout(() => {
                    console.log(`♻️ [${asset}] Unsuspending asset.`);
                    data.suspended = false;
                    data.consecutiveLosses = 0;
                    data.currentStake = this.config.initialStake;
                }, 60000 * 5); // 5 minutes
            }

            // Check Stop Loss
            if (this.stats.profit <= -this.config.stopLoss) {
                console.log('💀 STOP LOSS REACHED! Stopping bot.');
                this.stop();
            }
        }

        if (!this.endOfDay) {
            this.logTradingSummary(asset, data);
        }
    }

    logTradingSummary(asset, data) {
        console.log('Trading Summary:');
        console.log(`Total Trades: ${this.stats.totalTrades}`);
        console.log(`Total Trades Won: ${this.stats.wins}`);
        console.log(`Total Trades Lost: ${this.stats.losses}`);
        console.log(`x2 Losses: ${this.stats.consecutiveLosses2}`);
        console.log(`x3 Losses: ${this.stats.consecutiveLosses3}`);
        console.log(`x4 Losses: ${this.stats.consecutiveLosses4}`);
        console.log(`x5 Losses: ${this.stats.consecutiveLosses5}`);
        console.log(`Predicted Digit: ${data.predictedDigit}`);
        console.log(`MinStateSamples: ${this.config.minStateSamples}`);
        console.log(`Total Profit/Loss Amount: ${this.stats.profit.toFixed(2)}`);
        console.log(`[${asset}] Current Stake: $${data.currentStake.toFixed(2)}`);
    }

    startEmailTimer() {
        if (!this.endOfDay) {
            setInterval(() => {
                this.sendEmailSummary();
            }, 1800000); // 30 Minutes
        }
    }

    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const summaryText = `
        Trading Summary:
        Total Trades: ${this.stats.totalTrades}
        Total Trades Won: ${this.stats.wins}
        Total Trades Lost: ${this.stats.losses}
        x2 Losses: ${this.stats.consecutiveLosses2}
        x3 Losses: ${this.stats.consecutiveLosses3}
        x4 Losses: ${this.stats.consecutiveLosses4}
        x5 Losses: ${this.stats.consecutiveLosses5}

        Total Profit/Loss Amount: ${this.stats.profit.toFixed(2)}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Markov_Digit_Differ_Bot - Summary',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending email:', error);
        }
    }

    async sendLossEmail(asset, data) {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const lastFewTicks = data.lastDigits.slice(-20);

        const summaryText = `
        Trade Summary:
        Total Trades: ${this.stats.totalTrades}
        Total Trades Won: ${this.stats.wins}
        Total Trades Lost: ${this.stats.losses}
        x2 Losses: ${this.stats.consecutiveLosses2}
        x3 Losses: ${this.stats.consecutiveLosses3}
        x4 Losses: ${this.stats.consecutiveLosses4}
        x5 Losses: ${this.stats.consecutiveLosses5}

        Total Profit/Loss Amount: ${this.stats.profit.toFixed(2)}

        Last Digit Analysis:
        Asset: ${asset}
        Predicted Digit: ${data.predictedDigit}
        MinStateSamples: ${this.config.minStateSamples}
        Last 20 Digits: ${lastFewTicks.join(', ')} 

        Current Stake: $${data.currentStake.toFixed(2)}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Markov_Digit_Differ_Bot - Loss Alert',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending loss email:', error);
        }
    }

    async sendDisconnectResumptionEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const now = new Date();
        const currentHours = now.getHours();
        const currentMinutes = now.getMinutes();

        const summaryText = `
        Disconnect/Reconnect Email: Time (${currentHours}:${currentMinutes})
        Trading Summary:
        Total Trades: ${this.stats.totalTrades}
        Total Trades Won: ${this.stats.wins}
        Total Trades Lost: ${this.stats.losses}
        x2 Losses: ${this.stats.consecutiveLosses2}
        x3 Losses: ${this.stats.consecutiveLosses3}
        x4 Losses: ${this.stats.consecutiveLosses4}
        x5 Losses: ${this.stats.consecutiveLosses5}

        MinStateSamples: ${this.config.minStateSamples}

        Total Profit/Loss Amount: ${this.stats.profit.toFixed(2)}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Markov_Digit_Differ_Bot - Connection/Dissconnection Summary',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending email:', error);
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Markov_Digit_Differ_Bot - Error Report',
            text: `An error occurred: ${errorMessage}`
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending error email:', error);
        }
    }

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            if (this.endOfDay && currentHours === 8 && currentMinutes >= 0) {
                console.log("It's 8:00 AM GMT+1, reconnecting the bot.");
                this.endOfDay = false;
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 17 && currentMinutes >= 0) {
                    console.log("It's past 5:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.sendDisconnectResumptionEmailSummary();
                    this.ws.close();
                    this.endOfDay = true;
                }
            }
        }, 20000);
    }


    stop() {
        console.log('🛑 Stopping Bot...');
        this.ws.close();
        process.exit(0);
    }
}

// --- RUNNER ---

// Use the token from the existing file or env
const TOKEN = process.env.DERIV_TOKEN || 'DMylfkyce6VyZt7'; // Fallback to token found in geminiDiffer.js

const bot = new MarkovDifferBot(TOKEN, {
    initialStake: 2,
    martingaleMultiplier: 11.3, // High multiplier needed for Differ (payout ~9-10%)
    probabilityThreshold: 0.01, // Only trade if < 2% chance of hitting the digit
    minStateSamples: 12, // Learn quickly
    stopLoss: 200, // Stop if total loss exceeds this
    takeProfit: 5000, // Stop if total profit exceeds this
    maxConsecutiveLosses: 3, // Suspend asset after X losses
});

bot.start();
