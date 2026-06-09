import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "./saveAsModal.css";

const PAPER_SIZES = {
  A4: { width: 210, height: 297 },
  Letter: { width: 216, height: 279 },
};

const SAVE_TYPES = {
  pdf: { label: "PDF", extension: "pdf", mime: "application/pdf" },
  doc: { label: "Word document", extension: "doc", mime: "application/msword" },
  xls: { label: "Spreadsheet", extension: "xls", mime: "application/vnd.ms-excel" },
  html: { label: "HTML document", extension: "html", mime: "text/html;charset=utf-8" },
};

const escapePdfText = (text) =>
  text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

const wrapPdfLine = (line, maxLength = 92) => {
  const words = line.split(/\s+/).filter(Boolean);
  const lines = [];
  let currentLine = "";

  words.forEach((word) => {
    const nextLine = currentLine ? `${currentLine} ${word}` : word;
    if (nextLine.length > maxLength && currentLine) {
      lines.push(currentLine);
      currentLine = word;
      return;
    }
    currentLine = nextLine;
  });

  if (currentLine) lines.push(currentLine);
  return lines.length ? lines : [""];
};

const createPdfFromHtml = (html, title) => {
  const parsedDocument = new DOMParser().parseFromString(html, "text/html");
  const text = parsedDocument.body.textContent || "No content";
  const lines = text
    .split(/\n+/)
    .flatMap((line) => wrapPdfLine(line.trim()))
    .filter((line) => line.length);
  const pageHeight = 792;
  const pageWidth = 612;
  const margin = 54;
  const lineHeight = 15;
  const linesPerPage = Math.floor((pageHeight - margin * 2) / lineHeight);
  const pages = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += linesPerPage) {
    pages.push(lines.slice(lineIndex, lineIndex + linesPerPage));
  }

  if (!pages.length) pages.push(["No content"]);

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, pageIndex) => `${pageIndex * 2 + 3} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  ];

  pages.forEach((pageLines, pageIndex) => {
    const pageObjectNumber = pageIndex * 2 + 3;
    const contentObjectNumber = pageObjectNumber + 1;
    const textCommands = pageLines
      .map((line, lineIndex) => `BT /F1 10 Tf ${margin} ${pageHeight - margin - lineIndex * lineHeight} Td (${escapePdfText(line)}) Tj ET`)
      .join("\n");

    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${contentObjectNumber} 0 R >>`);
    objects.push(`<< /Length ${textCommands.length} >>\nstream\n${textCommands}\nendstream`);
  });

  const normalizedTitle = escapePdfText(title);
  const pdfObjects = objects.map((object, index) => `${index + 1} 0 obj\n${object}\nendobj\n`);
  let offset = "%PDF-1.4\n".length;
  const xref = ["0000000000 65535 f "];

  pdfObjects.forEach((object) => {
    xref.push(`${String(offset).padStart(10, "0")} 00000 n `);
    offset += object.length;
  });

  const body = pdfObjects.join("");
  const trailer = `xref\n0 ${objects.length + 1}\n${xref.join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info << /Title (${normalizedTitle}) >> >>\nstartxref\n${offset}\n%%EOF`;

  return `%PDF-1.4\n${body}${trailer}`;
};

export default function SaveAsModal({ open = false, html = "", onClose = () => {} }) {
  const [paperSize, setPaperSize] = useState("A4");
  const [saveType, setSaveType] = useState("pdf");
  const [layout, setLayout] = useState("Portrait");
  const [colorMode, setColorMode] = useState("Color");
  const [scale, setScale] = useState(1);

  useEffect(() => {
    if (!open) {
      setPaperSize("A4");
      setSaveType("pdf");
      setLayout("Portrait");
      setColorMode("Color");
      setScale(1);
    }
  }, [open]);

  if (!open) return null;

  const getPrintDocument = () => {
    const filenameBase = `notepad-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
    const exportHtml = `<!-- Export wrapper --><div style="color:#0f172a;background:transparent;">${html}</div>`;
    const baseSize = PAPER_SIZES[paperSize] || PAPER_SIZES.A4;
    const size =
      layout === "Landscape"
        ? { width: baseSize.height, height: baseSize.width }
        : baseSize;
    const pageStyle = `@page { size: ${size.width}mm ${size.height}mm; margin:12mm; }`;
    const colorStyle = colorMode === "Grayscale" ? "filter:grayscale(1);" : "";
    const printHtml = `<!doctype html><html><head><meta charset="utf-8"><title>${filenameBase}</title><style>body{font-family:Arial,Helvetica,sans-serif;margin:0;padding:0;color:#0f172a;} ${pageStyle} .paper{box-shadow:0 0 0 rgba(0,0,0,0); padding:20px;${colorStyle}} </style></head><body><div class="paper" style="transform: scale(${scale}); transform-origin: top left;">${exportHtml}</div></body></html>`;

    return { filenameBase, printHtml };
  };

  const handlePrint = () => {
    const { printHtml } = getPrintDocument();

    const printWindow = window.open("", "_blank", "noopener,noreferrer");
    if (!printWindow) return;
    printWindow.document.write(printHtml);
    printWindow.document.close();
    setTimeout(() => {
      try {
        printWindow.focus();
        printWindow.print();
      } catch (err) {
        console.error(err);
      }
    }, 250);
  };

  const handleDownload = () => {
    const { filenameBase, printHtml } = getPrintDocument();
    const selectedType = SAVE_TYPES[saveType] || SAVE_TYPES.pdf;
    const fileContent = saveType === "pdf" ? createPdfFromHtml(printHtml, filenameBase) : printHtml;
    const blob = new Blob([fileContent], { type: selectedType.mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `${filenameBase}.${selectedType.extension}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const modalNode = (
    <div className="saveAsRoot">
      <div className="saveAsBackdrop" onClick={onClose} />
      <div className="saveAsPanel" role="dialog" aria-modal="true">
        <div className="saveAsPreviewPane">
          <div className="saveAsPreviewMeta">
            <span>
              {new Date().toLocaleString([], {
                month: "numeric",
                day: "numeric",
                year: "2-digit",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
            <strong>Save Preview</strong>
          </div>

          <div className="saveAsPreviewWrap">
            <div
              className={[
                "saveAsPaper",
                `saveAsPaper--${paperSize}`,
                layout === "Landscape" ? "saveAsPaper--landscape" : "",
                colorMode === "Grayscale" ? "saveAsPaper--grayscale" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ "--save-as-scale": scale }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>

          <div className="saveAsPreviewFooter">
            <span>localhost:5173</span>
            <span>1/1</span>
          </div>
        </div>

        <aside className="saveAsControlsPane">
          <div className="saveAsControlsHeader">
            <h3 className="saveAsTitle">Print</h3>
            <strong>1 sheet of paper</strong>
          </div>

          <label className="saveAsControlRow">
            <span>Save as</span>
            <select value={saveType} onChange={(e) => setSaveType(e.target.value)}>
              {Object.entries(SAVE_TYPES).map(([value, type]) => (
                <option key={value} value={value}>
                  {type.label}
                </option>
              ))}
            </select>
          </label>

          <label className="saveAsControlRow">
            <span>Pages</span>
            <select value={paperSize} onChange={(e) => setPaperSize(e.target.value)}>
              {Object.keys(PAPER_SIZES).map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </label>

          <label className="saveAsControlRow">
            <span>Layout</span>
            <select value={layout} onChange={(e) => setLayout(e.target.value)}>
              <option value="Portrait">Portrait</option>
              <option value="Landscape">Landscape</option>
            </select>
          </label>

          <label className="saveAsControlRow">
            <span>Color</span>
            <select value={colorMode} onChange={(e) => setColorMode(e.target.value)}>
              <option value="Color">Color</option>
              <option value="Grayscale">Grayscale</option>
            </select>
          </label>

          <details className="saveAsMoreOptions">
            <summary>More options</summary>
            <label>
              Scale
              <input
                type="range"
                min="0.5"
                max="1.5"
                step="0.05"
                value={scale}
                onChange={(e) => setScale(Number(e.target.value))}
              />
              <span>{Math.round(scale * 100)}%</span>
            </label>
          </details>

          <div className="saveAsActions">
            <button type="button" className="saveAsBtn saveAsBtnPrimary" onClick={handlePrint}>
              Print
            </button>
            <button type="button" className="saveAsBtn saveAsBtnSecondary" onClick={handleDownload}>
              Download
            </button>
            <button type="button" className="saveAsBtn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </aside>
      </div>
    </div>
  );

  if (typeof document !== "undefined" && document.body) {
    return createPortal(modalNode, document.body);
  }

  return modalNode;
}
