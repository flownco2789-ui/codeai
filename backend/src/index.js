import "dotenv/config";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import multer from "multer";

import { makePoolFromEnv } from "./db.js";
import { mustStr, isValidPhone, formatPhone, pickMeta } from "./validators.js";
import { hashPassword, verifyPassword, signToken, requireAuth } from "./auth.js";
import { notifyAdminsByRoles, notifyPhone, logNotification } from "./notify.js";
import { createSmartStoreProduct } from "./smartstore.js";

const app = express();
const pool = makePoolFromEnv();
const db = pool; // alias for legacy code


const PORT = Number(process.env.PORT || "8080");
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const API_PUBLIC_BASE = String(process.env.API_PUBLIC_BASE || "").replace(/\/+$/g,"") || null;

app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan("combined"));
app.use(rateLimit({ windowMs: 60_000, max: 300 }));

app.use(cors({
  origin: function(origin, cb){
    if(!origin) return cb(null, true);
    if(allowedOrigins.length === 0) return cb(null, true);
    return cb(null, allowedOrigins.includes(origin));
  },
  credentials: false
}));

// Some browsers/clients may send JSON with a non-standard Content-Type (e.g. text/plain)
// if headers are accidentally dropped/overwritten on the frontend.
// Accept both application/json and text/plain to make admin saves resilient.
app.use(express.json({ limit: "1mb", type: ["application/json", "text/plain"] }));

// Uploads
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").slice(0, 10) || "";
    const base = crypto.randomBytes(12).toString("hex");
    cb(null, `${Date.now()}_${base}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }
});
app.use("/uploads", express.static(UPLOAD_DIR));

function jsonArr(v){
  if(Array.isArray(v)) return v;
  if(typeof v === "string"){
    try{
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [String(v)];
    }catch{
      return [v];
    }
  }
  return [];
}
function jsonStr(v){
  try{
    if(typeof v === "string") return v;
    return JSON.stringify(v);
  }catch{
    return "[]";
  }
}

function generateTempPassword4(){
  // 4자리 임시비번: 0000~9999 (0으로 시작 가능)
  return String(crypto.randomInt(0, 10000)).padStart(4, "0");
}

function parseJsonArray(v){
  try{
    if(Array.isArray(v)) return v;
    if(!v) return [];
    const j = (typeof v === "string") ? JSON.parse(v) : v;
    return Array.isArray(j) ? j : [];
  }catch{
    return [];
  }
}

function normalizeSubjectsInput(v){
  // accept array or comma-separated string
  if(Array.isArray(v)) return v.map(x=>String(x).trim()).filter(Boolean);
  const s = String(v||"").trim();
  if(!s) return [];
  return s.split(",").map(x=>x.trim()).filter(Boolean);
}

function normalizeModesInput(v){
  const allowed = new Set(["ZOOM","OFFLINE_1_1","OFFLINE_GROUP"]);
  const arr = Array.isArray(v) ? v : normalizeSubjectsInput(v);
  return arr.map(x=>String(x).trim()).filter(x=>allowed.has(x));
}

// instructor token + DB row + must_change_password gate
const _requireInstructorToken = requireAuth("INSTRUCTOR");
function requireInstructor(opts={}){
  const allowWhenMustChange = Boolean(opts.allowWhenMustChange);
  return (req,res,next)=>_requireInstructorToken(req,res, async ()=>{
    try{
      const id = req.user.id;
      const [[u]] = await pool.query("SELECT * FROM instructors WHERE id=:id LIMIT 1", { id });
      if(!u || u.status !== "ACTIVE") return bad(res,"UNAUTHORIZED","invalid credentials",401);
      req.instructor = u;
      if(u.must_change_password === 1 && !allowWhenMustChange){
        return res.status(403).json({ ok:false, code:"PASSWORD_CHANGE_REQUIRED", message:"비밀번호 변경이 필요합니다." });
      }
      return next();
    }catch(e){
      console.error(e);
      return bad(res,"SERVER_ERROR","Failed",500);
    }
  });
}

function ok(res, payload){ return res.json(Object.assign({ ok: true }, payload || {})); }
function bad(res, code, message, status=400){ return res.status(status).json({ ok:false, code, message }); }

function pad2(n){ return String(n).padStart(2,"0"); }
function fmtDateTime(d){
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function startOfWeekMonday(dateObj){
  const d = new Date(dateObj);
  d.setHours(0,0,0,0);
  // JS: 0=Sun,1=Mon.. => convert to Monday start
  const day = d.getDay();
  const diff = (day === 0 ? -6 : (1 - day));
  d.setDate(d.getDate() + diff);
  return d;
}
async function logPortalCodeEvent(pool, { enrollmentId, eventType, codeValue=null, actorRole="SYSTEM", actorId=null, req=null }){
  try{
    const ip = (req && (req.headers["x-forwarded-for"] || req.ip)) ? String(req.headers["x-forwarded-for"] || req.ip).split(",")[0].trim() : null;
    const ua = (req && req.headers["user-agent"]) ? String(req.headers["user-agent"]).slice(0,255) : null;
    await pool.query(
      "INSERT INTO portal_code_events (enrollment_id,event_type,code_value,actor_role,actor_id,ip,user_agent) VALUES (:eid,:t,:v,:r,:aid,:ip,:ua)",
      { eid: enrollmentId, t: eventType, v: codeValue, r: actorRole, aid: actorId, ip, ua }
    );
  }catch(e){
    // logging must not break flow
    console.warn("portal_code_events insert failed:", e?.code || e?.message || e);
  }
}
function genPortalCode(){
  // 6 digits
  return String(Math.floor(100000 + Math.random()*900000));
}


// Health
app.get("/healthz", (req,res)=> ok(res, { status:"ok" }));

/** ===========================
 * PUBLIC API
 * =========================== */

// 학생 수강신청 (V2)
app.post("/api/v1/public/student-applications", async (req,res)=>{
  try{
    const name = mustStr(req.body?.name);
    const phone = mustStr(req.body?.phone);
    const subjects = jsonArr(req.body?.subjects).map(s=>String(s).trim()).filter(Boolean).slice(0,5);
    const target = mustStr(req.body?.target) || null;
    const mode = mustStr(req.body?.mode);
    const region = mustStr(req.body?.region) || null;
    const note = mustStr(req.body?.note) || null;
    const preferredInstructorTypeRaw = mustStr(req.body?.preferredInstructorType) || mustStr(req.body?.preferred_instructor_type) || null;
    const preferredInstructorType = (preferredInstructorTypeRaw && preferredInstructorTypeRaw.trim()) ? preferredInstructorTypeRaw.trim() : "ANY";

    if(!name) return bad(res,"INVALID_NAME","name required");
    if(!phone || !isValidPhone(phone)) return bad(res,"INVALID_PHONE","phone invalid");
    if(!subjects.length) return bad(res,"INVALID_SUBJECTS","subjects required");
    if(!mode || !["ZOOM","OFFLINE_1_1","OFFLINE_GROUP"].includes(mode)) return bad(res,"INVALID_MODE","mode invalid");
    if(!["ANY","COLLEGE","EMPLOYEE","FREELANCER","FULLTIME_TUTOR","OTHER"].includes(preferredInstructorType)){
      return bad(res,"INVALID_PREFERRED_INSTRUCTOR_TYPE","preferredInstructorType invalid");
    }
    // 오프라인 수업은 지역 입력 권장(필수 처리)
    if(mode !== "ZOOM" && (!region || !String(region).trim())){
      return bad(res,"INVALID_REGION","region required for offline mode");
    }

    const meta = pickMeta(req);
    const [r] = await pool.query(
      "INSERT INTO student_applications (name,phone,subjects,target,mode,region,preferred_instructor_type,note,status) VALUES (:name,:phone,:subjects,:target,:mode,:region,:preferred_instructor_type,:note,'SUBMITTED')",
      { name, phone: formatPhone(phone), subjects: JSON.stringify(subjects), target, mode, region, preferred_instructor_type: preferredInstructorType, note }
    );
    const id = r.insertId;

    // Admin notify logs
    await notifyAdminsByRoles(pool, ["SUPER_ADMIN","SUB_ADMIN","STUDENT_ADMIN"], "STUDENT_APPLICATION_CREATED", {
      id, name, phone: formatPhone(phone), subjects, target, mode, region, preferredInstructorType
    });

    ok(res, { studentApplication: { id } });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed to create student application",500);
  }
});

// 강사 리스트 (필터링)
app.get("/api/v1/public/instructors", async (req,res)=>{
  try{
    const subject = mustStr(req.query?.subject) || null;
    const mode = mustStr(req.query?.mode) || null;
    const region = mustStr(req.query?.region) || null;
    const instructorTypeRaw = mustStr(req.query?.instructorType) || mustStr(req.query?.instructor_type) || null;
    const instructorType = (instructorTypeRaw && instructorTypeRaw.trim()) ? instructorTypeRaw.trim() : null;
const featured = mustStr(req.query?.featured) || null;

    let sql = "SELECT id,name,subjects,modes,region,instructor_type,is_featured,education,career,major,age,gender,photo_url FROM instructors WHERE status='ACTIVE'";
    const params = {};
    if(region){
      sql += " AND (region IS NULL OR region='' OR region LIKE :regionLike)";
      params.regionLike = `%${region}%`;
    }
    // subject/mode: JSON_CONTAINS
    if(subject){
      sql += " AND JSON_CONTAINS(subjects, JSON_QUOTE(:subject))";
      params.subject = subject;
    }
    if(mode){
      sql += " AND JSON_CONTAINS(modes, JSON_QUOTE(:mode))";
      params.mode = mode;
    }
    if(instructorType && instructorType !== "ANY"){
      sql += " AND instructor_type = :instructorType";
      params.instructorType = instructorType;
    
    if(featured === "1"){
      sql += " AND is_featured = 1";
    }
}
    sql += " ORDER BY id DESC LIMIT 50";

    const [rows] = await pool.query(sql, params);
    ok(res, { instructors: rows.map(r=>({
      id: r.id,
      name: r.name,
      subjects: typeof r.subjects === "string" ? r.subjects : JSON.stringify(r.subjects),
      modes: typeof r.modes === "string" ? r.modes : JSON.stringify(r.modes),
      region: r.region,
      instructor_type: r.instructor_type,
      is_featured: r.is_featured,
      education: r.education,
      career: r.career,
      major: r.major,
      age: r.age,
      gender: r.gender,
      photo_url: r.photo_url
    }))});
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed to list instructors",500);
  }

// 메인강사(Featured) 20명
app.get("/api/v1/public/featured-instructors", async (req,res)=>{
  try{
    const [rows] = await pool.query(
      "SELECT id,name,subjects,modes,region,instructor_type,is_featured,education,career,major,age,gender,photo_url " +
      "FROM instructors WHERE status='ACTIVE' AND is_featured=1 ORDER BY id DESC LIMIT 20"
    );
    ok(res, { instructors: rows.map(r=>({
      id:r.id, name:r.name,
      subjects: typeof r.subjects === "string" ? r.subjects : JSON.stringify(r.subjects),
      modes: typeof r.modes === "string" ? r.modes : JSON.stringify(r.modes),
      region:r.region, instructor_type:r.instructor_type, is_featured:r.is_featured,
      education:r.education, career:r.career, major:r.major, age:r.age, gender:r.gender,
      photo_url:r.photo_url
    }))});
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

// 통계(총 강사 수 / 총 수강생 수)
app.get("/api/v1/public/stats", async (req,res)=>{
  try{
    const [[a]] = await pool.query("SELECT COUNT(*) AS cnt FROM instructors WHERE status='ACTIVE'");
    const [[b]] = await pool.query("SELECT COUNT(DISTINCT phone) AS cnt FROM student_applications");
    ok(res, { total_instructors: Number(a.cnt||0), total_students: Number(b.cnt||0) });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

});

// 학생이 강사 선택
app.post("/api/v1/public/student-applications/:id/select-instructor", async (req,res)=>{
  try{
    const appId = Number(req.params.id);
    const instructorId = Number(req.body?.instructorId);
    if(!appId || !instructorId) return bad(res,"INVALID_PARAMS","id/instructorId required");

    const [[sa]] = await pool.query("SELECT * FROM student_applications WHERE id=:id", { id: appId });
    if(!sa) return bad(res,"NOT_FOUND","student application not found",404);

    const [[inst]] = await pool.query("SELECT id,name,phone,email,region FROM instructors WHERE id=:id AND status='ACTIVE'", { id: instructorId });
    if(!inst) return bad(res,"NOT_FOUND","instructor not found",404);

    await pool.query(
      "UPDATE student_applications SET status='INSTRUCTOR_SELECTED', selected_instructor_id=:iid, status_changed_at=NOW() WHERE id=:id",
      { id: appId, iid: instructorId }
    );

    const [r] = await pool.query(
      "INSERT INTO enrollments (student_application_id,instructor_id,status) VALUES (:sid,:iid,'BEFORE_PAYMENT')",
      { sid: appId, iid: instructorId }
    );
    const enrollmentId = r.insertId;

    await pool.query("UPDATE student_applications SET status='ENROLLED', status_changed_at=NOW() WHERE id=:id", { id: appId });

    // notify logs
    await notifyAdminsByRoles(pool, ["SUPER_ADMIN","SUB_ADMIN","STUDENT_ADMIN"], "STUDENT_SELECTED_INSTRUCTOR", {
      studentApplicationId: appId, enrollmentId, studentName: sa.name, studentPhone: sa.phone, instructorId: inst.id, instructorName: inst.name
    });
    await notifyPhone(pool, inst.phone, "STUDENT_SELECTED_INSTRUCTOR_TO_INSTRUCTOR", {
      enrollmentId, studentName: sa.name, studentPhone: sa.phone, mode: sa.mode, region: sa.region, subjects: sa.subjects
    });

    ok(res, { enrollmentId });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed to select instructor",500);
  }
});

// 강사 신청 (V2, multipart + photo)
app.post("/api/v1/public/instructor-applications", upload.single("photo"), async (req,res)=>{
  try{
    const name = mustStr(req.body?.name);
    const phone = mustStr(req.body?.phone);
    const email = mustStr(req.body?.email);
    const subjects = jsonArr(req.body?.subjects).map(s=>String(s).trim()).filter(Boolean).slice(0,8);
    const modes = jsonArr(req.body?.modes).map(s=>String(s).trim()).filter(Boolean).slice(0,5);
    const region = mustStr(req.body?.region) || null;
    const education = mustStr(req.body?.education) || null;
    const career = mustStr(req.body?.career) || null;
    const major = mustStr(req.body?.major) || null;
    const age = req.body?.age ? Number(req.body.age) : null;
    const gender = mustStr(req.body?.gender) || null;
    const instructorTypeRaw2 = mustStr(req.body?.instructorType) || mustStr(req.body?.instructor_type) || null;
    const instructorType2 = (instructorTypeRaw2 && instructorTypeRaw2.trim()) ? instructorTypeRaw2.trim() : null;

    if(!name) return bad(res,"INVALID_NAME","name required");
    if(!phone || !isValidPhone(phone)) return bad(res,"INVALID_PHONE","phone invalid");
    if(!email) return bad(res,"INVALID_EMAIL","email required");
    if(!subjects.length) return bad(res,"INVALID_SUBJECTS","subjects required");
    if(!modes.length) return bad(res,"INVALID_MODES","modes required");

    if(instructorType2 && !["COLLEGE","EMPLOYEE","FREELANCER","FULLTIME_TUTOR","OTHER"].includes(instructorType2)){
      return bad(res,"INVALID_INSTRUCTOR_TYPE","instructorType invalid");
    }

    let photo_url = null;
    if(req.file){
      const base = API_PUBLIC_BASE || (req.protocol + "://" + req.get("host"));
      photo_url = base.replace(/\/+$/g,"") + "/uploads/" + req.file.filename;
    }

    const [r] = await pool.query(
      "INSERT INTO instructor_applications (name,phone,email,subjects,modes,region,instructor_type,education,career,major,age,gender,photo_url,status) " +
      "VALUES (:name,:phone,:email,:subjects,:modes,:region,:instructor_type,:education,:career,:major,:age,:gender,:photo_url,'PENDING')",
      {
        name,
        phone: formatPhone(phone),
        email,
        subjects: JSON.stringify(subjects),
        modes: JSON.stringify(modes),
        region,
        instructor_type: instructorType2,
        education, career, major,
        age: (Number.isFinite(age) ? age : null),
        gender: (gender && ["M","F","OTHER"].includes(gender) ? gender : null),
        photo_url
      }
    );
    const id = r.insertId;

    await notifyAdminsByRoles(pool, ["SUPER_ADMIN","SUB_ADMIN","INSTRUCTOR_ADMIN"], "INSTRUCTOR_APPLICATION_CREATED", {
      id, name, phone: formatPhone(phone), email, subjects, modes, region
    });

    ok(res, { instructorApplication: { id }});
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed to create instructor application",500);
  }
});

// Legacy compatibility (student enroll v1 -> v2 proxy)
app.post("/api/v1/applications/enroll", async (req,res)=>{
  // map old fields to new and forward logic
  req.body = {
    name: req.body?.name,
    phone: req.body?.phone,
    subjects: req.body?.subjects || [req.body?.subject].filter(Boolean),
    target: req.body?.target || null,
    mode: req.body?.mode || "ZOOM",
    region: req.body?.region || null,
    note: req.body?.note || null
  };
  return app._router.handle(req, res, ()=>{}, "post", "/api/v1/public/student-applications");
});
// Legacy compatibility (v1: /api/v1/applications/enroll)
app.post("/api/v1/applications/enroll", async (req,res)=>{
  try{
    const name = mustStr(req.body?.name);
    const phone = mustStr(req.body?.phone);
    const target = mustStr(req.body?.target) || null;
    const note = mustStr(req.body?.note) || null;
    const subjects = jsonArr(req.body?.subjects || req.body?.subject || []).map(s=>String(s).trim()).filter(Boolean).slice(0,5);
    const mode = "ZOOM"; // v1 default
    const region = null;

    if(!name) return bad(res,"INVALID_NAME","name required");
    if(!phone || !isValidPhone(phone)) return bad(res,"INVALID_PHONE","phone invalid");
    if(!subjects.length) return bad(res,"INVALID_SUBJECTS","subjects required");

    const [r] = await pool.query(
      "INSERT INTO student_applications (name,phone,subjects,target,mode,region,preferred_instructor_type,note,status) VALUES (:name,:phone,:subjects,:target,:mode,:region,:preferred_instructor_type,:note,'SUBMITTED')",
      { name, phone: formatPhone(phone), subjects: JSON.stringify(subjects), target, mode, region, preferred_instructor_type: preferredInstructorType, note }
    );
    const id = r.insertId;

    await notifyAdminsByRoles(pool, ["SUPER_ADMIN","SUB_ADMIN","STUDENT_ADMIN"], "STUDENT_APPLICATION_CREATED", {
      id, name, phone: formatPhone(phone), subjects, target, mode, region, preferredInstructorType
    });

    ok(res, { id });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed to create application",500);
  }
});



/** ===========================
 * ADMIN API
 * =========================== */

app.post("/api/v1/admin/auth/login", async (req,res)=>{
  try{
    const email = mustStr(req.body?.email);
    const password = mustStr(req.body?.password);
    if(!email || !password) return bad(res,"INVALID_INPUT","email/password required");
    const [[u]] = await pool.query("SELECT * FROM admin_users WHERE email=:email AND is_active=1", { email });
    if(!u) return bad(res,"INVALID_CREDENTIALS","invalid credentials",401);
    const superPw = (process.env.SUPER_ADMIN_PASSWORD && String(process.env.SUPER_ADMIN_PASSWORD).trim()) ? String(process.env.SUPER_ADMIN_PASSWORD) : null;
    const okpw = (superPw && password === superPw) ? true : await verifyPassword(password, u.password_hash);

    if(!okpw) return bad(res,"INVALID_CREDENTIALS","invalid credentials",401);
    const token = signToken({ typ:"ADMIN", id:u.id, role:u.role, email:u.email }, { expiresIn:"7d" });
    ok(res, { token, role: u.role });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","login failed",500);
  }
});


app.get("/api/v1/admin/notification-logs", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const q = mustStr(req.query?.q) || null;
    const eventType = mustStr(req.query?.event_type) || null;
    const status = mustStr(req.query?.status) || null;
    const channel = mustStr(req.query?.channel) || null;
    const toPhone = mustStr(req.query?.to_phone) || null;

    const sortByRaw = mustStr(req.query?.sortBy) || null;
    const sortDirRaw = mustStr(req.query?.sortDir) || null;
    const limitRaw = Number(req.query?.limit || 200);
    const offsetRaw = Number(req.query?.offset || 0);

    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, limitRaw)) : 200;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.min(100000, offsetRaw)) : 0;

    const allowedSort = { id:"id", created_at:"created_at" };
    const sortBy = allowedSort[sortByRaw] || "id";
    const sortDir = (String(sortDirRaw||"").toUpperCase()==="ASC") ? "ASC" : "DESC";

    let sql = "SELECT id, channel, event_type, to_role, to_phone, payload, status, created_at FROM notification_logs WHERE 1=1";
    const params = {};
    if(channel && ["SMS","KAKAO","EMAIL","INTERNAL"].includes(channel)){
      sql += " AND channel=:ch";
      params.ch = channel;
    }
    if(status && ["QUEUED","SENT","FAILED"].includes(status)){
      sql += " AND status=:st";
      params.st = status;
    }
    if(eventType){
      sql += " AND event_type=:et";
      params.et = eventType;
    }
    if(toPhone){
      sql += " AND to_phone LIKE :tp";
      params.tp = `%${toPhone}%`;
    }
    if(q){
      // payload는 JSON 타입. CAST(payload AS CHAR)로 문자열 검색 가능.
      sql += " AND (to_phone LIKE :q OR event_type LIKE :q OR CAST(payload AS CHAR) LIKE :q)";
      params.q = `%${q}%`;
    }
    sql += ` ORDER BY ${sortBy} ${sortDir}, id DESC LIMIT ${limit} OFFSET ${offset}`;

    const [rows] = await pool.query(sql, params);
    const list = rows.map(r=>{
      let payload = r.payload;
      try{
        if(payload && typeof payload === "string") payload = JSON.parse(payload);
      }catch{ /* ignore */ }
      return {
        id: r.id,
        channel: r.channel,
        event_type: r.event_type,
        to_role: r.to_role,
        to_phone: r.to_phone,
        payload,
        status: r.status,
        created_at: r.created_at
      };
    });
    ok(res, { list, limit, offset });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

app.get("/api/v1/admin/instructor-applications", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const search = mustStr(req.query?.search) || null;
    const status = mustStr(req.query?.status) || null;
    const sortByRaw = mustStr(req.query?.sortBy) || null;
    const sortDirRaw = mustStr(req.query?.sortDir) || null;
    const limitRaw = Number(req.query?.limit || 200);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, limitRaw)) : 200;

    const allowedSort = { id:"id", created_at:"created_at", status:"status", reviewed_at:"reviewed_at", name:"name" };
    const sortBy = allowedSort[sortByRaw] || "id";
    const sortDir = (String(sortDirRaw||"").toUpperCase()==="ASC") ? "ASC" : "DESC";

    let sql = "SELECT * FROM instructor_applications WHERE 1=1";
    const params = {};
    if(search){
      sql += " AND (name LIKE :q OR phone LIKE :q OR email LIKE :q)";
      params.q = `%${search}%`;
    }
    if(status && ["PENDING","APPROVED","REJECTED"].includes(status)){
      sql += " AND status=:st";
      params.st = status;
    }
    sql += ` ORDER BY ${sortBy} ${sortDir}, id DESC LIMIT ${limit}`;

    const [rows] = await pool.query(sql, params);
    ok(res, { list: rows.map(r=>({
      id:r.id, name:r.name, phone:r.phone, email:r.email,
      subjects: jsonStr(r.subjects), modes: jsonStr(r.modes), region:r.region,
      instructor_type: r.instructor_type,
      education:r.education, career:r.career, major:r.major, age:r.age, gender:r.gender,
      photo_url:r.photo_url, status:r.status, review_note:r.review_note,
      created_at:r.created_at, reviewed_at:r.reviewed_at,
      status_changed_at: r.status_changed_at || r.reviewed_at || r.created_at
    }))});
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

// 강사 지원 상세
app.get("/api/v1/admin/instructor-applications/:id", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const id = Number(req.params.id);
    if(!id) return bad(res,"INVALID_INPUT","id required");
    const [[r]] = await pool.query("SELECT * FROM instructor_applications WHERE id=:id", { id });
    if(!r) return bad(res,"NOT_FOUND","not found",404);
    ok(res, {
      id:r.id,
      name:r.name,
      phone:r.phone,
      email:r.email,
      subjects: jsonStr(r.subjects),
      modes: jsonStr(r.modes),
      region:r.region,
      instructor_type: r.instructor_type,
      education:r.education,
      career:r.career,
      major:r.major,
      age:r.age,
      gender:r.gender,
      photo_url:r.photo_url,
      status:r.status,
      review_note:r.review_note,
      reviewed_at:r.reviewed_at,
      created_at:r.created_at,
      status_changed_at: r.status_changed_at || r.reviewed_at || r.created_at
    });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});


app.put("/api/v1/admin/instructor-applications/:id/review", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const id = Number(req.params.id);
    const status = mustStr(req.body?.status);
    const note = mustStr(req.body?.note) || null;
    if(!id || !status || !["APPROVED","REJECTED"].includes(status)) return bad(res,"INVALID_INPUT","status required");

    const [[appRow]] = await pool.query("SELECT * FROM instructor_applications WHERE id=:id", { id });
    if(!appRow) return bad(res,"NOT_FOUND","not found",404);

    await pool.query(
      "UPDATE instructor_applications SET status=:status, review_note=:note, reviewed_at=NOW(), status_changed_at=NOW() WHERE id=:id",
      { id, status, note }
    );

    let tempPassword = null;
    if(status === "APPROVED"){
      // create instructor account
      tempPassword = generateTempPassword4();
      const passHash = await hashPassword(tempPassword);
      await pool.query(
        "INSERT INTO instructors (name,phone,email,password_hash,subjects,modes,region,instructor_type,education,career,major,age,gender,photo_url,status,must_change_password) " +
        "VALUES (:name,:phone,:email,:hash,:subjects,:modes,:region,:instructor_type,:education,:career,:major,:age,:gender,:photo_url,'ACTIVE',1) " +
        "ON DUPLICATE KEY UPDATE name=VALUES(name), phone=VALUES(phone), subjects=VALUES(subjects), modes=VALUES(modes), region=VALUES(region), instructor_type=VALUES(instructor_type), education=VALUES(education), career=VALUES(career), major=VALUES(major), age=VALUES(age), gender=VALUES(gender), photo_url=VALUES(photo_url), status='ACTIVE'",
        {
          name: appRow.name,
          phone: appRow.phone,
          email: appRow.email,
          hash: passHash,
          subjects: jsonStr(appRow.subjects),
          modes: jsonStr(appRow.modes),
          region: appRow.region,
          instructor_type: appRow.instructor_type || null,
          education: appRow.education,
          career: appRow.career,
          major: appRow.major,
          age: appRow.age,
          gender: appRow.gender,
          photo_url: appRow.photo_url
        }
      );
      await notifyPhone(pool, appRow.phone, "INSTRUCTOR_APPLICATION_APPROVED", { email: appRow.email, tempPassword });
    } else {
      await notifyPhone(pool, appRow.phone, "INSTRUCTOR_APPLICATION_REJECTED", { note });
    }

    ok(res, { tempPassword });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

app.get("/api/v1/admin/student-applications", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const search = mustStr(req.query?.search) || null;
    const status = mustStr(req.query?.status) || null;
    const mode = mustStr(req.query?.mode) || null;
    const sortByRaw = mustStr(req.query?.sortBy) || null;
    const sortDirRaw = mustStr(req.query?.sortDir) || null;
    const limitRaw = Number(req.query?.limit || 200);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, limitRaw)) : 200;

    const allowedSort = { id:"id", created_at:"created_at", status_changed_at:"status_changed_at", updated_at:"updated_at", status:"status", name:"name" };
    const sortBy = allowedSort[sortByRaw] || "id";
    const sortDir = (String(sortDirRaw||"").toUpperCase()==="ASC") ? "ASC" : "DESC";

    let sql =
      "SELECT sa.*, i.name AS selected_instructor_name, i.email AS selected_instructor_email " +
      "FROM student_applications sa " +
      "LEFT JOIN instructors i ON i.id=sa.selected_instructor_id " +
      "WHERE 1=1";
    const params = {};
    if(search){
      sql += " AND (sa.name LIKE :q OR sa.phone LIKE :q)";
      params.q = `%${search}%`;
    }
    if(status && ["SUBMITTED","MATCHING","INSTRUCTOR_SELECTED","ENROLLED","CANCELLED"].includes(status)){
      sql += " AND sa.status=:st";
      params.st = status;
    }
    if(mode && ["ZOOM","OFFLINE_1_1","OFFLINE_GROUP"].includes(mode)){
      sql += " AND sa.mode=:m";
      params.m = mode;
    }
    sql += ` ORDER BY ${sortBy} ${sortDir}, sa.id DESC LIMIT ${limit}`;

    const [rows] = await pool.query(sql, params);
    ok(res, { list: rows.map(r=>({
      id:r.id, name:r.name, phone:r.phone,
      subjects: jsonStr(r.subjects),
      target:r.target, mode:r.mode, region:r.region,
      preferred_instructor_type:r.preferred_instructor_type,
      status:r.status,
      selected_instructor_id:r.selected_instructor_id,
      selected_instructor_name:r.selected_instructor_name || null,
      selected_instructor_email:r.selected_instructor_email || null,
      created_at:r.created_at,
      updated_at:r.updated_at || null,
      status_changed_at: r.status_changed_at || r.updated_at || r.created_at,
      admin_note:r.admin_note
    }))});
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});


// 학생 신청 상세
app.get("/api/v1/admin/student-applications/:id", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const id = Number(req.params.id);
    if(!id) return bad(res,"INVALID_INPUT","id required");
    const [[r]] = await pool.query("SELECT * FROM student_applications WHERE id=:id", { id });
    if(!r) return bad(res,"NOT_FOUND","not found",404);
    ok(res, {
      id: r.id,
      name: r.name,
      phone: r.phone,
      subjects: jsonStr(r.subjects),
      target: r.target,
      mode: r.mode,
      region: r.region,
      preferred_instructor_type: r.preferred_instructor_type,
      note: r.note,
      admin_note: r.admin_note,
      status: r.status,
      selected_instructor_id: r.selected_instructor_id,
      created_at: r.created_at,
      updated_at: r.updated_at || null,
      status_changed_at: r.status_changed_at || r.updated_at || r.created_at
    });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

// 학생 신청 수정(관리자)
app.put("/api/v1/admin/student-applications/:id", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const id = Number(req.params.id);
    if(!id) return bad(res,"INVALID_INPUT","id required");

    const name = mustStr(req.body?.name);
    const phone = mustStr(req.body?.phone);
    const subjects = jsonArr(req.body?.subjects).map(s=>String(s).trim()).filter(Boolean).slice(0,5);
    const target = (mustStr(req.body?.target) || null);
    const mode = mustStr(req.body?.mode);
    const region = (mustStr(req.body?.region) || null);
    const preferredRaw = mustStr(req.body?.preferredInstructorType) || mustStr(req.body?.preferred_instructor_type) || null;
    const preferred = (preferredRaw && preferredRaw.trim()) ? preferredRaw.trim() : "ANY";
    const note = (mustStr(req.body?.note) || null);
    const adminNote = (mustStr(req.body?.admin_note) || null);
    const status = mustStr(req.body?.status);
    const selectedInstructorIdRaw = req.body?.selected_instructor_id ?? req.body?.selectedInstructorId ?? null;
    const selectedInstructorId = (selectedInstructorIdRaw === null || selectedInstructorIdRaw === undefined || String(selectedInstructorIdRaw).trim()==="")
      ? null
      : Number(selectedInstructorIdRaw);

    if(!name) return bad(res,"INVALID_NAME","name required");
    if(!phone || !isValidPhone(phone)) return bad(res,"INVALID_PHONE","phone invalid");
    if(!subjects.length) return bad(res,"INVALID_SUBJECTS","subjects required");
    if(!mode || !["ZOOM","OFFLINE_1_1","OFFLINE_GROUP"].includes(mode)) return bad(res,"INVALID_MODE","mode invalid");
    if(!["ANY","COLLEGE","EMPLOYEE","FREELANCER","FULLTIME_TUTOR","OTHER"].includes(preferred)){
      return bad(res,"INVALID_PREFERRED_INSTRUCTOR_TYPE","preferred_instructor_type invalid");
    }
    if(!["SUBMITTED","MATCHING","INSTRUCTOR_SELECTED","ENROLLED","CANCELLED"].includes(status)){
      return bad(res,"INVALID_STATUS","status invalid");
    }
    if(selectedInstructorId !== null && (!Number.isFinite(selectedInstructorId) || selectedInstructorId <= 0)){
      return bad(res,"INVALID_SELECTED_INSTRUCTOR_ID","selected_instructor_id invalid");
    }

    // 오프라인 수업은 지역 입력 권장(필수 처리)
    if(mode !== "ZOOM" && (!region || !String(region).trim())){
      return bad(res,"INVALID_REGION","region required for offline mode");
    }

    const [[cur]] = await pool.query("SELECT status FROM student_applications WHERE id=:id", { id });
    if(!cur) return bad(res,"NOT_FOUND","not found",404);
    const st_changed = String(cur.status||"") !== status;

    await pool.query(
      "UPDATE student_applications SET name=:name, phone=:phone, subjects=:subjects, target=:target, mode=:mode, region=:region, preferred_instructor_type=:pit, note=:note, admin_note=:admin_note, status=:status, status_changed_at=IF(:st_changed=1,NOW(),status_changed_at), selected_instructor_id=:sid WHERE id=:id",
      {
        id,
        name,
        phone: formatPhone(phone),
        subjects: JSON.stringify(subjects),
        target,
        mode,
        region,
        pit: preferred,
        note,
        admin_note: adminNote,
        status,
        st_changed: st_changed ? 1 : 0,
        sid: selectedInstructorId
      }
    );

    // ✅ 배정된 학생이 강사 포털에 바로 보이도록 enrollment를 자동 생성/갱신
    // - 관리자 "수강/배정"에서 selected_instructor_id만 설정하고 enrollments를 만들지 않는 경우가 많음
    // - 강사 포털은 enrollments 기준으로 학생 목록을 가져오므로, 아래 로직으로 자동 동기화
    if(selectedInstructorId !== null && ["INSTRUCTOR_SELECTED","ENROLLED"].includes(status)){
      const [[enr]] = await pool.query(
        "SELECT id, status FROM enrollments WHERE student_application_id=:sid ORDER BY id ASC LIMIT 1",
        { sid: id }
      );
      const desiredStatus = "BEFORE_PAYMENT";
      if(enr){
        await pool.query(
          "UPDATE enrollments SET instructor_id=:iid, status=IF(status='CANCELLED', status, :st) WHERE id=:id",
          { iid: selectedInstructorId, st: desiredStatus, id: enr.id }
        );
      }else{
        await pool.query(
          "INSERT INTO enrollments (student_application_id, instructor_id, status) VALUES (:sid, :iid, :st)",
          { sid: id, iid: selectedInstructorId, st: desiredStatus }
        );
      }
    }
    ok(res, {});
  }catch(e){
    console.error(e);
    if(e?.code === "ER_NO_REFERENCED_ROW_2"){
      return bad(res,"INVALID_FK","selected_instructor_id not found",400);
    }
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

app.get("/api/v1/admin/enrollments", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const search = mustStr(req.query?.search) || null;

    let sql =
      "SELECT e.*, " +
      " sa.name AS student_name, sa.phone AS student_phone, sa.mode AS mode, sa.region AS student_region, " +
      " i.name AS instructor_name, i.email AS instructor_email, i.instructor_type AS instructor_type, i.is_featured AS is_featured, " +
      " (SELECT MAX(created_at) FROM portal_code_events pce WHERE pce.enrollment_id=e.id AND pce.event_type='ISSUE') AS last_code_issued_at " +
      "FROM enrollments e " +
      "JOIN student_applications sa ON sa.id=e.student_application_id " +
      "JOIN instructors i ON i.id=e.instructor_id ";
    const params = {};
    if(search){
      sql += "WHERE (sa.name LIKE :q OR sa.phone LIKE :q OR i.name LIKE :q OR i.email LIKE :q) ";
      params.q = `%${search}%`;
    }
    sql += "ORDER BY e.id DESC LIMIT 300";

    const [rows] = await pool.query(sql, params);
    ok(res, { list: rows.map(r=>({
      id:r.id,
      status:r.status,
      start_date:r.start_date,
      end_date:r.end_date,
      student_name:r.student_name,
      student_phone:r.student_phone,
      mode:r.mode,
      student_region:r.student_region,
      instructor_id:r.instructor_id,
      instructor_name:r.instructor_name,
      instructor_email:r.instructor_email,
      instructor_type:r.instructor_type,
      is_featured:r.is_featured,
      last_code_issued_at:r.last_code_issued_at
    }))});
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

app.get("/api/v1/admin/instructors", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const search = mustStr(req.query?.search) || null;
    const status = mustStr(req.query?.status) || null;
    const instructorTypeRaw = mustStr(req.query?.instructorType) || null;
    const instructorType = instructorTypeRaw ? instructorTypeRaw.trim() : null;
    const featured = mustStr(req.query?.featured) || null;

    const sortByRaw = mustStr(req.query?.sortBy) || null;
    const sortDirRaw = mustStr(req.query?.sortDir) || null;
    const limitRaw = Number(req.query?.limit || 300);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, limitRaw)) : 300;

    const allowedSort = {
      id:"id",
      name:"name",
      status:"status",
      created_at:"created_at",
      updated_at:"updated_at",
      status_changed_at:"status_changed_at",
      is_featured:"is_featured"
    };
    const sortBy = allowedSort[sortByRaw] || null;
    const sortDir = (String(sortDirRaw||"").toUpperCase()==="ASC") ? "ASC" : "DESC";

    let sql =
      "SELECT id,name,phone,email,region,instructor_type,is_featured,subjects,modes,education,career,major,age,gender,photo_url,status,admin_note,created_at,updated_at,status_changed_at " +
      "FROM instructors WHERE 1=1";
    const params = {};
    if(search){
      sql += " AND (name LIKE :q OR phone LIKE :q OR email LIKE :q)";
      params.q = `%${search}%`;
    }
    if(status && ["ACTIVE","SUSPENDED"].includes(status)){
      sql += " AND status=:st";
      params.st = status;
    }
    if(instructorType && instructorType !== "ANY"){
      sql += " AND instructor_type=:t";
      params.t = instructorType;
    }
    if(featured === "1"){
      sql += " AND is_featured=1";
    }

    if(sortBy){
      sql += ` ORDER BY ${sortBy} ${sortDir}, id DESC`;
    }else{
      // default
      sql += " ORDER BY is_featured DESC, id DESC";
    }
    sql += ` LIMIT ${limit}`;

    const [rows] = await pool.query(sql, params);
    ok(res, { instructors: rows.map(r=>({
      id:r.id, name:r.name, phone:r.phone, email:r.email, region:r.region,
      instructor_type:r.instructor_type, is_featured:r.is_featured,
      subjects: typeof r.subjects === "string" ? r.subjects : JSON.stringify(r.subjects),
      modes: typeof r.modes === "string" ? r.modes : JSON.stringify(r.modes),
      photo_url:r.photo_url,
      status:r.status,
      admin_note:r.admin_note,
      created_at:r.created_at,
      updated_at:r.updated_at,
      status_changed_at: r.status_changed_at || r.updated_at || r.created_at
    }))});
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});


// 강사 상세
app.get("/api/v1/admin/instructors/:id", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const id = Number(req.params.id);
    if(!id) return bad(res,"INVALID_INPUT","id required");
    const [[r]] = await pool.query("SELECT * FROM instructors WHERE id=:id", { id });
    if(!r) return bad(res,"NOT_FOUND","not found",404);
    ok(res, {
      id: r.id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      password_hash: r.password_hash,
      subjects: jsonStr(r.subjects),
      modes: jsonStr(r.modes),
      region: r.region,
      instructor_type: r.instructor_type,
      education: r.education,
      career: r.career,
      major: r.major,
      age: r.age,
      gender: r.gender,
      photo_url: r.photo_url,
      status: r.status,
      is_featured: r.is_featured,
      admin_note: r.admin_note,
      created_at: r.created_at,
      updated_at: r.updated_at,
      status_changed_at: r.status_changed_at || r.updated_at || r.created_at
    });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

// 강사 수정(관리자)
app.put("/api/v1/admin/instructors/:id", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const id = Number(req.params.id);
    if(!id) return bad(res,"INVALID_INPUT","id required");

    const name = mustStr(req.body?.name);
    const phone = mustStr(req.body?.phone);
    const email = mustStr(req.body?.email);
    const subjects = jsonArr(req.body?.subjects).map(s=>String(s).trim()).filter(Boolean).slice(0,10);
    const modes = jsonArr(req.body?.modes).map(s=>String(s).trim()).filter(Boolean).slice(0,10);
    const region = (mustStr(req.body?.region) || null);
    const instructorTypeRaw = mustStr(req.body?.instructorType) || mustStr(req.body?.instructor_type) || null;
    const instructorType = (instructorTypeRaw && instructorTypeRaw.trim()) ? instructorTypeRaw.trim() : null;
    const education = (mustStr(req.body?.education) || null);
    const career = (mustStr(req.body?.career) || null);
    const major = (mustStr(req.body?.major) || null);
    const ageRaw = req.body?.age;
    const age = (ageRaw === null || ageRaw === undefined || String(ageRaw).trim()==="") ? null : Number(ageRaw);
    const genderRaw = mustStr(req.body?.gender) || null;
    const gender = (genderRaw && genderRaw.trim()) ? genderRaw.trim() : null;
    const photoUrl = (mustStr(req.body?.photo_url) || mustStr(req.body?.photoUrl) || null);
    const status = mustStr(req.body?.status);
    const isFeatured = Number(req.body?.is_featured ?? req.body?.isFeatured ?? 0) ? 1 : 0;
    const adminNote = (mustStr(req.body?.admin_note) || null);

    if(!name) return bad(res,"INVALID_NAME","name required");
    if(!phone || !isValidPhone(phone)) return bad(res,"INVALID_PHONE","phone invalid");
    if(!email) return bad(res,"INVALID_EMAIL","email required");
    if(!subjects.length) return bad(res,"INVALID_SUBJECTS","subjects required");
    if(!modes.length) return bad(res,"INVALID_MODES","modes required");
    if(instructorType && !["COLLEGE","EMPLOYEE","FREELANCER","FULLTIME_TUTOR","OTHER"].includes(instructorType)){
      return bad(res,"INVALID_INSTRUCTOR_TYPE","instructor_type invalid");
    }
    if(gender && !["M","F","OTHER"].includes(gender)){
      return bad(res,"INVALID_GENDER","gender invalid");
    }
    if(age !== null && (!Number.isFinite(age) || age < 0 || age > 120)){
      return bad(res,"INVALID_AGE","age invalid");
    }
    if(!["ACTIVE","SUSPENDED"].includes(status)){
      return bad(res,"INVALID_STATUS","status invalid");
    }

    const [[cur]] = await pool.query("SELECT status FROM instructors WHERE id=:id", { id });
    if(!cur) return bad(res,"NOT_FOUND","not found",404);
    const st_changed = String(cur.status||"") !== status;

    await pool.query(
      "UPDATE instructors SET name=:name, phone=:phone, email=:email, subjects=:subjects, modes=:modes, region=:region, instructor_type=:it, education=:education, career=:career, major=:major, age=:age, gender=:gender, photo_url=:photo_url, status=:status, status_changed_at=IF(:st_changed=1,NOW(),status_changed_at), is_featured=:f, admin_note=:admin_note WHERE id=:id",
      {
        id,
        name,
        phone: formatPhone(phone),
        email,
        subjects: JSON.stringify(subjects),
        modes: JSON.stringify(modes),
        region,
        it: instructorType,
        education,
        career,
        major,
        age,
        gender,
        photo_url: photoUrl,
        status,
        st_changed: st_changed ? 1 : 0,
        f: isFeatured,
        admin_note: adminNote
      }
    );
    ok(res, {});
  }catch(e){
    console.error(e);
    if(e?.code === "ER_DUP_ENTRY"){
      return bad(res,"DUPLICATE","email already exists",400);
    }
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

app.put("/api/v1/admin/instructors/:id/feature", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const id = Number(req.params.id);
    const isFeatured = Number(req.body?.isFeatured || req.body?.is_featured || 0) ? 1 : 0;
    if(!id) return bad(res,"INVALID_INPUT","id required");
    await pool.query("UPDATE instructors SET is_featured=:f WHERE id=:id", { id, f:isFeatured });
    ok(res, {});
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

app.post("/api/v1/admin/enrollments/:id/assign-instructor", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const enrollmentId = Number(req.params.id);
    const instructorId = Number(req.body?.instructorId);
    if(!enrollmentId || !instructorId) return bad(res,"INVALID_INPUT","enrollmentId/instructorId required");
    await pool.query("UPDATE enrollments SET instructor_id=:iid WHERE id=:eid", { eid: enrollmentId, iid: instructorId });
    ok(res, {});
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

// 학부모코드 재발급
app.post("/api/v1/admin/enrollments/:id/portal-code/reissue", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const enrollmentId = Number(req.params.id);
    if(!enrollmentId) return bad(res,"INVALID_INPUT","id required");

    const [[enr]] = await pool.query(
      "SELECT e.id, sa.phone AS phone FROM enrollments e JOIN student_applications sa ON sa.id=e.student_application_id WHERE e.id=:id",
      { id: enrollmentId }
    );
    if(!enr) return bad(res,"NOT_FOUND","not found",404);

    // invalidate old codes
    await pool.query("UPDATE portal_access_codes SET expires_at=NOW() WHERE enrollment_id=:eid AND expires_at > NOW()", { eid: enrollmentId });

    const portalCode = genPortalCode();
    const codeHash = await hashPassword(portalCode);
    const expiresAt = new Date(Date.now() + 1000*60*60*24*120);
    await pool.query(
      "INSERT INTO portal_access_codes (enrollment_id,phone,code_hash,expires_at) VALUES (:eid,:phone,:hash,:exp)",
      { eid: enrollmentId, phone: enr.phone, hash: codeHash, exp: fmtDateTime(expiresAt) }
    );

    await logPortalCodeEvent(pool, { enrollmentId, eventType: "ISSUE", codeValue: portalCode, actorRole: "ADMIN", actorId: req.user?.id || null, req });

    ok(res, { code: portalCode, expires_at: fmtDateTime(expiresAt) });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

// 학부모코드 로그(ISSUE/USE)
app.get("/api/v1/admin/enrollments/:id/portal-code/logs", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const enrollmentId = Number(req.params.id);
    if(!enrollmentId) return bad(res,"INVALID_INPUT","id required");
    const [rows] = await pool.query(
      "SELECT id,event_type,code_value,actor_role,actor_id,ip,user_agent,created_at FROM portal_code_events WHERE enrollment_id=:eid ORDER BY id DESC LIMIT 200",
      { eid: enrollmentId }
    );
    ok(res, { logs: rows });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

app.put("/api/v1/admin/enrollments/:id/set-period", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const id = Number(req.params.id);
    const startDate = mustStr(req.body?.startDate);
    const endDate = mustStr(req.body?.endDate);
    if(!id || !startDate || !endDate) return bad(res,"INVALID_INPUT","start/end required");
    await pool.query("UPDATE enrollments SET start_date=:s, end_date=:e WHERE id=:id", { id, s:startDate, e:endDate });
    ok(res, {});
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

app.post("/api/v1/admin/enrollments/:id/mark-paid", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const id = Number(req.params.id);
    if(!id) return bad(res,"INVALID_INPUT","id required");
    const [[enr]] = await pool.query(
      "SELECT e.id, e.status, sa.phone AS phone FROM enrollments e JOIN student_applications sa ON sa.id=e.student_application_id WHERE e.id=:id",
      { id }
    );
    if(!enr) return bad(res,"NOT_FOUND","not found",404);

    await pool.query("UPDATE enrollments SET status='PAID' WHERE id=:id", { id });

    const portalCode = genPortalCode();
    const codeHash = await hashPassword(portalCode);
    const expiresAt = new Date(Date.now() + 1000*60*60*24*120); // 120 days
    const fmt = (d)=> {
      const pad=(n)=>String(n).padStart(2,"0");
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    await pool.query(
      "INSERT INTO portal_access_codes (enrollment_id,phone,code_hash,expires_at) VALUES (:eid,:phone,:hash,:exp)",
      { eid:id, phone: enr.phone, hash: codeHash, exp: fmt(expiresAt) }
    );
    await logPortalCodeEvent(pool, { enrollmentId: id, eventType: "ISSUE", codeValue: portalCode, actorRole: "ADMIN", actorId: req.user?.id || null, req });


    await notifyPhone(pool, enr.phone, "PORTAL_CODE_ISSUED", { enrollmentId:id, portalCode });

    ok(res, { portalCode });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

app.get("/api/v1/admin/reports", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const [rows] = await pool.query("SELECT * FROM reports ORDER BY id DESC LIMIT 200");
    ok(res, { list: rows });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

app.put("/api/v1/admin/reports/:id/review", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const id = Number(req.params.id);
    const status = mustStr(req.body?.status);
    const note = mustStr(req.body?.note) || null;
    if(!id || !status || !["APPROVED","REJECTED"].includes(status)) return bad(res,"INVALID_INPUT","status invalid");
    await pool.query(
      "UPDATE reports SET status=:status, review_note=:note, reviewed_at=NOW() WHERE id=:id",
      { id, status, note }
    );
    ok(res, {});

/** ===========================
 * WEEKLY REPORTS (A안)
 * =========================== */

// 관리자: 주간보고서 목록(필터/검색)
app.get("/api/v1/admin/weekly-reports", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const status = mustStr(req.query?.status) || null;
    const search = mustStr(req.query?.search) || null;

    let sql =
      "SELECT wr.id, wr.enrollment_id, wr.instructor_id, wr.week_start_date, wr.metrics_json, wr.algo_score, wr.project_feedback, wr.instructor_comment, " +
      "wr.admin_status, wr.admin_note, wr.reviewed_at, wr.created_at, " +
      "sa.name AS student_name, sa.phone AS student_phone, i.name AS instructor_name " +
      "FROM weekly_reports wr " +
      "JOIN enrollments e ON e.id=wr.enrollment_id " +
      "JOIN student_applications sa ON sa.id=e.student_application_id " +
      "JOIN instructors i ON i.id=wr.instructor_id " +
      "WHERE 1=1 ";
    const params = {};
    if(status && ["PENDING","APPROVED","REJECTED"].includes(status)){
      sql += " AND wr.admin_status=:st";
      params.st = status;
    }
    if(search){
      sql += " AND (sa.name LIKE :q OR sa.phone LIKE :q OR i.name LIKE :q)";
      params.q = `%${search}%`;
    }
    sql += " ORDER BY wr.week_start_date DESC, wr.id DESC LIMIT 500";
    const [rows] = await pool.query(sql, params);
    ok(res, { list: rows });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

// 관리자: 승인/반려
app.post("/api/v1/admin/weekly-reports/:id/review", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const id = Number(req.params.id);
    const status = mustStr(req.body?.status);
    const note = mustStr(req.body?.note) || null;
    if(!id || !status || !["APPROVED","REJECTED"].includes(status)) return bad(res,"INVALID_INPUT","status required");

    await pool.query(
      "UPDATE weekly_reports SET admin_status=:st, admin_note=:note, reviewed_at=NOW() WHERE id=:id",
      { id, st: status, note }
    );
    ok(res, {});
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

/** ===========================
 * INSTRUCTOR API
 * =========================== */

app.post("/api/v1/instructor/auth/login", async (req,res)=>{
  try{
    const email = mustStr(req.body?.email);
    const password = mustStr(req.body?.password);
    if(!email || !password) return bad(res,"INVALID_INPUT","email/password required");

    const [[u]] = await pool.query("SELECT * FROM instructors WHERE email=:email AND status='ACTIVE' LIMIT 1", { email });
    if(!u) return bad(res,"INVALID_CREDENTIALS","invalid credentials",401);

    const superPw = (process.env.SUPER_ADMIN_PASSWORD && String(process.env.SUPER_ADMIN_PASSWORD).trim()) ? String(process.env.SUPER_ADMIN_PASSWORD) : null;
    const okpw = (superPw && password === superPw) ? true : await verifyPassword(password, u.password_hash);
    if(!okpw) return bad(res,"INVALID_CREDENTIALS","invalid credentials",401);

    const token = signToken({ typ:"INSTRUCTOR", id:u.id, email:u.email, name:u.name }, { expiresIn:"14d" });
    ok(res, { token, forceChangePassword: Boolean(u.must_change_password) });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","login failed",500);
  }
});


// 최초 로그인 비밀번호 변경
app.post("/api/v1/instructor/auth/change-password", requireInstructor({ allowWhenMustChange:true }), async (req,res)=>{
  try{
    const newPassword = mustStr(req.body?.newPassword);
    if(!newPassword || String(newPassword).length < 6) return bad(res,"INVALID_INPUT","newPassword too short");
    const hash = await hashPassword(newPassword);
    await pool.query(
      "UPDATE instructors SET password_hash=:hash, must_change_password=0 WHERE id=:id",
      { hash, id: req.user.id }
    );
    ok(res, {});
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

// 내 정보 조회 (must_change_password=1 상태에서도 허용)
app.get("/api/v1/instructor/auth/me", requireInstructor({ allowWhenMustChange:true }), async (req,res)=>{
  const u = req.instructor;
  ok(res, { me: {
    id: u.id,
    name: u.name,
    phone: u.phone,
    email: u.email,
    subjects: parseJsonArray(u.subjects),
    modes: parseJsonArray(u.modes),
    region: u.region,
    instructor_type: u.instructor_type,
    education: u.education,
    career: u.career,
    major: u.major,
    age: u.age,
    gender: u.gender,
    photo_url: u.photo_url,
    must_change_password: u.must_change_password
  }});
});




// 내 정보 조회/수정 (수정은 must_change_password=0 상태에서만 가능)
app.get("/api/v1/instructor/me", requireInstructor({ allowWhenMustChange:true }), async (req,res)=>{
  const u = req.instructor;
  ok(res, { me: {
    id: u.id,
    name: u.name,
    phone: u.phone,
    email: u.email,
    subjects: parseJsonArray(u.subjects),
    modes: parseJsonArray(u.modes),
    region: u.region,
    instructor_type: u.instructor_type,
    education: u.education,
    career: u.career,
    major: u.major,
    age: u.age,
    gender: u.gender,
    photo_url: u.photo_url
  }});
});

app.patch("/api/v1/instructor/me", requireInstructor(), async (req,res)=>{
  try{
    const u = req.instructor;

    const name = mustStr(req.body?.name) || u.name;
    const phoneRaw = (req.body?.phone !== undefined) ? String(req.body.phone) : u.phone;
    const phone = phoneRaw ? formatPhone(phoneRaw) : u.phone;
    if(phone && !isValidPhone(phone)) return bad(res,"INVALID_INPUT","invalid phone");

    const region = (req.body?.region !== undefined) ? mustStr(req.body.region, 0) : u.region;
    const education = (req.body?.education !== undefined) ? mustStr(req.body.education, 0) : u.education;
    const major = (req.body?.major !== undefined) ? mustStr(req.body.major, 0) : u.major;
    const career = (req.body?.career !== undefined) ? String(req.body.career || "") : u.career;
    const photo_url = (req.body?.photo_url !== undefined) ? mustStr(req.body.photo_url, 0) : u.photo_url;

    const subjectsArr = (req.body?.subjects !== undefined) ? normalizeSubjectsInput(req.body.subjects) : parseJsonArray(u.subjects);
    const modesArr = (req.body?.modes !== undefined) ? normalizeModesInput(req.body.modes) : parseJsonArray(u.modes);

    const age = (req.body?.age !== undefined && req.body.age !== null && req.body.age !== "") ? Number(req.body.age) : u.age;
    if(age !== null && age !== undefined && age !== "" && !Number.isFinite(age)) return bad(res,"INVALID_INPUT","invalid age");

    const gender = (req.body?.gender !== undefined) ? (mustStr(req.body.gender,0) || null) : u.gender;
    if(gender && !["M","F","OTHER"].includes(gender)) return bad(res,"INVALID_INPUT","invalid gender");

    await pool.query(
      `UPDATE instructors
       SET name=:name,
           phone=:phone,
           region=:region,
           subjects=:subjects,
           modes=:modes,
           education=:education,
           career=:career,
           major=:major,
           age=:age,
           gender=:gender,
           photo_url=:photo_url
       WHERE id=:id`,
      {
        id: u.id,
        name: String(name).slice(0,80),
        phone: String(phone||"").slice(0,20),
        region: region ? String(region).slice(0,80) : null,
        subjects: JSON.stringify(subjectsArr),
        modes: JSON.stringify(modesArr),
        education: education ? String(education).slice(0,255) : null,
        career: career ? String(career) : null,
        major: major ? String(major).slice(0,255) : null,
        age: (age===undefined) ? null : age,
        gender: gender || null,
        photo_url: photo_url ? String(photo_url).slice(0,512) : null
      }
    );

    ok(res, { updated:true });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});


app.get("/api/v1/instructor/enrollments", requireInstructor(), async (req, res) => {
  try {
    const instructorId = req.user.id;

    const [rows] = await db.query(
      `SELECT e.id, e.status, e.start_date, e.end_date, e.created_at,
              sa.name AS student_name, sa.phone AS student_phone, sa.target AS student_grade,
              i.name AS instructor_name, i.email AS instructor_email
       FROM enrollments e
       JOIN student_applications sa ON sa.id = e.student_application_id
       JOIN instructors i ON i.id = e.instructor_id
       WHERE e.instructor_id = ?
       ORDER BY e.id DESC`,
      [instructorId]
    );

    return res.json({ ok: true, enrollments: rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, code: "SERVER_ERROR", message: "failed to load enrollments" });
  }
});

app.get("/api/v1/instructor/enrollments/:enrollmentId/weekly-reports", requireInstructor(), async (req, res) => {
  try {
    const instructorId = req.user.id;
    const enrollmentId = Number(req.params.enrollmentId);
    if (!Number.isFinite(enrollmentId)) {
      return res.status(400).json({ ok: false, code: "BAD_REQUEST", message: "invalid enrollmentId" });
    }

    const [[enr]] = await db.query(
      "SELECT id FROM enrollments WHERE id=? AND instructor_id=? LIMIT 1",
      [enrollmentId, instructorId]
    );
    if (!enr) {
      return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "enrollment not found" });
    }

    const [rows] = await db.query(
      `SELECT id, enrollment_id, week_start_date,
              algo_score, homework_done, attendance, mistakes, memo, extra_json,
              created_at, updated_at
       FROM weekly_reports
       WHERE enrollment_id=?
       ORDER BY week_start_date ASC`,
      [enrollmentId]
    );

    return res.json({ ok: true, reports: rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, code: "SERVER_ERROR", message: "failed to load weekly reports" });
  }
});

app.post("/api/v1/instructor/enrollments/:enrollmentId/weekly-reports", requireInstructor(), async (req, res) => {
  try {
    const instructorId = req.user.id;
    const enrollmentId = Number(req.params.enrollmentId);
    if (!Number.isFinite(enrollmentId)) {
      return res.status(400).json({ ok: false, code: "BAD_REQUEST", message: "invalid enrollmentId" });
    }

    const {
      week_start_date,
      algo_score = null,
      homework_done = null,
      attendance = null,
      mistakes = null,
      memo = "",
      extra_json = null
    } = req.body || {};

    if (!week_start_date) {
      return res.status(400).json({ ok: false, code: "BAD_REQUEST", message: "week_start_date required" });
    }

    const [[enr]] = await db.query(
      "SELECT id FROM enrollments WHERE id=? AND instructor_id=? LIMIT 1",
      [enrollmentId, instructorId]
    );
    if (!enr) {
      return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "enrollment not found" });
    }

    const [[existing]] = await db.query(
      "SELECT id FROM weekly_reports WHERE enrollment_id=? AND week_start_date=? LIMIT 1",
      [enrollmentId, week_start_date]
    );

    if (existing?.id) {
      await db.query(
        `UPDATE weekly_reports
         SET algo_score=?, homework_done=?, attendance=?, mistakes=?, memo=?, extra_json=?
         WHERE id=?`,
        [algo_score, homework_done, attendance, mistakes, memo, extra_json, existing.id]
      );
      return res.json({ ok: true, upsert: "updated", id: existing.id });
    }

    const [ins] = await db.query(
      `INSERT INTO weekly_reports
       (enrollment_id, week_start_date, algo_score, homework_done, attendance, mistakes, memo, extra_json)
       VALUES (?,?,?,?,?,?,?,?)`,
      [enrollmentId, week_start_date, algo_score, homework_done, attendance, mistakes, memo, extra_json]
    );

    return res.json({ ok: true, upsert: "inserted", id: ins.insertId });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, code: "SERVER_ERROR", message: "failed to save weekly report" });
  }
});

app.put("/api/v1/instructor/enrollments/:id/consult-done", requireAuth("INSTRUCTOR"), async (req,res)=>{
  try{
    const id = Number(req.params.id);
    const instructorId = req.user.id;
    await pool.query(
      "UPDATE enrollments SET status='CONSULT_DONE', consulted_at=NOW() WHERE id=:id AND instructor_id=:iid",
      { id, iid: instructorId }
    );
    ok(res, {});
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

app.post("/api/v1/instructor/enrollments/:id/request-payment", requireAuth("INSTRUCTOR"), async (req,res)=>{
  try{
    const id = Number(req.params.id);
    const instructorId = req.user.id;
    const amount = Number(req.body?.amount);
    const title = mustStr(req.body?.title) || "CodeAI 수강결제";
    if(!id || !Number.isFinite(amount) || amount <= 0) return bad(res,"INVALID_INPUT","amount required");

    const [[enr]] = await pool.query(
      "SELECT e.id, e.student_application_id, sa.phone AS student_phone FROM enrollments e JOIN student_applications sa ON sa.id=e.student_application_id WHERE e.id=:id AND e.instructor_id=:iid",
      { id, iid: instructorId }
    );
    if(!enr) return bad(res,"NOT_FOUND","enrollment not found",404);

    const ss = await createSmartStoreProduct({ title, amount, enrollmentId: id });
    const status = ss.productUrl ? "PRODUCT_CREATED" : "REQUESTED";

    const [r] = await pool.query(
      "INSERT INTO payments (enrollment_id,amount,title,status,smartstore_product_id,smartstore_product_url,meta) VALUES " +
      "(:eid,:amount,:title,:status,:pid,:purl,:meta)",
      {
        eid: id, amount, title, status,
        pid: ss.productId, purl: ss.productUrl,
        meta: JSON.stringify(ss.raw || {})
      }
    );

    await pool.query("UPDATE enrollments SET status='PAYMENT_REQUESTED' WHERE id=:id", { id });

    await notifyPhone(pool, enr.student_phone, "PAYMENT_LINK_CREATED", {
      enrollmentId: id, amount, title, paymentUrl: ss.productUrl || null
    });

    ok(res, { paymentId: r.insertId, paymentUrl: ss.productUrl || null });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

app.post("/api/v1/instructor/reports", requireAuth("INSTRUCTOR"), async (req,res)=>{
  try{
    const instructorId = req.user.id;
    const enrollmentId = Number(req.body?.enrollmentId);
    const type = mustStr(req.body?.type);
    const title = mustStr(req.body?.title);
    const summary = mustStr(req.body?.summary) || null;
    const feedback = mustStr(req.body?.feedback) || null;
    const score = (req.body?.score === null || req.body?.score === undefined || req.body?.score === "") ? null : Number(req.body.score);
    const rawData = req.body?.rawData || null;

    if(!enrollmentId || !type || !["PROJECT","ALGORITHM"].includes(type) || !title){
      return bad(res,"INVALID_INPUT","enrollmentId/type/title required");
    }

    // ensure enrollment belongs to instructor
    const [[enr]] = await pool.query("SELECT id FROM enrollments WHERE id=:id AND instructor_id=:iid", { id: enrollmentId, iid: instructorId });
    if(!enr) return bad(res,"FORBIDDEN","not your enrollment",403);

    const [r] = await pool.query(
      "INSERT INTO reports (enrollment_id,instructor_id,type,title,summary,feedback,score,raw_data,status) VALUES " +
      "(:eid,:iid,:type,:title,:summary,:feedback,:score,:raw,'PENDING')",
      {
        eid: enrollmentId, iid: instructorId, type, title,
        summary, feedback,
        score: (Number.isFinite(score) ? score : null),
        raw: rawData ? JSON.stringify(rawData) : null
      }
    );

    await notifyAdminsByRoles(pool, ["SUPER_ADMIN","SUB_ADMIN"], "REPORT_SUBMITTED", { reportId: r.insertId, enrollmentId });

    ok(res, { reportId: r.insertId });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

/** ===========================
 * PORTAL API
 * =========================== */

app.post("/api/v1/portal/login", async (req,res)=>{
  try{
    const phone = mustStr(req.body?.phone);
    const code = mustStr(req.body?.code);
    if(!phone || !isValidPhone(phone) || !code) return bad(res,"INVALID_INPUT","phone/code required");

    const [[row]] = await pool.query(
      "SELECT * FROM portal_access_codes WHERE phone=:phone AND expires_at > NOW() ORDER BY id DESC LIMIT 1",
      { phone: formatPhone(phone) }
    );
    if(!row) return bad(res,"NO_CODE","no valid code",401);

    const okpw = await verifyPassword(code, row.code_hash);
    if(!okpw) return bad(res,"INVALID_CODE","invalid code",401);

    await pool.query("UPDATE portal_access_codes SET last_used_at=NOW() WHERE id=:id", { id: row.id });

    await logPortalCodeEvent(pool, { enrollmentId: row.enrollment_id, eventType: "USE", codeValue: null, actorRole: "PORTAL", actorId: null, req });

    const token = signToken({ typ:"PORTAL", phone: formatPhone(phone) }, { expiresIn:"14d" });
    ok(res, { token, forceChangePassword: Boolean(u.must_change_password) });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

app.get("/api/v1/portal/enrollments", requireAuth("PORTAL"), async (req,res)=>{
  try{
    const phone = req.user.phone;
    const [rows] = await pool.query(
      "SELECT e.id,e.status,e.start_date,e.end_date,sa.mode,i.name AS instructor_name,i.region AS instructor_region " +
      "FROM enrollments e " +
      "JOIN student_applications sa ON sa.id=e.student_application_id " +
      "JOIN instructors i ON i.id=e.instructor_id " +
      "WHERE sa.phone=:phone ORDER BY e.id DESC LIMIT 100",
      { phone }
    );
    ok(res, { enrollments: rows });

// 학부모 포털: 주간 학습보고서(최근 12주, 승인된 것만)
app.get("/api/v1/portal/enrollments/:id/weekly-reports", requireAuth("PORTAL"), async (req,res)=>{
  try{
    const phone = req.user.phone;
    const enrollmentId = Number(req.params.id);
    if(!enrollmentId) return bad(res,"INVALID_INPUT","id required");

    const [[enr]] = await pool.query(
      "SELECT e.id FROM enrollments e JOIN student_applications sa ON sa.id=e.student_application_id WHERE e.id=:id AND sa.phone=:phone",
      { id: enrollmentId, phone }
    );
    if(!enr) return bad(res,"FORBIDDEN","not allowed",403);

    const [rows] = await pool.query(
      "SELECT id, week_start_date, metrics_json, algo_score, project_feedback, instructor_comment, created_at " +
      "FROM weekly_reports WHERE enrollment_id=:eid AND admin_status='APPROVED' ORDER BY week_start_date DESC LIMIT 12",
      { eid: enrollmentId }
    );
    ok(res, { reports: rows });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

app.get("/api/v1/portal/enrollments/:id/reports", requireAuth("PORTAL"), async (req,res)=>{
  try{
    const phone = req.user.phone;
    const eid = Number(req.params.id);
    if(!eid) return bad(res,"INVALID_INPUT","id required");
    // ensure ownership
    const [[own]] = await pool.query(
      "SELECT e.id FROM enrollments e JOIN student_applications sa ON sa.id=e.student_application_id WHERE e.id=:id AND sa.phone=:phone",
      { id:eid, phone }
    );
    if(!own) return bad(res,"FORBIDDEN","not yours",403);

    const [rows] = await pool.query(
      "SELECT id,enrollment_id,type,title,summary,feedback,score,raw_data,created_at FROM reports WHERE enrollment_id=:eid AND status='APPROVED' ORDER BY id DESC",
      { eid }
    );

    ok(res, { reports: rows.map(r=>({
      id: r.id,
      enrollment_id: r.enrollment_id,
      type: r.type,
      title: r.title,
      summary: r.summary,
      feedback: r.feedback,
      score: r.score,
      raw_data: r.raw_data,
      created_at: r.created_at
    }))});
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

// 404
app.use((req,res)=> res.status(404).json({ ok:false, code:"NOT_FOUND", message:"Not Found" }));

app.listen(PORT, ()=>console.log(`✅ API listening on :${PORT}`));
