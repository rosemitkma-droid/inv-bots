const WebSocket = require('ws');
const fs = require('fs');
const nodemailer = require('nodemailer');

// ===================== CONFIGURATION =====================
const CONFIG = {
    apiToken: 'Dz2V2KvRf4Uukt3',
    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],
    initialStake: 1.00,
    targetProfit: 0.25,
    multiplier: 4,
    stopLoss: 50.00,
    maxConsecutiveLosses: 3,
    takeProfit: 100.00,
    growthRate: 0.05,
    survivalThreshold: 0.98, // 98% survival probability
    minWaitTime: 2000,
    maxWaitTime: 5000
};


class EnhancedAccumulatorBot {
    constructor() {
        this.ws = null;
        this.currentStake = CONFIG.initialStake;
        this.totalPnL = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.consecutiveLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.totalTrades = 0;
        this.tradeInProgress = false;
        this.currentTradeId = null;
        this.pnlHistory = [];
        this.survival = { probability: 0, confidence: 'low' };
        this.endOfDay = false;
        this.Pause = false;
        this.isWinTrade = false;
        this.currentK = 0;
        this.emailRecipient = 'kenotaru@gmail.com';
        this.emailConfig = {
            service: 'gmail',
            auth: {
                user: 'kenzkdp2@gmail.com',
                pass: 'jfjhtmussgfpbgpk'
            }
        };
        this.startEmailTimer();

        // Asset data
        this.assetData = {};
        CONFIG.assets.forEach(a => {
            this.assetData[a] = {
                tickHistory: [],
                extendedStayedIn: [],
                previousStayedIn: null,
                trades: [],
                volatility: { short: 0, medium: 0, long: 0 },
                regime: 'unknown',
                score: 0,
            };
        });

        this.riskManager = {
            cooldownUntil: 0,
            adaptiveThreshold: CONFIG.survivalThreshold,
        };
    }

    log(msg, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const icons = { success: '✓', error: '✗', warning: '⚠', trade: '↗', info: 'ℹ' };

        console.log(`${(`[${timestamp}]`)} ${icons[type]} ${msg}`);
    }

    printHeader() {
        console.clear();
        console.log((('Deriv ACCU Bot', { font: 'Slant' })));
        console.log(('Enhanced Accumulator Bot v2.0 - Node.js Edition\n'));
    }

    printStats() {
        const winRate = this.totalTrades > 0 ? (this.totalWins / this.totalTrades * 100).toFixed(1) : 0;

        const stats = (
            `${('Wins:')} ${this.totalWins}   ` +
            `${('Losses:')} ${this.totalLosses}   ` +
            `${('Win Rate:')} ${winRate + '%'}\n` +
            `${('Total P/L:')} ${('$' + this.totalPnL.toFixed(2))}   ` +
            `${('Stake:')} ${('$' + this.currentStake.toFixed(2))}   ` +
            `${('Trades:')} ${this.totalTrades}`
        );
        console.log(stats);
    }

    connect() {
        if (this.endOfDay) return;
        // this.printHeader();
        this.log('Connecting to Deriv WebSocket...', 'info');

        this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            this.log('Connected! Authenticating...', 'success');
            this.ws.send(JSON.stringify({ authorize: CONFIG.apiToken }));
        });

        this.ws.on('message', (data) => {
            const msg = JSON.parse(data);
            this.handleMessage(msg);
        });

        this.ws.on('close', () => {
            this.log('Disconnected. Reconnecting in 5s...', 'warning');
            setTimeout(() => this.connect(), 5000);
        });

        this.ws.on('error', (err) => {
            this.log('WebSocket Error: ' + err.message, 'error');
        });
    }

    handleMessage(msg) {
        switch (msg.msg_type) {
            case 'authorize':
                if (msg.error) {
                    this.log('Auth failed: ' + msg.error.message, 'error');
                    process.exit(1);
                }
                this.log('Authenticated successfully!', 'success');
                this.subscribeToTicks();
                break;

            case 'tick':
                this.handleTick(msg.tick);
                break;

            case 'proposal':
                this.handleProposal(msg);
                break;

            case 'buy':
                this.handleBuy(msg);
                break;

            case 'proposal_open_contract':
                if (msg.proposal_open_contract?.is_sold) {
                    this.handleContractClose(msg.proposal_open_contract);
                }
                break;

            case 'history':
                this.handleHistory(msg);
                break;
        }
    }

    handleHistory(msg) {
        const asset = msg.echo_req.ticks_history;
        if (!this.assetData[asset]) return;

        const prices = msg.history.prices;
        if (prices && prices.length > 0) {
            prices.forEach(price => {
                const digit = this.getLastDigit(price, asset);
                this.assetData[asset].tickHistory.push(digit);
            });

            if (this.assetData[asset].tickHistory.length > 500) {
                this.assetData[asset].tickHistory = this.assetData[asset].tickHistory.slice(-500);
            }

            this.log(`Loaded ${prices.length} historical ticks for ${asset}`, 'success');
        }
    }

    subscribeToTicks() {
        CONFIG.assets.forEach(asset => {
            this.ws.send(JSON.stringify({
                ticks_history: asset,
                end: 'latest',
                count: 200,
                style: 'ticks',
                adjust_start_time: 1
            }));
            this.ws.send(JSON.stringify({ ticks: asset, subscribe: 1 }));
        });
        this.log(`Subscribed to ${CONFIG.assets.length} assets`, 'info');
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

    handleTick(tick) {
        const asset = tick.symbol;
        if (!this.assetData[asset]) return;

        const digit = this.getLastDigit(tick.quote, asset);
        const data = this.assetData[asset];
        data.tickHistory.push(digit);
        if (data.tickHistory.length > 500) data.tickHistory.shift();

        if (data.tickHistory.length >= 100 && !this.tradeInProgress) {
            this.analyzeAsset(asset);
        }
    }

    analyzeAsset(asset) {
        const h = this.assetData[asset].tickHistory;
        if (h.length < 100) return;

        // Volatility
        const vol = (arr) => {
            let changes = 0;
            for (let i = 1; i < arr.length; i++) if (arr[i] !== arr[i - 1]) changes++;
            return changes / (arr.length - 1);
        };
        const v = {
            short: vol(h.slice(-20)),
            medium: vol(h.slice(-50)),
            long: vol(h.slice(-100))
        };
        this.assetData[asset].volatility = v;

        // Score (simplified)
        const avgVol = (v.short + v.medium) / 2;
        let score = 50;
        if (avgVol >= 0.4 && avgVol <= 0.7) score += 30;
        if (avgVol > 0.85 || avgVol < 0.3) score -= 25;
        this.assetData[asset].score = Math.max(0, Math.min(100, score));

        const avgVol2 = ((this.assetData[asset].volatility.short + this.assetData[asset].volatility.medium) / 2 * 100).toFixed(1);

        console.log((
            `${(asset)} → Score: ${(this.assetData[asset].score.toFixed(0))} | Vol: ${avgVol2}%`
        ));

        if (this.tradeInProgress) return false;
        if (Date.now() < this.riskManager.cooldownUntil) return false;

        //Should Trade
        if (this.assetData[asset].score >= 50 && avgVol2 < 80) {
            this.requestProposal(asset);
        }
    }


    requestProposal(asset) {
        this.ws.send(JSON.stringify({
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: "stake",
            contract_type: "ACCU",
            currency: "USD",
            symbol: asset,
            growth_rate: CONFIG.growthRate,
            limit_order: {
                take_profit: (this.currentStake / CONFIG.multiplier).toFixed(2)
            }
        }));
    }

    handleProposal(msg) {
        if (msg.error) return this.log('Proposal error: ' + msg.error.message, 'error');
        const asset = msg.echo_req.symbol;
        const stayedIn = msg.proposal.contract_details.ticks_stayed_in;

        // Initialize history from the first proposal if empty
        if (this.assetData[asset].extendedStayedIn.length === 0 && stayedIn.length > 0) {
            for (let i = 0; i < stayedIn.length - 1; i++) {
                if (stayedIn[i + 1] < stayedIn[i] + 1) {
                    this.assetData[asset].extendedStayedIn.push(stayedIn[i]);
                }
            }
            this.log(`Initialized ${asset} history with ${this.assetData[asset].extendedStayedIn.length} past runs`, 'info');
        }

        // Update extended history
        const prev = this.assetData[asset].previousStayedIn;
        if (prev && stayedIn[99] !== prev[99] + 1) {
            this.assetData[asset].extendedStayedIn.push(prev[99] + 1);
        }
        this.assetData[asset].previousStayedIn = stayedIn.slice();

        const survival = this.calculateSurvivalProbability(asset, stayedIn);
        this.survival = survival;
        const currentK = stayedIn[99] + 1;

        //Survival Check
        if (survival.probability >= this.riskManager.adaptiveThreshold && survival.confidence !== 'low') {
            this.printTradeDecision(asset, survival, currentK);
            this.placeTrade(asset, msg.proposal.id, survival, currentK);
        }
    }

    calculateSurvivalProbability(asset, stayedInArray) {
        const history = this.assetData[asset].extendedStayedIn;
        const currentK = stayedInArray[99] + 1;

        if (history.length < 10) return { probability: 0.5, confidence: 'low' };

        const freq = {};
        history.forEach(l => freq[l] = (freq[l] || 0) + 1);

        let survival = 1;
        let atRisk = history.length;
        for (let k = 1; k < currentK; k++) {
            const events = freq[k] || 0;
            survival *= (1 - events / atRisk);
            atRisk -= events;
        }

        const nextHazard = (freq[currentK] || 0) / atRisk || 0.1;
        const prob = 1 - nextHazard;

        return {
            probability: prob,
            confidence: history.length > 50 ? 'high' : history.length > 20 ? 'medium' : 'low'
        };
    }

    printTradeDecision(asset, survival, currentK) {
        console.log((`${(asset)}\n` + `KCount: ${currentK} → Survival: ${((survival.probability).toFixed(2) + '%')}\n` + `Confidence: ${survival.confidence.toUpperCase()}`));
    }

    placeTrade(asset, proposalId, survival, currentK) {
        this.tradeInProgress = true;
        this.currentK = currentK;
        this.log(`PLACING TRADE on ${asset} | $${this.currentStake} | ${(survival.probability).toFixed(2)}%`, 'trade');
        this.ws.send(JSON.stringify({ buy: proposalId, price: this.currentStake.toFixed(2) }));
    }

    handleBuy(msg) {
        if (msg.error) {
            this.log('Buy failed: ' + msg.error.message, 'error');
            this.tradeInProgress = false;
            return;
        }
        this.currentTradeId = msg.buy.contract_id;
        this.ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: this.currentTradeId, subscribe: 1 }));
    }

    handleContractClose(contract) {
        this.handleResult(contract);
    }

    handleResult(contract) {
        const won = contract.profit > 0;
        const profit = parseFloat(contract.profit);
        const asset = contract.underlying;

        this.totalTrades++;
        this.totalPnL += profit;
        this.pnlHistory.push(this.totalPnL);
        won ? this.totalWins++ : this.totalLosses++;
        this.consecutiveLosses = won ? 0 : this.consecutiveLosses + 1;

        if (won) {
            this.log(`WON $${profit.toFixed(2)} on ${asset} | Total: $${this.totalPnL.toFixed(2)}`, 'success');
            this.currentStake = CONFIG.initialStake;
            this.isWinTrade = true;
        } else {
            this.log(`LOST $${Math.abs(profit).toFixed(2)} on ${asset}`, 'error');
            this.sendLossEmail(asset);
            this.isWinTrade = false;
            this.consecutiveLosses++;

            if (this.consecutiveLosses === 1) this.consecutiveLosses2++;
            if (this.consecutiveLosses === 2) this.consecutiveLosses3++;
            if (this.consecutiveLosses === 3) this.consecutiveLosses4++;
            if (this.consecutiveLosses === 4) this.consecutiveLosses5++;

            this.currentStake = this.currentStake * CONFIG.multiplier;
        }

        this.tradeInProgress = false;
        this.printStats();
        // this.printRunLengthDistribution();

        // Stop conditions
        if (this.totalPnL >= CONFIG.takeProfit) {
            this.log('TAKE PROFIT REACHED! Stopping bot.', 'success');
            this.sendEmailSummary();
            process.exit(0);
        }
        if (this.totalPnL <= -CONFIG.stopLoss || this.consecutiveLosses >= CONFIG.maxConsecutiveLosses) {
            this.log('STOP LOSS or MAX LOSSES! Stopping.', 'error');
            this.sendEmailSummary();
            process.exit(0);
        }

        // Cooldown
        const wait = CONFIG.minWaitTime + Math.random() * (CONFIG.maxWaitTime - CONFIG.minWaitTime);
        this.riskManager.cooldownUntil = Date.now() + wait;
        this.log(`Waiting ${(wait / 1000).toFixed(0)}s before next trade...`, 'info');
    }

    printRunLengthDistribution() {
        const all = [];
        CONFIG.assets.forEach(a => all.push(...this.assetData[a].extendedStayedIn));
        if (all.length === 0) return;

        const freq = {};
        all.forEach(l => {
            const b = l > 15 ? '15+' : l;
            freq[b] = (freq[b] || 0) + 1;
        });

        let dist = 'Run Length Distribution: ';
        Object.keys(freq).sort((a, b) => a - b).forEach(k => {
            dist += `${k}: ${'█'.repeat(Math.min(freq[k] / 2, 20))} (${freq[k]})  `;
        });
        console.log((dist));
    }

    startEmailTimer() {
        if (!this.endOfDay) {
            setInterval(() => {
                this.sendEmailSummary();
            }, 1800000); // 30 Minutes
        }
    }

    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const summaryText = `
        ==================== Trading Summary ====================
        Total Trades: ${this.totalTrades}
        Total Wins: ${this.totalWins}
        Total Losses: ${this.totalLosses}
        Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
        
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}

        Financial:
        Current Stake: ${this.currentStake.toFixed(2)}
        Total P/L: ${this.totalPnL.toFixed(2)}
        
        Asset Volatility:
        ${CONFIG.assets.map(a => `${a}: ${(this.assetData[a].volatility.short * 100 || 0).toFixed(1)}%`).join('\n        ')}
        =========================================================
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'nCluade Accumulator Bot - Performance Summary',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
            this.log('Summary email sent.', 'info');
        } catch (error) {
            console.error('Error sending email:', error);
        }
    }

    async sendLossEmail(asset) {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const history = this.assetData[asset].tickHistory;
        const lastFewTicks = history.slice(-10);
        const d = this.assetData[asset];

        const summaryText = `
        ==================== Loss Alert ====================
        Trade Summary:
        Total Trades: ${this.totalTrades}
        Wins: ${this.totalWins} 
        Losses: ${this.totalLosses}
                
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}

        Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%

        Loss Analysis for [${asset}]:
        Asset Score: ${d.score}
        KCount: ${this.currentK}
        Asset Volatility: ${(d.volatility.short * 100 || 0).toFixed(1)}%
        
        Last 10 Digits: ${lastFewTicks.join(', ')}

        Financial:
        Total P/L: ${this.totalPnL.toFixed(2)}
        Current Stake: ${this.currentStake.toFixed(2)}
        
        ====================================================
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: `nCluade Accumulator Bot - Loss Alert [${asset}]`,
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
            this.log('Loss alert email sent.', 'info');
        } catch (error) {
            console.error('Error sending loss email:', error);
        }
    }

    async sendDisconnectResumptionEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const now = new Date();
        const currentHours = now.getHours();
        const currentMinutes = now.getMinutes();

        const summaryText = `
        Disconnect/Reconnect Email: Time (${currentHours}:${currentMinutes})

        ==================== Trading Summary ====================
        Total Trades: ${this.totalTrades}
        Total Wins: ${this.totalWins}
        Total Losses: ${this.totalLosses}
        Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
        
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}

        Financial:
        Current Stake: ${this.currentStake.toFixed(2)}
        Total P/L: ${this.totalPnL.toFixed(2)}
        
        Asset Volatility:
        ${CONFIG.assets.map(a => `${a}: ${(this.assetData[a].volatility.short * 100 || 0).toFixed(1)}%`).join('\n        ')}
        =========================================================
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'nCluade Accumulator Bot - Performance Summary (Disconnect)',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
            this.log('Disconnect summary email sent.', 'info');
        } catch (error) {
            console.error('Error sending email:', error);
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'nCluade Accumulator Bot - Error Report',
            text: `An error occurred: ${errorMessage}`
        };

        try {
            await transporter.sendMail(mailOptions);
            this.log('Error email sent.', 'error');
        } catch (error) {
            console.error('Error sending error email:', error);
        }
    }

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            // Always use GMT +1 time regardless of server location
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000)); // Convert UTC → GMT+1
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            // Check for Morning resume condition (7:00 AM GMT+1)
            if (this.endOfDay && currentHours === 7 && currentMinutes >= 0) {
                console.log("It's 7:00 AM GMT+1, reconnecting the bot.");
                this.tradeInProgress = false;
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
                    this.endOfDay = true;
                    if (this.ws) this.ws.close();
                }
            }
        }, 5000); // Check every 20 seconds
    }
}

// ===================== START BOT =====================
function start() {
    console.log(('Enhanced Deriv Accumulator Bot v2.0 (Node.js)\n'));
    CONFIG.apiToken = 'Dz2V2KvRf4Uukt3';

    const bot = new EnhancedAccumulatorBot();
    bot.printHeader();
    bot.connect();
    bot.checkTimeForDisconnectReconnect();

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n\nBot stopped by user.');
        process.exit();
    });
}

start();
