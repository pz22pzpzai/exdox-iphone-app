let authToken: string | null = null;

export function setSessionToken(token: string | null) {
  authToken = token;
}

export function getSessionToken() {
  return authToken;
}

export function requireSessionToken() {
  if (!authToken) {
    throw new Error('You need to sign in before using the cloud receipt service.');
  }
  return authToken;
}
