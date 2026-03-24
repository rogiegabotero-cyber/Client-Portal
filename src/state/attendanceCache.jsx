import React, { createContext, useContext, useMemo, useState } from "react";

const AttendanceCacheContext = createContext(null);

export function AttendanceCacheProvider({ children }) {
  const [cache, setCache] = useState({
    hasLoadedOnce: false,
    startDate: null,
    endDate: null,
    logsByUserId: {},
    errorsByUserId: {},
    lastLoadedAt: null,
  });

  const value = useMemo(() => ({ cache, setCache }), [cache]);
  return <AttendanceCacheContext.Provider value={value}>{children}</AttendanceCacheContext.Provider>;
}

export function useAttendanceCache() {
  const ctx = useContext(AttendanceCacheContext);
  if (!ctx) throw new Error("useAttendanceCache must be used within AttendanceCacheProvider");
  return ctx;
}