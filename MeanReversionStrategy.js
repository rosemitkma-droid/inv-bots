class MeanReversionStrategy {
  constructor(config) {
    this.config = {
      lookback: config.lookback || 50,
      entryThreshold: config.entryThreshold || 2.5,
      exitThreshold: config.exitThreshold || 1.0,
      ...config
    };
  }

  analyze(marketData) {
    if (!marketData || marketData.length < this.config.lookback + 10) {
      return null;
    }

    const closes = marketData.map(c => c.close);
    const currentPrice = closes[closes.length - 1];
    
    // Calculate SMA
    const sma = this.calculateSMA(closes, this.config.lookback);
    
    // Calculate standard deviation
    const stdDev = this.calculateStdDev(closes, this.config.lookback);
    
    if (stdDev === 0) return null;
    
    // Calculate Z-Score
    const zScore = (currentPrice - sma) / stdDev;
    
    // Only trade extreme deviations
    if (Math.abs(zScore) > this.config.entryThreshold) {
      // Direction: above SMA = sell/PUT, below = buy/CALL
      const direction = zScore > 0 ? 'SELL' : 'BUY';
      const contractType = direction === 'BUY' ? 'CALL' : 'PUT';
      
      // Risk management levels
      const stopLossDistance = stdDev * 3;
      const takeProfitDistance = stdDev * 1.5;
      
      const stopLoss = direction === 'BUY' 
        ? currentPrice - stopLossDistance 
        : currentPrice + stopLossDistance;
      
      const takeProfit = direction === 'BUY'
        ? currentPrice + takeProfitDistance
        : currentPrice - takeProfitDistance;
      
      // Confidence based on extremity
      const confidence = Math.min(Math.abs(zScore) / 4, 1);
      
      return {
        direction: contractType,
        entry: currentPrice,
        stopLoss,
        takeProfit,
        confidence,
        zScore,
        duration: 60, // 1 hour
        timestamp: new Date()
      };
    }
    
    return null;
  }

  calculateSMA(data, period) {
    if (data.length < period) {
      return data[data.length - 1];
    }
    
    const sum = data.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
  }

  calculateStdDev(data, period) {
    if (data.length < period) {
      return 0;
    }
    
    const slice = data.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    return Math.sqrt(variance);
  }
}

module.exports = MeanReversionStrategy;
