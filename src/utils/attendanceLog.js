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
