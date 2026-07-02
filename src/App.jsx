import { useState, useEffect, useMemo, useCallback } from "react";

// ─────────────────────────────────────────────
// LIVE SEPOLIA CONFIG
// ─────────────────────────────────────────────
const CONTRACTS = {
  tPool: "0x7C348b70F640B47b64ecDb154960D337ce7a98B4",
  cPool: "0x0578E5EA652C62DB20F4475F685A4b587314A30f",
  sPool: "0xC94fbB2C1DA52F8561A829a4838f117DD7316F54",
  pPool: "0x7Dd6979749b60C60eaaa55e4A50e732DAbc5DdD3",
};

const ETHERSCAN_API = "https://api-sepolia.etherscan.io/api";
const ETHERSCAN_KEY = "KA6YTCMDKVQRNVDEQ75SV6SQ3SQSJN5Y6V";

// ERC-20 Transfer event topic
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// Common deposit/withdraw event topic signatures
const DEPOSIT_TOPIC  = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";
const WITHDRAW_TOPIC = "0x884edad9ce6fa2440d8a54cc123490eb96d2768479d49ff9c7366125a9424364";
const SWAP_TOPIC     = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";

const POOLS = {
  tPool: { label: "T-Pool", color: "#26A17B", token: "USDT", address: CONTRACTS.tPool },
  cPool: { label: "C-Pool", color: "#2775CA", token: "USDC", address: CONTRACTS.cPool },
  sPool: { label: "S-Pool", color: "#8B5CF6", token: "USDS", address: CONTRACTS.sPool },
  pPool: { label: "P-Pool", color: "#0070F3", token: "PYUSD", address: CONTRACTS.pPool },
};

const ACTIVITY_TYPES = {
  swap:     { label: "Swap",               color: "#f59e0b", icon: "⇄" },
  deposit:  { label: "Liquidity Added",    color: "#00d4aa", icon: "+"  },
  withdraw: { label: "Liquidity Removed",  color: "#ef4444", icon: "−"  },
  transfer: { label: "Transfer",           color: "#94a3b8", icon: "→"  },
};

const TIERS = [
  { name: "Diamond", icon: "💎", minTxns: 50,  color: "#a5f3fc" },
  { name: "Gold",    icon: "🥇", minTxns: 20,  color: "#fbbf24" },
  { name: "Silver",  icon: "🥈", minTxns: 10,  color: "#94a3b8" },
  { name: "Bronze",  icon: "🥉", minTxns: 0,   color: "#b45309" },
];

const SORT_OPTIONS = [
  { key: "txCount",    label: "Most Active"  },
  { key: "lastSeen",   label: "Recent"       },
  { key: "pools",      label: "Pools Used"   },
];

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function getTier(txCount) {
  return TIERS.find(t => txCount >= t.minTxns) || TIERS[TIERS.length - 1];
}
function shortAddr(a) {
  return `${a.slice(0,6)}...${a.slice(-4)}`;
}
function timeAgo(ts) {
  const d = Date.now() - ts * 1000;
  const days = Math.floor(d / 86400000);
  const hrs  = Math.floor(d / 3600000);
  const mins = Math.floor(d / 60000);
  if (days > 0) return `${days}d ago`;
  if (hrs  > 0) return `${hrs}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}
function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function useIsMobile() {
  const [m, setM] = useState(window.innerWidth < 768);
  useEffect(() => {
    const h = () => setM(window.innerWidth < 768);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return m;
}

// ─────────────────────────────────────────────
// ETHERSCAN API CALLS
// ─────────────────────────────────────────────
async function fetchTxsForContract(contractAddress) {
  const url = `/api/etherscan?address=${contractAddress}&action=txlist`;
  try {
    const res  = await fetch(url);
    const data = await res.json();
    if (data.status === "1") return data.result;
    return [];
  } catch { return []; }
}

async function fetchTokenTransfers(contractAddress) {
  const url = `/api/etherscan?address=${contractAddress}&action=tokentx`;
  try {
    const res  = await fetch(url);
    const data = await res.json();
    if (data.status === "1") return data.result;
    return [];
  } catch { return []; }
}

async function fetchWalletTxs(walletAddress) {
  const results = [];
  const wallet = walletAddress.toLowerCase();
  const poolAddrs = Object.values(POOLS).map(p => p.address.toLowerCase());

  // Search by wallet address directly — much more efficient
  // Etherscan returns all txs for this wallet, we filter for Stabilizer contracts
  const url = `/api/etherscan?address=${walletAddress}&action=txlist&offset=10000`;
  try {
    const res  = await fetch(url);
    const data = await res.json();
    if (data.status === "1" && data.result.length > 0) {
      data.result.forEach(tx => {
        const toAddr   = tx.to?.toLowerCase();
        const fromAddr = tx.from?.toLowerCase();
        const matchedPool = Object.entries(POOLS).find(([k, v]) =>
          v.address.toLowerCase() === toAddr ||
          v.address.toLowerCase() === fromAddr
        );
        if (matchedPool) {
          results.push({
            ...tx,
            poolKey:   matchedPool[0],
            poolLabel: matchedPool[1].label,
            poolColor: matchedPool[1].color,
          });
        }
      });
    }
  } catch (e) {
    console.error("fetchWalletTxs error:", e);
  }
  return results.sort((a, b) => b.timeStamp - a.timeStamp);
}

function classifyTx(tx) {
  const input = tx.input?.toLowerCase() || "";
  // Common function selectors
  if (input.startsWith("0x38ed1739") || input.startsWith("0x7ff36ab5") || input.startsWith("0x18cbafe5") || input.startsWith("0xd0e30db0")) return "swap";
  if (input.startsWith("0xe8eda9df") || input.startsWith("0xb6b55f25") || input.startsWith("0x47e7ef24") || input.startsWith("0xf340fa01")) return "deposit";
  if (input.startsWith("0x69328dec") || input.startsWith("0x2e1a7d4d") || input.startsWith("0x441a3e70")) return "withdraw";
  if (input === "0x" || input === "") return "transfer";
  return "deposit"; // default to deposit for unknown contract interactions
}

// ─────────────────────────────────────────────
// BUILD LEADERBOARD FROM ON-CHAIN DATA
// ─────────────────────────────────────────────
async function buildLeaderboard() {
  const allTxs = [];
  for (const [poolKey, poolInfo] of Object.entries(POOLS)) {
    const url = `/api/etherscan?address=${poolInfo.address}&action=txlist`;
    try {
      const res  = await fetch(url);
      const data = await res.json();
      if (data.status === "1") {
        data.result.forEach(tx => allTxs.push({ ...tx, poolKey, poolLabel: poolInfo.label, poolColor: poolInfo.color }));
      }
    } catch {}
  }

  // Group by wallet (from address = the user interacting)
  const walletMap = {};
  allTxs.forEach(tx => {
    const addr = tx.from?.toLowerCase();
    if (!addr) return;
    if (!walletMap[addr]) {
      walletMap[addr] = {
        address: tx.from,
        txCount: 0,
        pools: new Set(),
        lastSeen: 0,
        firstSeen: Infinity,
        txs: [],
      };
    }
    walletMap[addr].txCount++;
    walletMap[addr].pools.add(tx.poolKey);
    const ts = parseInt(tx.timeStamp);
    if (ts > walletMap[addr].lastSeen)  walletMap[addr].lastSeen  = ts;
    if (ts < walletMap[addr].firstSeen) walletMap[addr].firstSeen = ts;
    walletMap[addr].txs.push(tx);
  });

  // Convert to array, compute pools count
  return Object.values(walletMap)
    .map(w => ({ ...w, pools: w.pools.size, poolsSet: [...w.pools] }))
    .sort((a, b) => b.txCount - a.txCount)
    .slice(0, 100);
}

// ─────────────────────────────────────────────
// UI COMPONENTS
// ─────────────────────────────────────────────
function TierBadge({ txCount }) {
  const t = getTier(txCount);
  return (
    <span style={{ fontSize: 11, background: `${t.color}18`, border: `1px solid ${t.color}44`, color: t.color, borderRadius: 6, padding: "2px 7px", fontWeight: 700 }}>
      {t.icon} {t.name}
    </span>
  );
}

function PoolDots({ poolsSet }) {
  return (
    <div style={{ display: "flex", gap: 4, marginTop: 3 }}>
      {Object.entries(POOLS).map(([key, info]) => (
        <div key={key} style={{
          width: 8, height: 8, borderRadius: "50%",
          background: poolsSet?.includes(key) ? info.color : "#1e293b",
          border: `1px solid ${poolsSet?.includes(key) ? info.color : "#2d3748"}`
        }} title={info.label} />
      ))}
    </div>
  );
}

function Spinner() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "60px 20px", gap: 16 }}>
      <div style={{
        width: 40, height: 40, borderRadius: "50%",
        border: "3px solid #1e293b", borderTopColor: "#00d4aa",
        animation: "spin 0.8s linear infinite"
      }} />
      <div style={{ fontSize: 13, color: "#4a5568" }}>Fetching on-chain data from Sepolia...</div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function ActivityChart({ events, range, isMobile }) {
  const buckets = useMemo(() => {
    const now = Date.now();
    let count, ms, labelFn;
    if      (range === "daily")  { count = 7; ms = 86400000;    labelFn = i => new Date(now-(6-i)*ms).toLocaleDateString(undefined,{weekday:"short"}); }
    else if (range === "weekly") { count = 4; ms = 7*86400000;  labelFn = i => `Wk${4-i}`; }
    else                         { count = 6; ms = 30*86400000; labelFn = i => new Date(now-(5-i)*ms).toLocaleDateString(undefined,{month:"short"}); }
    const arr = Array.from({length:count},(_,i) => ({label:labelFn(i), count:0}));
    events.forEach(ev => {
      const idx = count - 1 - Math.floor((now - ev.timeStamp*1000) / ms);
      if (idx >= 0 && idx < count) arr[idx].count++;
    });
    return arr;
  }, [events, range]);

  const maxCount = Math.max(...buckets.map(b => b.count), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: isMobile?4:10, height: 120, padding: "0 4px" }}>
      {buckets.map((b, i) => (
        <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          {b.count > 0 && <div style={{ fontSize: 10, color: "#4a5568" }}>{b.count}</div>}
          <div style={{
            width: "100%", maxWidth: 32,
            height: `${Math.max((b.count/maxCount)*80, b.count>0?6:2)}px`,
            background: b.count > 0 ? "linear-gradient(180deg,#00d4aa,#0088ff)" : "#1e293b",
            borderRadius: 4, transition: "height 0.4s ease"
          }} />
          <div style={{ fontSize: 10, color: "#718096" }}>{b.label}</div>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────
// LEADERBOARD ROW
// ─────────────────────────────────────────────
function LeaderRow({ lp, rank, isMobile, isExpanded, onToggle, onViewActivity }) {
  const tier = getTier(lp.txCount);
  const avatarColors = ["#00d4aa","#0088ff","#8b5cf6","#f59e0b","#ef4444","#22c55e","#ec4899"];
  const daysActive = lp.firstSeen < Infinity
    ? Math.max(1, Math.ceil((Date.now()/1000 - lp.firstSeen) / 86400))
    : 1;

  return (
    <div style={{
      background: rank <= 3 ? `linear-gradient(135deg,${tier.color}08,#0d1525)` : "#0d1525",
      border: `1px solid ${rank <= 3 ? tier.color+"33" : "#1e293b"}`,
      borderRadius: 12, padding: isMobile?"12px":"14px 18px",
      cursor: "pointer", marginBottom: 8,
    }}>
      <div onClick={onToggle} style={{ display:"flex", alignItems:"center", gap: isMobile?8:14 }}>
        {/* Rank */}
        <div style={{ minWidth:28, textAlign:"center", fontSize:13, fontWeight:800, color:"#4a5568", fontFamily:"monospace" }}>
          {rank<=3 ? ["🥇","🥈","🥉"][rank-1] : `#${rank}`}
        </div>

        {/* Avatar + name */}
        <div style={{ display:"flex", alignItems:"center", gap:8, flex:1, minWidth:0 }}>
          <div style={{
            width:isMobile?28:34, height:isMobile?28:34, borderRadius:"50%", flexShrink:0,
            background:`linear-gradient(135deg,${avatarColors[rank%7]},#1e293b)`,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:13, fontWeight:800, color:"#060b18"
          }}>{lp.address[2]?.toUpperCase()}</div>
          <div style={{ minWidth:0, flex:1 }}>
            <div style={{ fontSize:12, fontWeight:700, color:"#e2e8f0", fontFamily:"'Space Grotesk',monospace", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {shortAddr(lp.address)}
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:2, flexWrap:"wrap" }}>
              <TierBadge txCount={lp.txCount} />
              <PoolDots poolsSet={lp.poolsSet} />
            </div>
          </div>
        </div>

        {/* Desktop stats */}
        {!isMobile && (<>
          <div style={{ textAlign:"right", minWidth:80 }}>
            <div style={{ fontSize:10, color:"#4a5568", marginBottom:2 }}>Txns</div>
            <div style={{ fontSize:15, fontWeight:800, color:"#00d4aa", fontFamily:"'Space Grotesk',monospace" }}>{lp.txCount}</div>
          </div>
          <div style={{ textAlign:"right", minWidth:80 }}>
            <div style={{ fontSize:10, color:"#4a5568", marginBottom:2 }}>Pools</div>
            <div style={{ fontSize:15, fontWeight:800, color:"#8b5cf6", fontFamily:"'Space Grotesk',monospace" }}>{lp.pools}</div>
          </div>
          <div style={{ textAlign:"right", minWidth:90 }}>
            <div style={{ fontSize:10, color:"#4a5568", marginBottom:2 }}>Last Active</div>
            <div style={{ fontSize:12, fontWeight:700, color:"#e2e8f0" }}>{lp.lastSeen ? timeAgo(lp.lastSeen) : "—"}</div>
          </div>
          <div style={{ textAlign:"right", minWidth:50 }}>
            <div style={{ fontSize:10, color:"#4a5568", marginBottom:2 }}>Days</div>
            <div style={{ fontSize:15, fontWeight:800, color:"#e2e8f0", fontFamily:"'Space Grotesk',monospace" }}>{daysActive}</div>
          </div>
        </>)}

        {isMobile && (
          <div style={{ textAlign:"right", flexShrink:0 }}>
            <div style={{ fontSize:14, fontWeight:800, color:"#00d4aa", fontFamily:"'Space Grotesk',monospace" }}>{lp.txCount} txns</div>
            <div style={{ fontSize:11, color:"#718096" }}>{lp.lastSeen ? timeAgo(lp.lastSeen) : ""}</div>
          </div>
        )}
        <div style={{ color:"#4a5568", fontSize:11, flexShrink:0 }}>{isExpanded?"▲":"▼"}</div>
      </div>

      {isExpanded && (
        <div style={{ marginTop:12, paddingTop:12, borderTop:"1px solid #1e293b" }}>
          {/* Pool breakdown */}
          <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:10 }}>
            {Object.entries(POOLS).map(([key, info]) => {
              const count = lp.txs?.filter(t => t.poolKey === key).length || 0;
              if (!count) return null;
              return (
                <div key={key} style={{ background:`${info.color}15`, border:`1px solid ${info.color}33`, borderRadius:8, padding:"5px 10px" }}>
                  <div style={{ fontSize:10, color:info.color, fontWeight:700 }}>{info.label}</div>
                  <div style={{ fontSize:13, fontWeight:800, color:"#e2e8f0", fontFamily:"'Space Grotesk',monospace" }}>{count} txns</div>
                </div>
              );
            })}
          </div>
          <div style={{ display:"flex", gap:8, alignItems:"center", justifyContent:"space-between", flexWrap:"wrap" }}>
            <a href={`https://sepolia.etherscan.io/address/${lp.address}`} target="_blank" rel="noreferrer"
              style={{ fontSize:11, color:"#4a5568", fontFamily:"monospace", textDecoration:"none" }}
              onClick={e => e.stopPropagation()}>
              {lp.address} ↗
            </a>
            <button onClick={e=>{e.stopPropagation();onViewActivity(lp);}} style={{
              background:"#00d4aa18", border:"1px solid #00d4aa44", color:"#00d4aa",
              borderRadius:6, padding:"5px 12px", fontSize:11, cursor:"pointer", fontWeight:700, flexShrink:0
            }}>View Activity →</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// ACTIVITY TRACKER
// ─────────────────────────────────────────────
function ActivityTracker({ isMobile, jumpToWallet }) {
  const [walletInput,    setWalletInput]    = useState("");
  const [searchedWallet, setSearchedWallet] = useState(jumpToWallet || "");
  const [range,          setRange]          = useState("daily");
  const [typeFilter,     setTypeFilter]     = useState("all");
  const [events,         setEvents]         = useState([]);
  const [loading,        setLoading]        = useState(false);
  const [error,          setError]          = useState("");
  const [searched,       setSearched]       = useState(false);

  useEffect(() => { if (jumpToWallet) { setSearchedWallet(jumpToWallet); doSearch(jumpToWallet); } }, [jumpToWallet]);

  const doSearch = useCallback(async (addr) => {
    const target = addr || searchedWallet;
    if (!target.trim() || target.length < 10) return;
    setLoading(true); setError(""); setEvents([]); setSearched(true);
    try {
      const txs = await fetchWalletTxs(target.trim());
      setEvents(txs);
      if (txs.length === 0) setError("No transactions found for this address on Stabilizer contracts.");
    } catch {
      setError("Failed to fetch data. Check your address and try again.");
    }
    setLoading(false);
  }, [searchedWallet]);

  const rangeMs  = range==="daily"?7*86400000:range==="weekly"?28*86400000:180*86400000;
  const filtered = useMemo(()=>{
    const now = Date.now();
    return events.filter(e => {
      const inRange = (now - e.timeStamp*1000) <= rangeMs;
      const typeMatch = typeFilter === "all" || classifyTx(e) === typeFilter;
      return inRange && typeMatch;
    });
  },[events, rangeMs, typeFilter]);

  const summary = useMemo(()=>{
    const s = {swap:0,deposit:0,withdraw:0,transfer:0};
    events.filter(e=>(Date.now()-e.timeStamp*1000)<=rangeMs).forEach(e=>{s[classifyTx(e)]=(s[classifyTx(e)]||0)+1;});
    return s;
  },[events, rangeMs]);

  // Pool breakdown
  const poolBreakdown = useMemo(()=>{
    const m = {};
    events.forEach(e => { m[e.poolKey] = (m[e.poolKey]||0)+1; });
    return m;
  },[events]);

  const txCount  = events.length;
  const tier     = getTier(txCount);
  const lastSeen = events.length ? events[0].timeStamp : null;
  const firstSeen= events.length ? events[events.length-1].timeStamp : null;
  const daysActive = firstSeen ? Math.max(1, Math.ceil((Date.now()/1000 - firstSeen)/86400)) : 0;

  const sec = {background:"#0d1525",border:"1px solid #1e293b",borderRadius:14,padding:isMobile?14:18};

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>

      {/* Wallet search */}
      <div style={sec}>
        <div style={{ fontSize:11, color:"#4a5568", textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:10 }}>
          🔍 Look Up Wallet on Stabilizer Testnet
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <input type="text" placeholder="Paste Sepolia wallet address (0x...)"
            value={walletInput}
            onChange={e=>setWalletInput(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&doSearch(walletInput)}
            style={{ flex:1, background:"#0a0f1e", border:"1px solid #2d3748", color:"#e2e8f0", borderRadius:10, padding:"10px 14px", fontSize:14, fontFamily:"'Space Grotesk',monospace" }}
          />
          <button onClick={()=>doSearch(walletInput)} disabled={loading} style={{
            background:"linear-gradient(135deg,#00d4aa,#0088ff)", border:"none", borderRadius:10,
            padding:"0 16px", color:"#060b18", fontWeight:800, fontSize:13, cursor:"pointer", whiteSpace:"nowrap",
            opacity: loading ? 0.7 : 1
          }}>{loading ? "..." : "Search"}</button>
        </div>
        <div style={{ marginTop:8, fontSize:11, color:"#4a5568" }}>
          Enter any wallet that has interacted with Stabilizer T/C/S/P-Pool contracts on Sepolia
        </div>
      </div>

      {/* Loading */}
      {loading && <Spinner />}

      {/* Error */}
      {!loading && error && (
        <div style={{ background:"#ef444418", border:"1px solid #ef444433", borderRadius:12, padding:"16px", fontSize:13, color:"#ef4444" }}>
          {error}
        </div>
      )}

      {/* Results */}
      {!loading && !error && searched && events.length > 0 && (<>

        {/* Wallet summary */}
        <div style={{ background:`linear-gradient(135deg,${tier.color}10,#0d1525)`, border:`1.5px solid ${tier.color}33`, borderRadius:16, padding:isMobile?16:20 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14, flexWrap:"wrap" }}>
            <div style={{ width:38, height:38, borderRadius:"50%", background:`linear-gradient(135deg,${tier.color},#1e293b)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, fontWeight:800, color:"#060b18", flexShrink:0 }}>
              {(searchedWallet||walletInput)[2]?.toUpperCase()}
            </div>
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:"#e2e8f0", fontFamily:"'Space Grotesk',monospace" }}>
                {shortAddr(searchedWallet||walletInput)}
              </div>
              <div style={{ display:"flex", gap:8, marginTop:3, alignItems:"center", flexWrap:"wrap" }}>
                <TierBadge txCount={txCount} />
                <span style={{ fontSize:11, color:"#4a5568" }}>{daysActive}d active · {txCount} total txns</span>
                {lastSeen && <span style={{ fontSize:11, color:"#718096" }}>Last: {timeAgo(lastSeen)}</span>}
              </div>
            </div>
            <a href={`https://sepolia.etherscan.io/address/${searchedWallet||walletInput}`} target="_blank" rel="noreferrer"
              style={{ marginLeft:"auto", fontSize:11, color:"#00d4aa", textDecoration:"none", border:"1px solid #00d4aa33", borderRadius:6, padding:"4px 10px" }}>
              Etherscan ↗
            </a>
          </div>

          {/* Pool breakdown */}
          <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:14 }}>
            {Object.entries(POOLS).map(([key,info]) => poolBreakdown[key] > 0 && (
              <div key={key} style={{ background:`${info.color}15`, border:`1px solid ${info.color}33`, borderRadius:8, padding:"6px 12px" }}>
                <div style={{ fontSize:10, color:info.color, fontWeight:700 }}>{info.label}</div>
                <div style={{ fontSize:14, fontWeight:800, color:"#e2e8f0", fontFamily:"'Space Grotesk',monospace" }}>{poolBreakdown[key]} txns</div>
              </div>
            ))}
          </div>

          <div style={{ display:"grid", gridTemplateColumns:isMobile?"1fr 1fr":"repeat(4,1fr)", gap:10 }}>
            {[
              {l:"Total Txns",    v:txCount,            c:"#00d4aa"},
              {l:"Pools Used",    v:Object.keys(poolBreakdown).length, c:"#8b5cf6"},
              {l:"Days Active",   v:daysActive,         c:"#f59e0b"},
              {l:"Last Seen",     v:lastSeen?timeAgo(lastSeen):"—", c:"#e2e8f0"},
            ].map(s=>(
              <div key={s.l} style={{ background:"#0a0f1e", border:`1px solid ${s.c}33`, borderRadius:12, padding:"12px 14px" }}>
                <div style={{ fontSize:10, color:"#4a5568", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>{s.l}</div>
                <div style={{ fontSize:18, fontWeight:800, color:s.c, fontFamily:"'Space Grotesk',monospace" }}>{s.v}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Range toggle + chart */}
        <div style={sec}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14, flexWrap:"wrap", gap:8 }}>
            <div style={{ fontSize:11, color:"#4a5568", textTransform:"uppercase", letterSpacing:"0.08em" }}>
              Transaction Activity
            </div>
            <div style={{ display:"flex", gap:6 }}>
              {[{k:"daily",l:"7 Days"},{k:"weekly",l:"4 Weeks"},{k:"monthly",l:"6 Months"}].map(o=>(
                <button key={o.k} onClick={()=>setRange(o.k)} style={{
                  background:range===o.k?"#00d4aa22":"transparent",
                  border:`1px solid ${range===o.k?"#00d4aa":"#2d3748"}`,
                  color:range===o.k?"#00d4aa":"#718096",
                  borderRadius:6, padding:"5px 12px", fontSize:11, cursor:"pointer", fontWeight:600
                }}>{o.l}</button>
              ))}
            </div>
          </div>
          <ActivityChart events={events} range={range} isMobile={isMobile} />
        </div>

        {/* Activity type pills */}
        <div style={{ display:"grid", gridTemplateColumns:isMobile?"1fr 1fr":"repeat(4,1fr)", gap:10 }}>
          {Object.entries(ACTIVITY_TYPES).map(([key,info])=>(
            <button key={key} onClick={()=>setTypeFilter(typeFilter===key?"all":key)} style={{
              background:typeFilter===key?`${info.color}18`:"#0d1525",
              border:`1px solid ${typeFilter===key?info.color:"#1e293b"}`,
              borderRadius:12, padding:"12px", textAlign:"left", cursor:"pointer"
            }}>
              <div style={{ fontSize:18, color:info.color }}>{info.icon}</div>
              <div style={{ fontSize:11, color:"#718096", margin:"4px 0 2px" }}>{info.label}</div>
              <div style={{ fontSize:22, fontWeight:800, color:info.color, fontFamily:"'Space Grotesk',monospace" }}>{summary[key]||0}</div>
            </button>
          ))}
        </div>

        {/* Event feed */}
        <div style={{ background:"#0d1525", border:"1px solid #1e293b", borderRadius:14, overflow:"hidden" }}>
          <div style={{ padding:"12px 16px 8px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div style={{ fontSize:11, color:"#4a5568", textTransform:"uppercase", letterSpacing:"0.08em" }}>
              {typeFilter!=="all"?`${ACTIVITY_TYPES[typeFilter].label} · `:""}Transactions
              <span style={{ color:"#00d4aa", marginLeft:6 }}>({filtered.length})</span>
            </div>
            {typeFilter!=="all"&&<button onClick={()=>setTypeFilter("all")} style={{ background:"none", border:"none", color:"#4a5568", fontSize:11, cursor:"pointer" }}>Clear ✕</button>}
          </div>
          <div style={{ maxHeight:420, overflowY:"auto" }}>
            {filtered.length===0
              ? <div style={{ padding:"30px", textAlign:"center", color:"#4a5568", fontSize:13 }}>No transactions in this range.</div>
              : filtered.map((tx,i)=>{
                  const type=ACTIVITY_TYPES[classifyTx(tx)];
                  return (
                    <div key={i} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 16px", borderBottom:"1px solid #0f1a2e" }}>
                      <div style={{ width:32, height:32, borderRadius:8, flexShrink:0, background:`${type.color}18`, border:`1px solid ${type.color}33`, display:"flex", alignItems:"center", justifyContent:"center", color:type.color, fontSize:14, fontWeight:800 }}>{type.icon}</div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:13, fontWeight:600, color:"#e2e8f0" }}>{type.label}</div>
                        <div style={{ fontSize:11, color:"#718096", display:"flex", gap:6, flexWrap:"wrap" }}>
                          <span style={{ color:POOLS[tx.poolKey]?.color }}>{tx.poolLabel}</span>
                          <span>·</span>
                          <span>{fmtDate(tx.timeStamp)}</span>
                          <span>·</span>
                          <a href={`https://sepolia.etherscan.io/tx/${tx.hash}`} target="_blank" rel="noreferrer"
                            style={{ color:"#4a5568", textDecoration:"none" }}>view tx ↗</a>
                        </div>
                      </div>
                      <div style={{ fontSize:11, color:"#4a5568", fontFamily:"monospace", flexShrink:0, textAlign:"right" }}>
                        <div style={{ color: tx.isError==="1" ? "#ef4444" : "#22c55e" }}>
                          {tx.isError==="1" ? "Failed" : "Success"}
                        </div>
                      </div>
                    </div>
                  );
                })
            }
          </div>
        </div>
      </>)}

      {/* Empty state */}
      {!loading && !searched && (
        <div style={{ textAlign:"center", padding:"60px 20px", color:"#4a5568", fontSize:14, lineHeight:2 }}>
          <div style={{ fontSize:40, marginBottom:12 }}>🔍</div>
          Enter a wallet address above to see its full activity<br/>
          across all 4 Stabilizer pools on Sepolia testnet.
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────
export default function StabilizerLeaderboard() {
  const isMobile    = useIsMobile();
  const [activeTab,   setActiveTab]   = useState("leaderboard");
  const [sortBy,      setSortBy]      = useState("txCount");
  const [filterPool,  setFilterPool]  = useState("all");
  const [filterTier,  setFilterTier]  = useState("all");
  const [expandedIdx, setExpandedIdx] = useState(null);
  const [searchVal,   setSearchVal]   = useState("");
  const [jumpWallet,  setJumpWallet]  = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [showAll,     setShowAll]     = useState(false);

  const loadLeaderboard = useCallback(async () => {
    setLoading(true);
    const data = await buildLeaderboard();
    setLeaderboard(data);
    setLastUpdated(new Date());
    setLoading(false);
  }, []);

  useEffect(() => { loadLeaderboard(); }, []);

  const handleViewActivity = (lp) => {
    setJumpWallet(lp.address);
    setActiveTab("activity");
  };

  const sorted = useMemo(() => {
    let data = [...leaderboard];
    if (filterPool !== "all") data = data.filter(lp => lp.poolsSet?.includes(filterPool));
    if (filterTier !== "all") {
      const tier = TIERS.find(t => t.name === filterTier);
      const nextTier = TIERS[TIERS.indexOf(tier)-1];
      data = data.filter(lp => lp.txCount >= tier.minTxns && (!nextTier || lp.txCount < nextTier.minTxns));
    }
    if (searchVal.trim()) {
      const q = searchVal.toLowerCase();
      data = data.filter(lp => lp.address.toLowerCase().includes(q));
    }
    data.sort((a, b) => {
      if (sortBy === "txCount")  return b.txCount - a.txCount;
      if (sortBy === "lastSeen") return b.lastSeen - a.lastSeen;
      if (sortBy === "pools")    return b.pools - a.pools;
      return 0;
    });
    return data;
  }, [leaderboard, sortBy, filterPool, filterTier, searchVal]);

  const displayed = showAll ? sorted : sorted.slice(0, 25);

  const totalTxns   = leaderboard.reduce((s, lp) => s + lp.txCount, 0);
  const totalWallets = leaderboard.length;
  const poolCounts  = Object.fromEntries(Object.keys(POOLS).map(k => [k, leaderboard.filter(lp=>lp.poolsSet?.includes(k)).length]));

  const sec = {background:"#0d1525",border:"1px solid #1e293b",borderRadius:14,padding:16};

  return (
    <div style={{ minHeight:"100vh", background:"linear-gradient(160deg,#060b18 0%,#080d1a 50%,#06101f 100%)", fontFamily:"'Inter','Segoe UI',sans-serif", color:"#e2e8f0" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700;800&family=Inter:wght@400;500;600&display=swap');
        *{box-sizing:border-box;}
        input:focus{outline:none;border-color:#00d4aa!important;box-shadow:0 0 0 2px rgba(0,212,170,0.15);}
        button{font-family:inherit;}
        ::-webkit-scrollbar{width:4px;}
        ::-webkit-scrollbar-track{background:#0d1525;}
        ::-webkit-scrollbar-thumb{background:#2d3748;border-radius:2px;}
        a{color:inherit;}
      `}</style>

      {/* Header */}
      <div style={{ background:"linear-gradient(180deg,#0a1628 0%,transparent 100%)", borderBottom:"1px solid #1e293b", padding:isMobile?"14px 16px":"18px 24px", position:"sticky", top:0, zIndex:50, backdropFilter:"blur(12px)" }}>
        <div style={{ maxWidth:940, margin:"0 auto", display:"flex", alignItems:"center", gap:12 }}>
          <div style={{ width:36, height:36, borderRadius:10, flexShrink:0, background:"linear-gradient(135deg,#00d4aa,#0088ff)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, fontWeight:800, color:"#060b18" }}>S</div>
          <div>
            <div style={{ fontSize:10, color:"#4a5568", letterSpacing:"0.1em", textTransform:"uppercase" }}>Stabilizer Protocol · Sepolia Testnet</div>
            <div style={{ fontSize:isMobile?16:20, fontWeight:800, color:"#f0f4f8", fontFamily:"'Space Grotesk',sans-serif", letterSpacing:"-0.02em" }}>
              {activeTab==="leaderboard"?"LP Leaderboard":"Activity Tracker"}
            </div>
          </div>
          <div style={{ marginLeft:"auto", display:"flex", flexDirection:"column", alignItems:"flex-end", gap:4 }}>
            {lastUpdated && <div style={{ fontSize:10, color:"#00d4aa" }}>Live · {lastUpdated.toLocaleTimeString()}</div>}
            <button onClick={loadLeaderboard} disabled={loading} style={{ background:"#0d1525", border:"1px solid #2d3748", color:"#718096", borderRadius:6, padding:"4px 10px", fontSize:11, cursor:"pointer" }}>
              {loading ? "Loading..." : "↻ Refresh"}
            </button>
          </div>
        </div>
      </div>

      {/* Tab nav */}
      <div style={{ borderBottom:"1px solid #1e293b", background:"#0a0f1e", position:"sticky", top:isMobile?62:70, zIndex:40 }}>
        <div style={{ maxWidth:940, margin:"0 auto", display:"flex" }}>
          {[{key:"leaderboard",label:"🏆 Leaderboard"},{key:"activity",label:"📊 Activity Tracker"}].map(t=>(
            <button key={t.key} onClick={()=>setActiveTab(t.key)} style={{ flex:1, padding:"11px", border:"none", cursor:"pointer", background:"none", fontSize:13, fontWeight:600, color:activeTab===t.key?"#00d4aa":"#4a5568", borderBottom:`2px solid ${activeTab===t.key?"#00d4aa":"transparent"}`, transition:"all 0.2s" }}>{t.label}</button>
          ))}
        </div>
      </div>

      <div style={{ maxWidth:940, margin:"0 auto", padding:isMobile?"14px":"20px" }}>

        {activeTab==="activity" ? (
          <ActivityTracker isMobile={isMobile} jumpToWallet={jumpWallet} />
        ) : (<>

          {/* Live data banner */}
          <div style={{ background:"#00d4aa0d", border:"1px solid #00d4aa22", borderRadius:10, padding:"10px 16px", marginBottom:16, fontSize:12, color:"#718096", display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ color:"#00d4aa", fontSize:14 }}>🔴</span>
            <span>Live data from Sepolia testnet · Contracts: T-Pool, C-Pool, S-Pool, P-Pool · Updates on refresh</span>
          </div>

          {/* Summary stats */}
          {loading ? <Spinner /> : (
            <>
              <div style={{ display:"grid", gridTemplateColumns:isMobile?"1fr 1fr":"repeat(4,1fr)", gap:12, marginBottom:16 }}>
                {[
                  {icon:"👛", label:"Active Wallets",  value:totalWallets,  color:"#00d4aa"},
                  {icon:"⚡", label:"Total Txns",       value:totalTxns,     color:"#f59e0b"},
                  {icon:"🏊", label:"T-Pool Users",     value:poolCounts.tPool||0, color:"#26A17B"},
                  {icon:"🏊", label:"C-Pool Users",     value:poolCounts.cPool||0, color:"#2775CA"},
                ].map((s,i)=>(
                  <div key={i} style={{ background:"#0d1525", border:"1px solid #1e293b", borderRadius:12, padding:"14px 16px" }}>
                    <div style={{ fontSize:11, color:"#4a5568", marginBottom:6 }}>{s.icon} {s.label}</div>
                    <div style={{ fontSize:20, fontWeight:800, color:s.color, fontFamily:"'Space Grotesk',monospace" }}>{s.value}</div>
                  </div>
                ))}
              </div>

              {/* Tier filter */}
              <div style={{ display:"flex", gap:8, marginBottom:14, flexWrap:"wrap" }}>
                <button onClick={()=>setFilterTier("all")} style={{ background:filterTier==="all"?"#ffffff15":"transparent", border:`1px solid ${filterTier==="all"?"#ffffff44":"#2d3748"}`, color:filterTier==="all"?"#e2e8f0":"#4a5568", borderRadius:8, padding:"6px 12px", fontSize:12, cursor:"pointer", fontWeight:600 }}>All Tiers</button>
                {TIERS.map(t=>{
                  const count=leaderboard.filter(lp=>{
                    const next=TIERS[TIERS.indexOf(t)-1];
                    return lp.txCount>=t.minTxns&&(!next||lp.txCount<next.minTxns);
                  }).length;
                  return (
                    <button key={t.name} onClick={()=>setFilterTier(filterTier===t.name?"all":t.name)} style={{ background:filterTier===t.name?`${t.color}18`:"transparent", border:`1px solid ${filterTier===t.name?t.color:"#2d3748"}`, color:filterTier===t.name?t.color:"#4a5568", borderRadius:8, padding:"6px 12px", fontSize:12, cursor:"pointer", fontWeight:600 }}>
                      {t.icon} {t.name} <span style={{ opacity:0.6 }}>({count})</span>
                    </button>
                  );
                })}
              </div>

              {/* Filters */}
              <div style={{ ...sec, marginBottom:14, display:"flex", flexDirection:"column", gap:12 }}>
                <input type="text" placeholder="Search by wallet address..."
                  value={searchVal} onChange={e=>setSearchVal(e.target.value)}
                  style={{ width:"100%", background:"#0a0f1e", border:"1px solid #2d3748", color:"#e2e8f0", borderRadius:10, padding:"10px 14px", fontSize:14, fontFamily:"'Space Grotesk',monospace" }}
                />
                <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
                  <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                    {SORT_OPTIONS.map(opt=>(
                      <button key={opt.key} onClick={()=>setSortBy(opt.key)} style={{ background:sortBy===opt.key?"#00d4aa22":"transparent", border:`1.5px solid ${sortBy===opt.key?"#00d4aa":"#2d3748"}`, color:sortBy===opt.key?"#00d4aa":"#718096", borderRadius:8, padding:"6px 12px", fontSize:12, cursor:"pointer", fontWeight:600 }}>{opt.label}</button>
                    ))}
                  </div>
                  <div style={{ display:"flex", gap:6, marginLeft:"auto", flexWrap:"wrap" }}>
                    <button onClick={()=>setFilterPool("all")} style={{ background:filterPool==="all"?"#ffffff15":"transparent", border:`1px solid ${filterPool==="all"?"#ffffff44":"#2d3748"}`, color:filterPool==="all"?"#e2e8f0":"#4a5568", borderRadius:6, padding:"5px 10px", fontSize:11, cursor:"pointer" }}>All</button>
                    {Object.entries(POOLS).map(([k,info])=>(
                      <button key={k} onClick={()=>setFilterPool(k)} style={{ background:filterPool===k?`${info.color}22`:"transparent", border:`1px solid ${filterPool===k?info.color:"#2d3748"}`, color:filterPool===k?info.color:"#4a5568", borderRadius:6, padding:"5px 10px", fontSize:11, cursor:"pointer" }}>{info.label}</button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Column headers */}
              {!isMobile&&(
                <div style={{ display:"flex", alignItems:"center", gap:14, padding:"0 18px 8px", fontSize:10, color:"#4a5568", letterSpacing:"0.08em", textTransform:"uppercase" }}>
                  <div style={{ minWidth:28 }}>Rank</div>
                  <div style={{ flex:1 }}>Wallet / Tier</div>
                  <div style={{ minWidth:80, textAlign:"right" }}>Txns</div>
                  <div style={{ minWidth:80, textAlign:"right" }}>Pools</div>
                  <div style={{ minWidth:90, textAlign:"right" }}>Last Active</div>
                  <div style={{ minWidth:50, textAlign:"right" }}>Days</div>
                  <div style={{ minWidth:20 }}></div>
                </div>
              )}

              {/* Rows */}
              {sorted.length===0
                ? <div style={{ textAlign:"center", padding:"40px", color:"#4a5568", fontSize:14 }}>No wallets found.</div>
                : displayed.map((lp,i)=>(
                  <LeaderRow key={lp.address} lp={lp} rank={i+1} isMobile={isMobile}
                    isExpanded={expandedIdx===i}
                    onToggle={()=>setExpandedIdx(expandedIdx===i?null:i)}
                    onViewActivity={handleViewActivity}
                  />
                ))
              }

              {sorted.length>25&&(
                <button onClick={()=>setShowAll(v=>!v)} style={{ width:"100%", padding:"12px", background:"#0d1525", border:"1px solid #2d3748", color:"#718096", borderRadius:12, cursor:"pointer", fontSize:13, fontWeight:600, marginTop:4 }}>
                  {showAll?`Show less ▲`:`Show all ${sorted.length} wallets ▼`}
                </button>
              )}

              {/* Pool legend */}
              <div style={{ display:"flex", gap:12, flexWrap:"wrap", marginTop:16, paddingTop:16, borderTop:"1px solid #1e293b" }}>
                {Object.entries(POOLS).map(([k,info])=>(
                  <div key={k} style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <div style={{ width:8, height:8, borderRadius:"50%", background:info.color }} />
                    <span style={{ fontSize:11, color:"#4a5568" }}>{info.label} ({info.address.slice(0,6)}...{info.address.slice(-4)})</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>)}

        <div style={{ marginTop:24, fontSize:11, color:"#4a5568", textAlign:"center", lineHeight:1.7 }}>
          Live data from Ethereum Sepolia Testnet · Stabilizer Protocol
          <br/><span style={{ color:"#00d4aa" }}>stabilizer.fi</span>
        </div>
      </div>
    </div>
  );
}
