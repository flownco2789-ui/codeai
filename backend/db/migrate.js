import "dotenv/config";
import fs from "fs";
import path from "path";
import mysql from "mysql2/promise";

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

  const conn = await mysql.createConnection({ host, port, user, password, database, multipleStatements: true });
  const schemaPath = path.join(process.cwd(), "db", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf-8");

  // naive split: remove line comments then split by ;
  const cleaned = sql
    .split(/\r?\n/)
    .filter(line => !line.trim().startsWith("--"))
    .join("\n");

  const statements = cleaned
    .split(";")
    .map(s => s.trim())
    .filter(Boolean);

  for(const st of statements){
    await conn.query(st);
  }

  await conn.end();
  console.log("✅ migrate done:", statements.length, "statements");
}

main().catch((e)=>{
  console.error("❌ migrate error:", e);
  process.exit(1);
});
