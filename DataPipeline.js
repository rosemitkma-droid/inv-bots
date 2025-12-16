const fs = require('fs');

class DataPipeline {
  loadEURUSD() {
    const filePath = './EURUSD_1h.csv';
    
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `\n❌ MISSING DATA FILE: ${filePath}\n\n` +
        `Please download EUR/USD 1-hour data:\n` +
        `1. Visit: https://www.dukascopy.com/swiss/english/marketwatch/historical/\n` +
        `2. Select: EUR/USD > 1 Hour > Last 2 Years\n` +
        `3. Save as: /EURUSD_1h.csv\n`
      );
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line && !line.includes('Date'));
    
    const data = lines.map(line => {
      const [date, time, open, high, low, close, volume] = line.split(',');
      return {
        timestamp: new Date(`${date} ${time}`),
        open: parseFloat(open),
        high: parseFloat(high),
        low: parseFloat(low),
        close: parseFloat(close),
        volume: parseInt(volume) || 0
      };
    }).filter(c => !isNaN(c.close));

    return {
      data,
      quality: this.validateQuality(data)
    };
  }

  validateQuality(data) {
    if (data.length < 1000) return 0.5;
    
    const gaps = data.filter((c, i) => {
      if (i === 0) return false;
      const diff = (c.timestamp - data[i-1].timestamp) / (1000 * 60 * 60);
      return diff > 1.5;
    });
    
    return gaps.length < 50 ? 0.95 : Math.max(0.5, 1 - (gaps.length / data.length));
  }
}

module.exports = DataPipeline;
