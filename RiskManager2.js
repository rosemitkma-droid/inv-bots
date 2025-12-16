class RiskManager {
  constructor(config) {
    this.config = config;
    this.dailyRisked = 0;
    this.lastReset = new Date().toDateString();
  }

  canTrade(state) {
    // Reset daily counter
    const today = new Date().toDateString();
    if (today !== this.lastReset) {
      this.dailyRisked = 0;
      this.lastReset = today;
    }

    // Check daily risk limit
    if (this.dailyRisked >= state.capital * this.config.maxDailyRisk) {
      console.log('🛑 Daily risk limit reached');
      return false;
    }

    // Check max drawdown
    const peak = Math.max(...state.equityCurve, state.capital);
    const drawdown = (peak - state.capital) / peak;
    if (drawdown > 0.15) {
      console.log('🛑 Max drawdown exceeded');
      return false;
    }

    return true;
  }

  calculatePositionSize(capital, stopLossPrice, entryPrice) {
    const riskPerShare = Math.abs(entryPrice - stopLossPrice);
    const dollarRisk = capital * this.config.maxTradeRisk;
    
    // Kelly Criterion for position sizing
    const winRate = 0.4; // Conservative estimate
    const payoutRatio = 2; // 1:2 risk:reward
    const kelly = (winRate * payoutRatio - (1 - winRate)) / payoutRatio;
    const kellyPosition = (dollarRisk / riskPerShare) * (kelly * this.config.kellyFraction);
    
    // Floor: minimum 0.5% risk
    // Cap: maximum 2% risk
    const minSize = (capital * 0.005) / riskPerShare;
    const maxSize = (capital * 0.02) / riskPerShare;
    
    return Math.max(minSize, Math.min(kellyPosition, maxSize));
  }

  recordRisk(riskAmount) {
    this.dailyRisked += riskAmount;
  }
}

module.exports = RiskManager;
