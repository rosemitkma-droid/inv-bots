require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

class HybridSuperBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = config.assets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR'];

        this.config = {
            initialStake: config.initialStake || 0.61,
            multiplier: config.multiplier || 11.3,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 3,
            stopLoss: config.stopLoss || 129,
            takeProfit: config.takeProfit || 25,
            requiredHistoryLength: config.requiredHistoryLength || 1000,
            minWaitTime: config.minWaitTime || 120000,
            maxWaitTime: config.maxWaitTime || 180000,
        };

        // Trading state
        this.currentStake = this.config.initialStake;
        this.consecutiveLosses = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.tradeInProgress = false;
        this.suspendedAssets = new Set();
        this.endOfDay = false;

        // Tick data storage
        this.tickHistories = {};
        this.tickSubscriptionIds = {};
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
        });

        // ========== LAYER 1: ROTATION STRATEGIES (8 strategies) ==========
        this.rotationStrategies = [
            { name: 'Momentum Reversal', func: this.momentumReversalStrategy.bind(this) },
            { name: 'Frequency Gap', func: this.frequencyGapStrategy.bind(this) },
            { name: 'Pattern Sequence', func: this.patternSequenceStrategy.bind(this) },
            { name: 'Volatility', func: this.volatilityStrategy.bind(this) },
            { name: 'Markov Chain', func: this.markovChainStrategy.bind(this) },
            { name: 'Entropy', func: this.entropyStrategy.bind(this) },
            { name: 'Cluster Avoidance', func: this.clusterAvoidanceStrategy.bind(this) },
            { name: 'Adaptive Streak', func: this.adaptiveStreakStrategy.bind(this) }
        ];
        this.currentRotationIndex = 0;

        // ========== LAYER 2: AI ENSEMBLE (5 strategies with weights) ==========
        this.ensembleStrategies = {
            'statistical': { func: this.statisticalStrategy.bind(this), wins: 0, total: 0, weight: 1.0 },
            'neural': { func: this.neuralStrategy.bind(this), wins: 0, total: 0, weight: 1.0 },
            'chaos': { func: this.chaosStrategy.bind(this), wins: 0, total: 0, weight: 1.0 },
            'regression': { func: this.regressionStrategy.bind(this), wins: 0, total: 0, weight: 1.0 },
            'bayesian': { func: this.bayesianStrategy.bind(this), wins: 0, total: 0, weight: 1.0 },
        };

        // ========== LAYER 3: QUANTUM PATTERNS (10 pattern detectors) ==========
        this.patternLibrary = {
            zigzag: this.detectZigZag.bind(this),
            consecutive: this.detectConsecutive.bind(this),
            mirror: this.detectMirror.bind(this),
            fibonacci: this.detectFibonacci.bind(this),
            prime: this.detectPrime.bind(this),
            evenOdd: this.detectEvenOdd.bind(this),
            palindrome: this.detectPalindrome.bind(this),
            ascending: this.detectAscending.bind(this),
            descending: this.detectDescending.bind(this),
            repeating: this.detectRepeating.bind(this),
        };

        // Quantum state
        this.quantumState = {
            mode: 'superposition',
            phase: 0,
            amplitude: 1.0
        };

        // ========== META-LAYER: HYBRID ORCHESTRATION ==========
        this.metaLayer = {
            layerWeights: {
                rotation: 0.33,
                ensemble: 0.33,
                quantum: 0.34
            },
            layerPerformance: {
                rotation: { wins: 0, total: 0 },
                ensemble: { wins: 0, total: 0 },
                quantum: { wins: 0, total: 0 }
            },
            lastUsedLayer: null,
            consensusThreshold: 0.9, // 90% agreement needed for high confidence
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
    }

    connect() {
        console.log('🚀 Connecting Hybrid Super Bot to Deriv API...');
        this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ Connected to Deriv API');
            this.connected = true;
            this.wsReady = true;
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
            this.handleDisconnect();
        });
    }

    sendRequest(request) {
        if (this.connected && this.wsReady) {
            this.ws.send(JSON.stringify(request));
        }
    }

    authenticate() {
        this.sendRequest({ authorize: this.token });
    }

    handleMessage(message) {
        if (message.msg_type === 'authorize') {
            if (message.error) {
                console.error('Authentication failed:', message.error.message);
                return;
            }
            console.log('✅ Authenticated successfully');
            this.initializeSubscriptions();
        } else if (message.msg_type === 'history') {
            const asset = message.echo_req.ticks_history;
            this.handleTickHistory(asset, message.history);
        } else if (message.msg_type === 'tick') {
            if (message.subscription) {
                const asset = message.tick.symbol;
                this.tickSubscriptionIds[asset] = message.subscription.id;
            }
            this.handleTickUpdate(message.tick);
        } else if (message.msg_type === 'buy') {
            if (message.error) {
                console.error('Error placing trade:', message.error.message);
                this.tradeInProgress = false;
                return;
            }
            console.log('✅ Trade placed successfully');
            this.subscribeToOpenContract(message.buy.contract_id);
        } else if (message.msg_type === 'proposal_open_contract') {
            if (message.proposal_open_contract.is_sold) {
                this.handleTradeResult(message.proposal_open_contract);
            }
        }
    }

    initializeSubscriptions() {
        console.log('Initializing subscriptions...');
        this.assets.forEach(asset => {
            this.sendRequest({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });
            this.sendRequest({
                ticks: asset,
                subscribe: 1
            });
        });
    }

    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['R_75', 'R_50', 'RDBULL', 'RDBEAR'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25'].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

    handleTickHistory(asset, history) {
        this.tickHistories[asset] = history.prices.map(price => this.getLastDigit(price, asset));
        console.log(`📊 Loaded ${this.tickHistories[asset].length} ticks for ${asset}`);
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const lastDigit = this.getLastDigit(tick.quote, asset);

        this.tickHistories[asset].push(lastDigit);
        if (this.tickHistories[asset].length > this.config.requiredHistoryLength) {
            this.tickHistories[asset].shift();
        }

        console.log(`[${asset}] ${tick.quote}: ${this.tickHistories[asset].slice(-5).join(', ')}`);

        if (this.tickHistories[asset].length >= this.config.requiredHistoryLength && 
            !this.tradeInProgress && 
            !this.suspendedAssets.has(asset)) {
            this.analyzeTicks(asset);
        }
    }

    // ==================== LAYER 1: ROTATION STRATEGIES ====================
    momentumReversalStrategy(history) {
        const recent = history.slice(-30);
        const digitCounts = Array(10).fill(0);
        recent.forEach(d => digitCounts[d]++);
        const maxCount = Math.max(...digitCounts);
        const hotDigits = digitCounts.map((c, i) => c === maxCount ? i : -1).filter(d => d !== -1);
        return hotDigits[Math.floor(Math.random() * hotDigits.length)];
    }

    frequencyGapStrategy(history) {
        const lastSeen = Array(10).fill(-1);
        history.forEach((digit, idx) => {
            lastSeen[digit] = idx;
        });
        let maxGap = -1;
        let targetDigit = 0;
        lastSeen.forEach((lastIdx, digit) => {
            const gap = history.length - 1 - lastIdx;
            if (gap > maxGap) {
                maxGap = gap;
                targetDigit = digit;
            }
        });
        return targetDigit;
    }

    patternSequenceStrategy(history) {
        const last10 = history.slice(-10);
        const digitCounts = Array(10).fill(0);
        last10.forEach((d, idx) => {
            digitCounts[d] += (idx + 1);
        });
        return digitCounts.indexOf(Math.max(...digitCounts));
    }

    volatilityStrategy(history) {
        const windows = [20, 50, 100];
        const volatility = Array(10).fill(0);
        windows.forEach(windowSize => {
            const window = history.slice(-windowSize);
            const counts = Array(10).fill(0);
            window.forEach(d => counts[d]++);
            counts.forEach((count, digit) => {
                volatility[digit] += Math.abs(count - windowSize / 10);
            });
        });
        return volatility.indexOf(Math.max(...volatility));
    }

    markovChainStrategy(history) {
        const transitions = {};
        for (let i = 0; i < history.length - 1; i++) {
            const current = history[i];
            const next = history[i + 1];
            if (!transitions[current]) transitions[current] = Array(10).fill(0);
            transitions[current][next]++;
        }
        const lastDigit = history[history.length - 1];
        if (transitions[lastDigit]) {
            const minTransition = Math.min(...transitions[lastDigit]);
            return transitions[lastDigit].indexOf(minTransition);
        }
        return Math.floor(Math.random() * 10);
    }

    entropyStrategy(history) {
        const recent = history.slice(-50);
        const digitCounts = Array(10).fill(0);
        recent.forEach(d => digitCounts[d]++);
        const entropy = digitCounts.map(count => {
            if (count === 0) return Infinity;
            const p = count / recent.length;
            return -p * Math.log2(p);
        });
        return entropy.indexOf(Math.min(...entropy));
    }

    clusterAvoidanceStrategy(history) {
        const last15 = history.slice(-15);
        const clusterScores = Array(10).fill(0);
        for (let i = 0; i < last15.length - 2; i++) {
            if (last15[i] === last15[i + 1] || last15[i] === last15[i + 2]) {
                clusterScores[last15[i]] += 2;
            }
        }
        return clusterScores.indexOf(Math.max(...clusterScores));
    }

    adaptiveStreakStrategy(history) {
        const last20 = history.slice(-20);
        const streaks = Array(10).fill(0);
        last20.forEach(d => streaks[d]++);
        return streaks.indexOf(Math.max(...streaks));
    }

    // ==================== LAYER 2: AI ENSEMBLE STRATEGIES ====================
    statisticalStrategy(history) {
        const recent50 = history.slice(-50);
        const recent20 = history.slice(-20);
        const counts50 = Array(10).fill(0);
        const counts20 = Array(10).fill(0);
        recent50.forEach(d => counts50[d]++);
        recent20.forEach(d => counts20[d]++);
        const deviations = counts20.map((c20, digit) => {
            const expected = (counts50[digit] / 50) * 20;
            return { digit, deviation: c20 - expected };
        });
        return deviations.reduce((max, curr) => curr.deviation > max.deviation ? curr : max).digit;
    }

    neuralStrategy(history) {
        const windows = [10, 20, 30, 50];
        const neuronOutputs = Array(10).fill(0);
        windows.forEach((windowSize, idx) => {
            const window = history.slice(-windowSize);
            const counts = Array(10).fill(0);
            window.forEach(d => counts[d]++);
            const weight = (idx + 1) / windows.length;
            counts.forEach((count, digit) => {
                neuronOutputs[digit] += (count / windowSize) * weight;
            });
        });
        return neuronOutputs.indexOf(Math.max(...neuronOutputs));
    }

    chaosStrategy(history) {
        const last30 = history.slice(-30);
        const equilibrium = last30.length / 10;
        const digitCounts = Array(10).fill(0);
        last30.forEach(d => digitCounts[d]++);
        const distances = digitCounts.map((count, digit) => ({
            digit,
            distance: Math.abs(count - equilibrium),
            isAbove: count > equilibrium
        }));
        const furthestAbove = distances.filter(d => d.isAbove)
            .reduce((max, curr) => curr.distance > max.distance ? curr : max, { distance: 0, digit: 0 });
        return furthestAbove.digit;
    }

    regressionStrategy(history) {
        const windowSize = 100;
        const window = history.slice(-windowSize);
        const trends = Array(10).fill(0);
        for (let digit = 0; digit < 10; digit++) {
            let sum = 0;
            window.forEach((d, idx) => {
                if (d === digit) sum += idx;
            });
            trends[digit] = sum;
        }
        return trends.indexOf(Math.max(...trends));
    }

    bayesianStrategy(history) {
        const prior = 0.1;
        const recent = history.slice(-40);
        const digitCounts = Array(10).fill(0);
        recent.forEach(d => digitCounts[d]++);
        const posteriors = digitCounts.map((count, digit) => {
            const likelihood = (count + 1) / (recent.length + 10);
            return prior * likelihood;
        });
        const sum = posteriors.reduce((a, b) => a + b, 0);
        const normalized = posteriors.map(p => p / sum);
        return normalized.indexOf(Math.max(...normalized));
    }

    // ==================== LAYER 3: QUANTUM PATTERN DETECTORS ====================
    detectZigZag(seq) {
        let changes = 0;
        for (let i = 1; i < seq.length; i++) {
            if ((seq[i] > seq[i-1] && i > 1 && seq[i-1] < seq[i-2]) ||
                (seq[i] < seq[i-1] && i > 1 && seq[i-1] > seq[i-2])) {
                changes++;
            }
        }
        return changes / (seq.length - 2);
    }

    detectConsecutive(seq) {
        let maxConsecutive = 0;
        let currentDigit = seq[0];
        let currentCount = 1;
        for (let i = 1; i < seq.length; i++) {
            if (seq[i] === currentDigit) {
                currentCount++;
            } else {
                maxConsecutive = Math.max(maxConsecutive, currentCount);
                currentDigit = seq[i];
                currentCount = 1;
            }
        }
        return maxConsecutive / seq.length;
    }

    detectMirror(seq) {
        const mid = Math.floor(seq.length / 2);
        let matches = 0;
        for (let i = 0; i < mid; i++) {
            if (seq[i] === seq[seq.length - 1 - i]) matches++;
        }
        return matches / mid;
    }

    detectFibonacci(seq) {
        const fibs = [0, 1, 1, 2, 3, 5, 8];
        let fibCount = 0;
        seq.forEach(d => { if (fibs.includes(d)) fibCount++; });
        return fibCount / seq.length;
    }

    detectPrime(seq) {
        const primes = [2, 3, 5, 7];
        let primeCount = 0;
        seq.forEach(d => { if (primes.includes(d)) primeCount++; });
        return primeCount / seq.length;
    }

    detectEvenOdd(seq) {
        const evenCount = seq.filter(d => d % 2 === 0).length;
        return Math.abs((evenCount / seq.length) - 0.5);
    }

    detectPalindrome(seq) {
        const str = seq.join('');
        const reversed = str.split('').reverse().join('');
        let matches = 0;
        for (let i = 0; i < str.length; i++) {
            if (str[i] === reversed[i]) matches++;
        }
        return matches / str.length;
    }

    detectAscending(seq) {
        let ascending = 0;
        for (let i = 1; i < seq.length; i++) {
            if (seq[i] > seq[i-1]) ascending++;
        }
        return ascending / (seq.length - 1);
    }

    detectDescending(seq) {
        let descending = 0;
        for (let i = 1; i < seq.length; i++) {
            if (seq[i] < seq[i-1]) descending++;
        }
        return descending / (seq.length - 1);
    }

    detectRepeating(seq) {
        const seen = new Set();
        const window = 3;
        let repeats = 0;
        for (let i = 0; i <= seq.length - window; i++) {
            const pattern = seq.slice(i, i + window).join('');
            if (seen.has(pattern)) repeats++;
            seen.add(pattern);
        }
        return repeats / (seq.length - window + 1);
    }

    updateQuantumState() {
        const timeFactor = Date.now() % 360;
        const randomness = crypto.randomInt(0, 360);
        this.quantumState.phase = (timeFactor + randomness) % 360;

        if (this.totalTrades > 0) {
            this.quantumState.amplitude = 0.5 + (this.totalWins / this.totalTrades);
        }

        if (this.quantumState.phase < 120) {
            this.quantumState.mode = 'superposition';
        } else if (this.quantumState.phase < 240) {
            this.quantumState.mode = 'collapsed';
        } else {
            this.quantumState.mode = 'entangled';
        }
    }

    // ==================== META-LAYER: HYBRID ORCHESTRATION ====================
    analyzeAllLayers(history) {
        const predictions = {
            rotation: { votes: Array(10).fill(0), strategy: '' },
            ensemble: { votes: Array(10).fill(0), strategy: '' },
            quantum: { votes: Array(10).fill(0), strategy: '' }
        };

        // LAYER 1: Rotation prediction
        const rotationStrategy = this.rotationStrategies[this.currentRotationIndex];
        const rotationPred = rotationStrategy.func(history);
        predictions.rotation.votes[rotationPred] = this.metaLayer.layerWeights.rotation;
        predictions.rotation.strategy = rotationStrategy.name;
        this.currentRotationIndex = (this.currentRotationIndex + 1) % this.rotationStrategies.length;

        // LAYER 2: Ensemble prediction
        Object.entries(this.ensembleStrategies).forEach(([name, strat]) => {
            const pred = strat.func(history);
            predictions.ensemble.votes[pred] += strat.weight;
        });
        const ensemblePred = predictions.ensemble.votes.indexOf(Math.max(...predictions.ensemble.votes));
        predictions.ensemble.votes = Array(10).fill(0);
        predictions.ensemble.votes[ensemblePred] = this.metaLayer.layerWeights.ensemble;
        const bestEnsemble = Object.entries(this.ensembleStrategies)
            .reduce((best, [name, strat]) => strat.weight > best.weight ? { name, ...strat } : best, 
                    { name: 'statistical', weight: 0 });
        predictions.ensemble.strategy = bestEnsemble.name;

        // LAYER 3: Quantum prediction
        this.updateQuantumState();
        const patternScores = {};
        Object.entries(this.patternLibrary).forEach(([name, detector]) => {
            const windows = [15, 30, 50];
            patternScores[name] = 0;
            windows.forEach(size => {
                const window = history.slice(-size);
                patternScores[name] += detector(window);
            });
            patternScores[name] /= windows.length;
        });

        const quantumPred = this.quantumPrediction(patternScores, history);
        predictions.quantum.votes[quantumPred.digit] = this.metaLayer.layerWeights.quantum;
        predictions.quantum.strategy = quantumPred.strategy;

        return predictions;
    }

    quantumPrediction(patternScores, history) {
        const mode = this.quantumState.mode;
        const recent = history.slice(-30);
        const digitCounts = Array(10).fill(0);

        if (mode === 'superposition') {
            const sortedPatterns = Object.entries(patternScores)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3);
            sortedPatterns.forEach(([pattern, score]) => {
                recent.forEach((digit, idx) => {
                    digitCounts[digit] += score * (idx + 1) / recent.length;
                });
            });
            return { 
                digit: digitCounts.indexOf(Math.max(...digitCounts)),
                strategy: `Superposition(${sortedPatterns.map(p => p[0].substring(0,3)).join('+')})`
            };
        } else if (mode === 'collapsed') {
            recent.forEach(d => digitCounts[d]++);
            return {
                digit: digitCounts.indexOf(Math.max(...digitCounts)),
                strategy: 'Collapsed'
            };
        } else {
            recent.forEach((digit, idx) => {
                const positionWeight = Math.sin((idx / recent.length) * Math.PI);
                digitCounts[digit] += positionWeight * 2;
            });
            return {
                digit: digitCounts.indexOf(Math.max(...digitCounts)),
                strategy: 'Entangled'
            };
        }
    }

    calculateConsensus(predictions) {
        const totalVotes = Array(10).fill(0);
        
        Object.values(predictions).forEach(layer => {
            layer.votes.forEach((vote, digit) => {
                totalVotes[digit] += vote;
            });
        });

        const maxVote = Math.max(...totalVotes);
        const winner = totalVotes.indexOf(maxVote);
        const consensus = maxVote / 1.0; // Total weight = 1.0

        // Determine which layer contributed most
        let dominantLayer = 'rotation';
        let maxLayerVote = 0;
        
        Object.entries(predictions).forEach(([layerName, layer]) => {
            if (layer.votes[winner] > maxLayerVote) {
                maxLayerVote = layer.votes[winner];
                dominantLayer = layerName;
            }
        });

        return {
            digit: winner,
            confidence: consensus,
            dominantLayer,
            strategy: predictions[dominantLayer].strategy,
            votes: totalVotes
        };
    }

    analyzeTicks(asset) {
        if (this.tradeInProgress || this.suspendedAssets.has(asset)) return;

        const history = this.tickHistories[asset];
        const lastDigit = history[history.length - 1];

        console.log('\n🔬 ANALYZING ALL LAYERS...');
        
        // Get predictions from all 3 layers
        const predictions = this.analyzeAllLayers(history);

        // Calculate consensus
        const result = this.calculateConsensus(predictions);

        console.log(`\n📊 LAYER PREDICTIONS:`);
        console.log(`   Rotation: ${predictions.rotation.strategy} → Digit ${predictions.rotation.votes.indexOf(Math.max(...predictions.rotation.votes))}`);
        console.log(`   Ensemble: ${predictions.ensemble.strategy} → Digit ${predictions.ensemble.votes.indexOf(Math.max(...predictions.ensemble.votes))}`);
        console.log(`   Quantum: ${predictions.quantum.strategy} → Digit ${predictions.quantum.votes.indexOf(Math.max(...predictions.quantum.votes))}`);
        console.log(`\n🎯 CONSENSUS: Digit ${result.digit} | Confidence: ${(result.confidence * 100).toFixed(1)}%`);
        console.log(`   Dominant Layer: ${result.dominantLayer} (${result.strategy})`);
        console.log(`   Vote Distribution: ${result.votes.map((v, i) => `${i}:${v.toFixed(2)}`).join(' | ')}`);

        if (result.digit !== lastDigit && result.confidence >= this.metaLayer.consensusThreshold) {
            this.metaLayer.lastUsedLayer = result.dominantLayer;
            this.placeTrade(asset, result.digit, result);
        } else if (result.digit !== lastDigit) {
            console.log(`⚠️  Low consensus (${(result.confidence * 100).toFixed(1)}% < ${(this.metaLayer.consensusThreshold * 100).toFixed(1)}%), skipping trade`);
        }
    }

    placeTrade(asset, predictedDigit, result) {
        if (this.tradeInProgress) return;
        
        this.tradeInProgress = true;
        console.log(`\n🚀 [${asset}] PLACING TRADE`);
        console.log(`   Digit: ${predictedDigit} | Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`   Dominant Layer: ${result.dominantLayer}`);
        console.log(`   Strategy: ${result.strategy}`);
        console.log(`   Confidence: ${(result.confidence * 100).toFixed(1)}%\n`);

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
                symbol: asset,
                barrier: predictedDigit.toString(),
            }
        });
    }

    subscribeToOpenContract(contractId) {
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });
    }

    updateLayerWeights(won) {
        if (!this.metaLayer.lastUsedLayer) return;

        const layer = this.metaLayer.lastUsedLayer;
        const perf = this.metaLayer.layerPerformance[layer];
        
        perf.total++;
        if (won) {
            perf.wins++;
            this.metaLayer.layerWeights[layer] *= 1.15; // 15% increase
        } else {
            this.metaLayer.layerWeights[layer] *= 0.85; // 15% decrease
        }

        // Normalize weights
        const totalWeight = Object.values(this.metaLayer.layerWeights).reduce((sum, w) => sum + w, 0);
        Object.keys(this.metaLayer.layerWeights).forEach(key => {
            this.metaLayer.layerWeights[key] /= totalWeight;
        });

        // Update ensemble strategy weights if ensemble was dominant
        if (layer === 'ensemble') {
            Object.values(this.ensembleStrategies).forEach(strat => {
                strat.total++;
                if (won) {
                    strat.wins++;
                    strat.weight *= 1.1;
                } else {
                    strat.weight *= 0.9;
                }
            });

            const totalEnsembleWeight = Object.values(this.ensembleStrategies)
                .reduce((sum, s) => sum + s.weight, 0);
            Object.values(this.ensembleStrategies).forEach(s => {
                s.weight /= totalEnsembleWeight;
            });
        }

        console.log('\n📊 LAYER PERFORMANCE:');
        Object.entries(this.metaLayer.layerPerformance).forEach(([name, perf]) => {
            const winRate = perf.total > 0 ? (perf.wins / perf.total * 100).toFixed(1) : 0;
            const weight = this.metaLayer.layerWeights[name];
            console.log(`   ${name}: ${perf.wins}/${perf.total} (${winRate}%) - Weight: ${weight.toFixed(3)}`);
        });

        if (layer === 'ensemble') {
            console.log('\n📈 ENSEMBLE STRATEGY WEIGHTS:');
            Object.entries(this.ensembleStrategies).forEach(([name, strat]) => {
                const winRate = strat.total > 0 ? (strat.wins / strat.total * 100).toFixed(1) : 0;
                console.log(`   ${name}: ${strat.wins}/${strat.total} (${winRate}%) - Weight: ${strat.weight.toFixed(3)}`);
            });
        }
    }

    handleTradeResult(contract) {
        const asset = contract.underlying;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);

        console.log(`\n[${asset}] ${won ? '✅ WON' : '❌ LOST'} | Profit: ${profit.toFixed(2)}`);

        this.totalTrades++;
        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
            this.suspendAsset(asset);
        }

        this.totalProfitLoss += profit;
        this.updateLayerWeights(won);

        if(!this.endOfDay) {
            this.logSummary();
        }

        // Check stop conditions
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses || 
            this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('\n🛑 Stop loss reached - Shutting down');
            this.endOfDay = true;
            this.disconnect();
            return;
        }

        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('\n🎉 Take profit reached - Mission accomplished!');
            this.endOfDay = true;
            this.sendEmailSummary();
            this.disconnect();
            return;
        }

        this.disconnect();

        if (!won) {
            this.sendLossEmail(asset);
        }

        const waitTime = Math.floor(Math.random() * 
            (this.config.maxWaitTime - this.config.minWaitTime + 1)) + this.config.minWaitTime;

        console.log(`⏳ Waiting ${Math.round(waitTime / 60000)} minutes before next trade...\n`);

        if(!this.endOfDay) {
            setTimeout(() => {
                this.tradeInProgress = false;
                this.connect();
            }, waitTime);
        }
    }

    suspendAsset(asset) {
        this.suspendedAssets.add(asset);
        console.log(`🚫 Suspended asset: ${asset}`);
        
        if (this.suspendedAssets.size > 2) {
            const first = Array.from(this.suspendedAssets)[0];
            this.suspendedAssets.delete(first);
            console.log(`✅ Reactivated asset: ${first}`);
        }
    }

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const currentHours = now.getHours();
            const currentMinutes = now.getMinutes();

            // Check for afternoon resume condition (7:00 AM)
            if (this.endOfDay && currentHours === 14 && currentMinutes >= 0) {
                console.log("It's 7:00 AM, reconnecting the bot.");
                this.LossDigitsList = [];
                this.tradeInProgress = false;
                this.usedAssets = new Set();
                this.RestartTrading = true;
                this.Pause = false;
                this.endOfDay = false;
                this.tradedDigitArray = [];
                this.tradedDigitArray2 = [];
                this.tradeNum = Math.floor(Math.random() * (40 - 21 + 1)) + 21;
                this.connect();
            }
    
            // Check for evening stop condition (after 5:00 PM)
            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 23 && currentMinutes >= 0) {
                    console.log("It's past 5:00 PM after a win trade, disconnecting the bot.");
                    this.sendDisconnectResumptionEmailSummary();
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000); // Check every 20 seconds
    }

    logSummary() {
        const winRate = this.totalTrades > 0 ? (this.totalWins / this.totalTrades * 100).toFixed(2) : 0;
        
        console.log('\n' + '='.repeat(60));
        console.log('📊 HYBRID SUPER BOT - TRADING SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total Trades: ${this.totalTrades} | Wins: ${this.totalWins} | Losses: ${this.totalLosses}`);
        console.log(`Win Rate: ${winRate}% | Consecutive Losses: ${this.consecutiveLosses}`);
        console.log(`P&L: ${this.totalProfitLoss.toFixed(2)} | Current Stake: ${this.currentStake.toFixed(2)}`);
        console.log(`Quantum State: ${this.quantumState.mode} (Phase: ${this.quantumState.phase}°)`);
        console.log(`Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}`);
        console.log('='.repeat(60) + '\n');
    }

    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        
        const layerStats = Object.entries(this.metaLayer.layerPerformance)
            .map(([name, perf]) => {
                const winRate = perf.total > 0 ? (perf.wins / perf.total * 100).toFixed(1) : 0;
                const weight = this.metaLayer.layerWeights[name];
                return `${name}: ${perf.wins}/${perf.total} (${winRate}%) - Weight: ${weight.toFixed(3)}`;
            })
            .join('\n');

        const ensembleStats = Object.entries(this.ensembleStrategies)
            .map(([name, strat]) => {
                const winRate = strat.total > 0 ? (strat.wins / strat.total * 100).toFixed(1) : 0;
                return `  ${name}: ${strat.wins}/${strat.total} (${winRate}%) - Weight: ${strat.weight.toFixed(3)}`;
            })
            .join('\n');

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Hybrid Super Bot - Trading Summary',
            text: `
                HYBRID SUPER BOT - FINAL SUMMARY
                ================================

                Overall Performance:
                -------------------
                Total Trades: ${this.totalTrades}
                Wins: ${this.totalWins}
                Losses: ${this.totalLosses}
                Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
                Total P&L: ${this.totalProfitLoss.toFixed(2)}

                Layer Performance:
                -----------------
                ${layerStats}

                Ensemble Strategy Breakdown:
                ----------------------------
                ${ensembleStats}

                Quantum State:
                -------------
                Mode: ${this.quantumState.mode}
                Phase: ${this.quantumState.phase}°
                Amplitude: ${this.quantumState.amplitude.toFixed(2)}

                Final Configuration:
                -------------------
                Current Stake: ${this.currentStake.toFixed(2)}
                Consecutive Losses: ${this.consecutiveLosses}
                Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}

                Next Rotation Strategy: ${this.rotationStrategies[this.currentRotationIndex].name}
            `
        };

        try {
            await transporter.sendMail(mailOptions);
            console.log('📧 Summary email sent successfully');
        } catch (error) {
            console.error('❌ Error sending email:', error.message);
        }
    }

    startEmailTimer() {
        if (!this.endOfDay) {
            setInterval(() => {
                this.sendEmailSummary();
            }, 21600000); // 6 Hours
        }
    }

    async sendLossEmail(asset, predictedDigit) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const history = this.tickHistories[asset];
        const lastFewTicks = history.slice(-20);

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Hybrid Super Bot - Loss Alert',
            text: `
                LOSS ALERT - TRADE SUMMARY
                ==========================

                Trade Details:
                -------------
                Asset: ${asset}
                Predicted Digit: ${predictedDigit}
                Last 20 Digits: ${lastFewTicks.join(', ')}

                Current Status:
                --------------
                Total Trades: ${this.totalTrades}
                Total Wins: ${this.totalWins}
                Total Losses: ${this.totalLosses}
                Consecutive Losses: ${this.consecutiveLosses}
                Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%
                Total P&L: ${this.totalProfitLoss.toFixed(2)}

                Risk Management:
                ---------------
                Current Stake: ${this.currentStake.toFixed(2)}
                Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}

                Layer Status:
                ------------
                Dominant Layer: ${this.metaLayer.lastUsedLayer}
                Quantum Mode: ${this.quantumState.mode}
            `
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending loss email:', error.message);
        }
    }

    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
    }

    disconnect() {
        if (this.connected) {
            this.ws.close();
        }
    }

    start() {
        console.log('\n' + '='.repeat(60));
        console.log('🚀 HYBRID SUPER BOT STARTING...');
        console.log('='.repeat(60));
        console.log('Combining 23 strategies across 3 layers:');
        console.log('  • Layer 1 (Rotation): 8 strategies');
        console.log('  • Layer 2 (Ensemble): 5 AI strategies');
        console.log('  • Layer 3 (Quantum): 10 pattern detectors');
        console.log('='.repeat(60) + '\n');
        
        this.connect();
        this.checkTimeForDisconnectReconnect();
    }
}

// ==================== INITIALIZE AND START BOT ====================
const bot = new HybridSuperBot('0P94g4WdSrSrzir', {
    initialStake: 0.61,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    stopLoss: 129,
    takeProfit: 5000,
    requiredHistoryLength: 1000,
    minWaitTime: 180000,
    maxWaitTime: 300000,
    // minWaitTime: 300000, //5 Minutes
    // maxWaitTime: 2600000, //1 Hour
});

bot.start();
