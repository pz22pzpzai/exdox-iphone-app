export type DocumentKind = 'receipt' | 'invoice';
export type WorkspaceContext = 'cost' | 'sales' | 'vault';
export type PaymentMethod = 'business_card' | 'cash_personal' | 'bank_transfer' | 'not_applicable';
export type PaymentMethodMatchState =
  | 'not_detected'
  | 'personal'
  | 'company_card'
  | 'employee_review'
  | 'employee_exception';
export type UkTaxRate = '20% Standard' | '5% Reduced' | '0% Zero' | 'Exempt' | 'No VAT';

export type DocumentStatus =
  | 'awaiting_review'
  | 'ready_to_submit'
  | 'submitted'
  | 'payment_processing'
  | 'paid';

export type ExtractionStatus = 'pending' | 'complete' | 'failed';

export type ClaimStatus = 'pending' | 'approved' | 'paid' | 'rejected';

export type TabKey = 'home' | 'documents' | 'claims' | 'settings';

export interface ExpenseDocument {
  id: string;
  type: DocumentKind;
  workspaceContext: WorkspaceContext;
  paymentMethod: PaymentMethod;
  paymentMethodMatchState?: PaymentMethodMatchState;
  paymentMethodReviewRequired?: boolean;
  matchedCompanyCardId?: number | null;
  paymentCardLastFour?: string | null;
  paymentCardNetwork?: string | null;
  paymentCardIssuer?: string | null;
  title: string;
  supplier: string;
  amount: number;
  netAmount: number;
  vatAmount: number;
  taxRateApplied: UkTaxRate;
  taxAmount: number;
  foreignTaxAmount?: number | null;
  foreignTaxLabel?: string | null;
  ukVatTreatment?:
    | 'not_applicable'
    | 'no_uk_vat_to_reclaim'
    | 'uk_vat_included'
    | 'reverse_charge_required'
    | 'import_vat'
    | 'accountant_review';
  reimbursementBatchId?: string | null;
  reimbursementBatchCreatedAt?: string | null;
  currency: string;
  baseCurrency?: string;
  baseAmount?: number | null;
  exchangeRate?: number | null;
  exchangeRateDate?: string | null;
  exchangeRateProvider?: string | null;
  exchangeRateOverride?: boolean;
  exchangeRateNote?: string | null;
  status: DocumentStatus;
  category: string;
  description?: string;
  customer?: string;
  date: string;
  dueDate?: string;
  invoiceNumber?: string;
  notes: string;
  tags: string[];
  fileUri?: string;
  fileName: string;
  previewImageUri?: string;
  previewImageUris?: string[];
  source: 'camera' | 'gallery' | 'files' | 'seeded';
  claimId?: string;
  cloudReceiptId?: number;
  mileageClaimId?: number;
  uploadedByUserId?: number;
  uploadedByEmail?: string | null;
  storageKey?: string;
  storageBucket?: string;
  extractionStatus: ExtractionStatus;
  extractionSource: 'backend_proxy' | 'fallback_review';
  confidenceScore?: number | null;
  needsReview?: boolean;
  lineItems?: Array<{
    description: string;
    quantity: number | null;
    unitPrice: number | null;
    total: number | null;
    taxAmount: number | null;
  }>;
  taxBreakdown?: Array<{
    label: string;
    rate: number | null;
    amount: number | null;
  }>;
  createdAt: string;
  updatedAt?: string;
}

export interface Claim {
  id: string;
  cloudClaimId?: number;
  name: string;
  status: ClaimStatus;
  total: number;
  currency: string;
  documentIds: string[];
  documentCount?: number;
  trip: string;
  owner: string;
  description?: string;
  submittedOn?: string;
  claimType?: 'standard' | 'mileage';
  mileageStartPostcode?: string;
  mileageEndPostcode?: string;
  mileageTotalMiles?: number;
  mileageRate?: number;
}

export interface Vehicle {
  id: string;
  name: string;
  registration: string;
}

export interface UserSettings {
  openOnCamera: boolean;
  lowResolution: boolean;
  saveToGallery: boolean;
  inAppSounds: boolean;
  marketingNotifications: boolean;
  theme: 'system' | 'light' | 'dark';
}

export interface OrganisationSettings {
  organisationId: number;
  organisationName: string;
  baseCurrency: string;
  isVatRegistered: boolean;
  defaultTaxRate: UkTaxRate;
  mileageRate: number;
}

export interface AppState {
  documents: ExpenseDocument[];
  claims: Claim[];
  vehicles: Vehicle[];
  settings: UserSettings;
  organisationSettings: OrganisationSettings | null;
}

export interface AppErrorLog {
  id: string;
  createdAt: string;
  source: string;
  message: string;
  stack?: string;
  isFatal: boolean;
}

export interface AuthUser {
  id: number;
  organisationId: number;
  email: string;
  fullName: string | null;
  role: 'Business_Admin' | 'Standard_Employee';
  status: 'pending_invite' | 'active';
}

export interface AuthSession {
  token: string;
  user: AuthUser;
}
