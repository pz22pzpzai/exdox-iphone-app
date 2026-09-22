import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { AppErrorLog, AppState } from '../types';
import { seedState } from '../data/seed';

const STORAGE_KEY = 'exdox-state-v1';
const ERROR_LOG_STORAGE_KEY = 'exdox-error-logs-v1';
const MAX_ERROR_LOGS = 30;
const DIAGNOSTIC_LOG_FILE = `${FileSystem.documentDirectory ?? ''}exdox-diagnostics.json`;
const MAX_DIAGNOSTIC_LOGS = 60;

export const loadStoredState = async () => {
  const saved = await AsyncStorage.getItem(STORAGE_KEY);
  return saved ? normalizeState(JSON.parse(saved) as Partial<AppState>) : null;
};

export const buildWorkspaceStateScope = (userId: number, organisationId: number) => `user-${userId}-organisation-${organisationId}`;

export const loadScopedStoredState = async (scope: string, legacyScope?: string) => {
  const saved = await AsyncStorage.getItem(getScopedStateKey(scope)) ??
    (legacyScope ? await AsyncStorage.getItem(getScopedStateKey(legacyScope)) : null);
  return saved ? normalizeState(JSON.parse(saved) as Partial<AppState>) : null;
};

export const saveStoredState = async (state: AppState, scope?: string) => {
  await AsyncStorage.setItem(scope ? getScopedStateKey(scope) : STORAGE_KEY, JSON.stringify(state));
};

export const clearScopedStoredState = async (scope: string) => {
  await AsyncStorage.removeItem(getScopedStateKey(scope));
};

export const loadStoredErrorLogs = async () => {
  const saved = await AsyncStorage.getItem(ERROR_LOG_STORAGE_KEY);
  if (!saved) {
    return [] as AppErrorLog[];
  }

  try {
    const parsed = JSON.parse(saved) as AppErrorLog[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const appendStoredErrorLog = async (entry: AppErrorLog) => {
  const current = await loadStoredErrorLogs();
  const next = [entry, ...current].slice(0, MAX_ERROR_LOGS);
  await AsyncStorage.setItem(ERROR_LOG_STORAGE_KEY, JSON.stringify(next));
  return next;
};

export const clearStoredErrorLogs = async () => {
  await AsyncStorage.removeItem(ERROR_LOG_STORAGE_KEY);
};

export const loadStoredDiagnosticLogs = async () => {
  if (!FileSystem.documentDirectory) {
    return [] as AppErrorLog[];
  }

  try {
    const info = await FileSystem.getInfoAsync(DIAGNOSTIC_LOG_FILE);
    if (!info.exists) {
      return [];
    }

    const raw = await FileSystem.readAsStringAsync(DIAGNOSTIC_LOG_FILE);
    const parsed = JSON.parse(raw) as AppErrorLog[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const appendStoredDiagnosticLog = async (entry: AppErrorLog) => {
  if (!FileSystem.documentDirectory) {
    return [entry] as AppErrorLog[];
  }

  const current = await loadStoredDiagnosticLogs();
  const latest = current[0];
  const isDuplicate =
    latest &&
    latest.source === entry.source &&
    latest.message === entry.message &&
    Math.abs(new Date(entry.createdAt).getTime() - new Date(latest.createdAt).getTime()) < 5000;
  const next = (isDuplicate ? current : [entry, ...current]).slice(0, MAX_DIAGNOSTIC_LOGS);
  await FileSystem.writeAsStringAsync(DIAGNOSTIC_LOG_FILE, JSON.stringify(next));
  return next;
};

export const clearStoredDiagnosticLogs = async () => {
  if (!FileSystem.documentDirectory) {
    return;
  }

  try {
    const info = await FileSystem.getInfoAsync(DIAGNOSTIC_LOG_FILE);
    if (info.exists) {
      await FileSystem.deleteAsync(DIAGNOSTIC_LOG_FILE, { idempotent: true });
    }
  } catch {
    // Ignore cleanup failures so the UI stays usable.
  }
};

const normalizeState = (saved: Partial<AppState>): AppState => ({
  documents: (saved.documents ?? []).map((document) => ({
    ...document,
    workspaceContext: document.workspaceContext ?? (document.type === 'invoice' ? 'sales' : 'cost'),
    paymentMethod:
      document.paymentMethod ??
      (document.type === 'invoice' ? 'bank_transfer' : 'business_card'),
    extractionStatus: document.extractionStatus ?? 'complete',
    extractionSource: document.extractionSource ?? 'fallback_review',
    confidenceScore: document.confidenceScore ?? null,
    needsReview: document.needsReview ?? true,
    netAmount: document.netAmount ?? document.amount ?? 0,
    vatAmount: document.vatAmount ?? document.taxAmount ?? 0,
    taxRateApplied: document.taxRateApplied ?? 'No VAT',
    description: document.description ?? '',
    customer: document.customer ?? '',
    lineItems: document.lineItems ?? [],
    taxBreakdown: document.taxBreakdown ?? [],
    updatedAt: document.updatedAt ?? document.createdAt ?? new Date().toISOString(),
  })),
  claims: saved.claims ?? [],
  vehicles: saved.vehicles ?? [],
  settings: {
    ...seedState.settings,
    ...(saved.settings ?? {}),
  },
  organisationSettings: saved.organisationSettings
    ? {
        ...saved.organisationSettings,
        baseCurrency: saved.organisationSettings.baseCurrency ?? 'GBP',
        isVatRegistered: saved.organisationSettings.isVatRegistered !== false,
        defaultTaxRate: saved.organisationSettings.defaultTaxRate ?? '20% Standard',
      }
    : null,
});

function getScopedStateKey(scope: string) {
  return `${STORAGE_KEY}-${scope}`;
}
