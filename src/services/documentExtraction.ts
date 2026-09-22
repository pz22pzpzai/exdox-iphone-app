import * as FileSystem from 'expo-file-system/legacy';

import { DocumentKind, ExpenseDocument, PaymentMethod, WorkspaceContext } from '../types';
import { prepareDocumentUpload } from '../utils/uploadAsset';
import { requireSessionToken } from './session';

const API_URL =
  process.env.EXPO_PUBLIC_EXPENSES_API_URL?.trim() ||
  'https://hz2zkm6jkf.execute-api.eu-west-2.amazonaws.com/prod/api/v1/expenses/process';

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

export interface ExtractedDocumentDraft {
  supplier: string;
  amount: number;
  netAmount: number;
  vatAmount: number;
  taxRateApplied: ExpenseDocument['taxRateApplied'];
  taxAmount: number;
  currency: string;
  baseCurrency?: string;
  baseAmount?: number | null;
  exchangeRate?: number | null;
  exchangeRateDate?: string | null;
  exchangeRateProvider?: string | null;
  category: string;
  description?: string;
  customer?: string;
  date?: string;
  notes: string;
  dueDate?: string;
  invoiceNumber?: string;
  extractionSource: ExpenseDocument['extractionSource'];
  confidenceScore?: number | null;
  needsReview?: boolean;
  lineItems?: ExpenseDocument['lineItems'];
  taxBreakdown?: ExpenseDocument['taxBreakdown'];
  cloudReceiptId?: number;
  storageKey?: string;
  storageBucket?: string;
  workspaceContext?: WorkspaceContext;
  paymentMethod?: PaymentMethod;
  extractionOutcome?: 'pending' | 'complete' | 'failed';
}

export interface DocumentExtractionService {
  extractFromAsset(input: {
    type: DocumentKind;
    fileName: string;
    uri?: string;
    lowResolution?: boolean;
    source?: ExpenseDocument['source'];
    workspaceContext: WorkspaceContext;
    paymentMethod: PaymentMethod;
    skipProcessing?: boolean;
  }): Promise<ExtractedDocumentDraft>;
}

class LocalMockExtractionService implements DocumentExtractionService {
  async extractFromAsset({
    type,
    fileName,
    uri,
    lowResolution,
    source,
    workspaceContext,
    paymentMethod,
    skipProcessing,
    }: {
    type: DocumentKind;
    fileName: string;
    uri?: string;
    lowResolution?: boolean;
    source?: ExpenseDocument['source'];
    workspaceContext: WorkspaceContext;
    paymentMethod: PaymentMethod;
    skipProcessing?: boolean;
    }): Promise<ExtractedDocumentDraft> {
    if (!uri) {
      return buildFallbackDraft(type, fileName, 'No file URI was available for upload.');
    }

    try {
      const prepared = await prepareDocumentUpload({
        uri,
        fileName,
        lowResolution: Boolean(lowResolution),
        source,
      });
      const token = requireSessionToken();

      const response = await FileSystem.uploadAsync(API_URL, prepared.uri, {
        fieldName: 'file',
        httpMethod: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        mimeType: prepared.mimeType,
        parameters: {
          locale: 'en-GB',
          extract_line_items: 'true',
          document_type: type,
          workspace_context: workspaceContext,
          payment_method: paymentMethod,
          skip_processing: skipProcessing ? 'true' : 'false',
        },
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      });

      const payload = JSON.parse(response.body) as ExpenseApiResponse | ExpenseApiError;
      if (response.status < 200 || response.status >= 300 || !('success' in payload) || payload.success !== true) {
        if ('error' in payload && payload.error === 'duplicate_receipt') {
          return buildDuplicateDraft(type, fileName);
        }
        throw new Error(
          'message' in payload && typeof payload.message === 'string'
            ? payload.message
            : 'Receipt processing failed.',
        );
      }

      if (shouldTreatPayloadAsUnreadable(payload.document)) {
        return {
          ...buildFallbackDraft(type, fileName, 'Unable to read receipt, tap to enter manually or retry uploading receipt'),
          cloudReceiptId: payload.receiptId,
          storageKey: payload.storage.key,
          storageBucket: payload.storage.bucket,
          workspaceContext: payload.workspaceContext,
          paymentMethod: payload.options.paymentMethod,
          extractionOutcome: 'failed',
        };
      }

      return {
        supplier: payload.document.vendorName ?? formatNameFallback(fileName, type),
        amount: resolveDocumentAmount({
          amount: payload.document.totalAmount,
          netAmount: payload.document.netAmount ?? payload.document.subtotalAmount,
          vatAmount: payload.document.vatAmount,
          taxAmount: payload.document.totalTaxAmount,
        }),
        netAmount: payload.document.netAmount ?? payload.document.subtotalAmount ?? payload.document.totalAmount ?? 0,
        vatAmount: payload.document.vatAmount ?? payload.document.totalTaxAmount ?? 0,
        taxRateApplied: payload.document.taxRateApplied ?? 'No VAT',
        taxAmount: payload.document.totalTaxAmount ?? 0,
        currency: payload.document.currency ?? 'GBP',
        baseCurrency: payload.document.baseCurrency ?? 'GBP',
        baseAmount: payload.document.baseTotalAmount,
        exchangeRate: payload.document.exchangeRate,
        exchangeRateDate: payload.document.exchangeRateDate,
        exchangeRateProvider: payload.document.exchangeRateProvider,
        category: type === 'invoice' ? 'Accounts Payable' : 'General',
        date: payload.document.invoiceDate ?? undefined,
        notes: payload.document.notes.join(' ') || 'Processed through the secure expenses proxy.',
        dueDate: payload.document.dueDate ?? undefined,
        invoiceNumber: payload.document.invoiceNumber ?? undefined,
        extractionSource: 'backend_proxy',
        confidenceScore: payload.document.confidenceScore,
        needsReview: payload.document.needsReview,
        lineItems: payload.document.lineItems,
        taxBreakdown: payload.document.taxBreakdown,
        cloudReceiptId: payload.receiptId,
        storageKey: payload.storage.key,
        storageBucket: payload.storage.bucket,
        workspaceContext: payload.workspaceContext,
        paymentMethod: payload.options.paymentMethod,
        extractionOutcome: 'complete',
      };
    } catch (error) {
      console.error('document extraction failed', error);
      const message = error instanceof Error ? error.message : String(error);
      if (looksLikeDuplicateReceiptMessage(message)) {
        return buildDuplicateDraft(type, fileName);
      }
      if (looksLikeUnreadableReceiptMessage(message)) {
        return buildFallbackDraft(type, fileName, 'Unable to read receipt, tap to enter manually or retry uploading receipt');
      }

      return buildPendingDraft(type, fileName);
    }
  }
}

export const documentExtractionService: DocumentExtractionService = new LocalMockExtractionService();

type ExpenseApiResponse = {
  success: true;
  receiptId: number;
  workspaceContext: WorkspaceContext;
  storage: {
    bucket: string;
    key: string;
  };
  options: {
    paymentMethod: PaymentMethod;
  };
  document: {
    vendorName: string | null;
    invoiceDate: string | null;
    dueDate: string | null;
    invoiceNumber: string | null;
    currency: string | null;
    baseCurrency?: string | null;
    baseTotalAmount?: number | null;
    exchangeRate?: number | null;
    exchangeRateDate?: string | null;
    exchangeRateProvider?: string | null;
    totalAmount: number | null;
    netAmount: number | null;
    vatAmount: number | null;
    taxRateApplied: ExpenseDocument['taxRateApplied'] | null;
    subtotalAmount: number | null;
    totalTaxAmount: number | null;
    confidenceScore: number | null;
    needsReview: boolean;
    notes: string[];
    lineItems: NonNullable<ExpenseDocument['lineItems']>;
    taxBreakdown: NonNullable<ExpenseDocument['taxBreakdown']>;
  };
};

type ExpenseApiError = {
  success: false;
  error?: string;
  message?: string;
};

function shouldTreatPayloadAsUnreadable(document: ExpenseApiResponse['document']) {
  const noteText = document.notes.join(' ').toLowerCase();
  if (
    /could not read receipt|could not read invoice|could not read amount|unable to read receipt|unable to read invoice|unable to read amount|blank image|blank file|no receipt visible|no invoice visible|not clearly visible/.test(
      noteText,
    )
  ) {
    return true;
  }

  return (
    document.vendorName === null &&
    document.totalAmount !== null &&
    document.confidenceScore !== null &&
    document.confidenceScore < 0.55 &&
    !document.invoiceNumber &&
    !document.dueDate &&
    document.lineItems.length === 0 &&
    document.taxBreakdown.length === 0
  );
}

function buildFallbackDraft(type: DocumentKind, fileName: string, notes: string): ExtractedDocumentDraft {
  return {
    supplier: formatNameFallback(fileName, type),
    amount: 0,
    netAmount: 0,
    vatAmount: 0,
    taxRateApplied: 'No VAT',
    taxAmount: 0,
    currency: 'GBP',
    category: type === 'invoice' ? 'Accounts Payable' : 'General',
    notes,
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

function buildPendingDraft(type: DocumentKind, fileName: string): ExtractedDocumentDraft {
  return {
    supplier: formatNameFallback(fileName, type),
    amount: 0,
    netAmount: 0,
    vatAmount: 0,
    taxRateApplied: 'No VAT',
    taxAmount: 0,
    currency: 'GBP',
    category: type === 'invoice' ? 'Accounts Payable' : 'General',
    notes: 'Receipt upload is still processing. Waiting for the finished result.',
    dueDate:
      type === 'invoice'
        ? new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString()
        : undefined,
    invoiceNumber: type === 'invoice' ? `INV-${Date.now().toString().slice(-5)}` : undefined,
    extractionSource: 'backend_proxy',
    confidenceScore: null,
    needsReview: true,
    lineItems: [],
    taxBreakdown: [],
    extractionOutcome: 'pending',
  };
}

function buildDuplicateDraft(type: DocumentKind, fileName: string): ExtractedDocumentDraft {
  return {
    supplier: formatNameFallback(fileName, type),
    amount: 0,
    netAmount: 0,
    vatAmount: 0,
    taxRateApplied: 'No VAT',
    taxAmount: 0,
    currency: 'GBP',
    category: type === 'invoice' ? 'Accounts Payable' : 'General',
    notes: 'Error: This is a duplicate',
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

function looksLikeDuplicateReceiptMessage(message: string) {
  return /error:\s*duplicate|duplicate receipt/.test(message.toLowerCase());
}

function looksLikeUnreadableReceiptMessage(message: string) {
  return /could not read receipt|could not read invoice|could not read amount|unable to read receipt|unable to read invoice|unable to read amount|blank image|blank file|no receipt visible|no invoice visible|not clearly visible/.test(
    message.toLowerCase(),
  );
}

function formatNameFallback(fileName: string, type: DocumentKind) {
  const stem = fileName.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ').trim() || 'Uploaded document';
  const normalizedStem = stem.replace(/\b\w/g, (char) => char.toUpperCase());
  return type === 'invoice' ? `${normalizedStem} Supplier` : normalizedStem;
}
