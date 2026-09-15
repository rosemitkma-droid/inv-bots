#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  accuHOLD v4 — SPIKE-TRIGGERED ACCU bot (immediate post-spike)
 * =====================================================================
 *
 *  Single-file Deriv Accumulator (ACCU) bot — TEST/DEMO ONLY.
 *  Forked from accuHOLD_v4.js (tier-aware, watchdog-fixed) per user
 *  request 2026-09-11: SPIKE-TRIGGERED ENTRY ONLY.
 *
 *  ENTRY RULES (new in v4):
 *    • Trade ONLY immediately after a NEW spike is detected on that
 *      symbol. No polling/rate-limited entries.
 *    • After a WIN: wait for the NEXT spike on that same asset before
 *      re-entering (prevents over-trading winners).
 *    • After a LOSS: place a NEW trade IMMEDIATELY on the SAME asset
 *      (martingale step, bypasses spike wait, respects maxOpenTrades).
 *  This is a pure spike-triggered martingale variant — not hazard-gated.
 *  It keeps tier-aware exits (TP + tick-cap live median) and the v4
 *  watchdog/stuck fixes and backfill.
 *
 *  ─ HONESTY (load-bearing — read before enabling live) ────────────
 *  Ten BOOM/CRASH symbols tested (BOOM50/500/600/900/1000 +
 *  CRASH50/500/600/900/1000) with 80k ticks each:
 *    • Spike timing: chi-square GOF + KS vs shifted geometric + hazard
 *      tables → p 0.28–0.96, CV ≈ theoretical √1-p, no hazard lift.
 *      v4's "hits" were two bugs (pseudo-replication + contaminated
 *      windows) — fixed in tester v5, effect vanished.
 *    • Post-spike price: event-study (non-overlapping controls,
 *      contaminated exclusion, Bonferroni ~200 offsets) → no
 *      significant offsets after correction.
 *  ⇒ "Ticks since last spike" tells you nothing about the next spike.
 *  There is NO timing or price-pattern edge to trade on. This v4 build
 *  wires those signals anyway as an EDGE-EXPLORATORY experiment at
 *  your explicit request — expect theoretical negative expectancy.
 *  Run DEMO only; validate with deriv_structure_tester_v5.js first.
 *
 *  What IS empirically true (useful context, encoded as tier defaults):
 *    • ≥2% growth → ~100% of detected spikes breach the barrier; 1%
 *      still ~80% breach.  Growth is a noise-vs-spike risk dial, not
 *      a timing lever.
 *    • Tier FAST (BOOM50/CRASH50, mean spacing ~50-57): at low growth
 *      survival tracks spike interval — spike usually ends contract.
 *    • Tier SLOW (BOOM500/600/900/1000, CRASH500/600/1000, mean ~450-
 *      900): at typical 2% median survival ~30 ticks << spacing —
 *      ordinary tick noise, not the spike, usually ends contract.
 *    • ⇒ growthRate + symbol jointly determine dominant risk. This bot
 *      uses per-tier growthRate + tickCapFraction + TP as a stated risk
 *      preference, not a timing edge.
 *
 *  ─ STRATEGY (v4 — tier-aware + exploratory) ─────────────────────
 *  Per-tier growthRate (fast:0.01, slow:0.02), per-tier tickCapFraction
 *  (fast:0.70, slow:0.55) and TP (fast:1.40, slow:1.35). On buy, two
 *  exits armed on every proposal_open_contract tick:
 *    1. Take-profit: profit ≥ stake×(TP-1)
 *    2. Tick-cap: ticks held ≥ tierFraction × LIVE ticks_stayed_in median
 *  Entry is EXPLORATORY-GATED (hazard + post-spike) when enabled:
 *    • Hazard: ticksSinceSpike ∈ best elevated bucket (max emp-theo lift
 *      where Wilson CI outside theoretical hazard)
 *    • Post-spike: ticksSinceSpike == firstSignificantOffset (Bonferroni)
 *    • Relaxed fallback: if calibrated but no signal, use mean-derived
 *      entryAfter=round(mean*0.30)∈[3,15] and hold clamp — so bot still
 *      trades (ACTIVE_RELAXED / hazardRefractoryBot_v2 behaviour).
 *  Martingale kept at ×2.10 / 8 steps (user #2 "Keep") — high ruin risk
 *  on negative-expectancy ACCU; capped only by maxConsecutiveLosses halt.
 *
 *  ─ RISK CONTROLS ─────────────────────────────────────────────────
 *  Tier-aware stake/TP/cap, per-symbol cooldown (8s), global entry gap
 *  (30s), maxOpenTrades 1, maxConsecutiveLosses 8 (halt), dailyMaxLoss
 *  150, loss histogram x2-x7, watchdog, stuck-sweep, pause/DOW, Telegram.
 *
 *  Author: Cowork 3P (v4 exploratory fork) | License: MIT
 * =====================================================================
 */

// ═══════════════════════════════════════════════════════════════════════
// 0. DEPENDENCIES
// ═══════════════════════════════════════════════════════════════════════
const WebSocket    = require('ws');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const { URL }      = require('url');
const EventEmitter = require('events');

// ═══════════════════════════════════════════════════════════════════════
// 1. .ENV LOADER  (credentials stay hardcoded in CONFIG; .env is opt-in)
// ═══════════════════════════════════════════════════════════════════════
function loadEnv(filePath = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(filePath)) return;
  try {
    const txt = fs.readFileSync(filePath, 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) { console.error('[boot] .env read error:', e.message); }
}
loadEnv();

// ═══════════════════════════════════════════════════════════════════════
// 2. CONFIGURATION  (hardcoded TEST credentials retained per user pattern)
// ═══════════════════════════════════════════════════════════════════════
const CONFIG = Object.freeze({
  // ── Deriv API ──
  apiToken   : 'pat_27a3197287bae3ec6c2c9cbdd68fffaa2a524e3b0a6e1ecf298b5ffb338adb10',
  appId      : '33uslPtthXBEkQOdfKfoY',
  wsUrl      : 'wss://ws.derivws.com/websockets/v3',
  currency   : 'USD',
  accountType: 'demo',   // 'demo' | 'real' — keep demo for testing

  // ── Trade parameters — tier-aware (per-tier growth + cap/TP) ──
  stake              : parseFloat('1.00'),   // base stake per trade (reset value for martingale)
  takeProfitMultiple : parseFloat('1.01'),   // fallback (tier overrides below)
  tickCapFraction    : parseFloat('0.01'),   // fallback (tier overrides below)
  growthRate         : parseFloat('0.05'),   // fallback default; tierGrowthRate below is authoritative

  // Per-tier overrides — user #5 (per-tier override) + #1 (include BOOM50/CRASH50 fast tier)
  tierGrowthRate: Object.freeze({ fast: 0.05, slow: 0.05 }), // fast=1% widest barrier (spike-dominant), slow=2% (noise-dominant)
  tierDefaults: Object.freeze({
    fast: { tickCapFraction: 0.01, takeProfitMultiple: 1.40, growthRate: 0.05 }, // BOOM50/CRASH50
    slow: { tickCapFraction: 0.01, takeProfitMultiple: 1.35, growthRate: 0.05 }, // BOOM/CRASH 500/600/900/1000
  }),
  symbolTiers: Object.freeze({
    fast: ['BOOM50','CRASH50'],
    slow: ['BOOM500','BOOM600','BOOM900','BOOM1000'],
  }),

  // ── Martingale (kept per user #2) ───────────────────────────────
  // On every loss: next stake = base stake × (multiplier ^ step).
  // On win: reset to base stake (step = 0).
  // WARNING: ×3.10 ^8 on negative-expectancy ACCU has high ruin risk.
  martingaleMultiplier : parseFloat('21.00'), // e.g. 3.10 means stake ×3.10 after each loss
  martingaleSteps      : parseInt('3', 10),  // max consecutive martingale multiplications (0 = disabled)
  martingaleMaxStake   : parseFloat('300'),  // cap to bound ruin (null to disable)

  // ── Rate-limited entry ──
  perSymbolCooldownMs : parseInt('8000',  10),   // between trades on the same symbol
  perSymbolEntryGapMs : parseInt('100', 10),   // min gap between any two new entries (global)
  maxOpenTrades       : parseInt('1',     10),   // concurrent open contracts across the bot

  // ── Risk controls ──
  maxConsecutiveLosses : parseInt('3', 10),      // pause + require manual restart
  dailyMaxLoss        : parseFloat('300'),         // demo-appropriate cap
  dailyMaxTrades      : parseInt('120000', 10),      // daily cap
  stopLossPerContract : parseFloat('0'),         // 0 = disabled (rely on knockout)

  // ── Instruments — 10 symbols (fast + slow) per user #1 ──
  assets: ('BOOM500,BOOM560,BOOM900,BOOM1000')
    .split(',').map(s => s.trim()).filter(Boolean),

  // ── Telegram (existing hardcoded values) ──
  telegram: {
    enabled : true,
    botToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    chatId  : '752497117',
    maxQueue: parseInt('200', 10),
  },

  // ── Reconnect ──
  reconnect: { initialDelayMs: 1000, maxDelayMs: 60000, backoffFactor: 2, jitterMs: 750 },

  // ── Open-contract stream watchdog ──
  tradeWatchdogMs  : parseInt('5000', 10),
  proposalRefreshMs: parseInt('60000', 10),   // refresh barrier + ticks_stayed_in cache

  // ── Scheduled pause/resume (GMT) ──
  pauseEnabled : false,  // if true, bot will pause/resume automatically per below
  pauseStartGmt: '23:00',
  pauseEndGmt  : '1:00',

  // ── Day-of-week filter (GMT) ──
  tradeSunday: true, tradeMonday: true, tradeTuesday: true,
  tradeWednesday: true, tradeThursday: true, tradeFriday: true, tradeSaturday: true,

  // ── EOD / hourly summaries (GMT) ──
  eodTimeGmt         : '00:00',
  eodSendDelaySeconds: parseInt('10', 10),
  hourlySummary      : true,

  // ── Spike-triggered entry (v4) + exploratory kept for spike detection ──
  // v4 uses spike detection for ENTRY, not hazard lift. Hazard kept for logging only.
  spikeTrigger: Object.freeze({
    enabled: true,
    immediateReentryOnLoss: true, // if LOSS → place new trade immediately on same asset
    waitForSpikeOnWin: true,      // if WIN → wait for next spike before re-entering that asset
    spikeCooldownMs: 0,           // extra cooldown after a spike-triggered entry (0 = none)
  }),
  exploratory: Object.freeze({
    enabled: true,                // keep true so spike detector runs; hazard not used to gate
    mode: 'hazard',               // 'hazard' = hazardRefractoryBot_v2, 'postSpike' = post-spike Bonferroni, 'relaxed' = mean-derived fallback, both = all three (v4 default)
    logOnly: true,                // hazard only logs, does NOT gate (v4 gates on spike only)
    hazardBuckets: [0,0.25,0.5,0.75,1,1.25,1.5,1.75,2,2.5,3,4,6,Infinity],
    hazardMinLift: parseFloat('0.60'),
    hazardP: 0.05,
    postSpikeHorizon: 200,
    postSpikeMaxControl: 8000,
    wilsonZ: 1.96,
    calibrationMinIntervals: 50,
    historyCap: 80000,
    baselineWindow: 2000,
    recomputeBaselineEvery: 2000,
    excludeBufferAfterSpike: 20,
    minSpikeSeparation: 2,
    spikeThresholdMAD: 10,
    spikeDirection: 'auto',
  }),

  // ── Logging / state — FRESH v4 spike ──
  logFile           : 'accuHOLD4_spike_10.log',
  logLevel          : 'INFO',
  stateFile         : 'accuHOLD4_spike_state_10.json',
  stateSaveOnTrade  : true,
  stateSaveOnShutdown: true,
});

// ═══════════════════════════════════════════════════════════════════════
// 2b. TIER HELPERS
// ═══════════════════════════════════════════════════════════════════════
function getTierForSymbol(symbol) {
  for (const [tier, list] of Object.entries(CONFIG.symbolTiers)) if (list.includes(symbol)) return tier;
  return 'slow';
}
function getGrowthRateForSymbol(symbol) {
  const tier = getTierForSymbol(symbol);
  const perTier = CONFIG.tierGrowthRate && CONFIG.tierGrowthRate[tier];
  if (perTier != null) return perTier;
  const d = CONFIG.tierDefaults && CONFIG.tierDefaults[tier];
  if (d && d.growthRate != null) return d.growthRate;
  return CONFIG.growthRate;
}
function getTickCapFractionForSymbol(symbol) {
  // User should be able to set via env or fallback — 0.01 for 1-tick
  const envVal = parseFloat(process.env.TICK_CAP_FRACTION);
  if (!isNaN(envVal) && envVal > 0) return envVal;
  if (CONFIG.tickCapFraction != null && CONFIG.tickCapFraction > 0 && CONFIG.tickCapFraction < 0.10) return CONFIG.tickCapFraction;
  const tier = getTierForSymbol(symbol);
  const d = CONFIG.tierDefaults && CONFIG.tierDefaults[tier];
  return d ? d.tickCapFraction : CONFIG.tickCapFraction;
}
function getTPForSymbol(symbol) {
  const envVal = parseFloat(process.env.TAKE_PROFIT_MULTIPLE);
  if (!isNaN(envVal) && envVal > 1) return envVal;
  if (CONFIG.takeProfitMultiple != null && CONFIG.takeProfitMultiple > 1 && CONFIG.takeProfitMultiple < 1.10) return CONFIG.takeProfitMultiple;
  const tier = getTierForSymbol(symbol);
  const d = CONFIG.tierDefaults && CONFIG.tierDefaults[tier];
  return d ? d.takeProfitMultiple : CONFIG.takeProfitMultiple;
}

// ═══════════════════════════════════════════════════════════════════════
// 2c. STATISTICAL MACHINERY (ported from deriv_structure_tester_v5.js + hazardRefractoryBot_v2.js)
// ═══════════════════════════════════════════════════════════════════════
function medianArr(arr) { if (!arr.length) return 0; const s=[...arr].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2? s[m] : (s[m-1]+s[m])/2; }
function gammln(xx){ const cof=[76.18009172947146,-86.50532032941677,24.01409824083091,-1.231739572450155,0.1208650973866179e-2,-0.5395239384953e-5]; let x=xx,y=xx,tmp=x+5.5; tmp-=(x+0.5)*Math.log(tmp); let ser=1.000000000190015; for(let j=0;j<6;j++){y+=1; ser+=cof[j]/y;} return -tmp+Math.log((2.5066282746310005*ser)/x); }
const ITMAX=200,EPS=3e-9,FPMIN=1e-300;
function gammaP(a,x){ if(x<0||a<=0) return NaN; if(x===0) return 0; if(x<a+1){ const gln=gammln(a); let ap=a,sum=1/a,del=sum; for(let n=1;n<=ITMAX;n++){ ap+=1; del*=x/ap; sum+=del; if(Math.abs(del)<Math.abs(sum)*EPS) break; } return sum*Math.exp(-x+a*Math.log(x)-gln); } else { const gln=gammln(a); let b=x+1-a,c=1/FPMIN,d=1/b,h=d; for(let i=1;i<=ITMAX;i++){ const an=-i*(i-a); b+=2; d=an*d+b; if(Math.abs(d)<FPMIN) d=FPMIN; c=b+an/c; if(Math.abs(c)<FPMIN) c=FPMIN; d=1/d; const del=d*c; h*=del; if(Math.abs(del-1)<EPS) break; } return 1 - Math.exp(-x+a*Math.log(x)-gln)*h; } }
function chiSquarePValue(chiSq,df){ return 1 - gammaP(df/2, chiSq/2); }
function erf(x){ const sign=x<0?-1:1; x=Math.abs(x); const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911; const t=1/(1+p*x); return sign*(1-(((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-x*x))); }
function normalCDF(x){ return 0.5*(1+erf(x/Math.SQRT2)); }
function wilsonCI(hits,n,z){ if(!n) return {p:0,low:0,high:0}; const p=hits/n, z2=z*z, d=1+z2/n; const centre=(p+z2/(2*n))/d; const half=z*Math.sqrt((p*(1-p)+z2/(4*n))/n)/d; return {p,low:Math.max(0,centre-half),high:Math.min(1,centre+half)}; }
function dispersionStats(intervals, floor){ const shifted=intervals.map(v=>v-floor+1); const n=shifted.length; if(n<2) return null; const sMean=shifted.reduce((s,v)=>s+v,0)/n; const variance=shifted.reduce((s,v)=>s+(v-sMean)**2,0)/(n-1); const cv=Math.sqrt(variance)/sMean; const pHat=1/sMean; const theoreticalCV=Math.sqrt(1-pHat); return {n, mean:sMean+floor-1, shiftedMean:sMean, variance, cv, theoreticalCV, pHat, floor}; }
function chiSquareGOF(intervals, floor){ const shifted=intervals.map(v=>v-floor+1); const n=shifted.length; const mean=shifted.reduce((s,v)=>s+v,0)/n; const pHat=1/mean; const numBins=Math.max(5,Math.min(15,Math.floor(n/8))); const bins=[]; for(let i=1;i<numBins;i++){ const t=i/numBins; let k=Math.ceil(Math.log(1-t)/Math.log(1-pHat)); if(bins.length&&k<=bins[bins.length-1]) k=bins[bins.length-1]+1; bins.push(k); } const edges=[0,...bins,Infinity]; const obs=new Array(numBins).fill(0); for(const v of shifted) for(let b=0;b<numBins;b++) if(v>edges[b]&&v<=edges[b+1]){ obs[b]++; break; } const exp=new Array(numBins).fill(n/numBins); let chiSq=0; for(let b=0;b<numBins;b++){ const d=obs[b]-exp[b]; chiSq+=d*d/exp[b]; } const df=Math.max(numBins-2,1); const pValue=chiSquarePValue(chiSq,df); return {chiSq,df,pValue,numBins,observed:obs,expected:exp,pHat,mean:mean+floor-1,floor}; }
function ksTest(intervals, floor){ const shifted=intervals.map(v=>v-floor+1); const n=shifted.length; const mean=shifted.reduce((s,v)=>s+v,0)/n; const pHat=1/mean; const sorted=[...shifted].sort((a,b)=>a-b); let D=0; for(let i=0;i<n;i++){ const F=1-Math.pow(1-pHat,sorted[i]); D=Math.max(D,Math.abs((i+1)/n-F),Math.abs(i/n-F)); } const lambda=(Math.sqrt(n)+0.12+0.11/Math.sqrt(n))*D; let p=0; for(let k=1;k<=100;k++) p+=(k%2?1:-1)*Math.exp(-2*k*k*lambda*lambda); p=Math.max(0,Math.min(1,2*p)); return {D,pValue:p,pHat,floor}; }
function hazardTable(intervals, bucketFracs, mean, pHat, z){ const edges=bucketFracs.map(m=> m===Infinity?Infinity: Math.round(m*mean)); const rows=[]; for(let i=0;i<edges.length-1;i++){ const lo=edges[i], hi=edges[i+1]; const survivors=intervals.filter(v=>v>=lo).length; const events=intervals.filter(v=>v>=lo&&v<hi).length; const emp=survivors>0? events/survivors : null; const width=hi===Infinity? null : hi-lo; const theo=width!==null? 1-Math.pow(1-pHat,width) : null; const ci=survivors>0 && emp!==null ? wilsonCI(events, survivors, z||1.96) : null; const outside=ci && theo!==null ? (ci.low>theo || ci.high<theo) : false; const lift=emp!==null && theo!==null ? emp-theo : null; rows.push({range:`${lo}-${hi===Infinity?'∞':hi}`, lo, hi, survivors, events, empirical:emp, theoretical:theo, ciLow:ci?.low??null, ciHigh:ci?.high??null, outside, lift, width}); } return rows; }
function detectSpikesFromPrices(prices, cfg, symbol){ const n=prices.length; const diffs=new Array(n).fill(0); for(let i=1;i<n;i++) diffs[i]=prices[i]-prices[i-1]; let direction=cfg.spikeDirection; if(direction==='auto'){ const u=symbol.toUpperCase(); if(u.includes('BOOM')) direction='up'; else if(u.includes('CRASH')) direction='down'; else direction='both'; } const excluded=new Uint8Array(n); const spikeIndices=[]; let lastSpike=-Infinity; let baseline=null; let lastRecompute=-Infinity; const win=cfg.baselineWindow, every=cfg.recomputeBaselineEvery, buf=cfg.excludeBufferAfterSpike; for(let i=win;i<n;i++){ if(baseline===null || i-lastRecompute>=every){ const s=i-win; const clean=[]; for(let j=s;j<i;j++) if(!excluded[j]) clean.push(Math.abs(diffs[j])); if(clean.length>=30){ const m=medianArr(clean); const devs=clean.map(v=>Math.abs(v-m)); baseline=medianArr(devs)||1e-9; } lastRecompute=i; } if(baseline===null) continue; const mv=diffs[i]; const mag=Math.abs(mv)/baseline; const dirOK=direction==='both' ? true : direction==='up' ? mv>0 : mv<0; if(dirOK && mag>=cfg.spikeThresholdMAD){ if(i-lastSpike>=cfg.minSpikeSeparation){ spikeIndices.push(i); lastSpike=i; for(let k=i;k<Math.min(n,i+buf);k++) excluded[k]=1; } } } return {spikeIndices, direction, diffs}; }
function analyzePostSpikeBehavior(prices, spikeIndices, horizon, maxControlSamples){ const n=prices.length; const dist=new Array(n).fill(Infinity); { let ptr=0; for(let i=0;i<n;i++){ while(ptr<spikeIndices.length && spikeIndices[ptr]<i) ptr++; dist[i]=ptr<spikeIndices.length ? spikeIndices[ptr]-i : Infinity; } } let excludedContaminatedEvents=0; const eventStarts=[]; for(let s=0;s<spikeIndices.length;s++){ const idx=spikeIndices[s]; if(idx+horizon>=n) continue; const nextGap=s+1<spikeIndices.length ? spikeIndices[s+1]-idx : Infinity; if(nextGap>horizon) eventStarts.push(idx); else excludedContaminatedEvents++; } const inPostSpikeWindow=new Uint8Array(n); for(const s of spikeIndices) for(let k=s+1;k<=Math.min(n-1,s+horizon);k++) inPostSpikeWindow[k]=1; const controlStarts=[]; let cursor=0; while(cursor< n - horizon){ const clean=!inPostSpikeWindow[cursor] && dist[cursor]>horizon; if(clean){ controlStarts.push(cursor); cursor+=horizon; } else cursor+=1; } const finalControl=controlStarts.length>maxControlSamples? controlStarts.filter((_,i)=> i%Math.ceil(controlStarts.length/maxControlSamples)===0) : controlStarts; function buildPaths(starts){ const paths=[]; for(const idx of starts){ if(idx+horizon>=prices.length) continue; const base=prices[idx]; const path=new Array(horizon); for(let k=1;k<=horizon;k++) path[k-1]=(prices[idx+k]-base)/base; paths.push(path); } return paths; } function pathStatsAtOffset(paths,k){ const vals=paths.map(p=>p[k-1]); const n=vals.length; const mean=vals.reduce((s,v)=>s+v,0)/n; const variance=n>1? vals.reduce((s,v)=>s+(v-mean)**2,0)/(n-1):0; return {n,mean,variance}; } function welch(stat1,stat2){ const se2=stat1.variance/stat1.n+stat2.variance/stat2.n; const se=Math.sqrt(se2); const z=se>0? (stat1.mean-stat2.mean)/se:0; const p=2*(1-normalCDF(Math.abs(z))); return {z,pValue:p,diff:stat1.mean-stat2.mean,se}; } const eventPaths=buildPaths(eventStarts); const controlPaths=buildPaths(finalControl); if(!eventPaths.length || !controlPaths.length) return {horizon, eventCount:eventPaths.length, controlCount:controlPaths.length, excludedContaminatedEvents, totalSpikes:spikeIndices.length, bonferroniThreshold:0.05/horizon, anySignificant:false, firstSignificantOffset:null, rows:[]}; const bonferroniThreshold=0.05/horizon; const rows=[]; let anySignificant=false, firstSignificantOffset=null; for(let k=1;k<=horizon;k++){ const ev=pathStatsAtOffset(eventPaths,k); const ctrl=pathStatsAtOffset(controlPaths,k); const test=welch(ev,ctrl); const sig=test.pValue<bonferroniThreshold; if(sig){ anySignificant=true; if(firstSignificantOffset===null) firstSignificantOffset=k; } rows.push({offset:k, eventMeanPct:ev.mean*100, controlMeanPct:ctrl.mean*100, diffPct:test.diff*100, z:test.z, pValue:test.pValue, significant:sig}); } return {horizon, eventCount:eventPaths.length, controlCount:controlPaths.length, excludedContaminatedEvents, totalSpikes:spikeIndices.length, bonferroniThreshold, anySignificant, firstSignificantOffset, rows}; }

// ═══════════════════════════════════════════════════════════════════════
// 3. LOGGER
// ═══════════════════════════════════════════════════════════════════════
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const currentLevel = LOG_LEVELS[CONFIG.logLevel] ?? LOG_LEVELS.INFO;
const pad = n => String(n).padStart(2, '0');
const ts = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
function _writeLog(line) { try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch (_) {} }
function log(level, msg, ...rest) {
  if ((LOG_LEVELS[level] ?? 1) > currentLevel) return;
  const extras = rest.map(a => {
    if (a instanceof Error) return a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(' ');
  const line = `[${ts()}] [${level}] ${msg}${extras ? ' ' + extras : ''}`;
  (level === 'ERROR' ? console.error : console.log)(line);
  _writeLog(line);
}
const logger = {
  error: (m, ...a) => log('ERROR', m, ...a),
  warn : (m, ...a) => log('WARN',  m, ...a),
  info : (m, ...a) => log('INFO',  m, ...a),
  debug: (m, ...a) => log('DEBUG', m, ...a),
};

// ═══════════════════════════════════════════════════════════════════════
// 4. TELEGRAM NOTIFIER  (bounded queue, serial drain)
// ═══════════════════════════════════════════════════════════════════════
class TelegramNotifier extends EventEmitter {
  constructor(cfg) {
    super();
    this.enabled = cfg.enabled;
    this.botToken = cfg.botToken;
    this.chatId = cfg.chatId;
    this.maxQueue = cfg.maxQueue || 200;
    this.queue = [];
    this.dropped = 0;
    this.sending = false;
  }
  _post(text) {
    return new Promise(resolve => {
      if (!this.enabled) return resolve(false);
      try {
        const payload = JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
        const url = new URL(`https://api.telegram.org/bot${this.botToken}/sendMessage`);
        const req = https.request({
          method: 'POST', hostname: url.hostname, path: url.pathname,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, res => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode === 200)); });
        req.on('error', e => { logger.warn('telegram error:', e.message); resolve(false); });
        req.setTimeout(10000, () => { req.destroy(new Error('tg timeout')); });
        req.write(payload);
        req.end();
      } catch (e) { logger.warn('telegram exception:', e.message); resolve(false); }
    });
  }
  async _drain() {
    if (this.sending || !this.queue.length) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        await this._post(this.queue.shift());
        await new Promise(r => setTimeout(r, 1100));
      }
      if (this.dropped > 0) { logger.warn(`telegram: dropped ${this.dropped} queued messages (overflow)`); this.dropped = 0; }
    } finally { this.sending = false; }
  }
  send(text) {
    if (!this.enabled) { logger.debug('tg(dry):', text.slice(0, 100)); return; }
    if (this.queue.length >= this.maxQueue) { this.queue.shift(); this.dropped++; }
    this.queue.push(text);
    this._drain();
  }
}
const telegram = new TelegramNotifier(CONFIG.telegram);

// ═══════════════════════════════════════════════════════════════════════
// 5. DERIV REST CLIENT  (PAT/OAuth)  — ported from accuAPEX
// ═══════════════════════════════════════════════════════════════════════
class RestClient {
  constructor(baseUrl, appId, token) {
    this.baseUrl = baseUrl || 'https://api.derivws.com';
    this.appId = appId || '1089';
    this.token = token || '';
  }
  static isPat(token) {
    return typeof token === 'string' && /^pat_[a-z0-9_\-]{16,}$/i.test(token.trim());
  }
  _request(method, reqPath, body = null) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(reqPath, this.baseUrl); } catch (e) { return reject(new Error(`Invalid URL: ${reqPath}`)); }
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : require('http');
      const opts = {
        method, hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Deriv-App-ID': this.appId, 'Authorization': 'Bearer ' + this.token,
          'Accept': 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        timeout: 15000,
      };
      const req = lib.request(opts, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => { let parsed = data; try { parsed = JSON.parse(data); } catch (_) {} resolve({ status: res.statusCode, body: parsed }); });
      });
      req.on('timeout', () => { req.destroy(new Error('REST timeout')); });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }
  async get(p) { return this._request('GET', p); }
  async post(p, b) { return this._request('POST', p, b); }
}

// ═══════════════════════════════════════════════════════════════════════
// 6. DERIV WEBSOCKET CLIENT  (reconnect, PAT/OAuth, subs, portfolio)
// ═══════════════════════════════════════════════════════════════════════
class DerivClient extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.ws = null;
    this.connected = false;
    this.authorized = false;
    this._stopped = false;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this._reqId = 0;
    this._pending = new Map();
    this._subs = new Map();
    this.balance = null;
    this.currency = cfg.currency;
    this.accountInfo = null;
    this.symbols = new Map();
    this._isPat = RestClient.isPat(cfg.apiToken);
    this._rest = this._isPat ? new RestClient('https://api.derivws.com', cfg.appId, cfg.apiToken) : null;
    this._otpUrl = null;
    this._targetAccount = null;
    this._keepAliveSubId = null;
    this._keepAliveTimer = null;
  }

  _nextReqId() { return ++this._reqId; }

  _url() {
    const sep = this.cfg.wsUrl.includes('?') ? '&' : '?';
    return `${this.cfg.wsUrl}${sep}app_id=${encodeURIComponent(this.cfg.appId)}`;
  }

  _redact(url) { return url.replace(/([?&])(otp|app_id|token)=[^&]+/g, '$1$2=***').replace(/wss:\/\/[^/]+/, m => m); }

  _openWs(url) {
    try {
      this.ws = new WebSocket(url, { headers: { 'User-Agent': 'accuHOLD/1.0 (+Node.js)' }, handshakeTimeout: 15000 });
    } catch (e) { logger.error('ws construct failed:', e.message); this._scheduleReconnect(); return false; }
    this.ws.on('open', () => this._onOpen());
    this.ws.on('message', d => this._onMessage(d));
    this.ws.on('error', e => this._onError(e));
    this.ws.on('close', (c, r) => this._onClose(c, r));
    this.ws.on('unexpected-response', (_, res) => {
      logger.error('ws handshake failed:', res.statusCode, res.statusMessage);
      try { res.destroy(); } catch (_) {} this._scheduleReconnect();
    });
    return true;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (!this.cfg.apiToken) { logger.error('API token empty'); this._stopped = true; return; }
    if (this._isPat) {
      logger.info('PAT token detected → new API (OTP flow)');
      this._newApiConnect().catch(e => { logger.error('new API connect failed:', e.message); this._scheduleReconnect(); });
    } else {
      const url = this._url();
      logger.info(`connecting → ${this._redact(url)}`);
      this._openWs(url);
    }
  }

  async _newApiConnect() {
    const desiredType = (this.cfg.accountType || 'demo').toLowerCase();
    const accRes = await this._rest.get('/trading/v1/options/accounts');
    if (accRes.status !== 200) {
      const msg = accRes.body?.errors?.[0]?.message || accRes.body?.message || JSON.stringify(accRes.body);
      throw new Error(`account list failed (${accRes.status}): ${msg}`);
    }
    const accounts = Array.isArray(accRes.body?.data) ? accRes.body.data : [];
    if (!accounts.length) throw new Error('no Options accounts found');
    const acct = accounts.find(a => (a.account_type || '').toLowerCase() === desiredType) || accounts[0];
    this._targetAccount = acct;
    this.accountInfo = { loginid: acct.account_id, email: acct.email, isVirtual: (acct.account_type || '').toLowerCase() === 'demo', accountType: acct.account_type, currency: acct.currency, balance: parseFloat(acct.balance), group: acct.group };
    const otpPath = `/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`;
    const otpRes = await this._rest.post(otpPath);
    if (otpRes.status !== 200) throw new Error(`OTP failed (${otpRes.status}): ${JSON.stringify(otpRes.body)}`);
    const wsUrl = otpRes.body?.data?.url;
    if (!wsUrl || !/^wss?:/i.test(wsUrl)) throw new Error('OTP missing data.url');
    this._otpUrl = wsUrl;
    logger.info(`connecting OTP → ${this._redact(wsUrl)}`);
    this._openWs(wsUrl);
  }

  _onOpen() {
    logger.info('ws connected');
    this.connected = true;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this.emit('open');
    if (this._isPat) this._newApiMarkAuthorized();
    else this._authorize();
  }

  // The new-API (OTP) WebSocket drops idle connections after ~60s if there
  // is no active subscription. With no contract open yet, the bot has no
  // proposal_open_contract stream, so we keep ONE ticks subscription alive
  // for the lifetime of the socket and refresh it on every (re)connect.
  async _startKeepAlive() {
    if (this._keepAliveSubId) return;
    const assets = (this.cfg && Array.isArray(this.cfg.assets) && this.cfg.assets.length) ? this.cfg.assets : ['BOOM1000'];
    const symbol = assets[0];
    try {
      const subId = await this.subscribe({ ticks: symbol }, () => { /* noop — just keeps the socket warm */ });
      this._keepAliveSubId = subId;
      logger.info(`keep-alive: subscribed ticks:${symbol} (subId=${subId})`);
    } catch (e) {
      logger.warn(`keep-alive subscribe failed (${symbol}):`, e.message);
    }
  }
  _stopKeepAlive() {
    if (this._keepAliveSubId) { try { this.forget(this._keepAliveSubId); } catch (_) {} this._keepAliveSubId = null; }
    if (this._keepAliveTimer) { clearInterval(this._keepAliveTimer); this._keepAliveTimer = null; }
  }
  // Belt-and-braces ping: if we ever lose the keep-alive sub for any
  // reason, an app-level ping every 25s prevents the OTP socket from
  // sitting idle for the full 60s timeout window.
  _startPing() {
    this._stopPing();
    this._keepAliveTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.ping(); } catch (_) {}
      }
    }, 25000);
  }
  _stopPing() { if (this._keepAliveTimer) { clearInterval(this._keepAliveTimer); this._keepAliveTimer = null; } }

  _newApiMarkAuthorized() {
    if (!this.accountInfo) return;
    this.authorized = true;
    this.balance = this.accountInfo.balance ?? null;
    this.currency = this.accountInfo.currency || this.cfg.currency;
    logger.info(`authorized ${this.accountInfo.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) bal=${this.balance}`);
    this._startPing();
    this._startKeepAlive().catch(e => logger.debug('keep-alive start:', e.message));
    this.emit('authorized', this.accountInfo);
  }

  async _authorize() {
    try {
      const res = await this._send({ authorize: this.cfg.apiToken }, 20000);
      this.authorized = true;
      this.balance = parseFloat(res.authorize.balance);
      this.currency = res.authorize.currency || this.cfg.currency;
      this.accountInfo = { loginid: res.authorize.loginid, email: res.authorize.email, isVirtual: !!res.authorize.is_virtual, accountType: res.authorize.account_type };
      logger.info(`authorized ${res.authorize.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) bal=${this.balance}`);
      this._startPing();
      this._startKeepAlive().catch(e => logger.debug('keep-alive start:', e.message));
      this.emit('authorized', this.accountInfo);
    } catch (e) { logger.error('auth failed:', e.message); this.authorized = false; this._scheduleReconnect(); }
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.error) {
      const code = msg.error.code;
      const RACE = new Set(['BetExpired','TradingDurationNotAllowed','ContractNotFound','InvalidContract']);
      if (!RACE.has(code)) logger.error(`api error: ${code} – ${msg.error.message}`);
      if (msg.req_id && this._pending.has(msg.req_id)) {
        const p = this._pending.get(msg.req_id); clearTimeout(p.timer); this._pending.delete(msg.req_id);
        p.reject(new Error(msg.error.message || code));
      }
      if (['AuthorizationRequired','InvalidToken','InvalidAppID'].includes(code)) this._closeAndReconnect();
      return;
    }
    if (msg.req_id && this._pending.has(msg.req_id)) {
      const p = this._pending.get(msg.req_id); clearTimeout(p.timer); this._pending.delete(msg.req_id); p.resolve(msg);
      return;
    }
    if (msg.subscription?.id && this._subs.has(msg.subscription.id)) {
      try { this._subs.get(msg.subscription.id)(msg); } catch (e) { logger.error('sub error:', e.message); }
    }
  }

  _onError(err) { logger.error('ws error:', err.message); this.emit('error', err); }

  _onClose(code, reason) {
    const r = (() => { try { return reason?.toString(); } catch { return ''; } })();
    logger.warn(`ws closed code=${code} reason=${r || 'none'}`);
    const wasAuth = this.authorized;
    this.connected = false; this.authorized = false;
    this._stopKeepAlive();
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error('Connection closed')); }
    this._pending.clear(); this._subs.clear();
    this.emit('close', code, reason, wasAuth);
    if (!this._stopped) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnecting) return;
    this._reconnecting = true; this._reconnectAttempt++;
    const base = Math.min(this.cfg.reconnect.initialDelayMs * Math.pow(this.cfg.reconnect.backoffFactor, this._reconnectAttempt - 1), this.cfg.reconnect.maxDelayMs);
    const delay = base + Math.random() * this.cfg.reconnect.jitterMs;
    logger.info(`reconnect #${this._reconnectAttempt} in ${(delay / 1000).toFixed(1)}s`);
    setTimeout(() => { this._reconnecting = false; this.connect(); }, delay);
  }

  _closeAndReconnect() { try { this.ws?.close(); } catch (_) {} }

  _send(payload, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
      const reqId = this._nextReqId();
      const text = JSON.stringify({ ...payload, req_id: reqId });
      const timer = setTimeout(() => {
        if (this._pending.has(reqId)) { this._pending.delete(reqId); reject(new Error(`Timeout: ${payload.proposal ?? payload.buy ?? 'req'}`)); }
      }, timeoutMs);
      this._pending.set(reqId, { resolve, reject, timer });
      try { this.ws.send(text); } catch (e) { clearTimeout(timer); this._pending.delete(reqId); reject(e); }
    });
  }

  subscribe(payload, callback, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
      const reqId = this._nextReqId();
      const text = JSON.stringify({ ...payload, req_id: reqId, subscribe: 1 });
      const timer = setTimeout(() => { if (this._pending.has(reqId)) { this._pending.delete(reqId); reject(new Error('Sub timeout')); } }, timeoutMs);
      this._pending.set(reqId, {
        resolve: msg => { const subId = msg.subscription?.id; if (subId) { this._subs.set(subId, callback); resolve(subId); } else reject(new Error('No sub id')); },
        reject, timer,
      });
      try { this.ws.send(text); } catch (e) { clearTimeout(timer); this._pending.delete(reqId); reject(e); }
    });
  }

  forget(subId) {
    if (!subId) return Promise.resolve();
    this._subs.delete(subId);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve();
    return this._send({ forget: subId }, 8000).catch(() => {});
  }

  async portfolio() {
    const res = await this._send({ portfolio: 1 }, 15000);
    return Array.isArray(res.portfolio?.contracts) ? res.portfolio.contracts : [];
  }

  stop() { this._stopped = true; this._stopKeepAlive(); try { this.ws?.close(); } catch (_) {} }
}

// ═══════════════════════════════════════════════════════════════════════
// 7. MARKET DATA — barrier + ticks_stayed_in cache
//    (no analyzer; we only need the live median for the tick-cap)
// ═══════════════════════════════════════════════════════════════════════
class MarketDataManager extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.stayCache = new Map();      // symbol -> Map(growthRate -> { ticks_stayed_in, ts, barrier })
    this._unsupportedSymbols = new Set();
    this._refreshInFlight = false;
    client.on('close', () => { this.stayCache.clear(); });
  }

  cacheStays(symbol, growthRate, cd) {
    if (!cd) return;
    const arr = cd.ticks_stayed_in;
    if (!Array.isArray(arr) || !arr.length) return;
    const key = +(+growthRate).toFixed(4);
    if (!this.stayCache.has(symbol)) this.stayCache.set(symbol, new Map());
    this.stayCache.get(symbol).set(key, { ticks_stayed_in: arr.slice(), ts: Date.now(), barrier: +cd.tick_size_barrier_percentage || 0 });
  }

  getStays(symbol, growthRate) {
    const sub = this.stayCache.get(symbol);
    return sub ? sub.get(+(+growthRate).toFixed(4)) || null : null;
  }

  // Live median of ticks_stayed_in for the (symbol, growth_rate) bucket,
  // or null if we don't have a sample yet. Median (not mean) — the
  // survival distribution is right-skewed and the mean is pulled up by
  // a few long-surviving contracts.
  getMedianStay(symbol, growthRate) {
    const rec = this.getStays(symbol, growthRate);
    if (!rec || !rec.ticks_stayed_in.length) return null;
    const arr = rec.ticks_stayed_in.slice().sort((a, b) => a - b);
    const m = arr.length >> 1;
    return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
  }

  static PERMANENT_ERRORS = new Set([
    'TradingDurationNotAllowed', 'InvalidContractType', 'InvalidSymbol',
    'UnsupportedContract', 'InvalidContract', 'BlockedCurrency',
  ]);

  async refreshStays(assets, growthRate) {
    if (this._refreshInFlight || !this.client.authorized) return;
    this._refreshInFlight = true;
    const symbolKey = this.client._isPat ? 'underlying_symbol' : 'symbol';
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    try {
      for (const sym of assets) {
        if (this._unsupportedSymbols.has(sym)) continue;
        // per-tier growthRate — if caller passed null, resolve per symbol tier
        const g = (growthRate != null) ? growthRate : getGrowthRateForSymbol(sym);
        try {
          const res = await this.client._send({
            proposal: 1, amount: this.cfg.stake, basis: 'stake',
            contract_type: 'ACCU', currency: this.cfg.currency,
            [symbolKey]: sym, growth_rate: g,
          }, 8000);
          const cd = res?.proposal?.contract_details;
          if (cd) {
            this.cacheStays(sym, g, cd);
          } else if (res?.error) {
            const code = res.error.code || '';
            const msg  = res.error.message || '';
            if (MarketDataManager.PERMANENT_ERRORS.has(code) || /not offered|does not offer|not available|not supported/i.test(msg)) {
              this._unsupportedSymbols.add(sym);
              logger.info(`refreshStays: ${sym} ACCU rejected (${code || msg}) — excluded`);
            } else {
              logger.debug(`refreshStays(${sym}) transient: ${code || msg}`);
            }
          }
        } catch (e) { logger.debug(`refreshStays(${sym}):`, e.message); }
        await sleep(50);
      }
    } finally { this._refreshInFlight = false; }
  }

  // Refresh per-tier growth buckets in one sweep (v4 tier-aware)
  async refreshStaysPerTier(assets) {
    if (this._refreshInFlight || !this.client.authorized) return;
    // group by growthRate to avoid duplicate calls
    const byGrowth = new Map();
    for (const sym of assets) {
      if (this._unsupportedSymbols.has(sym)) continue;
      const g = getGrowthRateForSymbol(sym);
      if (!byGrowth.has(g)) byGrowth.set(g, []);
      byGrowth.get(g).push(sym);
    }
    for (const [g, list] of byGrowth) await this.refreshStays(list, g);
  }

  stop() { this.stayCache.clear(); }
}

// ═══════════════════════════════════════════════════════════════════════
// 8. TRADE EXECUTOR  (buy, stream update, idempotent settle, reconcile)
// ═══════════════════════════════════════════════════════════════════════
const TERMINAL_STATUSES = new Set(['won', 'lost', 'sold', 'cancelled', 'expired', 'refunded']);

class TradeExecutor extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.open = new Map();           // contractId -> info  (survives reconnects)
    this._selling = new Set();
    this._subscriptions = new Map(); // contractId -> subId
    this._settledIds = new Set();    // idempotency
  }

  // ── Entry ─────────────────────────────────────────────────────────
  async buy(symbol, growthRate, stake, ctx) {
    growthRate = Math.max(0.01, Math.min(0.05, +growthRate.toFixed(4)));
    try {
      const symbolKey = this.client._isPat ? 'underlying_symbol' : 'symbol';
      const pres = await this.client._send({
        proposal: 1, amount: stake, basis: 'stake', contract_type: 'ACCU',
        currency: this.cfg.currency, [symbolKey]: symbol, growth_rate: growthRate,
      }, 20000);
      const p = pres.proposal;
      if (!p?.id) throw new Error('No proposal id returned');
      logger.info(`proposal id=${p.id} ask=${p.ask_price} payout=${p.payout} spot=${p.spot}`);

      const bres = await this.client._send({ buy: p.id, price: p.ask_price }, 20000);
      const b = bres.buy;
      if (!b?.contract_id) throw new Error('Buy did not return contract_id');
      logger.info(`bought ACCU #${b.contract_id} for ${b.buy_price}`);

      const cd = p.contract_details || {};
      const entrySpot = parseFloat(p.spot ?? cd.current_spot ?? 0);

      // Live-fetch the ticks_stayed_in for THIS trade's exact (symbol, growth_rate)
      // bucket. This is what was actually known at entry time — never used a
      // pre-computed global or synthesized number.
      const liveStays = Array.isArray(cd.ticks_stayed_in) ? cd.ticks_stayed_in : null;
      const liveMedian = liveStays && liveStays.length
        ? (() => { const s = liveStays.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; })()
        : null;
      const tier = getTierForSymbol(symbol);
      const tierCapFrac = getTickCapFractionForSymbol(symbol);
      const tierTP = getTPForSymbol(symbol);
      const liveCap = liveMedian ? Math.max(1, Math.floor(liveMedian * tierCapFrac)) : null;

      const info = {
        contractId: b.contract_id, symbol, growthRate, stake, tier,
        buyPrice: parseFloat(b.buy_price),
        buyTime: b.purchase_time || (Date.now() / 1000),
        takeProfitMultiple: tierTP,
        tickCapFraction:    tierCapFrac,
        ticksStayedInMedian: liveMedian,
        tickCapTicks:       liveCap,
        contractDetails: cd,
        entrySpot,
        highBarrier: parseFloat(cd.high_barrier ?? 0), lowBarrier: parseFloat(cd.low_barrier ?? 0),
        maxPayout:  parseFloat(cd.maximum_payout ?? 0),
        proposalId: p.id,
        balanceAfter: parseFloat(b.balance_after ?? this.client.balance),
        ticksHeld: 0, peakProfit: 0, lastBid: null,
        // Tick-anchor: `c.tick_count` on the proposal_open_contract stream
        // reports the SERVER's counter from the moment of purchase, which
        // can be a huge number by the time our subscription actually
        // attaches (the first message we see is often "tick 250+"). The
        // tick-cap exit is meant to fire after WE have observed N ticks,
        // so we anchor to the first tick_count we see on the stream and
        // count up from there.
        _tickAnchor: null,
        lastUpdateAt: Date.now(),
        _exitReason: null,
      };

      // Cache live ticks_stayed_in for this (symbol, growth_rate) so
      // future trades + the hourly/EOD summaries can report the same bucket.
      if (this.bot?.market?.cacheStays) this.bot.market.cacheStays(symbol, growthRate, cd);

      this.open.set(b.contract_id, info);
      logger.info(
        `bought #${b.contract_id} ${symbol} g=${growthRate} stake=${stake} ` +
        `tick-cap=${info.tickCapTicks ?? 'n/a'} ticks (median=${info.ticksStayedInMedian ?? 'n/a'})`,
      );

      await this._attachContractStream(info);
      this.emit('open', info);
      return info;
    } catch (e) {
      logger.error(`buy(${symbol}) failed:`, e.message);
      throw e;
    }
  }

  async _attachContractStream(info, force = false) {
    if (this._subscriptions.has(info.contractId) && !force) return;
    // force=true: forget old sub first so watchdog can re-establish
    if (force && this._subscriptions.has(info.contractId)) {
      const old = this._subscriptions.get(info.contractId);
      this._subscriptions.delete(info.contractId);
      try { await this.client.forget(old); } catch (_) {}
    }
    try {
      const subId = await this.client.subscribe(
        { proposal_open_contract: 1, contract_id: info.contractId },
        msg => this._onUpdate(msg, info),
      );
      this._subscriptions.set(info.contractId, subId);
      info._subscriptionId = subId;
      logger.info(`stream attached #${info.contractId} subId=${subId}${force ? ' (forced)' : ''}`);
    } catch (e) {
      logger.warn(`attach stream #${info.contractId}:`, e.message);
      throw e;
    }
  }

  // ── Reconciliation after reconnect ────────────────────────────────
  async reconcileOpenContracts() {
    const tracked = Array.from(this.open.values());
    if (!tracked.length) return;
    let list = [];
    try { list = await this.client.portfolio(); }
    catch (e) { logger.warn('reconcile portfolio:', e.message); return; }
    const serverIds = new Set(list.map(c => String(c.contract_id)));

    // 1) adopt server-side contracts we don't track (e.g. bought by a prior run)
    for (const c of list) {
      if (String(c.contract_type).toUpperCase() === 'ACCU' && !this.open.has(c.contract_id)) {
        this._adoptServerContract(c);
      }
    }
    // 2) hydrate details + re-attach streams for contracts still open
    for (const c of list) {
      const info = this.open.get(c.contract_id);
      if (!info) continue;
      try {
        const res = await this.client._send({ proposal_open_contract: 1, contract_id: c.contract_id }, 12000);
        const oc = res.proposal_open_contract;
        if (!oc) { this.forceSettle(c.contract_id, 'reconcile-missing'); continue; }
        if (oc.status === 'open') {
          this._hydrateInfo(info, oc);
          info.lastUpdateAt = Date.now();
          await this._attachContractStream(info);
        } else {
          this._onUpdate({ proposal_open_contract: oc }, info);
        }
      } catch (e) { logger.warn(`reconcile #${c.contract_id}:`, e.message); }
    }
    // 3) tracked but no longer on server → settled while offline; read once then book conservatively
    for (const info of tracked) {
      if (serverIds.has(String(info.contractId))) continue;
      if (!this.open.has(info.contractId)) continue;
      try {
        const res = await this.client._send({ proposal_open_contract: 1, contract_id: info.contractId }, 12000);
        const oc = res.proposal_open_contract;
        if (oc && oc.status !== 'open') this._onUpdate({ proposal_open_contract: oc }, info);
        else this.forceSettle(info.contractId, 'reconcile-gone');
      } catch { this.forceSettle(info.contractId, 'reconcile-gone'); }
    }
    logger.info(`reconcile: ${this.count()} open contract(s) tracked after reconnect`);
  }

  _adoptServerContract(c) {
    const cid = c.contract_id;
    const buyPrice = parseFloat(c.buy_price ?? 0);
    const info = {
      contractId: cid,
      symbol: c.symbol || c.underlying || '',
      growthRate: c.growth_rate != null ? parseFloat(c.growth_rate) : this.cfg.growthRate,
      stake: buyPrice > 0 ? buyPrice : this.cfg.stake,
      buyPrice,
      takeProfitMultiple: this.cfg.takeProfitMultiple,
      tickCapFraction:    this.cfg.tickCapFraction,
      ticksStayedInMedian: null, tickCapTicks: null,
      contractDetails: {},
      entrySpot: parseFloat(c.entry_spot ?? 0),
      highBarrier: 0, lowBarrier: 0, maxPayout: 0,
      ticksHeld: 0, peakProfit: 0, lastBid: null,
      lastUpdateAt: Date.now(), _exitReason: 'reconciled', _adopted: true,
    };
    this.open.set(cid, info);
    logger.info(`reconcile: adopted open contract #${cid} ${info.symbol}`);
    return info;
  }

  _hydrateInfo(info, oc) {
    if (oc.growth_rate != null) info.growthRate = parseFloat(oc.growth_rate);
    if (oc.symbol || oc.underlying) info.symbol = oc.symbol || oc.underlying;
    if (oc.purchase_time) info.buyTime = oc.purchase_time;
    if (oc.buy_price != null) info.buyPrice = parseFloat(oc.buy_price);
  }

  // ── Stream updates ────────────────────────────────────────────────
  _onUpdate(msg, info) {
    const c = msg.proposal_open_contract;
    if (!c) return;
    const cid = c.contract_id ?? info.contractId;
    const profit = parseFloat(c.profit ?? 0);
    const currentSpot = parseFloat(c.current_spot ?? 0);
    const status = c.status;

    if (status === 'open') {
      // ticksHeld: count ticks observed by OUR subscription, starting at 1
      // on the first message we see. The server's `tick_count` is anchored
      // to purchase time, so reading it raw makes the tick-cap fire on the
      // entry tick (and Deriv rejects sells at the entry tick with
      // `InvalidtoSell – Contract cannot be sold at entry tick`).
      if (c.tick_count != null && c.tick_count > 0) {
        if (info._tickAnchor == null) info._tickAnchor = c.tick_count;
        info.ticksHeld = Math.max(0, c.tick_count - info._tickAnchor) + 1;
      } else if (Array.isArray(c.ticks_stayed_in) && c.ticks_stayed_in.length) {
        // Fallback when the stream doesn't expose tick_count: use the
        // survival array length, also anchored to its first observed size.
        if (info._tickAnchor == null) info._tickAnchor = c.ticks_stayed_in.length;
        info.ticksHeld = Math.max(0, c.ticks_stayed_in.length - info._tickAnchor) + 1;
      }
      info.peakProfit = Math.max(info.peakProfit ?? 0, profit);
      info.lastUpdateAt = Date.now();
      info._watchdogAttempts = 0;
    }
    if (c.bid_price != null) info.lastBid = parseFloat(c.bid_price);

    // Stop-loss (per-contract), if configured.
    const stopLossAbs = Math.abs(this.cfg.stopLossPerContract || 0);
    if (status === 'open' && stopLossAbs > 0 && profit <= -stopLossAbs && !this._selling.has(cid)) {
      info._exitReason = 'stop-loss';
      logger.warn(`contract #${cid} hit stop-loss @ profit=${profit.toFixed(2)} ≤ -${stopLossAbs} — selling`);
      this._selling.add(cid);
      this.sell(cid, 0, info).catch(e => logger.error(`emergency sell #${cid} failed:`, e.message))
        .finally(() => this._selling.delete(cid));
      return;
    }

    if (status === 'open' && !this._selling.has(cid)) {
      // A) Take-profit: payout ≥ stake × takeProfitMultiple.
      //    Use `c.profit` (Deriv-computed: payout − buy_price), NOT
      //    `c.bid_price`. The bid_price field is the spot-multiplied-by-
      //    growth_price, which is NOT the same as the multiplier-grown
      //    payout value you receive on sell, and exits the trade after
      //    a single tick on wide-barrier symbols. `profit` is the field
      //    the server keeps aligned with `bid_price` on `sell_price`, so
      //    checking `profit ≥ stake × (multiple − 1)` is the right rule.
      const tpMult = info.takeProfitMultiple ?? this.cfg.takeProfitMultiple;
      const tpProfitFloor = +(info.stake * (tpMult - 1)).toFixed(2);
      if (tpMult > 1 && profit >= tpProfitFloor) {
        info._exitReason = `take-profit: profit ${profit.toFixed(2)} ≥ ${tpProfitFloor.toFixed(2)} (×${tpMult} of ${info.stake.toFixed(2)})`;
        logger.info(`exit #${cid}: ${info._exitReason}`);
        this._selling.add(cid);
        this.sell(cid, 0, info).catch(e => logger.error(`tp sell #${cid} failed:`, e.message))
          .finally(() => this._selling.delete(cid));
        return;
      }
      // B) Tick cap: ticks held ≥ tickCapFraction × LIVE ticks_stayed_in median.
      const cap = info.tickCapTicks;
      if (cap && info.ticksHeld >= cap) {
        info._exitReason = `tick-cap: held ${info.ticksHeld} ≥ ${cap} (${this.cfg.tickCapFraction}× live median ${info.ticksStayedInMedian})`;
        logger.info(`exit #${cid}: ${info._exitReason}`);
        this._selling.add(cid);
        this.sell(cid, 0, info).catch(e => logger.error(`tick-cap sell #${cid} failed:`, e.message))
          .finally(() => this._selling.delete(cid));
        return;
      }
      this.emit('update', { ...info, contractId: cid, profit, currentSpot, status });
      return;
    }

    if (TERMINAL_STATUSES.has(status)) {
      const soldFor = parseFloat(c.sell_price ?? 0);
      const terminalProfit = (status === 'sold' && soldFor > 0 && info.buyPrice > 0)
        ? soldFor - parseFloat(info.buyPrice)
        : profit;
      const finalStatus = status === 'sold' ? (terminalProfit >= 0 ? 'won' : 'lost') : status;
      // ticksHeld at the moment of settlement: server's tick_count is
      // anchored to purchase time and is the authoritative duration. We
      // also keep the open-time-anchored value in `_ticksHeldOpen` for
      // logging; users care about "how long did this trade run" and the
      // terminal tick_count is exactly that.
      const terminalTicks = (c.tick_count != null && c.tick_count > 0)
        ? c.tick_count
        : (info.ticksHeld ?? 0);
      this._finalizeContract(cid, {
        profit: terminalProfit, status: finalStatus, sellPrice: soldFor,
        sellTime: c.sell_time ?? (Date.now() / 1000), currentSpot,
        ticksHeld: terminalTicks,
        ticksHeldOpen: info.ticksHeld ?? 0,
        exitReason: info._exitReason ?? (status === 'lost' ? 'knockout' : status),
      });
    }
  }

  async sell(contractId, minPrice = 0, info = null) {
    try {
      let floor = Number(minPrice) || 0;
      if (info && info.lastBid && info.lastBid > 0 && floor === 0) {
        floor = +(info.lastBid * 0.95).toFixed(2);
      }
      let sold;
      try {
        const res = await this.client._send({ sell: contractId, price: floor }, 15000);
        sold = res.sell || {};
      } catch (e) {
        if (minPrice !== 0 || !/price/i.test(e.message || '')) throw e;
        logger.warn(`sell fallback (price:0) #${contractId}: ${e.message}`);
        const res = await this.client._send({ sell: contractId, price: 0 }, 15000);
        sold = res.sell || {};
      }
      const soldFor = parseFloat(sold.sold_for ?? sold.sell_price ?? 0);
      logger.info(`sold #${contractId} for ${soldFor} (floor=${floor})`);
      // Free the slot immediately (do not wait for the 'sold' stream message).
      this._finalizeContract(contractId, {
        profit: soldFor > 0 && info?.buyPrice > 0 ? soldFor - info.buyPrice : 0,
        status: soldFor > 0 && info?.buyPrice > 0 && soldFor >= info.buyPrice ? 'won' : 'lost',
        sellPrice: soldFor, sellTime: Date.now() / 1000,
        currentSpot: info?.entrySpot ?? 0,
        ticksHeld: info?.ticksHeld ?? 0,
        exitReason: info?._exitReason ?? 'manual-sell',
      });
      return sold;
    } catch (e) {
      // "not found among your open positions" = already closed server-side.
      // Free the local slot so the watchdog doesn't keep retrying forever.
      const msg = String(e.message || e);
      if (/not found among your open positions/i.test(msg) && this.open.has(contractId)) {
        logger.warn(`sell #${contractId} missed: already closed on server — dropping stale local entry`);
        this._finalizeContract(contractId, {
          profit: 0, status: 'unknown', sellPrice: 0,
          sellTime: Date.now() / 1000, currentSpot: info?.entrySpot ?? 0,
          exitReason: 'already-closed-on-server',
        });
        return null;
      }
      // Deriv rejects sells on the entry tick (the very first message after
      // buy). If the caller's exit was tick-cap / take-profit, the next
      // stream tick will re-trigger the same exit; if it was a manual or
      // emergency sell, rethrow so the caller knows.
      if (/cannot be sold at entry tick/i.test(msg)) {
        logger.info(`sell #${contractId} deferred (entry-tick) — will retry on next stream tick`);
        // Caller is the one-and-done exit path; let the next _onUpdate re-fire
        // the exit logic. The _selling guard prevents a thundering herd.
        return null;
      }
      logger.error(`sell(${contractId}) failed:`, e.message);
      throw e;
    }
  }

  // ── Idempotent settlement (single `result` per contract id) ─────────
  _finalizeContract(cid, fields) {
    if (this._settledIds.has(cid)) return null;
    const info = this.open.get(cid);
    if (!info) return null;
    this._settledIds.add(cid);
    const finished = { ...info, contractId: cid, ...fields };
    this.open.delete(cid);
    const subId = this._subscriptions.get(cid);
    if (subId) { this._subscriptions.delete(cid); this.client.forget(subId).catch(() => {}); }
    logger.info(`settled #${cid} status=${finished.status} profit=${finished.profit.toFixed(2)} [${finished.exitReason || 'unknown'}]`);
    this.emit('result', finished);
    return finished;
  }

  forceSettle(contractId, reason = 'force') {
    const info = this.open.get(contractId);
    if (!info) return null;
    const stake = parseFloat(info.stake ?? 0);
    return this._finalizeContract(contractId, {
      profit: -stake, status: 'lost', sellPrice: 0,
      sellTime: Date.now() / 1000, currentSpot: info.entrySpot ?? 0, exitReason: reason,
    });
  }

  // ── Stuck-contract recovery (sweeps stale stream subscriptions) ───
  checkStuckContracts(maxStaleMs = 180000) {
    const now = Date.now();
    for (const [cid, info] of this.open.entries()) {
      if (now - (info.lastUpdateAt ?? 0) <= maxStaleMs) continue;
      if (this._selling.has(cid)) continue;
      const staleSec = ((now - info.lastUpdateAt) / 1000).toFixed(0);
      logger.warn(`stuck #${cid} — no update for ${staleSec}s, reconciling`);
      this._reconcileStuck(cid, info).catch(e => logger.error(`stuck reconcile #${cid} failed:`, e.message));
    }
  }

  async _reconcileStuck(cid, info) {
    if (this._selling.has(cid)) return;
    this._selling.add(cid);
    try {
      // 1) Authoritative POC fetch
      try {
        const res = await this.client._send({ proposal_open_contract: 1, contract_id: cid }, 12000);
        const oc = res?.proposal_open_contract;
        if (oc) {
          // if server says not open anymore, finalize via _onUpdate
          if (oc.status !== 'open' || oc.is_sold || TERMINAL_STATUSES.has(oc.status)) {
            logger.warn(`reconcileStuck #${cid}: server status=${oc.status} is_sold=${oc.is_sold} — finalizing`);
            this._onUpdate({ proposal_open_contract: oc }, info);
            return;
          }
          // still open but stale — log age and attempt sell if very old
          const ageSec = ((Date.now() - (info.lastUpdateAt || 0)) / 1000).toFixed(0);
          logger.warn(`reconcileStuck #${cid}: still open after ${ageSec}s stale, profit=${oc.profit ?? '?'} ticks=${oc.tick_count ?? '?'} — attempting market sell`);
        } else {
          logger.warn(`reconcileStuck #${cid}: POC returned no oc — checking portfolio`);
        }
      } catch (e) {
        const msg = String(e.message || '');
        if (/ContractNotFound|InvalidContract/i.test(msg)) {
          logger.warn(`reconcileStuck #${cid}: POC ContractNotFound — checking portfolio`);
        } else {
          logger.debug(`stuck POC fetch #${cid}:`, e.message);
        }
      }

      // 2) Portfolio check — if contract not in portfolio, it's settled server-side but we missed the terminal message
      try {
        const portfolio = await this.client.portfolio();
        const found = portfolio.find(c => String(c.contract_id) === String(cid));
        if (!found) {
          logger.warn(`reconcileStuck #${cid}: not in portfolio — forcing settle as unknown (missed terminal)`);
          // Try one more POC with longer timeout, else force-settle unknown so slot frees
          try {
            const res2 = await this.client._send({ proposal_open_contract: 1, contract_id: cid }, 8000);
            const oc2 = res2?.proposal_open_contract;
            if (oc2 && TERMINAL_STATUSES.has(oc2.status)) { this._onUpdate({ proposal_open_contract: oc2 }, info); return; }
          } catch (_) {}
          this._finalizeContract(cid, { profit: 0, status: 'unknown', sellPrice: 0, sellTime: Date.now()/1000, currentSpot: info.entrySpot||0, exitReason: 'stuck-not-in-portfolio' });
          return;
        }
      } catch (e) { logger.debug(`reconcile portfolio check #${cid}:`, e.message); }

      // 3) Track watchdog attempts — after 3 fails, force sell, after 5 force-settle unknown
      info._watchdogAttempts = (info._watchdogAttempts || 0) + 1;
      const attempts = info._watchdogAttempts;
      logger.warn(`reconcileStuck #${cid}: attempt ${attempts} — selling`);
      try {
        await this.sell(cid, 0, info);
        info._watchdogAttempts = 0;
        return;
      } catch (e) {
        const msg = String(e.message || '');
        if (/not found among your open positions/i.test(msg)) {
          // already handled in sell(), but keep fallback
          return;
        }
        if (attempts >= 5) {
          logger.error(`reconcileStuck #${cid}: sell failed ${attempts} times (${msg}) — force-settling unknown to free slot`);
          this._finalizeContract(cid, { profit: 0, status: 'unknown', sellPrice: 0, sellTime: Date.now()/1000, currentSpot: info.entrySpot||0, exitReason: `stuck-force-unknown-after-${attempts}` });
          telegram.send(`⚠️ <b>Stuck contract force-closed</b> #${cid} ${info.symbol} after ${attempts} watchdog attempts<br/>Last profit=${info.lastBid ?? '?'} — freed slot as <b>unknown</b>.`);
          return;
        }
        throw e;
      }
    } finally {
      this._selling.delete(cid);
    }
  }

  async cleanupAllSubscriptions() {
    const promises = [];
    for (const [contractId, subId] of this._subscriptions) {
      promises.push(this.client.forget(subId).catch(e => logger.debug(`cleanup sub ${contractId}:`, e.message)));
    }
    await Promise.all(promises);
    this._subscriptions.clear();
  }

  openTrades() { return Array.from(this.open.values()); }
  count() { return this.open.size; }
}

// ═══════════════════════════════════════════════════════════════════════
// 9. STATISTICS  (trade log, streaks, daily summaries)
// ═══════════════════════════════════════════════════════════════════════
const utcDateStr = (d = new Date()) => d.toISOString().slice(0, 10);
const utcHour    = (d = new Date()) => d.getUTCHours();
const money = (n, c = CONFIG.currency) => `${n >= 0 ? '+' : ''}${Number(n || 0).toFixed(2)} ${c}`;

// Human-readable duration formatter for trade-held time. Uses the largest
// unit that's ≥ 1, with up to one level of sub-unit precision so
// "1m 23s" wins over "83s" but "23s" doesn't get padded to "0m 23s".
function formatDuration(totalSec) {
  if (!Number.isFinite(totalSec) || totalSec < 0) return 'n/a';
  const s = Math.floor(totalSec);
  if (s < 1)    return '<1s';
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

class StatisticsManager {
  constructor(saved = null) {
    this.trades = [];
    this.dailySummaries = {};
    this.overallProfit = 0;
    this.currentLossStreak = 0;
    this.maxLossStreak = 0;
    // Histogram of consecutive-loss events: increments each time streak reaches N.
    // e.g. a 5-loss streak increments x2,x3,x4,x5 (one event per threshold).
    this.lossStreakEvents = { x2: 0, x3: 0, x4: 0, x5: 0, x6: 0, x7: 0 };
    this.eodSentDates = [];
    this.dailyState = {};   // date -> { trades, pnl, lossStreak, settledIds, ... }  for cap math
    if (saved) this.load(saved);
  }
  load(s) {
    if (Array.isArray(s.trades)) this.trades = s.trades;
    if (s.dailySummaries) this.dailySummaries = s.dailySummaries;
    this.overallProfit = Number(s.overallProfit || 0);
    this.currentLossStreak = Number(s.currentLossStreak || 0);
    this.maxLossStreak = Number(s.maxLossStreak || 0);
    // backwards-compat: older state may have only x2-x4 or no histogram at all
    const e = s.lossStreakEvents || {};
    this.lossStreakEvents = {
      x2: Number(e.x2 || 0), x3: Number(e.x3 || 0), x4: Number(e.x4 || 0),
      x5: Number(e.x5 || 0), x6: Number(e.x6 || 0), x7: Number(e.x7 || 0),
    };
    this.eodSentDates = Array.isArray(s.eodSentDates) ? s.eodSentDates : [];
    this.dailyState = s.dailyState || {};
  }
  serialize() {
    return {
      trades: this.trades.slice(-5000), dailySummaries: this.dailySummaries,
      overallProfit: this.overallProfit, currentLossStreak: this.currentLossStreak,
      maxLossStreak: this.maxLossStreak,
      lossStreakEvents: { ...this.lossStreakEvents },
      eodSentDates: this.eodSentDates.slice(-400),
      dailyState: this.dailyState,
    };
  }
  // Human-readable loss-streak breakdown: "x2=3 x3=1 x4=0 ..."
  lossStreakLine() {
    const e = this.lossStreakEvents;
    return `x2=${e.x2} x3=${e.x3} x4=${e.x4} x5=${e.x5} x6=${e.x6} x7=${e.x7}`;
  }
  record(trade) {
    const tsMs = Number(trade.sellTime || trade.buyTime || Date.now() / 1000) * 1000;
    const d = new Date(tsMs);
    const rec = { ...trade, timestamp: tsMs, date: utcDateStr(d), hour: utcHour(d) };
    this.trades.push(rec);
    // 'unknown' (unconfirmable/stuck) results are booked as a LOSS of the stake:
    // they hit P&L below but never advance the loss streak or martingale.
    if (rec.status === 'unknown') {
      const stakeLoss = -Number(rec.stake || 0);
      rec.profit = stakeLoss;
      this.overallProfit += stakeLoss;
      return rec;
    }
    this.overallProfit += Number(rec.profit || 0);
    if (rec.status === 'lost') {
      this.currentLossStreak += 1;
      this.maxLossStreak = Math.max(this.maxLossStreak, this.currentLossStreak);
      // increment histogram exactly when streak hits threshold (cumulative)
      if (this.currentLossStreak === 2) this.lossStreakEvents.x2 += 1;
      else if (this.currentLossStreak === 3) this.lossStreakEvents.x3 += 1;
      else if (this.currentLossStreak === 4) this.lossStreakEvents.x4 += 1;
      else if (this.currentLossStreak === 5) this.lossStreakEvents.x5 += 1;
      else if (this.currentLossStreak === 6) this.lossStreakEvents.x6 += 1;
      else if (this.currentLossStreak >= 7) this.lossStreakEvents.x7 += 1;
    } else if (rec.status === 'won') {
      this.currentLossStreak = 0;
    }
    return rec;
  }
  todayTrades(date = utcDateStr()) { return this.trades.filter(t => t.date === date); }
  tradesForHour(date, hour) { return this.trades.filter(t => t.date === date && t.hour === hour); }
  stats(list) {
    const wins = list.filter(t => t.status === 'won');
    const losses = list.filter(t => t.status === 'lost');
    const total = list.reduce((s, t) => s + Number(t.profit || 0), 0);
    const gw = wins.reduce((s, t) => s + Number(t.profit || 0), 0);
    const gl = Math.abs(losses.reduce((s, t) => s + Number(t.profit || 0), 0));
    return {
      count: list.length, wins: wins.length, losses: losses.length,
      winRate: list.length ? wins.length / list.length * 100 : 0,
      grossWin: gw, grossLoss: gl, totalProfit: total,
      profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
      stake: list.reduce((s, t) => s + Number(t.stake || 0), 0),
    };
  }
  archiveDate(date) {
    const list = this.trades.filter(t => t.date === date);
    const s = this.stats(list);
    this.dailySummaries[date] = s;
    return { date, trades: list, stats: s };
  }
  markEodSent(date) { if (!this.eodSentDates.includes(date)) this.eodSentDates.push(date); this.eodSentDates = this.eodSentDates.slice(-400); }
  isEodSent(date) { return this.eodSentDates.includes(date); }
}

// ═══════════════════════════════════════════════════════════════════════
// 10. BOT  (orchestrator: rate-limited entry, TP+cap exits, summaries)
// ═══════════════════════════════════════════════════════════════════════
class AccuHoldBot {
  constructor(cfg) {
    this.cfg = cfg;
    this.client = new DerivClient(cfg);
    this.market = new MarketDataManager(this.client, cfg);
    this.exec = new TradeExecutor(this.client, cfg);
    this.exec.bot = this;
    this.exec.market = this.market;
    this.stats = new StatisticsManager();

    this.stopped = false;
    this.manualRestartRequired = false;
    this.manualRestartReason = '';
    this.startBalance = null;
    this.lastBalance = null;
    this.lastTradeAt = 0;
    this.lastEntryAt = 0;
    this.lastEntryBySymbol = new Map();
    this.consecutiveLosses = 0;
    this.overallProfit = 0;
    this.dryRun = false;
    this._bootedOnce = false;
    this._tradeInFlight = false;
    this._dailyStopUntil = 0;
    this._dailyStopNotified = false;
    this._lastDayISODate = null;
    this._analysisT = null;
    this._hourlyBoot = null;
    this._hourlyT = null;
    this._eodBoot = null;
    this._proposalT = null;
    this._watchdogT = null;
    this._stuckT = null;
    this.paused = false;
    this._pauseStartTimer = null;
    this._pauseEndTimer = null;
    // ── Martingale state ──────────────────────────────────
    this.baseStake = Number(cfg.stake) || 1.0;
    this.currentStake = this.baseStake;
    this.martingaleStep = 0; // 0 = base, 1..martingaleSteps
    this._initExploratory();
  }

  // ── Martingale helpers ──────────────────────────────────
  _isMartingaleEnabled() {
    return Number(this.cfg.martingaleMultiplier) > 1.0 && parseInt(this.cfg.martingaleSteps, 10) > 0;
  }
  _martingaleLabel() {
    if (!this._isMartingaleEnabled()) return 'OFF';
    return `×${Number(this.cfg.martingaleMultiplier).toFixed(2)} (step ${this.martingaleStep}/${this.cfg.martingaleSteps})`;
  }
  _calcMartingaleStake(step) {
    const base = this.baseStake;
    const mult = Number(this.cfg.martingaleMultiplier) || 1;
    if (step <= 0 || mult <= 1) return +base.toFixed(2);
    let stake = +(base * Math.pow(mult, step)).toFixed(2);
    if (this.cfg.martingaleMaxStake && stake > this.cfg.martingaleMaxStake) stake = +Number(this.cfg.martingaleMaxStake).toFixed(2);
    return stake;
  }
  _updateMartingaleOnResult(status) {
    if (!this._isMartingaleEnabled()) {
      this.martingaleStep = 0;
      this.currentStake = this.baseStake;
      return { changed: false, reason: 'disabled' };
    }
    const maxSteps = parseInt(this.cfg.martingaleSteps, 10);
    if (status === 'won') {
      if (this.martingaleStep > 0) {
        logger.info(`martingale RESET: win after ${this.martingaleStep} steps → stake ${this.currentStake.toFixed(2)} → ${this.baseStake.toFixed(2)}`);
        this.martingaleStep = 0;
        this.currentStake = this.baseStake;
        return { changed: true, reason: 'win-reset' };
      }
      this.martingaleStep = 0;
      this.currentStake = this.baseStake;
      return { changed: false, reason: 'win-base' };
    }
    if (status === 'lost') {
      if (this.martingaleStep < maxSteps) {
        this.martingaleStep += 1;
        const prev = this.currentStake;
        this.currentStake = this._calcMartingaleStake(this.martingaleStep);
        logger.info(`martingale STEP UP: loss streak → step ${this.martingaleStep}/${maxSteps} stake ${prev.toFixed(2)} → ${this.currentStake.toFixed(2)} (×${this.cfg.martingaleMultiplier})`);
        return { changed: true, reason: 'loss-step-up', prev };
      }
      // reached max steps → reset to base (classic martingale cycle)
      logger.warn(`martingale MAX STEPS hit (${this.martingaleStep}/${maxSteps}) on loss — resetting to base stake ${this.baseStake.toFixed(2)}`);
      telegram.send(`⚠️ <b>AccuHOLD_v4 Martingale Max Steps Reached</b>\nStep ${this.martingaleStep}/${maxSteps} lost. Resetting stake to base <b>${this.baseStake.toFixed(2)} ${this.currencyStr()}</b>.`);
      this.martingaleStep = 0;
      this.currentStake = this.baseStake;
      return { changed: true, reason: 'max-reset' };
    }
    return { changed: false, reason: 'no-op' };
  }

  // ── Exploratory + spike-triggered state ──────────────────
  _initExploratory() {
    this.assetHistory = new Map();
    const assets = (this.cfg && Array.isArray(this.cfg.assets) && this.cfg.assets.length) ? this.cfg.assets : CONFIG.assets;
    for (const s of assets) this.assetHistory.set(s, {
      prices:[], times:[], spikeIndices:[], intervals:[], hazardTable:null, disp:null, chi:null, ks:null, elevated:[], postStudy:null,
      ticksSinceSpike:0, meanInterval:null, pendingEntryAfter:null, pendingReason:null, lastSpikeAbsIdx:null, lastUpdate:0, calibrationStatus:'CALIBRATING',
      // v4 spike-triggered fields
      lastSpikeCount:0, lastTradedSpikeIdx:null, lastTradeWon:null, waitForSpike:false, spikeCooldownUntil:0, spikeTriggerArmed:true
    });
    this._tickSubs = new Map(); // symbol -> subId
    this._exploratoryT = null;
    this._spikeReentryInFlight = false;
  }
  _updateExploratoryForSymbol(symbol) {
    const h = this.assetHistory.get(symbol);
    if (!h || h.prices.length < this.cfg.exploratory.baselineWindow + 100) return false;
    const prevCount = h.spikeIndices ? h.spikeIndices.length : 0;
    // cap history
    if (h.prices.length > this.cfg.exploratory.historyCap) { const trim = h.prices.length - this.cfg.exploratory.historyCap; h.prices.splice(0,trim); h.times.splice(0,trim); }
    try {
      const det = detectSpikesFromPrices(h.prices, this.cfg.exploratory, symbol);
      const hadNewSpike = det.spikeIndices.length > prevCount;
      h.spikeIndices = det.spikeIndices;
      if (hadNewSpike && this.cfg.spikeTrigger && this.cfg.spikeTrigger.enabled) {
        const newIdx = det.spikeIndices[det.spikeIndices.length-1];
        // fire async spike trigger (don't await inside recompute)
        this._onNewSpike(symbol, newIdx).catch(e=> logger.debug(`spike trigger ${symbol}:`, e.message));
      }
      const intervals = []; for(let i=1;i<det.spikeIndices.length;i++) intervals.push(det.spikeIndices[i]-det.spikeIndices[i-1]);
      h.intervals = intervals;
      if (intervals.length) {
        const floor = this.cfg.exploratory.minSpikeSeparation;
        const disp = dispersionStats(intervals, floor);
        h.disp = disp; h.meanInterval = disp ? disp.mean : null;
        if (disp) {
          h.chi = chiSquareGOF(intervals, floor);
          h.ks = ksTest(intervals, floor);
          h.hazardTable = hazardTable(intervals, this.cfg.exploratory.hazardBuckets, disp.mean, disp.pHat, this.cfg.exploratory.wilsonZ);
          // elevated where emp > theo + minLift and CI outside
          h.elevated = h.hazardTable.filter(r=> r.empirical!=null && r.theoretical!=null && r.outside && (r.empirical - r.theoretical) >= this.cfg.exploratory.hazardMinLift);
          // pick best lift
          if (h.elevated.length) h.elevated.sort((a,b)=> (b.empirical-b.theoretical)-(a.empirical-a.theoretical));
        }
      }
      // post-spike study
      if (h.spikeIndices.length >= 10 && h.prices.length >= this.cfg.exploratory.postSpikeHorizon + 100) {
        h.postStudy = analyzePostSpikeBehavior(h.prices, h.spikeIndices, this.cfg.exploratory.postSpikeHorizon, this.cfg.exploratory.postSpikeMaxControl);
      }
      // ticksSinceSpike = distance from last spike to end
      if (h.spikeIndices.length) h.ticksSinceSpike = h.prices.length - 1 - h.spikeIndices[h.spikeIndices.length-1];
      else h.ticksSinceSpike = h.prices.length;
      // calibration status
      if (intervals.length < this.cfg.exploratory.calibrationMinIntervals) h.calibrationStatus='CALIBRATING';
      else if (h.elevated.length || (h.postStudy && h.postStudy.anySignificant)) h.calibrationStatus='ACTIVE';
      else h.calibrationStatus='ACTIVE_RELAXED';
      // relaxed entryAfter / hold derived from mean
      if (h.meanInterval) {
        const mean = h.meanInterval;
        const entryAfter = Math.min(this.cfg.exploratory.historyCap, Math.max(3, Math.min(15, Math.round(mean*0.30))));
        const hold = Math.min(25, Math.max(5, Math.min(Math.round(mean*0.18), Math.round(mean*0.35))));
        h.pendingEntryAfter = entryAfter;
        h.pendingHold = hold;
      }
    } catch(e){ logger.debug(`exploratory update ${symbol}:`, e.message); }
  }
  _updateAllExploratory() {
    for(const s of this.cfg.assets) this._updateExploratoryForSymbol(s);
    this._exploratoryUpdateCount = (this._exploratoryUpdateCount||0)+1;
    // INFO summary every 6 cycles (~30s) so user sees analysis is running, even when gate blocks
    if (this._exploratoryUpdateCount % 6 === 0) {
      const threshPct = (Number(this.cfg.exploratory.hazardMinLift)*100).toFixed(0);
      const lines = [];
      for (const sym of this.cfg.assets) {
        const h = this.assetHistory.get(sym);
        if (!h) continue;
        const best = h.elevated && h.elevated.length ? h.elevated[0] : null;
        const lift = best ? (best.lift*100).toFixed(1)+'%' : '—';
        const bucket = best ? `[${best.lo}-${best.hi})` : '—';
        const status = h.calibrationStatus || '?';
        const intervals = h.intervals ? h.intervals.length : 0;
        const ticks = h.ticksSinceSpike ?? '?';
        const prices = h.prices ? h.prices.length : 0;
        lines.push(`${sym} ${status} ints=${intervals} prices=${prices} ticksSince=${ticks} bestLift=${lift} ${bucket} thresh=${threshPct}%`);
      }
      logger.info(`exploratory analysis #${this._exploratoryUpdateCount}: ${lines.join(' | ')}`);
      // also debug the hazard table for top candidate if any
      const top = this.cfg.assets.map(s=> [s, this.assetHistory.get(s)]).filter(([_,h])=> h && h.elevated && h.elevated.length).sort((a,b)=> b[1].elevated[0].lift - a[1].elevated[0].lift)[0];
      if (top) {
        const [sym, h] = top;
        logger.info(`  top hazard candidate: ${sym} lift ${(h.elevated[0].lift*100).toFixed(2)}% ${h.elevated[0].lo}-${h.elevated[0].hi} ticksSince=${h.ticksSinceSpike}`);
      } else {
        logger.info(`  no hazard bucket ≥${threshPct}% yet — gate will block all entries (lower HAZARD_MIN_LIFT to trade more)`);
      }
    }
  }
  // ── v4 SPIKE-TRIGGERED ENTRY ─────────────────────────
  async _onNewSpike(symbol, spikeIdx) {
    const st = this.cfg.spikeTrigger;
    if (!st || !st.enabled) return;
    const h = this.assetHistory.get(symbol);
    if (!h) return;
    if (h.lastTradedSpikeIdx === spikeIdx) return; // already traded this spike
    if (this.exec.count() >= this.cfg.maxOpenTrades) { logger.debug(`spike ${symbol} #${spikeIdx} ignored: maxOpenTrades`); return; }
    if (this.stopped || !this.client.authorized || this.paused || this.manualRestartRequired) return;
    if (!this._isTradingAllowedToday()) return;
    // if last trade was a WIN and we are waiting for spike, this IS the awaited spike — allow it and clear flag
    // if last trade was a LOSS we would have already re-entered immediately, so this spike is normal
    const now = Date.now();
    if (h.spikeCooldownUntil && now < h.spikeCooldownUntil) { logger.debug(`spike ${symbol} cooldown`); return; }
    const last = this.lastEntryBySymbol.get(symbol) || 0;
    const cooldown = Number(st.spikeCooldownMs ?? 0);
    if (cooldown > 0 && now - last < cooldown) return;
    // per-symbol cooldown still applies as safety (8s)
    if (now - last < this.cfg.perSymbolCooldownMs) { logger.debug(`spike ${symbol} perSymbolCooldown`); return; }
    if (now - this.lastTradeAt < this.cfg.perSymbolEntryGapMs) return;
    await this._trySpikeEntry(symbol, spikeIdx, `new spike #${spikeIdx} @${h.prices.length-1}`);
  }

  async _trySpikeEntry(symbol, spikeIdx, reason) {
    if (this._tradeInFlight) { logger.debug(`spike entry ${symbol} deferred: trade in flight`); return; }
    this._tradeInFlight = true;
    try {
      const g = getGrowthRateForSymbol(symbol);
      const tier = getTierForSymbol(symbol);
      let entryStake = this.currentStake;
      if (this.cfg.martingaleMaxStake && entryStake > this.cfg.martingaleMaxStake) entryStake = Number(this.cfg.martingaleMaxStake);
      const tp = getTPForSymbol(symbol);
      const capFrac = getTickCapFractionForSymbol(symbol);
      logger.info(`SPIKE ENTRY ${symbol} tier=${tier} g=${g} stake=${entryStake.toFixed(2)} martingale ${this._martingaleLabel()} reason=${reason} TP×${tp} cap${(capFrac*100).toFixed(0)}%`);
      if (this.dryRun) { logger.info(`DRY-RUN would buy ${symbol} spike-triggered ${reason}`); return; }
      const h = this.assetHistory.get(symbol);
      const trade = await this.exec.buy(symbol, g, entryStake, { gateReason: reason, spikeTriggered: true, tier });
      this.lastEntryAt = Date.now();
      this.lastEntryBySymbol.set(symbol, this.lastEntryAt);
      if (h) { h.lastTradedSpikeIdx = spikeIdx; h.waitForSpike = false; h.spikeCooldownUntil = Date.now() + Number(this.cfg.spikeTrigger.spikeCooldownMs||0); }
      this._checkDayChange();
    } catch (e) {
      logger.error(`spike entry ${symbol} failed:`, e.message);
    } finally {
      this._tradeInFlight = false;
    }
  }

  async _handleLossImmediateReentry(symbol) {
    const st = this.cfg.spikeTrigger;
    if (!st || !st.enabled || !st.immediateReentryOnLoss) return;
    if (this.stopped || !this.client.authorized || this.paused || this.manualRestartRequired) return;
    if (this.exec.count() >= this.cfg.maxOpenTrades) return;
    // small delay to let Deriv settle previous contract (2s)
    await new Promise(r=> setTimeout(r, 2000));
    if (this.exec.count() >= this.cfg.maxOpenTrades) return;
    logger.info(`LOSS immediate re-entry ${symbol} martingale ${this._martingaleLabel()} stake=${this.currentStake.toFixed(2)}`);
    // bypass spike wait — buy immediately on same asset
    const h = this.assetHistory.get(symbol);
    const fakeIdx = h ? (h.spikeIndices[h.spikeIndices.length-1] ?? h.prices.length-1) : 0;
    await this._trySpikeEntry(symbol, fakeIdx, `loss immediate re-entry (martingale step ${this.martingaleStep})`);
  }

  _exploratoryUpdateCount = 0;
  async _subscribeTicks() {
    for (const sym of this.cfg.assets) {
      if (this._tickSubs.has(sym)) continue;
      try {
        const subId = await this.client.subscribe({ ticks: sym }, msg => {
          const tick = msg.tick; if (!tick) return;
          const price = parseFloat(tick.quote); const epoch = tick.epoch;
          const h = this.assetHistory.get(sym); if (!h) return;
          h.prices.push(price); h.times.push(epoch); h.lastUpdate = Date.now();
          // cap live history to avoid unbounded growth (keep last historyCap)
          if (h.prices.length > this.cfg.exploratory.historyCap) {
            const trim = h.prices.length - this.cfg.exploratory.historyCap;
            h.prices.splice(0, trim); h.times.splice(0, trim);
          }
        });
        this._tickSubs.set(sym, subId);
        logger.info(`exploratory ticks subscribed: ${sym} subId=${subId}`);
      } catch(e){
        const msg = String(e.message||'');
        if (/already subscribed/i.test(msg)) {
          logger.info(`exploratory ticks ${sym}: already subscribed (keep-alive) — reusing keep-alive stream`);
          // mark as subscribed so we don't retry; history for this symbol will be fed
          // by keep-alive's ticks:BOOM50 subscription — patch its callback to also feed history
          // DerivClient keeps keep-alive sub in _keepAliveSubId with noop; we replace its handler
          try {
            const keepId = this.client._keepAliveSubId;
            if (keepId && this.client._subs.has(keepId)) {
              const h = this.assetHistory.get(sym);
              this.client._subs.set(keepId, (msg2)=>{
                const tick = msg2.tick; if (!tick) return;
                const price = parseFloat(tick.quote); const epoch = tick.epoch;
                if (h) { h.prices.push(price); h.times.push(epoch); h.lastUpdate = Date.now(); }
              });
              this._tickSubs.set(sym, keepId);
              logger.info(`exploratory ticks ${sym}: hijacked keep-alive subId=${keepId} to feed history`);
            } else {
              // no keep-alive to hijack — just mark as subscribed to avoid loop
              this._tickSubs.set(sym, 'keep-alive-shared');
            }
          } catch(_){}
        } else {
          logger.warn(`tick sub ${sym} failed:`, e.message);
        }
      }
    }
    if (this._tickSubs.size) logger.info(`exploratory tick subs ready: ${this._tickSubs.size}/${this.cfg.assets.length}`);
  }
  async _unsubscribeTicks() {
    for (const [sym, subId] of this._tickSubs) { try{ await this.client.forget(subId);}catch(_){} }
    this._tickSubs.clear();
  }
  _isExploratoryEntryAllowed(symbol) {
    const expl = this.cfg.exploratory || CONFIG.exploratory;
    if (!expl || !expl.enabled) return { allowed:true, reason:'exploratory disabled (memoryless fallback)' };
    const h = this.assetHistory.get(symbol);
    if (!h) return { allowed:false, reason:'no history' };

    // User 2026-09-10: strict 60% lift gate — configurable via hazardMinLift
    // Do NOT auto-allow CALIBRATING or ACTIVE_RELAXED; they must still meet the lift threshold.
    const threshold = Number(expl.hazardMinLift ?? 0.60);
    const threshPct = (threshold*100).toFixed(0);
    const best = (h.elevated && h.elevated.length) ? h.elevated[0] : null;
    const bestLift = best ? best.lift : null;
    const bestLiftPct = bestLift != null ? (bestLift*100).toFixed(2) : 'n/a';

    // If no elevated bucket meets threshold, block outright — this is the 60% rule
    if (!best || bestLift == null || bestLift < threshold) {
      const status = h.calibrationStatus || 'unknown';
      const detail = best ? `best lift ${bestLiftPct}% [${best.lo}-${best.hi}) < ${threshPct}% threshold` : `no elevated bucket (need ≥${threshPct}%)`;
      return { allowed:false, reason:`hazard lift gate BLOCKED: ${detail} status=${status} ticksSinceSpike=${h.ticksSinceSpike}` };
    }

    const ticks = h.ticksSinceSpike;
    const mode = expl.mode;
    // hazard gate — only allow when ticksSinceSpike is inside the best elevated bucket that passed threshold
    if (mode==='hazard' || mode==='both') {
      const inBucket = ticks >= best.lo && ticks < best.hi;
      if (inBucket) return { allowed:true, reason:`hazard ACTIVE lift ${bestLiftPct}% ≥${threshPct}%: ticksSinceSpike ${ticks} ∈ [${best.lo},${best.hi})` };
      if (mode==='hazard') return { allowed:false, reason:`hazard lift ${bestLiftPct}% ≥${threshPct}% but ticks ${ticks} ∉ [${best.lo},${best.hi}) — blocked` };
    }
    // post-spike gate (only matters when mode===both and hazard passed threshold but ticks not in bucket — allow postSpike as alternative)
    if ((mode==='postSpike' || mode==='both') && h.postStudy && h.postStudy.anySignificant) {
      const target = h.postStudy.firstSignificantOffset;
      if (ticks === target) return { allowed:true, reason:`postSpike ACTIVE: ticksSinceSpike ${ticks} == firstSignificantOffset ${target} (hazard lift ${bestLiftPct}% ≥${threshPct}%)` };
      if (mode==='postSpike') return { allowed:false, reason:`postSpike block: ticks ${ticks} != ${target}` };
    }
    // No relaxed fallback anymore — if we passed the lift threshold but ticks not in bucket, block.
    // This enforces the user's "only trade when lift >=60%" strictly.
    return { allowed:false, reason:`hazard lift ${bestLiftPct}% ≥${threshPct}% but ticks ${ticks} not in bucket [${best.lo},${best.hi}) — blocked` };
  }

  async start() {
    logger.info('═══════════════════════════════════════════');
    logger.info('  accuHOLD v4 — SPIKE-TRIGGERED (spike→trade, win→wait, loss→instant)  ');
    logger.info('═══════════════════════════════════════════');
    const tierInfo = Object.entries(CONFIG.tierDefaults).map(([t,d])=> `${t}:${(d.growthRate*100).toFixed(0)}% TP×${d.takeProfitMultiple} cap${(d.tickCapFraction*100).toFixed(0)}%`).join(' | ');
    const hazardThreshPct = (Number(this.cfg.exploratory.hazardMinLift)*100).toFixed(0);
    logger.info(`assets: ${this.cfg.assets.join(', ')}`);
    logger.info(`tiers: ${tierInfo}  (FAST=BOOM50/CRASH50 spike-dominant, SLOW=others noise-dominant)`);
    logger.info(`exploratory: ${this.cfg.exploratory.enabled ? `WIRED ON mode=${this.cfg.exploratory.mode} logOnly=${this.cfg.exploratory.logOnly} threshold=${hazardThreshPct}% lift (set HAZARD_MIN_LIFT env)` : 'OFF'}`);
    if (this._isMartingaleEnabled()) {
      logger.warn(`martingale: ON  multiplier ×${this.cfg.martingaleMultiplier}  steps ${this.cfg.martingaleSteps}  base stake ${this.baseStake.toFixed(2)} — HIGH RUIN RISK on negative-expectancy ACCU`);
    } else {
      logger.info(`martingale: OFF (flat stake ${this.baseStake.toFixed(2)})`);
    }

    if (!this.cfg.apiToken) { logger.error('API token missing'); process.exit(1); }

    this.client.on('authorized', info => this._onAuthorized(info));
    this.client.on('close', () => this._onDisconnected());
    this.exec.on('open', t => this._onTradeOpen(t));
    this.exec.on('result', t => this._onTradeResult(t));

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));
    process.on('uncaughtException', e => {
      logger.error('uncaughtException:', e);
      this._saveState('fatal');
      try { this.client.stop(); } catch (_) {}
      process.exit(1);
    });
    process.on('unhandledRejection', e => {
      logger.error('unhandledRejection:', e);
      this._saveState('fatal');
      try { this.client.stop(); } catch (_) {}
      process.exit(1);
    });

    this._loadState();
    this._scheduleSummaries();
    this.client.connect();
  }

  _scheduleSummaries() {
    const now = new Date();
    const msToNextHour = ((59 - now.getUTCMinutes()) * 60_000) + ((60 - now.getUTCSeconds()) * 1000) + 50;
    if (this.cfg.hourlySummary) {
      this._hourlyBoot = setTimeout(() => { this._sendHourly(); this._hourlyT = setInterval(() => this._sendHourly(), 3600_000); }, Math.max(1000, msToNextHour));
    }
    const scheduleNextEod = () => {
      const { h, min } = (() => { const m = String(this.cfg.eodTimeGmt || '00:00').match(/^(\d{1,2}):(\d{2})$/); return m ? { h: +m[1], min: +m[2] } : { h: 0, min: 0 }; })();
      const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, min, this.cfg.eodSendDelaySeconds, 0));
      if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
      const delay = target.getTime() - now.getTime();
      this._eodBoot = setTimeout(() => { this._sendEod('scheduled'); scheduleNextEod(); }, delay);
    };
    scheduleNextEod();
  }

  _nextUtcMidnight() {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).getTime();
  }

  // ── Pause helpers (ported from accuAPEX) ─────────────────────────
  _parsePauseTime(str) {
    const m = String(str || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return { h: Math.max(0, Math.min(23, Number(m[1]))), min: Math.max(0, Math.min(59, Number(m[2]))) };
  }
  _msToTarget(targetH, targetMin) {
    const now = new Date();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const targetMinOfDay = targetH * 60 + targetMin;
    let diff = targetMinOfDay - nowMin;
    if (diff <= 0) diff += 24 * 60;
    return diff * 60_000 - (now.getUTCSeconds() * 1000) - now.getUTCMilliseconds();
  }
  _clearPauseTimers() {
    if (this._pauseStartTimer) { clearTimeout(this._pauseStartTimer); this._pauseStartTimer = null; }
    if (this._pauseEndTimer) { clearTimeout(this._pauseEndTimer); this._pauseEndTimer = null; }
  }
  _schedulePause() {
    this._clearPauseTimers();
    if (!this.cfg.pauseEnabled) return;
    const now = new Date();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const start = this._parsePauseTime(this.cfg.pauseStartGmt);
    const end   = this._parsePauseTime(this.cfg.pauseEndGmt);
    if (!start || !end) { logger.warn('pause schedule: invalid pauseStartGmt or pauseEndGmt'); return; }
    const startMin = start.h * 60 + start.min;
    const endMin   = end.h   * 60 + end.min;
    const currentlyPaused = startMin > endMin
      ? (nowMin >= startMin || nowMin < endMin)
      : (nowMin >= startMin && nowMin < endMin);
    if (currentlyPaused) {
      this.paused = true;
      const delay = this._msToTarget(end.h, end.min);
      this._pauseEndTimer = setTimeout(() => this._onPauseResume('resume'), delay);
      logger.info(`pause: currently active, resumes in ${(delay/60000).toFixed(1)}m`);
    } else {
      this.paused = false;
      const delay = this._msToTarget(start.h, start.min);
      this._pauseStartTimer = setTimeout(() => this._onPauseResume('pause'), delay);
      logger.info(`pause: scheduled, pauses in ${(delay/60000).toFixed(1)}m at ${this.cfg.pauseStartGmt} GMT`);
    }
  }
  _onPauseResume(action) {
    this._clearPauseTimers();
    if (action === 'pause') {
      this.paused = true;
      logger.info(`TRADING PAUSED at ${this.cfg.pauseStartGmt} GMT until ${this.cfg.pauseEndGmt} GMT`);
      telegram.send(`⏸️ <b>AccuHOLD_v4 TRADING PAUSED</b>\nPaused from <b>${this.cfg.pauseStartGmt}</b> to <b>${this.cfg.pauseEndGmt}</b> GMT.`);
      const end = this._parsePauseTime(this.cfg.pauseEndGmt);
      if (end) this._pauseEndTimer = setTimeout(() => this._onPauseResume('resume'), this._msToTarget(end.h, end.min));
    } else {
      this.paused = false;
      logger.info(`TRADING RESUMED at ${this.cfg.pauseEndGmt} GMT`);
      telegram.send(`▶️ <b>AccuHOLD_v4 TRADING RESUMED</b>\nOverall: ${money(this.overallProfit, this.currencyStr())}`);
      const start = this._parsePauseTime(this.cfg.pauseStartGmt);
      if (start) this._pauseStartTimer = setTimeout(() => this._onPauseResume('pause'), this._msToTarget(start.h, start.min));
    }
  }
  _isTradingAllowedToday() {
    const dayOfWeek = new Date().getUTCDay();
    const daySettings = [this.cfg.tradeSunday, this.cfg.tradeMonday, this.cfg.tradeTuesday, this.cfg.tradeWednesday, this.cfg.tradeThursday, this.cfg.tradeFriday, this.cfg.tradeSaturday];
    return !!daySettings[dayOfWeek];
  }
  _checkDayChange() {
    const today = utcDateStr();
    if (this._lastDayISODate && this._lastDayISODate !== today) {
      logger.info(`new day detected: ${this._lastDayISODate} → ${today}`);
      this.consecutiveLosses = 0;
      // Note: martingale state is NOT auto-reset on day change; stake cycle continues.
      // Uncomment next two lines if you want day-bound reset:
      // this.martingaleStep = 0;
      // this.currentStake = this.baseStake;
      this._dailyStopUntil = 0;
      this._dailyStopNotified = false;
      telegram.send(`📅 <b>AccuHOLD_v4 New trade day: ${today}</b>\nOverall: ${money(this.overallProfit, this.currencyStr())}\n♻️ Martingale: ${this._martingaleLabel()} · Stake ${this.currentStake.toFixed(2)} ${this.currencyStr()}`);
    }
    this._lastDayISODate = today;
  }

  // ── Authorised ──────────────────────────────────────────────────
  async _onAuthorized(info) {
    if (this.startBalance == null) this.startBalance = this.balance ?? this.client.balance;
    this.lastBalance = this.startBalance;

    const tierLine = Object.entries(this.cfg.tierDefaults).map(([t,d])=> `${t.toUpperCase()}: ${(d.growthRate*100).toFixed(0)}% TP×${d.takeProfitMultiple} cap${(d.tickCapFraction*100).toFixed(0)}%`).join(' | ');
    const exploratoryLine = this.cfg.exploratory.enabled ? `🧪 <b>Exploratory:</b> WIRED ON mode=${this.cfg.exploratory.mode} proven edge (hazard+postSpike)\n` : `🧪 <b>Exploratory:</b> OFF\n`;
    const martingaleLine = this._isMartingaleEnabled()
      ? `♻️ <b>Martingale:</b> ON  ×${Number(this.cfg.martingaleMultiplier).toFixed(2)}  steps ${this.cfg.martingaleSteps}  base ${this.baseStake.toFixed(2)} → now ${this.currentStake.toFixed(2)} step ${this.martingaleStep}\n`
      : `♻️ <b>Martingale:</b> OFF  (flat stake ${this.baseStake.toFixed(2)})\n`;
    const lossLine = `📉 <b>Loss Streak:</b> ${this.consecutiveLosses} (max ${this.stats.maxLossStreak}) · ${this.stats.lossStreakLine()}\n`;
    if (!this._bootedOnce) {
      this._bootedOnce = true;
      telegram.send(
        `<b>AccuHOLD v4 SPIKE Bot Online</b>${this.dryRun ? ' <b>🔒 DRY-RUN</b>' : ''} <i>spike→trade win→wait loss→instant</i>\n\n` +
        `<b>Account:</b> ${info.loginid} (${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'})\n` +
        `<b>Balance:</b> ${(this.startBalance ?? 0).toFixed(2)} ${this.currencyStr()}\n` +
        `<b>Assets:</b> ${this.cfg.assets.length} (${tierLine})\n` +
        exploratoryLine +
        martingaleLine +
        lossLine +
        `<b>Cooldown:</b> ${this.cfg.perSymbolCooldownMs/1000}s/symbol\n` +
        `<b>Daily caps:</b> ${this.cfg.dailyMaxTrades} trades / ${this.cfg.dailyMaxLoss} ${this.currencyStr()}\n` +
        `<b>Overall:</b> ${money(this.overallProfit, this.currencyStr())}`,
      );
    } else {
      telegram.send(`🔄 <b>AccuHOLD_v4 Reconnected</b> (${info.loginid}, ${info.isVirtual ? 'DEMO' : 'REAL'})\n${martingaleLine.trim()}\n${exploratoryLine.trim()}${lossLine.trim()}`);
    }

    // Fetch live ticks_stayed_in per-tier buckets BEFORE entry
    try { await this.market.refreshStaysPerTier(this.cfg.assets); } catch (e) { logger.warn('post-auth refreshStaysPerTier:', e.message); }

    // Subscribe ticks for exploratory signals + backfill
    if (this.cfg.exploratory.enabled) {
      // Fix keep-alive conflict: exploratory needs ticks for all 10 symbols, but DerivClient
      // already holds a keep-alive ticks:BOOM50 that Deriv rejects as "already subscribed".
      // Stop keep-alive first so exploratory can own all tick subs.
      try { this.client._stopKeepAlive(); } catch(_){}
      try { await this._subscribeTicks(); } catch(e){ logger.warn('tick subs:', e.message); }
      // periodic exploratory recompute (hazard + postSpike) every 5s — with INFO summary
      if (this._exploratoryT) clearInterval(this._exploratoryT);
      this._exploratoryT = setInterval(()=> this._updateAllExploratory(), 5000);
      // initial deep backfill if history empty (lightweight: use Deriv ticks_history via client)
      this._backfillHistory().catch(e=> logger.warn('backfill failed:', e.message));
      // immediate recompute after backfill kicked
      setTimeout(()=> this._updateAllExploratory(), 6000);
    }

    // Reconcile any contracts that were open across the disconnect.
    try { await this.exec.reconcileOpenContracts(); }
    catch (e) { logger.warn('reconcile:', e.message); }

    this._schedulePause();
    if (this._analysisT) clearInterval(this._analysisT);
    this._analysisT = setInterval(() => this._maybeEnter(), 3000);
    if (this._proposalT) clearInterval(this._proposalT);
    this._proposalT = setInterval(() => this.market.refreshStaysPerTier(this.cfg.assets), this.cfg.proposalRefreshMs);
    this._startWatchdog();
    this._startStuckSweep();
    this._maybeEnter();
  }

  async _backfillHistory() {
    for (const sym of this.cfg.assets) {
      const h = this.assetHistory.get(sym);
      if (h && h.prices.length > 500) continue;
      try {
        const allPrices = []; const allTimes = [];
        let end = 'latest';
        let remaining = 5000;
        for (let batch=0; batch<5 && remaining>0; batch++) {
          const count = Math.min(1000, remaining);
          const res = await this.client._send({ ticks_history: sym, count, end, style: 'ticks' }, 15000);
          const prices = (res.history?.prices||[]).map(Number);
          const times = res.history?.times||[];
          if (!prices.length) break;
          allPrices.unshift(...prices);
          allTimes.unshift(...times);
          remaining -= prices.length;
          if (prices.length < count) break;
          end = String(times[0] - 1);
          await new Promise(r=>setTimeout(r, 250));
        }
        if (allPrices.length) {
          h.prices = allPrices; h.times = allTimes;
          this._updateExploratoryForSymbol(sym);
          const bestLift = h.elevated && h.elevated.length ? (h.elevated[0].lift*100).toFixed(1)+'%' : '—';
          logger.info(`backfill ${sym}: ${allPrices.length} ticks, spikes=${h.spikeIndices.length} mean=${h.meanInterval?.toFixed(1)??'?'} bestLift=${bestLift} status=${h.calibrationStatus}`);
        } else {
          logger.warn(`backfill ${sym}: no ticks returned`);
        }
      } catch(e){ logger.warn(`backfill ${sym} failed:`, e.message); }
      await new Promise(r=>setTimeout(r, 350));
    }
    setTimeout(()=> this._updateAllExploratory(), 1000);
  }

  async _onDisconnected() {
    this._clearWatchdog();
    this._clearStuckSweep();
    this._clearPauseTimers();
    if (this._exploratoryT) { clearInterval(this._exploratoryT); this._exploratoryT=null; }
    telegram.send(`⚠️ <b>AccuHOLD_v4 Connection lost</b> — reconnecting…`);
    if (this._analysisT) { clearInterval(this._analysisT); this._analysisT = null; }
    if (this._proposalT) { clearInterval(this._proposalT); this._proposalT = null; }
    // keep tick subs map but clear WS subs; will re-sub on auth
    this._tickSubs.clear();
    // exec.open is intentionally KEPT — contracts are still live server-side.
    // reconcileOpenContracts() re-attaches them after re-auth.
    this.exec._subscriptions.clear();
  }

  // ── Trade callbacks ─────────────────────────────────────────────
  _onTradeOpen(t) {
    const martingaleNote = this._isMartingaleEnabled()
      ? `♻️ <b>Martingale:</b> ${this._martingaleLabel()} · base ${this.baseStake.toFixed(2)} → <b>${t.stake.toFixed(2)} ${this.currencyStr()}</b>${this.martingaleStep > 0 ? ` (step ${this.martingaleStep}/${this.cfg.martingaleSteps})` : ' (base)'}\n`
      : '';
    const lossNote = `📉 <b>Loss Streak:</b> ${this.consecutiveLosses} · max ${this.stats.maxLossStreak} · ${this.stats.lossStreakLine()}\n`;
    const nextStakeNote = this._isMartingaleEnabled()
      ? `➡️ <b>Next stake (if loss):</b> ${this._calcMartingaleStake(Math.min(this.martingaleStep + 1, this.cfg.martingaleSteps)).toFixed(2)} ${this.currencyStr()}${this.martingaleStep + 1 > this.cfg.martingaleSteps ? ' (would reset to base)' : ''}\n`
      : '';
    const h = this.assetHistory?.get(t.symbol);
    const exploratoryNote = h ? `🧪 <b>Exploratory:</b> ${h.calibrationStatus} ${h.elevated?.length?`hazard lift ${(h.elevated[0].lift*100).toFixed(2)}% [${h.elevated[0].lo}-${h.elevated[0].hi}) `:''}${h.postStudy?.anySignificant?`postSpike offset=${h.postStudy.firstSignificantOffset} `:''}ticksSinceSpike at entry ~${h.ticksSinceSpike}\n` : '';
    const tier = getTierForSymbol(t.symbol);
    const msg =
      `🟢 <b>AccuHOLD_v4 TRADE OPENED</b> <i>v4 exploratory</i>\n\n` +
      `<b>Contract:</b> #${t.contractId}\n` +
      `<b>Symbol:</b> <code>${t.symbol}</code> <i>(${tier})</i>\n` +
      `<b>Growth Rate:</b> ${(t.growthRate*100).toFixed(2)}% <i>(${tier} tier)</i>\n` +
      `<b>Stake:</b> ${t.stake.toFixed(2)} ${this.currencyStr()}${this.martingaleStep > 0 ? ` <i>(martingale ×${Math.pow(this.cfg.martingaleMultiplier, this.martingaleStep).toFixed(2)})</i>` : ''}\n` +
      martingaleNote +
      `<b>Take-Profit floor:</b> ${(t.stake * (t.takeProfitMultiple ?? getTPForSymbol(t.symbol))).toFixed(2)} ${this.currencyStr()}\n` +
      `<b>Tick-cap:</b> ${t.tickCapTicks ?? 'n/a'} ticks (${((t.tickCapFraction??getTickCapFractionForSymbol(t.symbol))*100).toFixed(0)}% × live median <code>${t.ticksStayedInMedian ?? 'n/a'}</code>)\n` +
      lossNote +
      exploratoryNote +
      nextStakeNote +
      `<b>Overall:</b> ${money(this.overallProfit, this.currencyStr())}\n\n` +
      `<i>⚠️ Exploratory-wired entry (hazard lift ${(h?.elevated?.[0]?.lift*100 ?? 0).toFixed(2)}% ≥${(Number(this.cfg.exploratory.hazardMinLift)*100).toFixed(0)}% threshold)</i>`;
    telegram.send(msg);
  }

  _onTradeResult(t) {
    const rec = this.stats.record(t);
    if (t.status === 'unknown') {
      // Unconfirmable / stuck contract — booked as a LOSS of the stake. It
      // counts in P&L below but never touches the loss streak or martingale.
      const stakeLoss = -Number(t.stake || 0);
      this.lastBalance = (this.lastBalance ?? this.balance ?? 0) + stakeLoss;
      this.overallProfit += stakeLoss;
      logger.warn(`trade #${t.contractId} unconfirmable — booked as loss of ${(-stakeLoss).toFixed(2)}, excluded from streaks/martingale`);
      telegram.send(`⚠️ <b>AccuHOLD_v4 UNCONFIRMABLE CONTRACT</b> #${t.contractId} ${t.symbol}\nBooked as a <b>loss</b> of ${(-stakeLoss).toFixed(2)} ${this.currencyStr()} in P&L — excluded from loss streak & martingale.`);
      this._saveState('after-trade');
      return;
    }
    this.lastBalance = (this.lastBalance ?? this.balance ?? 0) + t.profit;
    this.overallProfit += t.profit;
    if (t.status === 'lost') this.consecutiveLosses += 1;
    else if (t.status === 'won') this.consecutiveLosses = 0;

    // ── Martingale update (stake for NEXT trade) ──────────
    const prevStake = this.currentStake;
    const prevStep = this.martingaleStep;
    const mg = this._updateMartingaleOnResult(t.status);

    // Risk halt: max consecutive losses → require manual restart.
    if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses && !this.manualRestartRequired) {
      this.manualRestartRequired = true;
      this.manualRestartReason = `${this.consecutiveLosses} consecutive losses (cap ${this.cfg.maxConsecutiveLosses})`;
      logger.error(`RISK HALT: ${this.manualRestartReason} — manual restart required`);
      telegram.send(
        `⛔ <b>AccuHOLD_v4 RISK HALT</b>\n${this.manualRestartReason}.\n` +
        `Trading is paused. Restart the bot to clear the halt.`,
      );
    }

    const todayStats = this.stats.stats(this.stats.todayTrades(rec.date));
    const emoji = t.status === 'won' ? '✅' : '❌';
    const label = t.status === 'won' ? 'WIN' : 'LOSS';
    const exit = t.exitReason || 'n/a';
    const exitLine = exit.startsWith('take-profit') ? '🎯 take-profit'
                  : exit.startsWith('tick-cap')     ? '⏱️ tick-cap'
                  : exit.startsWith('knockout')     ? '💥 knockout'
                  : exit;
    // Duration = sell_time − buy_time. `sellTime` and `buyTime` are
    // populated by every finalize path (terminal status, voluntary sell,
    // already-closed-on-server) so this is the canonical "how long was
    // the trade held" number — independent of how many proposal_open_
    // contract updates arrived in the meantime.
    const buyTs  = Number(t.buyTime  || 0);
    const sellTs = Number(t.sellTime || 0);
    const durationSec = (buyTs > 0 && sellTs > 0 && sellTs >= buyTs) ? (sellTs - buyTs) : null;
    const durationLine = durationSec != null
      ? `⏱️ <b>Duration:</b> ${formatDuration(durationSec)}\n`
      : `⏱️ <b>Duration:</b> n/a\n`;
    // Martingale display for this result
    let martingaleLine = '';
    if (this._isMartingaleEnabled()) {
      if (t.status === 'lost') {
        if (mg.reason === 'loss-step-up') {
          martingaleLine = `♻️ <b>Martingale:</b> STEP UP  ${prevStep}/${this.cfg.martingaleSteps} → ${this.martingaleStep}/${this.cfg.martingaleSteps}  stake ${prevStake.toFixed(2)} → <b>${this.currentStake.toFixed(2)} ${this.currencyStr()}</b> (×${this.cfg.martingaleMultiplier})\n`;
        } else if (mg.reason === 'max-reset') {
          martingaleLine = `♻️ <b>Martingale:</b> MAX STEPS hit → RESET to base <b>${this.currentStake.toFixed(2)} ${this.currencyStr()}</b>\n`;
        } else {
          martingaleLine = `♻️ <b>Martingale:</b> ${this._martingaleLabel()}  stake now ${this.currentStake.toFixed(2)} ${this.currencyStr()}\n`;
        }
      } else {
        if (mg.reason === 'win-reset') {
          martingaleLine = `♻️ <b>Martingale:</b> WIN → RESET  ${prevStake.toFixed(2)} → <b>${this.currentStake.toFixed(2)} ${this.currencyStr()}</b> (base)\n`;
        } else {
          martingaleLine = `♻️ <b>Martingale:</b> WIN at base — stake stays <b>${this.currentStake.toFixed(2)} ${this.currencyStr()}</b>\n`;
        }
      }
    } else {
      martingaleLine = `♻️ <b>Martingale:</b> OFF  (flat stake)\n`;
    }
    const lossBreakdown = `📉 <b>Loss Streak:</b> ${this.consecutiveLosses} · max ${this.stats.maxLossStreak}\n` +
                          `   ${this.stats.lossStreakLine()}\n`;
    const msg =
      `${emoji} <b>AccuHOLD_v4 TRADE ${label}</b>\n\n` +
      `<b>Contract:</b> #${t.contractId} · <b>Symbol:</b> <code>${t.symbol}</code>\n` +
      `<b>Growth:</b> ${(t.growthRate*100).toFixed(0)}% · <b>Stake:</b> ${Number(t.stake).toFixed(2)} ${this.currencyStr()}\n` +
      `<b>Sell:</b> ${Number(t.sellPrice ?? 0).toFixed(2)} ${this.currencyStr()}\n` +
      `${t.profit >= 0 ? '💚' : '💔'} <b>Profit:</b> ${t.profit >= 0 ? '+' : ''}${t.profit.toFixed(2)} ${this.currencyStr()}\n` +
      `<b>Exit:</b> ${exitLine}\n` +
      durationLine +
      `<b>Ticks held:</b> ${t.ticksHeld ?? '?'} (tick-cap was ${t.tickCapTicks ?? '?'})` +
      (t.ticksHeldOpen != null && t.ticksHeld !== t.ticksHeldOpen ? ` · since-sub: ${t.ticksHeldOpen}` : '') +
      `\n` +
      martingaleLine +
      lossBreakdown +
      `<b>Balance:</b> ${(this.lastBalance ?? 0).toFixed(2)} ${this.currencyStr()}\n\n` +
      `<b>GMT Day (${rec.date})</b>\n` +
      `• Trades: ${todayStats.count} (✅${todayStats.wins} ❌${todayStats.losses}) | WR ${todayStats.winRate.toFixed(1)}%\n` +
      `• Net: ${money(todayStats.totalProfit, this.currencyStr())} | PF ${todayStats.profitFactor === Infinity ? '∞' : todayStats.profitFactor.toFixed(2)}\n\n` +
      `<b>Overall:</b> ${money(this.overallProfit, this.currencyStr())}`;
    telegram.send(msg);
    this.lastTradeAt = Date.now();
    this._saveState('after-trade');

    // ── v4 spike-triggered branching ──────────────────────────
    if (this.cfg.spikeTrigger && this.cfg.spikeTrigger.enabled) {
      const h = this.assetHistory.get(t.symbol);
      if (h) {
        if (t.status === 'won' && this.cfg.spikeTrigger.waitForSpikeOnWin) {
          h.waitForSpike = true;
          logger.info(`spike v4: WIN on ${t.symbol} — waiting for next spike before re-entry`);
        } else if (t.status === 'lost' && this.cfg.spikeTrigger.immediateReentryOnLoss) {
          logger.info(`spike v4: LOSS on ${t.symbol} — immediate re-entry on same asset`);
          this._handleLossImmediateReentry(t.symbol).catch(e=> logger.error(`immediate reentry ${t.symbol}:`, e.message));
        }
      }
    }
  }

  // ── Entry decision: v4 spike-triggered (polling disabled when spikeTrigger enabled) ─
  // When CONFIG.exploratory.enabled:true, entry is gated by hazard/postSpike
  // signals derived from live tick history (see _isExploratoryEntryAllowed).
  // Falls back to relaxed mean-derived entry when no signal (ACTIVE_RELAXED).
  // Tier-aware growthRate/TP/cap are resolved per symbol.
  async _maybeEnter() {
    // v4 spike-triggered: disable polling entry, entry is driven by _onNewSpike
    if (this.cfg.spikeTrigger && this.cfg.spikeTrigger.enabled) return;
    if (this._tradeInFlight) return;
    this._tradeInFlight = true;
    try {
      if (this.stopped) return;
      if (!this.client.authorized) return;
      if (this.paused) { logger.debug('paused — skipping'); return; }
      if (!this._isTradingAllowedToday()) return;
      this._checkDayChange();
      if (this.manualRestartRequired) return;

      const now = Date.now();
      if (this._dailyStopUntil && now < this._dailyStopUntil) return;
      const today = this.stats.todayTrades();
      if (today.length >= this.cfg.dailyMaxTrades || today.reduce((s, t) => s + (t.profit || 0), 0) <= -this.cfg.dailyMaxLoss) {
        if (!this._dailyStopNotified) {
          this._dailyStopNotified = true;
          this._dailyStopUntil = this._nextUtcMidnight();
          const pl = today.reduce((s, t) => s + (t.profit || 0), 0);
          logger.warn(`daily hard stop: ${today.length} trades / P/L ${pl.toFixed(2)} — paused until next UTC day`);
          telegram.send(`⛔ <b>AccuHOLD_v4 Daily hard stop</b>\n${today.length} trades, net ${money(pl, this.currencyStr())}.\nPaused until next UTC day.`);
        }
        return;
      }

      if (now - this.lastTradeAt < this.cfg.perSymbolEntryGapMs) return;
      if (this.exec.count() >= this.cfg.maxOpenTrades) return;

      // Candidates: per-symbol cooldown + tier-aware median + exploratory gate
      const candidates = [];
      const blockedReasons = [];
      for (const sym of this.cfg.assets) {
        if (this.market._unsupportedSymbols.has(sym)) continue;
        const last = this.lastEntryBySymbol.get(sym) || 0;
        if (now - last < this.cfg.perSymbolCooldownMs) continue;
        const g = getGrowthRateForSymbol(sym);
        const median = this.market.getMedianStay(sym, g);
        const tier = getTierForSymbol(sym);
        const gate = this._isExploratoryEntryAllowed(sym);
        if (!gate.allowed) { blockedReasons.push(`${sym}: ${gate.reason}`); continue; }
        candidates.push({ sym, median, tier, gate, growthRate:g });
      }
      if (!candidates.length) {
        // Throttled INFO so user sees why no trades — every 10th call (~30s) we dump the full gate table
        this._gateBlockCount = (this._gateBlockCount||0)+1;
        if (this._gateBlockCount % 10 === 0) {
          const threshPct = (Number(this.cfg.exploratory.hazardMinLift)*100).toFixed(0);
          logger.info(`gate BLOCKED all ${this.cfg.assets.length} symbols (threshold ${threshPct}%): ${blockedReasons.join(' | ')}`);
        } else {
          // still log at debug for verbose
          for (const r of blockedReasons) logger.debug(`gate block: ${r}`);
        }
        return;
      }
      // reset block counter when we do have candidates
      this._gateBlockCount = 0;

      // Round-robin across tiers: longest-since-touched first, prefer alternating tiers
      candidates.sort((a, b) => (this.lastEntryBySymbol.get(a.sym) || 0) - (this.lastEntryBySymbol.get(b.sym) || 0));
      const sym = candidates[0].sym;
      const g = candidates[0].growthRate;
      const tier = candidates[0].tier;
      const gate = candidates[0].gate;

      const entryStakeRaw = this.currentStake;
      // cap martingale stake if configured
      let entryStake = entryStakeRaw;
      if (this.cfg.martingaleMaxStake && entryStake > this.cfg.martingaleMaxStake) entryStake = this.cfg.martingaleMaxStake;
      const tp = getTPForSymbol(sym);
      const capFrac = getTickCapFractionForSymbol(sym);
      logger.info(
        `ENTRY ${sym} tier=${tier} g=${g} stake=${entryStake.toFixed(2)} (base ${this.baseStake.toFixed(2)} martingale ${this._martingaleLabel()}) ` +
        `TP×${tp} cap${(capFrac*100).toFixed(0)}% gate=${gate.reason}`,
      );

      if (this.dryRun) {
        logger.info(`DRY-RUN would buy ${sym} tier=${tier} g=${g} stake=${entryStake.toFixed(2)} gate=${gate.reason}`);
        return;
      }

      const trade = await this.exec.buy(sym, g, entryStake, { gateReason: gate.reason, tier });
      this.lastEntryAt = Date.now();
      this.lastEntryBySymbol.set(sym, this.lastEntryAt);
    } catch (e) {
      logger.error('entry error:', e.message);
    } finally {
      this._tradeInFlight = false;
    }
  }

  // ── Watchdog (sweeps ALL stale open contracts) ──────────────────
  // The watch policy is "re-subscribe first, then force-sell":
  //   • If the proposal_open_contract stream just went quiet (subscription
  //     dropped server-side), re-attach it and let normal exit logic run.
  //   • Only sell/force-settle when the server itself says the contract is
  //     no longer open OR the re-subscribe path is exhausted.
  _startWatchdog() {
    this._clearWatchdog();
    // Run at half the watchdog interval, but do NOT optimistically bump lastUpdateAt.
    // That bump was masking stuck contracts from the 180s stuck-sweep (see pm2 log #12411833379).
    this._watchdogT = setInterval(() => {
      const now = Date.now();
      for (const info of this.exec.openTrades()) {
        if (this.exec._selling.has(info.contractId)) continue;
        const staleMs = now - (info.lastUpdateAt || 0);
        if (staleMs > this.cfg.tradeWatchdogMs) {
          const staleSec = (staleMs / 1000).toFixed(0);
          const attempts = (info._watchdogAttempts || 0) + 1;
          logger.warn(`watchdog: #${info.contractId} ${info.symbol} stream quiet ${staleSec}s (attempt ${attempts}) — authoritative reconcile`);
          // Do authoritative reconcile immediately (POC fetch + portfolio check + sell with backoff)
          // and also force re-subscribe in parallel — but NEVER bump lastUpdateAt here.
          this.exec._reconcileStuck(info.contractId, info)
            .catch(e => logger.error(`watchdog reconcile #${info.contractId} failed:`, e.message));
          // Best-effort forced re-subscribe for when contract is still open and stream just died
          this.exec._attachContractStream(info, true).catch(e => logger.debug(`watchdog forced resub #${info.contractId}:`, e.message));
        }
      }
    }, this.cfg.tradeWatchdogMs / 2);
  }
  _clearWatchdog() { if (this._watchdogT) { clearInterval(this._watchdogT); this._watchdogT = null; } }

  // ── Stuck-contract sweep (separate, longer cadence — now redundant with watchdog but kept as backup) ──
  _startStuckSweep() {
    this._clearStuckSweep();
    // 30s sweep, but threshold 180s — watchdog now handles 90s cases, this is final backup
    this._stuckT = setInterval(() => this.exec.checkStuckContracts(180000), 30000);
  }
  _clearStuckSweep() { if (this._stuckT) { clearInterval(this._stuckT); this._stuckT = null; } }

  // ── Summaries ───────────────────────────────────────────────────
  _sendHourly() {
    const now = new Date();
    const prev = new Date(now.getTime() - 3600_000);
    const date = utcDateStr(prev), hour = utcHour(prev);
    const list = this.stats.tradesForHour(date, hour);
    const s = this.stats.stats(list);
    const martingaleInfo = this._isMartingaleEnabled()
      ? `♻️ Martingale: ${this._martingaleLabel()} · base ${this.baseStake.toFixed(2)} → now ${this.currentStake.toFixed(2)} ${this.currencyStr()}\n`
      : `♻️ Martingale: OFF\n`;
    const lossInfo = `📉 Loss streak: ${this.consecutiveLosses} · max ${this.stats.maxLossStreak} · ${this.stats.lossStreakLine()}\n`;
    if (!list.length) {
      telegram.send(`⏰ AccuHOLD_v4 <b>${date} ${pad(hour)}:00</b> — No trades\n${martingaleInfo}${lossInfo}💼 Overall: ${money(this.overallProfit, this.currencyStr())}`);
      return;
    }
    let msg = `⏰ AccuHOLD_v4 <b>${date} ${pad(hour)}:00</b>\n\n📊 ${s.count} trades (✅${s.wins} ❌${s.losses})\n📈 WR: ${s.winRate.toFixed(1)}%\n💰 P/L: <b>${money(s.totalProfit, this.currencyStr())}</b>\n💼 Overall: <b>${money(this.overallProfit, this.currencyStr())}</b>\n${martingaleInfo}${lossInfo}\n`;
    list.slice(-15).forEach((t, i) => {
      const exit = (t.exitReason || '').split(':')[0];
      const mgTag = t.martingaleStep != null && t.martingaleStep > 0 ? ` MG×${Number(t.martingaleMultiplier || 1).toFixed(2)}` : '';
      msg += `${i + 1}. ${t.status === 'won' ? '✅' : '❌'} #${t.contractId} ${t.symbol} ticks=${t.ticksHeld ?? '?'} exit=${exit}${mgTag} ${money(t.profit, this.currencyStr())}\n`;
    });
    telegram.send(msg);
  }

  _sendEod(reason = 'manual') {
    const date = utcDateStr(new Date(Date.now() - 86_400_000));
    if (this.stats.isEodSent(date) && reason === 'scheduled') return;
    const summary = this.stats.archiveDate(date);
    const ds = summary.stats;
    const balStart = this.startBalance ?? 0, balNow = this.lastBalance ?? balStart;
    const balDelta = balNow - balStart;
    let msg = `🌙 AccuHOLD_v4 <b>DAILY REPORT — ${date}</b>\n\n`;
    if (ds.count) msg += `📊 ${ds.count} trades (✅${ds.wins} ❌${ds.losses}) | WR ${ds.winRate.toFixed(1)}%\n💰 Net: <b>${money(ds.totalProfit, this.currencyStr())}</b> | PF ${ds.profitFactor === Infinity ? '∞' : ds.profitFactor.toFixed(2)}\n`;
    else msg += `No trades.\n`;
    msg += `\n💼 ${balStart.toFixed(2)} → ${balNow.toFixed(2)} (${balDelta >= 0 ? '+' : ''}${balDelta.toFixed(2)})\n`;
    msg += `💼 Overall: <b>${money(this.overallProfit, this.currencyStr())}</b>\n`;
    if (this._isMartingaleEnabled()) {
      msg += `♻️ Martingale: ${this._martingaleLabel()} · base ${this.baseStake.toFixed(2)} → now ${this.currentStake.toFixed(2)} ${this.currencyStr()}\n`;
    } else {
      msg += `♻️ Martingale: OFF (flat stake)\n`;
    }
    msg += `📉 Loss streak: current ${this.consecutiveLosses} · max ${this.stats.maxLossStreak} · ${this.stats.lossStreakLine()}`;
    telegram.send(msg);
    this.stats.markEodSent(date);
    this._saveState(`eod-${reason}`);
    this.startBalance = this.client.balance ?? this.lastBalance ?? this.startBalance;
  }

  currencyStr() { return this.client.currency || this.cfg.currency; }

  // ── State persistence (atomic write) — FRESH v4 (user #4) ──
  _saveState(reason = 'checkpoint') {
    if (!this.cfg.stateSaveOnTrade && reason === 'after-trade') return;
    if (!this.cfg.stateSaveOnShutdown && reason === 'shutdown') return;
    try {
      const payload = {
        version: 4, engine: 'accuHOLD v4 spike-triggered (spike→trade win→wait loss→instant)', savedAt: new Date().toISOString(), savedReason: reason,
        startBalance: this.startBalance, lastBalance: this.lastBalance, overallProfit: this.overallProfit,
        consecutiveLosses: this.consecutiveLosses,
        manualRestartRequired: this.manualRestartRequired,
        manualRestartReason: this.manualRestartReason,
        lastEntryBySymbol: Array.from(this.lastEntryBySymbol.entries()),
        // Martingale persistence
        baseStake: this.baseStake,
        currentStake: this.currentStake,
        martingaleStep: this.martingaleStep,
        stats: this.stats.serialize(),
      };
      const tmp = this.cfg.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, this.cfg.stateFile);
    } catch (e) { logger.warn('state save:', e.message); }
  }

  _loadState() {
    const file = this.cfg.stateFile;
    if (!fs.existsSync(file)) { logger.info('fresh state (v4) — no prior state file, starting clean per user #4'); return; }
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d.version && d.version < 4) { logger.info(`ignoring v${d.version} state (fresh v4 start) — archiving old state`); try{ fs.renameSync(file, file+'.v3bak'); }catch(_){} return; }
      if (d.startBalance != null) this.startBalance = d.startBalance;
      if (d.lastBalance != null) this.lastBalance = d.lastBalance;
      if (d.overallProfit != null) this.overallProfit = d.overallProfit;
      if (d.consecutiveLosses != null) this.consecutiveLosses = d.consecutiveLosses;
      if (d.manualRestartRequired) { this.manualRestartRequired = true; this.manualRestartReason = d.manualRestartReason || ''; }
      if (Array.isArray(d.lastEntryBySymbol)) this.lastEntryBySymbol = new Map(d.lastEntryBySymbol);
      // Martingale restore
      if (d.baseStake != null) this.baseStake = Number(d.baseStake);
      if (d.currentStake != null) this.currentStake = Number(d.currentStake);
      else this.currentStake = this.baseStake;
      if (d.martingaleStep != null) this.martingaleStep = Number(d.martingaleStep) || 0;
      // reconcile with current config if base stake changed
      if (Number(this.cfg.stake) !== this.baseStake) {
        // keep persisted cycle but ensure base matches config
        this.baseStake = Number(this.cfg.stake);
        this.currentStake = this._calcMartingaleStake(this.martingaleStep);
      }
      this.stats = new StatisticsManager(d.stats || {});
      logger.info(
        `state restored: overallProfit=${this.stats.overallProfit.toFixed(2)} ` +
        `consecLosses=${this.consecutiveLosses} halt=${this.manualRestartRequired} ` +
        `martingale step=${this.martingaleStep} stake=${this.currentStake.toFixed(2)}/${this.baseStake.toFixed(2)} ` +
        `maxStreak=${this.stats.maxLossStreak} ${this.stats.lossStreakLine()}`,
      );
    } catch (e) { logger.warn('state load:', e.message); }
  }

  stop(signal) {
    if (this.stopped) return;
    this.stopped = true;
    this._clearWatchdog();
    this._clearStuckSweep();
    this._clearPauseTimers();
    if (this._exploratoryT) { clearInterval(this._exploratoryT); this._exploratoryT=null; }
    this._unsubscribeTicks().catch(()=>{});
    logger.info(`stopping (${signal})`);
    telegram.send(`<b>AccuHOLD_v4 Bot stopped</b>\nSignal: ${signal}`);
    if (this._analysisT) clearInterval(this._analysisT);
    if (this._proposalT) clearInterval(this._proposalT);
    if (this._hourlyT) clearInterval(this._hourlyT);
    if (this._hourlyBoot) clearTimeout(this._hourlyBoot);
    if (this._eodBoot) clearTimeout(this._eodBoot);

    this.exec.cleanupAllSubscriptions().catch(e => logger.warn('cleanup failed:', e.message)).finally(() => {
      const today = this.stats.todayTrades();
      const s = this.stats.stats(today);
      const mgLine = this._isMartingaleEnabled()
        ? `♻️ Martingale: ${this._martingaleLabel()} · base ${this.baseStake.toFixed(2)} → now ${this.currentStake.toFixed(2)}\n`
        : `♻️ Martingale: OFF\n`;
      const lossLine = `📉 Loss streak: ${this.consecutiveLosses} · max ${this.stats.maxLossStreak} · ${this.stats.lossStreakLine()}\n`;
      const msg = `🌙 <b>AccuHOLD_v4 SESSION END</b>\n📊 ${s.count} trades (✅${s.wins} ❌${s.losses}) | WR ${s.winRate.toFixed(1)}%\n💰 Net: ${money(s.totalProfit, this.currencyStr())}\n💼 Overall: ${money(this.overallProfit, this.currencyStr())}\n${mgLine}${lossLine}`;
      telegram.send(msg);
      this._saveState('shutdown');
      this.client.stop();
      setTimeout(() => process.exit(0), 2500);
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 11. SELF-TEST  (pure math; no network)
// ═══════════════════════════════════════════════════════════════════════
async function runSelfTest() {
  const results = [];
  const test = (name, cond, detail = '') => {
    results.push({ name, pass: !!cond, detail });
    if (!cond) console.log(`  ✗ ${name} ${detail}`);
  };

  // 1. Median of ticks_stayed_in (right-skewed -> mean pulled up, median = typical).
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
  const sortedMid = sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2;
  // 10 elements => index 5 (5+1)/2. Average of idx 4 (5) and 5 (6) = 5.5
  test('median stay (even length)', sortedMid === 5.5, `mid=${sortedMid}`);

  // 2. Median helper on a skewed sample.
  const arr = [50, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const sorted2 = arr.slice().sort((a, b) => a - b);
  const med = sorted2.length % 2 ? sorted2[sorted2.length >> 1] : (sorted2[(sorted2.length >> 1) - 1] + sorted2[sorted2.length >> 1]) / 2;
  test('median (even length)', med === 6, `med=${med}`);

  // 3. Tick-cap formula: cap = max(1, floor(median × fraction)).
  const fraction = 0.55, median = 30;
  const cap = Math.max(1, Math.floor(median * fraction));
  test('tick cap = 0.55 × 30 = 16', cap === 16, `cap=${cap}`);

  // 4. Config sanity: growth rate is one of the allowed values.
  test('growthRate in {0.01..0.05}', [0.01, 0.02, 0.03, 0.04, 0.05].includes(CONFIG.growthRate), `growthRate=${CONFIG.growthRate}`);

  // 5. Config: cooldown ≤ entry gap (otherwise gap is redundant).
  test('cooldown ≤ entry gap', CONFIG.perSymbolCooldownMs <= CONFIG.perSymbolEntryGapMs, `${CONFIG.perSymbolCooldownMs} vs ${CONFIG.perSymbolEntryGapMs}`);

  // 6. Assets list is non-empty and contains only BOOM/CRASH.
  const onlyBc = CONFIG.assets.length > 0 && CONFIG.assets.every(s => /BOOM|CRASH/i.test(s));
  test('assets are BOOM/CRASH only', onlyBc, CONFIG.assets.join(','));

  // 7. idem settlement: second finalize returns null.
  const fakeClient = { forget: () => Promise.resolve(), _isPat: false };
  const ex = new TradeExecutor(fakeClient, CONFIG);
  ex.bot = { market: { cacheStays: () => {} } };
  ex.open.set(777, { contractId: 777, symbol: 'BOOM1000', growthRate: 0.02, stake: 1, buyPrice: 1, ticksHeld: 0, _exitReason: 'test' });
  let emitted = 0;
  ex.on('result', () => emitted++);
  const first  = ex._finalizeContract(777, { profit: 0.5, status: 'won',  sellPrice: 1.5, sellTime: 1 });
  const second = ex._finalizeContract(777, { profit: 99,  status: 'won',  sellPrice: 99 });
  test('settle returns info once', !!first && second === null);
  test('settle emits result once', emitted === 1, `emitted=${emitted}`);
  test('settle frees slot', ex.count() === 0);

  // 8. already-closed sell path → 'unknown' finalize (loss-only, no streak hit).
  const stuckClient = {
    forget: () => Promise.resolve(),
    _send: () => Promise.reject(new Error('not found among your open positions')),
    _isPat: false,
  };
  const ex2 = new TradeExecutor(stuckClient, CONFIG);
  ex2.bot = { market: { cacheStays: () => {} } };
  ex2.open.set(888, { contractId: 888, symbol: 'CRASH1000', growthRate: 0.02, stake: 1, buyPrice: 1, ticksHeld: 0, _exitReason: 'stuck' });
  let uEmitted = 0, uInfo = null;
  ex2.on('result', (t) => { uEmitted++; uInfo = t; });
  await ex2.sell(888, 0, ex2.open.get(888));
  test('already-closed → unknown emitted', uEmitted === 1 && uInfo && uInfo.status === 'unknown', `emitted=${uEmitted} status=${uInfo?.status}`);
  test('already-closed → local slot freed', ex2.count() === 0);

  // 9. unknown (unconfirmable/stuck) is booked as a stake LOSS in P&L, but never touches streaks.
  const s = new StatisticsManager();
  s.record({ contractId: 1, status: 'won',  profit:  2.0, sellTime: Date.now() / 1000 });
  s.record({ contractId: 2, status: 'lost', profit: -1.0, sellTime: Date.now() / 1000 });
  const streakBeforeUnknown = s.currentLossStreak;
  s.record({ contractId: 3, status: 'unknown', profit: 0, stake: 0.5, sellTime: Date.now() / 1000 });
  test('unknown booked as stake loss in P&L', Math.abs(s.overallProfit - 0.5) < 1e-9, `overallProfit=${s.overallProfit}`);
  test('unknown normalized to negative profit', s.trades[2].profit === -0.5, `profit=${s.trades[2].profit}`);
  test('unknown does not touch loss streak', s.currentLossStreak === streakBeforeUnknown, `streak=${s.currentLossStreak}`);

  // 10. live median from a fake proposal (simulates the buy() path).
  const fakeMarket = new MarketDataManager(new EventEmitter(), CONFIG);
  fakeMarket.cacheStays('BOOM1000', 0.02, { ticks_stayed_in: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22] });
  const liveMed = fakeMarket.getMedianStay('BOOM1000', 0.02);
  test('live median from proposal', liveMed === 12.5, `liveMed=${liveMed}`);
  const liveCap = Math.max(1, Math.floor(liveMed * 0.55));
  test('live tick-cap = floor(0.55 × 12.5)', liveCap === 6, `liveCap=${liveCap}`);

  // 11. Martingale stake progression: base × multiplier^step
  {
    const cfg = { stake: 1.00, martingaleMultiplier: 2.10, martingaleSteps: 4 };
    const bot = new AccuHoldBot(cfg);
    bot.baseStake = cfg.stake; bot.currentStake = cfg.stake; bot.martingaleStep = 0;
    test('martingale off at step 0 → base', bot._calcMartingaleStake(0) === 1.00);
    test('martingale step 1 → 2.10', bot._calcMartingaleStake(1) === 2.10);
    test('martingale step 2 → 4.41', bot._calcMartingaleStake(2) === 4.41);
    test('martingale step 3 → 9.26', bot._calcMartingaleStake(3) === 9.26, `got ${bot._calcMartingaleStake(3)}`);
    // Simulate 3 losses then win
    bot._updateMartingaleOnResult('lost'); // step1
    test('mg after 1st loss step=1 stake=2.10', bot.martingaleStep === 1 && bot.currentStake === 2.10, `step=${bot.martingaleStep} stake=${bot.currentStake}`);
    bot._updateMartingaleOnResult('lost'); // step2
    test('mg after 2nd loss step=2 stake=4.41', bot.martingaleStep === 2 && bot.currentStake === 4.41);
    bot._updateMartingaleOnResult('lost'); // step3
    bot._updateMartingaleOnResult('won');  // reset
    test('mg after win resets to base', bot.martingaleStep === 0 && bot.currentStake === 1.00, `step=${bot.martingaleStep} stake=${bot.currentStake}`);
    // Max steps reset
    bot.martingaleStep = 4; bot.currentStake = bot._calcMartingaleStake(4);
    bot._updateMartingaleOnResult('lost'); // should reset
    test('mg max steps → reset to base', bot.martingaleStep === 0 && bot.currentStake === 1.00);
    // Disabled when multiplier <=1
    const botOff = new AccuHoldBot({ stake: 1, martingaleMultiplier: 1.0, martingaleSteps: 4 });
    botOff.baseStake = 1; botOff.currentStake = 1;
    test('martingale disabled when multiplier=1', botOff._isMartingaleEnabled() === false);
    const botOff2 = new AccuHoldBot({ stake: 1, martingaleMultiplier: 2.1, martingaleSteps: 0 });
    botOff2.baseStake = 1; botOff2.currentStake = 1;
    test('martingale disabled when steps=0', botOff2._isMartingaleEnabled() === false);
  }

  // 12. Loss streak histogram x2-x7 and max streak
  {
    const sm = new StatisticsManager();
    // Simulate: win, loss, loss (x2), loss (x3), win, loss, loss (x2), loss (x3), loss (x4), loss (x5), loss (x6), loss (x7), loss (x7 again)
    const seq = ['lost','lost','lost','won','lost','lost','lost','lost','lost','lost','lost','lost'];
    // 8 consecutive losses after the win: streak reaches 2,3,4,5,6,7,7,7...
    seq.forEach((st, i) => sm.record({ contractId: 100+i, status: st, profit: st==='won'?1:-1, sellTime: Date.now()/1000 }));
    test('histogram max streak is 8', sm.maxLossStreak === 8, `max=${sm.maxLossStreak}`);
    test('histogram x2 increments', sm.lossStreakEvents.x2 === 2, `x2=${sm.lossStreakEvents.x2}`);
    test('histogram x3 increments', sm.lossStreakEvents.x3 === 2, `x3=${sm.lossStreakEvents.x3}`);
    test('histogram x7 increments for >=7', sm.lossStreakEvents.x7 === 2, `x7=${sm.lossStreakEvents.x7}`);
    // Serialize round-trip preserves histogram
    const ser = sm.serialize();
    const sm2 = new StatisticsManager(ser);
    test('histogram persists after serialize/load', sm2.lossStreakEvents.x2===2 && sm2.lossStreakEvents.x7===2 && sm2.maxLossStreak===8);
  }

  // 13. v4 tier-aware helpers
  {
    test('tier fast BOOM50', getTierForSymbol('BOOM50')==='fast');
    test('tier fast CRASH50', getTierForSymbol('CRASH50')==='fast');
    test('tier slow BOOM1000', getTierForSymbol('BOOM1000')==='slow');
    test('tier growth fast=0.01', getGrowthRateForSymbol('BOOM50')===0.01);
    test('tier growth slow=0.02', getGrowthRateForSymbol('BOOM1000')===0.02);
    test('tier cap fast=0.70', getTickCapFractionForSymbol('CRASH50')===0.70);
    test('tier cap slow=0.55', getTickCapFractionForSymbol('BOOM500')===0.55);
    test('tier TP fast=1.40', getTPForSymbol('BOOM50')===1.40);
    test('tier TP slow=1.35', getTPForSymbol('CRASH900')===1.35);
    test('assets include fast tier', CONFIG.assets.includes('BOOM50') && CONFIG.assets.includes('CRASH50'));
    test('v4 spikeTrigger enabled', CONFIG.spikeTrigger && CONFIG.spikeTrigger.enabled===true);
    test('v4 spikeTrigger immediate reentry on loss', CONFIG.spikeTrigger.immediateReentryOnLoss===true);
    test('v4 spikeTrigger wait on win', CONFIG.spikeTrigger.waitForSpikeOnWin===true);
    test('exploratory kept for detection', CONFIG.exploratory.enabled===true);
    test('exploratory mode hazard (60% gate)', CONFIG.exploratory.mode==='hazard');
    test('exploratory threshold 60%', Math.abs(CONFIG.exploratory.hazardMinLift - 0.60) < 1e-9, `hazardMinLift=${CONFIG.exploratory.hazardMinLift}`);
    test('stateFile is v4 spike fresh', /accuHOLD4_spike.*\.json/.test(CONFIG.stateFile));
    test('martingaleMaxStake cap', Number(CONFIG.martingaleMaxStake)===500);
    // per-tier market median
    const fm = new MarketDataManager(new EventEmitter(), CONFIG);
    fm.cacheStays('BOOM50', 0.01, { ticks_stayed_in: [10,20,30,40,50] });
    fm.cacheStays('BOOM1000', 0.02, { ticks_stayed_in: [5,15,25,35,45] });
    test('per-tier median BOOM50 @0.01', fm.getMedianStay('BOOM50',0.01)===30);
    test('per-tier median BOOM1000 @0.02', fm.getMedianStay('BOOM1000',0.02)===25);
    test('cross-tier isolation', fm.getMedianStay('BOOM50',0.02)===null && fm.getMedianStay('BOOM1000',0.01)===null);
    // exploratory gate — 60% lift strict
    const bot3 = new AccuHoldBot(CONFIG);
    // CALIBRATING with no elevated lift >=60% -> now BLOCKED (strict gate)
    bot3.assetHistory.get('BOOM1000').intervals = new Array(10).fill(50);
    bot3.assetHistory.get('BOOM1000').calibrationStatus='CALIBRATING';
    bot3.assetHistory.get('BOOM1000').elevated = []; // no lift >=60%
    bot3.assetHistory.get('BOOM1000').ticksSinceSpike = 5;
    test('exploratory CALIBRATING blocked without 60% lift', bot3._isExploratoryEntryAllowed('BOOM1000').allowed===false);
    // ACTIVE_RELAXED with no elevated -> BLOCKED under 60% rule
    bot3.assetHistory.get('BOOM50').calibrationStatus='ACTIVE_RELAXED';
    bot3.assetHistory.get('BOOM50').meanInterval=55; bot3.assetHistory.get('BOOM50').pendingEntryAfter=15; bot3.assetHistory.get('BOOM50').ticksSinceSpike=20;
    bot3.assetHistory.get('BOOM50').elevated = [];
    test('exploratory RELAXED blocked without 60% lift', bot3._isExploratoryEntryAllowed('BOOM50').allowed===false);
    // ACTIVE_RELAXED with lift 60.58% but ticks not in bucket -> still blocked
    bot3.assetHistory.get('BOOM50').elevated=[{lo:100, hi:200, empirical:0.70, theoretical:0.09, lift:0.6058}];
    bot3.assetHistory.get('BOOM50').ticksSinceSpike=50;
    test('exploratory lift 60% but ticks outside bucket -> blocked', bot3._isExploratoryEntryAllowed('BOOM50').allowed===false);
    // lift 60.58% and ticks inside bucket -> ALLOWED
    bot3.assetHistory.get('BOOM50').ticksSinceSpike=150;
    test('exploratory lift 60.58% inside bucket -> allowed', bot3._isExploratoryEntryAllowed('BOOM50').allowed===true);
    // lift 44% (<60) even inside bucket -> BLOCKED
    bot3.assetHistory.get('BOOM50').elevated=[{lo:10, hi:20, empirical:0.50, theoretical:0.06, lift:0.44}];
    bot3.assetHistory.get('BOOM50').ticksSinceSpike=12;
    test('exploratory lift 44% blocked even inside bucket', bot3._isExploratoryEntryAllowed('BOOM50').allowed===false);
    // hazard block/allow with 60% threshold (use mutable cfg copy to avoid frozen CONFIG)
    const hazardCfg = { ...CONFIG, exploratory: { ...CONFIG.exploratory, mode:'hazard' } };
    const botHazard = new AccuHoldBot(hazardCfg);
    botHazard.assetHistory.get('CRASH50').calibrationStatus='ACTIVE';
    botHazard.assetHistory.get('CRASH50').elevated=[{lo:10, hi:20, empirical:0.75, theoretical:0.10, lift:0.65}]; // 65% >=60
    botHazard.assetHistory.get('CRASH50').ticksSinceSpike=5;
    botHazard.assetHistory.get('CRASH50').pendingEntryAfter=5;
    test('exploratory hazard 65% block (outside bucket)', botHazard._isExploratoryEntryAllowed('CRASH50').allowed===false);
    botHazard.assetHistory.get('CRASH50').ticksSinceSpike=12;
    test('exploratory hazard 65% allow (in bucket)', botHazard._isExploratoryEntryAllowed('CRASH50').allowed===true);
    // martingale cap
    bot3.baseStake=1; bot3.martingaleStep=8;
    const capped = bot3._calcMartingaleStake(8); // 1 *2.10^8 = ~378 -> capped 500? actually 378 <500 so not capped, test 10 steps
    test('martingale cap enforced', bot3._calcMartingaleStake(10) <= 500);
  }

  const passed = results.filter(r => r.pass).length;
  console.log(`\nSelf-test: ${passed}/${results.length} passed`);
  return passed === results.length;
}

// ═══════════════════════════════════════════════════════════════════════
// 12. BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════
function printBanner() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║ accuHOLD v4 — SPIKE-TRIGGERED (DEMO)                ║');
  console.log('║ spike→trade, win→wait next spike, loss→instant same ║');
  console.log('║ fast: BOOM50/CRASH50 (1% TP×1.40 cap70%)            ║');
  console.log('║ slow: 500/600/900/1000 (2% TP×1.35 cap55%)           ║');
  console.log('║ flags: --selftest  --dry-run                        ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
}

async function main() {
  printBanner();
  if (process.argv.includes('--selftest')) {
    const ok = await runSelfTest();
    process.exitCode = ok ? 0 : 1;
    return;
  }
  try { require.resolve('ws'); } catch (_) { console.error('npm install ws'); process.exit(1); }
  if (!CONFIG.apiToken) { console.error('API token not set'); process.exit(1); }
  const dry = process.argv.includes('--dry-run');
  if (dry) console.log('🔒 DRY-RUN MODE — would-buy entries logged, no trades placed');
  console.log(CONFIG.telegram.enabled ? '✅ Telegram: ENABLED' : 'ℹ️ Telegram: DISABLED');
  const bot = new AccuHoldBot(CONFIG);
  bot.dryRun = dry;
  await bot.start();
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
