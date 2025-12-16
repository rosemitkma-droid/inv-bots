const WebSocket = require('ws');
const nodemailer = require('nodemailer');

// ============================================
// REFACTORED CHAOS DETECTION SYSTEM
// ============================================

class ChaosDetector {
    constructor() {
        // Adaptive thresholds with exponential moving averages
        this.ema = {
            sampleEntropy: null,
            hurstExponent: null,
            permEntropy: null,
            varianceRatio: null,
            alpha: 0.1 // smoothing factor
        };

        // Chaos state tracking
        this.chaosHistory = [];
        this.maxHistoryLength = 20;
    }

    /**
     * Main chaos analysis function
     * Returns comprehensive chaos assessment
     */
    analyzeChaos(tickHistory) {
        const minLength = 20;
        if (!tickHistory || tickHistory.length < minLength) {
            return {
                isChaotic: false,
                confidence: 0,
                shouldTrade: false,
                reason: 'Insufficient data',
                metrics: null
            };
        }

        // Use last 300 ticks for analysis (balance between recency and statistical power)
        const data = tickHistory.slice(-Math.min(20, tickHistory.length));

        // Calculate multiple chaos indicators
        const metrics = {
            sampleEntropy: this.calculateSampleEntropy(data),
            hurstExponent: this.calculateHurstExponent(data),
            permutationEntropy: this.calculatePermutationEntropy(data),
            varianceRatio: this.calculateVarianceRatio(data),
            trendStrength: this.calculateTrendStrength(data),
            volatilityRegime: this.detectVolatilityRegime(data)
        };

        // Update exponential moving averages for adaptive thresholds
        this.updateEMA(metrics);

        // Compute chaos score using weighted combination
        const chaosScore = this.computeChaosScore(metrics);

        // Determine if market is chaotic
        const isChaotic = this.isChaotic(metrics, chaosScore);

        // Track chaos state history
        this.updateChaosHistory(isChaotic);

        // Calculate confidence based on consistency
        const confidence = this.calculateConfidence(metrics, chaosScore);

        return {
            isChaotic,
            confidence,
            shouldTrade: !isChaotic && confidence >= 0.4,
            chaosScore,
            metrics,
            consistency: this.getConsistencyScore(),
            reason: this.getReasonString(metrics, isChaotic)
        };
    }

    /**
     * Sample Entropy - measures unpredictability
     * Higher values = more chaotic/random
     * Range: 0 to ~2.5 for this application
     */
    calculateSampleEntropy(data, m = 2, r = null) {
        const N = data.length;
        if (N < 10) return 0;

        // Auto-compute tolerance if not provided (0.2 * std dev)
        if (r === null) {
            const std = Math.sqrt(this.variance(data));
            r = 0.2 * std;
        }

        const matches = (template, maxDist) => {
            let count = 0;
            for (let i = 0; i <= N - template.length; i++) {
                let dist = 0;
                let valid = true;
                for (let j = 0; j < template.length; j++) {
                    dist = Math.max(dist, Math.abs(data[i + j] - template[j]));
                    if (dist > maxDist) {
                        valid = false;
                        break;
                    }
                }
                if (valid) count++;
            }
            return count;
        };

        let A = 0, B = 0;
        const limit = N - m;

        for (let i = 0; i < limit; i++) {
            const templateM = data.slice(i, i + m);
            const templateM1 = data.slice(i, i + m + 1);

            const countB = matches(templateM, r);
            const countA = matches(templateM1, r);

            if (countB > 1) B += Math.log((countB - 1) / (N - m));
            if (countA > 0) A += Math.log(countA / (N - m));
        }

        const sampEn = -A / limit + B / limit;
        return isFinite(sampEn) && sampEn >= 0 ? sampEn : 0;
    }

    /**
     * Hurst Exponent (R/S method)
     * H < 0.5: Anti-persistent/Mean-reverting (CHAOTIC)
     * H = 0.5: Random walk
     * H > 0.5: Persistent/Trending (PREDICTABLE)
     */
    calculateHurstExponent(data) {
        const N = data.length;
        if (N < 20) return 0.5;

        // Calculate mean
        const mean = data.reduce((a, b) => a + b, 0) / N;

        // Calculate cumulative deviations
        const deviations = [];
        let cumSum = 0;
        for (let i = 0; i < N; i++) {
            cumSum += data[i] - mean;
            deviations.push(cumSum);
        }

        // Calculate range
        const R = Math.max(...deviations) - Math.min(...deviations);

        // Calculate standard deviation
        const S = Math.sqrt(this.variance(data));

        if (S === 0) return 0.5;

        // R/S ratio for different window sizes
        const minWindow = 10;
        const maxWindow = Math.floor(N / 4);
        const windows = [];
        const rs = [];

        for (let w = minWindow; w <= maxWindow; w += Math.max(1, Math.floor((maxWindow - minWindow) / 10))) {
            const numSegments = Math.floor(N / w);
            if (numSegments < 2) continue;

            let rsSum = 0;
            for (let seg = 0; seg < numSegments; seg++) {
                const segment = data.slice(seg * w, (seg + 1) * w);
                const segMean = segment.reduce((a, b) => a + b, 0) / w;

                let cumDev = 0;
                const segDevs = [];
                for (let i = 0; i < w; i++) {
                    cumDev += segment[i] - segMean;
                    segDevs.push(cumDev);
                }

                const segR = Math.max(...segDevs) - Math.min(...segDevs);
                const segS = Math.sqrt(this.variance(segment));

                if (segS > 0) {
                    rsSum += segR / segS;
                }
            }

            windows.push(Math.log(w));
            rs.push(Math.log(rsSum / numSegments));
        }

        if (windows.length < 3) return 0.5;

        // Linear regression to find Hurst exponent
        const H = this.linearRegression(windows, rs).slope;

        // Clamp between 0 and 1
        return Math.max(0, Math.min(1, H));
    }

    /**
     * Permutation Entropy - fast and robust chaos indicator
     * Higher values = more random/chaotic
     * Range: 0 to log(d!)
     */
    calculatePermutationEntropy(data, d = 3, tau = 1) {
        const N = data.length;
        if (N < d * tau + 1) return 0;

        const patterns = new Map();

        for (let i = 0; i <= N - d * tau; i++) {
            // Extract pattern
            const indices = [];
            for (let j = 0; j < d; j++) {
                indices.push(data[i + j * tau]);
            }

            // Convert to ordinal pattern
            const sorted = indices.map((v, idx) => ({ v, idx }))
                .sort((a, b) => a.v - b.v);
            const pattern = sorted.map(x => x.idx).join(',');

            patterns.set(pattern, (patterns.get(pattern) || 0) + 1);
        }

        // Calculate entropy
        const total = N - d * tau + 1;
        let entropy = 0;
        for (const count of patterns.values()) {
            const p = count / total;
            entropy -= p * Math.log(p);
        }

        // Normalize by maximum possible entropy
        const maxEntropy = Math.log(this.factorial(d));
        return maxEntropy > 0 ? entropy / maxEntropy : 0;
    }

    /**
     * Variance Ratio Test - detects random walk vs predictable patterns
     * Ratio near 1 = random walk (chaotic)
     * Ratio >> 1 or << 1 = predictable patterns
     */
    calculateVarianceRatio(data, q = 5) {
        const N = data.length;
        if (N < q * 2) return 1;

        // Calculate returns
        const returns = [];
        for (let i = 1; i < N; i++) {
            returns.push(data[i] - data[i - 1]);
        }

        // Variance of 1-period returns
        const var1 = this.variance(returns);
        if (var1 === 0) return 1;

        // Variance of q-period returns
        const qReturns = [];
        for (let i = q; i < N; i++) {
            qReturns.push(data[i] - data[i - q]);
        }
        const varQ = this.variance(qReturns);

        // Variance ratio
        const vr = varQ / (q * var1);
        return isFinite(vr) ? vr : 1;
    }

    /**
     * Trend Strength - measures directional persistence
     * Low values = erratic/chaotic movement
     */
    calculateTrendStrength(data) {
        if (data.length < 10) return 0;

        const window = Math.min(20, Math.floor(data.length / 2));
        const recent = data.slice(-window);

        // Simple linear regression slope
        const indices = Array.from({ length: window }, (_, i) => i);
        const { slope, r2 } = this.linearRegression(indices, recent);

        // Normalize by data range
        const range = Math.max(...recent) - Math.min(...recent);
        const normalizedSlope = range > 0 ? Math.abs(slope) / range : 0;

        // Combine slope magnitude with R²
        return normalizedSlope * r2;
    }

    /**
     * Volatility Regime Detection
     * Returns: 'low', 'medium', 'high', or 'extreme'
     */
    detectVolatilityRegime(data) {
        if (data.length < 20) return 'unknown';

        const window = Math.min(50, data.length);
        const recent = data.slice(-window);

        // Calculate rolling standard deviation
        const std = Math.sqrt(this.variance(recent));

        // Calculate coefficient of variation
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const cv = mean !== 0 ? std / Math.abs(mean) : 0;

        if (cv < 0.15) return 'low';
        if (cv < 0.35) return 'medium';
        if (cv < 0.60) return 'high';
        return 'extreme';
    }

    /**
     * Compute overall chaos score (0-1 scale)
     */
    computeChaosScore(metrics) {
        // Normalize each metric to 0-1 chaos scale
        const sampleEntropyScore = Math.min(1, metrics.sampleEntropy / 2.0);

        // Invert Hurst: low Hurst = high chaos
        const hurstScore = metrics.hurstExponent < 0.5
            ? (0.5 - metrics.hurstExponent) * 2
            : 0;

        const permEntropyScore = metrics.permutationEntropy;

        // Variance ratio near 1 = chaos
        const vrScore = Math.max(0, 1 - Math.abs(metrics.varianceRatio - 1));

        // Low trend strength = chaos
        const trendScore = 1 - Math.min(1, metrics.trendStrength * 2);

        // Volatility contribution
        const volScore = {
            'low': 0.2,
            'medium': 0.4,
            'high': 0.7,
            'extreme': 1.0,
            'unknown': 0.5
        }[metrics.volatilityRegime];

        // Weighted combination
        const chaosScore = (
            0.30 * sampleEntropyScore +
            0.25 * hurstScore +
            0.20 * permEntropyScore +
            0.10 * vrScore +
            0.10 * trendScore +
            0.05 * volScore
        );

        return Math.max(0, Math.min(1, chaosScore));
    }

    /**
     * Determine if market is chaotic based on multiple criteria
     */
    isChaotic(metrics, chaosScore) {
        // Primary: Chaos score threshold
        if (chaosScore > 0.70) return true;

        // Secondary: Multiple indicators agreement
        const indicators = [];

        // Sample entropy threshold
        indicators.push(metrics.sampleEntropy > 1.5);

        // Hurst exponent (anti-persistent)
        indicators.push(metrics.hurstExponent < 0.45);

        // Permutation entropy threshold
        indicators.push(metrics.permutationEntropy > 0.85);

        // Variance ratio (random walk)
        indicators.push(Math.abs(metrics.varianceRatio - 1) < 0.15);

        // Weak or no trend
        indicators.push(metrics.trendStrength < 0.15);

        // High/extreme volatility
        indicators.push(['high', 'extreme'].includes(metrics.volatilityRegime));

        // If 4 or more indicators agree on chaos
        const agreeCount = indicators.filter(x => x).length;
        if (agreeCount >= 4) return true;

        // Moderate chaos score with some agreement
        if (chaosScore > 0.60 && agreeCount >= 3) return true;

        return false;
    }

    /**
     * Calculate confidence based on metric consistency
     */
    calculateConfidence(metrics, chaosScore) {
        // Check consistency across metrics
        const normalized = [
            Math.min(1, metrics.sampleEntropy / 2.0),
            metrics.hurstExponent < 0.5 ? (0.5 - metrics.hurstExponent) * 2 : 0,
            metrics.permutationEntropy,
            Math.max(0, 1 - Math.abs(metrics.varianceRatio - 1)),
            1 - Math.min(1, metrics.trendStrength * 2)
        ];

        // Calculate variance of normalized scores
        const mean = normalized.reduce((a, b) => a + b, 0) / normalized.length;
        const variance = normalized.reduce((sum, val) =>
            sum + Math.pow(val - mean, 2), 0) / normalized.length;

        // Low variance = high consistency = high confidence
        const consistency = Math.exp(-5 * variance);

        // Historical consistency
        const historyConsistency = this.getConsistencyScore();

        // Combine current and historical
        return 0.6 * consistency + 0.4 * historyConsistency;
    }

    /**
     * Update exponential moving averages for adaptive thresholds
     */
    updateEMA(metrics) {
        const alpha = this.ema.alpha;

        for (const key in metrics) {
            if (typeof metrics[key] === 'number' && isFinite(metrics[key])) {
                if (this.ema[key] === null) {
                    this.ema[key] = metrics[key];
                } else {
                    this.ema[key] = alpha * metrics[key] + (1 - alpha) * this.ema[key];
                }
            }
        }
    }

    /**
     * Track chaos state history
     */
    updateChaosHistory(isChaotic) {
        this.chaosHistory.push(isChaotic ? 1 : 0);
        if (this.chaosHistory.length > this.maxHistoryLength) {
            this.chaosHistory.shift();
        }
    }

    /**
     * Get consistency score from history
     */
    getConsistencyScore() {
        if (this.chaosHistory.length < 5) return 0.5;

        const recent = this.chaosHistory.slice(-10);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;

        // Calculate consistency (how close to pure 0 or 1)
        const consistency = 1 - 2 * Math.abs(mean - 0.5);
        return Math.max(0, Math.min(1, consistency));
    }

    /**
     * Get human-readable reason
     */
    getReasonString(metrics, isChaotic) {
        if (!isChaotic) {
            if (metrics.hurstExponent > 0.6 && metrics.trendStrength > 0.3) {
                return 'Strong trend detected - favorable for trading';
            }
            if (metrics.sampleEntropy < 1.0 && metrics.permutationEntropy < 0.7) {
                return 'Regular patterns detected - predictable market';
            }
            return 'Market shows predictable structure';
        } else {
            if (metrics.hurstExponent < 0.4) {
                return 'Anti-persistent behavior - highly chaotic';
            }
            if (metrics.volatilityRegime === 'extreme') {
                return 'Extreme volatility - unpredictable market';
            }
            if (metrics.sampleEntropy > 1.8) {
                return 'High randomness detected - avoid trading';
            }
            return 'Multiple chaos indicators active';
        }
    }

    // ========== UTILITY FUNCTIONS ==========

    variance(data) {
        if (data.length === 0) return 0;
        const mean = data.reduce((a, b) => a + b, 0) / data.length;
        return data.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / data.length;
    }

    linearRegression(x, y) {
        const n = x.length;
        if (n === 0) return { slope: 0, intercept: 0, r2: 0 };

        const sumX = x.reduce((a, b) => a + b, 0);
        const sumY = y.reduce((a, b) => a + b, 0);
        const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
        const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
        const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const intercept = (sumY - slope * sumX) / n;

        // Calculate R²
        const meanY = sumY / n;
        const ssTotal = y.reduce((sum, yi) => sum + Math.pow(yi - meanY, 2), 0);
        const ssResidual = y.reduce((sum, yi, i) =>
            sum + Math.pow(yi - (slope * x[i] + intercept), 2), 0);
        const r2 = ssTotal > 0 ? 1 - (ssResidual / ssTotal) : 0;

        return {
            slope: isFinite(slope) ? slope : 0,
            intercept: isFinite(intercept) ? intercept : 0,
            r2: isFinite(r2) ? Math.max(0, r2) : 0
        };
    }

    factorial(n) {
        if (n <= 1) return 1;
        let result = 1;
        for (let i = 2; i <= n; i++) {
            result *= i;
        }
        return result;
    }
}


// EnhancedDerivTradingBot class with Advanced Pattern Recognition
class EnhancedDerivTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.assets = [
            'R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR', '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V', 'JD10', 'JD25', 'JD50', 'JD75', 'JD100',
            // 'RDBEAR'
        ];

        this.config = {
            initialStake: config.initialStake,
            multiplier: config.multiplier,
            maxConsecutiveLosses: config.maxConsecutiveLosses,
            takeProfit: config.takeProfit,
        };

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
        this.tickHistory = [];
        this.tradeInProgress = false;
        this.wsReady = false;
        this.predictedDigit = null;
        this.Percentage = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.Pause = false;
        this.RestartTrading = true;
        this.endOfDay = false;
        this.requiredHistoryLength = Math.floor(Math.random() * 4981) + 20; //Random history length (20 to 5000)
        this.kCount = false;
        this.kCountNum = 0;
        this.kLoss = 0;
        this.multiplier2 = false;
        this.confidenceThreshold = null;
        this.kTradeCount = 0;
        this.isWinTrade = true;
        this.waitTime = 0;
        this.LossDigitsList = [];
        this.threeConsecutiveDigits = 0;
        this.kTrade = false;
        this.xDigit = null;
        this.kChaos = null;
        this.scanChaos = false;

        this.chaosDetector = new ChaosDetector();// Instantiate chaos detector

        // WebSocket management
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10000;
        this.reconnectInterval = 5000;
        this.tickSubscriptionId = null;

        // Email configuration
        this.emailConfig = {
            service: 'gmail',
            auth: {
                user: 'kenzkdp2@gmail.com',
                pass: 'jfjhtmussgfpbgpk'
            }
        };
        this.emailRecipient = 'kenotaru@gmail.com';
        this.startEmailTimer();
    }

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
            console.log('Trade placed successfully');
            this.currentTradeId = message.buy.contract_id;
            this.subscribeToOpenContract(this.currentTradeId);
        } else if (message.msg_type === 'proposal_open_contract') {
            if (message.error) {
                console.error('Error receiving contract update:', message.error.message);
                return;
            }
            this.handleContractUpdate(message.proposal_open_contract);
        } else if (message.msg_type === 'forget') {
            console.log('Successfully unsubscribed from ticks');
            this.tickSubscriptionId = null;
        } else if (message.subscription && message.msg_type === 'tick') {
            this.tickSubscriptionId = message.subscription.id;
            console.log(`Subscribed to ticks. Subscription ID: ${this.tickSubscriptionId}`);
        } else if (message.error) {
            this.handleApiError(message.error);
        }
    }

    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V',].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

    startTrading() {
        console.log('Starting trading...');
        this.tradeNextAsset();
    }

    tradeNextAsset() {
        if (this.usedAssets.size === this.assets.length) {
            this.usedAssets = new Set();
        }

        if (this.RestartTrading) {
            let availableAssets = this.assets.filter(asset => !this.usedAssets.has(asset));
            this.currentAsset = availableAssets[Math.floor(Math.random() * availableAssets.length)];
            this.usedAssets.add(this.currentAsset);
        }
        console.log(`Selected asset: ${this.currentAsset}`);

        this.unsubscribeFromTicks(() => {
            this.subscribeToTickHistory(this.currentAsset);
            this.subscribeToTicks(this.currentAsset);
        });

        this.RestartTrading = false;
    }

    handleTickHistory(history) {
        this.tickHistory = history.prices.map(price => this.getLastDigit(price, this.currentAsset));

    }

    handleTickUpdate(tick) {
        const lastDigit = this.getLastDigit(tick.quote, this.currentAsset);
        this.lastDigitsList.push(lastDigit);

        // Update tick history
        this.tickHistory.push(lastDigit);
        if (this.tickHistory.length > this.requiredHistoryLength) {
            this.tickHistory.shift();
        }

        console.log(`Recent tick History: ${this.tickHistory.slice(-5).join(', ')}`);

        // Enhanced logging
        if (!this.tradeInProgress) {
            this.analyzeTicksEnhanced();
        }
    }

    applyChaosTheory() {
        return this.chaosDetector.analyzeChaos(this.tickHistory);
    }


    analyzeTicksEnhanced() {
        if (this.tradeInProgress || this.tickHistory.length < 20) {
            return;
        }

        // Chaos theory application
        const chaosAnalysis = this.applyChaosTheory();

        if (!chaosAnalysis || !chaosAnalysis.metrics) {
            // console.log('Chaos analysis: insufficient data');
            // return;
        }

        // Log comprehensive analysis
        // console.log('\n=== CHAOS ANALYSIS ===');
        // console.log(`Chaos Score: ${(chaosAnalysis.chaosScore * 100).toFixed(1)}%`);
        // console.log(`Market State: ${chaosAnalysis.isChaotic ? '🔴 CHAOTIC' : '🟢 PREDICTABLE'}`);
        // console.log(`Confidence: ${(chaosAnalysis.confidence * 100).toFixed(1)}%`);
        // console.log(`Should Trade: ${chaosAnalysis.shouldTrade ? 'YES ✓' : 'NO ✗'}`);
        // console.log(`Reason: ${chaosAnalysis.reason}`);
        // console.log('\nMetrics:');
        // console.log(`  Sample Entropy: ${chaosAnalysis.metrics.sampleEntropy.toFixed(3)}`);
        // console.log(`  Hurst Exponent: ${chaosAnalysis.metrics.hurstExponent.toFixed(3)}`);
        // console.log(`  Perm Entropy: ${chaosAnalysis.metrics.permutationEntropy.toFixed(3)}`);
        // console.log(`  Variance Ratio: ${chaosAnalysis.metrics.varianceRatio.toFixed(3)}`);
        // console.log(`  Trend Strength: ${chaosAnalysis.metrics.trendStrength.toFixed(3)}`);
        // console.log(`  Volatility: ${chaosAnalysis.metrics.volatilityRegime}`);
        // console.log('====================\n');

        // // Only proceed with trading logic if market is not chaotic
        // if (!chaosAnalysis.shouldTrade) {
        //     console.log('⚠️  Market too chaotic - skipping trade analysis');
        //     return;
        // }

        // Least-occurring digit logic 
        const tickHistory2 = this.tickHistory;
        const digitCounts = Array(10).fill(0);
        tickHistory2.forEach(digit => digitCounts[digit]++);

        let leastOccurringDigit = null;
        let minCount = Infinity;
        digitCounts.forEach((count, digit) => {
            if (count < minCount) {
                minCount = count;
                leastOccurringDigit = digit;
            }
        });

        const leastPercentage = minCount;
        console.log(`Digit counts:`, digitCounts, '(', tickHistory2.length, 'ticks)');
        console.log('Least occurring digit:', leastOccurringDigit, `(${minCount} times)`);

        this.lastDigit = this.tickHistory[this.tickHistory.length - 1];

        if (
            // leastPercentage < 7 
            // && 
            // this.xLeastDigit !== leastOccurringDigit && 
            leastOccurringDigit !== this.lastDigit
            // && 
            // this.xLeastDigit !== null
        ) {

            this.xDigit = leastOccurringDigit;
            this.winProbNumber = leastPercentage;
            this.chaosLevel = (chaosAnalysis.chaosScore * 100).toFixed(1);
            this.kChaos = chaosAnalysis.isChaotic;

            this.placeTrade(this.xDigit, this.winProbNumber);
        }

        this.xLeastDigit = leastOccurringDigit;
    }


    placeTrade(predictedDigit, confidence) {
        if (this.tradeInProgress) {
            return;
        }

        this.tradeInProgress = true;

        console.log(`\n PLACING TRADE`);
        console.log(`Digit: ${predictedDigit} (${confidence}%)`);
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
        console.log(`   Predicted to differ from: ${this.xDigit} | Actual: ${actualDigit}`);
        console.log(`Profit/Loss: $${profit.toFixed(2)}`);

        this.totalTrades++;

        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;
        } else {
            this.isWinTrade = false;
            this.totalLosses++;
            this.consecutiveLosses++;

            if (this.consecutiveLosses === 2) {
                this.consecutiveLosses2++;
            } else if (this.consecutiveLosses === 3) {
                this.consecutiveLosses3++;
            } else if (this.consecutiveLosses === 4) {
                this.consecutiveLosses4++;
            } else if (this.consecutiveLosses === 5) {
                this.consecutiveLosses5++;
            }

            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;

            // this.RestartTrading = true; 
        }

        this.totalProfitLoss += profit;

        if (!won) {
            this.sendLossEmail();
        }

        this.Pause = true;

        this.RestartTrading = true;

        if (!this.endOfDay) {
            this.logTradingSummary();
        }

        this.regimCount = 0;
        this.kChaos = null;
        this.scanChaos = false;
        this.requiredHistoryLength = Math.floor(Math.random() * 4981) + 20; //Random history length (20 to 5000)

        // Take profit condition
        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('Take Profit Reached... Stopping trading.');
            this.endOfDay = true;
            this.sendDisconnectResumptionEmailSummary();
            this.disconnect();
            return;
        }

        // Check stopping conditions
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses ||
            this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('Stopping condition met. Disconnecting...');
            this.endOfDay = true;
            this.sendDisconnectResumptionEmailSummary();
            this.disconnect();
            return;
        }

        this.disconnect();

        if (!this.endOfDay) {
            this.waitTime = Math.floor(Math.random() * (1000 - 1000 + 1)) + 100000;
            console.log(`⏳ Waiting ${Math.round(this.waitTime / 1000)} seconds before next trade...\n`);
            setTimeout(() => {
                this.Pause = false;
                this.kTrade = false;
                this.connect();
            }, this.waitTime);
        }
    }

    unsubscribeFromTicks(callback) {
        if (this.tickSubscriptionId) {
            const request = {
                forget: this.tickSubscriptionId
            };
            this.sendRequest(request);
            console.log(`Unsubscribing from ticks with ID: ${this.tickSubscriptionId}`);

            this.ws.once('message', (data) => {
                const message = JSON.parse(data);
                if (message.msg_type === 'forget' && message.forget === this.tickSubscriptionId) {
                    console.log(`Unsubscribed from ticks successfully`);
                    this.tickSubscriptionId = null;
                    if (callback) callback();
                }
            });
        } else {
            if (callback) callback();
        }
    }

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            // Always use GMT +1 time regardless of server location
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000)); // Convert UTC → GMT+1
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();
            const currentDay = gmtPlus1Time.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

            // Optional: log current GMT+1 time for monitoring
            // console.log(
            // "Current GMT+1 time:",
            // gmtPlus1Time.toISOString().replace("T", " ").substring(0, 19)
            // );

            // Check if it's Sunday - no trading on Sundays
            if (currentDay === 0) {
                if (!this.endOfDay) {
                    console.log("It's Sunday, disconnecting the bot. No trading on Sundays.");
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
                return; // Skip all other checks on Sunday
            }

            // Check for Morning resume condition (7:00 AM GMT+1) - but not on Sunday
            if (this.endOfDay && currentHours === 7 && currentMinutes >= 0) {
                console.log("It's 7:00 AM GMT+1, reconnecting the bot.");
                this.LossDigitsList = [];
                this.tickHistory = [];
                this.regimCount = 0;
                this.kChaos = null;
                this.scanChaos = false;
                this.requiredHistoryLength = Math.floor(Math.random() * 4981) + 20; //Random
                this.tradeInProgress = false;
                this.RestartTrading = true;
                this.Pause = false;
                this.endOfDay = false;
                this.connect();
            }

            // Check for evening stop condition (after 5:00 PM GMT+1)
            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 17 && currentMinutes >= 0) {
                    console.log("It's past 5:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.sendDisconnectResumptionEmailSummary();
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 5000); // Check every 5 seconds
    }

    disconnect() {
        if (this.connected) {
            this.ws.close();
        }
    }

    logTradingSummary() {
        console.log('\n📈 TRADING SUMMARY 📈');
        console.log('═══════════════════════════════════════');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Won: ${this.totalWins} | Lost: ${this.totalLosses}`);
        console.log(`Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%`);
        console.log(`Consecutive Losses: x2:${this.consecutiveLosses2} x3:${this.consecutiveLosses3} x4:${this.consecutiveLosses4}`);
        console.log(`Total P/L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log('Predicted Digit:', this.xDigit);
        console.log('Percentage:', this.winProbNumber), '%';
        console.log(`Chaos Level: ${this.chaosLevel}`);
        console.log('Chaos:', this.kChaos, '(', this.regimCount, ')');
        console.log('═══════════════════════════════════════\n');
    }

    startEmailTimer() {
        setInterval(() => {
            if (!this.endOfDay) {
                this.sendEmailSummary();
            }
        }, 1800000); // 30 minutes
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
            subject: 'LF Deriv Differ Bot - Trading Summary',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // console.error('Email sending error:', error);
        }
    }

    async sendLossEmail() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const klastDigits = this.tickHistory.slice(-20);

        const summaryText = `
        LOSS ALERT - DETAILED ANALYSIS
        ===============================
        
        Trade Result: LOSS
        
        Performance Metrics:
        -------------------
        Total Trades: ${this.totalTrades}
        Won: ${this.totalWins} | Lost: ${this.totalLosses}
        Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
        Total P/L: $${this.totalProfitLoss.toFixed(2)}
        
        x2:${this.consecutiveLosses2} 
        x3:${this.consecutiveLosses3} 
        x4:${this.consecutiveLosses4}        
        
        Pattern Analysis:
        ----------------
        Asset: ${this.currentAsset}
        Predicted Digit: ${this.xDigit} | Actual Digit: ${this.actualDigit}
        Percentage: ${this.winProbNumber}%
        Chaos Level: ${this.chaosLevel}
        Chaos Details: ${this.kChaos} (${this.regimCount})
        
        Recent History:
        --------------
        Last 20 Digits: ${klastDigits.join(', ')}
        
        Current Stake: $${this.currentStake.toFixed(2)}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'LF Deriv Bot - Loss Alert',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // console.error('Email sending error:', error);
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'LF Deriv Bot - Error Report',
            text: `An error occurred in the trading bot: ${errorMessage}`
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // console.error('Error sending error email:', error);
        }
    }

    async sendDisconnectResumptionEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const now = new Date();
        const currentHours = now.getHours();
        const currentMinutes = now.getMinutes();

        const summaryText = `
        BOT STATUS UPDATE
        =================
        Time: ${currentHours}:${currentMinutes.toString().padStart(2, '0')}
        Status: ${this.endOfDay ? 'Day Trading Complete' : 'Session Update'}
        
        Final Performance:
        -----------------
        Total Trades: ${this.totalTrades}
        Won: ${this.totalWins} | Lost: ${this.totalLosses}
        Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
       
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        
        Financial Summary:
        -----------------
        Total P/L: $${this.totalProfitLoss.toFixed(2)}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'LF Deriv Bot - Status Update',
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
        this.checkTimeForDisconnectReconnect();
    }
}

// Usage
const bot = new EnhancedDerivTradingBot('0P94g4WdSrSrzir', {
    // 'DMylfkyce6VyZt7', '0P94g4WdSrSrzir'
    initialStake: 0.61,
    multiplier: 11.3,
    maxStake: 127,
    maxConsecutiveLosses: 3,
    stopLoss: 127,
    takeProfit: 100,
});

bot.start();
