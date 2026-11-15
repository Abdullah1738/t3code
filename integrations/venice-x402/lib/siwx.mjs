// Sign-In-With-X header for Venice x402: an EIP-4361 (SIWE) message on Base,
// signed with EIP-191, sent base64(JSON(fields + signature)). One header per
// request (Venice rejects reused nonces and messages older than 5 minutes).
import { createSiweMessage, generateSiweNonce } from 'viem/siwe';

export async function siwxHeader(account, resourceUrl, { now = new Date(), nonce = generateSiweNonce() } = {}) {
  const domain = new URL(resourceUrl).host;
  const issuedAt = new Date(now.getTime());
  const expirationTime = new Date(now.getTime() + 5 * 60 * 1000);
  const statement = 'Sign in to Venice AI';
  const message = createSiweMessage({
    domain,
    address: account.address,
    statement,
    uri: resourceUrl,
    version: '1',
    chainId: 8453,
    nonce,
    issuedAt,
    expirationTime,
  });
  const signature = await account.signMessage({ message });
  const payload = {
    domain,
    address: account.address,
    statement,
    uri: resourceUrl,
    version: '1',
    nonce,
    issuedAt: issuedAt.toISOString(),
    expirationTime: expirationTime.toISOString(),
    chainId: 'eip155:8453',
    type: 'eip191',
    signature,
  };
  return { header: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'), message };
}
