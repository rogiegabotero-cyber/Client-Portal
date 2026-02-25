// src/App.jsx
import React, { useEffect, useState } from "react";

import Header from "./header/header";
import Sidebar from "./header/Sidebar";

import SchedulePage from "./components/SchedulePage";
import AttendancePage from "./components/AttendancePage";
import '../src/app.css'
// import DashboardPage from "./components/DashboardPage"; // optional

export default function App() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // ✅ sidebar state
  const [collapsed, setCollapsed] = useState(false);
  const [activePage, setActivePage] = useState("dashboard"); // default

  useEffect(() => {
    const apiKey = import.meta.env.VITE_HYACINTH_API_KEY;
    const departmentId = import.meta.env.VITE_HYACINTH_DEPARTMENT_ID;

    if (!apiKey || !departmentId) {
      setError("Missing VITE_HYACINTH_API_KEY or VITE_HYACINTH_DEPARTMENT_ID in .env");
      return;
    }

    let cancelled = false;

    const loadUsersByDepartment = async () => {
      setLoading(true);
      setError("");

      try {
        const response = await fetch(
          "https://us-central1-hyacinthattendance.cloudfunctions.net/getUsersByDepartment",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
            },
            body: JSON.stringify({ apiKey, departmentId }),
          }
        );

        const result = await response.json();
        if (!result.success) throw new Error(result.message);

        if (!cancelled) setEmployees(Array.isArray(result.data) ? result.data : []);
      } catch (e) {
        if (!cancelled) setError(e?.message || "Failed to load users by department");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadUsersByDepartment();
    return () => {
      cancelled = true;
    };
  }, []);
  
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      {/* ✅ Sidebar always visible */}
      <Sidebar
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        activePage={activePage}
        setActivePage={setActivePage}
        employees={employees}
      />

      {/* ✅ Main area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {/* ✅ Header always visible */}
        <Header />

        {/* Status */}
        {loading && <p style={{ padding: 16 }}>Loading users…</p>}
        {error && <p style={{ padding: 16, color: "red" }}>{error}</p>}

        {/* ✅ Page content changes */}
        <main style={{ flex: 1 }}>
          <div style={{ display: activePage === "dashboard" ? "block" : "none", padding: 16 }}>
            <h1>Dashboard</h1>
            <p>Select Attendance or Schedule from the sidebar.</p>
          </div>

          <div style={{ display: activePage === "attendance" ? "block" : "none" }}>
            <AttendancePage employees={employees} />
          </div>

          <div style={{ display: activePage === "schedule" ? "block" : "none" }}>
            <SchedulePage employees={employees} />
          </div>

          <div style={{ display: ["assignment","hours","perf_daily","perf_weekly","perf_monthly","invoices"].includes(activePage) ? "block" : "none", padding: 16 }}>
            <h1>{activePage}</h1>
            <p>Page not implemented yet.</p>
          </div>
        </main>
      </div>
    </div>
  );
}