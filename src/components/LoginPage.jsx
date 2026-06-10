import React, { useState } from "react";
import { useAuth } from "../auth/useAuth";
import { Eye, EyeOff } from "lucide-react";
import "./login.css";
import HHIUHAI from "../assets/hhi-uhai.png"
import HHIPetals from "../assets/HHI-Petals.png";
import ForgotPasswordModal from "./ForgotPasswordModal";

export default function LoginPage({ onGoToRegister }) {
  const { signIn, loading } = useAuth();

  const [form, setForm] = useState({
    identifier: "",
    password: "",
  });

  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    try {
      await signIn(form);
    } catch (err) {
      setError(err?.message || "Login failed");
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-left">
          <div className="container-border">
            <div className="login-left-hero">
              <div className="login-left-hero-header">
                <div className="login-left-hero-header-text">
                  <h1>Welcome back</h1>
                </div>
              </div>
              <p className="login-left-hero-subtitle">Please enter your details to sign in.</p>
            </div>

            <form className="login-form" onSubmit={handleSubmit}>
              <div className="login-field">
                <label htmlFor="identifier">Email or Employee ID</label>
                <input
                  id="identifier"
                  name="identifier"
                  type="text"
                  placeholder="Enter your email or employee ID"
                  value={form.identifier}
                  onChange={handleChange}
                  autoComplete="username"
                />
              </div>

              <div className="login-field">
                <label htmlFor="password">Password</label>
                <div className="login-password-wrap">
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="Enter your password"
                    value={form.password}
                    onChange={handleChange}
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    className="login-password-toggle"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    onClick={() => setShowPassword((prev) => !prev)}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              {error ? <div className="login-error">{error}</div> : null}
              <div className="login-forgot-row">
                <button
                  type="button"
                  className="login-forgot-btn"
                  onClick={() => setForgotOpen(true)}
                >
                  Forgot password?
                </button>
              </div>
            <div className="login-primary-actions">
              <button className="login-button" type="submit" disabled={loading}>
                {loading ? "Signing in..." : "Log In"}
              </button>
              <button
                type="button"
                className="login-self-register-btn"
                onClick={() => onGoToRegister?.()}
                disabled={loading}
              >
                Self Registration
              </button>
            </div>

          </form>
        </div>
        <ForgotPasswordModal open={forgotOpen} onClose={() => setForgotOpen(false)} />
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
            <div className="login-left-hero-logo-badge login-right-side-badge">
              <img src={HHIUHAI} alt="" />
            </div>
            <div className="login-right-portal-copy">
              <h3>Hyacinth Client Portal</h3>
              <p>Log in to access schedules, attendance, employee information, and role-based portal pages.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
