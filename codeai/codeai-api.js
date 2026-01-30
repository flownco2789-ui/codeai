/** Minimal API helper for static pages */
(function(){
  const API = (window.CODEAI_API_BASE || "https://api.codeai.co.kr").replace(/\/+$/g,"");

  async function request(path, opts){
    const res = await fetch(API + path, Object.assign({
      headers: Object.assign({ "Content-Type":"application/json" }, (opts && opts.headers) || {})
    }, opts || {}));
    const data = await res.json().catch(()=>null);
    if(!res.ok){
      const msg = data && (data.message || data.code) ? (data.message || data.code) : ("HTTP_" + res.status);
      throw new Error(msg);
    }
    return data;
  }

  async function authRequest(path, tokenKey, opts){
    const token = localStorage.getItem(tokenKey);
    if(!token) throw new Error("NO_TOKEN");
    const headers = Object.assign({}, (opts && opts.headers) || {}, { Authorization: "Bearer " + token });
    return request(path, Object.assign({}, opts || {}, { headers }));
  }

  window.CodeAI = { API, request, authRequest };
})();
