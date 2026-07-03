export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { address, action = "txlist", offset = 2000, page = 1 } = req.query;
  const API_KEY = "KA6YTCMDKVQRNVDEQ75SV6SQ3SQSJN5Y6V";
  const url = `https://api.etherscan.io/v2/api?chainid=11155111&module=account&action=${action}&address=${address}&startblock=0&endblock=99999999&page=${page}&offset=${offset}&sort=desc&apikey=${API_KEY}`;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8500);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    const data = await r.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(504).json({ status: "0", message: err.name === "AbortError" ? "timeout" : err.message, result: [] });
  }
}
