/**
 * Browser-only invoice extraction and validation demo.
 *
 * This mirrors the Python pipeline in `invoice-pipeline`:
 *   pdf.js text layer -> label-based extraction -> deterministic validation.
 *
 * The rule is the same: never invent data. A missing or invalid field becomes
 * a validation error and the invoice is routed to "needs review".
 *
 * Everything runs locally. No PDF, text or result is uploaded anywhere.
 */

const PDFJS_VERSION = "4.7.76";
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;
const MIN_CONFIDENCE = 0.55;
const SUPPORTED_CURRENCIES = new Set(["BRL", "USD", "EUR", "GBP"]);

const $ = (selector) => document.querySelector(selector);

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatCnpj(digits) {
  if (!digits || digits.length !== 14) return "—";
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}

function formatMoney(value, currency) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (Number.isNaN(number)) return escapeHtml(value);
  const formatted = number.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency || "BRL"} ${formatted}`;
}

function formatDate(iso) {
  if (!iso) return "—";
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return escapeHtml(iso);
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/* ------------------------------------------------------------------ *
 * PDF text extraction (pdf.js)
 * ------------------------------------------------------------------ */

let pdfjsPromise = null;

async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(`${PDFJS_BASE}/build/pdf.min.mjs`).then((module) => {
      const pdfjs = module.default || module;
      pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.min.mjs`;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

/**
 * Rebuild lines from pdf.js text items.
 *
 * pdf.js returns positioned fragments, not lines. Grouping by the vertical
 * coordinate (transform[5]) restores the visual lines that the label-based
 * extractor expects.
 */
function itemsToText(items) {
  const rows = new Map();
  for (const item of items) {
    if (!item.str) continue;
    const y = Math.round(item.transform[5]);
    // Merge fragments that are visually on the same line.
    const key = [...rows.keys()].find((existing) => Math.abs(existing - y) <= 2) ?? y;
    const current = rows.get(key) || [];
    current.push({ x: item.transform[4], text: item.str });
    rows.set(key, current);
  }

  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, fragments]) =>
      fragments
        .sort((a, b) => a.x - b.x)
        .map((fragment) => fragment.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");
}

async function pdfToText(data) {
  const pdfjs = await loadPdfjs();
  const document_ = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let index = 1; index <= document_.numPages; index += 1) {
    const page = await document_.getPage(index);
    const content = await page.getTextContent();
    const text = itemsToText(content.items);
    if (text) pages.push(text);
  }
  return pages.join("\n").trim();
}

/* ------------------------------------------------------------------ *
 * Extraction (mirrors src/invoice_pipeline/extractor/mock.py)
 * ------------------------------------------------------------------ */

const CNPJ_RE = /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/;
const DATE_RE = /\b(\d{2}[/.-]\d{2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/;
const MONEY_RE = /[-+]?\d[\d.,\s]*\d|[-+]?\d/;

const SUPPLIER_LABELS = [
  "fornecedor",
  "supplier",
  "emitente",
  "razão social",
  "razao social",
  "vendor",
];
const CNPJ_LABELS = ["cnpj", "tax id"];
const TOTAL_LABELS = [
  "valor total",
  "total amount",
  "amount due",
  "valor a pagar",
  "total",
  "amount",
];
const DUE_LABELS = ["data de vencimento", "vencimento", "due date", "due"];

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Text after a label, using word boundaries so "total" does not match "subtotal". */
function tailAfterLabel(line, labels) {
  const lowered = line.toLowerCase();
  for (const label of labels) {
    const regex = new RegExp(`(?<![a-z])${escapeRegex(label)}(?![a-z])`);
    const match = lowered.match(regex);
    if (!match) continue;
    const tail = line.slice(match.index + match[0].length).replace(/^[\s:\-|\t]+/, "").trim();
    if (tail) return tail;
  }
  return null;
}

function firstMatch(regex, value) {
  if (!value) return null;
  const match = value.match(regex);
  return match ? match[0].trim() : null;
}

function detectCurrency(text) {
  const lowered = text.toLowerCase();
  if (lowered.includes("r$") || /\bbrl\b/.test(lowered)) return "BRL";
  if (lowered.includes("us$") || /\busd\b/.test(lowered)) return "USD";
  if (text.includes("€") || /\beur\b/.test(lowered)) return "EUR";
  if (text.includes("£") || /\bgbp\b/.test(lowered)) return "GBP";
  return null;
}

function extractFields(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let supplierName = null;
  let cnpj = null;
  let total = null;
  let due = null;

  for (const line of lines) {
    if (supplierName === null) {
      const tail = tailAfterLabel(line, SUPPLIER_LABELS);
      if (tail) {
        const candidate = tail.replace(/(cnpj|tax id)\s*[:\-]?\s*.*$/i, "").trim();
        if (candidate && !CNPJ_RE.test(candidate)) supplierName = candidate;
      }
    }
    if (cnpj === null) cnpj = firstMatch(CNPJ_RE, tailAfterLabel(line, CNPJ_LABELS));
    if (total === null) total = firstMatch(MONEY_RE, tailAfterLabel(line, TOTAL_LABELS));
    if (due === null) due = firstMatch(DATE_RE, tailAfterLabel(line, DUE_LABELS));
  }

  if (cnpj === null) cnpj = firstMatch(CNPJ_RE, text);
  if (total === null) total = firstMatch(MONEY_RE, text);
  if (due === null) due = firstMatch(DATE_RE, text);

  const found = [supplierName, cnpj, total, due].filter((value) => value !== null).length;
  const confidence = { 4: 0.95, 3: 0.7, 2: 0.5, 1: 0.3, 0: 0.1 }[found];

  return {
    supplier_name: supplierName,
    supplier_cnpj: cnpj,
    total_amount: total,
    currency: detectCurrency(text),
    due_date: due,
    confidence,
    notes: "browser mock extractor",
  };
}

/* ------------------------------------------------------------------ *
 * Validation (mirrors src/invoice_pipeline/extractor/validate.py)
 * ------------------------------------------------------------------ */

const CNPJ_WEIGHTS_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_WEIGHTS_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function normalizeCnpj(raw) {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/\D/g, "");
  return digits.length === 14 ? digits : null;
}

function cnpjIsValid(digits) {
  if (!digits || digits.length !== 14) return false;
  if (new Set(digits).size === 1) return false;

  const numbers = [...digits].map(Number);
  const checkDigit = (base, weights) => {
    const total = base.reduce((sum, value, index) => sum + value * weights[index], 0);
    const remainder = total % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };

  const first = checkDigit(numbers.slice(0, 12), CNPJ_WEIGHTS_1);
  const second = checkDigit(numbers.slice(0, 13), CNPJ_WEIGHTS_2);
  return first === numbers[12] && second === numbers[13];
}

/** Parse '1.234,56', '1,234.56', '42.50', 'R$ 10' and similar forms. */
function parseMoney(raw) {
  if (raw === null || raw === undefined) return null;
  let cleaned = String(raw).replace(/[^\d,.\-]/g, "").trim();
  if (!cleaned || !/\d/.test(cleaned)) return null;

  const negative = cleaned.startsWith("-");
  cleaned = cleaned.replace(/^-/, "");
  if (!cleaned) return null;

  if (cleaned.includes(".") && cleaned.includes(",")) {
    if (cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")) {
      cleaned = cleaned.replaceAll(".", "").replace(",", ".");
    } else {
      cleaned = cleaned.replaceAll(",", "");
    }
  } else if (cleaned.includes(",")) {
    const parts = cleaned.split(",");
    if (parts.length === 2 && parts[1].length === 2) {
      cleaned = cleaned.replace(",", ".");
    } else {
      cleaned = cleaned.replaceAll(",", "");
    }
  } else if (cleaned.includes(".") && cleaned.split(".").length === 2) {
    // A single dot with three digits after it is a thousands separator.
    if (cleaned.split(".")[1].length !== 2) cleaned = cleaned.replace(".", "");
  }

  const value = Number(cleaned);
  if (Number.isNaN(value)) return null;
  return negative ? -value : value;
}

const DATE_FORMATS = [
  /^(\d{2})\/(\d{2})\/(\d{4})$/, // dd/mm/yyyy
  /^(\d{4})-(\d{2})-(\d{2})$/, // yyyy-mm-dd
  /^(\d{2})-(\d{2})-(\d{4})$/, // dd-mm-yyyy
  /^(\d{2})\.(\d{2})\.(\d{4})$/, // dd.mm.yyyy
  /^(\d{2})\/(\d{2})\/(\d{2})$/, // dd/mm/yy
  /^(\d{4})\/(\d{2})\/(\d{2})$/, // yyyy/mm/dd
];

function parseDate(raw) {
  if (!raw) return null;
  const text = String(raw).trim().split("T")[0].split(" ")[0];

  const [y, m, d] = (() => {
    let match = text.match(DATE_FORMATS[0]);
    if (match) return [match[3], match[2], match[1]];
    match = text.match(DATE_FORMATS[1]);
    if (match) return [match[1], match[2], match[3]];
    match = text.match(DATE_FORMATS[2]);
    if (match) return [match[3], match[2], match[1]];
    match = text.match(DATE_FORMATS[3]);
    if (match) return [match[3], match[2], match[1]];
    match = text.match(DATE_FORMATS[4]);
    if (match) return [`20${match[3]}`, match[2], match[1]];
    match = text.match(DATE_FORMATS[5]);
    if (match) return [match[1], match[2], match[3]];
    return null;
  })();

  if (!y) return null;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isPlausibleDueDate(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  const today = new Date();
  const min = Date.UTC(2000, 0, 1);
  const max = Date.UTC(today.getUTCFullYear() + 10, 11, 31);
  return date.getTime() >= min && date.getTime() <= max;
}

function validateExtraction(extracted) {
  const errors = [];
  const warnings = [];

  const supplierName = (extracted.supplier_name || "").trim() || null;
  if (!supplierName) errors.push("missing_supplier_name");

  const cnpj = normalizeCnpj(extracted.supplier_cnpj);
  if (cnpj === null) errors.push("missing_cnpj");
  else if (!cnpjIsValid(cnpj)) errors.push("invalid_cnpj");

  const total = parseMoney(extracted.total_amount);
  if (total === null) errors.push("missing_total");
  else if (total <= 0) errors.push("invalid_total");

  const due = parseDate(extracted.due_date);
  if (due === null) errors.push("missing_due_date");
  else if (!isPlausibleDueDate(due)) errors.push("implausible_due_date");

  let currency = (extracted.currency || "").trim().toUpperCase() || null;
  if (currency === null) {
    currency = "BRL";
    warnings.push("currency_inferred");
  } else if (!SUPPORTED_CURRENCIES.has(currency)) {
    warnings.push(`unknown_currency:${currency}`);
  }

  let confidence = extracted.confidence;
  if (confidence !== null && confidence !== undefined) {
    confidence = Math.max(0, Math.min(1, Number(confidence)));
    if (confidence < MIN_CONFIDENCE) errors.push("low_confidence");
  } else {
    confidence = null;
  }

  return {
    supplier_name: supplierName,
    supplier_cnpj: cnpj,
    total_amount: total,
    currency,
    due_date: due,
    confidence,
    validation_errors: errors,
    validation_warnings: warnings,
  };
}

function renderNotification(validated) {
  const amount = validated.total_amount === null ? "n/a" : validated.total_amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (
    `New invoice processed successfully. Supplier: ${validated.supplier_name}. ` +
    `Total: ${validated.currency} ${amount}. Due: ${validated.due_date}. Approved for payment.`
  );
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function chips(errors, warnings) {
  const items = [
    ...(errors || []).map((item) => `<span class="chip chip-error">${escapeHtml(item)}</span>`),
    ...(warnings || []).map((item) => `<span class="chip chip-warn">${escapeHtml(item)}</span>`),
  ];
  if (!items.length) {
    items.push('<span class="chip chip-ok">All required fields validated</span>');
  }
  return items.join("");
}

function renderResult({ status, extracted, validated, text, source }) {
  const target = $("#result");

  if (status === "no_text_layer") {
    target.innerHTML = `
      <div class="result-head">
        <div>
          <h2>No text layer found</h2>
          <p class="result-sub">${escapeHtml(source)}</p>
        </div>
        <span class="status status-needs_review">Needs review</span>
      </div>
      <div class="section-title">Why</div>
      <div class="chips">${chips(["no_text_layer"], [])}</div>
      <p class="muted small" style="margin-top:12px">
        This PDF is a scan or has no embedded text. The full pipeline routes it to
        human review instead of guessing; OCR is out of scope for Phase 0.
      </p>`;
    return;
  }

  const notification =
    status === "processed"
      ? `<div class="section-title">Notification</div>
         <div class="notification">${escapeHtml(renderNotification(validated))}</div>`
      : `<div class="section-title">Notification</div>
         <div class="notification" style="border-left-color:#b7791f">
           Not sent. Only invoices that pass every required check are approved for payment.
         </div>`;

  target.innerHTML = `
    <div class="result-head">
      <div>
        <h2>${escapeHtml(validated.supplier_name || "Invoice under review")}</h2>
        <p class="result-sub">${escapeHtml(source)}</p>
      </div>
      <span class="status status-${status === "processed" ? "processed" : "needs_review"}">
        ${status === "processed" ? "Processed" : "Needs review"}
      </span>
    </div>

    <div class="fields">
      <div class="field">
        <div class="field-label">Supplier CNPJ</div>
        <div class="field-value">${escapeHtml(formatCnpj(validated.supplier_cnpj))}</div>
      </div>
      <div class="field">
        <div class="field-label">Total amount</div>
        <div class="field-value">${formatMoney(validated.total_amount, validated.currency)}</div>
      </div>
      <div class="field">
        <div class="field-label">Due date</div>
        <div class="field-value">${escapeHtml(formatDate(validated.due_date))}</div>
      </div>
    </div>

    <div class="section-title">Validation</div>
    <div class="chips">${chips(validated.validation_errors, validated.validation_warnings)}</div>

    ${notification}

    <div class="section-title">Extraction</div>
    <p class="muted small">Confidence: ${escapeHtml(validated.confidence ?? "—")} · mode: browser mock</p>
    <details class="raw">
      <summary>Raw extractor output</summary>
      <pre>${escapeHtml(JSON.stringify(extracted, null, 2))}</pre>
    </details>
    <details class="raw">
      <summary>Text read from the document</summary>
      <pre>${escapeHtml(text)}</pre>
    </details>`;
}

function setStatus(message, tone = "") {
  const node = $("#status");
  node.textContent = message;
  node.style.color = tone === "error" ? "#c62828" : "";
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

function processText(text, source) {
  if (!text || !text.trim()) {
    renderResult({
      status: "no_text_layer",
      extracted: {},
      validated: {},
      text: "",
      source,
    });
    return;
  }
  const extracted = extractFields(text);
  const validated = validateExtraction(extracted);
  const status = validated.validation_errors.length === 0 ? "processed" : "needs_review";
  renderResult({ status, extracted, validated, text, source });
}

async function processPdfBytes(bytes, source) {
  setStatus(`Reading ${source}…`);
  try {
    const text = await pdfToText(bytes);
    if (!text) {
      renderResult({ status: "no_text_layer", extracted: {}, validated: {}, text: "", source });
      setStatus("No text layer found.", "error");
      return;
    }
    processText(text, source);
    setStatus(`${source} processed locally.`);
  } catch (error) {
    console.error(error);
    setStatus(`Could not read the PDF: ${error.message}`, "error");
  }
}

async function loadSample(name) {
  setStatus(`Downloading ${name}…`);
  try {
    const response = await fetch(`samples/${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    await processPdfBytes(new Uint8Array(buffer), name);
  } catch (error) {
    setStatus(`Sample unavailable: ${error.message}`, "error");
  }
}

async function handleFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    setStatus("Please choose a PDF file.", "error");
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    setStatus("File is larger than the 15 MiB demo limit.", "error");
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  await processPdfBytes(bytes, file.name);
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

function wireEvents() {
  const input = $("#file-input");
  const dropzone = $("#dropzone");

  input.addEventListener("change", () => handleFile(input.files[0]));

  ["dragenter", "dragover"].forEach((event) => {
    dropzone.addEventListener(event, (evt) => {
      evt.preventDefault();
      dropzone.classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach((event) => {
    dropzone.addEventListener(event, (evt) => {
      evt.preventDefault();
      dropzone.classList.remove("drag");
    });
  });
  dropzone.addEventListener("drop", (evt) => handleFile(evt.dataTransfer.files[0]));

  document.querySelectorAll("[data-sample]").forEach((button) => {
    button.addEventListener("click", () => loadSample(button.dataset.sample));
  });

  $("#text-btn").addEventListener("click", () => {
    const text = $("#text-input").value;
    if (!text.trim()) {
      setStatus("Paste the invoice text first.", "error");
      return;
    }
    processText(text, "Pasted text");
    setStatus("Text processed locally.");
  });

  // First sample is the fastest way to see the demo working.
  loadSample("acme_invoice.pdf");
}

wireEvents();
