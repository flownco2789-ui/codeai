/** Minimal API helper for static pages */
(function(){
  const API = (window.CODEAI_API_BASE || "https://api.codeai.co.kr").replace(/\/+$/g,"");

  async function request(path, opts){
    // path가 "/" 없이 넘어오면 (예: "post"), 도메인 뒤에 그대로 붙어서
    // "https://api.codeai.co.krpost" 같은 잘못된 URL이 됩니다.
    // 모든 호출을 안전하게 만들기 위해 여기서 보정합니다.
    let url;
    if(/^https?:\/\//i.test(String(path)) || String(path).startsWith("//")){
      url = String(path);
    }else{
      const p = String(path || "");
      url = API + (p.startsWith("/") ? p : ("/" + p));
    }

    const res = await fetch(url, Object.assign({
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
