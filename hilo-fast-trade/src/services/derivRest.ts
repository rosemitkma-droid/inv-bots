import { DERIV_REST_BASE } from '../constants/api';

export interface DerivAccount {
  account_id: string;
  account_type: 'demo' | 'real';
  balance: number;
  currency: string;
  status: 'active' | 'inactive';
  email?: string;
  name?: string;
}

interface AccountsResponse {
  data: DerivAccount[];
}

interface OtpResponse {
  data: { url: string };
}

function headers(appId: string, token: string): HeadersInit {
  return {
    'Deriv-App-ID': appId,
    Authorization: `Bearer ${token}`,
  };
}

async function handleError(res: Response, op: string): Promise<never> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  let detail = body;
  try {
    const parsed = JSON.parse(body);
    detail = parsed.message ?? parsed.error?.message ?? JSON.stringify(parsed);
  } catch {
    /* not JSON */
  }
  throw new Error(`${op} failed: ${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`);
}

function normalizeAccount(raw: unknown): DerivAccount {
  const a = (raw ?? {}) as Record<string, unknown>;
  const balanceRaw = a.balance;
  const balance =
    typeof balanceRaw === 'number'
      ? balanceRaw
      : typeof balanceRaw === 'string'
        ? Number(balanceRaw)
        : 0;
  return {
    account_id: String(a.account_id ?? ''),
    account_type: (a.account_type === 'real' ? 'real' : 'demo') as 'demo' | 'real',
    balance: Number.isFinite(balance) ? balance : 0,
    currency: String(a.currency ?? ''),
    status: (a.status === 'inactive' ? 'inactive' : 'active') as 'active' | 'inactive',
    email: typeof a.email === 'string' ? a.email : undefined,
    name: typeof a.name === 'string' ? a.name : undefined,
  };
}

export async function listAccounts(appId: string, token: string): Promise<DerivAccount[]> {
  const res = await fetch(`${DERIV_REST_BASE}/accounts`, {
    method: 'GET',
    headers: headers(appId, token),
  });
  if (!res.ok) await handleError(res, 'list accounts');
  const json = (await res.json()) as AccountsResponse;
  if (!json?.data || !Array.isArray(json.data)) {
    throw new Error('list accounts: malformed response');
  }
  return json.data.map(normalizeAccount);
}

export async function getOtpUrl(
  appId: string,
  token: string,
  accountId: string,
): Promise<string> {
  const res = await fetch(
    `${DERIV_REST_BASE}/accounts/${encodeURIComponent(accountId)}/otp`,
    {
      method: 'POST',
      headers: headers(appId, token),
    },
  );
  if (!res.ok) await handleError(res, 'get otp');
  const json = (await res.json()) as OtpResponse;
  const url = json?.data?.url;
  if (!url) throw new Error('get otp: missing data.url in response');
  return url;
}

export function pickDefaultAccount(
  accounts: DerivAccount[],
  preferred?: 'demo' | 'real',
): DerivAccount | null {
  const active = accounts.filter((a) => a.status === 'active');
  if (preferred) {
    const match = active.find((a) => a.account_type === preferred);
    if (match) return match;
  }
  return (
    active.find((a) => a.account_type === 'demo') ??
    active.find((a) => a.account_type === 'real') ??
    active[0] ??
    null
  );
}
