const WebSocket = require('ws');
const nodemailer = require('nodemailer');



class EnhancedDerivTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.assets = [
            '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V', // 1 Tick per second
            'R_10', 'R_25', 'R_50','R_75', 'R_100',// 1 Tick every 2 seconds
            // 'R_75'
        ];  
        

        this.config = {
            initialStake: config.initialStake,
            multiplier: config.multiplier,
            multiplier2: config.multiplier2,
            maxConsecutiveLosses: config.maxConsecutiveLosses,
            takeProfit: config.takeProfit,
            // Accumulator specific settings
            growthRate: 0.05, // 1%, 2%, 3%, 4% or 5% growth rate
            accuTakeProfit: 0.01, // Take profit amount
            minTradeDelay: 120000,
            maxTradeDelay: 880000,
        };
        
        this.currentProposalId = null;

        // Initialize other properties
        this.currentStake = this.config.initialStake;
        this.lastDigits = [];
        this.tickHistory = [];
        this.usedAssets = new Set();
        this.consecutiveLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.consecutiveLosses6 = 0;
        this.consecutiveLosses7 = 0;
        this.consecutiveLosses8 = 0;
        this.consecutiveLosses9 = 0;
        this.currentAsset = null;
        this.currentTradeId = null;
        this.lastDigitsList = [];
        this.tickHistory = [];
        this.tradeInProgress = false;
        this.wsReady = false;
        this.predictedDigit = null;
        this.Percentage = 0;
        this.usedAssets = new Set();
        this.consecutiveLosses = 0;
        this.currentAsset = null;
        this.currentTradeId = null;
        this.connected = false;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.Pause = false;
        this.RestartTrading = true;
        this.endOfDay = false;
        this.requiredHistoryLength = 100, // Number of ticks to analyze
        this.kCount = false;
        this.kCountNum = 0;
        this.kLoss = 0.01;
        this.multiplier2 = false;
        this.confidenceThreshold = 0.5;
        this.kTradeCount = 0;
        this.isWinTrade = false;
        this.waitTime = 0;
        this.LossDigitsList = [];
        this.threeConsecutiveDigits = 0;
        this.predictedType = '';
        this.Sys1 = 0;
        this.tradedDigitArray = [];
        this.tradedDigitArray2 = [];
        this.totalArray = [];
        this.filteredArray = [];
        this.tradeNum = Math.floor(Math.random() * (40 - 21 + 1)) + 21;
        this.filterNum = 2;



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
            if(!this.Pause) {
                this.handleDisconnect();
            }
        });
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
                setTimeout(() => this.startTrading(), 60000); // Wait for 1 minute before retrying
                break;
            case 'MarketIsClosed':
                console.log('Market is closed. Waiting for market to open...');
                setTimeout(() => this.startTrading(), 3600000); // Wait for 1 hour before retrying
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
        // console.log(`Subscribed to ticks for asset: ${asset}`);
    }

    // First get a proposal for the trade
    requestProposal() {
        if (this.tradeInProgress) return;

        const proposal = {
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: this.currentAsset,
            growth_rate: this.config.growthRate,
            limit_order: {
                take_profit: this.kLoss            
            }
            
        };

        // console.log('Requesting proposal:', JSON.stringify(proposal, null, 2));
        this.sendRequest(proposal);
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
            this.startTrading();

        } else if (message.msg_type === 'proposal') {
            this.handleProposal(message);
        } else if (message.msg_type === 'tick') {
            this.handleTickUpdate(message.tick);
        }  else if (message.msg_type === 'history') {
            this.handleTickHistory(message.history);
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
        }  else if (message.msg_type === 'forget') {
            console.log('Successfully unsubscribed from Current Asset');
            this.currentTradeId = null;
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
        } else if (['R_10', 'R_25'].includes(asset)) {
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
        if (this.usedAssets.size > 5) {
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
        
        this.tickHistory.push(lastDigit);
        if (this.tickHistory.length > this.requiredHistoryLength) {
            this.tickHistory.shift();
        }

        const tickHistory = this.tickHistory;

        // if(this.lastDigitsList.length > 1) { 
            this.analyzeTicks(tickHistory);           
        // }
        
        console.log(`Received tick history: ${this.tickHistory.length}`);
        console.log(`Received tick: ${this.currentAsset}=>  ${tick.quote} (Last digit: ${lastDigit})`);       
        if(this.tradeInProgress) { 
            console.log(`Recent tick History: ${this.tickHistory.slice(-5).join(', ')}`);           
        }
    
    }

     // Handle the Proposal response
     handleProposal(response) {
        if (response.error) {
            console.error('Proposal error:', response.error.message);
            this.tradeInProgress = false;
            return;
        }

     
        if (response.proposal) {
            const stayedInArray = response.proposal.contract_details.ticks_stayed_in;
            this.stayedInArray25 = stayedInArray.slice(-16);

            // console.log('Received proposal:', stayedInArray);
            console.log('16 proposal:', this.stayedInArray25);
            
            const currentDigitCount = stayedInArray[99] + 1;
            const currentDigitCount2 = this.stayedInArray25[15] + 1;

            // console.log(`Current StayedIn Digit Count: ${stayedInArray[99]} (${currentDigitCount})`);
            console.log(`16 Current StayedIn Digit Count: ${this.stayedInArray25[15]} (${currentDigitCount2})`);
            this.currentProposalId = response.proposal.id;
            
            this.totalArray = stayedInArray;
            

            // Create frequency map of digits
            const digitFrequency = {};
            this.stayedInArray25.forEach(digit => {
                digitFrequency[digit] = (digitFrequency[digit] || 0) + 1;
            });                             
                        
            
             // 10, Decrease for more Less conservative Entry, don't go lower than 7 (Setup for the number of times Market Restarted for a new StayIN sequence)

            // Create array 1
            const appearedOnceArray = Object.keys(digitFrequency)
                .filter(digit => digitFrequency[digit] === this.filterNum) 
                .map(Number);
            
            // Create array 2
            const appearedOnceArray1 = Object.keys(digitFrequency)
                .filter(digit => digitFrequency[digit] === 3) 
                .map(Number);
            
            // Create array 3
            const appearedOnceArray2 = Object.keys(digitFrequency)
                .filter(digit => digitFrequency[digit] === 4) 
                .map(Number);
            
            // Create array 4
            const appearedOnceArray3 = Object.keys(digitFrequency)
                .filter(digit => digitFrequency[digit] === 5) 
                .map(Number);
            
            // Create array 5
            const appearedOnceArray4 = Object.keys(digitFrequency)
                .filter(digit => digitFrequency[digit] === 6) 
                .map(Number);

            // Create array 6
            const appearedOnceArray5 = Object.keys(digitFrequency)
                .filter(digit => digitFrequency[digit] === 7) 
                .map(Number);

            // Create array 7
            const appearedOnceArray6 = Object.keys(digitFrequency)
                .filter(digit => digitFrequency[digit] === 8) 
                .map(Number);

            // Create array 8
            const appearedOnceArray7 = Object.keys(digitFrequency)
                .filter(digit => digitFrequency[digit] === 9) 
                .map(Number);

            // Create array 9
            const appearedOnceArray8 = Object.keys(digitFrequency)
                .filter(digit => digitFrequency[digit] === 10) 
                .map(Number);
            
            // Create array 10
            const appearedOnceArray9 = Object.keys(digitFrequency)
            .filter(digit => digitFrequency[digit] === 11) 
            .map(Number);

            // Create array 11
            const appearedOnceArray10 = Object.keys(digitFrequency)
            .filter(digit => digitFrequency[digit] === 12) 
            .map(Number);
                              
             
            // console.log(`
            //     StayedIn Analysis: 
            //     2 Array: ${appearedOnceArray} (${appearedOnceArray.length})
            //     3 Array: ${appearedOnceArray1} (${appearedOnceArray1.length})
            //     4 Array: ${appearedOnceArray2} (${appearedOnceArray2.length})
            //     5 Array: ${appearedOnceArray3} (${appearedOnceArray3.length})
            //     6 Array: ${appearedOnceArray4} (${appearedOnceArray4.length})
            //     7 Array: ${appearedOnceArray5} (${appearedOnceArray5.length})
            //     8 Array: ${appearedOnceArray6} (${appearedOnceArray6.length})
            //     9 Array: ${appearedOnceArray7} (${appearedOnceArray7.length})
            //     10 Array: ${appearedOnceArray8} (${appearedOnceArray8.length})
            //     11 Array: ${appearedOnceArray9} (${appearedOnceArray9.length})
            //     12 Array: ${appearedOnceArray10} (${appearedOnceArray10.length})
            // `); 

            console.log(`filter Number: ${this.filterNum}`);

            console.log(`
                StayedIn Analysis: 
                2 Array: ${appearedOnceArray} (${appearedOnceArray.length})
                3 Array: ${appearedOnceArray1} (${appearedOnceArray1.length})
                4 Array: ${appearedOnceArray2} (${appearedOnceArray2.length})
                5 Array: ${appearedOnceArray3} (${appearedOnceArray3.length})
                6 Array: ${appearedOnceArray4} (${appearedOnceArray4.length})
                `)
            

            if (!this.tradeInProgress) {

                // if(appearedOnceArray.length < 1 || appearedOnceArray1.length > 0 || appearedOnceArray2.length > 0 || appearedOnceArray3.length > 0 || appearedOnceArray4.length > 0 || appearedOnceArray5.length > 0) {
                //     this.RestartTrading = true;
                //     this.disconnect();
                // }

                // if (appearedOnceArray.includes(currentDigitCount) 
                //     && !this.tradedDigitArray.includes(currentDigitCount) 
                //     && this.stayedInArray25[99] >= 0
                //     ) 
                //     {
                //    this.tradedDigitArray.push(currentDigitCount)
                //    this.filteredArray = appearedOnceArray;
                //    console.log('Traded Digit Array:', this.tradedDigitArray);
                //    this.placeTrade();
                // }
                console.log('kTraded Digit Array:', this.tradedDigitArray[this.tradedDigitArray.length - 1])

                // if (this.consecutiveLosses < 1) {
                    // if (
                        // (appearedOnceArray1.includes(currentDigitCount) || appearedOnceArray2.includes(currentDigitCount) || appearedOnceArray3.includes(currentDigitCount))
                        // (appearedOnceArray.includes(currentDigitCount2))
                        // && this.stayedInArray25[0] !== currentDigitCount2
                        // && this.stayedInArray25[1] !== currentDigitCount2
                        // && 
                        // this.stayedInArray25[15] >= 0
                        // ) 
                        // {
                       this.tradedDigitArray.push(currentDigitCount2)
                       this.filteredArray = appearedOnceArray;
                       console.log('Traded Digit Array:', this.tradedDigitArray);
                       console.log('kTraded Digit Array:', this.tradedDigitArray[this.tradedDigitArray.length - 1])
                       this.placeTrade();
                    // }
                // }
                // else{
                //     if (
                //         // (appearedOnceArray1.includes(currentDigitCount) || appearedOnceArray2.includes(currentDigitCount) || appearedOnceArray3.includes(currentDigitCount))
                //         (appearedOnceArray.includes(currentDigitCount2))
                //         && this.tradedDigitArray[this.tradedDigitArray.length - 1] !== currentDigitCount2
                //         && this.stayedInArray25[0] !== currentDigitCount2
                //         && this.stayedInArray25[1] !== currentDigitCount2
                //         && this.stayedInArray25[15] >= 0
                //         ) 
                //         {
                //        this.tradedDigitArray.push(currentDigitCount2)
                //        this.filteredArray = appearedOnceArray;
                //        console.log('Traded Digit Array:', this.tradedDigitArray);
                //        this.placeTrade();
                //     }
                // }
            }
        }
    }

        
    // Update analyzeTicks to request proposal instead of direct trade
    analyzeTicks() {
        if (!this.tradeInProgress) {
            
            this.requestProposal(this.currentAsset);

        }
    }

    
    // Place the trade using the proposal ID
    placeTrade() {
        if (this.tradeInProgress) return;

        if (!this.currentProposalId) {
            console.error('No valid proposal ID available');
            this.tradeInProgress = false;
            return;
        }

        const request = {
            buy: this.currentProposalId,
            price: this.currentStake.toFixed(2)
        };

        console.log('🚀 Placing trade:', JSON.stringify(request, null, 2));
        this.sendRequest(request);
        this.tradeInProgress = true;
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
        
        // Existing trade result handling
        console.log(`Trade outcome: ${won ? '✅ Won' : '❌ Lost'}`);
       
        this.totalTrades++;
        
        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            
            // if (this.consecutiveLosses >= 1) {
            //     this.kCountNum++;
            //     if(this.kCountNum === 1) {
                    this.currentStake = this.config.initialStake;
                    this.consecutiveLosses = 0;
                    this.kCountNum = 0;
            //     }
            // }

            // this.currentStake = this.config.initialStake;
            this.kLoss = 0.01;

            // this.RestartTrading = true;

            // this.filterNum = 2;
           
        } else {
            this.kCountNum = 0;
            this.isWinTrade = false;
            this.totalLosses++;
            this.consecutiveLosses++;
            // this.kLoss += profit.toFixed(2);

            // this.filterNum++;

                        
            if (this.consecutiveLosses === 1) {
                // this.kLoss = 2;
            } else if (this.consecutiveLosses === 2) {
                // this.kLoss = 4;
                this.consecutiveLosses2++;
            } else if (this.consecutiveLosses === 3) {
                // this.kLoss = 8;
                this.consecutiveLosses3++;
            } else if (this.consecutiveLosses === 4) {
                // this.kLoss = 16;
                this.consecutiveLosses4++;
            } else if (this.consecutiveLosses === 5) {
                // this.kLoss = 32;
                this.consecutiveLosses5++;
            } else if (this.consecutiveLosses === 6) {
                // this.kLoss = 64;
                this.consecutiveLosses6++;
            }

            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;

        }

        
        this.RestartTrading = true;

 
        this.totalProfitLoss += profit;

        if (!won) {
            this.sendLossEmail();
        }

        // Keep array length under 5 by removing from the start if needed
        if (this.tradedDigitArray.length > 1) {
            this.tradedDigitArray.shift();
        }

        this.tradeNum = Math.floor(Math.random() * (40 - 21 + 1)) + 21;

        this.Pause = true;

        if (!this.endOfDay) {
            this.logTradingSummary();
        }
        
        //Take profit condition
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
            // if(!won) {
            //     this.waitTime = Math.floor(Math.random() * (42000 - 20000 + 1)) + 40000;
            // } else {
            //     this.waitTime = Math.floor(Math.random() * (29000 - 20000 + 1)) + 5000;
            // }

            // if (this.usedAssets.size === this.assets.length) {
            //     this.waitTime = Math.floor(Math.random() * (42000 - 20000 + 1)) + 300000;
            // } else {
            //     this.waitTime = Math.floor(Math.random() * (21000 - 20000 + 1)) + 1000;
            // }
            // this.waitTime = Math.floor(Math.random() * (21000 - 20000 + 1)) + 2000;
            this.waitTime = Math.floor(Math.random() * (this.config.maxTradeDelay - this.config.minTradeDelay + 1)) + this.config.minTradeDelay;

            console.log(`Waiting ${Math.round(this.waitTime/1000)} seconds before next trade...`);
            setTimeout(() => {
                this.Pause = false;
                this.connect();
            }, this.waitTime);
        }
    }

    unsubscribeFromTicks(callback) {
        if (this.currentTradeId && this.tradeInProgress) {
            const request = {
                forget: this.currentTradeId
            };
            this.sendRequest(request);
            console.log(`Unsubscribing from ticks with ID: ${this.currentTradeId}`);
            
            this.ws.once('message', (data) => {
                const message = JSON.parse(data);
                if (message.msg_type === 'forget' && message.forget === this.currentTradeId) {
                    console.log(`Unsubscribed from ticks successfully`);
                    this.currentTradeId = null;
                    if (callback) callback();
                }
            });
        } else {
            if (callback) callback();
        }
    }

    //Check for Disconnect and Reconnect
    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const currentHours = now.getHours();
            const currentMinutes = now.getMinutes();

            // Check for afternoon resume condition (7:00 AM)
            if (this.endOfDay && currentHours === 7 && currentMinutes >= 0) {
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
                if (currentHours >= 16 && currentMinutes >= 0) {
                    console.log("It's past 5:00 PM after a win trade, disconnecting the bot.");
                    this.sendDisconnectResumptionEmailSummary();
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000); // Check every 20 seconds
    }
    

    disconnect() {
        if (this.connected) {
            this.ws.close();
        }
    }

    logTradingSummary() {
        console.log('Trading Summary:');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Total Trades Won: ${this.totalWins}`);
        console.log(`Total Trades Lost: ${this.totalLosses}`);
        console.log(`x2 Losses: ${this.consecutiveLosses2}`);
        console.log(`x3 Losses: ${this.consecutiveLosses3}`);
        console.log(`x4 Losses: ${this.consecutiveLosses4}`);
        console.log(`x5 Losses: ${this.consecutiveLosses5}`);
        console.log(`x6 Losses: ${this.consecutiveLosses6}`);
        console.log(`Total Profit/Loss Amount: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%`);
        // console.log(`predictedDigit: ${this.predictedDigit}`); 
        // console.log(`Percentage: ${this.Percentage} %`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`); 
    }
    
    startEmailTimer() {
        setInterval(() => {
            if (!this.endOfDay) {
            this.sendEmailSummary();
            }
        }, 21600000); // 6 Hours
    }

    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const summaryText = `
        Trading Summary:
        Total Trades: ${this.totalTrades}
        Total Trades Won: ${this.totalWins}
        Total Trades Lost: ${this.totalLosses}
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}
        x6 Losses: ${this.consecutiveLosses6}

        Total Profit/Loss Amount: $${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%

        Current Stake: $${this.currentStake.toFixed(2)}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'k5%Accumulator Trading Bot - Summary',
            text: summaryText
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Email sent successfully:', info.messageId);
        } catch (error) {
            // console.error('Error sending email:', error);
        }
    }

    async sendLossEmail() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const klastDigits = this.lastDigitsList.slice(-20);

        const summaryText = `
        Loss Summary:
        Total Trades: ${this.totalTrades}
        Total Trades Won: ${this.totalWins}
        Total Trades Lost: ${this.totalLosses}
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}
        x6 Losses: ${this.consecutiveLosses6}

        Total Profit/Loss Amount: $${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%

        Last Digit Analysis:
        Asset: ${this.currentAsset}
        Filtered Array: ${this.filteredArray}
        Traded Array: ${this.tradedDigitArray}
        Filtered Number: ${this.filterNum}

        Current Asset Array: ${this.totalArray}


        Current Stake: $${this.currentStake.toFixed(2)}
        `;      

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'k5%Accumulator Trading Bot - Summary',
            text: summaryText
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Email sent successfully:', info.messageId);
        } catch (error) {
            // console.error('Error sending email:', error);
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const mailOptions = {from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'k5%Accumulator Trading Bot - Error Report',
            text: `An error occurred in the trading bot: ${errorMessage}`
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Error email sent successfully:', info.messageId);
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
        Disconnect/Reconnect Email: Time (${currentHours}:${currentMinutes})
        
        
        Trading Summary:
        Total Trades: ${this.totalTrades}
        Total Trades Won: ${this.totalWins}
        Total Trades Lost: ${this.totalLosses}
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}
        x6 Losses: ${this.consecutiveLosses6}

        Trade Analysis:
        Asset: ${this.currentAsset}
        Filtered Array: ${this.filteredArray}
        Traded Array: ${this.tradedDigitArray2} 
        Filtered Number: ${this.filterNum}

        Current Asset Array: ${this.totalArray}
        

        Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'k5%Accumulator Trading Bot - Summary',
            text: summaryText
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Email sent successfully:', info.messageId);
        } catch (error) {
            // console.error('Error sending email:', error);
        }
    }

    start() {
        this.connect();
        this.checkTimeForDisconnectReconnect(); // Automatically handles disconnect/reconnect at specified times
    }
}

// Updated configuration
const bot = new EnhancedDerivTradingBot('DMylfkyce6VyZt7', {
    // 'DMylfkyce6VyZt7', '0P94g4WdSrSrzir'
    initialStake: 1,
    multiplier: 21,
    maxConsecutiveLosses: 3,
    stopLoss: 105,
    takeProfit: 5000,
    growthRate: 0.05, // 5% growth rate
    accuTakeProfit: 0.5, // Take profit amount 
    minWaitTime: 300000, //5 Minutes
    maxWaitTime: 2600000, //1 Hour      
});
bot.start();
