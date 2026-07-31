import { useCallback, useEffect, useState } from "react";
import { Router, Route, Switch } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient, setAuthToken } from "@/lib/queryClient";
import { clearSession, loadSession, saveSession } from "@/lib/session";
import { Toaster } from "@/components/ui/toaster";
import OrderSearch from "@/pages/OrderSearch";
import Login, { type AuthUser } from "@/pages/Login";
import NotFound from "@/pages/not-found";

// Pick the stored token up before the first render so the very first request
// already carries it. The session is only *trusted* once /api/auth/me confirms
// it below — this just avoids an unauthenticated first paint.
const restored = loadSession();
if (restored) setAuthToken(restored.token);

type AuthStatus = "restoring" | "signed-in" | "signed-out";

function App() {
  const [token, setToken] = useState<string | null>(restored?.token ?? null);
  const [user, setUser] = useState<AuthUser | null>(null);
  // With a stored token we hold the UI on a neutral screen until the server has
  // confirmed the session, so a resumed session never renders half-signed-in
  // and an expired one drops straight to the sign-in form.
  const [status, setStatus] = useState<AuthStatus>(restored ? "restoring" : "signed-out");

  const showSignIn = useCallback(() => {
    setAuthToken(null);
    setToken(null);
    setUser(null);
    setStatus("signed-out");
    queryClient.clear();
  }, []);

  // Discard the session for good: the token is dead, or the user asked to leave.
  const endSession = useCallback(() => {
    clearSession();
    showSignIn();
  }, [showSignIn]);

  // Resume a stored session. The role and identity always come from the
  // server's answer, never from the stored copy, so a rehydrated session is
  // indistinguishable from a fresh sign-in.
  useEffect(() => {
    if (!restored) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/me", {
          headers: { Authorization: `Bearer ${restored.token}` },
        });
        if (cancelled) return;
        if (!res.ok) {
          endSession();
          return;
        }
        const body = (await res.json()) as { user: AuthUser; sessionTtlMs?: number };
        if (cancelled) return;
        saveSession(restored.token, body.user, body.sessionTtlMs);
        setUser(body.user);
        setStatus("signed-in");
      } catch {
        // Unreachable server (offline, or mid-redeploy) — that is not evidence
        // the session is dead, so keep the stored record and let a later load
        // resume it instead of burning a still-valid session.
        if (!cancelled) showSignIn();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endSession, showSignIn]);

  const handleLogin = (newToken: string, newUser: AuthUser, sessionTtlMs?: number) => {
    saveSession(newToken, newUser, sessionTtlMs);
    setAuthToken(newToken);
    setToken(newToken);
    setUser(newUser);
    setStatus("signed-in");
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Ignore — clearing local state is enough to return to the login gate.
    }
    endSession();
  };

  // A 401 on one request is not proof the session is gone: it may be a single
  // bad call. Re-check with the server and only tear the session down when the
  // token itself is genuinely rejected.
  const handleAuthFailure = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) return;
    } catch {
      // Unreachable server — leave the session alone and let the user retry.
      return;
    }
    endSession();
  }, [token, endSession]);

  return (
    <QueryClientProvider client={queryClient}>
      {status === "restoring" ? (
        <div
          className="min-h-screen bg-background"
          role="status"
          aria-busy="true"
          aria-label="Restoring your session"
          data-testid="session-restoring"
        />
      ) : status !== "signed-in" ? (
        <Login onLogin={handleLogin} />
      ) : (
        <Router hook={useHashLocation}>
          <Switch>
            <Route path="/" >
              <OrderSearch user={user} onLogout={handleLogout} onAuthFailure={handleAuthFailure} />
            </Route>
            <Route component={NotFound} />
          </Switch>
        </Router>
      )}
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
