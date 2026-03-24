import { auth, db } from "../firebase";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  deleteUser,
} from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
  serverTimestamp,
} from "firebase/firestore";
import { DEFAULT_ROLE_PAGES, PAGE_KEYS, ROLES } from "./roleUtils";

export async function registerPortalUser({
  firstName,
  lastName,
  email,
  password,
  role,
}) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedPassword = String(password || "").trim();
  const normalizedRole = String(role || "").trim().toLowerCase();

  if (!String(firstName || "").trim()) throw new Error("First name is required");
  if (!String(lastName || "").trim()) throw new Error("Last name is required");
  if (!normalizedEmail) throw new Error("Email is required");
  if (!normalizedPassword) throw new Error("Password is required");

  if (![ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.VISITOR].includes(normalizedRole)) {
    throw new Error("Invalid role selected");
  }

  let createdUser = null;

  try {
    const cred = await createUserWithEmailAndPassword(
      auth,
      normalizedEmail,
      normalizedPassword
    );

    createdUser = cred.user;
    const uid = createdUser.uid;

    await setDoc(doc(db, "users", uid), {
      uid,
      firstName: String(firstName).trim(),
      lastName: String(lastName).trim(),
      email: normalizedEmail,
      role: normalizedRole,
      allowedPages: DEFAULT_ROLE_PAGES[normalizedRole] || [],
      createdAt: serverTimestamp(),
    });

    return {
      uid,
      email: normalizedEmail,
      firstName: String(firstName).trim(),
      lastName: String(lastName).trim(),
      role: normalizedRole,
      allowedPages: DEFAULT_ROLE_PAGES[normalizedRole] || [],
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
  }
}

export async function loginPortalUser({ email, password }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedPassword = String(password || "").trim();

  if (!normalizedEmail) throw new Error("Email is required");
  if (!normalizedPassword) throw new Error("Password is required");

  const cred = await signInWithEmailAndPassword(
    auth,
    normalizedEmail,
    normalizedPassword
  );

  const uid = cred.user.uid;
  const userRef = doc(db, "users", uid);
  const userSnap = await getDoc(userRef);

  if (!userSnap.exists()) {
    throw new Error("User profile not found in Firestore");
  }

  return {
    authUser: cred.user,
    profile: userSnap.data(),
  };
}

export async function getSpecialPortalUsers() {
  const usersRef = collection(db, "users");
  const q = query(
    usersRef,
    where("role", "in", [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.VISITOR])
  );

  const snapshot = await getDocs(q);

  return snapshot.docs.map((docItem) => ({
    id: docItem.id,
    ...docItem.data(),
  }));
}

export async function updatePortalUserEmail(userId, newEmail) {
  const normalizedEmail = String(newEmail || "").trim().toLowerCase();

  if (!normalizedEmail) {
    throw new Error("Email is required");
  }

  await updateDoc(doc(db, "users", userId), {
    email: normalizedEmail,
    updatedAt: serverTimestamp(),
  });

  return { uid: userId, email: normalizedEmail };
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

  return snap.data();
}

export async function updateEmployeeAllowedPages(userId, allowedPages, employeeData = {}) {
  const cleanPages = Array.isArray(allowedPages)
    ? allowedPages.filter((page) => PAGE_KEYS.includes(page))
    : [];

  await setDoc(
    doc(db, "user_permissions", String(userId)),
    {
      userId: String(userId),
      role: ROLES.EMPLOYEE,
      allowedPages: cleanPages,
      name: employeeData?.name || "",
      email: employeeData?.email || "",
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  return {
    userId: String(userId),
    allowedPages: cleanPages,
  };
}

export async function updatePortalUserPassword() {
  return {
    success: true,
    message:
      "Password change UI is ready. For secure admin-side password changes of another user, connect this action to a backend or Cloud Function using Firebase Admin SDK.",
  };
}

export async function logoutPortalUser() {
  await signOut(auth);
}