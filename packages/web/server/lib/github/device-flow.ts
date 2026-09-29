const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

type FormParams = Record<string, string | number | boolean | null | undefined>;

export interface GitHubDeviceFlowPayload {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface GitHubRequestError extends Error {
  status?: number;
  payload?: GitHubDeviceFlowPayload | null;
}

const encodeForm = (params: FormParams) => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    body.set(key, String(value));
  }
  return body.toString();
};

async function postForm(url: string, params: FormParams): Promise<GitHubDeviceFlowPayload | null> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: encodeForm(params),
  });

  const payload = await response.json().catch(() => null) as GitHubDeviceFlowPayload | null;
  if (!response.ok) {
    const message = payload?.error_description || payload?.error || response.statusText;
    const error: GitHubRequestError = new Error(message || 'GitHub request failed');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function startDeviceFlow({ clientId, scope }: { clientId: string; scope: string }) {
  return postForm(DEVICE_CODE_URL, {
    client_id: clientId,
    scope,
  });
}

export async function exchangeDeviceCode({ clientId, deviceCode }: { clientId: string; deviceCode: string }) {
  // GitHub returns 200 with {error: 'authorization_pending'|...} for non-success states.
  const payload = await postForm(ACCESS_TOKEN_URL, {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: DEVICE_GRANT_TYPE,
  });
  return payload;
}
