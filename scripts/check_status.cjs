const crypto = require('crypto');
const https = require('https');

const keyId = 'KALSHI_KEY_ID_PLACEHOLDER';
const privateKey = `PRIVATE_KEY_REDACTED`;

async function req(path) {
  return new Promise((resolve, reject) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const method = 'GET';
    const msgString = timestamp + method + path;
    const sign = crypto.sign('sha256', Buffer.from(msgString), privateKey);
    const sig = sign.toString('base64');
    const options = {
      hostname: 'api.elections.kalshi.com',
      path: path,
      method: method,
      headers: {
        'KALSHI-ACCESS-KEY': keyId,
        'KALSHI-ACCESS-SIGNATURE': sig,
        'KALSHI-ACCESS-TIMESTAMP': timestamp.toString()
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const bal = await req('/trade-api/v2/portfolio/balance');
  console.log('Balance Response:', JSON.stringify(bal, null, 2));
  
  // Check the settlement of the trade
  const settles = await req('/trade-api/v2/portfolio/settlements?limit=5');
  console.log('Recent Settlements:', JSON.stringify(settles, null, 2));
})();
