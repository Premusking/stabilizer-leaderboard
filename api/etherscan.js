export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const { address, action, offset = 10000, page = 1 } = req.query;
  const API_KEY = "KA6YTCMDKVQRNVDEQ75SV6SQ3SQSJN5Y6V";

  const url = `https://api.etherscan.io/v2/api?chainid=11155111&module=account&action=${action || "txlist"}&address=${address}&startblock=0&endblock=99999999&page=${page}&offset=${offset}&sort=desc&apikey=${API_KEY}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    if (err.name === "AbortError") {
      res.status(504).json({ status: "0", message: "Request timed out", result: [] });
    } else {
      res.status(500).json({ status: "0", message: err.message, result: [] });
    }
  }
}
