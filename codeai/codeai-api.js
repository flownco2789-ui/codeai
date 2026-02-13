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

    // IMPORTANT:
    // Object.assign({headers: merged}, opts) 형태로 합치면 opts.headers가 merged를 덮어써서
    // Authorization만 남고 Content-Type이 사라지는 버그가 생깁니다.
    // (express.json()이 body를 파싱하지 못해 req.body가 비어버림)
    const finalHeaders = Object.assign({ "Content-Type":"application/json" }, (opts && opts.headers) || {});
    const finalOpts = Object.assign({}, (opts || {}), { headers: finalHeaders });
    const res = await fetch(url, finalOpts);
    const data = await res.json().catch(()=>null);
    if(!res.ok){
      const msg = data && (data.message || data.code) ? (data.message || data.code) : ("HTTP_" + res.status);
      const err = new Error(msg);
      err.status = res.status;
      err.code = data && data.code;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function authRequest(path, tokenKey, opts){
    const token = localStorage.getItem(tokenKey);
    if(!token){
      const err = new Error("NO_TOKEN");
      err.status = 401;
      err.code = "NO_TOKEN";
      throw err;
    }
    const headers = Object.assign({}, (opts && opts.headers) || {}, { Authorization: "Bearer " + token });
    try{
      return await request(path, Object.assign({}, opts || {}, { headers }));
    }catch(err){
      // JWT_SECRET 변경 등으로 토큰이 무효가 되면 401이 나옵니다. 이런 경우 저장된 토큰을 제거합니다.
      if(err && (err.status === 401 || err.code === "INVALID_TOKEN" || err.code === "NO_TOKEN")){
        try{ localStorage.removeItem(tokenKey); }catch(_){}
      }
      throw err;
    }
  }

  window.CodeAI = { API, request, authRequest };
})();
