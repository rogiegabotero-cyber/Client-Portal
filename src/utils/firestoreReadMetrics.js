const METRICS_GLOBAL_KEY = "__PORTAL_FIRESTORE_READ_METRICS__";
const LOG_INTERVAL_MS = 12 * 1000;

const isEnabled = () =>
  !!(
    import.meta?.env?.DEV ||
    String(import.meta?.env?.VITE_LOG_FIRESTORE_READS || "")
      .trim()
      .toLowerCase() === "true"
  );

const getGlobalState = () => {
  const root = globalThis;
  if (!root[METRICS_GLOBAL_KEY]) {
    root[METRICS_GLOBAL_KEY] = {
      totalReads: 0,
      totalOps: 0,
      byLabel: {},
      lastLoggedAt: 0,
    };
  }
  return root[METRICS_GLOBAL_KEY];
};

const toSafeCount = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
};

const logIfDue = () => {
  if (!isEnabled()) return;

  const state = getGlobalState();
  const now = Date.now();
  if (now - Number(state.lastLoggedAt || 0) < LOG_INTERVAL_MS) return;
  state.lastLoggedAt = now;

  const rows = Object.entries(state.byLabel || {})
    .map(([label, item]) => ({
      label,
      reads: Number(item?.reads || 0),
      ops: Number(item?.ops || 0),
    }))
    .sort((a, b) => b.reads - a.reads)
    .slice(0, 12);

  console.groupCollapsed(
    `[Firestore Reads] totalReads=${state.totalReads} totalOps=${state.totalOps}`
  );
  if (rows.length) {
    console.table(rows);
  } else {
    console.log("No tracked reads yet.");
  }
  console.groupEnd();
};

const recordRead = (label, readCount) => {
  if (!isEnabled()) return;

  const safeLabel = String(label || "unknown").trim() || "unknown";
  const reads = toSafeCount(readCount);
  const state = getGlobalState();
  const row = state.byLabel[safeLabel] || { reads: 0, ops: 0 };

  row.reads += reads;
  row.ops += 1;
  state.byLabel[safeLabel] = row;
  state.totalReads += reads;
  state.totalOps += 1;

  logIfDue();
};

export function recordFirestoreGetDocsRead(label, snapshotLike) {
  const count = Array.isArray(snapshotLike?.docs)
    ? snapshotLike.docs.length
    : Number(snapshotLike?.size || 0);
  recordRead(`getDocs:${label}`, count);
}

export function recordFirestoreSnapshotRead(label, readCount) {
  recordRead(`onSnapshot:${label}`, readCount);
}

export function getFirestoreReadMetricsSnapshot() {
  const state = getGlobalState();
  return {
    totalReads: Number(state.totalReads || 0),
    totalOps: Number(state.totalOps || 0),
    byLabel: { ...(state.byLabel || {}) },
  };
}

export function resetFirestoreReadMetrics() {
  if (!isEnabled()) return;
  const state = getGlobalState();
  state.totalReads = 0;
  state.totalOps = 0;
  state.byLabel = {};
  state.lastLoggedAt = 0;
  console.info("[Firestore Reads] metrics reset");
}

if (isEnabled()) {
  globalThis.__getPortalFirestoreReadMetrics = getFirestoreReadMetricsSnapshot;
  globalThis.__resetPortalFirestoreReadMetrics = resetFirestoreReadMetrics;
}
