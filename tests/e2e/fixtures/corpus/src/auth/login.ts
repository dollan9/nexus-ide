// Fixtur för P0-test T8: RAG ska hitta just denna fil på en språklig fråga om authentication.
export interface User { readonly id: string; readonly email: string; }

export function authenticate(email: string, password: string): User | null {
  if (!email.includes("@") || password.length < 8) return null;
  return { id: "u-1", email };
}

export function createSession(user: User): string {
  return `session-${user.id}-${Date.now()}`;
}
