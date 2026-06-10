import React, { useState } from "react";
import { registerPortalUser } from "../auth/firebaseAuthService";
import "./login.css";

export default function RegisterPortalUser() {
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    password: "",
    role: "visitor",
  });

  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);

    try {
      const result = await registerPortalUser(form);
      setMessage(`Created ${result.role}: ${result.email}`);
      setForm({
        firstName: "",
        lastName: "",
        email: "",
        password: "",
        role: "visitor",
      });
    } catch (err) {
      setError(err?.message || "Failed to register user");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-left">
          <div className="login-header">
            <h1>Register Portal User</h1>
            <p>Create Super Admin, Admin, Accounting, or Visitor accounts in Firebase.</p>
          </div>

          <form className="login-form" onSubmit={handleSubmit}>
            <div className="login-field">
              <label htmlFor="firstName">First Name</label>
              <input
                id="firstName"
                name="firstName"
                type="text"
                placeholder="Enter first name"
                value={form.firstName}
                onChange={handleChange}
              />
            </div>

            <div className="login-field">
              <label htmlFor="lastName">Last Name</label>
              <input
                id="lastName"
                name="lastName"
                type="text"
                placeholder="Enter last name"
                value={form.lastName}
                onChange={handleChange}
              />
            </div>

            <div className="login-field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                name="email"
                type="email"
                placeholder="Enter email"
                value={form.email}
                onChange={handleChange}
              />
            </div>

            <div className="login-field">
              <label htmlFor="registerPassword">Password</label>
              <input
                id="registerPassword"
                name="password"
                type="password"
                placeholder="Enter password"
                value={form.password}
                onChange={handleChange}
              />
            </div>

            <div className="login-field">
              <label htmlFor="role">Role</label>
              <select
                id="role"
                name="role"
                value={form.role}
                onChange={handleChange}
                className="login-select"
              >
                <option value="super_admin">Super Admin</option>
                <option value="admin">Admin</option>
                <option value="accounting">Accounting</option>
                <option value="visitor">Visitor</option>
              </select>
            </div>

            {error ? <div className="login-error">{error}</div> : null}
            {message ? <div className="login-success">{message}</div> : null}

            <button className="login-button" type="submit" disabled={loading}>
              {loading ? "Creating..." : "Create User"}
            </button>
          </form>

          <div className="login-note">
            <strong>Note:</strong>
            <p>
              This registration screen is intended for Super Admin account creation and internal user setup.
            </p>
          </div>
        </div>

        <div className="login-right">
          <div className="login-brand-box">
            <h2>User Registration</h2>
            <p>Accounts created here are stored in Firebase Authentication and Firestore.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
