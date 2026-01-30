import mysql from "mysql2/promise";

function required(name, v) {
  if (v === undefined || v === null || String(v).trim() === "") {
    throw new Error(`Missing env: ${name}`);
  }
  return String(v);
}

export function makePoolFromEnv() {
  const host = required("DB_HOST", process.env.DB_HOST);
  const port = Number(process.env.DB_PORT || "3306");
  const user = required("DB_USER", process.env.DB_USER);
  const password = (process.env.DB_PASS && String(process.env.DB_PASS).trim()) ? String(process.env.DB_PASS) : required("DB_PASSWORD", process.env.DB_PASSWORD);
  const database = required("DB_NAME", process.env.DB_NAME);

  return mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    maxIdle: 10,
    idleTimeout: 60000,
    queueLimit: 0,
    namedPlaceholders: true
  });
}
