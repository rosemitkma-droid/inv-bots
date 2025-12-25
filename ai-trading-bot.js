/**
 * ============================================================
 * AI-POWERED DERIV DIGIT DIFFER TRADING BOT v3.0
 * Multi-Model Ensemble Prediction System (Fixed & Improved)
 * ============================================================
 * 
 * Supported AI Models (all free tiers):
 * - Google Gemini (60 req/min)
 * - Groq (30 req/min, fastest inference)
 * - OpenRouter (multiple free models)
 * - Mistral AI (free tier)
 * - Cerebras (fast inference, free)
 * - SambaNova (free tier)
 * 
 * ============================================================
 */

require('dotenv').config();
const WebSocket = require('ws');
const axios = require('axios');

// Optional: Email notifications
let nodemailer;
try {
    nodemailer = require('nodemailer');
} catch (e) {
    console.log('📧 Nodemailer not installed. Email notifications disabled.');
}

class AIDigitDifferBot {
    constructor(config = {}) {
        // Deriv Configuration
        this.token = config.derivToken || process.env.DERIV_TOKENs;

        // AI Model API Keys - Fixed parsing
        this.aiModels = {
            gemini: {
                keys: this.parseGeminiKeys(process.env.GEMINI_API_nKEYS),
                currentIndex: 0,
                enabled: false,
                name: 'Gemini',
                weight: 1.2
            },
            groq: {
                key: (process.env.GROQ_API_KEY || '').trim(),
                enabled: false,
                name: 'Groq',
                weight: 1.1
            },
            openrouter: {
                key: (process.env.OPENROUTER_API_KEY || '').trim(),
                enabled: false,
                name: 'OpenRouter',
                weight: 1.0
            },
            mistral: {
                key: (process.env.MISTRAL_API_KEY || '').trim(),
                enabled: false,
                name: 'Mistral',
                weight: 1.0
            },
            cerebras: {
                key: (process.env.CEREBRAS_API_KEY || '').trim(),
                enabled: false,
                name: 'Cerebras',
                weight: 1.1
            },
            sambanova: {
                key: (process.env.SAMBANOVA_API_KEY || '').trim(),
                enabled: false,
                name: 'SambaNova',
                weight: 1.0
            },
            qwen: {
                key: (process.env.DASHSCOPE_API_KEY || '').trim(),
                enabled: false,
                name: 'Qwen',
                weight: 1.1
            },
            kimi: {
                key: (process.env.MOONSHOT_API_KEY || '').trim(),
                enabled: false,
                name: 'Kimi',
                weight: 1.1
            },
            siliconflow: {
                key: (process.env.SILICONFLOW_API_KEY || '').trim(),
                enabled: false,
                name: 'SiliconFlow',
                weight: 1.2
            }
        };

        // Enable models with valid keys
        this.initializeAIModels();

        // WebSocket
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        // Assets
        this.assets = config.assets || [
            'R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR'
        ];

        // Trading Configuration
        this.config = {
            initialStake: config.initialStake || 5,
            multiplier: config.multiplier || 11.3,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 3,
            stopLoss: config.stopLoss || 67,
            takeProfit: config.takeProfit || 100,
            requiredHistoryLength: config.requiredHistoryLength || 500,
            minConfidence: config.minConfidence || 60,
            minModelsAgreement: config.minModelsAgreement || 2,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            tradeCooldown: config.tradeCooldown || 3000,
            minWaitTime: config.minWaitTime || 10000,
            maxWaitTime: config.maxWaitTime || 60000,
        };

        // Trading State
        this.currentStake = this.config.initialStake;
        this.currentAsset = null;
        this.usedAssets = new Set();
        this.consecutiveLosses = 0;
        this.currentTradeId = null;
        this.tickSubscriptionId = null;

        // Statistics
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalPnL = 0;
        this.balance = 0;
        this.sessionStartBalance = 0;

        // Tick Data
        this.tickHistory = [];
        this.digitCounts = Array(10).fill(0);

        // Prediction Tracking
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.lastPrediction = null;
        this.lastConfidence = 0;
        this.previousPredictions = [];
        this.predictionOutcomes = [];
        this.winningPatterns = new Map();
        this.tradeMethod = [];
        this.currentPrediction = null;

        // Model Performance Tracking
        this.modelPerformance = {};
        for (const key in this.aiModels) {
            this.modelPerformance[key] = { wins: 0, losses: 0, predictions: [] };
        }

        // Connection State
        this.reconnectAttempts = 0;
        this.isPaused = false;
        this.isShuttingDown = false;
        this.isReconnecting = false;

        // Email Configuration
        this.emailConfig = {
            enabled: !!(process.env.EMAIL_USER && process.env.EMAIL_PASS),
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            },
            recipient: process.env.EMAIL_RECIPIENT
        };

        // Session tracking
        this.sessionStartTime = new Date();

        console.log('\n' + '='.repeat(60));
        console.log('🤖 AI DIGIT DIFFER TRADING BOT v3.0');
        console.log('='.repeat(60));
        this.logActiveModels();

        // Start email timer
        if (this.emailConfig.enabled) {
            this.startEmailTimer();
        }
    }

    // ==================== INITIALIZATION ====================

    // Fixed: Properly parse Gemini keys
    parseGeminiKeys(keysString) {
        if (!keysString || typeof keysString !== 'string') return [];

        // Remove quotes, newlines, and extra whitespace
        const cleaned = keysString.replace(/["'\r\n]/g, ' ').trim();
        if (!cleaned) return [];

        // Check if it contains commas (multiple keys)
        if (cleaned.includes(',')) {
            return cleaned.split(',')
                .map(k => k.trim())
                .filter(k => k.length > 20); // API keys are typically long
        }

        // Single key or space-separated
        const parts = cleaned.split(/\s+/).filter(k => k.length > 20);
        return parts;
    }

    initializeAIModels() {
        // Check and enable Gemini
        if (this.aiModels.gemini.keys.length > 0) {
            this.aiModels.gemini.enabled = true;
        }

        // Check and enable other models
        for (const key of ['groq', 'openrouter', 'mistral', 'cerebras', 'sambanova', 'qwen', 'kimi', 'siliconflow']) {
            const apiKey = this.aiModels[key].key;
            if (apiKey && apiKey.length > 10) {
                this.aiModels[key].enabled = true;
            }
        }
    }

    logActiveModels() {
        console.log('\n📊 Active AI Models:');
        let activeCount = 0;

        for (const [key, model] of Object.entries(this.aiModels)) {
            const status = model.enabled ? '✅' : '❌';
            let extra = '';

            if (key === 'gemini' && model.enabled) {
                extra = `(${model.keys.length} key${model.keys.length > 1 ? 's' : ''})`;
            }

            console.log(`   ${status} ${model.name} ${extra}`);
            if (model.enabled) activeCount++;
        }

        console.log(`\n   Total Active: ${activeCount} models`);

        if (activeCount === 0) {
            console.log('\n⚠️  WARNING: No AI models configured!');
            console.log('   The bot will use statistical analysis only.');
            console.log('   Add API keys to .env file for better predictions.\n');
        }
        console.log('='.repeat(60) + '\n');
    }

    // ==================== WEBSOCKET CONNECTION (FIXED) ====================

    connect() {
        if (this.isShuttingDown) {
            console.log('Bot is shutting down, not reconnecting.');
            return;
        }

        if (this.connected) {
            console.log('Already connected.');
            return;
        }

        console.log('🔌 Connecting to Deriv API...');

        try {
            this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

            this.ws.on('open', () => {
                console.log('✅ Connected to Deriv API');
                this.connected = true;
                this.wsReady = true;
                this.reconnectAttempts = 0;
                this.isReconnecting = false;
                this.authenticate();
            });

            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handleMessage(message);
                } catch (error) {
                    console.error('Error parsing message:', error.message);
                }
            });

            this.ws.on('error', (error) => {
                console.error('❌ WebSocket error:', error.message);
            });

            this.ws.on('close', (code, reason) => {
                console.log(`🔌 Disconnected from Deriv API (code: ${code})`);
                this.connected = false;
                this.wsReady = false;
                this.ws = null;

                if (!this.isPaused && !this.isShuttingDown) {
                    this.handleDisconnect();
                }
            });

        } catch (error) {
            console.error('Error creating WebSocket:', error.message);
            this.handleDisconnect();
        }
    }

    sendRequest(request) {
        if (this.connected && this.wsReady && this.ws) {
            try {
                this.ws.send(JSON.stringify(request));
                return true;
            } catch (error) {
                console.error('Error sending request:', error.message);
                return false;
            }
        } else {
            console.log('⏳ WebSocket not ready.');
            return false;
        }
    }

    // Fixed: Improved reconnection logic
    handleDisconnect() {
        if (this.isReconnecting || this.isShuttingDown) {
            return;
        }

        this.connected = false;
        this.wsReady = false;
        this.isReconnecting = true;

        // Clean up old WebSocket
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.terminate();
            } catch (e) {
                // Ignore cleanup errors
            }
            this.ws = null;
        }

        this.reconnectAttempts++;

        const delay = Math.min(this.config.reconnectInterval * (this.reconnectAttempts + 1), 30000);
        console.log(`🔄 Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts + 1})...`);

        setTimeout(() => {
            this.isReconnecting = false;
            this.connect();
        }, delay);
    }

    authenticate() {
        console.log('🔐 Authenticating...');
        this.sendRequest({ authorize: this.token });
    }

    // Fixed: Proper disconnect method
    disconnect() {
        console.log('Disconnecting...');
        this.connected = false;
        this.wsReady = false;

        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.close();
            } catch (e) {
                // Ignore
            }
            this.ws = null;
        }
    }

    shutdown() {
        console.log('\n🛑 Bot task completed. Entering SUSPEND mode...');
        this.isShuttingDown = true;
        this.isPaused = true;
        this.logFinalSummary();
        this.disconnect();

        console.log('💤 Bot is now sleeping to prevent auto-restart on VPS.');
        console.log('👉 Press Ctrl+C or use your process manager to stop it manually.');

        // Keep process alive indefinitely to prevent PM2/VPS restart
        setInterval(() => { }, 1000 * 60 * 60);
    }

    // ==================== MESSAGE HANDLING ====================

    handleMessage(message) {
        switch (message.msg_type) {
            case 'authorize':
                this.handleAuthorize(message);
                break;
            case 'balance':
                this.handleBalance(message);
                break;
            case 'history':
                this.handleTickHistory(message.history);
                break;
            case 'tick':
                this.handleTickUpdate(message.tick);
                break;
            case 'buy':
                this.handleBuyResponse(message);
                break;
            case 'proposal_open_contract':
                if (message.proposal_open_contract?.is_sold) {
                    this.handleTradeResult(message.proposal_open_contract);
                }
                break;
            case 'forget':
                this.tickSubscriptionId = null;
                break;
            default:
                if (message.error) {
                    this.handleError(message.error);
                }
        }
    }

    handleAuthorize(message) {
        if (message.error) {
            console.error('❌ Authentication failed:', message.error.message);
            console.log('🔄 Retrying in 5 seconds...');
            this.scheduleReconnect(5000);
            return;
        }

        console.log('✅ Authentication successful');
        console.log(`👤 Account: ${message.authorize.loginid}`);
        this.balance = message.authorize.balance;
        this.sessionStartBalance = this.balance;
        console.log(`💰 Balance: $${this.balance.toFixed(2)}`);

        // Subscribe to balance updates
        this.sendRequest({ balance: 1, subscribe: 1 });

        // Reset trading state
        this.resetTradingState();

        // Start trading
        this.startTrading();
    }

    resetTradingState() {
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.tickHistory = [];
        this.digitCounts = Array(10).fill(0);
        this.tickSubscriptionId = null;
    }

    handleBalance(message) {
        if (message.balance) {
            this.balance = message.balance.balance;
        }
    }

    handleBuyResponse(message) {
        if (message.error) {
            console.error('❌ Trade error:', message.error.message);
            this.tradeInProgress = false;
            this.predictionInProgress = false;

            // Schedule next trade attempt after error
            this.scheduleNextTrade();
            return;
        }

        console.log('✅ Trade placed successfully');
        this.currentTradeId = message.buy.contract_id;
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: this.currentTradeId,
            subscribe: 1
        });
    }

    handleError(error) {
        console.error('❌ API Error:', error.message, `(Code: ${error.code})`);

        switch (error.code) {
            case 'InvalidToken':
                console.error('Invalid token. Please check your API token.');
                this.shutdown();
                break;
            case 'RateLimit':
                console.log('Rate limited. Waiting 60 seconds...');
                this.scheduleReconnect(60000);
                break;
            case 'MarketIsClosed':
                console.log('Market closed. Waiting 5 minutes...');
                this.scheduleReconnect(300000);
                break;
            default:
                // For other errors, try to continue
                if (!this.tradeInProgress) {
                    this.scheduleNextTrade();
                }
        }
    }

    // ==================== TRADING LOGIC ====================

    startTrading() {
        console.log('\n📈 Starting trading session...');
        this.selectNextAsset();
    }

    selectNextAsset() {
        // Reset used assets if all have been used
        if (this.usedAssets.size >= this.assets.length) {
            this.usedAssets.clear();
        }

        // Select random unused asset
        const availableAssets = this.assets.filter(a => !this.usedAssets.has(a));
        this.currentAsset = availableAssets[Math.floor(Math.random() * availableAssets.length)];
        this.usedAssets.add(this.currentAsset);

        console.log(`\n🎯 Selected asset: ${this.currentAsset}`);

        // Reset tick data
        this.tickHistory = [];
        this.digitCounts = Array(10).fill(0);

        // Unsubscribe from previous ticks then subscribe to new
        if (this.tickSubscriptionId) {
            this.sendRequest({ forget: this.tickSubscriptionId });
        }

        setTimeout(() => {
            // Request tick history
            this.sendRequest({
                ticks_history: this.currentAsset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });

            // Subscribe to live ticks
            this.sendRequest({
                ticks: this.currentAsset,
                subscribe: 1
            });
        }, 500);
    }

    getLastDigit(quote) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(this.currentAsset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25'].includes(this.currentAsset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

    handleTickHistory(history) {
        if (!history || !history.prices) {
            console.log('⚠️ Invalid tick history received');
            return;
        }
        this.tickHistory = history.prices.map(price => this.getLastDigit(price));
        console.log(`📊 Received ${this.tickHistory.length} ticks of history`);
    }

    handleTickUpdate(tick) {
        if (!tick || !tick.quote) return;

        const lastDigit = this.getLastDigit(tick.quote);

        // Add to history
        this.tickHistory.push(lastDigit);
        if (this.tickHistory.length > this.config.requiredHistoryLength) {
            this.tickHistory.shift();
        }

        this.digitCounts[lastDigit]++;

        console.log(`📍 Tick: ${tick.quote} | Digit: ${lastDigit} | History: ${this.tickHistory.length}`);

        // Check if ready to analyze
        if (this.tickHistory.length >= this.config.requiredHistoryLength &&
            !this.tradeInProgress && !this.predictionInProgress) {
            this.analyzeTicks();
        }
    }

    // ==================== AI PREDICTION ENGINE ====================

    async analyzeTicks() {
        if (this.tradeInProgress || this.predictionInProgress) return;

        this.predictionInProgress = true;
        console.log('\n🧠 Starting AI ensemble prediction...');

        const startTime = Date.now();

        try {
            // Get predictions from all enabled models
            const predictions = await this.getEnsemblePredictions();
            const processingTime = (Date.now() - startTime) / 1000;

            console.log(`⏱️  AI processing time: ${processingTime.toFixed(2)}s`);

            if (predictions.length === 0) {
                console.log('⚠️  No valid predictions received');
                this.predictionInProgress = false;
                this.scheduleNextTrade();
                return;
            }

            // Calculate ensemble result
            const ensemble = this.calculateEnsembleResult(predictions);

            console.log('\n📊 Ensemble Result:');
            console.log(`   Predicted Digit: ${ensemble.digit}`);
            console.log(`   Confidence: ${ensemble.confidence}%`);
            console.log(`   Models Agree: ${ensemble.agreement}/${predictions.length}`);
            console.log(`   Risk Level: ${ensemble.risk}`);
            console.log(`   Primary Strategy: ${ensemble.strategy || 'Mixed'}`);

            this.lastPrediction = ensemble.digit;
            this.lastConfidence = ensemble.confidence;

            // Check if we should trade
            if (ensemble.confidence >= this.config.minConfidence &&
                ensemble.agreement >= Math.min(this.config.minModelsAgreement, predictions.length) &&
                ensemble.risk !== 'high' &&
                processingTime.toFixed(2) < 10
            ) {
                this.placeTrade(ensemble.digit, ensemble.confidence);
            } else {
                console.log(`⏭️  Skipping trade: conf=${ensemble.confidence}%, agree=${ensemble.agreement}, risk=${ensemble.risk}`);
                this.predictionInProgress = false;
                this.scheduleNextTrade();
            }

        } catch (error) {
            console.error('❌ Prediction error:', error.message);
            this.predictionInProgress = false;
            this.scheduleNextTrade();
        }
    }

    async getEnsemblePredictions() {
        const predictions = [];
        const promises = [];

        // Launch all AI predictions in parallel
        if (this.aiModels.gemini.enabled) {
            promises.push(
                this.predictWithGemini()
                    .then(r => { r.model = 'gemini'; return r; })
                    .catch(e => ({ error: e.message, model: 'gemini' }))
            );
        }
        if (this.aiModels.groq.enabled) {
            promises.push(
                this.predictWithGroq()
                    .then(r => { r.model = 'groq'; return r; })
                    .catch(e => ({ error: e.message, model: 'groq' }))
            );
        }
        if (this.aiModels.openrouter.enabled) {
            promises.push(
                this.predictWithOpenRouter()
                    .then(r => { r.model = 'openrouter'; return r; })
                    .catch(e => ({ error: e.message, model: 'openrouter' }))
            );
        }
        if (this.aiModels.mistral.enabled) {
            promises.push(
                this.predictWithMistral()
                    .then(r => { r.model = 'mistral'; return r; })
                    .catch(e => ({ error: e.message, model: 'mistral' }))
            );
        }
        if (this.aiModels.cerebras.enabled) {
            promises.push(
                this.predictWithCerebras()
                    .then(r => { r.model = 'cerebras'; return r; })
                    .catch(e => ({ error: e.message, model: 'cerebras' }))
            );
        }
        if (this.aiModels.sambanova.enabled) {
            promises.push(
                this.predictWithSambaNova()
                    .then(r => { r.model = 'sambanova'; return r; })
                    .catch(e => ({ error: e.message, model: 'sambanova' }))
            );
        }
        if (this.aiModels.qwen.enabled) {
            promises.push(
                this.predictWithQwen()
                    .then(r => { r.model = 'qwen'; return r; })
                    .catch(e => ({ error: e.message, model: 'qwen' }))
            );
        }
        if (this.aiModels.kimi.enabled) {
            promises.push(
                this.predictWithKimi()
                    .then(r => { r.model = 'kimi'; return r; })
                    .catch(e => ({ error: e.message, model: 'kimi' }))
            );
        }
        if (this.aiModels.siliconflow.enabled) {
            promises.push(
                this.predictWithSiliconFlow()
                    .then(r => { r.model = 'siliconflow'; return r; })
                    .catch(e => ({ error: e.message, model: 'siliconflow' }))
            );
        }

        // Wait for all predictions with timeout
        const results = await Promise.race([
            Promise.all(promises),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 45000))
        ]).catch(e => {
            console.log(`⚠️ Prediction timeout or error: ${e.message}`);
            return [];
        });

        // Process results
        for (const result of results) {
            if (result && !result.error && typeof result.predictedDigit === 'number') {
                predictions.push(result);
                console.log(`   ✅ ${result.model}: digit=${result.predictedDigit}, conf=${result.confidence}%`);
            } else if (result && result.error) {
                console.log(`   ❌ ${result.model}: ${result.error}`);
            }
        }

        // Always add statistical prediction as baseline
        const statPrediction = this.statisticalPrediction();
        predictions.push(statPrediction);
        console.log(`   📈 Statistical: digit=${statPrediction.predictedDigit}, conf = ${statPrediction.confidence}% `);

        return predictions;
    }

    calculateEnsembleResult(predictions) {
        // Weighted voting
        const votes = Array(10).fill(0);
        const confidences = Array(10).fill().map(() => []);
        let totalRisk = 0;
        let regime = null;
        let strategy = null;

        for (const pred of predictions) {
            const digit = pred.predictedDigit;
            const weight = this.aiModels[pred.model]?.weight || 1.0;

            // Apply performance-based weight adjustment
            const perf = this.modelPerformance[pred.model];
            let performanceMultiplier = 1.0;
            if (perf && (perf.wins + perf.losses) >= 5) {
                const winRate = perf.wins / (perf.wins + perf.losses);
                performanceMultiplier = 0.5 + winRate;
            }

            votes[digit] += weight * performanceMultiplier;
            confidences[digit].push(pred.confidence);

            if (pred.riskAssessment) {
                totalRisk += pred.riskAssessment === 'high' ? 3 : pred.riskAssessment === 'medium' ? 2 : 1;
            }
            if (pred.marketRegime && !regime) regime = pred.marketRegime;
            if (pred.primaryStrategy && !strategy) strategy = pred.primaryStrategy;
        }

        // Find digit with highest weighted votes
        let maxVotes = 0;
        let winningDigit = 0;
        for (let i = 0; i < 10; i++) {
            if (votes[i] > maxVotes) {
                maxVotes = votes[i];
                winningDigit = i;
            }
        }

        // Count raw agreement
        const rawVotes = Array(10).fill(0);
        predictions.forEach(p => rawVotes[p.predictedDigit]++);
        const agreement = rawVotes[winningDigit];

        // Calculate average confidence
        const avgConfidence = confidences[winningDigit].length > 0
            ? Math.round(confidences[winningDigit].reduce((a, b) => a + b, 0) / confidences[winningDigit].length)
            : 50;

        // Determine overall risk
        const avgRisk = totalRisk / predictions.length;
        const risk = avgRisk >= 2.5 ? 'high' : avgRisk >= 1.5 ? 'medium' : 'low';

        return {
            digit: winningDigit,
            confidence: avgConfidence,
            agreement,
            risk,
            regime,
            strategy
        };
    }

    getPrompt() {
        const recentDigits = this.tickHistory.slice(-300);
        const last50 = this.tickHistory.slice(-50);
        const last20 = this.tickHistory.slice(-20);

        // Calculate frequency distribution
        const counts = Array(10).fill(0);
        last50.forEach(d => counts[d]++);

        // Find gaps (digits not appearing recently)
        const last15Set = new Set(this.tickHistory.slice(-15));
        const gaps = [];
        for (let i = 0; i < 10; i++) {
            if (!last15Set.has(i)) gaps.push(i);
        }

        // Previous outcomes
        const previousOutcomes = this.previousPredictions.slice(-10).map((pred, i) =>
            `${pred}:${this.predictionOutcomes[i] ? 'W' : 'L'} `
        ).join(',');

        // Recent methods used
        const recentMethods = this.tradeMethod.slice(-5).join(', ');

        return `You are an expert trading AI engaged in Deriv Digit Differ (digit that will not appear next) prediction, you are trading against an adversary (the Deriv system).
            ADVERSARIAL CONTEXT:
            - You are trading against an intelligent system that learns from your prediction patterns
            - The opposing system actively tries to break your models and cause losses
            - It adapts its digit generation to exploit your previous successful strategies
            - You must continuously evolve your analysis and prediction methods

            CURRENT MARKET DATA:
            - Asset: ${this.currentAsset}
            - Last 300 digits: [${recentDigits.join(',')}] 
            - Digit frequency (last 50): ${counts.map((c, i) => `${i}:${c}`).join(',')}
            - Digits not in last 15 ticks: [${gaps.join(',')}]
            - Recent predictions: ${previousOutcomes || 'None'}
            - Recent methods: ${recentMethods || 'None'}
            - Consecutive losses: ${this.consecutiveLosses}

            ANALYSIS FRAMEWORK – Use only proven methods for predicting the Digit that will NOT appear (Digit Differ):
        
            STRATEGY SELECTION & ADAPTATION:
            - Select the best method based on recent performance, market regime, and risk level
            - Avoid methods that have recently led to losses
            - Adapt strategy dynamically based on current market conditions and historical effectiveness
        
            MARKET REGIME ASSESSMENT:
            - Determine if the market is trending, ranging, or volatile using volatility and momentum indicators
            - Adjust method selection based on the identified market regime

            CRITICAL CONSIDERATIONS:
            - There is a 1-3 tick delay from your analysis to trade execution
            - Your prediction should account for this delay
            - Predict the Digit that will NOT appear (Digit Differ), not the most likely
            - Base predictions on quantitative analysis only

            DECISION RULES:
            - If consecutive losses ≥ 1, switch to conservative statistical methods
            - Consider recent performance: adapt method selection based on what's working

            OUTPUT FORMAT (JSON only):
            {
                "predictedDigit": X,
                "confidence": XX,
                "primaryStrategy": "Method-Name",
                "marketRegime": "trending/ranging/volatile",
                "riskAssessment": "low/medium/high"
            }
        `;
    }

    parseAIResponse(text, modelName = 'unknown') {
        if (!text) throw new Error('Empty response');

        try {
            // Try to find JSON in the response - more robust greedy matching
            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');

            if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
                // Log the first 100 chars of failed response to help debug
                console.log(`   ⚠️ ${modelName} raw response (first 100 chars): ${text.substring(0, 100).replace(/\n/g, ' ')}...`);
                throw new Error('No JSON found in response');
            }

            const jsonStr = text.substring(firstBrace, lastBrace + 1);
            const prediction = JSON.parse(jsonStr);

            // Validate
            if (typeof prediction.predictedDigit !== 'number' ||
                prediction.predictedDigit < 0 ||
                prediction.predictedDigit > 9) {
                throw new Error(`Invalid predictedDigit: ${prediction.predictedDigit}`);
            }

            if (typeof prediction.confidence !== 'number') {
                prediction.confidence = 60;
            }

            return prediction;
        } catch (e) {
            if (e.message.includes('JSON')) {
                console.log(`   ⚠️ ${modelName} JSON Parse Error: ${e.message}`);
                console.log(`   ⚠️ ${modelName} offending text: ${text.substring(0, 150)}...`);
            }
            throw e;
        }
    }

    // ==================== AI MODEL INTEGRATIONS (FIXED) ====================

    async predictWithGemini() {
        const keys = this.aiModels.gemini.keys;
        if (!keys || keys.length === 0) throw new Error('No Gemini API keys');

        const key = keys[this.aiModels.gemini.currentIndex % keys.length];
        this.aiModels.gemini.currentIndex++;

        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`,
            {
                contents: [{ parts: [{ text: this.getPrompt() }] }],
                generationConfig: {
                    temperature: 0.1, // Lower temperature for more consistent JSON
                    maxOutputTokens: 256,
                    candidateCount: 1,
                    response_mime_type: "application/json" // Force JSON output for Gemini
                }
            },
            {
                timeout: 30000,
                headers: { 'Content-Type': 'application/json' }
            }
        );

        const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
        return this.parseAIResponse(text, 'gemini');
    }

    async predictWithGroq() {
        const key = this.aiModels.groq.key;
        if (!key) throw new Error('No Groq API key');

        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',//'https://gen.pollinations.ai/v1/chat/completions',//'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'groq/compound',//'llama-3.3-70b-versatile',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt() }
                ],
                temperature: 0.1,
                max_tokens: 256,
                response_format: { type: "json_object" }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`
                },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'groq');
    }

    async predictWithOpenRouter() {
        const key = this.aiModels.openrouter.key;
        if (!key) throw new Error('No OpenRouter API key');

        const response = await axios.post(
            'https://api.cerebras.ai/v1/chat/completions',//https://openrouter.ai/api/v1/chat/completions',
            {
                model: 'qwen-3-235b-a22b-instruct-2507',//'meta-llama/llama-3.2-3b-instruct:free',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt() }
                ],
                temperature: 0.1,
                max_tokens: 256,
                // response_format: { type: "json_object" }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`,
                    // 'HTTP-Referer': 'https://github.com/digit-differ-bot',
                    // 'X-Title': 'Digit Differ Bot'
                },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'openrouter');
    }

    async predictWithMistral() {
        const key = this.aiModels.mistral.key;
        if (!key) throw new Error('No Mistral API key');

        const response = await axios.post(
            'https://api.mistral.ai/v1/chat/completions',
            {
                model: 'mistral-small-latest',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt() }
                ],
                temperature: 0.1,
                max_tokens: 256
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`
                },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'mistral');
    }

    // NEW: Cerebras (very fast, free)
    async predictWithCerebras() {
        const key = this.aiModels.cerebras.key;
        if (!key) throw new Error('No Cerebras API key');

        const response = await axios.post(
            'https://api.cerebras.ai/v1/chat/completions',
            {
                model: 'llama3.1-8b',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt() }
                ],
                temperature: 0.1,
                max_tokens: 256
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`
                },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'cerebras');
    }

    // NEW: SambaNova (free tier)
    async predictWithSambaNova() {
        const key = this.aiModels.sambanova.key;
        if (!key) throw new Error('No SambaNova API key');

        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',//'https://gen.pollinations.ai/v1/chat/completions',//'https://api.sambanova.ai/v1/chat/completions',
            {
                model: 'moonshotai/kimi-k2-instruct-0905',//'perplexity-fast',//'Meta-Llama-3.1-8B-Instruct',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt() }
                ],
                temperature: 0.1,
                max_tokens: 256,
                response_format: { type: "json_object" }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`
                },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'sambanova');
    }

    // NEW: Qwen (Alibaba DashScope)
    async predictWithQwen() {
        const key = this.aiModels.qwen.key;
        if (!key) throw new Error('No DashScope API key');

        // Use compatible-mode endpoint
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',//'https://gen.pollinations.ai/v1/chat/completions',//'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
            {
                model: 'meta-llama/llama-4-scout-17b-16e-instruct',//'claude-fast',//'openai-fast',//'gemini-fast',//'claude-fast',//'qwen/qwen3-coder:free',//'qwen-turbo',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt() }
                ],
                temperature: 0.1,
                max_tokens: 256,
                response_format: { type: "json_object" }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`,
                },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'qwen');
    }

    // NEW: Kimi (Moonshot AI)
    async predictWithKimi() {
        const key = this.aiModels.kimi.key;
        if (!key) throw new Error('No Moonshot API key');

        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',//'https://gen.pollinations.ai/v1/chat/completions',//'https://openrouter.ai/api/v1/chat/completions',//'https://api.moonshot.cn/v1/chat/completions',
            {
                model: 'llama-3.3-70b-versatile',//'gemini-fast',//'kwaipilot/kat-coder-pro:free',//'moonshot-v1-8k',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt() }
                ],
                temperature: 0.1,
                max_tokens: 256,
                response_format: { type: "json_object" }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`
                },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'kimi');
    }

    // NEW: SiliconFlow (Fast Alternative)
    async predictWithSiliconFlow() {
        const key = this.aiModels.siliconflow.key;
        if (!key) throw new Error('No SiliconFlow API key');

        const response = await axios.post(
            'https://gen.pollinations.ai/v1/chat/completions',//'https://openrouter.ai/api/v1/chat/completions',//'https://api.moonshot.cn/v1/chat/completions',
            {
                model: 'gemini-fast',//'kwaipilot/kat-coder-pro:free',//'moonshot-v1-8k',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt() }
                ],
                temperature: 0.1,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`
                },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'siliconflow');
    }

    // ==================== STATISTICAL PREDICTION (FALLBACK) ====================

    statisticalPrediction() {
        const last100 = this.tickHistory.slice(-300);
        const last50 = this.tickHistory.slice(-50);
        const last20 = this.tickHistory.slice(-20);

        // Frequency analysis
        const counts = Array(10).fill(0);
        last100.forEach(d => counts[d]++);

        // Gap analysis - digits not appearing recently
        const last15Set = new Set(this.tickHistory.slice(-15));
        const gaps = [];
        for (let i = 0; i < 10; i++) {
            if (!last15Set.has(i)) gaps.push(i);
        }

        // Transition analysis
        const lastDigit = this.tickHistory[this.tickHistory.length - 1];
        const transitions = Array(10).fill(0);
        for (let i = 1; i < last100.length; i++) {
            if (last100[i - 1] === lastDigit) {
                transitions[last100[i]]++;
            }
        }

        // Combine analyses
        const scores = Array(10).fill(0);

        for (let i = 0; i < 10; i++) {
            // Lower frequency = more likely to NOT appear = good for differ
            scores[i] += (10 - counts[i]) * 2;

            // If digit is in gaps, it might appear soon (bad for differ)
            if (gaps.includes(i)) {
                scores[i] -= 7;
            }

            // Higher transition probability = more likely to appear = bad
            scores[i] -= transitions[i];

            // Check recent momentum
            const recentCount = last20.filter(d => d === i).length;
            if (recentCount === 0) {
                scores[i] -= 2;
            } else if (recentCount >= 4) {
                scores[i] += 3;
            }
        }

        // Find digit with highest score
        let maxScore = -Infinity;
        let predictedDigit = 0;

        for (let i = 0; i < 10; i++) {
            if (scores[i] > maxScore) {
                maxScore = scores[i];
                predictedDigit = i;
            }
        }

        // Calculate confidence
        const avgScore = scores.reduce((a, b) => a + b, 0) / 10;
        const scoreDiff = maxScore - avgScore;
        const confidence = Math.min(85, Math.max(50, Math.round(50 + scoreDiff * 5)));

        return {
            predictedDigit,
            confidence,
            primaryStrategy: 'Statistical Analysis',
            marketRegime: 'ranging',
            riskAssessment: confidence >= 70 ? 'low' : 'medium',
            model: 'statistical'
        };
    }

    // ==================== TRADE EXECUTION ====================

    placeTrade(digit, confidence) {
        if (this.tradeInProgress) return;

        this.tradeInProgress = true;
        this.predictionInProgress = true;

        console.log(`\n💰 Placing trade: DIFFER ${digit} @ $${this.currentStake.toFixed(2)} (${confidence}% confidence)`);

        this.sendRequest({
            buy: 1,
            price: this.currentStake,
            parameters: {
                amount: this.currentStake,
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: this.currentAsset,
                barrier: digit
            }
        });

        this.currentPrediction = { digit, confidence };
    }

    handleTradeResult(contract) {
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const actualDigit = this.tickHistory[this.tickHistory.length - 1];

        console.log('\n' + '='.repeat(40));
        console.log(won ? '🎉 TRADE WON!' : '😔 TRADE LOST');
        console.log(`   Predicted: ${this.lastPrediction} | Actual: ${actualDigit}`);
        console.log(`   Profit: ${won ? '+' : ''}$${profit.toFixed(2)}`);
        console.log('='.repeat(40));

        // Update statistics
        this.totalTrades++;
        this.totalPnL += profit;

        // Track prediction outcomes
        this.previousPredictions.push(this.lastPrediction);
        this.predictionOutcomes.push(won);
        if (this.previousPredictions.length > 100) {
            this.previousPredictions.shift();
            this.predictionOutcomes.shift();
        }

        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;

            // Track winning pattern
            const pattern = this.tickHistory.slice(-5).join('');
            this.winningPatterns.set(pattern, (this.winningPatterns.get(pattern) || 0) + 1);
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;

            // Martingale stake increase
            this.currentStake = Math.min(
                Math.ceil(this.currentStake * this.config.multiplier * 100) / 100,
                this.balance * 0.5
            );
        }

        // Send email notification for loss
        if (!won && this.emailConfig.enabled) {
            this.sendLossEmail(actualDigit, profit);
        }

        // Log summary
        this.logTradingSummary();

        // Check stop conditions
        if (this.checkStopConditions()) {
            return;
        }

        // Reset state and schedule next trade
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.scheduleNextTrade();
    }

    checkStopConditions() {
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log('\n🛑 Max consecutive losses reached. Stopping.');
            this.shutdown();
            return true;
        }

        if (this.totalPnL <= -this.config.stopLoss) {
            console.log('\n🛑 Stop loss reached. Stopping.');
            this.shutdown();
            return true;
        }

        if (this.totalPnL >= this.config.takeProfit) {
            console.log('\n🎉 Take profit reached! Stopping.');
            this.shutdown();
            return true;
        }

        return false;
    }

    // Fixed: Proper scheduling for next trade
    scheduleNextTrade() {
        // Cycle to next API key for Gemini
        if (this.aiModels.gemini.enabled && this.aiModels.gemini.keys.length > 1) {
            this.aiModels.gemini.currentIndex =
                (this.aiModels.gemini.currentIndex + 1) % this.aiModels.gemini.keys.length;
        }

        // Random wait time between trades
        const waitTime = Math.floor(
            Math.random() * (this.config.maxWaitTime - this.config.minWaitTime) +
            this.config.minWaitTime
        );

        console.log(`\n⏳ Waiting ${Math.round(waitTime / 1000)}s before next trade...`);

        // Disconnect and schedule reconnect
        this.isPaused = true;
        this.disconnect();

        setTimeout(() => {
            if (!this.isShuttingDown) {
                this.isPaused = false;
                this.reconnectAttempts = 0;
                this.connect();
            }
        }, waitTime);
    }

    // Fixed: Proper reconnect scheduling
    scheduleReconnect(delay) {
        console.log(`⏳ Scheduling reconnect in ${delay / 1000}s...`);

        this.isPaused = true;
        this.disconnect();

        setTimeout(() => {
            if (!this.isShuttingDown) {
                this.isPaused = false;
                this.reconnectAttempts = 0;
                this.connect();
            }
        }, delay);
    }

    // ==================== LOGGING & NOTIFICATIONS ====================

    logTradingSummary() {
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;

        console.log('\n📊 Trading Summary:');
        console.log(`   Total Trades: ${this.totalTrades}`);
        console.log(`   Wins/Losses: ${this.totalWins}/${this.totalLosses}`);
        console.log(`   Win Rate: ${winRate}%`);
        console.log(`   Total P/L: $${this.totalPnL.toFixed(2)}`);
        console.log(`   Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`   Balance: $${this.balance.toFixed(2)}`);
        console.log(`   Consecutive Losses: ${this.consecutiveLosses}`);
    }

    logFinalSummary() {
        const duration = this.getSessionDuration();
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;

        console.log('\n' + '='.repeat(60));
        console.log('📊 FINAL TRADING SUMMARY');
        console.log('='.repeat(60));
        console.log(`   Session Duration: ${duration}`);
        console.log(`   Total Trades: ${this.totalTrades}`);
        console.log(`   Wins: ${this.totalWins}`);
        console.log(`   Losses: ${this.totalLosses}`);
        console.log(`   Win Rate: ${winRate}%`);
        console.log(`   Total P/L: $${this.totalPnL.toFixed(2)}`);
        console.log(`   Starting Balance: $${this.sessionStartBalance.toFixed(2)}`);
        console.log(`   Final Balance: $${this.balance.toFixed(2)}`);
        console.log('='.repeat(60) + '\n');

        // Send email notification if configured
        if (this.emailConfig.enabled) {
            this.sendEmailNotification('Bot Stopped', this.getEmailSummary());
        }
    }

    getSessionDuration() {
        const now = new Date();
        const diff = now - this.sessionStartTime;
        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        return `${hours}h ${minutes}m`;
    }

    getEmailSummary() {
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;

        return `
            Trading Session Summary
            ========================
            Total Trades: ${this.totalTrades}
            Wins: ${this.totalWins}
            Losses: ${this.totalLosses}
            Win Rate: ${winRate}%
            Total P/L: $${this.totalPnL.toFixed(2)}
            Final Balance: $${this.balance.toFixed(2)}
        `;
    }

    async sendEmailNotification(subject, body) {
        if (!this.emailConfig.enabled || !nodemailer) return;

        try {
            const transporter = nodemailer.createTransport({
                service: this.emailConfig.service,
                auth: this.emailConfig.auth
            });

            await transporter.sendMail({
                from: this.emailConfig.auth.user,
                to: this.emailConfig.recipient,
                subject: `🤖 AI Digit Bot - ${subject}`,
                text: body
            });

            console.log('📧 Email notification sent');
        } catch (error) {
            console.error('❌ Failed to send email:', error.message);
        }
    }

    startEmailTimer() {
        // Send summary every 30 minutes
        setInterval(() => {
            if (this.totalTrades > 0 && !this.isShuttingDown) {
                this.sendEmailNotification('Regular Performance Summary', this.getEmailSummary());
            }
        }, 30 * 60 * 1000);
    }

    async sendLossEmail(actualDigit, profit) {
        const subject = `Loss Alert: -$${Math.abs(profit).toFixed(2)}`;
        const body = `
            TRADE LOSS ALERT
            ================
            Asset: ${this.currentAsset}
            Prediction: ${this.lastPrediction}
            Actual: ${actualDigit}
            Loss: $${Math.abs(profit).toFixed(2)}
            
            Current Balance: $${this.balance.toFixed(2)}
            Consecutive Losses: ${this.consecutiveLosses}
            
            Session Stats:
            Wins: ${this.totalWins}
            Losses: ${this.totalLosses}
            P/L: $${this.totalPnL.toFixed(2)}
        `;

        await this.sendEmailNotification(subject, body);
    }

    // ==================== START BOT ====================

    start() {
        console.log('🚀 Starting AI Digit Differ Trading Bot v3.0...\n');

        if (!this.token) {
            console.error('❌ Error: DERIV_TOKEN is required');
            process.exit(1);
        }

        // Handle graceful shutdown
        // process.on('SIGINT', () => {
        //     console.log('\n\n⚠️  Received SIGINT. Shutting down gracefully...');
        //     this.shutdown();
        // });

        // process.on('SIGTERM', () => {
        //     console.log('\n\n⚠️  Received SIGTERM. Shutting down gracefully...');
        //     this.shutdown();
        // });

        process.on('uncaughtException', (error) => {
            console.error('Uncaught Exception:', error.message);
            // Don't exit, try to continue
        });

        process.on('unhandledRejection', (reason, promise) => {
            console.error('Unhandled Rejection:', reason);
            // Don't exit, try to continue
        });

        this.connect();
    }
}

// ==================== STARTUP ====================

// Validate required environment variable
if (!process.env.DERIV_TOKENs) {
    console.error('❌ Error: DERIV_TOKEN is required in .env file');
    console.log('   Create a .env file with: DERIV_TOKEN=your_token_here');
    process.exit(1);
}

// Create and start bot
const bot = new AIDigitDifferBot({
    derivToken: process.env.DERIV_TOKENs,
    initialStake: parseFloat(process.env.INITIAL_STAKE) || 5,
    multiplier: parseFloat(process.env.MULTIPLIER) || 11.3,
    maxConsecutiveLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES) || 3,
    stopLoss: parseFloat(process.env.STOP_LOSS) || 67,
    takeProfit: parseFloat(process.env.TAKE_PROFIT) || 100,
    minConfidence: parseInt(process.env.MIN_CONFIDENCE) || 60,
    minModelsAgreement: parseInt(process.env.MIN_MODELS_AGREEMENT) || 2,
    requiredHistoryLength: parseInt(process.env.REQUIRED_HISTORY_LENGTH) || 500,
    minWaitTime: parseInt(process.env.MIN_WAIT_TIME) || 10000,
    maxWaitTime: parseInt(process.env.MAX_WAIT_TIME) || 60000,
    assets: process.env.ASSETS ? process.env.ASSETS.split(',').map(a => a.trim()) : undefined
});

bot.start();
