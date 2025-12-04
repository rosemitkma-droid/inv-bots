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
        takeProfit: 5000,               // Target profit before stopping
        maxStake: 100,                // Maximum allowed stake
    },

    // Analysis Thresholds - CRITICAL for trade decisions
    ANALYSIS: {
        minHistoryLength: 5000,       // Minimum ticks before trading
        minConfidence: 0.8,          // Minimum confidence to trade (92%)
        maxRepetitionRate: 0.10,      // Max acceptable repetition rate (10%)
        recentRepetitionRate: 0.08,     // Maximum recent repetition rate (8%)
        selfRepetitionRate: 0.08,     // Maximum self-repetition rate (8%)
        minNonRepStreak: 6,           // Minimum consecutive non-repetitions
        minSampleSize: 500,           // Minimum samples for digit analysis 
    },

    // Assets to trade (synthetic indices)
    ASSETS: ['R_100'],

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
