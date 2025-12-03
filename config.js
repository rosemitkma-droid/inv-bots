/**
 * Bot Configuration
 * Adjust these settings based on your risk tolerance
 */

module.exports = {
    // Deriv API Token - Replace with your actual token
    API_TOKEN: 'Dz2V2KvRf4Uukt3',

    // Trading Parameters
    TRADING: {
        initialStake: 0.61,           // Starting stake in USD
        multiplier: 11.3,              // Stake multiplier after loss (Martingale)
        maxConsecutiveLosses: 3,      // Stop after this many consecutive losses
        stopLoss: 86,                 // Maximum total loss before stopping
        takeProfit: 2000,               // Target profit before stopping
        maxStake: 100,                // Maximum allowed stake
    },

    // Analysis Thresholds - CRITICAL for trade decisions
    ANALYSIS: {
        minHistoryLength: 5000,       // Minimum ticks before trading
        minConfidence: 0.45,          // Minimum confidence to trade (92%)
        maxRepetitionRate: 0.9,      // Max acceptable repetition rate (8%)
        minNonRepStreak: 9,           // Minimum consecutive non-repetitions
        minSampleSize: 500,           // Minimum samples for digit analysis
    },

    // Assets to trade (synthetic indices)
    ASSETS: ['R_50'],

    // Email notifications (optional)
    EMAIL: {
        enabled: true,
        service: 'gmail',
        user: 'kenzkdp2@gmail.com',
        pass: 'jfjhtmussgfpbgpk',
        recipient: 'kenotaru@gmail.com'
    },

    // Timing
    TIMING: {
        reconnectInterval: 5000,      // ms between reconnect attempts
        maxReconnectAttempts: 500,
        tradeCooldown: 2000,          // ms to wait after each trade
    }
};
