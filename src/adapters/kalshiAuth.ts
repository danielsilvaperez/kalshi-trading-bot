import { createSign, constants } from 'node:crypto';

export interface KalshiSigningCreds {
  keyId: string;
  privateKeyPem: string;
}

export function kalshiSignedHeaders(
  creds: KalshiSigningCreds,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
): Record<string, string> {
  const ts = String(Date.now());
  const pathNoQuery = path.split('?')[0] || path;
  const msg = `${ts}${method}${pathNoQuery}`;

  const signer = createSign('RSA-SHA256');
  signer.update(msg);
  signer.end();

  const signature = signer.sign(
    {
      key: creds.privateKeyPem,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    },
    'base64',
  );

  return {
    'KALSHI-ACCESS-KEY': creds.keyId,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}
