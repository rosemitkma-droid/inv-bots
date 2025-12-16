class PerformanceMonitor {
  calculateSharpeRatio(trades, riskFreeRate = 0.02) {
    if (!trades || trades.length < 30) return 0;
    
    const returns = trades.map(t => t.profit / 100); // Normalize
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdDev = Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length);
    
    if (stdDev === 0) return 0;
    
    return (avgReturn - (riskFreeRate / 252)) / stdDev * Math.sqrt(252);
  }

  calculateMaxDrawdown(equityCurve) {
    if (!equityCurve || equityCurve.length === 0) return 0;
    
    let peak = equityCurve[0];
    let maxDrawdown = 0;
    
    for (const equity of equityCurve) {
      if (equity > peak) peak = equity;
      const drawdown = (peak - equity) / peak;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }
    
    return maxDrawdown;
  }

  calculateProfitFactor(trades) {
    if (!trades || trades.length === 0) return 0;
    
    const wins = trades.filter(t => t.profit > 0).reduce((sum, t) => sum + t.profit, 0);
    const losses = Math.abs(trades.filter(t => t.profit < 0).reduce((sum, t) => sum + t.profit, 0));
    
    return losses > 0 ? wins / losses : 0;
  }
}

module.exports = PerformanceMonitor;
