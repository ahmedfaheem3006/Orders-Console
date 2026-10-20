import { toApiError } from "./http";

export interface SessionUser {
  id: number;
  email: string;
  role: "admin" | "agent";
}

// Kept only in React state (memory). See README "Client token storage".
export interface Session {
  token: string;
  expiresAt: string;
  user: SessionUser;
}

export type Login = (email: string, password: string) => Promise<Session>;

export const login: Login = async (email, password) => {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as Session;
};
