const crypto = require('crypto');
const https = require('https');

const keyId = 'de8b272e-71a5-4823-a08e-f4dafe85d004';
const privateKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEogIBAAKCAQEAsImijem/NnlmEzvjV0690A1dctAtKGf2tRl3C8W/MQtzjbSm
AcVvi1jFl+q73wim6KVoxFXPrUy4Hr+eMVtFp8aYhmdFiqBqpQUJxQSIcc4X58fg
r1nXYPAEZqaK9LJo9VjSKi21o6pyi05vLZU4dt5Tn882T5mUYOJzgoCuVyyrQnCB
H5GGGmAmQWR4hANEe3K/z60TgVuKmyrjiVo9nt27Ucn9dnZFwokuMqt2KaytGdLv
JwpQUFfdrsM5GeLbB9z8ivZ3f0MDQQalTdd6+TffSckOwj5FC1dXui6vvtPYDbuc
o4ZtBOBxcHkQUiBPnFIXastcJRq3N86k/GbcQQIDAQABAoIBADMAWFeCZ6z/rocw
/pFrHLg+HDi+vsUVH/ea90MN6pnrMoOGZI1PclXCHDey53rcX4gHvXg3SEvLRcgQ
WM3ujfWWENuHe1Y82QJ6raNfF2I1hb9/BcDzBh+px8O2Kp/d6Se0dOcdlIPHitcH
HmR/XzQsL+GT9h9SAcVptrBFp9hkAmL58QjLl6xs7bAzcRc830qSlcv4YA9mcC8m
nNmj7b3IGQAHIoBKawaNo9fhVdPsR1H5RGKY7+Q3oMRG6Bb7El/5to9IeeZ8YB1+
iTbMMFx1ItLUmLeF47IL7opgELik8A+lepbTw3yBnnDlu0rSzE5nduc3dZuQAaWi
r8kUKvcCgYEA6eZiHTNj6PmMibjQOhI997Tu88i5KY101qjFrE1hzKD5b+GU49z0
KVV6wbYyGpUye1d0VwvbgJ1+5fxI98tSVp2WTCskZdr/LgpXsoZ4ZTNxJmDAAPml
a+Jzt0R02MvMThIbPqtXYXeLOX1XU5WpI3CpJxkQ2mCyx1cdoJxGOVcCgYEAwTfC
6nlC7F4rh7/+QF5lRffm6GFFUs3vKL8zaT67U/kL8q9JsS2LSZtZm9YmVES1bTbn
6J5tSsPGi6ADJMJBPR//TehZNXrHXuEneoL9gHVFsAHVf2KuV/6RErcJqNwyc6+F
3NptD867ihwjf8odHvG7dVfecrfQ/8o9+YO44CcCgYBYtsn1210Eq0nznoZT0EFy
p0yOaE5ahU2QcVjwPjVe4JtbJQtM1axB1SsHN+yPCpGoGIaG0XeCs7nCz0p5ucNU
GNc9sotOmp54vvF+Q+R8NeOvs7h/ZjCo164eD7fl1n56CgINZf1xeV70AidSC4yo
ZX2y1539xflpBBC3ry4vZwKBgDxkNWQcKrK+bFStycZMutK3vVB8trI+87WErYkD
toF0oitkZmAeoB6Nk+CFes1z/FD6jFnEytxHfNM/XDwtCz8TtTSgnuF8UrxxG2nL
b3irLvDoYdbC/UM7qhRzaW2CBbLq9agmDViXgT6VtPLINXnqjHEM2dZ5ZbXNfLl0
VmCZAoGATZKJU4Ob3W3LOTpqzqw41bWIitmPx2x7f4xKRZ/qPZozu4sQReMD+FS7
f7aTWyVGe7UGIBdqkGV3CPd5Lwm+cyQUvVFQOmlHSJvWMDYymoJDMOuXNN8nT6dS
aGOrVsGgs7VlrE8KOSrmaNTD9ieuoIfQ03cdJF4uyRWLWhmpuNU=
-----END RSA PRIVATE KEY-----`;

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
