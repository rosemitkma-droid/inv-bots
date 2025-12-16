class MeanReversionStrategy {
  constructor(config) {
    this.lookback = config.lookbackPeriod;
    this.entryThreshold = config.entryThreshold;
    this.exitThreshold = config.exitThreshold;
  }

  analyze(candles) {
    if (candles.length < this.lookback + 10) return null;

    const closes = candles.map(c => c.close);
    const sma = this.calculateSMA(closes, this.lookback);
    const stdDev = this.calculateStdDev(closes, this.lookback);
    const currentPrice = closes[closes.length - 1];
    const zScore = (currentPrice - sma) / stdDev;

    // ==== ENTRY LOGIC ====
    // Only trade extreme deviations with confirmation
    if (Math.abs(zScore) > this.entryThreshold && this.hasVolumeConfirmation(candles)) {
      return {
        direction: zScore > 0 ? 'SELL' : 'BUY',
        entry: currentPrice,
        stopLoss: zScore > 0 ? currentPrice + (stdDev * 3) : currentPrice - (stdDev * 3),
        takeProfit: this.calculateDynamicTarget(zScore, sma, stdDev),
        confidence: Math.min(Math.abs(zScore) / 4, 1),
        zScore: zScore
      };
    }

    return null;
  }

  hasVolumeConfirmation(candles) {
    const recentVolumes = candles.slice(-5).map(c => c.volume);
    const avgVolume = recentVolumes.reduce((a,b) => a+b) / recentVolumes.length;
    const currentVolume = candles[candles.length - 1].volume;
    
    // Require above-average volume for conviction
    return currentVolume > avgVolume * 1.2;
  }

  calculateDynamicTarget(zScore, sma, stdDev) {
    // Scale target based on extremity
    const targetZScore = zScore > 0 ? -this.exitThreshold : this.exitThreshold;
    return sma + (targetZScore * stdDev);
  }

  calculateSMA(data, period) {
    const sum = data.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
  }

  calculateStdDev(data, period) {
    const slice = data.slice(-period);
    const mean = slice.reduce((a, b) => a + b) / period;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    return Math.sqrt(variance);
  }
}

module.exports = MeanReversionStrategy;
