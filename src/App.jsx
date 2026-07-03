import { useState, useEffect, useMemo, useCallback } from "react";

// ── CONTRACTS ──────────────────────────────────────────────
const POOLS = {
  tPool: { label: "T-Pool", color: "#26A17B", token: "USDT", decimals: 6,  address: "0x7C348b70F640B47b64ecDb154960D337ce7a98B4" },
  cPool: { label: "C-Pool", color: "#2775CA", token: "USDC", decimals: 6,  address: "0x0578E5EA652C62DB20F4475F685A4b587314A30f" },
  sPool: { label: "S-Pool", color: "#8B5CF6", token: "USDS", decimals: 18, address: "0xC94fbB2C1DA52F8561A829a4838f117DD7316F54" },
  pPool: { label: "P-Pool", color: "#0070F3", token: "PYUSD",decimals: 6,  address: "0x7Dd6979749b60C60eaaa55e4A50e732DAbc5DdD3" },
};
const POOL_BY_ADDR = Object.fromEntries(
  Object.entries(POOLS).map(([k,v]) => [v.address.toLowerCase(), { key: k, ...v }])
);

// ── SP SCORING: 1 SP per $100 volume ──────────────────────
function calcSP(volumeUSD) { return Math.floor(volumeUSD / 100); }

// Extract USD volume from tx input data
// Stabilizer swap passes amounts as uint256 in input bytes
// For stablecoins we treat 1 token = $1
function extractVolume(tx, poolKey) {
  try {
    const pool = POOLS[poolKey];
    const input = tx.input || "";
    if (input.length < 10) return 0;
    // Amount is usually first uint256 param (bytes 10–74)
    const hex = input.slice(10, 74);
    if (!hex || hex.length < 64) return 0;
    const raw = BigInt("0x" + hex);
    const divisor = BigInt(10 ** pool.decimals);
    const amount = Number(raw / divisor);
    return Math.min(amount, 10_000_000); // cap at $10M to filter bad parses
  } catch { return 0; }
}

// Classify tx by method selector
const METHOD_TYPE = {
  "0xfe029156": "swap",
  "0x6bf08450": "swap",
  "0x68ffa1a8": "deposit",
  "0x46f66e42": "deposit",
  "0xe8eda9df": "deposit",
  "0xb6b55f25": "deposit",
  "0x349d8b48": "claim",
  "0x0a7c4960": "claim",
};
function getTxType(tx) {
  const mid = (tx.methodId || tx.input?.slice(0,10) || "").toLowerCase();
  return METHOD_TYPE[mid] || null;
}

// ── TIERS ──────────────────────────────────────────────────
const TIERS = [
  { name: "Diamond", icon: "💎", minSP: 1000, color: "#a5f3fc" },
  { name: "Gold",    icon: "🥇", minSP: 200,  color: "#fbbf24" },
  { name: "Silver",  icon: "🥈", minSP: 50,   color: "#94a3b8" },
  { name: "Bronze",  icon: "🥉", minSP: 0,    color: "#b45309" },
];
function getTier(sp) { return TIERS.find(t => sp >= t.minSP) || TIERS[TIERS.length-1]; }

// ── HELPERS ────────────────────────────────────────────────
function shortAddr(a) { return `${a.slice(0,6)}...${a.slice(-4)}`; }
function timeAgo(ts) {
  const s = Math.floor(Date.now()/1000) - parseInt(ts);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}
function fmtUSD(n) {
  if (n >= 1_000_000) return `$${(n/1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n/1_000).toFixed(1)}K`;
  return `$${Math.floor(n)}`;
}
function fmtDate(ts) {
  return new Date(parseInt(ts)*1000).toLocaleDateString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
}
function useIsMobile() {
  const [m,setM]=useState(window.innerWidth<768);
  useEffect(()=>{const h=()=>setM(window.innerWidth<768);window.addEventListener("resize",h);return()=>window.removeEventListener("resize",h);},[]);
  return m;
}

// ── API ────────────────────────────────────────────────────
async function apiFetch(address, offset=2000) {
  try {
    const r = await fetch(`/api/etherscan?address=${address}&action=txlist&offset=${offset}&page=1`);
    const d = await r.json();
    return d.status==="1" ? d.result : [];
  } catch { return []; }
}

// Build leaderboard from all 4 pool contracts
async function buildLeaderboard() {
  const wallets = {};
  for (const [poolKey, poolInfo] of Object.entries(POOLS)) {
    const txs = await apiFetch(poolInfo.address, 2000);
    txs.forEach(tx => {
      const type = getTxType(tx);
      if (!type || tx.isError === "1") return;
      const addr = tx.from?.toLowerCase();
      if (!addr) return;
      if (!wallets[addr]) {
        wallets[addr] = {
          address: tx.from,
          sp: 0, swaps: 0, deposits: 0, claims: 0,
          volumeUSD: 0, swapVolumeUSD: 0,
          txCount: 0, pools: new Set(),
          lastSeen: 0, firstSeen: Infinity,
        };
      }
      const w = wallets[addr];
      const vol = extractVolume(tx, poolKey);
      w.txCount++;
      w.volumeUSD += vol;
      w.pools.add(poolKey);
      if (type === "swap")    { w.swaps++;    w.swapVolumeUSD += vol; }
      if (type === "deposit") { w.deposits++; }
      if (type === "claim")   { w.claims++;   }
      const ts = parseInt(tx.timeStamp);
      if (ts > w.lastSeen)  w.lastSeen  = ts;
      if (ts < w.firstSeen) w.firstSeen = ts;
    });
  }
  return Object.values(wallets)
    .map(w => ({
      ...w,
      sp: calcSP(w.volumeUSD),
      daysActive: w.firstSeen < Infinity ? Math.max(1, Math.ceil((Math.floor(Date.now()/1000) - w.firstSeen) / 86400)) : 1,
      poolsSet: [...w.pools],
      pools: w.pools.size,
    }))
    .sort((a,b) => b.sp - a.sp || b.volumeUSD - a.volumeUSD)
    .slice(0, 10000);
}

// Fetch a single wallet's activity across all Stabilizer pools
async function fetchWalletActivity(wallet) {
  const txs = await apiFetch(wallet, 5000);
  const results = [];
  txs.forEach(tx => {
    const pool = POOL_BY_ADDR[tx.to?.toLowerCase()];
    if (!pool) return;
    const type = getTxType(tx);
    if (!type || tx.isError === "1") return;
    const vol = extractVolume(tx, pool.key);
    results.push({ ...tx, poolKey: pool.key, poolLabel: pool.label, poolColor: pool.color, txType: type, volumeUSD: vol });
  });
  return results.sort((a,b) => parseInt(b.timeStamp) - parseInt(a.timeStamp));
}

// ── SMALL UI ───────────────────────────────────────────────
function Spinner({ text }) {
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"60px 20px",gap:14}}>
      <div style={{width:38,height:38,borderRadius:"50%",border:"3px solid #1e293b",borderTopColor:"#00d4aa",animation:"spin 0.8s linear infinite"}}/>
      <div style={{fontSize:13,color:"#4a5568"}}>{text}</div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function TierBadge({ sp }) {
  const t = getTier(sp);
  return <span style={{fontSize:11,background:`${t.color}18`,border:`1px solid ${t.color}44`,color:t.color,borderRadius:6,padding:"2px 7px",fontWeight:700}}>{t.icon} {t.name}</span>;
}

function PoolDots({ poolsSet }) {
  return (
    <div style={{display:"flex",gap:4,marginTop:3}}>
      {Object.entries(POOLS).map(([k,v])=>(
        <div key={k} title={v.label} style={{width:8,height:8,borderRadius:"50%",background:poolsSet?.includes(k)?v.color:"#1e293b",border:`1px solid ${poolsSet?.includes(k)?v.color:"#2d3748"}`}}/>
      ))}
    </div>
  );
}

function StatBox({ label, value, color, sub }) {
  return (
    <div style={{background:"#0a0f1e",border:`1px solid ${color}33`,borderRadius:12,padding:"12px 14px"}}>
      <div style={{fontSize:10,color:"#4a5568",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:4}}>{label}</div>
      <div style={{fontSize:20,fontWeight:800,color,fontFamily:"'Space Grotesk',monospace"}}>{value}</div>
      {sub&&<div style={{fontSize:11,color:"#4a5568",marginTop:2}}>{sub}</div>}
    </div>
  );
}

// ── ACTIVITY CHART ─────────────────────────────────────────
function ActivityChart({ events, range, isMobile }) {
  const buckets = useMemo(()=>{
    const now = Math.floor(Date.now()/1000);
    let count, sec, labelFn;
    if      (range==="daily")  { count=7; sec=86400;    labelFn=i=>new Date((now-(6-i)*sec)*1000).toLocaleDateString(undefined,{weekday:"short"}); }
    else if (range==="weekly") { count=4; sec=7*86400;  labelFn=i=>`Wk${4-i}`; }
    else                       { count=6; sec=30*86400; labelFn=i=>new Date((now-(5-i)*sec)*1000).toLocaleDateString(undefined,{month:"short"}); }
    const arr = Array.from({length:count},(_,i)=>({label:labelFn(i),count:0,volume:0,sp:0}));
    events.forEach(e=>{
      const idx = count-1-Math.floor((now-parseInt(e.timeStamp))/sec);
      if(idx>=0&&idx<count){arr[idx].count++;arr[idx].volume+=e.volumeUSD||0;arr[idx].sp+=calcSP(e.volumeUSD||0);}
    });
    return arr;
  },[events,range]);

  const maxVol = Math.max(...buckets.map(b=>b.volume),1);
  return (
    <div>
      <div style={{display:"flex",alignItems:"flex-end",gap:isMobile?4:10,height:120,padding:"0 4px"}}>
        {buckets.map((b,i)=>(
          <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
            {b.volume>0&&<div style={{fontSize:9,color:"#4a5568",textAlign:"center"}}>{fmtUSD(b.volume)}</div>}
            <div style={{width:"100%",maxWidth:32,height:`${Math.max((b.volume/maxVol)*85,b.volume>0?6:2)}px`,background:b.volume>0?"linear-gradient(180deg,#00d4aa,#0088ff)":"#1e293b",borderRadius:4,transition:"height 0.4s"}}/>
            <div style={{fontSize:9,color:"#4a5568",textAlign:"center"}}>{b.count>0?`${b.count}tx`:""}</div>
            <div style={{fontSize:10,color:"#718096"}}>{b.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── LEADERBOARD ROW ────────────────────────────────────────
function LeaderRow({ lp, rank, isMobile, expanded, onToggle, onView }) {
  const tier = getTier(lp.sp);
  const rankColors = ["#f59e0b","#94a3b8","#b45309"];
  const ac = ["#00d4aa","#0088ff","#8b5cf6","#f59e0b","#ef4444","#22c55e","#ec4899"];

  return (
    <div style={{
      background: rank<=3 ? `linear-gradient(135deg,${tier.color}08,#0d1525)` : "#0d1525",
      border: `1px solid ${rank<=3 ? tier.color+"44" : "#1e293b"}`,
      borderRadius:12, padding:isMobile?"12px":"14px 18px", cursor:"pointer", marginBottom:8,
    }}>
      <div onClick={onToggle} style={{display:"flex",alignItems:"center",gap:isMobile?8:14}}>

        {/* Rank */}
        <div style={{minWidth:32,textAlign:"center"}}>
          {rank<=3
            ? <span style={{fontSize:20}}>{"🥇🥈🥉"[rank-1]}</span>
            : <span style={{fontSize:13,fontWeight:800,color:"#4a5568",fontFamily:"monospace"}}>#{rank}</span>
          }
        </div>

        {/* Avatar + info */}
        <div style={{display:"flex",alignItems:"center",gap:8,flex:1,minWidth:0}}>
          <div style={{width:isMobile?28:36,height:isMobile?28:36,borderRadius:"50%",flexShrink:0,background:`linear-gradient(135deg,${ac[rank%7]},#1e293b)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:800,color:"#060b18"}}>{lp.address[2]?.toUpperCase()}</div>
          <div style={{minWidth:0,flex:1}}>
            <div style={{fontSize:12,fontWeight:700,color:"#e2e8f0",fontFamily:"'Space Grotesk',monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{shortAddr(lp.address)}</div>
            <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2,flexWrap:"wrap"}}>
              <TierBadge sp={lp.sp}/>
              <PoolDots poolsSet={lp.poolsSet}/>
            </div>
          </div>
        </div>

        {/* Desktop stats */}
        {!isMobile&&<>
          <div style={{textAlign:"right",minWidth:80}}>
            <div style={{fontSize:10,color:"#4a5568",marginBottom:2}}>⭐ SP Score</div>
            <div style={{fontSize:15,fontWeight:800,color:"#f59e0b",fontFamily:"'Space Grotesk',monospace"}}>{lp.sp.toLocaleString()}</div>
          </div>
          <div style={{textAlign:"right",minWidth:90}}>
            <div style={{fontSize:10,color:"#4a5568",marginBottom:2}}>Volume</div>
            <div style={{fontSize:15,fontWeight:800,color:"#00d4aa",fontFamily:"'Space Grotesk',monospace"}}>{fmtUSD(lp.volumeUSD)}</div>
          </div>
          <div style={{textAlign:"right",minWidth:60}}>
            <div style={{fontSize:10,color:"#4a5568",marginBottom:2}}>Swaps</div>
            <div style={{fontSize:15,fontWeight:800,color:"#e2e8f0",fontFamily:"'Space Grotesk',monospace"}}>{lp.swaps}</div>
          </div>
          <div style={{textAlign:"right",minWidth:55}}>
            <div style={{fontSize:10,color:"#4a5568",marginBottom:2}}>Days</div>
            <div style={{fontSize:15,fontWeight:800,color:"#718096",fontFamily:"'Space Grotesk',monospace"}}>{lp.daysActive}</div>
          </div>
          <div style={{textAlign:"right",minWidth:85}}>
            <div style={{fontSize:10,color:"#4a5568",marginBottom:2}}>Last Seen</div>
            <div style={{fontSize:12,fontWeight:700,color:"#e2e8f0"}}>{lp.lastSeen?timeAgo(lp.lastSeen):"—"}</div>
          </div>
        </>}

        {/* Mobile stats */}
        {isMobile&&(
          <div style={{textAlign:"right",flexShrink:0}}>
            <div style={{fontSize:14,fontWeight:800,color:"#f59e0b",fontFamily:"'Space Grotesk',monospace"}}>{lp.sp.toLocaleString()} SP</div>
            <div style={{fontSize:11,color:"#00d4aa"}}>{fmtUSD(lp.volumeUSD)}</div>
          </div>
        )}

        <div style={{color:"#4a5568",fontSize:11,flexShrink:0}}>{expanded?"▲":"▼"}</div>
      </div>

      {/* Expanded */}
      {expanded&&(
        <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid #1e293b"}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8,marginBottom:10}}>
            {[
              {l:"SP Score",      v:`${lp.sp.toLocaleString()} SP`,   c:"#f59e0b"},
              {l:"Total Volume",  v:fmtUSD(lp.volumeUSD),              c:"#00d4aa"},
              {l:"Swap Volume",   v:fmtUSD(lp.swapVolumeUSD),          c:"#00d4aa"},
              {l:"Total Swaps",   v:lp.swaps,                          c:"#e2e8f0"},
              {l:"Add Liquidity", v:lp.deposits,                       c:"#8b5cf6"},
              {l:"Claim Fees",    v:lp.claims,                         c:"#8b5cf6"},
              {l:"Days Active",   v:lp.daysActive,                     c:"#718096"},
              {l:"Last Seen",     v:lp.lastSeen?timeAgo(lp.lastSeen):"—", c:"#718096"},
            ].map(s=>(
              <div key={s.l} style={{background:`${s.c}10`,border:`1px solid ${s.c}22`,borderRadius:8,padding:"8px 10px"}}>
                <div style={{fontSize:10,color:"#4a5568"}}>{s.l}</div>
                <div style={{fontSize:13,fontWeight:700,color:s.c,fontFamily:"'Space Grotesk',monospace"}}>{s.v}</div>
              </div>
            ))}
          </div>
          {/* Pool breakdown */}
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
            {lp.poolsSet?.map(k=>(
              <div key={k} style={{background:`${POOLS[k].color}15`,border:`1px solid ${POOLS[k].color}33`,borderRadius:8,padding:"4px 10px"}}>
                <span style={{fontSize:10,color:POOLS[k].color,fontWeight:700}}>{POOLS[k].label}</span>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center",justifyContent:"space-between",flexWrap:"wrap"}}>
            <a href={`https://sepolia.etherscan.io/address/${lp.address}`} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} style={{fontSize:11,color:"#4a5568",fontFamily:"monospace",textDecoration:"none"}}>{lp.address} ↗</a>
            <button onClick={e=>{e.stopPropagation();onView(lp);}} style={{background:"#00d4aa18",border:"1px solid #00d4aa44",color:"#00d4aa",borderRadius:6,padding:"5px 12px",fontSize:11,cursor:"pointer",fontWeight:700,flexShrink:0}}>View Activity →</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── ACTIVITY TRACKER ───────────────────────────────────────
function ActivityTracker({ isMobile, jumpWallet }) {
  const [input,   setInput]   = useState("");
  const [wallet,  setWallet]  = useState(jumpWallet||"");
  const [events,  setEvents]  = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [done,    setDone]    = useState(false);
  const [range,   setRange]   = useState("daily");
  const [filter,  setFilter]  = useState("all");

  useEffect(()=>{ if(jumpWallet){ setWallet(jumpWallet); runSearch(jumpWallet); } },[jumpWallet]);

  const runSearch = useCallback(async(addr)=>{
    const a = (addr||input).trim();
    if(!a||a.length<10) return;
    setLoading(true);setError("");setEvents([]);setDone(false);setWallet(a);
    try {
      const txs = await fetchWalletActivity(a);
      setEvents(txs);
      if(txs.length===0) setError("No Stabilizer transactions found for this wallet on Sepolia.");
    } catch { setError("Failed to fetch. Please try again."); }
    setLoading(false);setDone(true);
  },[input]);

  const rangeMs   = range==="daily"?7*86400:range==="weekly"?28*86400:180*86400;
  const chartEvts = useMemo(()=>events.filter(e=>Math.floor(Date.now()/1000)-parseInt(e.timeStamp)<=rangeMs),[events,rangeMs]);
  const displayed = useMemo(()=>filter==="all"?events:events.filter(e=>e.txType===filter),[events,filter]);

  // Period summary
  const periodStats = useMemo(()=>{
    const s={swaps:0,deposits:0,claims:0,swapVol:0,totalVol:0,sp:0};
    chartEvts.forEach(e=>{
      if(e.txType==="swap")    {s.swaps++;s.swapVol+=e.volumeUSD;}
      if(e.txType==="deposit") {s.deposits++;}
      if(e.txType==="claim")   {s.claims++;}
      s.totalVol+=e.volumeUSD;
      s.sp+=calcSP(e.volumeUSD);
    });
    return s;
  },[chartEvts]);

  // Overall wallet stats
  const totalSP       = calcSP(events.reduce((s,e)=>s+e.volumeUSD,0));
  const totalVol      = events.reduce((s,e)=>s+e.volumeUSD,0);
  const totalSwapVol  = events.filter(e=>e.txType==="swap").reduce((s,e)=>s+e.volumeUSD,0);
  const lastSeen      = events.length ? events[0].timeStamp : null;
  const firstSeen     = events.length ? events[events.length-1].timeStamp : null;
  const daysActive    = firstSeen ? Math.max(1,Math.ceil((Math.floor(Date.now()/1000)-parseInt(firstSeen))/86400)) : 0;
  const poolBreak     = useMemo(()=>{const m={};events.forEach(e=>{m[e.poolKey]=(m[e.poolKey]||{count:0,vol:0});m[e.poolKey].count++;m[e.poolKey].vol+=e.volumeUSD;});return m;},[events]);
  const tier          = getTier(totalSP);
  const sec           = {background:"#0d1525",border:"1px solid #1e293b",borderRadius:14,padding:isMobile?14:18};

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>

      {/* Search */}
      <div style={sec}>
        <div style={{fontSize:11,color:"#4a5568",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>🔍 Wallet Activity Tracker</div>
        <div style={{display:"flex",gap:8}}>
          <input type="text" placeholder="Paste Sepolia wallet address (0x...)"
            value={input} onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&runSearch(input)}
            style={{flex:1,background:"#0a0f1e",border:"1px solid #2d3748",color:"#e2e8f0",borderRadius:10,padding:"10px 14px",fontSize:14,fontFamily:"'Space Grotesk',monospace"}}
          />
          <button onClick={()=>runSearch(input)} disabled={loading} style={{background:"linear-gradient(135deg,#00d4aa,#0088ff)",border:"none",borderRadius:10,padding:"0 18px",color:"#060b18",fontWeight:800,fontSize:13,cursor:"pointer",opacity:loading?0.7:1}}>
            {loading?"...":"Search"}
          </button>
        </div>
        <div style={{fontSize:11,color:"#4a5568",marginTop:8}}>Shows all Swap, Add Liquidity and Claim Fee txns across T/C/S/P-Pool on Sepolia</div>
      </div>

      {loading&&<Spinner text="Fetching wallet activity from Sepolia..."/>}
      {!loading&&error&&<div style={{background:"#ef444418",border:"1px solid #ef444433",borderRadius:12,padding:16,fontSize:13,color:"#ef4444"}}>{error}</div>}

      {!loading&&done&&events.length>0&&<>

        {/* Wallet summary hero */}
        <div style={{background:`linear-gradient(135deg,${tier.color}10,#0d1525)`,border:`1.5px solid ${tier.color}44`,borderRadius:16,padding:isMobile?16:24}}>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16,flexWrap:"wrap"}}>
            <div style={{width:44,height:44,borderRadius:"50%",background:`linear-gradient(135deg,${tier.color},#1e293b)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,fontWeight:800,color:"#060b18",flexShrink:0}}>{wallet[2]?.toUpperCase()}</div>
            <div>
              <div style={{fontSize:14,fontWeight:700,color:"#e2e8f0",fontFamily:"'Space Grotesk',monospace"}}>{shortAddr(wallet)}</div>
              <div style={{display:"flex",gap:8,marginTop:4,alignItems:"center",flexWrap:"wrap"}}>
                <TierBadge sp={totalSP}/>
                <span style={{fontSize:11,color:"#4a5568"}}>{daysActive}d active</span>
                {lastSeen&&<span style={{fontSize:11,color:"#00d4aa"}}>Last seen: {timeAgo(lastSeen)}</span>}
              </div>
            </div>
            <a href={`https://sepolia.etherscan.io/address/${wallet}`} target="_blank" rel="noreferrer" style={{marginLeft:"auto",fontSize:11,color:"#00d4aa",textDecoration:"none",border:"1px solid #00d4aa33",borderRadius:6,padding:"4px 10px"}}>Etherscan ↗</a>
          </div>

          {/* Key stats */}
          <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"repeat(4,1fr)",gap:10,marginBottom:14}}>
            <StatBox label="⭐ Total SP"      value={`${totalSP.toLocaleString()} SP`}  color="#f59e0b" sub="1 SP per $100 vol"/>
            <StatBox label="💰 Total Volume"  value={fmtUSD(totalVol)}                   color="#00d4aa"/>
            <StatBox label="⇄ Swap Volume"   value={fmtUSD(totalSwapVol)}               color="#00d4aa"/>
            <StatBox label="📊 Total Txns"   value={events.length}                       color="#e2e8f0"/>
          </div>

          {/* Pool breakdown */}
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {Object.entries(poolBreak).map(([k,v])=>(
              <div key={k} style={{background:`${POOLS[k].color}15`,border:`1px solid ${POOLS[k].color}33`,borderRadius:8,padding:"6px 12px"}}>
                <div style={{fontSize:10,color:POOLS[k].color,fontWeight:700}}>{POOLS[k].label}</div>
                <div style={{fontSize:13,fontWeight:800,color:"#e2e8f0",fontFamily:"'Space Grotesk',monospace"}}>{v.count} txns · {fmtUSD(v.vol)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Range + Chart */}
        <div style={sec}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:8}}>
            <div>
              <div style={{fontSize:11,color:"#4a5568",textTransform:"uppercase",letterSpacing:"0.08em"}}>Volume Activity</div>
              <div style={{fontSize:12,color:"#718096",marginTop:2}}>
                {fmtUSD(periodStats.totalVol)} · {periodStats.swaps} swaps · {periodStats.sp} SP earned
              </div>
            </div>
            <div style={{display:"flex",gap:6}}>
              {[{k:"daily",l:"Daily"},{k:"weekly",l:"Weekly"},{k:"monthly",l:"Monthly"}].map(o=>(
                <button key={o.k} onClick={()=>setRange(o.k)} style={{background:range===o.k?"#00d4aa22":"transparent",border:`1px solid ${range===o.k?"#00d4aa":"#2d3748"}`,color:range===o.k?"#00d4aa":"#718096",borderRadius:6,padding:"5px 12px",fontSize:11,cursor:"pointer",fontWeight:600}}>{o.l}</button>
              ))}
            </div>
          </div>
          <ActivityChart events={chartEvts} range={range} isMobile={isMobile}/>
        </div>

        {/* Period breakdown */}
        <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"repeat(3,1fr)",gap:10}}>
          {[
            {icon:"⭐",label:"SP This Period",  value:`${periodStats.sp} SP`,       color:"#f59e0b"},
            {icon:"💰",label:"Volume",           value:fmtUSD(periodStats.totalVol), color:"#00d4aa"},
            {icon:"⇄",label:"Swaps",            value:`${periodStats.swaps} · ${fmtUSD(periodStats.swapVol)}`, color:"#e2e8f0"},
          ].map(s=>(
            <div key={s.label} style={{background:"#0d1525",border:`1px solid ${s.color}22`,borderRadius:12,padding:"14px 16px"}}>
              <div style={{fontSize:14}}>{s.icon}</div>
              <div style={{fontSize:11,color:"#4a5568",margin:"4px 0 2px"}}>{s.label}</div>
              <div style={{fontSize:16,fontWeight:800,color:s.color,fontFamily:"'Space Grotesk',monospace"}}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Type filter */}
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {[{k:"all",l:"All",c:"#718096"},{k:"swap",l:"⇄ Swaps",c:"#f59e0b"},{k:"deposit",l:"+ Add Liquidity",c:"#00d4aa"},{k:"claim",l:"★ Claim Fees",c:"#8b5cf6"}].map(f=>(
            <button key={f.k} onClick={()=>setFilter(f.k)} style={{background:filter===f.k?`${f.c}18`:"transparent",border:`1.5px solid ${filter===f.k?f.c:"#2d3748"}`,color:filter===f.k?f.c:"#4a5568",borderRadius:8,padding:"6px 14px",fontSize:12,cursor:"pointer",fontWeight:600}}>{f.l}</button>
          ))}
        </div>

        {/* Transaction feed */}
        <div style={{background:"#0d1525",border:"1px solid #1e293b",borderRadius:14,overflow:"hidden"}}>
          <div style={{padding:"12px 16px 8px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{fontSize:11,color:"#4a5568",textTransform:"uppercase",letterSpacing:"0.08em"}}>
              Transactions <span style={{color:"#00d4aa",marginLeft:6}}>({displayed.length})</span>
            </div>
          </div>
          <div style={{maxHeight:460,overflowY:"auto"}}>
            {displayed.length===0
              ?<div style={{padding:"30px",textAlign:"center",color:"#4a5568",fontSize:13}}>No transactions found.</div>
              :displayed.map((tx,i)=>{
                const typeInfo = {swap:{label:"Swap",color:"#f59e0b",icon:"⇄"},deposit:{label:"Add Liquidity",color:"#00d4aa",icon:"+"},claim:{label:"Claim Fees",color:"#8b5cf6",icon:"★"}}[tx.txType];
                return (
                  <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 16px",borderBottom:"1px solid #0f1a2e"}}>
                    <div style={{width:34,height:34,borderRadius:8,flexShrink:0,background:`${typeInfo.color}18`,border:`1px solid ${typeInfo.color}33`,display:"flex",alignItems:"center",justifyContent:"center",color:typeInfo.color,fontSize:16,fontWeight:800}}>{typeInfo.icon}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:600,color:"#e2e8f0",display:"flex",alignItems:"center",gap:8}}>
                        {typeInfo.label}
                        {tx.volumeUSD>0&&<span style={{fontSize:12,color:"#00d4aa",fontFamily:"'Space Grotesk',monospace"}}>{fmtUSD(tx.volumeUSD)}</span>}
                        {tx.volumeUSD>0&&<span style={{fontSize:11,color:"#f59e0b",fontFamily:"'Space Grotesk',monospace"}}>+{calcSP(tx.volumeUSD)} SP</span>}
                      </div>
                      <div style={{fontSize:11,color:"#718096",display:"flex",gap:6,flexWrap:"wrap",marginTop:2}}>
                        <span style={{color:POOLS[tx.poolKey].color}}>{tx.poolLabel}</span>
                        <span>·</span>
                        <span>{fmtDate(tx.timeStamp)}</span>
                        <span>·</span>
                        <a href={`https://sepolia.etherscan.io/tx/${tx.hash}`} target="_blank" rel="noreferrer" style={{color:"#4a5568",textDecoration:"none"}}>view ↗</a>
                      </div>
                    </div>
                    <div style={{fontSize:11,color:tx.isError==="1"?"#ef4444":"#22c55e",flexShrink:0,fontWeight:700}}>{tx.isError==="1"?"Failed":"✓"}</div>
                  </div>
                );
              })
            }
          </div>
        </div>
      </>}

      {!loading&&!done&&(
        <div style={{textAlign:"center",padding:"60px 20px",color:"#4a5568",fontSize:14,lineHeight:2.2}}>
          <div style={{fontSize:44,marginBottom:12}}>🔍</div>
          <div style={{color:"#718096",fontWeight:600,marginBottom:8}}>Look up any Stabilizer wallet</div>
          See swap count, volume, SP score, daily/weekly/monthly activity<br/>
          and full transaction history across all 4 pools.
        </div>
      )}
    </div>
  );
}

// ── MAIN APP ───────────────────────────────────────────────
export default function App() {
  const isMobile    = useIsMobile();
  const [tab,       setTab]       = useState("leaderboard");
  const [sortBy,    setSortBy]    = useState("sp");
  const [poolF,     setPoolF]     = useState("all");
  const [tierF,     setTierF]     = useState("all");
  const [search,    setSearch]    = useState("");
  const [expanded,  setExpanded]  = useState(null);
  const [board,     setBoard]     = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [updated,   setUpdated]   = useState(null);
  const [showAll,   setShowAll]   = useState(false);
  const [jumpWallet,setJumpWallet]= useState(null);

  const loadBoard = useCallback(async()=>{
    setLoading(true);
    const data = await buildLeaderboard();
    setBoard(data);setUpdated(new Date());setLoading(false);
  },[]);

  useEffect(()=>{ loadBoard(); },[]);

  const sorted = useMemo(()=>{
    let d=[...board];
    if(poolF!=="all") d=d.filter(w=>w.poolsSet?.includes(poolF));
    if(tierF!=="all"){const t=TIERS.find(x=>x.name===tierF),nx=TIERS[TIERS.indexOf(t)-1];d=d.filter(w=>w.sp>=t.minSP&&(!nx||w.sp<nx.minSP));}
    if(search.trim()){const q=search.toLowerCase();d=d.filter(w=>w.address.toLowerCase().includes(q));}
    d.sort((a,b)=>sortBy==="lastSeen"?b.lastSeen-a.lastSeen:sortBy==="swaps"?b.swaps-a.swaps:sortBy==="volumeUSD"?b.volumeUSD-a.volumeUSD:b.sp-a.sp);
    return d;
  },[board,poolF,tierF,search,sortBy]);

  const displayed = showAll?sorted:sorted.slice(0,25);
  const totalSP   = board.reduce((s,w)=>s+w.sp,0);
  const totalVol  = board.reduce((s,w)=>s+w.volumeUSD,0);
  const sec={background:"#0d1525",border:"1px solid #1e293b",borderRadius:14,padding:16};

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(160deg,#060b18 0%,#080d1a 50%,#06101f 100%)",fontFamily:"'Inter','Segoe UI',sans-serif",color:"#e2e8f0"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700;800&family=Inter:wght@400;500;600&display=swap');
        *{box-sizing:border-box;} input:focus{outline:none;border-color:#00d4aa!important;box-shadow:0 0 0 2px rgba(0,212,170,0.15);}
        button{font-family:inherit;} a{color:inherit;}
        ::-webkit-scrollbar{width:4px;} ::-webkit-scrollbar-track{background:#0d1525;} ::-webkit-scrollbar-thumb{background:#2d3748;border-radius:2px;}
      `}</style>

      {/* Header */}
      <div style={{background:"linear-gradient(180deg,#0a1628 0%,transparent 100%)",borderBottom:"1px solid #1e293b",padding:isMobile?"14px 16px":"18px 24px",position:"sticky",top:0,zIndex:50,backdropFilter:"blur(12px)"}}>
        <div style={{maxWidth:960,margin:"0 auto",display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:36,height:36,borderRadius:10,flexShrink:0,background:"linear-gradient(135deg,#00d4aa,#0088ff)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,fontWeight:800,color:"#060b18"}}>S</div>
          <div>
            <div style={{fontSize:10,color:"#4a5568",letterSpacing:"0.1em",textTransform:"uppercase"}}>Stabilizer Protocol · Sepolia Testnet</div>
            <div style={{fontSize:isMobile?16:20,fontWeight:800,color:"#f0f4f8",fontFamily:"'Space Grotesk',sans-serif",letterSpacing:"-0.02em"}}>{tab==="leaderboard"?"SP Leaderboard":"Activity Tracker"}</div>
          </div>
          <div style={{marginLeft:"auto",display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
            {updated&&<div style={{fontSize:10,color:"#00d4aa"}}>Live · {updated.toLocaleTimeString()}</div>}
            <button onClick={loadBoard} disabled={loading} style={{background:"#0d1525",border:"1px solid #2d3748",color:"#718096",borderRadius:6,padding:"4px 10px",fontSize:11,cursor:"pointer"}}>{loading?"Loading...":"↻ Refresh"}</button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{borderBottom:"1px solid #1e293b",background:"#0a0f1e",position:"sticky",top:isMobile?62:70,zIndex:40}}>
        <div style={{maxWidth:960,margin:"0 auto",display:"flex"}}>
          {[{k:"leaderboard",l:"🏆 SP Leaderboard"},{k:"activity",l:"📊 Activity Tracker"}].map(t=>(
            <button key={t.k} onClick={()=>setTab(t.k)} style={{flex:1,padding:"11px",border:"none",cursor:"pointer",background:"none",fontSize:13,fontWeight:600,color:tab===t.k?"#00d4aa":"#4a5568",borderBottom:`2px solid ${tab===t.k?"#00d4aa":"transparent"}`,transition:"all 0.2s"}}>{t.l}</button>
          ))}
        </div>
      </div>

      <div style={{maxWidth:960,margin:"0 auto",padding:isMobile?"14px":"20px"}}>

        {tab==="activity"?<ActivityTracker isMobile={isMobile} jumpWallet={jumpWallet}/>:(<>

          {/* Banner */}
          <div style={{background:"#f59e0b0d",border:"1px solid #f59e0b22",borderRadius:10,padding:"10px 16px",marginBottom:16,fontSize:12,color:"#718096",display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:16}}>⭐</span>
            <span>SP Score = 1 point per $100 volume · Ranked by total SP · Live from Sepolia · T/C/S/P-Pool</span>
          </div>

          {loading?<Spinner text="Fetching leaderboard from Sepolia..."/>:(<>

            {/* Summary stats */}
            <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"repeat(4,1fr)",gap:12,marginBottom:16}}>
              {[
                {icon:"👛",label:"Wallets",        value:board.length,               color:"#00d4aa"},
                {icon:"⭐",label:"Total SP",        value:totalSP.toLocaleString(),   color:"#f59e0b"},
                {icon:"💰",label:"Total Volume",    value:fmtUSD(totalVol),            color:"#00d4aa"},
                {icon:"⇄",label:"Total Swaps",    value:board.reduce((s,w)=>s+w.swaps,0), color:"#e2e8f0"},
              ].map((s,i)=>(
                <div key={i} style={{background:"#0d1525",border:"1px solid #1e293b",borderRadius:12,padding:"14px 16px"}}>
                  <div style={{fontSize:11,color:"#4a5568",marginBottom:6}}>{s.icon} {s.label}</div>
                  <div style={{fontSize:isMobile?18:22,fontWeight:800,color:s.color,fontFamily:"'Space Grotesk',monospace"}}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* Tier filter */}
            <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap"}}>
              <button onClick={()=>setTierF("all")} style={{background:tierF==="all"?"#ffffff15":"transparent",border:`1px solid ${tierF==="all"?"#ffffff44":"#2d3748"}`,color:tierF==="all"?"#e2e8f0":"#4a5568",borderRadius:8,padding:"6px 12px",fontSize:12,cursor:"pointer",fontWeight:600}}>All Tiers</button>
              {TIERS.map(t=>{
                const cnt=board.filter(w=>{const nx=TIERS[TIERS.indexOf(t)-1];return w.sp>=t.minSP&&(!nx||w.sp<nx.minSP);}).length;
                return <button key={t.name} onClick={()=>setTierF(tierF===t.name?"all":t.name)} style={{background:tierF===t.name?`${t.color}18`:"transparent",border:`1px solid ${tierF===t.name?t.color:"#2d3748"}`,color:tierF===t.name?t.color:"#4a5568",borderRadius:8,padding:"6px 12px",fontSize:12,cursor:"pointer",fontWeight:600}}>{t.icon} {t.name} <span style={{opacity:0.6}}>({cnt})</span></button>;
              })}
            </div>

            {/* Filters + sort */}
            <div style={{...sec,marginBottom:14,display:"flex",flexDirection:"column",gap:12}}>
              <input type="text" placeholder="Search by wallet address..." value={search} onChange={e=>setSearch(e.target.value)}
                style={{width:"100%",background:"#0a0f1e",border:"1px solid #2d3748",color:"#e2e8f0",borderRadius:10,padding:"10px 14px",fontSize:14,fontFamily:"'Space Grotesk',monospace"}}
              />
              <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {[{k:"sp",l:"⭐ SP Score"},{k:"volumeUSD",l:"💰 Volume"},{k:"swaps",l:"⇄ Swaps"},{k:"lastSeen",l:"🕒 Recent"}].map(o=>(
                    <button key={o.k} onClick={()=>setSortBy(o.k)} style={{background:sortBy===o.k?"#00d4aa22":"transparent",border:`1.5px solid ${sortBy===o.k?"#00d4aa":"#2d3748"}`,color:sortBy===o.k?"#00d4aa":"#718096",borderRadius:8,padding:"6px 12px",fontSize:12,cursor:"pointer",fontWeight:600}}>{o.l}</button>
                  ))}
                </div>
                <div style={{display:"flex",gap:6,marginLeft:"auto",flexWrap:"wrap"}}>
                  <button onClick={()=>setPoolF("all")} style={{background:poolF==="all"?"#ffffff15":"transparent",border:`1px solid ${poolF==="all"?"#ffffff44":"#2d3748"}`,color:poolF==="all"?"#e2e8f0":"#4a5568",borderRadius:6,padding:"5px 10px",fontSize:11,cursor:"pointer"}}>All</button>
                  {Object.entries(POOLS).map(([k,v])=>(
                    <button key={k} onClick={()=>setPoolF(k)} style={{background:poolF===k?`${v.color}22`:"transparent",border:`1px solid ${poolF===k?v.color:"#2d3748"}`,color:poolF===k?v.color:"#4a5568",borderRadius:6,padding:"5px 10px",fontSize:11,cursor:"pointer"}}>{v.label}</button>
                  ))}
                </div>
              </div>
            </div>

            {/* Column headers */}
            {!isMobile&&(
              <div style={{display:"flex",alignItems:"center",gap:14,padding:"0 18px 8px",fontSize:10,color:"#4a5568",letterSpacing:"0.08em",textTransform:"uppercase"}}>
                <div style={{minWidth:32}}>Rank</div>
                <div style={{flex:1}}>Wallet</div>
                <div style={{minWidth:80,textAlign:"right"}}>⭐ SP</div>
                <div style={{minWidth:90,textAlign:"right"}}>Volume</div>
                <div style={{minWidth:60,textAlign:"right"}}>Swaps</div>
                <div style={{minWidth:55,textAlign:"right"}}>Days</div>
                <div style={{minWidth:85,textAlign:"right"}}>Last Seen</div>
                <div style={{minWidth:20}}></div>
              </div>
            )}

            {sorted.length===0
              ?<div style={{textAlign:"center",padding:"40px",color:"#4a5568",fontSize:14}}>No wallets found.</div>
              :displayed.map((lp,i)=>(
                <LeaderRow key={lp.address} lp={lp} rank={i+1} isMobile={isMobile}
                  expanded={expanded===i} onToggle={()=>setExpanded(expanded===i?null:i)}
                  onView={lp=>{setJumpWallet(lp.address);setTab("activity");}}
                />
              ))
            }

            {sorted.length>25&&(
              <button onClick={()=>setShowAll(v=>!v)} style={{width:"100%",padding:"12px",background:"#0d1525",border:"1px solid #2d3748",color:"#718096",borderRadius:12,cursor:"pointer",fontSize:13,fontWeight:600,marginTop:4}}>
                {showAll?`Show less ▲`:`Show all ${sorted.length} wallets ▼`}
              </button>
            )}

            {/* Pool legend */}
            <div style={{display:"flex",gap:12,flexWrap:"wrap",marginTop:16,paddingTop:16,borderTop:"1px solid #1e293b"}}>
              {Object.entries(POOLS).map(([k,v])=>(
                <div key={k} style={{display:"flex",alignItems:"center",gap:6}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:v.color}}/>
                  <span style={{fontSize:11,color:"#4a5568"}}>{v.label} · {v.token}</span>
                </div>
              ))}
            </div>
          </>)}
        </>)}

        <div style={{marginTop:24,fontSize:11,color:"#4a5568",textAlign:"center",lineHeight:1.7}}>
          Live data · Ethereum Sepolia Testnet · Stabilizer Protocol · <span style={{color:"#00d4aa"}}>stabilizer.fi</span>
        </div>
      </div>
    </div>
  );
}
