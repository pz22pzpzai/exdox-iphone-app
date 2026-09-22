import { memo, useDeferredValue, useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState as RNAppState,
  Dimensions,
  FlatList,
  Image,
  InteractionManager,
  KeyboardAvoidingView,
  Linking,
  Modal,
  NativeModules,
  PanResponder,
  Platform,
  Pressable,
  Share,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useColorScheme,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Camera, CameraView } from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { seedState } from './src/data/seed';
import { deleteAccount, loginWithEmail } from './src/services/auth';
import { documentExtractionService, ExtractedDocumentDraft } from './src/services/documentExtraction';
import {
  attachCloudReceiptToClaim,
  addCloudMileageProof,
  createCloudClaim,
  deleteCloudClaim,
  deleteCloudReceipt,
  fetchCloudReceiptAssetUrl,
  fetchCloudReceipts,
  fetchSalesWorkspace,
  type MobileSalesWorkspace,
  fetchExpenseClaims,
  updateCloudReceipt,
} from './src/services/receiptsApi';
import { fetchOrganisationSettings, saveOrganisationSettings } from './src/services/settingsApi';
import { setSessionToken } from './src/services/session';
import { colors, radius, spacing } from './src/theme';
import {
  AppErrorLog,
  AppState,
  AuthSession,
  Claim,
  DocumentKind,
  ExpenseDocument,
  OrganisationSettings,
  PaymentMethod,
  UkTaxRate,
  UserSettings,
  Vehicle,
  WorkspaceContext,
} from './src/types';
import {
  clearAuthSession,
  loadAuthSession,
  loadBiometricAuthSession,
  saveAuthSession,
  saveBiometricAuthSession,
} from './src/utils/authStorage';
import { buildDraftDocument, extractionLooksUnreadable } from './src/utils/documents';
import { prepareCombinedImageDocumentForApp, prepareImportedImageForApp } from './src/utils/uploadAsset';
import {
  appendStoredDiagnosticLog,
  appendStoredErrorLog,
  buildWorkspaceStateScope,
  clearScopedStoredState,
  clearStoredDiagnosticLogs,
  clearStoredErrorLogs,
  loadScopedStoredState,
  loadStoredDiagnosticLogs,
  loadStoredErrorLogs,
  saveStoredState,
} from './src/utils/storage';

type MainTab = 'costs' | 'sales' | 'claims' | 'reports' | 'more';
type MoreSheetTarget = 'capture_actions';
type CameraCaptureMode = 'single' | 'multiple' | 'combine';
type ArchiveTarget = 'cost' | 'sales';

const appTutorialSteps: Array<{ tab: MainTab; icon: keyof typeof Ionicons.glyphMap; title: string; copy: string }> = [
  { tab: 'costs', icon: 'receipt-outline', title: 'Welcome to Exdox', copy: 'This is Purchases: your individual costs, receipts, and supplier bills. Start here whenever you spend for work.' },
  { tab: 'more', icon: 'add-circle-outline', title: 'Capture a document', copy: 'Use Upload at the bottom to photograph or import a receipt or invoice. Exdox extracts the key details so you can check them.' },
  { tab: 'costs', icon: 'checkmark-circle-outline', title: 'Review your purchases', copy: 'Open a purchase to check supplier, date, amount, VAT, category, and payment method. Mark it reviewed when it is correct.' },
  { tab: 'sales', icon: 'briefcase-outline', title: 'Keep sales separate', copy: 'Sales is for invoices and income evidence. It stays separate from business costs so records remain clear.' },
  { tab: 'claims', icon: 'card-outline', title: 'Claim back personal spend', copy: 'Expense Claims groups purchases you paid for personally. Select those purchases, create one claim, and send it to your employer for review.' },
  { tab: 'reports', icon: 'bar-chart-outline', title: 'Track completed payments', copy: 'Reports shows claims and payment rounds once they have been approved or paid. You are ready to use Exdox.' },
];
type SettingsPanelTarget =
  | 'business_admin'
  | 'logins'
  | 'extract_email'
  | 'vehicles'
  | 'analytics'
  | 'team_exports'
  | 'vault'
  | 'team_admin'
  | 'archive';
type StatusFilter = 'all' | ExpenseDocument['status'];
type SortMode = 'newest' | 'oldest' | 'amount_high' | 'amount_low';
type ThemeOption = UserSettings['theme'];
type VaultUploadState = {
  visible: boolean;
  progress: number;
  status: string;
};

type MileageSubmissionState = {
  visible: boolean;
  progress: number;
  status: string;
};

const brandBadge = require('./assets/brand-badge.png');
const workspaceName = 'Exdox Workspace';
const TAX_RATE_OPTIONS: UkTaxRate[] = ['20% Standard', '5% Reduced', '0% Zero', 'Exempt', 'No VAT'];
const COST_CATEGORY_OPTIONS = [
  'Staff Welfare',
  '1 - Taxi',
  '2 - Bus/ Tram',
  '3 - Car Wash',
  '4 - Fuel',
  '5 - Train',
  '6 - Toll Road',
  '7 - Motor Expenses',
  '8 - Other',
  '9 - Uniform',
  '10 - EV Charging',
] as const;
const SALES_CATEGORY_OPTIONS = [
  'Accounts Receivable',
  'Consulting Income',
  'Product Sales',
  'Subscription Income',
  'Travel Recharge',
  'Other Income',
] as const;
const previewableImagePattern = /\.(jpg|jpeg|png|webp|heic)$/i;
const pdfDocumentPattern = /\.pdf(\?|$)/i;

type NativeGalleryAsset = {
  uri: string;
  fileName: string;
};

const NativeGalleryPicker = NativeModules.NativeGalleryPicker as
  | { open: () => Promise<NativeGalleryAsset | null> }
  | undefined;

type GallerySelectionMode = 'multiple_documents' | 'combined_document';

const getWorkspaceContextForTab = (tab: MainTab): WorkspaceContext => (tab === 'sales' ? 'sales' : 'cost');
const getCategoryOptions = (workspaceContext: WorkspaceContext) =>
  workspaceContext === 'sales' ? [...SALES_CATEGORY_OPTIONS] : [...COST_CATEGORY_OPTIONS];
const getDefaultPaymentMethod = (workspaceContext: WorkspaceContext, isAdmin: boolean): PaymentMethod => {
  if (workspaceContext === 'vault') {
    return 'not_applicable';
  }
  if (workspaceContext === 'sales') {
    return 'bank_transfer';
  }
  // A cost uploaded from a person's own app login is treated as their out-of-pocket spend.
  // Reviewers can still change it to a business-funded payment method when appropriate.
  return 'cash_personal';
};

const formatErrorLog = (source: string, error: unknown, isFatal = false): AppErrorLog => {
  const normalized =
    error instanceof Error
      ? error
      : new Error(typeof error === 'string' ? error : 'Unknown application error');

  return {
    id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    source,
    message: normalized.message || 'Unknown application error',
    stack: normalized.stack,
    isFatal,
  };
};

const buildManualDraftDocument = ({
  fileName,
  type,
  uri,
  previewImageUri,
  previewImageUris,
  source,
  workspaceContext,
  paymentMethod,
}: {
  fileName: string;
  type: DocumentKind;
  uri?: string;
  previewImageUri?: string;
  previewImageUris?: string[];
  source: ExpenseDocument['source'];
  workspaceContext: WorkspaceContext;
  paymentMethod: PaymentMethod;
}): ExpenseDocument => {
  const now = new Date().toISOString();
  const isInvoice = type === 'invoice';

  return {
    id: `doc-${Date.now()}`,
    type,
    workspaceContext,
    paymentMethod,
    title: isInvoice ? 'Invoice to review' : 'Receipt to review',
    supplier: isInvoice ? 'Supplier to review' : 'Merchant to review',
    amount: 0,
    taxAmount: 0,
    currency: 'GBP',
    status: 'awaiting_review',
    category: '',
    description: '',
    customer: '',
    date: now,
    netAmount: 0,
    vatAmount: 0,
    taxRateApplied: 'No VAT',
    dueDate: undefined,
    invoiceNumber: undefined,
    notes:
      source === 'camera'
        ? 'Captured with camera and saved for manual review.'
        : 'Imported from gallery and saved for manual review.',
    tags: [type, 'draft'],
    fileUri: uri,
    fileName,
    previewImageUri,
    previewImageUris,
    source,
    extractionStatus: 'pending',
    extractionSource: 'backend_proxy',
    confidenceScore: null,
    needsReview: true,
    lineItems: [],
    taxBreakdown: [],
    createdAt: now,
    updatedAt: now,
  };
};

const resolveExtractedDraftStatus = (extracted: ExtractedDocumentDraft): ExpenseDocument['extractionStatus'] =>
  extracted.extractionOutcome ??
  (extracted.extractionSource === 'backend_proxy' && !extractionLooksUnreadable(extracted) ? 'complete' : 'failed');

const applyExtractedDocumentDraft = (
  document: ExpenseDocument,
  extracted: ExtractedDocumentDraft,
): ExpenseDocument => ({
  ...document,
  title: extracted.supplier?.trim() ? extracted.supplier : document.title,
  supplier: extracted.supplier?.trim() ? extracted.supplier : document.supplier,
  amount: resolveDocumentAmount({
    amount: extracted.amount,
    netAmount: extracted.netAmount,
    vatAmount: extracted.vatAmount,
    taxAmount: extracted.taxAmount,
  }),
  netAmount: extracted.netAmount ?? document.netAmount ?? extracted.amount ?? document.amount,
  vatAmount: extracted.vatAmount ?? extracted.taxAmount ?? document.vatAmount ?? document.taxAmount,
  taxRateApplied: extracted.taxRateApplied ?? document.taxRateApplied ?? 'No VAT',
  taxAmount: extracted.taxAmount ?? document.taxAmount,
  currency: extracted.currency ?? document.currency,
  baseCurrency: extracted.baseCurrency ?? document.baseCurrency,
  baseAmount: extracted.baseAmount ?? document.baseAmount,
  exchangeRate: extracted.exchangeRate ?? document.exchangeRate,
  exchangeRateDate: extracted.exchangeRateDate ?? document.exchangeRateDate,
  exchangeRateProvider: extracted.exchangeRateProvider ?? document.exchangeRateProvider,
  category: document.category.trim() ? document.category : extracted.category ?? document.category,
  description: extracted.description ?? document.description ?? '',
  customer: extracted.customer ?? document.customer ?? '',
  date: extracted.date ?? document.date,
  dueDate: extracted.dueDate,
  invoiceNumber: extracted.invoiceNumber,
  notes: extracted.notes || document.notes,
  extractionStatus: resolveExtractedDraftStatus(extracted),
  extractionSource: extracted.extractionSource,
  confidenceScore: extracted.confidenceScore ?? null,
  needsReview: extracted.needsReview ?? true,
  lineItems: extracted.lineItems ?? [],
  taxBreakdown: extracted.taxBreakdown ?? [],
  updatedAt: new Date().toISOString(),
  cloudReceiptId: extracted.cloudReceiptId ?? document.cloudReceiptId,
  storageKey: extracted.storageKey ?? document.storageKey,
  storageBucket: extracted.storageBucket ?? document.storageBucket,
  workspaceContext: extracted.workspaceContext ?? document.workspaceContext,
  paymentMethod: extracted.paymentMethod ?? document.paymentMethod,
});

const getDocumentPreviewUris = (document: Pick<ExpenseDocument, 'fileName' | 'fileUri' | 'previewImageUri' | 'previewImageUris'>) => {
  const previewUris = Array.isArray(document.previewImageUris)
    ? document.previewImageUris.filter((value): value is string => Boolean(value))
    : [];

  if (previewUris.length) {
    return previewUris;
  }

  if (document.previewImageUri) {
    return [document.previewImageUri];
  }

  if (
    document.fileUri &&
    !pdfDocumentPattern.test(document.fileName) &&
    !pdfDocumentPattern.test(document.fileUri) &&
    (previewableImagePattern.test(document.fileName) || previewableImagePattern.test(document.fileUri))
  ) {
    return [document.fileUri];
  }

  return [];
};

const getPrimaryDocumentPreviewUri = (
  document: Pick<ExpenseDocument, 'fileName' | 'fileUri' | 'previewImageUri' | 'previewImageUris'>,
) => getDocumentPreviewUris(document)[0];

const markDuplicateUploadDraft = (
  currentDocument: ExpenseDocument | undefined,
  extracted: ExtractedDocumentDraft,
  documents: ExpenseDocument[],
): ExtractedDocumentDraft => {
  if (!currentDocument || extractionLooksLikeDuplicateUpload(extracted)) {
    return extracted;
  }

  const nextDocument = applyExtractedDocumentDraft(currentDocument, extracted);
  const matchingCloudDocument = documents.find(
    (candidate) =>
      candidate.id !== currentDocument.id &&
      ((extracted.cloudReceiptId && candidate.cloudReceiptId === extracted.cloudReceiptId) ||
        isLikelyDuplicateReceiptMatch(nextDocument, candidate)),
  );
  if (!matchingCloudDocument) {
    return extracted;
  }

  return {
    ...buildDuplicateExtractedDraft(currentDocument.type, currentDocument.fileName || currentDocument.title),
    currency: extracted.currency || currentDocument.currency || 'GBP',
    workspaceContext: extracted.workspaceContext ?? currentDocument.workspaceContext,
    paymentMethod: extracted.paymentMethod ?? currentDocument.paymentMethod,
    notes: duplicateReceiptStatusMessage,
  };
};

const formatDuplicateDocumentLabel = (fileName: string) =>
  fileName
    .replace(/\.[^/.]+$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Duplicate receipt';

function buildDuplicateExtractedDraft(type: DocumentKind, fileName: string): ExtractedDocumentDraft {
  return {
    supplier: formatDuplicateDocumentLabel(fileName),
    amount: 0,
    netAmount: 0,
    vatAmount: 0,
    taxRateApplied: 'No VAT',
    taxAmount: 0,
    currency: 'GBP',
    category: type === 'invoice' ? 'Accounts Payable' : 'General',
    notes: duplicateReceiptStatusMessage,
    dueDate:
      type === 'invoice'
        ? new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString()
        : undefined,
    invoiceNumber: type === 'invoice' ? `INV-${Date.now().toString().slice(-5)}` : undefined,
    extractionSource: 'fallback_review',
    confidenceScore: null,
    needsReview: true,
    lineItems: [],
    taxBreakdown: [],
    extractionOutcome: 'failed',
  };
}

const buildBlockedDuplicateDocument = ({
  fileName,
  source,
  type,
  uri,
  workspaceContext,
  paymentMethod,
}: {
  fileName: string;
  source: ExpenseDocument['source'];
  type: DocumentKind;
  uri?: string;
  workspaceContext: WorkspaceContext;
  paymentMethod: PaymentMethod;
}): ExpenseDocument => {
  const duplicateDocument = buildManualDraftDocument({
    fileName,
    type,
    uri,
    previewImageUri: uri,
    previewImageUris: uri ? [uri] : undefined,
    source,
    workspaceContext,
    paymentMethod,
  });

  return {
    ...duplicateDocument,
    title: formatDuplicateDocumentLabel(fileName),
    supplier: formatDuplicateDocumentLabel(fileName),
    amount: 0,
    netAmount: 0,
    vatAmount: 0,
    taxAmount: 0,
    notes: duplicateReceiptStatusMessage,
    extractionStatus: 'failed',
    extractionSource: 'fallback_review',
    needsReview: true,
  };
};

const canPreviewDocumentInline = (
  document: Pick<ExpenseDocument, 'fileName' | 'fileUri' | 'previewImageUri' | 'previewImageUris'>,
) => Boolean(getPrimaryDocumentPreviewUri(document));

const canHydrateDocumentPreview = (document: Pick<ExpenseDocument, 'fileName'>) =>
  !pdfDocumentPattern.test(document.fileName) && Boolean(document.fileName);

const isRemotePreviewUri = (uri: string | undefined) => /^https?:\/\//i.test(uri ?? '');

let cloudPreviewCacheScope = 'signed-out';

const setCloudPreviewCacheScope = (userId: number, organisationId: number) => {
  cloudPreviewCacheScope = `user-${userId}-organisation-${organisationId}`;
};

const clearCloudPreviewCacheScope = async (scope: string) => {
  const cacheDirectory = FileSystem.cacheDirectory;
  if (!cacheDirectory) {
    return;
  }
  await FileSystem.deleteAsync(`${cacheDirectory}exdox-receipt-previews/${scope}`, { idempotent: true });
};

const getCloudPreviewCachePath = (receiptId: number, fileName: string) => {
  const cacheDirectory = FileSystem.cacheDirectory;
  if (!cacheDirectory) {
    return null;
  }

  const extension = (fileName.split('.').pop() ?? 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
  return `${cacheDirectory}exdox-receipt-previews/${cloudPreviewCacheScope}/${receiptId}.${extension}`;
};

const getCachedCloudPreview = async ({ receiptId, fileName }: { receiptId: number; fileName: string }) => {
  const previewPath = getCloudPreviewCachePath(receiptId, fileName);
  if (!previewPath) {
    return null;
  }

  try {
    return (await FileSystem.getInfoAsync(previewPath)).exists ? previewPath : null;
  } catch {
    return null;
  }
};

const cacheCloudPreview = async ({
  receiptId,
  fileName,
  remoteUri,
}: {
  receiptId: number;
  fileName: string;
  remoteUri: string;
}) => {
  const previewPath = getCloudPreviewCachePath(receiptId, fileName);
  if (!previewPath) {
    return remoteUri;
  }

  const previewDirectory = previewPath.slice(0, previewPath.lastIndexOf('/') + 1);

  try {
    const existingPreview = await getCachedCloudPreview({ receiptId, fileName });
    if (existingPreview) {
      return existingPreview;
    }

    await FileSystem.makeDirectoryAsync(previewDirectory, { intermediates: true });
    await FileSystem.downloadAsync(remoteUri, previewPath);
    return previewPath;
  } catch {
    // A signed cloud URL is still a useful immediate fallback if local caching
    // is unavailable on this device.
    return remoteUri;
  }
};

const isTransientNetworkError = (error: unknown) => {
  const message =
    error instanceof Error
      ? `${error.message} ${error.stack ?? ''}`.toLowerCase()
      : String(error).toLowerCase();

  return /unknownhostexception|unable to resolve host|network request failed|failed to fetch|timeout/.test(message);
};

const isWorkspaceUnavailableError = (error: unknown) =>
  /current plan does not include (the )?(sales|vault) workspace|workspace is not included in (your )?current plan/i.test(
    error instanceof Error ? error.message : String(error),
  );

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cloudSyncTimeoutMs = 20_000;

const resolveDocumentAmount = ({
  amount,
  netAmount,
  vatAmount,
  taxAmount,
}: {
  amount?: number | null;
  netAmount?: number | null;
  vatAmount?: number | null;
  taxAmount?: number | null;
}) => {
  if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) {
    return amount;
  }

  const derivedTaxAmount =
    typeof vatAmount === 'number' && Number.isFinite(vatAmount)
      ? vatAmount
      : typeof taxAmount === 'number' && Number.isFinite(taxAmount)
        ? taxAmount
        : null;

  if (
    typeof netAmount === 'number' &&
    Number.isFinite(netAmount) &&
    netAmount >= 0 &&
    derivedTaxAmount !== null &&
    derivedTaxAmount >= 0
  ) {
    return Number((netAmount + derivedTaxAmount).toFixed(2));
  }

  return amount ?? 0;
};

const isVatTrackingEnabled = (settings: OrganisationSettings | null) => settings?.isVatRegistered !== false;

const normalizeVatDisabledValues = ({
  amount,
  netAmount,
  vatAmount,
}: Pick<ExpenseDocument, 'amount' | 'netAmount' | 'vatAmount'>) => {
  const grossAmount = resolveDocumentAmount({ amount, netAmount, vatAmount });
  return {
    amount: grossAmount,
    netAmount: grossAmount,
    vatAmount: 0,
    taxAmount: 0,
    taxRateApplied: 'No VAT' as UkTaxRate,
  };
};

const isPlaceholderSupplierLabel = (value?: string | null) => {
  const normalized = value?.trim().toLowerCase() ?? '';
  return !normalized || normalized === 'merchant to review' || normalized === 'supplier to review';
};

const looksLikeGeneratedUploadTitle = (value?: string | null) => {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (!normalized) {
    return false;
  }

  return (
    /^[0-9_-]{10,}$/.test(normalized) ||
    normalized.includes('screenshot') ||
    normalized.includes('receipt-') ||
    normalized.includes('invoice-')
  );
};

const normalizeDocumentFileName = (fileName: string) =>
  fileName
    .trim()
    .toLowerCase()
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-z0-9]+/g, '');

const normalizeDuplicateComparisonText = (value: string | null | undefined) =>
  (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

const duplicateReceiptStatusMessage = 'Error: This is a duplicate';

const getDocumentFileNameCandidates = (document: Pick<ExpenseDocument, 'fileName' | 'fileUri'>) => {
  const candidates = new Set<string>();
  const normalizedFileName = normalizeDocumentFileName(document.fileName);
  if (normalizedFileName) {
    candidates.add(normalizedFileName);
  }

  if (document.fileUri) {
    const fileUriName = document.fileUri.split(/[\\/]/).pop() ?? '';
    const normalizedUriName = normalizeDocumentFileName(fileUriName);
    if (normalizedUriName) {
      candidates.add(normalizedUriName);
      const trimmedPrefixedName = normalizedUriName.replace(/^doc\d+/, '');
      if (trimmedPrefixedName) {
        candidates.add(trimmedPrefixedName);
      }
    }
  }

  return [...candidates];
};

const hasExactMatchingFileName = (
  left: Pick<ExpenseDocument, 'fileName' | 'fileUri'>,
  right: Pick<ExpenseDocument, 'fileName' | 'fileUri'>,
) => {
  const leftCandidates = getDocumentFileNameCandidates(left);
  const rightCandidates = getDocumentFileNameCandidates(right);
  return leftCandidates.some((candidate) => rightCandidates.includes(candidate));
};

const hasUsableSupplierName = (value: string | null | undefined) => {
  const trimmed = value?.trim() ?? '';
  return Boolean(trimmed) && !isPlaceholderSupplierLabel(trimmed) && !looksLikeGeneratedUploadTitle(trimmed);
};

const shouldPushLocalSupplierToCloud = (localDocument: ExpenseDocument, cloudDocument: ExpenseDocument) =>
  hasUsableSupplierName(localDocument.supplier) &&
  (!hasUsableSupplierName(cloudDocument.supplier) || isPlaceholderSupplierLabel(cloudDocument.supplier));

const buildCloudReceiptSyncUpdates = (document: ExpenseDocument) => ({
  workspaceContext: document.workspaceContext,
  supplier: hasUsableSupplierName(document.supplier) ? document.supplier : undefined,
  date: document.date,
  dueDate: document.dueDate,
  invoiceNumber: document.invoiceNumber,
  category: document.category,
  description: document.description,
  customer: document.customer,
  amount: document.amount,
  currency: document.currency,
  netAmount: document.netAmount,
  vatAmount: document.vatAmount,
  taxRateApplied: document.taxRateApplied,
  status: document.status,
});

const findLocalDocumentForCloudSync = (
  localDocuments: ExpenseDocument[],
  cloudDocument: ExpenseDocument,
) =>
  localDocuments.find((document) => document.cloudReceiptId === cloudDocument.cloudReceiptId)
  ?? localDocuments.find((document) => isLikelyTimedOutUploadDuplicate(document, cloudDocument));

const buildPendingCloudSupplierUpdates = (
  localDocuments: ExpenseDocument[],
  cloudDocuments: ExpenseDocument[],
) => {
  const updatesByReceiptId = new Map<number, ReturnType<typeof buildCloudReceiptSyncUpdates>>();

  cloudDocuments.forEach((cloudDocument) => {
    if (!cloudDocument.cloudReceiptId) {
      return;
    }

    const localDocument = findLocalDocumentForCloudSync(localDocuments, cloudDocument);
    if (!localDocument || !shouldPushLocalSupplierToCloud(localDocument, cloudDocument)) {
      return;
    }

    updatesByReceiptId.set(cloudDocument.cloudReceiptId, buildCloudReceiptSyncUpdates(localDocument));
  });

  return [...updatesByReceiptId.entries()].map(([receiptId, updates]) => ({
    receiptId,
    updates,
  }));
};

const isLikelyTimedOutUploadDuplicate = (localDocument: ExpenseDocument, cloudDocument: ExpenseDocument) => {
  if (localDocument.cloudReceiptId) {
    return false;
  }

  if (extractionLooksLikeDuplicateUpload(localDocument)) {
    return false;
  }

  if (localDocument.type !== cloudDocument.type || localDocument.workspaceContext !== cloudDocument.workspaceContext) {
    return false;
  }

  const localFileNameCandidates = getDocumentFileNameCandidates(localDocument);
  const cloudFileName = normalizeDocumentFileName(cloudDocument.fileName);
  const localIdentityCandidates = [
    localDocument.title,
    localDocument.supplier,
    localDocument.invoiceNumber,
    localDocument.fileName,
  ].map(normalizeDuplicateComparisonText).filter((value) => value.length >= 4);
  const cloudIdentityCandidates = [
    cloudDocument.title,
    cloudDocument.supplier,
    cloudDocument.invoiceNumber,
    cloudDocument.fileName,
  ].map(normalizeDuplicateComparisonText).filter((value) => value.length >= 4);
  const unreadableLabelMatch =
    extractionLooksUnreadable(localDocument) &&
    isUnreadableCloudReviewItem(cloudDocument) &&
    localIdentityCandidates.some((localValue) =>
      cloudIdentityCandidates.some(
        (cloudValue) => localValue === cloudValue || localValue.includes(cloudValue) || cloudValue.includes(localValue),
      ),
    );
  if (
    !unreadableLabelMatch &&
    (!cloudFileName ||
    !localFileNameCandidates.some(
      (candidate) => candidate === cloudFileName || candidate.endsWith(cloudFileName) || cloudFileName.endsWith(candidate),
    ))
  ) {
    return false;
  }

  // A failed upload with the same source identity is never useful as a second
  // row. Older app versions did not retain the cloud receipt ID, so do not
  // require a narrow timing match when cleaning up those persisted placeholders.
  if (unreadableLabelMatch) {
    return true;
  }

  const localCreatedAt = Date.parse(localDocument.createdAt);
  const cloudCreatedAt = Date.parse(cloudDocument.createdAt);
  return (
    Number.isFinite(localCreatedAt) &&
    Number.isFinite(cloudCreatedAt) &&
    Math.abs(localCreatedAt - cloudCreatedAt) <= 1000 * 60 * 15
  );
};

const isUnreadableCloudReviewItem = (document: ExpenseDocument) =>
  extractionLooksUnreadable(document) ||
  (document.needsReview === true &&
    (document.amount ?? 0) === 0 &&
    /unable to read|could not read|no receipt visible|no invoice visible|not clearly visible/.test(
      (document.notes ?? '').toLowerCase(),
    ));

const extractionLooksLikeDuplicateUpload = (input: { notes?: string | null }) =>
  /upload error:\s*duplicate receipt|duplicate receipt|error:\s*this is a duplicate/.test(
    (input.notes ?? '').toLowerCase(),
  );

const isLikelyDuplicateReceiptMatch = (document: ExpenseDocument, candidate: ExpenseDocument) => {
  if (!candidate.cloudReceiptId || document.id === candidate.id) {
    return false;
  }

  if (document.type !== candidate.type || document.workspaceContext !== candidate.workspaceContext) {
    return false;
  }

  if (hasExactMatchingFileName(document, candidate)) {
    return true;
  }

  const amountMatches = Math.abs((document.amount ?? 0) - (candidate.amount ?? 0)) < 0.01;
  if (!amountMatches || document.amount <= 0 || candidate.amount <= 0) {
    return false;
  }

  const documentDate = new Date(document.date).toISOString().slice(0, 10);
  const candidateDate = new Date(candidate.date).toISOString().slice(0, 10);
  if (documentDate !== candidateDate) {
    return false;
  }

  const documentSupplier = normalizeDuplicateComparisonText(document.supplier || document.title);
  const candidateSupplier = normalizeDuplicateComparisonText(candidate.supplier || candidate.title);
  return Boolean(documentSupplier) && documentSupplier === candidateSupplier;
};

const findExistingExactFileNameDuplicate = (
  documents: ExpenseDocument[],
  input: {
    fileName: string;
    workspaceContext: WorkspaceContext;
    type: DocumentKind;
  },
) =>
  documents.find((document) =>
    !extractionLooksLikeDuplicateUpload(document) &&
    document.workspaceContext === input.workspaceContext &&
    document.type === input.type &&
    hasExactMatchingFileName(
      {
        fileName: input.fileName,
      },
      document,
    ),
  ) ?? null;

const mergeWorkspaceDocuments = (
  currentDocuments: ExpenseDocument[],
  cloudDocuments: ExpenseDocument[],
  deletedCloudReceiptIds: Set<number>,
) => {
  const cloudReceiptIds = new Set(cloudDocuments.map((document) => document.cloudReceiptId).filter(Boolean));
  const duplicateLocalDocumentIds = new Set(
    currentDocuments
      .filter((document) => !document.cloudReceiptId)
      .flatMap((document) =>
        cloudDocuments.some((cloudDocument) => isLikelyTimedOutUploadDuplicate(document, cloudDocument))
          ? [document.id]
          : [],
      ),
  );
  const retainedLocalDocuments = currentDocuments.filter(
    (document) =>
      (!document.cloudReceiptId || !cloudReceiptIds.has(document.cloudReceiptId)) &&
      (!document.cloudReceiptId || !deletedCloudReceiptIds.has(document.cloudReceiptId)) &&
      !duplicateLocalDocumentIds.has(document.id),
  );
  const localCloudDocuments = new Map(
    currentDocuments
      .filter((document) => Boolean(document.cloudReceiptId))
      .map((document) => [document.cloudReceiptId, document] as const),
  );
  const mergedCloudDocuments = cloudDocuments.map((document) => {
    const localDocument = document.cloudReceiptId ? localCloudDocuments.get(document.cloudReceiptId) : undefined;
    const duplicateLocalDocument = currentDocuments.find((current) => isLikelyTimedOutUploadDuplicate(current, document));
    const mergedLocalDocument = localDocument ?? duplicateLocalDocument;
    if (!mergedLocalDocument) {
      return document;
    }

    const preferLocalSupplier =
      isPlaceholderSupplierLabel(document.supplier) &&
      !isPlaceholderSupplierLabel(mergedLocalDocument.supplier);
    const preferLocalTitle =
      (!document.title.trim() || looksLikeGeneratedUploadTitle(document.title)) &&
      Boolean(mergedLocalDocument.title.trim());

    return {
      ...document,
      id: mergedLocalDocument.id,
      title: preferLocalTitle ? mergedLocalDocument.title : document.title,
      supplier: preferLocalSupplier ? mergedLocalDocument.supplier : document.supplier,
      category: mergedLocalDocument.category.trim() ? mergedLocalDocument.category : document.category,
      fileUri: mergedLocalDocument.fileUri ?? document.fileUri,
      previewImageUri: mergedLocalDocument.previewImageUri ?? document.previewImageUri,
      previewImageUris: mergedLocalDocument.previewImageUris ?? document.previewImageUris,
      source: mergedLocalDocument.source,
      createdAt: mergedLocalDocument.createdAt,
      updatedAt: document.updatedAt ?? mergedLocalDocument.updatedAt,
    };
  });

  return [...retainedLocalDocuments, ...mergedCloudDocuments].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
};

const galleryResultAssetName = (asset: { uri?: string | null; fileName?: string | null; assetId?: string | null }) =>
  asset.assetId ?? asset.uri ?? asset.fileName ?? `gallery-${Date.now()}`;

const statusFilterOptions: Array<{ label: string; value: StatusFilter }> = [
  { label: 'All statuses', value: 'all' },
  { label: 'To review', value: 'awaiting_review' },
  { label: 'Reviewed', value: 'ready_to_submit' },
  { label: 'Submitted', value: 'submitted' },
  { label: 'Payment processing', value: 'payment_processing' },
  { label: 'Paid', value: 'paid' },
];

const sortOptions: Array<{ label: string; value: SortMode }> = [
  { label: 'Newest first', value: 'newest' },
  { label: 'Oldest first', value: 'oldest' },
  { label: 'Amount high to low', value: 'amount_high' },
  { label: 'Amount low to high', value: 'amount_low' },
];

const themeOptions: Array<{ label: string; value: ThemeOption }> = [
  { label: 'System default', value: 'system' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
];

const formatCurrency = (amount: number, currency = 'GBP') =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);

const getStatusLabel = (status: ExpenseDocument['status']) =>
  status === 'awaiting_review'
    ? 'To review'
    : status === 'ready_to_submit'
      ? 'Reviewed'
      : status === 'submitted'
        ? 'Submitted'
        : status === 'payment_processing'
          ? 'Payment processing'
        : 'Paid';

const getPaymentMethodLabel = (paymentMethod: PaymentMethod) =>
  paymentMethod === 'business_card'
    ? 'Company card'
    : paymentMethod === 'cash_personal'
      ? 'Personal spend'
      : paymentMethod === 'bank_transfer'
        ? 'Bank transfer'
        : 'Not applicable';

const getPaymentCardLabel = (document: ExpenseDocument) => {
  const details = [document.paymentCardNetwork?.trim(), document.paymentCardIssuer?.trim()]
    .filter((detail): detail is string => Boolean(detail));

  if (document.paymentCardLastFour) {
    details.push(`**** ${document.paymentCardLastFour}`);
  }

  return details.join(' / ') || 'Not detected';
};

const getPaymentMethodMatchLabel = (document: ExpenseDocument) =>
  document.paymentMethod === 'business_card'
    ? 'Company card'
    : document.paymentMethodMatchState === 'company_card'
    ? 'Company card confirmed'
    : document.paymentMethodMatchState === 'employee_review'
      ? 'Admin review needed'
      : document.paymentMethodMatchState === 'employee_exception'
        ? 'Personal-card exception'
        : document.paymentMethodMatchState === 'personal'
          ? 'Personal spend'
          : 'No card match';

const isReimbursementArchiveDocument = (document: ExpenseDocument) =>
  document.workspaceContext === 'cost' &&
  document.paymentMethod === 'cash_personal' &&
  (document.status === 'paid' ||
    document.status === 'payment_processing' ||
    (document.status === 'ready_to_submit' && Boolean(document.reimbursementBatchId)));

const buildInboundEmailAddress = (organisationName: string, organisationId: number) => {
  const slug = organisationName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 18);
  return `${slug || 'workspace'}-${organisationId}@exdox.co.uk`;
};

const DocumentThumbnail = memo(function DocumentThumbnail({
  previewUri,
  hasPreviewImage,
  cloudReceiptId,
  fileName,
}: {
  previewUri?: string;
  hasPreviewImage: boolean;
  cloudReceiptId?: number;
  fileName: string;
}) {
  const [resolvedPreviewUri, setResolvedPreviewUri] = useState(previewUri);

  useEffect(() => {
    let cancelled = false;

    if (previewUri && !isRemotePreviewUri(previewUri)) {
      setResolvedPreviewUri(previewUri);
      return () => {
        cancelled = true;
      };
    }

    if (!cloudReceiptId || !canHydrateDocumentPreview({ fileName })) {
      setResolvedPreviewUri(previewUri);
      return () => {
        cancelled = true;
      };
    }

    void getCachedCloudPreview({ receiptId: cloudReceiptId, fileName })
      .then(async (cachedUri) => {
        if (cachedUri) {
          return cachedUri;
        }
        const remoteUri = await fetchCloudReceiptAssetUrl(cloudReceiptId);
        return cacheCloudPreview({ receiptId: cloudReceiptId, fileName, remoteUri });
      })
      .then((nextUri) => {
        if (!cancelled) {
          setResolvedPreviewUri(nextUri);
        }
      })
      .catch(() => {
        // Keep the placeholder until a later visible-row retry succeeds.
      });

    return () => {
      cancelled = true;
    };
  }, [cloudReceiptId, fileName, previewUri]);

  const displayUri = resolvedPreviewUri ?? previewUri;
  if ((hasPreviewImage || Boolean(displayUri)) && displayUri) {
    return (
      <Image
        source={{ uri: displayUri }}
        fadeDuration={0}
        resizeMethod="resize"
        resizeMode="cover"
        style={styles.documentThumb}
      />
    );
  }

  return (
    <View style={styles.documentThumbFallback}>
      <View style={styles.documentDot} />
    </View>
  );
}, (previousProps, nextProps) =>
  previousProps.previewUri === nextProps.previewUri &&
  previousProps.hasPreviewImage === nextProps.hasPreviewImage &&
  previousProps.cloudReceiptId === nextProps.cloudReceiptId &&
  previousProps.fileName === nextProps.fileName,
);

const DocumentPreviewCarousel = memo(function DocumentPreviewCarousel({
  previewUris,
  fullScreen = false,
}: {
  previewUris: string[];
  fullScreen?: boolean;
}) {
  const viewportWidth = Math.max(Dimensions.get('window').width - (fullScreen ? 0 : 48), 1);
  const imageHeight = fullScreen ? '88%' : 180;

  if (!previewUris.length) {
    return null;
  }

  if (previewUris.length === 1) {
    return (
      <Image
        source={{ uri: previewUris[0] }}
        fadeDuration={0}
        resizeMethod="resize"
        resizeMode="contain"
        style={fullScreen ? styles.previewFullscreenImage : styles.documentSheetPreview}
      />
    );
  }

  return (
    <ScrollView
      horizontal
      pagingEnabled
      nestedScrollEnabled
      directionalLockEnabled
      showsHorizontalScrollIndicator={false}
      bounces={false}
      style={fullScreen ? styles.previewCarouselFullScreen : styles.previewCarousel}
    >
      {previewUris.map((previewUri, index) => (
        <View
          key={`${previewUri}-${index}`}
          style={[
            styles.previewCarouselPage,
            {
              width: viewportWidth,
              height: imageHeight,
            },
          ]}
        >
          <Image
            source={{ uri: previewUri }}
            fadeDuration={0}
            resizeMethod="resize"
            resizeMode="contain"
            style={fullScreen ? styles.previewFullscreenImage : styles.documentSheetPreview}
          />
        </View>
      ))}
    </ScrollView>
  );
}, (previousProps, nextProps) =>
  previousProps.previewUris.join('|') === nextProps.previewUris.join('|') &&
  previousProps.fullScreen === nextProps.fullScreen,
);

export default function App() {
  const systemTheme = useColorScheme();
  const hasLoggedLaunchRef = useRef(false);
  const hasRecoveredPickerResultRef = useRef(false);
  const hasRestoredStateRef = useRef(false);
  const awaitingGalleryResultRef = useRef(false);
  const handledGalleryAssetRef = useRef<string | null>(null);
  const deletedCloudReceiptIdsRef = useRef<Set<number>>(new Set());
  const [appState, setAppState] = useState<AppState>(seedState);
  const appStateRef = useRef<AppState>(seedState);
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register' | 'reset'>('login');
  const [authFullName, setAuthFullName] = useState('');
  const [authOrganisationName, setAuthOrganisationName] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<MainTab>('costs');
  const [captureType, setCaptureType] = useState<DocumentKind>('receipt');
  const [captureModalVisible, setCaptureModalVisible] = useState(false);
  const [cameraVisible, setCameraVisible] = useState(false);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [captureReviewDocumentId, setCaptureReviewDocumentId] = useState<string | null>(null);
  const [sheetTarget, setSheetTarget] = useState<MoreSheetTarget | null>(null);
  const [search, setSearch] = useState('');
  const [isReady, setIsReady] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [vaultUpload, setVaultUpload] = useState<VaultUploadState>({ visible: false, progress: 0, status: '' });
  const [mileageSubmission, setMileageSubmission] = useState<MileageSubmissionState>({ visible: false, progress: 0, status: '' });
  const [errorLogs, setErrorLogs] = useState<AppErrorLog[]>([]);
  const [diagnosticLogs, setDiagnosticLogs] = useState<AppErrorLog[]>([]);
  const [cloudSyncState, setCloudSyncState] = useState<'idle' | 'syncing' | 'synced' | 'failed'>('idle');
  const [cloudSyncError, setCloudSyncError] = useState<string | null>(null);
  const cloudSyncAttemptRef = useRef(0);
  const [errorLogVisible, setErrorLogVisible] = useState(false);
  const [pendingGalleryOpen, setPendingGalleryOpen] = useState(false);
  const [notificationsVisible, setNotificationsVisible] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<ArchiveTarget | null>(null);
  const [filterVisible, setFilterVisible] = useState(false);
  const [settingsPanelTarget, setSettingsPanelTarget] = useState<SettingsPanelTarget | null>(null);
  const [claimComposerVisible, setClaimComposerVisible] = useState(false);
  const [tutorialVisible, setTutorialVisible] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(0);
  const [claimComposerSubmitting, setClaimComposerSubmitting] = useState(false);
  const [claimTitleInput, setClaimTitleInput] = useState('');
  const [claimStartDateInput, setClaimStartDateInput] = useState(new Date().toISOString().slice(0, 10));
  const [claimEndDateInput, setClaimEndDateInput] = useState(new Date().toISOString().slice(0, 10));
  const [selectedClaimDocumentIds, setSelectedClaimDocumentIds] = useState<string[]>([]);
  const [mileageVisible, setMileageVisible] = useState(false);
  const [mileageStartInput, setMileageStartInput] = useState('');
  const [mileageEndInput, setMileageEndInput] = useState('');
  const [mileageMilesInput, setMileageMilesInput] = useState('');
  const [mileageRateInput, setMileageRateInput] = useState('0.45');
  const [mileageProofs, setMileageProofs] = useState<{ uri: string; fileName?: string | null; mimeType?: string | null }[]>([]);
  const [themeVisible, setThemeVisible] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('newest');
  const [vehicleNameInput, setVehicleNameInput] = useState('');
  const [vehicleRegistrationInput, setVehicleRegistrationInput] = useState('');
  const [editingVehicleId, setEditingVehicleId] = useState<string | null>(null);
  const deferredSearch = useDeferredValue(search);
  const isAdmin = authSession?.user.role === 'Business_Admin';
  const vatTrackingEnabled = isVatTrackingEnabled(appState.organisationSettings);
  const effectiveTheme: ThemeOption =
    appState.settings.theme === 'system' ? (systemTheme === 'dark' ? 'dark' : 'light') : appState.settings.theme;
  const shellBackgroundStyle = effectiveTheme === 'dark' ? styles.shellDark : null;
  const shellTextStyle = effectiveTheme === 'dark' ? styles.shellTextDark : null;

  useEffect(() => {
    appStateRef.current = appState;
  }, [appState]);

  useEffect(() => {
    let mounted = true;

    const restoreState = async () => {
      const [savedAuthSession, savedErrorLogs, savedDiagnosticLogs] = await Promise.all([
        loadAuthSession(),
        loadStoredErrorLogs(),
        loadStoredDiagnosticLogs(),
      ]);
      if (mounted) {
        if (savedAuthSession) {
          setSessionToken(savedAuthSession.token);
          setAuthSession(savedAuthSession);
          setCloudPreviewCacheScope(savedAuthSession.user.id, savedAuthSession.user.organisationId);
          const savedState = await loadScopedStoredState(
            buildWorkspaceStateScope(savedAuthSession.user.id, savedAuthSession.user.organisationId),
            String(savedAuthSession.user.id),
          );
          if (savedState && mounted) {
            appStateRef.current = savedState;
            setAppState(savedState);
          }
        }
        setErrorLogs(savedErrorLogs);
        setDiagnosticLogs(savedDiagnosticLogs);
        hasRestoredStateRef.current = true;
        setIsReady(true);
      }
    };

    restoreState().catch(() => setIsReady(true));

    return () => {
      mounted = false;
    };
  }, []);

  const recordError = useEffectEvent(async (source: string, error: unknown, isFatal = false) => {
    const entry = formatErrorLog(source, error, isFatal);

    try {
      const next = await appendStoredErrorLog(entry);
      setErrorLogs(next);
    } catch {
      setErrorLogs((current) => [entry, ...current].slice(0, 30));
    }
  });

  const recordDiagnostic = useEffectEvent(async (source: string, message: string) => {
    const entry: AppErrorLog = {
      id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      source,
      message,
      isFatal: false,
    };

    try {
      const next = await appendStoredDiagnosticLog(entry);
      setDiagnosticLogs(next);
    } catch {
      setDiagnosticLogs((current) => [entry, ...current].slice(0, 60));
    }
  });

  const syncCloudWorkspace = useEffectEvent(async (session: AuthSession) => {
    const attemptId = ++cloudSyncAttemptRef.current;
    setCloudSyncState('syncing');
    setCloudSyncError(null);
    const timeoutId = setTimeout(() => {
      if (cloudSyncAttemptRef.current === attemptId) {
        setCloudSyncState('failed');
        setCloudSyncError('Sync is taking longer than expected. Your local changes are safe.');
      }
    }, cloudSyncTimeoutMs);

    try {
      let costDocuments: ExpenseDocument[] = [];
      let salesDocuments: ExpenseDocument[] = [];
      let remoteClaims: Claim[] = [];
      const fetchOptionalWorkspace = async (workspaceContext: WorkspaceContext) => {
        try {
          return await fetchCloudReceipts(workspaceContext);
        } catch (error) {
          // A plan entitlement must not prevent the permitted Costs workspace
          // from syncing. The server remains authoritative for access control.
          if (isWorkspaceUnavailableError(error)) {
            return [] as ExpenseDocument[];
          }
          throw error;
        }
      };

      try {
        [costDocuments, salesDocuments, remoteClaims] = await Promise.all([
          fetchCloudReceipts('cost', 200, true),
          fetchOptionalWorkspace('sales'),
          fetchExpenseClaims(),
        ]);
      } catch (error) {
        if (!isTransientNetworkError(error)) {
          throw error;
        }

        await delay(1200);
        [costDocuments, salesDocuments, remoteClaims] = await Promise.all([
          fetchCloudReceipts('cost', 200, true),
          fetchOptionalWorkspace('sales'),
          fetchExpenseClaims(),
        ]);
      }

      // Ignore a slower, older refresh once a newer refresh has begun. Without
      // this guard, overlapping refreshes could merge a stale list over the
      // current one and make recently synced items disappear temporarily.
      if (cloudSyncAttemptRef.current !== attemptId) {
        return;
      }

      // Always use the latest state. A sync can start while an upload or edit is
      // completing, and a render-time snapshot can otherwise overwrite that work.
      const currentDocuments = appStateRef.current.documents;
      const pendingCostSupplierUpdates = buildPendingCloudSupplierUpdates(currentDocuments, costDocuments);
      const pendingSalesSupplierUpdates = buildPendingCloudSupplierUpdates(currentDocuments, salesDocuments);

      const applyCloudWorkspace = (nextCostDocuments: ExpenseDocument[], nextSalesDocuments: ExpenseDocument[]) => {
        const nextDocuments = [...nextCostDocuments, ...nextSalesDocuments].sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt),
        );
        updateState((current) => ({
          ...current,
          documents: mergeWorkspaceDocuments(current.documents, nextDocuments, deletedCloudReceiptIdsRef.current),
          claims: remoteClaims,
        }));
        return nextDocuments;
      };

      // Apply the cloud list before doing any optional metadata or image work.
      // Previously the UI waited for an asset-url request for every receipt,
      // making a successful sync look empty and causing a large render burst.
      let mergedDocuments = applyCloudWorkspace(costDocuments, salesDocuments);

      if (pendingCostSupplierUpdates.length || pendingSalesSupplierUpdates.length) {
        await Promise.all([
          ...pendingCostSupplierUpdates.map(({ receiptId, updates }) => updateCloudReceipt(receiptId, updates)),
          ...pendingSalesSupplierUpdates.map(({ receiptId, updates }) => updateCloudReceipt(receiptId, updates)),
        ]);

        [costDocuments, salesDocuments] = await Promise.all([
          fetchCloudReceipts('cost', 200, true),
          fetchOptionalWorkspace('sales'),
        ]);
        if (cloudSyncAttemptRef.current !== attemptId) {
          return;
        }
        mergedDocuments = applyCloudWorkspace(costDocuments, salesDocuments);
      }

      if (cloudSyncAttemptRef.current === attemptId) {
        setCloudSyncState('synced');
      }

      // Previews are an enhancement, not a prerequisite for data sync. Fetch the
      // visible list batch after it appears, then cache each image locally so a
      // short-lived signed URL cannot leave the feed on placeholder thumbnails.
      const previewCandidates = mergedDocuments
        .filter((document) => {
          if (!canHydrateDocumentPreview(document) || !document.cloudReceiptId) {
            return false;
          }
          const existingDocument = appStateRef.current.documents.find(
            (current) =>
              current.cloudReceiptId === document.cloudReceiptId &&
              current.fileUri &&
              canPreviewDocumentInline(current),
          );
          return !existingDocument?.fileUri || isRemotePreviewUri(existingDocument.fileUri);
        })
        .slice(0, 12);

      void Promise.all(
        previewCandidates.map(async (document) => {
          try {
            const remoteUri = await fetchCloudReceiptAssetUrl(document.cloudReceiptId!);
            return {
              receiptId: document.cloudReceiptId!,
              fileUri: await cacheCloudPreview({
                receiptId: document.cloudReceiptId!,
                fileName: document.fileName,
                remoteUri,
              }),
            };
          } catch {
            return null;
          }
        }),
      ).then((previewUpdates) => {
        if (cloudSyncAttemptRef.current !== attemptId) {
          return;
        }
        const previewsByReceiptId = new Map(
          previewUpdates.filter((preview): preview is { receiptId: number; fileUri: string } => Boolean(preview)).map((preview) => [preview.receiptId, preview.fileUri]),
        );
        if (!previewsByReceiptId.size) {
          return;
        }
        updateState((current) => ({
          ...current,
          documents: current.documents.map((document) => {
            const fileUri = document.cloudReceiptId ? previewsByReceiptId.get(document.cloudReceiptId) : undefined;
            return fileUri ? { ...document, fileUri } : document;
          }),
        }));
      });
    } catch (error) {
      if (cloudSyncAttemptRef.current !== attemptId) {
        return;
      }
      if (isTransientNetworkError(error)) {
        await recordDiagnostic('cloud sync', 'Cloud sync skipped because the device could not reach the server.');
        setCloudSyncState('failed');
        setCloudSyncError('Could not reach Exdox. Your local changes are safe; retry when connected.');
        return;
      }
      setCloudSyncState('failed');
      setCloudSyncError(error instanceof Error ? error.message : 'Cloud sync failed.');
      void recordError('cloud sync', error);
    } finally {
      clearTimeout(timeoutId);
    }
  });

  const activateSession = useEffectEvent(async (session: AuthSession) => {
    setSessionToken(session.token);
    await saveAuthSession(session);
    setCloudPreviewCacheScope(session.user.id, session.user.organisationId);
    const savedState = await loadScopedStoredState(
      buildWorkspaceStateScope(session.user.id, session.user.organisationId),
      String(session.user.id),
    );
    setAuthSession(session);
    const nextState = savedState ?? seedState;
    appStateRef.current = nextState;
    setAppState(nextState);
    const tutorialSeen = await AsyncStorage.getItem(`exdox-onboarding-v1-${session.user.id}`);
    setTutorialStep(0);
    setTutorialVisible(!tutorialSeen);
    try {
      const organisationSettings = await fetchOrganisationSettings();
      updateState((current) => ({
        ...current,
        organisationSettings,
      }));
    } catch (error) {
      void recordError('organisation settings', error);
    }
    await syncCloudWorkspace(session);
  });

  const finishTutorial = useEffectEvent(async () => {
    if (authSession) {
      await AsyncStorage.setItem(`exdox-onboarding-v1-${authSession.user.id}`, 'complete');
    }
    setTutorialVisible(false);
  });

  const advanceTutorial = useEffectEvent(() => {
    const nextStep = tutorialStep + 1;
    if (nextStep >= appTutorialSteps.length) {
      void finishTutorial();
      return;
    }
    setTutorialStep(nextStep);
    setActiveTab(appTutorialSteps[nextStep].tab);
  });

  const signInWithBiometrics = useEffectEvent(async () => {
    setAuthBusy(true);
    try {
      const session = await loadBiometricAuthSession();
      if (!session) {
        Alert.alert(
          'Secure sign-in unavailable',
          'Sign in once with your email and password on this iPhone to enable Face ID or device authentication.',
        );
        return;
      }

      await activateSession(session);
      setAuthPassword('');
      setAuthFullName('');
      setAuthOrganisationName('');
    } catch (error) {
      void recordError('biometric sign-in', error);
      Alert.alert('Secure sign-in failed', 'Use your email address and password to sign in instead.');
    } finally {
      setAuthBusy(false);
    }
  });

  const handleSignOut = useEffectEvent(async () => {
    const cachedWorkspaceScope = authSession
      ? buildWorkspaceStateScope(authSession.user.id, authSession.user.organisationId)
      : null;
    const previewScope = cloudPreviewCacheScope;
    if (cachedWorkspaceScope) {
      await Promise.all([
        clearScopedStoredState(cachedWorkspaceScope),
        clearCloudPreviewCacheScope(previewScope),
      ]).catch(() => undefined);
    }
    cloudPreviewCacheScope = 'signed-out';
    setSessionToken(null);
    setAuthSession(null);
    appStateRef.current = seedState;
    setAppState(seedState);
    setSelectedDocumentId(null);
    setActiveTab('costs');
    await clearAuthSession({ preserveBiometric: true });
  });

  const handleDeleteAccount = useEffectEvent(() => {
    Alert.prompt(
      'Delete Exdox workspace',
      'This permanently deletes the workspace, its Exdox subscription and associated data. Enter your account password to continue.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: (password?: string) => {
            if (!password) {
              Alert.alert('Password required', 'Enter your account password before deleting the workspace.');
              return;
            }
            Alert.prompt(
              'Confirm permanent deletion',
              'Type DELETE exactly. This cannot be undone.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete permanently',
                  style: 'destructive',
                  onPress: async (confirmation?: string) => {
                    if (confirmation !== 'DELETE') {
                      Alert.alert('Confirmation required', 'Type DELETE exactly to confirm permanent deletion.');
                      return;
                    }
                    try {
                      await deleteAccount({ password, confirmation: 'DELETE' });
                      const workspaceScope = authSession
                        ? buildWorkspaceStateScope(authSession.user.id, authSession.user.organisationId)
                        : null;
                      if (workspaceScope) {
                        await Promise.all([
                          clearScopedStoredState(workspaceScope),
                          clearCloudPreviewCacheScope(cloudPreviewCacheScope),
                        ]).catch(() => undefined);
                      }
                      cloudPreviewCacheScope = 'signed-out';
                      setSessionToken(null);
                      setAuthSession(null);
                      appStateRef.current = seedState;
                      setAppState(seedState);
                      setSelectedDocumentId(null);
                      setActiveTab('costs');
                      await clearAuthSession();
                      Alert.alert('Account deleted', 'Your Exdox workspace, subscription and account have been deleted.');
                    } catch (error) {
                      void recordError('account deletion', error);
                      Alert.alert('Account not deleted', error instanceof Error ? error.message : 'Please try again.');
                    }
                  },
                },
              ],
              'plain-text',
            );
          },
        },
      ],
      'secure-text',
    );
  });

  const syncDocumentToCloud = useEffectEvent(
    async (
      documentId: string,
      updates: Partial<
        Pick<
          ExpenseDocument,
          'workspaceContext' | 'supplier' | 'date' | 'dueDate' | 'invoiceNumber' | 'category' | 'description' | 'customer' | 'paymentMethod' | 'netAmount' | 'vatAmount' | 'amount' | 'currency' | 'taxRateApplied' | 'status'
        >
      >,
    ) => {
      const document = appState.documents.find((entry) => entry.id === documentId);
      if (!document?.cloudReceiptId) {
        return;
      }

      await updateCloudReceipt(document.cloudReceiptId, {
        workspaceContext: document.workspaceContext,
        supplier: updates.supplier ?? document.supplier,
        date: updates.date ?? document.date,
        dueDate: updates.dueDate ?? document.dueDate,
        invoiceNumber: updates.invoiceNumber ?? document.invoiceNumber,
        category: updates.category ?? document.category,
        description: updates.description ?? document.description,
        customer: updates.customer ?? document.customer,
        paymentMethod: updates.paymentMethod ?? document.paymentMethod,
        netAmount: updates.netAmount ?? document.netAmount,
        vatAmount: updates.vatAmount ?? document.vatAmount,
        amount: updates.amount ?? document.amount,
        currency: updates.currency ?? document.currency,
        taxRateApplied: updates.taxRateApplied ?? document.taxRateApplied,
        status: updates.status ?? document.status,
      });

      if (authSession) {
        await syncCloudWorkspace(authSession);
      }
    },
  );

  const submitAuth = useEffectEvent(async () => {
    if (authMode === 'reset') {
      Alert.alert(
        'Password reset',
        authEmail
          ? 'Reset email delivery is not connected yet. Ask your Exdox administrator to reset your access for now.'
          : 'Enter your email address first so we know which account needs access help.',
      );
      return;
    }

    if (authMode === 'register') {
      await openRegisterPricing();
      return;
    }

    setAuthBusy(true);
    try {
      const session =
        await loginWithEmail({
          email: authEmail,
          password: authPassword,
        });

      await activateSession(session);
      void saveBiometricAuthSession(session);
      setAuthPassword('');
      setAuthFullName('');
      setAuthOrganisationName('');
    } catch (error) {
      void recordError('auth', error);
      Alert.alert('Sign-in failed', error instanceof Error ? error.message : 'Could not sign in right now.');
    } finally {
      setAuthBusy(false);
    }
  });

  const prepareManualDocument = useEffectEvent(async ({
    source,
    type,
    uri,
    fileName,
    workspaceContext,
    paymentMethod,
  }: {
    source: ExpenseDocument['source'];
    type: DocumentKind;
    uri: string;
    fileName: string;
    workspaceContext: WorkspaceContext;
    paymentMethod: PaymentMethod;
  }) => {
    await recordDiagnostic(source, `Preparing image ${fileName}`);
    const prepared = await prepareImportedImageForApp({
      id: `prepared-${Date.now()}`,
      uri,
      fileName,
    });
    await recordDiagnostic(
      source,
      `Prepared image ${prepared.fileName} | uri=${prepared.uri} | mime=${prepared.mimeType}`,
    );
    return buildManualDraftDocument({
      fileName: prepared.fileName,
      type,
      uri: prepared.uri,
      previewImageUri: prepared.uri,
      previewImageUris: [prepared.uri],
      source,
      workspaceContext,
      paymentMethod,
    });
  });

  const openRegisterPricing = useEffectEvent(async () => {
    try {
      await Linking.openURL('https://exdox.co.uk/register');
    } catch (error) {
      void recordError('auth register pricing redirect', error);
      Alert.alert('Open registration failed', 'We could not open Exdox registration right now.');
    }
  });

  const openForgotPassword = useEffectEvent(async () => {
    const targetUrl = authEmail.trim()
      ? `https://exdox.co.uk/forgot-password?email=${encodeURIComponent(authEmail.trim())}`
      : 'https://exdox.co.uk/forgot-password';

    try {
      await Linking.openURL(targetUrl);
    } catch (error) {
      void recordError('auth forgot password redirect', error);
      Alert.alert('Open reset failed', 'We could not open the Exdox password reset page right now.');
    }
  });

  const prepareCombinedManualDocument = useEffectEvent(
    async ({
      assets,
      type = captureType,
      source = 'gallery',
      workspaceContext,
      paymentMethod,
    }: {
      assets: Array<{
        uri: string;
        fileName: string;
      }>;
      type?: DocumentKind;
      source?: 'camera' | 'gallery';
      workspaceContext: WorkspaceContext;
      paymentMethod: PaymentMethod;
    }) => {
      await recordDiagnostic(source, `Preparing combined document from ${assets.length} ${source} images`);
      const combined = await prepareCombinedImageDocumentForApp({
        id: `combined-${Date.now()}`,
        assets,
        fileNameStem:
          assets[0]?.fileName?.replace(/\.[^/.]+$/, '') ||
          (type === 'invoice' ? 'invoice' : 'receipt'),
      });
      const nextDocument = buildManualDraftDocument({
        fileName: combined.fileName,
        type,
        uri: combined.uri,
        previewImageUri: combined.previewImageUri,
        previewImageUris: combined.previewImageUris,
        source,
        workspaceContext,
        paymentMethod,
      });
      return {
        ...nextDocument,
        notes: `Combined from ${assets.length} ${source} image${assets.length === 1 ? '' : 's'} and saved for manual review.`,
      };
    },
  );

  const commitPreparedDocument = useEffectEvent(
    async (
      document: ExpenseDocument,
      origin: 'camera' | 'gallery' | 'recovery',
      options?: {
        openReview?: boolean;
      },
    ) => {
      try {
        await recordDiagnostic(
          document.source,
          `Deferred commit starting from ${origin} | fileUri=${document.fileUri ?? 'undefined'}`,
        );
        const existingDuplicate = findExistingExactFileNameDuplicate(appStateRef.current.documents, {
          fileName: document.fileName,
          workspaceContext: document.workspaceContext,
          type: document.type,
        });
        const committedDocument = existingDuplicate
          ? buildBlockedDuplicateDocument({
              fileName: document.fileName,
              source: document.source,
              type: document.type,
              uri: document.fileUri,
              workspaceContext: document.workspaceContext,
              paymentMethod: document.paymentMethod,
            })
          : document;
        const shouldUploadDocument = !existingDuplicate;
        updateState((current) => ({
          ...current,
          documents: [committedDocument, ...current.documents],
        }));
        setActiveTab(document.type === 'invoice' ? 'sales' : 'costs');
        setSelectedDocumentId(null);
        if (options?.openReview ?? true) {
          setCaptureReviewDocumentId(committedDocument.id);
        }
        if (!shouldUploadDocument) {
          await recordDiagnostic(
            document.source,
            `Duplicate ${origin} document blocked before upload: ${document.fileName}`,
          );
          await recordDiagnostic(document.source, `Deferred commit complete from ${origin}`);
          return;
        }
        setTimeout(() => {
          void processPreparedDocumentUpload({
            documentId: document.id,
            fileName: document.fileName,
            fileUri: document.fileUri,
            type: document.type,
            source: document.source,
            workspaceContext: document.workspaceContext,
            paymentMethod: document.paymentMethod,
          });
        }, 120);
        await recordDiagnostic(document.source, `Deferred commit complete from ${origin}`);
      } catch (error) {
        await recordDiagnostic(document.source, `Deferred commit failed from ${origin}`);
        void recordError('prepared document commit', error);
        Alert.alert(
          'Import failed',
          'The receipt or invoice could not be saved. Please try again with another photo or import method.',
        );
      }
    },
  );

  const schedulePreparedDocumentCommit = useEffectEvent(
    (
      document: ExpenseDocument,
      origin: 'camera' | 'gallery' | 'recovery',
      options?: {
        openReview?: boolean;
      },
    ) => {
      void recordDiagnostic(document.source, `Scheduling deferred commit from ${origin}`);
      if (origin === 'camera') {
        InteractionManager.runAfterInteractions(() => {
          void recordDiagnostic(document.source, `Deferred commit running after interactions from ${origin}`);
          void commitPreparedDocument(document, origin, options);
        });
        return;
      }

      void recordDiagnostic(document.source, `Immediate commit running for ${origin}`);
      void commitPreparedDocument(document, origin, options);
    },
  );

  const processPreparedDocumentUpload = useEffectEvent(async ({
    documentId,
    fileName,
    fileUri,
    type,
    source,
    workspaceContext,
    paymentMethod,
  }: {
    documentId: string;
    fileName: string;
    fileUri?: string;
    type: DocumentKind;
    source: ExpenseDocument['source'];
    workspaceContext: WorkspaceContext;
    paymentMethod: PaymentMethod;
  }) => {
    if (!fileUri) {
      return;
    }

    try {
      await recordDiagnostic(source, `Starting background upload for ${fileName}`);
      const extracted = await documentExtractionService.extractFromAsset({
        type,
        fileName,
        uri: fileUri,
        lowResolution: appStateRef.current.settings.lowResolution,
        source,
        workspaceContext,
        paymentMethod,
        skipProcessing: false,
      });
      let currentDocument = appStateRef.current.documents.find((document) => document.id === documentId);
      const extractedWithDuplicateHint = markDuplicateUploadDraft(
        currentDocument,
        extracted,
        appStateRef.current.documents,
      );
      const nextDocument = currentDocument ? applyExtractedDocumentDraft(currentDocument, extractedWithDuplicateHint) : null;
      await recordDiagnostic(source, `Background upload complete for ${fileName}`);
      updateState((current) => ({
        ...current,
        documents: current.documents.map((document) =>
          document.id === documentId ? applyExtractedDocumentDraft(document, extractedWithDuplicateHint) : document,
        ),
      }));
      if (extractionLooksLikeDuplicateUpload(extractedWithDuplicateHint)) {
        if (
          authSession &&
          extracted.cloudReceiptId &&
          !appStateRef.current.documents.some(
            (document) => document.id !== documentId && document.cloudReceiptId === extracted.cloudReceiptId,
          )
        ) {
          await deleteCloudReceipt(extracted.cloudReceiptId);
          await syncCloudWorkspace(authSession);
        }
        return;
      }
      if (resolveExtractedDraftStatus(extractedWithDuplicateHint) === 'pending') {
        await recordDiagnostic(source, `Waiting for cloud extraction handshake for ${fileName}`);
        if (authSession) {
          let cloudMatchFound = false;
          for (let attempt = 1; attempt <= 8; attempt += 1) {
            await delay(3000);
            const latestLocalDocument =
              appStateRef.current.documents.find((document) => document.id === documentId) ?? currentDocument ?? nextDocument;
            if (!latestLocalDocument) {
              break;
            }

            try {
              let cloudDocuments = await fetchCloudReceipts(workspaceContext);
              const matchingCloudDocument = cloudDocuments.find(
                (candidate) =>
                  (latestLocalDocument.cloudReceiptId && candidate.cloudReceiptId === latestLocalDocument.cloudReceiptId) ||
                  isLikelyTimedOutUploadDuplicate(latestLocalDocument, candidate),
              );
              if (!matchingCloudDocument) {
                continue;
              }

              if (
                matchingCloudDocument.cloudReceiptId &&
                shouldPushLocalSupplierToCloud(latestLocalDocument, matchingCloudDocument)
              ) {
                await updateCloudReceipt(
                  matchingCloudDocument.cloudReceiptId,
                  buildCloudReceiptSyncUpdates(latestLocalDocument),
                );
                cloudDocuments = await fetchCloudReceipts(workspaceContext);
              }

              cloudMatchFound = true;
              await recordDiagnostic(source, `Cloud extraction handshake received for ${fileName} on attempt ${attempt}`);
              updateState((current) => ({
                ...current,
                documents: mergeWorkspaceDocuments(current.documents, cloudDocuments, deletedCloudReceiptIdsRef.current),
              }));
              break;
            } catch (error) {
              if (!isTransientNetworkError(error)) {
                throw error;
              }
            }
          }

          if (!cloudMatchFound) {
            await recordDiagnostic(source, `Cloud extraction handshake still pending for ${fileName}`);
            await syncCloudWorkspace(authSession);
          }
        }

        return;
      }
      if (
        authSession &&
        extractedWithDuplicateHint.cloudReceiptId &&
        nextDocument &&
        resolveExtractedDraftStatus(extractedWithDuplicateHint) === 'failed'
      ) {
        // The API has already created the authoritative unreadable-review item.
        // Do not save generated fallback values back to it first: a rejected
        // update used to skip the sync and leave a local placeholder beside the
        // cloud item. Merge the known receipt ID immediately instead.
        try {
          const cloudDocuments = await fetchCloudReceipts(workspaceContext);
          updateState((current) => ({
            ...current,
            documents: mergeWorkspaceDocuments(current.documents, cloudDocuments, deletedCloudReceiptIdsRef.current),
          }));
          await recordDiagnostic(source, `Merged unreadable upload with cloud receipt for ${fileName}`);
        } catch (error) {
          await recordDiagnostic(source, `Unreadable upload will merge on the next cloud sync for ${fileName}`);
          void recordError('unreadable upload reconciliation', error);
        }
        return;
      }
      if (authSession && extractedWithDuplicateHint.cloudReceiptId && nextDocument) {
        await updateCloudReceipt(extractedWithDuplicateHint.cloudReceiptId, buildCloudReceiptSyncUpdates(nextDocument));
        await syncCloudWorkspace(authSession);
      }
      if (authSession && !extractedWithDuplicateHint.cloudReceiptId) {
        await delay(1200);
        await syncCloudWorkspace(authSession);
      }
    } catch (error) {
      await recordDiagnostic(source, `Background upload failed for ${fileName}`);
      void recordError('background upload', error);
    }
  });

  useEffect(() => {
    if (!authSession) {
      return;
    }

    if (!appState.organisationSettings) {
      fetchOrganisationSettings()
        .then((organisationSettings) => {
          updateState((current) => ({
            ...current,
            organisationSettings,
          }));
        })
        .catch((error) => {
          void recordError('organisation settings', error);
        });
    }

    void syncCloudWorkspace(authSession);
  }, [appState.organisationSettings, authSession, recordError, syncCloudWorkspace]);

  useEffect(() => {
    if (!pendingGalleryOpen || cameraVisible) {
      return;
    }

    const timeoutId = setTimeout(() => {
      setPendingGalleryOpen(false);
      void recordDiagnostic('gallery', 'Camera closed, opening gallery picker');
      void openGalleryPicker();
    }, 180);

    return () => clearTimeout(timeoutId);
  }, [cameraVisible, pendingGalleryOpen, recordDiagnostic]);

  useEffect(() => {
    const errorUtils = (
      globalThis as typeof globalThis & {
        ErrorUtils?: {
          getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
          setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
        };
      }
    ).ErrorUtils;

    const previousHandler = errorUtils?.getGlobalHandler?.();
    errorUtils?.setGlobalHandler?.((error, isFatal) => {
      void recordError('Global JS error', error, Boolean(isFatal));
      previousHandler?.(error, isFatal);
    });

    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      originalConsoleError(...args);
      const firstArg = args[0];
      if (firstArg instanceof Error) {
        void recordError('console.error', firstArg, false);
        return;
      }
      if (typeof firstArg === 'string' && firstArg.trim()) {
        void recordError('console.error', firstArg, false);
      }
    };

    return () => {
      console.error = originalConsoleError;
      if (previousHandler && errorUtils?.setGlobalHandler) {
        errorUtils.setGlobalHandler(previousHandler);
      }
    };
  }, [recordError]);

  useEffect(() => {
    if (hasLoggedLaunchRef.current) {
      return;
    }

    hasLoggedLaunchRef.current = true;
    void recordDiagnostic('app', 'Application launched');
  }, [recordDiagnostic]);

  useEffect(() => {
    if (!isReady || !hasRestoredStateRef.current) {
      return;
    }

    let cancelled = false;

    const persistCurrentState = async () => {
      try {
        if (authSession) {
          await saveStoredState(
            appState,
            buildWorkspaceStateScope(authSession.user.id, authSession.user.organisationId),
          );
        }
      } catch {
        if (!cancelled) {
          Alert.alert('Storage warning', 'The change is visible, but it could not be saved on this device.');
        }
      }
    };

    void persistCurrentState();

    return () => {
      cancelled = true;
    };
  }, [appState, authSession, isReady]);

  const updateState = (updater: (current: AppState) => AppState) => {
    setAppState((current) => {
      const next = updater(current);
      appStateRef.current = next;
      return next;
    });
  };

  const filteredDocuments = useMemo(() => {
    const term = deferredSearch.trim().toLowerCase();
    return appState.documents
      .filter((document) => {
        if (activeTab === 'costs' && (document.workspaceContext !== 'cost' || isReimbursementArchiveDocument(document))) {
          return false;
        }
        if (activeTab === 'sales' && document.workspaceContext !== 'sales') {
          return false;
        }
        if (activeTab === 'claims' && document.claimId) {
          return false;
        }

        if (!term) {
          return statusFilter === 'all' ? true : document.status === statusFilter;
        }

        const matchesSearch = [document.title, document.supplier, document.notes, document.category, document.description, document.customer]
          .join(' ')
          .toLowerCase()
          .includes(term);
        const matchesStatus = statusFilter === 'all' ? true : document.status === statusFilter;
        return matchesSearch && matchesStatus;
      })
      .sort((left, right) => {
        if (sortMode === 'oldest') {
          return left.createdAt.localeCompare(right.createdAt);
        }
        if (sortMode === 'amount_high') {
          return right.amount - left.amount;
        }
        if (sortMode === 'amount_low') {
          return left.amount - right.amount;
        }
        return right.createdAt.localeCompare(left.createdAt);
      });
  }, [activeTab, appState.documents, deferredSearch, sortMode, statusFilter]);

  const archiveDocuments = useMemo(() => {
    if (!archiveTarget) {
      return [];
    }

    return appState.documents
      .filter((document) => document.workspaceContext === archiveTarget)
      .filter(
        (document) =>
          document.status === 'submitted' || document.status === 'payment_processing' || document.status === 'paid',
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [appState.documents, archiveTarget]);

  const selectedDocument = useMemo(
    () => appState.documents.find((document) => document.id === selectedDocumentId) ?? null,
    [appState.documents, selectedDocumentId],
  );

  // Report/archive rows may be older than the small background-preview batch.
  // When one is opened, load its secured image before the read-only details so
  // the receipt is always shown above its information.
  useEffect(() => {
    if (
      !selectedDocument ||
      !selectedDocument.cloudReceiptId ||
      !canHydrateDocumentPreview(selectedDocument) ||
      (canPreviewDocumentInline(selectedDocument) && !isRemotePreviewUri(getPrimaryDocumentPreviewUri(selectedDocument)))
    ) {
      return;
    }

    let cancelled = false;
    void fetchCloudReceiptAssetUrl(selectedDocument.cloudReceiptId)
      .then((remoteUri) =>
        cacheCloudPreview({
          receiptId: selectedDocument.cloudReceiptId!,
          fileName: selectedDocument.fileName,
          remoteUri,
        }),
      )
      .then((fileUri) => {
        if (cancelled) {
          return;
        }
        updateState((current) => ({
          ...current,
          documents: current.documents.map((document) =>
            document.id === selectedDocument.id ? { ...document, fileUri } : document,
          ),
        }));
      })
      .catch((error) => {
        if (!cancelled) {
          void recordError('report receipt preview', error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [recordError, selectedDocument?.cloudReceiptId, selectedDocument?.fileUri, selectedDocument?.id]);

  const captureReviewDocument = useMemo(
    () => appState.documents.find((document) => document.id === captureReviewDocumentId) ?? null,
    [appState.documents, captureReviewDocumentId],
  );

  const claims = useMemo(
    () =>
      [...appState.claims].sort((left, right) =>
        (right.submittedOn ?? '').localeCompare(left.submittedOn ?? ''),
      ),
    [appState.claims],
  );

  const processingAlerts = useMemo(
    () =>
      appState.documents
        .filter((document) => document.extractionStatus !== 'complete' || document.needsReview)
        .slice(0, 20)
        .map((document) => ({
          id: document.id,
          title: document.title,
          message:
            document.extractionStatus === 'pending'
              ? 'Still processing'
              : document.extractionStatus === 'failed'
                ? 'Needs another look'
                : 'Ready for review',
          createdAt: document.updatedAt ?? document.createdAt,
        })),
    [appState.documents],
  );

  const analyticsSummary = useMemo(() => {
    const total = filteredDocuments.reduce((sum, document) => sum + document.amount, 0);
    const vatTotal = vatTrackingEnabled
      ? filteredDocuments.reduce((sum, document) => sum + document.vatAmount, 0)
      : 0;
    return {
      total,
      vatTotal,
      reviewCount: appState.documents.filter((document) => document.status === 'awaiting_review').length,
      submittedCount: appState.documents.filter((document) => document.status === 'submitted').length,
    };
  }, [appState.documents, filteredDocuments, vatTrackingEnabled]);

  const inboundEmailAddress = useMemo(() => {
    if (!authSession) {
      return '';
    }
    return buildInboundEmailAddress(authSession.user.fullName || workspaceName, authSession.user.organisationId);
  }, [authSession]);

  const claimableDocuments = useMemo(
    () =>
      appState.documents
        .filter((document) => document.workspaceContext === 'cost')
        .filter((document) => document.paymentMethod === 'cash_personal')
        .filter((document) => !document.paymentMethodReviewRequired)
        .filter((document) => !document.claimId)
        .filter((document) => document.extractionStatus !== 'pending')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [appState.documents],
  );

  const tabTitle =
    activeTab === 'costs'
      ? 'Purchases'
      : activeTab === 'sales'
        ? 'Sales'
        : activeTab === 'claims'
          ? 'Expense claims'
          : activeTab === 'reports'
            ? 'Reports'
            : 'Settings';

  const syncCaptureType = () => {
    setCaptureType(activeTab === 'sales' ? 'invoice' : 'receipt');
  };

  const openCapture = () => {
    syncCaptureType();
    if (appState.settings.openOnCamera) {
      void handleUseCamera();
      return;
    }
    setCaptureModalVisible(true);
  };

  const openCaptureActions = () => {
    syncCaptureType();
    setSheetTarget('capture_actions');
  };

  const updateSettings = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    updateState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        [key]: value,
      },
    }));
  };

  const getCurrentCaptureContext = () => {
    const workspaceContext = getWorkspaceContextForTab(activeTab);
    return {
      workspaceContext,
      paymentMethod: getDefaultPaymentMethod(workspaceContext, Boolean(isAdmin)),
    };
  };

  const getCaptureContextForType = (type: DocumentKind) => {
    const workspaceContext: WorkspaceContext = type === 'invoice' ? 'sales' : 'cost';
    return {
      workspaceContext,
      paymentMethod: getDefaultPaymentMethod(workspaceContext, Boolean(isAdmin)),
    };
  };

  const commitGalleryAsset = useEffectEvent(
    async (
      asset: {
        uri?: string | null;
        fileName?: string | null;
        assetId?: string | null;
      },
      origin: 'gallery' | 'recovery',
    ) => {
      const assetKey = galleryResultAssetName(asset);
      if (handledGalleryAssetRef.current === assetKey) {
        await recordDiagnostic('gallery', `Skipping duplicate ${origin} asset handoff`);
        return;
      }

      if (!asset.uri) {
        await recordDiagnostic('gallery', `${origin} asset did not provide a usable URI`);
        Alert.alert('Import failed', 'The selected image did not provide a usable file path.');
        return;
      }

      handledGalleryAssetRef.current = assetKey;
      awaitingGalleryResultRef.current = false;
      await recordDiagnostic('gallery', `${origin} image selected: ${asset.fileName ?? 'unnamed'} | uri=${asset.uri}`);
      const nextDocument = await prepareManualDocument({
        source: 'gallery',
        type: captureType,
        uri: asset.uri,
        fileName: asset.fileName ?? `${captureType}-${Date.now()}.jpg`,
        ...getCurrentCaptureContext(),
      });
      await recordDiagnostic('gallery', `Manual draft document built from ${origin}`);
      schedulePreparedDocumentCommit(nextDocument, origin);
      await recordDiagnostic('gallery', 'Document scheduled for deferred state commit');
    },
  );

  const commitGalleryAssetsAsMultipleDocuments = useEffectEvent(
    async (
      assets: Array<{
        uri?: string | null;
        fileName?: string | null;
        assetId?: string | null;
      }>,
      origin: 'gallery',
    ) => {
      const captureContext = getCurrentCaptureContext();
      const nextDocuments = [];

      for (const [index, asset] of assets.entries()) {
        if (!asset.uri) {
          continue;
        }
        const prepared = await prepareManualDocument({
          source: 'gallery',
          type: captureType,
          uri: asset.uri,
          fileName: asset.fileName ?? `${captureType}-${Date.now()}-${index + 1}.jpg`,
          ...captureContext,
        });
        nextDocuments.push(prepared);
      }

      nextDocuments.forEach((document) => {
        schedulePreparedDocumentCommit(document, origin, { openReview: false });
      });

      if (nextDocuments.length) {
        setActiveTab(nextDocuments[0].type === 'invoice' ? 'sales' : 'costs');
        setSelectedDocumentId(null);
        setCaptureReviewDocumentId(null);
      }
    },
  );

  const promptForGallerySelectionMode = useEffectEvent(
    (assetCount: number) =>
      new Promise<GallerySelectionMode | null>((resolve) => {
        Alert.alert(
          'Submit as',
          `You selected ${assetCount} images from the gallery.`,
          [
            {
              text: 'Multiple documents',
              onPress: () => resolve('multiple_documents'),
            },
            {
              text: 'Combined document',
              onPress: () => resolve('combined_document'),
            },
            {
              text: 'Cancel',
              style: 'cancel',
              onPress: () => resolve(null),
            },
          ],
          {
            cancelable: true,
            onDismiss: () => resolve(null),
          },
        );
      }),
  );

  useEffect(() => {
    if (hasRecoveredPickerResultRef.current) {
      return;
    }

    hasRecoveredPickerResultRef.current = true;
    void (async () => {
      try {
        const pendingResult = await ImagePicker.getPendingResultAsync();
        if (!pendingResult || 'code' in pendingResult || pendingResult.canceled || !pendingResult.assets?.length) {
          return;
        }

        const asset = pendingResult.assets[0];
        await recordDiagnostic('gallery', `Recovered pending picker result: ${asset.fileName ?? 'unnamed'}`);
        await commitGalleryAsset(asset, 'recovery');
      } catch (error) {
        void recordError('picker pending result', error);
      }
    })();
  }, [commitGalleryAsset, recordDiagnostic, recordError]);

  useEffect(() => {
    const subscription = RNAppState.addEventListener('change', (nextState: string) => {
      if (nextState !== 'active' || !awaitingGalleryResultRef.current) {
        return;
      }

      void (async () => {
        try {
          const pendingResult = await ImagePicker.getPendingResultAsync();
          if (!pendingResult || 'code' in pendingResult || pendingResult.canceled || !pendingResult.assets?.length) {
            await recordDiagnostic('gallery', 'No recoverable pending gallery result was available');
            return;
          }

          await recordDiagnostic('gallery', 'Recovered gallery result after returning to the app');
          await commitGalleryAsset(pendingResult.assets[0], 'recovery');
        } catch (error) {
          void recordError('picker app state recovery', error);
        }
      })();
    });

    return () => {
      subscription.remove();
    };
  }, [commitGalleryAsset, recordDiagnostic, recordError]);

  const addDocument = async ({
    fileName,
    source,
    type,
    uri,
    lowResolution,
    openDetails = true,
    workspaceContext = type === 'invoice' ? 'sales' : 'cost',
    paymentMethod = getDefaultPaymentMethod(type === 'invoice' ? 'sales' : 'cost', Boolean(isAdmin)),
  }: {
    fileName: string;
    source: ExpenseDocument['source'];
    type: DocumentKind;
    uri?: string;
    lowResolution?: boolean;
    openDetails?: boolean;
    workspaceContext?: WorkspaceContext;
    paymentMethod?: PaymentMethod;
  }) => {
    setIsSaving(true);
    try {
      const existingDuplicate = findExistingExactFileNameDuplicate(appState.documents, {
        fileName,
        workspaceContext,
        type,
      });
      if (existingDuplicate) {
        const duplicateDocument = buildBlockedDuplicateDocument({
          fileName,
          source,
          type,
          uri,
          workspaceContext,
          paymentMethod,
        });
        updateState((current) => ({
          ...current,
          documents: [duplicateDocument, ...current.documents],
        }));
        if (openDetails) {
          setSelectedDocumentId(duplicateDocument.id);
        } else {
          setSelectedDocumentId(null);
        }
        setActiveTab(workspaceContext === 'sales' ? 'sales' : 'costs');
        return duplicateDocument;
      }

      const nextDocument = await buildDraftDocument({
        fileName,
        source,
        type,
        uri,
        lowResolution,
        workspaceContext,
        paymentMethod,
      });
      updateState((current) => ({
        ...current,
        documents: [nextDocument, ...current.documents],
      }));
      if (openDetails) {
        setSelectedDocumentId(nextDocument.id);
      } else {
        setSelectedDocumentId(null);
      }
      setActiveTab(workspaceContext === 'sales' ? 'sales' : 'costs');
      return nextDocument;
    } catch (error) {
      void recordError('addDocument', error);
      console.error('addDocument failed', error);
      Alert.alert(
        'Import failed',
        'The receipt or invoice could not be saved. Please try again with another photo or import method.',
      );
      return null;
    } finally {
      setIsSaving(false);
      setCaptureModalVisible(false);
    }
  };

  const openGalleryPicker = async () => {
    await recordDiagnostic('gallery', 'Launching system photo picker');
    awaitingGalleryResultRef.current = true;
    handledGalleryAssetRef.current = null;
    const pickerOptions: any = {
      mediaTypes: ['images'],
      allowsEditing: false,
      allowsMultipleSelection: true,
      quality: 0.8,
      exif: false,
    };

    try {
      const result = await ImagePicker.launchImageLibraryAsync(pickerOptions);
      await recordDiagnostic(
        'gallery',
        `Image library returned | canceled=${result.canceled ? 'yes' : 'no'} | assets=${result.assets?.length ?? 0}`,
      );

      if (!result.canceled && result.assets?.length) {
        if (result.assets.length === 1) {
          await commitGalleryAsset(result.assets[0], 'gallery');
          return;
        }

        await recordDiagnostic('gallery', `Multiple gallery assets selected: ${result.assets.length}`);
        awaitingGalleryResultRef.current = false;
        const selectionMode = await promptForGallerySelectionMode(result.assets.length);
        if (!selectionMode) {
          await recordDiagnostic('gallery', 'Gallery submit mode prompt was canceled');
          return;
        }

        if (selectionMode === 'multiple_documents') {
          await commitGalleryAssetsAsMultipleDocuments(result.assets, 'gallery');
          await recordDiagnostic('gallery', 'Gallery assets queued as multiple documents');
          return;
        }

        const captureContext = getCurrentCaptureContext();
        const combinedDocument = await prepareCombinedManualDocument({
          assets: result.assets
            .filter((asset) => Boolean(asset.uri))
            .map((asset, index) => ({
              uri: asset.uri!,
              fileName: asset.fileName ?? `${captureType}-${Date.now()}-${index + 1}.jpg`,
            })),
          ...captureContext,
        });
        schedulePreparedDocumentCommit(combinedDocument, 'gallery');
        await recordDiagnostic('gallery', 'Gallery assets queued as a combined document');
      } else if (!result.canceled) {
        await recordDiagnostic('gallery', 'Image picker returned without assets');
        Alert.alert('Import failed', 'No image was returned from the gallery picker.');
      } else {
        awaitingGalleryResultRef.current = false;
        await recordDiagnostic('gallery', 'Image selection canceled');
      }
    } catch (error) {
      awaitingGalleryResultRef.current = false;
      await recordDiagnostic('gallery', 'Image handling threw an error');
      void recordError('openGalleryPicker', error);
      Alert.alert('Import failed', 'The selected image could not be imported.');
    }
  };

  const handlePickImage = async () => {
    await recordDiagnostic('gallery', `handlePickImage start | cameraVisible=${cameraVisible ? 'yes' : 'no'}`);
    setCaptureModalVisible(false);
    if (cameraVisible) {
      setPendingGalleryOpen(true);
      await recordDiagnostic('gallery', 'Closing camera before opening gallery');
      setCameraVisible(false);
      return;
    }

    await openGalleryPicker();
  };

  const handlePickPdf = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      multiple: false,
      type: 'application/pdf',
      copyToCacheDirectory: true,
    });

    try {
      if (!result.canceled) {
        const asset = result.assets[0];
        const captureContext = getCurrentCaptureContext();
        await addDocument({
          fileName: asset.name,
          source: 'files',
          type: captureType,
          uri: asset.uri,
          lowResolution: appState.settings.lowResolution,
          workspaceContext: captureContext.workspaceContext,
          paymentMethod: captureContext.paymentMethod,
        });
      }
    } catch (error) {
      void recordError('handlePickPdf', error);
      console.error('handlePickPdf failed', error);
      Alert.alert('Import failed', 'The selected PDF could not be imported.');
    }
  };

  const handleUseCamera = async () => {
    const permission = await Camera.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Camera permission needed', 'Allow camera access so you can snap a new receipt or invoice.');
      return;
    }

    setCaptureModalVisible(false);
    setCameraVisible(true);
  };

  const handleAddToVault = useEffectEvent(async () => {
    setSheetTarget(null);
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: false,
        type: ['application/pdf', 'image/*'],
        copyToCacheDirectory: true,
      });

      if (result.canceled) {
        return;
      }

      const asset = result.assets[0];
      setVaultUpload({
        visible: true,
        progress: 12,
        status: 'Uploading your file securely...',
      });
      progressTimer = setInterval(() => {
        setVaultUpload((current) => {
          if (!current.visible) {
            return current;
          }

          const progress = Math.min(88, current.progress + 4);
          return {
            ...current,
            progress,
            status: progress >= 56 ? 'Processing your Vault item...' : 'Uploading your file securely...',
          };
        });
      }, 650);
      const vaultDocument = await addDocument({
        fileName: asset.name,
        source: 'files',
        type: 'receipt',
        uri: asset.uri,
        lowResolution: appState.settings.lowResolution,
        openDetails: false,
        workspaceContext: 'vault',
        paymentMethod: 'not_applicable',
      });
      if (!vaultDocument) {
        throw new Error('The file could not be saved to the Vault.');
      }
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = undefined;
      }
      setVaultUpload({
        visible: true,
        progress: 100,
        status: 'Processed and saved securely.',
      });
      await delay(350);
      setVaultUpload({ visible: false, progress: 0, status: '' });
      Alert.alert(
        'Vault upload processed',
        'Your file has been processed and saved securely in the Vault.',
      );
    } catch (error) {
      void recordError('handleAddToVault', error);
      Alert.alert('Vault upload failed', error instanceof Error ? error.message : 'Could not save this file to the vault.');
    } finally {
      if (progressTimer) {
        clearInterval(progressTimer);
      }
      setVaultUpload({ visible: false, progress: 0, status: '' });
    }
  });

  const deleteDocument = useEffectEvent(async (document: ExpenseDocument) => {
    if (
      !authSession ||
      (authSession.user.role !== 'Business_Admin' && document.uploadedByUserId !== authSession.user.id)
    ) {
      Alert.alert(
        'This item belongs to another account',
        'Only the Exdox account that uploaded this item can delete it from the app.',
      );
      return;
    }
    if (document.mileageClaimId) {
      if (document.status !== 'awaiting_review') {
        Alert.alert('Mileage claim reviewed', 'Only a mileage claim that has not been reviewed can be deleted.');
        return;
      }
      try {
        // Mileage Costs are projections of claims, not receipts. Their
        // synthetic receipt IDs cannot be sent to the receipt-delete route.
        await deleteCloudClaim(document.mileageClaimId);
        updateState((current) => ({
          ...current,
          documents: current.documents.filter((item) => item.id !== document.id),
          claims: current.claims.filter((claim) => claim.cloudClaimId !== document.mileageClaimId),
        }));
        setSelectedDocumentId((current) => (current === document.id ? null : current));
        await syncCloudWorkspace(authSession);
        return;
      } catch (error) {
        void recordError('delete mileage claim', error);
        Alert.alert('Delete failed', error instanceof Error ? error.message : 'Could not delete this mileage claim.');
        return;
      }
    }
    if (document.claimId) {
      Alert.alert(
        'Document linked to claim',
        'This item is already attached to an expense claim. Remove it from the claim flow first, then delete it.',
      );
      return;
    }

    try {
      if (document.cloudReceiptId) {
        await deleteCloudReceipt(document.cloudReceiptId);
        deletedCloudReceiptIdsRef.current.add(document.cloudReceiptId);
      }

      updateState((current) => ({
        ...current,
        documents: current.documents.filter((item) => item.id !== document.id),
      }));
      setSelectedDocumentId((current) => (current === document.id ? null : current));
      if (authSession) {
        await syncCloudWorkspace(authSession);
      }
    } catch (error) {
      void recordError('deleteDocument', error);
      Alert.alert('Delete failed', error instanceof Error ? error.message : 'Could not delete this document.');
    }
  });

  const confirmDeleteDocument = useEffectEvent((document: ExpenseDocument) => {
    Alert.alert(
      document.mileageClaimId ? 'Delete mileage claim' : 'Delete document',
      document.mileageClaimId
        ? 'Delete this unreviewed mileage claim from both the app and dashboard? This cannot be undone.'
        : `Delete ${document.title} from both the app and dashboard? This cannot be undone.`,
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void deleteDocument(document);
          },
        },
      ],
    );
  });

  const updateDocumentStatus = useEffectEvent(async (
    documentId: string,
    status: ExpenseDocument['status'],
    successConfirmation?: {
      title: string;
      message: string;
    },
  ) => {
    const updatedAt = new Date().toISOString();
    updateState((current) => ({
      ...current,
      documents: current.documents.map((document) =>
        document.id === documentId ? { ...document, status, updatedAt } : document,
      ),
    }));
    try {
      await syncDocumentToCloud(documentId, { status });
      if (successConfirmation) {
        Alert.alert(successConfirmation.title, successConfirmation.message);
      }
    } catch (error) {
      void recordError('update document status', error);
      Alert.alert('Sync failed', error instanceof Error ? error.message : 'Could not sync this receipt update.');
    }
  });

  const updateDocumentReviewFields = useEffectEvent(async (
    documentId: string,
    reviewFields: Pick<
      ExpenseDocument,
      'amount' | 'netAmount' | 'vatAmount' | 'taxAmount' | 'currency' | 'taxRateApplied' | 'category' | 'description' | 'customer'
    > & Partial<Pick<ExpenseDocument, 'paymentMethod'>>,
    successConfirmation?: {
      title: string;
      message: string;
    },
    syncStrategy: 'wait' | 'background' = 'wait',
  ) => {
    const updatedAt = new Date().toISOString();
    updateState((current) => ({
      ...current,
      documents: current.documents.map((document) =>
        document.id === documentId ? { ...document, ...reviewFields, needsReview: true, updatedAt } : document,
      ),
    }));
    if (syncStrategy === 'background') {
      if (successConfirmation) {
        Alert.alert(successConfirmation.title, successConfirmation.message);
      }
      void syncDocumentToCloud(documentId, reviewFields).catch((error) => {
        void recordError('update review fields', error);
        Alert.alert('Sync failed', error instanceof Error ? error.message : 'Could not sync this receipt update.');
      });
      return;
    }
    try {
      await syncDocumentToCloud(documentId, reviewFields);
      if (successConfirmation) {
        Alert.alert(successConfirmation.title, successConfirmation.message);
      }
    } catch (error) {
      void recordError('update review fields', error);
      Alert.alert('Sync failed', error instanceof Error ? error.message : 'Could not sync this receipt update.');
    }
  });

  const createClaimFromReceipt = useEffectEvent(async (document: ExpenseDocument) => {
    if (!authSession) {
      return;
    }
    if (!document.cloudReceiptId) {
      Alert.alert('Receipt not synced yet', 'Wait for the upload to finish before adding this item to a claim.');
      return;
    }

    try {
      const created = await createCloudClaim({
        name: `${document.supplier || 'Expense'} Claim`,
        description: `Claim created from ${document.title}`,
        currency: document.currency,
      });
      await attachCloudReceiptToClaim({
        receiptId: document.cloudReceiptId,
        claimId: created.id,
      });
      await syncCloudWorkspace(authSession);
      setActiveTab('claims');
      setSelectedDocumentId(null);
    } catch (error) {
      void recordError('createClaimFromReceipt', error);
      Alert.alert('Claim failed', error instanceof Error ? error.message : 'Could not create this expense claim.');
    }
  });

  const handleAttachToClaim = useEffectEvent(async (claim: Claim, document: ExpenseDocument) => {
    if (!authSession) {
      return;
    }
    if (!claim.cloudClaimId || !document.cloudReceiptId) {
      Alert.alert('Not ready yet', 'This claim or document has not synced to the server yet.');
      return;
    }

    try {
      await attachCloudReceiptToClaim({
        claimId: claim.cloudClaimId,
        receiptId: document.cloudReceiptId,
      });
      await syncCloudWorkspace(authSession);
    } catch (error) {
      void recordError('handleAttachToClaim', error);
      Alert.alert('Attach failed', error instanceof Error ? error.message : 'Could not add this document to the claim.');
    }
  });

  const handleRefreshFeed = useEffectEvent(async () => {
    if (!authSession) {
      return;
    }
    try {
      await syncCloudWorkspace(authSession);
    } catch (error) {
      void recordError('refresh feed', error);
    }
  });

  const handleOpenClaimComposer = () => {
    setClaimTitleInput(`Expense Claim ${new Date().toLocaleDateString('en-GB')}`);
    setClaimStartDateInput(new Date().toISOString().slice(0, 10));
    setClaimEndDateInput(new Date().toISOString().slice(0, 10));
    setSelectedClaimDocumentIds([]);
    setClaimComposerVisible(true);
  };

  const submitClaimComposer = useEffectEvent(async () => {
    const selectedDocuments = claimableDocuments.filter((document) => selectedClaimDocumentIds.includes(document.id));
    if (!selectedDocuments.length) {
      Alert.alert('Add purchases first', 'Choose at least one personal-spend purchase to include in this expense claim.');
      return;
    }
    if (selectedDocuments.some((document) => !document.cloudReceiptId)) {
      Alert.alert('Receipt still syncing', 'Wait for the selected purchases to finish syncing, then create the claim.');
      return;
    }

    setClaimComposerSubmitting(true);
    try {
      const created = await createCloudClaim({
        name: claimTitleInput.trim() || `Expense Claim ${new Date().toLocaleDateString('en-GB')}`,
        description: `Date range: ${claimStartDateInput} to ${claimEndDateInput}`,
        currency: 'GBP',
      });
      await Promise.all(
        selectedDocuments.map((document) =>
          attachCloudReceiptToClaim({
            claimId: created.id,
            receiptId: document.cloudReceiptId as number,
          }),
        ),
      );
      setClaimComposerVisible(false);
      setSelectedClaimDocumentIds([]);
      if (authSession) {
        await syncCloudWorkspace(authSession);
      }
      setActiveTab('claims');
      Alert.alert(
        'Claim submitted for review',
        `${selectedDocuments.length} purchase${selectedDocuments.length === 1 ? '' : 's'} ${selectedDocuments.length === 1 ? 'has' : 'have'} been added and sent to your employer for review.`,
      );
    } catch (error) {
      void recordError('submit claim composer', error);
      Alert.alert('Claim failed', error instanceof Error ? error.message : 'Could not create a new claim.');
    } finally {
      setClaimComposerSubmitting(false);
    }
  });

  const canDeleteDocument = (document: ExpenseDocument) =>
    Boolean(
      authSession &&
      (authSession.user.role === 'Business_Admin' || document.uploadedByUserId === authSession.user.id) &&
      (!document.mileageClaimId || document.status === 'awaiting_review'),
    );

  const submitMileageClaim = useEffectEvent(async () => {
    const miles = Number.parseFloat(mileageMilesInput);
    const rate = Number.parseFloat(mileageRateInput);
    if (!mileageStartInput.trim() || !mileageEndInput.trim() || !Number.isFinite(miles) || miles <= 0 || !Number.isFinite(rate) || rate <= 0) {
      Alert.alert('Mileage details needed', 'Add the start postcode, end postcode, total miles, and rate per mile.');
      return;
    }

    const mileageAmount = Number((miles * rate).toFixed(2));
    const journey = `${mileageStartInput.trim()} to ${mileageEndInput.trim()}`;
    let createdClaimId: number | null = null;
    setMileageSubmission({ visible: true, progress: 8, status: 'Creating your mileage claim…' });
    try {
      const createdClaim = await createCloudClaim({
        name: `Mileage claim ${new Date().toLocaleDateString('en-GB')}`,
        description: journey,
        currency: 'GBP',
        claimType: 'mileage',
        startPostcode: mileageStartInput.trim(),
        endPostcode: mileageEndInput.trim(),
        totalMiles: miles,
        mileageRate: rate,
      });
      createdClaimId = createdClaim.id;
      setMileageSubmission({
        visible: true,
        progress: mileageProofs.length ? 22 : 82,
        status: mileageProofs.length ? `Claim created. Uploading proof 1 of ${mileageProofs.length}…` : 'Claim created. Refreshing your Purchases…',
      });
      for (let index = 0; index < mileageProofs.length; index += 1) {
        await addCloudMileageProof(createdClaim.id, mileageProofs[index]);
        const uploadedCount = index + 1;
        setMileageSubmission({
          visible: true,
          progress: Math.round(22 + (uploadedCount / mileageProofs.length) * 60),
          status: uploadedCount === mileageProofs.length
            ? 'Proof images uploaded. Refreshing your Purchases…'
            : `Uploaded proof ${uploadedCount} of ${mileageProofs.length}. Uploading the next image…`,
        });
      }
      setMileageSubmission({ visible: true, progress: 90, status: 'Adding your mileage cost to Purchases…' });
      setMileageVisible(false);
      setMileageStartInput('');
      setMileageEndInput('');
      setMileageMilesInput('');
      setMileageRateInput(String(appState.organisationSettings?.mileageRate ?? 0.45));
      setMileageProofs([]);
      if (authSession) {
        try {
          await syncCloudWorkspace(authSession);
        } catch (syncError) {
          void recordError('refresh mileage claims after submission', syncError);
        }
      }
      setMileageSubmission({ visible: true, progress: 100, status: 'Mileage claim submitted.' });
      await delay(350);
      setActiveTab('costs');
      Alert.alert(
        'Mileage claim submitted',
        `${miles.toFixed(1)} miles from ${journey} (${formatCurrency(mileageAmount)}) has been sent to your employer for review and is now in Purchases.`,
      );
    } catch (error) {
      void recordError('submit mileage claim', error);
      Alert.alert(
        createdClaimId ? 'Mileage claim saved, but proof upload failed' : 'Mileage claim failed',
        createdClaimId
          ? `${error instanceof Error ? error.message : 'A journey proof image could not be uploaded.'} The mileage claim was created. Open it from Purchases or Expense claims and try again after checking your signal.`
          : error instanceof Error ? error.message : 'Could not create the mileage claim.',
      );
    } finally {
      setMileageSubmission({ visible: false, progress: 0, status: '' });
    }
  });

  const confirmDeleteClaim = useEffectEvent((claim: Claim) => {
    if (!claim.cloudClaimId || claim.status !== 'pending') return;
    Alert.alert('Delete expense claim?', 'Its purchases will return to Purchases and can be added to another claim.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete claim', style: 'destructive', onPress: () => void (async () => {
        try {
          await deleteCloudClaim(claim.cloudClaimId!);
          updateState((current) => ({ ...current, claims: current.claims.filter((item) => item.id !== claim.id), documents: current.documents.map((document) => document.claimId === claim.id ? { ...document, claimId: undefined } : document) }));
          if (authSession) await syncCloudWorkspace(authSession);
          Alert.alert('Expense claim deleted', 'The purchases are available again.');
        } catch (error) { Alert.alert('Could not delete claim', error instanceof Error ? error.message : 'Please try again.'); }
      }) },
    ]);
  });

  const saveVehicle = () => {
    const name = vehicleNameInput.trim();
    const registration = vehicleRegistrationInput.trim().toUpperCase();
    if (!name || !registration) {
      Alert.alert('Vehicle details needed', 'Add a vehicle name and registration.');
      return;
    }

    updateState((current) => ({
      ...current,
      vehicles: editingVehicleId
        ? current.vehicles.map((vehicle) =>
            vehicle.id === editingVehicleId ? { ...vehicle, name, registration } : vehicle,
          )
        : [...current.vehicles, { id: `vehicle-${Date.now()}`, name, registration }],
    }));
    setVehicleNameInput('');
    setVehicleRegistrationInput('');
    setEditingVehicleId(null);
  };

  const editVehicle = (vehicle: Vehicle) => {
    setEditingVehicleId(vehicle.id);
    setVehicleNameInput(vehicle.name);
    setVehicleRegistrationInput(vehicle.registration);
  };

  const removeVehicle = (vehicleId: string) => {
    updateState((current) => ({
      ...current,
      vehicles: current.vehicles.filter((vehicle) => vehicle.id !== vehicleId),
    }));
  };

  const handleTeamExport = useEffectEvent(async () => {
    const csvRows = [
      ['Type', 'Supplier', 'Amount', 'Status', 'Date'],
      ...appState.documents.map((document) => [
        document.type,
        document.supplier,
        document.amount.toFixed(2),
        getStatusLabel(document.status),
        document.date,
      ]),
    ];
    const csv = csvRows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\n');

    try {
      await Share.share({
        title: 'Exdox team export',
        message: csv,
      });
    } catch (error) {
      void recordError('team export', error);
      Alert.alert('Export failed', error instanceof Error ? error.message : 'Could not prepare the team export.');
    }
  });

  if (!isReady) {
    return (
      <SafeAreaView style={[styles.loadingScreen, shellBackgroundStyle]}>
        <StatusBar style={effectiveTheme === 'dark' ? 'light' : 'dark'} />
        <Image source={brandBadge} resizeMode="contain" style={styles.loadingLogo} />
        <Text style={[styles.loadingText, shellTextStyle]}>Preparing your workspace...</Text>
      </SafeAreaView>
    );
  }

  if (!authSession) {
    return (
      <SafeAreaView style={[styles.safeArea, shellBackgroundStyle]}>
        <StatusBar style={effectiveTheme === 'dark' ? 'light' : 'dark'} />
        <AuthScreen
          mode={authMode}
          fullName={authFullName}
          organisationName={authOrganisationName}
          email={authEmail}
          password={authPassword}
          busy={authBusy}
          onChangeMode={setAuthMode}
          onOpenRegisterPricing={() => void openRegisterPricing()}
          onOpenReset={() => void openForgotPassword()}
          onBackToLogin={() => setAuthMode('login')}
          onChangeFullName={setAuthFullName}
          onChangeOrganisationName={setAuthOrganisationName}
          onChangeEmail={setAuthEmail}
          onChangePassword={setAuthPassword}
          onSubmit={() => void submitAuth()}
          onFingerprintSignIn={() => void signInWithBiometrics()}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safeArea, shellBackgroundStyle]}>
      <StatusBar style={effectiveTheme === 'dark' ? 'light' : 'dark'} />
      <View style={[styles.screen, shellBackgroundStyle]}>
        <TopHeader
          title={tabTitle}
          subtitle={authSession.user.fullName || authSession.user.email}
          notificationCount={processingAlerts.length}
          onOpenNotifications={() => setNotificationsVisible(true)}
          onRefresh={() => void handleRefreshFeed()}
          onOpenSettings={() => setActiveTab('more')}
        />

        {cloudSyncState !== 'idle' ? (
          <View
            style={[
              styles.syncBanner,
              cloudSyncState === 'synced' && styles.syncBannerSynced,
              cloudSyncState === 'failed' && styles.syncBannerFailed,
            ]}
          >
            {cloudSyncState === 'synced' ? <Ionicons name="checkmark-circle" size={16} color={colors.dotMint} /> : null}
            {cloudSyncState === 'syncing' ? (
              <SyncingBannerLabel />
            ) : (
              <Text style={styles.syncBannerText}>
                {cloudSyncState === 'synced' ? 'Synced with Exdox' : cloudSyncError ?? 'Cloud sync failed.'}
              </Text>
            )}
            {cloudSyncState === 'failed' ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry cloud sync"
                onPress={() => void syncCloudWorkspace(authSession)}
              >
                <Text style={styles.syncBannerAction}>Retry</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {(activeTab === 'costs' || activeTab === 'sales') && (
          <SearchBand value={search} onChangeText={setSearch} onOpenFilter={() => setFilterVisible(true)} />
        )}

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {activeTab === 'costs' && (
            <CostsScreen
              documents={filteredDocuments}
              onOpenDocument={setSelectedDocumentId}
              onDeleteDocument={(document) => confirmDeleteDocument(document)}
              canDeleteDocument={canDeleteDocument}
              onAddDocument={openCapture}
            />
          )}
          {activeTab === 'sales' && (
            <SalesScreen
              documents={filteredDocuments}
              isAdmin={authSession.user.role === 'Business_Admin'}
              onOpenDocument={setSelectedDocumentId}
              onDeleteDocument={(document) => confirmDeleteDocument(document)}
              canDeleteDocument={canDeleteDocument}
              onAddDocument={openCapture}
            />
          )}
          {activeTab === 'claims' && (
            <ClaimsScreen
              claims={claims}
              documents={appState.documents}
              claimableDocuments={claimableDocuments}
              mode="claims"
              onCreateClaim={handleOpenClaimComposer}
              onAttachDocument={(claim, document) => void handleAttachToClaim(claim, document)}
              onOpenDocument={setSelectedDocumentId}
              onDeleteClaim={confirmDeleteClaim}
            />
          )}
          {activeTab === 'reports' && (
            <ClaimsScreen
              claims={claims}
              documents={appState.documents}
              claimableDocuments={[]}
              reimbursementDocuments={appState.documents
                .filter(isReimbursementArchiveDocument)
                .sort((left, right) => right.createdAt.localeCompare(left.createdAt))}
              mode="reports"
              onCreateClaim={handleOpenClaimComposer}
              onAttachDocument={(claim, document) => void handleAttachToClaim(claim, document)}
              onOpenDocument={setSelectedDocumentId}
              onDeleteClaim={confirmDeleteClaim}
            />
          )}
          {activeTab === 'more' && (
            <SettingsScreen
              accountName={authSession.user.fullName || workspaceName}
              accountEmail={authSession.user.email}
              role={authSession.user.role}
              settings={appState.settings}
              organisationSettings={appState.organisationSettings}
              errorLogCount={errorLogs.length}
              onUpdateSetting={updateSettings}
              onOpenTheme={() => setThemeVisible(true)}
              onOpenPanel={setSettingsPanelTarget}
              onOpenArchive={() => setSettingsPanelTarget('archive')}
              onOpenErrorLog={() => setErrorLogVisible(true)}
              onSaveMileageRate={async (value) => {
                const rate = Number.parseFloat(value);
                const current = appState.organisationSettings;
                if (!current || !Number.isFinite(rate) || rate <= 0) {
                  Alert.alert('Mileage rate', 'Enter a positive mileage rate.');
                  return;
                }
                const settings = await saveOrganisationSettings({ baseCurrency: current.baseCurrency, isVatRegistered: current.isVatRegistered, defaultTaxRate: current.defaultTaxRate, mileageRate: rate });
                updateState((state) => ({ ...state, organisationSettings: settings }));
                Alert.alert('Mileage rate saved', `${formatCurrency(settings.mileageRate)} per mile is now the approved default.`);
              }}
              onSignOut={() => void handleSignOut()}
              onDeleteAccount={handleDeleteAccount}
            />
          )}
        </ScrollView>

        <BottomNav
          activeTab={activeTab}
          onSelect={setActiveTab}
          onOpenCaptureActions={openCaptureActions}
        />

        <CaptureModal
          visible={captureModalVisible}
          captureType={captureType}
          activeTab={activeTab}
          isAdmin={Boolean(isAdmin)}
          isSaving={isSaving}
          onClose={() => setCaptureModalVisible(false)}
          onSelectType={setCaptureType}
          onUseCamera={handleUseCamera}
          onUseGallery={handlePickImage}
          onUsePdf={handlePickPdf}
        />

        <FirstUseTutorial
          visible={tutorialVisible}
          step={tutorialStep}
          onNext={advanceTutorial}
          onSkip={() => void finishTutorial()}
        />

        <MoreSheet
          target={sheetTarget}
          onClose={() => setSheetTarget(null)}
          onOpenCamera={() => {
            setSheetTarget(null);
            void handleUseCamera();
          }}
          onUseGallery={() => {
            setSheetTarget(null);
            void handlePickImage();
          }}
          onCreateMileageClaim={() => {
            setSheetTarget(null);
            setMileageVisible(true);
          }}
          onAddToVault={() => void handleAddToVault()}
        />

        <VaultUploadProgress
          visible={vaultUpload.visible}
          progress={vaultUpload.progress}
          status={vaultUpload.status}
        />

        <MileageSubmissionProgress
          visible={mileageSubmission.visible}
          progress={mileageSubmission.progress}
          status={mileageSubmission.status}
        />

        <CaptureReviewScreen
          document={captureReviewDocument}
          ownerName={authSession?.user.fullName ?? authSession?.user.email ?? 'Current user'}
          onClose={() => setCaptureReviewDocumentId(null)}
          onSubmit={async (reviewFields) => {
            if (!captureReviewDocument) {
              return;
            }
            await updateDocumentReviewFields(captureReviewDocument.id, {
              ...reviewFields,
              currency: captureReviewDocument.currency,
            });
            setCaptureReviewDocumentId(null);
            setSelectedDocumentId(null);
            setActiveTab(captureReviewDocument.type === 'invoice' ? 'sales' : 'costs');
          }}
        />

        <DocumentSheet
          document={selectedDocument}
          isAdmin={Boolean(isAdmin)}
          ownerName={authSession?.user.fullName ?? authSession?.user.email ?? 'Current user'}
          vatTrackingEnabled={vatTrackingEnabled}
          onClose={() => setSelectedDocumentId(null)}
          onMarkReviewed={() => {
            if (selectedDocument) {
              void updateDocumentStatus(selectedDocument.id, 'ready_to_submit', {
                title: selectedDocument.workspaceContext === 'sales' ? 'Sales document approved' : 'Marked reviewed',
                message: selectedDocument.workspaceContext === 'sales' ? 'This sales document is approved and ready to publish.' : 'This receipt has been marked as reviewed.',
              });
            }
          }}
          onAddToClaim={() => {
            if (selectedDocument) {
              void createClaimFromReceipt(selectedDocument);
            }
          }}
          onUpdateReviewFields={async (reviewFields) => {
            if (!selectedDocument) {
              return;
            }
            await updateDocumentReviewFields(selectedDocument.id, reviewFields);
          }}
          onMarkSubmitted={() => {
            if (selectedDocument) {
              void updateDocumentStatus(selectedDocument.id, 'submitted', {
                title: selectedDocument.workspaceContext === 'sales' ? 'Sales document published' : 'Marked submitted',
                message: selectedDocument.workspaceContext === 'sales' ? 'This sales document has been added to the published archive.' : 'This receipt has been marked as submitted.',
              });
            }
          }}
          onDelete={() => {
            if (selectedDocument) {
              confirmDeleteDocument(selectedDocument);
            }
          }}
          canDelete={selectedDocument ? canDeleteDocument(selectedDocument) : false}
        />

        <ErrorLogSheet
          visible={errorLogVisible}
          logs={[...errorLogs, ...diagnosticLogs].sort((left, right) => right.createdAt.localeCompare(left.createdAt))}
          onClose={() => setErrorLogVisible(false)}
          onClear={async () => {
            await clearStoredDiagnosticLogs();
            await clearStoredErrorLogs();
            setErrorLogs([]);
            setDiagnosticLogs([]);
            setErrorLogVisible(false);
          }}
        />

        <ArchiveSheet
          visible={Boolean(archiveTarget)}
          target={archiveTarget}
          documents={archiveDocuments}
          onClose={() => setArchiveTarget(null)}
          onOpenDocument={(documentId) => {
            setArchiveTarget(null);
            setSelectedDocumentId(documentId);
          }}
        />

        <NotificationsSheet
          visible={notificationsVisible}
          notifications={processingAlerts}
          onClose={() => setNotificationsVisible(false)}
          onOpenDocument={(documentId) => {
            setNotificationsVisible(false);
            setSelectedDocumentId(documentId);
          }}
        />

        <FilterSheet
          visible={filterVisible}
          statusFilter={statusFilter}
          sortMode={sortMode}
          onClose={() => setFilterVisible(false)}
          onSelectStatus={setStatusFilter}
          onSelectSort={setSortMode}
        />

        <ClaimComposerSheet
          visible={claimComposerVisible}
          submitting={claimComposerSubmitting}
          title={claimTitleInput}
          startDate={claimStartDateInput}
          endDate={claimEndDateInput}
          claimableDocuments={claimableDocuments}
          selectedDocumentIds={selectedClaimDocumentIds}
          onClose={() => setClaimComposerVisible(false)}
          onChangeTitle={setClaimTitleInput}
          onChangeStartDate={setClaimStartDateInput}
          onChangeEndDate={setClaimEndDateInput}
          onToggleDocument={(documentId) =>
            setSelectedClaimDocumentIds((current) =>
              current.includes(documentId) ? current.filter((id) => id !== documentId) : [...current, documentId],
            )
          }
          onSubmit={() => void submitClaimComposer()}
        />

        <MileageClaimSheet
          visible={mileageVisible}
          startPostcode={mileageStartInput}
          endPostcode={mileageEndInput}
          totalMiles={mileageMilesInput}
          mileageRate={mileageRateInput}
          proofNames={mileageProofs.map((proof, index) => proof.fileName || `Journey proof ${index + 1}`)}
          submitting={mileageSubmission.visible}
          onClose={() => !mileageSubmission.visible && setMileageVisible(false)}
          onChangeStartPostcode={setMileageStartInput}
          onChangeEndPostcode={setMileageEndInput}
          onChangeTotalMiles={setMileageMilesInput}
          onChangeMileageRate={setMileageRateInput}
          onAddProof={() => void (async () => {
            const remainingSlots = 5 - mileageProofs.length;
            if (remainingSlots <= 0) { Alert.alert('Proof images added', 'You can attach up to five journey proof images to a mileage claim.'); return; }
            const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: remainingSlots, quality: 0.7 });
            if (!result.canceled && result.assets.length) {
              setMileageProofs((current) => {
                const selected = result.assets.filter((asset) => !current.some((proof) => proof.uri === asset.uri));
                return [...current, ...selected].slice(0, 5);
              });
            }
          })()}
          onSubmit={() => void submitMileageClaim()}
        />

        <ThemeSheet
          visible={themeVisible}
          value={appState.settings.theme}
          onClose={() => setThemeVisible(false)}
          onSelect={(theme) => {
            updateSettings('theme', theme);
            setThemeVisible(false);
          }}
        />

        <SettingsPanelSheet
          visible={Boolean(settingsPanelTarget)}
          target={settingsPanelTarget}
          role={authSession.user.role}
          inboundEmailAddress={inboundEmailAddress}
          analyticsSummary={analyticsSummary}
          vatTrackingEnabled={vatTrackingEnabled}
          vehicles={appState.vehicles}
          vehicleNameInput={vehicleNameInput}
          vehicleRegistrationInput={vehicleRegistrationInput}
          editingVehicleId={editingVehicleId}
          onClose={() => setSettingsPanelTarget(null)}
          onOpenArchive={(target) => {
            setSettingsPanelTarget(null);
            setArchiveTarget(target);
          }}
          onExport={() => void handleTeamExport()}
          onChangeVehicleName={setVehicleNameInput}
          onChangeVehicleRegistration={setVehicleRegistrationInput}
          onSaveVehicle={saveVehicle}
          onEditVehicle={editVehicle}
          onDeleteVehicle={removeVehicle}
        />

        <CameraCapture
          visible={cameraVisible}
          type={captureType}
          lowResolution={appState.settings.lowResolution}
          onClose={() => setCameraVisible(false)}
          onSelectType={(nextType) => {
            setCaptureType(nextType);
            setActiveTab(nextType === 'invoice' ? 'sales' : 'costs');
          }}
          onUseGallery={() => {
            setCameraVisible(false);
            void handlePickImage();
          }}
          onUsePdf={() => {
            setCameraVisible(false);
            void handlePickPdf();
          }}
          onCaptureSingle={async (uri) => {
            const currentType = captureType;
            setCameraVisible(false);
            try {
              const nextDocument = await prepareManualDocument({
                source: 'camera',
                type: currentType,
                uri,
                fileName: `${currentType}-${Date.now()}.jpg`,
                ...getCaptureContextForType(currentType),
              });
              schedulePreparedDocumentCommit(nextDocument, 'camera');
              void recordDiagnostic('camera', 'Document scheduled for deferred state commit');
            } catch (error) {
              void recordError('camera draft save', error);
              console.error('camera draft save failed', error);
              Alert.alert(
                'Import failed',
                'The receipt photo could not be saved. Please try again or import from gallery.',
              );
              setSelectedDocumentId(null);
            }
          }}
          onCaptureMultiple={async (uri) => {
            const currentType = captureType;
            try {
              const nextDocument = await prepareManualDocument({
                source: 'camera',
                type: currentType,
                uri,
                fileName: `${currentType}-${Date.now()}.jpg`,
                ...getCaptureContextForType(currentType),
              });
              schedulePreparedDocumentCommit(nextDocument, 'camera', { openReview: false });
              void recordDiagnostic('camera', 'Multi-photo document scheduled for deferred state commit');
            } catch (error) {
              void recordError('camera multi draft save', error);
              console.error('camera multi draft save failed', error);
              Alert.alert(
                'Import failed',
                'The receipt photo could not be saved. Please try again or import from gallery.',
              );
            }
          }}
          onCaptureCombined={async (assets) => {
            const currentType = captureType;
            setCameraVisible(false);
            try {
              const combinedDocument = await prepareCombinedManualDocument({
                type: currentType,
                source: 'camera',
                assets: assets.map((asset, index) => ({
                  uri: asset.uri,
                  fileName: `${currentType}-${Date.now()}-${index + 1}.jpg`,
                })),
                ...getCaptureContextForType(currentType),
              });
              schedulePreparedDocumentCommit(combinedDocument, 'camera');
              void recordDiagnostic('camera', 'Combined camera document scheduled for deferred state commit');
            } catch (error) {
              void recordError('camera combined draft save', error);
              console.error('camera combined draft save failed', error);
              Alert.alert(
                'Import failed',
                'The combined receipt could not be saved. Please try again or import from gallery.',
              );
            }
          }}
        />
      </View>
    </SafeAreaView>
  );
}

function TopHeader({
  title,
  subtitle,
  notificationCount,
  onOpenNotifications,
  onRefresh,
  onOpenSettings,
}: {
  title: string;
  subtitle: string;
  notificationCount: number;
  onOpenNotifications: () => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <View style={styles.header}>
      <View style={styles.headerBrandBlock}>
        <View style={styles.headerBrandMarkFrame}>
          <Image source={brandBadge} resizeMode="contain" style={styles.headerBrandMark} />
        </View>
        <View>
          <Text style={styles.headerEyebrow}>EXDOX WORKSPACE</Text>
          <Text style={styles.headerTitle}>{title}</Text>
          <Text style={styles.headerSubtitle}>{subtitle}</Text>
        </View>
      </View>
      <View style={styles.headerActions}>
        <Pressable onPress={onOpenNotifications} hitSlop={8} style={styles.headerIconButton}>
          <Ionicons name="notifications-outline" size={23} color={colors.white} />
          {notificationCount ? (
            <View style={styles.headerNotificationDot}>
              <Text style={styles.headerNotificationDotText}>{Math.min(notificationCount, 9)}</Text>
            </View>
          ) : null}
        </Pressable>
        <Pressable onPress={onRefresh} hitSlop={8} style={styles.headerIconButton} accessibilityLabel="Refresh workspace">
          <Ionicons name="refresh-outline" size={23} color={colors.white} />
        </Pressable>
        <Pressable onPress={onOpenSettings} hitSlop={8} style={styles.headerIconButton} accessibilityLabel="Open settings">
          <Ionicons name="settings-outline" size={22} color={colors.white} />
        </Pressable>
      </View>
    </View>
  );
}

function SearchBand({
  value,
  onChangeText,
  onOpenFilter,
}: {
  value: string;
  onChangeText: (value: string) => void;
  onOpenFilter: () => void;
}) {
  return (
    <View style={styles.searchBand}>
      <View style={styles.searchRow}>
        <Ionicons name="search-outline" size={21} color={colors.tealDeep} />
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder="Search your workspace"
          placeholderTextColor={colors.mutedText}
          style={styles.searchInput}
        />
      </View>
      <Pressable style={styles.searchFilterButton} onPress={onOpenFilter} hitSlop={8}>
        <Ionicons name="options-outline" size={21} color={colors.tealDeep} />
      </Pressable>
    </View>
  );
}

function CostsScreen({
  documents,
  onOpenDocument,
  onDeleteDocument,
  canDeleteDocument,
  onAddDocument,
}: {
  documents: ExpenseDocument[];
  onOpenDocument: (id: string) => void;
  onDeleteDocument: (document: ExpenseDocument) => void;
  canDeleteDocument: (document: ExpenseDocument) => boolean;
  onAddDocument: () => void;
}) {
  if (!documents.length) {
    return (
      <BlankPanel
        icon="receipt-outline"
        title="Your purchases start here"
        copy="Add a receipt or bill and Exdox will prepare it for review."
        actionLabel="Upload a purchase"
        onAction={onAddDocument}
      />
    );
  }

  return (
    <FlatList
      data={documents}
      keyExtractor={(item) => item.id.toString()}
      scrollEnabled={false}
      ListHeaderComponent={
        <View style={styles.dayHeader}>
          <Text style={styles.dayHeaderText}>Today</Text>
        </View>
      }
      renderItem={({ item }) => (
        <DocumentRow
          document={item}
          onPress={() => onOpenDocument(item.id)}
          onStatusPress={() => onOpenDocument(item.id)}
          onLongPress={canDeleteDocument(item) ? () => onDeleteDocument(item) : undefined}
        />
      )}
    />
  );
}

function SalesScreen({
  documents,
  isAdmin,
  onOpenDocument,
  onDeleteDocument,
  canDeleteDocument,
  onAddDocument,
}: {
  documents: ExpenseDocument[];
  isAdmin: boolean;
  onOpenDocument: (id: string) => void;
  onDeleteDocument: (document: ExpenseDocument) => void;
  canDeleteDocument: (document: ExpenseDocument) => boolean;
  onAddDocument: () => void;
}) {
  const [view, setView] = useState<'inbox' | 'archive' | 'created' | 'customers' | 'history'>('inbox');
  const [workspace, setWorkspace] = useState<MobileSalesWorkspace | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    fetchSalesWorkspace().then((next) => { if (active) { setWorkspace(next); setWorkspaceError(null); } }).catch((error) => { if (active) setWorkspaceError(error instanceof Error ? error.message : 'Could not load Sales tools.'); });
    return () => { active = false; };
  }, []);
  const visibleDocuments = documents.filter((document) => view === 'archive'
    ? document.status === 'submitted' || document.status === 'paid'
    : document.status !== 'submitted' && document.status !== 'paid');

  return (
    <View>
      <View style={styles.salesWorkflowTabs}>
        <Pressable style={[styles.salesWorkflowTab, view === 'inbox' && styles.salesWorkflowTabActive]} onPress={() => setView('inbox')}>
          <Text style={[styles.salesWorkflowTabText, view === 'inbox' && styles.salesWorkflowTabTextActive]}>Inbox</Text>
        </Pressable>
        <Pressable style={[styles.salesWorkflowTab, view === 'archive' && styles.salesWorkflowTabActive]} onPress={() => setView('archive')}>
          <Text style={[styles.salesWorkflowTabText, view === 'archive' && styles.salesWorkflowTabTextActive]}>Published archive</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.salesToolTabs}>
        <Pressable style={[styles.salesToolTab, view === 'created' && styles.salesWorkflowTabActive]} onPress={() => setView('created')}><Text style={[styles.salesWorkflowTabText, view === 'created' && styles.salesWorkflowTabTextActive]}>Created documents</Text></Pressable>
        <Pressable style={[styles.salesToolTab, view === 'customers' && styles.salesWorkflowTabActive]} onPress={() => setView('customers')}><Text style={[styles.salesWorkflowTabText, view === 'customers' && styles.salesWorkflowTabTextActive]}>Customers</Text></Pressable>
        <Pressable style={[styles.salesToolTab, view === 'history' && styles.salesWorkflowTabActive]} onPress={() => setView('history')}><Text style={[styles.salesWorkflowTabText, view === 'history' && styles.salesWorkflowTabTextActive]}>Submission history</Text></Pressable>
      </ScrollView>
      {workspaceError ? <Text style={styles.salesWorkspaceError}>{workspaceError}</Text> : null}
      {view === 'created' ? <View style={styles.salesToolsPanel}><Text style={styles.panelSectionTitle}>Invoices, quotes & credit notes</Text>{workspace?.documents.map((item) => <View key={item.id} style={styles.salesToolRow}><View style={styles.salesToolRowMain}><Text style={styles.panelListTitle}>{item.number} · {item.customerName}</Text><Text style={styles.panelListMeta}>{item.kind.replace('_', ' ')} · {item.status.replace('_', ' ')} · {item.issueDate}</Text></View><View><Text style={styles.salesToolAmount}>{item.currency} {item.total.toFixed(2)}</Text><Text style={styles.panelListMeta}>{item.currency} {item.outstandingAmount.toFixed(2)} due</Text></View></View>)}{!workspace?.documents.length ? <Text style={styles.panelMuted}>No native sales documents yet.</Text> : null}{isAdmin ? <Pressable style={styles.panelPrimaryButton} onPress={() => void Linking.openURL('https://exdox.co.uk/sales/manage')}><Text style={styles.panelPrimaryButtonText}>Create or manage sales documents</Text></Pressable> : null}</View> : null}
      {view === 'customers' ? <View style={styles.salesToolsPanel}><Text style={styles.panelSectionTitle}>Customer directory</Text>{workspace?.customers.map((item) => <View key={item.id} style={styles.salesToolRow}><View style={styles.salesToolRowMain}><Text style={styles.panelListTitle}>{item.name}</Text><Text style={styles.panelListMeta}>{item.email || 'No email'} · {item.paymentTermsDays} day terms</Text></View></View>)}{!workspace?.customers.length ? <Text style={styles.panelMuted}>No customers saved yet.</Text> : null}{isAdmin ? <Pressable style={styles.panelPrimaryButton} onPress={() => void Linking.openURL('https://exdox.co.uk/sales/customers')}><Text style={styles.panelPrimaryButtonText}>Manage customers</Text></Pressable> : null}</View> : null}
      {view === 'history' ? <View style={styles.salesToolsPanel}><Text style={styles.panelSectionTitle}>Private Sales submission email</Text><Text selectable style={styles.salesSubmissionAddress}>{workspace?.submissionAddress.address || 'Loading...'}</Text>{workspace?.submissions.slice(0, 20).map((item) => <View key={item.id} style={styles.salesToolRow}><View style={styles.salesToolRowMain}><Text style={styles.panelListTitle}>{item.sourceFilename}</Text><Text style={styles.panelListMeta}>{item.channel} · {item.status} · {item.receiptIds.length} record(s)</Text></View></View>)}{!workspace?.submissions.length ? <Text style={styles.panelMuted}>No Sales submissions recorded yet.</Text> : null}</View> : null}
      {(view === 'inbox' || view === 'archive') ? (
      <FlatList
      data={visibleDocuments}
      keyExtractor={(item) => item.id.toString()}
      scrollEnabled={false}
      renderItem={({ item }) => (
        <DocumentRow
          document={item}
          onPress={() => onOpenDocument(item.id)}
          onStatusPress={() => onOpenDocument(item.id)}
          onLongPress={canDeleteDocument(item) ? () => onDeleteDocument(item) : undefined}
        />
      )}
      ListEmptyComponent={<BlankPanel icon="archive-outline" title="No sales documents here" copy={view === 'archive' ? 'Published sales documents will be retained here.' : 'No sales documents need attention.'} />}
    />
      ) : null}
    </View>
  );
}

function ClaimsScreen({
  claims,
  documents,
  claimableDocuments,
  reimbursementDocuments = [],
  mode,
  onCreateClaim,
  onAttachDocument,
  onOpenDocument,
  onDeleteClaim,
}: {
  claims: Claim[];
  documents: ExpenseDocument[];
  claimableDocuments: ExpenseDocument[];
  reimbursementDocuments?: ExpenseDocument[];
  mode: 'claims' | 'reports';
  onCreateClaim: () => void;
  onAttachDocument: (claim: Claim, document: ExpenseDocument) => void;
  onOpenDocument: (documentId: string) => void;
  onDeleteClaim: (claim: Claim) => void;
}) {
  const [expandedClaimId, setExpandedClaimId] = useState<string | null>(null);
  const [expandedPaymentRoundId, setExpandedPaymentRoundId] = useState<string | null>(null);

  const openClaims = claims.filter((claim) => claim.status === 'pending' || claim.status === 'rejected');
  const paymentRounds = groupReimbursementDocumentsByPaymentRound(reimbursementDocuments);

  if ((mode === 'reports' && !paymentRounds.length) || (mode === 'claims' && !openClaims.length)) {
    return (
      <BlankPanel
        icon={mode === 'reports' ? 'analytics-outline' : 'receipt-outline'}
        title={mode === 'reports' ? 'No payment rounds yet' : 'No expense claims yet'}
        copy={
          mode === 'reports'
            ? 'Your reimbursement rounds will appear here once your employer processes them.'
            : 'Create a claim to group your purchases before submitting them to your employer.'
        }
        actionLabel={mode === 'claims' ? 'Create a claim' : undefined}
        onAction={mode === 'claims' ? onCreateClaim : undefined}
      />
    );
  }

  const groupByMonth = (items: Claim[]) => {
    const groups = new Map<string, Claim[]>();
    items.forEach((claim) => {
      const month = claim.submittedOn ? formatMonthYear(claim.submittedOn) : 'Earlier reports';
      groups.set(month, [...(groups.get(month) ?? []), claim]);
    });
    return [...groups.entries()];
  };
  const toggleClaim = (claimId: string) => {
    setExpandedClaimId((current) => (current === claimId ? null : claimId));
  };

  return (
    <View style={styles.claimsList}>
      {mode === 'claims' ? (
        <Pressable style={styles.claimCreateButton} onPress={onCreateClaim}>
          <Ionicons name="add-circle-outline" size={20} color={colors.white} />
          <Text style={styles.claimCreateButtonText}>Create claim</Text>
        </Pressable>
      ) : null}

      {mode === 'reports' && paymentRounds.length ? (
        <>
          <View style={styles.claimSectionHeading}>
            <View>
              <Text style={styles.claimSectionTitle}>Payment rounds</Text>
              <Text style={styles.claimSectionCopy}>Select a total to view the receipts in that payment round.</Text>
            </View>
          </View>
          <View style={styles.claimMonthGroup}>
            {paymentRounds.map((round) => (
              <PaymentRoundCard
                key={round.id}
                round={round}
                expanded={expandedPaymentRoundId === round.id}
                onToggle={() =>
                  setExpandedPaymentRoundId((current) => (current === round.id ? null : round.id))
                }
                onOpenDocument={onOpenDocument}
              />
            ))}
          </View>
        </>
      ) : null}

      {mode === 'claims' && openClaims.length ? (
        <>
          <View style={styles.claimSectionHeading}>
            <View>
              <Text style={styles.claimSectionTitle}>Open claims</Text>
              <Text style={styles.claimSectionCopy}>Claims waiting for an employer decision.</Text>
            </View>
            <Ionicons name="time-outline" size={22} color={colors.royalBlueDark} />
          </View>
          {groupByMonth(openClaims).map(([month, monthClaims]) => (
            <View key={`open-${month}`} style={styles.claimMonthGroup}>
              <Text style={styles.claimMonthHeading}>{month}</Text>
              {monthClaims.map((claim) => (
                <ClaimReportCard
                  key={claim.id}
                  claim={claim}
                  documents={documents}
                  expanded={expandedClaimId === claim.id}
                  onToggle={() => toggleClaim(claim.id)}
                  claimableDocuments={claim.status === 'pending' && claim.claimType !== 'mileage' ? claimableDocuments : []}
                  onAttachDocument={onAttachDocument}
                  onDelete={onDeleteClaim}
                />
              ))}
            </View>
          ))}
        </>
      ) : null}
    </View>
  );
}

type PaymentRound = {
  id: string;
  processedAt: string;
  total: number;
  documents: ExpenseDocument[];
};

function groupReimbursementDocumentsByPaymentRound(documents: ExpenseDocument[]): PaymentRound[] {
  const rounds = new Map<string, PaymentRound>();

  documents.forEach((document) => {
    const processedAt = document.reimbursementBatchCreatedAt ?? document.updatedAt ?? document.createdAt;
    const batchId = document.reimbursementBatchId?.trim();
    // Legacy exports predate persistent batch IDs, so group their records by payment date.
    const legacyPaymentDate = processedAt.slice(0, 10);
    const key = batchId
      ? `batch:${batchId}`
      : `legacy:${document.status}:${legacyPaymentDate}`;
    const round = rounds.get(key) ?? {
      id: key,
      processedAt,
      total: 0,
      documents: [],
    };
    round.total += document.baseAmount ?? document.amount;
    round.documents.push(document);
    rounds.set(key, round);
  });

  return [...rounds.values()]
    .map((round) => ({
      ...round,
      total: Number(round.total.toFixed(2)),
      documents: [...round.documents].sort((left, right) => right.date.localeCompare(left.date)),
    }))
    .sort((left, right) => right.processedAt.localeCompare(left.processedAt));
}

function PaymentRoundCard({
  round,
  expanded,
  onToggle,
  onOpenDocument,
}: {
  round: PaymentRound;
  expanded: boolean;
  onToggle: () => void;
  onOpenDocument: (documentId: string) => void;
}) {
  const roundCurrency = round.documents[0]?.baseCurrency ?? 'GBP';
  const roundTotal = formatCurrency(round.total, roundCurrency);

  return (
    <View style={styles.paymentRoundCard}>
      <Pressable
        style={[styles.paymentRoundHeader, expanded && styles.paymentRoundHeaderExpanded]}
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${formatDate(round.processedAt)}, ${roundTotal}, ${round.documents.length} receipts`}
      >
        <Text style={styles.paymentRoundDate}>{formatDate(round.processedAt)}</Text>
        <View style={styles.paymentRoundTotalWrap}>
          <Text style={styles.paymentRoundTotal}>{roundTotal}</Text>
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={19} color={colors.royalBlueDark} />
        </View>
      </Pressable>

      {expanded ? (
        <View style={styles.paymentRoundExpanded}>
          {round.documents.map((document) => (
            <Pressable
              key={document.id}
              style={styles.paymentRoundReceiptRow}
              onPress={() => onOpenDocument(document.id)}
              accessibilityRole="button"
              accessibilityLabel={`Open ${document.title || document.supplier} details`}
            >
              <View style={styles.paymentRoundReceiptDetails}>
                <Text style={styles.paymentRoundReceiptTitle} numberOfLines={1}>
                  {document.title || document.supplier}
                </Text>
                <Text style={styles.paymentRoundReceiptDate}>{formatDate(document.date)}</Text>
              </View>
              <View style={styles.paymentRoundReceiptAction}>
                <Text style={styles.paymentRoundReceiptAmount}>
                  {document.currency === document.baseCurrency || document.baseAmount == null
                    ? formatCurrency(document.amount, document.currency)
                    : `${formatCurrency(document.amount, document.currency)} · ${formatCurrency(document.baseAmount, document.baseCurrency)}`}
                </Text>
                <Ionicons name="chevron-forward" size={18} color={colors.royalBlueDark} />
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ClaimReportCard({
  claim,
  documents,
  expanded,
  onToggle,
  claimableDocuments = [],
  onAttachDocument,
  onDelete,
}: {
  claim: Claim;
  documents: ExpenseDocument[];
  expanded: boolean;
  onToggle: () => void;
  claimableDocuments?: ExpenseDocument[];
  onAttachDocument?: (claim: Claim, document: ExpenseDocument) => void;
  onDelete?: (claim: Claim) => void;
}) {
  const linkedDocuments = documents.filter((document) => document.claimId === claim.id);
  const itemCount = Math.max(claim.documentCount ?? 0, claim.documentIds.length, linkedDocuments.length);
  const linkedTotal = linkedDocuments.reduce((total, document) => total + document.amount, 0);
  const claimTotal = claim.total > 0 ? claim.total : linkedTotal;
  const isPaid = claim.status === 'paid';
  const isApproved = claim.status === 'approved';
  const statusLabel = isPaid ? 'Paid' : isApproved ? 'Approved' : claim.status === 'rejected' ? 'Returned' : 'Awaiting review';
  const statusDetail = isPaid ? 'Payment processed' : isApproved ? 'Ready for payment' : claim.status === 'rejected' ? 'Needs changes' : 'With your employer';

  return (
    <View style={styles.claimCard}>
      <Pressable
        style={[styles.claimCardHeader, expanded && styles.claimCardHeaderExpanded]}
        onPress={onToggle}
        onLongPress={claim.status === 'pending' && onDelete ? () => onDelete(claim) : undefined}
        delayLongPress={500}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${claim.name}, ${formatCurrency(claimTotal, claim.currency)}, ${statusLabel}${claim.status === 'pending' ? '. Long press to delete this pending claim.' : ''}`}
      >
        <View style={styles.claimRowLeft}>
          <Text style={styles.claimName}>{claim.name}</Text>
          <Text style={styles.claimMeta}>
            {`${itemCount || 'No'} receipt${itemCount === 1 ? '' : 's'}${claim.submittedOn ? ` • ${formatDate(claim.submittedOn)}` : ''}`}
          </Text>
        </View>
        <View style={[styles.claimStatusChip, isPaid ? styles.claimStatusPaid : isApproved ? styles.claimStatusApproved : styles.claimStatusOpen]}>
          <Text
            style={[
              styles.claimStatusText,
              isApproved && styles.claimStatusTextProcessed,
              isPaid && styles.claimStatusTextPaid,
            ]}
          >
            {statusLabel}
          </Text>
          {expanded ? (
            <Text
              style={[
                styles.claimStatusDetail,
                isApproved && styles.claimStatusTextProcessed,
                isPaid && styles.claimStatusTextPaid,
              ]}
            >
              {statusDetail}
            </Text>
          ) : null}
        </View>
        <View style={styles.claimListTotal}>
          <Text style={styles.claimListAmount}>{formatCurrency(claimTotal, claim.currency)}</Text>
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={19} color={colors.royalBlueDark} />
        </View>
      </Pressable>

      {expanded ? (
        <View style={styles.claimExpandedContent}>
          {claim.description ? <Text style={styles.claimDescription}>{claim.description}</Text> : null}
          <Text style={styles.claimItemsHeading}>Items in this claim</Text>
          {linkedDocuments.length ? (
        <View style={styles.claimReceiptList}>
          {linkedDocuments.map((document) => (
            <View key={document.id} style={styles.claimReceiptRow}>
              <View style={styles.claimReceiptIcon}>
                <Ionicons name="receipt-outline" size={17} color={colors.royalBlueDark} />
              </View>
              <View style={styles.claimReceiptCopy}>
                <Text style={styles.claimReceiptName} numberOfLines={1}>{document.title}</Text>
                <Text style={styles.claimReceiptDate}>{formatDate(document.date)}</Text>
              </View>
              <Text style={styles.claimReceiptAmount}>{formatCurrency(document.amount, document.currency)}</Text>
            </View>
          ))}
        </View>
          ) : (
            <Text style={styles.claimReceiptSummary}>{itemCount ? `${itemCount} receipt${itemCount === 1 ? '' : 's'} included in this claim.` : 'No receipts linked yet.'}</Text>
          )}

          {claimableDocuments.length && onAttachDocument ? (
            <View style={styles.claimAttachList}>
              <Text style={styles.claimAddPurchaseLabel}>Add a purchase</Text>
              {claimableDocuments.slice(0, 3).map((document) => (
                <Pressable key={`${claim.id}-${document.id}`} style={styles.claimAttachButton} onPress={() => onAttachDocument(claim, document)}>
                  <Text style={styles.claimAttachButtonText}>{`Add ${document.title}`}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          <View style={styles.claimTotalRow}>
            <Text style={styles.claimTotalLabel}>Claim total</Text>
            <Text style={styles.claimTotalAmount}>{formatCurrency(claimTotal, claim.currency)}</Text>
          </View>
          {claim.status === 'pending' ? <Text style={styles.claimReceiptSummary}>Long press the claim heading to delete this pending claim.</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function FirstUseTutorial({ visible, step, onNext, onSkip }: { visible: boolean; step: number; onNext: () => void; onSkip: () => void }) {
  if (!visible) return null;
  const current = appTutorialSteps[step] ?? appTutorialSteps[0];
  const lastStep = step === appTutorialSteps.length - 1;
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onSkip}>
      <View style={styles.tutorialBackdrop}>
        <View style={styles.tutorialCard}>
          <View style={styles.tutorialIcon}><Ionicons name={current.icon} size={34} color={colors.white} /></View>
          <Text style={styles.tutorialProgress}>{`${step + 1} of ${appTutorialSteps.length}`}</Text>
          <Text style={styles.tutorialTitle}>{current.title}</Text>
          <Text style={styles.tutorialCopy}>{current.copy}</Text>
          <View style={styles.tutorialDots}>{appTutorialSteps.map((_, index) => <View key={index} style={[styles.tutorialDot, index === step && styles.tutorialDotActive]} />)}</View>
          <Pressable style={styles.tutorialPrimary} onPress={onNext}><Text style={styles.tutorialPrimaryText}>{lastStep ? 'Start using Exdox' : 'Next'}</Text></Pressable>
          {!lastStep ? <Pressable style={styles.tutorialSkip} onPress={onSkip}><Text style={styles.tutorialSkipText}>Skip tour</Text></Pressable> : null}
        </View>
      </View>
    </Modal>
  );
}

function AuthScreen({
  mode,
  fullName,
  organisationName,
  email,
  password,
  busy,
  onChangeMode,
  onOpenRegisterPricing,
  onOpenReset,
  onBackToLogin,
  onChangeFullName,
  onChangeOrganisationName,
  onChangeEmail,
  onChangePassword,
  onSubmit,
  onFingerprintSignIn,
}: {
  mode: 'login' | 'register' | 'reset';
  fullName: string;
  organisationName: string;
  email: string;
  password: string;
  busy: boolean;
  onChangeMode: (mode: 'login' | 'register' | 'reset') => void;
  onOpenRegisterPricing: () => void;
  onOpenReset: () => void;
  onBackToLogin: () => void;
  onChangeFullName: (value: string) => void;
  onChangeOrganisationName: (value: string) => void;
  onChangeEmail: (value: string) => void;
  onChangePassword: (value: string) => void;
  onSubmit: () => void;
  onFingerprintSignIn: () => void;
}) {
  return (
    <KeyboardAvoidingView
      style={styles.authScreen}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'android' ? 24 : 0}
    >
      <ScrollView
        contentContainerStyle={styles.authScrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.authCard}>
          <View style={styles.authLogoFrame}>
            <Image source={brandBadge} resizeMode="contain" style={styles.authLogo} />
          </View>
          <Text style={styles.authTitle}>Exdox</Text>
          <Text style={styles.authSubtitle}>
            {mode === 'login'
              ? 'Sign in to your receipt workspace.'
              : mode === 'register'
                ? 'Choose whether you are registering a business, sole trader, or employee account.'
                : 'Request help getting back into your Exdox workspace.'}
          </Text>

          {mode !== 'reset' ? (
            <View style={styles.authTabs}>
              <Pressable
                style={[styles.authTab, mode === 'login' && styles.authTabActive]}
                onPress={() => onChangeMode('login')}
              >
                <Text style={[styles.authTabText, mode === 'login' && styles.authTabTextActive]}>Login</Text>
              </Pressable>
              <Pressable
                style={[styles.authTab, mode === 'register' && styles.authTabActive]}
                onPress={onOpenRegisterPricing}
              >
                <Text style={[styles.authTabText, mode === 'register' && styles.authTabTextActive]}>Register</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable style={styles.authSecondaryLink} onPress={onBackToLogin}>
              <Text style={styles.authSecondaryLinkText}>Back to login</Text>
            </Pressable>
          )}

          {mode === 'register' ? (
            <>
              <TextInput
                value={fullName}
                onChangeText={onChangeFullName}
                placeholder="Full name"
                placeholderTextColor={colors.mutedText}
                style={styles.authInput}
              />
              <TextInput
                value={organisationName}
                onChangeText={onChangeOrganisationName}
                placeholder="Business name"
                placeholderTextColor={colors.mutedText}
                style={styles.authInput}
              />
            </>
          ) : null}
          <TextInput
            value={email}
            onChangeText={onChangeEmail}
            placeholder={mode === 'reset' ? 'Work email' : 'Email'}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            placeholderTextColor={colors.mutedText}
            style={styles.authInput}
          />
          {mode !== 'reset' ? (
            <TextInput
              value={password}
              onChangeText={onChangePassword}
              placeholder="Password"
              secureTextEntry
              placeholderTextColor={colors.mutedText}
              style={styles.authInput}
            />
          ) : null}

          <Pressable style={[styles.authButton, busy && styles.authButtonDisabled]} onPress={onSubmit} disabled={busy}>
            {busy ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Text style={styles.authButtonText}>
                {mode === 'login' ? 'Sign in' : mode === 'register' ? 'Choose account type' : 'Request reset help'}
              </Text>
            )}
          </Pressable>
          {mode === 'login' ? (
            <>
              <Pressable
                style={[styles.biometricButton, busy && styles.authButtonDisabled]}
                onPress={onFingerprintSignIn}
                disabled={busy}
              >
                <Ionicons name="finger-print-outline" size={21} color={colors.royalBlueDark} />
                <Text style={styles.biometricButtonText}>Sign in with fingerprint</Text>
              </Pressable>
              <Pressable style={styles.authSecondaryLink} onPress={onOpenReset}>
                <Text style={styles.authSecondaryLinkText}>Forgot password?</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function SettingsScreen({
  accountName,
  accountEmail,
  role,
  settings,
  organisationSettings,
  errorLogCount,
  onUpdateSetting,
  onOpenTheme,
  onOpenPanel,
  onOpenArchive,
  onOpenErrorLog,
  onSaveMileageRate,
  onSignOut,
  onDeleteAccount,
}: {
  accountName: string;
  accountEmail: string;
  role: 'Business_Admin' | 'Standard_Employee';
  settings: UserSettings;
  organisationSettings: OrganisationSettings | null;
  errorLogCount: number;
  onUpdateSetting: <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => void;
  onOpenTheme: () => void;
  onOpenPanel: (target: SettingsPanelTarget) => void;
  onOpenArchive: () => void;
  onOpenErrorLog: () => void;
  onSaveMileageRate: (value: string) => Promise<void>;
  onSignOut: () => void;
  onDeleteAccount: () => void;
}) {
  const [mileageRate, setMileageRate] = useState(String(organisationSettings?.mileageRate ?? 0.45));
  useEffect(() => setMileageRate(String(organisationSettings?.mileageRate ?? 0.45)), [organisationSettings?.mileageRate]);
  return (
    <View>
      <View style={styles.profileRow}>
        <View style={styles.profileAvatar}>
          <Ionicons name="person-outline" size={28} color={colors.nearBlack} />
        </View>
        <View style={styles.profileCopy}>
          <Text style={styles.profileName}>{accountName}</Text>
          <Text style={styles.profileEmail}>{accountEmail}</Text>
          <Text style={styles.profileRole}>
            {role === 'Business_Admin' ? 'Business admin access' : 'Standard employee access'}
          </Text>
        </View>
      </View>

      {role === 'Business_Admin' ? (
        <>
          <SettingsButton icon="business-outline" label="Business admin access" onPress={() => onOpenPanel('business_admin')} />
          <View style={styles.settingsGroup}>
            <Text style={styles.settingLabel}>Approved mileage rate per mile</Text>
            <TextInput value={mileageRate} onChangeText={setMileageRate} keyboardType="decimal-pad" style={styles.panelInput} placeholder="0.45" />
            <Pressable style={styles.panelPrimaryButton} onPress={() => void onSaveMileageRate(mileageRate)}>
              <Text style={styles.panelPrimaryButtonText}>Save mileage rate</Text>
            </Pressable>
          </View>
        </>
      ) : null}
      <SettingsButton icon="people-outline" label="Logins" onPress={() => onOpenPanel('logins')} />
      <SettingsButton icon="mail-outline" label="Extract by email" onPress={() => onOpenPanel('extract_email')} />
      <SettingsButton icon="car-outline" label="Vehicles" onPress={() => onOpenPanel('vehicles')} />
      {role === 'Business_Admin' ? (
        <>
          <SettingsButton icon="bar-chart-outline" label="Analytics" onPress={() => onOpenPanel('analytics')} />
          <SettingsButton icon="download-outline" label="Team exports" onPress={() => onOpenPanel('team_exports')} />
        </>
      ) : null}
      <SettingsButton
        icon="alert-circle-outline"
        label={`Error log${errorLogCount ? ` (${errorLogCount})` : ''}`}
        onPress={onOpenErrorLog}
      />
      <SettingsButton icon="archive-outline" label="Archive" onPress={onOpenArchive} />

      <View style={styles.settingsGroup}>
        <SettingToggleRow
          icon="camera-outline"
          label="Open on camera"
          value={settings.openOnCamera}
          onValueChange={(value) => onUpdateSetting('openOnCamera', value)}
        />
        <SettingToggleRow
          icon="scan-outline"
          label="Low resolution"
          value={settings.lowResolution}
          onValueChange={(value) => onUpdateSetting('lowResolution', value)}
        />
        <SettingToggleRow
          icon="image-outline"
          label="Save to gallery"
          value={settings.saveToGallery}
          onValueChange={(value) => onUpdateSetting('saveToGallery', value)}
        />
        <SettingToggleRow
          icon="musical-notes-outline"
          label="In-app sounds"
          value={settings.inAppSounds}
          onValueChange={(value) => onUpdateSetting('inAppSounds', value)}
        />
        <View style={styles.settingRow}>
          <View style={styles.settingLabelWrap}>
            <Ionicons name="sunny-outline" size={22} color={colors.nearBlack} />
            <Text style={styles.settingLabel}>Theme</Text>
          </View>
          <Pressable onPress={onOpenTheme}>
            <Text style={styles.settingValue}>
              {settings.theme === 'system' ? 'System default' : settings.theme === 'light' ? 'Light' : 'Dark'}
            </Text>
          </Pressable>
        </View>
        <SettingToggleRow
          icon="notifications-outline"
          label="Marketing notifications"
          value={settings.marketingNotifications}
          onValueChange={(value) => onUpdateSetting('marketingNotifications', value)}
        />
      </View>
      <SettingsButton icon="log-out-outline" label="Log out" onPress={onSignOut} />
      {role === 'Business_Admin' ? (
        <SettingsButton icon="trash-outline" label="Delete Exdox workspace" onPress={onDeleteAccount} />
      ) : null}
    </View>
  );
}

function SettingToggleRow({
  icon,
  label,
  value,
  onValueChange,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.settingRow}>
      <View style={styles.settingLabelWrap}>
        <Ionicons name={icon} size={22} color={colors.nearBlack} />
        <Text style={styles.settingLabel}>{label}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.softBlueGrey, true: colors.softBlueGrey }}
        thumbColor={colors.nearBlack}
      />
    </View>
  );
}

function SettingsButton({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.settingsLink} onPress={onPress}>
      <Ionicons name={icon} size={24} color={colors.nearBlack} />
      <Text style={styles.settingsLinkText}>{label}</Text>
    </Pressable>
  );
}

function BlankPanel({
  icon,
  title,
  copy,
  actionLabel,
  onAction,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  copy: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.blankState}>
      <EmptyOrbit icon={icon} />
      <Text style={styles.blankTitle}>{title}</Text>
      {copy ? <Text style={styles.blankCopy}>{copy}</Text> : null}
      {actionLabel ? (
        <Pressable style={styles.blankButton} onPress={onAction}>
          <Text style={styles.blankButtonText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const DocumentRow = memo(function DocumentRow({
  document,
  onPress,
  onStatusPress,
  onLongPress,
  compact = false,
}: {
  document: ExpenseDocument;
  onPress: () => void;
  onStatusPress?: () => void;
  onLongPress?: () => void;
  compact?: boolean;
}) {
  const hasPreviewImage = canPreviewDocumentInline(document);
  const previewUri = getPrimaryDocumentPreviewUri(document);
  const isDuplicateReceipt = extractionLooksLikeDuplicateUpload(document);
  const isProcessing = document.extractionStatus === 'pending' && !isDuplicateReceipt;
  const isUnreadableReceipt =
    document.extractionStatus !== 'pending' &&
    (document.extractionStatus === 'failed' || extractionLooksUnreadable(document));
  const extractionStatusText =
    isDuplicateReceipt
      ? duplicateReceiptStatusMessage
      : document.extractionStatus === 'pending'
        ? 'Reading receipt...'
      : isUnreadableReceipt
        ? 'Unable to read receipt, tap to enter manually or retry uploading receipt'
        : document.needsReview
          ? 'To be reviewed'
          : null;

  return (
    <Pressable
      style={[styles.documentRow, compact && styles.documentRowCompact]}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={240}
    >
      <View style={styles.documentLeft}>
        <DocumentThumbnail
          previewUri={previewUri}
          hasPreviewImage={hasPreviewImage}
          cloudReceiptId={document.cloudReceiptId}
          fileName={document.fileName}
        />
        <View style={styles.documentText}>
          <Text style={styles.documentTitle} numberOfLines={2} ellipsizeMode="tail">
            {document.title}
          </Text>
          <Text style={[styles.documentAmount, isProcessing && styles.documentAmountPending]}>
            {formatCurrency(document.amount, document.currency)}
          </Text>
          {extractionStatusText ? <Text style={styles.documentStatusText}>{extractionStatusText}</Text> : null}
        </View>
      </View>
      <View style={styles.documentRight}>
        <Text style={styles.documentDate}>{formatDate(document.date)}</Text>
        <StatusPill status={document.status} onPress={onStatusPress ?? onPress} />
      </View>
    </Pressable>
  );
}, (previousProps, nextProps) =>
  previousProps.compact === nextProps.compact &&
  previousProps.document.id === nextProps.document.id &&
  previousProps.document.title === nextProps.document.title &&
  previousProps.document.amount === nextProps.document.amount &&
  previousProps.document.date === nextProps.document.date &&
  previousProps.document.status === nextProps.document.status &&
  previousProps.document.extractionStatus === nextProps.document.extractionStatus &&
  previousProps.document.needsReview === nextProps.document.needsReview &&
  previousProps.document.notes === nextProps.document.notes &&
  previousProps.document.updatedAt === nextProps.document.updatedAt &&
  previousProps.document.fileUri === nextProps.document.fileUri &&
  previousProps.document.previewImageUri === nextProps.document.previewImageUri &&
  (previousProps.document.previewImageUris?.join('|') ?? '') ===
    (nextProps.document.previewImageUris?.join('|') ?? '') &&
  true,
);

function StatusPill({ status, onPress }: { status: ExpenseDocument['status']; onPress: () => void }) {
  const label = getStatusLabel(status);
  const tone =
    status === 'awaiting_review'
      ? styles.pillReview
      : status === 'ready_to_submit'
        ? styles.pillReady
        : status === 'submitted'
          ? styles.pillSubmitted
          : status === 'payment_processing'
            ? styles.pillSubmitted
          : styles.pillPaid;

  return (
    <Pressable style={[styles.statusPill, tone]} onPress={onPress}>
      <Text
        numberOfLines={1}
        style={[styles.statusPillText, status === 'awaiting_review' && styles.statusPillTextReview]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function BottomNav({
  activeTab,
  onSelect,
  onOpenCaptureActions,
}: {
  activeTab: MainTab;
  onSelect: (tab: MainTab) => void;
  onOpenCaptureActions: () => void;
}) {
  return (
    <View style={styles.bottomBar}>
      <BottomTabItem
        active={activeTab === 'costs'}
        label="Purchases"
        icon="bag-handle-outline"
        activeIcon="bag-handle"
        onPress={() => onSelect('costs')}
      />
      <BottomTabItem
        active={activeTab === 'sales'}
        label="Sales"
        icon="albums-outline"
        activeIcon="albums"
        onPress={() => onSelect('sales')}
      />
      <View style={styles.uploadNavSlot}>
        <Pressable style={styles.uploadNavButton} onPress={onOpenCaptureActions}>
          <Ionicons name="add" size={30} color={colors.white} />
        </Pressable>
        <Text style={styles.uploadNavLabel}>Upload</Text>
      </View>
      <BottomTabItem
        active={activeTab === 'claims'}
        label="Exp. claims"
        icon="receipt-outline"
        activeIcon="receipt"
        onPress={() => onSelect('claims')}
      />
      <BottomTabItem
        active={activeTab === 'reports'}
        label="Reports"
        icon="stats-chart-outline"
        activeIcon="stats-chart"
        onPress={() => onSelect('reports')}
      />
    </View>
  );
}

function BottomTabItem({
  active,
  label,
  icon,
  activeIcon,
  onPress,
}: {
  active: boolean;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.bottomItem} onPress={onPress}>
      <Ionicons name={active ? activeIcon : icon} size={23} color={active ? colors.nearBlack : colors.tabMuted} />
      <Text style={[styles.bottomLabel, active && styles.bottomLabelActive]}>{label}</Text>
    </Pressable>
  );
}

function DismissibleSheet({
  children,
  onClose,
  style,
  disabled = false,
}: {
  children: ReactNode;
  onClose: () => void;
  style: StyleProp<ViewStyle>;
  disabled?: boolean;
}) {
  const translateY = useRef(new Animated.Value(0)).current;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const resetPosition = () => {
    Animated.spring(translateY, {
      toValue: 0,
      stiffness: 320,
      damping: 30,
      mass: 0.8,
      useNativeDriver: true,
    }).start();
  };

  const finishDrag = (distance: number, velocity: number) => {
    if (disabled) {
      resetPosition();
      return;
    }
    if (distance > 90 || (distance > 24 && velocity > 0.8)) {
      Animated.timing(translateY, {
        toValue: Dimensions.get('window').height,
        duration: 180,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) {
          onCloseRef.current();
        }
        translateY.setValue(0);
      });
      return;
    }
    resetPosition();
  };

  const dragResponder = useMemo(
    () => PanResponder.create({
      onStartShouldSetPanResponder: () => !disabled,
      onStartShouldSetPanResponderCapture: () => !disabled,
      onMoveShouldSetPanResponder: (_event, gesture) =>
        !disabled && gesture.dy > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onMoveShouldSetPanResponderCapture: (_event, gesture) =>
        !disabled && gesture.dy > 2 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderGrant: () => {
        translateY.stopAnimation();
      },
      onPanResponderMove: (_event, gesture) => {
        translateY.setValue(Math.max(0, gesture.dy));
      },
      onPanResponderRelease: (_event, gesture) => finishDrag(gesture.dy, gesture.vy),
      onPanResponderTerminate: () => resetPosition(),
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
    }),
    [disabled, translateY],
  );

  return (
    <Animated.View style={[style, { transform: [{ translateY }] }]}>
      <View
        style={styles.sheetDragHandleTouchArea}
        {...dragResponder.panHandlers}
        accessible
        accessibilityRole="button"
        accessibilityLabel="Drag down to close"
        accessibilityHint="Swipe this handle down to close the panel"
        collapsable={false}
        hitSlop={{ top: 10, bottom: 10 }}
      >
        <View style={styles.documentSheetHandle} />
      </View>
      {children}
    </Animated.View>
  );
}

function MoreSheet({
  target,
  onClose,
  onOpenCamera,
  onUseGallery,
  onCreateMileageClaim,
  onAddToVault,
}: {
  target: MoreSheetTarget | null;
  onClose: () => void;
  onOpenCamera: () => void;
  onUseGallery: () => void;
  onCreateMileageClaim: () => void;
  onAddToVault: () => void;
}) {
  if (!target) {
    return null;
  }

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
        <View style={styles.sheetBackdrop}>
        <Pressable style={styles.sheetOverlay} onPress={onClose} />
        <DismissibleSheet style={styles.captureActionSheet} onClose={onClose}>
            <Pressable style={styles.captureActionRow} onPress={onCreateMileageClaim}>
              <Ionicons name="car-outline" size={28} color={colors.nearBlack} />
              <Text style={styles.captureActionText}>Create mileage claim</Text>
            </Pressable>
            <Pressable style={styles.captureActionRow} onPress={onAddToVault}>
              <Ionicons name="wallet-outline" size={28} color={colors.nearBlack} />
              <Text style={styles.captureActionText}>Add to Vault</Text>
            </Pressable>
            <Pressable style={styles.captureActionButton} onPress={onOpenCamera}>
              <Ionicons name="camera-outline" size={22} color={colors.white} />
              <Text style={styles.captureActionButtonText}>Scan receipt or invoice</Text>
            </Pressable>
            <Pressable style={styles.captureActionGhost} onPress={onUseGallery}>
              <Ionicons name="image-outline" size={20} color={colors.royalBlueDark} />
              <Text style={styles.captureActionGhostText}>Choose from gallery</Text>
            </Pressable>
        </DismissibleSheet>
      </View>
    </Modal>
  );
}

function VaultUploadProgress({
  visible,
  progress,
  status,
}: {
  visible: boolean;
  progress: number;
  status: string;
}) {
  if (!visible) {
    return null;
  }

  return (
    <Modal transparent animationType="fade" visible statusBarTranslucent>
      <View style={styles.vaultUploadBackdrop}>
        <View
          style={styles.vaultUploadCard}
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: progress }}
        >
          <View style={styles.vaultUploadIcon}>
            <Ionicons name="shield-checkmark-outline" size={30} color={colors.white} />
          </View>
          <Text style={styles.vaultUploadTitle}>Saving to Vault</Text>
          <Text style={styles.vaultUploadStatus}>{status}</Text>
          <View style={styles.vaultUploadTrack}>
            <View style={[styles.vaultUploadFill, { width: `${progress}%` }]} />
          </View>
          <Text style={styles.vaultUploadPercent}>{`${Math.round(progress)}%`}</Text>
        </View>
      </View>
    </Modal>
  );
}

function MileageSubmissionProgress({
  visible,
  progress,
  status,
}: MileageSubmissionState) {
  if (!visible) {
    return null;
  }

  return (
    <Modal transparent animationType="fade" visible onRequestClose={() => undefined}>
      <View style={styles.vaultUploadBackdrop}>
        <View
          style={styles.vaultUploadCard}
          accessibilityRole="progressbar"
          accessibilityLabel="Submitting mileage claim"
          accessibilityValue={{ min: 0, max: 100, now: progress }}
        >
          <View style={styles.vaultUploadIcon}>
            <Ionicons name="car-outline" size={30} color={colors.white} />
          </View>
          <Text style={styles.vaultUploadTitle}>Submitting mileage claim</Text>
          <Text style={styles.vaultUploadStatus}>{status}</Text>
          <View style={styles.vaultUploadTrack}>
            <View style={[styles.vaultUploadFill, { width: `${progress}%` }]} />
          </View>
          <Text style={styles.vaultUploadPercent}>{`${Math.round(progress)}%`}</Text>
        </View>
      </View>
    </Modal>
  );
}

function NotificationsSheet({
  visible,
  notifications,
  onClose,
  onOpenDocument,
}: {
  visible: boolean;
  notifications: Array<{ id: string; title: string; message: string; createdAt: string }>;
  onClose: () => void;
  onOpenDocument: (documentId: string) => void;
}) {
  if (!visible) {
    return null;
  }

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <Pressable style={styles.sheetOverlay} onPress={onClose} />
        <DismissibleSheet style={styles.panelSheet} onClose={onClose}>
          <Text style={styles.panelTitle}>Processing alerts</Text>
          <ScrollView contentContainerStyle={styles.panelContent}>
            {!notifications.length ? (
              <Text style={styles.panelMuted}>No document alerts right now.</Text>
            ) : (
              notifications.map((notification) => (
                <Pressable
                  key={notification.id}
                  style={styles.panelListRow}
                  onPress={() => onOpenDocument(notification.id)}
                >
                  <View style={styles.panelListRowMain}>
                    <Text style={styles.panelListTitle}>{notification.title}</Text>
                    <Text style={styles.panelListMeta}>{notification.message}</Text>
                  </View>
                  <Text style={styles.panelListTime}>{formatDate(notification.createdAt)}</Text>
                </Pressable>
              ))
            )}
          </ScrollView>
        </DismissibleSheet>
      </View>
    </Modal>
  );
}

function FilterSheet({
  visible,
  statusFilter,
  sortMode,
  onClose,
  onSelectStatus,
  onSelectSort,
}: {
  visible: boolean;
  statusFilter: StatusFilter;
  sortMode: SortMode;
  onClose: () => void;
  onSelectStatus: (value: StatusFilter) => void;
  onSelectSort: (value: SortMode) => void;
}) {
  if (!visible) {
    return null;
  }

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <Pressable style={styles.sheetOverlay} onPress={onClose} />
        <DismissibleSheet style={styles.panelSheet} onClose={onClose}>
          <Text style={styles.panelTitle}>Sort and filter</Text>
          <ScrollView
            style={styles.filterSheetScroll}
            contentContainerStyle={styles.filterSheetContent}
            nestedScrollEnabled
            showsVerticalScrollIndicator
          >
            <Text style={styles.panelSectionTitle}>Status</Text>
            {statusFilterOptions.map((option) => (
              <Pressable key={option.value} style={styles.panelOptionRow} onPress={() => onSelectStatus(option.value)}>
                <Text style={styles.panelOptionText}>{option.label}</Text>
                {statusFilter === option.value ? <Ionicons name="checkmark" size={20} color={colors.nearBlack} /> : null}
              </Pressable>
            ))}
            <Text style={styles.panelSectionTitle}>Sort</Text>
            {sortOptions.map((option) => (
              <Pressable key={option.value} style={styles.panelOptionRow} onPress={() => onSelectSort(option.value)}>
                <Text style={styles.panelOptionText}>{option.label}</Text>
                {sortMode === option.value ? <Ionicons name="checkmark" size={20} color={colors.nearBlack} /> : null}
              </Pressable>
            ))}
          </ScrollView>
        </DismissibleSheet>
      </View>
    </Modal>
  );
}

function ClaimComposerSheet({
  visible,
  submitting,
  title,
  startDate,
  endDate,
  claimableDocuments,
  selectedDocumentIds,
  onClose,
  onChangeTitle,
  onChangeStartDate,
  onChangeEndDate,
  onToggleDocument,
  onSubmit,
}: {
  visible: boolean;
  submitting: boolean;
  title: string;
  startDate: string;
  endDate: string;
  claimableDocuments: ExpenseDocument[];
  selectedDocumentIds: string[];
  onClose: () => void;
  onChangeTitle: (value: string) => void;
  onChangeStartDate: (value: string) => void;
  onChangeEndDate: (value: string) => void;
  onToggleDocument: (documentId: string) => void;
  onSubmit: () => void;
}) {
  if (!visible) {
    return null;
  }

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <Pressable style={styles.sheetOverlay} onPress={onClose} />
        <DismissibleSheet style={styles.panelSheet} onClose={onClose} disabled={submitting}>
          <Text style={styles.panelTitle}>Create claim</Text>
          <Text style={styles.claimComposerCopy}>Choose the personal purchases to reimburse, then send one claim to your employer for review.</Text>
          <ScrollView style={styles.claimComposerScroll} contentContainerStyle={styles.claimComposerContent} keyboardShouldPersistTaps="handled">
            <TextInput value={title} onChangeText={onChangeTitle} placeholder="Claim title" style={styles.panelInput} editable={!submitting} />
            <TextInput value={startDate} onChangeText={onChangeStartDate} placeholder="Start date" style={styles.panelInput} editable={!submitting} />
            <TextInput value={endDate} onChangeText={onChangeEndDate} placeholder="End date" style={styles.panelInput} editable={!submitting} />
            <View style={styles.claimComposerSelectionHeader}>
              <Text style={styles.panelSectionTitle}>Purchases to claim</Text>
              <Text style={styles.claimComposerCount}>{selectedDocumentIds.length} selected</Text>
            </View>
            {claimableDocuments.length ? claimableDocuments.map((document) => {
              const selected = selectedDocumentIds.includes(document.id);
              return (
                <Pressable
                  key={document.id}
                  style={[styles.claimComposerDocumentRow, selected && styles.claimComposerDocumentRowSelected]}
                  onPress={() => onToggleDocument(document.id)}
                  disabled={submitting}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: selected, disabled: submitting }}
                  accessibilityLabel={`Include ${document.title || document.supplier} in this claim`}
                >
                  <View style={[styles.claimComposerCheckbox, selected && styles.claimComposerCheckboxSelected]}>
                    {selected ? <Ionicons name="checkmark" size={16} color={colors.white} /> : null}
                  </View>
                  <View style={styles.claimComposerDocumentCopy}>
                    <Text style={styles.claimComposerDocumentTitle} numberOfLines={1}>{document.title || document.supplier}</Text>
                    <Text style={styles.claimComposerDocumentDate}>{formatDate(document.date)}</Text>
                  </View>
                  <Text style={styles.claimComposerDocumentAmount}>{formatCurrency(document.amount, document.currency)}</Text>
                </Pressable>
              );
            }) : (
              <Text style={styles.claimComposerEmpty}>No personal-spend purchases are ready to claim yet. Upload or review a purchase with Personal / cash payment first.</Text>
            )}
          </ScrollView>
          <Pressable style={[styles.panelPrimaryButton, (submitting || !selectedDocumentIds.length) && styles.panelPrimaryButtonDisabled]} onPress={onSubmit} disabled={submitting || !selectedDocumentIds.length}>
            <Text style={styles.panelPrimaryButtonText}>{submitting ? 'Creating claim…' : 'Create & request approval'}</Text>
          </Pressable>
        </DismissibleSheet>
      </View>
    </Modal>
  );
}

function MileageClaimSheet({
  visible,
  startPostcode,
  endPostcode,
  totalMiles,
  mileageRate,
  proofNames,
  submitting,
  onClose,
  onChangeStartPostcode,
  onChangeEndPostcode,
  onChangeTotalMiles,
  onChangeMileageRate,
  onAddProof,
  onSubmit,
}: {
  visible: boolean;
  startPostcode: string;
  endPostcode: string;
  totalMiles: string;
  mileageRate: string;
  proofNames: string[];
  submitting: boolean;
  onClose: () => void;
  onChangeStartPostcode: (value: string) => void;
  onChangeEndPostcode: (value: string) => void;
  onChangeTotalMiles: (value: string) => void;
  onChangeMileageRate: (value: string) => void;
  onAddProof: () => void;
  onSubmit: () => void;
}) {
  if (!visible) {
    return null;
  }

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.sheetBackdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'android' ? 24 : 0}
      >
        <Pressable style={styles.sheetOverlay} onPress={onClose} disabled={submitting} />
        <DismissibleSheet style={styles.panelSheet} onClose={onClose} disabled={submitting}>
          <ScrollView
            style={styles.filterSheetScroll}
            contentContainerStyle={styles.panelSheetScrollContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
          >
            <Text style={styles.panelTitle}>Create mileage claim</Text>
          <TextInput value={startPostcode} onChangeText={onChangeStartPostcode} placeholder="Start postcode" style={styles.panelInput} editable={!submitting} />
          <TextInput value={endPostcode} onChangeText={onChangeEndPostcode} placeholder="End postcode" style={styles.panelInput} editable={!submitting} />
          <TextInput value={totalMiles} onChangeText={onChangeTotalMiles} placeholder="Total miles" keyboardType="decimal-pad" style={styles.panelInput} editable={!submitting} />
          <TextInput value={mileageRate} onChangeText={onChangeMileageRate} placeholder="Rate per mile" keyboardType="decimal-pad" style={styles.panelInput} editable={!submitting} />
          <Pressable style={[styles.claimAttachButton, submitting && styles.panelPrimaryButtonDisabled]} onPress={onAddProof} disabled={submitting}>
            <Text style={styles.claimAttachButtonText}>{proofNames.length ? `Journey proof images (${proofNames.length}/5)` : 'Add journey proof images (up to 5)'}</Text>
          </Pressable>
          {proofNames.map((proofName, index) => <Text key={`${proofName}-${index}`} style={styles.claimSectionCopy}>{`${index + 1}. ${proofName}`}</Text>)}
          <Text style={styles.claimSectionCopy}>Your requested rate is sent with the claim for your business admin to approve.</Text>
          <Pressable style={[styles.panelPrimaryButton, submitting && styles.panelPrimaryButtonDisabled]} onPress={onSubmit} disabled={submitting}>
            <Text style={styles.panelPrimaryButtonText}>{submitting ? 'Submitting mileage claim…' : 'Create mileage claim'}</Text>
          </Pressable>
          </ScrollView>
        </DismissibleSheet>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ThemeSheet({
  visible,
  value,
  onClose,
  onSelect,
}: {
  visible: boolean;
  value: ThemeOption;
  onClose: () => void;
  onSelect: (theme: ThemeOption) => void;
}) {
  if (!visible) {
    return null;
  }

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <Pressable style={styles.sheetOverlay} onPress={onClose} />
        <DismissibleSheet style={styles.panelSheet} onClose={onClose}>
          <Text style={styles.panelTitle}>Theme</Text>
          {themeOptions.map((option) => (
            <Pressable key={option.value} style={styles.panelOptionRow} onPress={() => onSelect(option.value)}>
              <Text style={styles.panelOptionText}>{option.label}</Text>
              {value === option.value ? <Ionicons name="checkmark" size={20} color={colors.nearBlack} /> : null}
            </Pressable>
          ))}
        </DismissibleSheet>
      </View>
    </Modal>
  );
}

function SettingsPanelSheet({
  visible,
  target,
  role,
  inboundEmailAddress,
  analyticsSummary,
  vatTrackingEnabled,
  vehicles,
  vehicleNameInput,
  vehicleRegistrationInput,
  editingVehicleId,
  onClose,
  onOpenArchive,
  onExport,
  onChangeVehicleName,
  onChangeVehicleRegistration,
  onSaveVehicle,
  onEditVehicle,
  onDeleteVehicle,
}: {
  visible: boolean;
  target: SettingsPanelTarget | null;
  role: 'Business_Admin' | 'Standard_Employee';
  inboundEmailAddress: string;
  analyticsSummary: { total: number; vatTotal: number; reviewCount: number; submittedCount: number };
  vatTrackingEnabled: boolean;
  vehicles: Vehicle[];
  vehicleNameInput: string;
  vehicleRegistrationInput: string;
  editingVehicleId: string | null;
  onClose: () => void;
  onOpenArchive: (target: ArchiveTarget) => void;
  onExport: () => void;
  onChangeVehicleName: (value: string) => void;
  onChangeVehicleRegistration: (value: string) => void;
  onSaveVehicle: () => void;
  onEditVehicle: (vehicle: Vehicle) => void;
  onDeleteVehicle: (vehicleId: string) => void;
}) {
  if (!visible || !target) {
    return null;
  }

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <Pressable style={styles.sheetOverlay} onPress={onClose} />
        <DismissibleSheet style={styles.panelSheet} onClose={onClose}>
          {target === 'business_admin' ? (
            <>
              <Text style={styles.panelTitle}>Business admin</Text>
              <Text style={styles.panelMuted}>
                {role === 'Business_Admin'
                  ? 'Admin access is active on this workspace.'
                  : 'This workspace is signed in without business admin permissions.'}
              </Text>
              <Text style={styles.panelMuted}>
                Workspace VAT settings are managed by a business administrator on the Exdox website.
              </Text>
            </>
          ) : null}
          {target === 'archive' ? (
            <>
              <Text style={styles.panelTitle}>Archive</Text>
              <Text style={styles.panelMuted}>Choose the document history you want to view.</Text>
              <Pressable style={styles.panelOptionRow} onPress={() => onOpenArchive('cost')}>
                <Text style={styles.panelOptionText}>Purchases archive</Text>
                <Ionicons name="chevron-forward" size={20} color={colors.mutedText} />
              </Pressable>
              <Pressable style={styles.panelOptionRow} onPress={() => onOpenArchive('sales')}>
                <Text style={styles.panelOptionText}>Sales archive</Text>
                <Ionicons name="chevron-forward" size={20} color={colors.mutedText} />
              </Pressable>
            </>
          ) : null}
          {target === 'logins' ? (
            <>
              <Text style={styles.panelTitle}>Logins</Text>
              <Text style={styles.panelMuted}>This device is signed in and using the current secure session.</Text>
            </>
          ) : null}
          {target === 'extract_email' ? (
            <>
              <Text style={styles.panelTitle}>Extract by email</Text>
              <Text style={styles.panelMuted}>{inboundEmailAddress}</Text>
            </>
          ) : null}
          {target === 'analytics' ? (
            <>
              <Text style={styles.panelTitle}>Analytics</Text>
              <View style={styles.analyticsGrid}>
                <View style={styles.analyticsCard}>
                  <Text style={styles.analyticsValue}>{formatCurrency(analyticsSummary.total)}</Text>
                  <Text style={styles.analyticsLabel}>Visible total</Text>
                </View>
                <View style={styles.analyticsCard}>
                  <Text style={styles.analyticsValue}>{formatCurrency(analyticsSummary.vatTotal)}</Text>
                  <Text style={styles.analyticsLabel}>{vatTrackingEnabled ? 'Visible VAT' : 'VAT hidden'}</Text>
                </View>
                <View style={styles.analyticsCard}>
                  <Text style={styles.analyticsValue}>{analyticsSummary.reviewCount}</Text>
                  <Text style={styles.analyticsLabel}>To review</Text>
                </View>
                <View style={styles.analyticsCard}>
                  <Text style={styles.analyticsValue}>{analyticsSummary.submittedCount}</Text>
                  <Text style={styles.analyticsLabel}>Submitted</Text>
                </View>
              </View>
            </>
          ) : null}
          {target === 'team_exports' ? (
            <>
              <Text style={styles.panelTitle}>Team exports</Text>
              <Text style={styles.panelMuted}>Share a CSV-style export of the current workspace data.</Text>
              <Pressable style={styles.panelPrimaryButton} onPress={onExport}>
                <Text style={styles.panelPrimaryButtonText}>Export summary</Text>
              </Pressable>
            </>
          ) : null}
          {target === 'vault' ? (
            <>
              <Text style={styles.panelTitle}>Vault</Text>
              <Text style={styles.panelMuted}>Vault items are read with OCR and stored securely for future reference.</Text>
            </>
          ) : null}
          {target === 'team_admin' ? (
            <>
              <Text style={styles.panelTitle}>Team admin</Text>
              <Text style={styles.panelMuted}>Open your team management tools from this workspace area.</Text>
            </>
          ) : null}
          {target === 'vehicles' ? (
            <>
              <Text style={styles.panelTitle}>Vehicles</Text>
              <TextInput value={vehicleNameInput} onChangeText={onChangeVehicleName} placeholder="Vehicle name" style={styles.panelInput} />
              <TextInput value={vehicleRegistrationInput} onChangeText={onChangeVehicleRegistration} placeholder="Registration" autoCapitalize="characters" style={styles.panelInput} />
              <Pressable style={styles.panelPrimaryButton} onPress={onSaveVehicle}>
                <Text style={styles.panelPrimaryButtonText}>{editingVehicleId ? 'Save vehicle' : 'Add vehicle'}</Text>
              </Pressable>
              <ScrollView contentContainerStyle={styles.panelContent}>
                {!vehicles.length ? (
                  <Text style={styles.panelMuted}>No vehicles added yet.</Text>
                ) : (
                  vehicles.map((vehicle) => (
                    <View key={vehicle.id} style={styles.panelListRow}>
                      <View style={styles.panelListRowMain}>
                        <Text style={styles.panelListTitle}>{vehicle.name}</Text>
                        <Text style={styles.panelListMeta}>{vehicle.registration}</Text>
                      </View>
                      <View style={styles.panelInlineActions}>
                        <Pressable onPress={() => onEditVehicle(vehicle)}>
                          <Text style={styles.panelInlineActionText}>Edit</Text>
                        </Pressable>
                        <Pressable onPress={() => onDeleteVehicle(vehicle.id)}>
                          <Text style={styles.panelInlineActionText}>Delete</Text>
                        </Pressable>
                      </View>
                    </View>
                  ))
                )}
              </ScrollView>
            </>
          ) : null}
        </DismissibleSheet>
      </View>
    </Modal>
  );
}

function ErrorLogSheet({
  visible,
  logs,
  onClose,
  onClear,
}: {
  visible: boolean;
  logs: AppErrorLog[];
  onClose: () => void;
  onClear: () => Promise<void>;
}) {
  if (!visible) {
    return null;
  }

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <Pressable style={styles.sheetOverlay} onPress={onClose} />
        <DismissibleSheet style={styles.errorSheet} onClose={onClose}>
          <View style={styles.errorSheetHeader}>
            <Text style={styles.errorSheetTitle}>Error log</Text>
            <Pressable style={styles.errorSheetClear} onPress={() => void onClear()}>
              <Text style={styles.errorSheetClearText}>Clear</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.errorSheetScroll} contentContainerStyle={styles.errorSheetContent}>
            {!logs.length ? (
              <Text style={styles.errorEmptyText}>No errors recorded yet.</Text>
            ) : (
              logs.map((entry) => (
                <View key={entry.id} style={styles.errorEntry}>
                  <View style={styles.errorEntryHeader}>
                    <Text style={styles.errorEntrySource}>{entry.source}</Text>
                    <Text style={styles.errorEntryTime}>{formatDateTime(entry.createdAt)}</Text>
                  </View>
                  <Text style={styles.errorEntryMessage}>{entry.message}</Text>
                  <Text style={styles.errorEntryMeta}>{entry.isFatal ? 'Fatal' : 'Non-fatal'}</Text>
                  {entry.stack ? <Text style={styles.errorEntryStack}>{entry.stack}</Text> : null}
                </View>
              ))
            )}
          </ScrollView>
        </DismissibleSheet>
      </View>
    </Modal>
  );
}

function CaptureReviewScreen({
  document,
  ownerName,
  onClose,
  onSubmit,
}: {
  document: ExpenseDocument | null;
  ownerName: string;
  onClose: () => void;
  onSubmit: (
    reviewFields: Pick<ExpenseDocument, 'category' | 'description' | 'customer' | 'amount' | 'netAmount' | 'vatAmount' | 'taxAmount' | 'taxRateApplied'> &
      Partial<Pick<ExpenseDocument, 'paymentMethod'>>,
  ) => Promise<void>;
}) {
  const [selectedCategory, setSelectedCategory] = useState('');
  const [descriptionInput, setDescriptionInput] = useState('');
  const [customerInput, setCustomerInput] = useState('');
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<PaymentMethod>('cash_personal');
  const [paymentMethodOverridden, setPaymentMethodOverridden] = useState(false);
  const [categoryPickerVisible, setCategoryPickerVisible] = useState(false);
  const [categorySearchInput, setCategorySearchInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!document) {
      return;
    }

    setSelectedCategory(document.category ?? '');
    setDescriptionInput(document.description ?? '');
    setCustomerInput(document.customer ?? '');
    setSelectedPaymentMethod(document.paymentMethod || 'cash_personal');
    setPaymentMethodOverridden(false);
    setCategoryPickerVisible(false);
    setCategorySearchInput('');
    setSubmitting(false);
  }, [document?.id]);

  useEffect(() => {
    if (!document || paymentMethodOverridden) {
      return;
    }

    // OCR may finish after this screen opens. Keep the untouched choice aligned
    // with the server classification, while preserving an explicit user choice.
    setSelectedPaymentMethod(document.paymentMethod || 'cash_personal');
  }, [document?.paymentMethod, paymentMethodOverridden]);

  if (!document) {
    return null;
  }

  const categoryOptions = getCategoryOptions(document.workspaceContext);
  const filteredCategoryOptions = categoryOptions.filter((option) =>
    option.toLowerCase().includes(categorySearchInput.trim().toLowerCase()),
  );

  return (
    <>
      <Modal
        visible
        transparent={false}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={onClose}
      >
        <SafeAreaView style={styles.captureReviewScreen}>
          <View style={styles.captureReviewHeader}>
            <Pressable onPress={onClose} style={styles.captureReviewHeaderButton}>
              <Ionicons name="chevron-back" size={24} color={colors.nearBlack} />
            </Pressable>
            <Text style={styles.captureReviewHeaderTitle}>Review</Text>
            <Pressable onPress={onClose} style={styles.captureReviewHeaderButton}>
              <Ionicons name="ellipsis-vertical" size={20} color={colors.nearBlack} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.captureReviewScroll}
            contentContainerStyle={styles.captureReviewScrollContent}
            showsVerticalScrollIndicator={false}
          >
            <Pressable style={styles.captureReviewFieldButton} onPress={() => setCategoryPickerVisible(true)}>
              <Text style={styles.captureReviewFieldValue}>{selectedCategory || 'Category'}</Text>
            </Pressable>
            <View style={styles.captureReviewFieldRow}>
              <Text style={styles.captureReviewFieldLabel}>Owned by</Text>
              <Text style={styles.captureReviewFieldValueRight}>{ownerName}</Text>
            </View>
            <View style={styles.captureReviewTextField}>
              <TextInput
                value={descriptionInput}
                onChangeText={setDescriptionInput}
                placeholder="Write your description here"
                placeholderTextColor={colors.slate}
                multiline
                style={styles.captureReviewTextInput}
              />
            </View>
            {document.workspaceContext === 'cost' ? (
              <View style={styles.captureReviewPaymentMethod}>
                <Text style={styles.captureReviewPaymentMethodLabel}>Payment method</Text>
                <View style={styles.captureReviewPaymentMethodOptions}>
                  {([
                    ['cash_personal', 'Personal'],
                    ['business_card', 'Company card'],
                  ] as Array<[PaymentMethod, string]>).map(([method, label]) => (
                    <Pressable
                      key={method}
                      style={[
                        styles.captureReviewPaymentMethodOption,
                        method === selectedPaymentMethod && styles.captureReviewPaymentMethodOptionActive,
                      ]}
                      onPress={() => {
                        setSelectedPaymentMethod(method);
                        setPaymentMethodOverridden(true);
                      }}
                    >
                      <Text
                        style={[
                          styles.captureReviewPaymentMethodOptionText,
                          method === selectedPaymentMethod && styles.captureReviewPaymentMethodOptionTextActive,
                        ]}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}
            <Text style={styles.captureReviewSectionHeading}>More</Text>
            <View style={styles.captureReviewTextField}>
              <Text style={styles.captureReviewFieldValue}>Customer</Text>
              <TextInput
                value={customerInput}
                onChangeText={setCustomerInput}
                placeholder=""
                placeholderTextColor={colors.slate}
                style={styles.captureReviewSingleLineInput}
              />
            </View>
          </ScrollView>

          <View style={styles.captureReviewFooter}>
            <Pressable
              style={[styles.captureReviewSubmitButton, submitting && styles.captureReviewSubmitButtonDisabled]}
              disabled={submitting}
              onPress={async () => {
                setSubmitting(true);
                try {
                  await onSubmit({
                    category: selectedCategory || document.category,
                    description: descriptionInput.trim(),
                    customer: customerInput.trim(),
                    amount: document.amount,
                    netAmount: document.netAmount,
                    vatAmount: document.vatAmount,
                    taxAmount: document.taxAmount,
                    taxRateApplied: document.taxRateApplied,
                    ...(paymentMethodOverridden ? { paymentMethod: selectedPaymentMethod } : {}),
                  });
                } finally {
                  setSubmitting(false);
                }
              }}
            >
              <Text style={styles.captureReviewSubmitButtonText}>{submitting ? 'Saving...' : 'Submit'}</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      </Modal>

      <Modal transparent animationType="slide" visible={categoryPickerVisible} onRequestClose={() => setCategoryPickerVisible(false)}>
        <View style={styles.sheetBackdrop}>
          <Pressable style={styles.sheetOverlay} onPress={() => setCategoryPickerVisible(false)} />
          <DismissibleSheet style={styles.categoryPickerSheet} onClose={() => setCategoryPickerVisible(false)}>
            <View style={styles.categoryPickerHeader}>
              <TextInput
                value={categorySearchInput}
                onChangeText={setCategorySearchInput}
                placeholder="Search"
                placeholderTextColor={colors.slate}
                style={styles.categoryPickerSearchInput}
              />
              <Pressable onPress={() => setCategoryPickerVisible(false)} style={styles.categoryPickerCloseButton}>
                <Ionicons name="close" size={28} color={colors.nearBlack} />
              </Pressable>
            </View>
            <ScrollView style={styles.categoryPickerList} keyboardShouldPersistTaps="handled">
              {filteredCategoryOptions.map((option) => (
                <Pressable
                  key={option}
                  style={styles.categoryPickerOption}
                  onPress={() => {
                    setSelectedCategory(option);
                    setCategoryPickerVisible(false);
                  }}
                >
                  <Text style={styles.categoryPickerOptionText}>{option}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </DismissibleSheet>
        </View>
      </Modal>
    </>
  );
}

function DocumentSheet({
  document,
  isAdmin,
  ownerName,
  vatTrackingEnabled,
  onClose,
  onMarkReviewed,
  onAddToClaim,
  onUpdateReviewFields,
  onMarkSubmitted,
  onDelete,
  canDelete,
}: {
  document: ExpenseDocument | null;
  isAdmin: boolean;
  ownerName: string;
  vatTrackingEnabled: boolean;
  onClose: () => void;
  onMarkReviewed: () => void;
  onAddToClaim: () => void;
  onUpdateReviewFields: (
    reviewFields: Pick<
      ExpenseDocument,
      'amount' | 'netAmount' | 'vatAmount' | 'taxAmount' | 'currency' | 'taxRateApplied' | 'category' | 'description' | 'customer' | 'paymentMethod'
    >,
  ) => Promise<void>;
  onMarkSubmitted: () => void;
  onDelete: () => void;
  canDelete: boolean;
}) {
  const [totalInput, setTotalInput] = useState('0.00');
  const [netInput, setNetInput] = useState('0.00');
  const [vatInput, setVatInput] = useState('0.00');
  const [selectedCurrency, setSelectedCurrency] = useState('GBP');
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<PaymentMethod>('cash_personal');
  const [selectedTaxRate, setSelectedTaxRate] = useState<UkTaxRate>('No VAT');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [descriptionInput, setDescriptionInput] = useState('');
  const [customerInput, setCustomerInput] = useState('');
  const [taxDropdownOpen, setTaxDropdownOpen] = useState(false);
  const [categoryPickerVisible, setCategoryPickerVisible] = useState(false);
  const [categorySearchInput, setCategorySearchInput] = useState('');
  const [previewVisible, setPreviewVisible] = useState(false);
  const [savingValues, setSavingValues] = useState(false);
  const [savingValuesProgress, setSavingValuesProgress] = useState(0);

  useEffect(() => {
    if (!document) {
      return;
    }
    setTotalInput(formatMoneyInput(document.amount));
    setNetInput(formatMoneyInput(document.netAmount ?? document.amount));
    setVatInput(formatMoneyInput(document.vatAmount ?? document.taxAmount));
    setSelectedCurrency(document.currency || 'GBP');
    setSelectedPaymentMethod(document.paymentMethod || 'cash_personal');
    setSelectedTaxRate(document.taxRateApplied ?? 'No VAT');
    setSelectedCategory(document.category ?? '');
    setDescriptionInput(document.description ?? '');
    setCustomerInput(document.customer ?? '');
    setTaxDropdownOpen(false);
    setCategoryPickerVisible(false);
    setCategorySearchInput('');
    setPreviewVisible(false);
  }, [document?.id]);

  if (!document) {
    return null;
  }

  const previewUris = getDocumentPreviewUris(document);
  const hasPreviewImage = previewUris.length > 0;
  const categoryOptions = getCategoryOptions(document.workspaceContext);
  const filteredCategoryOptions = categoryOptions.filter((option) =>
    option.toLowerCase().includes(categorySearchInput.trim().toLowerCase()),
  );
  const effectiveTaxRate = vatTrackingEnabled ? selectedTaxRate : 'No VAT';
  const foreignCurrencyDocument = document.currency.toUpperCase() !== 'GBP';
  const reimbursementArchived = isReimbursementArchiveDocument(document);
  const extractionStatusText =
    document.extractionStatus === 'pending'
      ? 'Reading this receipt now.'
      : document.extractionStatus === 'failed'
        ? 'Unable to read receipt, tap to enter manually or retry uploading receipt'
        : document.needsReview
          ? 'Extraction finished. Review the details before submitting.'
          : 'Extraction finished.';
  const documentStatusText = reimbursementArchived
    ? document.status === 'paid'
      ? 'This expense has been paid and is retained here for your records.'
      : 'This expense is with your employer\'s payment team and payment is being processed.'
    : extractionStatusText;
  const documentReference = document.invoiceNumber?.trim() || document.fileName || 'Not available';
  const submittedByName = document.uploadedByEmail?.trim() || ownerName;
  const lineItemCount = document.lineItems?.length ?? 0;

  return (
    <>
      <Modal transparent animationType="slide" visible onRequestClose={onClose}>
        <View style={styles.sheetBackdrop}>
          <Pressable style={styles.sheetOverlay} onPress={onClose} />
          <DismissibleSheet style={styles.documentSheet} onClose={onClose}>
            <ScrollView
              style={styles.documentSheetScroll}
              contentContainerStyle={styles.documentSheetScrollContent}
              showsVerticalScrollIndicator={false}
            >
              {hasPreviewImage ? (
                <View style={styles.documentSheetPreviewPanel}>
                  <DocumentPreviewCarousel previewUris={previewUris} />
                  <View style={styles.documentSheetPreviewActions}>
                    <Text style={styles.documentSheetPreviewHint}>
                      {previewUris.length > 1 ? `Swipe to view ${previewUris.length} images` : 'Preview image'}
                    </Text>
                    <Pressable
                      style={styles.documentSheetPreviewLink}
                      onPress={() => {
                        InteractionManager.runAfterInteractions(() => {
                          setPreviewVisible(true);
                        });
                      }}
                    >
                      <Text style={styles.documentSheetPreviewLinkText}>
                        {previewUris.length > 1 ? 'Open full screen' : 'Tap to open full screen'}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
          <Text style={styles.documentSheetTitle}>{document.title}</Text>
          <Text style={styles.documentSheetMeta}>{document.supplier}</Text>
          <Text style={styles.documentSheetAmount}>{formatCurrency(document.amount, document.currency)}</Text>
          {document.baseAmount != null && document.currency !== document.baseCurrency ? (
            <Text style={styles.documentSheetMeta}>
              {formatCurrency(document.baseAmount, document.baseCurrency)} at the recorded exchange rate
            </Text>
          ) : null}
          <Text style={styles.documentSheetStatus}>{documentStatusText}</Text>
          {reimbursementArchived ? (
            <View style={styles.archivedDocumentDetails}>
              <Text style={styles.archivedDocumentDetailsHeading}>Item details</Text>
              <View style={styles.reviewFieldRow}>
                <Text style={styles.reviewFieldLabel}>Category</Text>
                <Text style={styles.reviewFieldValue}>{document.category || 'Uncategorised'}</Text>
              </View>
              <View style={styles.reviewFieldRow}>
                <Text style={styles.reviewFieldLabel}>Type</Text>
                <Text style={styles.reviewFieldValue}>{document.type === 'invoice' ? 'Invoice' : 'Receipt'}</Text>
              </View>
              <View style={styles.reviewFieldRow}>
                <Text style={styles.reviewFieldLabel}>Owned by</Text>
                <Text style={styles.reviewFieldValue}>{ownerName}</Text>
              </View>
              <View style={styles.reviewFieldRow}>
                <Text style={styles.reviewFieldLabel}>Submitted by</Text>
                <Text style={styles.reviewFieldValue}>{submittedByName}</Text>
              </View>
              <View style={styles.reviewFieldRow}>
                <Text style={styles.reviewFieldLabel}>Date</Text>
                <Text style={styles.reviewFieldValue}>{formatDate(document.date)}</Text>
              </View>
              <View style={styles.reviewFieldRow}>
                <Text style={styles.reviewFieldLabel}>Document reference</Text>
                <Text style={styles.reviewFieldValue} numberOfLines={1}>{documentReference}</Text>
              </View>
              <View style={styles.reviewFieldRow}>
                <Text style={styles.reviewFieldLabel}>Supplier</Text>
                <Text style={styles.reviewFieldValue}>{document.supplier || 'Not available'}</Text>
              </View>
              <View style={styles.reviewFieldRow}>
                <Text style={styles.reviewFieldLabel}>Currency</Text>
                <Text style={styles.reviewFieldValue}>{document.currency || document.baseCurrency || 'GBP'}</Text>
              </View>
              <View style={styles.reviewFieldRow}>
                <Text style={styles.reviewFieldLabel}>Total amount</Text>
                <Text style={styles.reviewFieldValue}>{formatCurrency(document.amount, document.currency)}</Text>
              </View>
              <View style={styles.reviewFieldRow}>
                <Text style={styles.reviewFieldLabel}>Tax amount</Text>
                <Text style={styles.reviewFieldValue}>{formatCurrency(document.vatAmount ?? document.taxAmount, document.currency)}</Text>
              </View>
              <View style={styles.reviewFieldRow}>
                <Text style={styles.reviewFieldLabel}>Line items</Text>
                <Text style={styles.reviewFieldValue}>{`${lineItemCount} ${lineItemCount === 1 ? 'line' : 'lines'}`}</Text>
              </View>
              <View style={styles.reviewFieldRow}>
                <Text style={styles.reviewFieldLabel}>Paid at purchase</Text>
                <Text style={styles.reviewFieldValue}>{document.type === 'receipt' ? 'Yes' : 'Not confirmed'}</Text>
              </View>
              <View style={styles.reviewFieldRow}>
                <Text style={styles.reviewFieldLabel}>Payment card</Text>
                <Text style={styles.reviewFieldValue}>{getPaymentCardLabel(document)}</Text>
              </View>
              <View style={styles.reviewFieldRow}>
                <Text style={styles.reviewFieldLabel}>Payment method</Text>
                <Text style={styles.reviewFieldValue}>{getPaymentMethodLabel(document.paymentMethod)}</Text>
              </View>
              {document.paymentMethodMatchState && document.paymentMethodMatchState !== 'not_detected' ? (
                <View style={styles.reviewFieldRow}>
                  <Text style={styles.reviewFieldLabel}>Company card check</Text>
                  <Text style={styles.reviewFieldValue}>{getPaymentMethodMatchLabel(document)}</Text>
                </View>
              ) : null}
              {document.description ? (
                <View style={styles.archivedDocumentDescription}>
                  <Text style={styles.reviewFieldLabel}>Description</Text>
                  <Text style={styles.archivedDocumentDescriptionValue}>{document.description}</Text>
                </View>
              ) : null}
            </View>
          ) : null}
          {!reimbursementArchived ? (
            <>
          <View style={styles.reviewEditor}>
            <View style={styles.reviewFieldRow}>
              <Text style={styles.reviewFieldLabel}>Type</Text>
              <Text style={styles.reviewFieldValue}>{document.type === 'invoice' ? 'Invoice' : 'Receipt'}</Text>
            </View>
            <View style={styles.reviewFieldRow}>
              <Text style={styles.reviewFieldLabel}>Owned by</Text>
              <Text style={styles.reviewFieldValue}>{ownerName}</Text>
            </View>
            <View style={styles.reviewFieldRow}>
              <Text style={styles.reviewFieldLabel}>Submitted by</Text>
              <Text style={styles.reviewFieldValue}>{submittedByName}</Text>
            </View>
            <View style={styles.reviewFieldRow}>
              <Text style={styles.reviewFieldLabel}>Date</Text>
              <Text style={styles.reviewFieldValue}>{formatDate(document.date)}</Text>
            </View>
            <View style={styles.reviewFieldRow}>
              <Text style={styles.reviewFieldLabel}>Document reference</Text>
              <Text style={styles.reviewFieldValue} numberOfLines={1}>{documentReference}</Text>
            </View>
            <View style={styles.reviewFieldRow}>
              <Text style={styles.reviewFieldLabel}>Supplier</Text>
              <Text style={styles.reviewFieldValue}>{document.supplier || 'Not available'}</Text>
            </View>
            <Pressable style={styles.reviewFieldButton} onPress={() => setCategoryPickerVisible(true)}>
              <Text style={styles.reviewFieldLabel}>Category</Text>
              <View style={styles.reviewFieldValueRow}>
                <Text style={styles.reviewFieldValue}>{selectedCategory || 'Select category'}</Text>
                <Ionicons name="chevron-forward" size={18} color={colors.royalBlueDark} />
              </View>
            </Pressable>
            <View style={styles.reviewFieldRow}>
              <Text style={styles.reviewFieldLabel}>Line items</Text>
              <Text style={styles.reviewFieldValue}>{`${lineItemCount} ${lineItemCount === 1 ? 'line' : 'lines'}`}</Text>
            </View>
            <View style={styles.reviewFieldRow}>
              <Text style={styles.reviewFieldLabel}>Paid at purchase</Text>
              <Text style={styles.reviewFieldValue}>{document.type === 'receipt' ? 'Yes' : 'Not confirmed'}</Text>
            </View>
            <View style={styles.reviewFieldRow}>
              <Text style={styles.reviewFieldLabel}>Payment card</Text>
              <Text style={styles.reviewFieldValue}>{getPaymentCardLabel(document)}</Text>
            </View>
            <View style={styles.reviewFieldRow}>
              <Text style={styles.reviewFieldLabel}>Company card check</Text>
              <Text style={styles.reviewFieldValue}>{getPaymentMethodMatchLabel(document)}</Text>
            </View>
            <View style={styles.reviewFieldRow}>
              <Text style={styles.reviewFieldLabel}>Claim status</Text>
              <Text style={styles.reviewFieldValue}>{getStatusLabel(document.status)}</Text>
            </View>
            {document.paymentMethodReviewRequired ? (
              <View style={styles.paymentMethodReviewNotice}>
                <Ionicons name="alert-circle-outline" size={20} color={colors.amber} />
                <Text style={styles.paymentMethodReviewNoticeText}>
                  This card may be a company card. Your business admin must resolve it before it can be claimed.
                </Text>
              </View>
            ) : null}
            <View style={styles.reviewTextField}>
              <Text style={styles.reviewFieldLabel}>Description</Text>
              <TextInput
                value={descriptionInput}
                onChangeText={setDescriptionInput}
                placeholder="Write your description here"
                placeholderTextColor={colors.slate}
                multiline
                style={styles.reviewTextInput}
              />
            </View>
            <Text style={styles.reviewSectionHeading}>More</Text>
            <View style={styles.reviewTextField}>
              <Text style={styles.reviewFieldLabel}>Customer</Text>
              <TextInput
                value={customerInput}
                onChangeText={setCustomerInput}
                placeholder="Add customer"
                placeholderTextColor={colors.slate}
                style={styles.reviewSingleLineInput}
              />
            </View>
          </View>
          <View style={styles.taxEditor}>
            <View style={styles.taxEditorRow}>
              <TaxAmountField label="Total" value={totalInput} onChangeText={setTotalInput} />
              {vatTrackingEnabled ? <TaxAmountField label="Net" value={netInput} onChangeText={setNetInput} /> : null}
              {vatTrackingEnabled && !foreignCurrencyDocument ? <TaxAmountField label="VAT" value={vatInput} onChangeText={setVatInput} /> : null}
            </View>
            {foreignCurrencyDocument ? (
              <View style={styles.reviewFieldRow}>
                <Text style={styles.reviewFieldLabel}>Foreign tax</Text>
                <Text style={styles.reviewFieldValue}>
                  {document.foreignTaxAmount == null
                    ? 'Not shown on document'
                    : formatCurrency(document.foreignTaxAmount, document.currency)}
                </Text>
              </View>
            ) : null}
            {foreignCurrencyDocument ? (
              <View style={styles.reviewFieldRow}>
                <Text style={styles.reviewFieldLabel}>UK VAT treatment</Text>
                <Text style={styles.reviewFieldValue}>Set by your business admin</Text>
              </View>
            ) : null}
            <View style={styles.taxDropdown}>
              <Text style={styles.taxDropdownLabel}>Currency</Text>
              <View style={styles.taxDropdownValueWrap}>
                {['GBP', 'USD', 'EUR'].map((currency) => (
                  <Pressable
                    key={currency}
                    style={[styles.taxDropdownOption, currency === selectedCurrency && styles.taxDropdownOptionActive]}
                    onPress={() => setSelectedCurrency(currency)}
                  >
                    <Text style={[styles.taxDropdownOptionText, currency === selectedCurrency && styles.taxDropdownOptionTextActive]}>
                      {currency}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
            {document.workspaceContext === 'cost' ? (
              <View style={styles.taxDropdown}>
                <Text style={styles.taxDropdownLabel}>Payment method</Text>
                <View style={styles.taxDropdownValueWrap}>
                  {([
                    ['cash_personal', 'Personal'],
                    ['business_card', 'Company card'],
                  ] as const).map(([method, label]) => (
                    <Pressable
                      key={method}
                      style={[styles.taxDropdownOption, method === selectedPaymentMethod && styles.taxDropdownOptionActive]}
                      onPress={() => setSelectedPaymentMethod(method)}
                    >
                      <Text style={[styles.taxDropdownOptionText, method === selectedPaymentMethod && styles.taxDropdownOptionTextActive]}>{label}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}
            {vatTrackingEnabled && !foreignCurrencyDocument ? (
              <>
                <Pressable style={styles.taxDropdown} onPress={() => setTaxDropdownOpen((current) => !current)}>
                  <Text style={styles.taxDropdownLabel}>Tax rate</Text>
                  <View style={styles.taxDropdownValueWrap}>
                    <Text style={styles.taxDropdownValue}>{selectedTaxRate}</Text>
                    <Ionicons
                      name={taxDropdownOpen ? 'chevron-up' : 'chevron-down'}
                      size={18}
                      color={colors.royalBlueDark}
                    />
                  </View>
                </Pressable>
                {taxDropdownOpen ? (
                  <View style={styles.taxDropdownMenu}>
                    {TAX_RATE_OPTIONS.map((option) => (
                      <Pressable
                        key={option}
                        style={[styles.taxDropdownOption, option === selectedTaxRate && styles.taxDropdownOptionActive]}
                        onPress={() => {
                          setSelectedTaxRate(option);
                          setTaxDropdownOpen(false);
                        }}
                      >
                        <Text
                          style={[
                            styles.taxDropdownOptionText,
                            option === selectedTaxRate && styles.taxDropdownOptionTextActive,
                          ]}
                        >
                          {option}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </>
            ) : (
              <View style={styles.reviewFieldRow}>
                <Text style={styles.reviewFieldLabel}>VAT tracking</Text>
                <Text style={styles.reviewFieldValue}>Gross total only</Text>
              </View>
            )}
            <Pressable
              style={[styles.taxSaveButton, savingValues && styles.taxSaveButtonDisabled]}
              disabled={savingValues}
              onPress={async () => {
                let valuesSaved = false;
                const amount = parseMoneyInput(totalInput);
                const netAmount = vatTrackingEnabled ? parseMoneyInput(netInput) : amount;
                const vatAmount = vatTrackingEnabled ? parseMoneyInput(vatInput) : 0;
                setSavingValues(true);
                setSavingValuesProgress(16);
                try {
                  // Let the progress panel render before the network save begins.
                  await delay(90);
                  setSavingValuesProgress(68);
                  await onUpdateReviewFields({
                    amount,
                    netAmount,
                    vatAmount,
                    taxAmount: vatAmount,
                    currency: selectedCurrency,
                    category: selectedCategory || document.category,
                    description: descriptionInput.trim(),
                    customer: customerInput.trim(),
                    paymentMethod: selectedPaymentMethod,
                    taxRateApplied: effectiveTaxRate,
                  });
                  setSavingValuesProgress(100);
                  await delay(220);
                  valuesSaved = true;
                } finally {
                  setSavingValues(false);
                  setSavingValuesProgress(0);
                }
                if (valuesSaved) {
                  Alert.alert('Values saved');
                }
              }}
            >
              <Text style={styles.taxSaveButtonText}>{savingValues ? 'Saving values...' : 'Save Values'}</Text>
            </Pressable>
          </View>
              <View style={styles.documentSheetActions}>
            {document.workspaceContext !== 'sales' || isAdmin ? <Pressable style={[styles.sheetActionButton, styles.sheetActionPrimary]} onPress={onMarkReviewed}>
              <Text style={styles.sheetActionPrimaryText}>{document.workspaceContext === 'sales' ? 'Approve sales document' : 'Mark reviewed'}</Text>
            </Pressable> : null}
            {document.workspaceContext === 'cost' && document.paymentMethod === 'cash_personal' && !document.paymentMethodReviewRequired ? (
              <Pressable style={styles.sheetActionButton} onPress={onAddToClaim}>
                <Text style={styles.sheetActionText}>Add to claim</Text>
              </Pressable>
            ) : null}
            {document.workspaceContext !== 'sales' || isAdmin ? <Pressable style={[styles.sheetActionButton, styles.sheetActionPrimary]} onPress={onMarkSubmitted}>
              <Text style={styles.sheetActionPrimaryText}>{document.workspaceContext === 'sales' ? 'Mark as published' : 'Mark submitted'}</Text>
            </Pressable> : null}
            {canDelete ? (
              <Pressable style={[styles.sheetActionButton, styles.sheetActionDanger]} onPress={onDelete}>
                <Text style={styles.sheetActionDangerText}>Delete</Text>
              </Pressable>
            ) : null}
              </View>
            </>
          ) : null}
            </ScrollView>
          </DismissibleSheet>
        </View>
      </Modal>
      <Modal transparent animationType="slide" visible={categoryPickerVisible} onRequestClose={() => setCategoryPickerVisible(false)}>
        <View style={styles.sheetBackdrop}>
          <Pressable style={styles.sheetOverlay} onPress={() => setCategoryPickerVisible(false)} />
          <DismissibleSheet style={styles.categoryPickerSheet} onClose={() => setCategoryPickerVisible(false)}>
            <View style={styles.categoryPickerHeader}>
              <TextInput
                value={categorySearchInput}
                onChangeText={setCategorySearchInput}
                placeholder="Search"
                placeholderTextColor={colors.slate}
                style={styles.categoryPickerSearchInput}
              />
              <Pressable onPress={() => setCategoryPickerVisible(false)} style={styles.categoryPickerCloseButton}>
                <Ionicons name="close" size={28} color={colors.nearBlack} />
              </Pressable>
            </View>
            <ScrollView style={styles.categoryPickerList} keyboardShouldPersistTaps="handled">
              {filteredCategoryOptions.map((option) => (
                <Pressable
                  key={option}
                  style={styles.categoryPickerOption}
                  onPress={() => {
                    setSelectedCategory(option);
                    setCategoryPickerVisible(false);
                  }}
                >
                  <Text style={styles.categoryPickerOptionText}>{option}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </DismissibleSheet>
        </View>
      </Modal>
      <Modal
        visible={previewVisible}
        transparent={false}
        animationType="fade"
        presentationStyle="fullScreen"
        statusBarTranslucent
        onRequestClose={() => setPreviewVisible(false)}
      >
        <View style={styles.previewFullscreenBackdrop}>
          <Pressable style={styles.previewFullscreenClose} onPress={() => setPreviewVisible(false)}>
            <Ionicons name="close" size={28} color={colors.white} />
          </Pressable>
          {hasPreviewImage ? (
            <DocumentPreviewCarousel previewUris={previewUris} fullScreen />
          ) : null}
        </View>
      </Modal>
      <SavingValuesProgress visible={savingValues} progress={savingValuesProgress} />
    </>
  );
}

function SavingValuesProgress({ visible, progress }: { visible: boolean; progress: number }) {
  if (!visible) {
    return null;
  }

  return (
    <Modal transparent animationType="fade" visible statusBarTranslucent>
      <View style={styles.vaultUploadBackdrop}>
        <View
          style={styles.vaultUploadCard}
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: progress }}
        >
          <View style={styles.vaultUploadIcon}>
            <Ionicons name="save-outline" size={30} color={colors.white} />
          </View>
          <Text style={styles.vaultUploadTitle}>Saving values</Text>
          <Text style={styles.vaultUploadStatus}>Updating this receipt securely...</Text>
          <ActivityIndicator size="small" color={colors.tealDeep} style={styles.valueSaveSpinner} />
          <View style={styles.vaultUploadTrack}>
            <View style={[styles.vaultUploadFill, { width: `${progress}%` }]} />
          </View>
          <Text style={styles.vaultUploadPercent}>{`${Math.round(progress)}%`}</Text>
        </View>
      </View>
    </Modal>
  );
}

const SyncingBannerLabel = memo(function SyncingBannerLabel() {
  const dotsOpacity = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(dotsOpacity, { toValue: 1, duration: 500, useNativeDriver: true }),
        Animated.timing(dotsOpacity, { toValue: 0.35, duration: 500, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [dotsOpacity]);

  return (
    <View style={styles.syncBannerStatus} accessibilityLabel="Syncing with Exdox">
      <Text style={styles.syncBannerStaticText}>Syncing with Exdox</Text>
      <Animated.Text style={[styles.syncBannerDots, { opacity: dotsOpacity }]}>...</Animated.Text>
    </View>
  );
});

function TaxAmountField({
  label,
  value,
  onChangeText,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
}) {
  return (
    <View style={styles.taxAmountField}>
      <Text style={styles.taxAmountLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType="decimal-pad"
        selectTextOnFocus
        style={styles.taxAmountInput}
      />
    </View>
  );
}

function CaptureModal({
  captureType,
  activeTab,
  isAdmin,
  visible,
  isSaving,
  onClose,
  onSelectType,
  onUseCamera,
  onUseGallery,
  onUsePdf,
}: {
  captureType: DocumentKind;
  activeTab: MainTab;
  isAdmin: boolean;
  visible: boolean;
  isSaving: boolean;
  onClose: () => void;
  onSelectType: (type: DocumentKind) => void;
  onUseCamera: () => void;
  onUseGallery: () => void;
  onUsePdf: () => void;
}) {
  const availableTypes =
    activeTab === 'sales'
      ? (['invoice'] as const)
      : isAdmin
        ? (['receipt', 'invoice'] as const)
        : (['receipt'] as const);

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <Pressable style={styles.sheetOverlay} onPress={onClose} />
        <DismissibleSheet style={styles.captureSheet} onClose={onClose} disabled={isSaving}>
          <View style={styles.sectionTabs}>
            {availableTypes.map((type) => (
              <Pressable
                key={type}
                style={[styles.sectionTab, captureType === type && styles.sectionTabActive]}
                onPress={() => onSelectType(type)}
              >
                <Text style={[styles.sectionTabText, captureType === type && styles.sectionTabTextActive]}>
                  {type === 'receipt' ? 'Receipt' : 'Invoice'}
                </Text>
              </Pressable>
            ))}
          </View>
          <Pressable style={styles.captureRow} onPress={onUseCamera} disabled={isSaving}>
            <Ionicons name="camera-outline" size={24} color={colors.royalBlue} />
            <Text style={styles.captureRowText}>Use camera</Text>
          </Pressable>
          <Pressable style={styles.captureRow} onPress={onUseGallery} disabled={isSaving}>
            <Ionicons name="image-outline" size={24} color={colors.royalBlue} />
            <Text style={styles.captureRowText}>Import from gallery</Text>
          </Pressable>
          <Pressable style={styles.captureRow} onPress={onUsePdf} disabled={isSaving}>
            <Ionicons name="document-outline" size={24} color={colors.royalBlue} />
            <Text style={styles.captureRowText}>Select PDF</Text>
          </Pressable>
          {isSaving ? <ActivityIndicator color={colors.royalBlue} style={styles.captureLoader} /> : null}
        </DismissibleSheet>
      </View>
    </Modal>
  );
}

function CameraCapture({
  visible,
  type,
  lowResolution,
  onClose,
  onSelectType,
  onUseGallery,
  onUsePdf,
  onCaptureSingle,
  onCaptureMultiple,
  onCaptureCombined,
}: {
  visible: boolean;
  type: DocumentKind;
  lowResolution: boolean;
  onClose: () => void;
  onSelectType: (type: DocumentKind) => void;
  onUseGallery: () => void;
  onUsePdf: () => void;
  onCaptureSingle: (uri: string) => Promise<void>;
  onCaptureMultiple: (uri: string) => Promise<void>;
  onCaptureCombined: (assets: Array<{ uri: string }>) => Promise<void>;
}) {
  if (!visible) {
    return null;
  }

  return (
    <CameraSheet
      type={type}
      lowResolution={lowResolution}
      onClose={onClose}
      onSelectType={onSelectType}
      onUseGallery={onUseGallery}
      onUsePdf={onUsePdf}
      onCaptureSingle={onCaptureSingle}
      onCaptureMultiple={onCaptureMultiple}
      onCaptureCombined={onCaptureCombined}
    />
  );
}

function EmptyOrbit({ icon }: { icon: keyof typeof Ionicons.glyphMap }) {
  return (
    <View style={styles.emptyOrbit}>
      <View style={styles.emptyOrbitHalo} />
      <View style={styles.emptyOrbitDotTop} />
      <View style={styles.emptyOrbitDotBottom} />
      <View style={styles.emptyOrbitCore}>
        <Ionicons name={icon} size={34} color={colors.white} />
      </View>
    </View>
  );
}

function ArchiveSheet({
  visible,
  target,
  documents,
  onClose,
  onOpenDocument,
}: {
  visible: boolean;
  target: ArchiveTarget | null;
  documents: ExpenseDocument[];
  onClose: () => void;
  onOpenDocument: (documentId: string) => void;
}) {
  if (!visible || !target) {
    return null;
  }

  const groupedDocuments = documents.reduce<Array<{ title: string; items: ExpenseDocument[] }>>((groups, document) => {
    const dateValue = document.date || document.createdAt;
    const title = formatMonthYear(dateValue);
    const existingGroup = groups.find((group) => group.title === title);
    if (existingGroup) {
      existingGroup.items.push(document);
      return groups;
    }
    groups.push({
      title,
      items: [document],
    });
    return groups;
  }, []);

  return (
    <Modal visible transparent={false} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.archiveScreen}>
        <View style={styles.archiveHeader}>
          <Pressable style={styles.archiveBackButton} onPress={onClose}>
            <Ionicons name="chevron-back" size={26} color={colors.nearBlack} />
          </Pressable>
          <View style={styles.archiveHeaderCopy}>
            <Text style={styles.archiveTitle}>Archive</Text>
            <Text style={styles.archiveSubtitle}>{target === 'sales' ? 'Sales history' : 'Costs history'}</Text>
          </View>
        </View>

        {!documents.length ? (
          <View style={styles.archiveEmptyState}>
            <BlankPanel
              icon={target === 'sales' ? 'document-text-outline' : 'archive-outline'}
              title={`No ${target === 'sales' ? 'sales' : 'costs'} history yet`}
              copy={`Submitted ${target === 'sales' ? 'sales documents' : 'cost items'} will appear here.`}
            />
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.archiveContent} showsVerticalScrollIndicator={false}>
            {groupedDocuments.map((group) => (
              <View key={group.title}>
                <View style={styles.archiveMonthHeader}>
                  <Text style={styles.archiveMonthHeaderText}>{group.title}</Text>
                </View>
                {group.items.map((document) => (
                  <Pressable
                    key={document.id}
                    style={styles.archiveRow}
                    onPress={() => onOpenDocument(document.id)}
                  >
                    <View style={styles.archiveRowMain}>
                      <Text style={styles.archiveRowTitle}>{document.title}</Text>
                      <Text style={styles.archiveRowAmount}>{formatCurrency(document.amount, document.currency)}</Text>
                    </View>
                    <View style={styles.archiveRowRight}>
                      <Text style={styles.archiveRowDate}>{formatDate(document.date || document.createdAt)}</Text>
                      <StatusPill status={document.status} onPress={() => onOpenDocument(document.id)} />
                    </View>
                  </Pressable>
                ))}
              </View>
            ))}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

function CameraSheet({
  type,
  lowResolution,
  onClose,
  onSelectType,
  onUseGallery,
  onUsePdf,
  onCaptureSingle,
  onCaptureMultiple,
  onCaptureCombined,
}: {
  type: DocumentKind;
  lowResolution: boolean;
  onClose: () => void;
  onSelectType: (type: DocumentKind) => void;
  onUseGallery: () => void;
  onUsePdf: () => void;
  onCaptureSingle: (uri: string) => Promise<void>;
  onCaptureMultiple: (uri: string) => Promise<void>;
  onCaptureCombined: (assets: Array<{ uri: string }>) => Promise<void>;
}) {
  const cameraRef = useRef<CameraView | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [mode, setMode] = useState<CameraCaptureMode>('single');
  const [combinedAssets, setCombinedAssets] = useState<Array<{ uri: string }>>([]);
  const isCombining = mode === 'combine' && combinedAssets.length > 0;
  const hintText =
    mode === 'multiple'
      ? 'Capture multiple receipts'
      : mode === 'combine'
        ? isCombining
          ? `${combinedAssets.length} image${combinedAssets.length === 1 ? '' : 's'} ready to combine`
          : 'Capture pages for one receipt'
        : 'One receipt or bill';

  const capturePhoto = async () => {
    const camera = cameraRef.current;
    if (!camera) {
      Alert.alert('Camera not ready', 'Please wait a moment and try taking the photo again.');
      return;
    }

    setIsProcessing(true);
    try {
      const result = await camera.takePictureAsync({
        quality: lowResolution ? 0.6 : 0.8,
        skipProcessing: false,
      });

      if (!result?.uri) {
        throw new Error('Camera capture returned no file URI.');
      }

      if (mode === 'multiple') {
        await onCaptureMultiple(result.uri);
        return;
      }

      if (mode === 'combine') {
        setCombinedAssets((current) => [...current, { uri: result.uri }]);
        return;
      }

      await onCaptureSingle(result.uri);
    } catch (error) {
      console.error('camera capture failed', error);
      Alert.alert(
        'Camera failed',
        'The receipt photo could not be captured. Please try again or import from gallery.',
      );
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <Modal animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.cameraShell}>
        <CameraView
          style={styles.cameraView}
          facing="back"
          ref={(instance) => {
            cameraRef.current = instance;
          }}
          onCameraReady={() => setIsCameraReady(true)}
        />
        <View style={styles.cameraOverlay}>
          <View style={styles.cameraTopBar}>
            <Pressable style={styles.cameraTopIcon} onPress={onClose}>
              <Ionicons name="close" size={24} color={colors.white} />
            </Pressable>
          </View>
          <View style={styles.cameraHintWrap}>
            <Text style={styles.cameraText}>{hintText}</Text>
          </View>
          <View style={styles.cameraBottomPanel}>
            <View style={styles.cameraModeRow}>
              {(['single', 'multiple', 'combine'] as const).map((option) => (
                <Pressable
                  key={option}
                  style={styles.cameraModeButton}
                  onPress={() => {
                    setMode(option);
                    if (option !== 'combine') {
                      setCombinedAssets([]);
                    }
                  }}
                >
                  <Text style={[styles.cameraModeText, mode === option && styles.cameraModeTextActive]}>
                    {option === 'single' ? 'Single' : option === 'multiple' ? 'Multiple' : 'Combine'}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.cameraActions}>
              <Pressable style={styles.cameraGalleryButton} onPress={onUseGallery}>
                <Ionicons name="image-outline" size={30} color={colors.white} />
              </Pressable>
              <Pressable style={styles.cameraGalleryButton} onPress={onUsePdf}>
                <Ionicons name="document-outline" size={28} color={colors.white} />
              </Pressable>
              <Pressable
                style={[styles.cameraShutter, (!isCameraReady || isProcessing) && styles.cameraShutterDisabled]}
                disabled={!isCameraReady || isProcessing}
                onPress={capturePhoto}
              >
                <View style={styles.cameraShutterInner} />
              </Pressable>
              <Pressable
                style={styles.cameraTypeButton}
                onPress={() => onSelectType(type === 'invoice' ? 'receipt' : 'invoice')}
              >
                <Text style={styles.cameraTypeText}>{type === 'invoice' ? 'Sales' : 'Costs'}</Text>
                <Ionicons name="chevron-down" size={18} color={colors.white} />
              </Pressable>
            </View>
            {mode === 'combine' ? (
              <View style={styles.cameraCombineActions}>
                <Pressable
                  style={[styles.cameraCombineButton, !combinedAssets.length && styles.cameraCombineButtonDisabled]}
                  disabled={!combinedAssets.length || isProcessing}
                  onPress={() => void onCaptureCombined(combinedAssets)}
                >
                  <Text style={styles.cameraCombineButtonText}>
                    {combinedAssets.length ? `Done (${combinedAssets.length})` : 'Done'}
                  </Text>
                </Pressable>
                {combinedAssets.length ? (
                  <Pressable style={styles.cameraCombineClearButton} onPress={() => setCombinedAssets([])}>
                    <Text style={styles.cameraCombineClearText}>Clear</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date
    .toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
    .replace(/,/g, '');
}

function formatMonthYear(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown month';
  }
  return date.toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
  });
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatMoneyInput(value: number | null | undefined) {
  return Number.isFinite(value) ? Number(value).toFixed(2) : '0.00';
}

function parseMoneyInput(value: string) {
  const parsed = Number(value.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.white,
  },
  screen: {
    flex: 1,
    backgroundColor: colors.white,
  },
  syncBanner: {
    minHeight: 34,
    paddingHorizontal: 20,
    paddingVertical: 8,
    backgroundColor: colors.band,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  syncBannerSynced: {
    backgroundColor: '#EAF8F4',
  },
  syncBannerFailed: {
    backgroundColor: '#FFF3E2',
  },
  syncBannerText: {
    flex: 1,
    marginLeft: 8,
    color: colors.mutedText,
    fontSize: 12,
  },
  syncBannerStatus: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  syncBannerStaticText: {
    color: colors.mutedText,
    fontSize: 12,
  },
  syncBannerDots: {
    minWidth: 28,
    marginLeft: 2,
    color: colors.mutedText,
    fontSize: 12,
  },
  syncBannerAction: {
    marginLeft: 12,
    color: colors.royalBlueDark,
    fontSize: 13,
    fontWeight: '700',
  },
  authScreen: {
    flex: 1,
    paddingHorizontal: 24,
    backgroundColor: colors.band,
  },
  authScrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingVertical: 24,
  },
  authCard: {
    backgroundColor: colors.white,
    borderRadius: 24,
    paddingHorizontal: 22,
    paddingVertical: 28,
  },
  authLogoFrame: {
    alignSelf: 'center',
    width: 200,
    height: 108,
    marginBottom: 12,
    borderRadius: 24,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  authLogo: {
    width: 150,
    height: 100,
  },
  authTitle: {
    fontSize: 30,
    fontWeight: '700',
    color: colors.nearBlack,
    textAlign: 'center',
  },
  authSubtitle: {
    marginTop: 8,
    fontSize: 16,
    lineHeight: 24,
    color: colors.mutedText,
    textAlign: 'center',
  },
  authTabs: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 24,
    marginBottom: 18,
  },
  authTab: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 18,
    backgroundColor: colors.band,
    alignItems: 'center',
  },
  authTabActive: {
    backgroundColor: colors.royalBlueDark,
  },
  authTabText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.nearBlack,
  },
  authTabTextActive: {
    color: colors.white,
  },
  authInput: {
    borderWidth: 1,
    borderColor: colors.lightBorder,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: colors.nearBlack,
    marginBottom: 12,
    backgroundColor: colors.white,
  },
  authButton: {
    marginTop: 8,
    backgroundColor: colors.royalBlueDark,
    borderRadius: 18,
    minHeight: 54,
    alignItems: 'center',
    justifyContent: 'center',
  },
  authButtonDisabled: {
    opacity: 0.6,
  },
  authButtonText: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.white,
  },
  authSecondaryLink: {
    marginTop: 14,
    alignSelf: 'center',
    paddingVertical: 4,
  },
  authSecondaryLinkText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.royalBlueDark,
  },
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
  },
  loadingLogo: {
    width: 132,
    height: 132,
    marginBottom: 20,
  },
  loadingText: {
    marginTop: spacing.sm,
    color: colors.mutedText,
    fontSize: 15,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 26,
    paddingTop: 16,
    paddingBottom: 20,
    backgroundColor: colors.tealDeep,
  },
  headerBrandBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
    marginRight: 16,
  },
  headerBrandMark: {
    width: 42,
    height: 42,
  },
  headerBrandMarkFrame: {
    width: 52,
    height: 52,
    borderRadius: 18,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#020817',
    shadowOpacity: 0.2,
    shadowRadius: 10,
    elevation: 3,
  },
  headerEyebrow: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.1,
    color: '#80E5D6',
  },
  headerTitle: {
    marginTop: 2,
    fontSize: 27,
    fontWeight: '700',
    color: colors.white,
  },
  biometricButton: {
    minHeight: 48,
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.royalBlueDark,
    borderRadius: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#EEF4FF',
  },
  biometricButtonText: {
    color: colors.royalBlueDark,
    fontSize: 15,
    fontWeight: '700',
  },
  headerSubtitle: {
    marginTop: 4,
    fontSize: 15,
    color: '#C9D7F1',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
    paddingTop: 4,
  },
  searchBand: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: '#E9F1F8',
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 10,
    minHeight: 48,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: '#D6E4F1',
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    color: colors.nearBlack,
  },
  searchFilterButton: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#CFF4EE',
  },
  content: {
    paddingBottom: 132,
    flexGrow: 1,
  },
  dayHeader: {
    alignItems: 'flex-end',
    paddingHorizontal: 30,
    paddingTop: 24,
    paddingBottom: 10,
  },
  dayHeaderText: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.nearBlack,
  },
  documentRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 26,
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.white,
  },
  documentRowCompact: {
    paddingVertical: 14,
  },
  documentLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
    minWidth: 0,
    paddingRight: 10,
  },
  documentText: {
    flex: 1,
    minWidth: 0,
  },
  documentThumb: {
    width: 52,
    height: 52,
    borderRadius: 14,
    backgroundColor: colors.band,
  },
  documentThumbFallback: {
    width: 52,
    height: 52,
    borderRadius: 14,
    backgroundColor: colors.band,
    alignItems: 'center',
    justifyContent: 'center',
  },
  documentDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.dotMint,
  },
  documentTitle: {
    fontSize: 19,
    fontWeight: '700',
    color: colors.nearBlack,
    flexShrink: 1,
    lineHeight: 24,
  },
  documentAmount: {
    marginTop: 8,
    fontSize: 18,
    color: colors.amountText,
  },
  documentAmountPending: {
    color: colors.mutedText,
  },
  documentStatusText: {
    marginTop: 6,
    fontSize: 13,
    color: colors.mutedText,
  },
  documentRight: {
    width: 120,
    flexShrink: 0,
    alignItems: 'flex-end',
    gap: 12,
  },
  documentDate: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.dateText,
  },
  statusPill: {
    minWidth: 112,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9,
    alignItems: 'center',
  },
  salesWorkflowTabs: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
  salesWorkflowTab: {
    flex: 1,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    alignItems: 'center',
  },
  salesWorkflowTabActive: {
    backgroundColor: colors.royalBlueDark,
    borderColor: colors.royalBlueDark,
  },
  salesWorkflowTabText: {
    color: colors.royalBlueDark,
    fontWeight: '700',
  },
  salesWorkflowTabTextActive: {
    color: colors.white,
  },
  salesToolTabs: {
    gap: 8,
    paddingBottom: 14,
  },
  salesToolTab: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
  },
  salesToolsPanel: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    gap: 12,
  },
  salesToolRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  salesToolRowMain: {
    flex: 1,
  },
  salesToolAmount: {
    fontWeight: '700',
    color: colors.nearBlack,
    textAlign: 'right',
  },
  salesSubmissionAddress: {
    color: colors.royalBlueDark,
    fontWeight: '700',
  },
  salesWorkspaceError: {
    color: '#B42318',
    marginBottom: 12,
  },
  statusPillText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.nearBlack,
  },
  pillReview: {
    backgroundColor: colors.royalBlueDark,
    borderColor: colors.dotMint,
    borderWidth: 1,
  },
  statusPillTextReview: {
    color: colors.white,
    fontWeight: '700',
  },
  pillReady: {
    backgroundColor: colors.pillBlue,
  },
  pillSubmitted: {
    backgroundColor: colors.pillGrey,
  },
  pillPaid: {
    backgroundColor: colors.pillGreen,
  },
  blankState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 38,
    paddingTop: 96,
  },
  emptyOrbit: {
    width: 156,
    height: 156,
    marginBottom: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyOrbitHalo: {
    position: 'absolute',
    width: 138,
    height: 138,
    borderRadius: 69,
    backgroundColor: '#E0F6F2',
    borderWidth: 1,
    borderColor: '#A6E5DA',
  },
  emptyOrbitCore: {
    width: 82,
    height: 82,
    borderRadius: 28,
    backgroundColor: colors.tealDeep,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-8deg' }],
    shadowColor: colors.tealDeep,
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 5,
  },
  emptyOrbitDotTop: {
    position: 'absolute',
    top: 8,
    right: 29,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#2EC4A6',
  },
  emptyOrbitDotBottom: {
    position: 'absolute',
    bottom: 18,
    left: 19,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#2458D3',
  },
  blankTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.nearBlack,
    textAlign: 'center',
  },
  blankCopy: {
    marginTop: 22,
    fontSize: 18,
    lineHeight: 28,
    color: colors.nearBlack,
    textAlign: 'center',
  },
  blankButton: {
    marginTop: 34,
    minWidth: 196,
    alignItems: 'center',
    borderRadius: 16,
    paddingHorizontal: 28,
    paddingVertical: 17,
    backgroundColor: colors.tealDeep,
    shadowColor: colors.tealDeep,
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 4,
  },
  blankButtonText: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.white,
  },
  claimsList: {
    paddingTop: 24,
    gap: 0,
  },
  claimCreateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: colors.royalBlueDark,
    borderRadius: 18,
    paddingVertical: 14,
    marginHorizontal: 20,
    marginBottom: 22,
  },
  claimCreateButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.white,
  },
  claimCard: {
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.lightBorder,
  },
  paymentRoundCard: {
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.lightBorder,
  },
  paymentRoundHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 20,
  },
  paymentRoundHeaderExpanded: {
    backgroundColor: '#F4F8FC',
  },
  paymentRoundDate: {
    color: colors.nearBlack,
    fontSize: 18,
    fontWeight: '800',
  },
  paymentRoundTotalWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  paymentRoundTotal: {
    color: colors.royalBlueDark,
    fontSize: 19,
    fontWeight: '800',
  },
  paymentRoundExpanded: {
    borderTopWidth: 1,
    borderTopColor: colors.band,
  },
  paymentRoundReceiptRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.band,
  },
  paymentRoundReceiptDetails: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  paymentRoundReceiptTitle: {
    color: colors.nearBlack,
    fontSize: 16,
    fontWeight: '700',
  },
  paymentRoundReceiptDate: {
    color: colors.dateText,
    fontSize: 15,
    fontWeight: '600',
  },
  paymentRoundReceiptAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginLeft: 16,
  },
  paymentRoundReceiptAmount: {
    color: colors.nearBlack,
    fontSize: 16,
    fontWeight: '800',
  },
  claimSectionHeading: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
  },
  paymentRoundHeadingCopy: {
    flex: 1,
    paddingRight: 70,
  },
  claimSectionTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.nearBlack,
  },
  claimSectionCopy: {
    marginTop: 3,
    fontSize: 13,
    color: colors.mutedText,
  },
  claimCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingTop: 15,
    paddingBottom: 15,
  },
  claimCardHeaderExpanded: {
    backgroundColor: '#F4F8FC',
  },
  claimMonthGroup: {
    gap: 0,
    marginBottom: 22,
  },
  claimMonthHeading: {
    width: '100%',
    paddingHorizontal: 20,
    paddingVertical: 12,
    textAlign: 'right',
    backgroundColor: '#EDF4F8',
    color: colors.royalBlueDark,
    fontSize: 16,
    fontWeight: '800',
  },
  claimRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 18,
  },
  claimRowLeft: {
    flex: 1,
    paddingRight: 16,
  },
  claimDate: {
    marginTop: 7,
    color: colors.dateText,
    fontSize: 13,
    fontWeight: '600',
  },
  claimStatusChip: {
    minWidth: 104,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  claimStatusApproved: {
    backgroundColor: '#EAF8F4',
    borderWidth: 1,
    borderColor: colors.dotMint,
  },
  claimStatusPaid: {
    backgroundColor: colors.royalBlueDark,
  },
  claimStatusOpen: {
    backgroundColor: '#FFF4DE',
    borderWidth: 1,
    borderColor: colors.pillAmber,
  },
  claimStatusText: {
    color: '#805A12',
    fontSize: 13,
    fontWeight: '800',
  },
  claimStatusDetail: {
    marginTop: 2,
    color: '#805A12',
    fontSize: 11,
    fontWeight: '600',
  },
  claimListTotal: {
    alignItems: 'flex-end',
    gap: 5,
    marginLeft: 10,
  },
  claimListAmount: {
    color: colors.royalBlueDark,
    fontSize: 15,
    fontWeight: '800',
  },
  claimStatusTextProcessed: {
    color: colors.royalBlueDark,
  },
  claimStatusTextPaid: {
    color: colors.white,
  },
  claimReceiptList: {
    borderTopWidth: 1,
    borderTopColor: colors.band,
  },
  claimExpandedContent: {
    borderTopWidth: 1,
    borderTopColor: colors.band,
  },
  claimDescription: {
    paddingHorizontal: 18,
    paddingTop: 14,
    color: colors.mutedText,
    fontSize: 14,
    lineHeight: 20,
  },
  claimItemsHeading: {
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 8,
    color: colors.nearBlack,
    fontSize: 14,
    fontWeight: '800',
  },
  claimReceiptRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.band,
  },
  claimReceiptIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: '#EEF4FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  claimReceiptCopy: {
    flex: 1,
  },
  claimReceiptName: {
    color: colors.nearBlack,
    fontSize: 15,
    fontWeight: '700',
  },
  claimReceiptDate: {
    marginTop: 2,
    color: colors.mutedText,
    fontSize: 12,
  },
  claimReceiptAmount: {
    color: colors.nearBlack,
    fontSize: 14,
    fontWeight: '800',
  },
  claimReceiptSummary: {
    paddingHorizontal: 18,
    paddingBottom: 14,
    color: colors.mutedText,
    fontSize: 14,
  },
  claimAttachList: {
    borderTopWidth: 1,
    borderTopColor: colors.band,
    paddingHorizontal: 18,
    paddingBottom: 18,
    paddingTop: 14,
    gap: 8,
  },
  claimAddPurchaseLabel: {
    color: colors.nearBlack,
    fontSize: 14,
    fontWeight: '800',
  },
  claimAttachButton: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.lightBorder,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  claimAttachButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.royalBlueDark,
  },
  claimName: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.nearBlack,
  },
  claimMeta: {
    marginTop: 6,
    fontSize: 14,
    color: colors.mutedText,
  },
  claimAmount: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.royalBlueDark,
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 18,
    paddingHorizontal: 26,
    paddingTop: 18,
    paddingBottom: 20,
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.band,
    borderBottomWidth: 1,
    borderBottomColor: colors.band,
  },
  profileCopy: {
    flex: 1,
    justifyContent: 'center',
    paddingTop: 2,
  },
  profileAvatar: {
    width: 82,
    height: 82,
    borderRadius: 41,
    backgroundColor: colors.avatarMint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileName: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '700',
    color: colors.nearBlack,
  },
  profileEmail: {
    marginTop: 6,
    fontSize: 16,
    lineHeight: 22,
    color: colors.mutedText,
  },
  profileRole: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 18,
    color: colors.royalBlueDark,
    fontWeight: '600',
  },
  settingsLink: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 18,
    paddingHorizontal: 26,
    paddingVertical: 22,
    borderBottomWidth: 1,
    borderBottomColor: colors.band,
  },
  settingsLinkText: {
    flex: 1,
    fontSize: 20,
    lineHeight: 26,
    color: colors.nearBlack,
  },
  errorSheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 28,
    maxHeight: '80%',
  },
  errorSheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  errorSheetTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.nearBlack,
  },
  errorSheetClear: {
    backgroundColor: colors.band,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  errorSheetClearText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.royalBlueDark,
  },
  errorSheetScroll: {
    flexGrow: 0,
  },
  errorSheetContent: {
    paddingBottom: spacing.md,
  },
  errorEmptyText: {
    fontSize: 15,
    color: colors.mutedText,
  },
  errorEntry: {
    borderWidth: 1,
    borderColor: colors.band,
    borderRadius: 16,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  errorEntryHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginBottom: 6,
  },
  errorEntrySource: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    color: colors.nearBlack,
  },
  errorEntryTime: {
    fontSize: 12,
    color: colors.mutedText,
  },
  errorEntryMessage: {
    fontSize: 14,
    color: colors.nearBlack,
    marginBottom: 6,
  },
  errorEntryMeta: {
    fontSize: 12,
    color: colors.royalBlueDark,
    marginBottom: 6,
  },
  errorEntryStack: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.mutedText,
  },
  settingsGroup: {
    paddingTop: 8,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 26,
    paddingVertical: 18,
  },
  settingLabelWrap: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 18,
    flex: 1,
    paddingRight: 12,
  },
  settingLabel: {
    fontSize: 19,
    lineHeight: 25,
    color: colors.nearBlack,
    flexShrink: 1,
  },
  settingValue: {
    fontSize: 18,
    lineHeight: 24,
    color: colors.nearBlack,
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 22,
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: '#DCE8F1',
    shadowColor: colors.tealDeep,
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 10,
  },
  bottomItem: {
    alignItems: 'center',
    flex: 1,
    minWidth: 54,
  },
  bottomLabel: {
    marginTop: 6,
    fontSize: 11,
    color: colors.tabMuted,
    textAlign: 'center',
  },
  bottomLabelActive: {
    color: colors.nearBlack,
    fontWeight: '700',
  },
  uploadNavSlot: {
    flex: 1,
    minWidth: 62,
    alignItems: 'center',
    marginTop: -36,
  },
  uploadNavButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.tealDeep,
    borderWidth: 5,
    borderColor: '#E9F1F8',
    shadowColor: colors.tealDeep,
    shadowOpacity: 0.28,
    shadowRadius: 14,
    elevation: 8,
  },
  uploadNavLabel: {
    marginTop: 4,
    fontSize: 11,
    fontWeight: '700',
    color: colors.tealDeep,
  },
  sheetBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.34)',
  },
  sheetOverlay: {
    flex: 1,
  },
  sheetCard: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 34,
    borderTopRightRadius: 34,
    paddingHorizontal: 26,
    paddingTop: 28,
    paddingBottom: 42,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    paddingVertical: 18,
  },
  sheetText: {
    fontSize: 20,
    color: colors.nearBlack,
  },
  captureActionSheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 34,
    borderTopRightRadius: 34,
    marginHorizontal: 22,
    marginBottom: 90,
    paddingHorizontal: 26,
    paddingTop: 18,
    paddingBottom: 26,
  },
  captureActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    paddingVertical: 20,
  },
  captureActionText: {
    fontSize: 19,
    color: colors.nearBlack,
  },
  captureActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 12,
    backgroundColor: colors.royalBlueDark,
    borderRadius: 22,
    paddingVertical: 18,
  },
  captureActionButtonText: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.white,
  },
  captureActionGhost: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  captureActionGhostText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.royalBlueDark,
  },
  vaultUploadBackdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    backgroundColor: 'rgba(7, 20, 48, 0.5)',
  },
  vaultUploadCard: {
    width: '100%',
    maxWidth: 360,
    alignItems: 'center',
    borderRadius: 28,
    paddingHorizontal: 28,
    paddingVertical: 30,
    backgroundColor: colors.white,
  },
  vaultUploadIcon: {
    width: 58,
    height: 58,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: colors.tealDeep,
  },
  vaultUploadTitle: {
    marginTop: 18,
    fontSize: 22,
    fontWeight: '800',
    color: colors.nearBlack,
  },
  vaultUploadStatus: {
    marginTop: 8,
    fontSize: 15,
    color: colors.mutedInk,
    textAlign: 'center',
  },
  valueSaveSpinner: {
    marginTop: 16,
  },
  vaultUploadTrack: {
    width: '100%',
    height: 10,
    marginTop: 24,
    overflow: 'hidden',
    borderRadius: 5,
    backgroundColor: '#DDE8EF',
  },
  vaultUploadFill: {
    height: '100%',
    borderRadius: 5,
    backgroundColor: colors.tealDeep,
  },
  vaultUploadPercent: {
    marginTop: 10,
    fontSize: 14,
    fontWeight: '700',
    color: colors.tealDeep,
  },
  captureReviewScreen: {
    flex: 1,
    backgroundColor: colors.white,
  },
  captureReviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 18,
  },
  captureReviewHeaderButton: {
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureReviewHeaderTitle: {
    flex: 1,
    fontSize: 20,
    fontWeight: '700',
    color: colors.nearBlack,
    marginLeft: 12,
  },
  captureReviewScroll: {
    flex: 1,
  },
  captureReviewScrollContent: {
    paddingBottom: 24,
  },
  captureReviewFieldButton: {
    paddingHorizontal: 24,
    paddingVertical: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#B8CCED',
  },
  captureReviewFieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 24,
    paddingVertical: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#B8CCED',
  },
  captureReviewFieldLabel: {
    fontSize: 16,
    color: colors.nearBlack,
  },
  captureReviewFieldValue: {
    fontSize: 16,
    color: colors.nearBlack,
  },
  captureReviewFieldValueRight: {
    fontSize: 16,
    color: colors.nearBlack,
    textAlign: 'right',
  },
  captureReviewTextField: {
    paddingHorizontal: 24,
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: '#B8CCED',
  },
  captureReviewPaymentMethod: {
    paddingHorizontal: 24,
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: '#B8CCED',
  },
  captureReviewPaymentMethodLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.royalBlueDark,
  },
  captureReviewPaymentMethodOptions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  captureReviewPaymentMethodOption: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#B8CCED',
    borderRadius: 10,
    backgroundColor: colors.white,
  },
  captureReviewPaymentMethodOptionActive: {
    borderColor: colors.royalBlueDark,
    backgroundColor: '#EAF1FC',
  },
  captureReviewPaymentMethodOptionText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.slate,
  },
  captureReviewPaymentMethodOptionTextActive: {
    color: colors.royalBlueDark,
  },
  captureReviewTextInput: {
    minHeight: 72,
    fontSize: 16,
    color: colors.nearBlack,
    textAlignVertical: 'top',
    padding: 0,
  },
  captureReviewSingleLineInput: {
    fontSize: 16,
    color: colors.nearBlack,
    padding: 0,
    marginTop: 10,
  },
  captureReviewSectionHeading: {
    paddingHorizontal: 24,
    paddingVertical: 14,
    fontSize: 14,
    fontWeight: '700',
    color: colors.royalBlueDark,
    backgroundColor: '#EAF1FC',
  },
  captureReviewFooter: {
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 20,
    backgroundColor: colors.white,
  },
  captureReviewSubmitButton: {
    borderRadius: 8,
    backgroundColor: colors.royalBlueDark,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 18,
  },
  captureReviewSubmitButtonDisabled: {
    opacity: 0.7,
  },
  captureReviewSubmitButtonText: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.white,
  },
  documentSheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 38,
    maxHeight: '92%',
  },
  documentSheetScroll: {
    flexGrow: 0,
  },
  documentSheetScrollContent: {
    paddingBottom: 8,
  },
  sheetDragHandleTouchArea: {
    alignSelf: 'stretch',
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  documentSheetHandle: {
    alignSelf: 'center',
    width: 52,
    height: 5,
    borderRadius: 999,
    backgroundColor: colors.softBlueGrey,
  },
  documentSheetTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.nearBlack,
  },
  documentSheetPreviewPanel: {
    marginBottom: 18,
  },
  documentSheetPreview: {
    width: '100%',
    height: 180,
    borderRadius: 18,
    backgroundColor: colors.band,
    overflow: 'hidden',
  },
  previewCarousel: {
    width: '100%',
  },
  previewCarouselFullScreen: {
    width: '100%',
    height: '88%',
  },
  previewCarouselPage: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  documentSheetPreviewActions: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  documentSheetPreviewHint: {
    fontSize: 13,
    color: colors.mutedText,
    flex: 1,
  },
  documentSheetPreviewLink: {
    paddingVertical: 4,
  },
  documentSheetPreviewLinkText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.royalBlueDark,
  },
  claimTotalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.royalBlueDark,
    paddingHorizontal: 18,
    paddingVertical: 15,
  },
  claimTotalLabel: {
    color: '#C8FAF1',
    fontSize: 14,
    fontWeight: '700',
  },
  claimTotalAmount: {
    color: colors.white,
    fontSize: 19,
    fontWeight: '800',
  },
  documentSheetMeta: {
    marginTop: 6,
    fontSize: 16,
    color: colors.mutedText,
  },
  documentSheetAmount: {
    marginTop: 18,
    fontSize: 22,
    fontWeight: '700',
    color: colors.royalBlueDark,
  },
  documentSheetStatus: {
    marginTop: 8,
    fontSize: 15,
    color: colors.mutedText,
  },
  archivedDocumentDetails: {
    marginTop: 20,
    borderWidth: 1,
    borderColor: colors.lightBorder,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: colors.white,
  },
  archivedDocumentDetailsHeading: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    fontSize: 17,
    fontWeight: '800',
    color: colors.nearBlack,
    backgroundColor: colors.band,
  },
  archivedDocumentDescription: {
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  archivedDocumentDescriptionValue: {
    fontSize: 16,
    color: colors.nearBlack,
    lineHeight: 23,
  },
  reviewEditor: {
    marginTop: 20,
    borderWidth: 1,
    borderColor: colors.lightBorder,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: colors.white,
  },
  reviewFieldButton: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.lightBorder,
  },
  reviewFieldRow: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.lightBorder,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  reviewTextField: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.lightBorder,
  },
  reviewFieldLabel: {
    fontSize: 14,
    color: colors.nearBlack,
    marginBottom: 8,
  },
  reviewFieldValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  reviewFieldValue: {
    flex: 1,
    fontSize: 16,
    color: colors.nearBlack,
    fontWeight: '500',
  },
  reviewTextInput: {
    minHeight: 72,
    fontSize: 16,
    color: colors.nearBlack,
    textAlignVertical: 'top',
    padding: 0,
  },
  reviewSingleLineInput: {
    fontSize: 16,
    color: colors.nearBlack,
    padding: 0,
  },
  reviewSectionHeading: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    fontSize: 14,
    fontWeight: '700',
    color: colors.nearBlack,
    backgroundColor: colors.band,
  },
  paymentMethodReviewNotice: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#FFF8E6',
    borderBottomWidth: 1,
    borderBottomColor: colors.lightBorder,
  },
  paymentMethodReviewNoticeText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: colors.nearBlack,
  },
  taxEditor: {
    marginTop: 18,
    borderWidth: 1,
    borderColor: colors.lightBorder,
    borderRadius: 16,
    padding: 12,
    backgroundColor: colors.white,
  },
  taxEditorRow: {
    flexDirection: 'row',
    gap: 8,
  },
  taxAmountField: {
    flex: 1,
  },
  taxAmountLabel: {
    marginBottom: 6,
    fontSize: 12,
    fontWeight: '700',
    color: colors.mutedText,
  },
  taxAmountInput: {
    borderWidth: 1,
    borderColor: colors.lightBorder,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    fontSize: 15,
    fontWeight: '700',
    color: colors.nearBlack,
  },
  taxDropdown: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.lightBorder,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  taxDropdownLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.mutedText,
  },
  taxDropdownValueWrap: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  taxDropdownValue: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.nearBlack,
  },
  taxDropdownMenu: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.lightBorder,
    borderRadius: 12,
    overflow: 'hidden',
  },
  taxDropdownOption: {
    paddingHorizontal: 12,
    paddingVertical: 11,
    backgroundColor: colors.white,
  },
  taxDropdownOptionActive: {
    backgroundColor: colors.band,
  },
  taxDropdownOptionText: {
    fontSize: 15,
    color: colors.nearBlack,
  },
  taxDropdownOptionTextActive: {
    fontWeight: '700',
    color: colors.royalBlueDark,
  },
  taxSaveButton: {
    marginTop: 12,
    borderRadius: 12,
    backgroundColor: colors.royalBlueDark,
    paddingVertical: 12,
    alignItems: 'center',
  },
  taxSaveButtonDisabled: {
    opacity: 0.65,
  },
  taxSaveButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.white,
  },
  categoryPickerSheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 24,
    maxHeight: '86%',
  },
  categoryPickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.lightBorder,
  },
  categoryPickerSearchInput: {
    flex: 1,
    fontSize: 18,
    color: colors.nearBlack,
    paddingVertical: 10,
  },
  categoryPickerCloseButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryPickerList: {
    marginTop: 8,
  },
  categoryPickerOption: {
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: colors.lightBorder,
  },
  categoryPickerOptionText: {
    fontSize: 18,
    color: colors.nearBlack,
  },
  documentSheetActions: {
    marginTop: 24,
    gap: 12,
  },
  previewFullscreenBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.94)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 32,
  },
  previewFullscreenClose: {
    position: 'absolute',
    top: 48,
    right: 22,
    zIndex: 2,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewFullscreenImage: {
    width: '100%',
    height: '100%',
  },
  sheetActionButton: {
    paddingVertical: 15,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.lightBorder,
    alignItems: 'center',
  },
  sheetActionPrimary: {
    backgroundColor: colors.royalBlueDark,
    borderColor: colors.royalBlueDark,
  },
  sheetActionDanger: {
    backgroundColor: '#FBE5E2',
    borderColor: '#F3C5BE',
  },
  sheetActionText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.nearBlack,
  },
  sheetActionPrimaryText: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.white,
  },
  sheetActionDangerText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#A43A2D',
  },
  captureSheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 36,
  },
  sectionTabs: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 22,
  },
  sectionTab: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 24,
    alignItems: 'center',
    backgroundColor: colors.band,
  },
  sectionTabActive: {
    backgroundColor: colors.royalBlueDark,
  },
  sectionTabText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.nearBlack,
  },
  sectionTabTextActive: {
    color: colors.white,
  },
  captureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.band,
  },
  captureRowText: {
    fontSize: 18,
    color: colors.nearBlack,
  },
  captureLoader: {
    marginTop: 20,
  },
  cameraShell: {
    flex: 1,
    backgroundColor: colors.nearBlack,
  },
  cameraView: {
    flex: 1,
  },
  cameraOverlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'space-between',
  },
  cameraTopBar: {
    paddingTop: 56,
    paddingHorizontal: 24,
  },
  cameraTopIcon: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraHintWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 120,
  },
  cameraText: {
    color: colors.white,
    fontSize: 16,
    backgroundColor: 'rgba(0,0,0,0.52)',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 12,
  },
  cameraBottomPanel: {
    backgroundColor: '#000000',
    paddingTop: 10,
    paddingBottom: Platform.OS === 'android' ? 42 : 28,
  },
  cameraModeRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 18,
    paddingBottom: 14,
  },
  cameraModeButton: {
    minWidth: 88,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  cameraModeText: {
    fontSize: 18,
    color: 'rgba(255,255,255,0.92)',
  },
  cameraModeTextActive: {
    color: '#E7C94F',
  },
  cameraActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    gap: 8,
  },
  cameraGalleryButton: {
    width: 52,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraShutter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 3,
    borderColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraShutterDisabled: {
    opacity: 0.5,
  },
  cameraShutterInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.white,
  },
  cameraTypeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minWidth: 86,
    minHeight: 56,
  },
  cameraTypeText: {
    fontSize: 18,
    color: colors.white,
  },
  cameraCombineActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 14,
    paddingTop: 14,
  },
  cameraCombineButton: {
    minWidth: 132,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: colors.white,
  },
  cameraCombineButtonDisabled: {
    opacity: 0.45,
  },
  cameraCombineButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.nearBlack,
  },
  cameraCombineClearButton: {
    minHeight: 44,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraCombineClearText: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.white,
  },
  shellDark: {
    backgroundColor: '#111827',
  },
  shellTextDark: {
    color: colors.white,
  },
  headerIconButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerNotificationDot: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#F59E0B',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  headerNotificationDotText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.nearBlack,
  },
  selectionDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.lightBorder,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  selectionDotActive: {
    backgroundColor: colors.royalBlueDark,
    borderColor: colors.royalBlueDark,
  },
  documentRowSelected: {
    borderColor: colors.royalBlueDark,
    borderWidth: 1,
  },
  headerMenuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(17,24,39,0.2)',
    alignItems: 'flex-end',
    paddingTop: 86,
    paddingRight: 18,
  },
  headerMenuCard: {
    width: 220,
    borderRadius: 18,
    backgroundColor: colors.white,
    paddingVertical: 8,
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  headerMenuRow: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  headerMenuText: {
    fontSize: 15,
    color: colors.nearBlack,
    fontWeight: '600',
  },
  headerMenuCaption: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 6,
    fontSize: 12,
    color: colors.mutedText,
    fontWeight: '700',
  },
  archiveScreen: {
    flex: 1,
    backgroundColor: colors.white,
  },
  archiveHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: colors.lightBorder,
  },
  archiveBackButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  archiveHeaderCopy: {
    flex: 1,
  },
  archiveTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.nearBlack,
  },
  archiveSubtitle: {
    marginTop: 4,
    fontSize: 16,
    color: colors.mutedText,
  },
  archiveContent: {
    paddingBottom: 32,
  },
  archiveEmptyState: {
    flex: 1,
    justifyContent: 'center',
  },
  archiveMonthHeader: {
    alignItems: 'flex-end',
    paddingHorizontal: 24,
    paddingTop: 22,
    paddingBottom: 10,
  },
  archiveMonthHeaderText: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.nearBlack,
  },
  archiveRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 24,
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: colors.lightBorder,
    gap: 14,
  },
  archiveRowMain: {
    flex: 1,
    gap: 8,
    paddingRight: 8,
  },
  archiveRowTitle: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '700',
    color: colors.nearBlack,
  },
  archiveRowAmount: {
    fontSize: 16,
    color: colors.mutedText,
  },
  archiveRowRight: {
    alignItems: 'flex-end',
    gap: 10,
  },
  archiveRowDate: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.slate,
  },
  panelSheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 22,
    paddingTop: 20,
    paddingBottom: 58,
    maxHeight: '82%',
  },
  panelSheetScrollContent: {
    paddingBottom: 58,
  },
  panelTitle: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '700',
    color: colors.nearBlack,
    marginBottom: 16,
  },
  panelSectionTitle: {
    marginTop: 10,
    marginBottom: 8,
    fontSize: 13,
    fontWeight: '700',
    color: colors.mutedText,
    textTransform: 'uppercase',
  },
  filterSheetScroll: {
    flexShrink: 1,
  },
  filterSheetContent: {
    paddingBottom: 8,
  },
  panelOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.band,
  },
  panelOptionText: {
    fontSize: 16,
    color: colors.nearBlack,
  },
  panelContent: {
    gap: 12,
  },
  panelMuted: {
    fontSize: 15,
    lineHeight: 24,
    color: colors.mutedText,
  },
  panelListRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.band,
  },
  panelListRowMain: {
    flex: 1,
    paddingRight: 12,
  },
  panelListTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.nearBlack,
  },
  panelListMeta: {
    marginTop: 4,
    fontSize: 14,
    color: colors.mutedText,
  },
  panelListTime: {
    fontSize: 13,
    color: colors.mutedText,
  },
  panelInput: {
    borderWidth: 1,
    borderColor: colors.lightBorder,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 16,
    color: colors.nearBlack,
    marginBottom: 12,
  },
  claimComposerCopy: {
    marginTop: -8,
    marginBottom: 14,
    fontSize: 15,
    lineHeight: 21,
    color: colors.mutedText,
  },
  claimComposerScroll: {
    flexShrink: 1,
  },
  claimComposerContent: {
    paddingBottom: 8,
  },
  claimComposerSelectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  claimComposerCount: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.royalBlueDark,
  },
  claimComposerDocumentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: colors.lightBorder,
    borderRadius: 14,
    marginBottom: 8,
  },
  claimComposerDocumentRowSelected: {
    borderColor: colors.dotMint,
    backgroundColor: '#EFFBF8',
  },
  claimComposerCheckbox: {
    width: 22,
    height: 22,
    borderWidth: 2,
    borderColor: colors.mutedText,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  claimComposerCheckboxSelected: {
    borderColor: colors.royalBlueDark,
    backgroundColor: colors.royalBlueDark,
  },
  claimComposerDocumentCopy: {
    flex: 1,
  },
  claimComposerDocumentTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.nearBlack,
  },
  claimComposerDocumentDate: {
    marginTop: 3,
    fontSize: 13,
    color: colors.mutedText,
  },
  claimComposerDocumentAmount: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.royalBlueDark,
  },
  claimComposerEmpty: {
    paddingVertical: 12,
    fontSize: 15,
    lineHeight: 21,
    color: colors.mutedText,
  },
  panelPrimaryButton: {
    marginTop: 6,
    borderRadius: 14,
    backgroundColor: colors.royalBlueDark,
    alignItems: 'center',
    paddingVertical: 14,
  },
  panelPrimaryButtonDisabled: {
    opacity: 0.45,
  },
  panelPrimaryButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.white,
  },
  tutorialBackdrop: { flex: 1, backgroundColor: 'rgba(9, 27, 71, 0.72)', justifyContent: 'center', padding: 26 },
  tutorialCard: { backgroundColor: colors.white, borderRadius: 28, padding: 26, alignItems: 'center' },
  tutorialIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.royalBlueDark, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  tutorialProgress: { fontSize: 13, fontWeight: '700', color: colors.mutedText, textTransform: 'uppercase', letterSpacing: 0.8 },
  tutorialTitle: { marginTop: 10, fontSize: 25, lineHeight: 31, fontWeight: '700', color: colors.nearBlack, textAlign: 'center' },
  tutorialCopy: { marginTop: 12, fontSize: 16, lineHeight: 23, color: colors.mutedText, textAlign: 'center' },
  tutorialDots: { flexDirection: 'row', gap: 7, marginTop: 24, marginBottom: 22 },
  tutorialDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.lightBorder },
  tutorialDotActive: { width: 22, backgroundColor: colors.dotMint },
  tutorialPrimary: { width: '100%', borderRadius: 14, backgroundColor: colors.royalBlueDark, paddingVertical: 15, alignItems: 'center' },
  tutorialPrimaryText: { color: colors.white, fontSize: 16, fontWeight: '700' },
  tutorialSkip: { marginTop: 15, padding: 6 },
  tutorialSkipText: { fontSize: 15, fontWeight: '700', color: colors.royalBlueDark },
  analyticsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  analyticsCard: {
    width: '47%',
    backgroundColor: colors.band,
    borderRadius: 16,
    padding: 16,
  },
  analyticsValue: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.nearBlack,
  },
  analyticsLabel: {
    marginTop: 6,
    fontSize: 13,
    color: colors.mutedText,
  },
  panelInlineActions: {
    flexDirection: 'row',
    gap: 12,
  },
  panelInlineActionText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.royalBlueDark,
  },
});
