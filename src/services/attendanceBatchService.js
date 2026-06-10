import app from "../firebase";
import { getFunctions, httpsCallable } from "firebase/functions";

const functions = getFunctions(app, "us-central1");
const fetchAttendanceLogsBatchCallable = httpsCallable(functions, "fetchAttendanceLogsBatch");

export async function fetchAttendanceLogsBatch({
  apiKey = "",
  baseUrl = "",
  userIds = [],
  startDate = "",
  endDate = "",
} = {}) {
  const normalizedUserIds = Array.isArray(userIds)
    ? userIds.map((value) => String(value || "").trim()).filter(Boolean)
    : [];

  if (!normalizedUserIds.length) {
    return {
      logsByUserId: {},
      errorsByUserId: {},
    };
  }

  const response = await fetchAttendanceLogsBatchCallable({
    apiKey: String(apiKey || "").trim(),
    baseUrl: String(baseUrl || "").trim(),
    userIds: normalizedUserIds,
    startDate: String(startDate || "").trim(),
    endDate: String(endDate || "").trim(),
  });

  const data = response?.data || {};
  return {
    logsByUserId:
      data?.logsByUserId && typeof data.logsByUserId === "object" ? data.logsByUserId : {},
    errorsByUserId:
      data?.errorsByUserId && typeof data.errorsByUserId === "object" ? data.errorsByUserId : {},
  };
}
