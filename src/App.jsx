import { useState, useEffect, useMemo, useCallback } from "react";

// ── CONTRACTS ──────────────────────────────────────────────
const POOLS = {
  tPool: { label: "T-Pool", color: "#26A17B", token: "USDT", address: "0x7C348b70F640B47b64ecDb154960D337ce7a98B4" },
  cPool: { label: "C-Pool", color: "#2775CA", token: "USDC", address: "0x0578E5EA652C62DB20F4475F685A4b587314A30f" },
  sPool: { label: "S-Pool", color: "#8B5CF6", token: "USDS", address: "0xC94fbB2C1DA52F8561A829a4838f117DD7316F54" },
  pPool: { label: "P-Pool", color: "#0070F3", token: "PYUSD", address: "0x7Dd6979749b60C60eaaa55e4A50e732DAbc5DdD3" },
};
const POOL_ADDRS = Object.fromEntries(Object.entries(POOLS).map(([k,v]) => [v.address.toLowerCase(), {key:k,...v}]));

// ── TX TYPES (only 3 as requested) ─────────────────────────
const TX_TYPES = {
  swap:    { label: "Swap",          color: "#f59e0b", icon: "⇄" },
  deposit: { label: "Add Liquidity", color: "#00d4aa", icon: "+" },
  claim:   { label: "Claim Fees",    color: "#8b5cf6", icon: "★" },
};

// Known Stabilizer method selectors (from real tx data)
const METHOD_MAP = {
  "0xfe029156": "swap",
  "0x6bf08450": "swap",
  "0x68ffa1a8": "deposit",
  "0xe8eda9df": "deposit",
  "0xb6b55f25": "deposit",
  "0x47e7ef24": "deposit",
  "0x46f66e42": "deposit",  // addLiquidity variant
  "0x349d8b48": "claim",
  "0x0a7c4960": "claim",
};

function classifyTx(tx) {
  const mid = (tx.methodId || tx.input?.slice(0,10) || "").toLowerCase();
  return METHOD_MAP[mid] || null; // null = skip (remove liquidity, transfers, etc)
}

// ── TIERS ──────────────────────────────────────────────────
const TIERS = [
  { name: "Diamond", icon: "💎", min: 100, color: "#a5f3fc" },
  { name: "Gold",    icon: "🥇", min: 30,  color: "#fbbf24" },
  { name: "Silver",  icon: "🥈", min: 10,  color: "#94a3b8" },
  { name: "Bronze",  icon: "🥉", min: 0,   color: "#b45309" },
];
function getTier(n) { return TIERS.find(t => n >= t.min) || TIERS[TIERS.length-1]; }

// ── HELPERS ────────────────────────────────────────────────
function shortAddr(a) { return `${a.slice(0,6)}...${a.slice(-4)}`; }
function timeAgo(ts) {
  const s = Math.floor(Date.now()/1000) - parseInt(ts);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400)return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}
function fmtDate(ts) {
  return new Date(parseInt(ts)*1000).toLocaleDateString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
}
function useIsMobile() {
  const [m,setM] = useState(window.innerWidth<768);
  useEffect(()=>{const h=()=>setM(window.innerWidth<768);window.addEventListener("resize",h);return()=>window.removeEventListener("resize",h);},[]);
  return m;
}

// ── API ────────────────────────────────────────────────────
async function apiFetch(address, action="txlist", offset=2000) {
  const r = await fetch(`/api/etherscan?address=${address}&action=${action}&offset=${offset}&page=1`);
  const d = await r.json();
  return d.status==="1" ? d.result : [];
}

// Build leaderboard: fetch latest 2000 txs per pool, aggregate by wallet
async function buildLeaderboard() {
  const wallets = {};
  for (const [poolKey, poolInfo] of Object.entries(POOLS)) {
    const txs = await apiFetch(poolInfo.address, "txlist", 2000);
    txs.forEach(tx => {
      const type = classifyTx(tx);
      if (!type) return; // skip irrelevant txs
      const addr = tx.from?.toLowerCase();
      if (!addr) return;
      if (!wallets[addr]) wallets[addr] = { address: tx.from, pools: new Set(), txCount: 0, swaps: 0, deposits: 0, claims: 0, lastSeen: 0, firstSeen: Infinity };
      wallets[addr].txCount++;
      wallets[addr][type === "swap" ? "swaps" : type === "deposit" ? "deposits" : "claims"]++;
      wallets[addr].pools.add(poolKey);
      const ts = parseInt(tx.timeStamp);
      if (ts > wallets[addr].lastSeen)  wallets[addr].lastSeen  = ts;
      if (ts < wallets[addr].firstSeen) wallets[addr].firstSeen = ts;
    });
  }
  return Object.values(wallets)
    .map(w => ({ ...w, pools: w.pools.size, poolsSet: [...w.pools] }))
    .sort((a,b) => b.txCount - a.txCount)
    .slice(0, 10000);
}

// Fetch wallet activity — search wallet's own tx history
async function fetchWalletActivity(walletAddress) {
  const txs = await apiFetch(walletAddress, "txlist", 5000);
  const results = [];
  txs.forEach(tx => {
    const pool = POOL_ADDRS[tx.to?.toLowerCase()];
    if (!pool) return;
    const type = classifyTx(tx);
    if (!type) return;
    results.push({ ...tx, poolKey: pool.key, poolLabel: pool.label, poolColor: pool.color, txType: type });
  });
  return results.sort((a,b) => parseInt(b.timeStamp) - parseInt(a.timeStamp));
}

// ── UI COMPONENTS ──────────────────────────────────────────
function Spinner({ text }) {
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"60px 20px",gap:14}}>
      <div style={{width:38,height:38,borderRadius:"50%",border:"3px solid #1e293b",borderTopColor:"#00d4aa",animation:"spin 0.8s linear infinite"}}/>
      <div style={{fontSize:13,color:"#4a5568"}}>{text||"Loading..."}</div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
function TierBadge({n}) {
  const t=getTier(n);
  return <span style={{fontSize:11,background:`${t.color}18`,border:`1px solid ${t.color}44`,color:t.color,borderRadius:6,padding:"2px 7px",fontWeight:700}}>{t.icon} {t.name}</span>;
}
function PoolDots({poolsSet}) {
  return (
    <div style={{display:"flex",gap:4,marginTop:3}}>
      {Object.entries(POOLS).map(([k,v])=>(
        <div key={k} style={{width:8,height:8,borderRadius:"50%",background:poolsSet?.includes(k)?v.color:"#1e293b",border:`1px solid ${poolsSet?.includes(k)?v.color:"#2d3748"}`}} title={v.label}/>
      ))}
    </div>
  );
}
function ActivityBar({events,range,isMobile}) {
  const buckets = useMemo(()=>{
    const now = Math.floor(Date.now()/1000);
    let count,sec,labelFn;
    if(range==="daily")      {count=7;sec=86400;    labelFn=i=>new Date((now-(6-i)*sec)*1000).toLocaleDateString(undefined,{weekday:"short"});}
    else if(range==="weekly"){count=4;sec=7*86400;  labelFn=i=>`Wk${4-i}`;}
    else                     {count=6;sec=30*86400; labelFn=i=>new Date((now-(5-i)*sec)*1000).toLocaleDateString(undefined,{month:"short"});}
    const arr=Array.from({length:count},(_,i)=>({label:labelFn(i),count:0}));
    events.forEach(e=>{
      const idx=count-1-Math.floor((now-parseInt(e.timeStamp))/sec);
      if(idx>=0&&idx<count)arr[idx].count++;
    });
    return arr;
  },[events,range]);
  const maxC=Math.max(...buckets.map(b=>b.count),1);
  return (
    <div style={{display:"flex",alignItems:"flex-end",gap:isMobile?4:10,height:110,padding:"0 4px"}}>
      {buckets.map((b,i)=>(
        <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
          {b.count>0&&<div style={{fontSize:10,color:"#4a5568"}}>{b.count}</div>}
          <div style={{width:"100%",maxWidth:32,height:`${Math.max((b.count/maxC)*80,b.count>0?6:2)}px`,background:b.count>0?"linear-gradient(180deg,#00d4aa,#0088ff)":"#1e293b",borderRadius:4,transition:"height 0.4s"}}/>
          <div style={{fontSize:10,color:"#718096"}}>{b.label}</div>
        </div>
      ))}
    </div>
  );
}

// ── LEADERBOARD ROW ────────────────────────────────────────
function LeaderRow({lp,rank,isMobile,expanded,onToggle,onView}) {
  const tier=getTier(lp.txCount);
  const daysActive=lp.firstSeen<Infinity?Math.max(1,Math.ceil((Math.floor(Date.now()/1000)-lp.firstSeen)/86400)):1;
  const ac=["#00d4aa","#0088ff","#8b5cf6","#f59e0b","#ef4444","#22c55e","#ec4899"];
  return (
    <div style={{background:rank<=3?`linear-gradient(135deg,${tier.color}08,#0d1525)`:"#0d1525",border:`1px solid ${rank<=3?tier.color+"33":"#1e293b"}`,borderRadius:12,padding:isMobile?"12px":"14px 18px",cursor:"pointer",marginBottom:8}}>
      <div onClick={onToggle} style={{display:"flex",alignItems:"center",gap:isMobile?8:14}}>
        <div style={{minWidth:28,textAlign:"center",fontSize:13,fontWeight:800,color:"#4a5568",fontFamily:"monospace"}}>{rank<=3?["🥇","🥈","🥉"][rank-1]:`#${rank}`}</div>
        <div style={{display:"flex",alignItems:"center",gap:8,flex:1,minWidth:0}}>
          <div style={{width:isMobile?28:34,height:isMobile?28:34,borderRadius:"50%",flexShrink:0,background:`linear-gradient(135deg,${ac[rank%7]},#1e293b)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:800,color:"#060b18"}}>{lp.address[2]?.toUpperCase()}</div>
          <div style={{minWidth:0,flex:1}}>
            <div style={{fontSize:12,fontWeight:700,color:"#e2e8f0",fontFamily:"'Space Grotesk',monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{shortAddr(lp.address)}</div>
            <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2,flexWrap:"wrap"}}><TierBadge n={lp.txCount}/><PoolDots poolsSet={lp.poolsSet}/></div>
          </div>
        </div>
        {!isMobile&&<>
          <div style={{textAlign:"right",minWidth:70}}><div style={{fontSize:10,color:"#4a5568",marginBottom:2}}>Txns</div><div style={{fontSize:14,fontWeight:800,color:"#00d4aa",fontFamily:"'Space Grotesk',monospace"}}>{lp.txCount}</div></div>
          <div style={{textAlign:"right",minWidth:60}}><div style={{fontSize:10,color:"#4a5568",marginBottom:2}}>Swaps</div><div style={{fontSize:14,fontWeight:800,color:"#f59e0b",fontFamily:"'Space Grotesk',monospace"}}>{lp.swaps}</div></div>
          <div style={{textAlign:"right",minWidth:60}}><div style={{fontSize:10,color:"#4a5568",marginBottom:2}}>Deposits</div><div style={{fontSize:14,fontWeight:800,color:"#00d4aa",fontFamily:"'Space Grotesk',monospace"}}>{lp.deposits}</div></div>
          <div style={{textAlign:"right",minWidth:60}}><div style={{fontSize:10,color:"#4a5568",marginBottom:2}}>Claims</div><div style={{fontSize:14,fontWeight:800,color:"#8b5cf6",fontFamily:"'Space Grotesk',monospace"}}>{lp.claims}</div></div>
          <div style={{textAlign:"right",minWidth:80}}><div style={{fontSize:10,color:"#4a5568",marginBottom:2}}>Last Active</div><div style={{fontSize:12,fontWeight:700,color:"#e2e8f0"}}>{lp.lastSeen?timeAgo(lp.lastSeen):"—"}</div></div>
          <div style={{textAlign:"right",minWidth:45}}><div style={{fontSize:10,color:"#4a5568",marginBottom:2}}>Days</div><div style={{fontSize:14,fontWeight:800,color:"#718096",fontFamily:"'Space Grotesk',monospace"}}>{daysActive}</div></div>
        </>}
        {isMobile&&<div style={{textAlign:"right",flexShrink:0}}><div style={{fontSize:13,fontWeight:800,color:"#00d4aa",fontFamily:"'Space Grotesk',monospace"}}>{lp.txCount} txns</div><div style={{fontSize:11,color:"#718096"}}>{lp.lastSeen?timeAgo(lp.lastSeen):""}</div></div>}
        <div style={{color:"#4a5568",fontSize:11,flexShrink:0}}>{expanded?"▲":"▼"}</div>
      </div>
      {expanded&&(
        <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid #1e293b"}}>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
            {[{l:"Swaps",v:lp.swaps,c:"#f59e0b"},{l:"Add Liquidity",v:lp.deposits,c:"#00d4aa"},{l:"Claim Fees",v:lp.claims,c:"#8b5cf6"},{l:"Days Active",v:daysActive,c:"#e2e8f0"}].map(s=>(
              <div key={s.l} style={{background:`${s.c}12`,border:`1px solid ${s.c}30`,borderRadius:8,padding:"6px 12px"}}>
                <div style={{fontSize:10,color:"#718096"}}>{s.l}</div>
                <div style={{fontSize:14,fontWeight:700,color:s.c,fontFamily:"'Space Grotesk',monospace"}}>{s.v}</div>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center",justifyContent:"space-between",flexWrap:"wrap"}}>
            <a href={`https://sepolia.etherscan.io/address/${lp.address}`} target="_blank" rel="noreferrer" style={{fontSize:11,color:"#4a5568",fontFamily:"monospace",textDecoration:"none"}} onClick={e=>e.stopPropagation()}>{lp.address} ↗</a>
            <button onClick={e=>{e.stopPropagation();onView(lp);}} style={{background:"#00d4aa18",border:"1px solid #00d4aa44",color:"#00d4aa",borderRadius:6,padding:"5px 12px",fontSize:11,cursor:"pointer",fontWeight:700}}>View Activity →</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── ACTIVITY TRACKER ───────────────────────────────────────
function ActivityTracker({isMobile,jumpWallet}) {
  const [input,   setInput]   = useState("");
  const [wallet,  setWallet]  = useState(jumpWallet||"");
  const [events,  setEvents]  = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [done,    setDone]    = useState(false);
  const [range,   setRange]   = useState("daily");
  const [filter,  setFilter]  = useState("all");

  useEffect(()=>{ if(jumpWallet){setWallet(jumpWallet);doSearch(jumpWallet);} },[jumpWallet]);

  const doSearch = useCallback(async(addr)=>{
    const a=(addr||wallet||input).trim();
    if(!a||a.length<10) return;
    setLoading(true);setError("");setEvents([]);setDone(false);
    try {
      const txs = await fetchWalletActivity(a);
      setEvents(txs);
      setWallet(a);
      if(txs.length===0) setError("No Swap / Add Liquidity / Claim Fee transactions found for this address on Stabilizer contracts.");
    } catch(e){ setError("Failed to fetch. Check address and try again."); }
    setLoading(false);setDone(true);
  },[wallet,input]);

  const displayed = useMemo(()=>filter==="all"?events:events.filter(e=>e.txType===filter),[events,filter]);
  const rangeMs   = range==="daily"?7*86400:range==="weekly"?28*86400:180*86400;
  const chartEvts = useMemo(()=>events.filter(e=>Math.floor(Date.now()/1000)-parseInt(e.timeStamp)<=rangeMs),[events,rangeMs]);

  const summary  = useMemo(()=>{
    const s={swap:0,deposit:0,claim:0};
    chartEvts.forEach(e=>{ s[e.txType]=(s[e.txType]||0)+1; });
    return s;
  },[chartEvts]);

  const lastSeen  = events.length?events[0].timeStamp:null;
  const firstSeen = events.length?events[events.length-1].timeStamp:null;
  const daysActive= firstSeen?Math.max(1,Math.ceil((Math.floor(Date.now()/1000)-parseInt(firstSeen))/86400)):0;
  const poolBreak = useMemo(()=>{ const m={};events.forEach(e=>{m[e.poolKey]=(m[e.poolKey]||0)+1;});return m; },[events]);
  const tier      = getTier(events.length);
  const sec       = {background:"#0d1525",border:"1px solid #1e293b",borderRadius:14,padding:isMobile?14:18};

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {/* Search */}
      <div style={sec}>
        <div style={{fontSize:11,color:"#4a5568",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>🔍 Look Up Wallet on Stabilizer Testnet</div>
        <div style={{display:"flex",gap:8}}>
          <input type="text" placeholder="Paste Sepolia wallet address (0x...)"
            value={input} onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&doSearch(input)}
            style={{flex:1,background:"#0a0f1e",border:"1px solid #2d3748",color:"#e2e8f0",borderRadius:10,padding:"10px 14px",fontSize:14,fontFamily:"'Space Grotesk',monospace"}}
          />
          <button onClick={()=>doSearch(input)} disabled={loading} style={{background:"linear-gradient(135deg,#00d4aa,#0088ff)",border:"none",borderRadius:10,padding:"0 16px",color:"#060b18",fontWeight:800,fontSize:13,cursor:"pointer",opacity:loading?0.7:1}}>
            {loading?"...":"Search"}
          </button>
        </div>
        <div style={{fontSize:11,color:"#4a5568",marginTop:8}}>Shows Swaps, Add Liquidity, and Claim Fee transactions across all 4 Stabilizer pools</div>
      </div>

      {loading&&<Spinner text="Fetching wallet transactions from Sepolia..."/>}
      {!loading&&error&&<div style={{background:"#ef444418",border:"1px solid #ef444433",borderRadius:12,padding:16,fontSize:13,color:"#ef4444"}}>{error}</div>}

      {!loading&&done&&events.length>0&&<>
        {/* Wallet card */}
        <div style={{background:`linear-gradient(135deg,${tier.color}10,#0d1525)`,border:`1.5px solid ${tier.color}33`,borderRadius:16,padding:isMobile?16:20}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14,flexWrap:"wrap"}}>
            <div style={{width:38,height:38,borderRadius:"50%",background:`linear-gradient(135deg,${tier.color},#1e293b)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:800,color:"#060b18",flexShrink:0}}>{wallet[2]?.toUpperCase()}</div>
            <div>
              <div style={{fontSize:13,fontWeight:700,color:"#e2e8f0",fontFamily:"'Space Grotesk',monospace"}}>{shortAddr(wallet)}</div>
              <div style={{display:"flex",gap:8,marginTop:3,alignItems:"center",flexWrap:"wrap"}}>
                <TierBadge n={events.length}/>
                <span style={{fontSize:11,color:"#4a5568"}}>{daysActive}d active · {events.length} relevant txns</span>
                {lastSeen&&<span style={{fontSize:11,color:"#00d4aa"}}>Last: {timeAgo(lastSeen)}</span>}
              </div>
            </div>
            <a href={`https://sepolia.etherscan.io/address/${wallet}`} target="_blank" rel="noreferrer" style={{marginLeft:"auto",fontSize:11,color:"#00d4aa",textDecoration:"none",border:"1px solid #00d4aa33",borderRadius:6,padding:"4px 10px"}}>Etherscan ↗</a>
          </div>
          {/* Pool breakdown */}
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
            {Object.entries(POOLS).map(([k,v])=>poolBreak[k]>0&&(
              <div key={k} style={{background:`${v.color}15`,border:`1px solid ${v.color}33`,borderRadius:8,padding:"5px 10px"}}>
                <div style={{fontSize:10,color:v.color,fontWeight:700}}>{v.label}</div>
                <div style={{fontSize:13,fontWeight:800,color:"#e2e8f0",fontFamily:"'Space Grotesk',monospace"}}>{poolBreak[k]} txns</div>
              </div>
            ))}
          </div>
          {/* Stats */}
          <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"repeat(4,1fr)",gap:10}}>
            {[
              {l:"Swaps",      v:events.filter(e=>e.txType==="swap").length,    c:"#f59e0b"},
              {l:"Add Liq",    v:events.filter(e=>e.txType==="deposit").length,  c:"#00d4aa"},
              {l:"Claim Fees", v:events.filter(e=>e.txType==="claim").length,    c:"#8b5cf6"},
              {l:"Days Active",v:daysActive,                                     c:"#e2e8f0"},
            ].map(s=>(
              <div key={s.l} style={{background:"#0a0f1e",border:`1px solid ${s.c}33`,borderRadius:12,padding:"12px 14px"}}>
                <div style={{fontSize:10,color:"#4a5568",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:4}}>{s.l}</div>
                <div style={{fontSize:20,fontWeight:800,color:s.c,fontFamily:"'Space Grotesk',monospace"}}>{s.v}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Chart */}
        <div style={sec}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:8}}>
            <div style={{fontSize:11,color:"#4a5568",textTransform:"uppercase",letterSpacing:"0.08em"}}>Transaction Activity</div>
            <div style={{display:"flex",gap:6}}>
              {[{k:"daily",l:"7 Days"},{k:"weekly",l:"4 Weeks"},{k:"monthly",l:"6 Months"}].map(o=>(
                <button key={o.k} onClick={()=>setRange(o.k)} style={{background:range===o.k?"#00d4aa22":"transparent",border:`1px solid ${range===o.k?"#00d4aa":"#2d3748"}`,color:range===o.k?"#00d4aa":"#718096",borderRadius:6,padding:"5px 12px",fontSize:11,cursor:"pointer",fontWeight:600}}>{o.l}</button>
              ))}
            </div>
          </div>
          <ActivityBar events={chartEvts} range={range} isMobile={isMobile}/>
        </div>

        {/* Type filter pills */}
        <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr 1fr":"repeat(3,1fr)",gap:10}}>
          {Object.entries(TX_TYPES).map(([k,v])=>(
            <button key={k} onClick={()=>setFilter(filter===k?"all":k)} style={{background:filter===k?`${v.color}18`:"#0d1525",border:`1px solid ${filter===k?v.color:"#1e293b"}`,borderRadius:12,padding:"12px",textAlign:"left",cursor:"pointer"}}>
              <div style={{fontSize:18,color:v.color}}>{v.icon}</div>
              <div style={{fontSize:11,color:"#718096",margin:"4px 0 2px"}}>{v.label}</div>
              <div style={{fontSize:22,fontWeight:800,color:v.color,fontFamily:"'Space Grotesk',monospace"}}>{summary[k]||0}</div>
            </button>
          ))}
        </div>

        {/* Feed */}
        <div style={{background:"#0d1525",border:"1px solid #1e293b",borderRadius:14,overflow:"hidden"}}>
          <div style={{padding:"12px 16px 8px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{fontSize:11,color:"#4a5568",textTransform:"uppercase",letterSpacing:"0.08em"}}>
              {filter!=="all"?`${TX_TYPES[filter].label} · `:""}Transactions
              <span style={{color:"#00d4aa",marginLeft:6}}>({displayed.length})</span>
            </div>
            {filter!=="all"&&<button onClick={()=>setFilter("all")} style={{background:"none",border:"none",color:"#4a5568",fontSize:11,cursor:"pointer"}}>Clear ✕</button>}
          </div>
          <div style={{maxHeight:440,overflowY:"auto"}}>
            {displayed.length===0
              ?<div style={{padding:"30px",textAlign:"center",color:"#4a5568",fontSize:13}}>No transactions in this range.</div>
              :displayed.map((tx,i)=>{
                const type=TX_TYPES[tx.txType];
                const pool=POOLS[tx.poolKey];
                return (
                  <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 16px",borderBottom:"1px solid #0f1a2e"}}>
                    <div style={{width:32,height:32,borderRadius:8,flexShrink:0,background:`${type.color}18`,border:`1px solid ${type.color}33`,display:"flex",alignItems:"center",justifyContent:"center",color:type.color,fontSize:14,fontWeight:800}}>{type.icon}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:600,color:"#e2e8f0"}}>{type.label}</div>
                      <div style={{fontSize:11,color:"#718096",display:"flex",gap:6,flexWrap:"wrap"}}>
                        <span style={{color:pool.color}}>{pool.label}</span>
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
        <div style={{textAlign:"center",padding:"60px 20px",color:"#4a5568",fontSize:14,lineHeight:2}}>
          <div style={{fontSize:40,marginBottom:12}}>🔍</div>
          Enter a wallet address to see its Swap, Add Liquidity<br/>and Claim Fee activity across all Stabilizer pools.
        </div>
      )}
    </div>
  );
}

// ── MAIN APP ───────────────────────────────────────────────
export default function App() {
  const isMobile   = useIsMobile();
  const [tab,      setTab]      = useState("leaderboard");
  const [sortBy,   setSortBy]   = useState("txCount");
  const [poolF,    setPoolF]    = useState("all");
  const [tierF,    setTierF]    = useState("all");
  const [search,   setSearch]   = useState("");
  const [expanded, setExpanded] = useState(null);
  const [board,    setBoard]    = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [updated,  setUpdated]  = useState(null);
  const [showAll,  setShowAll]  = useState(false);
  const [jumpWallet,setJumpWallet]=useState(null);

  const loadBoard = useCallback(async()=>{
    setLoading(true);
    const data=await buildLeaderboard();
    setBoard(data);setUpdated(new Date());setLoading(false);
  },[]);

  useEffect(()=>{ loadBoard(); },[]);

  const sorted = useMemo(()=>{
    let d=[...board];
    if(poolF!=="all") d=d.filter(w=>w.poolsSet?.includes(poolF));
    if(tierF!=="all"){const t=TIERS.find(x=>x.name===tierF),nx=TIERS[TIERS.indexOf(t)-1];d=d.filter(w=>w.txCount>=t.min&&(!nx||w.txCount<nx.min));}
    if(search.trim()){const q=search.toLowerCase();d=d.filter(w=>w.address.toLowerCase().includes(q));}
    d.sort((a,b)=>sortBy==="lastSeen"?b.lastSeen-a.lastSeen:b[sortBy]-a[sortBy]);
    return d;
  },[board,poolF,tierF,search,sortBy]);

  const displayed=showAll?sorted:sorted.slice(0,25);
  const totalTxns=board.reduce((s,w)=>s+w.txCount,0);
  const totalSwaps=board.reduce((s,w)=>s+w.swaps,0);
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
        <div style={{maxWidth:940,margin:"0 auto",display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:36,height:36,borderRadius:10,flexShrink:0,background:"linear-gradient(135deg,#00d4aa,#0088ff)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,fontWeight:800,color:"#060b18"}}>S</div>
          <div>
            <div style={{fontSize:10,color:"#4a5568",letterSpacing:"0.1em",textTransform:"uppercase"}}>Stabilizer Protocol · Sepolia Testnet</div>
            <div style={{fontSize:isMobile?16:20,fontWeight:800,color:"#f0f4f8",fontFamily:"'Space Grotesk',sans-serif",letterSpacing:"-0.02em"}}>{tab==="leaderboard"?"LP Leaderboard":"Activity Tracker"}</div>
          </div>
          <div style={{marginLeft:"auto",display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
            {updated&&<div style={{fontSize:10,color:"#00d4aa"}}>Live · {updated.toLocaleTimeString()}</div>}
            <button onClick={loadBoard} disabled={loading} style={{background:"#0d1525",border:"1px solid #2d3748",color:"#718096",borderRadius:6,padding:"4px 10px",fontSize:11,cursor:"pointer"}}>{loading?"Loading...":"↻ Refresh"}</button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{borderBottom:"1px solid #1e293b",background:"#0a0f1e",position:"sticky",top:isMobile?62:70,zIndex:40}}>
        <div style={{maxWidth:940,margin:"0 auto",display:"flex"}}>
          {[{k:"leaderboard",l:"🏆 Leaderboard"},{k:"activity",l:"📊 Activity Tracker"}].map(t=>(
            <button key={t.k} onClick={()=>setTab(t.k)} style={{flex:1,padding:"11px",border:"none",cursor:"pointer",background:"none",fontSize:13,fontWeight:600,color:tab===t.k?"#00d4aa":"#4a5568",borderBottom:`2px solid ${tab===t.k?"#00d4aa":"transparent"}`,transition:"all 0.2s"}}>{t.l}</button>
          ))}
        </div>
      </div>

      <div style={{maxWidth:940,margin:"0 auto",padding:isMobile?"14px":"20px"}}>

        {tab==="activity"?<ActivityTracker isMobile={isMobile} jumpWallet={jumpWallet}/>:(<>

          {/* Live banner */}
          <div style={{background:"#00d4aa0d",border:"1px solid #00d4aa22",borderRadius:10,padding:"10px 16px",marginBottom:16,fontSize:12,color:"#718096",display:"flex",alignItems:"center",gap:8}}>
            <span style={{color:"#00d4aa",fontSize:14}}>🔴</span>
            <span>Live data from Sepolia · T-Pool, C-Pool, S-Pool, P-Pool · Showing Swaps, Add Liquidity & Claim Fees only</span>
          </div>

          {loading?<Spinner text="Fetching on-chain data from Sepolia..."/>:(<>
            {/* Stats */}
            <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"repeat(4,1fr)",gap:12,marginBottom:16}}>
              {[
                {icon:"👛",label:"Active Wallets",  value:board.length, color:"#00d4aa"},
                {icon:"⚡",label:"Total Txns",       value:totalTxns,    color:"#f59e0b"},
                {icon:"⇄",label:"Total Swaps",      value:totalSwaps,   color:"#f59e0b"},
                {icon:"+",label:"Total Deposits",   value:board.reduce((s,w)=>s+w.deposits,0), color:"#00d4aa"},
              ].map((s,i)=>(
                <div key={i} style={{background:"#0d1525",border:"1px solid #1e293b",borderRadius:12,padding:"14px 16px"}}>
                  <div style={{fontSize:11,color:"#4a5568",marginBottom:6}}>{s.icon} {s.label}</div>
                  <div style={{fontSize:20,fontWeight:800,color:s.color,fontFamily:"'Space Grotesk',monospace"}}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* Tier filter */}
            <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap"}}>
              <button onClick={()=>setTierF("all")} style={{background:tierF==="all"?"#ffffff15":"transparent",border:`1px solid ${tierF==="all"?"#ffffff44":"#2d3748"}`,color:tierF==="all"?"#e2e8f0":"#4a5568",borderRadius:8,padding:"6px 12px",fontSize:12,cursor:"pointer",fontWeight:600}}>All Tiers</button>
              {TIERS.map(t=>{
                const cnt=board.filter(w=>{const nx=TIERS[TIERS.indexOf(t)-1];return w.txCount>=t.min&&(!nx||w.txCount<nx.min);}).length;
                return <button key={t.name} onClick={()=>setTierF(tierF===t.name?"all":t.name)} style={{background:tierF===t.name?`${t.color}18`:"transparent",border:`1px solid ${tierF===t.name?t.color:"#2d3748"}`,color:tierF===t.name?t.color:"#4a5568",borderRadius:8,padding:"6px 12px",fontSize:12,cursor:"pointer",fontWeight:600}}>{t.icon} {t.name} <span style={{opacity:0.6}}>({cnt})</span></button>;
              })}
            </div>

            {/* Filters */}
            <div style={{...sec,marginBottom:14,display:"flex",flexDirection:"column",gap:12}}>
              <input type="text" placeholder="Search by wallet address..." value={search} onChange={e=>setSearch(e.target.value)}
                style={{width:"100%",background:"#0a0f1e",border:"1px solid #2d3748",color:"#e2e8f0",borderRadius:10,padding:"10px 14px",fontSize:14,fontFamily:"'Space Grotesk',monospace"}}
              />
              <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {[{k:"txCount",l:"Most Active"},{k:"swaps",l:"Most Swaps"},{k:"deposits",l:"Most Deposits"},{k:"lastSeen",l:"Recent"}].map(o=>(
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
                <div style={{minWidth:28}}>Rank</div>
                <div style={{flex:1}}>Wallet / Tier</div>
                <div style={{minWidth:70,textAlign:"right"}}>Txns</div>
                <div style={{minWidth:60,textAlign:"right"}}>Swaps</div>
                <div style={{minWidth:60,textAlign:"right"}}>Deposits</div>
                <div style={{minWidth:60,textAlign:"right"}}>Claims</div>
                <div style={{minWidth:80,textAlign:"right"}}>Last Active</div>
                <div style={{minWidth:45,textAlign:"right"}}>Days</div>
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

            {/* Legend */}
            <div style={{display:"flex",gap:12,flexWrap:"wrap",marginTop:16,paddingTop:16,borderTop:"1px solid #1e293b"}}>
              {Object.entries(POOLS).map(([k,v])=>(
                <div key={k} style={{display:"flex",alignItems:"center",gap:6}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:v.color}}/>
                  <span style={{fontSize:11,color:"#4a5568"}}>{v.label} ({v.address.slice(0,6)}...{v.address.slice(-4)})</span>
                </div>
              ))}
            </div>
          </>)}
        </>)}

        <div style={{marginTop:24,fontSize:11,color:"#4a5568",textAlign:"center",lineHeight:1.7}}>
          Live data from Ethereum Sepolia Testnet · Stabilizer Protocol · <span style={{color:"#00d4aa"}}>stabilizer.fi</span>
        </div>
      </div>
    </div>
  );
}
