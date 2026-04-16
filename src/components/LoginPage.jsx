import React, { useState } from "react";
import { useAuth } from "../auth/useAuth";
import { Eye, EyeOff } from "lucide-react";
import "./login.css";
import HHIUHAI from "../assets/hhi-uhai.png"

export default function LoginPage() {
  const { signIn, loading } = useAuth();

  const [form, setForm] = useState({
    identifier: "",
    password: "",
  });

  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);

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
          <div className="login-header">
            <h1>Hyacinth Client Portal</h1>
            <p>Log in to access schedules, attendance, employee information, and role-based portal pages.</p>
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

            <button className="login-button" type="submit" disabled={loading}>
              {loading ? "Signing in..." : "Log In"}
            </button>

          </form>
        </div>

        <div className="login-right"> 
          <div className="hhiuhai-logo">
            <img src={HHIUHAI} alt="" />
          </div>
          <div className="login-brand-box">
            <h2>Welcome</h2>
          </div>
        </div>
      </div>
    </div>
  );
}
