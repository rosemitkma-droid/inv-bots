#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  Deriv Digit Differ — Ultra-Fast Single-Asset Bot (Simplified)
 * =====================================================================
 *  Strategy: every trade bets the NEXT tick's last digit will DIFFER
 *  from the current last digit (barrier = current digit, DIGITDIFF).
 *
 *  No analysis, no filters, no scoring — just fire as fast as allowed.
 *  Single asset, tick-driven, minimal overhead for maximum speed.
 *
 *  Credentials below are the user's hardcoded demo-test values and are
 *  preserved. Install: npm install ws
 *  Run:     node simpleDifferX2.js
 * =====================================================================
 */

const WebSocket    = require('ws');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const { URL }      = require('url');
const EventEmitter = require('events');

// ── 1. ENV LOADER (minimal) ──────────────────────────────────────────
function loadEnv(filePath = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(filePath)) return;
  try {
    const txt = fs.readFileSync(filePath, 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (e) { console.error('[boot] .env read failed:', e.message); }
}
loadEnv();
function strEnv(n, d) { const v = process.env[n]; return v == null || v === '' ? d : String(v).trim(); }
function numEnv(n, d) { const v = process.env[n]; if (v == null||v==='') return d; const x=Number(v); return Number.isFinite(x)?x:d; }
function intEnv(n, d) { const v = process.env[n]; if (v == null||v==='') return d; const x=parseInt(v,10); return Number.isFinite(x)?x:d; }
function boolEnv(n,d){ const v=process.env[n]; if(v==null||v==='')return d; return ['1','true','yes','on'].includes(String(v).trim().toLowerCase()); }

// ── 2. CONFIG — single asset, minimal knobs ──────────────────────────
const CONFIG = Object.freeze({
  apiToken:    'pat_cb2016855b5e6c61ac95f94432192dd6ed86bec7f7454e575d3fe1ed9f617692',
  appId:       '33uslPtthXBEkQOdfKfoY',
  accountId:   '',
  accountType: 'demo',
  legacyWsUrl: 'wss://ws.derivws.com/websockets/v3',
  restBaseUrl: 'https://api.derivws.com',
  currency:   'USD',

  // ── Single asset — change via env SINGLE_ASSET or edit here ────────
  asset:         strEnv('SINGLE_ASSET', 'R_50'),
  stake:         numEnv('STAKE', 0.62),
  durationTicks: intEnv('DURATION_TICKS', 1),
  minStake:      0.62,
  maxStake:      750,

  // ── Speed / throttle ───────────────────────────────────────────────
  tradeCooldownMs: intEnv('TRADE_COOLDOWN_MS', 800), // min gap between buys
  maxOpenTrades:   1,
  tradeWatchdogMs: intEnv('WATCHDOG_MS', 20000),

  // ── Martingale (optional) ────────────────────────────────────────
  martingaleEnabled:  boolEnv('MARTINGALE_ENABLED', true),
  martingaleStep:     numEnv('MARTINGALE_STEP', 11.3),           // multiplier per loss, e.g. 2.1
  martingaleFilter:   intEnv('MARTINGALE_FILTER', 0),           // losses before multiplier starts (0=immediate, 1=after 1 loss, 2=after 2 losses…)
  martingaleMaxSteps: intEnv('MARTINGALE_MAX_STEPS', 4),        // cap exponent on the *scaled* steps (0 = uncapped)
  martingaleMaxStake: numEnv('MARTINGALE_MAX_STAKE', 750),      // hard cap (also limited by maxStake)
  // ── Safety (lightweight, does not slow hot path) ──────────────────
  dailyMaxLoss:   numEnv('DAILY_MAX_LOSS', 2000),  // 0 = off
  dailyMaxProfit: numEnv('DAILY_MAX_PROFIT', 0),   // 0 = off
  dailyMaxTrades: intEnv('DAILY_MAX_TRADES', 0),   // 0 = off

  stateFile: strEnv('STATE_FILE', 'simpleX2Differ_state_06.json'),
  logFile:   strEnv('LOG_FILE',   'simpleX2Differ_bot_06.log'),
  logLevel:  strEnv('LOG_LEVEL',  'INFO').toUpperCase(),

  telegram: {
    enabled:  true,
    botToken: '8106601008:AAEMyCma6mvPYIHEvw3RHQX2tkD5-wUe1o0',
    chatId:   '752497117',
  },
  reconnect: {
    initialDelayMs: intEnv('RECONNECT_INITIAL_MS', 1000),
    maxDelayMs:     intEnv('RECONNECT_MAX_MS', 60000),
    backoffFactor:  numEnv('RECONNECT_BACKOFF', 2),
    jitterMs:       intEnv('RECONNECT_JITTER_MS', 750),
  },
});

// ── 3. LOGGER ─────────────────────────────────────────────────────────
const LOG_LEVELS = { ERROR:0, WARN:1, INFO:2, DEBUG:3 };
const curLevel = LOG_LEVELS[CONFIG.logLevel] ?? LOG_LEVELS.INFO;
const pad = n => String(n).padStart(2,'0');
function utcTs(){ const d=new Date(); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`; }
function _writeLog(l){ try{fs.appendFileSync(CONFIG.logFile,l+'\n');}catch(_){} }
function log(lv,msg,...r){
  if((LOG_LEVELS[lv]??1)>curLevel) return;
  const extra=r.map(a=>{ if(a instanceof Error) return a.stack||a.message; if(typeof a==='object'){try{return JSON.stringify(a);}catch{return String(a);}} return String(a);}).join(' ');
  const line=`[${utcTs()}] [${lv}] ${msg}${extra?' '+extra:''}`;
  (lv==='ERROR'?console.error:console.log)(line); _writeLog(line);
}
const logger={ error:(m,...a)=>log('ERROR',m,...a), warn:(m,...a)=>log('WARN',m,...a), info:(m,...a)=>log('INFO',m,...a), debug:(m,...a)=>log('DEBUG',m,...a) };
function money(n,c=CONFIG.currency){ const x=Number(n||0); return `${x>=0?'+':''}${x.toFixed(2)} ${c}`; }
function htmlEscape(s){ return String(s).replace(/[&<>]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch])); }

// ── 4. TELEGRAM ───────────────────────────────────────────────────────
class TelegramNotifier extends EventEmitter{
  constructor(cfg){ super(); this.enabled=cfg.enabled&&!!cfg.botToken&&!!cfg.chatId; this.botToken=cfg.botToken; this.chatId=cfg.chatId; this.q=[]; this.sending=false; }
  _post(text){
    return new Promise(res=>{
      if(!this.enabled) return res(false);
      try{
        const payload=JSON.stringify({ chat_id:this.chatId, text, parse_mode:'HTML', disable_web_page_preview:true });
        const u=new URL(`https://api.telegram.org/bot${this.botToken}/sendMessage`);
        const req=https.request({ method:'POST', hostname:u.hostname, path:u.pathname, headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}, timeout:15000 }, r=>{ r.on('data',()=>{}); r.on('end',()=>res(r.statusCode===200)); });
        req.on('error',e=>{ logger.warn('telegram:',e.message); res(false); });
        req.on('timeout',()=>{ req.destroy(new Error('tg timeout')); res(false); });
        req.write(payload); req.end();
      }catch(e){ logger.warn('telegram exc:',e.message); res(false); }
    });
  }
  async _drain(){ if(this.sending||!this.q.length) return; this.sending=true; try{ while(this.q.length){ await this._post(this.q.shift()); await new Promise(r=>setTimeout(r,1100)); } }finally{this.sending=false;} }
  send(t){ if(!this.enabled){ logger.debug('tg(dry):',String(t).slice(0,160).replace(/\n/g,' | ')); return; } this.q.push(String(t)); this._drain().catch(e=>logger.warn('tg drain:',e.message)); }
}
const telegram=new TelegramNotifier(CONFIG.telegram);

// ── 5. REST + WS CLIENT ───────────────────────────────────────────────
class RestClient{
  constructor(base,appId,token){ this.baseUrl=base; this.appId=appId; this.token=token; }
  static isPat(t){ return typeof t==='string' && /^pat_[a-z0-9_\-]{16,}$/i.test(t.trim()); }
  request(method,route,body=null){
    return new Promise((res,rej)=>{
      let u; try{ u=new URL(route,this.baseUrl);}catch(e){return rej(new Error(`Bad URL ${route}`));}
      const payload=body==null?null:JSON.stringify(body);
      const req=https.request({ method, hostname:u.hostname, port:u.port||443, path:u.pathname+u.search, headers:{ Authorization:`Bearer ${this.token}`, 'Deriv-App-ID':this.appId, Accept:'application/json', ...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}) }, timeout:15000 }, r=>{
        let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{ d=JSON.parse(d);}catch(_){} res({status:r.statusCode,body:d}); });
      });
      req.on('timeout',()=>req.destroy(new Error('REST timeout'))); req.on('error',rej);
      if(payload) req.write(payload); req.end();
    });
  }
  get(r){return this.request('GET',r);} post(r,b){return this.request('POST',r,b);}
}

class DerivClient extends EventEmitter{
  constructor(cfg){
    super(); this.cfg=cfg; this.ws=null; this.connected=false; this.authorized=false;
    this._stopped=false; this._reconnecting=false; this._reconnectAttempt=0; this._reqId=0;
    this._pending=new Map(); this._subs=new Map(); this.balance=null; this.currency=cfg.currency;
    this.accountInfo=null; this.symbols=new Map();
    this._isPat=RestClient.isPat(cfg.apiToken);
    this._rest=this._isPat?new RestClient(cfg.restBaseUrl,cfg.appId,cfg.apiToken):null;
    this._targetAccountId=cfg.accountId||'';
  }
  _nextId(){ return ++this._reqId; }
  _legacyUrl(){ const s=this.cfg.legacyWsUrl.includes('?')?'&':'?'; return `${this.cfg.legacyWsUrl}${s}app_id=${encodeURIComponent(this.cfg.appId)}`; }
  _redact(u){ return String(u).replace(/([?&])(otp|app_id|token|auth)=[^&]+/gi,'$1$2=***'); }
  connect(){
    if(this.ws && (this.ws.readyState===WebSocket.OPEN||this.ws.readyState===WebSocket.CONNECTING)) return;
    if(!this.cfg.apiToken){ logger.error('API token empty'); this._stopped=true; return; }
    if(this._isPat) this._connectPat().catch(e=>{ logger.error('PAT connect:',e.message); this._schedReconnect(); });
    else this._openWs(this._legacyUrl());
  }
  async _connectPat(){
    const aid=await this._resolvePatAccountId();
    const route=`/trading/v1/options/accounts/${encodeURIComponent(aid)}/otp`;
    const res=await this._rest.post(route);
    if(res.status!==200){ const m=res.body?.errors?.[0]?.message||res.body?.message||JSON.stringify(res.body); throw new Error(`OTP ${res.status}: ${m}`); }
    const wsUrl=res.body?.data?.url; if(!wsUrl) throw new Error(`OTP missing url: ${JSON.stringify(res.body)}`);
    this._targetAccountId=aid;
    this.accountInfo={ loginid:aid, accountType:this.cfg.accountType, isVirtual:this.cfg.accountType!=='real', currency:this.cfg.currency };
    logger.info(`connecting → ${this._redact(wsUrl)}`); this._openWs(wsUrl);
  }
  async _resolvePatAccountId(){
    if(this._targetAccountId) return this._targetAccountId;
    for(const [m,r] of [['GET','/trading/v1/options/accounts'],['POST','/trading/v1/options/accounts/list']]){
      try{
        const res=m==='GET'?await this._rest.get(r):await this._rest.post(r,null);
        if(res.status>=200&&res.status<300){
          const arr=Array.isArray(res.body?.data)?res.body.data:Array.isArray(res.body?.accounts)?res.body.accounts:[];
          if(arr.length){ const d=arr.find(a=>String(a.account_type||'').toLowerCase()===this.cfg.accountType)||arr[0]; const id=d.account_id||d.loginid||d.id; if(id){ this.accountInfo={loginid:id,accountType:d.account_type||this.cfg.accountType,isVirtual:String(d.account_type||this.cfg.accountType).toLowerCase()!=='real',currency:d.currency||this.cfg.currency,balance:d.balance!=null?Number(d.balance):null}; return id; } }
        }
      }catch(e){ logger.debug(`PAT discovery ${m} ${r}:`,e.message); }
    }
    throw new Error('DERIV_ACCOUNT_ID required for PAT');
  }
  _openWs(url){
    try{ this.ws=new WebSocket(url,{handshakeTimeout:15000,headers:{'User-Agent':'DigitDifferFast/1.0'}});}catch(e){ logger.error('WS construct:',e.message); this._schedReconnect(); return; }
    this.ws.on('open',()=>this._onOpen()); this.ws.on('message',d=>this._onMsg(d)); this.ws.on('error',e=>this._onErr(e)); this.ws.on('close',(c,r)=>this._onClose(c,r));
    this.ws.on('unexpected-response',(_,res)=>{ logger.error('WS handshake:',res.statusCode,res.statusMessage); try{res.destroy();}catch(_){} this._schedReconnect(); });
  }
  _onOpen(){ logger.info('WS connected ✔'); this.connected=true; this._reconnecting=false; this._reconnectAttempt=0; this.emit('open'); if(this._isPat) this._markPatAuth(); else this._authLegacy(); }
  async _authLegacy(){
    try{ const res=await this._send({authorize:this.cfg.apiToken},20000); const a=res.authorize; this.authorized=true; this.balance=Number(a.balance); this.currency=a.currency||this.cfg.currency; this.accountInfo={loginid:a.loginid,email:a.email,isVirtual:!!a.is_virtual,accountType:a.account_type,currency:this.currency}; logger.info(`authorized ${a.loginid} (${this.accountInfo.isVirtual?'DEMO':'REAL'}) bal=${this.balance} ${this.currency}`); this.emit('authorized',this.accountInfo); }
    catch(e){ logger.error('authorize:',e.message); this.authorized=false; this._schedReconnect(); }
  }
  async _markPatAuth(){
    this.authorized=true; if(this.accountInfo?.balance!=null) this.balance=Number(this.accountInfo.balance); this.currency=this.accountInfo?.currency||this.cfg.currency;
    try{ const b=await this._send({balance:1},10000); if(b.balance){ this.balance=Number(b.balance.balance); this.currency=b.balance.currency||this.currency; } }catch(e){ logger.debug('balance skip:',e.message); }
    logger.info(`authorized ${this.accountInfo?.loginid||this._targetAccountId} via PAT bal=${this.balance??'?'} ${this.currency}`); this.emit('authorized',this.accountInfo||{loginid:this._targetAccountId,isVirtual:this.cfg.accountType!=='real'});
  }
  _onMsg(data){
    let msg; try{ msg=JSON.parse(data.toString());}catch{return;}
    if(msg.error){
      const code=msg.error.code||'Error', text=msg.error.message||code;
      const benign=new Set(['AlreadySubscribedOrLimit','ContractNotFound','BetExpired','TradingDurationNotAllowed']);
      (benign.has(code)?logger.debug:logger.error)(`api: ${code} - ${text} req=${msg.req_id||'?'}`);
      if(msg.req_id&&this._pending.has(msg.req_id)){ const p=this._pending.get(msg.req_id); clearTimeout(p.timer); this._pending.delete(msg.req_id); p.reject(new Error(text)); }
      if(['AuthorizationRequired','InvalidToken','InvalidAppID'].includes(code)) try{this.ws?.close();}catch(_){}
      return;
    }
    if(msg.req_id&&this._pending.has(msg.req_id)){ const p=this._pending.get(msg.req_id); clearTimeout(p.timer); this._pending.delete(msg.req_id); p.resolve(msg); return; }
    if(msg.subscription?.id&&this._subs.has(msg.subscription.id)){ const cb=this._subs.get(msg.subscription.id); try{cb(msg);}catch(e){logger.error('sub handler:',e.message);} return; }
    this.emit('message',msg);
  }
  _onErr(e){ logger.error('WS error:',e.message,e.code||''); this.emit('error',e); }
  _onClose(code,reason){
    const rs=(()=>{try{return reason?.toString()||'';}catch{return '';}})();
    logger.warn(`WS closed code=${code} ${rs||''}`); const was=this.authorized; this.connected=false; this.authorized=false;
    for(const[,p] of this._pending){ clearTimeout(p.timer); p.reject(new Error('Connection closed')); } this._pending.clear(); this._subs.clear();
    this.emit('close',code,reason,was); if(!this._stopped) this._schedReconnect();
  }
  _schedReconnect(){
    if(this._stopped||this._reconnecting) return; this._reconnecting=true; this._reconnectAttempt++;
    const base=Math.min(this.cfg.reconnect.initialDelayMs*Math.pow(this.cfg.reconnect.backoffFactor,this._reconnectAttempt-1),this.cfg.reconnect.maxDelayMs);
    const delay=base+Math.random()*this.cfg.reconnect.jitterMs;
    logger.info(`reconnect #${this._reconnectAttempt} in ${(delay/1000).toFixed(1)}s`);
    setTimeout(()=>{ this._reconnecting=false; this.connect(); },delay);
  }
  _send(payload,timeoutMs=30000){
    return new Promise((res,rej)=>{
      if(!this.ws||this.ws.readyState!==WebSocket.OPEN) return rej(new Error('Not connected'));
      const id=this._nextId();
      const timer=setTimeout(()=>{ if(this._pending.has(id)){ this._pending.delete(id); rej(new Error('Request timeout')); } },timeoutMs);
      this._pending.set(id,{resolve:res,reject:rej,timer});
      try{ this.ws.send(JSON.stringify({...payload,req_id:id})); }catch(e){ clearTimeout(timer); this._pending.delete(id); rej(e); }
    });
  }
  subscribe(payload,cb,timeoutMs=30000){
    return new Promise((res,rej)=>{
      if(!this.ws||this.ws.readyState!==WebSocket.OPEN) return rej(new Error('Not connected'));
      const id=this._nextId();
      const timer=setTimeout(()=>{ if(this._pending.has(id)){ this._pending.delete(id); rej(new Error('Subscribe timeout')); } },timeoutMs);
      this._pending.set(id,{ resolve:msg=>{ const sid=msg.subscription?.id; if(!sid) return rej(new Error('No sub id')); this._subs.set(sid,cb); res(sid); }, reject:rej, timer });
      try{ this.ws.send(JSON.stringify({...payload,subscribe:1,req_id:id})); }catch(e){ clearTimeout(timer); this._pending.delete(id); rej(e); }
    });
  }
  forget(subId){ if(!subId) return Promise.resolve(); this._subs.delete(subId); if(!this.ws||this.ws.readyState!==WebSocket.OPEN) return Promise.resolve(); return this._send({forget:subId},8000).catch(e=>logger.debug('forget:',e.message)); }
  stop(){ this._stopped=true; try{this.ws?.close();}catch(_){} }
  symbolField(){ return this._isPat?'underlying_symbol':'symbol'; }
}

// ── 6. MARKET DATA — single asset, last-digit only ────────────────────
const KNOWN_PIP_SIZES=Object.freeze({ R_10:3,R_25:3,R_50:4,R_75:4,R_100:2,'1HZ10V':2,'1HZ25V':2,'1HZ50V':2,'1HZ75V':2,'1HZ100V':2,RDBULL:4,RDBEAR:4 });

function quoteToDigit(quote,pipSize=2){
  const n=Number(quote); if(!Number.isFinite(n)) return null;
  const pip=Number.isInteger(pipSize)&&pipSize>=1&&pipSize<=8?pipSize:2;
  let s=Math.abs(n).toString(); if(s.indexOf('e')!==-1) s=Math.abs(n).toFixed(8);
  const dot=s.indexOf('.'); const frac=dot<0?'':s.slice(dot+1); const padded=frac.padEnd(pip,'0'); const d=Number(padded.charAt(pip-1)); return Number.isInteger(d)?d:null;
}

class MarketDataManager extends EventEmitter{
  constructor(client){
    super(); this.client=client; this.lastTick=null; this.lastDigit=null; this.pip=null; this.subId=null;
    this.pip=KNOWN_PIP_SIZES[client.cfg?.asset] ?? KNOWN_PIP_SIZES[CONFIG.asset] ?? 4;
    client.on('close',()=>{ this.subId=null; });
  }
  pipSize(symbol){
    if(Number.isFinite(this.pip)) return this.pip;
    const raw=Number(this.client.symbols.get(symbol)?.pip_size);
    if(Number.isFinite(raw)&&raw>=1&&raw<=8){ this.pip=raw; return raw; }
    return 2;
  }
  async loadSymbols(){
    try{
      const res=await this.client._send({active_symbols:'full'},15000);
      for(const s of res.active_symbols||[]){ const k=s.underlying_symbol||s.symbol; if(k) this.client.symbols.set(k,s); }
      const sym=CONFIG.asset; const raw=Number(this.client.symbols.get(sym)?.pip_size);
      if(Number.isFinite(raw)&&raw>=1&&raw<=8) this.pip=raw; else if(KNOWN_PIP_SIZES[sym]) this.pip=KNOWN_PIP_SIZES[sym];
      logger.info(`symbol ${sym} pip_size=${this.pip}`);
    }catch(e){ logger.warn('loadSymbols:',e.message); }
  }
  async subscribe(symbol){
    if(this.subId) return this.subId;
    const pip=this.pipSize(symbol);
    this.subId=await this.client.subscribe({ticks:symbol},msg=>{
      const t=msg.tick; if(!t) return;
      const quote=Number(t.quote); const digit=quoteToDigit(quote,pip);
      if(digit==null) return;
      this.lastTick={ epoch:Number(t.epoch), quote, digit };
      this.lastDigit=digit;
      this.emit('tick',symbol,this.lastTick);
    });
    logger.info(`subscribed ticks: ${symbol} sub=${this.subId} pip=${pip}`);
    return this.subId;
  }
}

// ── 7. TRADE EXECUTOR ──────────────────────────────────────────────────
class TradeExecutor extends EventEmitter{
  constructor(client,cfg){ super(); this.client=client; this.cfg=cfg; this.open=new Map(); this._settled=new Set(); }
  async buy(symbol,digit,stake){
    stake=Math.max(this.cfg.minStake,Math.min(this.cfg.maxStake,Number(stake)));
    const k=this.client.symbolField();
    const pres=await this.client._send({ proposal:1, amount:stake, basis:'stake', contract_type:'DIGITDIFF', currency:this.cfg.currency, duration:this.cfg.durationTicks, duration_unit:'t', barrier:String(digit), [k]:symbol },15000);
    const p=pres.proposal; if(!p?.id) throw new Error('No proposal id');
    const ask=Number(p.ask_price||stake), payout=Number(p.payout||0);
    const bres=await this.client._send({buy:p.id,price:ask},15000);
    const b=bres.buy; if(!b?.contract_id) throw new Error('Buy no contract_id');
    const info={ contractId:b.contract_id, symbol, digit, stake:ask, buyPrice:Number(b.buy_price||ask), payout:Number(b.payout||payout), buyTime:Number(b.purchase_time||Date.now()/1000), durationTicks:this.cfg.durationTicks, balanceAfter:b.balance_after!=null?Number(b.balance_after):null };
    this.open.set(info.contractId,info);
    logger.info(`bought #${info.contractId} ${symbol} differs ${digit} stake=${ask} payout=${info.payout}`);
    try{ const sid=await this.client.subscribe({proposal_open_contract:1,contract_id:info.contractId},m=>this._onUpdate(m,info)); info.subId=sid; }catch(e){ logger.warn(`sub settle #${info.contractId} fail: ${e.message} — watchdog will poll`); }
    this.emit('open',info); return info;
  }
  settleFromContract(info,c){
    const cid=c.contract_id||info.contractId;
    if(this._settled.has(cid)) return null;
    if(c.status!=='won'&&c.status!=='lost') return null;
    this._settled.add(cid); if(this._settled.size>5000){ const f=this._settled.values().next().value; if(f!=null) this._settled.delete(f); }
    const fin={ ...info, contractId:cid, status:c.status, profit:Number(c.profit||0), sellPrice:Number(c.sell_price||0), sellTime:Number(c.sell_time||Date.now()/1000) };
    this.open.delete(cid); this.emit('result',fin); return fin;
  }
  _onUpdate(msg,info){
    const c=msg.proposal_open_contract; if(!c) return;
    const fin=this.settleFromContract(info,c);
    if(fin){ const sid=msg.subscription?.id||info.subId; if(sid) this.client.forget(sid).catch(()=>{}); }
    else this.emit('update',{...info,status:c.status,profit:Number(c.profit||0)});
  }
  count(){ return this.open.size; }
}

// ── 8. STATS (minimal + consecutive-loss tracking x2..x7 + WR) ──────
class StatisticsManager{
  constructor(saved=null){
    this.trades=[]; this.overallProfit=0; this.todayCount=0; this._todayStr=null;
    this.wins=0; this.losses=0; this.unknowns=0;
    this.currentLossStreak=0; this.maxLossStreak=0;
    this.lossStreakEvents={ x2:0, x3:0, x4:0, x5:0, x6:0, x7:0 };
    if(saved) this.load(saved);
  }
  load(s){
    if(Array.isArray(s.trades)) this.trades=s.trades;
    this.overallProfit=Number(s.overallProfit||0);
    // recover wins/losses if missing (backwards compat: derive from trades)
    if(Number.isFinite(s.wins) && Number.isFinite(s.losses)){
      this.wins=Number(s.wins); this.losses=Number(s.losses); this.unknowns=Number(s.unknowns||0);
    } else if(Array.isArray(s.trades)){
      let w=0,l=0,u=0; for(const t of s.trades){ if(t.status==='won') w++; else if(t.status==='lost') l++; else if(t.status==='unknown') u++; }
      this.wins=w; this.losses=l; this.unknowns=u;
    } else { this.wins=0; this.losses=0; this.unknowns=0; }
    this.currentLossStreak=Number(s.currentLossStreak||0);
    this.maxLossStreak=Number(s.maxLossStreak||0);
    this.lossStreakEvents={
      x2:Number(s.lossStreakEvents?.x2||0),
      x3:Number(s.lossStreakEvents?.x3||0),
      x4:Number(s.lossStreakEvents?.x4||0),
      x5:Number(s.lossStreakEvents?.x5||0),
      x6:Number(s.lossStreakEvents?.x6||0),
      x7:Number(s.lossStreakEvents?.x7||0),
    };
  }
  serialize(){
    return {
      trades:this.trades.slice(-3000),
      overallProfit:this.overallProfit,
      wins:this.wins, losses:this.losses, unknowns:this.unknowns,
      currentLossStreak:this.currentLossStreak,
      maxLossStreak:this.maxLossStreak,
      lossStreakEvents:{ ...this.lossStreakEvents },
    };
  }
  winRate(){
    const decided=this.wins+this.losses;
    return decided ? (this.wins/decided*100) : 0;
  }
  record(t){
    const d=new Date((t.sellTime||t.buyTime||Date.now()/1000)*1000); const date=d.toISOString().slice(0,10);
    if(this._todayStr!==date){ this._todayStr=date; this.todayCount=0; }
    this.todayCount++;
    const rec={...t,date,timestamp:Date.now()};
    this.trades.push(rec); this.overallProfit+=Number(rec.profit||0);
    if(t.status==='won') this.wins+=1;
    else if(t.status==='lost') this.losses+=1;
    else if(t.status==='unknown') this.unknowns+=1;
    // ── consecutive-loss tracking (x2..x7) — fast, no heavy compute ──
    if(t.status==='lost'){
      this.currentLossStreak+=1;
      this.maxLossStreak=Math.max(this.maxLossStreak,this.currentLossStreak);
      if(this.currentLossStreak===2) this.lossStreakEvents.x2+=1;
      if(this.currentLossStreak===3) this.lossStreakEvents.x3+=1;
      if(this.currentLossStreak===4) this.lossStreakEvents.x4+=1;
      if(this.currentLossStreak===5) this.lossStreakEvents.x5+=1;
      if(this.currentLossStreak===6) this.lossStreakEvents.x6+=1;
      if(this.currentLossStreak===7) this.lossStreakEvents.x7+=1;
    } else if(t.status==='won'){
      this.currentLossStreak=0;
    } // 'unknown' does not affect streak
    return rec;
  }
}

// ── 9. BOT — tick-driven, no analysis ─────────────────────────────────
class TradingBot{
  constructor(){
    this.cfg=CONFIG;
    this.client=new DerivClient(this.cfg);
    this.market=new MarketDataManager(this.client);
    this.exec=new TradeExecutor(this.client,this.cfg);
    this.stats=new StatisticsManager();
    this.lastBalance=null; this.startBalance=null;
    this._buying=false; this.lastTradeAt=0; this.stopped=false;
    this._watchdog=null; this._watchdogPoll=null;
    this._dayStartStr=null; this._dayStartBal=null; this._todayPL=0; this._todayTrades=0;
  }

  // ── Martingale stake: base * step^effectiveLosses, capped ─────────
  // filter = losses to absorb at base before scaling starts
  // effective = max(0, lossStreak - filter)
  _getStake(){
    const base = Number(this.cfg.stake);
    if(!this.cfg.martingaleEnabled) return Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, base));
    const step = Number(this.cfg.martingaleStep);
    if(!Number.isFinite(step) || step <= 1) return Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, base));
    const n = this.stats.currentLossStreak || 0;
    const filter = Math.max(0, Number(this.cfg.martingaleFilter) || 0);
    const effective = Math.max(0, n - filter);
    const cap = this.cfg.martingaleMaxSteps > 0 ? Math.min(effective, this.cfg.martingaleMaxSteps) : effective;
    let stake = effective === 0 ? base : base * Math.pow(step, cap);
    const hardCap = Math.min(this.cfg.maxStake, this.cfg.martingaleMaxStake || this.cfg.maxStake);
    stake = Math.max(this.cfg.minStake, Math.min(hardCap, Number(stake.toFixed(2))));
    const bal = this.lastBalance ?? this.client.balance ?? Infinity;
    if(Number.isFinite(bal) && stake > bal) stake = Math.max(this.cfg.minStake, Math.min(hardCap, bal));
    return stake;
  }
  _martingaleLabel(){
    if(!this.cfg.martingaleEnabled) return 'OFF';
    const f = Math.max(0, Number(this.cfg.martingaleFilter)||0);
    return `ON step=${this.cfg.martingaleStep} filter=${f} maxSteps=${this.cfg.martingaleMaxSteps} cap=${this.cfg.martingaleMaxStake}`;
  }

  async start(){
    logger.info('===== Digit Differ FAST bot starting =====');
    logger.info(`asset=${this.cfg.asset} stake=${this.cfg.stake} duration=${this.cfg.durationTicks}t cooldown=${this.cfg.tradeCooldownMs}ms`);
    logger.info(`martingale=${this._martingaleLabel()} | streak x2..x7 tracking ON`);
    if(!this.cfg.apiToken){ logger.error('API token missing'); process.exit(1); }
    this._loadState();
    this.client.on('authorized',i=>this._onAuth(i));
    this.client.on('close',(c,r,w)=>this._onDisc(c,r,w));
    this.exec.on('open',t=>this._onOpen(t));
    this.exec.on('result',t=>this._onResult(t));
    this.market.on('tick',(sym,tick)=>this._onTick(sym,tick));
    process.on('SIGINT',()=>this.stop('SIGINT')); process.on('SIGTERM',()=>this.stop('SIGTERM'));
    process.on('uncaughtException',e=>{ logger.error('uncaught:',e); this._save('uncaught'); });
    process.on('unhandledRejection',e=>{ logger.error('unhandled:',e); this._save('unhandled'); });
    this.client.connect();
  }

  async _onAuth(info){
    this.startBalance=this.startBalance??this.client.balance??0;
    this.lastBalance=this.lastBalance??this.client.balance??this.startBalance;
    this._dayStartStr=new Date().toISOString().slice(0,10);
    this._dayStartBal=this.lastBalance;
    this._todayPL=0; this._todayTrades=0;
    logger.info(`start balance ${this.startBalance} ${this.currency()}`);
    await this.market.loadSymbols();
    const mg = this.cfg.martingaleEnabled ? `🧮 Martingale: <b>ON</b> step ${this.cfg.martingaleStep} filter ${this.cfg.martingaleFilter} (maxSteps ${this.cfg.martingaleMaxSteps}, cap ${this.cfg.martingaleMaxStake})` : `🧮 Martingale: <b>OFF</b>`;
    const st = `❌ Streak: cur ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak} | x2=${this.stats.lossStreakEvents.x2} x3=${this.stats.lossStreakEvents.x3} x4=${this.stats.lossStreakEvents.x4} x5=${this.stats.lossStreakEvents.x5} x6=${this.stats.lossStreakEvents.x6} x7=${this.stats.lossStreakEvents.x7}`;
    const wr = this.stats.winRate().toFixed(1);
    const total = this.stats.wins + this.stats.losses + this.stats.unknowns;
    const wrLine = `📊 Trades: ${total} (✅${this.stats.wins} ❌${this.stats.losses}${this.stats.unknowns?` ❓${this.stats.unknowns}`:''}) | WR ${wr}%`;
    telegram.send(
      `🤖 <b>FAST x2Differ</b>\n`+
      `👤 <code>${htmlEscape(info.loginid||'?')}</code> ${info.isVirtual?'🟡 DEMO':'🔴 REAL'}\n`+
      `💰 ${Number(this.client.balance??0).toFixed(2)} ${this.currency()}\n`+
      `📊 Asset: <code>${CONFIG.asset}</code> | DIGITDIFF differs last digit | ${CONFIG.durationTicks}t\n`+
      `💵 Base stake: ${CONFIG.stake.toFixed(2)} | next: ${this._getStake().toFixed(2)} | cooldown ${CONFIG.tradeCooldownMs}ms\n`+
      `${mg}\n`+
      `${st}\n`+
      `${wrLine}\n`+
      `💼 Overall: ${money(this.stats.overallProfit,this.currency())}\n`+
      `🕒 ${utcTs()}`
    );
    await this.market.subscribe(CONFIG.asset);
  }
  _onDisc(code,reason,was){ telegram.send(`⚠️ <b>FAST x2Differ disconnected</b> code=${code} wasAuth=${was?'yes':'no'} — reconnecting…`); }

  // ── Hot path: called on every tick ──────────────────────────────────
  async _onTick(symbol,tick){
    if(this.stopped||!this.client.authorized) return;
    if(this.exec.count()>=this.cfg.maxOpenTrades) return;
    if(this._buying) return;
    if(Date.now()-this.lastTradeAt < this.cfg.tradeCooldownMs) return;
    const digit=tick.digit;
    if(!Number.isInteger(digit)||digit<0||digit>9) return;

    // Lightweight daily guards (no heavy compute, just counters)
    if(this.cfg.dailyMaxTrades>0 && this._todayTrades>=this.cfg.dailyMaxTrades){ logger.debug('dailyMaxTrades hit'); return; }
    if(this.cfg.dailyMaxLoss>0 && this._todayPL <= -Math.abs(this.cfg.dailyMaxLoss)){ logger.warn('dailyMaxLoss halt'); return; }
    if(this.cfg.dailyMaxProfit>0 && this._todayPL >= this.cfg.dailyMaxProfit){ logger.warn('dailyMaxProfit halt'); return; }

    // Day rollover
    const today=new Date().toISOString().slice(0,10);
    if(this._dayStartStr!==today){ this._dayStartStr=today; this._dayStartBal=this.lastBalance??this.client.balance??0; this._todayPL=0; this._todayTrades=0; }

    const stake = this._getStake();
    if(!Number.isFinite(stake) || stake < this.cfg.minStake){
      logger.debug(`stake ${stake} invalid — skipping`);
      return;
    }
    const bal = this.lastBalance ?? this.client.balance;
    if(Number.isFinite(bal) && stake > bal && bal >= this.cfg.minStake){
      logger.warn(`stake ${stake.toFixed(2)} > balance ${bal.toFixed(2)} — skipping`);
      return;
    }
    this._buying=true;
    try{
      const trade=await this.exec.buy(symbol,digit,stake);
      this.lastTradeAt=Date.now();
      this._todayTrades++;
      if(this.cfg.martingaleEnabled && this.stats.currentLossStreak>0){
        const f = Math.max(0, Number(this.cfg.martingaleFilter)||0);
        const eff = Math.max(0, this.stats.currentLossStreak - f);
        const capped = this.cfg.martingaleMaxSteps>0 ? Math.min(eff, this.cfg.martingaleMaxSteps) : eff;
        logger.info(`martingale stake=${stake.toFixed(2)} (base ${this.cfg.stake} × ${this.cfg.martingaleStep}^${capped} | streak ${this.stats.currentLossStreak} filter ${f} eff ${eff})`);
      }
      this._startWatchdog(trade.contractId);
    }catch(e){
      const m=String(e.message||'');
      if(!/AlreadySubscribed|Not connected|timeout/i.test(m)) logger.error(`buy fail d${digit} stake=${stake}:`,m);
    }finally{ this._buying=false; }
  }

  _onOpen(t){
    this._startWatchdog(t.contractId);
    const mgInfo = this.cfg.martingaleEnabled ? ` | MG x${this.stats.currentLossStreak}` : '';
    telegram.send(
      `🟢 <b>Fast x2Differ TRADE OPEN</b> #${t.contractId} <code>${t.symbol}</code> differs <b>${t.digit}</b>${mgInfo}\n`+
      `💵 ${t.stake.toFixed(2)} → payout ${t.payout.toFixed(2)} ${this.currency()} | ${t.durationTicks}t | next stake ${this._getStake().toFixed(2)}\n`+
      `🕒 ${utcTs()}`
    );
  }
  _onResult(t){
    const rec=this.stats.record(t);
    const profit=Number(t.profit||0);
    if(t.balanceAfter!=null) this.lastBalance=Number(t.balanceAfter)+profit+Number(t.stake||0);
    else this.lastBalance=(this.lastBalance??this.client.balance??0)+profit;
    this._todayPL+=profit;
    this._clearWatchdog();
    const won=t.status==='won';
    const e=this.stats.lossStreakEvents;
    const total = this.stats.wins + this.stats.losses + this.stats.unknowns;
    const wr = this.stats.winRate().toFixed(1);
    const tradesLine = `📊 Trades: ${total} (W:${this.stats.wins} L:${this.stats.losses}${this.stats.unknowns?` ❓${this.stats.unknowns}`:''}) | WR ${wr}%`;
    const streakLine=`x2=${e.x2} x3=${e.x3} x4=${e.x4} x5=${e.x5} x6=${e.x6} x7=${e.x7} (Max: ${this.stats.maxLossStreak})`;
    const mgLine=this.cfg.martingaleEnabled ? `🧮 Martingale: ${this._getStake().toFixed(2)} (mul: ${this.cfg.martingaleStep} filter: ${this.cfg.martingaleFilter})` : '';
    telegram.send(
      `${won?'✅ WIN':'❌ LOSS'} <b>#${t.contractId}</b> ${t.symbol} differs ${t.digit} | ${money(profit,this.currency())}\n`+
      `${tradesLine}\n`+
      `📅 Today: ${this._todayTrades} trades P/L ${money(this._todayPL,this.currency())} | Overall ${money(this.stats.overallProfit,this.currency())}\n`+
      `${streakLine}\n`+
      `${mgLine}\n`+
      `🕒 ${utcTs()}`
    );
    logger.info(`${won?'WIN':'LOSS'} #${t.contractId} P/L=${profit.toFixed(2)} | ${tradesLine} | ${streakLine} | overall=${this.stats.overallProfit.toFixed(2)}`);
    this._save('after-trade');
  }

  // ── Watchdog (poll if settlement subscription silent) ─────────────────
  _startWatchdog(cid){ this._clearWatchdog(); this._watchdog=setTimeout(()=>this._poll(cid), this.cfg.tradeWatchdogMs); }
  _clearWatchdog(){ if(this._watchdog) clearTimeout(this._watchdog); if(this._watchdogPoll) clearTimeout(this._watchdogPoll); this._watchdog=null; this._watchdogPoll=null; }
  async _poll(cid){
    this._clearWatchdog();
    const open=[...this.exec.open.values()]; const t=open.find(x=>Number(x.contractId)===Number(cid))||open[0]; if(!t) return;
    t._polls=(t._polls||0)+1;
    logger.warn(`watchdog #${t.contractId} open ${this.cfg.tradeWatchdogMs/1000}s poll #${t._polls}`);
    if(!this.client.authorized||!this.client.connected){ logger.warn('watchdog: offline, defer to reconnect'); return; }
    try{
      const res=await this.client._send({proposal_open_contract:1,contract_id:t.contractId},15000);
      const c=res?.proposal_open_contract;
      if(c){ const fin=this.exec.settleFromContract(t,c); if(fin){ logger.info(`watchdog settled #${fin.contractId} ${fin.status} ${fin.profit}`); return; } }
    }catch(e){ logger.warn(`watchdog poll #${t.contractId}: ${e.message}`); }
    if(t._polls>=3){ logger.error(`watchdog unresolved #${t.contractId} → UNKNOWN`); this.stats.record({...t,status:'unknown',profit:0,sellTime:Date.now()/1000}); this.exec.open.delete(t.contractId); this._save('unknown'); return; }
    this._watchdogPoll=setTimeout(()=>this._poll(t.contractId),15000);
  }

  _save(reason){ try{ const f=this.cfg.stateFile, tmp=f+'.tmp'; fs.writeFileSync(tmp,JSON.stringify({ version:1, savedAt:new Date().toISOString(), reason, startBalance:this.startBalance, lastBalance:this.lastBalance, stats:this.stats.serialize() },null,2)); fs.renameSync(tmp,f); }catch(e){ logger.warn('save fail:',e.message);} }
  _loadState(){ const f=this.cfg.stateFile; if(!fs.existsSync(f)) return; try{ const d=JSON.parse(fs.readFileSync(f,'utf8')); this.startBalance=d.startBalance??null; this.lastBalance=d.lastBalance??null; this.stats=new StatisticsManager(d.stats||d); const e=this.stats.lossStreakEvents; const wr=this.stats.winRate().toFixed(1); const tot=this.stats.wins+this.stats.losses+this.stats.unknowns; logger.info(`state restored overall=${this.stats.overallProfit.toFixed(2)} trades ${tot} (✅${this.stats.wins} ❌${this.stats.losses}) WR ${wr}% streak cur=${this.stats.currentLossStreak} max=${this.stats.maxLossStreak} x2=${e.x2} x3=${e.x3} x4=${e.x4} x5=${e.x5} x6=${e.x6} x7=${e.x7}`);}catch(e){ logger.warn('load state:',e.message);} }
  currency(){ return this.client.currency||this.cfg.currency; }
  stop(sig){ if(this.stopped) return; this.stopped=true; logger.info(`stopping ${sig}`); telegram.send(`🛑 <b>FAST x2Differ stopped</b> ${htmlEscape(sig)} | Overall ${money(this.stats.overallProfit,this.currency())}`); this._clearWatchdog(); this._save('shutdown'); this.client.stop(); setTimeout(()=>process.exit(0),2000); }
}

// ── BOOT ────────────────────────────────────────────────────────────────
function banner(){ console.log('╔════════════════════════════════════════════╗'); console.log('║  Digit Differ FAST — single asset, no filter ║'); console.log('║  Barrier = current last digit (DIGITDIFF)    ║'); console.log('╚════════════════════════════════════════════╝'); }
async function main(){
  banner();
  if(!CONFIG.apiToken){ console.error('DERIV_API_TOKEN missing'); process.exit(1); }
  console.log(CONFIG.telegram.enabled?'✅ Telegram: ON':'ℹ️ Telegram: OFF');
  console.log(`   asset=${CONFIG.asset} stake=${CONFIG.stake} duration=${CONFIG.durationTicks}t cooldown=${CONFIG.tradeCooldownMs}ms`);
  console.log(`   martingale=${CONFIG.martingaleEnabled ? `ON step=${CONFIG.martingaleStep} filter=${CONFIG.martingaleFilter} maxSteps=${CONFIG.martingaleMaxSteps} cap=${CONFIG.martingaleMaxStake}` : 'OFF'}`);
  const bot=new TradingBot(); await bot.start();
}
main().catch(e=>{ console.error('fatal:',e); process.exit(1); });
