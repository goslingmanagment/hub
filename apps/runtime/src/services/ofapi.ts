// Thin client for the onlyfansapi.com management API (webhook CRUD + account list).
// Not to be confused with packages/onlyfans, which is the OnlyMonster adapter.

const OFAPI_REQUEST_TIMEOUT_MS = 15_000;

export class OfapiApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: string | null,
  ) {
    super(message);
    this.name = "OfapiApiError";
  }
}

export interface OfapiWebhookRegistrationInput {
  endpointUrl: string;
  signingSecret: string;
  events: string[];
  accountScope: "global" | "inclusive" | "exclusive";
}

export interface OfapiWebhookRecord {
  id: string | null;
}

export interface OfapiAccountRecord {
  id: string;
  username: string | null;
}

export interface OfapiClient {
  createWebhook(input: OfapiWebhookRegistrationInput): Promise<OfapiWebhookRecord>;
  updateWebhook(id: string, input: OfapiWebhookRegistrationInput): Promise<OfapiWebhookRecord>;
  listAccounts(): Promise<OfapiAccountRecord[]>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// OFAPI wraps most responses in {data}; tolerate both wrapped and bare shapes.
function unwrapData(value: unknown): unknown {
  const record = asRecord(value);
  return record && "data" in record ? record.data : value;
}

function toWebhookRecord(value: unknown): OfapiWebhookRecord {
  const record = asRecord(unwrapData(value));
  const id = record?.id;
  return {
    id: typeof id === "string" && id.length > 0
      ? id
      : typeof id === "number"
        ? String(id)
        : null,
  };
}

function toAccountRecords(value: unknown): OfapiAccountRecord[] {
  const data = unwrapData(value);
  if (!Array.isArray(data)) {
    return [];
  }

  const accounts: OfapiAccountRecord[] = [];
  for (const item of data) {
    const record = asRecord(item);
    const id = record?.id;
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }

    const username = record?.onlyfans_username;
    accounts.push({
      id,
      username: typeof username === "string" && username.length > 0 ? username : null,
    });
  }

  return accounts;
}

function webhookRequestBody(input: OfapiWebhookRegistrationInput) {
  return {
    endpoint_url: input.endpointUrl,
    signing_secret: input.signingSecret,
    events: input.events,
    account_scope: input.accountScope,
  };
}

export function createOfapiClient(input: {
  baseUrl: string;
  apiKey: string;
}): OfapiClient {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(OFAPI_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new OfapiApiError(
        `OFAPI request failed: ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`,
        null,
        null,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new OfapiApiError(
        `OFAPI request failed: ${method} ${path} returned ${response.status}`,
        response.status,
        text.slice(0, 2000),
      );
    }

    try {
      return text.length > 0 ? JSON.parse(text) as unknown : null;
    } catch {
      throw new OfapiApiError(
        `OFAPI request failed: ${method} ${path} returned non-JSON body`,
        response.status,
        text.slice(0, 2000),
      );
    }
  }

  return {
    async createWebhook(registration) {
      return toWebhookRecord(await request("POST", "/webhooks", webhookRequestBody(registration)));
    },
    async updateWebhook(id, registration) {
      return toWebhookRecord(await request(
        "PUT",
        `/webhooks/${encodeURIComponent(id)}`,
        webhookRequestBody(registration),
      ));
    },
    async listAccounts() {
      return toAccountRecords(await request("GET", "/accounts"));
    },
  };
}
