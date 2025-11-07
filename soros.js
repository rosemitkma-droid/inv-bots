require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const crypto = require('crypto');


class ReflexiveAdaptiveBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = config.assets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR'];

        this.config = {
            initialStake: config.initialStake || 0.61,
            multiplier: config.multiplier || 3.5,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 2,
            stopLoss: config.stopLoss || 40,
            takeProfit: config.takeProfit || 30,
            requiredHistoryLength: config.requiredHistoryLength || 1000,
            minWaitTime: config.minWaitTime || 180000,
            maxWaitTime: config.maxWaitTime || 300000,
            reflexivityThreshold: config.reflexivityThreshold || 0.55, // FIXED: Lowered to realistic level
            pauseAfterLosses: config.pauseAfterLosses || 2
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
        this.tradingPaused = false;
        this.lastStrategyUsed = null;

        // Tick data storage
        this.tickHistories = {};
        this.tickSubscriptionIds = {};
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
        });

        // Reflexive Strategies
        this.strategies = [
            { name: 'Sentiment Shift', func: this.sentimentShiftStrategy.bind(this), wins: 0, total: 0, weight: 1.0 },
            { name: 'Feedback Loop', func: this.feedbackLoopStrategy.bind(this), wins: 0, total: 0, weight: 1.0 },
            { name: 'Contrarian Bias', func: this.contrarianBiasStrategy.bind(this), wins: 0, total: 0, weight: 1.0 },
            { name: 'Momentum Tracker', func: this.momentumTrackerStrategy.bind(this), wins: 0, total: 0, weight: 1.0 }, // NEW STRATEGY
            { name: 'Pattern Recognition', func: this.patternRecognitionStrategy.bind(this), wins: 0, total: 0, weight: 1.0 } // NEW STRATEGY
        ];

        this.reflexivityData = {
            assetSentiment: {},
            lossFeedback: []
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
        console.log('🚀 Connecting Reflexive Adaptive Bot to Deriv API...');
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

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
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
            !this.suspendedAssets.has(asset) &&
            !this.tradingPaused) {
            this.analyzeTicks(asset);
        }
    }

    // STRATEGY 1: Sentiment Shift
    sentimentShiftStrategy(history) {
        const recentShort = history.slice(-20);
        const recentLong = history.slice(-100);
        const shortCounts = Array(10).fill(0);
        const longCounts = Array(10).fill(0);
        recentShort.forEach(d => shortCounts[d]++);
        recentLong.forEach(d => longCounts[d]++);
        const shifts = shortCounts.map((sc, digit) => {
            const longAvg = longCounts[digit] / 100;
            const shortAvg = sc / 20;
            return { digit, shift: Math.abs(shortAvg - longAvg) };
        });
        return shifts.reduce((max, curr) => curr.shift > max.shift ? curr : max).digit;
    }

    // STRATEGY 2: Feedback Loop
    feedbackLoopStrategy(history) {
        const recent = history.slice(-50);
        const counts = Array(10).fill(0);
        recent.forEach((d, idx) => {
            counts[d] += (idx / recent.length);
        });
        return counts.indexOf(Math.max(...counts));
    }

    // STRATEGY 3: Contrarian Bias
    contrarianBiasStrategy(history) {
        const recent = history.slice(-30);
        const counts = Array(10).fill(0);
        recent.forEach(d => counts[d]++);
        return counts.indexOf(Math.min(...counts));
    }

    // STRATEGY 4: Momentum Tracker (NEW)
    momentumTrackerStrategy(history) {
        const recent = history.slice(-40);
        const momentum = Array(10).fill(0);
        for (let i = 1; i < recent.length; i++) {
            if (recent[i] === recent[i - 1]) {
                momentum[recent[i]]++;
            }
        }
        return momentum.indexOf(Math.max(...momentum));
    }

    // STRATEGY 5: Pattern Recognition (NEW)
    patternRecognitionStrategy(history) {
        const recent = history.slice(-60);
        const counts = Array(10).fill(0);
        // Weight recent occurrences more heavily
        recent.forEach((d, idx) => {
            const weight = 1 + (idx / recent.length) * 2; // Exponential weighting
            counts[d] += weight;
        });
        return counts.indexOf(Math.max(...counts));
    }

    // FIXED: Proper strategy weight updates
    updateStrategyWeights(won, strategyName) {
        const strategy = this.strategies.find(s => s.name === strategyName);
        if (!strategy) return;

        strategy.total++;
        if (won) {
            strategy.wins++;
            strategy.weight *= 1.15; // Moderate increase
        } else {
            strategy.weight *= 0.85; // Moderate decrease
        }

        if (strategy.weight < 0.3) strategy.weight = 0.3; // Higher minimum to keep all strategies active
        if (strategy.weight > 3.0) strategy.weight = 3.0; // Cap maximum weight

        // Normalize weights
        const totalWeight = this.strategies.reduce((sum, s) => sum + s.weight, 0);
        this.strategies.forEach(s => {
            s.weight /= totalWeight;
        });

        console.log(`📈 Updated ${strategyName}: ${strategy.wins}/${strategy.total} wins, Weight: ${strategy.weight.toFixed(3)}`);
    }

    // FIXED: Improved confidence calculation
    analyzeTicks(asset) {
        if (this.tradeInProgress || this.suspendedAssets.has(asset) || this.tradingPaused) return;

        const history = this.tickHistories[asset];
        const lastDigit = history[history.length - 1];

        console.log('\n🔬 ANALYZING TICKS WITH REFLEXIVE ADAPTATION...');
        
        // FIXED: Proper weighted voting system
        const votes = Array(10).fill(0);
        const predictions = this.strategies.map(strategy => {
            const pred = strategy.func(history);
            votes[pred] += strategy.weight;
            return { strategy, pred, weight: strategy.weight };
        });

        const predictedDigit = votes.indexOf(Math.max(...votes));
        
        // FIXED: Correct confidence calculation
        const totalWeight = votes.reduce((sum, v) => sum + v, 0);
        const topVote = votes[predictedDigit];
        const confidence = topVote / totalWeight; // Simple normalized confidence
        
        // Alternative confidence with separation measure
        const sortedVotes = [...votes].sort((a, b) => b - a);
        const separationConfidence = sortedVotes[0] / (sortedVotes[0] + sortedVotes[1] + 0.001);

        // Agreement factor: how many strategies agree on top prediction
        const agreementCount = predictions.filter(p => p.pred === predictedDigit).length;

        // Use the higher confidence measure
        const finalConfidence = Math.max(confidence, separationConfidence);

        // Select the strategy that predicted the chosen digit with highest weight
        const candidateStrategies = predictions
            .filter(p => p.pred === predictedDigit)
            .sort((a, b) => b.weight - a.weight);
        const selectedStrategy = candidateStrategies.length > 0 ? candidateStrategies[0].strategy : this.strategies[0];

        console.log(`\n🎯 PREDICTION: Digit ${predictedDigit} | Confidence: ${(finalConfidence * 100).toFixed(1)}%`);
        console.log(`   Last Digit: ${lastDigit}`);
        console.log(`   Selected Strategy: ${selectedStrategy.name} (Weight: ${selectedStrategy.weight.toFixed(3)})`);
        // console.log(`   Vote Distribution: [${votes.map(v => v.toFixed(2)).join(', ')}]`);
        console.log(`   Agreement: ${agreementCount}/${this.strategies.length} strategies`);
        console.log(`   Strategy Predictions: ${predictions.map(p => `${p.strategy.name}→${p.pred}`).join(', ')}`);

        // FIXED: More lenient trade execution condition
        if (finalConfidence >= this.config.reflexivityThreshold) {
            // Additional check: avoid trading if last digit matches prediction (diversity check)
            if (predictedDigit !== lastDigit && agreementCount > 3) {
                this.lastStrategyUsed = selectedStrategy.name;
                this.placeTrade(asset, predictedDigit, selectedStrategy.name, finalConfidence);
            } else {
                console.log(`⚠️ Skipping trade: predicted digit ${predictedDigit} matches last digit`);
            }
        } else {
            console.log(`⚠️ Confidence below threshold (${(finalConfidence * 100).toFixed(1)}% < ${(this.config.reflexivityThreshold * 100).toFixed(1)}%), skipping trade`);
        }
    }

    placeTrade(asset, predictedDigit, strategyName, confidence) {
        if (this.tradeInProgress) return;
        
        this.tradeInProgress = true;
        console.log(`\n🚀 [${asset}] PLACING TRADE`);
        console.log(`   Digit: ${predictedDigit} | Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`   Strategy: ${strategyName}`);
        console.log(`   Confidence: ${(confidence * 100).toFixed(1)}%`);

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
            this.tradingPaused = false;
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
            this.suspendAsset(asset);
            this.reflexivityData.lossFeedback.push({
                asset: asset,
                history: this.tickHistories[asset].slice(-10),
                timestamp: Date.now()
            });
            if (this.consecutiveLosses >= this.config.pauseAfterLosses) {
                this.tradingPaused = true;
                console.log(`🛑 Pausing trading due to ${this.consecutiveLosses} consecutive losses. Waiting for market reset.`);
            }
        }

        this.totalProfitLoss += profit;
        const strategyName = this.lastStrategyUsed || this.strategies[0].name;
        this.updateStrategyWeights(won, strategyName);

        if (!this.endOfDay) {
            this.logSummary();
        }

        if (this.consecutiveLosses > this.config.maxConsecutiveLosses || 
            this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('\n🛑 Stop loss reached or max consecutive losses exceeded - Shutting down');
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
            this.sendLossEmail(asset, strategyName);
        }

        if (!this.tradingPaused && !this.endOfDay) {
            const waitTime = Math.floor(Math.random() * 
                (this.config.maxWaitTime - this.config.minWaitTime + 1)) + this.config.minWaitTime;
            console.log(`⏳ Waiting ${Math.round(waitTime / 60000)} minutes before next trade...\n`);
            setTimeout(() => {
                this.tradeInProgress = false;
                this.connect();
            }, waitTime);
        } else if (this.tradingPaused) {
            const extendedWait = 30 * 60 * 1000;
            console.log(`⏳ Extended pause due to losses. Waiting ${Math.round(extendedWait / 60000)} minutes...`);
            setTimeout(() => {
                this.tradingPaused = false;
                this.tradeInProgress = false;
                this.connect();
            }, extendedWait);
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

    logSummary() {
        const winRate = this.totalTrades > 0 ? (this.totalWins / this.totalTrades * 100).toFixed(2) : 0;
        
        console.log('\n' + '='.repeat(60));
        console.log('📊 REFLEXIVE ADAPTIVE BOT - TRADING SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total Trades: ${this.totalTrades} | Wins: ${this.totalWins} | Losses: ${this.totalLosses}`);
        console.log(`Win Rate: ${winRate}% | Consecutive Losses: ${this.consecutiveLosses}`);
        console.log(`P&L: ${this.totalProfitLoss.toFixed(2)} | Current Stake: ${this.currentStake.toFixed(2)}`);
        console.log(`Trading Status: ${this.tradingPaused ? 'Paused due to losses' : 'Active'}`);
        console.log(`Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}`);
        console.log('Strategy Performance:');
        this.strategies.forEach(s => {
            const wr = s.total > 0 ? ((s.wins / s.total) * 100).toFixed(1) : 0;
            console.log(`  ${s.name}: ${s.wins}/${s.total} (${wr}%) | Weight: ${s.weight.toFixed(3)}`);
        });
        console.log('='.repeat(60) + '\n');
    }

    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        
        const strategyStats = this.strategies
            .map(strategy => {
                const winRate = strategy.total > 0 ? (strategy.wins / strategy.total * 100).toFixed(1) : 0;
                return `${strategy.name}: ${strategy.wins}/${strategy.total} (${winRate}%) - Weight: ${strategy.weight.toFixed(3)}`;
            })
            .join('\n');

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Reflexive Adaptive Bot - Trading Summary',
            text: `
                REFLEXIVE ADAPTIVE BOT - FINAL SUMMARY
                ================================

                Overall Performance:
                -------------------
                Total Trades: ${this.totalTrades}
                Wins: ${this.totalWins}
                Losses: ${this.totalLosses}
                Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
                Total P&L: ${this.totalProfitLoss.toFixed(2)}

                Strategy Performance:
                -----------------
                ${strategyStats}

                Final Configuration:
                -------------------
                Current Stake: ${this.currentStake.toFixed(2)}
                Consecutive Losses: ${this.consecutiveLosses}
                Trading Paused: ${this.tradingPaused ? 'Yes' : 'No'}
                Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}
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
            }, 21600000);
        }
    }

    async sendLossEmail(asset, strategyName) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const history = this.tickHistories[asset];
        const lastFewTicks = history.slice(-20);

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Reflexive Adaptive Bot - Loss Alert',
            text: `
                LOSS ALERT - TRADE SUMMARY
                ==========================

                Trade Details:
                -------------
                Asset: ${asset}
                Strategy Used: ${strategyName}
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
                Trading Paused: ${this.tradingPaused ? 'Yes' : 'No'}
                Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}
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
        console.log('🚀 REFLEXIVE ADAPTIVE BOT STARTING...');
        console.log('='.repeat(60));
        console.log('Built on principles of market reflexivity:');
        console.log('  • 5 Adaptive strategies with dynamic weighting');
        console.log('  • Improved confidence calculation');
        console.log('  • Risk management through conservative staking');
        console.log('  • Pausing mechanism to avoid loss streaks');
        console.log(`  • Confidence Threshold: ${(this.config.reflexivityThreshold * 100).toFixed(0)}%`);
        console.log('='.repeat(60) + '\n');
        
        this.connect();
    }
}

// ==================== INITIALIZE AND START BOT ====================
const bot = new ReflexiveAdaptiveBot('DMylfkyce6VyZt7', {
    initialStake: 0.61,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    stopLoss: 86,
    takeProfit: 500,
    requiredHistoryLength: 1000,
    minWaitTime: 180000,
    maxWaitTime: 300000,
    reflexivityThreshold: 0.8, // LOWERED from 0.7 to realistic level
    pauseAfterLosses: 2
});

bot.start();
