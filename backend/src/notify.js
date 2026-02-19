/**
 * Notification abstraction
 * - 현재는 DB(notification_logs)에만 기록 (알림톡/SMS는 추후 연동)
 */
export async function logNotification(pool, {
  channel="INTERNAL",
  eventType,
  toRole=null,
  toPhone=null,
  payload=null,
  status="QUEUED"
}){
  const payloadJson = (payload === null || payload === undefined) ? null : JSON.stringify(payload);

  await pool.query(
    "INSERT INTO notification_logs (channel,event_type,to_role,to_phone,payload,status) VALUES (:channel,:eventType,:toRole,:toPhone,:payload,:status)",
    { channel, eventType, toRole, toPhone, payload: payloadJson, status }
  );
}

export async function notifyAdminsByRoles(pool, roles, eventType, payload){
  if(!roles || !roles.length) return;
  const [rows] = await pool.query(
    "SELECT role, phone FROM admin_users WHERE is_active=1 AND role IN (" + roles.map(()=>"?").join(",") + ") AND phone IS NOT NULL",
    roles
  );
  for(const r of rows){
    await logNotification(pool, { channel:"INTERNAL", eventType, toRole:r.role, toPhone:r.phone, payload, status:"QUEUED" });
  }
}

export async function notifyPhone(pool, phone, eventType, payload){
  if(!phone) return;
  await logNotification(pool, { channel:"INTERNAL", eventType, toRole:null, toPhone:phone, payload, status:"QUEUED" });
}

// ----------------------------
// Aligo 알림톡 (KAKAO)
// ----------------------------

function cleanPhone(phone){
  if(!phone) return "";
  return String(phone).replace(/[^0-9]/g, "");
}

function envOr(name, fallback=null){
  const v = process.env[name];
  if(v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s ? s : fallback;
}

function envPick(names, fallback=null){
  for(const n of (names||[])){
    const v = envOr(n);
    if(v !== null && v !== undefined && String(v).trim() !== "") return String(v).trim();
  }
  return fallback;
}

function isAligoEnabled(){
  const flag = envOr("ALIGO_ENABLED", "");
  // default: OFF unless explicitly enabled
  return String(flag).toLowerCase() === "true" || String(flag) === "1";
}

async function aligoPost(url, formObj){
  const body = new URLSearchParams();
  for(const [k,v] of Object.entries(formObj||{})){
    if(v === undefined || v === null || v === "") continue;
    body.set(k, String(v));
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const text = await resp.text();
  let json = null;
  try{ json = JSON.parse(text); }catch{ json = { raw:text }; }
  return { httpStatus: resp.status, data: json };
}

async function getAligoToken(){
  const apikey = envPick(["ALIGO_APIKEY","ALIGO_API_KEY"]);
  const userid = envPick(["ALIGO_USERID","ALIGO_USER_ID"]);
  const tokenUrl = envOr("ALIGO_TOKEN_URL", "https://kakaoapi.aligo.in/akv10/token/create/30/s/");
  if(!apikey || !userid) throw new Error("Missing ALIGO_APIKEY/ALIGO_USERID");

  const { data } = await aligoPost(tokenUrl, { apikey, userid });
  // 성공: {code:0, token:"..."}
  if(!data || data.code !== 0 || !data.token) throw new Error(`Aligo token error: ${JSON.stringify(data)}`);
  return data.token;
}

async function sendAligoAlimtalk({ toPhone, toName=null, tplCode, subject, message, buttonJson=null }){
  const apikey = envPick(["ALIGO_APIKEY","ALIGO_API_KEY"]);
  const userid = envPick(["ALIGO_USERID","ALIGO_USER_ID"]);
  const senderkey = envPick(["ALIGO_SENDERKEY"]);
  const sender = envPick(["ALIGO_SENDER","ALIGO_SENDER_PHONE"]);
  const sendUrl = envOr("ALIGO_SEND_URL", "https://kakaoapi.aligo.in/akv10/alimtalk/send/");
  if(!apikey || !userid || !senderkey || !sender) throw new Error("Missing ALIGO env (ALIGO_APIKEY/ALIGO_USERID/ALIGO_SENDERKEY/ALIGO_SENDER)");
  if(!tplCode) throw new Error("Missing tplCode");

  const token = await getAligoToken();

  const form = {
    apikey,
    userid,
    senderkey,
    token,
    tpl_code: tplCode,
    sender: cleanPhone(sender),
    receiver_1: cleanPhone(toPhone),
    recvname_1: toName ? String(toName) : undefined,
    subject_1: subject || "",
    message_1: message || "",
    button_1: buttonJson ? String(buttonJson) : undefined,
    failover: envOr("ALIGO_FAILOVER", "N")
  };

  const { data, httpStatus } = await aligoPost(sendUrl, form);
  return { httpStatus, data };
}

async function updateNotification(pool, id, { status, payload }){
  const payloadJson = (payload === null || payload === undefined) ? null : JSON.stringify(payload);
  await pool.query(
    "UPDATE notification_logs SET status=:status, payload=:payload WHERE id=:id",
    { id, status, payload: payloadJson }
  );
}

/**
 * 알림톡 전송 + notification_logs 기록
 * - ALIGO_ENABLED=true 인 경우에만 실제 전송 시도
 * - 항상 notification_logs에는 기록
 */
export async function sendAlimtalk(pool, {
  toPhone,
  toName=null,
  eventType,
  payload=null,
  tplCode,
  subject,
  message,
  buttonJson=null
}){
  if(!toPhone) return { ok:false, skipped:true, reason:"NO_PHONE" };

  // 기록 먼저
  const basePayload = Object.assign({}, payload || {}, {
    tplCode,
    subject,
    message,
    buttonJson: buttonJson || null
  });

  const [ins] = await pool.query(
    "INSERT INTO notification_logs (channel,event_type,to_role,to_phone,payload,status) VALUES ('KAKAO',:eventType,NULL,:toPhone,:payload,'QUEUED')",
    { eventType, toPhone: cleanPhone(toPhone), payload: JSON.stringify(basePayload) }
  );
  const notiId = ins.insertId;

  if(!isAligoEnabled()){
    // 환경변수 미설정/비활성화: QUEUED로 남김
    return { ok:true, skipped:true, id:notiId, reason:"ALIGO_DISABLED" };
  }

  try{
    const result = await sendAligoAlimtalk({ toPhone, toName, tplCode, subject, message, buttonJson });
    const sentOk = result?.data && result.data.code === 0;
    await updateNotification(pool, notiId, {
      status: sentOk ? "SENT" : "FAILED",
      payload: Object.assign({}, basePayload, { aligo_result: result })
    });
    return { ok: sentOk, id: notiId, result };
  }catch(e){
    await updateNotification(pool, notiId, {
      status: "FAILED",
      payload: Object.assign({}, basePayload, { error: String(e?.message || e) })
    });
    return { ok:false, id:notiId, error: String(e?.message || e) };
  }
}
