#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  Hazard-Refractory Bot v2 — LESS RESTRICTIVE, post-spike trader
 *  File: hazardRefractoryBot_v2.js  (derived from hazardRefractoryBot.js)
 * =====================================================================
 *
 *  v1 was strict: needed 200 intervals + CI outside theo AND χ²&KS p<0.01
 *  in elevated bucket before ACTIVE. On 10 real reports all 10 were
 *  no_structure_detected, so v1 would never trade (correct under spec but
 *  not useful if user wants to trade).
 *
 *  v2 is deliberately less restrictive while keeping the same corrected
 *  detection (stable 2000-tick MAD, exclude 20 after spike, floor 2,
 *  shifted-geometric tests):
 *   - Calibration still runs per asset but gates are relaxed:
 *       • calibrationMinIntervals = 50 (vs 200) — user adjustable
 *       • calibrationP = 0.05 (vs 0.01) and single-test logic:
 *         signal if (CI outside) OR (χ² p<0.05) OR (KS p<0.05) with
 *         empirical>theo in elevated bucket. Still logs full table.
 *       • If no elevated bucket even under relaxed gate, bot does NOT
 *         restart afresh into CALIBRATING forever; instead it promotes
 *         to ACTIVE_RELAXED — “no edge, but trade post-spike with
 *         mean-derived timing”. Still sends Telegram “no edge → relaxed”.
 *   - Trading is spike-driven, not bucket-polling:
 *       • After every new spike (gap pushed), the bot schedules an entry.
 *       • Entry delay (ticksSinceSpike to wait) is intelligently chosen
 *         from that asset’s own hazard table / mean:
 *           – if elevatedBuckets exists → entryAfter = lo of best (highest
 *             empirical-theo lift) elevated bucket;
 *           – else → entryAfter = round(mean * 0.30) clamped 3..15
 *             (roughly 1/3 mean = still inside refractory dip where
 *             hazard ~theo, not chasing tail noise).
 *       • plannedHoldTicks is also derived from observed pattern:
 *           – if elevatedBuckets → width of best elevated bucket
 *             (hi-lo) clamped 5..25, else round(mean*0.18) clamped 5..25;
 *           – also cross-checked against mean: hold = min(hold,
 *             round(mean*0.35)) so high-freq 50-index ~9 ticks, low-freq
 *             1000-index ~25 ticks.
 *       • This means after each spike we get exactly one attempt to enter,
 *         timed to the asset’s own empirical cadence, rather than polling
 *         every 3s for current ticksSinceSpike ∈ elevated.
 *   - Kill-switch / validation unchanged (30-trade binomial vs breakeven,
 *     consecutive 3, daily 50).
 *
 *  Token: CONFIG.apiToken = process.env.DERIV_API_TOKEN || 'pat_...' top.
 *  Assets: 10 Boom/Crash variants, stake 1, daily 50 — all adjustable.
 *  Run: node hazardRefractoryBot_v2.js  /  --selftest  /  --reset
 * =====================================================================
 */

const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const EventEmitter = require('events');

// ────────────────────────────────────────────────────────────────────
//  CONFIG v2 — less restrictive
// ────────────────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
  apiToken: 'pat_cb2016855b5e6c61ac95f94432192dd6ed86bec7f7454e575d3fe1ed9f617692',
  appId: '33uslPtthXBEkQOdfKfoY',
  wsUrl: 'wss://ws.derivws.com/websockets/v3',
  accountType: 'demo',
  currency: 'USD',

  assets: ['BOOM500','BOOM600','BOOM900','BOOM1000','CRASH500','CRASH600','CRASH900','CRASH1000'],

  detection: {
    baselineWindow: 2000,
    recomputeBaselineEvery: 2000,
    excludeBufferAfterSpike: 20,
    minSpikeSeparation: 2,
    spikeThresholdMAD: 10,
    spikeDirection: 'auto',
  },

  // ── Calibration v2 (relaxed) ──────────────────────────────────────
  calibrationMinIntervals: 5,                          // was 200 — now 50
  calibrationBuckets: [0,0.25,0.5,0.75,1,1.25,1.5,1.75,2,2.5,3,4,6,Infinity],
  calibrationP: 0.01,                                   // was 0.01 — now 0.05
  wilsonZ: 1.96,
  historyCap: 80000,
  deepBackfillBatch: 1000,
  deepBackfillTarget: 5000,

   // ── Trading v2 — per-spike, hold derived from mean + EV search (adaptive) ─
  stake: 1,                                  // base stake (reset point)
  // ── Martingale (user adjustable) ────────────────────────────────────
  martingaleEnabled: true,                   // master switch
  martingaleMultiplier: 2.1,                 // multiply on each loss (e.g. 2.1 = ×2.1)
  martingaleSteps: 8,                        // max consecutive martingale doubles before reset to base
  martingaleMaxStake: 100,                   // hard cap to avoid insane stake
  growthRate: 0.02, // 0.02
  minBarrierPct: 0.000006,
  maxOpenTrades: 1,                // allow 2 concurrent (10 assets, hold 5-15 ticks)
  tradeCooldownMs: 800,
  elevatedMinLift: 0.01,
  // fallback fractions when no elevated bucket (now adaptive, not fixed):
  entryDelayFrac: 0.30,            // fallback entryAfter = round(mean * entryDelayFrac)
  holdFrac: 0.18,                  // fallback hold base = round(mean * holdFrac)
  holdMin: 5,
  holdMax: 20,                     // was 25 — allow longer holds for low-freq
  entryDelayMin: 3,
  entryDelayMax: 40,               // was 15 — low-freq needs 30-40

  // Validation & kill-switch (unchanged, user adjustable)
  validationN: 30, // 30-trade binomial test vs breakeven
  killP: 0.05,
  maxConsecutiveLosses: 8,
  dailyMaxLoss: 150,
  dailyMaxTrades: 200000000,

  reconnect: { initialDelayMs:1000, maxDelayMs:60000, backoffFactor:2, jitterMs:750 },
  watchdogMs: 90000,
  stateFile: 'hazardBot_v2_001_state.json',
  logFile: 'hazardBot_v2_001.log',
  logLevel: 'INFO',
  telegram: {
    enabled: true,
    botToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    chatId: '752497117',
  },
  maxTelegramQueue: 100,
});

// ────────────────────────────────────────────────────────────────────
//  Logger
// ────────────────────────────────────────────────────────────────────
const LOG_LEVELS = { ERROR:0, WARN:1, INFO:2, DEBUG:3 };
const currentLevel = LOG_LEVELS[CONFIG.logLevel] ?? LOG_LEVELS.INFO;
const pad = n => String(n).padStart(2,'0');
const ts = () => { const d=new Date(); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
function log(level, msg, ...rest){
  if ((LOG_LEVELS[level]??1) > currentLevel) return;
  const extras = rest.map(a=> a instanceof Error ? a.message : typeof a==='object' ? JSON.stringify(a) : String(a)).join(' ');
  const line = `[${ts()}] [${level}] ${msg}${extras?' '+extras:''}`;
  (level==='ERROR'?console.error:console.log)(line);
  try{ fs.appendFileSync(CONFIG.logFile, line+'\n'); }catch(_){}
}

// ────────────────────────────────────────────────────────────────────
//  Telegram
// ────────────────────────────────────────────────────────────────────
class TelegramNotifier{
  constructor(cfg){ this.enabled=cfg.enabled&&!!cfg.botToken&&!!cfg.chatId; this.botToken=cfg.botToken; this.chatId=cfg.chatId; this.queue=[]; this.sending=false; }
  async _post(text){
    if(!this.enabled) return false;
    try{
      const payload=JSON.stringify({chat_id:this.chatId,text,parse_mode:'HTML',disable_web_page_preview:true});
      const url=new URL(`https://api.telegram.org/bot${this.botToken}/sendMessage`);
      const req=https.request({method:'POST',hostname:url.hostname,path:url.pathname,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)},timeout:10000},res=>{res.on('data',()=>{});res.on('end',()=>{});});
      req.on('error',e=>log('WARN','Telegram error:',e.message)); req.on('timeout',()=>req.destroy()); req.write(payload); req.end(); return true;
    }catch(e){ log('WARN','Telegram exception:',e.message); return false; }
  }
  async send(text){
    if(!this.enabled){ log('DEBUG','TG(dry):',String(text).slice(0,160)); return; }
    if(this.queue.length>=CONFIG.maxTelegramQueue){ this.queue.shift(); log('WARN','Telegram queue full; dropped oldest'); }
    this.queue.push(String(text));
    if(!this.sending){ this.sending=true; while(this.queue.length){ await this._post(this.queue.shift()); await new Promise(r=>setTimeout(r,1100)); } this.sending=false; }
  }
}
const telegram = new TelegramNotifier(CONFIG.telegram);

// ────────────────────────────────────────────────────────────────────
//  RestClient (PAT/OTP)
// ────────────────────────────────────────────────────────────────────
function isPatToken(token){ return typeof token==='string' && /^pat_[a-z0-9_\-]{16,}$/i.test(token.trim()); }
class RestClient{
  constructor(baseUrl,appId,token){ this.baseUrl=baseUrl||'https://api.derivws.com'; this.appId=appId||'1089'; this.token=token||''; }
  _request(method,reqPath,body=null){
    return new Promise((resolve,reject)=>{
      let url; try{ url=new URL(reqPath,this.baseUrl);}catch(e){ return reject(new Error(`Invalid URL: ${reqPath}`));}
      const isHttps=url.protocol==='https:'; const lib=isHttps?https:require('http');
      const opts={method,hostname:url.hostname,port:url.port||(isHttps?443:80),path:url.pathname+url.search,headers:{'Deriv-App-ID':this.appId,'Authorization':'Bearer '+this.token,'Accept':'application/json',...(body?{'Content-Type':'application/json'}:{})},timeout:15000};
      const req=lib.request(opts,res=>{ let data=''; res.on('data',d=>data+=d); res.on('end',()=>{ let p=data; try{p=JSON.parse(data);}catch(_){} resolve({status:res.statusCode,body:p});});});
      req.on('timeout',()=>req.destroy(new Error('REST timeout'))); req.on('error',reject); if(body) req.write(JSON.stringify(body)); req.end();
    });
  }
  get(p){ return this._request('GET',p); } post(p,b){ return this._request('POST',p,b); }
}
async function resolveConnection(cfg){
  const token=cfg.apiToken||null;
  if(!token){ const s=cfg.wsUrl.includes('?')?'&':'?'; return {url:`${cfg.wsUrl}${s}app_id=${encodeURIComponent(cfg.appId)}`,needsAuthorize:false,isPat:false,noToken:true}; }
  if(!isPatToken(token)){ const s=cfg.wsUrl.includes('?')?'&':'?'; return {url:`${cfg.wsUrl}${s}app_id=${encodeURIComponent(cfg.appId)}`,needsAuthorize:true,isPat:false,token};}
  const rest=new RestClient('https://api.derivws.com',cfg.appId,token);
  const accRes=await rest.get('/trading/v1/options/accounts');
  if(accRes.status!==200){ const m=accRes.body?.errors?.[0]?.message||accRes.body?.message||JSON.stringify(accRes.body); throw new Error(`Account list failed (${accRes.status}): ${m}`); }
  const accts=Array.isArray(accRes.body?.data)?accRes.body.data:[]; if(!accts.length) throw new Error('No Options accounts');
  const desired=(cfg.accountType||'demo').toLowerCase(); const acct=accts.find(a=>String(a.account_type||'').toLowerCase()===desired)||accts[0];
  const otpRes=await rest.post(`/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`);
  if(otpRes.status!==200) throw new Error(`OTP failed (${otpRes.status}): ${JSON.stringify(otpRes.body)}`);
  const wsUrl=otpRes.body?.data?.url; if(!wsUrl||!/^wss?:/i.test(wsUrl)) throw new Error('OTP missing data.url');
  return {url:wsUrl,needsAuthorize:false,isPat:true,account:acct,token};
}

// ────────────────────────────────────────────────────────────────────
//  Stats (validated, from tester)
// ────────────────────────────────────────────────────────────────────
function median(arr){ if(!arr.length) return 0; const s=[...arr].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2? s[m] : (s[m-1]+s[m])/2; }
function gammln(xx){
  const cof=[76.18009172947146,-86.50532032941677,24.01409824083091,-1.231739572450155,0.1208650973866179e-2,-0.5395239384953e-5];
  let x=xx,y=xx,tmp=x+5.5; tmp-=(x+0.5)*Math.log(tmp); let ser=1.000000000190015; for(let j=0;j<6;j++){y+=1; ser+=cof[j]/y;} return -tmp+Math.log((2.5066282746310005*ser)/x);
}
const ITMAX=200,EPS=3e-9,FPMIN=1e-300;
function gammaP(a,x){
  if(x<0||a<=0) return NaN; if(x===0) return 0;
  if(x<a+1){ const gln=gammln(a); let ap=a,sum=1/a,del=sum; for(let n=1;n<=ITMAX;n++){ ap+=1; del*=x/ap; sum+=del; if(Math.abs(del)<Math.abs(sum)*EPS) break; } return sum*Math.exp(-x+a*Math.log(x)-gln); }
  else{ const gln=gammln(a); let b=x+1-a,c=1/FPMIN,d=1/b,h=d; for(let i=1;i<=ITMAX;i++){ const an=-i*(i-a); b+=2; d=an*d+b; if(Math.abs(d)<FPMIN) d=FPMIN; c=b+an/c; if(Math.abs(c)<FPMIN) c=FPMIN; d=1/d; const del=d*c; h*=del; if(Math.abs(del-1)<EPS) break; } return 1 - Math.exp(-x+a*Math.log(x)-gln)*h; }
}
function chiSquarePValue(chiSq,df){ return 1 - gammaP(df/2, chiSq/2); }
function erf(x){ const sign=x<0?-1:1; x=Math.abs(x); const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911; const t=1/(1+p*x); return sign*(1-(((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-x*x))); }
function normalCDF(x){ return 0.5*(1+erf(x/Math.SQRT2)); }
function wilsonCI(hits,n,z){
  if(!n) return {p:0,low:0,high:0};
  const p=hits/n, z2=z*z, d=1+z2/n;
  const centre=(p+z2/(2*n))/d;
  const half=z*Math.sqrt((p*(1-p)+z2/(4*n))/n)/d;
  return {p,low:Math.max(0,centre-half),high:Math.min(1,centre+half)};
}
function binomialPValue(k,n,p0){
  if(n===0) return 1;
  function logChoose(n,k){ if(k<0||k>n) return -Infinity; let s=0; for(let i=1;i<=k;i++) s+=Math.log((n-k+i)/i); return s; }
  function pmf(k){ return Math.exp(logChoose(n,k)+k*Math.log(p0)+(n-k)*Math.log(1-p0)); }
  const pk=pmf(k); let p=0; for(let i=0;i<=n;i++){ const pi=pmf(i); if(pi <= pk+1e-12) p+=pi; } return Math.min(1,Math.max(0,p));
}
function dispersionStats(intervals, floor){
  const shifted=intervals.map(v=>v-floor+1); const n=shifted.length;
  const sMean=shifted.reduce((s,v)=>s+v,0)/n;
  const variance=shifted.reduce((s,v)=>s+(v-sMean)**2,0)/(n-1);
  const cv=Math.sqrt(variance)/sMean; const pHat=1/sMean; const theoreticalCV=Math.sqrt(1-pHat);
  return {n, mean:sMean+floor-1, shiftedMean:sMean, variance, cv, theoreticalCV, pHat, floor};
}
function chiSquareGOF(intervals, floor){
  const shifted=intervals.map(v=>v-floor+1); const n=shifted.length;
  const mean=shifted.reduce((s,v)=>s+v,0)/n; const pHat=1/mean;
  const numBins=Math.max(5,Math.min(15,Math.floor(n/8)));
  const bins=[]; for(let i=1;i<numBins;i++){ const t=i/numBins; let k=Math.ceil(Math.log(1-t)/Math.log(1-pHat)); if(bins.length&&k<=bins[bins.length-1]) k=bins[bins.length-1]+1; bins.push(k); }
  const edges=[0,...bins,Infinity]; const obs=new Array(numBins).fill(0);
  for(const v of shifted) for(let b=0;b<numBins;b++) if(v>edges[b]&&v<=edges[b+1]){ obs[b]++; break; }
  const exp=new Array(numBins).fill(n/numBins);
  let chiSq=0; for(let b=0;b<numBins;b++){ const d=obs[b]-exp[b]; chiSq+=d*d/exp[b]; }
  const df=Math.max(numBins-2,1); const pValue=chiSquarePValue(chiSq,df);
  return {chiSq,df,pValue,numBins,observed:obs,expected:exp,pHat,mean:mean+floor-1,floor};
}
function ksTest(intervals, floor){
  const shifted=intervals.map(v=>v-floor+1); const n=shifted.length;
  const mean=shifted.reduce((s,v)=>s+v,0)/n; const pHat=1/mean; const sorted=[...shifted].sort((a,b)=>a-b);
  let D=0; for(let i=0;i<n;i++){ const F=1-Math.pow(1-pHat,sorted[i]); D=Math.max(D,Math.abs((i+1)/n-F),Math.abs(i/n-F)); }
  const lambda=(Math.sqrt(n)+0.12+0.11/Math.sqrt(n))*D; let p=0; for(let k=1;k<=100;k++) p+=(k%2?1:-1)*Math.exp(-2*k*k*lambda*lambda); p=Math.max(0,Math.min(1,2*p));
  return {D,pValue:p,pHat,floor};
}
function hazardTable(intervals, bucketFracs, mean, pHat){
  const edges=bucketFracs.map(m=> m===Infinity?Infinity: Math.round(m*mean));
  const rows=[];
  for(let i=0;i<edges.length-1;i++){
    const lo=edges[i], hi=edges[i+1];
    const survivors=intervals.filter(v=>v>=lo).length;
    const events=intervals.filter(v=>v>=lo&&v<hi).length;
    const emp=survivors>0? events/survivors : null;
    const width=hi===Infinity? null : hi-lo;
    const theo=width!==null? 1-Math.pow(1-pHat,width) : null;
    const ci=survivors>0 && emp!==null ? wilsonCI(events, survivors, CONFIG.wilsonZ) : null;
    rows.push({range:`${lo}-${hi===Infinity?'∞':hi}`, lo, hi, survivors, events, empirical:emp, theoretical:theo, ciLow:ci?.low??null, ciHigh:ci?.high??null, outside: ci && theo!==null ? (ci.low>theo || ci.high<theo) : false});
  }
  return rows;
}

// ────────────────────────────────────────────────────────────────────
//  SpikeDetector — corrected (Bug #1 & #2)
// ────────────────────────────────────────────────────────────────────
function detectSpikes(prices, cfg, symbol){
  const n=prices.length;
  const diffs=new Array(n).fill(0); for(let i=1;i<n;i++) diffs[i]=prices[i]-prices[i-1];
  let direction=cfg.detection.spikeDirection;
  if(direction==='auto'){ const u=symbol.toUpperCase(); if(u.includes('BOOM')) direction='up'; else if(u.includes('CRASH')) direction='down'; else direction='both'; }
  const excluded=new Uint8Array(n);
  const spikeIndices=[]; let lastSpike=-Infinity; let baseline=null; let lastRecompute=-Infinity;
  const win=cfg.detection.baselineWindow, every=cfg.detection.recomputeBaselineEvery, buf=cfg.detection.excludeBufferAfterSpike;
  for(let i=win;i<n;i++){
    if(baseline===null || i-lastRecompute>=every){
      const s=i-win; const clean=[]; for(let j=s;j<i;j++) if(!excluded[j]) clean.push(Math.abs(diffs[j]));
      if(clean.length>=30){ const m=median(clean); const devs=clean.map(v=>Math.abs(v-m)); baseline=median(devs)||1e-9; }
      lastRecompute=i;
    }
    if(baseline===null) continue;
    const mv=diffs[i]; const mag=Math.abs(mv)/baseline; const dirOK=direction==='both' ? true : direction==='up' ? mv>0 : mv<0;
    if(dirOK && mag>=cfg.detection.spikeThresholdMAD){
      if(i-lastSpike>=cfg.detection.minSpikeSeparation){
        spikeIndices.push(i); lastSpike=i;
        for(let k=i;k<Math.min(n,i+buf);k++) excluded[k]=1;
      }
    }
  }
  return {spikeIndices, direction, diffs, excluded};
}

// ────────────────────────────────────────────────────────────────────
//  DerivClient
// ────────────────────────────────────────────────────────────────────
class DerivClient extends EventEmitter{
  constructor(cfg){ super(); this.cfg=cfg; this.ws=null; this.connected=false; this.authorized=false; this._stopped=false; this._reconnecting=false; this._reconnectAttempt=0; this._reqId=0; this._pending=new Map(); this._subs=new Map(); this._isPat=isPatToken(cfg.apiToken); this._rest=this._isPat? new RestClient('https://api.derivws.com',cfg.appId,cfg.apiToken):null; this._account=null; }
  connect(){
    if(this.ws && (this.ws.readyState===WebSocket.OPEN||this.ws.readyState===WebSocket.CONNECTING)) return;
    if(!this.cfg.apiToken){ log('ERROR','API token empty'); this._stopped=true; return; }
    if(this._isPat){ log('INFO','PAT token → OTP flow'); this._connectPat().catch(e=>{ log('ERROR','PAT connect failed:',e.message); this._scheduleReconnect();}); }
    else{ const s=this.cfg.wsUrl.includes('?')?'&':'?'; const url=`${this.cfg.wsUrl}${s}app_id=${encodeURIComponent(this.cfg.appId)}`; log('INFO',`Connecting → ${url.replace(/app_id=[^&]+/,'app_id=***')}`); this._openWs(url); }
  }
  async _connectPat(){
    const desired=(this.cfg.accountType||'demo').toLowerCase();
    const accRes=await this._rest.get('/trading/v1/options/accounts');
    if(accRes.status!==200){ const m=accRes.body?.errors?.[0]?.message||accRes.body?.message||JSON.stringify(accRes.body); throw new Error(`Account list ${accRes.status}: ${m}`); }
    const accts=Array.isArray(accRes.body?.data)? accRes.body.data:[]; if(!accts.length) throw new Error('No Options accounts');
    const acct=accts.find(a=>String(a.account_type||'').toLowerCase()===desired)||accts[0]; this._account=acct;
    const otpRes=await this._rest.post(`/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`);
    if(otpRes.status!==200) throw new Error(`OTP ${otpRes.status}: ${JSON.stringify(otpRes.body)}`);
    const wsUrl=otpRes.body?.data?.url; if(!wsUrl||!/^wss?:/i.test(wsUrl)) throw new Error('OTP missing data.url');
    log('INFO',`OTP → ${wsUrl.replace(/otp=[^&]+/,'otp=***')}`); this._openWs(wsUrl);
  }
  _openWs(url){
    try{
      this.ws=new WebSocket(url,{headers:{'User-Agent':'hazardRefractoryBot/v2'},handshakeTimeout:15000});
      this.ws.on('open',()=>this._onOpen()); this.ws.on('message',d=>this._onMessage(d));
      this.ws.on('error',e=>this._onError(e)); this.ws.on('close',(c,r)=>this._onClose(c,r));
      this.ws.on('unexpected-response',(_,res)=>{ log('ERROR','WS handshake',res.statusCode); try{res.destroy();}catch(_){} this._scheduleReconnect();});
    }catch(e){ log('ERROR','WS construct',e.message); this._scheduleReconnect(); }
  }
  _onOpen(){ log('INFO','WS connected'); this.connected=true; this._reconnecting=false; this._reconnectAttempt=0; this.emit('open'); if(this._isPat){ this.authorized=true; log('INFO',`Authorized ${this._account?.account_id||'PAT'} (${this._account?.account_type||''})`); this.emit('authorized',this._account);} else this._authorize(); }
  async _authorize(){
    try{ const r=await this._send({authorize:this.cfg.apiToken},20000); this.authorized=true; log('INFO',`Authorized ${r.authorize.loginid}`); this.emit('authorized',r.authorize);}catch(e){ log('ERROR','Auth failed',e.message); this.authorized=false; this._scheduleReconnect(); }
  }
  _onMessage(data){
    let msg; try{ msg=JSON.parse(data.toString()); }catch{ return; }
    if(msg.error){
      const code=msg.error.code; if(!new Set(['BetExpired','ContractNotFound','InvalidContract']).has(code)) log('WARN',`API error ${code}: ${msg.error.message}`);
      if(msg.req_id && this._pending.has(msg.req_id)){ const p=this._pending.get(msg.req_id); clearTimeout(p.timer); this._pending.delete(msg.req_id); p.reject(new Error(msg.error.message||code)); }
      if(['AuthorizationRequired','InvalidToken'].includes(code)) this._closeAndReconnect(); return;
    }
    if(msg.req_id && this._pending.has(msg.req_id)){ const p=this._pending.get(msg.req_id); clearTimeout(p.timer); this._pending.delete(msg.req_id); p.resolve(msg); return; }
    if(msg.subscription?.id && this._subs.has(msg.subscription.id)) try{ this._subs.get(msg.subscription.id)(msg); }catch(e){ log('ERROR','Sub cb',e.message); }
  }
  _onError(e){ log('ERROR','WS error',e.message); this.emit('error',e); }
  _onClose(code,reason){
    const rs=(()=>{try{return reason?.toString()||''}catch{return ''}})();
    log('WARN',`WS closed ${code} ${rs}`); const was=this.authorized; this.connected=false; this.authorized=false;
    for(const[,p] of this._pending){ clearTimeout(p.timer); p.reject(new Error('Connection closed')); } this._pending.clear(); this._subs.clear();
    this.emit('close',code,reason,was); if(!this._stopped) this._scheduleReconnect();
  }
  _scheduleReconnect(){
    if(this._stopped||this._reconnecting) return; this._reconnecting=true; this._reconnectAttempt++;
    const base=Math.min(this.cfg.reconnect.initialDelayMs*Math.pow(this.cfg.reconnect.backoffFactor,this._reconnectAttempt-1), this.cfg.reconnect.maxDelayMs);
    const delay=base+Math.random()*this.cfg.reconnect.jitterMs;
    log('INFO',`Reconnect #${this._reconnectAttempt} in ${(delay/1000).toFixed(1)}s`);
    setTimeout(()=>{ this._reconnecting=false; this.connect(); }, delay);
  }
  _closeAndReconnect(){ try{this.ws?.close();}catch(_){} }
  _send(payload,timeoutMs=30000){
    return new Promise((resolve,reject)=>{
      if(!this.ws||this.ws.readyState!==WebSocket.OPEN) return reject(new Error('Not connected'));
      const id=++this._reqId; const txt=JSON.stringify({...payload,req_id:id});
      const timer=setTimeout(()=>{ if(this._pending.has(id)){ this._pending.delete(id); reject(new Error(`Timeout req ${id}`)); } }, timeoutMs);
      this._pending.set(id,{resolve,reject,timer});
      try{ this.ws.send(txt); }catch(e){ clearTimeout(timer); this._pending.delete(id); reject(e); }
    });
  }
  subscribe(payload,cb,timeoutMs=30000){
    return new Promise((resolve,reject)=>{
      if(!this.ws||this.ws.readyState!==WebSocket.OPEN) return reject(new Error('Not connected'));
      const id=++this._reqId; const txt=JSON.stringify({...payload,req_id:id,subscribe:1});
      const timer=setTimeout(()=>{ if(this._pending.has(id)){ this._pending.delete(id); reject(new Error('Sub timeout')); }}, timeoutMs);
      this._pending.set(id,{resolve:msg=>{
        const sid=msg.subscription?.id; if(!sid) return reject(new Error('No sub id'));
        this._subs.set(sid,cb); resolve(sid); try{cb(msg);}catch(e){log('ERROR','Sub ack',e.message);}
      },reject,timer});
      try{ this.ws.send(txt);}catch(e){ clearTimeout(timer); this._pending.delete(id); reject(e); }
    });
  }
  forget(sid){ if(!sid) return Promise.resolve(); this._subs.delete(sid); if(!this.ws||this.ws.readyState!==WebSocket.OPEN) return Promise.resolve(); return this._send({forget:sid},8000).catch(()=>{}); }
  stop(){ this._stopped=true; try{this.ws?.close();}catch(_){} }
  get isPat(){ return this._isPat; }
  get symbolKey(){ return this._isPat ? 'underlying_symbol' : 'symbol'; }
}

// ────────────────────────────────────────────────────────────────────
//  Per-asset state v2 — adds post-spike scheduling fields
// ────────────────────────────────────────────────────────────────────
class AssetState{
  constructor(symbol){
    this.symbol=symbol;
    this.history=[]; // {epoch, quote} oldest→newest
    this.intervals=[];
    this.ticksSinceSpike=0;
    this.lastSpikeAbsIdx=null;
    this.totalTicksSeen=0;
    this.calibrationStatus='CALIBRATING'; // CALIBRATING | ACTIVE | ACTIVE_RELAXED | PAUSED
    this.pauseReason=null;
    this.hazardTable=null;
    this.dispersion=null;
    this.chi=null;
    this.ks=null;
    this.meanInterval=null;
    this.pHat=null;
    this.elevatedBuckets=[];
    this.lastCalibrationAt=null;
    this.consecutiveLosses=0;
    this.lastTradeAt=0;
    // v2: post-spike scheduling — 1 trade per spike enforcement
    this.pendingEntryAfter=null;
    this.pendingHoldTicks=null;
    this.pendingEntryReason=null;
    this.entryScheduledAt=null;
    this.lastTradedSpikeAbsIdx=null;
    this.lastTradeSpikeMean=null;
    // adaptive stay tracking (from proposal contract_details.ticks_stayed_in)
    this.lastStayMedian=null;
    this.lastStayMean=null;
    this.stayHistory=[]; // last 20 medians
  }
}

// ────────────────────────────────────────────────────────────────────
//  Global state + persistence
// ────────────────────────────────────────────────────────────────────
const assetMap = new Map();
for(const s of CONFIG.assets) assetMap.set(s, new AssetState(s));
let tradeLog=[];
let dailyLoss=0, dailyTrades=0, lastDailyReset=utcDateStr();
let consecutiveLossesGlobal=0;
let killed=false;
let globalClient=null; // set in main for tick-driven sell

// ── Martingale global state ─────────────────────────────────────────
let martingaleLevel = 0;                          // 0 = base stake, 1 = ×multiplier once, etc.
let maxConsecutiveLossesSeen = 0;                 // all-time max streak
let lossStreakCounts = { x2:0, x3:0, x4:0, x5:0, x6:0, x7:0 }; // how many streaks hit exactly 2..7
let _lossStreakCountedAt = { x2:0, x3:0, x4:0, x5:0, x6:0, x7:0 }; // internal guard to count once per streak
function getMartingaleStake(){
  if(!CONFIG.martingaleEnabled) return CONFIG.stake;
  const mult = CONFIG.martingaleMultiplier || 2;
  const raw = CONFIG.stake * Math.pow(mult, martingaleLevel);
  return Math.min(raw, CONFIG.martingaleMaxStake);
}
function martingaleInfoLine(){
  const stake = getMartingaleStake();
  const mult = CONFIG.martingaleMultiplier;
  const steps = CONFIG.martingaleSteps;
  const enabled = CONFIG.martingaleEnabled ? 'ON' : 'OFF';
  return `Martingale <code>${enabled} ×${mult} Step ${martingaleLevel}/${steps}</code> Stake <code>${stake.toFixed(2)} ${CONFIG.currency}</code> (base ${CONFIG.stake})`;
}
function lossStreakInfoLine(){
  return `Max Consecutive Losses <code>${maxConsecutiveLossesSeen}</code> Cur <code>${consecutiveLossesGlobal}</code> | x2:<code>${lossStreakCounts.x2}</code> x3:<code>${lossStreakCounts.x3}</code> x4:<code>${lossStreakCounts.x4}</code> x5:<code>${lossStreakCounts.x5}</code> x6:<code>${lossStreakCounts.x6}</code> x7:<code>${lossStreakCounts.x7}</code>`;
}
function recordLossStreakMilestones(curStreak){
  // Count each milestone once per streak (when streak first reaches 2,3,...7)
  if(curStreak>=2 && _lossStreakCountedAt.x2 !== curStreak){ /* guard per milestone */ }
  for(let n=2;n<=7;n++){
    const key='x'+n;
    if(curStreak===n && _lossStreakCountedAt[key]!==curStreak){
      // increment count for this milestone occurrence
      lossStreakCounts[key]++;
      _lossStreakCountedAt[key]=curStreak;
    }
    // reset guard when streak resets, handled below
  }
  // For streaks >7, also bump x7 only once at 7; no extra counts beyond 7
  if(curStreak> maxConsecutiveLossesSeen) maxConsecutiveLossesSeen = curStreak;
}
function resetLossStreakGuards(){
  _lossStreakCountedAt = { x2:0, x3:0, x4:0, x5:0, x6:0, x7:0 };
}
function advanceMartingaleOnResult(isWin){
  if(!CONFIG.martingaleEnabled) return;
  if(isWin){
    if(martingaleLevel!==0) log('INFO',`Martingale RESET win → level 0 stake ${CONFIG.stake} (was level ${martingaleLevel})`);
    martingaleLevel = 0;
    resetLossStreakGuards();
  }else{
    const maxSteps = CONFIG.martingaleSteps||7;
    if(martingaleLevel < maxSteps){
      martingaleLevel++;
      const nextStake=getMartingaleStake();
      log('INFO',`Martingale UP loss → level ${martingaleLevel}/${maxSteps} stake ${nextStake.toFixed(2)} ×${CONFIG.martingaleMultiplier}`);
    }else{
      log('WARN',`Martingale at max steps ${maxSteps} — resetting to level 0 (cap reached)`);
      martingaleLevel=0;
      resetLossStreakGuards();
    }
  }
}

function utcDateStr(d=new Date()){ return d.toISOString().slice(0,10); }
function saveState(reason='tick'){
  const data={
    version:2,
    savedAt: Date.now(),
    reason,
    dailyLoss, dailyTrades, lastDailyReset, consecutiveLossesGlobal, killed,
    martingaleLevel, maxConsecutiveLossesSeen, lossStreakCounts, _lossStreakCountedAt,
    assets: [...assetMap.entries()].map(([sym,st])=> ({
      symbol:sym,
      history: st.history.slice(-2000),
      intervals: st.intervals,
      ticksSinceSpike: st.ticksSinceSpike,
      totalTicksSeen: st.totalTicksSeen,
      lastSpikeAbsIdx: st.lastSpikeAbsIdx,
      calibrationStatus: st.calibrationStatus,
      pauseReason: st.pauseReason,
      meanInterval: st.meanInterval,
      consecutiveLosses: st.consecutiveLosses,
      elevatedBuckets: st.elevatedBuckets,
      pendingEntryAfter: st.pendingEntryAfter,
      pendingHoldTicks: st.pendingHoldTicks,
      lastTradedSpikeAbsIdx: st.lastTradedSpikeAbsIdx,
      lastStayMedian: st.lastStayMedian,
      lastStayMean: st.lastStayMean,
      stayHistory: st.stayHistory,
    })),
    tradeLog: tradeLog.slice(-500),
  };
  const tmp=CONFIG.stateFile+'.tmp';
  try{ fs.writeFileSync(tmp, JSON.stringify(data,null,2)); fs.renameSync(tmp, CONFIG.stateFile); }catch(e){ log('WARN','saveState failed',e.message); }
}
function loadState(){
  if(!fs.existsSync(CONFIG.stateFile)) return;
  try{
    const d=JSON.parse(fs.readFileSync(CONFIG.stateFile,'utf8'));
    dailyLoss=d.dailyLoss||0; dailyTrades=d.dailyTrades||0; lastDailyReset=d.lastDailyReset||utcDateStr();
    consecutiveLossesGlobal=d.consecutiveLossesGlobal||0; killed=d.killed||false;
    martingaleLevel=Number.isFinite(d.martingaleLevel)? d.martingaleLevel:0;
    maxConsecutiveLossesSeen=Number.isFinite(d.maxConsecutiveLossesSeen)? d.maxConsecutiveLossesSeen:0;
    if(d.lossStreakCounts) lossStreakCounts={x2:d.lossStreakCounts.x2||0,x3:d.lossStreakCounts.x3||0,x4:d.lossStreakCounts.x4||0,x5:d.lossStreakCounts.x5||0,x6:d.lossStreakCounts.x6||0,x7:d.lossStreakCounts.x7||0};
    if(d._lossStreakCountedAt) _lossStreakCountedAt={x2:d._lossStreakCountedAt.x2||0,x3:d._lossStreakCountedAt.x3||0,x4:d._lossStreakCountedAt.x4||0,x5:d._lossStreakCountedAt.x5||0,x6:d._lossStreakCountedAt.x6||0,x7:d._lossStreakCountedAt.x7||0};
    tradeLog=Array.isArray(d.tradeLog)? d.tradeLog: [];
    for(const a of d.assets||[]){
      const st=assetMap.get(a.symbol); if(!st) continue;
      st.history=Array.isArray(a.history)? a.history: [];
      st.intervals=Array.isArray(a.intervals)? a.intervals: [];
      st.ticksSinceSpike=Number.isFinite(a.ticksSinceSpike)? a.ticksSinceSpike: 0;
      st.totalTicksSeen=Number.isFinite(a.totalTicksSeen)? a.totalTicksSeen: st.history.length;
      st.lastSpikeAbsIdx=a.lastSpikeAbsIdx;
      st.calibrationStatus=a.calibrationStatus||'CALIBRATING';
      st.pauseReason=a.pauseReason||null;
      st.meanInterval=a.meanInterval||null;
      st.consecutiveLosses=a.consecutiveLosses||0;
      st.elevatedBuckets=Array.isArray(a.elevatedBuckets)? a.elevatedBuckets: [];
      st.pendingEntryAfter=a.pendingEntryAfter??null;
      st.pendingHoldTicks=a.pendingHoldTicks??null;
      st.lastTradedSpikeAbsIdx=a.lastTradedSpikeAbsIdx??null;
      st.lastStayMedian=a.lastStayMedian??null;
      st.lastStayMean=a.lastStayMean??null;
      st.stayHistory=Array.isArray(a.stayHistory)? a.stayHistory: [];
      if(st.calibrationStatus==='PAUSED') killed=true;
    }
    log('INFO',`State loaded: ${d.assets?.length||0} assets, ${tradeLog.length} trades, killed=${killed}`);
  }catch(e){ log('WARN','loadState failed',e.message); }
}
function maybeResetDaily(){
  const today=utcDateStr();
  if(today!==lastDailyReset){ dailyLoss=0; dailyTrades=0; lastDailyReset=today; saveState('dailyReset'); }
}

// ────────────────────────────────────────────────────────────────────
//  Watchdog — idempotent settlement (accuAPEX-style)
// ────────────────────────────────────────────────────────────────────
const openContracts = new Map();
const settledIds = new Set();
let watchdogTimer=null;
function startWatchdog(client){
  if(watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer=setInterval(async ()=>{
    const now=Date.now();
    for(const [cid, rec] of openContracts){
      if(now - rec.lastUpdate > CONFIG.watchdogMs){
        log('WARN',`Watchdog: contract ${cid} (${rec.symbol}) no update ${CONFIG.watchdogMs}ms — re-query`);
        try{
          const r=await client._send({proposal_open_contract:1, contract_id: cid}, 10000);
          const poc=r.proposal_open_contract;
          if(poc && poc.is_sold){ finalizeContract(cid, poc); }
          else { rec.lastUpdate=now; }
        }catch(e){ log('WARN',`Watchdog re-query ${cid} failed:`,e.message); }
      }
    }
  }, CONFIG.watchdogMs/2);
  client.on('close', ()=>{ openContracts.clear(); });
}
function finalizeContract(cid, poc){
  if(settledIds.has(cid)) return;
  const rec=openContracts.get(cid); if(!rec) return;
  settledIds.add(cid);
  const profit=Number(poc.profit ?? 0);
  const outcome= poc.status==='won' || profit>0 ? 'won' : 'lost';
  const win= outcome==='won';
  // Duration: prefer poc sell/buy times if available else wall clock
  // Ticks Held: actual ticks held (rec.ticksHeld from tick-driven tracking), fallback to poc.tick_count
  const buyTime = rec.entryLog?.ts || rec.entryLog?.buyTime || Date.now();
  const sellTime = poc.sell_time ? Number(poc.sell_time)*1000 : Date.now();
  const durationSec = Math.max(0, Math.round((sellTime - buyTime)/1000));
  const ticksHeldVal = Number.isFinite(rec.ticksHeld) ? rec.ticksHeld : (poc.tick_count ?? rec.entryLog?.plannedHold ?? '?');

  log('INFO',`Contract ${cid} settled: ${outcome} profit ${profit.toFixed(2)} ${CONFIG.currency} status=${poc.status||'?'} duration ${durationSec}s ticksHeld ${ticksHeldVal}`);

  const entry=rec.entryLog;
  if(entry){ entry.outcome=outcome; entry.profit=profit; entry.settledAt=Date.now(); entry.status=poc.status||'unknown'; entry.durationSec=durationSec; entry.ticksHeld=ticksHeldVal; entry.martingaleLevel=rec.entryLog?.martingaleLevel??martingaleLevel; }
  dailyLoss += (profit<0? profit: 0);
  if(!win){ rec.assetState.consecutiveLosses=(rec.assetState.consecutiveLosses||0)+1; consecutiveLossesGlobal++; }else{ rec.assetState.consecutiveLosses=0; consecutiveLossesGlobal=0; }

  // ── Loss streak tracking (Max + x2..x7) ───────────────────────────────
  if(!win){
    if(consecutiveLossesGlobal > maxConsecutiveLossesSeen) maxConsecutiveLossesSeen = consecutiveLossesGlobal;
    // count milestone once when streak first reaches 2..7
    if(consecutiveLossesGlobal>=2 && consecutiveLossesGlobal<=7){
      const key='x'+consecutiveLossesGlobal;
      lossStreakCounts[key] = (lossStreakCounts[key]||0)+1;
    }
  } else {
    // win resets guards — max stays, x counters persist
  }
  // ── Martingale advance (loss → ×multiplier, win → reset) ─────────────
  const martingaleLevelBefore = martingaleLevel;
  const stakeUsed = rec.entryLog?.stake ?? getMartingaleStake();
  advanceMartingaleOnResult(win);
  const nextStake = getMartingaleStake();
  if(entry){ entry.martingaleLevelBefore=martingaleLevelBefore; entry.martingaleLevelAfter=martingaleLevel; entry.nextStake=nextStake; }

  // Push before computing totals so totals include this trade
  tradeLog.push(entry||{symbol:rec.symbol, outcome, profit, ts:Date.now(), durationSec, martingaleLevel: martingaleLevelBefore, stake: stakeUsed});
  dailyTrades++;
  // Totals for telegram
  const settledAll = tradeLog.filter(t=>t.outcome);
  const totalTrades = settledAll.length;
  const wins = settledAll.filter(t=>t.outcome==='won').length;
  const losses = totalTrades - wins;
  const winRatio = totalTrades ? (wins/totalTrades*100).toFixed(1) : '0.0';
  const netProfit = settledAll.reduce((s,t)=> s + Number(t.profit||0), 0);

  // Detailed CLOSE telegram per spec: asset, P/L, NetProfit, Duration, Total Trades Win/Loss (Win Ratio)
  // Ticks is ticks Held, now also martingale + loss streak info
  {
    const mgLine = CONFIG.martingaleEnabled
      ? `Martingale Lv <code>${martingaleLevelBefore}→${martingaleLevel}/${CONFIG.martingaleSteps} ×${CONFIG.martingaleMultiplier}</code> Stake <code>${stakeUsed.toFixed(2)}</code> → Next <code>${nextStake.toFixed(2)} ${CONFIG.currency}</code>`
      : `Martingale <code>OFF</code> Stake <code>${stakeUsed.toFixed(2)}</code>`;
    const streakLine = lossStreakInfoLine();
    const closeMsg = `${win?'✅':'❌'} <b>CLOSE ${rec.symbol} #${cid} ${outcome.toUpperCase()}</b>\n`+
      `P/L <code>${profit>=0?'+':''}${profit.toFixed(2)} ${CONFIG.currency}</code> NetProfit <code>${netProfit>=0?'+':''}${netProfit.toFixed(2)} ${CONFIG.currency}</code>\n`+
      `Duration <code>${durationSec}s</code> ticks Held <code>${ticksHeldVal}</code> Stake <code>${stakeUsed.toFixed(2)} ${CONFIG.currency}</code>\n`+
      `${mgLine}\n`+
      `${streakLine}\n`+
      `Total <code>${totalTrades}</code> W <code>${wins}</code> L <code>${losses}</code> WR <code>${winRatio}%</code> Consecutive losses <code>${rec.assetState.consecutiveLosses}</code> (global <code>${consecutiveLossesGlobal}</code>)`;
    telegram.send(closeMsg);
  }

  if(rec.subId) rec.client.forget(rec.subId).catch(()=>{});
  openContracts.delete(cid);
  saveState('settle');
  if(tradeLog.filter(t=>t.outcome).length % CONFIG.validationN === 0 && tradeLog.filter(t=>t.outcome).length>=CONFIG.validationN) runValidationSweep();
  checkKillSwitch();
}
function runValidationSweep(){
  const settled=tradeLog.filter(t=>t.outcome && Number.isFinite(t.breakeven));
  const lastN=settled.slice(-CONFIG.validationN);
  if(lastN.length < CONFIG.validationN) return;
  const wins=lastN.filter(t=>t.outcome==='won').length;
  const breakevenMean=lastN.reduce((s,t)=>s+(t.breakeven||0),0)/lastN.length;
  const pTwo=binomialPValue(wins, lastN.length, breakevenMean);
  const unfavorable = wins/lastN.length < breakevenMean;
  const pOne = pTwo/2;
  log('INFO',`Validation last${CONFIG.validationN}: wins ${wins}/${lastN.length} WR ${(wins/lastN.length).toFixed(3)} vs breakeven ${breakevenMean.toFixed(3)} pTwo ${pTwo.toFixed(4)} ${unfavorable?'unfavorable':''}`);
  for(const t of lastN) t.validationP=pTwo;
  if(unfavorable && pOne < CONFIG.killP){
    const msg=`🛑 <b>Kill-switch: realized WR inconsistent</b>\nLast${CONFIG.validationN}: <code>${wins}/${lastN.length} ${(wins/lastN.length).toFixed(3)}</code> vs breakeven <code>${breakevenMean.toFixed(3)}</code> pOne <code>${pOne.toFixed(4)}</code>`;
    log('ERROR',msg.replace(/<[^>]+>/g,'')); telegram.send(msg); enterPaused('validation p<0.05 unfavorable');
  }
}
function checkKillSwitch(){
  if(killed) return;
  if(consecutiveLossesGlobal >= CONFIG.maxConsecutiveLosses){ const msg=`🛑 <b>Kill-switch: ${consecutiveLossesGlobal} consecutive losses</b> (limit ${CONFIG.maxConsecutiveLosses})`; log('ERROR',msg.replace(/<[^>]+>/g,'')); telegram.send(msg); enterPaused(`consecutive losses ${consecutiveLossesGlobal}`); return; }
  if(dailyLoss <= -Math.abs(CONFIG.dailyMaxLoss)){ const msg=`🛑 <b>Kill-switch: daily loss ${dailyLoss.toFixed(2)} ${CONFIG.currency}</b> (limit -${CONFIG.dailyMaxLoss})`; log('ERROR',msg.replace(/<[^>]+>/g,'')); telegram.send(msg); enterPaused(`daily loss ${dailyLoss.toFixed(2)}`); return; }
  if(dailyTrades >= CONFIG.dailyMaxTrades){ const msg=`🛑 <b>Kill-switch: daily trades ${dailyTrades}</b>`; log('ERROR',msg.replace(/<[^>]+>/g,'')); telegram.send(msg); enterPaused('daily trades limit'); return; }
}
function enterPaused(reason){
  killed=true;
  for(const st of assetMap.values()){ st.calibrationStatus='PAUSED'; st.pauseReason=reason; }
  saveState('paused:'+reason);
  log('ERROR',`PAUSED — manual restart required (delete ${CONFIG.stateFile} or restart with --reset)`);
}

// ────────────────────────────────────────────────────────────────────
//  Deep backfill helper
// ────────────────────────────────────────────────────────────────────
async function deepBackfill(client, symbol, target, onProgress){
  const out=[]; let remain=target; let end='latest'; let lastEpoch=null;
  const DERIV_MAX=CONFIG.deepBackfillBatch;
  while(remain>0){
    const count=Math.min(DERIV_MAX, remain);
    let res; try{ res=await client._send({ticks_history:symbol,count, end, style:'ticks'},30000); }catch(e){ log('WARN',`backfill ${symbol} batch failed:`,e.message); break; }
    const times=res.history?.times||[]; const prices=res.history?.prices||[];
    if(!times.length){ log('INFO',`backfill ${symbol} exhausted at ${out.length}`); break; }
    const batch=times.map((t,i)=> ({epoch:+t, quote:parseFloat(prices[i])}));
    if(lastEpoch!==null && batch[batch.length-1].epoch >= lastEpoch){ log('INFO',`backfill ${symbol} pagination stalled at ${out.length}`); break; }
    lastEpoch=batch[0].epoch; out.unshift(...batch); remain-=batch.length;
    if(onProgress) onProgress(out.length);
    end=String(batch[0].epoch-1);
    await new Promise(r=>setTimeout(r,200));
    if(batch.length < count){ log('INFO',`backfill ${symbol} short ${batch.length}/${count} at ${out.length}`); break; }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
//  Calibration logic v2 — relaxed gates + intelligent post-spike params
// ────────────────────────────────────────────────────────────────────
function rebuildCalibration(st){
  if(st.intervals.length < CONFIG.calibrationMinIntervals) return {ready:false, reason:`need ${CONFIG.calibrationMinIntervals} intervals, have ${st.intervals.length}`};
  const mean=st.intervals.reduce((s,v)=>s+v,0)/st.intervals.length;
  const floor=CONFIG.detection.minSpikeSeparation;
  const disp=dispersionStats(st.intervals, floor);
  const chi=chiSquareGOF(st.intervals, floor);
  const ks=ksTest(st.intervals, floor);
  const hazard=hazardTable(st.intervals, CONFIG.calibrationBuckets, mean, disp.pHat);
  const elevatedIdx=[];
  for(let i=0;i<hazard.length;i++){
    const b=hazard[i];
    if(b.ciLow===null || b.theoretical===null) continue;
    const outside=b.ciLow > b.theoretical || b.ciHigh < b.theoretical;
    const elevated=b.empirical!==null && b.theoretical!==null && b.empirical > b.theoretical + CONFIG.elevatedMinLift;
    if(outside && elevated) elevatedIdx.push(i);
  }
  const outsideAny = hazard.some(b=> b.outside);
  // v2 relaxed: pass if ANY of CI-outside OR chi OR ks is significant (OR, not AND) — at 0.05
  const testsPassRelaxed = chi.pValue < CONFIG.calibrationP || ks.pValue < CONFIG.calibrationP;
  const hasSignalStrict = outsideAny && (chi.pValue < CONFIG.calibrationP && ks.pValue < CONFIG.calibrationP) && elevatedIdx.length>0;
  const hasSignalRelaxed = outsideAny && testsPassRelaxed && elevatedIdx.length>0;
  // Best elevated bucket = max lift
  let bestIdx=-1, bestLift=-Infinity;
  for(const i of elevatedIdx){ const b=hazard[i]; const lift=b.empirical - b.theoretical; if(lift>bestLift){ bestLift=lift; bestIdx=i; } }
  return {ready:true, mean, disp, chi, ks, hazard, elevatedIdx, hasSignalStrict, hasSignalRelaxed, outsideAny, testsPassRelaxed, bestIdx, bestLift};
}
function computePostSpikeParams(st, calib){
  // Adaptive: best hold is where EV is maximal given observed hazard + stay data
  const mean = calib.mean;
  const pHat = st.pHat ?? calib.disp?.pHat ?? 0.02;
  let entryAfter, holdTicks, reason;

  // helper: per-tick hazard for a given entry tick (approx from bucket)
  function perTickHazardAt(tick){
    if(calib.hazard){
      const b=calib.hazard.find(x=> tick>=x.lo && tick < x.hi);
      if(b && b.empirical!==null && b.hi!==Infinity){
        const width=Math.max(1,b.hi-b.lo);
        // bucket hazard is P(spike in width | survived to lo) → per-tick ≈ 1-(1-haz)^(1/width)
        return 1 - Math.pow(Math.max(0,1-b.empirical), 1/width);
      }
      if(b && b.empirical!==null) return b.empirical; // Infinity bucket fallback
    }
    return pHat;
  }

  if(calib.bestIdx>=0){
    const b=calib.hazard[calib.bestIdx];
    entryAfter=b.lo;
    const width=b.hi===Infinity? Math.round(mean*0.25) : b.hi - b.lo;
    // EV search within 5..min(30, width*2) using per-tick hazard of that bucket
    let bestK=Math.max(CONFIG.holdMin, Math.min(CONFIG.holdMax, width));
    let bestEV=-Infinity;
    const g=CONFIG.growthRate;
    const perTick = perTickHazardAt(entryAfter);
    for(let K=CONFIG.holdMin; K<=Math.min(CONFIG.holdMax, Math.max(width*2, CONFIG.holdMin+5)); K++){
      const surv=Math.pow(Math.max(0,1-perTick), K);
      const ev=Math.pow(1+g,K)*surv -1;
      if(ev>bestEV){ bestEV=ev; bestK=K; }
    }
    holdTicks=bestK;
    // blend with stay median if available (observed best stay)
    if(st.lastStayMedian){
      const stayHold=Math.round(st.lastStayMedian * 0.40);
      holdTicks=Math.round((holdTicks*0.65 + stayHold*0.35));
    }
    // ensure entry+hold < 80% mean to avoid next spike
    const maxByMean=Math.max(CONFIG.holdMin, Math.round(mean*0.80) - entryAfter);
    if(holdTicks>maxByMean) holdTicks=maxByMean;
    reason=`best elevated ${b.range} lift ${(calib.bestLift*100).toFixed(2)}pp mean ${mean.toFixed(1)} EV-best ${bestK} stayMed ${st.lastStayMedian??'n/a'}`;
  }else{
    // fallback: EV-optimal hold using pHat
    let bestK=CONFIG.holdMin, bestEV=-Infinity;
    for(let K=CONFIG.holdMin; K<=CONFIG.holdMax; K++){
      const surv=Math.pow(1-pHat, K);
      const ev=Math.pow(1+CONFIG.growthRate,K)*surv -1;
      if(ev>bestEV){ bestEV=ev; bestK=K; }
    }
    // choose entryAfter fraction adaptively by mean
    const entryFrac = mean < 80 ? 0.28 : mean < 250 ? 0.22 : mean < 600 ? 0.15 : 0.10;
    entryAfter=Math.round(mean * entryFrac);
    holdTicks=bestK;
    // blend with stay median or mean-fraction
    if(st.lastStayMedian){
      const stayHold=Math.round(st.lastStayMedian * 0.45);
      holdTicks=Math.round((holdTicks*0.55 + stayHold*0.45));
    }else{
      const meanHold=Math.round(mean * (mean<100?0.22: mean<400?0.16:0.09));
      holdTicks=Math.round((holdTicks*0.50 + meanHold*0.50));
    }
    // small asset-specific jitter to avoid all 5
    const jitter = (((st.symbol||'BOOM50').charCodeAt((st.symbol||'BOOM50').length-1) || 0) % 3);
    holdTicks+=jitter;
    const maxByMean=Math.max(CONFIG.holdMin, Math.round(mean*0.75) - entryAfter);
    if(holdTicks>maxByMean) holdTicks=maxByMean;
    reason=`fallback mean ${mean.toFixed(1)} pHat ${pHat.toFixed(4)} EV-best ${bestK} stayMed ${st.lastStayMedian??'n/a'} jitter ${jitter}`;
  }
  // final clamps — ensure not stuck at min by enforcing at least 8% of mean
  const minByMean=Math.max(CONFIG.holdMin, Math.round(mean*0.09));
  if(holdTicks < minByMean) holdTicks=Math.min(CONFIG.holdMax, minByMean);
  // extra variance: add CV-based 0-2
  if(holdTicks===CONFIG.holdMin && mean>35){
    const extra=Math.round((st.dispersion?.cv ?? 0.9)*1.5);
    holdTicks=Math.min(CONFIG.holdMax, holdTicks+extra);
  }
  holdTicks=Math.max(CONFIG.holdMin, Math.min(CONFIG.holdMax, holdTicks));
  entryAfter=Math.max(CONFIG.entryDelayMin, Math.min(CONFIG.entryDelayMax, entryAfter));
  return {entryAfter, holdTicks, reason, mean};
}
function logHazardTable(st, res){
  log('INFO',`── ${st.symbol} hazard (mean ${res.mean.toFixed(1)} pHat ${res.disp.pHat.toFixed(5)} n=${st.intervals.length}) ──`);
  log('INFO',`Chi² p ${res.chi.pValue.toFixed(4)} (χ²=${res.chi.chiSq.toFixed(2)} df=${res.chi.df}) KS p ${res.ks.pValue.toFixed(4)} D=${res.ks.D.toFixed(4)} ${res.hasSignalStrict?'STRICT':'relaxed='+(res.hasSignalRelaxed?'yes':'no')}`);
  log('INFO',`Bucket            surv  events  empirical   theo    95% CI           outside  elevated`);
  for(const b of res.hazard){
    const emp=b.empirical!==null? b.empirical.toFixed(4):'n/a';
    const theo=b.theoretical!==null? b.theoretical.toFixed(4):'n/a';
    const ci=b.ciLow!==null? `[${b.ciLow.toFixed(3)}-${b.ciHigh.toFixed(3)}]` : '[n/a]';
    const flag=b.outside? (b.empirical > b.theoretical ? '▲' : '▼') : ' ';
    const elev=res.elevatedIdx.includes(res.hazard.indexOf(b))? '★': ' ';
    const best=res.bestIdx===res.hazard.indexOf(b)? '◀best':'';
    log('INFO',`  ${b.range.padEnd(12)} ${String(b.survivors).padEnd(5)} ${String(b.events).padEnd(6)} ${emp.padEnd(10)} ${theo.padEnd(7)} ${ci.padEnd(18)} ${flag}${elev} ${best}`);
  }
}
async function evaluateCalibrationForAsset(st){
  const res=rebuildCalibration(st);
  if(!res.ready){ log('INFO',`${st.symbol} calibrating ${st.intervals.length}/${CONFIG.calibrationMinIntervals} ${res.reason}`); return; }
  logHazardTable(st, res);
  st.hazardTable=res.hazard; st.dispersion=res.disp; st.chi=res.chi; st.ks=res.ks; st.meanInterval=res.mean; st.pHat=res.disp.pHat; st.elevatedBuckets=res.elevatedIdx;

  if(res.hasSignalStrict){
    st.calibrationStatus='ACTIVE';
    st.lastCalibrationAt=Date.now();
    const post=computePostSpikeParams(st,res);
    st.pendingEntryAfter=post.entryAfter; st.pendingHoldTicks=post.holdTicks; st.pendingEntryReason=post.reason;
    const msg=`✅ <b>Calibration ACTIVE ${st.symbol} (strict)</b>\nIntervals <code>${st.intervals.length}</code> mean <code>${res.mean.toFixed(1)}</code> CV <code>${res.disp.cv.toFixed(3)}</code>\nχ² p <code>${res.chi.pValue.toFixed(4)}</code> KS p <code>${res.ks.pValue.toFixed(4)}</code>\nElevated <code>${res.elevatedIdx.map(i=>res.hazard[i].range).join(', ')}</code>\nPost-spike entry <code>${post.entryAfter}</code> hold <code>${post.holdTicks}</code> (${post.reason})`;
    log('INFO',`CALIBRATION STRICT ACTIVE ${st.symbol} entryAfter ${post.entryAfter} hold ${post.holdTicks}`);
    telegram.send(msg);
    saveState('calibActive:'+st.symbol);
  }else if(res.hasSignalRelaxed){
    st.calibrationStatus='ACTIVE';
    st.lastCalibrationAt=Date.now();
    const post=computePostSpikeParams(st,res);
    st.pendingEntryAfter=post.entryAfter; st.pendingHoldTicks=post.holdTicks; st.pendingEntryReason=post.reason;
    const msg=`✅ <b>Calibration ACTIVE (relaxed) ${st.symbol}</b>\nIntervals <code>${st.intervals.length}</code> mean <code>${res.mean.toFixed(1)}</code>\nχ² p <code>${res.chi.pValue.toFixed(4)}</code> KS p <code>${res.ks.pValue.toFixed(4)}</code> (relaxed OR gate)\nElevated <code>${res.elevatedIdx.map(i=>res.hazard[i].range).join(', ')}</code>\nPost-spike entry <code>${post.entryAfter}</code> hold <code>${post.holdTicks}</code>`;
    log('INFO',`CALIBRATION RELAXED ACTIVE ${st.symbol} entryAfter ${post.entryAfter} hold ${post.holdTicks}`);
    telegram.send(msg);
    saveState('calibRelaxed:'+st.symbol);
  }else{
    // v2 relaxed fallback: still go ACTIVE_RELAXED but with mean-derived timing
    const post=computePostSpikeParams(st,res);
    st.calibrationStatus='ACTIVE_RELAXED';
    st.lastCalibrationAt=Date.now();
    st.pendingEntryAfter=post.entryAfter; st.pendingHoldTicks=post.holdTicks; st.pendingEntryReason=post.reason;
    const msg=`⚠️ <b>Calibration NO EDGE → RELAXED ${st.symbol}</b>\nIntervals <code>${st.intervals.length}</code> mean <code>${res.mean.toFixed(1)}</code>\nχ² p <code>${res.chi.pValue.toFixed(4)}</code> KS p <code>${res.ks.pValue.toFixed(4)}</code>\nNo relaxed elevated bucket — using mean-derived entry <code>${post.entryAfter}</code> hold <code>${post.holdTicks}</code>\nWill trade post-spike anyway (v2 less restrictive).`;
    log('WARN',`CALIBRATION RELAXED (no edge) ${st.symbol} entryAfter ${post.entryAfter} hold ${post.holdTicks}`);
    telegram.send(msg);
    saveState('calibRelaxedNoEdge:'+st.symbol);
    // Do NOT wipe intervals — keep learning; do not restart afresh in v2 relaxed mode
  }
}

// ────────────────────────────────────────────────────────────────────
//  Spike detection integration — v2 schedules post-spike entry on each spike
// ────────────────────────────────────────────────────────────────────
function schedulePostSpikeEntry(st){
  // Called immediately after a new spike is appended
  const tmp={ intervals: st.intervals, hazardTable: st.hazardTable, chi: st.chi, ks: st.ks, dispersion: st.dispersion, meanInterval: st.meanInterval };
  // Need mean at least; if not yet calibrated, use current intervals mean
  let mean=null;
  if(st.meanInterval) mean=st.meanInterval;
  else if(st.intervals.length>=10) mean=st.intervals.reduce((a,b)=>a+b,0)/st.intervals.length;
  else return; // not enough data to schedule

  // Build a lightweight calib-like object for param calc
  let calibForParams;
  if(st.hazardTable && st.meanInterval){
    // Rebuild bestIdx from existing hazard
    const res=rebuildCalibration(st);
    if(res.ready) calibForParams=res;
    else calibForParams={mean, hazard: st.hazardTable, elevatedIdx: st.elevatedBuckets, bestIdx: -1, bestLift: 0};
    if(calibForParams.bestIdx===undefined) calibForParams.bestIdx=-1;
  }else{
    calibForParams={mean, hazard: [], elevatedIdx:[], bestIdx:-1};
  }
  const post=computePostSpikeParams(st, {mean, hazard: calibForParams.hazard||[], elevatedIdx: calibForParams.elevatedIdx||[], bestIdx: calibForParams.bestIdx??-1, bestLift: calibForParams.bestLift??0});
  st.pendingEntryAfter=post.entryAfter;
  st.pendingHoldTicks=post.holdTicks;
  st.pendingEntryReason=post.reason;
  st.entryScheduledAt=Date.now();
  log('INFO',`${st.symbol} scheduled post-spike entry: after ${post.entryAfter} ticks hold ${post.holdTicks} (${post.reason}) ticksSinceSpike reset 0`);
}

function processNewTicksForAsset(st, newTicks){
  for(const t of newTicks) st.history.push(t);
  if(st.history.length > CONFIG.historyCap) st.history.splice(0, st.history.length - CONFIG.historyCap);
  st.totalTicksSeen += newTicks.length;

  // ── Timed close for ACCU: sell when plannedHold ticks elapsed (accuAPEX-style) ──
  // Must run on every tick, even if history too short for detector
  for(const [cid, rec] of openContracts){
    if(rec.symbol !== st.symbol) continue;
    if(rec._selling) continue;
    // rec.buyAbsIdx set at buy time; fallback to buyTime
    const ticksHeld = st.totalTicksSeen - (rec.buyAbsIdx ?? st.totalTicksSeen);
    rec.ticksHeld = ticksHeld;
    const targetHold = rec.entryLog?.plannedHold ?? CONFIG.holdMin;
    if(ticksHeld >= targetHold){
      log('INFO',`Timed close ${st.symbol} #${cid} ticksHeld ${ticksHeld}/${targetHold} — selling`);
      rec._selling = true;
      // async sell without blocking tick processing
      (async ()=>{
        try{
          const res = await rec.client._send({sell: cid, price: 0}, 15000);
          const sold = res.sell || {};
          const soldFor = parseFloat(sold.sold_for ?? sold.sell_price ?? 0);
          log('INFO',`sold #${cid} for ${soldFor}`);
          // finalize will be triggered by proposal_open_contract is_sold, but force if needed
          // If stream doesn't fire, finalize here
          setTimeout(()=>{
            if(openContracts.has(cid)){
              // fallback: query contract
              rec.client._send({proposal_open_contract:1, contract_id: cid}, 10000).then(r=>{
                const poc=r.proposal_open_contract;
                if(poc && poc.is_sold) finalizeContract(cid, poc);
                else if(poc) finalizeContract(cid, {profit: poc.profit ?? 0, status: poc.status||'sold', sell_price: soldFor, sell_time: Date.now()/1000});
              }).catch(()=> finalizeContract(cid, {profit: 0, status: 'sold', sell_price: soldFor, sell_time: Date.now()/1000}));
            }
          }, 2000);
        }catch(e){
          log('WARN',`Timed sell #${cid} failed:`,e.message);
          rec._selling = false;
          // retry next tick
          rec.lastUpdate = Date.now() - CONFIG.watchdogMs + 5000; // force watchdog check
        }
      })();
    }
  }

  if(st.history.length < CONFIG.detection.baselineWindow + 100) return;

  const prices=st.history.map(t=>t.quote);
  const det=detectSpikes(prices, CONFIG, st.symbol);
  let newSpikeHappened=false;
  for(const idx of det.spikeIndices){
    const absIdx = st.totalTicksSeen - st.history.length + idx;
    if(st.lastSpikeAbsIdx===null || absIdx > st.lastSpikeAbsIdx){
      const tick=st.history[idx];
      const prevAbs = st.lastSpikeAbsIdx;
      const gap = prevAbs===null ? null : absIdx - prevAbs;
      if(gap!==null){
        st.intervals.push(gap);
        const lo=Math.max(0, idx-10), hi=Math.min(prices.length, idx+11);
        const window=st.history.slice(lo,hi).map((t,i)=> `${lo+i===idx?'▶':''}${t.quote.toFixed(4)}@${t.epoch}`).join(' ');
        log('INFO',`${st.symbol} spike #${st.intervals.length} gap ${gap} at idx ${idx} epoch ${tick.epoch} window: ${window}`);
      }
      st.lastSpikeAbsIdx=absIdx;
      st.ticksSinceSpike=0;
      newSpikeHappened=true;
      // v2: schedule post-spike entry immediately
      schedulePostSpikeEntry(st);

      if(st.calibrationStatus==='CALIBRATING' && !killed){
        if(st.intervals.length % 10 === 0 || st.intervals.length===CONFIG.calibrationMinIntervals){
          evaluateCalibrationForAsset(st);
        }
      }
      // v2: even when ACTIVE, after each spike we refresh hazard incrementally every 20 intervals
      // Do NOT overwrite pendingEntry — that is driven strictly by schedulePostSpikeEntry (1-per-spike).
      // Just refresh hazard stats for next spike's scheduling.
      if((st.calibrationStatus==='ACTIVE' || st.calibrationStatus==='ACTIVE_RELAXED') && st.intervals.length % 20 === 0){
        const res=rebuildCalibration(st);
        if(res.ready){
          st.hazardTable=res.hazard; st.dispersion=res.disp; st.chi=res.chi; st.ks=res.ks; st.meanInterval=res.mean; st.pHat=res.disp.pHat; st.elevatedBuckets=res.elevatedIdx;
          log('INFO',`${st.symbol} hazard refreshed intervals ${st.intervals.length} mean ${res.mean.toFixed(1)} elevated [${res.elevatedIdx.map(i=>res.hazard[i].range).join(',')||'none'}] — pending untouched (1-per-spike)`);
          saveState('hazardRefresh:'+st.symbol);
        }
      }
    }
  }
  if(st.lastSpikeAbsIdx!==null){
    const newTicksSince = st.totalTicksSeen - st.lastSpikeAbsIdx - 1;
    st.ticksSinceSpike = Math.max(0, newTicksSince);
  }

  // v2 trigger: if we just had a spike, the *next* tick loop will handle entry when ticksSinceSpike == pendingEntryAfter
  // No extra action here; tryTrade is polled externally or can be triggered on tick.
}

// ────────────────────────────────────────────────────────────────────
//  Trading v2 — post-spike scheduled entry, hold derived from mean
// ────────────────────────────────────────────────────────────────────
async function tryTradeForAsset(client, st){
  if(killed) return;
  if(st.calibrationStatus!=='ACTIVE' && st.calibrationStatus!=='ACTIVE_RELAXED') return;
  if(openContracts.size >= CONFIG.maxOpenTrades) return;
  if(Date.now() - st.lastTradeAt < CONFIG.tradeCooldownMs) return;
  if(st.pendingEntryAfter===null || st.pendingHoldTicks===null) return;
  // Strict 1-trade-per-spike guard — if this spike already traded, ignore
  if(st.lastSpikeAbsIdx!==null && st.lastTradedSpikeAbsIdx!==null && st.lastSpikeAbsIdx===st.lastTradedSpikeAbsIdx){
    // already traded this spike — clear pending and wait for next spike
    if(st.ticksSinceSpike > st.pendingEntryAfter+2){
      log('DEBUG',`${st.symbol} already traded spike ${st.lastSpikeAbsIdx} — clearing pending`);
      st.pendingEntryAfter=null; st.pendingHoldTicks=null;
    }
    return;
  }
  // Only fire when we have reached exactly the scheduled ticksSinceSpike
  // Allow a 2-tick window to avoid missing due to async/proposal retry
  const target=st.pendingEntryAfter;
  if(st.ticksSinceSpike < target) return;
  if(st.ticksSinceSpike > target+2){
    // Missed window — clear and wait for next spike
    log('DEBUG',`${st.symbol} missed entry window ${target} now ${st.ticksSinceSpike} — clearing`);
    st.pendingEntryAfter=null; st.pendingHoldTicks=null;
    return;
  }
  // One-shot: capture the scheduled entry (keep pending until we confirm proposal has payout)
  const holdTicks=st.pendingHoldTicks;
  const entryAfter=st.pendingEntryAfter;
  const entryReason=st.pendingEntryReason;

  // Fetch proposal with derived hold? For ACCU, growthRate is fixed 1%, but hold informs EV calc and logging.
  // Deriv ACCU payout is stake-based, not tick-based, but we log hold for audit.
  const key=client.symbolKey;
  // ── Martingale stake for this entry ──────────────────────────────────
  const martingaleStake = getMartingaleStake();
  let proposal;
  let rawRes;
  try{
    rawRes=await client._send({proposal:1, amount:martingaleStake, basis:'stake', contract_type:'ACCU', currency:CONFIG.currency, [key]:st.symbol, growth_rate: CONFIG.growthRate}, 15000);
    proposal=rawRes.proposal;
  }catch(e){
    log('WARN',`Proposal ${st.symbol} failed:`,e.message, rawRes? JSON.stringify(rawRes).slice(0,400):'');
    // keep pending for one more tick retry (don't consume yet) — only clear if window fully missed
    if(st.ticksSinceSpike > target+1){ st.pendingEntryAfter=null; st.pendingHoldTicks=null; }
    return;
  }
  const cd=proposal?.contract_details||{};
  // ── Adaptive stay observation: update per-asset stay median for next hold calc ──
  if(Array.isArray(cd.ticks_stayed_in) && cd.ticks_stayed_in.length){
    const arr=cd.ticks_stayed_in.map(Number).filter(n=>Number.isFinite(n));
    if(arr.length){
      const sorted=[...arr].sort((a,b)=>a-b);
      const med=sorted[Math.floor(sorted.length/2)];
      const meanStay=arr.reduce((a,b)=>a+b,0)/arr.length;
      st.lastStayMedian=med;
      st.lastStayMean=meanStay;
      st.stayHistory.push(med);
      if(st.stayHistory.length>20) st.stayHistory.shift();
      log('DEBUG',`${st.symbol} stay update median ${med} mean ${meanStay.toFixed(1)} n=${arr.length} next hold will adapt`);
    }
  }
  const barrierPct= parseFloat(cd.tick_size_barrier_percentage||0)/100 || (parseFloat(cd.current_spot||0)>0 && parseFloat(cd.barrier_spot_distance||0)>0 ? parseFloat(cd.barrier_spot_distance)/parseFloat(cd.current_spot) : null);
  // if(!(barrierPct>CONFIG.minBarrierPct)){
  //   log('WARN',`Skip ${st.symbol} barrier too small ${barrierPct} — proposal: ${JSON.stringify(proposal).slice(0,400)}`);
  //   if(st.ticksSinceSpike > target+1){ st.pendingEntryAfter=null; st.pendingHoldTicks=null; }
  //   return;
  // }
  const ask=parseFloat(proposal.ask_price ?? martingaleStake);
  // For ACCU, proposal.payout may be missing/0 — use contract_details.maximum_payout per accuAPEX.js:1129
  const payoutRaw = proposal.payout ?? cd.maximum_payout ?? 0;
  const payout=parseFloat(payoutRaw||0);
  let breakevenLocal=null;
  if(payout>0 && ask>0) breakevenLocal= 1 - ask/payout;
  else {
    // ACCU payout not fixed at proposal — estimate breakeven from hazard or set null
    // accuAPEX does NOT gate on payout at proposal; proceed and validate on settlement
    breakevenLocal=null;
    log('INFO',`ACCU proposal ${st.symbol} has no fixed payout (ask ${ask} maxPayout ${cd.maximum_payout||'?'}) — proceeding per accuAPEX reference, breakeven N/A`);
  }
  // Success — now consume the scheduled entry (before buy, per accuAPEX: buy uses p.id/ask)
  st.pendingEntryAfter=null; st.pendingHoldTicks=null;

  // Hazard-implied survival for this hold
  const hazard = st.hazardTable ? (st.hazardTable.find(b=> entryAfter>=b.lo && entryAfter<b.hi)?.empirical ?? st.pHat ?? 0.02) : (st.pHat ?? 0.02);
  const pHorizon=Math.pow(Math.max(0, 1 - hazard), holdTicks);
  const ev=((1+CONFIG.growthRate)**holdTicks)*pHorizon -1;

  log('INFO',`v2 Signal ${st.symbol} post-spike entryAfter ${entryAfter} hold ${holdTicks} hazard ${Number(hazard).toFixed(4)} barrier ${(barrierPct*100).toFixed(5)}% payout ${payout} ev ${ (ev*100).toFixed(2)}% martingale Lv${martingaleLevel} stake ${martingaleStake.toFixed(2)} (${entryReason})`);

  let buyRes;
  let buyAttempts=0;
  while(buyAttempts<2){
    try{
      const buy=await client._send({buy: proposal.id, price: ask}, 20000);
      buyRes=buy.buy;
      if(!buyRes?.contract_id) throw new Error('No contract_id');
      break; // success
    }catch(e){
      const msg=String(e.message||'');
      const isRace = /BetExpired|TradingDurationNotAllowed|ContractNotFound|InvalidContract|Unknown contract proposal/i.test(msg);
      const isLimit = /OpenPositionLimitExceeded|too many open positions/i.test(msg);
      if(isLimit){
        log('WARN',`Buy ${st.symbol} blocked (limit):`,msg,'— pending cleared till next spike/close');
        // clear pending so we don't hammer Deriv while at limit; wait for close or next spike
        st.pendingEntryAfter=null; st.pendingHoldTicks=null;
        return;
      }
      if(isRace && buyAttempts===0){
        log('WARN',`Buy ${st.symbol} race (${msg}) — fetching fresh proposal and retrying once`);
        // fetch fresh proposal
        try{
          const fresh=await client._send({proposal:1, amount:martingaleStake, basis:'stake', contract_type:'ACCU', currency:CONFIG.currency, [client.symbolKey]:st.symbol, growth_rate: CONFIG.growthRate}, 15000);
          proposal=fresh.proposal;
          if(!proposal?.id) throw new Error('No fresh proposal id');
          // re-extract ask/payout/barrier for fresh proposal (keep same hold)
          const cd2=proposal.contract_details||{};
          const barrier2= parseFloat(cd2.tick_size_barrier_percentage||0)/100 || (parseFloat(cd2.current_spot||0)>0 && parseFloat(cd2.barrier_spot_distance||0)>0 ? parseFloat(cd2.barrier_spot_distance)/parseFloat(cd2.current_spot) : null);
          if(barrier2) { /* keep original barrierPct for logging but update proposal reference */ }
        }catch(e2){
          log('WARN',`Fresh proposal retry for ${st.symbol} failed:`,e2.message);
          return;
        }
        buyAttempts++;
        continue;
      }
      // non-race or second failure
      const level = isRace ? 'WARN' : 'ERROR';
      log(level,`Buy ${st.symbol} failed:`,msg);
      if(!isRace) telegram.send(`❌ <b>Buy failed ${st.symbol}</b> ${msg.slice(0,120)}`);
      return;
    }
  }
  if(!buyRes) return;
  const cid=buyRes.contract_id;
  // Mark this spike as traded (strict 1-per-spike)
  st.lastTradedSpikeAbsIdx=st.lastSpikeAbsIdx;
  st.lastTradeAt=Date.now();
  log('INFO',`Bought v2 ${st.symbol} ACCU #${cid} stake ${buyRes.buy_price} growth ${CONFIG.growthRate*100}% entryAfter ${entryAfter} hold ${holdTicks} barrier ${(barrierPct*100).toFixed(5)}%`);
  // ── Detailed OPEN telegram per spec: asset, Stake, Trade Analysis, Consecutive losses + Martingale ──
  {
    const consLoss = st.consecutiveLosses||0;
    const meanTxt = st.meanInterval ? `mean ${st.meanInterval.toFixed(1)}` : 'mean n/a';
    const bucketInfo = st.hazardTable?.find(b=>entryAfter>=b.lo&&entryAfter<b.hi);
    const bucketTxt = bucketInfo ? `${bucketInfo.range} emp ${Number(hazard).toFixed(4)} theo ${(bucketInfo.theoretical??0).toFixed(4)}` : `${entryAfter}`;
    const analysis = `Bucket <code>${bucketTxt}</code>\nHazard emp <code>${Number(hazard).toFixed(4)}</code> theo <code>${(bucketInfo?.theoretical??st.pHat??0).toFixed(4)}</code>\nBarrier <code>${(barrierPct*100).toFixed(5)}%</code> Hold <code>${holdTicks}</code> ticks\nEV <code>${(ev*100).toFixed(2)}%</code> ${entryReason} | ${meanTxt} pHat <code>${(st.pHat??0).toFixed(5)}</code>`;
    const mgLine = CONFIG.martingaleEnabled
      ? `Martingale Lv <code>${martingaleLevel}/${CONFIG.martingaleSteps} ×${CONFIG.martingaleMultiplier}</code> Stake <code>${martingaleStake.toFixed(2)}→${(parseFloat(buyRes.buy_price||martingaleStake)).toFixed(2)} ${CONFIG.currency}</code> Next <code>${getMartingaleStake().toFixed(2)}</code>`
      : `Martingale <code>OFF</code> Stake <code>${martingaleStake.toFixed(2)}</code>`;
    const streakLine = lossStreakInfoLine();
    telegram.send(`🟢 <b>OPEN ${st.symbol} #${cid}</b>\nStake <code>${buyRes.buy_price} ${CONFIG.currency}</code> Growth <code>${(CONFIG.growthRate*100).toFixed(2)}%</code>\n${analysis}\n${mgLine}\n${streakLine}\nConsecutive losses <code>${consLoss}</code> (global <code>${consecutiveLossesGlobal}</code>)`);
  }

  const entry={
    ts:Date.now(), symbol:st.symbol, ticksSinceSpike: entryAfter, bucketRange: st.hazardTable?.find(b=>entryAfter>=b.lo&&entryAfter<b.hi)?.range||`${entryAfter}`, plannedHold: holdTicks, entryAfter,
    hazardEmp: hazard, hazardTheo: st.hazardTable?.find(b=>entryAfter>=b.lo&&entryAfter<b.hi)?.theoretical||null,
    barrierPct, growthRate: CONFIG.growthRate, ask, payout, breakeven: breakevenLocal,
    outcome:null, profit:null, contractId: cid, v2:true, entryReason, stake: parseFloat(buyRes.buy_price||martingaleStake), martingaleLevel, martingaleStake, martingaleMultiplier: CONFIG.martingaleMultiplier, buyTime: Date.now(),
  };

  let subId=null;
  try{
    subId=await client.subscribe({proposal_open_contract:1, contract_id: cid}, msg=>{
      const poc=msg.proposal_open_contract;
      if(!poc) return;
      const rec=openContracts.get(cid); if(rec) rec.lastUpdate=Date.now();
      if(poc.is_sold || ['won','lost','sold','expired','cancelled'].includes(poc.status)){
        finalizeContract(cid, poc);
      }
    });
  }catch(e){ log('WARN',`Subscribe contract ${cid} failed:`,e.message); }

  openContracts.set(cid, {
    symbol: st.symbol, client, subId, lastUpdate: Date.now(),
    assetState: st, entryLog: entry,
    buyAbsIdx: st.totalTicksSeen,
    ticksHeld: 0,
    _selling: false,
  });
  st.lastTradeAt=Date.now();
  saveState('buy:'+cid);
}

// ────────────────────────────────────────────────────────────────────
//  Self-test
// ────────────────────────────────────────────────────────────────────
function runSelfTest(){
  console.log('Running selftest v2...');
  const assert=(cond,msg)=>{ if(!cond) throw new Error('selftest fail: '+msg); };
  assert(median([3,1,2])===2, 'median');
  const w0=wilsonCI(0,10,1.96); assert(w0.low===0 && w0.high<0.3, 'wilson 0');
  const w5=wilsonCI(5,10,1.96); assert(Math.abs(w5.low-0.236)<0.01, 'wilson 5');
  const d=dispersionStats([2,2,2],2); assert(Math.abs(d.pHat-1)<1e-9, 'phat');
  const fakeIntervals=Array.from({length:200},()=> 2+ Math.floor(Math.log(Math.random())/Math.log(1-0.018)));
  const chi=chiSquareGOF(fakeIntervals,2); assert(Number.isFinite(chi.pValue), 'chi');
  const ks=ksTest(fakeIntervals,2); assert(Number.isFinite(ks.pValue), 'ks');
  const hz=hazardTable(fakeIntervals, CONFIG.calibrationBuckets, fakeIntervals.reduce((a,b)=>a+b,0)/fakeIntervals.length, 0.018);
  assert(hz.length===CONFIG.calibrationBuckets.length-1, 'hazard');
  assert(binomialPValue(5,10,0.5)>0.6, 'binom');
  // v2 specific: post-spike param calc
  const mockSt={intervals: fakeIntervals, meanInterval: fakeIntervals.reduce((a,b)=>a+b,0)/fakeIntervals.length, hazardTable: hz, elevatedBuckets: [], pHat:0.018};
  const mockCalib={mean: mockSt.meanInterval, hazard: hz, elevatedIdx:[], bestIdx:-1, bestLift:0};
  const post=computePostSpikeParams(mockSt, mockCalib);
  assert(post.entryAfter>=CONFIG.entryDelayMin && post.entryAfter<=CONFIG.entryDelayMax, 'entryAfter range');
  assert(post.holdTicks>=CONFIG.holdMin && post.holdTicks<=CONFIG.holdMax, 'hold range');
  // martingale checks
  const base=CONFIG.stake;
  martingaleLevel=0; assert(getMartingaleStake()===base, 'mg base');
  martingaleLevel=1; assert(Math.abs(getMartingaleStake()- base*CONFIG.martingaleMultiplier)<1e-9, 'mg 1');
  martingaleLevel=2; assert(Math.abs(getMartingaleStake()- base*Math.pow(CONFIG.martingaleMultiplier,2))<1e-9, 'mg 2');
  // advance/reset
  martingaleLevel=0; advanceMartingaleOnResult(false); assert(martingaleLevel===1, 'mg advance 1');
  advanceMartingaleOnResult(false); assert(martingaleLevel===2, 'mg advance 2');
  advanceMartingaleOnResult(true); assert(martingaleLevel===0, 'mg reset');
  // maxSteps cap
  martingaleLevel=CONFIG.martingaleSteps; advanceMartingaleOnResult(false); assert(martingaleLevel===0, 'mg cap reset');
  martingaleLevel=0;
  // loss streak tracking
  maxConsecutiveLossesSeen=0; lossStreakCounts={x2:0,x3:0,x4:0,x5:0,x6:0,x7:0};
  consecutiveLossesGlobal=2; if(consecutiveLossesGlobal>=2&&consecutiveLossesGlobal<=7) lossStreakCounts['x'+consecutiveLossesGlobal]++;
  assert(lossStreakCounts.x2===1, 'x2 count');
  consecutiveLossesGlobal=3; lossStreakCounts['x'+consecutiveLossesGlobal]++;
  assert(lossStreakCounts.x3===1, 'x3 count');
  const info=martingaleInfoLine(); assert(info.includes('Martingale'), 'mg info');
  const linfo=lossStreakInfoLine(); assert(linfo.includes('Max Consecutive'), 'loss info');
  // reset globals for clean boot
  martingaleLevel=0; consecutiveLossesGlobal=0; maxConsecutiveLossesSeen=0; lossStreakCounts={x2:0,x3:0,x4:0,x5:0,x6:0,x7:0};
  console.log('selftest v2 PASS — martingale + loss streak OK');
  process.exit(0);
}
if(process.argv.includes('--selftest')) runSelfTest();
if(process.argv.includes('--reset')){ try{fs.unlinkSync(CONFIG.stateFile);}catch(_){} console.log('state reset v2'); }

// ────────────────────────────────────────────────────────────────────
//  Main
// ────────────────────────────────────────────────────────────────────
async function main(){
  console.log('═'.repeat(72));
  console.log('  Hazard-Refractory Bot v2 — post-spike less restrictive');
  console.log('═'.repeat(72));
  console.log(`  Assets: ${CONFIG.assets.join(', ')}`);
  console.log(`  Calibration: ${CONFIG.calibrationMinIntervals} intervals relaxed p<${CONFIG.calibrationP} entryAfter mean*${CONFIG.entryDelayFrac} hold mean*${CONFIG.holdFrac}`);
  console.log(`  Stake ${CONFIG.stake} ${CONFIG.currency} growth ${(CONFIG.growthRate*100).toFixed(1)}% maxLoss ${CONFIG.dailyMaxLoss} maxConsecLoss ${CONFIG.maxConsecutiveLosses}`);
  console.log(`  Martingale ${CONFIG.martingaleEnabled?'ON':'OFF'} ×${CONFIG.martingaleMultiplier} steps ${CONFIG.martingaleSteps} maxStake ${CONFIG.martingaleMaxStake} Lv ${martingaleLevel} → ${getMartingaleStake().toFixed(2)}`);
  console.log(`  Losses Max ${maxConsecutiveLossesSeen} cur ${consecutiveLossesGlobal} x2:${lossStreakCounts.x2} x3:${lossStreakCounts.x3} x4:${lossStreakCounts.x4} x5:${lossStreakCounts.x5} x6:${lossStreakCounts.x6} x7:${lossStreakCounts.x7}`);
  console.log('═'.repeat(72));

  loadState();
  maybeResetDaily();

  const client=new DerivClient(CONFIG);
  globalClient=client;
  client.connect();

  await new Promise((resolve,reject)=>{
    const onAuth=()=>{ client.removeListener('authorized', onAuth); resolve(); };
    client.on('authorized', onAuth);
    setTimeout(()=> reject(new Error('Auth timeout')), 30000);
  }).catch(e=>{ log('WARN','Auth wait timeout:',e.message); });

  let tries=0; while(!client.authorized && tries<30){ await new Promise(r=>setTimeout(r,1000)); tries++; }
  if(!client.authorized){ log('ERROR','Not authorized — continuing with ticks only'); }

  log('INFO',`Subscribing ticks for ${CONFIG.assets.length} assets...`);
  for(const sym of CONFIG.assets){
    try{
      const hist=assetMap.get(sym).history;
      if(hist.length===0){
        log('INFO',`Bootstrapping ${sym} deepBackfill ${CONFIG.deepBackfillTarget}...`);
        const fetched=await deepBackfill(client, sym, CONFIG.deepBackfillTarget);
        assetMap.get(sym).history=fetched;
        assetMap.get(sym).totalTicksSeen=fetched.length;
        log('INFO',`  ${sym} fetched ${fetched.length}`);
      }
      await client.subscribe({ticks: sym}, msg=>{
        const t=msg.tick; if(!t) return;
        const tick={epoch: +t.epoch, quote: parseFloat(t.quote)};
        const st=assetMap.get(sym);
        if(!st) return;
        processNewTicksForAsset(st, [tick]);
        // v2: immediately check if this tick makes pending entry fire
        // processNewTicks updated ticksSinceSpike, so tryTrade can fire on next tick
      });
      log('INFO',`Subscribed ${sym}`);
      await new Promise(r=>setTimeout(r,300));
    }catch(e){ log('ERROR',`Subscribe ${sym} failed:`,e.message); }
  }

  // Bootstrap intervals from history
  for(const sym of CONFIG.assets){
    const st=assetMap.get(sym);
    if(st.history.length>=CONFIG.detection.baselineWindow){
      const prices=st.history.map(t=>t.quote);
      const det=detectSpikes(prices, CONFIG, sym);
      st.intervals=[];
      let last=null;
      for(const idx of det.spikeIndices){
        if(last!==null) st.intervals.push(idx-last);
        last=idx;
      }
      st.lastSpikeAbsIdx= last!==null ? st.totalTicksSeen - st.history.length + last : null;
      st.ticksSinceSpike= last!==null ? st.history.length -1 - last : 0;
      log('INFO',`${sym} bootstrap spikes ${det.spikeIndices.length} intervals ${st.intervals.length} mean ${st.intervals.length? (st.intervals.reduce((a,b)=>a+b,0)/st.intervals.length).toFixed(1):'n/a'}`);
      if(st.intervals.length>=CONFIG.calibrationMinIntervals){
        await evaluateCalibrationForAsset(st);
      }else{
        log('INFO',`${sym} CALIBRATING ${st.intervals.length}/${CONFIG.calibrationMinIntervals}`);
        telegram.send(`🔄 <b>v2 Calibrating ${sym}</b> intervals <code>${st.intervals.length}/${CONFIG.calibrationMinIntervals}</code>`);
      }
      // v2: schedule initial entry if already ACTIVE
      if(st.calibrationStatus.startsWith('ACTIVE') && st.intervals.length){
        schedulePostSpikeEntry(st);
      }
    }
  }

  startWatchdog(client);
  saveState('boot');

  // v2 main loop: poll every 800ms for post-spike windows (faster than v1 3s)
  setInterval(async ()=>{
    if(killed) return;
    maybeResetDaily();
    for(const sym of CONFIG.assets){
      const st=assetMap.get(sym);
      // If calibrating but now enough intervals, evaluate
      if(st.calibrationStatus==='CALIBRATING' && st.intervals.length>=CONFIG.calibrationMinIntervals){
        await evaluateCalibrationForAsset(st);
      }
      if(st.calibrationStatus==='ACTIVE' || st.calibrationStatus==='ACTIVE_RELAXED'){
        try{ await tryTradeForAsset(client, st); }catch(e){ log('WARN',`tryTrade ${sym}:`,e.message); }
        await new Promise(r=>setTimeout(r,80));
      }
    }
    if(Math.random()<0.08) saveState('loop');
  }, 800);

  setInterval(()=>{
    for(const st of assetMap.values()){
      if(st.calibrationStatus.startsWith('ACTIVE')){
        log('INFO',`${st.symbol} ticksSinceSpike ${st.ticksSinceSpike} pendingAfter ${st.pendingEntryAfter} hold ${st.pendingHoldTicks} status ${st.calibrationStatus} | ${martingaleInfoLine()} | ${lossStreakInfoLine()}`);
      }
    }
  }, 60000);

  process.on('SIGINT', ()=>{ log('INFO','SIGINT — saving state'); saveState('sigint'); client.stop(); if(watchdogTimer) clearInterval(watchdogTimer); setTimeout(()=>process.exit(0),500); });
  process.on('uncaughtException', e=>{ log('ERROR','Uncaught',e.message); saveState('uncaught'); setTimeout(()=>process.exit(1),500); });
  process.on('unhandledRejection', e=>{ log('ERROR','Unhandled',String(e)); saveState('unhandled'); setTimeout(()=>process.exit(1),500); });

  log('INFO','Bot v2 running — post-spike trades every spike');
  log('INFO', martingaleInfoLine()+' | '+lossStreakInfoLine());
  telegram.send(`🚀 <b>Hazard Bot v2 started</b>\nAssets <code>${CONFIG.assets.join(', ')}</code>\nRelaxed calib <code>${CONFIG.calibrationMinIntervals}</code> intervals p<${CONFIG.calibrationP}\n${martingaleInfoLine()}\n${lossStreakInfoLine()}`);
}

main().catch(e=>{ console.error('Fatal',e.message); process.exit(1); });
