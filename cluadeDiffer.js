require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');

class AIWeightedEnsembleBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = config.assets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];

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

        // Strategy performance tracking for adaptive weighting
        this.strategyPerformance = {
            'statistical': { wins: 0, total: 0, weight: 1.0 },
            'neural': { wins: 0, total: 0, weight: 1.0 },
            'chaos': { wins: 0, total: 0, weight: 1.0 },
            'regression': { wins: 0, total: 0, weight: 1.0 },
            'bayesian': { wins: 0, total: 0, weight: 1.0 },
            'momentum': { wins: 0, total: 0, weight: 1.0 },
            'markov': { wins: 0, total: 0, weight: 1.0 },
            'entropy': { wins: 0, total: 0, weight: 1.0 },
            'cluster': { wins: 0, total: 0, weight: 1.0 },
            'adaptive': { wins: 0, total: 0, weight: 1.0 },
            'volatility': { wins: 0, total: 0, weight: 1.0 },
            'pattern': { wins: 0, total: 0, weight: 1.0 },
            'gap': { wins: 0, total: 0, weight: 1.0 },
        };

        this.lastUsedStrategy = null;

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
        console.log('Connecting to Deriv API...');
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

        if (['R_75', 'R_50'].includes(asset)) {
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

    // ==================== STRATEGY A: STATISTICAL ANALYSIS ====================
    statisticalStrategy(history) {
        const recent50 = history.slice(-50);
        const recent20 = history.slice(-20);
        
        const counts50 = Array(10).fill(0);
        const counts20 = Array(10).fill(0);
        
        recent50.forEach(d => counts50[d]++);
        recent20.forEach(d => counts20[d]++);

        // Find digits that are overrepresented in recent 20 vs 50
        const deviations = counts20.map((c20, digit) => {
            const expected = (counts50[digit] / 50) * 20;
            return { digit, deviation: c20 - expected };
        });

        const maxDeviation = deviations.reduce((max, curr) => 
            curr.deviation > max.deviation ? curr : max
        );

        return maxDeviation.digit;
    }

    // ==================== STRATEGY B: NEURAL NETWORK SIMULATION ====================
    neuralStrategy(history) {
        // Simulates simple neural network with weighted inputs
        const windows = [10, 20, 30, 50];
        const neuronOutputs = Array(10).fill(0);

        windows.forEach((windowSize, idx) => {
            const window = history.slice(-windowSize);
            const counts = Array(10).fill(0);
            window.forEach(d => counts[d]++);

            const weight = (idx + 1) / windows.length; // Increasing weight for larger windows
            counts.forEach((count, digit) => {
                neuronOutputs[digit] += (count / windowSize) * weight;
            });
        });

        // Activation function - find max
        return neuronOutputs.indexOf(Math.max(...neuronOutputs));
    }

    // ==================== STRATEGY C: CHAOS THEORY APPROACH ====================
    chaosStrategy(history) {
        // Uses attractor theory - finds digits at edge of phase space
        const last30 = history.slice(-30);
        
        // Calculate "distance" from equilibrium for each digit
        const equilibrium = last30.length / 10;
        const digitCounts = Array(10).fill(0);
        last30.forEach(d => digitCounts[d]++);

        const distances = digitCounts.map((count, digit) => ({
            digit,
            distance: Math.abs(count - equilibrium),
            isAbove: count > equilibrium
        }));

        // Find digit furthest above equilibrium
        const furthestAbove = distances
            .filter(d => d.isAbove)
            .reduce((max, curr) => curr.distance > max.distance ? curr : max, { distance: 0, digit: 0 });

        return furthestAbove.digit;
    }

    // ==================== STRATEGY D: REGRESSION ANALYSIS ====================
    regressionStrategy(history) {
        // Linear regression on digit frequency trends
        const windowSize = 100;
        const window = history.slice(-windowSize);
        
        const trends = Array(10).fill(0);
        
        for (let digit = 0; digit < 10; digit++) {
            let sum = 0;
            window.forEach((d, idx) => {
                if (d === digit) sum += idx; // Weight by position
            });
            trends[digit] = sum;
        }

        return trends.indexOf(Math.max(...trends));
    }

    // ==================== STRATEGY E: BAYESIAN PROBABILITY ====================
    bayesianStrategy(history) {
        // Uses Bayes theorem to update probabilities
        const prior = 0.1; // Initial probability for each digit
        const recent = history.slice(-40);
        
        const likelihoods = Array(10).fill(0);
        const digitCounts = Array(10).fill(0);
        
        recent.forEach(d => digitCounts[d]++);

        // Calculate posterior probabilities
        const posteriors = digitCounts.map((count, digit) => {
            const likelihood = (count + 1) / (recent.length + 10); // Laplace smoothing
            return prior * likelihood;
        });

        // Normalize
        const sum = posteriors.reduce((a, b) => a + b, 0);
        const normalized = posteriors.map(p => p / sum);

        return normalized.indexOf(Math.max(...normalized));
    }

    // ==================== STRATEGY 1: MOMENTUM REVERSAL ====================
    momentumReversalStrategy(history) {
        // Identifies digits with strongest recent momentum and predicts reversal
        const recent = history.slice(-30);
        const digitCounts = Array(10).fill(0);
        recent.forEach(d => digitCounts[d]++);

        const maxCount = Math.max(...digitCounts);
        const hotDigits = digitCounts.map((c, i) => c === maxCount ? i : -1).filter(d => d !== -1);
        
        return hotDigits[Math.floor(Math.random() * hotDigits.length)];
    }

    // ==================== STRATEGY 2: FREQUENCY GAP ANALYSIS ====================
    frequencyGapStrategy(history) {
        // Finds digit with largest gap since last appearance
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

    // ==================== STRATEGY 3: PATTERN SEQUENCE DETECTION ====================
    patternSequenceStrategy(history) {
        // Detects repeating sequences and predicts breaking digit
        const last10 = history.slice(-10);
        const digitCounts = Array(10).fill(0);
        
        // Weight recent occurrences higher
        last10.forEach((d, idx) => {
            digitCounts[d] += (idx + 1);
        });

        const maxWeightedCount = Math.max(...digitCounts);
        const dominantDigit = digitCounts.indexOf(maxWeightedCount);
        
        return dominantDigit;
    }

    // ==================== STRATEGY 4: VOLATILITY-BASED SELECTION ====================
    volatilityStrategy(history) {
        // Selects digit based on variance in recent window
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

    // ==================== STRATEGY 5: MARKOV CHAIN PREDICTION ====================
    markovChainStrategy(history) {
        // Uses transition probabilities to predict unlikely digit
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
            const leastLikely = transitions[lastDigit].indexOf(minTransition);
            return leastLikely;
        }

        return Math.floor(Math.random() * 10);
    }

    // ==================== STRATEGY 6: ENTROPY MINIMIZATION ====================
    entropyStrategy(history) {
        // Selects digit that would minimize Shannon entropy
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

    // ==================== STRATEGY 7: CLUSTER AVOIDANCE ====================
    clusterAvoidanceStrategy(history) {
        // Avoids digits that appear in clusters
        const last15 = history.slice(-15);
        const clusterScores = Array(10).fill(0);

        for (let i = 0; i < last15.length - 2; i++) {
            if (last15[i] === last15[i + 1] || last15[i] === last15[i + 2]) {
                clusterScores[last15[i]] += 2;
            }
        }

        return clusterScores.indexOf(Math.max(...clusterScores));
    }

    // ==================== STRATEGY 8: ADAPTIVE STREAK BREAKING ====================
    adaptiveStreakStrategy(history) {
        // Identifies longest current streak and predicts that digit
        const last20 = history.slice(-20);
        const streaks = Array(10).fill(0);
        
        let currentStreak = 1;
        for (let i = last20.length - 2; i >= 0; i--) {
            if (last20[i] === last20[last20.length - 1]) {
                currentStreak++;
            } else {
                break;
            }
        }

        // Count streaks for each digit
        last20.forEach(d => streaks[d]++);
        
        const maxStreak = Math.max(...streaks);
        const streakDigit = streaks.indexOf(maxStreak);
        
        return streakDigit;
    }

    // ==================== ENSEMBLE VOTING SYSTEM ====================
    ensembleVoting(history) {
        const votes = Array(10).fill(0);
        
        // Collect predictions from all strategies with weights
        const strategies = [
            { name: 'statistical', pred: this.statisticalStrategy(history), weight: this.strategyPerformance.statistical.weight },
            { name: 'neural', pred: this.neuralStrategy(history), weight: this.strategyPerformance.neural.weight },
            { name: 'chaos', pred: this.chaosStrategy(history), weight: this.strategyPerformance.chaos.weight },
            { name: 'regression', pred: this.regressionStrategy(history), weight: this.strategyPerformance.regression.weight },
            { name: 'bayesian', pred: this.bayesianStrategy(history), weight: this.strategyPerformance.bayesian.weight },
            { name: 'momentum', pred: this.momentumReversalStrategy(history), weight: this.strategyPerformance.momentum.weight },
            { name: 'markov', pred: this.markovChainStrategy(history), weight: this.strategyPerformance.markov.weight },
            { name: 'entropy', pred: this.entropyStrategy(history), weight: this.strategyPerformance.entropy.weight },
            { name: 'cluster', pred: this.clusterAvoidanceStrategy(history), weight: this.strategyPerformance.cluster.weight },
            { name: 'adaptive', pred: this.adaptiveStreakStrategy(history), weight: this.strategyPerformance.adaptive.weight },
            { name: 'volatility', pred: this.volatilityStrategy(history), weight: this.strategyPerformance.volatility.weight },
            { name: 'pattern', pred: this.patternSequenceStrategy(history), weight: this.strategyPerformance.pattern.weight },
            { name: 'gap', pred: this.frequencyGapStrategy(history), weight: this.strategyPerformance.gap.weight },
        ];

        // Weighted voting
        strategies.forEach(strat => {
            votes[strat.pred] += strat.weight;
        });

        const winner = votes.indexOf(Math.max(...votes));
        
        // Find which strategy contributed most to winner
        const winningStrategy = strategies
            .filter(s => s.pred === winner)
            .reduce((best, curr) => curr.weight > best.weight ? curr : best, strategies[0]);

        return { digit: winner, strategy: winningStrategy.name, votes };
    }

    analyzeTicks(asset) {
        if (this.tradeInProgress || this.suspendedAssets.has(asset)) return;

        const history = this.tickHistories[asset];
        const lastDigit = history[history.length - 1];

        // Use ensemble voting to select best prediction
        const result = this.ensembleVoting(history);
        const predictedDigit = result.digit;
        const strategy = result.strategy;
        const predictedDigitVote = result.votes[predictedDigit];

        console.log(`\n🎯 Ensemble Votes: ${result.votes.map((v, i) => `${i}:${v.toFixed(2)}`).join(' | ')}`);
        console.log(`Winning Strategy: ${strategy} (weight: ${this.strategyPerformance[strategy].weight.toFixed(2)})`);

        // Execute trade if predicted digit votes is greater than 6
        if (predictedDigit !== lastDigit) {//&& predictedDigitVote > 6
            this.lastUsedStrategy = strategy;
            this.placeTrade(asset, predictedDigit, strategy, predictedDigitVote);
        }
    }

    placeTrade(asset, predictedDigit, strategy, predictedDigitVote) {
        if (this.tradeInProgress) return;
        
        this.tradeInProgress = true;
        console.log(`🚀 [${asset}] Strategy: ${strategy} => Digit ${predictedDigit} | Digitvote: ${predictedDigitVote.toFixed(2)} | Stake: $${this.currentStake.toFixed(2)}`);

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

    updateStrategyWeights(won) {
        if (!this.lastUsedStrategy) return;

        const strategy = this.strategyPerformance[this.lastUsedStrategy];
        strategy.total++;
        
        if (won) {
            strategy.wins++;
            strategy.weight *= 1.1; // Increase weight by 10%
        } else {
            strategy.weight *= 0.9; // Decrease weight by 10%
        }

        // Normalize weights
        const totalWeight = Object.values(this.strategyPerformance).reduce((sum, s) => sum + s.weight, 0);
        Object.values(this.strategyPerformance).forEach(s => {
            s.weight /= totalWeight;
        });

        console.log('\n📊 Strategy Performance:');
        Object.entries(this.strategyPerformance).forEach(([name, perf]) => {
            const winRate = perf.total > 0 ? (perf.wins / perf.total * 100).toFixed(1) : 0;
            console.log(`  ${name}: ${perf.wins}/${perf.total} (${winRate}%) - Weight: ${perf.weight.toFixed(3)}`);
        });
    }

    handleTradeResult(contract) {
        const asset = contract.underlying;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);

        console.log(`[${asset}] ${won ? '✅ WON' : '❌ LOST'} | Profit: $${profit.toFixed(2)}`);

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
        this.updateStrategyWeights(won);
        
        if(!this.endOfDay) {
            this.logSummary();
        }

        // Check stop conditions
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses || 
            this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('🛑 Stop loss reached');
            this.endOfDay = true;
            this.disconnect();
            return;
        }

        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('🎉 Take profit reached');
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
        console.log(`🚫 Suspended: ${asset}`);
        
        if (this.suspendedAssets.size > 3) {
            const first = Array.from(this.suspendedAssets)[0];
            this.suspendedAssets.delete(first);
            console.log(`✅ Reactivated: ${first}`);
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
        console.log('\n📊 TRADING SUMMARY');
        console.log(`Trades: ${this.totalTrades} | Wins: ${this.totalWins} | Losses: ${this.totalLosses}`);
        console.log(`P&L: $${this.totalProfitLoss.toFixed(2)} | Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}\n`);
    }

    startEmailTimer() {
        if (!this.endOfDay) {
            setInterval(() => {
                this.sendEmailSummary();
            }, 21600000); // 6 Hours
        }
    }

    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        
        const strategyStats = Object.entries(this.strategyPerformance)
            .map(([name, perf]) => {
                const winRate = perf.total > 0 ? (perf.wins / perf.total * 100).toFixed(1) : 0;
                return `${name}: ${perf.wins}/${perf.total} (${winRate}%) - Weight: ${perf.weight.toFixed(3)}`;
            })
            .join('\n');

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'AI-Weighted Ensemble Bot - Summary',
            text: `
                Trading Summary:
                Total Trades: ${this.totalTrades}
                Wins: ${this.totalWins}
                Losses: ${this.totalLosses}
                P&L: $${this.totalProfitLoss.toFixed(2)}
                Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%

                Strategy Performance:
                ${strategyStats}
            `
        };

        try {
            await transporter.sendMail(mailOptions);
            console.log('📧 Summary email sent successfully');
        } catch (error) {
            console.error('❌ Error sending email:', error.message);
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
        this.connect();
        this.checkTimeForDisconnectReconnect();
    }
}

// Initialize and start bot
const bot = new AIWeightedEnsembleBot('0P94g4WdSrSrzir', {
    initialStake: 0.61,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    stopLoss: 129,
    takeProfit: 5000,
    requiredHistoryLength: 1000,
    minWaitTime: 300000, //5 Minutes
    maxWaitTime: 2600000, //1 Hour
});

bot.start();
