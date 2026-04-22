import { pick, safeLower } from "./common";

const IN_TS_KEYS = ["timestamp", "createdAt", "time", "timeIn", "clockIn", "timestampIn"];
const OUT_TS_KEYS = [
  "timeOut",
  "time_out",
  "clockOut",
  "clock_out",
  "timestampOut",
  "outTimestamp",
  "timeout",
  "outTime",
  "endTime",
  "checkedOutAt",
  "timeEnd",
  "clockedOutAt",
];

export const pickTs = (log) => pick(log, IN_TS_KEYS, "");

export const pickOutTs = (log) => pick(log, OUT_TS_KEYS, "");

export const tsMs = (ts) => {
  if (ts == null || ts === "") return NaN;

  if (typeof ts === "number") {
    if (!Number.isFinite(ts)) return NaN;
    return ts > 1e12 ? ts : ts * 1000;
  }

  if (ts instanceof Date) {
    const ms = ts.getTime();
    return Number.isFinite(ms) ? ms : NaN;
  }

  if (typeof ts === "object") {
    if (typeof ts.toMillis === "function") {
      const ms = ts.toMillis();
      return Number.isFinite(ms) ? ms : NaN;
    }

    if (typeof ts.toDate === "function") {
      const d = ts.toDate();
      const ms = d instanceof Date ? d.getTime() : NaN;
      return Number.isFinite(ms) ? ms : NaN;
    }

    const sec = Number(
      pick(ts, ["seconds", "_seconds", "sec", "unix"], NaN)
    );
    const nanos = Number(pick(ts, ["nanoseconds", "_nanoseconds", "nanos"], 0));
    if (Number.isFinite(sec)) {
      const ms = sec * 1000 + (Number.isFinite(nanos) ? nanos / 1e6 : 0);
      return Number.isFinite(ms) ? ms : NaN;
    }
  }

  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : NaN;
};

export const isIn = (log) => {
  const type = safeLower(pick(log, ["type", "logType", "eventType"], ""));
  return type.includes("in") || type.includes("clockin") || type.includes("timein");
};

export const isOut = (log) => {
  const type = safeLower(pick(log, ["type", "logType", "eventType"], ""));
  return (
    type.includes("out") ||
    type.includes("clockout") ||
    type.includes("timeout") ||
    type.includes("checkout")
  );
};

export const hasRealTimeOut = (raw) => {
  const outValue = pickOutTs(raw || {});
  if (!outValue) return false;
  return Number.isFinite(tsMs(outValue));
};

export const isClockedOutLog = (log) => isOut(log) || hasRealTimeOut(log);

export const getEventTs = (log) => {
  const outTs = pickOutTs(log);
  const mainTs = pickTs(log);

  if (isOut(log) || hasRealTimeOut(log)) return outTs || mainTs || "";
  return mainTs || outTs || "";
};
