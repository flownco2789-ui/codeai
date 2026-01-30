export function normalizePhone(v) {
  return String(v || "").replace(/[^0-9]/g, "");
}

export function formatPhone(v) {
  const p = normalizePhone(v);
  // 01012345678 -> 010-1234-5678 / 0101234567 -> 010-123-4567
  if (p.length === 11) return p.replace(/^(\d{3})(\d{4})(\d{4})$/, "$1-$2-$3");
  if (p.length === 10) return p.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3");
  return String(v || "").trim();
}

export function isValidPhone(v) {
  const p = normalizePhone(v);
  return p.length >= 10 && p.length <= 11;
}

export function mustStr(v, minLen = 1) {
  const s = String(v || "").trim();
  return s.length >= minLen ? s : null;
}

export function mustBool(v) {
  if (v === true || v === 1 || v === "1" || v === "true") return true;
  if (v === false || v === 0 || v === "0" || v === "false") return false;
  return null;
}

export function pickMeta(req) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
  return {
    page_url: mustStr(req.body?.page_url) || mustStr(req.body?.pageUrl) || null,
    referrer: mustStr(req.body?.referrer) || null,
    user_agent: String(req.headers["user-agent"] || "").slice(0, 255) || null,
    client_time: (() => {
      const raw = mustStr(req.body?.client_time) || mustStr(req.body?.clientTime);
      if (!raw) return null;
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return null;
      // MySQL DATETIME
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    })(),
    ip: ip ? String(ip).slice(0, 45) : null
  };
}
