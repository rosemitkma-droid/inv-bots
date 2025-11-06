require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

class HyperOpticTradingEngine {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = config.assets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];

        this.config = {
            initialStake: config.initialStake || 0.61,
            multiplier: config.multiplier || 5.0, // Balanced for recovery without insane risk
            maxConsecutiveLosses: config.maxConsecutiveLosses || 2, // Tight loss control
            stopLoss: config.stopLoss || 50, // Aggressive stop to protect capital
            takeProfit: config.takeProfit || 35, // Realistic target for gains
            requiredHistoryLength: config.requiredHistoryLength || 1000,
            minWaitTime: config.minWaitTime || 120000, // 2 min base wait
            maxWaitTime: config.maxWaitTime || 240000, // 4 min max wait
            confidenceThreshold: config.confidenceThreshold || 0.85, // High bar for trades
            lossPauseDuration: config.lossPauseDuration || 600000 // 10 min pause after loss streak
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

        // Tick data storage
        this.tickHistories = {};
        this.tickSubscriptionIds = {};
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
        });

        // HyperOptic Strategies - Focused on rapid iteration and adaptability
        this.strategies = [
            { name: 'Momentum Surge', func: this.momentumSurgeStrategy.bind(this), wins: 0, total: 0, weight: 1.0 },
            { name: 'Pattern Breakout', func: this.patternBreakoutStrategy.bind(this), wins: 0, total: 0, weight: 1.0 },
            { name: 'Anomaly Dodge', func: this.anomalyDodgeStrategy.bind(this), wins: 0, total: 0, weight: 1.0 }
        ];

        // Adaptive Learning Data
        this.learningData = {
            lossPatterns: [], // Track patterns leading to losses
            winPatterns: [],  // Track successful trade patterns
            assetPerformance: {} // Track win/loss per asset
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
        console.log('🚀 Connecting HyperOptic Trading Engine to Deriv API...');
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
            !this.suspendedAssets.has(asset) &&
            !this.tradingPaused) {
            this.analyzeTicks(asset);
        }
    }

    // HyperOptic Strategies - Built for Speed and Adaptability
    momentumSurgeStrategy(history) {
        // Focuses on short-term momentum spikes for quick wins
        const recent = history.slice(-25);
        const digitCounts = Array(10).fill(0);
        recent.forEach((d, idx) => {
            digitCounts[d] += (idx / recent.length); // Weight recent ticks more
        });
        return digitCounts.indexOf(Math.max(...digitCounts));
    }

    patternBreakoutStrategy(history) {
        // Identifies breakout from recent repetitive patterns
        const recent = history.slice(-30);
        const counts = Array(10).fill(0);
        recent.forEach(d => counts[d]++);
        const avgFreq = recent.length / 10;
        const breakoutDigits = counts.map((c, i) => ({ digit: i, deviation: Math.abs(c - avgFreq) }));
        return breakoutDigits.reduce((max, curr) => curr.deviation > max.deviation ? curr : max).digit;
    }

    anomalyDodgeStrategy(history) {
        // Avoids digits with recent loss associations from learning data
        const recent = history.slice(-20);
        const counts = Array(10).fill(0);
        recent.forEach(d => counts[d]++);
        let penalty = Array(10).fill(0);
        if (this.learningData.lossPatterns.length > 0) {
            this.learningData.lossPatterns.slice(-5).forEach(pattern => {
                if (pattern.digit && pattern.timestamp > Date.now() - 3600000) {
                    penalty[pattern.digit] += 2; // Penalize recent loss digits
                }
            });
        }
        const adjustedScores = counts.map((c, i) => c - penalty[i]);
        return adjustedScores.indexOf(Math.max(...adjustedScores));
    }

    // Update Strategy Weights with Aggressive Learning
    updateStrategyWeights(won, strategyName) {
        const strategy = this.strategies.find(s => s.name === strategyName);
        if (!strategy) return;

        strategy.total++;
        if (won) {
            strategy.wins++;
            strategy.weight *= 1.3; // Aggressive boost for winning strategies
        } else {
            strategy.weight *= 0.7; // Sharp penalty for losses
        }

        if (strategy.weight < 0.1) strategy.weight = 0.1; // Prevent total exclusion

        // Normalize weights
        const totalWeight = this.strategies.reduce((sum, s) => sum + s.weight, 0);
        this.strategies.forEach(s => {
            s.weight /= totalWeight;
        });

        console.log(`📈 Updated weight for ${strategyName}: ${strategy.weight.toFixed(2)}`);
    }

    // Analyze Ticks with HyperOptic Precision
    analyzeTicks(asset) {
        if (this.tradeInProgress || this.suspendedAssets.has(asset) || this.tradingPaused) return;

        const history = this.tickHistories[asset];
        const lastDigit = history[history.length - 1];

        console.log('\n🔬 ANALYZING TICKS WITH HYPEROPTIC PRECISION...');
        
        // Calculate votes based on strategy weights
        const votes = Array(10).fill(0);
        let selectedStrategy = null;
        let maxWeight = 0;

        this.strategies.forEach(strategy => {
            const pred = strategy.func(history);
            votes[pred] += strategy.weight;
            if (strategy.weight > maxWeight) {
                maxWeight = strategy.weight;
                selectedStrategy = strategy;
            }
        });

        const predictedDigit = votes.indexOf(Math.max(...votes));
        const confidence = Math.max(...votes) / this.strategies.reduce((sum, s) => sum + s.weight, 0);

        console.log(`\n🎯 PREDICTION: Digit ${predictedDigit} | Confidence: ${(confidence * 100).toFixed(1)}%`);
        console.log(`   Selected Strategy: ${selectedStrategy.name} (Weight: ${selectedStrategy.weight.toFixed(2)})`);

        // Only trade with extremely high confidence to avoid loss streaks
        if (predictedDigit !== lastDigit && confidence >= this.config.confidenceThreshold) {
            this.placeTrade(asset, predictedDigit, selectedStrategy.name);
        } else {
            console.log(`⚠️ Confidence below threshold (${(confidence * 100).toFixed(1)}% < ${(this.config.confidenceThreshold * 100).toFixed(1)}%), skipping trade`);
        }
    }

    placeTrade(asset, predictedDigit, strategyName) {
        if (this.tradeInProgress) return;
        
        this.tradeInProgress = true;
        console.log(`\n🚀 [${asset}] PLACING TRADE`);
        console.log(`   Digit: ${predictedDigit} | Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`   Strategy: ${strategyName}`);
        console.log(`   Confidence: ${(this.config.confidenceThreshold * 100).toFixed(1)}% or higher\n`);

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
            this.tradingPaused = false; // Resume after win
            // Store win pattern for learning
            this.learningData.winPatterns.push({
                digit: parseInt(contract.barrier),
                history: this.tickHistories[asset].slice(-10),
                timestamp: Date.now()
            });
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
            this.suspendAsset(asset);
            // Store loss pattern for learning
            this.learningData.lossPatterns.push({
                digit: parseInt(contract.barrier),
                history: this.tickHistories[asset].slice(-10),
                timestamp: Date.now()
            });
            // Pause trading if consecutive losses hit threshold
            if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
                this.tradingPaused = true;
                console.log(`🛑 Pausing trading due to ${this.consecutiveLosses} consecutive losses. Waiting for reset.`);
            }
        }

        // Update asset performance
        if (!this.learningData.assetPerformance[asset]) {
            this.learningData.assetPerformance[asset] = { wins: 0, losses: 0 };
        }
        won ? this.learningData.assetPerformance[asset].wins++ : this.learningData.assetPerformance[asset].losses++;

        this.totalProfitLoss += profit;
        const strategyName = this.strategies.find(s => s.total === this.totalTrades - 1)?.name || this.strategies[0].name;
        this.updateStrategyWeights(won, strategyName);

        if (!this.endOfDay) {
            this.logSummary();
        }

        // Check stop conditions
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
            console.log(`⏳ Extended pause due to losses. Waiting ${Math.round(this.config.lossPauseDuration / 60000)} minutes...`);
            setTimeout(() => {
                this.tradingPaused = false;
                this.tradeInProgress = false;
                this.connect();
            }, this.config.lossPauseDuration);
        }
    }

    suspendAsset(asset) {
        this.suspendedAssets.add(asset);
        console.log(`🚫 Suspended asset: ${asset}`);
        
        if (this.suspendedAssets.size > 3) {
            const first = Array.from(this.suspendedAssets)[0];
            this.suspendedAssets.delete(first);
            console.log(`✅ Reactivated asset: ${first}`);
        }
    }

    logSummary() {
        const winRate = this.totalTrades > 0 ? (this.totalWins / this.totalTrades * 100).toFixed(2) : 0;
        
        console.log('\n' + '='.repeat(60));
        console.log('📊 HYPEROPTIC TRADING ENGINE - SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total Trades: ${this.totalTrades} | Wins: ${this.totalWins} | Losses: ${this.totalLosses}`);
        console.log(`Win Rate: ${winRate}% | Consecutive Losses: ${this.consecutiveLosses}`);
        console.log(`P&L: ${this.totalProfitLoss.toFixed(2)} | Current Stake: ${this.currentStake.toFixed(2)}`);
        console.log(`Trading Status: ${this.tradingPaused ? 'Paused due to losses' : 'Active'}`);
        console.log(`Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}`);
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
            subject: 'HyperOptic Trading Engine - Summary',
            text: `
                HYPEROPTIC TRADING ENGINE - FINAL SUMMARY
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
            }, 21600000); // 6 Hours
        }
    }

    async sendLossEmail(asset, strategyName) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const history = this.tickHistories[asset];
        const lastFewTicks = history.slice(-20);

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'HyperOptic Trading Engine - Loss Alert',
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
        console.log('🚀 HYPEROPTIC TRADING ENGINE STARTING...');
        console.log('='.repeat(60));
        console.log('Engineered for maximum performance:');
        console.log('  • Ultra-high confidence trading threshold');
        console.log('  • Adaptive learning from wins and losses');
        console.log('  • Aggressive pause to dodge loss streaks');
        console.log('='.repeat(60) + '\n');
        
        this.connect();
    }
}

// ==================== INITIALIZE AND START BOT ====================
const bot = new HyperOpticTradingEngine('0P94g4WdSrSrzir', {
    initialStake: 0.61,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    stopLoss: 150,
    takeProfit: 135,
    requiredHistoryLength: 1000,
    minWaitTime: 120000, // 2 Minutes
    maxWaitTime: 240000, // 4 Minutes
    confidenceThreshold: 0.85,
    lossPauseDuration: 600000 // 10 Minutes
});

bot.start();
