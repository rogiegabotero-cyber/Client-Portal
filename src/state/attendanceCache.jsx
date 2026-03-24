import React, { createContext, useMemo, useState } from "react";

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
