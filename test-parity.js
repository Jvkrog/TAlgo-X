const L = process.env.L;
const { replayBiasHedge, createLegKit } = require(L + "/backtestDualHedge");
const { createBiasHedgeController } = require(L + "/dualBiasHedgeController");
const { toHA } = require(L + "/indicators");
const { createBandStepper } = require(L + "/dynamicBandReader");
const { setEmitSuppressed } = require(L + "/eventBridge");
setEmitSuppressed(true);
const IST = 5.5 * 3600e3;
function rng(seed){ let s=seed>>>0; return ()=> (s=(s*1664525+1013904223)>>>0)/4294967296; }
function mk(seed, days){
  const r=rng(seed), out=[]; let p=300;
  const start=Date.UTC(2026,5,1)-IST;   // 2026-06-01 00:00 IST
  for(let d=0;d<days;d++) for(let m=9*60;m<23*60+40;m++){
    const o=p; p=Math.max(50,p+(r()-0.5)*2+(r()-0.5)*(d%5==0?3:0)); const hi=Math.max(o,p)+r()*.3, lo=Math.min(o,p)-r()*.3;
    out.push({date:new Date(start+d*864e5+m*6e4),open:o,high:hi,low:lo,close:p,volume:1});
  }
  return out;
}
const dayKey=d=>new Date(d.getTime()+IST).toISOString().slice(0,10);
function agg(c, minutes){ const out=[]; let cur=null;
  for(const k of c){ const ms=k.date.getTime(); const b=Math.floor((ms+IST)/(minutes*6e4))*minutes*6e4-IST;
    if(!cur||cur.t!==b){ if(cur)out.push(cur.bar); cur={t:b,bar:{date:new Date(b),open:k.open,high:k.high,low:k.low,close:k.close,volume:1}}; }
    else { cur.bar.high=Math.max(cur.bar.high,k.high); cur.bar.low=Math.min(cur.bar.low,k.low); cur.bar.close=k.close; } }
  if(cur)out.push(cur.bar); return out; }
function daily(c){ const out=[]; let cur=null; for(const k of c){ const dk=dayKey(k.date); if(!cur||cur.dk!==dk){ if(cur)out.push(cur.bar); cur={dk,bar:{date:new Date(Math.floor((k.date.getTime()+IST)/864e5)*864e5-IST),open:k.open,high:k.high,low:k.low,close:k.close,volume:1}}; } else { cur.bar.high=Math.max(cur.bar.high,k.high); cur.bar.low=Math.min(cur.bar.low,k.low); cur.bar.close=k.close; } } if(cur)out.push(cur.bar); return out; }
const TFM={ "5m":5,"15m":15,"30m":30,"1h":60 };
const ctx=(side)=>({tgPrefix:"T_"+side,symbol:"TEST",token:1,lots:1,lotMult:100});
const hm=m=>({h:Math.floor(m/60),m:m%60});
async function one(seed,tf,unwind){
  const candles=mk(seed,+process.env.DAYS||14), tradeFrom=candles[0].date.getTime()+(+process.env.DAYS||14)*864e5/2;
  const dailyBars=daily(candles), bandBars=agg(candles,TFM[tf]); const eod=(tf==="30m"||tf==="1h")?{h:23,m:0}:{h:23,m:15};
  const ref=await replayBiasHedge({longCtx:ctx("LONG"),shortCtx:ctx("SHORT"),candles,tradeFromMs:tradeFrom,dailyBars,bandBars,bandStep:1.5,bandTimeframe:tf,unwindMode:unwind,eodHour:eod.h,eodMinute:eod.m,verbose:false});
  // controller side
  const { barEndMs } = require(L + "/backtestDualHedge");
  const stats={entries:{LONG:0,SHORT:0},coreDays:{LONG:0,SHORT:0},hedgeEntries:0,hedgeUnwinds:0,noBiasDays:0,exits:{eod:0,bandUnwind:0,backtestEnd:0}};
  const kit=createLegKit({longCtx:ctx("LONG"),shortCtx:ctx("SHORT"),startDate:candles[0].date,slip:0,log:()=>{},stats});
  const dailyHA=toHA(dailyBars).map(b=>({dk:dayKey(b.date),color:b.close>b.open?"green":b.close<b.open?"red":null}));
  const stepper=createBandStepper(1.5); const bars=bandBars.map(b=>({b,end:barEndMs(b,tf)}));
  let now={ms:0,dk:""}; let bp=0, bcol=null;
  const dailyReader={getLatest:async()=>{ let c=null; for(const h of dailyHA){ if(h.dk<now.dk) c=h.color; else break; } return c?{color:c}:null; }};
  const bandReader={getLatest:async()=>{ while(bp<bars.length&&bars[bp].end<=now.ms){ stepper.push(bars[bp].b); bcol=stepper.state().color; bp++; } return bcol?{color:bcol}:null; }};
  let px=0;
  const ctl=createBiasHedgeController({long:kit.long,short:kit.short,dailyReader,bandReader,
    enterLeg:async(leg,role,reason)=>{await kit.enterLeg(leg,px,reason,role);return true;},
    exitLeg:async(leg,reason)=>{await kit.exitLeg(leg,px,reason);return true;},
    clock:()=>{const t=new Date(now.ms+IST); return {today:now.dk,hours:t.getUTCHours(),minutes:t.getUTCMinutes()};},
    entryHour:10,entryMinute:0,eodHour:eod.h,eodMinute:eod.m,unwindMode:unwind});
  for(const cn of candles){ const ms=cn.date.getTime(); if(ms<tradeFrom) continue; now={ms,dk:dayKey(cn.date)}; kit.clockBox.date=cn.date; px=cn.open; await ctl.tick(); }
  const fmt=t=>[t.leg,t.entry_time,t.entry_price,t.exit_time,t.exit_price,t.pnl??t.net_pnl].join("|");
  const A=ref.trades.map(fmt), B=kit.tradesFrom(tradeFrom).trades.map(fmt);
  const ok=JSON.stringify(A)===JSON.stringify(B);
  console.log(`${ok?"OK  ":"FAIL"} seed ${seed} ${tf} ${unwind} trades ref=${A.length} ctl=${B.length}`);
  if(!ok){ console.log(A.slice(0,3),B.slice(0,3)); process.exitCode=1; }
  return A.length;
}
(async()=>{ let n=0; for(const seed of (process.env.SEEDS||"1").split(",").map(Number)) for(const tf of ["15m","1h"]) for(const u of ["BAND_FLIP","EOD_ONLY"]) n+=await one(seed,tf,u); console.log("total trades",n); process.exit(process.exitCode||0); })();
