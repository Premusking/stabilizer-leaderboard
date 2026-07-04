import { useState, useEffect, useMemo, useCallback } from "react";

// ── CONTRACTS ──────────────────────────────────────────────
const POOLS = {
  tPool: { label: "T-Pool", color: "#26A17B", token: "USDT", address: "0x7C348b70F640B47b64ecDb154960D337ce7a98B4" },
  cPool: { label: "C-Pool", color: "#2775CA", token: "USDC", address: "0x0578E5EA652C62DB20F4475F685A4b587314A30f" },
  sPool: { label: "S-Pool", color: "#8B5CF6", token: "USDS", address: "0xC94fbB2C1DA52F8561A829a4838f117DD7316F54" },
  pPool: { label: "P-Pool", color: "#0070F3", token: "PYUSD", address: "0x7Dd6979749b60C60eaaa55e4A50e732DAbc5DdD3" },
};
const POOL_ADDRS = new Set(Object.values(POOLS).map(p => p.address.toLowerCase()));
const POOL_BY_ADDR = Object.fromEntries(Object.entries(POOLS).map(([k,v]) => [v.address.toLowerCase(), {key:k,...v}]));

// SP: 1 per $1000 volume
function calcSP(vol) { return Math.floor(vol / 1000); }

// Tiers based on SP
const TIERS = [
  { name: "Diamond", icon: "💎", minSP: 500,  color: "#a5f3fc" },
  { name: "Gold",    icon: "🥇", minSP: 100,  color: "#fbbf24" },
  { name: "Silver",  icon: "🥈", minSP: 20,   color: "#94a3b8" },
  { name: "Bronze",  icon: "🥉", minSP: 0,    color: "#b45309" },
];
function getTier(sp) { return TIERS.find(t => sp >= t.minSP) || TIERS[TIERS.length-1]; }

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
  "0x9163cd89": "claim",
};
function getTxType(tx) {
  const mid = (tx.methodId || tx.input?.slice(0,10) || "").toLowerCase();
  return METHOD_TYPE[mid] || "other";
}

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
  if (!n) return "$0";
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

// ── API — fetch ALL pages of wallet txs ───────────────────
async function fetchAllWalletTxs(wallet) {
  const all = [];
  let page = 1;
  const offset = 10000;
  while (true) {
    try {
      const r = await fetch(`/api/etherscan?address=${wallet}&action=txlist&offset=${offset}&page=${page}`);
      const d = await r.json();
      if (d.status !== "1" || !d.result?.length) break;
      all.push(...d.result);
      if (d.result.length < offset) break; // last page
      page++;
      if (page > 10) break; // safety cap at 100k txs
    } catch { break; }
  }
  return all;
}

// Also fetch internal txs (some stabilizer txs show as internal)
async function fetchInternalTxs(wallet) {
  try {
    const r = await fetch(`/api/etherscan?address=${wallet}&action=txlistinternal&offset=10000&page=1`);
    const d = await r.json();
    return d.status === "1" ? d.result : [];
  } catch { return []; }
}

async function fetchWalletActivity(walletAddr) {
  const [txs, internal] = await Promise.all([
    fetchAllWalletTxs(walletAddr),
    fetchInternalTxs(walletAddr),
  ]);

  const wallet = walletAddr.toLowerCase();
  const results = [];
  const seen = new Set();

  // Process normal txs
  txs.forEach(tx => {
    if (tx.isError === "1") return;
    const to   = tx.to?.toLowerCase();
    const from = tx.from?.toLowerCase();

    // Include if tx is TO a pool contract (user action)
    const pool = POOL_BY_ADDR[to];
    if (!pool) return;
    if (seen.has(tx.hash)) return;
    seen.add(tx.hash);

    const type = getTxType(tx);
    if (type === "other") return;

    // Extract value — use tx value field (ETH) or parse from input
    // For stablecoin pools, value comes from token transfer
    // We'll get the volume from token transfers separately
    results.push({
      ...tx,
      poolKey: pool.key,
      poolLabel: pool.label,
      poolColor: pool.color,
      txType: type,
      volumeUSD: 0, // will be enriched below
    });
  });

  return results.sort((a,b) => parseInt(b.timeStamp) - parseInt(a.timeStamp));
}

// Fetch ERC20 token transfers for a wallet to get actual amounts
async function fetchTokenTransfers(wallet) {
  try {
    const r = await fetch(`/api/etherscan?address=${wallet}&action=tokentx&offset=10000&page=1`);
    const d = await r.json();
    return d.status === "1" ? d.result : [];
  } catch { return []; }
}

// Main function: get wallet activity with real USD volumes
async function getWalletData(walletAddr) {
  const [txs, tokenTxs] = await Promise.all([
    fetchAllWalletTxs(walletAddr),
    fetchTokenTransfers(walletAddr),
  ]);

  const wallet = walletAddr.toLowerCase();

  // Build token transfer map by tx hash for volume lookup
  const volByHash = {};
  tokenTxs.forEach(t => {
    const pool = POOL_BY_ADDR[t.to?.toLowerCase()] || POOL_BY_ADDR[t.from?.toLowerCase()];
    if (!pool) return;
    const decimals = t.tokenDecimal ? parseInt(t.tokenDecimal) : 6;
    const amount = Number(BigInt(t.value) / BigInt(10**Math.min(decimals,18))) ;
    const usd = Math.min(amount, 50_000_000); // sanity cap
    if (!volByHash[t.hash]) volByHash[t.hash] = 0;
    volByHash[t.hash] += usd;
  });

  const results = [];
  const seen = new Set();

  txs.forEach(tx => {
    if (tx.isError === "1") return;
    const to = tx.to?.toLowerCase();
    const pool = POOL_BY_ADDR[to];
    if (!pool) return;
    if (seen.has(tx.hash)) return;
    seen.add(tx.hash);

    const type = getTxType(tx);
    if (type === "other") return;

    const volumeUSD = volByHash[tx.hash] || 0;

    results.push({
      ...tx,
      poolKey: pool.key,
      poolLabel: pool.label,
      poolColor: pool.color,
      txType: type,
      volumeUSD,
    });
  });

  return results.sort((a,b) => parseInt(b.timeStamp) - parseInt(a.timeStamp));
}

// ── UI COMPONENTS ──────────────────────────────────────────
function Spinner({ text }) {
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"60px 20px",gap:14}}>
      <div style={{width:42,height:42,borderRadius:"50%",border:"3px solid #1e293b",borderTopColor:"#00d4aa",animation:"spin 0.8s linear infinite"}}/>
      <div style={{fontSize:13,color:"#4a5568"}}>{text}</div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function TierBadge({ sp }) {
  const t = getTier(sp);
  return <span style={{fontSize:11,background:`${t.color}18`,border:`1px solid ${t.color}44`,color:t.color,borderRadius:6,padding:"2px 8px",fontWeight:700,whiteSpace:"nowrap"}}>{t.icon} {t.name}</span>;
}

function StatBox({ label, value, color, sub, big }) {
  return (
    <div style={{background:"#0a0f1e",border:`1px solid ${color}33`,borderRadius:12,padding:"14px 16px"}}>
      <div style={{fontSize:10,color:"#4a5568",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>{label}</div>
      <div style={{fontSize:big?28:20,fontWeight:800,color,fontFamily:"'Space Grotesk',monospace",letterSpacing:"-0.02em"}}>{value}</div>
      {sub&&<div style={{fontSize:11,color:"#4a5568",marginTop:3}}>{sub}</div>}
    </div>
  );
}

function ActivityChart({ events, range, isMobile }) {
  const buckets = useMemo(()=>{
    const now = Math.floor(Date.now()/1000);
    let count, sec, labelFn;
    if      (range==="daily")  { count=7; sec=86400;    labelFn=i=>new Date((now-(6-i)*sec)*1000).toLocaleDateString(undefined,{weekday:"short"}); }
    else if (range==="weekly") { count=4; sec=7*86400;  labelFn=i=>`Wk${4-i}`; }
    else                       { count=6; sec=30*86400; labelFn=i=>new Date((now-(5-i)*sec)*1000).toLocaleDateString(undefined,{month:"short"}); }
    const arr = Array.from({length:count},(_,i)=>({label:labelFn(i),count:0,volume:0}));
    events.forEach(e=>{
      const idx = count-1-Math.floor((now-parseInt(e.timeStamp))/sec);
      if(idx>=0&&idx<count){arr[idx].count++;arr[idx].volume+=e.volumeUSD||0;}
    });
    return arr;
  },[events,range]);

  const maxVol = Math.max(...buckets.map(b=>b.volume),1);
  const maxCount = Math.max(...buckets.map(b=>b.count),1);

  return (
    <div style={{display:"flex",alignItems:"flex-end",gap:isMobile?6:12,height:130,padding:"0 4px"}}>
      {buckets.map((b,i)=>(
        <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
          {b.volume>0&&<div style={{fontSize:9,color:"#4a5568",textAlign:"center",lineHeight:1.2}}>{fmtUSD(b.volume)}</div>}
          <div style={{
            width:"100%",maxWidth:36,
            height:`${Math.max((b.volume/maxVol)*90,b.volume>0?8:2)}px`,
            background:b.volume>0?"linear-gradient(180deg,#00d4aa,#0088ff)":"#1e293b",
            borderRadius:4,transition:"height 0.4s",position:"relative"
          }}>
            {b.count>0&&<div style={{position:"absolute",top:-18,left:"50%",transform:"translateX(-50%)",fontSize:9,color:"#00d4aa",whiteSpace:"nowrap"}}>{b.count}tx</div>}
          </div>
          <div style={{fontSize:10,color:"#718096"}}>{b.label}</div>
        </div>
      ))}
    </div>
  );
}

// ── MAIN APP ───────────────────────────────────────────────
export default function App() {
  const isMobile = useIsMobile();
  const [input,   setInput]   = useState("");
  const [wallet,  setWallet]  = useState("");
  const [events,  setEvents]  = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [done,    setDone]    = useState(false);
  const [range,   setRange]   = useState("daily");
  const [filter,  setFilter]  = useState("all");

  const runSearch = useCallback(async(addr)=>{
    const a = (addr||input).trim();
    if(!a||a.length<10) return;
    setLoading(true);setError("");setEvents([]);setDone(false);setWallet(a);
    try {
      const txs = await getWalletData(a);
      setEvents(txs);
      if(txs.length===0) setError("No Stabilizer transactions found for this wallet on Sepolia testnet.");
    } catch(e) { setError("Failed to fetch data. Please check the address and try again."); }
    setLoading(false);setDone(true);
  },[input]);

  // Range filter for chart
  const rangeMs   = range==="daily"?7*86400:range==="weekly"?28*86400:180*86400;
  const chartEvts = useMemo(()=>events.filter(e=>Math.floor(Date.now()/1000)-parseInt(e.timeStamp)<=rangeMs),[events,rangeMs]);
  const displayed = useMemo(()=>filter==="all"?events:events.filter(e=>e.txType===filter),[events,filter]);

  // Period stats (for selected range)
  const periodStats = useMemo(()=>{
    const s={swaps:0,deposits:0,claims:0,swapVol:0,totalVol:0};
    chartEvts.forEach(e=>{
      s.totalVol+=e.volumeUSD||0;
      if(e.txType==="swap")    {s.swaps++;   s.swapVol+=e.volumeUSD||0;}
      if(e.txType==="deposit") {s.deposits++;}
      if(e.txType==="claim")   {s.claims++;}
    });
    return s;
  },[chartEvts]);

  // Overall stats
  const totalVol     = events.reduce((s,e)=>s+e.volumeUSD,0);
  const totalSwapVol = events.filter(e=>e.txType==="swap").reduce((s,e)=>s+e.volumeUSD,0);
  const totalSP      = calcSP(totalVol);
  const swapCount    = events.filter(e=>e.txType==="swap").length;
  const depositCount = events.filter(e=>e.txType==="deposit").length;
  const claimCount   = events.filter(e=>e.txType==="claim").length;
  const lastSeen     = events.length ? events[0].timeStamp : null;
  const firstSeen    = events.length ? events[events.length-1].timeStamp : null;
  const daysActive   = firstSeen ? Math.max(1,Math.ceil((Math.floor(Date.now()/1000)-parseInt(firstSeen))/86400)) : 0;
  const tier         = getTier(totalSP);

  const poolBreak = useMemo(()=>{
    const m={};
    events.forEach(e=>{
      if(!m[e.poolKey]) m[e.poolKey]={count:0,vol:0,swaps:0};
      m[e.poolKey].count++;
      m[e.poolKey].vol+=e.volumeUSD||0;
      if(e.txType==="swap") m[e.poolKey].swaps++;
    });
    return m;
  },[events]);

  const sec = {background:"#0d1525",border:"1px solid #1e293b",borderRadius:14,padding:isMobile?14:20};

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(160deg,#060b18 0%,#080d1a 50%,#06101f 100%)",fontFamily:"'Inter','Segoe UI',sans-serif",color:"#e2e8f0"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700;800&family=Inter:wght@400;500;600&display=swap');
        *{box-sizing:border-box;} input:focus{outline:none;border-color:#00d4aa!important;box-shadow:0 0 0 2px rgba(0,212,170,0.15);}
        button{font-family:inherit;} a{color:inherit;}
        ::-webkit-scrollbar{width:4px;} ::-webkit-scrollbar-track{background:#0d1525;} ::-webkit-scrollbar-thumb{background:#2d3748;border-radius:2px;}
      `}</style>

      {/* Header */}
      <div style={{background:"linear-gradient(180deg,#0a1628 0%,transparent 100%)",borderBottom:"1px solid #1e293b",padding:isMobile?"16px":"20px 28px",position:"sticky",top:0,zIndex:50,backdropFilter:"blur(12px)"}}>
        <div style={{maxWidth:860,margin:"0 auto",display:"flex",alignItems:"center",gap:14}}>
          <div style={{width:40,height:40,borderRadius:12,flexShrink:0,background:"linear-gradient(135deg,#00d4aa,#0088ff)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,fontWeight:800,color:"#060b18"}}>S</div>
          <div>
            <div style={{fontSize:10,color:"#4a5568",letterSpacing:"0.12em",textTransform:"uppercase"}}>Stabilizer Protocol · Sepolia Testnet</div>
            <div style={{fontSize:isMobile?18:24,fontWeight:800,color:"#f0f4f8",fontFamily:"'Space Grotesk',sans-serif",letterSpacing:"-0.03em"}}>Activity Tracker</div>
          </div>
          <div style={{marginLeft:"auto",fontSize:10,color:"#4a5568",textAlign:"right"}}>
            <div style={{color:"#00d4aa",marginBottom:2}}>🔴 Live</div>
            <div>Sepolia Testnet</div>
          </div>
        </div>
      </div>

      <div style={{maxWidth:860,margin:"0 auto",padding:isMobile?"16px":"24px",display:"flex",flexDirection:"column",gap:18}}>

        {/* Search */}
        <div style={sec}>
          <div style={{fontSize:12,color:"#4a5568",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:12,display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:16}}>🔍</span> Wallet Activity Tracker
          </div>
          <div style={{display:"flex",gap:10}}>
            <input type="text"
              placeholder="Enter Sepolia wallet address (0x...)"
              value={input}
              onChange={e=>setInput(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&runSearch(input)}
              style={{flex:1,background:"#060b18",border:"1.5px solid #2d3748",color:"#e2e8f0",borderRadius:10,padding:"12px 16px",fontSize:15,fontFamily:"'Space Grotesk',monospace"}}
            />
            <button onClick={()=>runSearch(input)} disabled={loading} style={{
              background:"linear-gradient(135deg,#00d4aa,#0088ff)",border:"none",borderRadius:10,
              padding:"0 22px",color:"#060b18",fontWeight:800,fontSize:14,cursor:"pointer",
              opacity:loading?0.7:1,whiteSpace:"nowrap",minWidth:90
            }}>{loading?"...":"Search"}</button>
          </div>
          <div style={{fontSize:11,color:"#4a5568",marginTop:10,lineHeight:1.6}}>
            Tracks Swaps · Add Liquidity · Claim Fees across T-Pool, C-Pool, S-Pool, P-Pool on Sepolia
          </div>
        </div>

        {/* Loading */}
        {loading&&<Spinner text="Fetching all wallet transactions from Sepolia..."/>}

        {/* Error */}
        {!loading&&error&&(
          <div style={{background:"#ef444415",border:"1px solid #ef444433",borderRadius:12,padding:"16px 20px",fontSize:13,color:"#ef4444"}}>{error}</div>
        )}

        {/* Results */}
        {!loading&&done&&events.length>0&&<>

          {/* Wallet hero card */}
          <div style={{background:`linear-gradient(135deg,${tier.color}12,#0d1525)`,border:`2px solid ${tier.color}44`,borderRadius:18,padding:isMobile?18:28}}>
            <div style={{display:"flex",alignItems:"flex-start",gap:14,marginBottom:20,flexWrap:"wrap"}}>
              <div style={{width:52,height:52,borderRadius:"50%",background:`linear-gradient(135deg,${tier.color},#1e293b)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,fontWeight:800,color:"#060b18",flexShrink:0}}>
                {wallet[2]?.toUpperCase()}
              </div>
              <div style={{flex:1,minWidth:200}}>
                <div style={{fontSize:15,fontWeight:700,color:"#e2e8f0",fontFamily:"'Space Grotesk',monospace",marginBottom:6}}>{shortAddr(wallet)}</div>
                <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                  <TierBadge sp={totalSP}/>
                  <span style={{fontSize:12,color:"#4a5568"}}>{daysActive} days active</span>
                  {lastSeen&&<span style={{fontSize:12,color:"#00d4aa",fontWeight:600}}>Last seen: {timeAgo(lastSeen)}</span>}
                </div>
              </div>
              <a href={`https://sepolia.etherscan.io/address/${wallet}`} target="_blank" rel="noreferrer"
                style={{fontSize:12,color:"#00d4aa",textDecoration:"none",border:"1px solid #00d4aa44",borderRadius:8,padding:"6px 14px",whiteSpace:"nowrap",flexShrink:0}}>
                View on Etherscan ↗
              </a>
            </div>

            {/* SP + volume hero */}
            <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"repeat(4,1fr)",gap:12,marginBottom:16}}>
              <StatBox label="⭐ SP Score"     value={`${totalSP.toLocaleString()}`} color="#f59e0b" sub="1 SP per $1,000 vol" big/>
              <StatBox label="💰 Total Volume"  value={fmtUSD(totalVol)}              color="#00d4aa"/>
              <StatBox label="⇄ Swap Volume"   value={fmtUSD(totalSwapVol)}           color="#22c55e"/>
              <StatBox label="📊 Total Txns"   value={events.length}                  color="#e2e8f0"/>
            </div>

            {/* Tx type breakdown */}
            <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:16}}>
              {[
                {l:"Swaps",         v:swapCount,    c:"#f59e0b", icon:"⇄"},
                {l:"Add Liquidity", v:depositCount, c:"#00d4aa", icon:"+"},
                {l:"Claim Fees",    v:claimCount,   c:"#8b5cf6", icon:"★"},
              ].map(s=>(
                <div key={s.l} style={{background:`${s.c}12`,border:`1px solid ${s.c}33`,borderRadius:10,padding:"8px 14px",display:"flex",alignItems:"center",gap:8}}>
                  <span style={{color:s.c,fontSize:16}}>{s.icon}</span>
                  <div>
                    <div style={{fontSize:10,color:"#4a5568"}}>{s.l}</div>
                    <div style={{fontSize:17,fontWeight:800,color:s.c,fontFamily:"'Space Grotesk',monospace"}}>{s.v}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Pool breakdown */}
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {Object.entries(poolBreak).map(([k,v])=>(
                <div key={k} style={{background:`${POOLS[k].color}15`,border:`1px solid ${POOLS[k].color}33`,borderRadius:10,padding:"8px 14px"}}>
                  <div style={{fontSize:10,color:POOLS[k].color,fontWeight:700,marginBottom:2}}>{POOLS[k].label}</div>
                  <div style={{fontSize:13,fontWeight:700,color:"#e2e8f0",fontFamily:"'Space Grotesk',monospace"}}>{v.count} txns</div>
                  {v.vol>0&&<div style={{fontSize:11,color:"#00d4aa"}}>{fmtUSD(v.vol)}</div>}
                </div>
              ))}
            </div>
          </div>

          {/* Chart + range */}
          <div style={sec}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,flexWrap:"wrap",gap:10}}>
              <div>
                <div style={{fontSize:12,color:"#4a5568",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:4}}>Volume Activity</div>
                <div style={{fontSize:13,color:"#718096"}}>
                  <span style={{color:"#00d4aa",fontWeight:700}}>{fmtUSD(periodStats.totalVol)}</span> vol ·
                  <span style={{color:"#f59e0b",fontWeight:700,marginLeft:6}}>{periodStats.swaps} swaps</span> ·
                  <span style={{color:"#f59e0b",marginLeft:6}}>+{calcSP(periodStats.totalVol)} SP</span>
                </div>
              </div>
              <div style={{display:"flex",gap:6}}>
                {[{k:"daily",l:"Daily"},{k:"weekly",l:"Weekly"},{k:"monthly",l:"Monthly"}].map(o=>(
                  <button key={o.k} onClick={()=>setRange(o.k)} style={{
                    background:range===o.k?"#00d4aa22":"transparent",
                    border:`1px solid ${range===o.k?"#00d4aa":"#2d3748"}`,
                    color:range===o.k?"#00d4aa":"#718096",
                    borderRadius:6,padding:"6px 14px",fontSize:12,cursor:"pointer",fontWeight:600
                  }}>{o.l}</button>
                ))}
              </div>
            </div>
            <ActivityChart events={chartEvts} range={range} isMobile={isMobile}/>
          </div>

          {/* Period breakdown cards */}
          <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"repeat(3,1fr)",gap:12}}>
            {[
              {icon:"⭐",label:"SP Earned (period)",  value:`${calcSP(periodStats.totalVol)} SP`,      color:"#f59e0b"},
              {icon:"💰",label:"Volume (period)",      value:fmtUSD(periodStats.totalVol),               color:"#00d4aa"},
              {icon:"⇄",label:"Swaps (period)",      value:`${periodStats.swaps} · ${fmtUSD(periodStats.swapVol)}`, color:"#e2e8f0"},
            ].map(s=>(
              <div key={s.label} style={{background:"#0d1525",border:`1px solid ${s.color}22`,borderRadius:12,padding:"16px 18px"}}>
                <div style={{fontSize:16,marginBottom:6}}>{s.icon}</div>
                <div style={{fontSize:11,color:"#4a5568",marginBottom:4}}>{s.label}</div>
                <div style={{fontSize:18,fontWeight:800,color:s.color,fontFamily:"'Space Grotesk',monospace"}}>{s.value}</div>
              </div>
            ))}
          </div>

          {/* Filter + feed */}
          <div style={sec}>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14}}>
              {[
                {k:"all",     l:"All Transactions", c:"#718096"},
                {k:"swap",    l:"⇄ Swaps",          c:"#f59e0b"},
                {k:"deposit", l:"+ Add Liquidity",   c:"#00d4aa"},
                {k:"claim",   l:"★ Claim Fees",      c:"#8b5cf6"},
              ].map(f=>(
                <button key={f.k} onClick={()=>setFilter(f.k)} style={{
                  background:filter===f.k?`${f.c}18`:"transparent",
                  border:`1.5px solid ${filter===f.k?f.c:"#2d3748"}`,
                  color:filter===f.k?f.c:"#4a5568",
                  borderRadius:8,padding:"6px 14px",fontSize:12,cursor:"pointer",fontWeight:600
                }}>{f.l} {filter===f.k&&`(${displayed.length})`}</button>
              ))}
            </div>

            {/* Transaction list */}
            <div style={{maxHeight:500,overflowY:"auto",borderRadius:10,border:"1px solid #1a2035",overflow:"hidden"}}>
              {/* Header row */}
              {!isMobile&&(
                <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr 80px",gap:12,padding:"10px 16px",background:"#060b18",fontSize:10,color:"#4a5568",textTransform:"uppercase",letterSpacing:"0.08em",borderBottom:"1px solid #1e293b"}}>
                  <div>Transaction</div>
                  <div>Pool</div>
                  <div>Volume</div>
                  <div>SP Earned</div>
                  <div>Date</div>
                </div>
              )}
              <div style={{maxHeight:isMobile?440:460,overflowY:"auto"}}>
                {displayed.length===0
                  ?<div style={{padding:"40px",textAlign:"center",color:"#4a5568",fontSize:13}}>No transactions found.</div>
                  :displayed.map((tx,i)=>{
                    const typeInfo = {
                      swap:    {label:"Swap",         color:"#f59e0b", icon:"⇄"},
                      deposit: {label:"Add Liquidity", color:"#00d4aa", icon:"+"},
                      claim:   {label:"Claim Fees",    color:"#8b5cf6", icon:"★"},
                    }[tx.txType] || {label:"Tx",color:"#718096",icon:"·"};
                    const pool = POOLS[tx.poolKey];
                    const sp = calcSP(tx.volumeUSD||0);

                    return (
                      <div key={i} style={{
                        display:"flex",alignItems:"center",gap:12,padding:"12px 16px",
                        borderBottom:"1px solid #0f1a2e",
                        background:i%2===0?"transparent":"#060b1844"
                      }}>
                        {/* Type icon */}
                        <div style={{width:36,height:36,borderRadius:8,flexShrink:0,background:`${typeInfo.color}15`,border:`1px solid ${typeInfo.color}33`,display:"flex",alignItems:"center",justifyContent:"center",color:typeInfo.color,fontSize:16,fontWeight:800}}>
                          {typeInfo.icon}
                        </div>

                        {/* Info */}
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                            <span style={{fontSize:13,fontWeight:700,color:typeInfo.color}}>{typeInfo.label}</span>
                            <span style={{fontSize:11,background:`${pool.color}18`,color:pool.color,borderRadius:4,padding:"1px 6px"}}>{pool.label}</span>
                            {tx.volumeUSD>0&&<span style={{fontSize:12,color:"#00d4aa",fontFamily:"'Space Grotesk',monospace",fontWeight:700}}>{fmtUSD(tx.volumeUSD)}</span>}
                            {sp>0&&<span style={{fontSize:11,color:"#f59e0b",fontFamily:"'Space Grotesk',monospace"}}>+{sp} SP</span>}
                          </div>
                          <div style={{fontSize:11,color:"#4a5568",marginTop:3,display:"flex",gap:8,flexWrap:"wrap"}}>
                            <span>{fmtDate(tx.timeStamp)}</span>
                            <span>·</span>
                            <a href={`https://sepolia.etherscan.io/tx/${tx.hash}`} target="_blank" rel="noreferrer" style={{color:"#2d3748",textDecoration:"none"}}>
                              {tx.hash.slice(0,10)}...{tx.hash.slice(-6)} ↗
                            </a>
                          </div>
                        </div>

                        <div style={{fontSize:11,color:tx.isError==="1"?"#ef4444":"#22c55e",flexShrink:0,fontWeight:700}}>
                          {tx.isError==="1"?"Failed":"✓"}
                        </div>
                      </div>
                    );
                  })
                }
              </div>
            </div>
          </div>
        </>}

        {/* Empty state */}
        {!loading&&!done&&(
          <div style={{textAlign:"center",padding:"80px 20px",color:"#4a5568",lineHeight:2.4}}>
            <div style={{fontSize:52,marginBottom:16}}>🔍</div>
            <div style={{fontSize:16,fontWeight:700,color:"#718096",marginBottom:8}}>Track any Stabilizer wallet</div>
            <div style={{fontSize:13}}>
              Enter a Sepolia wallet address to see<br/>
              swap count · volume · SP score<br/>
              daily/weekly/monthly activity
            </div>
          </div>
        )}

        <div style={{fontSize:11,color:"#2d3748",textAlign:"center",lineHeight:1.8}}>
          Stabilizer Protocol · Sepolia Testnet · Live on-chain data
          <br/><span style={{color:"#00d4aa33"}}>stabilizer.fi</span>
        </div>
      </div>
    </div>
  );
}
