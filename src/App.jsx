import { useState, useEffect, useMemo, useCallback } from "react";

// ── CONTRACTS ──────────────────────────────────────────────
// The Router is the main contract users interact with for swaps
const ROUTER_ADDR = "0xFa6419a3d3503a016dF3A59F690734862CA2A78D".toLowerCase();

const POOLS = {
  tPool: { label: "T-Pool", color: "#26A17B", token: "USDT", address: "0x7C348b70F640B47b64ecDb154960D337ce7a98B4" },
  cPool: { label: "C-Pool", color: "#2775CA", token: "USDC", address: "0x0578E5EA652C62DB20F4475F685A4b587314A30f" },
  sPool: { label: "S-Pool", color: "#8B5CF6", token: "USDS", address: "0xC94fbB2C1DA52F8561A829a4838f117DD7316F54" },
  pPool: { label: "P-Pool", color: "#0070F3", token: "PYUSD", address: "0x7Dd6979749b60C60eaaa55e4A50e732DAbc5DdD3" },
};
const POOL_ADDRS = new Set(Object.values(POOLS).map(p => p.address.toLowerCase()));
const POOL_BY_ADDR = Object.fromEntries(Object.entries(POOLS).map(([k,v]) => [v.address.toLowerCase(), {key:k,...v}]));

// All Stabilizer contracts (router + pools)
const ALL_STABILIZER_ADDRS = new Set([ROUTER_ADDR, ...Object.values(POOLS).map(p => p.address.toLowerCase())]);

// SP Formula (official):
// Swap: $1,000 volume = 10 SP  (vol / 100)
// LP Deposit: $1,000 = 20 SP  (vol / 50)
function calcSwapSP(vol) { return Math.floor(vol / 100); }
function calcLiqSP(vol)  { return Math.floor(vol / 50); }
function calcSP(swapVol, liqVol) { return calcSwapSP(swapVol) + calcLiqSP(liqVol); }

// Tiers based on SP
const TIERS = [
  { name: "Diamond", icon: "💎", minSP: 500,  color: "#a5f3fc" },
  { name: "Gold",    icon: "🥇", minSP: 100,  color: "#fbbf24" },
  { name: "Silver",  icon: "🥈", minSP: 20,   color: "#94a3b8" },
  { name: "Bronze",  icon: "🥉", minSP: 0,    color: "#b45309" },
];
function getTier(sp) { return TIERS.find(t => sp >= t.minSP) || TIERS[TIERS.length-1]; }

// ── THEME ──────────────────────────────────────────────────
const DARK = {
  bg:       "linear-gradient(160deg,#060b18 0%,#080d1a 50%,#06101f 100%)",
  card:     "#0d1525",
  card2:    "#0a0f1e",
  input:    "#060b18",
  border:   "#1e293b",
  border2:  "#2d3748",
  text:     "#e2e8f0",
  muted:    "#4a5568",
  sub:      "#718096",
  header:   "#0a1628",
  tabBg:    "#0a0f1e",
  rowAlt:   "#060b1844",
  tblHead:  "#060b18",
};
const LIGHT = {
  bg:       "linear-gradient(160deg,#f0f4f8 0%,#e8eef5 50%,#edf2f7 100%)",
  card:     "#ffffff",
  card2:    "#f7fafc",
  input:    "#ffffff",
  border:   "#e2e8f0",
  border2:  "#cbd5e0",
  text:     "#1a202c",
  muted:    "#718096",
  sub:      "#4a5568",
  header:   "#ffffff",
  tabBg:    "#f7fafc",
  rowAlt:   "#f7fafc",
  tblHead:  "#edf2f7",
};

// Classify tx - swap goes to router, claim/deposit/withdraw go to pool
function getTxType(tx) {
  const to  = tx.to?.toLowerCase() || "";
  const mid = (tx.methodId || tx.input?.slice(0,10) || "").toLowerCase();

  if (to === ROUTER_ADDR) return "swap";

  const claimMethods  = new Set(["0x349d8b48","0x0a7c4960","0x9163cd89","0x82013098","0xb78f8012"]);
  const depositMethods= new Set(["0x68ffa1a8","0xe8eda9df","0xb6b55f25","0x6bf08450"]);
  const withdrawMethods=new Set(["0x46f66e42","0x69328dec","0x2e1a7d4d","0x441a3e70"]);

  if (claimMethods.has(mid))   return "claim";
  if (depositMethods.has(mid) && POOL_ADDRS.has(to))  return "deposit";
  if (withdrawMethods.has(mid) && POOL_ADDRS.has(to)) return "withdraw";

  return null;
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
  if (n >= 1_000_000_000) return `$${(n/1_000_000_000).toFixed(2)}B`;
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
async function apiGet(address, action, offset=10000, page=1) {
  try {
    const r = await fetch(`/api/etherscan?address=${address}&action=${action}&offset=${offset}&page=${page}`);
    const d = await r.json();
    return d.status==="1" ? d.result : [];
  } catch { return []; }
}

// Fetch ALL pages of txs for a wallet
async function fetchAllTxs(wallet) {
  const all = [];
  for (let page=1; page<=20; page++) {
    const txs = await apiGet(wallet, "txlist", 10000, page);
    if (!txs.length) break;
    all.push(...txs);
    if (txs.length < 10000) break;
  }
  return all;
}

// Fetch ALL token transfers for volume calculation
async function fetchAllTokenTxs(wallet) {
  const all = [];
  for (let page=1; page<=5; page++) {
    const txs = await apiGet(wallet, "tokentx", 10000, page);
    if (!txs.length) break;
    all.push(...txs);
    if (txs.length < 10000) break;
  }
  return all;
}

// Get volume per tx hash from token transfers
// For swaps: user sends stablecoin TO router — use that as volume
function buildVolMap(tokenTxs, wallet) {
  const volMap = {};
  const w = wallet.toLowerCase();
  tokenTxs.forEach(t => {
    const from = t.from?.toLowerCase();
    const to   = t.to?.toLowerCase();
    // Count token sent FROM wallet to router/pool as the swap volume
    if (from === w && ALL_STABILIZER_ADDRS.has(to)) {
      const dec = parseInt(t.tokenDecimal) || 6;
      // Use string math to avoid float precision issues
      const raw = t.value || "0";
      const divisor = Math.pow(10, dec);
      const amount = parseFloat(raw) / divisor;
      if (!volMap[t.hash]) volMap[t.hash] = 0;
      volMap[t.hash] += Math.min(amount, 1_000_000_000);
    }
  });
  return volMap;
}

async function getWalletData(walletAddr) {
  const [allTxs, tokenTxs] = await Promise.all([
    fetchAllTxs(walletAddr),
    fetchAllTokenTxs(walletAddr),
  ]);

  const volMap = buildVolMap(tokenTxs, walletAddr);
  const results = [];
  const seen = new Set();

  allTxs.forEach(tx => {
    if (tx.isError === "1") return;
    const type = getTxType(tx);
    if (!type) return;
    if (seen.has(tx.hash)) return;
    seen.add(tx.hash);

    // For swaps: get volume from token transfer map
    // For claims: volume = 0 (claiming fees, not swapping)
    const volumeUSD = type === "swap" ? (volMap[tx.hash] || 0) : 0;

    // Determine which pool (for swaps, check token transfers)
    let poolKey = "tPool"; // default
    const relatedTokenTx = tokenTxs.find(t =>
      t.hash === tx.hash &&
      POOL_BY_ADDR[t.to?.toLowerCase()]
    );
    if (relatedTokenTx) {
      const p = POOL_BY_ADDR[relatedTokenTx.to?.toLowerCase()];
      if (p) poolKey = p.key;
    }

    results.push({
      ...tx,
      poolKey,
      poolLabel: POOLS[poolKey].label,
      poolColor: POOLS[poolKey].color,
      txType: type,
      volumeUSD,
    });
  });

  return results.sort((a,b) => parseInt(b.timeStamp) - parseInt(a.timeStamp));
}

// Leaderboard — pulls ALL router txs (paginated) for accurate 15K+ wallet data
// Ranked by: swap count → swap volume → SP
async function buildLeaderboard() {
  const wallets = {};
  const swapHashes = {}; // wallet -> Set of swap tx hashes
  const liqHashes  = {}; // wallet -> Set of liq tx hashes

  const init = (addr, from) => {
    if (!wallets[addr]) {
      wallets[addr]   = { address: from, swaps:0, deposits:0, withdrawals:0, claims:0, swapVolumeUSD:0, liqVolumeUSD:0, lastSeen:0, firstSeen:Infinity };
      swapHashes[addr] = new Set();
      liqHashes[addr]  = new Set();
    }
  };
  const stamp = (w, ts) => {
    if (ts > w.lastSeen)  w.lastSeen  = ts;
    if (ts < w.firstSeen) w.firstSeen = ts;
  };

  // 1. Fetch ALL router txs (paginated) — router has all swap interactions
  const routerTxs = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await apiGet(ROUTER_ADDR, "txlist", 10000, page);
    if (!batch.length) break;
    routerTxs.push(...batch);
    if (batch.length < 10000) break;
  }

  // 2. Fetch pool txs (deposits/withdrawals/claims) — paginate top 3 pages
  const poolTxsArr = await Promise.all(
    Object.values(POOLS).map(async p => {
      const all = [];
      for (let page = 1; page <= 3; page++) {
        const batch = await apiGet(p.address, "txlist", 10000, page);
        if (!batch.length) break;
        all.push(...batch);
        if (batch.length < 10000) break;
      }
      return all;
    })
  );
  const allPoolTxs = poolTxsArr.flat();

  // Process router txs — each is a swap
  routerTxs.forEach(tx => {
    if (tx.isError === "1") return;
    const addr = tx.from?.toLowerCase(); if (!addr) return;
    init(addr, tx.from);
    wallets[addr].swaps++;
    swapHashes[addr].add(tx.hash?.toLowerCase());
    stamp(wallets[addr], parseInt(tx.timeStamp));
  });

  // Process pool txs
  allPoolTxs.forEach(tx => {
    if (tx.isError === "1") return;
    const addr = tx.from?.toLowerCase(); if (!addr) return;
    const type = getTxType(tx);
    if (!type || type === "swap") return;
    init(addr, tx.from);
    if (type === "deposit")  { wallets[addr].deposits++;  liqHashes[addr].add(tx.hash?.toLowerCase()); }
    if (type === "withdraw") { wallets[addr].withdrawals++; }
    if (type === "claim")    { wallets[addr].claims++; }
    stamp(wallets[addr], parseInt(tx.timeStamp));
  });

  // 3. Router token transfers for swap volume — one transfer per tx per wallet
  const routerTokenTxs = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await apiGet(ROUTER_ADDR, "tokentx", 10000, page);
    if (!batch.length) break;
    routerTokenTxs.push(...batch);
    if (batch.length < 10000) break;
  }

  // 3. Get swap volume by fetching tokentx for each wallet found
  // Strategy: tokentx from router shows all transfers. We need transfers WHERE
  // the initiating wallet sent tokens TO the router (first leg of the swap)
  // Filter: from=wallet, to=router, hash matches a known swap hash
  const countedSwap = new Set();
  routerTokenTxs.forEach(t => {
    const from = t.from?.toLowerCase();
    const to   = t.to?.toLowerCase();
    const h    = t.hash?.toLowerCase();
    // User sends stablecoin TO router to initiate swap
    if (to !== ROUTER_ADDR) return;
    if (!wallets[from]) return;
    // Accept any tx hash where this wallet sent to router
    // (even if not in swapHashes — router tokentx may miss some)
    const key = `${from}:${h}`;
    if (countedSwap.has(key)) return;
    countedSwap.add(key);
    const dec = parseInt(t.tokenDecimal) || 6;
    const amt = parseFloat(t.value) / Math.pow(10, dec);
    if (!isNaN(amt) && isFinite(amt) && amt > 0 && amt < 1_000_000_000)
      wallets[from].swapVolumeUSD += amt;
  });

  // 4. Pool token transfers for liquidity volume
  const poolTokenTxsArr = await Promise.all(
    Object.values(POOLS).map(async p => {
      const all = [];
      for (let page = 1; page <= 3; page++) {
        const batch = await apiGet(p.address, "tokentx", 5000, page);
        if (!batch.length) break;
        all.push(...batch);
        if (batch.length < 5000) break;
      }
      return all;
    })
  );
  const allPoolTokenTxs = poolTokenTxsArr.flat();

  const countedLiq = new Set();
  allPoolTokenTxs.forEach(t => {
    const from = t.from?.toLowerCase();
    const to   = t.to?.toLowerCase();
    const h    = t.hash?.toLowerCase();
    if (!POOL_ADDRS.has(to)) return;
    if (!wallets[from]) return;
    const key = `${from}:${h}`;
    if (countedLiq.has(key)) return;
    countedLiq.add(key);
    const dec = parseInt(t.tokenDecimal) || 6;
    const amt = parseFloat(t.value) / Math.pow(10, dec);
    if (!isNaN(amt) && isFinite(amt) && amt > 0 && amt < 1_000_000_000)
      wallets[from].liqVolumeUSD += amt;
  });

  return Object.values(wallets)
    .map(w => ({
      address:        w.address,
      swaps:          w.swaps,
      deposits:       w.deposits,
      withdrawals:    w.withdrawals,
      claims:         w.claims,
      swapVolumeUSD:  Math.round(w.swapVolumeUSD),
      liqVolumeUSD:   Math.round(w.liqVolumeUSD),
      totalVolumeUSD: Math.round(w.swapVolumeUSD + w.liqVolumeUSD),
      sp:             calcSP(w.swapVolumeUSD, w.liqVolumeUSD),
      lastSeen:       w.lastSeen,
      firstSeen:      w.firstSeen,
      daysActive:     w.firstSeen < Infinity
        ? Math.max(1, Math.ceil((Math.floor(Date.now()/1000) - w.firstSeen) / 86400))
        : 1,
    }))
    // Rank by: swaps desc → swapVolumeUSD desc → sp desc
    .sort((a,b) => b.totalVolumeUSD - a.totalVolumeUSD || b.sp - a.sp)
    .slice(0, 50);
}

// ── UI COMPONENTS ──────────────────────────────────────────
function Spinner({ text }) {
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"60px 20px",gap:14}}>
      <div style={{width:42,height:42,borderRadius:"50%",border:"3px solid #1e293b",borderTopColor:"#00d4aa",animation:"spin 0.8s linear infinite"}}/>
      <div style={{fontSize:13,color:"#4a5568",textAlign:"center"}}>{text}</div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
function TierBadge({ sp }) {
  const t = getTier(sp);
  return <span style={{fontSize:11,background:`${t.color}18`,border:`1px solid ${t.color}44`,color:t.color,borderRadius:6,padding:"2px 8px",fontWeight:700,whiteSpace:"nowrap"}}>{t.icon} {t.name}</span>;
}
function StatBox({ label, value, color, sub, theme }) {
  const T = theme || DARK;
  return (
    <div style={{background:T.card2,border:`1px solid ${color}33`,borderRadius:12,padding:"14px 16px"}}>
      <div style={{fontSize:10,color:T.muted,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>{label}</div>
      <div style={{fontSize:20,fontWeight:800,color,fontFamily:"'Space Grotesk',monospace",letterSpacing:"-0.02em"}}>{value}</div>
      {sub&&<div style={{fontSize:11,color:T.muted,marginTop:3}}>{sub}</div>}
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
  return (
    <div style={{display:"flex",alignItems:"flex-end",gap:isMobile?6:12,height:130,padding:"4px 4px 0"}}>
      {buckets.map((b,i)=>(
        <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
          {b.volume>0&&<div style={{fontSize:9,color:"#4a5568",textAlign:"center"}}>{fmtUSD(b.volume)}</div>}
          <div style={{
            width:"100%",maxWidth:40,
            height:`${Math.max((b.volume/maxVol)*90,b.volume>0?8:2)}px`,
            background:b.volume>0?"linear-gradient(180deg,#00d4aa,#0088ff)":"#1e293b",
            borderRadius:4,transition:"height 0.4s",position:"relative"
          }}>
            {b.count>0&&<div style={{position:"absolute",top:-16,left:"50%",transform:"translateX(-50%)",fontSize:9,color:"#00d4aa",whiteSpace:"nowrap"}}>{b.count}tx</div>}
          </div>
          <div style={{fontSize:10,color:"#718096"}}>{b.label}</div>
        </div>
      ))}
    </div>
  );
}

// ── LEADERBOARD ROW ────────────────────────────────────────
function LeaderRow({ lp, rank, isMobile, expanded, onToggle, onView }) {
  const tier = getTier(lp.sp);
  const ac = ["#00d4aa","#0088ff","#8b5cf6","#f59e0b","#ef4444","#22c55e","#ec4899"];
  return (
    <div style={{background:rank<=3?`linear-gradient(135deg,${tier.color}08,#0d1525)`:"#0d1525",border:`1px solid ${rank<=3?tier.color+"44":"#1e293b"}`,borderRadius:12,padding:isMobile?"12px":"14px 18px",cursor:"pointer",marginBottom:8}}>
      <div onClick={onToggle} style={{display:"flex",alignItems:"center",gap:isMobile?8:14}}>
        <div style={{minWidth:32,textAlign:"center"}}>
          {rank<=3?<span style={{fontSize:20}}>{"🥇🥈🥉"[rank-1]}</span>:<span style={{fontSize:13,fontWeight:800,color:"#4a5568",fontFamily:"monospace"}}>#{rank}</span>}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,flex:1,minWidth:0}}>
          <div style={{width:isMobile?28:36,height:isMobile?28:36,borderRadius:"50%",flexShrink:0,background:`linear-gradient(135deg,${ac[rank%7]},#1e293b)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:800,color:"#060b18"}}>{lp.address[2]?.toUpperCase()}</div>
          <div style={{minWidth:0,flex:1}}>
            <div style={{fontSize:12,fontWeight:700,color:"#e2e8f0",fontFamily:"'Space Grotesk',monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{shortAddr(lp.address)}</div>
            <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2}}><TierBadge sp={lp.sp}/></div>
          </div>
        </div>
        {!isMobile&&<>
          <div style={{textAlign:"right",minWidth:90}}><div style={{fontSize:10,color:"#4a5568",marginBottom:2}}>⭐ SP</div><div style={{fontSize:15,fontWeight:800,color:"#f59e0b",fontFamily:"'Space Grotesk',monospace"}}>{lp.sp.toLocaleString()}</div></div>
          <div style={{textAlign:"right",minWidth:100}}><div style={{fontSize:10,color:"#4a5568",marginBottom:2}}>💰 Total Vol</div><div style={{fontSize:15,fontWeight:800,color:"#00d4aa",fontFamily:"'Space Grotesk',monospace"}}>{fmtUSD(lp.totalVolumeUSD||lp.swapVolumeUSD)}</div></div>
          <div style={{textAlign:"right",minWidth:55}}><div style={{fontSize:10,color:"#4a5568",marginBottom:2}}>⇄ Swaps</div><div style={{fontSize:14,fontWeight:800,color:"#e2e8f0",fontFamily:"'Space Grotesk',monospace"}}>{lp.swaps}</div></div>
          <div style={{textAlign:"right",minWidth:55}}><div style={{fontSize:10,color:"#4a5568",marginBottom:2}}>+ Liq</div><div style={{fontSize:14,fontWeight:800,color:"#00d4aa",fontFamily:"'Space Grotesk',monospace"}}>{lp.deposits||0}</div></div>
          <div style={{textAlign:"right",minWidth:55}}><div style={{fontSize:10,color:"#4a5568",marginBottom:2}}>− Liq</div><div style={{fontSize:14,fontWeight:800,color:"#ef4444",fontFamily:"'Space Grotesk',monospace"}}>{lp.withdrawals||0}</div></div>
          <div style={{textAlign:"right",minWidth:85}}><div style={{fontSize:10,color:"#4a5568",marginBottom:2}}>Last Seen</div><div style={{fontSize:12,fontWeight:700,color:"#e2e8f0"}}>{lp.lastSeen?timeAgo(lp.lastSeen):"—"}</div></div>
        </>}
        {isMobile&&<div style={{textAlign:"right",flexShrink:0}}><div style={{fontSize:13,fontWeight:800,color:"#f59e0b",fontFamily:"'Space Grotesk',monospace"}}>{lp.sp.toLocaleString()} SP</div><div style={{fontSize:11,color:"#00d4aa"}}>{fmtUSD(lp.swapVolumeUSD)}</div></div>}
        <div style={{color:"#4a5568",fontSize:11,flexShrink:0}}>{expanded?"▲":"▼"}</div>
      </div>
      {expanded&&(
        <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid #1e293b"}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8,marginBottom:10}}>
            {[
              {l:"SP Score",       v:`${lp.sp.toLocaleString()} SP`,      c:"#f59e0b"},
              {l:"Total Volume",   v:fmtUSD(lp.totalVolumeUSD||lp.swapVolumeUSD), c:"#00d4aa"},
              {l:"Swap Volume",    v:fmtUSD(lp.swapVolumeUSD),             c:"#00d4aa"},
              {l:"Liq Volume",     v:fmtUSD(lp.liqVolumeUSD||0),           c:"#8b5cf6"},
              {l:"Swaps",          v:lp.swaps,                             c:"#e2e8f0"},
              {l:"Add Liquidity",  v:lp.deposits||0,                       c:"#00d4aa"},
              {l:"Remove Liq",     v:lp.withdrawals||0,                    c:"#ef4444"},
              {l:"Claims",         v:lp.claims||0,                         c:"#8b5cf6"},
              {l:"Days Active",    v:lp.daysActive,                        c:"#718096"},
              {l:"Last Seen",      v:lp.lastSeen?timeAgo(lp.lastSeen):"—", c:"#718096"},
            ].map(s=>(
              <div key={s.l} style={{background:`${s.c}10`,border:`1px solid ${s.c}22`,borderRadius:8,padding:"8px 10px"}}>
                <div style={{fontSize:10,color:"#4a5568"}}>{s.l}</div>
                <div style={{fontSize:13,fontWeight:700,color:s.c,fontFamily:"'Space Grotesk',monospace"}}>{s.v}</div>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center",justifyContent:"space-between",flexWrap:"wrap"}}>
            <a href={`https://sepolia.etherscan.io/address/${lp.address}`} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} style={{fontSize:11,color:"#4a5568",fontFamily:"monospace",textDecoration:"none"}}>{lp.address} ↗</a>
            <button onClick={e=>{e.stopPropagation();onView(lp);}} style={{background:"#00d4aa18",border:"1px solid #00d4aa44",color:"#00d4aa",borderRadius:6,padding:"5px 12px",fontSize:11,cursor:"pointer",fontWeight:700}}>View Activity →</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── ACTIVITY TRACKER ───────────────────────────────────────
function ActivityTracker({ isMobile, jumpWallet, board, T }) {
  T = T || DARK;
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
    const a=(addr||input).trim();
    if(!a||a.length<10) return;
    setLoading(true);setError("");setEvents([]);setDone(false);setWallet(a);
    try {
      const txs = await getWalletData(a);
      setEvents(txs);
      if(!txs.length) setError("No Stabilizer swap or claim transactions found for this wallet.");
    } catch { setError("Failed to fetch. Please try again."); }
    setLoading(false);setDone(true);
  },[input]);

  const rangeMs   = range==="daily"?7*86400:range==="weekly"?28*86400:180*86400;
  const chartEvts = useMemo(()=>events.filter(e=>Math.floor(Date.now()/1000)-parseInt(e.timeStamp)<=rangeMs),[events,rangeMs]);
  const displayed = useMemo(()=>filter==="all"?events:events.filter(e=>e.txType===filter),[events,filter]);

  const totalVol     = events.filter(e=>e.txType==="swap").reduce((s,e)=>s+e.volumeUSD,0);
  const totalSP      = calcSP(totalVol, 0);
  const swapCount    = events.filter(e=>e.txType==="swap").length;
  const claimCount   = events.filter(e=>e.txType==="claim").length;
  const lastSeen     = events.length?events[0].timeStamp:null;
  const firstSeen    = events.length?events[events.length-1].timeStamp:null;
  const daysActive   = firstSeen?Math.max(1,Math.ceil((Math.floor(Date.now()/1000)-parseInt(firstSeen))/86400)):0;
  const tier         = getTier(totalSP);

  // Find leaderboard rank for this wallet
  const lbRank = useMemo(()=>{
    if (!board?.length || !wallet) return null;
    const idx = board.findIndex(w => w.address.toLowerCase() === wallet.toLowerCase());
    return idx >= 0 ? idx + 1 : null;
  },[board, wallet]);

  const periodStats = useMemo(()=>{
    const s={swaps:0,vol:0,claims:0};
    chartEvts.forEach(e=>{
      if(e.txType==="swap"){s.swaps++;s.vol+=e.volumeUSD||0;}
      if(e.txType==="claim") s.claims++;
    });
    return s;
  },[chartEvts]);

  const sec={background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:isMobile?14:20};

  return (
    <div style={{display:"flex",flexDirection:"column",gap:18}}>
      {/* Search */}
      <div style={sec}>
        <div style={{fontSize:12,color:T.muted,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:12}}>🔍 Wallet Activity Tracker</div>
        <div style={{display:"flex",gap:10}}>
          <input type="text" placeholder="Enter Sepolia wallet address (0x...)"
            value={input} onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&runSearch(input)}
            style={{flex:1,background:T.input,border:`1.5px solid ${T.border2}`,color:T.text,borderRadius:10,padding:"12px 16px",fontSize:15,fontFamily:"'Space Grotesk',monospace"}}
          />
          <button onClick={()=>runSearch(input)} disabled={loading} style={{background:"linear-gradient(135deg,#00d4aa,#0088ff)",border:"none",borderRadius:10,padding:"0 22px",color:"#060b18",fontWeight:800,fontSize:14,cursor:"pointer",opacity:loading?0.7:1,minWidth:90}}>
            {loading?"...":"Search"}
          </button>
        </div>
        <div style={{fontSize:11,color:T.muted,marginTop:8}}>Tracks Swaps & Claim Fee transactions · Router + T/C/S/P-Pool on Sepolia</div>
      </div>

      {loading&&<Spinner text="Fetching all transactions from Sepolia... this may take a moment"/>}
      {!loading&&error&&<div style={{background:"#ef444415",border:"1px solid #ef444433",borderRadius:12,padding:"16px 20px",fontSize:13,color:"#ef4444"}}>{error}</div>}

      {!loading&&done&&events.length>0&&<>
        {/* Hero card */}
        <div style={{background:`linear-gradient(135deg,${tier.color}12,${T.card})`,border:`2px solid ${tier.color}44`,borderRadius:18,padding:isMobile?18:28}}>
          <div style={{display:"flex",alignItems:"flex-start",gap:14,marginBottom:20,flexWrap:"wrap"}}>
            <div style={{position:"relative",flexShrink:0}}>
              <div style={{width:52,height:52,borderRadius:"50%",background:`linear-gradient(135deg,${tier.color},#1e293b)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,fontWeight:800,color:"#060b18"}}>{wallet[2]?.toUpperCase()}</div>
              {lbRank&&(
                <div style={{position:"absolute",bottom:-6,right:-6,background:"#f59e0b",borderRadius:"50%",width:22,height:22,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:800,color:"#060b18",border:`2px solid ${T.card}`}}>
                  #{lbRank}
                </div>
              )}
            </div>
            <div style={{flex:1,minWidth:180}}>
              <div style={{fontSize:15,fontWeight:700,color:T.text,fontFamily:"'Space Grotesk',monospace",marginBottom:6}}>{shortAddr(wallet)}</div>
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                <TierBadge sp={totalSP}/>
                {lbRank&&(
                  <span style={{fontSize:12,background:"#f59e0b18",border:"1px solid #f59e0b44",color:"#f59e0b",borderRadius:6,padding:"2px 8px",fontWeight:700}}>
                    🏆 Rank #{lbRank}
                  </span>
                )}
                <span style={{fontSize:12,color:T.muted}}>{daysActive} days active</span>
                {lastSeen&&<span style={{fontSize:12,color:"#00d4aa",fontWeight:600}}>Last seen: {timeAgo(lastSeen)}</span>}
              </div>
            </div>
            <a href={`https://sepolia.etherscan.io/address/${wallet}`} target="_blank" rel="noreferrer" style={{fontSize:12,color:"#00d4aa",textDecoration:"none",border:"1px solid #00d4aa44",borderRadius:8,padding:"6px 14px",flexShrink:0}}>Etherscan ↗</a>
          </div>

          <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"repeat(4,1fr)",gap:12,marginBottom:16}}>
            <StatBox label="⭐ SP Score"    value={totalSP.toLocaleString()} color="#f59e0b" sub="$1,000 swap = 10 SP" theme={T}/>
            <StatBox label="💰 Swap Volume" value={fmtUSD(totalVol)}         color="#00d4aa" theme={T}/>
            <StatBox label="⇄ Swaps"       value={swapCount}                 color="#e2e8f0" theme={T}/>
            <StatBox
              label="🏆 Leaderboard Rank"
              value={lbRank ? `#${lbRank}` : "—"}
              color="#f59e0b"
              sub={lbRank ? `Top ${((lbRank/Math.max(board?.length,1))*100).toFixed(1)}% of wallets` : "Not ranked yet"}
              theme={T}
            />
          </div>
        </div>

        {/* Chart */}
        <div style={sec}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:10}}>
            <div>
              <div style={{fontSize:12,color:"#4a5568",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:4}}>Swap Volume Activity</div>
              <div style={{fontSize:13,color:"#718096"}}>
                <span style={{color:"#00d4aa",fontWeight:700}}>{fmtUSD(periodStats.vol)}</span>
                <span style={{margin:"0 8px"}}>·</span>
                <span style={{color:"#e2e8f0"}}>{periodStats.swaps} swaps</span>
                <span style={{margin:"0 8px"}}>·</span>
                <span style={{color:"#f59e0b"}}>+{calcSP(periodStats.vol, 0).toLocaleString()} SP earned</span>
              </div>
            </div>
            <div style={{display:"flex",gap:6}}>
              {[{k:"daily",l:"Daily"},{k:"weekly",l:"Weekly"},{k:"monthly",l:"Monthly"}].map(o=>(
                <button key={o.k} onClick={()=>setRange(o.k)} style={{background:range===o.k?"#00d4aa22":"transparent",border:`1px solid ${range===o.k?"#00d4aa":"#2d3748"}`,color:range===o.k?"#00d4aa":"#718096",borderRadius:6,padding:"6px 14px",fontSize:12,cursor:"pointer",fontWeight:600}}>{o.l}</button>
              ))}
            </div>
          </div>
          <ActivityChart events={chartEvts.filter(e=>e.txType==="swap")} range={range} isMobile={isMobile}/>
        </div>

        {/* Filter tabs */}
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {[
            {k:"all",   l:`All (${events.length})`,      c:"#718096"},
            {k:"swap",  l:`⇄ Swaps (${swapCount})`,     c:"#f59e0b"},
            {k:"claim", l:`★ Claim Fees (${claimCount})`,c:"#8b5cf6"},
          ].map(f=>(
            <button key={f.k} onClick={()=>setFilter(f.k)} style={{background:filter===f.k?`${f.c}18`:"transparent",border:`1.5px solid ${filter===f.k?f.c:"#2d3748"}`,color:filter===f.k?f.c:"#4a5568",borderRadius:8,padding:"8px 16px",fontSize:12,cursor:"pointer",fontWeight:600}}>{f.l}</button>
          ))}
        </div>

        {/* Transaction feed */}
        <div style={{background:"#0d1525",border:"1px solid #1e293b",borderRadius:14,overflow:"hidden"}}>
          {!isMobile&&(
            <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr",gap:12,padding:"10px 16px",background:"#060b18",fontSize:10,color:"#4a5568",textTransform:"uppercase",letterSpacing:"0.08em",borderBottom:"1px solid #1e293b"}}>
              <div>Transaction</div><div>Volume</div><div>SP Earned</div><div>Date</div>
            </div>
          )}
          <div style={{maxHeight:500,overflowY:"auto"}}>
            {displayed.length===0
              ?<div style={{padding:"40px",textAlign:"center",color:"#4a5568"}}>No transactions.</div>
              :displayed.map((tx,i)=>{
                const isSwap = tx.txType==="swap";
                const info = isSwap
                  ? {label:"Swap",color:"#f59e0b",icon:"⇄"}
                  : {label:"Claim Fees",color:"#8b5cf6",icon:"★"};
                const sp = calcSP(tx.volumeUSD||0, 0);
                return (
                  <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",borderBottom:"1px solid #0f1a2e",background:i%2===0?"transparent":"#060b1844"}}>
                    <div style={{width:36,height:36,borderRadius:8,flexShrink:0,background:`${info.color}15`,border:`1px solid ${info.color}33`,display:"flex",alignItems:"center",justifyContent:"center",color:info.color,fontSize:16,fontWeight:800}}>{info.icon}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:3}}>
                        <span style={{fontSize:13,fontWeight:700,color:info.color}}>{info.label}</span>
                        <span style={{fontSize:11,background:`${POOLS[tx.poolKey].color}18`,color:POOLS[tx.poolKey].color,borderRadius:4,padding:"1px 6px"}}>{tx.poolLabel}</span>
                        {isSwap&&tx.volumeUSD>0&&<span style={{fontSize:13,color:"#00d4aa",fontFamily:"'Space Grotesk',monospace",fontWeight:700}}>{fmtUSD(tx.volumeUSD)}</span>}
                        {isSwap&&sp>0&&<span style={{fontSize:11,color:"#f59e0b"}}>+{sp} SP</span>}
                      </div>
                      <div style={{fontSize:11,color:"#4a5568",display:"flex",gap:8}}>
                        <span>{fmtDate(tx.timeStamp)}</span>
                        <span>·</span>
                        <a href={`https://sepolia.etherscan.io/tx/${tx.hash}`} target="_blank" rel="noreferrer" style={{color:"#2d3748",textDecoration:"none"}}>{tx.hash.slice(0,10)}...↗</a>
                      </div>
                    </div>
                    <div style={{fontSize:11,color:"#22c55e",fontWeight:700,flexShrink:0}}>✓</div>
                  </div>
                );
              })
            }
          </div>
        </div>
      </>}

      {!loading&&!done&&(
        <div style={{textAlign:"center",padding:"80px 20px",color:"#4a5568",lineHeight:2.4}}>
          <div style={{fontSize:52,marginBottom:16}}>🔍</div>
          <div style={{fontSize:16,fontWeight:700,color:"#718096",marginBottom:8}}>Track any Stabilizer wallet</div>
          <div style={{fontSize:13}}>Swap count · Volume · SP score<br/>Daily / Weekly / Monthly activity</div>
        </div>
      )}
    </div>
  );
}

// ── MAIN APP ───────────────────────────────────────────────
export default function App() {
  const isMobile    = useIsMobile();
  const [tab,       setTab]       = useState("leaderboard");
  const [sortBy,    setSortBy]    = useState("swaps");
  const [search,    setSearch]    = useState("");
  const [tierF,     setTierF]     = useState("all");
  const [expanded,  setExpanded]  = useState(null);
  const [board,     setBoard]     = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [updated,   setUpdated]   = useState(null);
  const [showAll,   setShowAll]   = useState(false);
  const [jumpWallet,setJumpWallet]= useState(null);
  const [darkMode,  setDarkMode]  = useState(true);

  const T = darkMode ? DARK : LIGHT;

  const loadBoard = useCallback(async()=>{
    setLoading(true);
    const data = await buildLeaderboard();
    setBoard(data);setUpdated(new Date());setLoading(false);
  },[]);

  useEffect(()=>{ loadBoard(); },[]);

  const sorted = useMemo(()=>{
    let d=[...board];
    if(tierF!=="all"){const t=TIERS.find(x=>x.name===tierF),nx=TIERS[TIERS.indexOf(t)-1];d=d.filter(w=>w.sp>=t.minSP&&(!nx||w.sp<nx.minSP));}
    if(search.trim()){const q=search.toLowerCase();d=d.filter(w=>w.address.toLowerCase().includes(q));}
    d.sort((a,b)=>sortBy==="swaps"?b.swaps-a.swaps:sortBy==="lastSeen"?b.lastSeen-a.lastSeen:sortBy==="swapVolumeUSD"?b.swapVolumeUSD-a.swapVolumeUSD:b.sp-a.sp);
    return d;
  },[board,tierF,search,sortBy]);

  const displayed=sorted;
  const totalSP  =board.reduce((s,w)=>s+w.sp,0);
  const totalVol =board.reduce((s,w)=>s+(w.totalVolumeUSD||w.swapVolumeUSD),0);
  const sec={background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:16};

  return (
    <div style={{minHeight:"100vh",background:T.bg,fontFamily:"'Inter','Segoe UI',sans-serif",color:T.text,transition:"background 0.3s,color 0.3s"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700;800&family=Inter:wght@400;500;600&display=swap');
        *{box-sizing:border-box;} input:focus{outline:none;border-color:#00d4aa!important;box-shadow:0 0 0 2px rgba(0,212,170,0.15);}
        button{font-family:inherit;} a{color:inherit;}
        ::-webkit-scrollbar{width:4px;} ::-webkit-scrollbar-track{background:${T.card};} ::-webkit-scrollbar-thumb{background:${T.border2};border-radius:2px;}
      `}</style>

      {/* Header */}
      <div style={{background:darkMode?"linear-gradient(180deg,#0a1628 0%,transparent 100%)":T.header,borderBottom:`1px solid ${T.border}`,padding:isMobile?"14px 16px":"18px 24px",position:"sticky",top:0,zIndex:50,backdropFilter:"blur(12px)"}}>
        <div style={{maxWidth:960,margin:"0 auto",display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:38,height:38,borderRadius:10,flexShrink:0,background:"linear-gradient(135deg,#00d4aa,#0088ff)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,fontWeight:800,color:"#060b18"}}>S</div>
          <div>
            <div style={{fontSize:10,color:T.muted,letterSpacing:"0.1em",textTransform:"uppercase"}}>Stabilizer Protocol · Sepolia Testnet</div>
            <div style={{fontSize:isMobile?16:20,fontWeight:800,color:T.text,fontFamily:"'Space Grotesk',sans-serif",letterSpacing:"-0.02em"}}>{tab==="leaderboard"?"SP Leaderboard":"Activity Tracker"}</div>
          </div>
          <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8}}>
            {/* Dark/Light toggle */}
            <button onClick={()=>setDarkMode(v=>!v)} style={{
              background:darkMode?"#1e293b":"#e2e8f0",
              border:`1px solid ${T.border2}`,
              borderRadius:20,padding:"6px 12px",cursor:"pointer",
              fontSize:14,display:"flex",alignItems:"center",gap:6,
              color:T.text,transition:"all 0.3s"
            }}>
              {darkMode?"☀️ Light":"🌙 Dark"}
            </button>
            <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
              {updated&&<div style={{fontSize:10,color:"#00d4aa"}}>Live · {updated.toLocaleTimeString()}</div>}
              <button onClick={loadBoard} disabled={loading} style={{background:T.card,border:`1px solid ${T.border2}`,color:T.sub,borderRadius:6,padding:"4px 10px",fontSize:11,cursor:"pointer"}}>{loading?"Loading...":"↻ Refresh"}</button>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{borderBottom:`1px solid ${T.border}`,background:T.tabBg,position:"sticky",top:isMobile?62:70,zIndex:40}}>
        <div style={{maxWidth:960,margin:"0 auto",display:"flex"}}>
          {[{k:"leaderboard",l:"🏆 SP Leaderboard"},{k:"activity",l:"📊 Activity Tracker"}].map(t=>(
            <button key={t.k} onClick={()=>setTab(t.k)} style={{flex:1,padding:"11px",border:"none",cursor:"pointer",background:"none",fontSize:13,fontWeight:600,color:tab===t.k?"#00d4aa":T.muted,borderBottom:`2px solid ${tab===t.k?"#00d4aa":"transparent"}`,transition:"all 0.2s"}}>{t.l}</button>
          ))}
        </div>
      </div>

      <div style={{maxWidth:960,margin:"0 auto",padding:isMobile?"14px":"20px"}}>
        {tab==="activity"?<ActivityTracker isMobile={isMobile} jumpWallet={jumpWallet} board={board} T={T}/>:(<>

          <div style={{background:"#f59e0b0d",border:"1px solid #f59e0b22",borderRadius:10,padding:"10px 16px",marginBottom:16,fontSize:12,color:T.sub,display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:16}}>⭐</span>
            <span>Top 50 · Ranked by Total Volume (Swaps + Liquidity) · Swap $1,000 = 10 SP · LP $1,000 = 20 SP</span>
          </div>

          {loading?<Spinner text="Fetching leaderboard from Sepolia..."/>:(<>
            <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"repeat(4,1fr)",gap:12,marginBottom:16}}>
              {[
                {icon:"👛",label:"Active Wallets", value:board.length,             color:"#00d4aa"},
                {icon:"⭐",label:"Total SP",        value:board.reduce((s,w)=>s+w.sp,0).toLocaleString(), color:"#f59e0b"},
                {icon:"💰",label:"Total Volume",    value:fmtUSD(totalVol),          color:"#00d4aa"},
                {icon:"⇄",label:"Total Swaps",    value:board.reduce((s,w)=>s+w.swaps,0), color:T.text},
              ].map((s,i)=>(
                <div key={i} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"14px 16px"}}>
                  <div style={{fontSize:11,color:T.muted,marginBottom:6}}>{s.icon} {s.label}</div>
                  <div style={{fontSize:isMobile?17:21,fontWeight:800,color:s.color,fontFamily:"'Space Grotesk',monospace"}}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* Tier filter */}
            <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap"}}>
              <button onClick={()=>setTierF("all")} style={{background:tierF==="all"?`${T.border2}88`:"transparent",border:`1px solid ${tierF==="all"?T.text+"44":T.border2}`,color:tierF==="all"?T.text:T.muted,borderRadius:8,padding:"6px 12px",fontSize:12,cursor:"pointer",fontWeight:600}}>All Tiers</button>
              {TIERS.map(t=>{
                const cnt=board.filter(w=>{const nx=TIERS[TIERS.indexOf(t)-1];return w.sp>=t.minSP&&(!nx||w.sp<nx.minSP);}).length;
                return <button key={t.name} onClick={()=>setTierF(tierF===t.name?"all":t.name)} style={{background:tierF===t.name?`${t.color}18`:"transparent",border:`1px solid ${tierF===t.name?t.color:T.border2}`,color:tierF===t.name?t.color:T.muted,borderRadius:8,padding:"6px 12px",fontSize:12,cursor:"pointer",fontWeight:600}}>{t.icon} {t.name} <span style={{opacity:0.6}}>({cnt})</span></button>;
              })}
            </div>

            <div style={{...sec,marginBottom:14,display:"flex",flexDirection:"column",gap:12}}>
              <input type="text" placeholder="Search by wallet address..." value={search} onChange={e=>setSearch(e.target.value)}
                style={{width:"100%",background:T.input,border:`1px solid ${T.border2}`,color:T.text,borderRadius:10,padding:"10px 14px",fontSize:14,fontFamily:"'Space Grotesk',monospace"}}
              />
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {[{k:"swaps",l:"⇄ Swaps"},{k:"swapVolumeUSD",l:"💰 Volume"},{k:"sp",l:"⭐ SP Score"},{k:"lastSeen",l:"🕒 Recent"}].map(o=>(
                  <button key={o.k} onClick={()=>setSortBy(o.k)} style={{background:sortBy===o.k?"#00d4aa22":"transparent",border:`1.5px solid ${sortBy===o.k?"#00d4aa":T.border2}`,color:sortBy===o.k?"#00d4aa":T.sub,borderRadius:8,padding:"6px 12px",fontSize:12,cursor:"pointer",fontWeight:600}}>{o.l}</button>
                ))}
              </div>
            </div>

            {!isMobile&&(
              <div style={{display:"flex",alignItems:"center",gap:14,padding:"0 18px 8px",fontSize:10,color:T.muted,letterSpacing:"0.08em",textTransform:"uppercase"}}>
                <div style={{minWidth:32}}>Rank</div>
                <div style={{flex:1}}>Wallet</div>
                <div style={{minWidth:90,textAlign:"right"}}>⭐ SP</div>
                <div style={{minWidth:100,textAlign:"right"}}>💰 Total Vol</div>
                <div style={{minWidth:55,textAlign:"right"}}>⇄ Swaps</div>
                <div style={{minWidth:55,textAlign:"right"}}>+ Liq</div>
                <div style={{minWidth:55,textAlign:"right"}}>− Liq</div>
                <div style={{minWidth:85,textAlign:"right"}}>Last Seen</div>
                <div style={{minWidth:20}}></div>
              </div>
            )}

            {sorted.length===0
              ?<div style={{textAlign:"center",padding:"40px",color:T.muted}}>No wallets found.</div>
              :displayed.map((lp,i)=>(
                <LeaderRow key={lp.address} lp={lp} rank={i+1} isMobile={isMobile}
                  expanded={expanded===i} onToggle={()=>setExpanded(expanded===i?null:i)}
                  onView={lp=>{setJumpWallet(lp.address);setTab("activity");}}
                />
              ))
            }

            {sorted.length>25&&(
              <button onClick={()=>setShowAll(v=>!v)} style={{width:"100%",padding:"12px",background:T.card,border:`1px solid ${T.border2}`,color:T.muted,borderRadius:12,cursor:"pointer",fontSize:13,fontWeight:600,marginTop:4}}>
                {showAll?`Show less ▲`:`Show all ${sorted.length} wallets ▼`}
              </button>
            )}

            <div style={{display:"flex",gap:12,flexWrap:"wrap",marginTop:16,paddingTop:16,borderTop:`1px solid ${T.border}`}}>
              {Object.entries(POOLS).map(([k,v])=>(
                <div key={k} style={{display:"flex",alignItems:"center",gap:6}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:v.color}}/>
                  <span style={{fontSize:11,color:T.muted}}>{v.label} · {v.token}</span>
                </div>
              ))}
            </div>
          </>)}
        </>)}

        <div style={{marginTop:24,fontSize:11,color:T.muted,textAlign:"center",lineHeight:1.8}}>
          Stabilizer Protocol · Sepolia Testnet · Live on-chain data · <span style={{color:"#00d4aa"}}>stabilizer.fi</span>
        </div>
      </div>
    </div>
  );
}
