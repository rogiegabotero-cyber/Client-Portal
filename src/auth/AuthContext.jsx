import React, { useCallback, useEffect, useMemo, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import {
  clearSession,
  getStoredSession,
  isStoredSessionStillValid,
  loginUser,
  logoutUser,
  subscribeToSessionValidity,
} from "./authService";
import { AuthContext } from "./auth-context";
import { auth } from "../firebase";

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => getStoredSession());
  const [loading, setLoading] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [firebaseUser, setFirebaseUser] = useState(() => auth.currentUser);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setFirebaseUser(nextUser || null);
      setAuthReady(true);

      setSession((prev) => {
        if (!prev?.isAuthenticated) return prev;

        const sessionUserId = String(prev?.user?.userId || prev?.user?.id || "").trim();
        const firebaseUid = String(nextUser?.uid || "").trim();

        if (!firebaseUid || (sessionUserId && sessionUserId !== firebaseUid)) {
          clearSession();
          return null;
        }

        return prev;
      });
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!authReady) return;

    let cancelled = false;

    const verifyStoredSession = async () => {
      const stored = getStoredSession();
      if (!stored?.isAuthenticated) return;
      const sessionUserId = String(stored?.user?.userId || stored?.user?.id || "").trim();
      const firebaseUid = String(firebaseUser?.uid || "").trim();

      if (!firebaseUid || (sessionUserId && sessionUserId !== firebaseUid)) {
        clearSession();
        setSession(null);
        return;
      }

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
  }, [authReady, firebaseUser?.uid]);

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

  const signIn = useCallback(async (credentials) => {
    setLoading(true);
    try {
      const nextSession = await loginUser(credentials);
      setSession(nextSession);
      setFirebaseUser(auth.currentUser || null);
      return nextSession;
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    setLoading(true);
    try {
      await logoutUser(session?.user || null);
      setSession(null);
      setFirebaseUser(null);
    } finally {
      setLoading(false);
    }
  }, [session?.user]);

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      isAuthenticated: authReady && !!session?.isAuthenticated && !!firebaseUser,
      authReady,
      firebaseUser,
      loading,
      signIn,
      signOut,
    }),
    [authReady, firebaseUser, loading, session, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
