class RiskManager {
  constructor(config) {
    this.config = {
      maxDailyRisk: config.maxDailyRisk || 0.015,
      maxTradeRisk: config.maxTradeRisk || 0.005,
      kellyFraction: config.kellyFraction || 0.25,
      ...config
    };
  }

  canTrade(state) {
    // Check daily loss limit
    if (state.dailyPnL < -state.capital * this.config.maxDailyRisk) {
      return false;
    }

    // Check if daily risked amount exceeded
    if (state.dailyRisked >= state.capital * this.config.maxDailyRisk) {
      return false;
    }

    // Check if trade already active
    if (state.activeTrade) {
      return false;
    }

    return true;
  }

  calculatePositionSize(capital, stopLossPrice, entryPrice) {
    const riskAmount = capital * this.config.maxTradeRisk;
    const riskPerUnit = Math.abs(entryPrice - stopLossPrice);
    
    if (riskPerUnit === 0) return 0;
    
    const positionSize = riskAmount / riskPerUnit;
    
    // Conservative Kelly sizing
    const winRate = 0.4;
    const payoutRatio = 2;
    const kelly = (winRate * payoutRatio - (1 - winRate)) / payoutRatio;
    const kellySize = positionSize * kelly * this.config.kellyFraction;
    
    // Apply limits
    const minSize = 0.5;
    const maxSize = riskAmount * 2;
    
    return Math.max(minSize, Math.min(kellySize, maxSize));
  }
}

module.exports = RiskManager;
