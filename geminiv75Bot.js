const WebSocket = require('ws');
const nodemailer = require('nodemailer');

// EnhancedDerivTradingBot class with Advanced Pattern Recognition
class EnhancedDerivTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        
        // --- UPDATED CONFIGURATION ---
        this.config = {
            initialStake: config.initialStake,
            multiplier: config.multiplier,
            maxConsecutiveLosses: config.maxConsecutiveLosses,
            takeProfit: config.takeProfit,
            // New Filter Configs
            analysisWindow: 100,      // Analyze the last 100 ticks for patterns
            maxRepetitionThreshold: 10, // If global repeats > 12% in last 100 ticks, DO NOT TRADE (Market is sticky)
            maxDigitFrequency: 12,    // If the specific digit appears > 14% of time, DO NOT TRADE (Digit is Hot)
        };

        this.assets = ['R_100', 'R_10', 'R_25', 'R_50', 'R_75']; // Suggest using Volatility indices for better stats
        
        // Initialize existing properties
        this.currentStake = this.config.initialStake;
        this.usedAssets = new Set();
        this.consecutiveLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.currentAsset = null;
        this.currentTradeId = null;
        this.lastDigitsList = [];
        this.tickHistory = []; // This stores raw digits
        this.tradeInProgress = false;
        this.wsReady = false;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.Pause = false;
        this.RestartTrading = true;
        this.endOfDay = false;
        this.requiredHistoryLength = 1000; 
        this.xDigit = null;
        this.actualDigit = null;

        // WebSocket management
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10000;
        this.reconnectInterval = 5000;
        this.tickSubscriptionId = null;

        // Email configuration (Keep your existing settings)
        this.emailConfig = {
            service: 'gmail',
            auth: { user: 'kenzkdp2@gmail.com', pass: 'jfjhtmussgfpbgpk' }
        };
        this.emailRecipient = 'kenotaru@gmail.com';
        this.startEmailTimer();
    }

    // ... [Previous connect(), sendRequest(), etc. remain unchanged] ...

    connect() {
        if (!this.endOfDay) {
            console.log('Attempting to connect to Deriv API...');
            this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

            this.ws.on('open', () => {
                console.log('Connected to Deriv API');
                this.connected = true;
                this.wsReady = true;
                this.reconnectAttempts = 0;
                this.authenticate();
            });

            this.ws.on('message', (data) => {
                const message = JSON.parse(data);
                this.handleMessage(message);
            });

            this.ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                this.handleDisconnect();
            });

            this.ws.on('close', () => {
                console.log('Disconnected from Deriv API');
                this.connected = false;
                if (!this.endOfDay && !this.Pause) {
                    this.handleDisconnect();
                }
            });
        }
    }
    
    sendRequest(request) {
        if (this.connected && this.wsReady) {
            this.ws.send(JSON.stringify(request));
        } else if (this.connected && !this.wsReady) {
            console.log('WebSocket not ready. Queueing request...');
            setTimeout(() => this.sendRequest(request), this.reconnectInterval);
        } else {
            console.error('Not connected to Deriv API. Unable to send request:', request);
        }
    }
    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            setTimeout(() => this.connect(), this.reconnectInterval);
        }
        this.tradeInProgress = false;
        this.lastDigitsList = [];
        this.tickHistory = [];
    }
    handleApiError(error) {
        console.error('API Error:', error.message);
        switch (error.code) {
            case 'InvalidToken':
                console.error('Invalid token. Please check your API token and restart the bot.');
                this.sendErrorEmail('Invalid API token');
                this.disconnect();
                break;
            case 'RateLimit':
                console.log('Rate limit reached. Waiting before next request...');
                setTimeout(() => this.startTrading(), 60000);
                break;
            case 'MarketIsClosed':
                console.log('Market is closed. Waiting for market to open...');
                setTimeout(() => this.startTrading(), 3600000);
                break;
            default:
                console.log('Encountered an error. Continuing operation...');
                this.startTrading();
        }
    }
    authenticate() {
        console.log('Attempting to authenticate...');
        this.sendRequest({
            authorize: this.token
        });
    }
    subscribeToTickHistory(asset) {
        const request = {
            ticks_history: asset,
            adjust_start_time: 1,
            count: this.requiredHistoryLength,
            end: 'latest',
            start: 1,
            style: 'ticks'
        };
        this.sendRequest(request);
        console.log(`Requested tick history for asset: ${asset}`);
    }
    subscribeToTicks(asset) {
        const request = {
            ticks: asset,
            subscribe: 1
        };
        this.sendRequest(request);
    }

    handleMessage(message) {
         if (message.msg_type === 'authorize') {
            if (message.error) {
                console.error('Authentication failed:', message.error.message);
                this.disconnect();
                return;
            }
            console.log('Authentication successful');
            this.tradeInProgress = false;
            this.lastDigitsList = [];
            this.tickHistory = [];
            this.startTrading();

        } else if (message.msg_type === 'history') {
            this.handleTickHistory(message.history);
        } else if (message.msg_type === 'tick') {
            this.handleTickUpdate(message.tick);
        } else if (message.msg_type === 'buy') {
            if (message.error) {
                console.error('Error placing trade:', message.error.message);
                this.tradeInProgress = false;
                return;
            }
            console.log('Trade placed successfully. Contract ID:', message.buy.contract_id);
            this.currentTradeId = message.buy.contract_id;
            this.subscribeToOpenContract(this.currentTradeId);
        } else if (message.msg_type === 'proposal_open_contract') {
            this.handleContractUpdate(message.proposal_open_contract);
        } else if (message.msg_type === 'forget') {
            this.tickSubscriptionId = null;
        } else if (message.subscription && message.msg_type === 'tick') {
            this.tickSubscriptionId = message.subscription.id;
        } else if (message.error) {
            this.handleApiError(message.error);
        }
    }

    sendRequest(request) {
        if (this.connected && this.wsReady) {
            this.ws.send(JSON.stringify(request));
        } else if (this.connected && !this.wsReady) {
            setTimeout(() => this.sendRequest(request), 1000);
        }
    }
    
    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            setTimeout(() => this.connect(), this.reconnectInterval);
        }
    }

    handleApiError(error) {
        console.error('API Error:', error.message);
        this.startTrading();
    }

    authenticate() {
        this.sendRequest({ authorize: this.token });
    }

    subscribeToTickHistory(asset) {
        const request = {
            ticks_history: asset,
            adjust_start_time: 1,
            count: this.requiredHistoryLength,
            end: 'latest',
            start: 1,
            style: 'ticks'
        };
        this.sendRequest(request);
    }

    subscribeToTicks(asset) {
        const request = { ticks: asset, subscribe: 1 };
        this.sendRequest(request);
    }

    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');
        // Generalized digit extraction based on your logic
        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V'].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

    startTrading() {
        this.tradeNextAsset();
    }

    tradeNextAsset() {
        if (this.RestartTrading) {
            let availableAssets = this.assets.filter(asset => !this.usedAssets.has(asset));
            // Reset assets if all used
            if(availableAssets.length === 0) {
                 this.usedAssets.clear();
                 availableAssets = this.assets;
            }
            
            this.currentAsset = availableAssets[Math.floor(Math.random() * availableAssets.length)];
            console.log(`Selected asset: ${this.currentAsset}`);

            this.unsubscribeFromTicks(() => {
                this.subscribeToTickHistory(this.currentAsset);
                this.subscribeToTicks(this.currentAsset);
            });
            this.RestartTrading = false;
        }
    }
    
    unsubscribeFromTicks(callback) {
        if (this.tickSubscriptionId) {
            this.sendRequest({ forget: this.tickSubscriptionId });
            // Simple timeout for unsubscribe flow
            setTimeout(() => {
                 this.tickSubscriptionId = null;
                 if (callback) callback();
            }, 1000);
        } else {
            if (callback) callback();
        }
    }

    handleTickHistory(history) {
        this.tickHistory = history.prices.map(price => this.getLastDigit(price, this.currentAsset));
    }

    handleTickUpdate(tick) {
        const lastDigit = this.getLastDigit(tick.quote, this.currentAsset);
        this.tickHistory.push(lastDigit);
        
        // Keep history size manageable
        if (this.tickHistory.length > this.requiredHistoryLength) {
            this.tickHistory.shift();
        }

        if (!this.tradeInProgress) {
            this.analyzeTicksEnhanced();
        }
    }

    // =========================================================================
    // 🧠 INTELLIGENT MARKET ANALYSIS ENGINE (NEW UPGRADE)
    // =========================================================================

    analyzeTicksEnhanced() {
        if (this.tradeInProgress || this.Pause || this.tickHistory.length < this.config.analysisWindow) {
            return;
        }

        const analysisWindow = this.config.analysisWindow; // Last 100 ticks
        const historySlice = this.tickHistory.slice(-analysisWindow);
        const currentDigit = this.tickHistory[this.tickHistory.length - 1];

        // 1. Calculate Global Repetition Rate (Entropy)
        // How often did ANY digit repeat immediately in the last 100 ticks?
        let repeats = 0;
        for (let i = 1; i < historySlice.length; i++) {
            if (historySlice[i] === historySlice[i - 1]) {
                repeats++;
            }
        }
        const globalRepetitionRate = (repeats / analysisWindow) * 100;

        // 2. Calculate Individual Digit Frequency (Heat)
        // How often has the CURRENT digit (the one we want to bet against) appeared recently?
        const digitCount = historySlice.filter(d => d === currentDigit).length;
        const digitFrequency = (digitCount / analysisWindow) * 100;

        console.log(`📊 Analysis [${this.currentAsset}] | Last: ${currentDigit} | Global Repeats: ${globalRepetitionRate}% | Digit Heat: ${digitFrequency}%`);

        // ================= TRADING LOGIC =================
        
        // CONDITION 1: Global Safety Check
        // If the market is repeating abnormally often (>12%), wait. 
        // We want a "Scattering" market for Digit Differ.
        if (globalRepetitionRate > this.config.maxRepetitionThreshold) {
            console.log(`⚠️ Market Sticky (Repeats: ${globalRepetitionRate}%). Skipping...`);
            return;
        }

        // CONDITION 2: Specific Digit Safety Check
        // If the current digit is "Hot" (>14% freq), it has a higher statistical chance of repeating.
        if (digitFrequency > this.config.maxDigitFrequency) {
             console.log(`🔥 Digit ${currentDigit} is HOT (${digitFrequency}%). Skipping to avoid repeat...`);
             return;
        }

        // CONDITION 3: Pattern Check (Double Repeat)
        // If the last two digits were the same (e.g., 5, 5), do we bet on a 3rd?
        // Risky. Let's skip if a repeat just happened.
        const prevDigit = this.tickHistory[this.tickHistory.length - 2];
        if (currentDigit === prevDigit) {
            console.log(`⚠️ Immediate Repeat Detected (${prevDigit} -> ${currentDigit}). Waiting for breakout...`);
            return;
        }

        // ✅ ALL CHECKS PASSED
        console.log(`✅ Signal Found: Market Scattering, Digit Cold. Executing...`);
        this.xDigit = currentDigit;
        this.placeTrade(this.xDigit);
    }

    // =========================================================================

    placeTrade(predictedDigit) {
        if (this.tradeInProgress) return;

        this.tradeInProgress = true;
        console.log(`\n💰 PLACING TRADE on ${this.currentAsset}`);
        console.log(`Target: Differ from ${predictedDigit}`);
        console.log(`Stake: $${this.currentStake.toFixed(2)}`);

        const request = {
            buy: 1,
            price: this.currentStake.toFixed(2),
            parameters: {
                amount: this.currentStake.toFixed(2),
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: this.currentAsset,
                barrier: predictedDigit
            }
        };
        this.sendRequest(request);
    }

    subscribeToOpenContract(contractId) {
        const request = {
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        };
        this.sendRequest(request);
    }

    handleContractUpdate(contract) {
        if (contract.is_sold) {
            this.handleTradeResult(contract);
        }
    }

    handleTradeResult(contract) {
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const exitSpot = contract.exit_tick_display_value;
        const actualDigit = this.getLastDigit(parseFloat(exitSpot), this.currentAsset);
        this.actualDigit = actualDigit;

        console.log(`\n📊 TRADE RESULT: ${won ? '✅ WON' : '❌ LOST'}`);
        console.log(`   Predicted: != ${this.xDigit} | Actual: ${actualDigit}`);
        console.log(`   Profit/Loss: $${profit.toFixed(2)}`);

        this.totalTrades++;
        this.totalProfitLoss += profit;

        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.handleLossCounters();
            
            // Martingale
            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
        }

        if (!this.endOfDay) {
            this.logTradingSummary();
        }

        // Risk Management Checks
        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('🎉 Take Profit Reached! Stopping.');
            this.endOfDay = true;
            this.disconnect();
            return;
        }

        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log('⛔ Max Consecutive Losses Reached. Stopping.');
            this.endOfDay = true;
            this.disconnect();
            return;
        }

        // Reset for next trade
        this.waitTime = won ? 1000 : 2000; // Wait longer after loss
        setTimeout(() => {
            this.tradeInProgress = false;
            this.Pause = false;
        }, this.waitTime);
    }

    handleLossCounters() {
        if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
        else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
        else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
        else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;
    }

    logTradingSummary() {
        console.log('\n📈 SESSION SUMMARY');
        console.log(`Trades: ${this.totalTrades} | W: ${this.totalWins} / L: ${this.totalLosses}`);
        console.log(`P/L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Next Stake: $${this.currentStake.toFixed(2)}`);
        console.log('──────────────────────────────────────\n');
    }

    startEmailTimer() {
        setInterval(() => {
            if (!this.endOfDay) this.sendEmailSummary();
        }, 1800000);
    }

    disconnect() {
        if (this.connected) {
            this.ws.close();
        }
    }

    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const summaryText = `
        ENHANCED TRADING BOT SUMMARY
        ============================
        
        Performance Metrics:
        -------------------
        Total Trades: ${this.totalTrades}
        Won: ${this.totalWins} | Lost: ${this.totalLosses}
        Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
        
        Loss Analysis:
        -------------
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}
        
        Financial Summary:
        -----------------
        Total P/L: $${this.totalProfitLoss.toFixed(2)}
        Current Stake: $${this.currentStake.toFixed(2)}
        `;
        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Gemini Deriv 2 Deriv Differ Bot - Trading Summary',
            text: summaryText
        };
        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // console.error('Email sending error:', error);
        }
    }

    start() {
        this.connect();
    }
}

// Usage
const bot = new EnhancedDerivTradingBot('rgNedekYXvCaPeP', {
    initialStake: 0.61,
    multiplier: 11.3, // High multiplier needed for Digit Differ recovery
    maxConsecutiveLosses: 3,
    takeProfit: 500,
});

bot.start();
