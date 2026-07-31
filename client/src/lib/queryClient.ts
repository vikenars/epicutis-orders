import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { touchSession } from "./session";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// Module-level token storage. Set after a successful OTP verify or after the
// stored session is rehydrated on startup; read by apiRequest and the default
// React Query queryFn so the Bearer header is attached transparently. The
// durable copy lives in localStorage — see ./session.
let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

// Every successful authenticated call slides the stored deadline forward, so
// the local window tracks the server's sliding expiry.
function noteAuthenticatedSuccess(res: Response) {
  if (authToken && res.ok) touchSession();
}

export function getAuthToken(): string | null {
  return authToken;
}

export function getAuthHeader(token?: string | null): Record<string, string> | undefined {
  const t = token ?? authToken;
  return t ? { Authorization: `Bearer ${t}` } : undefined;
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(data ? { "Content-Type": "application/json" } : {}),
    ...(getAuthHeader() || {}),
    ...(extraHeaders || {}),
  };

  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
  });

  noteAuthenticatedSuccess(res);
  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const headers: Record<string, string> = { ...(getAuthHeader() || {}) };
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`, { headers });
    noteAuthenticatedSuccess(res);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
