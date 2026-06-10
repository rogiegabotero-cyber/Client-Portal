import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import "./confirmModal.css";

export default function ConfirmModal({
  open = false,
  title = "Confirm Action",
  message = "Are you sure?",
  meta = null,
  confirmText = "Confirm",
  cancelText = "Cancel",
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
}) {
  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event) => {
      if (event.key === "Escape" && !busy) {
        onCancel?.();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const modalNode = (
    <div className="confirmModalRoot">
      <div
        className="confirmModalBackdrop"
        onClick={() => {
          if (!busy) onCancel?.();
        }}
      />

      <div className="confirmModalPanel" role="dialog" aria-modal="true" aria-label={title}>
        <h3 className="confirmModalTitle">{title}</h3>
        <p className="confirmModalMessage">{message}</p>
        {meta ? <div className="confirmModalMeta">{meta}</div> : null}

        <div className="confirmModalActions">
          <button
            type="button"
            className="confirmModalBtn confirmModalBtnCancel"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelText}
          </button>

          <button
            type="button"
            className={`confirmModalBtn ${tone === "primary" ? "confirmModalBtnPrimary" : "confirmModalBtnDanger"}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Please wait..." : confirmText}
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document !== "undefined" && document.body) {
    return createPortal(modalNode, document.body);
  }

  return modalNode;
}
