import type { AiGatewayStreamFrame } from "@agency_hub_core/contracts";

export interface ProviderHttpFailureFixture {
  id: string;
  status: number;
  headers: Readonly<Record<string, string>>;
  body: {
    type: "error";
    error: {
      type: string;
      message: string;
    };
  };
}

export const providerHttpFailureFixtures = [
  {
    id: "anthropic-billing-400",
    status: 400,
    headers: {},
    body: {
      type: "error",
      error: {
        // The motivating production response is deliberately preserved
        // verbatim: billing arrives as invalid_request_error, not a special
        // provider billing type.
        type: "invalid_request_error",
        message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      },
    },
  },
  {
    id: "provider-auth-401",
    status: 401,
    headers: {},
    body: {
      type: "error",
      error: {
        type: "authentication_error",
        message: "invalid x-api-key",
      },
    },
  },
  {
    id: "provider-auth-403",
    status: 403,
    headers: {},
    body: {
      type: "error",
      error: {
        type: "permission_error",
        message: "account is not permitted to use this model",
      },
    },
  },
  {
    id: "provider-rate-limit-429",
    status: 429,
    headers: {
      "retry-after": "17",
    },
    body: {
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "rate limit exceeded",
      },
    },
  },
  {
    id: "provider-overloaded-529",
    status: 529,
    headers: {},
    body: {
      type: "error",
      error: {
        type: "overloaded_error",
        message: "Overloaded",
      },
    },
  },
  {
    id: "provider-internal-500",
    status: 500,
    headers: {},
    body: {
      type: "error",
      error: {
        type: "api_error",
        message: "Internal server error",
      },
    },
  },
  {
    id: "provider-unavailable-503",
    status: 503,
    headers: {},
    body: {
      type: "error",
      error: {
        type: "api_error",
        message: "Service unavailable",
      },
    },
  },
] as const satisfies readonly ProviderHttpFailureFixture[];

export function errorFromProviderHttpFixture(
  fixture: ProviderHttpFailureFixture,
): Error & {
  status: number;
  headers: Readonly<Record<string, string>>;
  error: ProviderHttpFailureFixture["body"]["error"];
} {
  return Object.assign(new Error(fixture.body.error.message), {
    status: fixture.status,
    headers: fixture.headers,
    error: fixture.body.error,
  });
}

function codedError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function namedError(message: string, name: string) {
  const error = new Error(message);
  error.name = name;
  return error;
}

export const providerConnectFailureFixtures = [
  {
    id: "econnrefused",
    createError: () => codedError("connect ECONNREFUSED 127.0.0.1:1080", "ECONNREFUSED"),
  },
  {
    id: "socks-handshake",
    createError: () => {
      const cause = namedError("SOCKS proxy connection failed", "SocksClientError");
      return Object.assign(new Error("Connection error."), { cause });
    },
  },
  {
    id: "connect-timeout",
    createError: () => namedError("Connect Timeout Error", "ConnectTimeoutError"),
  },
] as const;

export const providerStreamInterruptionFixture = {
  id: "stream-interruption-after-first-chunk",
  firstFrame: {
    type: "content_delta",
    text: "partial provider output",
  } satisfies AiGatewayStreamFrame,
  createError: () => codedError("socket closed after first chunk", "ECONNRESET"),
} as const;
