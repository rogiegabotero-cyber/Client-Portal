import React, { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import {
  beginVisitorGoogleSelfRegistration,
  selfRegisterPortalUser,
  verifyEmployeeSelfRegistrationEmail,
} from "../auth/firebaseAuthService";
import "./login.css";
import HHIPetals from "../assets/HHI-Petals.png";

const SELF_REGISTER_ROLES = [
  { value: "employee", label: "Employee" },
  { value: "visitor", label: "Visitor" },
];
const TEMP_UNAVAILABLE_SELF_REGISTER_ROLES = new Set([]);
const HYACINTH_REGISTER_URL = "https://hyacinthattendance.firebaseapp.com/register";
const SUCCESS_REDIRECT_SECONDS = 15;

export default function SelfRegisterPage({ onBackToLogin }) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    role: "employee",
    firstName: "",
    lastName: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [employeeVerified, setEmployeeVerified] = useState(null);
  const [visitorGoogleProfile, setVisitorGoogleProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [showEmployeePassword, setShowEmployeePassword] = useState(false);
  const [showEmployeeConfirmPassword, setShowEmployeeConfirmPassword] = useState(false);
  const [showVisitorPassword, setShowVisitorPassword] = useState(false);
  const [showVisitorConfirmPassword, setShowVisitorConfirmPassword] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [successEmail, setSuccessEmail] = useState("");
  const [redirectCountdown, setRedirectCountdown] = useState(SUCCESS_REDIRECT_SECONDS);

  const isEmployee = form.role === "employee";
  const isVisitor = form.role === "visitor";
  const isVisitorGoogle = isVisitor && !!visitorGoogleProfile?.email;
  const stepLabels = useMemo(
    () => [
      "Select User Type",
      isEmployee ? "Verify Company Email" : "Choose Method",
      isEmployee ? "Set Password" : "Submit Request",
    ],
    [isEmployee]
  );

  useEffect(() => {
    if (!showSuccessModal) return undefined;

    setRedirectCountdown(SUCCESS_REDIRECT_SECONDS);

    const tick = setInterval(() => {
      setRedirectCountdown((prev) => Math.max(0, prev - 1));
    }, 1000);

    const timeout = setTimeout(() => {
      onBackToLogin?.();
    }, SUCCESS_REDIRECT_SECONDS * 1000);

    return () => {
      clearInterval(tick);
      clearTimeout(timeout);
    };
  }, [showSuccessModal, onBackToLogin]);

  function resetStatus() {
    setError("");
    setMessage("");
  }

  function handleGoToLogin() {
    setShowSuccessModal(false);
    onBackToLogin?.();
  }

  function handleRoleSelect(nextRole) {
    setForm((prev) => ({
      ...prev,
      role: nextRole,
      firstName: "",
      lastName: "",
      email: "",
      password: "",
      confirmPassword: "",
    }));
    setEmployeeVerified(null);
    setVisitorGoogleProfile(null);
    setShowVisitorPassword(false);
    setShowVisitorConfirmPassword(false);
    setStep(1);
    resetStatus();
  }

  function parseNameParts(rawName = "", emailFallback = "") {
    const name = String(rawName || "").trim();
    const parts = name.split(/\s+/).filter(Boolean);
    const fallback = String(emailFallback || "").trim().split("@")[0] || "Visitor";
    const firstName = parts[0] || fallback;
    const lastName = parts.slice(1).join(" ") || "User";
    return {
      firstName,
      lastName,
    };
  }

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
    if (name === "email") {
      setEmployeeVerified(null);
    }
    resetStatus();
  }

  async function handleEmployeeVerifyAndNext() {
    const normalizedEmail = String(form.email || "").trim();
    if (!normalizedEmail) {
      setError("Use the same email address you use for HyacinthHub login");
      return;
    }

    setLoading(true);
    resetStatus();
    try {
      const verified = await verifyEmployeeSelfRegistrationEmail(normalizedEmail);
      setEmployeeVerified(verified);
      setStep(3);
    } catch (err) {
      setError(err?.message || "Employee verification failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmitEmployee() {
    const password = String(form.password || "");
    const confirmPassword = String(form.confirmPassword || "");
    if (!employeeVerified?.email) {
      setError("Verify your email first.");
      return;
    }
    if (!password) {
      setError("Enter your password.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    resetStatus();
    try {
      const result = await selfRegisterPortalUser({
        role: "employee",
        email: employeeVerified.email,
        firstName: employeeVerified.firstName,
        lastName: employeeVerified.lastName,
        password,
      });
      const registeredEmail = result?.email || employeeVerified.email;
      setSuccessEmail(registeredEmail);
      setShowSuccessModal(true);
      setMessage(
        `Registration successful for ${registeredEmail}. Please log in with your credentials.`
      );
    } catch (err) {
      setError(err?.message || "Employee registration failed.");
    } finally {
      setLoading(false);
    }
  }

  function handleVisitorManualNext() {
    const firstName = String(form.firstName || "").trim();
    const lastName = String(form.lastName || "").trim();
    const email = String(form.email || "").trim();

    if (!firstName) {
      setError("First name is required.");
      return false;
    }
    if (!lastName) {
      setError("Last name is required.");
      return false;
    }
    if (!email) {
      setError("Email is required.");
      return false;
    }

    setVisitorGoogleProfile(null);
    setStep(3);
    resetStatus();
    return true;
  }

  async function handleVisitorGoogleNext() {
    setLoading(true);
    resetStatus();
    try {
      const googleProfile = await beginVisitorGoogleSelfRegistration();
      const names = parseNameParts(googleProfile?.name, googleProfile?.email);
      setVisitorGoogleProfile(googleProfile);
      setForm((prev) => ({
        ...prev,
        firstName: names.firstName,
        lastName: names.lastName,
        email: String(googleProfile?.email || "").trim(),
        password: "",
        confirmPassword: "",
      }));
      setStep(3);
    } catch (err) {
      setError(err?.message || "Google sign-in failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmitVisitor() {
    const firstName = String(form.firstName || "").trim();
    const lastName = String(form.lastName || "").trim();
    const email = String(form.email || "").trim();
    const password = String(form.password || "");
    const confirmPassword = String(form.confirmPassword || "");

    if (!firstName) {
      setError("First name is required.");
      return;
    }
    if (!lastName) {
      setError("Last name is required.");
      return;
    }
    if (!email) {
      setError("Email is required.");
      return;
    }
    if (!password) {
      setError("Enter your password.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    resetStatus();
    try {
      const result = await selfRegisterPortalUser({
        firstName,
        lastName,
        email,
        password,
        role: form.role,
        googleProfile: isVisitorGoogle ? visitorGoogleProfile : null,
      });
      setMessage(
        `Visitor registration request sent for ${result?.email || email}. Admin approval is required before login is enabled.`
      );
      setStep(1);
    } catch (err) {
      setError(err?.message || "Visitor registration failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (isEmployee) {
      if (step === 2) {
        await handleEmployeeVerifyAndNext();
        return;
      }
      if (step === 3) {
        await handleSubmitEmployee();
      }
      return;
    }

    if (isVisitor) {
      if (step === 2) {
        handleVisitorManualNext();
        return;
      }
      if (step === 3) {
        await handleSubmitVisitor();
      }
    }
  }

  function handleBackStep() {
    if (step === 3 && isVisitor && visitorGoogleProfile) {
      setVisitorGoogleProfile(null);
    }
    setStep((prev) => Math.max(1, prev - 1));
    resetStatus();
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-left self-register-left">
          <div className="login-left-hero">
            <div className="login-left-hero-header">
              <div className="login-left-hero-header-text">
                <h1>Self registration</h1>
              </div>
            </div>
            <p className="login-left-hero-subtitle">Complete your registration in guided steps.</p>
          </div>

          <div className="self-register-stepper" aria-label="Registration steps">
            {[1, 2, 3].map((stepNumber) => (
              <div
                key={`step-${stepNumber}`}
                className={`self-register-stepper-item ${step >= stepNumber ? "active" : ""}`}
              >
                <div className="self-register-stepper-circle">{stepNumber}</div>
                {stepNumber < 3 ? <div className="self-register-stepper-line" aria-hidden="true" /> : null}
                <div className="self-register-stepper-label">{stepLabels[stepNumber - 1]}</div>
              </div>
            ))}
          </div>

          <form className="login-form" onSubmit={handleSubmit}>
            {step === 1 ? (
              <fieldset className="self-register-question" disabled={loading}>
                <legend className="self-register-question-title">
                  What type of user are you registering?
                </legend>
                <div className="self-register-role-grid">
                  {SELF_REGISTER_ROLES.map((item) => {
                    const isUnavailable = TEMP_UNAVAILABLE_SELF_REGISTER_ROLES.has(item.value);
                    return (
                      <label
                        key={item.value}
                        className={`self-register-role-option ${
                          form.role === item.value ? "selected" : ""
                        } ${isUnavailable ? "unavailable" : ""}`}
                        title={isUnavailable ? "Not avilable" : undefined}
                      >
                        <input
                          type="radio"
                          name="role"
                          value={item.value}
                          checked={form.role === item.value}
                          onChange={() => {
                            if (isUnavailable) return;
                            handleRoleSelect(item.value);
                          }}
                          disabled={loading || isUnavailable}
                        />
                        <span>{item.label}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ) : null}

            {step === 2 && isEmployee ? (
              <div className="login-field">
                <label htmlFor="self-email">Hyacinth Email (Unicorn Hair)</label>
                <input
                  id="self-email"
                  name="email"
                  type="email"
                  placeholder="you@hyacinth..."
                  value={form.email}
                  onChange={handleChange}
                  disabled={loading}
                />
              </div>
            ) : null}

            {step === 2 && isVisitor ? (
              <>
                <button
                  type="button"
                  className="self-register-google-panel"
                  onClick={handleVisitorGoogleNext}
                  disabled={loading}
                >
                  <span className="self-register-google-icon" aria-hidden="true">
                    <svg viewBox="0 0 48 48" width="18" height="18">
                      <path
                        fill="#EA4335"
                        d="M24 9.5c3.2 0 6.1 1.1 8.4 3.2l6.3-6.3C34.8 2.8 29.7.5 24 .5 14.6.5 6.5 5.9 2.6 13.8l7.4 5.8C11.8 13.6 17.4 9.5 24 9.5z"
                      />
                      <path
                        fill="#4285F4"
                        d="M46.5 24.5c0-1.6-.1-3.1-.4-4.6H24v9h12.7c-.6 3-2.3 5.6-4.9 7.3l7.4 5.8c4.3-4 6.8-9.9 6.8-17.5z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M10 28.4c-.5-1.4-.8-2.9-.8-4.4s.3-3 .8-4.4l-7.4-5.8C.9 17 .5 20.4.5 24s.4 7 2.1 10.2l7.4-5.8z"
                      />
                      <path
                        fill="#34A853"
                        d="M24 47.5c6.5 0 11.9-2.2 15.9-5.9l-7.4-5.8c-2.1 1.4-4.8 2.3-8.5 2.3-6.6 0-12.2-4.1-14.2-10l-7.4 5.8C6.5 42.1 14.6 47.5 24 47.5z"
                      />
                    </svg>
                  </span>
                  <span>{loading ? "Opening Google..." : "Login with Google instead"}</span>
                </button>

                <>
                <div className="login-field">
                  <label htmlFor="self-first-name">First Name</label>
                  <input
                    id="self-first-name"
                    name="firstName"
                    type="text"
                    placeholder="Enter first name"
                    value={form.firstName}
                    onChange={handleChange}
                    disabled={loading}
                  />
                </div>
                <div className="login-field">
                  <label htmlFor="self-last-name">Last Name</label>
                  <input
                    id="self-last-name"
                    name="lastName"
                    type="text"
                    placeholder="Enter last name"
                    value={form.lastName}
                    onChange={handleChange}
                    disabled={loading}
                  />
                </div>
                <div className="login-field">
                  <label htmlFor="self-email">Email</label>
                  <input
                    id="self-email"
                    name="email"
                    type="email"
                    placeholder="Enter your email"
                    value={form.email}
                    onChange={handleChange}
                    disabled={loading}
                  />
                </div>
                </>
              </>
            ) : null}

            {step === 3 && isEmployee ? (
              <>
                <div className="login-note">
                  <strong>Verified employee email:</strong>
                  <p>{employeeVerified?.email || form.email}</p>
                </div>
                <div className="login-field">
                  <label htmlFor="self-password">Custom Password</label>
                  <div className="login-password-wrap">
                    <input
                      id="self-password"
                      name="password"
                      type={showEmployeePassword ? "text" : "password"}
                      placeholder="Create password"
                      value={form.password}
                      onChange={handleChange}
                      disabled={loading}
                    />
                    <button
                      type="button"
                      className="login-password-toggle"
                      aria-label={showEmployeePassword ? "Hide password" : "Show password"}
                      onClick={() => setShowEmployeePassword((prev) => !prev)}
                      disabled={loading}
                    >
                      {showEmployeePassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>
                <div className="login-field">
                  <label htmlFor="self-confirm-password">Verify Password</label>
                  <div className="login-password-wrap">
                    <input
                      id="self-confirm-password"
                      name="confirmPassword"
                      type={showEmployeeConfirmPassword ? "text" : "password"}
                      placeholder="Re-enter password"
                      value={form.confirmPassword}
                      onChange={handleChange}
                      disabled={loading}
                    />
                    <button
                      type="button"
                      className="login-password-toggle"
                      aria-label={showEmployeeConfirmPassword ? "Hide password" : "Show password"}
                      onClick={() => setShowEmployeeConfirmPassword((prev) => !prev)}
                      disabled={loading}
                    >
                      {showEmployeeConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            {step === 3 && isVisitor ? (
              <>
                <div className="login-note">
                  <strong>{isVisitorGoogle ? "Google profile" : "Visitor details"}</strong>
                  <p>
                    Name: {String(form.firstName || "").trim()} {String(form.lastName || "").trim()}
                  </p>
                  {isVisitorGoogle ? (
                    <p>Username: {visitorGoogleProfile?.username || "-"}</p>
                  ) : null}
                  <p>Email: {String(form.email || "").trim() || "-"}</p>
                  <p>Admin approval is required before this account can log in.</p>
                </div>
                <div className="login-field">
                  <label htmlFor="self-visitor-password">Custom Password</label>
                  <div className="login-password-wrap">
                    <input
                      id="self-visitor-password"
                      name="password"
                      type={showVisitorPassword ? "text" : "password"}
                      placeholder="Create password"
                      value={form.password}
                      onChange={handleChange}
                      disabled={loading}
                    />
                    <button
                      type="button"
                      className="login-password-toggle"
                      aria-label={showVisitorPassword ? "Hide password" : "Show password"}
                      onClick={() => setShowVisitorPassword((prev) => !prev)}
                      disabled={loading}
                    >
                      {showVisitorPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>
                <div className="login-field">
                  <label htmlFor="self-visitor-confirm-password">Verify Password</label>
                  <div className="login-password-wrap">
                    <input
                      id="self-visitor-confirm-password"
                      name="confirmPassword"
                      type={showVisitorConfirmPassword ? "text" : "password"}
                      placeholder="Re-enter password"
                      value={form.confirmPassword}
                      onChange={handleChange}
                      disabled={loading}
                    />
                    <button
                      type="button"
                      className="login-password-toggle"
                      aria-label={showVisitorConfirmPassword ? "Hide password" : "Show password"}
                      onClick={() => setShowVisitorConfirmPassword((prev) => !prev)}
                      disabled={loading}
                    >
                      {showVisitorConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            {error ? (
              <div className="login-error">
                {error.includes(HYACINTH_REGISTER_URL) ? (
                  <>
                    {error.replace(HYACINTH_REGISTER_URL, "").trim()}{" "}
                    <a
                      href={HYACINTH_REGISTER_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {HYACINTH_REGISTER_URL}
                    </a>
                  </>
                ) : (
                  error
                )}
              </div>
            ) : null}
            {message ? <div className="login-success">{message}</div> : null}

            <div className={`login-register-actions ${step === 1 ? "single-action" : ""}`}>
              {step > 1 ? (
                <button
                  type="button"
                  className="login-secondary-button"
                  onClick={handleBackStep}
                  disabled={loading}
                >
                  Back
                </button>
              ) : null}

              {step === 1 ? (
                <button
                  type="button"
                  className="login-button"
                  onClick={() => {
                    setStep(2);
                    resetStatus();
                  }}
                  disabled={loading}
                >
                  <span className="self-register-next-label">Next</span>
                  <span aria-hidden="true" className="self-register-next-arrow">{"->"}</span>
                </button>
              ) : step === 2 && isEmployee ? (
                <button className="login-button" type="submit" disabled={loading}>
                  {loading ? (
                    "Verifying..."
                  ) : (
                    <>
                      <span className="self-register-next-label">Next</span>
                      <span aria-hidden="true" className="self-register-next-arrow">{"->"}</span>
                    </>
                  )}
                </button>
              ) : step === 2 && isVisitor ? (
                <button className="login-button" type="submit" disabled={loading}>
                  <span className="self-register-next-label">Next</span>
                  <span aria-hidden="true" className="self-register-next-arrow">{"->"}</span>
                </button>
              ) : (
                <button className="login-button" type="submit" disabled={loading}>
                  {loading ? "Submitting..." : isVisitor ? "Submit Request" : "Submit Registration"}
                </button>
              )}
            </div>
          </form>

          <button
            type="button"
            className="self-register-cancel-link"
            onClick={() => onBackToLogin?.()}
            disabled={loading}
          >
            Cancel Registration
          </button>
        </div>

        <div className="login-right login-right--petals">
          <div className="login-right-spots" aria-hidden="true">
            <span className="login-right-spot login-right-spot--1" />
            <span className="login-right-spot login-right-spot--2" />
            <span className="login-right-spot login-right-spot--3" />
            <span className="login-right-spot login-right-spot--4" />
            <span className="login-right-spot login-right-spot--5" />
            <span className="login-right-spot login-right-spot--6" />
            <span className="login-right-spot login-right-spot--white login-right-spot--w1" />
            <span className="login-right-spot login-right-spot--white login-right-spot--w2" />
            <span className="login-right-spot login-right-spot--white login-right-spot--w3" />
            <span className="login-right-spot login-right-spot--white login-right-spot--w4" />
            <span className="login-right-spot login-right-spot--white login-right-spot--white-lg login-right-spot--w5" />
            <span className="login-right-spot login-right-spot--white login-right-spot--white-lg login-right-spot--w6" />
            <span className="login-right-spot login-right-spot--white login-right-spot--white-lg login-right-spot--w7" />
            <span className="login-right-spot login-right-spot--white login-right-spot--white-xs login-right-spot--w8" />
            <span className="login-right-spot login-right-spot--white login-right-spot--white-xs login-right-spot--w9" />
            <span className="login-right-spot login-right-spot--white login-right-spot--white-xs login-right-spot--w10" />
            <span className="login-right-spot login-right-spot--white login-right-spot--white-xs login-right-spot--w11" />
            <span className="login-right-spot login-right-spot--white login-right-spot--white-xs login-right-spot--w12" />
          </div>
          <div className="login-right-petals-bg" aria-hidden="true">
            <img src={HHIPetals} alt="" />
          </div>
          <div className="login-right-center-brand">
            <div className="login-right-portal-copy">
              <h3>Registration Flow</h3>
              <p>
                Employee registration is verified against Hyacinth + Unicorn Hair data before
                credentials are saved.
              </p>
            </div>
          </div>
        </div>
      </div>

      {showSuccessModal ? (
        <div className="self-register-success-modal-backdrop" role="presentation">
          <div
            className="self-register-success-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="self-register-success-title"
          >
            <h3 id="self-register-success-title">Registration confirmed</h3>
            <p>
              Registration successful for <strong>{successEmail}</strong>. Please log in with your
              credentials.
            </p>
            <div className="self-register-success-actions">
              <button type="button" className="login-button" onClick={handleGoToLogin}>
                Log In
              </button>
              <span className="self-register-success-timer">{redirectCountdown}s</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}


