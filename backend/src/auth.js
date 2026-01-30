import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

function required(name, v){
  if(!v || String(v).trim()==="") throw new Error(`Missing env: ${name}`);
  return String(v);
}

export function jwtSecret(){
  return required("JWT_SECRET", process.env.JWT_SECRET);
}

export async function hashPassword(password){
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password, hash){
  return bcrypt.compare(password, hash);
}

export function signToken(payload, opts={}){
  const secret = jwtSecret();
  return jwt.sign(payload, secret, { expiresIn: opts.expiresIn || "7d" });
}

export function requireAuth(typ){
  return (req, res, next)=>{
    try{
      const auth = String(req.headers.authorization || "");
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if(!token) return res.status(401).json({ ok:false, code:"NO_TOKEN", message:"Missing token" });
      const decoded = jwt.verify(token, jwtSecret());
      if(typ && decoded.typ !== typ) return res.status(403).json({ ok:false, code:"FORBIDDEN", message:"Wrong token type" });
      req.user = decoded;
      return next();
    }catch(e){
      return res.status(401).json({ ok:false, code:"INVALID_TOKEN", message:"Invalid token" });
    }
  };
}
