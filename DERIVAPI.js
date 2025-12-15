const WebSocket = require('ws');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}]: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/deriv-bot.log' })
  ]
});

class DerivAPI {
  constructor(config) {
    this.appId = config.appId;
    this.token = config.token;
    this.wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
    this.ws = null;
    this.isConnected = false;
    this.isAuthorized = false;
    this.balance = 0;
    this.pendingRequests = new Map();
    this.tickHistory = [];
    this.requestCounter = 0;
    
    // Add promise resolvers for auth
    this.authPromise = null;
    this.authResolve = null;
    this.authReject = null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      
      this.ws.on('open', () => {
        logger.info('Connected to Deriv WebSocket');
        this.isConnected = true;
        
        // Create auth promise
        this.authPromise = new Promise((authResolve, authReject) => {
          this.authResolve = authResolve;
          this.authReject = authReject;
        });

        // Send authorization
        this.authorize();

        // Wait for auth to complete
        this.authPromise.then(() => {
          logger.info('Authorization completed successfully');
          resolve();
        }).catch(error => {
          logger.error(`Authorization failed: ${error.message}`);
          reject(error);
        });
      });

      this.ws.on('message', (data) => {
        try {
          const response = JSON.parse(data);
          this.handleMessage(response);
        } catch (error) {
          logger.error(`Failed to parse message: ${data}`);
        }
      });

      this.ws.on('error', (error) => {
        logger.error(`WebSocket error: ${error.message}`);
        if (this.authReject) this.authReject(error);
      });

      this.ws.on('close', () => {
        logger.warn('WebSocket connection closed');
        this.isConnected = false;
        this.isAuthorized = false;
        setTimeout(() => this.connect(), 5000);
      });
    });
  }

  async authorize() {
    const requestId = this.generateRequestId();
    
    this.ws.send(JSON.stringify({
      authorize: this.token,
      req_id: requestId
    }));

    logger.info(`Authorization request sent (req_id: ${requestId})`);

    // Set up response handler for this request
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
    });
  }

  subscribeToTicks(symbol) {
    if (!this.isAuthorized) {
      logger.error('Cannot subscribe to ticks: Not authorized yet');
      return;
    }

    const requestId = this.generateRequestId();
    this.ws.send(JSON.stringify({
      ticks: symbol,
      subscribe: 1,
      req_id: requestId
    }));
    
    logger.info(`Subscribed to ticks: ${symbol}`);
  }

  async buy(proposal) {
    return new Promise((resolve, reject) => {
      const requestId = this.generateRequestId();
      this.pendingRequests.set(requestId, { resolve, reject });

      const buyRequest = {
        buy: 1,
        price: proposal.amount,
        parameters: {
          amount: proposal.amount,
          basis: "stake",
          contract_type: proposal.contract_type,
          currency: "USD",
          duration: proposal.duration,
          duration_unit: "t",
          symbol: proposal.symbol
        },
        req_id: requestId
      };

      logger.info(`Executing trade: ${JSON.stringify(buyRequest.parameters)}`);
      this.ws.send(JSON.stringify(buyRequest));

      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error('Trade execution timeout'));
        }
      }, 10000);
    });
  }

  handleMessage(response) {
    // CRITICAL: Handle errors first
    if (response.error) {
      logger.error(`API Error: ${response.error.message} (code: ${response.error.code})`);
      
      // If it's an auth error, reject the auth promise
      if (response.error.code === 'InvalidToken' || response.error.code === 'InvalidAppID') {
        if (this.authReject) {
          this.authReject(new Error(`Authorization failed: ${response.error.message}`));
        }
      }
      return;
    }

    // Handle request responses
    if (response.req_id !== undefined && this.pendingRequests.has(response.req_id)) {
      const { resolve, reject } = this.pendingRequests.get(response.req_id);
      this.pendingRequests.delete(response.req_id);

      // If this was the auth request, validate it
      if (response.authorize) {
        this.isAuthorized = true;
        this.balance = parseFloat(response.authorize.balance);
        logger.info(`Authorization successful. Balance: $${this.balance.toFixed(2)}`);
        
        if (this.authResolve) this.authResolve();
        resolve(response);
      } else {
        resolve(response);
      }
      return;
    }

    // Handle subscription updates
    if (response.msg_type === 'tick' && response.tick) {
      this.handleTick(response.tick);
    } else if (response.msg_type === 'balance') {
      this.balance = parseFloat(response.balance.balance);
    } else if (response.msg_type === 'buy') {
      this.handleBuyResponse(response.buy);
    } else if (response.msg_type === 'proposal_open_contract') {
      if (this.onContractUpdate) {
        this.onContractUpdate(response.proposal_open_contract);
      }
    } else {
      // Log unexpected messages
      logger.debug(`Unhandled message type: ${response.msg_type}`);
    }
  }

  handleTick(tick) {
    // CRITICAL: Validate tick object
    if (!tick || !tick.epoch || !tick.quote) {
      logger.warn(`Received invalid tick data: ${JSON.stringify(tick)}`);
      return;
    }

    this.tickHistory.push({
      epoch: tick.epoch,
      quote: parseFloat(tick.quote)
    });

    // Keep last 100 ticks
    if (this.tickHistory.length > 100) {
      this.tickHistory.shift();
    }

    // Emit event for strategy engine
    if (this.onTick) {
      this.onTick(tick);
    }
  }

  handleBuyResponse(buyData) {
    logger.info(`Trade executed: ${buyData.contract_id} - ${buyData.contract_type} $${buyData.buy_price}`);
    if (this.onTrade) {
      this.onTrade(buyData);
    }
  }

  generateRequestId() {
    return ++this.requestCounter;
  }

  async getBalance() {
    return this.balance;
  }
}

module.exports = DerivAPI;
