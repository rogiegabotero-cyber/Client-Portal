export const pick = (obj, keys, fallback = "") => {
  for (const key of Array.isArray(keys) ? keys : []) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && String(value).length) return value;
  }
  return fallback;
};

export const safeLower = (value) => String(value ?? "").toLowerCase();

export const toText = (value) => String(value || "").trim();

export const uniq = (arr = []) => Array.from(new Set(Array.isArray(arr) ? arr : []));

export const toMillis = (value) => {
  if (value == null) return NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;

  if (typeof value?.toMillis === "function") {
    const ms = value.toMillis();
    return Number.isFinite(ms) ? ms : NaN;
  }

  if (typeof value?.toDate === "function") {
    const d = value.toDate();
    if (!(d instanceof Date)) return NaN;
    const ms = d.getTime();
    return Number.isFinite(ms) ? ms : NaN;
  }

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : NaN;
  }

  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
};

export const getUserId = (emp) =>
  emp?.userId ??
  emp?.userID ??
  emp?.user_id ??
  emp?.UserId ??
  emp?.uid ??
  emp?.firebaseUid ??
  emp?.id ??
  emp?.employeeId ??
  emp?._id ??
  emp?.user?.id ??
  emp?.user?.uid ??
  emp?.user?.userId ??
  null;

export const getDisplayName = (emp) =>
  emp?.name ??
  emp?.fullName ??
  emp?.displayName ??
  emp?.email ??
  `User ${String(getUserId(emp) ?? "")}`.trim();

export const getProfileImageUrl = (emp = {}) => {
  const raw = pick(
    emp || {},
    [
      "profileImg",
      "profileImage",
      "profileImageUrl",
      "profileImageURL",
      "profileImageKey",
      "photoURL",
      "photoUrl",
      "avatarUrl",
      "avatarURL",
      "imageUrl",
      "imageURL",
      "image",
    ],
    ""
  );

  const value = String(raw || "").trim();
  if (!value) return "";

  const lower = value.toLowerCase();
  if (lower.startsWith("data:image/")) return value;
  if (lower.startsWith("/")) return value;
  if (lower.startsWith("./") || lower.startsWith("../")) return value;

  try {
    const base =
      typeof window !== "undefined" && window?.location?.origin
        ? window.location.origin
        : "http://localhost";
    const parsed = new URL(value, base);
    const protocol = String(parsed.protocol || "").toLowerCase();
    if (protocol === "http:" || protocol === "https:" || protocol === "blob:") {
      return parsed.href;
    }
    return "";
  } catch {
    return "";
  }
};

export const getDeviceTimeZone = (fallback = "America/Chicago") => {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return String(tz || "").trim() || fallback;
  } catch {
    return fallback;
  }
};
