import React, { useEffect, useMemo, useState } from "react";
import "./assignment.css";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Plus,
  Search,
  X,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Trash2,
} from "lucide-react";
import {
  getDaysUntilDeadline,
} from "../services/assignmentService";

const normalize = (s) => String(s || "").toLowerCase().trim();

const toText = (value) => String(value || "").trim();

const getViewerUserId = (viewer) =>
  toText(
    viewer?.userId ??
      viewer?.id ??
      viewer?.uid ??
      viewer?.firebaseUid ??
      viewer?.employeeId ??
      ""
  );

const getViewerName = (viewer) =>
  toText(viewer?.name) || toText(viewer?.displayName) || toText(viewer?.email) || "User";

const isAdminLikeRole = (role) => {
  const r = normalize(role);
  return r === "admin" || r === "super_admin" || r === "super admin";
};

const getUserId = (emp) =>
  emp?.userId ??
  emp?.userID ??
  emp?.user_id ??
  emp?.UserId ??
  emp?.uid ??
  emp?.firebaseUid ??
  emp?.id ??
  emp?.employeeId ??
  emp?._id ??
  emp?.user?.id ??
  emp?.user?.uid ??
  emp?.user?.userId ??
  null;

const getDisplayName = (emp) =>
  emp?.name ??
  emp?.fullName ??
  emp?.displayName ??
  emp?.email ??
  `User ${String(getUserId(emp) ?? "")}`.trim();

const getEmployeePosition = (emp, employeeProfilesByUserId = {}) => {
  const uid = String(getUserId(emp) || "");
  const profile = employeeProfilesByUserId?.[uid] || {};

  return (
    emp?.position ||
    emp?.role ||
    emp?.jobTitle ||
    profile?.position ||
    profile?.role ||
    profile?.jobTitle ||
    "Unassigned Position"
  );
};

const firstDayOfMonth = (date) =>
  new Date(date.getFullYear(), date.getMonth(), 1);

const lastDayOfMonth = (date) =>
  new Date(date.getFullYear(), date.getMonth() + 1, 0);

const getCalendarGridDates = (baseDate) => {
  const start = firstDayOfMonth(baseDate);
  const end = lastDayOfMonth(baseDate);

  const gridStart = new Date(start);
  gridStart.setDate(start.getDate() - start.getDay());

  const gridEnd = new Date(end);
  gridEnd.setDate(end.getDate() + (6 - end.getDay()));

  const dates = [];
  const cur = new Date(gridStart);

  while (cur <= gridEnd) {
    dates.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }

  return dates;
};

const toYmd = (date) => {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
};

const prettyMonth = (date) =>
  date.toLocaleDateString([], { month: "long", year: "numeric" });

const prettyDate = (dateStr) => {
  if (!dateStr) return "-";
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const getTaskStatusMeta = (task) => {
  const days = getDaysUntilDeadline(task?.deadlineDate);

  if (task?.status === "completed") {
    return { label: "Completed", tone: "completed" };
  }
  if (days !== null && days < 0) {
    return { label: "Overdue", tone: "overdue" };
  }
  if (days === 0) {
    return { label: "Due Today", tone: "today" };
  }
  if (days === 1) {
    return { label: "Due Tomorrow", tone: "warning" };
  }
  return { label: task?.status || "Pending", tone: "pending" };
};

export default function AssignmentPage({
  employees = [],
  viewer = null,
  assignments = [],
  loadingAssignments = false,
  assignmentsError = "",
  employeeProfilesByUserId = {},
  onReloadAssignments,
  onCreateAssignment,
  onUpdateAssignment,
  onDeleteAssignment,
  onMarkAssignmentCompleted,
  onRequestAssignmentAccess,
  onApproveAssignmentAccess,
  onToast,
}) {
  const [query, setQuery] = useState("");
  const [selectedAssigneeIds, setSelectedAssigneeIds] = useState([]);
  const [selectedTask, setSelectedTask] = useState(null);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: "",
    instructions: "",
    deadlineDate: "",
    deadlineTime: "",
    priority: "medium",
  });

  const viewerId = useMemo(() => getViewerUserId(viewer), [viewer]);
  const viewerName = useMemo(() => getViewerName(viewer), [viewer]);
  const viewerRole = useMemo(() => normalize(viewer?.role), [viewer?.role]);
  const isManager = useMemo(() => isAdminLikeRole(viewerRole), [viewerRole]);
  const canCreateAssignments = useMemo(
    () => isManager || viewerRole === "visitor",
    [isManager, viewerRole]
  );

  const validEmployees = useMemo(
    () => (Array.isArray(employees) ? employees : []).filter((e) => !!getUserId(e)),
    [employees]
  );

  const employeeOptions = useMemo(() => {
    return validEmployees.map((emp) => {
      const uid = String(getUserId(emp));
      return {
        userId: uid,
        name: getDisplayName(emp),
        position: getEmployeePosition(emp, employeeProfilesByUserId),
        raw: emp,
      };
    });
  }, [validEmployees, employeeProfilesByUserId]);

  const employeeNameById = useMemo(() => {
    const map = {};
    for (const emp of employeeOptions) {
      map[String(emp.userId)] = emp.name;
    }
    return map;
  }, [employeeOptions]);

  useEffect(() => {
    const validIds = new Set(employeeOptions.map((item) => String(item.userId)));
    setSelectedAssigneeIds((prev) => {
      const cleaned = (Array.isArray(prev) ? prev : []).filter((id) => validIds.has(String(id)));
      if (cleaned.length > 0) return cleaned;
      return employeeOptions.length ? [String(employeeOptions[0].userId)] : [];
    });
  }, [employeeOptions]);

  useEffect(() => {
    if (!selectedTask?.id) return;

    const updated = assignments.find((row) => String(row?.id) === String(selectedTask.id));
    if (!updated) {
      setSelectedTask(null);
      return;
    }

    if (updated !== selectedTask) {
      setSelectedTask(updated);
    }
  }, [assignments, selectedTask]);

  const selectedAssignees = useMemo(
    () =>
      employeeOptions.filter((item) =>
        selectedAssigneeIds.includes(String(item.userId))
      ),
    [employeeOptions, selectedAssigneeIds]
  );

  const toggleAssigneeSelection = (userId) => {
    const id = String(userId);
    setSelectedAssigneeIds((prev) => {
      const current = Array.isArray(prev) ? prev.map((v) => String(v)) : [];
      if (current.includes(id)) {
        return current.filter((v) => v !== id);
      }
      return [...current, id];
    });
  };

  const assignmentStats = useMemo(() => {
    const total = assignments.length;
    const completed = assignments.filter((a) => a.status === "completed").length;
    const pending = assignments.filter((a) => a.status !== "completed").length;
    const overdue = assignments.filter((a) => {
      const days = getDaysUntilDeadline(a.deadlineDate);
      return a.status !== "completed" && days !== null && days < 0;
    }).length;

    return { total, completed, pending, overdue };
  }, [assignments]);

  const filteredAssignments = useMemo(() => {
    const q = normalize(query);

    return assignments.filter((task) => {
      if (!q) return true;

      return (
        normalize(task?.title).includes(q) ||
        normalize(task?.instructions).includes(q) ||
        normalize(task?.employeeName).includes(q) ||
        normalize(task?.employeePosition).includes(q) ||
        normalize(task?.deadlineDate).includes(q) ||
        normalize(task?.priority).includes(q)
      );
    });
  }, [assignments, query]);

  const assignmentsByDate = useMemo(() => {
    const map = new Map();

    for (const task of filteredAssignments) {
      const key = String(task?.deadlineDate || "");
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(task);
    }

    return map;
  }, [filteredAssignments]);

  const myTasks = useMemo(() => {
    if (!viewerId) return [];
    return assignments.filter((item) => {
      const ids = Array.isArray(item?.employeeUserIds)
        ? item.employeeUserIds.map((id) => String(id))
        : [];
      if (ids.length > 0) return ids.includes(viewerId);
      return String(item?.employeeUserId) === viewerId;
    });
  }, [assignments, viewerId]);

  const calendarDates = useMemo(() => getCalendarGridDates(calendarMonth), [calendarMonth]);

  const getTaskAccessState = (task) => {
    const assignedUserIds = Array.isArray(task?.employeeUserIds)
      ? task.employeeUserIds.map((id) => toText(id)).filter(Boolean)
      : [toText(task?.employeeUserId)].filter(Boolean);
    const approvedUserIds = Array.isArray(task?.accessApprovedUserIds)
      ? task.accessApprovedUserIds.map((id) => toText(id)).filter(Boolean)
      : [];
    const requestedUserIds = Array.isArray(task?.accessRequestedByUserIds)
      ? task.accessRequestedByUserIds.map((id) => toText(id)).filter(Boolean)
      : [];

    const isOwner = !!viewerId && assignedUserIds.includes(viewerId);
    const hasApprovedAccess = !!viewerId && approvedUserIds.includes(viewerId);
    const alreadyRequested = !!viewerId && requestedUserIds.includes(viewerId);
    const canComplete = isManager || isOwner || hasApprovedAccess;
    const canRequestAccess =
      !isManager && !!viewerId && !canComplete && String(task?.status || "") !== "completed";

    return {
      assignedUserIds,
      approvedUserIds,
      requestedUserIds,
      isOwner,
      hasApprovedAccess,
      alreadyRequested,
      canComplete,
      canRequestAccess,
    };
  };

  const selectedTaskAccess = selectedTask ? getTaskAccessState(selectedTask) : null;

  const resetForm = () => {
    setForm({
      title: "",
      instructions: "",
      deadlineDate: "",
      deadlineTime: "",
      priority: "medium",
    });
  };

  const handleCreateAssignment = async (e) => {
    e.preventDefault();

    if (!canCreateAssignments) {
      onToast?.({
        type: "warning",
        title: "Action Restricted",
        message: "Only admins and visitors can create assignments.",
      });
      return;
    }

    if (!selectedAssignees.length || !form.title.trim() || !form.deadlineDate) {
      onToast?.({
        type: "warning",
        title: "Missing Fields",
        message: "Please select at least one assignee, task title, and deadline date.",
      });
      return;
    }

    setSaving(true);

    try {
      if (!onCreateAssignment) {
        throw new Error("Create action is unavailable");
      }

      const assignees = selectedAssignees.map((item) => ({
        userId: String(item.userId),
        name: item.name,
        position: item.position,
      }));

      await onCreateAssignment({
        assignees,
        employeeUserId: assignees[0]?.userId || "",
        employeeName: assignees.map((item) => item.name).join(", "),
        employeePosition: assignees.map((item) => item.position).filter(Boolean).join(", "),
        title: form.title.trim(),
        instructions: form.instructions.trim(),
        deadlineDate: form.deadlineDate,
        deadlineTime: form.deadlineTime,
        priority: form.priority,
        status: "pending",
        createdByUserId: viewerId,
        createdByName: viewerName,
      });

      resetForm();
      await onReloadAssignments?.();

      onToast?.({
        type: "success",
        title: "Assignment Saved",
        message: `Task assigned to ${selectedAssignees.length} agent${selectedAssignees.length === 1 ? "" : "s"}.`,
      });
    } catch (err) {
      console.error("Failed to create assignment:", err);
      onToast?.({
        type: "error",
        title: "Save Failed",
        message: "Could not save assignment.",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleMarkCompleted = async (task) => {
    const access = getTaskAccessState(task);
    if (!access.canComplete) {
      onToast?.({
        type: "warning",
        title: "Access Needed",
        message: "You need manager approval to complete this task.",
      });
      return;
    }

    try {
      if (!onMarkAssignmentCompleted) {
        throw new Error("Complete action is unavailable");
      }

      await onMarkAssignmentCompleted(task.id, {
        userId: viewerId,
        name: viewerName,
        role: viewerRole,
      });
      if (selectedTask?.id === task.id) {
        setSelectedTask({
          ...task,
          status: "completed",
          completedByUserId: viewerId,
          completedByName: viewerName,
        });
      }
      onToast?.({
        type: "success",
        title: "Task Completed",
        message: `"${task.title}" marked as completed by ${viewerName}.`,
      });
    } catch (err) {
      console.error("Failed to complete task:", err);
      onToast?.({
        type: "error",
        title: "Complete Failed",
        message: err?.message || "Could not complete task.",
      });
    }
  };

  const handleDeleteTask = async (task) => {
    if (!isManager) {
      onToast?.({
        type: "warning",
        title: "Action Restricted",
        message: "Only admins can delete assignments.",
      });
      return;
    }

    const ok = window.confirm(`Delete task "${task.title}"?`);
    if (!ok) return;

    try {
      if (!onDeleteAssignment) {
        throw new Error("Delete action is unavailable");
      }

      await onDeleteAssignment(task.id);
      if (selectedTask?.id === task.id) setSelectedTask(null);
      onToast?.({
        type: "success",
        title: "Task Deleted",
        message: "Assignment removed successfully.",
      });
    } catch (err) {
      console.error("Failed to delete task:", err);
      onToast?.({
        type: "error",
        title: "Delete Failed",
        message: "Could not delete assignment.",
      });
    }
  };

  const handleStatusChange = async (task, nextStatus) => {
    if (!isManager) {
      onToast?.({
        type: "warning",
        title: "Action Restricted",
        message: "Only admins can change assignment status.",
      });
      return;
    }

    try {
      if (!onUpdateAssignment) {
        throw new Error("Update action is unavailable");
      }

      await onUpdateAssignment(task.id, { status: nextStatus });
      if (selectedTask?.id === task.id) {
        setSelectedTask({ ...task, status: nextStatus });
      }
    } catch (err) {
      console.error("Failed to update task status:", err);
    }
  };

  const handleRequestAccess = async (task) => {
    const access = getTaskAccessState(task);
    if (!access.canRequestAccess) return;

    try {
      if (!onRequestAssignmentAccess) {
        throw new Error("Access request action is unavailable");
      }

      await onRequestAssignmentAccess(task.id, {
        requesterUserId: viewerId,
        requesterName: viewerName,
        requesterRole: viewerRole,
      });

      onToast?.({
        type: "success",
        title: "Request Sent",
        message: `Access request sent to manager for "${task.title}".`,
      });

      await onReloadAssignments?.();
    } catch (err) {
      console.error("Failed to request assignment access:", err);
      onToast?.({
        type: "error",
        title: "Request Failed",
        message: err?.message || "Could not request assignment access.",
      });
    }
  };

  const handleApproveAccess = async (task, requesterUserId) => {
    try {
      if (!onApproveAssignmentAccess) {
        throw new Error("Approve access action is unavailable");
      }

      await onApproveAssignmentAccess(task.id, requesterUserId, {
        userId: viewerId,
        name: viewerName,
        role: viewerRole,
      });

      onToast?.({
        type: "success",
        title: "Access Approved",
        message: `${employeeNameById[String(requesterUserId)] || requesterUserId} can now complete "${task.title}".`,
      });
    } catch (err) {
      console.error("Failed to approve assignment access:", err);
      onToast?.({
        type: "error",
        title: "Approval Failed",
        message: err?.message || "Could not approve assignment access.",
      });
    }
  };

  return (
    <div className="assignment-page">
      <div className="assignment-header">
        <div>
          <h1 className="assignment-title">Assignment Management</h1>
          <p className="assignment-subtitle">
            Assign tasks, track deadlines, and monitor employee deliverables in a calendar layout.
          </p>
        </div>

        <div className="assignment-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search task, employee, deadline, priority..."
          />
        </div>
      </div>

      {assignmentsError ? (
        <div className="assignment-empty assignment-empty-spaced">
          {assignmentsError}
        </div>
      ) : null}

      <div className="assignment-stats">
        <div className="assignment-stat-card">
          <div className="assignment-stat-label">Total Tasks</div>
          <div className="assignment-stat-value">{assignmentStats.total}</div>
        </div>
        <div className="assignment-stat-card">
          <div className="assignment-stat-label">Pending</div>
          <div className="assignment-stat-value">{assignmentStats.pending}</div>
        </div>
        <div className="assignment-stat-card">
          <div className="assignment-stat-label">Completed</div>
          <div className="assignment-stat-value">{assignmentStats.completed}</div>
        </div>
        <div className="assignment-stat-card danger">
          <div className="assignment-stat-label">Overdue</div>
          <div className="assignment-stat-value">{assignmentStats.overdue}</div>
        </div>
      </div>

      <div className="assignment-layout">
        <section className="assignment-left">
          {canCreateAssignments ? (
            <>
              <div className="assignment-panel">
                <div className="assignment-panel-head">
                  <ClipboardList size={16} />
                  <span>Create Assignment</span>
                </div>

                <form className="assignment-form" onSubmit={handleCreateAssignment}>
                  <label className="assignment-field">
                    <span>Assignees (check all that apply)</span>
                    <div className="assignment-checkbox-list" role="group" aria-label="Assignees">
                      {employeeOptions.map((emp) => (
                        <label key={emp.userId} className="assignment-checkbox-item">
                          <input
                            type="checkbox"
                            checked={selectedAssigneeIds.includes(String(emp.userId))}
                            onChange={() => toggleAssigneeSelection(emp.userId)}
                          />
                          <span className="assignment-checkbox-item-text">
                            <span className="assignment-checkbox-name">{emp.name}</span>
                            <span className="assignment-checkbox-position">{emp.position}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </label>

                  <div className="assignment-employee-preview">
                    <div className="assignment-employee-name">
                      {selectedAssignees.length
                        ? selectedAssignees.map((item) => item.name).join(", ")
                        : "No assignees selected"}
                    </div>
                    <div className="assignment-employee-position">
                      {selectedAssignees.length} assignee{selectedAssignees.length === 1 ? "" : "s"} selected
                    </div>
                  </div>

                  <label className="assignment-field">
                    <span>Task Title</span>
                    <input
                      type="text"
                      value={form.title}
                      onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
                      placeholder="Enter specific task"
                    />
                  </label>

                  <label className="assignment-field">
                    <span>Instructions</span>
                    <textarea
                      rows={5}
                      value={form.instructions}
                      onChange={(e) => setForm((p) => ({ ...p, instructions: e.target.value }))}
                      placeholder="Enter detailed instructions for the employee"
                    />
                  </label>

                  <div className="assignment-grid-2">
                    <label className="assignment-field">
                      <span>Deadline Date</span>
                      <input
                        type="date"
                        value={form.deadlineDate}
                        onChange={(e) => setForm((p) => ({ ...p, deadlineDate: e.target.value }))}
                      />
                    </label>

                    <label className="assignment-field">
                      <span>Deadline Time</span>
                      <input
                        type="time"
                        value={form.deadlineTime}
                        onChange={(e) => setForm((p) => ({ ...p, deadlineTime: e.target.value }))}
                      />
                    </label>
                  </div>

                  <label className="assignment-field">
                    <span>Priority</span>
                    <select
                      value={form.priority}
                      onChange={(e) => setForm((p) => ({ ...p, priority: e.target.value }))}
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="urgent">Urgent</option>
                    </select>
                  </label>

                  <button className="assignment-primary-btn" type="submit" disabled={saving}>
                    <Plus size={16} />
                    <span>{saving ? "Saving..." : "Assign Task"}</span>
                  </button>
                </form>
              </div>

            </>
          ) : null}

          <div className="assignment-panel">
            <div className="assignment-panel-head">
              <span>My Tasks</span>
              <span className="assignment-count">{myTasks.length}</span>
            </div>

            <div className="assignment-task-list compact">
              {myTasks.length === 0 ? (
                <div className="assignment-empty">No tasks for current viewer.</div>
              ) : (
                myTasks.map((task) => {
                  const meta = getTaskStatusMeta(task);
                  return (
                    <button
                      type="button"
                      key={task.id}
                      className="assignment-task-card compact"
                      onClick={() => setSelectedTask(task)}
                    >
                      <div className="assignment-task-card-top">
                        <div className="assignment-task-card-title">{task.title}</div>
                        <span className={`assignment-status-pill ${meta.tone}`}>
                          {meta.label}
                        </span>
                      </div>
                      <div className="assignment-task-card-meta">
                        <span>{task.employeeName}</span>
                        <span>{prettyDate(task.deadlineDate)}</span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </section>

        <section className="assignment-right">
          <div className="assignment-panel calendar-panel">
            <div className="assignment-calendar-header">
              <div className="assignment-calendar-title-wrap">
                <CalendarDays size={18} />
                <h2>{prettyMonth(calendarMonth)}</h2>
              </div>

              <div className="assignment-calendar-nav">
                <button
                  type="button"
                  onClick={() =>
                    setCalendarMonth(
                      (prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1)
                    )
                  }
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => setCalendarMonth(new Date())}
                >
                  Today
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setCalendarMonth(
                      (prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1)
                    )
                  }
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>

            <div className="assignment-calendar-weekdays">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                <div key={day} className="assignment-calendar-weekday">
                  {day}
                </div>
              ))}
            </div>

            <div className="assignment-calendar-grid">
              {calendarDates.map((dateObj) => {
                const ymd = toYmd(dateObj);
                const dayTasks = assignmentsByDate.get(ymd) || [];
                const isCurrentMonth =
                  dateObj.getMonth() === calendarMonth.getMonth();
                const isToday = ymd === toYmd(new Date());

                return (
                  <div
                    key={ymd}
                    className={[
                      "assignment-calendar-cell",
                      isCurrentMonth ? "" : "is-other-month",
                      isToday ? "is-today" : "",
                    ].join(" ")}
                  >
                    <div className="assignment-calendar-date">{dateObj.getDate()}</div>

                    <div className="assignment-calendar-items">
                      {dayTasks.map((task) => {
                        const meta = getTaskStatusMeta(task);
                        return (
                          <button
                            type="button"
                            key={task.id}
                            className={`assignment-calendar-item ${meta.tone}`}
                            onClick={() => setSelectedTask(task)}
                            title={`${task.employeeName} - ${task.title}`}
                          >
                            <span className="assignment-calendar-item-name">
                              {task.employeeName}
                            </span>

                            <span className="assignment-calendar-tooltip">
                              <strong>{task.employeeName}</strong>
                              <span>{task.title}</span>
                              <span>{task.employeePosition}</span>
                              <span>Deadline: {prettyDate(task.deadlineDate)}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="assignment-panel">
            <div className="assignment-panel-head">
              <span>{isManager ? "All Assignments" : "Assignments"}</span>
              <span className="assignment-count">
                {loadingAssignments ? "Loading..." : filteredAssignments.length}
              </span>
            </div>

            <div className="assignment-table-wrap">
              <table className="assignment-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Position</th>
                    <th>Task</th>
                    <th>Deadline</th>
                    <th>Status</th>
                    <th>Priority</th>
                    <th>Completed By</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAssignments.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="assignment-no-rows">
                        No assignments found.
                      </td>
                    </tr>
                  ) : (
                    filteredAssignments.map((task) => {
                      const meta = getTaskStatusMeta(task);
                      return (
                        <tr key={task.id} onClick={() => setSelectedTask(task)}>
                          <td>{task.employeeName}</td>
                          <td>{task.employeePosition}</td>
                          <td>{task.title}</td>
                          <td>{prettyDate(task.deadlineDate)}</td>
                          <td>
                            <span className={`assignment-status-pill ${meta.tone}`}>
                              {meta.label}
                            </span>
                          </td>
                          <td className="capitalize">{task.priority}</td>
                          <td>{task.completedByName || "-"}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>

      <div className={`assignment-drawer ${selectedTask ? "open" : ""}`}>
        <div className="assignment-drawer-backdrop" onClick={() => setSelectedTask(null)} />
        <div className="assignment-drawer-panel">
          <div className="assignment-drawer-head">
            <div>
              <div className="assignment-drawer-title">
                {selectedTask?.title || "Task Details"}
              </div>
              <div className="assignment-drawer-subtitle">
                {selectedTask?.employeeName || "-"}  |  {selectedTask?.employeePosition || "-"}
              </div>
            </div>

            <button
              type="button"
              className="assignment-icon-btn"
              onClick={() => setSelectedTask(null)}
            >
              <X size={18} />
            </button>
          </div>

          {selectedTask ? (
            <div className="assignment-drawer-body">
              <div className="assignment-detail-grid">
                <div className="assignment-detail-card">
                  <div className="assignment-detail-label">Deadline</div>
                  <div className="assignment-detail-value">
                    {prettyDate(selectedTask.deadlineDate)}
                    {selectedTask.deadlineTime ? `  |  ${selectedTask.deadlineTime}` : ""}
                  </div>
                </div>

                <div className="assignment-detail-card">
                  <div className="assignment-detail-label">Priority</div>
                  <div className="assignment-detail-value capitalize">
                    {selectedTask.priority || "medium"}
                  </div>
                </div>

                <div className="assignment-detail-card">
                  <div className="assignment-detail-label">Status</div>
                  <div className="assignment-detail-value">
                    {getTaskStatusMeta(selectedTask).label}
                  </div>
                </div>

                <div className="assignment-detail-card">
                  <div className="assignment-detail-label">Created By</div>
                  <div className="assignment-detail-value">
                    {selectedTask.createdByName || "-"}
                  </div>
                </div>

                <div className="assignment-detail-card">
                  <div className="assignment-detail-label">Completed By</div>
                  <div className="assignment-detail-value">
                    {selectedTask.completedByName || "-"}
                  </div>
                </div>
              </div>

              <div className="assignment-section-block">
                <div className="assignment-section-title">Instructions</div>
                <div className="assignment-instructions">
                  {selectedTask.instructions || "No instructions provided."}
                </div>
              </div>

              <div className="assignment-section-block">
                <div className="assignment-section-title">Quick Actions</div>

                <div className="assignment-action-row">
                  {selectedTaskAccess?.canComplete ? (
                    <button
                      type="button"
                      className="assignment-action-btn success"
                      onClick={() => handleMarkCompleted(selectedTask)}
                      disabled={selectedTask.status === "completed"}
                    >
                      <CheckCircle2 size={16} />
                      <span>Mark Completed</span>
                    </button>
                  ) : null}

                  {selectedTaskAccess?.canRequestAccess ? (
                    <button
                      type="button"
                      className="assignment-action-btn"
                      onClick={() => handleRequestAccess(selectedTask)}
                      disabled={selectedTaskAccess.alreadyRequested}
                    >
                      <Clock3 size={16} />
                      <span>
                        {selectedTaskAccess.alreadyRequested ? "Access Requested" : "Request Access"}
                      </span>
                    </button>
                  ) : null}

                  {isManager ? (
                    <>
                      <button
                        type="button"
                        className="assignment-action-btn"
                        onClick={() => handleStatusChange(selectedTask, "in_progress")}
                      >
                        <Clock3 size={16} />
                        <span>Set In Progress</span>
                      </button>

                      <button
                        type="button"
                        className="assignment-action-btn danger"
                        onClick={() => handleDeleteTask(selectedTask)}
                      >
                        <Trash2 size={16} />
                        <span>Delete</span>
                      </button>
                    </>
                  ) : null}
                </div>
              </div>

              {isManager && (selectedTaskAccess?.requestedUserIds || []).length > 0 ? (
                <div className="assignment-section-block">
                  <div className="assignment-section-title">Pending Access Requests</div>
                  <div className="assignment-action-row">
                    {selectedTaskAccess.requestedUserIds.map((requesterId) => (
                      <button
                        key={`approve-${selectedTask.id}-${requesterId}`}
                        type="button"
                        className="assignment-action-btn"
                        onClick={() => handleApproveAccess(selectedTask, requesterId)}
                      >
                        <CheckCircle2 size={16} />
                        <span>
                          Approve {employeeNameById[String(requesterId)] || requesterId}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {(() => {
                const daysLeft = getDaysUntilDeadline(selectedTask.deadlineDate);
                if (selectedTask.status === "completed" || daysLeft === null || daysLeft > 1) {
                  return null;
                }

                return (
                  <div className="assignment-alert-box">
                    <AlertTriangle size={18} />
                    <div>
                      {daysLeft < 0
                        ? "This task is overdue."
                        : daysLeft === 0
                          ? "This task is due today."
                          : "This task is due tomorrow."}
                    </div>
                  </div>
                );
              })()}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

