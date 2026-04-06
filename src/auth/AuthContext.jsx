import React, { useEffect, useMemo, useState } from "react";
import {
  clearSession,
  getStoredSession,
  isStoredSessionStillValid,
  loginUser,
  logoutUser,
  subscribeToSessionValidity,
} from "./authService";
import { AuthContext } from "./auth-context";

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => getStoredSession());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const verifyStoredSession = async () => {
      const stored = getStoredSession();
      if (!stored?.isAuthenticated) return;

      const stillValid = await isStoredSessionStillValid(stored);
      if (cancelled) return;

      if (stillValid) {
        setSession(stored);
      } else {
        clearSession();
        setSession(null);
      }
    };

    verifyStoredSession();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!session?.isAuthenticated) return undefined;

    const hasSessionIdentity =
      !!String(session?.user?.userId || "").trim() &&
      !!String(session?.user?.sessionKey || "").trim();

    if (!hasSessionIdentity) {
      clearSession();
      setSession(null);
      return undefined;
    }

    let handled = false;
    const unsubscribe = subscribeToSessionValidity(session, () => {
      if (handled) return;
      handled = true;
      clearSession();
      setSession(null);
    });

    return () => {
      handled = true;
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
  }, [session]);

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
      await logoutUser(session?.user || null);
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
