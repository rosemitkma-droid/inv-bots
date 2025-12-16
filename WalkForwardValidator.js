class WalkForwardValidator {
  constructor(strategy, data, config) {
    this.strategy = strategy;
    this.data = data;
    this.config = config;
  }

  async executeWalkForward() {
    const results = [];
    const step = this.config.trainPeriod + this.config.testPeriod;
    
    for (let i = 0; i < this.config.totalWalks; i++) {
      const trainStart = i * this.config.testPeriod;
      const trainEnd = trainStart + this.config.trainPeriod;
      const testStart = trainEnd;
      const testEnd = testStart + this.config.testPeriod;
      
      const trainSet = this.data.slice(trainStart, trainEnd);
      const testSet = this.data.slice(testStart, testEnd);
      
      // Optimize parameters on training set
      const params = this.optimizeParameters(trainSet);
      
      // Test on unseen data
      const performance = this.simulate(testSet, params);
      
      results.push(performance);
    }
    
    return this.generateReport(results);
  }

  generateReport(results) {
    const sharpes = results.map(r => r.sharpe);
    const drawdowns = results.map(r => r.maxDrawdown);
    const returns = results.flatMap(r => r.trades.map(t => t.profit));
    
    return {
      sharpeMean: sharpes.reduce((a,b) => a+b) / sharpes.length,
      sharpeStd: Math.sqrt(sharpes.reduce((a,b) => a + Math.pow(b - sharpes.reduce((a,b) => a+b)/sharpes.length, 2) / sharpes.length)),
      maxDD: Math.max(...drawdowns),
      profitFactor: this.calculateProfitFactor(returns),
      tStatistic: this.calculateTStatistic(returns),
      pValue: this.calculatePValue(returns),
      isValid: this.meetsCriteria(sharpes, drawdowns),
      failureReasons: this.getFailures(sharpes, drawdowns)
    };
  }

  meetsCriteria(sharpes, drawdowns) {
    return {
      overall: Math.min(...sharpes) > 0.5 && Math.max(...drawdowns) < 0.15
    };
  }
}

module.exports = WalkForwardValidator;
