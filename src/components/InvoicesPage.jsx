import React from "react";
import "./InvoicesPage.css";

export default function InvoicesPage({ invoiceUrl = "" }) {
  return (
    <div className="invoices-page">
      <div className="invoices-frame">
        <iframe
          title="Invoices"
          src={invoiceUrl}
          className="invoices-iframe"
        />
      </div>
    </div>
  );
}
