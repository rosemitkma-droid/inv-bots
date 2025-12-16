const WebSocket = require('ws');

class DerivAPI {
  constructor(token) {
    this.token = token;
    this.ws = null;
    this.connected = false;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.tickCallbacks = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');
      
      this.ws.on('open', () => {
        console.log('✅ Connected to Deriv API');
        this.connected = true;
        resolve();
      });
      
      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      });
      
      this.ws.on('message', (data) => {
        const message = JSON.parse(data);
        this.handleMessage(message);
      });
    });
  }

  async authorize() {
    if (!this.connected) await this.connect();
    
    const response = await this.sendRequest({ authorize: this.token });
    
    if (response.error) {
      throw new Error(`Authorization failed: ${response.error.message}`);
    }
    
    console.log(`✅ Authorized: ${response.authorize.fullname}`);
    return response.authorize;
  }

  sendRequest(data) {
    return new Promise((resolve) => {
      const id = ++this.requestId;
      data.req_id = id;
      
      this.pendingRequests.set(id, resolve);
      this.ws.send(JSON.stringify(data));
    });
  }

  handleMessage(message) {
    // Handle contract updates
    if (message.msg_type === 'proposal_open_contract') {
      const callback = this.tickCallbacks.get(message.proposal_open_contract.contract_id);
      if (callback) callback(message.proposal_open_contract);
    }
    
    // Handle request responses
    if (message.req_id) {
      const resolver = this.pendingRequests.get(message.req_id);
      if (resolver) {
        resolver(message);
        this.pendingRequests.delete(message.req_id);
      }
    }
  }

  async getProposal(params) {
    const response = await this.sendRequest({
      proposal: 1,
      ...params
    });
    
    if (response.error) {
      throw new Error(`Proposal error: ${response.error.message}`);
    }
    
    return response.proposal;
  }

  async buyContract(proposalId, price = 100) {
    const response = await this.sendRequest({ buy: proposalId, price });
    
    if (response.error) {
      throw new Error(`Buy error: ${response.error.message}`);
    }
    
    console.log(`✅ Contract purchased: ${response.buy.contract_id}`);
    return response.buy;
  }

  subscribeToTicks(symbol, callback) {
    this.sendRequest({
      ticks: symbol,
      subscribe: 1
    });
    
    this.tickCallbacks.set(symbol, callback);
    
    // Handle tick messages
    this.ws.on('message', (data) => {
      const message = JSON.parse(data);
      if (message.tick && message.tick.symbol === symbol) {
        callback(message.tick);
      }
    });
    
    console.log(`📡 Subscribed to ${symbol} ticks`);
  }

  subscribeToContract(contractId, callback) {
    this.sendRequest({
      proposal_open_contract: 1,
      contract_id: contractId,
      subscribe: 1
    });
    
    this.tickCallbacks.set(contractId, callback);
    console.log(`📊 Subscribed to contract ${contractId}`);
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      console.log('🔌 Disconnected from Deriv API');
    }
  }
}

module.exports = DerivAPI;
