/**
 * KO Deriv Differ Bot - NodeJS Version
 * Version 1.00 - Repetition Pattern Strategy
 * 
 * Strategy: Analyze digit repetition patterns and trade when probability is low
 * 
 * Features:
 * - Digit Repetition Pattern Analysis
 * - Multi-Asset Trading
 * - Martingale System
 * - Email Notifications
 * - Configurable Parameters
 */

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

class KODerivDifferBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.config = {
            // Assets
            assets: config.assets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],
            multiAssetEnabled: config.multiAssetEnabled || false,
            parallelTrading: config.parallelTrading || false,
            suspendOnLoss: config.suspendOnLoss !== false,

            // Trading Parameters
            initialStake: config.initialStake || 1,
            tickDuration: config.tickDuration || 1,
            stopLoss: config.stopLoss || 10,
            takeProfit: config.takeProfit || 5,

            // Repetition Pattern Strategy
            historyLength: config.historyLength || 5000,
            repetitionThreshold: config.repetitionThreshold || 10, // percentage
            repetitionThreshold2: config.repetitionThreshold2 || 10, // percentage
            sequenceLength: config.sequenceLength || 5,
            sequenceThreshold: config.sequenceThreshold || 10,
            repetitionThresholdB: config.repetitionThresholdB || 10, // percentage
            repetitionThresholdB2: config.repetitionThresholdB2 || 10, // percentage
            sequenceLengthB: config.sequenceLengthB || 5,
            sequenceThresholdB: config.sequenceThresholdB || 10,
            TradeSys: config.TradeSys || 1,

            // Martingale
            martingaleMultiplier: config.martingaleMultiplier || 2.2,
            martingaleSteps: config.martingaleSteps || 5,
            resetAfterMax: config.resetAfterMax || 'reset', // 'reset', 'stop', 'continue'

            // Connection
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            minWaitTime: config.minWaitTime || 3000,
            maxWaitTime: config.maxWaitTime || 8000,
        };

        // Trading state
        this.currentStake = this.config.initialStake;
        this.initialStake = this.config.initialStake;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalPnL = 0;
        this.consecutiveLosses = 0;
        this.x2Losses = 0;
        this.x3Losses = 0;
        this.x4Losses = 0;
        this.x5Losses = 0;
        this.x6Losses = 0;
        this.x7Losses = 0;
        this.x8Losses = 0;
        this.kWins = 0;
        this.balance = 0;
        this.tradeInProgress = false;
        this.endOfDay = false;
        this.isWinTrade = false;

        // Martingale
        this.martingaleStep = 0;

        // Multi-asset state
        this.activeAssets = this.config.multiAssetEnabled ? this.config.assets : [this.config.assets[0]];
        this.assetData = {};
        this.assetTradesInProgress = {};
        this.assetProposalIds = {};
        this.assetSelectedDigits = {};
        this.suspendedAssets = new Set();

        // Repetition tracking
        this.currentRepetitionProb = {};

        // Trade history
        this.tradeHistory = [];

        // Initialize assets
        this.activeAssets.forEach(asset => {
            this.assetData[asset] = { tickHistory: [] };
            this.assetTradesInProgress[asset] = false;
            this.currentRepetitionProb[asset] = { probability: 0, currentDigit: '--', canTrade: false, canTradeB: false, total: 0 };
        });

        // Telegram Configuration
        this.telegramToken = '8212244373:AAE6-5-ANOmp2rEYYfPBSn8N7uSbRp6HM-k';
        this.telegramChatId = '752497117';

        if (this.telegramToken && this.telegramChatId) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
        } else {
            console.warn('Telegram tokens not found in .env');
        }

        this.reconnectAttempts = 0;

        // Start telegram timer
        this.startTelegramTimer();
    }

    // ========================================================================
    // WEBSOCKET METHODS
    // ========================================================================

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
                if (!this.endOfDay) {
                    this.handleDisconnect();
                }
            });
        }
    }

    send(request) {
        if (this.connected && this.wsReady) {
            this.ws.send(JSON.stringify(request));
        } else if (this.connected && !this.wsReady) {
            setTimeout(() => this.send(request), this.config.reconnectInterval);
        } else {
            console.error('Not connected to Deriv API.');
        }
    }

    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        if (this.reconnectAttempts < this.config.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`Reconnecting (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})...`);
            setTimeout(() => this.connect(), this.config.reconnectInterval);
        }
    }

    authenticate() {
        console.log('Authenticating...');
        this.send({ authorize: this.token });
    }

    // ========================================================================
    // MESSAGE HANDLERS
    // ========================================================================

    handleMessage(message) {
        switch (message.msg_type) {
            case 'authorize':
                if (message.error) {
                    console.error('Authentication failed:', message.error.message);
                    this.disconnect();
                    return;
                }
                console.log('Authentication successful');
                this.balance = parseFloat(message.authorize.balance);
                console.log(`Current Balance: $${this.balance.toFixed(2)}`);
                this.tradeInProgress = false;
                this.subscribeToAllAssets();
                this.send({ balance: 1, subscribe: 1 });
                break;

            case 'history':
                const histAsset = message.echo_req.ticks_history;
                this.handleTickHistory(histAsset, message.history);
                break;

            case 'tick':
                this.handleTick(message.tick);
                break;

            case 'proposal':
                this.handleProposal(message);
                break;

            case 'buy':
                if (message.error) {
                    console.error('Trade error:', message.error.message);
                    const asset = message.echo_req?.symbol;
                    if (asset) this.assetTradesInProgress[asset] = false;
                    return;
                }
                console.log('Trade placed successfully');
                this.subscribeToContract(message.buy.contract_id);
                break;

            case 'proposal_open_contract':
                this.handleContractUpdate(message.proposal_open_contract);
                break;

            case 'balance':
                this.balance = parseFloat(message.balance.balance);
                break;

            default:
                if (message.error) {
                    this.handleApiError(message.error);
                }
        }
    }

    handleApiError(error) {
        console.error('API Error:', error.message);

        switch (error.code) {
            case 'InvalidToken':
                console.error('Invalid token.');
                this.disconnect();
                break;
            case 'RateLimit':
                console.log('Rate limit. Waiting...');
                setTimeout(() => this.subscribeToAllAssets(), 60000);
                break;
            case 'MarketIsClosed':
                console.log('Market closed.');
                setTimeout(() => this.subscribeToAllAssets(), 3600000);
                break;
            default:
                this.subscribeToAllAssets();
        }
    }

    // ========================================================================
    // SUBSCRIPTION METHODS
    // ========================================================================

    subscribeToAllAssets() {
        console.log(`Subscribing to ${this.activeAssets.length} asset(s): ${this.activeAssets.join(', ')}`);

        this.activeAssets.forEach(asset => {
            // Fetch history FIRST
            this.send({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.historyLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });

            // Then subscribe to live ticks
            this.send({ ticks: asset, subscribe: 1 });

            if (!this.assetData[asset]) {
                this.assetData[asset] = { tickHistory: [] };
            }
        });
    }

    handleTickHistory(asset, history) {
        if (!history || !history.prices) return;

        const digits = history.prices.map(price => this.getLastDigit(price, asset));
        this.assetData[asset].tickHistory = digits;

        console.log(`[${asset}] Loaded ${digits.length} historical ticks`);

        // Calculate initial repetition probability
        this.calculateAndDisplayRepetition(asset);
    }

    handleTick(tick) {
        const asset = tick.symbol;
        const digit = this.getLastDigit(tick.quote, asset);

        if (!this.assetData[asset]) {
            this.assetData[asset] = { tickHistory: [] };
        }

        const data = this.assetData[asset];

        // Push new tick to history
        data.tickHistory.push(digit);

        // Keep history at configured length
        if (data.tickHistory.length > this.config.historyLength) {
            data.tickHistory.shift();
        }

        // Calculate repetition probability on EVERY tick
        this.calculateAndDisplayRepetition(asset);

        // Try to trade
        // if (!this.suspendedAssets.has(asset)) {
        this.analyzeAndTrade(asset);
        // }
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

    // ========================================================================
    // REPETITION PATTERN ANALYSIS
    // ========================================================================

    calculateAndDisplayRepetition(asset) {
        const data = this.assetData[asset];
        if (!data || data.tickHistory.length < 2) {
            this.currentRepetitionProb[asset] = {
                globalProbability: 0,
                specificProbability: 0,
                sequenceProbability: 0,
                currentDigit: '--',
                canTrade: false,
                canTradeB: false,
                globalTotal: 0,
                specificTotal: 0,
                sequenceTotal: 0
            };
            return;
        }

        const history = data.tickHistory;
        const currentDigit = history[history.length - 1];

        // 1. Global Analysis
        let globalRepetitions = 0;
        let globalTotal = 0;

        // 2. Specific Analysis (Last digit repeating)
        let specificRepetitions = 0;
        let specificTotal = 0;

        for (let i = 1; i < history.length; i++) {
            const prev = history[i - 1];
            const curr = history[i];

            globalTotal++;
            if (curr === prev) globalRepetitions++;

            if (prev === currentDigit) {
                specificTotal++;
                if (curr === currentDigit) specificRepetitions++;
            }
        }

        // 3. Sequence Analysis
        const seqLength = this.config.sequenceLength;
        let sequenceRepetitions = 0;
        let sequenceTotal = 0;
        let currentSequence = [];

        if (history.length >= seqLength + 1) {
            currentSequence = history.slice(-seqLength);

            // Scan history for this sequence (excluding the current live instance)
            // matching against windows: history[i] ... history[i + seqLength - 1]
            // check next digit: history[i + seqLength]
            for (let i = 0; i < history.length - seqLength; i++) {
                // Check if window matches sequence
                let match = true;
                for (let j = 0; j < seqLength; j++) {
                    if (history[i + j] !== currentSequence[j]) {
                        match = false;
                        break;
                    }
                }

                if (match) {
                    sequenceTotal++;
                    const nextDigit = history[i + seqLength];
                    // Check if the next digit was a repetition of the sequence's last digit
                    if (nextDigit === currentSequence[seqLength - 1]) {
                        sequenceRepetitions++;
                    }
                }
            }
        }

        const globalProbability = globalTotal > 0 ? (globalRepetitions / globalTotal) * 100 : 0;
        const specificProbability = specificTotal > 0 ? (specificRepetitions / specificTotal) * 100 : 0;
        const sequenceProbability = sequenceTotal > 0 ? (sequenceRepetitions / sequenceTotal) * 100 : 0;

        // Log analysis
        console.log(`[${asset}] Repetition Analysis (Last: ${currentDigit})`);
        console.log(`    Global:   ${globalProbability.toFixed(2)}% (${globalRepetitions}/${globalTotal})`);
        console.log(`    Specific: ${specificProbability.toFixed(2)}% (${specificRepetitions}/${specificTotal})`);
        // console.log(`    Sequence: ${sequenceProbability.toFixed(2)}% (${sequenceRepetitions}/${sequenceTotal}) [Pattern: ${currentSequence.join('')}]`);

        // Check conditions (ALL 3 must be met)
        const canTrade = globalProbability < this.config.repetitionThreshold &&
            specificProbability < this.config.repetitionThreshold2 &&
            sequenceProbability < this.config.sequenceThreshold &&
            specificTotal >= 10; // Minimum samples

        const canTradeB = globalProbability >= this.config.repetitionThresholdB
        // &&
        //     specificProbability > this.config.repetitionThresholdB2
        // &&
        // sequenceProbability > this.config.sequenceThresholdB &&
        // specificTotal >= 10; // Minimum samples

        // Store the data
        this.currentRepetitionProb[asset] = {
            globalProbability,
            specificProbability,
            sequenceProbability,
            currentDigit,
            canTrade,
            canTradeB,
            total: globalTotal,
            sequenceTotal,
            threshold: this.config.repetitionThreshold
        };
    }

    // ========================================================================
    // TRADING LOGIC
    // ========================================================================

    analyzeAndTrade(asset) {
        const data = this.assetData[asset];
        if (!data || data.tickHistory.length < 50) return;

        if (this.assetTradesInProgress[asset]) return;
        if (!this.config.parallelTrading && Object.values(this.assetTradesInProgress).some(v => v)) return;

        const repData = this.currentRepetitionProb[asset];
        // console.log('KData', repData);
        if (!repData) return;

        // Trade selection based on TradeSys
        let triggerTrade = false;
        // if (this.config.TradeSys === 2) {
        triggerTrade = repData.canTradeB;
        // }
        // else {
        //     triggerTrade = repData.canTrade;
        // }

        // if (!triggerTrade) return;

        // Trade: Bet DIFFER from current digit (predicted digit = current digit)
        const currentDigit = repData.currentDigit;

        console.log(`[${asset}] 🎯 TRADE SIGNAL MATCHED (System ${this.config.TradeSys})!`);
        if (this.config.TradeSys === 2) {
            console.log(`    Global Prob: ${repData.globalProbability.toFixed(2)}% > ${this.config.repetitionThresholdB}%`);
            console.log(`    Specific Prob: ${repData.specificProbability.toFixed(2)}% > ${this.config.repetitionThresholdB2}%`);
            console.log(`    Sequence Prob: ${repData.sequenceProbability.toFixed(2)}% > ${this.config.sequenceThresholdB}%`);
        } else {
            console.log(`    Global Prob: ${repData.globalProbability.toFixed(2)}% < ${this.config.repetitionThreshold}%`);
            console.log(`    Specific Prob: ${repData.specificProbability.toFixed(2)}% < ${this.config.repetitionThreshold2}%`);
            console.log(`    Sequence Prob: ${repData.sequenceProbability.toFixed(2)}% < ${this.config.sequenceThreshold}%`);
        }
        console.log(`    Action: Betting NEXT DIGIT will NOT be ${currentDigit}`);

        this.assetSelectedDigits[asset] = currentDigit;
        this.requestProposal(asset, currentDigit);
    }

    requestProposal(asset, barrier) {
        this.send({
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'DIGITDIFF',
            currency: 'USD',
            symbol: asset,
            duration: this.config.tickDuration,
            duration_unit: 't',
            barrier: barrier
        });
    }

    handleProposal(message) {
        if (message.error) {
            console.error('Proposal error:', message.error.message);
            return;
        }

        const asset = message.echo_req?.symbol;
        if (!asset) return;

        if (message.proposal && !this.assetTradesInProgress[asset]) {
            this.assetProposalIds[asset] = message.proposal.id;
            this.placeTrade(asset);
        }
    }

    placeTrade(asset) {
        if (this.assetTradesInProgress[asset]) return;
        if (!this.config.parallelTrading && Object.values(this.assetTradesInProgress).some(v => v)) return;

        const proposalId = this.assetProposalIds[asset];
        if (!proposalId) return;

        this.send({
            buy: proposalId,
            price: this.currentStake.toFixed(2)
        });

        this.assetTradesInProgress[asset] = true;
        console.log(`[${asset}] Placing trade: Differ from ${this.assetSelectedDigits[asset]}, Stake: $${this.currentStake.toFixed(2)}, Step: ${this.martingaleStep}/${this.config.martingaleSteps}`);
    }

    subscribeToContract(contractId) {
        this.send({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });
    }

    handleContractUpdate(contract) {
        if (!contract.is_sold) return;

        const asset = contract.underlying;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const exitSpot = contract.exit_tick_display_value;
        const actualDigit = this.getLastDigit(parseFloat(exitSpot), asset);
        const selectedDigit = this.assetSelectedDigits[asset];

        this.assetTradesInProgress[asset] = false;
        this.totalTrades++;

        if (won) {
            this.totalWins++;
            // this.consecutiveLosses = 0;
            // this.martingaleStep = 0;
            this.kWins++;
            if (this.kWins >= 10) {
                this.currentStake = this.initialStake;
                this.consecutiveLosses = 0;
                this.martingaleStep = 0;
                this.kWins = 0;
            }
            console.log(`[${asset}] ✅ WON: +$${profit.toFixed(2)} (Predicted: ${selectedDigit}, Actual: ${actualDigit}) | Martingale reset`);

            if (this.suspendedAssets.size > 1) {
                const toReactivate = this.suspendedAssets.values().next().value;
                this.reactivateAsset(toReactivate);
            }
            this.isWinTrade = true;
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.martingaleStep++;
            this.kWins = 0;

            if (this.consecutiveLosses === 2) this.x2Losses++;
            else if (this.consecutiveLosses === 3) this.x3Losses++;
            else if (this.consecutiveLosses === 4) this.x4Losses++;
            else if (this.consecutiveLosses === 5) this.x5Losses++;
            else if (this.consecutiveLosses === 6) this.x6Losses++;
            else if (this.consecutiveLosses === 7) this.x7Losses++;
            else if (this.consecutiveLosses === 8) this.x8Losses++;
            ;

            if (this.config.suspendOnLoss && this.config.multiAssetEnabled) {
                this.suspendAsset(asset);
            }

            this.currentStake = this.currentStake * this.config.martingaleMultiplier;

            console.log(`[${asset}] ❌ LOST: -$${Math.abs(profit).toFixed(2)} (Predicted: ${selectedDigit}, Actual: ${actualDigit}) | Step ${this.martingaleStep}/${this.config.martingaleSteps}`);
            this.sendTelegramLossAlert(asset, actualDigit, selectedDigit);
            this.isWinTrade = false;
        }

        this.suspendAsset(asset);

        this.totalPnL += profit;
        this.addTradeToHistory(won, profit, selectedDigit, actualDigit, asset);
        this.updateStats();

        if (this.totalPnL <= -this.config.stopLoss || this.martingaleStep >= this.config.martingaleSteps) {
            console.log('Stop loss reached. Stopping bot.');
            this.endOfDay = true;
            this.sendTelegramSummary();
            this.disconnect();
            return;
        }

        if (this.totalPnL >= this.config.takeProfit) {
            console.log('Take profit reached. Stopping bot.');
            this.endOfDay = true;
            this.sendTelegramSummary();
            this.disconnect();
            return;
        }
    }

    // ========================================================================
    // ASSET MANAGEMENT
    // ========================================================================

    suspendAsset(asset) {
        this.suspendedAssets.add(asset);
        console.log(`[${asset}] Suspended due to loss`);
    }

    reactivateAsset(asset) {
        this.suspendedAssets.delete(asset);
        console.log(`[${asset}] Reactivated`);
    }

    // ========================================================================
    // UTILITY METHODS
    // ========================================================================

    updateStats() {
        const winRate = this.totalTrades > 0 ? (this.totalWins / this.totalTrades * 100) : 0;
        console.log('═══════════════════════════════════════════════════════════');
        console.log('                    TRADING SUMMARY');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Wins: ${this.totalWins} | Losses: ${this.totalLosses}`);
        console.log(`Win Rate: ${winRate.toFixed(1)}%`);
        console.log(`x2 Losses: ${this.x2Losses} | x3 Losses: ${this.x3Losses} | x4 Losses: ${this.x4Losses}`);
        console.log(`Total P/L: $${this.totalPnL.toFixed(2)}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`Balance: $${this.balance.toFixed(2)}`);
        console.log('═══════════════════════════════════════════════════════════');
    }

    addTradeToHistory(won, profit, predicted, actual, asset) {
        this.tradeHistory.unshift({ won, profit, predicted, actual, asset, time: new Date() });
        if (this.tradeHistory.length > 100) this.tradeHistory.pop();
    }

    disconnect() {
        if (this.connected) {
            this.ws.close();
        }
    }

    // ========================================================================
    // TELEGRAM NOTIFICATION METHODS
    // ========================================================================

    startTelegramTimer() {
        setInterval(() => {
            if (!this.endOfDay) {
                this.sendTelegramSummary();
            }
        }, 1800000); // 30 minutes
    }

    async sendTelegramSummary() {
        if (!this.telegramBot) return;

        const assetStats = this.activeAssets.map(a => {
            const repData = this.currentRepetitionProb[a] || {};
            return `*${a}*: Rep Prob=${(repData.probability || 0).toFixed(2)}%, Digit=${repData.currentDigit || '--'}`;
        }).join('\n');

        const winRate = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0;

        const summaryText = `
            📊 *Fast x2 Differ Bot Summary*

            *TRADING PERFORMANCE*
            Total Trades: ${this.totalTrades}
            Wins: ${this.totalWins} | Losses: ${this.totalLosses}
            Win Rate: ${winRate}%

            *Consecutive Losses*
            x2: ${this.x2Losses}
            x3: ${this.x3Losses}
            x4: ${this.x4Losses}
            x5: ${this.x5Losses}
            x6: ${this.x6Losses}
            x7: ${this.x7Losses}
            x8: ${this.x8Losses}

            *FINANCIAL*
            Current Stake: $${this.currentStake.toFixed(2)}
            Total P/L: *$${this.totalPnL.toFixed(2)}*
            Balance: $${this.balance.toFixed(2)}

            *STRATEGY*
            Rep Threshold: ${this.config.repetitionThreshold}%
            Martingale: ${this.config.martingaleMultiplier}x (${this.config.martingaleSteps} steps)
        `;

        try {
            await this.telegramBot.sendMessage(this.telegramChatId, summaryText, { parse_mode: 'Markdown' });
            console.log('Telegram summary sent');
        } catch (error) {
            console.error('Telegram Error (Summary):', error.message);
        }
    }

    async sendTelegramLossAlert(asset, actualDigit, predictedDigit) {
        if (!this.telegramBot) return;

        const recentTrades = this.tradeHistory.slice(0, 5);
        const recentAnalysis = recentTrades.map(t =>
            `${t.won ? '✅' : '❌'} [${t.asset}] Pred: ${t.predicted}, Act: ${t.actual}`
        ).join('\n');

        const repData = this.currentRepetitionProb[asset] || {};

        const summaryText = `
            🚨 *LOSS ALERT [${asset}]*

            *TRADE DETAILS*
            Asset: ${asset}
            Predicted (Betting NOT): ${predictedDigit}
            Actual Digit: ${actualDigit}

            *PATTERN ANALYSIS*
            Rep Probability: ${(repData.probability || 0).toFixed(2)}%
            Threshold: ${this.config.repetitionThreshold}% / ${this.config.repetitionThreshold2}%
            Historical Samples: ${repData.total || 0}

            *CURRENT STATUS*
            Wins: ${this.totalWins} | Losses: ${this.totalLosses}
            Martingale Step: ${this.martingaleStep}/${this.config.martingaleSteps}
            Current Stake: $${this.currentStake.toFixed(2)}
            Total P/L: *$${this.totalPnL.toFixed(2)}*

            xLosses:
            x2: ${this.x2Losses}
            x3: ${this.x3Losses}
            x4: ${this.x4Losses}
            x5: ${this.x5Losses}
            x6: ${this.x6Losses}
            x7: ${this.x7Losses}
            x8: ${this.x8Losses}
        `;

        try {
            await this.telegramBot.sendMessage(this.telegramChatId, summaryText, { parse_mode: 'Markdown' });
            console.log('Telegram loss alert sent');
        } catch (error) {
            console.error('Telegram Error (Loss Alert):', error.message);
        }
    }

    // ========================================================================
    // TIME-BASED CONTROLS
    // ========================================================================

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentDay = gmtPlus1Time.getUTCDay(); // 0: Sunday, 1: Monday, ..., 6: Saturday
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            // Weekend logic: Saturday 11pm to Monday 2am GMT+1 -> Disconnect and stay disconnected
            const isWeekend = (currentDay === 0) || // Sunday
                (currentDay === 6 && currentHours >= 23) || // Saturday after 11pm
                (currentDay === 1 && currentHours < 2);    // Monday before 2am

            if (isWeekend) {
                if (!this.endOfDay) {
                    console.log("Weekend trading suspension (Saturday 11pm - Monday 2am). Disconnecting...");
                    this.sendHourlySummary();
                    this.disconnect();
                    this.endOfDay = true;
                }
                return; // Prevent any reconnection logic during the weekend
            }

            if (this.endOfDay && currentHours === 2 && currentMinutes >= 0) {
                console.log("It's 2:00 AM GMT+1, reconnecting the bot.");
                this.resetDailyStats();
                this.endOfDay = false;
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 23 && currentMinutes >= 0) {
                    console.log("It's past 23:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.sendHourlySummary();
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000);
    }

    // ========================================================================
    // START METHOD
    // ========================================================================

    start() {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  🧠 KO DERIV DIFFER BOT v1.00');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');
        console.log('  📊 Strategy: Digit Repetition Pattern Analysis');
        console.log('  🎯 Contract Type: DIGITDIFF');
        console.log('');
        console.log('  ⚙️ Configuration:');
        console.log(`    • Assets: ${this.activeAssets.join(', ')}`);
        console.log(`    • Multi-Asset: ${this.config.multiAssetEnabled ? 'Enabled' : 'Disabled'}`);
        console.log(`    • Parallel Trading: ${this.config.parallelTrading ? 'Enabled' : 'Disabled'}`);
        console.log(`    • History Length: ${this.config.historyLength} ticks`);
        console.log(`    • Trade System: ${this.config.TradeSys}`);
        if (this.config.TradeSys === 2) {
            console.log(`    • Repetition Threshold B: ${this.config.repetitionThresholdB}%`);
            console.log(`    • Repetition Threshold B2: ${this.config.repetitionThresholdB2}%`);
            console.log(`    • Sequence Length B: ${this.config.sequenceLengthB}`);
            console.log(`    • Sequence Threshold B: ${this.config.sequenceThresholdB}%`);
        } else {
            console.log(`    • Repetition Threshold: ${this.config.repetitionThreshold}%`);
            console.log(`    • Repetition Threshold 2: ${this.config.repetitionThreshold2}%`);
            console.log(`    • Sequence Length: ${this.config.sequenceLength}`);
            console.log(`    • Sequence Threshold: ${this.config.sequenceThreshold}%`);
        }
        console.log(`    • Initial Stake: $${this.config.initialStake}`);
        console.log(`    • Martingale: ${this.config.martingaleMultiplier}x (${this.config.martingaleSteps} steps)`);
        console.log(`    • Stop Loss: $${this.config.stopLoss}`);
        console.log(`    • Take Profit: $${this.config.takeProfit}`);
        console.log('');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');

        this.connect();
        this.checkTimeForDisconnectReconnect();
    }
}

// ============================================================================
// RUN THE BOT
// ============================================================================

const token = 'hsj0tA0XJoIzJG5';

const bot = new KODerivDifferBot(token, {
    // Trading Parameters
    initialStake: 0.61,
    tickDuration: 1,
    stopLoss: 1000,
    takeProfit: 100,

    // Repetition Pattern Strategy
    historyLength: 50,
    repetitionThreshold: 9.88,
    repetitionThreshold2: 9,
    sequenceLength: 2,
    sequenceThreshold: 5,
    repetitionThresholdB: 18,
    repetitionThresholdB2: 0,
    sequenceLengthB: 2,
    sequenceThresholdB: 8,

    // Martingale
    martingaleMultiplier: 2,
    martingaleSteps: 7,
    resetAfterMax: 'stop', // 'reset', 'stop', 'continue'

    // Multi-Asset Trading
    multiAssetEnabled: true,
    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR'], // Use single asset or ['R_10', 'R_25', 'R_50', 'R_75', 'R_100','RDBULL', 'RDBEAR',]
    parallelTrading: false,
    suspendOnLoss: false,
    TradeSys: 2,
});

bot.start();

module.exports = KODerivDifferBot;
