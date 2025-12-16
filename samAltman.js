require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

class NeuralEdgeAITrader {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = config.assets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR'];

        this.config = {
            initialStake: config.initialStake || 0.61,
            multiplier: config.multiplier || 4.0,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 2,
            stopLoss: config.stopLoss || 45,
            takeProfit: config.takeProfit || 30,
            requiredHistoryLength: config.requiredHistoryLength || 1000,
            minWaitTime: config.minWaitTime || 150000,
            maxWaitTime: config.maxWaitTime || 270000,
            confidenceThreshold: config.confidenceThreshold || 0.55, // FIXED: Reduced from 0.8
            lossPauseDuration: config.lossPauseDuration || 540000
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

        // FIXED: Strategies now use proper weighted ensemble approach
        this.strategies = [
            { name: 'Neural Trend', func: this.neuralTrendStrategy.bind(this), wins: 0, total: 0, weight: 1.0 }, // Start with slight advantage
            { name: 'Data Entropy', func: this.dataEntropyStrategy.bind(this), wins: 0, total: 0, weight: 1.0 },
            { name: 'Risk Adaptive', func: this.riskAdaptiveStrategy.bind(this), wins: 0, total: 0, weight: 1.0 }
        ];

        // AI Learning Repository
        this.aiData = {
            tradeHistory: [],
            patternWeights: Array(10).fill(0),
            assetRiskProfile: {}
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
        console.log('🚀 Connecting NeuralEdge AI Trader to Deriv API...');
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

    // FIXED: Neural Trend Strategy - Improved weighting
    neuralTrendStrategy(history) {
        const windows = [10, 20, 50];
        const scores = Array(10).fill(0);
        
        windows.forEach((size, idx) => {
            const window = history.slice(-size);
            const counts = Array(10).fill(0);
            window.forEach(d => counts[d]++);
            
            // More aggressive weighting for recent data
            const weight = Math.pow(2, idx);
            counts.forEach((c, digit) => {
                scores[digit] += c * weight;
            });
        });
        
        return scores.indexOf(Math.max(...scores));
    }

    // FIXED: Data Entropy Strategy - Targets overdue digits
    dataEntropyStrategy(history) {
        const recent = history.slice(-50); // Increased window
        const counts = Array(10).fill(0);
        recent.forEach(d => counts[d]++);
        
        // Find least frequent digit (most overdue)
        const minCount = Math.min(...counts);
        const candidates = counts.map((c, i) => c === minCount ? i : -1).filter(i => i >= 0);
        
        // If multiple candidates, use pattern weights
        if (candidates.length > 1) {
            const weighted = candidates.map(digit => ({
                digit,
                score: counts[digit] + this.aiData.patternWeights[digit]
            }));
            weighted.sort((a, b) => a.score - b.score);
            return weighted[0].digit;
        }
        
        return candidates[0];
    }

    // FIXED: Risk Adaptive Strategy - Better risk assessment
    riskAdaptiveStrategy(history) {
        const recent = history.slice(-40);
        const counts = Array(10).fill(0);
        recent.forEach(d => counts[d]++);
        
        // Combine frequency with learned patterns
        const adjusted = counts.map((c, digit) => {
            const patternBoost = this.aiData.patternWeights[digit] * 2; // Increased influence
            const frequency = c / recent.length;
            return (frequency * 10) + patternBoost;
        });
        
        return adjusted.indexOf(Math.max(...adjusted));
    }

    // FIXED: Update Strategy Weights with better learning
    updateStrategyWeights(won, strategyName, predictedDigit) {
        const strategy = this.strategies.find(s => s.name === strategyName);
        if (!strategy) return;

        strategy.total++;
        if (won) {
            strategy.wins++;
            strategy.weight *= 1.15; // Moderate boost
            this.aiData.patternWeights[predictedDigit] += 0.2; // Stronger reinforcement
        } else {
            strategy.weight *= 0.85; // Moderate penalty
            this.aiData.patternWeights[predictedDigit] -= 0.15;
        }

        // Ensure minimum weight floor
        if (strategy.weight < 0.3) strategy.weight = 0.3;

        // Normalize weights to sum to total strategies count
        const totalWeight = this.strategies.reduce((sum, s) => sum + s.weight, 0);
        this.strategies.forEach(s => {
            s.weight = (s.weight / totalWeight) * this.strategies.length;
        });

        console.log(`📈 Updated weight for ${strategyName}: ${strategy.weight.toFixed(2)} (WR: ${((strategy.wins/strategy.total)*100).toFixed(1)}%)`);
    }

    // FIXED: Improved confidence calculation
    analyzeTicks(asset) {
        if (this.tradeInProgress || this.suspendedAssets.has(asset) || this.tradingPaused) return;

        const history = this.tickHistories[asset];
        const lastDigit = history[history.length - 1];

        console.log('\n🔬 ANALYZING TICKS WITH NEURALEDGE AI...');
        
        // Get predictions from all strategies
        const predictions = this.strategies.map(strategy => ({
            strategy,
            digit: strategy.func(history)
        }));

        // Calculate weighted votes for each digit
        const votes = Array(10).fill(0);
        predictions.forEach(pred => {
            votes[pred.digit] += pred.strategy.weight;
        });

        const totalWeight = this.strategies.reduce((sum, s) => sum + s.weight, 0);
        const predictedDigit = votes.indexOf(Math.max(...votes));
        
        // FIXED: Better confidence calculation
        // Confidence = (top vote weight / total weight) * agreement factor
        const topVoteWeight = votes[predictedDigit];
        const baseConfidence = topVoteWeight / totalWeight;
        
        // Agreement factor: how many strategies agree on top prediction
        const agreementCount = predictions.filter(p => p.digit === predictedDigit).length;
        const agreementFactor = agreementCount / this.strategies.length;
        
        // Combined confidence with both factors
        const confidence = baseConfidence * (0.7 + (agreementFactor * 0.3));

        // Select strategy with highest weight that predicted winning digit
        const candidateStrategies = predictions
            .filter(p => p.digit === predictedDigit)
            .sort((a, b) => b.strategy.weight - a.strategy.weight);
        const selectedStrategy = candidateStrategies.length > 0 ? 
            candidateStrategies[0].strategy : this.strategies[0];

        console.log(`\n🎯 PREDICTION: Digit ${predictedDigit} | Confidence: ${(confidence * 100).toFixed(1)}%`);
        console.log(`   Last Digit: ${lastDigit}`);
        console.log(`   Strategy: ${selectedStrategy.name} (Weight: ${selectedStrategy.weight.toFixed(2)})`);
        console.log(`   Agreement: ${agreementCount}/${this.strategies.length} strategies`);
        console.log(`   Strategy Predictions: ${predictions.map(p => `${p.strategy.name}→${p.digit}`).join(', ')}`);

        // FIXED: Trade if confidence meets threshold AND different from last digit
        if (predictedDigit !== lastDigit && confidence >= this.config.confidenceThreshold && agreementCount > 1) {
            this.lastStrategyUsed = selectedStrategy.name;
            this.placeTrade(asset, predictedDigit, selectedStrategy.name, confidence);
        } else {
            if (predictedDigit === lastDigit) {
                console.log(`⚠️ Skipping trade: Predicted digit matches last digit (${lastDigit})`);
            } else {
                console.log(`⚠️ Confidence below threshold: ${(confidence * 100).toFixed(1)}% < ${(this.config.confidenceThreshold * 100).toFixed(1)}%`);
            }
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
        const predictedDigit = parseInt(contract.barrier);

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
            
            if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
                this.tradingPaused = true;
                console.log(`🛑 Pausing trading due to ${this.consecutiveLosses} consecutive losses.`);
            }
        }

        // Update AI trade history
        this.aiData.tradeHistory.push({
            asset: asset,
            digit: predictedDigit,
            outcome: won ? 'win' : 'loss',
            timestamp: Date.now(),
            historySnapshot: this.tickHistories[asset].slice(-10)
        });

        // Update asset risk profile
        if (!this.aiData.assetRiskProfile[asset]) {
            this.aiData.assetRiskProfile[asset] = { wins: 0, losses: 0 };
        }
        won ? this.aiData.assetRiskProfile[asset].wins++ : this.aiData.assetRiskProfile[asset].losses++;

        this.totalProfitLoss += profit;
        const strategyName = this.lastStrategyUsed || this.strategies[0].name;
        this.updateStrategyWeights(won, strategyName, predictedDigit);

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
                this.consecutiveLosses = 0; // FIXED: Reset on resume
                this.tradeInProgress = false;
                this.connect();
            }, this.config.lossPauseDuration);
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
        console.log('📊 NEURALEDGE AI TRADER - SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total Trades: ${this.totalTrades} | Wins: ${this.totalWins} | Losses: ${this.totalLosses}`);
        console.log(`Win Rate: ${winRate}% | Consecutive Losses: ${this.consecutiveLosses}`);
        console.log(`P&L: ${this.totalProfitLoss.toFixed(2)} | Current Stake: ${this.currentStake.toFixed(2)}`);
        console.log(`Trading Status: ${this.tradingPaused ? 'Paused due to losses' : 'Active'}`);
        console.log(`Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}`);
        
        // Show strategy performance
        console.log('\nStrategy Performance:');
        this.strategies.forEach(s => {
            const wr = s.total > 0 ? ((s.wins/s.total)*100).toFixed(1) : 'N/A';
            console.log(`  ${s.name}: ${s.wins}/${s.total} (${wr}%) - Weight: ${s.weight.toFixed(2)}`);
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
            subject: 'NeuralEdge AI Trader - Summary',
            text: `
                NEURALEDGE AI TRADER - FINAL SUMMARY
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
            subject: 'NeuralEdge AI Trader - Loss Alert',
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
        console.log('🚀 NEURALEDGE AI TRADER STARTING...');
        console.log('='.repeat(60));
        console.log('Powered by AI-driven intelligence:');
        console.log('  • Continuous learning from trade outcomes');
        console.log('  • Optimized confidence threshold (55%)');
        console.log('  • Enhanced weighted ensemble strategies');
        console.log('  • Strategic pauses to mitigate loss streaks');
        console.log('='.repeat(60) + '\n');
        
        this.connect();
    }
}

// ==================== INITIALIZE AND START BOT ====================
const bot = new NeuralEdgeAITrader('0P94g4WdSrSrzir', {
    initialStake: 0.61,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    stopLoss: 86,
    takeProfit: 500,
    requiredHistoryLength: 1000,
    minWaitTime: 150000,
    maxWaitTime: 270000,
    confidenceThreshold: 0.55, // FIXED: Reduced from 0.8 to 0.55
    lossPauseDuration: 540000
});

bot.start();
