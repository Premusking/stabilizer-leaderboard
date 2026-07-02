export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const { address, action, offset = 10000 } = req.query;
  const API_KEY = "KA6YTCMDKVQRNVDEQ75SV6SQ3SQSJN5Y6V";

  const url = `https://api-sepolia.etherscan.io/api?module=account&action=${action || "txlist"}&address=${address}&startblock=0&endblock=99999999&page=1&offset=${offset}&sort=desc&apikey=${API_KEY}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    // Return full response including status and message for debugging
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ status: "0", message: err.message, result: [] });
  }
}
