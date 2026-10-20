import { useState, type FormEvent } from "react";
import type { Login, Session } from "../api/auth";
import { ApiError } from "../api/http";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface LoginPageProps {
  login: Login;
  onLoggedIn: (session: Session) => void;
  notice?: string | null; // e.g. "Your session has expired"
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Invalid email or password.";
    if (error.status === 429) return "Too many login attempts. Wait a few minutes and try again.";
    return error.message;
  }
  return "Could not reach the server. Check your connection and try again.";
}

export function LoginPage({ login, onLoggedIn, notice }: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const found: typeof errors = {};
    if (email.trim() === "") found.email = "Enter your email";
    else if (!EMAIL_PATTERN.test(email.trim())) found.email = "Enter a valid email address";
    if (password === "") found.password = "Enter your password";
    setErrors(found);
    setFailure(null);
    if (found.email || found.password) return;

    setSubmitting(true);
    try {
      onLoggedIn(await login(email.trim(), password));
    } catch (error) {
      setFailure(messageFor(error));
      setPassword("");
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={handleSubmit} noValidate aria-labelledby="login-title">
        <h1 id="login-title">Orders Console</h1>
        <p className="subtitle">Sign in to continue.</p>

        {notice && (
          <p className="message message-warning" role="status">
            {notice}
          </p>
        )}
        {failure && (
          <p className="message message-error" role="alert">
            {failure}
          </p>
        )}

        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? "login-email-error" : undefined}
          />
          {errors.email && (
            <span className="field-error" id="login-email-error">
              {errors.email}
            </span>
          )}
        </div>

        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? "login-password-error" : undefined}
          />
          {errors.password && (
            <span className="field-error" id="login-password-error">
              {errors.password}
            </span>
          )}
        </div>

        <button type="submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
