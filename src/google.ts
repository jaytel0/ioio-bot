import { createRemoteJWKSet, jwtVerify } from 'jose';
import { requireThat } from './shared';
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export async function verifyGoogleIdentity(idToken: string, clientId: string, nonce: string, keys = googleKeys) {
  const { payload } = await jwtVerify(idToken, keys, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: clientId, algorithms: ['RS256'] });
  requireThat(payload.nonce === nonce && typeof payload.sub === 'string' && typeof payload.email === 'string' && payload.email_verified === true, 401, 'Google identity could not be verified');
  return { subject: payload.sub, email: payload.email };
}
