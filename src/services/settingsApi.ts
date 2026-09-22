import { type OrganisationSettings } from '../types';
import { getApiBaseUrl } from './auth';
import { requireSessionToken } from './session';

type SettingsResponse =
  | {
      success: true;
      settings: {
        organisationId: number;
        organisationName: string;
        baseCurrency: string;
        isVatRegistered: boolean;
        defaultTaxRate: OrganisationSettings['defaultTaxRate'];
        mileageRate: number;
      };
    }
  | {
      success: false;
      message?: string;
    };

export async function fetchOrganisationSettings() {
  const token = requireSessionToken();
  const response = await fetch(`${getApiBaseUrl()}/settings`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const data = (await response.json()) as SettingsResponse;
  if (!response.ok || !('success' in data) || data.success !== true) {
    throw new Error('message' in data && typeof data.message === 'string' ? data.message : 'Could not load organisation settings.');
  }

  return data.settings satisfies OrganisationSettings;
}

export async function saveOrganisationSettings(
  payload: Pick<OrganisationSettings, 'baseCurrency' | 'isVatRegistered' | 'defaultTaxRate' | 'mileageRate'>,
) {
  const token = requireSessionToken();
  const response = await fetch(`${getApiBaseUrl()}/settings`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = (await response.json()) as SettingsResponse;
  if (!response.ok || !('success' in data) || data.success !== true) {
    throw new Error('message' in data && typeof data.message === 'string' ? data.message : 'Could not save organisation settings.');
  }

  return data.settings satisfies OrganisationSettings;
}
