import React, { useEffect, useMemo, useState } from "react";
import { getStoredSession, loginUser, logoutUser } from "./authService";
import { AuthContext } from "./auth-context";

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => getStoredSession());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const stored = getStoredSession();
    if (stored?.isAuthenticated) {
      setSession(stored);
    }
  }, []);

  const signIn = async (credentials) => {
    setLoading(true);
    try {
      const nextSession = await loginUser(credentials);
      setSession(nextSession);
      return nextSession;
    } finally {
      setLoading(false);
    }
  };

  const signOut = async () => {
    setLoading(true);
    try {
      await logoutUser();
      setSession(null);
    } finally {
      setLoading(false);
    }
  };

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      isAuthenticated: !!session?.isAuthenticated,
      loading,
      signIn,
      signOut,
    }),
    [session, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}