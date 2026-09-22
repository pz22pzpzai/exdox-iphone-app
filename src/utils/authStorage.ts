import * as SecureStore from 'expo-secure-store';

import { type AuthSession } from '../types';

const AUTH_SESSION_KEY = 'exdox-auth-session-v1';
const BIOMETRIC_AUTH_SESSION_KEY = 'exdox-biometric-auth-session-v1';

const parseAuthSession = (raw: string | null) => {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AuthSession>;
    if (
      !parsed ||
      typeof parsed.token !== 'string' ||
      !parsed.user ||
      typeof parsed.user.id !== 'number' ||
      typeof parsed.user.organisationId !== 'number' ||
      (parsed.user.role !== 'Business_Admin' && parsed.user.role !== 'Standard_Employee') ||
      (parsed.user.status !== 'active' && parsed.user.status !== 'pending_invite')
    ) {
      return null;
    }

    return parsed as AuthSession;
  } catch {
    return null;
  }
};

export async function loadAuthSession() {
  return parseAuthSession(await SecureStore.getItemAsync(AUTH_SESSION_KEY));
}

export async function saveAuthSession(session: AuthSession) {
  await SecureStore.setItemAsync(AUTH_SESSION_KEY, JSON.stringify(session));
}

export async function saveBiometricAuthSession(session: AuthSession) {
  try {
    await SecureStore.setItemAsync(BIOMETRIC_AUTH_SESSION_KEY, JSON.stringify(session), {
      requireAuthentication: true,
      authenticationPrompt: 'Set up secure sign-in for Exdox',
    });
    return true;
  } catch {
    return false;
  }
}

export async function loadBiometricAuthSession() {
  try {
    return parseAuthSession(
      await SecureStore.getItemAsync(BIOMETRIC_AUTH_SESSION_KEY, {
        requireAuthentication: true,
        authenticationPrompt: 'Sign in securely to Exdox',
      }),
    );
  } catch {
    return null;
  }
}

export async function clearAuthSession({ preserveBiometric = false }: { preserveBiometric?: boolean } = {}) {
  await SecureStore.deleteItemAsync(AUTH_SESSION_KEY);
  if (!preserveBiometric) {
    await SecureStore.deleteItemAsync(BIOMETRIC_AUTH_SESSION_KEY);
  }
}
