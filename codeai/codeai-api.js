/** Minimal API helper for static pages (with typed errors) */
(function(){
  const API = (window.CODEAI_API_BASE || "https://api.codeai.co.kr").replace(/\/+$/g,"");

  class ApiError extends Error {
    constructor(status, code, message, data){
      super(message || code || ("HTTP_" + status));
      this.name = "ApiError";
      this.status = status;
      this.code = code || null;
      this.data = data || null;
    }
  }

  async function request(path, opts){
    const res = await fetch(API + path, Object.assign({
      headers: Object.assign({ "Content-Type":"application/json" }, (opts && opts.headers) || {})
    }, opts || {}));

    let data = null;
    let text = null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    try{
      if(ct.includes("application/json")) data = await res.json();
      else text = await res.text();
    }catch(e){
      // ignore parse errors
    }

    if(!res.ok){
      const code = data && data.code ? data.code : null;
      const msg = (data && (data.message || data.error)) ? (data.message || data.error)
                : (text && text.trim() ? text.trim().slice(0,200) : ("HTTP_" + res.status));
      throw new ApiError(res.status, code, msg, data || { text });
    }
    return data;
  }

  async function authRequest(path, tokenKey, opts){
    const token = localStorage.getItem(tokenKey);
    if(!token) throw new ApiError(401, "NO_TOKEN", "로그인이 필요합니다.", null);
    const headers = Object.assign({}, (opts && opts.headers) || {}, { Authorization: "Bearer " + token });
    try{
      return await request(path, Object.assign({}, opts || {}, { headers }));
    }catch(e){
      // Normalize common invalid token errors from servers that only return message
      if(e && e.status === 401 && (!e.code)){
        const m = String(e.message||"").toLowerCase();
        if(m.includes("token") || m.includes("jwt")) e.code = "INVALID_TOKEN";
      }
      throw e;
    }
  }

  window.CodeAI = { API, request, authRequest, ApiError };
})();