'use strict';
/**
 * differAnalyzer.js — 4-Engine Consensus Digit Differ Analyzer
 *
 * STRATEGY CORRECTION vs old bot:
 *   DIGITDIFF wins when next_digit ≠ chosen_digit.
 *   Win prob = 1 - P(chosen_digit appears).
 *   → Bet DIFFER on the COLDEST digit (least likely to appear next).
 *
 * Engines:
 *   1. MarkovEngine     — Order-2 Markov chain transition probabilities
 *   2. FrequencyEngine  — Multi-window weighted frequency (20/50/100 ticks)
 *   3. StatisticalEngine— Z-score + Chi-square + Shannon entropy
 *   4. StreakEngine      — Absence streaks + hot-filter veto
 *   5. ConsensusAnalyzer— Weighted vote aggregation → final digit + confidence
 */

// ─────────────────────────────────────────────────────────────────────────────
// ENGINE 1: Markov Chain (Order 2)
// ─────────────────────────────────────────────────────────────────────────────
class MarkovEngine {
    constructor(minStateSamples = 20) {
        this.minStateSamples = minStateSamples;
        // 100 states (d1*10+d2) × 10 next-digits
        this.matrix = Array.from({ length: 100 }, () => new Array(10).fill(0));
        this.stateCounts = new Array(100).fill(0);
    }

    /** Feed historical digit array to pre-populate the matrix */
    bootstrap(digits) {
        for (let i = 2; i < digits.length; i++) {
            const state = digits[i - 2] * 10 + digits[i - 1];
            this.matrix[state][digits[i]]++;
            this.stateCounts[state]++;
        }
    }

    /** Update with one new digit (call after bootstrap on every new tick) */
    update(digits) {
        const n = digits.length;
        if (n < 3) return;
        const state = digits[n - 3] * 10 + digits[n - 2];
        this.matrix[state][digits[n - 1]]++;
        this.stateCounts[state]++;
    }

    /**
     * Returns {vote, confidence, probs} where vote = coldest digit,
     * confidence = 1 - P(vote).
     * Returns null if not enough samples.
     */
    analyze(digits) {
        const n = digits.length;
        if (n < 2) return null;
        const state = digits[n - 2] * 10 + digits[n - 1];
        const total = this.stateCounts[state];
        if (total < this.minStateSamples) return null;

        const row = this.matrix[state];
        const probs = row.map(c => c / total);
        let minProb = 1, vote = 0;
        for (let d = 0; d <= 9; d++) {
            if (probs[d] < minProb) { minProb = probs[d]; vote = d; }
        }
        return { vote, confidence: 1 - minProb, probs, total };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENGINE 2: Multi-Window Frequency
// ─────────────────────────────────────────────────────────────────────────────
class FrequencyEngine {
    constructor(windows = [20, 50, 100], weights = [0.50, 0.30, 0.20]) {
        this.windows = windows;
        this.weights = weights;
    }

    analyze(digits) {
        const maxWin = this.windows[this.windows.length - 1];
        if (digits.length < maxWin) return null;

        // Weighted frequency score per digit (lower = colder = better DIFFER target)
        const score = new Array(10).fill(0);
        for (let wi = 0; wi < this.windows.length; wi++) {
            const win = this.windows[wi];
            const slice = digits.slice(-win);
            const freq = new Array(10).fill(0);
            slice.forEach(d => freq[d]++);
            for (let d = 0; d <= 9; d++) {
                score[d] += this.weights[wi] * (freq[d] / win);
            }
        }

        let minScore = 1, vote = 0;
        for (let d = 0; d <= 9; d++) {
            if (score[d] < minScore) { minScore = score[d]; vote = d; }
        }

        const expectedPerDigit = 0.10;
        const edge = expectedPerDigit - minScore; // positive = under-represented
        const confidence = Math.min(1, Math.max(0, edge / 0.08)); // normalized
        return { vote, confidence, score, minScore, edge };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENGINE 3: Statistical (Z-Score + Chi-Square + Entropy)
// ─────────────────────────────────────────────────────────────────────────────
class StatisticalEngine {
    constructor(window = 100, minChiSquare = 3.5, maxEntropy = 3.10) {
        this.window = window;
        this.minChiSquare = minChiSquare;
        this.maxEntropy = maxEntropy;
    }

    analyze(digits) {
        if (digits.length < this.window) return null;

        const slice = digits.slice(-this.window);
        const n = slice.length;
        const freq = new Array(10).fill(0);
        slice.forEach(d => freq[d]++);

        const expected = n / 10;
        // Chi-square
        let chiSq = 0;
        for (let d = 0; d <= 9; d++) chiSq += Math.pow(freq[d] - expected, 2) / expected;

        // Shannon entropy
        let entropy = 0;
        for (let d = 0; d <= 9; d++) {
            if (freq[d] > 0) {
                const p = freq[d] / n;
                entropy -= p * Math.log2(p);
            }
        }

        // Z-scores (negative = under-represented = good DIFFER target)
        const stdDev = Math.sqrt(n * 0.1 * 0.9);
        const zScores = freq.map(f => (f - expected) / stdDev);
        let minZ = Infinity, vote = 0;
        for (let d = 0; d <= 9; d++) {
            if (zScores[d] < minZ) { minZ = zScores[d]; vote = d; }
        }

        if (chiSq < this.minChiSquare) return { vote, confidence: 0, chiSq, entropy, zScores, pass: false };
        if (entropy > this.maxEntropy) return { vote, confidence: 0, chiSq, entropy, zScores, pass: false };

        // confidence = how negative the z-score is (capped)
        const confidence = Math.min(1, Math.max(0, (-minZ) / 2.5));
        return { vote, confidence, chiSq, entropy, zScores, pass: true };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENGINE 4: Streak / Absence / Hot-Filter
// ─────────────────────────────────────────────────────────────────────────────
class StreakEngine {
    constructor(hotFilterTicks = 3) {
        this.hotFilterTicks = hotFilterTicks;
    }

    analyze(digits) {
        if (digits.length < 10) return null;

        // How many ticks since each digit last appeared
        const absence = new Array(10).fill(0);
        for (let d = 0; d <= 9; d++) {
            let found = false;
            for (let i = digits.length - 1; i >= 0; i--) {
                absence[d]++;
                if (digits[i] === d) { found = true; break; }
            }
            if (!found) absence[d] = digits.length;
        }

        // Hot digits: appeared in last hotFilterTicks ticks → VETO
        const hotSet = new Set(digits.slice(-this.hotFilterTicks));

        // Vote for digit with LONGEST absence that is NOT hot
        let maxAbsence = -1, vote = -1;
        for (let d = 0; d <= 9; d++) {
            if (!hotSet.has(d) && absence[d] > maxAbsence) {
                maxAbsence = absence[d]; vote = d;
            }
        }
        if (vote === -1) {
            // All digits are hot (unlikely), fall back to longest absence
            for (let d = 0; d <= 9; d++) {
                if (absence[d] > maxAbsence) { maxAbsence = absence[d]; vote = d; }
            }
        }

        const confidence = Math.min(1, maxAbsence / 20);
        return { vote, confidence, absence, hotSet: [...hotSet] };
    }

    /** Returns true if digit is NOT in the last hotFilterTicks ticks */
    isDigitSafe(digits, digit) {
        const last = digits.slice(-this.hotFilterTicks);
        return !last.includes(digit);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSENSUS ANALYZER — Aggregates all engines
// ─────────────────────────────────────────────────────────────────────────────
class ConsensusAnalyzer {
    constructor(config = {}) {
        this.cfg = {
            digitWindow: config.digitWindow || 100,
            markovMinSamples: config.markovMinSamples || 20,
            freqWindows: config.freqWindows || [20, 50, 100],
            freqWeights: config.freqWeights || [0.50, 0.30, 0.20],
            statWindow: config.statWindow || 100,
            minChiSquare: config.minChiSquare || 3.5,
            maxEntropy: config.maxEntropy || 3.10,
            hotFilterTicks: config.hotFilterTicks || 3,
            minConsensusScore: config.minConsensusScore || 0.50,
            minEnginesAgreeing: config.minEnginesAgreeing || 2,
            requiredHistoryLength: config.requiredHistoryLength || 100,
            // Engine weights
            wMarkov: config.wMarkov || 0.35,
            wFrequency: config.wFrequency || 0.30,
            wStatistical: config.wStatistical || 0.20,
            wStreak: config.wStreak || 0.15,
        };

        this.markov = new MarkovEngine(this.cfg.markovMinSamples);
        this.frequency = new FrequencyEngine(this.cfg.freqWindows, this.cfg.freqWeights);
        this.statistical = new StatisticalEngine(this.cfg.statWindow, this.cfg.minChiSquare, this.cfg.maxEntropy);
        this.streak = new StreakEngine(this.cfg.hotFilterTicks);
        this._bootstrapped = false;
    }

    /** Call once after loading history */
    bootstrap(digits) {
        this.markov.bootstrap(digits);
        this._bootstrapped = true;
    }

    /** Call on each new tick to update Markov state */
    update(digits) {
        this.markov.update(digits);
    }

    /**
     * Main entry point.
     * Returns: { shouldTrade, predictedDigit, reason, consensusScore,
     *            engineVotes, markov, frequency, statistical, streak }
     */
    analyze(digits) {
        if (digits.length < this.cfg.requiredHistoryLength) {
            return { shouldTrade: false, reason: 'insufficient_history', consensusScore: 0 };
        }

        const mResult = this.markov.analyze(digits);
        const fResult = this.frequency.analyze(digits);
        const sResult = this.statistical.analyze(digits);
        const kResult = this.streak.analyze(digits);

        // Entropy gate (from statistical engine)
        if (sResult && sResult.entropy > this.cfg.maxEntropy) {
            return {
                shouldTrade: false, reason: 'entropy_too_high',
                consensusScore: 0, entropy: sResult.entropy,
                markov: mResult, frequency: fResult, statistical: sResult, streak: kResult,
            };
        }

        // Collect votes
        const votes = new Array(10).fill(0);      // weighted consensus score per digit
        const engineVotes = {};
        let enginesReporting = 0;

        if (mResult) {
            enginesReporting++;
            engineVotes.markov = { vote: mResult.vote, confidence: mResult.confidence };
            votes[mResult.vote] += this.cfg.wMarkov * mResult.confidence;
        }
        if (fResult) {
            enginesReporting++;
            engineVotes.frequency = { vote: fResult.vote, confidence: fResult.confidence };
            votes[fResult.vote] += this.cfg.wFrequency * fResult.confidence;
        }
        if (sResult && sResult.pass) {
            enginesReporting++;
            engineVotes.statistical = { vote: sResult.vote, confidence: sResult.confidence };
            votes[sResult.vote] += this.cfg.wStatistical * sResult.confidence;
        }
        if (kResult) {
            enginesReporting++;
            engineVotes.streak = { vote: kResult.vote, confidence: kResult.confidence };
            votes[kResult.vote] += this.cfg.wStreak * kResult.confidence;
        }

        if (enginesReporting < 2) {
            return { shouldTrade: false, reason: 'not_enough_engines', consensusScore: 0, engineVotes };
        }

        // Find digit with highest consensus score
        let maxScore = 0, predictedDigit = 0;
        for (let d = 0; d <= 9; d++) {
            if (votes[d] > maxScore) { maxScore = votes[d]; predictedDigit = d; }
        }

        // Count how many engines voted for this digit
        const agreeing = Object.values(engineVotes).filter(e => e.vote === predictedDigit).length;

        // Hot-filter veto: predicted digit must NOT have appeared in last hotFilterTicks ticks
        const isSafe = this.streak.isDigitSafe(digits, predictedDigit);

        if (!isSafe) {
            return {
                shouldTrade: false, reason: 'predicted_digit_appeared_recently',
                predictedDigit, consensusScore: maxScore,
                engineVotes, markov: mResult, frequency: fResult,
                statistical: sResult, streak: kResult,
            };
        }
        if (maxScore < this.cfg.minConsensusScore) {
            return {
                shouldTrade: false, reason: `consensus_too_low_${maxScore.toFixed(3)}`,
                predictedDigit, consensusScore: maxScore, agreeing,
                engineVotes, markov: mResult, frequency: fResult,
                statistical: sResult, streak: kResult,
            };
        }
        if (agreeing < this.cfg.minEnginesAgreeing) {
            return {
                shouldTrade: false, reason: `only_${agreeing}_engines_agree`,
                predictedDigit, consensusScore: maxScore, agreeing,
                engineVotes, markov: mResult, frequency: fResult,
                statistical: sResult, streak: kResult,
            };
        }

        return {
            shouldTrade: true,
            reason: 'consensus_confirmed',
            predictedDigit,
            consensusScore: maxScore,
            agreeing,
            engineVotes,
            entropy: sResult?.entropy,
            chiSquare: sResult?.chiSq,
            markov: mResult,
            frequency: fResult,
            statistical: sResult,
            streak: kResult,
            absenceStreak: kResult?.absence[predictedDigit],
            weightedFreq: fResult?.score[predictedDigit],
            zScore: sResult?.zScores[predictedDigit],
        };
    }
}

module.exports = { ConsensusAnalyzer, MarkovEngine, FrequencyEngine, StatisticalEngine, StreakEngine };
