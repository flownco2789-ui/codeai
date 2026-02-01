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
