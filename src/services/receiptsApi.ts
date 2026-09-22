import { type Claim, type ExpenseDocument, type PaymentMethod, type WorkspaceContext } from '../types';
import { getApiBaseUrl } from './auth';
import { requireSessionToken } from './session';

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

type ReceiptApiResponse = {
  success: true;
  receipts: Array<{
    id: number;
    organisationId: number;
    uploadedByUserId: number;
    uploadedByEmail?: string | null;
    workspaceContext: WorkspaceContext;
    paymentMethod: PaymentMethod;
    paymentMethodMatchState?: ExpenseDocument['paymentMethodMatchState'];
    paymentMethodReviewRequired?: boolean;
    matchedCompanyCardId?: number | null;
    claimId: number | null;
    mileageClaimId?: number | null;
    status: string | null;
    sourceFilename: string;
    s3Bucket: string;
    s3Key: string;
    documentType: 'receipt' | 'invoice' | 'unknown';
    vendorName: string | null;
    invoiceDate: string | null;
    dueDate: string | null;
    invoiceNumber: string | null;
    paymentCardLastFour?: string | null;
    paymentCardNetwork?: string | null;
    paymentCardIssuer?: string | null;
    currency: string | null;
    baseCurrency: string;
    baseTotalAmount: number | null;
    exchangeRate: number | null;
    exchangeRateDate: string | null;
    exchangeRateProvider: string | null;
    exchangeRateOverride: boolean;
    exchangeRateNote: string | null;
    totalAmount: number | null;
    netAmount: number | null;
    vatAmount: number | null;
    category: string | null;
    description: string | null;
    customer: string | null;
    taxRateApplied: ExpenseDocument['taxRateApplied'] | null;
    totalTaxAmount: number | null;
    foreignTaxAmount: number | null;
    foreignTaxLabel: string | null;
    ukVatTreatment: ExpenseDocument['ukVatTreatment'] | null;
    reimbursementBatchId: string | null;
    reimbursementBatchCreatedAt: string | null;
    needsReview: boolean;
    confidenceScore: number | null;
    lineItems: NonNullable<ExpenseDocument['lineItems']>;
    taxBreakdown: NonNullable<ExpenseDocument['taxBreakdown']>;
    notes: string[];
    createdAt: string;
    updatedAt: string;
  }>;
};

type ClaimApiResponse = {
  success: true;
  claims: Array<{
    id: number;
    name: string;
    description: string | null;
    status: 'pending' | 'approved' | 'paid' | 'rejected';
    totalAmount: number;
    documentCount: number;
    currency: string;
    createdByUserId: number;
    createdAt: string;
    claimType?: 'standard' | 'mileage';
    mileageStartPostcode?: string | null;
    mileageEndPostcode?: string | null;
    mileageTotalMiles?: number | null;
    mileageRate?: number | null;
  }>;
};

export type MobileSalesWorkspace = {
  customers: Array<{ id: string; name: string; email: string | null; paymentTermsDays: number; active: boolean }>;
  documents: Array<{ id: string; kind: 'invoice' | 'quote' | 'credit_note'; number: string; customerName: string; issueDate: string; currency: string; status: string; total: number; paidAmount: number; outstandingAmount: number }>;
  submissions: Array<{ id: string; channel: string; sourceFilename: string; status: string; receiptIds: number[]; createdAt: string }>;
  submissionAddress: { address: string };
};

export async function fetchSalesWorkspace(): Promise<MobileSalesWorkspace> {
  const token = requireSessionToken();
  const response = await fetch(`${getApiBaseUrl()}/sales-workspace`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json() as MobileSalesWorkspace & { success?: boolean; message?: string };
  if (!response.ok) throw new Error(data.message || 'Could not load the Sales workspace.');
  return data;
}

export async function fetchCloudReceipts(workspaceContext?: WorkspaceContext, limit = 200, includeMileageCosts = false) {
  const token = requireSessionToken();
  const searchParams = new URLSearchParams();
  if (workspaceContext) {
    searchParams.set('workspace_context', workspaceContext);
  }
  // The API permits up to 200 records. The old implicit 50-record limit meant
  // older receipts simply never reached the phone, even after a successful sync.
  searchParams.set('limit', String(Math.min(Math.max(limit, 1), 200)));
  if (includeMileageCosts && workspaceContext === 'cost') {
    searchParams.set('include_mileage_costs', 'true');
  }
  const response = await fetch(`${getApiBaseUrl()}/receipts${searchParams.size ? `?${searchParams.toString()}` : ''}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const data = (await response.json()) as ReceiptApiResponse | { success: false; message?: string };
  if (!response.ok || !('success' in data) || data.success !== true) {
    throw new Error('message' in data && typeof data.message === 'string' ? data.message : 'Could not load cloud receipts.');
  }

  return data.receipts.map(mapReceiptToDocument);
}

export async function fetchClaimableReceipts() {
  const token = requireSessionToken();
  const response = await fetch(`${getApiBaseUrl()}/receipts?workspace_context=cost&only_claimable=true`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const data = (await response.json()) as ReceiptApiResponse | { success: false; message?: string };
  if (!response.ok || !('success' in data) || data.success !== true) {
    throw new Error('message' in data && typeof data.message === 'string' ? data.message : 'Could not load claimable receipts.');
  }

  return data.receipts.map(mapReceiptToDocument);
}

export async function fetchExpenseClaims() {
  const token = requireSessionToken();
  const response = await fetch(`${getApiBaseUrl()}/claims`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const data = (await response.json()) as ClaimApiResponse | { success: false; message?: string };
  if (!response.ok || !('success' in data) || data.success !== true) {
    throw new Error('message' in data && typeof data.message === 'string' ? data.message : 'Could not load expense claims.');
  }

  return data.claims.map(
    (claim): Claim => ({
      id: `claim-${claim.id}`,
      cloudClaimId: claim.id,
      name: claim.name,
      description: claim.description ?? undefined,
      status: claim.status,
      total: claim.totalAmount,
      currency: claim.currency,
      documentIds: [],
      documentCount: claim.documentCount,
      trip: claim.description ?? 'Expense claim',
      owner: `User ${claim.createdByUserId}`,
      submittedOn: claim.createdAt,
      claimType: claim.claimType,
      mileageStartPostcode: claim.mileageStartPostcode ?? undefined,
      mileageEndPostcode: claim.mileageEndPostcode ?? undefined,
      mileageTotalMiles: claim.mileageTotalMiles ?? undefined,
      mileageRate: claim.mileageRate ?? undefined,
    }),
  );
}

export async function createCloudClaim(input: {
  name: string;
  description?: string;
  currency?: string;
  claimType?: 'standard' | 'mileage';
  startPostcode?: string;
  endPostcode?: string;
  totalMiles?: number;
  mileageRate?: number;
}) {
  const token = requireSessionToken();
  const response = await fetch(`${getApiBaseUrl()}/claims`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  const data = (await response.json()) as
    | { success: true; claim: ClaimApiResponse['claims'][number] }
    | { success: false; message?: string };
  if (!response.ok || !('success' in data) || data.success !== true) {
    throw new Error('message' in data && typeof data.message === 'string' ? data.message : 'Could not create expense claim.');
  }

  return data.claim;
}

export async function addCloudMileageProof(claimId: number, asset: { uri: string; fileName?: string | null; mimeType?: string | null }) {
  const token = requireSessionToken();
  const base64 = await (await import('expo-file-system/legacy')).readAsStringAsync(asset.uri, { encoding: 'base64' });
  const mimeType = asset.mimeType === 'image/png' || asset.mimeType === 'image/webp' ? asset.mimeType : 'image/jpeg';
  const response = await fetch(`${getApiBaseUrl()}/claims/${claimId}/evidence`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: asset.fileName || `journey-proof-${Date.now()}.jpg`, mimeType, base64 }),
  });
  const data = (await response.json()) as { success?: boolean; message?: string };
  if (!response.ok || data.success === false) {
    throw new Error(typeof data.message === 'string' ? data.message : 'Could not upload journey proof.');
  }
}

export async function attachCloudReceiptToClaim(input: { receiptId: number; claimId: number }) {
  const token = requireSessionToken();
  const response = await fetch(`${getApiBaseUrl()}/claims/attach`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  const data = (await response.json()) as { success: true } | { success: false; message?: string };
  if (!response.ok || !('success' in data) || data.success !== true) {
    throw new Error('message' in data && typeof data.message === 'string' ? data.message : 'Could not attach receipt to expense claim.');
  }
}

export async function deleteCloudReceipt(receiptId: number) {
  const token = requireSessionToken();
  const response = await fetch(`${getApiBaseUrl()}/receipts/${receiptId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 204) {
    return;
  }

  // Deletion is idempotent from the app's point of view. A cached purchase can
  // outlive its server record, so "not found" means there is nothing left to
  // delete remotely and the local tombstone can safely be applied.
  if (response.status === 404) {
    return;
  }

  const data = (await response.json()) as { success?: boolean; message?: string };
  if (!response.ok || data.success === false) {
    throw new Error(typeof data.message === 'string' ? data.message : 'Could not delete this receipt.');
  }
}

export async function deleteCloudClaim(claimId: number) {
  const token = requireSessionToken();
  const response = await fetch(`${getApiBaseUrl()}/claims/${claimId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await response.json()) as { success?: boolean; message?: string };
  if (!response.ok || data.success === false) {
    throw new Error(typeof data.message === 'string' ? data.message : 'Could not delete this expense claim.');
  }
}

export async function updateCloudReceipt(
  receiptId: number,
  updates: Partial<
    Pick<
      ExpenseDocument,
      'workspaceContext' | 'supplier' | 'date' | 'dueDate' | 'invoiceNumber' | 'category' | 'description' | 'customer' | 'paymentMethod' | 'netAmount' | 'vatAmount' | 'amount' | 'currency' | 'taxRateApplied' | 'status'
    >
  >,
) {
  const token = requireSessionToken();
  const response = await fetch(`${getApiBaseUrl()}/receipts/${receiptId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      vendorName: updates.supplier,
      invoiceDate: updates.date,
      dueDate: updates.dueDate,
      invoiceNumber: updates.invoiceNumber,
      category: updates.category,
      description: updates.description,
      customer: updates.customer,
      paymentMethod: updates.paymentMethod,
      netAmount: updates.netAmount,
      vatAmount: updates.vatAmount,
      totalAmount: updates.amount,
      currency: updates.currency,
      taxRateApplied: updates.taxRateApplied,
      status: updates.workspaceContext === 'sales' ? mapSalesStatusForApi(updates.status) : updates.status,
    }),
  });

  const data = (await response.json()) as { success?: boolean; message?: string };
  if (!response.ok || data.success === false) {
    throw new Error(typeof data.message === 'string' ? data.message : 'Could not update this receipt.');
  }
}

export async function fetchCloudReceiptAssetUrl(receiptId: number) {
  const token = requireSessionToken();
  const response = await fetch(`${getApiBaseUrl()}/receipts/${receiptId}/asset-url`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const data = (await response.json()) as
    | {
        success: true;
        asset?: {
          downloadUrl?: string;
        };
      }
    | { success: false; message?: string };

  if (!response.ok || !('success' in data) || data.success !== true || !data.asset?.downloadUrl) {
    throw new Error(
      'message' in data && typeof data.message === 'string'
        ? data.message
        : 'Could not load the receipt image.',
    );
  }

  return data.asset.downloadUrl;
}

function mapReceiptToDocument(receipt: ReceiptApiResponse['receipts'][number]): ExpenseDocument {
  const status = mapCloudReceiptStatus(receipt.status, receipt.workspaceContext);
  return {
    id: `cloud-${receipt.id}`,
    type: receipt.documentType === 'invoice' ? 'invoice' : 'receipt',
    workspaceContext: receipt.workspaceContext,
    paymentMethod: receipt.paymentMethod,
    paymentMethodMatchState: receipt.paymentMethodMatchState ?? 'not_detected',
    paymentMethodReviewRequired: receipt.paymentMethodReviewRequired ?? false,
    matchedCompanyCardId: receipt.matchedCompanyCardId ?? null,
    title: receipt.vendorName || receipt.sourceFilename.replace(/\.[^/.]+$/, ''),
    supplier: receipt.vendorName || 'Merchant to review',
    amount: resolveDocumentAmount({
      amount: receipt.totalAmount,
      netAmount: receipt.netAmount,
      vatAmount: receipt.vatAmount,
      taxAmount: receipt.totalTaxAmount,
    }),
    netAmount: receipt.netAmount ?? receipt.totalAmount ?? 0,
    vatAmount: receipt.vatAmount ?? receipt.totalTaxAmount ?? 0,
    taxRateApplied: receipt.taxRateApplied ?? 'No VAT',
    taxAmount: receipt.totalTaxAmount ?? 0,
    foreignTaxAmount: receipt.foreignTaxAmount,
    foreignTaxLabel: receipt.foreignTaxLabel,
    ukVatTreatment: receipt.ukVatTreatment ?? undefined,
    reimbursementBatchId: receipt.reimbursementBatchId,
    reimbursementBatchCreatedAt: receipt.reimbursementBatchCreatedAt,
    currency: receipt.currency ?? 'GBP',
    baseCurrency: receipt.baseCurrency ?? 'GBP',
    baseAmount: receipt.baseTotalAmount,
    exchangeRate: receipt.exchangeRate,
    exchangeRateDate: receipt.exchangeRateDate,
    exchangeRateProvider: receipt.exchangeRateProvider,
    exchangeRateOverride: receipt.exchangeRateOverride,
    exchangeRateNote: receipt.exchangeRateNote,
    status,
    category: receipt.category ?? (receipt.documentType === 'invoice' ? 'Accounts Payable' : 'General'),
    description: receipt.description ?? '',
    customer: receipt.customer ?? '',
    date: receipt.invoiceDate ?? receipt.createdAt,
    dueDate: receipt.dueDate ?? undefined,
    invoiceNumber: receipt.invoiceNumber ?? undefined,
    paymentCardLastFour: receipt.paymentCardLastFour ?? null,
    paymentCardNetwork: receipt.paymentCardNetwork ?? null,
    paymentCardIssuer: receipt.paymentCardIssuer ?? null,
    notes: receipt.notes.join(' ') || 'Imported from your cloud receipts.',
    tags: [receipt.documentType, 'cloud'],
    fileName: receipt.sourceFilename,
    source: 'files',
    claimId: receipt.claimId === null ? undefined : `claim-${receipt.claimId}`,
    mileageClaimId: receipt.mileageClaimId ?? undefined,
    cloudReceiptId: receipt.id,
    uploadedByUserId: receipt.uploadedByUserId,
    uploadedByEmail: receipt.uploadedByEmail ?? null,
    storageKey: receipt.s3Key,
    storageBucket: receipt.s3Bucket,
    extractionStatus: 'complete',
    extractionSource: 'backend_proxy',
    confidenceScore: receipt.confidenceScore,
    needsReview: receipt.needsReview,
    lineItems: receipt.lineItems,
    taxBreakdown: receipt.taxBreakdown,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt ?? receipt.createdAt,
  };
}

function mapCloudReceiptStatus(status: string | null | undefined, workspaceContext?: WorkspaceContext): ExpenseDocument['status'] {
  const normalized = (status ?? '').trim().toLowerCase();
  if (normalized === 'ready' || normalized === 'ready_to_submit' || normalized === 'reviewed') {
    return 'ready_to_submit';
  }
  if (workspaceContext === 'cost' && normalized === 'published') {
    return 'ready_to_submit';
  }
  if (normalized === 'submitted' || (workspaceContext === 'sales' && normalized === 'published')) {
    return 'submitted';
  }
  if (normalized === 'payment processing' || normalized === 'payment_processing') {
    return 'payment_processing';
  }
  if (normalized === 'paid') {
    return 'paid';
  }
  return 'awaiting_review';
}

function mapSalesStatusForApi(status: ExpenseDocument['status'] | undefined) {
  if (status === 'ready_to_submit') return 'Ready';
  if (status === 'submitted') return 'Published';
  if (status === 'paid') return 'Paid';
  if (status === 'awaiting_review') return 'Review';
  return status;
}
