import { clearDashboardSession } from "@/lib/queryClient";

class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    const msg = typeof body === "object" && body !== null && "message" in body
      ? (body as { message: string }).message
      : `HTTP ${status}`;
    super(msg);
    this.name = "ApiError";
  }
}

function shouldHandleUnauthorized(url: string) {
  return url !== "/api/v1/auth/login";
}

function redirectToLogin() {
  if (typeof window === "undefined") {
    return;
  }

  if (window.location.pathname === "/login") {
    return;
  }

  clearDashboardSession();
  window.location.assign("/login");
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let errorBody: unknown;
    try {
      errorBody = await res.json();
    } catch {
      errorBody = { message: res.statusText };
    }

    if (res.status === 401 && shouldHandleUnauthorized(url)) {
      redirectToLogin();
    }

    throw new ApiError(res.status, errorBody);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, body),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body),
  del: <T>(url: string, body?: unknown) => request<T>("DELETE", url, body),
};

export { ApiError };
