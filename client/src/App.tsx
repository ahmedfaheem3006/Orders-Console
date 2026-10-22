import { useCallback, useEffect, useMemo, useState } from "react";
import { login as defaultLogin, type Login, type Session } from "./api/auth";
import { createApiClient } from "./api/orders";
import { LoginPage } from "./auth/LoginPage";
import { OrdersConsole } from "./orders/OrdersConsole";

const SESSION_EXPIRED = "Your session has expired. Please sign in again.";

interface AppProps {
  login?: Login;   // injectable for tests
}

// The session (including the token) lives only in this component's state: nothing is
// written to localStorage, sessionStorage or cookies. A page reload signs the user out.
export function App({ login = defaultLogin }: AppProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const endSession = useCallback((message: string | null) => {
    setSession(null);
    setNotice(message);
  }, []);

  // One client per token. Its functions keep a stable identity while the token is the
  // same, which useOrders relies on (fetchPage is an effect dependency).
  const api = useMemo(
    () => (session ? createApiClient(session.token, () => endSession(SESSION_EXPIRED)) : null),
    [session, endSession],
  );

  // Return to the login screen when the token expires, even if no request is made.
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(() => endSession(SESSION_EXPIRED), Math.max(Date.parse(session.expiresAt) - Date.now(), 0));
    return () => clearTimeout(timer);
  }, [session, endSession]);

  if (!session || !api) {
    return (
      <LoginPage
        login={login}
        notice={notice}
        onLoggedIn={(newSession) => {
          setNotice(null);
          setSession(newSession);
        }}
      />
    );
  }

  return (
    <OrdersConsole
      user={session.user}
      fetchPage={api.fetchOrders}
      createOrder={api.createOrder}
      deleteOrder={api.deleteOrder}
      onLogout={() => endSession(null)}
    />
  );
}
