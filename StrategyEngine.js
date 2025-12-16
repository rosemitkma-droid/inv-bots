const { RSI, SMA } = require('technicalindicators');

class StrategyEngine {
  constructor(config) {
    this.config = config;
    this.lastSignal = null;
    this.signalHistory = [];
  }

  generateSignal(tickHistory) {
    if (tickHistory.length < this.config.maLongPeriod) {
      return null; // Not enough data
    }

    const closes = tickHistory.map(t => t.quote);
    
    // Calculate RSI
    const rsiInput = {
      values: closes,
      period: this.config.rsiPeriod
    };
    const rsiValues = RSI.calculate(rsiInput);
    const currentRSI = rsiValues[rsiValues.length - 1];

    // Calculate Moving Averages
    const maShortInput = {
      values: closes,
      period: this.config.maShortPeriod
    };
    const maLongInput = {
      values: closes,
      period: this.config.maLongPeriod
    };
    
    const maShortValues = SMA.calculate(maShortInput);
    const maLongValues = SMA.calculate(maLongInput);
    
    const currentMAShort = maShortValues[maShortValues.length - 1];
    const currentMALong = maLongValues[maLongValues.length - 1];

    // Generate signals
    let signal = null;
    let strength = 0;

    // BUY signal: RSI oversold + bullish MA cross
    if (currentRSI < this.config.rsiOversold && currentMAShort > currentMALong) {
      strength = ((this.config.rsiOversold - currentRSI) / this.config.rsiOversold) * 
                 ((currentMAShort - currentMALong) / currentMALong);
      
      if (strength >= this.config.minSignalStrength) {
        signal = {
          direction: 'CALL',
          confidence: 'high',
          strength: strength,
          rsi: currentRSI,
          maShort: currentMAShort,
          maLong: currentMALong
        };
      }
    }
    
    // SELL signal: RSI overbought + bearish MA cross
    if (currentRSI > this.config.rsiOverbought && currentMAShort < currentMALong) {
      strength = ((currentRSI - this.config.rsiOverbought) / (100 - this.config.rsiOverbought)) * 
                 ((currentMALong - currentMAShort) / currentMALong);
      
      if (strength >= this.config.minSignalStrength) {
        signal = {
          direction: 'PUT',
          confidence: 'high',
          strength: strength,
          rsi: currentRSI,
          maShort: currentMAShort,
          maLong: currentMALong
        };
      }
    }

    // Filter consecutive same signals
    if (signal && this.lastSignal === signal.direction) {
      return null; // Wait for opposite signal
    }

    if (signal) {
      this.lastSignal = signal.direction;
      this.signalHistory.push({
        ...signal,
        timestamp: Date.now()
      });
    }

    return signal;
  }

  getSignalStats() {
    const last24Hours = this.signalHistory.filter(s => 
      s.timestamp > Date.now() - 24 * 60 * 60 * 1000
    );
    
    return {
      totalSignals: this.signalHistory.length,
      recentSignals: last24Hours.length,
      lastSignal: this.lastSignal
    };
  }
}

module.exports = StrategyEngine;
