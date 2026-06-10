import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "./forgotPassword.css";
import { sendPortalUserPasswordResetEmail } from "../auth/firebaseAuthService";

export default function ForgotPasswordModal({ open = false, onClose = () => {} }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) {
      setEmail("");
      setBusy(false);
      setSubmitted(false);
      setError("");
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    const trimmed = String(email || "").trim();
    if (!trimmed) {
      setError("Enter your email address");
      return;
    }

    setBusy(true);
    try {
      await sendPortalUserPasswordResetEmail(trimmed);
      // Always show a non-revealing success message regardless of whether the email exists
      setSubmitted(true);
    } catch (err) {
      setError(err?.message || "Could not send reset email. Try again later.");
    } finally {
      setBusy(false);
    }
  };

  const modalNode = (
    <div className="forgotModalRoot">
      <div className="forgotModalBackdrop" onClick={() => { if (!busy) onClose(); }} />
      <div className="forgotModalPanel" role="dialog" aria-modal="true">
        <h3 className="forgotModalTitle">Reset password</h3>

        {!submitted ? (
          <form className="forgotModalForm" onSubmit={handleSubmit}>
            <p className="forgotModalMessage">Enter the email where you'd like the reset link sent.</p>
            <input
              className="forgotModalInput"
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              autoFocus
            />
            {error ? <div className="forgotModalError">{error}</div> : null}

            <div className="forgotModalActions">
              <button type="button" className="forgotModalBtn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="forgotModalBtn forgotModalBtnPrimary" disabled={busy}>
                {busy ? "Sending..." : "Send reset link"}
              </button>
            </div>
          </form>
        ) : (
          <div className="forgotModalSuccess">
            <p>
              A password reset link has been sent. Please
              check your inbox.
            </p>
            <div className="forgotModalActions">
              <button type="button" className="forgotModalBtn forgotModalBtnPrimary" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  if (typeof document !== "undefined" && document.body) {
    return createPortal(modalNode, document.body);
  }

  return modalNode;
}
