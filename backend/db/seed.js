import "dotenv/config";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";

function required(name, v){
  if(!v || String(v).trim()==="") throw new Error(`Missing env: ${name}`);
  return String(v);
}
function pad2(n){ return String(n).padStart(2,"0"); }
function fmtDateTime(d){
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function startOfWeekMonday(dateObj){
  const d = new Date(dateObj);
  d.setHours(0,0,0,0);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : (1 - day));
  d.setDate(d.getDate() + diff);
  return d;
}
function randPick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function randInt(a,b){ return a + Math.floor(Math.random()*(b-a+1)); }
function genPhone(base){
  // base: 1000..9999
  return `010${String(base).padStart(4,"0")}${String(randInt(1000,9999)).padStart(4,"0")}`;
}
function genPortalCode(){
  return String(Math.floor(100000 + Math.random()*900000));
}

async function main(){
  const host = required("DB_HOST", process.env.DB_HOST);
  const port = Number(process.env.DB_PORT || "3306");
  const user = required("DB_USER", process.env.DB_USER);
  const password = (process.env.DB_PASS && String(process.env.DB_PASS).trim()) ? String(process.env.DB_PASS) : required("DB_PASSWORD", process.env.DB_PASSWORD);
  const database = required("DB_NAME", process.env.DB_NAME);

  const conn = await mysql.createConnection({ host, port, user, password, database, namedPlaceholders: true });

  const adminPassword = process.env.SEED_ADMIN_PASSWORD || "admin1234!";
  const teacherPassword = process.env.SEED_TEACHER_PASSWORD || "teacher1234!";

  const adminHash = await bcrypt.hash(adminPassword, 10);
  const teacherHash = await bcrypt.hash(teacherPassword, 10);

  // Admin users
  const admins = [
    { email:"superadmin@codeai.co.kr", role:"SUPER_ADMIN", phone:null },
    { email:"subadmin@codeai.co.kr", role:"SUB_ADMIN", phone:null },
    { email:"instadmin@codeai.co.kr", role:"INSTRUCTOR_ADMIN", phone:null },
    { email:"stuadmin@codeai.co.kr", role:"STUDENT_ADMIN", phone:null },
  ];
  for(const a of admins){
    await conn.query(
      "INSERT INTO admin_users (email,password_hash,role,phone,is_active) VALUES (:email,:hash,:role,:phone,1) " +
      "ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash), role=VALUES(role), is_active=1",
      { email:a.email, hash:adminHash, role:a.role, phone:a.phone }
    );
  }

  // Instructors
  const subjectsPool = ["Scratch","Python","C","C++","Java","JavaScript","Web","Algorithm","AI"];
  const modesPool = ["ZOOM","OFFLINE_1_1","OFFLINE_GROUP"];
  const typePool = ["COLLEGE","EMPLOYEE","FREELANCER","FULLTIME_TUTOR","OTHER"];

  const instructorIds = [];
  for(let i=1;i<=25;i++){
    const name = `강사${String(i).padStart(2,"0")}`;
    const email = `teacher${String(i).padStart(2,"0")}@codeai.co.kr`;
    const phone = genPhone(2000+i);
    const subjects = Array.from(new Set([randPick(subjectsPool), randPick(subjectsPool)])).slice(0,3);
    const modes = Array.from(new Set([randPick(modesPool), randPick(modesPool)])).slice(0,3);
    const instructor_type = randPick(typePool);
    const is_featured = (i <= 20) ? 1 : 0;

    const [r] = await conn.query(
      "INSERT INTO instructors (name,phone,email,password_hash,subjects,modes,region,instructor_type,is_featured,education,career,major,age,gender,photo_url,status) " +
      "VALUES (:name,:phone,:email,:hash,:subjects,:modes,:region,:type,:featured,:edu,:career,:major,:age,:gender,:photo,'ACTIVE') " +
      "ON DUPLICATE KEY UPDATE name=VALUES(name), phone=VALUES(phone), subjects=VALUES(subjects), modes=VALUES(modes), region=VALUES(region), instructor_type=VALUES(instructor_type), is_featured=VALUES(is_featured), status='ACTIVE'",
      {
        name, phone, email, hash: teacherHash,
        subjects: JSON.stringify(subjects),
        modes: JSON.stringify(modes),
        region: "수지/죽전/분당",
        type: instructor_type,
        featured: is_featured,
        edu: "대학(또는 재직)",
        career: "코딩 교육 경력 1~5년",
        major: "컴퓨터/공학",
        age: randInt(21,39),
        gender: randPick(["M","F","OTHER"]),
        photo: null
      }
    );
    const id = r.insertId || (await conn.query("SELECT id FROM instructors WHERE email=:email", { email })).[0][0].id;
    instructorIds.push(id);
  }

  // Student applications + enrollments
  const studentIds = [];
  for(let i=1;i<=30;i++){
    const name = `학생${String(i).padStart(2,"0")}`;
    const phone = genPhone(3000+i);
    const subjects = [randPick(subjectsPool)];
    const mode = randPick(["ZOOM","OFFLINE_1_1","OFFLINE_GROUP"]);
    const preferred = randPick(["ANY","COLLEGE","EMPLOYEE","FREELANCER","FULLTIME_TUTOR","OTHER"]);

    const [r] = await conn.query(
      "INSERT INTO student_applications (name,phone,subjects,target,mode,region,preferred_instructor_type,note,status) " +
      "VALUES (:name,:phone,:subjects,:target,:mode,:region,:pref,:note,'ENROLLED')",
      {
        name, phone,
        subjects: JSON.stringify(subjects),
        target: "중·고등",
        mode,
        region: "수지",
        pref: preferred,
        note: "시드데이터"
      }
    );
    studentIds.push(r.insertId);
  }

  // Distribute 30 students among instructors (1~5 each)
  const enrollmentIds = [];
  let stuIdx = 0;
  for(const iid of instructorIds){
    const take = (stuIdx >= studentIds.length) ? 0 : randInt(1,5);
    for(let k=0;k<take && stuIdx < studentIds.length; k++){
      const sid = studentIds[stuIdx++];
      const [er] = await conn.query(
        "INSERT INTO enrollments (student_application_id,instructor_id,status,start_date,end_date,consulted_at) VALUES (:sid,:iid,'PAID',CURDATE(),DATE_ADD(CURDATE(), INTERVAL 90 DAY),NOW())",
        { sid, iid }
      );
      enrollmentIds.push({ enrollment_id: er.insertId, instructor_id: iid, student_application_id: sid });
    }
    if(stuIdx >= studentIds.length) break;
  }

  // Ensure all students enrolled
  while(stuIdx < studentIds.length){
    const iid = randPick(instructorIds);
    const sid = studentIds[stuIdx++];
    const [er] = await conn.query(
      "INSERT INTO enrollments (student_application_id,instructor_id,status,start_date,end_date,consulted_at) VALUES (:sid,:iid,'PAID',CURDATE(),DATE_ADD(CURDATE(), INTERVAL 90 DAY),NOW())",
      { sid, iid }
    );
    enrollmentIds.push({ enrollment_id: er.insertId, instructor_id: iid, student_application_id: sid });
  }

  // Portal codes + ISSUE logs + weekly reports (12 weeks)
  for(const e of enrollmentIds){
    const [[sa]] = await conn.query("SELECT phone FROM student_applications WHERE id=:id", { id: e.student_application_id });
    const portalCode = genPortalCode();
    const codeHash = await bcrypt.hash(portalCode, 10);
    const expiresAt = new Date(Date.now() + 1000*60*60*24*120);

    await conn.query(
      "INSERT INTO portal_access_codes (enrollment_id,phone,code_hash,expires_at) VALUES (:eid,:phone,:hash,:exp)",
      { eid: e.enrollment_id, phone: sa.phone, hash: codeHash, exp: fmtDateTime(expiresAt) }
    );
    await conn.query(
      "INSERT INTO portal_code_events (enrollment_id,event_type,code_value,actor_role,actor_id,ip,user_agent) VALUES (:eid,'ISSUE',:v,'SYSTEM',NULL,NULL,'seed')",
      { eid: e.enrollment_id, v: portalCode }
    );

    const now = new Date();
    const start = startOfWeekMonday(now);
    for(let w=0; w<12; w++){
      const d = new Date(start);
      d.setDate(d.getDate() - 7*w);
      const weekStart = `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;

      const metrics = {
        attendance: randInt(1,3),
        homework_done: randInt(60,100),
        focus: randInt(60,100),
        mistakes: randInt(0,8),
        memo: randPick(["좋아요","보통","집중 필요","숙제 체크 필요"])
      };
      const algo_score = randInt(55,100);
      const project_feedback = randPick([
        "기초 개념을 안정적으로 잡아가고 있어요.",
        "문제 접근이 좋아졌고, 정확도만 더 올리면 됩니다.",
        "스스로 설명하는 연습을 더 하면 성장이 빨라집니다."
      ]);
      const instructor_comment = randPick([
        "다음 주는 함수/조건문 복습을 진행하겠습니다.",
        "오답노트 작성 습관을 잡아주세요.",
        "수업 전 10분 예습을 권장합니다."
      ]);
      const admin_status = (w < 8) ? "APPROVED" : (Math.random() < 0.7 ? "PENDING" : "REJECTED");

      await conn.query(
        "INSERT INTO weekly_reports (enrollment_id,instructor_id,week_start_date,metrics_json,algo_score,project_feedback,instructor_comment,admin_status) " +
        "VALUES (:eid,:iid,:ws,:mj,:as,:pf,:ic,:st) " +
        "ON DUPLICATE KEY UPDATE metrics_json=VALUES(metrics_json), algo_score=VALUES(algo_score), project_feedback=VALUES(project_feedback), instructor_comment=VALUES(instructor_comment), admin_status=VALUES(admin_status)",
        { eid: e.enrollment_id, iid: e.instructor_id, ws: weekStart, mj: JSON.stringify(metrics), as: algo_score, pf: project_feedback, ic: instructor_comment, st: admin_status }
      );
    }
  }

  await conn.end();
  console.log("✅ seed done");
  console.log("관리자 로그인:", "superadmin@codeai.co.kr /", adminPassword);
  console.log("강사 로그인 예시:", "teacher01@codeai.co.kr /", teacherPassword);
}

main().catch((e)=>{
  console.error("❌ seed error:", e);
  process.exit(1);
});
