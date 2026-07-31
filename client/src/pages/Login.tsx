import { useState, type FormEvent } from "react";

export interface AuthUser {
  email: string;
  label: string;
  role?: "admin" | "rsd" | "ae";
}

interface LoginProps {
  onLogin: (token: string, user: AuthUser, sessionTtlMs?: number) => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const handleRequestOtp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setInfo("");
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/auth/request-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error || "Could not send sign-in code.");
      }
      setStep("code");
      setInfo(`We sent a 6-digit code to ${email}. It expires in 10 minutes.`);
    } catch (err: any) {
      setError(err?.message || "Could not send sign-in code.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVerifyOtp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error || "Invalid code.");
      }
      const data = (await res.json()) as {
        token: string;
        user: AuthUser;
        sessionTtlMs?: number;
      };
      onLogin(data.token, data.user, data.sessionTtlMs);
    } catch (err: any) {
      setError(err?.message || "Invalid code.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const goBackToEmail = () => {
    setStep("email");
    setCode("");
    setError("");
    setInfo("");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-5">
      <form
        onSubmit={step === "email" ? handleRequestOtp : handleVerifyOtp}
        className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-sm"
        data-testid="form-login"
      >
        <div className="flex flex-col items-center text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary text-primary-foreground text-2xl font-extrabold">
            E
          </div>
          <h1 className="mt-6 text-xl font-bold tracking-tight">Epicutis Orders</h1>
          <p className="mt-2 text-xs uppercase tracking-[0.24em] text-muted-foreground">
            {step === "email" ? "Sign in with your work email" : "Enter the 6-digit code"}
          </p>
        </div>

        <div className="mt-8 space-y-4">
          {step === "email" ? (
            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Work email
              </span>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoFocus
                required
                data-testid="input-login-email"
                className="h-12 w-full rounded-lg border border-input bg-background px-4 text-sm font-medium text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
                placeholder="you@epicutis.com"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Only @epicutis.com and @signumbio.com addresses can sign in.
              </p>
            </label>
          ) : (
            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Sign-in code
              </span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                autoFocus
                required
                data-testid="input-login-code"
                className="h-12 w-full rounded-lg border border-input bg-background px-4 text-center text-2xl font-semibold tracking-[0.4em] text-foreground outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary"
                placeholder="••••••"
              />
              {info && (
                <p className="mt-2 text-xs text-primary">{info}</p>
              )}
            </label>
          )}

          {error && (
            <p
              data-testid="text-login-error"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs font-medium text-destructive"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting || (step === "code" && code.length !== 6)}
            data-testid={step === "email" ? "button-login-request-otp" : "button-login-verify-otp"}
            className="h-11 w-full rounded-lg bg-primary text-sm font-semibold uppercase tracking-wider text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting
              ? (step === "email" ? "Sending…" : "Verifying…")
              : (step === "email" ? "Send code" : "Verify & sign in")}
          </button>

          {step === "code" && (
            <button
              type="button"
              onClick={goBackToEmail}
              className="h-10 w-full rounded-lg border border-border bg-transparent text-xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
            >
              Use a different email
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

