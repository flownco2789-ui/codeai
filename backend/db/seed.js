import "dotenv/config";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";

function required(name, v){
  if(!v || String(v).trim()==="") throw new Error(`Missing env: ${name}`);
  return String(v);
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

  const admins = [
    { email:"superadmin@codeai.co.kr", role:"SUPER_ADMIN", phone:null },
    { email:"subadmin@codeai.co.kr", role:"SUB_ADMIN", phone:null },
    { email:"instadmin@codeai.co.kr", role:"INSTRUCTOR_ADMIN", phone:null },
    { email:"stuadmin@codeai.co.kr", role:"STUDENT_ADMIN", phone:null }
  ];

  for(const a of admins){
    const [rows] = await conn.query("SELECT id FROM admin_users WHERE email=:email", { email:a.email });
    if(rows.length) continue;
    const hash = await bcrypt.hash(adminPassword, 10);
    await conn.query(
      "INSERT INTO admin_users (email,password_hash,role,phone,is_active) VALUES (:email,:hash,:role,:phone,1)",
      { email:a.email, hash, role:a.role, phone:a.phone }
    );
  }

  // demo instructor (if not exists)
  const demoEmail = "demo-instructor@codeai.co.kr";
  const [instRows] = await conn.query("SELECT id FROM instructors WHERE email=:email", { email: demoEmail });
  if(!instRows.length){
    const hash = await bcrypt.hash(teacherPassword, 10);
    await conn.query(
      "INSERT INTO instructors (name,phone,email,password_hash,subjects,modes,region,education,career,major,age,gender,photo_url,status) VALUES " +
      "(:name,:phone,:email,:hash,JSON_ARRAY('파이썬','웹개발','알고리즘'),JSON_ARRAY('ZOOM','OFFLINE_1_1'),'수지','OO대 컴퓨터공학','학원/과외 5년','컴퓨터공학',30,'M',NULL,'ACTIVE')",
      { name:"데모강사", phone:"01000000000", email:demoEmail, hash }
    );
  }

  await conn.end();
  console.log("✅ seed done. admin pw:", adminPassword, "/ instructor pw:", teacherPassword);
}

main().catch((e)=>{
  console.error("❌ seed error:", e);
  process.exit(1);
});
