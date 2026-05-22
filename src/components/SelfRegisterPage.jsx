import React, { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import {
  createPublicPortalUserRequest,
  selfRegisterPortalUser,
  verifyEmployeeSelfRegistrationEmail,
} from "../auth/firebaseAuthService";
import "./login.css";

const SELF_REGISTER_ROLES = [
  { value: "employee", label: "Employee" },
  { value: "visitor", label: "Visitor" },
  { value: "admin", label: "Admin" },
];
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [showEmployeePassword, setShowEmployeePassword] = useState(false);
  const [showEmployeeConfirmPassword, setShowEmployeeConfirmPassword] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [successEmail, setSuccessEmail] = useState("");
  const [redirectCountdown, setRedirectCountdown] = useState(SUCCESS_REDIRECT_SECONDS);

  const isEmployee = form.role === "employee";
  const isVisitorOrAdmin = form.role === "visitor" || form.role === "admin";
  const roleLabel = useMemo(
    () => SELF_REGISTER_ROLES.find((item) => item.value === form.role)?.label || "User",
    [form.role]
  );
  const stepLabels = useMemo(
    () => [
      "Select User Type",
      isEmployee ? "Verify Company Email" : "Basic Info",
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
    setStep(1);
    resetStatus();
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

  async function handleSubmitVisitorOrAdmin() {
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
      setError("Password is required.");
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
      await createPublicPortalUserRequest({
        firstName,
        lastName,
        email,
        role: form.role,
      });
      setMessage(
        `${roleLabel} registration request sent. An admin will review your request, then you can log in once approved.`
      );
    } catch (err) {
      setError(err?.message || "Could not submit request.");
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

    if (isVisitorOrAdmin) {
      await handleSubmitVisitorOrAdmin();
    }
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
                  {SELF_REGISTER_ROLES.map((item) => (
                    <label
                      key={item.value}
                      className={`self-register-role-option ${
                        form.role === item.value ? "selected" : ""
                      }`}
                    >
                      <input
                        type="radio"
                        name="role"
                        value={item.value}
                        checked={form.role === item.value}
                        onChange={() => handleRoleSelect(item.value)}
                      />
                      <span>{item.label}</span>
                    </label>
                  ))}
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

            {step === 2 && isVisitorOrAdmin ? (
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
                <div className="login-field">
                  <label htmlFor="self-password">Password</label>
                  <input
                    id="self-password"
                    name="password"
                    type="password"
                    placeholder="Create password"
                    value={form.password}
                    onChange={handleChange}
                    disabled={loading}
                  />
                </div>
                <div className="login-field">
                  <label htmlFor="self-confirm-password">Confirm Password</label>
                  <input
                    id="self-confirm-password"
                    name="confirmPassword"
                    type="password"
                    placeholder="Re-enter password"
                    value={form.confirmPassword}
                    onChange={handleChange}
                    disabled={loading}
                  />
                </div>
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
                  onClick={() => {
                    setStep((prev) => Math.max(1, prev - 1));
                    resetStatus();
                  }}
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
                  <span aria-hidden="true" className="self-register-next-arrow">→</span>
                </button>
              ) : step === 2 && isEmployee ? (
                <button className="login-button" type="submit" disabled={loading}>
                  {loading ? (
                    "Verifying..."
                  ) : (
                    <>
                      <span className="self-register-next-label">Next</span>
                      <span aria-hidden="true" className="self-register-next-arrow">→</span>
                    </>
                  )}
                </button>
              ) : (
                <button className="login-button" type="submit" disabled={loading}>
                  {loading
                    ? "Submitting..."
                    : isEmployee
                    ? "Submit Registration"
                    : "Submit Request"}
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
          <div className="login-right-spots" aria-hidden="true" />
          <div className="login-right-portal-copy">
            <h3>Registration Flow</h3>
            <p>
              Employee registration is verified against Hyacinth + Unicorn Hair data before
              credentials are saved.
            </p>
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
