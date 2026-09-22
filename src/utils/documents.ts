import * as FileSystem from 'expo-file-system/legacy';

import { DocumentKind, ExpenseDocument, PaymentMethod, WorkspaceContext } from '../types';
import { documentExtractionService, type ExtractedDocumentDraft } from '../services/documentExtraction';

const documentDirectory = FileSystem.documentDirectory ?? undefined;

const formatTitle = (name: string) =>
  name
    .replace(/\.[^/.]+$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || 'New Upload';

const formatCurrencyAmount = () => 0;

export const extractionLooksUnreadable = (input: {
  amount?: number | null;
  notes?: string | null;
  needsReview?: boolean;
  confidenceScore?: number | null;
  supplier?: string | null;
  lineItems?: Array<unknown> | null;
  taxBreakdown?: Array<unknown> | null;
}) => {
  const noteText = (input.notes ?? '').toLowerCase();
  if (
    input.needsReview === true &&
    (input.amount ?? 0) === 0 &&
    /could not read receipt|could not read invoice|could not read amount|unable to read receipt|unable to read invoice|unable to read amount|blank image|blank file|no receipt visible|no invoice visible|not clearly visible/.test(
      noteText,
    )
  ) {
    return true;
  }

  return (
    input.needsReview === true &&
    (input.amount ?? 0) === 0 &&
    (input.confidenceScore ?? 1) < 0.55 &&
    !(input.supplier ?? '').trim() &&
    (input.lineItems?.length ?? 0) === 0 &&
    (input.taxBreakdown?.length ?? 0) === 0
  );
};

export const buildDraftDocument = async ({
  fileName,
  source,
  type,
  uri,
  lowResolution = false,
  workspaceContext,
  paymentMethod,
}: {
  fileName: string;
  source: ExpenseDocument['source'];
  type: DocumentKind;
  uri?: string;
  lowResolution?: boolean;
  workspaceContext: WorkspaceContext;
  paymentMethod: PaymentMethod;
}): Promise<ExpenseDocument> => {
  const id = `doc-${Date.now()}`;
  const title = formatTitle(fileName);
  const storedUri = uri ? await persistAsset(id, fileName, uri, source) : undefined;
  const now = new Date().toISOString();
  const extracted = await extractDraftSafely({
    type,
    fileName,
    uri: storedUri,
    lowResolution,
    source,
    workspaceContext,
    paymentMethod,
  });

  return {
    id,
    type,
    workspaceContext,
    paymentMethod,
    title: extracted.supplier || title,
    supplier: extracted.supplier,
    amount: extracted.amount ?? formatCurrencyAmount(),
    netAmount: extracted.netAmount ?? extracted.amount ?? 0,
    vatAmount: extracted.vatAmount ?? extracted.taxAmount ?? 0,
    taxRateApplied: extracted.taxRateApplied ?? ('No VAT' as ExpenseDocument['taxRateApplied']),
    taxAmount: extracted.taxAmount,
    currency: extracted.currency,
    status: 'awaiting_review',
    category: extracted.category,
    description: extracted.description ?? '',
    customer: extracted.customer ?? '',
    date: extracted.date ?? now,
    dueDate: extracted.dueDate,
    invoiceNumber: extracted.invoiceNumber,
    notes: extracted.notes,
    tags: [type, 'draft'],
    fileUri: storedUri,
    fileName,
    source,
    extractionStatus:
      extracted.extractionOutcome ??
      (extracted.extractionSource === 'backend_proxy' && !extractionLooksUnreadable(extracted) ? 'complete' : 'failed'),
    extractionSource: extracted.extractionSource,
    confidenceScore: extracted.confidenceScore ?? null,
    needsReview: extracted.needsReview ?? true,
    lineItems: extracted.lineItems ?? [],
    taxBreakdown: extracted.taxBreakdown ?? [],
    createdAt: now,
    updatedAt: now,
  };
};

const extractDraftSafely = async ({
  type,
  fileName,
  uri,
  lowResolution,
  source,
  workspaceContext,
  paymentMethod,
}: {
  type: DocumentKind;
  fileName: string;
  uri?: string;
  lowResolution?: boolean;
  source: ExpenseDocument['source'];
  workspaceContext: WorkspaceContext;
  paymentMethod: PaymentMethod;
}): Promise<ExtractedDocumentDraft> => {
  if (source === 'camera') {
    return {
      supplier: type === 'invoice' ? 'Supplier to review' : 'Merchant to review',
      amount: formatCurrencyAmount(),
      netAmount: 0,
      vatAmount: 0,
      taxRateApplied: 'No VAT',
      taxAmount: 0,
      currency: 'GBP',
      category: type === 'invoice' ? 'Accounts Payable' : 'General',
      description: '',
      customer: '',
      notes: 'Captured with camera and saved for manual review.',
      dueDate:
        type === 'invoice'
          ? new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString()
          : undefined,
      invoiceNumber: type === 'invoice' ? `INV-${Date.now().toString().slice(-5)}` : undefined,
      extractionSource: 'fallback_review' as const,
      confidenceScore: null,
      needsReview: true,
      lineItems: [],
      taxBreakdown: [],
    };
  }

  try {
    return await documentExtractionService.extractFromAsset({
      type,
      fileName,
      uri,
      lowResolution,
      source,
      workspaceContext,
      paymentMethod,
      skipProcessing: false,
    });
  } catch {
    return {
      supplier: type === 'invoice' ? 'Supplier to review' : 'Merchant to review',
      amount: formatCurrencyAmount(),
      netAmount: 0,
      vatAmount: 0,
      taxRateApplied: 'No VAT',
      taxAmount: 0,
      currency: 'GBP',
      category: type === 'invoice' ? 'Accounts Payable' : 'General',
      description: '',
      customer: '',
      notes: 'Imported for manual review because automatic extraction is unavailable.',
      dueDate:
        type === 'invoice'
          ? new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString()
          : undefined,
      invoiceNumber: type === 'invoice' ? `INV-${Date.now().toString().slice(-5)}` : undefined,
      extractionSource: 'fallback_review' as const,
      confidenceScore: null,
      needsReview: true,
      lineItems: [],
      taxBreakdown: [],
    };
  }
};

const persistAsset = async (
  id: string,
  fileName: string,
  uri: string,
  source: ExpenseDocument['source'],
) => {
  if (source === 'camera') {
    return uri;
  }

  if (!documentDirectory) {
    return uri;
  }

  const extension = fileName.includes('.') ? fileName.split('.').pop() : 'jpg';
  const safeExtension = extension ? extension.replace(/[^a-zA-Z0-9]/g, '') : 'jpg';
  const nextUri = `${documentDirectory}${id}.${safeExtension}`;

  try {
    await FileSystem.copyAsync({
      from: uri,
      to: nextUri,
    });
    return nextUri;
  } catch {
    return uri;
  }
};
