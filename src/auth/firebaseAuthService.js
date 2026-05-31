import { deleteApp, initializeApp } from "firebase/app";
import app, { auth, db } from "../firebase";
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  fetchSignInMethodsForEmail,
  getAdditionalUserInfo,
  getAuth,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  signInWithPopup,
  signInWithEmailAndPassword,
  signOut,
  verifyBeforeUpdateEmail,
  updateEmail,
  updatePassword,
  deleteUser,
} from "firebase/auth";
import { getFunctions, httpsCallable } from "firebase/functions";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getFirestore,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  where,
  serverTimestamp,
} from "firebase/firestore";
import { DEFAULT_ROLE_PAGES, PAGE_KEYS, ROLES } from "./roleUtils";
import { buildTimeZoneMeta, resolveStorageTimeZone } from "../utils/timeZoneMeta";
import { toMillis } from "../utils/common";
import {
  verifyEmailInHyacinthDepartment,
} from "../services/hyacinthDirectoryService";

const PORTAL_USER_REQUESTS_COLLECTION = "portal_user_requests";
const BREAK_NOTIFICATIONS_COLLECTION = "break_notifications";
const ACTIVE_SESSIONS_COLLECTION = "portal_active_sessions";
const EMPLOYEE_CREDENTIALS_COLLECTION = "employee_credentials";
const ACTIVE_SESSION_STALE_THRESHOLD_MS = 20 * 60 * 1000;
const REQUEST_ROLE_OPTIONS = [ROLES.ADMIN, ROLES.ACCOUNTING, ROLES.VISITOR];
const PUBLIC_SELF_REQUEST_ROLES = [ROLES.ADMIN, ROLES.VISITOR];
const PORTAL_ROLE_OPTIONS = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.ACCOUNTING, ROLES.VISITOR];
const PASSWORD_HASH_PREFIX = "portal_v1";
const functions = getFunctions(app, "us-central1");
const issueSessionTokenCallable = httpsCallable(functions, "issueSessionToken");

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
const normalizePortalRole = (value) => String(value || "").trim().toLowerCase();
const HYACINTH_EMAIL_FALLBACK_MATCH = "hyacinth";

const toGoogleProfileSnapshot = (user = null) => {
  const normalizedEmail = normalizeEmail(user?.email || "");
  const displayName = String(user?.displayName || "").trim();
  const rawUsername = normalizedEmail ? normalizedEmail.split("@")[0] : "";
  const username = String(rawUsername || "").trim();
  const photoURL = String(user?.photoURL || "").trim();
  const providerData = Array.isArray(user?.providerData) ? user.providerData : [];
  const googleProviderData =
    providerData.find((item) => String(item?.providerId || "").trim() === "google.com") || {};

  return {
    uid: String(user?.uid || "").trim(),
    providerId: "google.com",
    email: normalizedEmail,
    name: displayName || String(googleProviderData?.displayName || "").trim() || username,
    username,
    photoURL: photoURL || String(googleProviderData?.photoURL || "").trim(),
    googleUid: String(googleProviderData?.uid || user?.uid || "").trim(),
  };
};

const isHyacinthCompanyEmail = (emailValue) => {
  const normalizedEmail = normalizeEmail(emailValue);
  if (!normalizedEmail) return false;
  const atIndex = normalizedEmail.lastIndexOf("@");
  if (atIndex < 0) return false;
  const domain = normalizedEmail.slice(atIndex + 1);
  const configuredDomains = String(import.meta.env.VITE_HYACINTH_EMAIL_DOMAINS || "")
    .split(",")
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean);
  const acceptedDomains = configuredDomains.length
    ? configuredDomains
    : [HYACINTH_EMAIL_FALLBACK_MATCH];

  return acceptedDomains.some((candidate) => {
    if (!candidate) return false;
    if (candidate.includes(".")) {
      return domain === candidate || domain.endsWith(`.${candidate}`);
    }
    return domain.includes(candidate);
  });
};

const normalizePortalRequestRole = (value) => {
  const role = String(value || "").trim().toLowerCase();
  return REQUEST_ROLE_OPTIONS.includes(role) ? role : "";
};

const normalizePublicSelfRequestRole = (value) => {
  const role = String(value || "").trim().toLowerCase();
  return PUBLIC_SELF_REQUEST_ROLES.includes(role) ? role : "";
};

const splitNameParts = (fullName = "", emailFallback = "") => {
  const cleaned = String(fullName || "").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  const fallbackBase = String(emailFallback || "").trim().split("@")[0] || "";
  const firstName = parts[0] || fallbackBase || "Portal";
  const lastName = parts.slice(1).join(" ") || "User";
  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
  };
};

const extractEmployeeNameDetails = (employee = {}, normalizedEmail = "") => {
  const fullName =
    String(employee?.name || "").trim() ||
    String(employee?.displayName || "").trim() ||
    String(employee?.fullName || "").trim() ||
    `${String(employee?.firstName || "").trim()} ${String(employee?.lastName || "").trim()}`.trim();
  return splitNameParts(fullName, normalizedEmail);
};

const extractEmployeeDirectoryIdentifiers = (employee = {}) => {
  const toId = (value) => String(value || "").trim();
  const employeeIdCandidates = [
    employee?.employeeId,
    employee?.employee_id,
    employee?.employeeID,
    employee?.employeeNumber,
    employee?.staffId,
    employee?.staff_id,
    employee?.profile?.employeeId,
    employee?.profile?.employee_id,
  ];
  const userIdCandidates = [
    employee?.userId,
    employee?.uid,
    employee?.id,
    employee?.profile?.userId,
    employee?.profile?.uid,
    employee?.profile?.id,
  ];

  let employeeId = "";
  for (const candidate of employeeIdCandidates) {
    const value = toId(candidate);
    if (value) {
      employeeId = value;
      break;
    }
  }

  let userId = "";
  for (const candidate of userIdCandidates) {
    const value = toId(candidate);
    if (value) {
      userId = value;
      break;
    }
  }

  return {
    employeeId,
    userId,
  };
};

const isPermissionDeniedError = (error) => {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  return (
    code.includes("permission-denied") ||
    code.includes("permission_denied") ||
    message.includes("missing or insufficient permissions")
  );
};

const assertEmployeeSelfRegistrationIsAllowed = async ({ normalizedEmail = "" } = {}) => {
  const usersRef = collection(db, "users");

  try {
    const response = await issueSessionTokenCallable({
      mode: "check_employee_credentials_email",
      email: normalizedEmail,
    });
    const payload = response?.data || {};
    if (payload?.exists === true) {
      throw new Error(
        "Registration denied. This email is already registered. Please log in instead."
      );
    }
  } catch (error) {
    const code = String(error?.code || "").toLowerCase();
    if (
      code === "functions/not-found" ||
      code === "functions/unavailable" ||
      code === "functions/internal" ||
      code === "functions/deadline-exceeded"
    ) {
      throw new Error(
        "Registration check is unavailable right now. Please try again shortly."
      );
    }
    if (error instanceof Error && /^Registration denied\./i.test(error.message || "")) {
      throw error;
    }
    if (error instanceof Error && /^Email is required\./i.test(error.message || "")) {
      throw error;
    }
    throw new Error(error?.message || "Registration check failed.");
  }

  try {
    const byEmail = await getDocs(query(usersRef, where("email", "==", normalizedEmail), limit(1)));
    if (!byEmail.empty) {
      throw new Error(
        "Registration denied. This email is already registered. Please log in instead."
      );
    }
  } catch (error) {
    if (!isPermissionDeniedError(error)) throw error;
  }

  // Guard against auth users that may exist without a matching Firestore user document.
  const signInMethods = await fetchSignInMethodsForEmail(auth, normalizedEmail);
  if (Array.isArray(signInMethods) && signInMethods.length > 0) {
    throw new Error(
      "Registration denied. This auth account already exists. Please log in instead."
    );
  }
};

const validateEmployeeSelfRegistrationEmail = async (emailValue) => {
  const normalizedEmail = normalizeEmail(emailValue || "");
  if (!normalizedEmail) throw new Error("Email is required.");
  const { matchedEmployee } = await verifyEmailInHyacinthDepartment(normalizedEmail);

  if (!matchedEmployee) {
    throw new Error(
      "Register to HyacinthHub First to Proceed Registration. Click the link to Register: https://hyacinthattendance.firebaseapp.com/register"
    );
  }

  await assertEmployeeSelfRegistrationIsAllowed({ normalizedEmail });

  const names = extractEmployeeNameDetails(matchedEmployee, normalizedEmail);
  const identifiers = extractEmployeeDirectoryIdentifiers(matchedEmployee);
  return {
    email: normalizedEmail,
    employee: matchedEmployee,
    employeeId: identifiers.employeeId,
    directoryUserId: identifiers.userId,
    ...names,
  };
};

const getActorIdentity = (actor = {}) => {
  const userId = String(
    actor?.userId ?? actor?.id ?? actor?.uid ?? actor?.firebaseUid ?? ""
  ).trim();
  const email = normalizeEmail(actor?.email || "");
  const name = String(actor?.name || actor?.displayName || "").trim() || email || "Portal User";

  return {
    userId,
    name,
    email,
  };
};

const toRequestStatus = (value) => String(value || "").trim().toLowerCase();

const buildFirebaseConfigFromEnv = () => ({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
});

const getWebCrypto = () => {
  const cryptoApi = globalThis?.crypto;
  if (!cryptoApi?.subtle || typeof cryptoApi.getRandomValues !== "function") {
    throw new Error("Secure crypto API is unavailable in this environment.");
  }
  return cryptoApi;
};

const bytesToHex = (buffer) =>
  Array.from(new Uint8Array(buffer))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

const createRandomHex = (byteLength = 16) => {
  const cryptoApi = getWebCrypto();
  const bytes = new Uint8Array(byteLength);
  cryptoApi.getRandomValues(bytes);
  return bytesToHex(bytes);
};

const sha256Hex = async (text) => {
  const cryptoApi = getWebCrypto();
  const input = new TextEncoder().encode(String(text || ""));
  const digest = await cryptoApi.subtle.digest("SHA-256", input);
  return bytesToHex(digest);
};

const buildPortalPasswordSecret = async (password) => {
  const salt = createRandomHex(16);
  const hash = await sha256Hex(`${PASSWORD_HASH_PREFIX}:${salt}:${String(password || "")}`);
  return {
    salt,
    hash,
  };
};

const verifyPortalPassword = async (password, salt, expectedHash) => {
  const normalizedSalt = String(salt || "").trim();
  const normalizedExpected = String(expectedHash || "").trim().toLowerCase();
  if (!normalizedSalt || !normalizedExpected) return false;
  const actual = await sha256Hex(
    `${PASSWORD_HASH_PREFIX}:${normalizedSalt}:${String(password || "")}`
  );
  return actual.toLowerCase() === normalizedExpected;
};

const upsertEmployeeCredentialRecord = async ({
  firestoreDb = db,
  userId = "",
  employeeId = "",
  email = "",
  firstName = "",
  lastName = "",
  fullName = "",
  passwordSecret = null,
} = {}) => {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return;

  const normalizedEmail = normalizeEmail(email);
  const normalizedFirstName = String(firstName || "").trim();
  const normalizedLastName = String(lastName || "").trim();
  const normalizedFullName =
    String(fullName || "").trim() ||
    `${normalizedFirstName} ${normalizedLastName}`.trim() ||
    normalizedEmail ||
    normalizedUserId;
  const normalizedEmployeeId = String(employeeId || "").trim();

  const payload = {
    userId: normalizedUserId,
    role: ROLES.EMPLOYEE,
    name: normalizedFullName,
    email: normalizedEmail,
    firstName: normalizedFirstName,
    lastName: normalizedLastName,
    updatedAt: serverTimestamp(),
  };

  if (normalizedEmployeeId) {
    payload.employeeId = normalizedEmployeeId;
  }

  if (passwordSecret?.salt && passwordSecret?.hash) {
    payload.portalPasswordSalt = String(passwordSecret.salt).trim();
    payload.portalPasswordHash = String(passwordSecret.hash).trim();
    payload.portalPasswordUpdatedAt = serverTimestamp();
  }

  await setDoc(
    doc(firestoreDb, EMPLOYEE_CREDENTIALS_COLLECTION, normalizedUserId),
    payload,
    { merge: true }
  );
};

const addPortalNotification = async ({
  audience = "admin",
  userId = "",
  role = "",
  type = "",
  title = "",
  message = "",
  targetPage = "",
  actorUserId = "",
  actorName = "",
  extra = {},
} = {}) => {
  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  await addDoc(collection(db, BREAK_NOTIFICATIONS_COLLECTION), {
    audience: String(audience || "").trim() || "admin",
    userId: String(userId || "").trim(),
    role: String(role || "").trim(),
    type: String(type || "").trim() || "portal_user_request",
    title: String(title || "").trim() || "Portal user request",
    message: String(message || "").trim(),
    targetPage: String(targetPage || "").trim(),
    actorUserId: String(actorUserId || "").trim(),
    actorName: String(actorName || "").trim(),
    read: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...buildTimeZoneMeta("createdAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
    ...(extra && typeof extra === "object" ? extra : {}),
  });
};

const getReadableRole = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === ROLES.ADMIN) return "Admin";
  if (normalized === ROLES.ACCOUNTING) return "Accounting";
  if (normalized === ROLES.VISITOR) return "Visitor";
  if (normalized === ROLES.SUPER_ADMIN) return "Super Admin";
  return normalized || "User";
};

const stripPasswordSecrets = (row = {}) => {
  const next = { ...(row || {}) };
  delete next.portalPasswordSalt;
  delete next.portalPasswordHash;
  return next;
};

const resolveIdentifierToEmail = async (identifierValue) => {
  const rawIdentifier = String(identifierValue || "").trim();
  if (!rawIdentifier) return "";
  if (rawIdentifier.includes("@")) return normalizeEmail(rawIdentifier);

  const usersRef = collection(db, "users");
  const byUserIdSnap = await getDocs(query(usersRef, where("userId", "==", rawIdentifier), limit(1)));
  if (!byUserIdSnap.empty) {
    const email = normalizeEmail(byUserIdSnap.docs[0]?.data()?.email || "");
    if (email) return email;
  }

  const byEmployeeIdSnap = await getDocs(
    query(usersRef, where("employeeId", "==", rawIdentifier), limit(1))
  );
  if (!byEmployeeIdSnap.empty) {
    const email = normalizeEmail(byEmployeeIdSnap.docs[0]?.data()?.email || "");
    if (email) return email;
  }

  return "";
};

export async function registerPortalUser({
  firstName,
  lastName,
  email,
  password,
  role,
  employeeId = "",
  googleProfile = null,
}) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = String(password || "").trim();
  const normalizedRole = String(role || "").trim().toLowerCase();

  if (!String(firstName || "").trim()) throw new Error("First name is required");
  if (!String(lastName || "").trim()) throw new Error("Last name is required");
  if (!normalizedEmail) throw new Error("Email is required");
  if (!normalizedPassword) throw new Error("Password is required");

  if (
    ![ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.ACCOUNTING, ROLES.VISITOR, ROLES.EMPLOYEE].includes(
      normalizedRole
    )
  ) {
    throw new Error("Invalid role selected");
  }

  let createdUser = null;
  let secondaryApp = null;
  let secondaryAuth = null;
  let secondaryDb = null;

  try {
    const appName = `portal-user-create-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    secondaryApp = initializeApp(buildFirebaseConfigFromEnv(), appName);
    secondaryAuth = getAuth(secondaryApp);
    secondaryDb = getFirestore(secondaryApp);

    const cred = await createUserWithEmailAndPassword(
      secondaryAuth,
      normalizedEmail,
      normalizedPassword
    );

    createdUser = cred.user;
    const uid = createdUser.uid;
    const passwordSecret = await buildPortalPasswordSecret(normalizedPassword);
    const normalizedFirstName = String(firstName).trim();
    const normalizedLastName = String(lastName).trim();
    const normalizedEmployeeId = String(employeeId || "").trim();
    const allowedPages = DEFAULT_ROLE_PAGES[normalizedRole] || [];
    const employeeName = `${normalizedFirstName} ${normalizedLastName}`.trim();
    const googleDetails =
      googleProfile && typeof googleProfile === "object"
        ? {
            uid: String(googleProfile?.uid || "").trim(),
            providerId: String(googleProfile?.providerId || "google.com").trim() || "google.com",
            email: normalizeEmail(googleProfile?.email || normalizedEmail),
            name: String(googleProfile?.name || "").trim(),
            username: String(googleProfile?.username || "").trim(),
            photoURL: String(googleProfile?.photoURL || "").trim(),
            googleUid: String(googleProfile?.googleUid || "").trim(),
          }
        : null;

    const userPayload = {
      uid,
      userId: uid,
      firstName: normalizedFirstName,
      lastName: normalizedLastName,
      email: normalizedEmail,
      role: normalizedRole,
      allowedPages,
      portalPasswordSalt: passwordSecret.salt,
      portalPasswordHash: passwordSecret.hash,
      portalPasswordUpdatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    if (googleDetails?.email) {
      userPayload.authProviders = ["password", "google.com"];
      userPayload.googleProfile = googleDetails;
    }

    if (normalizedRole === ROLES.EMPLOYEE && normalizedEmployeeId) {
      userPayload.employeeId = normalizedEmployeeId;
    }

    await setDoc(doc(secondaryDb, "users", uid), userPayload);

    if (normalizedRole === ROLES.EMPLOYEE) {
      await setDoc(
        doc(secondaryDb, "user_permissions", uid),
        {
          userId: uid,
          role: ROLES.EMPLOYEE,
          allowedPages,
          name: employeeName,
          email: normalizedEmail,
          ...(normalizedEmployeeId ? { employeeId: normalizedEmployeeId } : {}),
          portalPasswordSalt: passwordSecret.salt,
          portalPasswordHash: passwordSecret.hash,
          portalPasswordUpdatedAt: serverTimestamp(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      await upsertEmployeeCredentialRecord({
        firestoreDb: secondaryDb,
        userId: uid,
        employeeId: normalizedEmployeeId,
        email: normalizedEmail,
        firstName: normalizedFirstName,
        lastName: normalizedLastName,
        fullName: employeeName,
        passwordSecret,
      });
    }

    return {
      uid,
      email: normalizedEmail,
      firstName: normalizedFirstName,
      lastName: normalizedLastName,
      role: normalizedRole,
      allowedPages,
    };
  } catch (error) {
    if (createdUser) {
      try {
        await deleteUser(createdUser);
      } catch {
        // ignore cleanup failure
      }
    }
    throw error;
  } finally {
    if (secondaryAuth) {
      try {
        await signOut(secondaryAuth);
      } catch {
        // ignore cleanup failure
      }
    }
    if (secondaryApp) {
      try {
        await deleteApp(secondaryApp);
      } catch {
        // ignore cleanup failure
      }
    }
  }
}

export async function beginVisitorGoogleSelfRegistration() {
  let secondaryApp = null;
  let secondaryAuth = null;
  let secondaryDb = null;
  let popupUser = null;
  let shouldDeletePopupUser = false;

  try {
    const appName = `portal-visitor-google-prefill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    secondaryApp = initializeApp(buildFirebaseConfigFromEnv(), appName);
    secondaryAuth = getAuth(secondaryApp);
    secondaryDb = getFirestore(secondaryApp);

    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });

    const result = await signInWithPopup(secondaryAuth, provider);
    popupUser = result?.user || null;
    const googleProfile = toGoogleProfileSnapshot(popupUser);
    const additionalInfo = getAdditionalUserInfo(result);
    shouldDeletePopupUser = additionalInfo?.isNewUser === true;

    if (!googleProfile.email) {
      throw new Error("Google account is missing an email. Try a different account.");
    }

    const existingUserByEmail = await getDocs(
      query(collection(secondaryDb, "users"), where("email", "==", googleProfile.email), limit(1))
    );
    if (!existingUserByEmail.empty) {
      throw new Error(
        "Registration denied. This email is already registered. Please log in instead."
      );
    }

    const isNewGoogleAuthUser = additionalInfo?.isNewUser === true;
    if (!isNewGoogleAuthUser) {
      throw new Error(
        "This Google account already exists in authentication. Please log in or use a different Google account."
      );
    }

    return googleProfile;
  } catch (error) {
    const code = String(error?.code || "").toLowerCase();
    if (code === "auth/popup-closed-by-user") {
      throw new Error("Google sign-in was cancelled.");
    }
    if (code === "auth/cancelled-popup-request") {
      throw new Error("Another Google sign-in is in progress. Please try again.");
    }
    throw new Error(error?.message || "Could not fetch Google profile details.");
  } finally {
    if (popupUser && shouldDeletePopupUser) {
      try {
        await deleteUser(popupUser);
      } catch {
        // ignore cleanup failures for temporary google user
      }
    }
    if (secondaryAuth) {
      try {
        await signOut(secondaryAuth);
      } catch {
        // ignore cleanup failure
      }
    }
    if (secondaryApp) {
      try {
        await deleteApp(secondaryApp);
      } catch {
        // ignore cleanup failure
      }
    }
  }
}

export async function selfRegisterPortalUser({
  firstName,
  lastName,
  email,
  password,
  role,
  googleProfile = null,
} = {}) {
  const normalizedRole = normalizePortalRole(role || "");
  const normalizedEmail = normalizeEmail(email || "");
  const normalizedPassword = String(password || "").trim();
  const normalizedFirstName = String(firstName || "").trim();
  const normalizedLastName = String(lastName || "").trim();

  if (![ROLES.ADMIN, ROLES.VISITOR, ROLES.EMPLOYEE].includes(normalizedRole)) {
    throw new Error("Select a valid user type.");
  }

  if (normalizedRole === ROLES.EMPLOYEE) {
    if (!normalizedPassword) {
      throw new Error("Password is required.");
    }
    if (normalizedPassword.length < 6) {
      throw new Error("Password must be at least 6 characters.");
    }
    const verified = await validateEmployeeSelfRegistrationEmail(normalizedEmail);
    const employeeFirstName = normalizedFirstName || verified.firstName;
    const employeeLastName = normalizedLastName || verified.lastName;
    return registerPortalUser({
      firstName: employeeFirstName,
      lastName: employeeLastName,
      email: verified.email,
      password: normalizedPassword,
      role: normalizedRole,
      employeeId: verified.employeeId || verified.directoryUserId || "",
    });
  }

  if (!normalizedFirstName) throw new Error("First name is required.");
  if (!normalizedLastName) throw new Error("Last name is required.");
  if (!normalizedEmail) throw new Error("Email is required.");

  if (normalizedRole === ROLES.VISITOR) {
    if (!normalizedPassword) {
      throw new Error("Password is required.");
    }
    if (normalizedPassword.length < 6) {
      throw new Error("Password must be at least 6 characters.");
    }

    const noteParts = [];
    if (googleProfile && typeof googleProfile === "object") {
      const providerId = String(googleProfile?.providerId || "").trim();
      const username = String(googleProfile?.username || "").trim();
      if (providerId === "google.com") {
        noteParts.push("Self-registration source: Google");
      }
      if (username) {
        noteParts.push(`Google username: ${username}`);
      }
    }

    const request = await createPublicPortalUserRequest({
      firstName: normalizedFirstName,
      lastName: normalizedLastName,
      email: normalizedEmail,
      role: normalizedRole,
      note: noteParts.join(" | "),
      preferredPassword: normalizedPassword,
    });

    return {
      ...request,
      status: "pending_approval",
    };
  }

  if (!normalizedPassword) {
    throw new Error("Password is required.");
  }
  if (normalizedPassword.length < 6) {
    throw new Error("Password must be at least 6 characters.");
  }

  return registerPortalUser({
    firstName: normalizedFirstName,
    lastName: normalizedLastName,
    email: normalizedEmail,
    password: normalizedPassword,
    role: normalizedRole,
    googleProfile:
      normalizedRole === ROLES.VISITOR && googleProfile && typeof googleProfile === "object"
        ? {
            uid: String(googleProfile?.uid || "").trim(),
            providerId: String(googleProfile?.providerId || "google.com").trim() || "google.com",
            email: normalizeEmail(googleProfile?.email || normalizedEmail),
            name: String(googleProfile?.name || "").trim(),
            username: String(googleProfile?.username || "").trim(),
            photoURL: String(googleProfile?.photoURL || "").trim(),
            googleUid: String(googleProfile?.googleUid || "").trim(),
          }
        : null,
  });
}

export async function verifyEmployeeSelfRegistrationEmail(email) {
  const verified = await validateEmployeeSelfRegistrationEmail(email);
  return {
    email: verified.email,
    firstName: verified.firstName,
    lastName: verified.lastName,
    fullName: verified.fullName,
    employeeId: verified.employeeId || "",
    directoryUserId: verified.directoryUserId || "",
  };
}

export async function createPublicPortalUserRequest({
  firstName,
  lastName,
  email,
  role,
  note = "",
  preferredPassword = "",
} = {}) {
  const normalizedFirstName = String(firstName || "").trim();
  const normalizedLastName = String(lastName || "").trim();
  const normalizedEmail = normalizeEmail(email);
  const normalizedRole = normalizePublicSelfRequestRole(role);
  const normalizedNote = String(note || "").trim();
  const normalizedPreferredPassword = String(preferredPassword || "").trim();

  if (!normalizedFirstName) throw new Error("First name is required");
  if (!normalizedLastName) throw new Error("Last name is required");
  if (!normalizedEmail) throw new Error("Email is required");
  if (!normalizedRole) throw new Error("Only Admin and Visitor requests are allowed here.");
  if (normalizedPreferredPassword && normalizedPreferredPassword.length < 6) {
    throw new Error("Password must be at least 6 characters.");
  }

  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  const ref = await addDoc(collection(db, PORTAL_USER_REQUESTS_COLLECTION), {
    firstName: normalizedFirstName,
    lastName: normalizedLastName,
    email: normalizedEmail,
    role: normalizedRole,
    note: normalizedNote,
    preferredPassword: normalizedPreferredPassword,
    status: "pending",
    requestedByUserId: "public-self-registration",
    requestedByName: "Self Registration",
    requestedByEmail: normalizedEmail,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    approvedAt: null,
    approvedByUserId: "",
    approvedByName: "",
    approvedByEmail: "",
    approvedUserId: "",
    rejectedAt: null,
    rejectedByUserId: "",
    rejectedByName: "",
    rejectedByEmail: "",
    rejectionReason: "",
    ...buildTimeZoneMeta("createdAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  });

  try {
    const superAdminSnap = await getDocs(
      query(collection(db, "users"), where("role", "==", ROLES.SUPER_ADMIN))
    );
    const pendingName = `${normalizedFirstName} ${normalizedLastName}`.trim();
    const title = "New self-registration request";
    const message = `${pendingName || normalizedEmail} requested a ${getReadableRole(
      normalizedRole
    )} portal account.`;

    await Promise.all(
      superAdminSnap.docs.map((item) => {
        const superAdminId = String(item.id || "").trim();
        if (!superAdminId) return Promise.resolve();

        return addPortalNotification({
          audience: "super_admin",
          userId: superAdminId,
          role: ROLES.SUPER_ADMIN,
          type: "portal_user_request_pending",
          title,
          message,
          targetPage: "control_panel",
          actorUserId: "public-self-registration",
          actorName: "Self Registration",
          extra: {
            portalUserRequestId: ref.id,
            requestedRole: normalizedRole,
            requestedEmail: normalizedEmail,
          },
        });
      })
    );
  } catch (err) {
    console.error("Failed to notify super admins about public user request:", err);
  }

  return {
    id: ref.id,
    firstName: normalizedFirstName,
    lastName: normalizedLastName,
    email: normalizedEmail,
    role: normalizedRole,
    note: normalizedNote,
    status: "pending",
  };
}

export async function createPortalUserRequest({
  firstName,
  lastName,
  email,
  role,
  note = "",
  requestedBy = {},
}) {
  const normalizedFirstName = String(firstName || "").trim();
  const normalizedLastName = String(lastName || "").trim();
  const normalizedEmail = normalizeEmail(email);
  const normalizedRole = normalizePortalRequestRole(role);
  const normalizedNote = String(note || "").trim();
  const requester = getActorIdentity(requestedBy);

  if (!normalizedFirstName) throw new Error("First name is required");
  if (!normalizedLastName) throw new Error("Last name is required");
  if (!normalizedEmail) throw new Error("Email is required");
  if (!normalizedRole) throw new Error("Invalid role selected");
  if (!requester.userId) throw new Error("Missing requester user id");

  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  const ref = await addDoc(collection(db, PORTAL_USER_REQUESTS_COLLECTION), {
    firstName: normalizedFirstName,
    lastName: normalizedLastName,
    email: normalizedEmail,
    role: normalizedRole,
    note: normalizedNote,
    status: "pending",
    requestedByUserId: requester.userId,
    requestedByName: requester.name,
    requestedByEmail: requester.email,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    approvedAt: null,
    approvedByUserId: "",
    approvedByName: "",
    approvedByEmail: "",
    approvedUserId: "",
    rejectedAt: null,
    rejectedByUserId: "",
    rejectedByName: "",
    rejectedByEmail: "",
    rejectionReason: "",
    ...buildTimeZoneMeta("createdAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  });

  try {
    const superAdminSnap = await getDocs(
      query(collection(db, "users"), where("role", "==", ROLES.SUPER_ADMIN))
    );
    const pendingName = `${normalizedFirstName} ${normalizedLastName}`.trim();
    const title = "New user request pending";
    const message = `${requester.name} requested a ${getReadableRole(
      normalizedRole
    )} account for ${pendingName || normalizedEmail}.`;

    await Promise.all(
      superAdminSnap.docs.map((item) => {
        const superAdminId = String(item.id || "").trim();
        if (!superAdminId) return Promise.resolve();

        return addPortalNotification({
          audience: "super_admin",
          userId: superAdminId,
          role: ROLES.SUPER_ADMIN,
          type: "portal_user_request_pending",
          title,
          message,
          targetPage: "control_panel",
          actorUserId: requester.userId,
          actorName: requester.name,
          extra: {
            portalUserRequestId: ref.id,
            requestedRole: normalizedRole,
            requestedEmail: normalizedEmail,
          },
        });
      })
    );
  } catch (err) {
    console.error("Failed to notify super admins about user request:", err);
  }

  return {
    id: ref.id,
    firstName: normalizedFirstName,
    lastName: normalizedLastName,
    email: normalizedEmail,
    role: normalizedRole,
    note: normalizedNote,
    status: "pending",
  };
}

export async function getPortalUserRequests() {
  const snap = await getDocs(
    query(
      collection(db, PORTAL_USER_REQUESTS_COLLECTION),
      orderBy("createdAt", "desc"),
      limit(250)
    )
  );

  const rows = snap.docs.map((item) => {
    const row = {
      id: item.id,
      ...(item.data() || {}),
    };
    delete row.preferredPassword;
    return row;
  });

  rows.sort((a, b) => {
    const aMs = toMillis(a?.createdAt);
    const bMs = toMillis(b?.createdAt);
    return bMs - aMs;
  });

  return rows;
}

export async function approvePortalUserRequest(
  requestId,
  { password, approvedBy = {} } = {}
) {
  const normalizedRequestId = String(requestId || "").trim();
  const normalizedPassword = String(password || "").trim();
  const approver = getActorIdentity(approvedBy);

  if (!normalizedRequestId) throw new Error("Missing request id");
  if (!approver.userId) throw new Error("Missing approver user id");

  const requestRef = doc(db, PORTAL_USER_REQUESTS_COLLECTION, normalizedRequestId);
  const requestSnap = await getDoc(requestRef);

  if (!requestSnap.exists()) {
    throw new Error("Request not found");
  }

  const current = requestSnap.data() || {};
  const requestPreferredPassword = String(current?.preferredPassword || "").trim();
  const approvalPassword = normalizedPassword || requestPreferredPassword;
  if (toRequestStatus(current?.status) !== "pending") {
    throw new Error("Only pending requests can be approved");
  }
  if (!approvalPassword) throw new Error("Approval password is required");

  const result = await registerPortalUser({
    firstName: current?.firstName || "",
    lastName: current?.lastName || "",
    email: current?.email || "",
    role: current?.role || "",
    password: approvalPassword,
  });

  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  await updateDoc(requestRef, {
    status: "approved",
    approvedByUserId: approver.userId,
    approvedByName: approver.name,
    approvedByEmail: approver.email,
    approvedAt: serverTimestamp(),
    approvedUserId: String(result?.uid || "").trim(),
    updatedAt: serverTimestamp(),
    rejectionReason: "",
    rejectedAt: null,
    rejectedByUserId: "",
    rejectedByName: "",
    rejectedByEmail: "",
    preferredPassword: "",
    ...buildTimeZoneMeta("approvedAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  });

  const requesterId = String(current?.requestedByUserId || "").trim();
  if (requesterId) {
    const requestedName = `${current?.firstName || ""} ${current?.lastName || ""}`.trim();
    const requestedEmail = String(current?.email || "").trim();

    await addPortalNotification({
      audience: "admin",
      userId: requesterId,
      role: ROLES.ADMIN,
      type: "portal_user_request_approved",
      title: "User request approved",
      message: `${approver.name} approved your request for ${requestedName || requestedEmail}.`,
      actorUserId: approver.userId,
      actorName: approver.name,
      extra: {
        portalUserRequestId: normalizedRequestId,
        approvedUserId: String(result?.uid || "").trim(),
      },
    });
  }

  return {
    requestId: normalizedRequestId,
    status: "approved",
    user: result,
  };
}

export async function rejectPortalUserRequest(
  requestId,
  { reason = "", rejectedBy = {} } = {}
) {
  const normalizedRequestId = String(requestId || "").trim();
  const normalizedReason = String(reason || "").trim();
  const approver = getActorIdentity(rejectedBy);

  if (!normalizedRequestId) throw new Error("Missing request id");
  if (!approver.userId) throw new Error("Missing approver user id");

  const requestRef = doc(db, PORTAL_USER_REQUESTS_COLLECTION, normalizedRequestId);
  const requestSnap = await getDoc(requestRef);

  if (!requestSnap.exists()) {
    throw new Error("Request not found");
  }

  const current = requestSnap.data() || {};
  if (toRequestStatus(current?.status) !== "pending") {
    throw new Error("Only pending requests can be rejected");
  }

  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  await updateDoc(requestRef, {
    status: "rejected",
    rejectionReason: normalizedReason,
    rejectedByUserId: approver.userId,
    rejectedByName: approver.name,
    rejectedByEmail: approver.email,
    rejectedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    approvedAt: null,
    approvedByUserId: "",
    approvedByName: "",
    approvedByEmail: "",
    approvedUserId: "",
    preferredPassword: "",
    ...buildTimeZoneMeta("rejectedAtClient", now, storageTimeZone),
    ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
  });

  const requesterId = String(current?.requestedByUserId || "").trim();
  if (requesterId) {
    const requestedName = `${current?.firstName || ""} ${current?.lastName || ""}`.trim();
    const requestedEmail = String(current?.email || "").trim();
    const suffix = normalizedReason ? ` Reason: ${normalizedReason}` : "";

    await addPortalNotification({
      audience: "admin",
      userId: requesterId,
      role: ROLES.ADMIN,
      type: "portal_user_request_rejected",
      title: "User request rejected",
      message: `${approver.name} rejected your request for ${
        requestedName || requestedEmail
      }.${suffix}`,
      actorUserId: approver.userId,
      actorName: approver.name,
      extra: {
        portalUserRequestId: normalizedRequestId,
      },
    });
  }

  return {
    requestId: normalizedRequestId,
    status: "rejected",
    reason: normalizedReason,
  };
}

export async function loginPortalUser({ identifier = "", email = "", password }) {
  const rawIdentifier = String(identifier || email || "").trim();
  const normalizedPassword = String(password || "").trim();

  if (!rawIdentifier) throw new Error("Email or employee ID is required");
  if (!normalizedPassword) throw new Error("Password is required");

  let normalizedEmail = "";
  try {
    normalizedEmail = await resolveIdentifierToEmail(rawIdentifier);
  } catch (error) {
    const code = String(error?.code || "").trim().toLowerCase();
    if (code === "permission-denied") {
      throw new Error("Use your email address to sign in.");
    }
    throw error;
  }

  if (!normalizedEmail) throw new Error("Account not found. Use your email address or contact an admin.");

  let cred;
  try {
    cred = await signInWithEmailAndPassword(auth, normalizedEmail, normalizedPassword);
  } catch (error) {
    const code = String(error?.code || "").trim().toLowerCase();
    if (code === "auth/user-not-found") {
      throw new Error("No auth account found for this user. Ask an admin to create one.");
    }
    if (code === "auth/wrong-password" || code === "auth/invalid-credential") {
      throw new Error("Invalid password");
    }
    throw error;
  }

  const uid = cred.user.uid;
  const userRef = doc(db, "users", uid);
  const userSnap = await getDoc(userRef);

  if (!userSnap.exists()) {
    try {
      await signOut(auth);
    } catch {
      // ignore sign-out cleanup failure
    }
    throw new Error("User profile not found. Ask an admin to set up your portal profile.");
  }

  const profile = userSnap.data() || {};
  const normalizedProfile = {
    ...profile,
    uid: String(profile?.uid || uid || "").trim(),
    email: normalizeEmail(profile?.email || normalizedEmail),
  };
  const profileRole = normalizePortalRole(normalizedProfile?.role || "");
  if (
    ![ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.ACCOUNTING, ROLES.VISITOR, ROLES.EMPLOYEE].includes(
      profileRole
    )
  ) {
    try {
      await signOut(auth);
    } catch {
      // ignore sign-out cleanup failure
    }
    throw new Error("This account does not have a portal role assigned.");
  }

  const hasInternalPassword =
    !!String(normalizedProfile?.portalPasswordSalt || "").trim() &&
    !!String(normalizedProfile?.portalPasswordHash || "").trim();

  if (!hasInternalPassword) {
    const passwordSecret = await buildPortalPasswordSecret(normalizedPassword);
    await updateDoc(userRef, {
      portalPasswordSalt: passwordSecret.salt,
      portalPasswordHash: passwordSecret.hash,
      portalPasswordUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  return {
    authUser: cred.user,
    profile: normalizedProfile,
  };
}

const changeCurrentUserPassword = async ({ oldPassword, newPassword, confirmPassword }) => {
  const oldValue = String(oldPassword || "").trim();
  const newValue = String(newPassword || "").trim();
  const confirmValue = String(confirmPassword || "").trim();

  if (!oldValue) throw new Error("Old password is required.");
  if (!newValue) throw new Error("New password is required.");
  if (newValue.length < 6) throw new Error("New password must be at least 6 characters.");
  if (confirmValue && confirmValue !== newValue) {
    throw new Error("New password and confirm password do not match.");
  }

  const currentUser = auth.currentUser;
  const currentEmail = normalizeEmail(currentUser?.email || "");
  if (!currentUser || !currentEmail) {
    throw new Error("You must be signed in with an email/password account to change your password.");
  }

  try {
    const credential = EmailAuthProvider.credential(currentEmail, oldValue);
    await reauthenticateWithCredential(currentUser, credential);
    await updatePassword(currentUser, newValue);
  } catch (error) {
    const code = String(error?.code || "").trim().toLowerCase();
    if (code === "auth/wrong-password" || code === "auth/invalid-credential") {
      throw new Error("Old password is incorrect.");
    }
    throw error;
  }

  const passwordSecret = await buildPortalPasswordSecret(newValue);
  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();
  const userRef = doc(db, "users", currentUser.uid);
  const userSnap = await getDoc(userRef);
  const currentProfile = userSnap.exists() ? userSnap.data() || {} : {};
  const currentRole = normalizePortalRole(currentProfile?.role || "");
  const firstName = String(currentProfile?.firstName || "").trim();
  const lastName = String(currentProfile?.lastName || "").trim();
  const employeeName =
    String(currentProfile?.name || "").trim() ||
    `${firstName} ${lastName}`.trim() ||
    currentEmail;
  const employeeId = String(currentProfile?.employeeId || "").trim();

  await setDoc(
    userRef,
    {
      portalPasswordSalt: passwordSecret.salt,
      portalPasswordHash: passwordSecret.hash,
      portalPasswordUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      ...buildTimeZoneMeta("portalPasswordUpdatedAtClient", now, storageTimeZone),
      ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
    },
    { merge: true }
  );

  if (currentRole === ROLES.EMPLOYEE) {
    await setDoc(
      doc(db, "user_permissions", currentUser.uid),
      {
        userId: currentUser.uid,
        role: ROLES.EMPLOYEE,
        name: employeeName,
        email: currentEmail,
        ...(employeeId ? { employeeId } : {}),
        portalPasswordSalt: passwordSecret.salt,
        portalPasswordHash: passwordSecret.hash,
        portalPasswordUpdatedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        ...buildTimeZoneMeta("portalPasswordUpdatedAtClient", now, storageTimeZone),
        ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
      },
      { merge: true }
    );

    await upsertEmployeeCredentialRecord({
      userId: currentUser.uid,
      employeeId,
      email: currentEmail,
      firstName,
      lastName,
      fullName: employeeName,
      passwordSecret,
    });
  }

  return {
    success: true,
    message: "Portal password updated successfully.",
  };
};

export async function getSpecialPortalUsers() {
  const usersRef = collection(db, "users");
  const q = query(
    usersRef,
    where("role", "in", [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.ACCOUNTING, ROLES.VISITOR])
  );

  const snapshot = await getDocs(q);

  return snapshot.docs.map((docItem) => {
    const data = stripPasswordSecrets(docItem.data() || {});
    return {
      id: docItem.id,
      ...data,
    };
  });
}

export async function updatePortalUserEmail(userId, newEmail, options = {}) {
  const normalizedUserId = String(userId || "").trim();
  const normalizedEmail = normalizeEmail(newEmail);
  const requestedAuthUserId = String(options?.authUserId || "").trim();
  const requireAuthUpdate = options?.requireAuthUpdate === true;

  if (!normalizedUserId) {
    throw new Error("User id is required");
  }

  if (!normalizedEmail) {
    throw new Error("Email is required");
  }

  const currentAuthUser = auth.currentUser;
  const currentAuthUid = String(currentAuthUser?.uid || "").trim();
  const authTargetUid = requestedAuthUserId || currentAuthUid;
  const targetUserIds = Array.from(
    new Set([normalizedUserId, authTargetUid].map((x) => String(x || "").trim()).filter(Boolean))
  );
  const basePayload = {
    email: normalizedEmail,
    updatedAt: serverTimestamp(),
  };

  await Promise.all(
    targetUserIds.map(async (targetUserId) => {
      const userRef = doc(db, "users", targetUserId);
      const userSnap = await getDoc(userRef);

      if (userSnap.exists()) {
        await updateDoc(userRef, basePayload);
      } else {
        await setDoc(
          userRef,
          {
            uid: targetUserId,
            userId: targetUserId,
            ...basePayload,
          },
          { merge: true }
        );
      }
    })
  );

  const canUpdateSignedInAuthUser =
    !!currentAuthUser && !!currentAuthUid && !!authTargetUid && currentAuthUid === authTargetUid;
  let authUpdated = false;
  let authAlreadyMatched = false;
  let pendingVerification = false;

  if (canUpdateSignedInAuthUser) {
    const currentAuthEmail = normalizeEmail(currentAuthUser?.email || "");
    if (currentAuthEmail === normalizedEmail) {
      authAlreadyMatched = true;
      authUpdated = true;
    } else {
      try {
        await updateEmail(currentAuthUser, normalizedEmail);
        authUpdated = true;
      } catch (err) {
        const code = String(err?.code || "").trim().toLowerCase();
        if (code === "auth/operation-not-allowed") {
          try {
            await verifyBeforeUpdateEmail(currentAuthUser, normalizedEmail);
            pendingVerification = true;
          } catch (verifyErr) {
            const verifyCode = String(verifyErr?.code || "").trim().toLowerCase();
            if (verifyCode === "auth/invalid-email") {
              throw new Error("Please enter a valid email address.");
            }
            if (verifyCode === "auth/email-already-in-use") {
              throw new Error("That email is already in use by another account.");
            }
            if (verifyCode === "auth/requires-recent-login") {
              throw new Error("For security, log out and sign in again, then retry changing your email.");
            }
            throw verifyErr;
          }
        } else if (code === "auth/requires-recent-login") {
          throw new Error("For security, log out and sign in again, then retry changing your email.");
        } else if (code === "auth/email-already-in-use") {
          throw new Error("That email is already in use by another account.");
        } else if (code === "auth/invalid-email") {
          throw new Error("Please enter a valid email address.");
        } else {
          throw err;
        }
      }
    }
  }

  if (requireAuthUpdate && !authUpdated && !pendingVerification) {
    throw new Error(
      "Authentication email was not updated. Please sign out, sign in again, and retry."
    );
  }

  const message = authUpdated
    ? authAlreadyMatched
      ? "Email is already updated in Authentication and profile."
      : "Email updated in Authentication and profile."
    : pendingVerification
      ? "Profile email updated. Verification email sent. Please verify the new email from your inbox to complete Authentication email change."
      : "Profile email updated successfully.";

  return {
    uid: normalizedUserId,
    email: normalizedEmail,
    authUpdated,
    pendingVerification,
    profileUpdated: true,
    message,
  };
}

export async function updatePortalUserProfileDetails(userId, payload = {}) {
  const normalizedUserId = String(userId || "").trim();
  const firstName = String(payload?.firstName || "").trim();
  const lastName = String(payload?.lastName || "").trim();
  const role = normalizePortalRole(payload?.role);

  if (!normalizedUserId) throw new Error("User id is required");
  if (!firstName) throw new Error("First name is required");
  if (!lastName) throw new Error("Last name is required");
  if (!PORTAL_ROLE_OPTIONS.includes(role)) throw new Error("Invalid role");

  await updateDoc(doc(db, "users", normalizedUserId), {
    firstName,
    lastName,
    role,
    updatedAt: serverTimestamp(),
  });

  return {
    uid: normalizedUserId,
    firstName,
    lastName,
    role,
  };
}

export async function transferEmployeeToPortalRole(userId, role, employeeData = {}) {
  const normalizedUserId = String(userId || "").trim();
  const normalizedRole = normalizePortalRole(role);
  const supportedRoles = [ROLES.ADMIN, ROLES.ACCOUNTING, ROLES.VISITOR];

  if (!normalizedUserId) throw new Error("User id is required");
  if (!supportedRoles.includes(normalizedRole)) {
    throw new Error("Invalid transfer role");
  }

  const userRef = doc(db, "users", normalizedUserId);
  const userSnap = await getDoc(userRef);
  const existing = userSnap.exists() ? userSnap.data() || {} : {};

  const incomingEmail = normalizeEmail(employeeData?.email || "");
  const existingEmail = normalizeEmail(existing?.email || "");
  const finalEmail = incomingEmail || existingEmail;
  const incomingFullName = String(employeeData?.name || "").trim();
  const existingFirstName = String(existing?.firstName || "").trim();
  const existingLastName = String(existing?.lastName || "").trim();
  const rawFirstName = String(employeeData?.firstName || "").trim();
  const rawLastName = String(employeeData?.lastName || "").trim();

  const splitName = incomingFullName.split(/\s+/).filter(Boolean);
  const firstNameFromFull = splitName[0] || "";
  const lastNameFromFull = splitName.slice(1).join(" ");
  const emailNameFallback = finalEmail ? finalEmail.split("@")[0] : "";
  const finalFirstName =
    rawFirstName || existingFirstName || firstNameFromFull || emailNameFallback || "Portal";
  const finalLastName = rawLastName || existingLastName || lastNameFromFull || "User";
  const finalDisplayName =
    incomingFullName || String(existing?.name || "").trim() || `${finalFirstName} ${finalLastName}`.trim();
  const finalAllowedPages = DEFAULT_ROLE_PAGES[normalizedRole] || [];

  const userPayload = {
    uid: normalizedUserId,
    userId: normalizedUserId,
    role: normalizedRole,
    firstName: finalFirstName,
    lastName: finalLastName,
    name: finalDisplayName,
    allowedPages: finalAllowedPages,
    updatedAt: serverTimestamp(),
  };

  if (finalEmail) {
    userPayload.email = finalEmail;
  }

  const employeeId = String(
    employeeData?.employeeId || employeeData?.employee_id || existing?.employeeId || ""
  ).trim();
  if (employeeId) {
    userPayload.employeeId = employeeId;
  }

  await setDoc(userRef, userPayload, { merge: true });

  await setDoc(
    doc(db, "user_permissions", normalizedUserId),
    {
      userId: normalizedUserId,
      role: normalizedRole,
      allowedPages: finalAllowedPages,
      name: finalDisplayName,
      email: finalEmail,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  return {
    userId: normalizedUserId,
    role: normalizedRole,
    firstName: finalFirstName,
    lastName: finalLastName,
    name: finalDisplayName,
    email: finalEmail,
    allowedPages: finalAllowedPages,
  };
}

export async function transferPortalUserToEmployeeRole(userId, userData = {}) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) throw new Error("User id is required");

  const userRef = doc(db, "users", normalizedUserId);
  const userSnap = await getDoc(userRef);
  const existing = userSnap.exists() ? userSnap.data() || {} : {};

  const incomingEmail = normalizeEmail(userData?.email || "");
  const existingEmail = normalizeEmail(existing?.email || "");
  const finalEmail = incomingEmail || existingEmail;
  const incomingFullName = String(userData?.name || "").trim();
  const existingFirstName = String(existing?.firstName || "").trim();
  const existingLastName = String(existing?.lastName || "").trim();
  const rawFirstName = String(userData?.firstName || "").trim();
  const rawLastName = String(userData?.lastName || "").trim();

  const splitName = incomingFullName.split(/\s+/).filter(Boolean);
  const firstNameFromFull = splitName[0] || "";
  const lastNameFromFull = splitName.slice(1).join(" ");
  const emailNameFallback = finalEmail ? finalEmail.split("@")[0] : "";
  const finalFirstName =
    rawFirstName || existingFirstName || firstNameFromFull || emailNameFallback || "Employee";
  const finalLastName = rawLastName || existingLastName || lastNameFromFull || "User";
  const finalDisplayName =
    incomingFullName || String(existing?.name || "").trim() || `${finalFirstName} ${finalLastName}`.trim();
  const finalAllowedPages = DEFAULT_ROLE_PAGES[ROLES.EMPLOYEE] || [];

  const userPayload = {
    uid: normalizedUserId,
    userId: normalizedUserId,
    role: ROLES.EMPLOYEE,
    firstName: finalFirstName,
    lastName: finalLastName,
    name: finalDisplayName,
    allowedPages: finalAllowedPages,
    updatedAt: serverTimestamp(),
  };

  if (finalEmail) {
    userPayload.email = finalEmail;
  }

  const employeeId = String(
    userData?.employeeId || userData?.employee_id || existing?.employeeId || ""
  ).trim();
  if (employeeId) {
    userPayload.employeeId = employeeId;
  }

  await setDoc(userRef, userPayload, { merge: true });

  await setDoc(
    doc(db, "user_permissions", normalizedUserId),
    {
      userId: normalizedUserId,
      role: ROLES.EMPLOYEE,
      allowedPages: finalAllowedPages,
      name: finalDisplayName,
      email: finalEmail,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  return {
    userId: normalizedUserId,
    role: ROLES.EMPLOYEE,
    firstName: finalFirstName,
    lastName: finalLastName,
    name: finalDisplayName,
    email: finalEmail,
    allowedPages: finalAllowedPages,
  };
}

export async function deleteAdminPortalUser(userId) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) throw new Error("User id is required");
  try {
    const callable = httpsCallable(functions, "adminDeletePortalUserAccount");
    const response = await callable({
      userId: normalizedUserId,
    });
    const payload = response?.data || {};
    if (payload?.success === false) {
      throw new Error(payload?.message || "Could not delete portal user.");
    }
    return {
      userId: String(payload?.userId || normalizedUserId),
      role: normalizePortalRole(payload?.role || ""),
      email: normalizeEmail(payload?.email || ""),
      authDeleted: payload?.authDeleted !== false,
    };
  } catch (error) {
    const code = String(error?.code || "").toLowerCase();
    const message = String(error?.message || "").trim();

    if (code === "functions/unavailable") {
      throw new Error(
        "Delete service is unavailable. Deploy functions and try again."
      );
    }

    throw new Error(message || "Could not delete portal user.");
  }
}

export async function adminUpdateEmployeePortalPassword({
  userId,
  newPassword,
  employeeData = {},
} = {}) {
  const normalizedUserId = String(userId || "").trim();
  const nextPassword = String(newPassword || "").trim();

  if (!normalizedUserId) throw new Error("User id is required");
  if (!nextPassword) throw new Error("New password is required");
  if (nextPassword.length < 6) throw new Error("New password must be at least 6 characters.");
  const normalizedName = String(employeeData?.name || "").trim();
  const normalizedEmail = normalizeEmail(employeeData?.email || "");
  const normalizedEmployeeId = String(
    employeeData?.employeeId || employeeData?.employee_id || ""
  ).trim();

  try {
    const callable = httpsCallable(functions, "adminResetEmployeePassword");
    const response = await callable({
      userId: normalizedUserId,
      email: normalizedEmail,
      name: normalizedName,
      employeeId: normalizedEmployeeId,
      newPassword: nextPassword,
    });

    const payload = response?.data || {};
    if (payload?.success === false) {
      throw new Error(payload?.message || "Could not update employee password.");
    }

    return {
      userId: String(payload?.userId || normalizedUserId),
      role: ROLES.EMPLOYEE,
      authUserCreated: !!payload?.authUserCreated,
      authUserUpdated: !!payload?.authUserUpdated,
    };
  } catch (error) {
    const code = String(error?.code || "").toLowerCase();
    const message = String(error?.message || "").trim();

    if (code === "functions/unavailable") {
      throw new Error(
        "Password update service is unavailable. Deploy functions and try again."
      );
    }

    throw new Error(message || "Could not update employee password.");
  }
}

export async function sendPortalUserPasswordResetEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error("Email is required");

  await sendPasswordResetEmail(auth, normalizedEmail);

  return {
    success: true,
    email: normalizedEmail,
    message: `Password reset email sent to ${normalizedEmail}.`,
  };
}

export async function updatePortalUserAllowedPages(userId, allowedPages) {
  const cleanPages = Array.isArray(allowedPages)
    ? allowedPages.filter((page) => PAGE_KEYS.includes(page))
    : [];

  await updateDoc(doc(db, "users", userId), {
    allowedPages: cleanPages,
    updatedAt: serverTimestamp(),
  });

  return {
    uid: userId,
    allowedPages: cleanPages,
  };
}

export async function getEmployeePermission(userId) {
  if (!userId) return null;

  const snap = await getDoc(doc(db, "user_permissions", String(userId)));

  if (!snap.exists()) return null;

  return stripPasswordSecrets(snap.data() || {});
}

export async function verifyEmployeePortalPassword(
  userId,
  password,
  { permissionDoc = null, legacyPassword = "" } = {}
) {
  const normalizedUserId = String(userId || "").trim();
  const candidatePassword = String(password || "");

  if (!normalizedUserId || !candidatePassword) {
    return { valid: false, reason: "missing-input" };
  }

  const existingPermission =
    permissionDoc && typeof permissionDoc === "object"
      ? permissionDoc
      : await getEmployeePermission(normalizedUserId);
  const storedSalt = String(existingPermission?.portalPasswordSalt || "").trim();
  const storedHash = String(existingPermission?.portalPasswordHash || "").trim();

  if (storedSalt && storedHash) {
    const valid = await verifyPortalPassword(candidatePassword, storedSalt, storedHash);
    return {
      valid,
      reason: valid ? "verified" : "invalid",
    };
  }

  const legacy = String(legacyPassword || "");
  if (legacy && candidatePassword === legacy) {
    const passwordSecret = await buildPortalPasswordSecret(candidatePassword);
    const now = new Date();
    const storageTimeZone = resolveStorageTimeZone();

    await setDoc(
      doc(db, "user_permissions", normalizedUserId),
      {
        userId: normalizedUserId,
        role: ROLES.EMPLOYEE,
        portalPasswordSalt: passwordSecret.salt,
        portalPasswordHash: passwordSecret.hash,
        portalPasswordUpdatedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        ...buildTimeZoneMeta("portalPasswordUpdatedAtClient", now, storageTimeZone),
        ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
      },
      { merge: true }
    );

    return {
      valid: true,
      migrated: true,
      reason: "migrated-legacy",
    };
  }

  return { valid: false, reason: "invalid" };
}

export async function updateEmployeeAllowedPages(userId, allowedPages, employeeData = {}) {
  const normalizedUserId = String(userId || "").trim();
  const cleanPages = Array.isArray(allowedPages)
    ? allowedPages.filter((page) => PAGE_KEYS.includes(page))
    : [];
  const safeName = String(employeeData?.name || "").trim();
  const safeEmail = normalizeEmail(employeeData?.email);

  // Keep employee permissions in sync across both collections.
  await Promise.all([
    setDoc(
      doc(db, "user_permissions", normalizedUserId),
      {
        userId: normalizedUserId,
        role: ROLES.EMPLOYEE,
        allowedPages: cleanPages,
        name: safeName,
        email: safeEmail,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    ),
    setDoc(
      doc(db, "users", normalizedUserId),
      {
        uid: normalizedUserId,
        userId: normalizedUserId,
        role: ROLES.EMPLOYEE,
        allowedPages: cleanPages,
        ...(safeName ? { name: safeName } : {}),
        ...(safeEmail ? { email: safeEmail } : {}),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    ),
  ]);

  return {
    userId: normalizedUserId,
    allowedPages: cleanPages,
  };
}

export async function updateEmployeePortalPassword(userId, payload = {}) {
  return changeCurrentUserPassword({
    oldPassword: payload?.oldPassword || payload?.currentPassword || "",
    newPassword: payload?.newPassword || "",
    confirmPassword: payload?.confirmPassword || "",
  });
}

export async function updatePortalUserPassword(payload = {}) {
  return changeCurrentUserPassword({
    oldPassword: payload?.oldPassword || payload?.currentPassword || "",
    newPassword: payload?.newPassword || "",
    confirmPassword: payload?.confirmPassword || "",
  });
}

export async function logoutPortalUser() {
  await signOut(auth);
}

export async function claimPortalActiveSession({
  userId,
  role = "",
  email = "",
  name = "",
} = {}) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) {
    throw new Error("User id is required to start a session.");
  }

  const sessionKey = createRandomHex(24);
  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();

  await setDoc(
    doc(db, ACTIVE_SESSIONS_COLLECTION, normalizedUserId),
    {
      userId: normalizedUserId,
      sessionKey,
      role: normalizePortalRole(role),
      email: normalizeEmail(email),
      name: String(name || "").trim(),
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
      ...buildTimeZoneMeta("createdAtClient", now, storageTimeZone),
    },
    { merge: true }
  );

  return {
    userId: normalizedUserId,
    sessionKey,
  };
}

export async function touchPortalActiveSession({ userId, sessionKey } = {}) {
  const normalizedUserId = String(userId || "").trim();
  const expectedSessionKey = String(sessionKey || "").trim();

  if (!normalizedUserId || !expectedSessionKey) return false;

  const sessionRef = doc(db, ACTIVE_SESSIONS_COLLECTION, normalizedUserId);
  const now = new Date();
  const storageTimeZone = resolveStorageTimeZone();
  let updated = false;

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(sessionRef);
    if (!snap.exists()) return;

    const currentKey = String(snap.data()?.sessionKey || "").trim();
    if (!currentKey || currentKey !== expectedSessionKey) return;

    tx.update(sessionRef, {
      updatedAt: serverTimestamp(),
      ...buildTimeZoneMeta("updatedAtClient", now, storageTimeZone),
    });
    updated = true;
  });

  return updated;
}

export async function isPortalActiveSessionValid({ userId, sessionKey } = {}) {
  const normalizedUserId = String(userId || "").trim();
  const expectedSessionKey = String(sessionKey || "").trim();

  if (!normalizedUserId || !expectedSessionKey) return false;

  const sessionSnap = await getDoc(doc(db, ACTIVE_SESSIONS_COLLECTION, normalizedUserId));
  if (!sessionSnap.exists()) return false;

  const currentKey = String(sessionSnap.data()?.sessionKey || "").trim();
  return !!currentKey && currentKey === expectedSessionKey;
}

export function subscribeToPortalActiveSession({
  userId,
  sessionKey,
  onInvalid,
} = {}) {
  const normalizedUserId = String(userId || "").trim();
  const expectedSessionKey = String(sessionKey || "").trim();

  if (!normalizedUserId || !expectedSessionKey) {
    return () => {};
  }

  const sessionRef = doc(db, ACTIVE_SESSIONS_COLLECTION, normalizedUserId);
  return onSnapshot(sessionRef, (snap) => {
    const currentKey = snap.exists() ? String(snap.data()?.sessionKey || "").trim() : "";
    const stillValid = !!currentKey && currentKey === expectedSessionKey;

    if (!stillValid && typeof onInvalid === "function") {
      onInvalid();
    }
  });
}

export function subscribePortalActiveSessions({
  onChange,
  onError,
  staleThresholdMs = ACTIVE_SESSION_STALE_THRESHOLD_MS,
  cleanupStale = true,
} = {}) {
  const sessionsRef = collection(db, ACTIVE_SESSIONS_COLLECTION);
  const normalizedThresholdMs = Number(staleThresholdMs);
  const activeThresholdMs =
    Number.isFinite(normalizedThresholdMs) && normalizedThresholdMs > 0
      ? normalizedThresholdMs
      : ACTIVE_SESSION_STALE_THRESHOLD_MS;
  const staleCleanupCooldownMs = 10 * 60 * 1000;
  const lastCleanupAttemptByUserId = new Map();

  return onSnapshot(
    sessionsRef,
    (snapshot) => {
      const rows = [];
      const nowMs = Date.now();
      const staleUserIdsToCleanup = [];

      for (const docSnap of snapshot.docs || []) {
        const data = docSnap.data() || {};
        const userId = String(data?.userId || docSnap.id || "").trim();
        if (!userId) continue;

        const updatedAtMs = toMillis(data?.updatedAt ?? data?.updatedAtClientUtcIso ?? null);
        if (!Number.isFinite(updatedAtMs)) continue;
        if (nowMs - updatedAtMs > activeThresholdMs) {
          if (cleanupStale) {
            const lastAttemptAt = Number(lastCleanupAttemptByUserId.get(userId) || 0);
            if (!Number.isFinite(lastAttemptAt) || nowMs - lastAttemptAt >= staleCleanupCooldownMs) {
              lastCleanupAttemptByUserId.set(userId, nowMs);
              staleUserIdsToCleanup.push(userId);
            }
          }
          continue;
        }

        rows.push({
          userId,
          role: normalizePortalRole(data?.role || ""),
          name: String(data?.name || "").trim(),
          email: normalizeEmail(data?.email || ""),
          updatedAtMs,
        });
      }

      rows.sort((a, b) => {
        const left = String(a?.name || a?.email || a?.userId || "");
        const right = String(b?.name || b?.email || b?.userId || "");
        return left.localeCompare(right);
      });

      if (typeof onChange === "function") {
        onChange(rows);
      }

      if (cleanupStale && staleUserIdsToCleanup.length) {
        Promise.allSettled(
          staleUserIdsToCleanup.map((uid) =>
            deleteDoc(doc(db, ACTIVE_SESSIONS_COLLECTION, uid))
          )
        ).catch(() => {
          // Ignore stale cleanup failures (for example, permission constraints).
        });
      }
    },
    (error) => {
      if (typeof onError === "function") {
        onError(error);
      }
    }
  );
}

export async function releasePortalActiveSession({ userId, sessionKey } = {}) {
  const normalizedUserId = String(userId || "").trim();
  const expectedSessionKey = String(sessionKey || "").trim();

  if (!normalizedUserId || !expectedSessionKey) return;

  const sessionRef = doc(db, ACTIVE_SESSIONS_COLLECTION, normalizedUserId);

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(sessionRef);
    if (!snap.exists()) return;

    const currentKey = String(snap.data()?.sessionKey || "").trim();
    if (!currentKey) {
      tx.delete(sessionRef);
      return;
    }

    if (currentKey === expectedSessionKey) {
      tx.delete(sessionRef);
    }
  });
}
