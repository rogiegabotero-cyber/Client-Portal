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
  Archive,
  CheckCircle2,
  Clock3,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  getDaysUntilDeadline,
} from "../services/assignmentService";
import ConfirmModal from "./ConfirmModal";
import { getDisplayName, getProfileImageUrl, getUserId, toText } from "../utils/common";

const normalize = (s) => String(s || "").toLowerCase().trim();
const normalizeStatusKey = (status) => normalize(status).replace(/\s+/g, "_");
const isToBeCheckStatus = (status) => normalizeStatusKey(status) === "to_be_check";
const initialsFromName = (value = "") => {
  const parts = toText(value).split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] || "?";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return `${first}${last}`.toUpperCase();
};

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
  return !!r;
};

const canCreateAssignmentsForRole = (role) => {
  const r = normalize(role);
  return r === "admin" || r === "visitor" || r === "super_admin" || r === "super admin";
};

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
const MAX_CALENDAR_TASK_MARKERS = 6;

const getTaskStatusMeta = (task) => {
  const days = getDaysUntilDeadline(task?.deadlineDate);

  const statusKey = normalizeStatusKey(task?.status);
  if (statusKey === "completed") {
    return { label: "Completed", tone: "completed" };
  }
  if (statusKey === "to_be_check") {
    return { label: "To Be Check", tone: "review" };
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
const ASSIGNMENT_STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "in_progress", label: "In Progress" },
  { key: "to_be_check", label: "To Be Check" },
  { key: "completed", label: "Completed" },
  { key: "overdue", label: "Overdue" },
];

const isTaskOverdue = (task) => {
  const statusKey = normalizeStatusKey(task?.status);
  if (statusKey === "completed") return false;
  const days = getDaysUntilDeadline(task?.deadlineDate);
  return days !== null && days < 0;
};

const matchesStatusFilter = (task, statusFilter) => {
  const key = normalizeStatusKey(statusFilter) || "all";
  if (key === "all") return true;
  if (key === "overdue") return isTaskOverdue(task);
  const taskStatusKey = normalizeStatusKey(task?.status) || "pending";
  return taskStatusKey === key;
};

const matchesAssignmentSearchQuery = (task, queryValue = "") => {
  const q = normalize(queryValue);
  if (!q) return true;
  return (
    normalize(task?.title).includes(q) ||
    normalize(task?.instructions).includes(q) ||
    normalize(task?.employeeName).includes(q) ||
    normalize(task?.employeePosition).includes(q) ||
    normalize(task?.deadlineDate).includes(q) ||
    normalize(task?.priority).includes(q)
  );
};

export default function AssignmentPage({
  employees = [],
  viewer = null,
  assignments = [],
  archivedAssignments = [],
  loadingAssignments = false,
  assignmentsError = "",
  employeeProfilesByUserId = {},
  onReloadAssignments,
  onCreateAssignment,
  onUpdateAssignment,
  onDeleteAssignment,
  onArchiveAssignment,
  onRepostAssignment,
  onMarkAssignmentCompleted,
  onReviewAssignmentCompletion,
  onRequestAssignmentAccess,
  onApproveAssignmentAccess,
  openTaskRequest = null,
  onConsumeOpenTaskRequest,
  openCreateRequest = null,
  onConsumeOpenCreateRequest,
  pageData = null,
  onToast,
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedAssigneeIds, setSelectedAssigneeIds] = useState([]);
  const [selectedTask, setSelectedTask] = useState(null);
  const [showCreateAssignmentDrawer, setShowCreateAssignmentDrawer] = useState(false);
  const [showAllAssignmentsDrawer, setShowAllAssignmentsDrawer] = useState(false);
  const [showArchivedDrawer, setShowArchivedDrawer] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [saving, setSaving] = useState(false);
  const [archivingTaskId, setArchivingTaskId] = useState("");
  const [archiveConfirmTask, setArchiveConfirmTask] = useState(null);
  const [repostingTaskId, setRepostingTaskId] = useState("");
  const [repostConfirmTask, setRepostConfirmTask] = useState(null);
  const [deletingTaskId, setDeletingTaskId] = useState("");
  const [deleteConfirmTask, setDeleteConfirmTask] = useState(null);
  const [editingArchivedTask, setEditingArchivedTask] = useState(null);
  const [savingArchivedEdit, setSavingArchivedEdit] = useState(false);
  const [archivedEditForm, setArchivedEditForm] = useState({
    title: "",
    instructions: "",
    deadlineDate: "",
    deadlineTime: "",
    priority: "medium",
  });
  const [handledOpenRequestId, setHandledOpenRequestId] = useState(0);
  const [handledOpenCreateRequestId, setHandledOpenCreateRequestId] = useState(0);
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
    () => canCreateAssignmentsForRole(viewerRole),
    [viewerRole]
  );
  const canUseArchiveFeature = useMemo(
    () => isManager,
    [isManager]
  );
  const canPermanentlyDeleteArchived = useMemo(() => isManager, [isManager]);
  const canViewMyTasks = useMemo(() => isManager, [isManager]);
  const isAnyDrawerOpen = useMemo(
    () => Boolean(showCreateAssignmentDrawer || showAllAssignmentsDrawer || showArchivedDrawer || selectedTask),
    [showCreateAssignmentDrawer, showAllAssignmentsDrawer, showArchivedDrawer, selectedTask]
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
  const employeeById = useMemo(() => {
    const map = {};
    for (const emp of validEmployees) {
      const id = String(getUserId(emp) || "");
      if (!id) continue;
      map[id] = emp;
    }
    return map;
  }, [validEmployees]);
  const profileImagesByUserId =
    pageData?.profileImagesByUserId && typeof pageData.profileImagesByUserId === "object"
      ? pageData.profileImagesByUserId
      : {};
  const getCalendarTaskAssignee = (task) => {
    const assignees = Array.isArray(task?.assignees) ? task.assignees : [];
    const primaryAssignee = assignees[0] || null;
    const assigneeIds = Array.isArray(task?.employeeUserIds)
      ? task.employeeUserIds.map((id) => toText(id)).filter(Boolean)
      : [];
    const fallbackListedName = toText(task?.employeeName).split(",")[0]?.trim() || "";
    const assigneeUserId =
      toText(primaryAssignee?.userId) ||
      assigneeIds[0] ||
      toText(task?.employeeUserId);
    const mappedEmployee = assigneeUserId ? employeeById[assigneeUserId] : null;
    const profileImg =
      toText(primaryAssignee?.profileImg) ||
      toText(primaryAssignee?.profileImage) ||
      toText(primaryAssignee?.profileImageUrl) ||
      toText(profileImagesByUserId?.[assigneeUserId]) ||
      getProfileImageUrl(mappedEmployee) ||
      "";
    const name =
      toText(primaryAssignee?.name) ||
      toText(employeeNameById?.[assigneeUserId]) ||
      (mappedEmployee ? getDisplayName(mappedEmployee) : "") ||
      fallbackListedName ||
      "Unassigned";

    return { userId: assigneeUserId, profileImg, name };
  };

  const openTaskDetails = (task) => {
    setShowCreateAssignmentDrawer(false);
    setShowAllAssignmentsDrawer(false);
    setShowArchivedDrawer(false);
    setSelectedTask(task);
  };

  const openCreateAssignmentDrawer = () => {
    if (!canCreateAssignments) return;
    setSelectedTask(null);
    setShowAllAssignmentsDrawer(false);
    setShowArchivedDrawer(false);
    setShowCreateAssignmentDrawer(true);
  };

  const closeCreateAssignmentDrawer = () => {
    setShowCreateAssignmentDrawer(false);
  };

  const openAllAssignmentsDrawer = () => {
    setSelectedTask(null);
    setShowCreateAssignmentDrawer(false);
    setShowArchivedDrawer(false);
    setShowAllAssignmentsDrawer(true);
  };

  const closeAllAssignmentsDrawer = () => {
    setShowAllAssignmentsDrawer(false);
  };

  const openArchivedDrawer = () => {
    setSelectedTask(null);
    setShowCreateAssignmentDrawer(false);
    setShowAllAssignmentsDrawer(false);
    setShowArchivedDrawer(true);
  };

  const closeArchivedDrawer = () => {
    setShowArchivedDrawer(false);
  };

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

  useEffect(() => {
    const requestId = Number(openTaskRequest?.requestId || 0);
    const taskId = toText(openTaskRequest?.taskId);
    if (!requestId || !taskId) return;
    if (handledOpenRequestId === requestId) return;

    const targetTask =
      (Array.isArray(assignments) ? assignments : []).find(
        (row) => String(row?.id || "") === taskId
      ) || null;
    if (!targetTask) return;

    setHandledOpenRequestId(requestId);
    openTaskDetails(targetTask);
    if (typeof onConsumeOpenTaskRequest === "function") {
      onConsumeOpenTaskRequest(requestId);
    }
  }, [openTaskRequest, assignments, handledOpenRequestId, onConsumeOpenTaskRequest]);

  useEffect(() => {
    const requestId = Number(openCreateRequest?.requestId || 0);
    const assigneeUserId = toText(openCreateRequest?.assigneeUserId);

    if (!requestId || !assigneeUserId) return;
    if (handledOpenCreateRequestId === requestId) return;

    const isValidAssignee = employeeOptions.some(
      (item) => String(item.userId || "") === assigneeUserId
    );
    if (!isValidAssignee) return;

    setHandledOpenCreateRequestId(requestId);
    setSelectedAssigneeIds([assigneeUserId]);

    if (canCreateAssignments) {
      setSelectedTask(null);
      setShowAllAssignmentsDrawer(false);
      setShowArchivedDrawer(false);
      setShowCreateAssignmentDrawer(true);
    }

    if (typeof onConsumeOpenCreateRequest === "function") {
      onConsumeOpenCreateRequest(requestId);
    }
  }, [
    openCreateRequest,
    handledOpenCreateRequestId,
    employeeOptions,
    canCreateAssignments,
    onConsumeOpenCreateRequest,
  ]);

  useEffect(() => {
    if (canUseArchiveFeature) return;
    setShowArchivedDrawer(false);
  }, [canUseArchiveFeature]);

  useEffect(() => {
    if (canCreateAssignments) return;
    setShowCreateAssignmentDrawer(false);
  }, [canCreateAssignments]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const lockClass = "assignment-scroll-lock";
    if (isAnyDrawerOpen) {
      document.documentElement.classList.add(lockClass);
      document.body.classList.add(lockClass);
    } else {
      document.documentElement.classList.remove(lockClass);
      document.body.classList.remove(lockClass);
    }

    return () => {
      document.documentElement.classList.remove(lockClass);
      document.body.classList.remove(lockClass);
    };
  }, [isAnyDrawerOpen]);

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

  const assignmentStatusCounts = useMemo(() => {
    const counts = {
      all: assignments.length,
      pending: 0,
      in_progress: 0,
      to_be_check: 0,
      completed: 0,
      overdue: 0,
    };

    for (const task of assignments) {
      const statusKey = normalizeStatusKey(task?.status) || "pending";
      if (Object.prototype.hasOwnProperty.call(counts, statusKey)) {
        counts[statusKey] += 1;
      } else {
        counts.pending += 1;
      }

      if (isTaskOverdue(task)) {
        counts.overdue += 1;
      }
    }

    return counts;
  }, [assignments]);

  const searchedAssignments = useMemo(() => {
    return assignments.filter((task) => matchesAssignmentSearchQuery(task, query));
  }, [assignments, query]);

  const searchedArchivedAssignments = useMemo(() => {
    return (Array.isArray(archivedAssignments) ? archivedAssignments : []).filter((task) =>
      matchesAssignmentSearchQuery(task, query)
    );
  }, [archivedAssignments, query]);

  const filteredAssignments = useMemo(
    () => searchedAssignments.filter((task) => matchesStatusFilter(task, statusFilter)),
    [searchedAssignments, statusFilter]
  );

  const assignmentsByDate = useMemo(() => {
    const map = new Map();

    for (const task of searchedAssignments) {
      const key = String(task?.deadlineDate || "");
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(task);
    }

    return map;
  }, [searchedAssignments]);

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
    const statusKey = normalizeStatusKey(task?.status);
    const canRequestAccess =
      !isManager && !!viewerId && !canComplete && statusKey !== "completed" && statusKey !== "to_be_check";

    return {
      assignedUserIds,
      approvedUserIds,
      requestedUserIds,
      isOwner,
      hasApprovedAccess,
      alreadyRequested,
      canComplete,
      statusKey,
      isPendingReview: statusKey === "to_be_check",
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
        message: "You do not have permission to create assignments.",
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
      setShowCreateAssignmentDrawer(false);
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
    if (access.statusKey === "completed") {
      onToast?.({
        type: "info",
        title: "Already Completed",
        message: "This task is already completed.",
      });
      return;
    }
    if (access.statusKey === "to_be_check") {
      onToast?.({
        type: "info",
        title: "Already Submitted",
        message: "This task is already waiting for manager review.",
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
          status: "to_be_check",
          completionRequestedByUserId: viewerId,
          completionRequestedByName: viewerName,
        });
      }
      onToast?.({
        type: "success",
        title: "Submitted For Check",
        message: `"${task.title}" is now waiting for manager review.`,
      });
    } catch (err) {
      console.error("Failed to complete task:", err);
      onToast?.({
        type: "error",
        title: "Submit Failed",
        message: err?.message || "Could not submit task for manager check.",
      });
    }
  };

  const handleReviewCompletion = async (task, decision = "") => {
    if (!isManager) {
      onToast?.({
        type: "warning",
        title: "Action Restricted",
        message: "You do not have permission to review completion requests.",
      });
      return;
    }

    const normalizedDecision = normalizeStatusKey(decision);
    if (normalizedDecision !== "approve" && normalizedDecision !== "reject") return;

    try {
      if (!onReviewAssignmentCompletion) {
        throw new Error("Review action is unavailable");
      }

      await onReviewAssignmentCompletion(task.id, normalizedDecision, {
        userId: viewerId,
        name: viewerName,
        role: viewerRole,
      });

      if (selectedTask?.id === task.id) {
        setSelectedTask({
          ...task,
          status: normalizedDecision === "approve" ? "completed" : "in_progress",
        });
      }

      onToast?.({
        type: "success",
        title: normalizedDecision === "approve" ? "Completion Approved" : "Completion Rejected",
        message:
          normalizedDecision === "approve"
            ? `"${task.title}" is now marked as completed.`
            : `"${task.title}" was sent back to In Progress.`,
      });
    } catch (err) {
      console.error("Failed to review completion:", err);
      onToast?.({
        type: "error",
        title: "Review Failed",
        message: err?.message || "Could not review completion request.",
      });
    }
  };

  const handleDeleteTask = async (task) => {
    if (!canPermanentlyDeleteArchived) {
      onToast?.({
        type: "warning",
        title: "Action Restricted",
        message: "You do not have permission to permanently delete archived assignments.",
      });
      return;
    }
    if (!task?.archived) {
      onToast?.({
        type: "warning",
        title: "Archived Tasks Only",
        message: "Only archived tasks can be permanently deleted.",
      });
      return;
    }

    setDeleteConfirmTask(task);
  };

  const handleArchiveTask = async (task) => {
    if (!canUseArchiveFeature) {
      onToast?.({
        type: "warning",
        title: "Action Restricted",
        message: "You do not have permission to archive assignments.",
      });
      return;
    }

    setArchiveConfirmTask(task);
  };

  const openArchivedTaskEditor = (task) => {
    if (!task) return;
    setEditingArchivedTask(task);
    setArchivedEditForm({
      title: toText(task?.title),
      instructions: toText(task?.instructions),
      deadlineDate: toText(task?.deadlineDate),
      deadlineTime: toText(task?.deadlineTime),
      priority: toText(task?.priority) || "medium",
    });
  };

  const closeArchivedTaskEditor = () => {
    if (savingArchivedEdit) return;
    setEditingArchivedTask(null);
  };

  const saveArchivedTaskEdit = async () => {
    const task = editingArchivedTask;
    if (!task) return;

    const title = toText(archivedEditForm.title).trim();
    const deadlineDate = toText(archivedEditForm.deadlineDate).trim();
    if (!title || !deadlineDate) {
      onToast?.({
        type: "warning",
        title: "Missing Fields",
        message: "Title and deadline date are required.",
      });
      return;
    }

    setSavingArchivedEdit(true);
    try {
      if (!onUpdateAssignment) {
        throw new Error("Edit action is unavailable");
      }

      await onUpdateAssignment(task.id, {
        title,
        instructions: toText(archivedEditForm.instructions),
        deadlineDate,
        deadlineTime: toText(archivedEditForm.deadlineTime),
        priority: toText(archivedEditForm.priority) || "medium",
      });

      onToast?.({
        type: "success",
        title: "Archived Task Updated",
        message: "Changes saved successfully.",
      });
      setEditingArchivedTask(null);
    } catch (err) {
      console.error("Failed to edit archived task:", err);
      onToast?.({
        type: "error",
        title: "Edit Failed",
        message: err?.message || "Could not update archived task.",
      });
    } finally {
      setSavingArchivedEdit(false);
    }
  };

  const closeArchiveConfirm = () => {
    if (archivingTaskId) return;
    setArchiveConfirmTask(null);
  };

  const confirmArchiveTask = async () => {
    const task = archiveConfirmTask;
    if (!task) return;

    setArchivingTaskId(String(task.id));
    try {
      if (!onArchiveAssignment) {
        throw new Error("Archive action is unavailable");
      }

      await onArchiveAssignment(task.id, {
        userId: viewerId,
        name: viewerName,
        role: viewerRole,
      });
      if (selectedTask?.id === task.id) setSelectedTask(null);
      onToast?.({
        type: "success",
        title: "Task Archived",
        message: "Assignment archived successfully.",
      });
    } catch (err) {
      console.error("Failed to archive task:", err);
      onToast?.({
        type: "error",
        title: "Archive Failed",
        message: err?.message || "Could not archive assignment.",
      });
    } finally {
      setArchivingTaskId("");
      setArchiveConfirmTask(null);
    }
  };

  const handleRepostTask = async (task) => {
    if (!canUseArchiveFeature) {
      onToast?.({
        type: "warning",
        title: "Action Restricted",
        message: "You do not have permission to repost archived assignments.",
      });
      return;
    }
    setRepostConfirmTask(task);
  };

  const closeRepostConfirm = () => {
    if (repostingTaskId) return;
    setRepostConfirmTask(null);
  };

  const confirmRepostTask = async () => {
    const task = repostConfirmTask;
    if (!task) return;

    setRepostingTaskId(String(task.id));
    try {
      if (!onRepostAssignment) {
        throw new Error("Repost action is unavailable");
      }

      await onRepostAssignment(
        task.id,
        {
          title: toText(task?.title),
          instructions: toText(task?.instructions),
          deadlineDate: toText(task?.deadlineDate),
          deadlineTime: toText(task?.deadlineTime),
          priority: toText(task?.priority) || "medium",
          status: "pending",
        },
        {
          userId: viewerId,
          name: viewerName,
          role: viewerRole,
        }
      );
      onToast?.({
        type: "success",
        title: "Task Reposted",
        message: `"${toText(task?.title) || "Task"}" is active again.`,
      });
    } catch (err) {
      console.error("Failed to repost task:", err);
      onToast?.({
        type: "error",
        title: "Repost Failed",
        message: err?.message || "Could not repost assignment.",
      });
    } finally {
      setRepostingTaskId("");
      setRepostConfirmTask(null);
    }
  };

  const closeDeleteConfirm = () => {
    if (deletingTaskId) return;
    setDeleteConfirmTask(null);
  };

  const confirmDeleteTask = async () => {
    const task = deleteConfirmTask;
    if (!task) return;

    setDeletingTaskId(String(task.id));
    try {
      if (!onDeleteAssignment) {
        throw new Error("Delete action is unavailable");
      }

      await onDeleteAssignment(task.id, {
        userId: viewerId,
        name: viewerName,
        role: viewerRole,
      });
      if (selectedTask?.id === task.id) setSelectedTask(null);
      onToast?.({
        type: "success",
        title: "Task Permanently Deleted",
        message: "Archived assignment removed successfully.",
      });
    } catch (err) {
      console.error("Failed to delete task:", err);
      onToast?.({
        type: "error",
        title: "Delete Failed",
        message: err?.message || "Could not delete assignment.",
      });
    } finally {
      setDeletingTaskId("");
      setDeleteConfirmTask(null);
    }
  };

  const handleStatusChange = async (task, nextStatus) => {
    if (!isManager) {
      onToast?.({
        type: "warning",
        title: "Action Restricted",
        message: "You do not have permission to change assignment status.",
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
        <div className="assignment-header-actions">
          <div className="assignment-search">
            <Search size={16} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search task, employee, deadline, priority..."
            />
          </div>

          {canCreateAssignments ? (
            <button
              type="button"
              className="assignment-inline-btn"
              onClick={openCreateAssignmentDrawer}
            >
              <Plus size={14} />
              <span>Create Assignment</span>
            </button>
          ) : null}

          <button
            type="button"
            className="assignment-inline-btn"
            onClick={openAllAssignmentsDrawer}
          >
            <ClipboardList size={14} />
            <span>
              {isManager ? "All Assignments" : "Assignments"} (
              {loadingAssignments ? "..." : filteredAssignments.length})
            </span>
          </button>

          {canUseArchiveFeature ? (
            <button
              type="button"
              className="assignment-inline-btn"
              onClick={openArchivedDrawer}
            >
              <Archive size={14} />
              <span>Archived ({searchedArchivedAssignments.length})</span>
            </button>
          ) : null}
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

      <div className={`assignment-layout ${canViewMyTasks ? "" : "assignment-layout-full"}`}>
        {canViewMyTasks ? (
          <section className="assignment-left">
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
                        onClick={() => openTaskDetails(task)}
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
        ) : null}

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
                const visibleDayTasks = dayTasks.slice(0, MAX_CALENDAR_TASK_MARKERS);
                const hiddenDayTaskCount = Math.max(0, dayTasks.length - visibleDayTasks.length);
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
                      {visibleDayTasks.map((task) => {
                        const meta = getTaskStatusMeta(task);
                        const assignee = getCalendarTaskAssignee(task);
                        return (
                          <button
                            type="button"
                            key={task.id}
                            className={`assignment-calendar-item ${meta.tone}`}
                            onClick={() => openTaskDetails(task)}
                            title={`${assignee.name} - ${task.title}`}
                          >
                            <span className="assignment-calendar-item-avatar" aria-hidden="true">
                              {assignee.profileImg ? (
                                <img
                                  src={assignee.profileImg}
                                  alt=""
                                  className="assignment-calendar-item-avatar-img"
                                  loading="lazy"
                                />
                              ) : (
                                initialsFromName(assignee.name)
                              )}
                            </span>

                            <span className="assignment-calendar-tooltip">
                              <strong>{assignee.name}</strong>
                              <span>{task.title}</span>
                              <span>{task.employeePosition}</span>
                              <span>Deadline: {prettyDate(task.deadlineDate)}</span>
                            </span>
                          </button>
                        );
                      })}
                      {hiddenDayTaskCount > 0 ? (
                        <span
                          className="assignment-calendar-more"
                          title={`${hiddenDayTaskCount} more task${
                            hiddenDayTaskCount === 1 ? "" : "s"
                          } on this date`}
                        >
                          +{hiddenDayTaskCount}
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>

      {canCreateAssignments ? (
        <div
          className={`assignment-drawer assignment-create-drawer ${showCreateAssignmentDrawer ? "open" : ""}`}
        >
          <div className="assignment-drawer-backdrop" onClick={closeCreateAssignmentDrawer} />
          <div className="assignment-drawer-panel assignment-create-drawer-panel">
            <div className="assignment-drawer-head">
              <div>
                <div className="assignment-drawer-title">Create Assignment</div>
                <div className="assignment-drawer-subtitle">
                  Assign tasks to one or more agents.
                </div>
              </div>

              <button
                type="button"
                className="assignment-icon-btn"
                onClick={closeCreateAssignmentDrawer}
              >
                <X size={18} />
              </button>
            </div>

            <div className="assignment-drawer-body">
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
          </div>
        </div>
      ) : null}

      <div className={`assignment-drawer assignment-all-drawer ${showAllAssignmentsDrawer ? "open" : ""}`}>
        <div className="assignment-drawer-backdrop" onClick={closeAllAssignmentsDrawer} />
        <div className="assignment-drawer-panel assignment-all-drawer-panel">
          <div className="assignment-drawer-head">
            <div>
              <div className="assignment-drawer-title">
                {isManager ? "All Assignments" : "Assignments"}
              </div>
              <div className="assignment-drawer-subtitle">
                {loadingAssignments
                  ? "Loading assignments..."
                  : `${filteredAssignments.length} task${filteredAssignments.length === 1 ? "" : "s"} shown`}
              </div>
            </div>

            <button
              type="button"
              className="assignment-icon-btn"
              onClick={closeAllAssignmentsDrawer}
            >
              <X size={18} />
            </button>
          </div>

          <div className="assignment-status-filters" role="tablist" aria-label="Assignment status filters">
            {ASSIGNMENT_STATUS_FILTERS.map((item) => {
              const isActive = statusFilter === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`assignment-status-filter-btn ${isActive ? "active" : ""}`}
                  onClick={() => setStatusFilter(item.key)}
                  aria-pressed={isActive}
                >
                  <span>{item.label}</span>
                  <span className="assignment-status-filter-count">
                    {assignmentStatusCounts[item.key] || 0}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="assignment-drawer-body">
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
                        <tr key={task.id} onClick={() => openTaskDetails(task)}>
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
        </div>
      </div>

      <div className={`assignment-drawer assignment-archive-drawer ${showArchivedDrawer ? "open" : ""}`}>
        <div className="assignment-drawer-backdrop" onClick={closeArchivedDrawer} />
        <div className="assignment-drawer-panel assignment-archive-drawer-panel">
          <div className="assignment-drawer-head">
            <div>
              <div className="assignment-drawer-title">Archived Assignments</div>
              <div className="assignment-drawer-subtitle">
                {searchedArchivedAssignments.length} archived task
                {searchedArchivedAssignments.length === 1 ? "" : "s"}
              </div>
            </div>

            <button
              type="button"
              className="assignment-icon-btn"
              onClick={closeArchivedDrawer}
            >
              <X size={18} />
            </button>
          </div>

          <div className="assignment-drawer-body">
            <div className="assignment-table-wrap">
              <table className="assignment-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Task</th>
                    <th>Deadline</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {searchedArchivedAssignments.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="assignment-no-rows">
                        No archived assignments found.
                      </td>
                    </tr>
                  ) : (
                    searchedArchivedAssignments.map((task) => (
                      <tr key={`archived-${task.id}`}>
                        <td>{task.employeeName || "-"}</td>
                        <td>{task.title || "-"}</td>
                        <td>{prettyDate(task.deadlineDate)}</td>
                        <td>
                          <div className="assignment-inline-actions">
                            <button
                              type="button"
                              className="assignment-inline-btn"
                              onClick={() => openArchivedTaskEditor(task)}
                            >
                              <Pencil size={14} />
                              <span>Edit</span>
                            </button>

                            <button
                              type="button"
                              className="assignment-inline-btn success"
                              onClick={() => handleRepostTask(task)}
                              disabled={repostingTaskId === String(task?.id || "")}
                            >
                              <CheckCircle2 size={14} />
                              <span>
                                {repostingTaskId === String(task?.id || "")
                                  ? "Reposting..."
                                  : "Repost"}
                              </span>
                            </button>

                            {canPermanentlyDeleteArchived ? (
                              <button
                                type="button"
                                className="assignment-inline-btn danger"
                                onClick={() => handleDeleteTask(task)}
                                disabled={deletingTaskId === String(task?.id || "")}
                              >
                                <Trash2 size={14} />
                                <span>
                                  {deletingTaskId === String(task?.id || "")
                                    ? "Deleting..."
                                    : "Delete"}
                                </span>
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
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
                  {selectedTaskAccess?.canComplete && !isManager ? (
                    <button
                      type="button"
                      className="assignment-action-btn success"
                      onClick={() => handleMarkCompleted(selectedTask)}
                      disabled={selectedTaskAccess.statusKey === "completed" || selectedTaskAccess.isPendingReview}
                    >
                      <CheckCircle2 size={16} />
                      <span>
                        {selectedTaskAccess.isPendingReview ? "Waiting For Review" : "Submit For Check"}
                      </span>
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
                      {selectedTaskAccess?.isPendingReview ? (
                        <>
                          <button
                            type="button"
                            className="assignment-action-btn success"
                            onClick={() => handleReviewCompletion(selectedTask, "approve")}
                          >
                            <CheckCircle2 size={16} />
                            <span>Approve Completion</span>
                          </button>

                          <button
                            type="button"
                            className="assignment-action-btn danger"
                            onClick={() => handleReviewCompletion(selectedTask, "reject")}
                          >
                            <AlertTriangle size={16} />
                            <span>Reject Completion</span>
                          </button>
                        </>
                      ) : null}

                      <button
                        type="button"
                        className="assignment-action-btn"
                        onClick={() => handleStatusChange(selectedTask, "in_progress")}
                        disabled={selectedTaskAccess?.statusKey === "completed"}
                      >
                        <Clock3 size={16} />
                        <span>Set In Progress</span>
                      </button>
                    </>
                  ) : null}

                  {canUseArchiveFeature ? (
                    <button
                      type="button"
                      className="assignment-action-btn"
                      onClick={() => handleArchiveTask(selectedTask)}
                      disabled={archivingTaskId === String(selectedTask?.id || "")}
                    >
                      <Archive size={16} />
                      <span>
                        {archivingTaskId === String(selectedTask?.id || "")
                          ? "Archiving..."
                          : "Archive"}
                      </span>
                    </button>
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
                if (
                  normalizeStatusKey(selectedTask.status) === "completed" ||
                  isToBeCheckStatus(selectedTask.status) ||
                  daysLeft === null ||
                  daysLeft > 1
                ) {
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

      {editingArchivedTask ? (
        <div className="assignment-edit-modal-root">
          <div className="assignment-edit-modal-backdrop" onClick={closeArchivedTaskEditor} />
          <div className="assignment-edit-modal-panel" role="dialog" aria-modal="true">
            <div className="assignment-edit-modal-head">
              <h3>Edit Archived Task</h3>
            </div>

            <div className="assignment-edit-modal-body">
              <label className="assignment-field">
                <span>Task Title</span>
                <input
                  type="text"
                  value={archivedEditForm.title}
                  onChange={(e) =>
                    setArchivedEditForm((prev) => ({ ...prev, title: e.target.value }))
                  }
                />
              </label>

              <label className="assignment-field">
                <span>Instructions</span>
                <textarea
                  rows={4}
                  value={archivedEditForm.instructions}
                  onChange={(e) =>
                    setArchivedEditForm((prev) => ({ ...prev, instructions: e.target.value }))
                  }
                />
              </label>

              <div className="assignment-grid-2">
                <label className="assignment-field">
                  <span>Deadline Date</span>
                  <input
                    type="date"
                    value={archivedEditForm.deadlineDate}
                    onChange={(e) =>
                      setArchivedEditForm((prev) => ({ ...prev, deadlineDate: e.target.value }))
                    }
                  />
                </label>

                <label className="assignment-field">
                  <span>Deadline Time</span>
                  <input
                    type="time"
                    value={archivedEditForm.deadlineTime}
                    onChange={(e) =>
                      setArchivedEditForm((prev) => ({ ...prev, deadlineTime: e.target.value }))
                    }
                  />
                </label>
              </div>

              <label className="assignment-field">
                <span>Priority</span>
                <select
                  value={archivedEditForm.priority}
                  onChange={(e) =>
                    setArchivedEditForm((prev) => ({ ...prev, priority: e.target.value }))
                  }
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </label>
            </div>

            <div className="assignment-edit-modal-actions">
              <button
                type="button"
                className="assignment-inline-btn"
                onClick={closeArchivedTaskEditor}
                disabled={savingArchivedEdit}
              >
                Cancel
              </button>
              <button
                type="button"
                className="assignment-inline-btn success"
                onClick={saveArchivedTaskEdit}
                disabled={savingArchivedEdit}
              >
                {savingArchivedEdit ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmModal
        open={!!archiveConfirmTask}
        title="Archive Assignment?"
        message={`Archive task "${archiveConfirmTask?.title || ""}"?`}
        confirmText="Archive Task"
        tone="primary"
        busy={!!archivingTaskId}
        onCancel={closeArchiveConfirm}
        onConfirm={confirmArchiveTask}
      />

      <ConfirmModal
        open={!!repostConfirmTask}
        title="Repost Assignment?"
        message={`Repost task "${repostConfirmTask?.title || ""}" to active assignments?`}
        confirmText="Repost Task"
        tone="primary"
        busy={!!repostingTaskId}
        onCancel={closeRepostConfirm}
        onConfirm={confirmRepostTask}
      />

      <ConfirmModal
        open={!!deleteConfirmTask}
        title="Permanently Delete Archived Task?"
        message={`Permanently delete archived task "${deleteConfirmTask?.title || ""}"?`}
        confirmText="Delete Task"
        tone="danger"
        busy={!!deletingTaskId}
        onCancel={closeDeleteConfirm}
        onConfirm={confirmDeleteTask}
      />
    </div>
  );
}
