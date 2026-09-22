import { type AuthSession } from '../types';
import { requireSessionToken, setSessionToken } from './session';

const API_BASE_URL =
  process.env.EXPO_PUBLIC_EXPENSES_API_URL?.trim()?.replace(/\/api\/v1\/expenses\/process$/, '') ||
  'https://hz2zkm6jkf.execute-api.eu-west-2.amazonaws.com/prod';

type AuthResponse =
  | {
      success: true;
      token: string;
      user: AuthSession['user'];
    }
  | {
      success: false;
      message?: string;
    };

export async function loginWithEmail(input: { email: string; password: string }) {
  return authenticate('/login', input);
}

export async function registerWithEmail(input: {
  email: string;
  password: string;
  fullName?: string;
  organisationName?: string;
  inviteToken?: string;
}) {
  return authenticate('/register', input);
}

export async function deleteAccount(input: { password: string; confirmation: 'DELETE' }) {
  const response = await fetch(`${API_BASE_URL}/account`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${requireSessionToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  const data = (await response.json()) as { success?: boolean; message?: string };
  if (!response.ok || !data.success) {
    throw new Error(data.message || 'Account deletion failed.');
  }

  return data;
}

async function authenticate(path: string, payload: Record<string, unknown>) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = (await response.json()) as AuthResponse;
  if (!response.ok || !data.success) {
    throw new Error(('message' in data && data.message) || 'Authentication failed.');
  }

  const session = {
    token: data.token,
    user: data.user,
  } satisfies AuthSession;
  setSessionToken(session.token);
  return session;
}

export function getApiBaseUrl() {
  return API_BASE_URL;
}
