/**
 * CODEAI 강사등록신청 → Google Sheet 저장용 Web App
 *
 * 대상 스프레드시트: https://docs.google.com/spreadsheets/d/1YS4SqWhd_WB2qBu_tRi26dL-DYpHMULTO12ev0ZDlqQ
 * 대상 탭(시트명): 강사신청목록
 *
 * ✅ doGet: action=headers (JSONP) → 1행 헤더 목록 반환(폼 자동 생성용)
 * ✅ doPost: payload 전달 → 시트에 appendRow (2행부터 누적)
 *
 * ⚠️ 배포(웹앱) 설정:
 * - 실행: 나
 * - 액세스: 모든 사용자(익명 포함)
 */

const SPREADSHEET_ID = "1YS4SqWhd_WB2qBu_tRi26dL-DYpHMULTO12ev0ZDlqQ";
const SHEET_NAME = "강사신청목록";
const API_KEY = "fgtz7pT4TLOI42l0HcS5Eo7R41zweVdvsCEmcbSEwUE";

// 자동으로 날짜 넣고 싶은 헤더 키워드(해당 헤더는 입력폼에서 제외되고 서버에서 자동기록)
const AUTO_DATE_KEYWORDS = ["접수", "신청", "등록", "작성", "일시", "날짜", "timestamp"];

function getSheet_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) throw new Error(`시트 탭을 찾을 수 없습니다: ${SHEET_NAME}`);
  return sh;
}

function getHeaders_() {
  const sh = getSheet_();
  const lastCol = sh.getLastColumn();
  if (lastCol < 1) return [];
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || "").trim());
  return headers.filter(h => h.length > 0);
}

function isAutoDateHeader_(header) {
  const h = String(header || "").toLowerCase();
  return AUTO_DATE_KEYWORDS.some(k => h.includes(k));
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonpOut_(obj, callback) {
  const body = `${callback}(${JSON.stringify(obj)});`;
  return ContentService
    .createTextOutput(body)
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

/**
 * GET: 헤더 목록 제공 (폼 자동 생성)
 * 예) ?action=headers&apiKey=...&callback=...
 */
function doGet(e) {
  try {
    const p = e.parameter || {};
    if ((p.apiKey || "") !== API_KEY) {
      const out = { ok: false, error: "Unauthorized" };
      return p.callback ? jsonpOut_(out, p.callback) : jsonOut_(out);
    }

    if ((p.action || "") === "headers") {
      const headers = getHeaders_();
      const out = { ok: true, headers };
      return p.callback ? jsonpOut_(out, p.callback) : jsonOut_(out);
    }

    return jsonOut_({ ok: true, message: "OK" });
  } catch (err) {
    const out = { ok: false, error: String(err) };
    return (e && e.parameter && e.parameter.callback)
      ? jsonpOut_(out, e.parameter.callback)
      : jsonOut_(out);
  }
}

/**
 * POST: 신청 저장
 * 프론트는 <form target="hiddenIframe">로 제출하고,
 * 응답 HTML이 window.parent.postMessage로 결과를 돌려줍니다.
 */
function doPost(e) {
  const send = (obj) => {
    const payload = JSON.stringify(obj);
    const html = `<!doctype html><html><body>
      <script>
        window.parent.postMessage(${payload}, "*");
      </script>
    </body></html>`;
    return HtmlService.createHtmlOutput(html);
  };

  try {
    const payloadStr =
      (e.parameter && e.parameter.payload) ? e.parameter.payload :
      (e.postData && e.postData.contents) ? e.postData.contents : "{}";

    const payload = JSON.parse(payloadStr || "{}");
    const requestId = payload.requestId || "";

    if ((payload.apiKey || "") !== API_KEY) {
      return send({ type:"CODEAI_INSTRUCTOR_SUBMIT_RESULT", ok:false, code:"UNAUTHORIZED", message:"API_KEY가 일치하지 않습니다.", requestId });
    }

    const sh = getSheet_();
    const headers = getHeaders_();
    if (!headers.length) {
      return send({ type:"CODEAI_INSTRUCTOR_SUBMIT_RESULT", ok:false, code:"NO_HEADERS", message:"1행 헤더가 비어있습니다(강사신청목록 탭 1행 확인).", requestId });
    }

    const now = new Date();
    const values = payload.values || {};

    // ✅ 1행 헤더 순서대로 값 구성 → appendRow는 자동으로 2행부터 누적
    const row = headers.map(h => {
      if (isAutoDateHeader_(h)) return now; // 자동 날짜
      return (values[h] !== undefined && values[h] !== null) ? String(values[h]).trim() : "";
    });

    sh.appendRow(row);
    return send({ type:"CODEAI_INSTRUCTOR_SUBMIT_RESULT", ok:true, requestId });

  } catch (err) {
    return send({ type:"CODEAI_INSTRUCTOR_SUBMIT_RESULT", ok:false, code:"SERVER_ERROR", message:String(err), requestId:"" });
  }
}
