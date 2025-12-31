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
const TelegramBot = require('node-telegram-bot-api');

// Production-Grade Adversarial-Aware Prediction System

class EnhancedAIPrompt {

    static generatePrompt(marketData, modelPerformance, regimeData) {
        const {
            currentAsset,
            tickHistory,
            lastPrediction,
            lastOutcome,
            consecutiveLosses,
            recentMethods,
            volatility,
            marketRegime,
            comprehensiveAnalysis
        } = marketData;

        const recentDigits = tickHistory.slice(-100);
        const last50 = tickHistory.slice(-50);
        const last20 = tickHistory.slice(-20);
        const last500 = tickHistory.slice(-500);

        // Use comprehensive analysis if available, otherwise calculate basic stats
        let freqStats, gapAnalysis, serialCorrelation, entropyValue, uniformityTest;

        if (comprehensiveAnalysis && !comprehensiveAnalysis.error) {
            // Use pre-calculated comprehensive analysis
            freqStats = comprehensiveAnalysis.frequencyAnalysis;
            gapAnalysis = comprehensiveAnalysis.gapAnalysis.absentDigits || [];
            serialCorrelation = comprehensiveAnalysis.serialCorrelation;
            entropyValue = comprehensiveAnalysis.entropy;
            uniformityTest = comprehensiveAnalysis.uniformityTest;
        } else {
            // Fallback to basic calculations
            freqStats = this.calculateFrequencyStats(last500);
            gapAnalysis = this.analyzeGaps(tickHistory);
            serialCorrelation = this.calculateSerialCorrelation(tickHistory);
            entropyValue = null;
            uniformityTest = null;
        }

        const volatilityAssessment = this.assessVolatility(tickHistory);

        // Format comprehensive analysis for prompt
        let comprehensiveSection = '';
        if (comprehensiveAnalysis && !comprehensiveAnalysis.error) {
            comprehensiveSection = `
            === COMPREHENSIVE STATISTICAL ANALYSIS ===
            Sample Size: ${comprehensiveAnalysis.sampleSize} ticks
            Market Regime: ${comprehensiveAnalysis.regime}
            Entropy: ${entropyValue ? entropyValue.toFixed(4) : 'N/A'} (${entropyValue > 0.95 ? 'High randomness' : 'Potential patterns'})
            
            Chi-Square Test: ${uniformityTest ? uniformityTest.interpretation : 'N/A'}
            ${uniformityTest ? `- Chi-Square: ${uniformityTest.chiSquare}, p-value: ${uniformityTest.pValue}` : ''}
            
            Gap Analysis:
            ${comprehensiveAnalysis.gapAnalysis.gaps.slice(0, 5).map(g =>
                `- Digit ${g.digit}: Absent for ${g.gapLength} ticks`
            ).join('\n            ')}
            `;
        }

        return `You are an elite statistical arbitrage AI specializing in Deriv Digit Differ prediction. You operate in a highly adversarial environment where the platform actively learns from and counters successful strategies. Your predictability is your greatest vulnerability.

            === ADVERSARIAL REALITY ===
            The Deriv platform is not passive - it is an intelligent opponent that:
            - Observes and adapts to successful prediction patterns
            - Actively counters strategies that show consistent profitability  
            - May adjust digit generation to neutralize your historical advantages
            - Exploites predictable behavioral patterns

            Your survival depends on:
            1. Continuous strategy evolution and randomization
            2. Statistical rigor over pattern chasing
            3. Regime-aware adaptation
            4. Never repeating the same approach consecutively

            === CURRENT MARKET CONTEXT ===
            Asset: ${currentAsset}
            Market Regime: ${marketRegime || 'Detecting...'}
            Volatility Level: ${volatilityAssessment.level} (${volatilityAssessment.value.toFixed(3)})
            Last Prediction: ${lastPrediction || 'None'} → ${lastOutcome || 'N/A'}
            Consecutive Losses: ${consecutiveLosses}
            Recent Methods: ${recentMethods || 'None'}
            ${comprehensiveSection}

            === FREQUENCY ANALYSIS (Last 500 Ticks) ===
            ${Array.isArray(freqStats) ? this.formatFrequencyStats(freqStats) : 'Calculating...'}

            Gap Analysis (Digits absent in last 25 ticks): ${Array.isArray(gapAnalysis) ? gapAnalysis.join(', ') : 'None'}
            Serial Correlation: ${serialCorrelation ? serialCorrelation.toFixed(4) : '0.0000'} (${Math.abs(serialCorrelation) > 0.1 ? 'Significant' : 'Negligible'})

            === MANDATORY PREDICTION PRINCIPLES ===
            You MUST predict the digit that will NOT appear in the next tick (Digit Differ).

            APPROVED STATISTICAL METHODS ONLY:
            1. FREQUENCY DEVIATION ANALYSIS
            - Target digits appearing significantly below 10% frequency
            - Require statistical significance (p < 0.05)
            - Apply chi-square test for uniformity

            2. ENTROPY AND DISTRIBUTION ANALYSIS  
            - Calculate information entropy of recent digits
            - Identify digits with maximum divergence from uniform distribution
            - Use KL-divergence for distribution comparison

            3. REGIME-AWARE PATTERN DETECTION
            - Adjust methods based on current market regime
            - Use different strategies for trending vs ranging markets
            - Apply volatility-adjusted confidence intervals

            4. VOLATILITY-ADJUSTED FORECASTING
            - Reduce confidence during high volatility periods
            - Increase sample size requirements during uncertainty
            - Use GARCH models for volatility prediction

            FORBIDDEN APPROACHES:
            - Pattern matching without statistical validation
            - Numerology or superstitious reasoning
            - Chasing recent streaks without statistical basis
            - Copying previous successful predictions

            === ADAPTIVE STRATEGY PROTOCOL ===
            After ANY loss (consecutiveLosses ≥ 1):
            1. Immediately switch to conservative statistical method
            2. Blacklist the losing method for next 3 decisions
            3. Increase sample size requirements by 50%
            4. Reduce confidence threshold by 20%

            Performance Tracking:
            - Maintain ledger of method effectiveness by regime
            - Favor methods with recent wins in current regime
            - Trigger complete strategy reset after 3 losses in 5 trades

            === CONFIDENCE REQUIREMENTS ===
            Confidence MUST reflect true statistical certainty:
            - 95%+: Strong statistical evidence, multiple methods agree
            - 85-94%: Moderate evidence, single strong method
            - 70-84%: Weak evidence, trade not recommended
            - <70%: Insufficient evidence, mandatory skip

            Statistical Validation Requirements:
            - Minimum 100 observations for frequency analysis
            - P-value < 0.05 for significance claims
            - Confidence intervals for all probability estimates
            - Bayesian updating for model weights

            === MARKET REGIME ADAPTATION ===
            Current Regime: ${marketRegime || 'Unknown'}

            Regime-Specific Guidelines:
            - TRENDING: Focus on momentum-resistant digits, reduce position size
            - RANGING: Emphasize mean reversion, standard confidence
            - VOLATILE: Conservative approach, require higher confidence threshold
            - STABLE: Normal operation, standard statistical methods

            === OUTPUT FORMAT (STRICT JSON) ===
            {
            "predictedDigit": X,
            "confidence": XX,
            "primaryStrategy": "Statistical-Method-Name",
            "marketRegime": "trending/ranging/volatile/stable",
            "riskAssessment": "low/medium/high",
            "statisticalEvidence": {
                "frequencyAnalysis": {
                "digitFrequency": X.X%,
                "expectedFrequency": 10.0%,
                "deviation": X.X%,
                "significance": "p=X.XXX"
                },
                "gapAnalysis": {
                "absentForTicks": X,
                "maxHistoricalGap": X,
                "gapPercentile": XX%
                },
                "volatilityAdjusted": true/false,
                "serialCorrelation": X.XXXX,
                "sampleSize": XXX
            },
            "methodRationale": "Detailed explanation of statistical reasoning",
            "alternativeCandidates": [X, Y, Z],
            "skipRecommendation": "reason or null"
            }

            === CRITICAL REMINDERS ===
            - You are not just predicting - you are strategically selecting only high-certainty battles
            - The platform adapts to your patterns - maintain unpredictability
            - Statistical rigor is your only defense against market randomness
            - When in doubt, reduce confidence or skip the trade entirely
            - Your goal is long-term survival, not short-term gains

            Generate your prediction based on the statistical evidence provided. Remember: predict the digit that will NOT appear in the next tick.
        `;
    }

    static calculateFrequencyStats(digits) {
        const counts = Array(10).fill(0);
        digits.forEach(d => counts[d]++);

        const total = digits.length;
        return counts.map((count, digit) => ({
            digit,
            count,
            frequency: (count / total * 100).toFixed(1),
            deviation: ((count / total - 0.1) * 100).toFixed(1)
        }));
    }

    static analyzeGaps(tickHistory) {
        const last25 = new Set(tickHistory.slice(-25));
        const gaps = [];
        for (let i = 0; i < 10; i++) {
            if (!last25.has(i)) gaps.push(i);
        }
        return gaps;
    }

    static assessVolatility(tickHistory) {
        if (tickHistory.length < 50) {
            return { level: 'Unknown', value: 0 };
        }

        // Calculate rolling standard deviation
        const recent = tickHistory.slice(-50);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
        const stdDev = Math.sqrt(variance);

        let level = 'Low';
        if (stdDev > 3) level = 'High';
        else if (stdDev > 2) level = 'Medium';

        return { level, value: stdDev };
    }

    static calculateSerialCorrelation(tickHistory) {
        if (tickHistory.length < 50) return 0;

        const recent = tickHistory.slice(-50);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;

        let numerator = 0;
        let denominator = 0;

        for (let i = 0; i < recent.length - 1; i++) {
            numerator += (recent[i] - mean) * (recent[i + 1] - mean);
            denominator += Math.pow(recent[i] - mean, 2);
        }

        return denominator > 0 ? numerator / denominator : 0;
    }

    static formatFrequencyStats(stats) {
        return stats
            .sort((a, b) => parseFloat(a.frequency) - parseFloat(b.frequency))
            .map(s => `Digit ${s.digit}: ${s.frequency}% (${s.count}/500) | Deviation: ${s.deviation}%`)
            .join('\n');
    }
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

        // Trading Configuration - UPGRADED WITH SAFE RISK MANAGEMENT
        this.config = {
            initialStake: config.initialStake || 5,
            baseStake: config.baseStake || 5,
            maxStakePercent: config.maxStakePercent || 2, // Max 2% of balance per trade
            maxConsecutiveLosses: config.maxConsecutiveLosses || 5, // Increased from 3
            stopLoss: config.stopLoss || 25, // Reduced from 67% to 25%
            takeProfit: config.takeProfit || 50, // Reduced from 100% to 50%
            requiredHistoryLength: config.requiredHistoryLength || 500,
            minConfidence: config.minConfidence || 75, // Increased from 60 to 75
            minModelsAgreement: config.minModelsAgreement || 2,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            tradeCooldown: config.tradeCooldown || 5000, // Increased from 3000
            minWaitTime: config.minWaitTime || 15000, // Increased from 10000
            maxWaitTime: config.maxWaitTime || 90000, // Increased from 60000
        };

        // Trading State
        this.currentStake = this.config.initialStake;
        this.consecutiveWins = 0; // Track wins for Anti-Martingale
        this.currentAsset = null;
        this.usedAssets = new Set();
        this.consecutiveLosses = 0;
        this.currentTradeId = null;
        this.tickSubscriptionId = null;
        this.tradingHistory = []; // Track all trades for performance analysis
        this.lastTradeResult = null; // 'won' or 'lost'

        // Statistics
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
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
        this.RestartTrading = true;

        // Model Performance Tracking
        this.modelPerformance = {};
        for (const key in this.aiModels) {
            this.modelPerformance[key] = {
                wins: 0,
                losses: 0,
                predictions: [],
                lastPrediction: 'None',
                lastOutcome: 'None',
                currentPrediction: null
            };
        }

        // Connection State
        this.reconnectAttempts = 0;
        this.isPaused = false;
        this.isShuttingDown = false;
        this.isReconnecting = false;

        // Telegram Configuration (using Token 2 and Chat ID 2)
        this.telegramToken = process.env.TELEGRAM_BOT_TOKEN2;
        this.telegramChatId = process.env.TELEGRAM_CHAT_ID2;
        this.telegramEnabled = !!(this.telegramToken && this.telegramChatId);

        if (this.telegramEnabled) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
        } else {
            console.log('📱 Telegram notifications disabled (missing API keys).');
        }

        // Session tracking
        this.sessionStartTime = new Date();

        console.log('\n' + '='.repeat(60));
        console.log('🤖 AI DIGIT DIFFER TRADING BOT v3.0');
        console.log('='.repeat(60));
        this.logActiveModels();

        // Start telegram timer
        if (this.telegramEnabled) {
            this.startTelegramTimer();
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
        if (this.RestartTrading) {
            const availableAssets = this.assets.filter(a => !this.usedAssets.has(a));
            this.currentAsset = availableAssets[Math.floor(Math.random() * availableAssets.length)];
            this.usedAssets.add(this.currentAsset);
        }

        this.RestartTrading = false;

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

    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25'].includes(asset)) {
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
        this.tickHistory = history.prices.map(price => this.getLastDigit(price, this.currentAsset));
        console.log(`📊 Received ${this.tickHistory.length} ticks of history`);
    }

    handleTickUpdate(tick) {
        if (!tick || !tick.quote) return;

        const lastDigit = this.getLastDigit(tick.quote, this.currentAsset);

        // Add to history
        this.tickHistory.push(lastDigit);
        if (this.tickHistory.length > this.config.requiredHistoryLength) {
            this.tickHistory.shift();
        }

        this.digitCounts[lastDigit]++;

        console.log(`📍 Last 5 digits: ${this.tickHistory.slice(-5).join(', ')} | History: ${this.tickHistory.length}`);

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
            // if (ensemble.confidence >= this.config.minConfidence &&
            //     ensemble.agreement >= Math.min(this.config.minModelsAgreement, predictions.length) &&
            //     ensemble.risk !== 'high' &&
            //     ensemble.risk !== 'medium' &&
            //     processingTime.toFixed(2) < 3 &&
            //     this.lastPrediction !== this.xDigit
            //     && ensemble.digit !== this.tickHistory[this.tickHistory.length - 1]
            // ) {
            //     this.xDigit = ensemble.digit;
            //     this.placeTrade(ensemble.digit, ensemble.confidence);
            // } else {
            //     console.log(`⏭️  Skipping trade: conf=${ensemble.confidence}%, agree=${ensemble.agreement}, risk=${ensemble.risk}`);
            //     this.predictionInProgress = false;
            //     this.scheduleNextTrade();
            // }

            // NEW CODE:
            const marketRegime = this.detectMarketRegime(this.tickHistory);
            const tradeDecision = this.shouldExecuteTrade(ensemble, marketRegime, this.config);

            if (tradeDecision.execute && processingTime.toFixed(2) < 3) {
                this.placeTrade(ensemble.digit, ensemble.confidence);
            } else {
                console.log(`⏭️ Skipping trade: ${tradeDecision.reason}`);
                this.predictionInProgress = false;
                this.scheduleNextTrade();
            }


        } catch (error) {
            console.error('❌ Prediction error:', error.message);
            this.predictionInProgress = false;
            this.scheduleNextTrade();
        }
    }

    /**
     * Intelligent Trade Decision Logic
     * Determines if a trade should be executed based on multiple factors
     */
    shouldExecuteTrade(ensemble, marketRegime, config) {
        const reasons = [];
        let execute = true;

        // 1. Confidence Check
        if (ensemble.confidence < config.minConfidence) {
            execute = false;
            reasons.push(`Low confidence: ${ensemble.confidence}% < ${config.minConfidence}%`);
        }

        // 2. Model Agreement Check
        const minAgreement = Math.min(config.minModelsAgreement, ensemble.totalModels || 1);
        if (ensemble.agreement < minAgreement) {
            execute = false;
            reasons.push(`Low agreement: ${ensemble.agreement}/${ensemble.totalModels || 'N/A'} models`);
        }

        // 3. Risk Assessment Check
        if (ensemble.risk === 'high') {
            execute = false;
            reasons.push(`High risk assessment`);
        }

        // 4. Medium Risk in Volatile Markets
        // if (ensemble.risk === 'medium' && (marketRegime === 'volatile' || marketRegime === 'random')) {
        //     execute = false;
        //     reasons.push(`Medium risk in ${marketRegime} market`);
        // }

        // 5. Regime-Specific Confidence Adjustment
        if (marketRegime === 'volatile' && ensemble.confidence < config.minConfidence + 10) {
            execute = false;
            reasons.push(`Volatile market requires ${config.minConfidence + 10}% confidence`);
        }

        if (marketRegime === 'random' && ensemble.confidence < config.minConfidence + 15) {
            execute = false;
            reasons.push(`Random market requires ${config.minConfidence + 15}% confidence`);
        }

        // 6. Avoid Repeating Same Prediction
        if (this.lastPrediction === ensemble.digit && this.xDigit === ensemble.digit) {
            execute = false;
            reasons.push(`Already predicted digit ${ensemble.digit}`);
        }

        // 7. Avoid Predicting Current Tick's Digit
        const lastTickDigit = this.tickHistory[this.tickHistory.length - 1];
        if (ensemble.digit === lastTickDigit) {
            execute = false;
            reasons.push(`Digit ${ensemble.digit} just appeared in last tick`);
        }

        // 8. Check Comprehensive Analysis (if available)
        if (this.tickHistory.length >= 100) {
            const analysis = this.performComprehensiveAnalysis(this.tickHistory, 100);

            // If market is highly uniform (random), require higher confidence
            if (analysis.uniformityTest && analysis.uniformityTest.isUniform) {
                if (ensemble.confidence < config.minConfidence + 10) {
                    execute = false;
                    reasons.push(`Uniform distribution requires higher confidence`);
                }
            }

            // If entropy is very high (random), be more cautious
            if (analysis.entropy && analysis.entropy > 0.95) {
                if (ensemble.confidence < config.minConfidence + 15) {
                    execute = false;
                    reasons.push(`High entropy (${analysis.entropy.toFixed(2)}) requires higher confidence`);
                }
            }

            // Check if predicted digit has a significant gap
            if (analysis.gapAnalysis && analysis.gapAnalysis.absentDigits) {
                const isAbsent = analysis.gapAnalysis.absentDigits.includes(ensemble.digit);
                if (isAbsent) {
                    // Boost confidence for absent digits
                    console.log(`✅ Digit ${ensemble.digit} has been absent - good prediction target`);
                } else {
                    // Digit appeared recently, be more cautious
                    if (ensemble.confidence < config.minConfidence + 5) {
                        execute = false;
                        reasons.push(`Digit ${ensemble.digit} appeared recently, needs higher confidence`);
                    }
                }
            }
        }

        // 9. Balance Check
        if (this.balance < config.initialStake * 2) {
            execute = false;
            reasons.push(`Low balance: $${this.balance.toFixed(2)}`);
        }

        // 10. Consecutive Losses Check (extra caution)
        if (this.consecutiveLosses >= 3 && ensemble.confidence < config.minConfidence + 10) {
            execute = false;
            reasons.push(`${this.consecutiveLosses} consecutive losses - need ${config.minConfidence + 10}% confidence`);
        }

        // Build result
        const result = {
            execute: execute,
            reason: execute
                ? `✅ All checks passed (Conf: ${ensemble.confidence}%, Risk: ${ensemble.risk}, Regime: ${marketRegime})`
                : reasons.join(' | '),
            confidence: ensemble.confidence,
            risk: ensemble.risk,
            regime: marketRegime
        };

        // Log decision details
        if (!execute) {
            console.log(`\n🚫 Trade Decision: SKIP`);
            console.log(`   Reasons: ${result.reason}`);
        } else {
            console.log(`\n✅ Trade Decision: EXECUTE`);
            console.log(`   Confidence: ${ensemble.confidence}%`);
            console.log(`   Risk: ${ensemble.risk}`);
            console.log(`   Market Regime: ${marketRegime}`);
            console.log(`   Agreement: ${ensemble.agreement} models`);
        }

        return result;
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
                // Store current prediction for feedback loop
                if (this.modelPerformance[result.model]) {
                    this.modelPerformance[result.model].currentPrediction = result.predictedDigit;
                }
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

    // Add comprehensive statistical analysis
    performComprehensiveAnalysis(tickHistory, minSampleSize = 100) {
        if (tickHistory.length < minSampleSize) {
            return { error: 'Insufficient data for statistical analysis' };
        }

        const sample = tickHistory.slice(-minSampleSize);

        return {
            frequencyAnalysis: this.analyzeDigitFrequency(sample),
            gapAnalysis: this.analyzeDigitGaps(sample),
            serialCorrelation: this.calculateSerialCorrelation(sample),
            entropy: this.calculateEntropy(sample),
            uniformityTest: this.performChiSquareTest(sample),
            volatility: this.calculateVolatility(sample),
            regime: this.detectMarketRegime(sample)
        };
    }

    // Add frequency analysis
    analyzeDigitFrequency(digits) {
        const counts = Array(10).fill(0);
        digits.forEach(d => counts[d]++);

        const total = digits.length;
        return counts.map((count, digit) => ({
            digit,
            count,
            frequency: count / total,
            deviation: (count / total - 0.1) * 100,
            zScore: (count / total - 0.1) / Math.sqrt(0.1 * 0.9 / total)
        }));
    }

    /**
     * Analyze digit gaps - which digits haven't appeared recently
     */
    analyzeDigitGaps(digits) {
        if (digits.length < 25) return { gaps: [], maxGap: 0, absentDigits: [] };

        const last25 = new Set(digits.slice(-25));
        const gaps = [];

        for (let i = 0; i < 10; i++) {
            if (!last25.has(i)) {
                // Find how long this digit has been absent
                let gapLength = 0;
                for (let j = digits.length - 1; j >= 0; j--) {
                    if (digits[j] === i) break;
                    gapLength++;
                }
                gaps.push({ digit: i, gapLength });
            }
        }

        const maxGap = gaps.length > 0 ? Math.max(...gaps.map(g => g.gapLength)) : 0;

        return {
            gaps: gaps.sort((a, b) => b.gapLength - a.gapLength),
            maxGap,
            absentDigits: gaps.map(g => g.digit)
        };
    }

    /**
     * Calculate serial correlation (already exists but adding here for completeness)
     * This is a duplicate - will be handled by the existing one
     */
    // calculateSerialCorrelation is already defined in Kelly Criterion section

    /**
     * Perform Chi-Square test for uniformity
     * Tests if digit distribution is significantly different from uniform
     */
    performChiSquareTest(digits) {
        if (digits.length < 100) {
            return { chiSquare: 0, pValue: 1, isUniform: true };
        }

        const counts = Array(10).fill(0);
        digits.forEach(d => counts[d]++);

        const expected = digits.length / 10;
        let chiSquare = 0;

        for (const count of counts) {
            chiSquare += Math.pow(count - expected, 2) / expected;
        }

        // Degrees of freedom = 10 - 1 = 9
        // Critical value at p=0.05 for df=9 is 16.919
        const criticalValue = 16.919;
        const isUniform = chiSquare < criticalValue;

        // Approximate p-value (simplified)
        const pValue = chiSquare < criticalValue ? 0.5 : 0.01;

        return {
            chiSquare: chiSquare.toFixed(3),
            pValue: pValue.toFixed(3),
            isUniform,
            interpretation: isUniform
                ? 'Distribution is uniform (random)'
                : 'Distribution is non-uniform (potential pattern)'
        };
    }

    /**
     * Calculate serial correlation (autocorrelation)
     * Measures if current digit is correlated with previous digit
     */
    calculateSerialCorrelation(digits) {
        if (digits.length < 50) return 0;

        const recent = digits.slice(-50);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;

        let numerator = 0;
        let denominator = 0;

        for (let i = 0; i < recent.length - 1; i++) {
            numerator += (recent[i] - mean) * (recent[i + 1] - mean);
            denominator += Math.pow(recent[i] - mean, 2);
        }

        return denominator > 0 ? numerator / denominator : 0;
    }


    /**
     * Kelly Criterion - Optimal position sizing based on win rate and payout
     * Replaces dangerous Martingale strategy
     */
    calculateKellyStake(winRate, payout, balance, maxRiskPercent = 2) {
        // Bound win rate between 10% and 90% to avoid extreme values
        const p = Math.max(0.1, Math.min(0.9, winRate));
        const q = 1 - p;
        const b = payout; // Payout ratio (typically ~1.1 for digit differ)

        // Kelly formula: f = (bp - q) / b
        const kellyFraction = (b * p - q) / b;

        // Use half-Kelly for safety (Kelly is known to be aggressive)
        const safeKellyFraction = Math.max(0, kellyFraction * 0.5);

        // Maximum risk amount (2% of balance by default)
        const maxRiskAmount = balance * (maxRiskPercent / 100);

        // Calculate optimal stake
        const optimalStake = Math.min(
            balance * safeKellyFraction,
            maxRiskAmount
        );

        // Ensure stake is at least 1 and at most baseStake * 3
        return Math.max(1, Math.min(Math.floor(optimalStake), this.config.baseStake * 3));
    }

    /**
     * Anti-Martingale - Increase stake after wins, reset after losses
     * Safer alternative to Martingale
     */
    calculateAntiMartingaleStake(lastTradeResult, currentStake, baseStake, consecutiveWins = 0) {
        if (lastTradeResult === 'won') {
            // Increase stake after win, but cap at 4x base
            const multiplier = Math.min(Math.pow(1.5, consecutiveWins + 1), 4);
            return Math.floor(currentStake * multiplier);
        } else {
            // Reset to base stake after loss (key difference from Martingale)
            return baseStake;
        }
    }

    /**
     * Volatility-Adjusted Position Sizing
     * Reduce stake during high volatility, increase during low volatility
     */
    calculateVolatilityAdjustedStake(baseStake, currentVolatility, averageVolatility) {
        if (currentVolatility <= 0 || averageVolatility <= 0) return baseStake;

        // Volatility ratio: if current > average, reduce stake
        const volatilityRatio = averageVolatility / currentVolatility;

        // Limit adjustment factor between 0.3x and 3x
        const adjustmentFactor = Math.max(0.3, Math.min(volatilityRatio, 3));

        const adjustedStake = baseStake * adjustmentFactor;
        return Math.max(1, Math.floor(adjustedStake));
    }

    /**
     * Calculate volatility from recent tick history
     */
    calculateVolatility(digits) {
        if (digits.length < 20) return 0;

        const recent = digits.slice(-50);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
        return Math.sqrt(variance);
    }

    /**
     * Market Regime Detection
     * Determines if market is trending, ranging, volatile, or stable
     */
    detectMarketRegime(tickHistory) {
        if (tickHistory.length < 100) return 'insufficient_data';

        const recent = tickHistory.slice(-100);
        const volatility = this.calculateVolatility(recent);
        const trend = this.detectTrend(recent);
        const entropy = this.calculateEntropy(recent);

        // High volatility = volatile regime
        if (volatility > 2.5) return 'volatile';

        // Strong trend = trending regime
        if (Math.abs(trend.strength) > 0.3) return 'trending';

        // High entropy = random regime
        if (entropy > 0.95) return 'random';

        // Otherwise stable
        return 'stable';
    }

    /**
     * Detect trend strength and direction
     */
    detectTrend(digits) {
        if (digits.length < 20) return { strength: 0, direction: 'neutral' };

        const first = digits.slice(0, 10);
        const last = digits.slice(-10);

        const firstAvg = first.reduce((a, b) => a + b, 0) / first.length;
        const lastAvg = last.reduce((a, b) => a + b, 0) / last.length;

        const diff = lastAvg - firstAvg;
        const strength = Math.abs(diff) / 5; // Normalize to 0-1 range
        const direction = diff > 0 ? 'up' : diff < 0 ? 'down' : 'neutral';

        return { strength, direction };
    }

    /**
     * Calculate Shannon entropy (measure of randomness)
     */
    calculateEntropy(digits) {
        const counts = Array(10).fill(0);
        digits.forEach(d => counts[d]++);

        const total = digits.length;
        let entropy = 0;

        for (const count of counts) {
            if (count > 0) {
                const p = count / total;
                entropy -= p * Math.log2(p);
            }
        }

        // Normalize to 0-1 range (max entropy for 10 digits is log2(10) ≈ 3.32)
        return entropy / Math.log2(10);
    }


    getPrompt(modelName = 'unknown') {
        // Get model specific history
        const modelStats = this.modelPerformance[modelName] || {};
        const lastPred = modelStats.lastPrediction !== undefined ? modelStats.lastPrediction : 'None';
        const lastOutcome = modelStats.lastOutcome !== undefined ? modelStats.lastOutcome : 'None';

        // Recent methods used
        const recentMethods = this.tradeMethod.slice(-5).join(', ');

        // Detect market regime
        const marketRegime = this.detectMarketRegime(this.tickHistory);

        // Calculate volatility
        const volatility = this.calculateVolatility(this.tickHistory);

        // Perform comprehensive statistical analysis
        const comprehensiveAnalysis = this.tickHistory.length >= 100
            ? this.performComprehensiveAnalysis(this.tickHistory, 100)
            : null;

        // Prepare market data for EnhancedAIPrompt
        const marketData = {
            currentAsset: this.currentAsset,
            tickHistory: this.tickHistory,
            lastPrediction: lastPred,
            lastOutcome: lastOutcome,
            consecutiveLosses: this.consecutiveLosses,
            recentMethods: recentMethods,
            volatility: volatility,
            marketRegime: marketRegime,
            comprehensiveAnalysis: comprehensiveAnalysis // Add full statistical analysis
        };

        // Use EnhancedAIPrompt for better adversarial-aware predictions
        return EnhancedAIPrompt.generatePrompt(marketData, this.modelPerformance, {});
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
                contents: [{ parts: [{ text: this.getPrompt('gemini') }] }],
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
                model: 'groq/compound',//'groq/compound-mini',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt('groq') }
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
                    { role: 'user', content: this.getPrompt('openrouter') }
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
                    { role: 'user', content: this.getPrompt('mistral') }
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
                model: 'zai-glm-4.6',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt('cerebras') }
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
        return this.parseAIResponse(text, 'cerebras');
    }

    // NEW: SambaNova (free tier)
    async predictWithSambaNova() {
        const key = this.aiModels.sambanova.key;
        if (!key) throw new Error('No SambaNova API key');

        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',//'https://gen.pollinations.ai/v1/chat/completions',//'https://api.sambanova.ai/v1/chat/completions',
            {
                model: 'llama-3.3-70b-versatile',//'perplexity-fast',//'Meta-Llama-3.1-8B-Instruct',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt('sambanova') }
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
                    { role: 'user', content: this.getPrompt('qwen') }
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
                model: 'moonshotai/kimi-k2-instruct-0905',//'gemini-fast',//'kwaipilot/kat-coder-pro:free',//'moonshot-v1-8k',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt('kimi') }
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
                    { role: 'user', content: this.getPrompt('siliconflow') }
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

        // Apply volatility adjustment to stake if enough history
        let adjustedStake = this.currentStake;

        if (this.tickHistory.length >= 100) {
            const currentVolatility = this.calculateVolatility(this.tickHistory.slice(-50));
            const averageVolatility = this.calculateVolatility(this.tickHistory.slice(-100));

            if (currentVolatility > 0 && averageVolatility > 0) {
                adjustedStake = this.calculateVolatilityAdjustedStake(
                    this.currentStake,
                    currentVolatility,
                    averageVolatility
                );

                if (adjustedStake !== this.currentStake) {
                    console.log(`📊 Volatility Adjustment: $${this.currentStake.toFixed(2)} → $${adjustedStake.toFixed(2)}`);
                }
            }
        }

        // Ensure stake is within limits
        adjustedStake = Math.max(1, Math.min(adjustedStake, this.balance * 0.1));

        console.log(`\n💰 Placing trade: DIFFER ${digit} @ $${adjustedStake.toFixed(2)} (${confidence}% confidence)`);

        this.sendRequest({
            buy: 1,
            price: adjustedStake,
            parameters: {
                amount: adjustedStake,
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
        const exitSpot = contract.exit_tick_display_value;
        this.actualDigit = this.getLastDigit(exitSpot, this.currentAsset);

        console.log('\n' + '='.repeat(40));
        console.log(won ? '🎉 TRADE WON!' : '😔 TRADE LOST');
        console.log(`   Predicted: ${this.lastPrediction} | Actual: ${this.actualDigit}`);
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

        // Update model specific performance
        for (const key in this.modelPerformance) {
            const stats = this.modelPerformance[key];
            const currentPred = stats.currentPrediction;

            if (currentPred !== null && currentPred !== undefined) {
                // Differ trade: Won if Prediction != Actual
                // AI predicts the digit that will NOT appear.
                // So if AI says "5" and Actual is "8", AI wins.
                // If AI says "5" and Actual is "5", AI loses.
                const modelWon = currentPred !== this.actualDigit;

                stats.lastPrediction = currentPred;
                stats.lastOutcome = modelWon ? 'WON' : 'LOST';

                if (modelWon) stats.wins++;
                else stats.losses++;

                // Clear current prediction
                stats.currentPrediction = null;
            }
        }

        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
            this.consecutiveWins++; // Track wins for Anti-Martingale
            this.lastTradeResult = 'won';

            // Use Anti-Martingale: increase stake after wins (safer than Martingale)
            this.currentStake = this.calculateAntiMartingaleStake(
                'won',
                this.currentStake,
                this.config.baseStake,
                this.consecutiveWins
            );

            // Track winning pattern
            const pattern = this.tickHistory.slice(-5).join('');
            this.winningPatterns.set(pattern, (this.winningPatterns.get(pattern) || 0) + 1);
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.consecutiveWins = 0; // Reset win streak
            this.lastTradeResult = 'lost';

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;

            // REPLACED DANGEROUS MARTINGALE WITH KELLY CRITERION
            // Calculate win rate from history
            const winRate = this.totalTrades > 0 ? this.totalWins / this.totalTrades : 0.5;
            const payout = 1.1; // Typical payout for digit differ

            // Use Kelly Criterion for optimal position sizing
            this.currentStake = this.calculateKellyStake(
                winRate,
                payout,
                this.balance,
                this.config.maxStakePercent
            );

            // Ensure stake doesn't exceed balance limits
            this.currentStake = Math.min(
                this.currentStake,
                this.balance * (this.config.maxStakePercent / 100)
            );

            console.log(`📊 Kelly Criterion Stake: $${this.currentStake.toFixed(2)} (Win Rate: ${(winRate * 100).toFixed(1)}%)`);
        }

        // Track trade in history
        this.tradingHistory.push({
            timestamp: Date.now(),
            asset: this.currentAsset,
            predicted: this.lastPrediction,
            actual: this.actualDigit,
            result: won ? 'won' : 'lost',
            profit: profit,
            stake: this.currentStake,
            confidence: this.lastConfidence
        });

        // this.RestartTrading = false;

        // Send Telegram notification for loss
        if (!won && this.telegramEnabled) {
            this.sendTelegramLossAlert(this.actualDigit, profit);
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

        // Send telegram notification if configured
        if (this.telegramEnabled) {
            this.sendTelegramMessage(`<b>⏹ Bot Stopped</b>\n\n${this.getTelegramSummary()}`);
        }
    }

    getSessionDuration() {
        const now = new Date();
        const diff = now - this.sessionStartTime;
        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        return `${hours}h ${minutes}m`;
    }

    getTelegramSummary() {
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;

        return `<b>Trading Session Summary</b>
━━━━━━━━━━━━━━━━━━━━━━━━
📊 <b>Total Trades:</b> ${this.totalTrades}
✅ <b>Wins:</b> ${this.totalWins}
❌ <b>Losses:</b> ${this.totalLosses}
� <b>Win Rate:</b> ${winRate}%

<b>x2 Losses:</b> ${this.consecutiveLosses2}
<b>x3 Losses:</b> ${this.consecutiveLosses3}
<b>x4 Losses:</b> ${this.consecutiveLosses4}
<b>x5 Losses:</b> ${this.consecutiveLosses5}

💰 <b>Total P/L:</b> $${this.totalPnL.toFixed(2)}
🏦 <b>Final Balance:</b> $${this.balance.toFixed(2)}`;
    }

    async sendTelegramMessage(message) {
        if (!this.telegramEnabled || !this.telegramBot) return;

        try {
            await this.telegramBot.sendMessage(this.telegramChatId, message, { parse_mode: 'HTML' });
            console.log('� Telegram notification sent');
        } catch (error) {
            console.error('❌ Failed to send Telegram message:', error.message);
        }
    }

    startTelegramTimer() {
        // Send summary every 30 minutes
        setInterval(() => {
            if (this.totalTrades > 0 && !this.isShuttingDown) {
                this.sendTelegramMessage(`📊 <b>Regular Performance Summary</b>\n\n${this.getTelegramSummary()}`);
            }
        }, 30 * 60 * 1000);
    }

    async sendTelegramLossAlert(actualDigit, profit) {
        let riskWarning = '';
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses - 1) {
            riskWarning = `\n⚠️ <b>CRITICAL RISK:</b> ${this.consecutiveLosses} consecutive losses! Next loss will trigger STOP.`;
        }

        const body = `🚨 <b>TRADE LOSS ALERT</b>
━━━━━━━━━━━━━━━━━━━━━━━━
<b>Asset:</b> <code>${this.currentAsset}</code>
<b>Prediction:</b> ${this.lastPrediction}
<b>Actual Digit:</b> ${actualDigit}
<b>Loss:</b> -$${Math.abs(profit).toFixed(2)}

<b>Consecutive Losses:</b> ${this.consecutiveLosses} / ${this.config.maxConsecutiveLosses}${riskWarning}

<b>x2 Losses:</b> ${this.consecutiveLosses2}
<b>x3 Losses:</b> ${this.consecutiveLosses3}
<b>x4 Losses:</b> ${this.consecutiveLosses4}
<b>x5 Losses:</b> ${this.consecutiveLosses5}

<b>Current Balance:</b> $${this.balance.toFixed(2)}
<b>Total P/L:</b> $${this.totalPnL.toFixed(2)}

<b>Session Stats:</b>
Wins: ${this.totalWins} | Losses: ${this.totalLosses}`;

        await this.sendTelegramMessage(body);
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
