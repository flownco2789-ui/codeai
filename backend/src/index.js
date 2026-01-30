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

app.use(express.json({ limit: "1mb" }));

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
function ok(res, payload){ return res.json(Object.assign({ ok: true }, payload || {})); }
function bad(res, code, message, status=400){ return res.status(status).json({ ok:false, code, message }); }

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

    if(!name) return bad(res,"INVALID_NAME","name required");
    if(!phone || !isValidPhone(phone)) return bad(res,"INVALID_PHONE","phone invalid");
    if(!subjects.length) return bad(res,"INVALID_SUBJECTS","subjects required");
    if(!mode || !["ZOOM","OFFLINE_1_1","OFFLINE_GROUP"].includes(mode)) return bad(res,"INVALID_MODE","mode invalid");

    const meta = pickMeta(req);
    const [r] = await pool.query(
      "INSERT INTO student_applications (name,phone,subjects,target,mode,region,note,status) VALUES (:name,:phone,:subjects,:target,:mode,:region,:note,'SUBMITTED')",
      { name, phone: formatPhone(phone), subjects: JSON.stringify(subjects), target, mode, region, note }
    );
    const id = r.insertId;

    // Admin notify logs
    await notifyAdminsByRoles(pool, ["SUPER_ADMIN","SUB_ADMIN","STUDENT_ADMIN"], "STUDENT_APPLICATION_CREATED", {
      id, name, phone: formatPhone(phone), subjects, target, mode, region
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

    let sql = "SELECT id,name,subjects,modes,region,education,career,major,age,gender,photo_url FROM instructors WHERE status='ACTIVE'";
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
    sql += " ORDER BY id DESC LIMIT 50";

    const [rows] = await pool.query(sql, params);
    ok(res, { instructors: rows.map(r=>({
      id: r.id,
      name: r.name,
      subjects: typeof r.subjects === "string" ? r.subjects : JSON.stringify(r.subjects),
      modes: typeof r.modes === "string" ? r.modes : JSON.stringify(r.modes),
      region: r.region,
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
      "UPDATE student_applications SET status='INSTRUCTOR_SELECTED', selected_instructor_id=:iid WHERE id=:id",
      { id: appId, iid: instructorId }
    );

    const [r] = await pool.query(
      "INSERT INTO enrollments (student_application_id,instructor_id,status) VALUES (:sid,:iid,'BEFORE_PAYMENT')",
      { sid: appId, iid: instructorId }
    );
    const enrollmentId = r.insertId;

    await pool.query("UPDATE student_applications SET status='ENROLLED' WHERE id=:id", { id: appId });

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

    if(!name) return bad(res,"INVALID_NAME","name required");
    if(!phone || !isValidPhone(phone)) return bad(res,"INVALID_PHONE","phone invalid");
    if(!email) return bad(res,"INVALID_EMAIL","email required");
    if(!subjects.length) return bad(res,"INVALID_SUBJECTS","subjects required");
    if(!modes.length) return bad(res,"INVALID_MODES","modes required");

    let photo_url = null;
    if(req.file){
      const base = API_PUBLIC_BASE || (req.protocol + "://" + req.get("host"));
      photo_url = base.replace(/\/+$/g,"") + "/uploads/" + req.file.filename;
    }

    const [r] = await pool.query(
      "INSERT INTO instructor_applications (name,phone,email,subjects,modes,region,education,career,major,age,gender,photo_url,status) " +
      "VALUES (:name,:phone,:email,:subjects,:modes,:region,:education,:career,:major,:age,:gender,:photo_url,'PENDING')",
      {
        name,
        phone: formatPhone(phone),
        email,
        subjects: JSON.stringify(subjects),
        modes: JSON.stringify(modes),
        region, education, career, major,
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
      "INSERT INTO student_applications (name,phone,subjects,target,mode,region,note,status) VALUES (:name,:phone,:subjects,:target,:mode,:region,:note,'SUBMITTED')",
      { name, phone: formatPhone(phone), subjects: JSON.stringify(subjects), target, mode, region, note }
    );
    const id = r.insertId;

    await notifyAdminsByRoles(pool, ["SUPER_ADMIN","SUB_ADMIN","STUDENT_ADMIN"], "STUDENT_APPLICATION_CREATED", {
      id, name, phone: formatPhone(phone), subjects, target, mode, region
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
    const okpw = await verifyPassword(password, u.password_hash);
    if(!okpw) return bad(res,"INVALID_CREDENTIALS","invalid credentials",401);
    const token = signToken({ typ:"ADMIN", id:u.id, role:u.role, email:u.email }, { expiresIn:"7d" });
    ok(res, { token, role: u.role });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","login failed",500);
  }
});

app.get("/api/v1/admin/instructor-applications", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const [rows] = await pool.query("SELECT * FROM instructor_applications ORDER BY id DESC LIMIT 200");
    ok(res, { list: rows.map(r=>({
      id:r.id, name:r.name, phone:r.phone, email:r.email,
      subjects: jsonStr(r.subjects), modes: jsonStr(r.modes), region:r.region,
      education:r.education, career:r.career, major:r.major, age:r.age, gender:r.gender,
      photo_url:r.photo_url, status:r.status, review_note:r.review_note, created_at:r.created_at
    }))});
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
      "UPDATE instructor_applications SET status=:status, review_note=:note, reviewed_at=NOW() WHERE id=:id",
      { id, status, note }
    );

    let tempPassword = null;
    if(status === "APPROVED"){
      // create instructor account
      tempPassword = crypto.randomBytes(5).toString("base64").replace(/[^a-zA-Z0-9]/g,"").slice(0,10) + "!";
      const passHash = await hashPassword(tempPassword);
      await pool.query(
        "INSERT INTO instructors (name,phone,email,password_hash,subjects,modes,region,education,career,major,age,gender,photo_url,status) " +
        "VALUES (:name,:phone,:email,:hash,:subjects,:modes,:region,:education,:career,:major,:age,:gender,:photo_url,'ACTIVE') " +
        "ON DUPLICATE KEY UPDATE name=VALUES(name), phone=VALUES(phone), subjects=VALUES(subjects), modes=VALUES(modes), region=VALUES(region), education=VALUES(education), career=VALUES(career), major=VALUES(major), age=VALUES(age), gender=VALUES(gender), photo_url=VALUES(photo_url), status='ACTIVE'",
        {
          name: appRow.name,
          phone: appRow.phone,
          email: appRow.email,
          hash: passHash,
          subjects: jsonStr(appRow.subjects),
          modes: jsonStr(appRow.modes),
          region: appRow.region,
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
    const [rows] = await pool.query("SELECT * FROM student_applications ORDER BY id DESC LIMIT 200");
    ok(res, { list: rows.map(r=>({
      id:r.id, name:r.name, phone:r.phone,
      subjects: jsonStr(r.subjects), target:r.target, mode:r.mode, region:r.region, status:r.status,
      selected_instructor_id:r.selected_instructor_id, created_at:r.created_at
    }))});
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
  }
});

app.get("/api/v1/admin/enrollments", requireAuth("ADMIN"), async (req,res)=>{
  try{
    const [rows] = await pool.query(
      "SELECT e.*, sa.name AS student_name, sa.phone AS student_phone, i.name AS instructor_name, i.email AS instructor_email " +
      "FROM enrollments e " +
      "JOIN student_applications sa ON sa.id=e.student_application_id " +
      "JOIN instructors i ON i.id=e.instructor_id " +
      "ORDER BY e.id DESC LIMIT 200"
    );
    ok(res, { list: rows.map(r=>({
      id:r.id,
      status:r.status,
      start_date:r.start_date,
      end_date:r.end_date,
      student_name:r.student_name,
      student_phone:r.student_phone,
      instructor_name:r.instructor_name,
      instructor_email:r.instructor_email
    }))});
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

    const portalCode = String(Math.floor(100000 + Math.random()*900000));
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
    const [[u]] = await pool.query("SELECT * FROM instructors WHERE email=:email AND status='ACTIVE'", { email });
    if(!u) return bad(res,"INVALID_CREDENTIALS","invalid credentials",401);
    const okpw = await verifyPassword(password, u.password_hash);
    if(!okpw) return bad(res,"INVALID_CREDENTIALS","invalid credentials",401);
    const token = signToken({ typ:"INSTRUCTOR", id:u.id, email:u.email, name:u.name }, { expiresIn:"14d" });
    ok(res, { token });
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","login failed",500);
  }
});

app.get("/api/v1/instructor/enrollments", requireAuth("INSTRUCTOR"), async (req,res)=>{
  try{
    const instructorId = req.user.id;
    const [rows] = await pool.query(
      "SELECT e.*, sa.name AS student_name, sa.phone AS student_phone, sa.subjects AS student_subjects, sa.mode AS student_mode, sa.region AS student_region " +
      "FROM enrollments e JOIN student_applications sa ON sa.id=e.student_application_id " +
      "WHERE e.instructor_id=:iid ORDER BY e.id DESC LIMIT 200",
      { iid: instructorId }
    );
    // payments
    const ids = rows.map(r=>r.id);
    let paymentsBy = {};
    if(ids.length){
      const [pays] = await pool.query(
        "SELECT * FROM payments WHERE enrollment_id IN (" + ids.map(()=>"?").join(",") + ") ORDER BY id ASC",
        ids
      );
      paymentsBy = pays.reduce((acc,p)=>{ (acc[p.enrollment_id] ||= []).push(p); return acc; }, {});
    }

    ok(res, { list: rows.map(r=>({
      id:r.id,
      status:r.status,
      start_date:r.start_date,
      end_date:r.end_date,
      consulted_at:r.consulted_at,
      studentApplication: {
        id: r.student_application_id,
        name: r.student_name,
        phone: r.student_phone,
        subjects: jsonStr(r.student_subjects),
        mode: r.student_mode,
        region: r.student_region
      },
      payments: paymentsBy[r.id] || []
    }))});
  }catch(e){
    console.error(e);
    bad(res,"SERVER_ERROR","Failed",500);
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

    const token = signToken({ typ:"PORTAL", phone: formatPhone(phone) }, { expiresIn:"14d" });
    ok(res, { token });
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
