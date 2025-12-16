class PerformanceMonitor {
  calculateSharpeRatio(trades, riskFreeRate = 0.02) {
    if (trades.length < 30) return 0;
    
    const returns = trades.map(t => t.profit / t.capital);
    const avgReturn = returns.reduce((a,b) => a+b) / returns.length;
    const stdDev = Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length);
    
    return (avgReturn - riskFreeRate / 252) / stdDev * Math.sqrt(252);
  }

  generateComprehensiveReport(state) {
    return {
      finalCapital: state.capital,
      totalReturn: (state.capital - state.initialCapital) / state.initialCapital,
      sharpeRatio: this.calculateSharpeRatio(state.trades),
      maxDrawdown: this.calculateMaxDrawdown(state.equityCurve),
      winRate: state.trades.filter(t => t.profit > 0).length / state.trades.length,
      profitFactor: this.calculateProfitFactor(state.trades.map(t => t.profit))
    };
  }
}

module.exports = PerformanceMonitor;
