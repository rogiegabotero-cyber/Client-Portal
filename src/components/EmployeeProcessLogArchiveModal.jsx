import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import "./employeeProcessLogArchiveModal.css";
import {
  archiveEmployeeProcessActionLogs,
  clearEmployeeProcessActionLogArchive,
  deleteEmployeeProcessActionLogArchiveEntries,
} from "../services/employeeProcessLogService";
import { getBusinessDayKey } from "../utils/attendanceDate";

const RANGE_OPTIONS = [
  { key: "today", label: "Today" },
  { key: "week", label: "This Week" },
  { key: "month", label: "This Month" },
  { key: "all", label: "All" },
];

const toMs = (value) => {
  if (!value) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value?.toMillis === "function") return value.toMillis();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatLogDateTime = (value, timeZone) => {
  const ms = toMs(value);
  if (!ms) return "-";
  return new Date(ms).toLocaleString(undefined, {
    timeZone: String(timeZone || "").trim() || undefined,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

// Business-day keys ("YYYY-MM-DD") sort lexicographically, so once we know a
// week's start/end keys, range membership is just a string comparison - no
// need to convert back to a Date for the actual matching.
const getWeekStartKey = (todayKey) => {
  const [y, m, d] = todayKey.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = date.getUTCDay(); // 0=Sun .. 6=Sat
  const diffToMonday = weekday === 0 ? 6 : weekday - 1;
  date.setUTCDate(date.getUTCDate() - diffToMonday);
  return date.toISOString().slice(0, 10);
};

export default function EmployeeProcessLogArchiveModal({
  open = false,
  onClose = () => {},
  activeLogs = [],
  archiveLogs = [],
  attendanceResetTime = "05:00",
  businessTimeZone = "America/Chicago",
  actingAsUserId = "",
  actingAsName = "",
  onToast,
}) {
  const [activeTabKey, setActiveTabKey] = useState("active");
  const [step, setStep] = useState("range");
  const [selectedRangeKey, setSelectedRangeKey] = useState("");
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmingClearArchive, setConfirmingClearArchive] = useState(false);

  useEffect(() => {
    if (!open) {
      setActiveTabKey("active");
      setStep("range");
      setSelectedRangeKey("");
      setSelectedIds(new Set());
      setBusy(false);
      setError("");
      setConfirmingClearArchive(false);
    }
  }, [open]);

  const switchTab = (tabKey) => {
    if (busy) return;
    setActiveTabKey(tabKey);
    setStep("range");
    setSelectedRangeKey("");
    setSelectedIds(new Set());
    setError("");
    setConfirmingClearArchive(false);
  };

  const { todayKey, weekStartKey } = useMemo(() => {
    const key = getBusinessDayKey(Date.now(), attendanceResetTime, businessTimeZone) || "";
    return { todayKey: key, weekStartKey: key ? getWeekStartKey(key) : "" };
  }, [attendanceResetTime, businessTimeZone]);

  const matchesRange = useMemo(() => {
    return (log, rangeKey) => {
      if (rangeKey === "all") return true;
      if (!todayKey) return false;
      const logKey = getBusinessDayKey(toMs(log?.createdAtMs || log?.createdAt), attendanceResetTime, businessTimeZone);
      if (!logKey) return false;
      if (rangeKey === "today") return logKey === todayKey;
      if (rangeKey === "week") return logKey >= weekStartKey && logKey <= todayKey;
      if (rangeKey === "month") return logKey.slice(0, 7) === todayKey.slice(0, 7);
      return false;
    };
  }, [attendanceResetTime, businessTimeZone, todayKey, weekStartKey]);

  const rows = activeTabKey === "active" ? activeLogs : archiveLogs;

  const handlePickRange = (rangeKey) => {
    const matchingIds = (Array.isArray(rows) ? rows : [])
      .filter((log) => matchesRange(log, rangeKey))
      .map((log) => String(log.id));
    setSelectedRangeKey(rangeKey);
    setSelectedIds(new Set(matchingIds));
    setError("");
    setStep("select");
  };

  const handleBackToRange = () => {
    if (busy) return;
    setStep("range");
    setSelectedRangeKey("");
    setSelectedIds(new Set());
    setError("");
  };

  const toggleRow = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const key = String(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (prev.size === rows.length) return new Set();
      return new Set(rows.map((log) => String(log.id)));
    });
  };

  const selectedCount = selectedIds.size;

  const handleConfirmSelection = async () => {
    if (busy || !selectedCount) return;
    setBusy(true);
    setError("");
    try {
      const selectedLogs = rows.filter((log) => selectedIds.has(String(log.id)));

      if (activeTabKey === "active") {
        const count = await archiveEmployeeProcessActionLogs(selectedLogs, {
          archivedByUserId: actingAsUserId,
          archivedByName: actingAsName,
        });
        onToast?.({
          type: "success",
          title: "Logs Archived",
          message: `${count} inbound/new lead log item(s) moved to the archive.`,
        });
      } else {
        const count = await deleteEmployeeProcessActionLogArchiveEntries(
          selectedLogs.map((log) => log.id)
        );
        onToast?.({
          type: "success",
          title: "Archive Entries Deleted",
          message: `${count} archived log item(s) permanently deleted.`,
        });
      }

      setStep("range");
      setSelectedRangeKey("");
      setSelectedIds(new Set());
    } catch (err) {
      const message =
        err?.message ||
        (activeTabKey === "active" ? "Unable to archive selected logs." : "Unable to delete selected archive entries.");
      setError(message);
      onToast?.({ type: "error", title: "Action Failed", message });
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteOneArchived = async (log) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await deleteEmployeeProcessActionLogArchiveEntries([log.id]);
      onToast?.({
        type: "success",
        title: "Archive Entry Deleted",
        message: `Deleted "${log.actionLabel || "this entry"}" from the archive.`,
      });
    } catch (err) {
      const message = err?.message || "Unable to delete this archive entry.";
      setError(message);
      onToast?.({ type: "error", title: "Delete Failed", message });
    } finally {
      setBusy(false);
    }
  };

  const handleClearArchive = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const count = await clearEmployeeProcessActionLogArchive();
      onToast?.({
        type: count > 0 ? "success" : "info",
        title: count > 0 ? "Archive Cleared" : "Archive Already Empty",
        message:
          count > 0 ? `${count} archived log item(s) permanently deleted.` : "There were no archived logs to clear.",
      });
    } catch (err) {
      const message = err?.message || "Unable to clear the archive.";
      setError(message);
      onToast?.({ type: "error", title: "Clear Archive Failed", message });
    } finally {
      setBusy(false);
      setConfirmingClearArchive(false);
    }
  };

  if (!open) return null;

  const modalNode = (
    <div className="empLogArchiveRoot">
      <div className="empLogArchiveBackdrop" onClick={() => !busy && onClose()} />
      <div className="empLogArchivePanel" role="dialog" aria-modal="true" aria-label="Manage inbound and new lead activity log">
        <div className="empLogArchiveHeader">
          <h3>Inbound &amp; New Lead Activity Log</h3>
          <button type="button" className="empLogArchiveCloseBtn" onClick={() => !busy && onClose()} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="empLogArchiveTabs">
          <button
            type="button"
            className={`empLogArchiveTab ${activeTabKey === "active" ? "empLogArchiveTabActive" : ""}`}
            onClick={() => switchTab("active")}
            disabled={busy}
          >
            Active Log ({activeLogs.length})
          </button>
          <button
            type="button"
            className={`empLogArchiveTab ${activeTabKey === "archive" ? "empLogArchiveTabActive" : ""}`}
            onClick={() => switchTab("archive")}
            disabled={busy}
          >
            Archive ({archiveLogs.length})
          </button>
        </div>

        {error ? <div className="empLogArchiveError">{error}</div> : null}

        {step === "range" ? (
          <div className="empLogArchiveBody">
            <div className="empLogArchiveRangeRow">
              <div className="empLogArchiveRangeLabel">
                {activeTabKey === "active"
                  ? "Select a range to archive:"
                  : "Select a range to permanently delete:"}
              </div>
              <div className="empLogArchiveRangeBtns">
                {RANGE_OPTIONS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    className="empLogArchiveRangeBtn"
                    onClick={() => handlePickRange(option.key)}
                    disabled={busy || !rows.length}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {activeTabKey === "archive" ? (
                confirmingClearArchive ? (
                  <div className="empLogArchiveClearConfirm">
                    <span>Permanently delete all {archiveLogs.length} archived item(s)?</span>
                    <button
                      type="button"
                      className="empLogArchiveBtn empLogArchiveBtnDanger"
                      onClick={handleClearArchive}
                      disabled={busy}
                    >
                      {busy ? "Clearing..." : "Yes, Clear Archive"}
                    </button>
                    <button
                      type="button"
                      className="empLogArchiveBtn"
                      onClick={() => setConfirmingClearArchive(false)}
                      disabled={busy}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="empLogArchiveBtn empLogArchiveBtnDanger"
                    onClick={() => setConfirmingClearArchive(true)}
                    disabled={busy || !archiveLogs.length}
                  >
                    Clear Archive
                  </button>
                )
              ) : null}
            </div>

            <div className="empLogArchiveTableWrap">
              {rows.length === 0 ? (
                <div className="empLogArchiveEmpty">
                  {activeTabKey === "active" ? "No active log items yet." : "No archived log items yet."}
                </div>
              ) : (
                <table className="empLogArchiveTable">
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Action</th>
                      <th scope="col">Employee</th>
                      <th scope="col">By</th>
                      {activeTabKey === "archive" ? <th scope="col">Archived</th> : null}
                      {activeTabKey === "archive" ? <th scope="col"></th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((log) => (
                      <tr key={log.id}>
                        <td>{formatLogDateTime(log.createdAtMs || log.createdAt, businessTimeZone)}</td>
                        <td>{log.actionLabel || "-"}</td>
                        <td>{log.employeeName || "-"}</td>
                        <td>{log.createdByName || "-"}</td>
                        {activeTabKey === "archive" ? (
                          <td>{formatLogDateTime(log.archivedAtMs || log.archivedAt, businessTimeZone)}</td>
                        ) : null}
                        {activeTabKey === "archive" ? (
                          <td>
                            <button
                              type="button"
                              className="empLogArchiveRowDeleteBtn"
                              onClick={() => handleDeleteOneArchived(log)}
                              disabled={busy}
                              aria-label={`Delete "${log.actionLabel || "this entry"}" permanently`}
                              title="Delete permanently"
                            >
                              &times;
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        ) : (
          <div className="empLogArchiveBody">
            <div className="empLogArchiveSelectHeader">
              <button type="button" className="empLogArchiveBackBtn" onClick={handleBackToRange} disabled={busy}>
                &larr; Back
              </button>
              <div className="empLogArchiveSelectTitle">
                Select logs to {activeTabKey === "active" ? "archive" : "delete"}
                {selectedRangeKey ? ` (starting from ${RANGE_OPTIONS.find((o) => o.key === selectedRangeKey)?.label || selectedRangeKey})` : ""}
              </div>
              <label className="empLogArchiveSelectAll">
                <input
                  type="checkbox"
                  checked={rows.length > 0 && selectedCount === rows.length}
                  onChange={toggleSelectAll}
                  disabled={busy || !rows.length}
                />
                Select all
              </label>
            </div>

            <div className="empLogArchiveTableWrap">
              {rows.length === 0 ? (
                <div className="empLogArchiveEmpty">No log items to show.</div>
              ) : (
                <table className="empLogArchiveTable">
                  <thead>
                    <tr>
                      <th scope="col"></th>
                      <th scope="col">When</th>
                      <th scope="col">Action</th>
                      <th scope="col">Employee</th>
                      <th scope="col">By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((log) => {
                      const id = String(log.id);
                      return (
                        <tr
                          key={id}
                          className={selectedIds.has(id) ? "empLogArchiveRowSelected" : ""}
                          onClick={() => !busy && toggleRow(id)}
                        >
                          <td onClick={(event) => event.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selectedIds.has(id)}
                              onChange={() => toggleRow(id)}
                              disabled={busy}
                            />
                          </td>
                          <td>{formatLogDateTime(log.createdAtMs || log.createdAt, businessTimeZone)}</td>
                          <td>{log.actionLabel || "-"}</td>
                          <td>{log.employeeName || "-"}</td>
                          <td>{log.createdByName || "-"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div className="empLogArchiveSelectFooter">
              <span>{selectedCount} selected</span>
              <div className="empLogArchiveSelectActions">
                <button type="button" className="empLogArchiveBtn" onClick={handleBackToRange} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={`empLogArchiveBtn ${activeTabKey === "active" ? "empLogArchiveBtnPrimary" : "empLogArchiveBtnDanger"}`}
                  onClick={handleConfirmSelection}
                  disabled={busy || !selectedCount}
                >
                  {busy
                    ? activeTabKey === "active"
                      ? "Archiving..."
                      : "Deleting..."
                    : activeTabKey === "active"
                      ? `Archive Selected (${selectedCount})`
                      : `Delete Selected (${selectedCount})`}
                </button>
              </div>
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
