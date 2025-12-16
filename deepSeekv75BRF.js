const WebSocket = require('ws');
const nodemailer = require('nodemailer');

class DerivVolatility75Bot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        
        // Configuration
        this.config = {
            initialStake: config.initialStake || 1.00,
            multiplier: config.multiplier || 2.2,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 7,
            takeProfit: config.takeProfit || 50,
            stopLoss: config.stopLoss || -35,
            tradeDuration: 1, // 1 minute
            symbol: 'R_75', // Volatility 75 Index
            maxStake: config.maxStake || 127,
            ...config
        };
        
        // State management
        this.state = {
            currentTrend: 'neutral',
            consecutiveLosses: 0,
            currentStake: this.config.initialStake,
            dailyProfit: 0,
            tradesToday: 0,
            totalTrades: 0,
            totalWins: 0,
            totalLosses: 0,
            totalProfitLoss: 0,
            winningStreak: 0,
            losingStreak: 0,
            lastTradeTime: null,
            tradeInProgress: false
        };
        
        // Market data
        this.marketData = {
            priceHistory: [],
            ticks: [],
            emaShort: null,
            emaMedium: null,
            emaLong: null,
            rsi: 50,
            atr: 0.0005,
            lastPrice: null
        };
        
        // WebSocket
        this.wsReady = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectInterval = 5000;
        this.tickSubscriptionId = null;
        
        // Email configuration (optional)
        this.emailEnabled = config.emailEnabled || false;
        if (this.emailEnabled) {
            this.emailConfig = {
                service: 'gmail',
                auth: {
                    user: config.emailUser,
                    pass: config.emailPass
                }
            };
            this.emailRecipient = config.emailRecipient;
        }
        
        console.log('🤖 Deriv Volatility 75 Bot Initialized');
        console.log('========================================');
        console.log(`Symbol: ${this.config.symbol}`);
        console.log(`Initial Stake: $${this.config.initialStake}`);
        console.log(`Daily Target: $${this.config.takeProfit}`);
        console.log(`Daily Stop Loss: $${Math.abs(this.config.stopLoss)}`);
        console.log('========================================\n');
    }

    // ==================== WEB SOCKET METHODS ====================
    
    connect() {
        console.log('🔗 Connecting to Deriv API...');
        this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');
        
        this.ws.on('open', () => {
            console.log('✅ Connected to Deriv API');
            this.connected = true;
            this.wsReady = true;
            this.reconnectAttempts = 0;
            this.authenticate();
        });
        
        this.ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                this.handleMessage(message);
            } catch (error) {
                console.error('Error parsing message:', error);
            }
        });
        
        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error.message);
            this.handleDisconnect();
        });
        
        this.ws.on('close', () => {
            console.log('🔌 Disconnected from Deriv API');
            this.connected = false;
            this.handleDisconnect();
        });
    }
    
    sendRequest(request) {
        if (this.connected && this.wsReady) {
            this.ws.send(JSON.stringify(request));
        } else {
            console.log('⏳ Waiting for connection...');
            setTimeout(() => this.sendRequest(request), 1000);
        }
    }
    
    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`🔄 Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
            setTimeout(() => this.connect(), this.reconnectInterval);
        } else {
            console.error('❌ Max reconnection attempts reached. Please restart bot.');
        }
    }
    
    authenticate() {
        console.log('🔑 Authenticating...');
        this.sendRequest({
            authorize: this.token
        });
    }
    
    // ==================== MARKET DATA METHODS ====================
    
    subscribeToTicks() {
        console.log(`📊 Subscribing to ${this.config.symbol} ticks...`);
        this.sendRequest({
            ticks: this.config.symbol,
            subscribe: 1
        });
    }
    
    getTickHistory(count = 100) {
        console.log(`📈 Getting ${count} ticks history...`);
        this.sendRequest({
            ticks_history: this.config.symbol,
            adjust_start_time: 1,
            count: count,
            end: 'latest',
            start: 1,
            style: 'ticks'
        });
    }
    
    // ==================== TRADING LOGIC ====================
    
    calculateEMA(prices, period) {
        if (prices.length < period) return null;
        
        const k = 2 / (period + 1);
        let ema = prices[0];
        
        for (let i = 1; i < prices.length; i++) {
            ema = prices[i] * k + ema * (1 - k);
        }
        
        return ema;
    }
    
    calculateRSI(prices, period = 14) {
        if (prices.length < period + 1) return 50;
        
        let gains = 0;
        let losses = 0;
        
        for (let i = 1; i <= period; i++) {
            const change = prices[i] - prices[i - 1];
            if (change >= 0) {
                gains += change;
            } else {
                losses -= change;
            }
        }
        
        const avgGain = gains / period;
        const avgLoss = losses / period;
        
        if (avgLoss === 0) return 100;
        
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }
    
    analyzeMarket() {
        if (this.marketData.priceHistory.length < 50) {
            return { trend: 'neutral', confidence: 0 };
        }
        
        const prices = this.marketData.priceHistory.slice(-100);
        const currentPrice = prices[prices.length - 1];
        
        // Calculate indicators
        const ema9 = this.calculateEMA(prices, 9);
        const ema21 = this.calculateEMA(prices, 21);
        const ema50 = this.calculateEMA(prices, 50);
        const rsi = this.calculateRSI(prices, 14);
        
        // Store for reference
        this.marketData.emaShort = ema9;
        this.marketData.emaMedium = ema21;
        this.marketData.emaLong = ema50;
        this.marketData.rsi = rsi;
        
        let trend = 'neutral';
        let confidence = 0;
        let signal = null;
        
        // Trend detection
        if (ema9 && ema21 && ema50) {
            // Bullish conditions
            if (currentPrice > ema9 && ema9 > ema21 && ema21 > ema50) {
                trend = 'bullish';
                confidence = 0.7;
                if (rsi < 70) signal = 'CALL';
            }
            // Bearish conditions
            else if (currentPrice < ema9 && ema9 < ema21 && ema21 < ema50) {
                trend = 'bearish';
                confidence = 0.7;
                if (rsi > 30) signal = 'PUT';
            }
            
            // RSI extremes
            if (rsi < 30 && trend === 'bullish') {
                confidence = 0.8;
                signal = 'CALL';
            } else if (rsi > 70 && trend === 'bearish') {
                confidence = 0.8;
                signal = 'PUT';
            }
        }
        
        this.state.currentTrend = trend;
        
        return {
            trend,
            confidence,
            signal,
            price: currentPrice,
            ema9: ema9 ? ema9.toFixed(5) : 'N/A',
            ema21: ema21 ? ema21.toFixed(5) : 'N/A',
            rsi: rsi.toFixed(2)
        };
    }
    
    shouldTrade(analysis) {
        // Don't trade if already in a trade
        if (this.state.tradeInProgress) return false;
        
        // Check time since last trade (minimum 5 seconds)
        if (this.state.lastTradeTime) {
            const timeSinceLastTrade = Date.now() - this.state.lastTradeTime;
            if (timeSinceLastTrade < 5000) return false;
        }
        
        // Check risk management
        const riskCheck = this.checkRiskLimits();
        if (riskCheck.shouldStop) return false;
        
        // Check confidence level
        if (analysis.confidence < 0.7) return false;
        
        // Check if we have a signal
        if (!analysis.signal) return false;
        
        // Check if market data is sufficient
        if (this.marketData.priceHistory.length < 50) return false;
        
        return true;
    }
    
    checkRiskLimits() {
        // Daily stop loss
        if (this.state.dailyProfit <= this.config.stopLoss) {
            console.log('🔴 DAILY STOP LOSS REACHED');
            this.sendEmailAlert('DAILY STOP LOSS HIT', `Profit: $${this.state.dailyProfit.toFixed(2)}`);
            return { shouldStop: true };
        }
        
        // Daily take profit
        if (this.state.dailyProfit >= this.config.takeProfit) {
            console.log('🟢 DAILY TAKE PROFIT REACHED');
            this.sendEmailAlert('DAILY TAKE PROFIT HIT', `Profit: $${this.state.dailyProfit.toFixed(2)}`);
            return { shouldStop: true };
        }
        
        // Max consecutive losses
        if (this.state.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log('⚠️ MAX CONSECUTIVE LOSSES REACHED');
            return { shouldStop: true, reason: 'maxLosses' };
        }
        
        // Max stake protection
        if (this.state.currentStake > this.config.maxStake) {
            console.log('⚠️ MAX STAKE EXCEEDED, resetting to initial');
            this.state.currentStake = this.config.initialStake;
        }
        
        return { shouldStop: false };
    }
    
    calculateNextStake(previousResult) {
        if (previousResult === 'WIN') {
            // After win, reset to initial stake
            this.state.currentStake = this.config.initialStake;
            this.state.consecutiveLosses = 0;
            this.state.winningStreak++;
            this.state.losingStreak = 0;
            
            // After 2 wins in a row, take a small break
            if (this.state.winningStreak >= 2) {
                console.log('🎯 Winning streak - maintaining base stake');
            }
        } 
        else if (previousResult === 'LOSS') {
            this.state.consecutiveLosses++;
            this.state.losingStreak++;
            this.state.winningStreak = 0;
            
            // Apply martingale with limits
            if (this.state.consecutiveLosses <= 3) {
                this.state.currentStake = this.state.currentStake * this.config.multiplier;
            } else if (this.state.consecutiveLosses <= 5) {
                this.state.currentStake = this.state.currentStake * 2.5;
            } else {
                this.state.currentStake = this.state.currentStake * 1.8;
            }
            
            // Round to 2 decimal places
            this.state.currentStake = Math.round(this.state.currentStake * 100) / 100;
            
            // Safety: Don't exceed max stake
            if (this.state.currentStake > this.config.maxStake) {
                console.log('⚠️ Max stake reached, cooling down...');
                this.state.currentStake = this.config.initialStake;
                this.state.consecutiveLosses = 0;
            }
        }
        
        return this.state.currentStake;
    }
    
    placeTrade(signal, stake) {
        if (this.state.tradeInProgress) return;
        
        this.state.tradeInProgress = true;
        this.state.lastTradeTime = Date.now();
        
        console.log(`\n🎯 PLACING TRADE`);
        console.log('═══════════════════════════════════════');
        console.log(`Signal: ${signal}`);
        console.log(`Stake: $${stake.toFixed(2)}`);
        console.log(`Duration: ${this.config.tradeDuration} minute`);
        console.log(`Consecutive Losses: ${this.state.consecutiveLosses}`);
        console.log('═══════════════════════════════════════\n');
        
        const request = {
            buy: 1,
            price: stake.toFixed(2),
            parameters: {
                amount: stake.toFixed(2),
                basis: 'stake',
                contract_type: signal,
                currency: 'USD',
                duration: this.config.tradeDuration,
                duration_unit: 'm',
                symbol: this.config.symbol
            }
        };
        
        this.sendRequest(request);
    }
    
    // ==================== TRADE RESULT HANDLING ====================
    
    handleTradeResult(contract) {
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit) || 0;
        const sellPrice = parseFloat(contract.sell_price) || 0;
        
        // Update state
        this.state.tradeInProgress = false;
        this.state.totalTrades++;
        this.state.dailyProfit += profit;
        this.state.totalProfitLoss += profit;
        
        if (won) {
            this.state.totalWins++;
            this.calculateNextStake('WIN');
            console.log('✅ TRADE WON!');
        } else {
            this.state.totalLosses++;
            this.calculateNextStake('LOSS');
            console.log('❌ TRADE LOST');
        }
        
        console.log(`Profit/Loss: $${profit.toFixed(2)}`);
        console.log(`Daily P/L: $${this.state.dailyProfit.toFixed(2)}`);
        console.log(`Current Stake: $${this.state.currentStake.toFixed(2)}`);
        
        // Log summary
        this.logTradingSummary();
        
        // Check if we should stop trading
        const riskCheck = this.checkRiskLimits();
        if (riskCheck.shouldStop) {
            console.log('\n⚠️ STOPPING TRADING DUE TO RISK LIMIT');
            this.disconnect();
        }
        
        // Send email alert for significant events
        if (Math.abs(profit) >= 10 || this.state.consecutiveLosses >= 3) {
            this.sendTradeAlert(won, profit, this.state.consecutiveLosses);
        }
    }
    
    // ==================== MESSAGE HANDLER ====================
    
    handleMessage(message) {
        if (message.msg_type === 'authorize') {
            if (message.error) {
                console.error('❌ Authentication failed:', message.error.message);
                this.disconnect();
                return;
            }
            console.log('✅ Authenticated successfully');
            console.log(`Balance: $${message.authorize.balance}`);
            
            // Get history and subscribe to ticks
            this.getTickHistory(200);
            setTimeout(() => this.subscribeToTicks(), 2000);
            
        } else if (message.msg_type === 'history') {
            if (message.history && message.history.prices) {
                this.marketData.priceHistory = message.history.prices.map(p => parseFloat(p));
                console.log(`📊 Loaded ${this.marketData.priceHistory.length} historical prices`);
            }
            
        } else if (message.msg_type === 'tick') {
            this.handleTickUpdate(message.tick);
            
        } else if (message.msg_type === 'buy') {
            if (message.error) {
                console.error('❌ Trade error:', message.error.message);
                this.state.tradeInProgress = false;
                return;
            }
            console.log('📝 Trade placed, contract ID:', message.buy.contract_id);
            // Subscribe to contract updates
            this.sendRequest({
                proposal_open_contract: 1,
                contract_id: message.buy.contract_id,
                subscribe: 1
            });
            
        } else if (message.msg_type === 'proposal_open_contract') {
            const contract = message.proposal_open_contract;
            if (contract.is_sold) {
                this.handleTradeResult(contract);
            }
            
        } else if (message.error) {
            console.error('API Error:', message.error.message);
        }
    }
    
    handleTickUpdate(tick) {
        const price = parseFloat(tick.quote);
        
        // Update market data
        this.marketData.priceHistory.push(price);
        this.marketData.lastPrice = price;
        
        // Keep history size manageable
        if (this.marketData.priceHistory.length > 200) {
            this.marketData.priceHistory.shift();
        }
        
        // Analyze market every few ticks (not every tick)
        if (this.marketData.priceHistory.length % 1 === 0) {
            const analysis = this.analyzeMarket();
            console.log(`\n🔍 Market Analysis | Trend: ${analysis.trend} | RSI: ${analysis.rsi} | Confidence: ${(analysis.confidence * 100).toFixed(2)}%`);
            
            // Log market status periodically
            if (this.marketData.priceHistory.length % 30 === 0) {
                console.log(`📈 Market: $${price.toFixed(5)} | Trend: ${analysis.trend} | RSI: ${analysis.rsi}`);
            }
            
            // Check if we should trade
            if (this.shouldTrade(analysis)) {
                this.placeTrade(analysis.signal, this.state.currentStake);
            }
        }
    }
    
    // ==================== UTILITY METHODS ====================
    
    logTradingSummary() {
        const winRate = this.state.totalTrades > 0 
            ? (this.state.totalWins / this.state.totalTrades * 100).toFixed(2) 
            : '0.00';
        
        console.log('\n📊 TRADING SUMMARY');
        console.log('═══════════════════════════════════════');
        console.log(`Total Trades: ${this.state.totalTrades}`);
        console.log(`Wins: ${this.state.totalWins} | Losses: ${this.state.totalLosses}`);
        console.log(`Win Rate: ${winRate}%`);
        console.log(`Consecutive Losses: ${this.state.consecutiveLosses}`);
        console.log(`Daily P/L: $${this.state.dailyProfit.toFixed(2)}`);
        console.log(`Total P/L: $${this.state.totalProfitLoss.toFixed(2)}`);
        console.log(`Current Stake: $${this.state.currentStake.toFixed(2)}`);
        console.log('═══════════════════════════════════════\n');
    }
    
    sendEmailAlert(subject, message) {
        if (!this.emailEnabled) return;
        
        const transporter = nodemailer.createTransport(this.emailConfig);
        
        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: `🤖 Deriv Bot: ${subject}`,
            text: `${message}\n\nTime: ${new Date().toLocaleString()}`
        };
        
        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error('Email error:', error);
            } else {
                console.log('✅ Email alert sent');
            }
        });
    }
    
    sendTradeAlert(won, profit, consecutiveLosses) {
        if (!this.emailEnabled) return;
        
        const subject = won ? '✅ TRADE WON' : '❌ TRADE LOST';
        const message = won 
            ? `Profit: $${profit.toFixed(2)}\nTotal Daily: $${this.state.dailyProfit.toFixed(2)}`
            : `Loss: $${Math.abs(profit).toFixed(2)}\nConsecutive Losses: ${consecutiveLosses}`;
        
        this.sendEmailAlert(subject, message);
    }
    
    disconnect() {
        if (this.ws && this.connected) {
            console.log('🛑 Disconnecting...');
            this.ws.close();
        }
    }
    
    start() {
        console.log('🚀 Starting Deriv Volatility 75 Bot...');
        this.connect();
    }
}

// ==================== CONFIGURATION ====================

// REPLACE WITH YOUR DERIV API TOKEN
// Get from: https://app.deriv.com/account/api-token
const DERIV_API_TOKEN = 'rgNedekYXvCaPeP'; // e.g., 'rgNedekYXvCaPeP'

// Bot Configuration
const config = {
    initialStake: 0.50,      // Start with $1
    multiplier: 2.2,         // Martingale multiplier
    maxConsecutiveLosses: 7, // Stop after 7 losses
    takeProfit: 5,          // Stop at $50 profit
    stopLoss: -35,           // Stop at -$35 loss
    maxStake: 127,           // Maximum stake amount
    
    // Email notifications (optional)
    emailEnabled: true,
    emailUser: 'kenzkdp2@gmail.com',
    emailPass: 'jfjhtmussgfpbgpk', // Use App Password for Gmail
    emailRecipient: 'kenotaru@gmail.com'
};

// ==================== START THE BOT ====================

// Validate API token
if (!DERIV_API_TOKEN || DERIV_API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.error('❌ ERROR: Please add your Deriv API token to the script!');
    console.log('Get your token from: https://app.deriv.com/account/api-token');
    process.exit(1);
}

console.log('🤖 Deriv Volatility 75 Trading Bot');
console.log('========================================');
console.log('⚠️  WARNING: Trading involves risk!');
console.log('⚠️  Only trade with money you can afford to lose!');
console.log('⚠️  This bot is for educational purposes!');
console.log('========================================\n');

// Start the bot
const bot = new DerivVolatility75Bot(DERIV_API_TOKEN, config);
bot.start();

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n🛑 Shutting down bot gracefully...');
    bot.logTradingSummary();
    bot.disconnect();
    setTimeout(() => process.exit(0), 1000);
});
