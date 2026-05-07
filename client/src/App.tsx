import { useState } from "react";
import { Router, Route, Switch } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient, setAuthToken } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import OrderSearch from "@/pages/OrderSearch";
import Login, { type AuthUser } from "@/pages/Login";
import NotFound from "@/pages/not-found";

function App() {
  // Auth state lives in memory only — a refresh logs the user out by design.
  // No localStorage/cookies, so this works fine inside iframes/sandboxes too.
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);

  const handleLogin = (newToken: string, newUser: AuthUser) => {
    setAuthToken(newToken);
    setToken(newToken);
    setUser(newUser);
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
    setAuthToken(null);
    setToken(null);
    setUser(null);
  };

  return (
    <QueryClientProvider client={queryClient}>
      {!token ? (
        <Login onLogin={handleLogin} />
      ) : (
        <Router hook={useHashLocation}>
          <Switch>
            <Route path="/" >
              <OrderSearch user={user} onLogout={handleLogout} />
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
