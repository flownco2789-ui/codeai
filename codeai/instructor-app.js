(function(){
  const TOKEN_KEY = "codeai_instructor_token";
let WEEKLY_CACHE = new Map(); // key: YYYY-MM-DD (week_start_date)
  const $ = (id)=>document.getElementById(id);
  const bind = (id, ev, fn)=>{ const el=$(id); if(el) el.addEventListener(ev, fn); };



  function isUnauthorizedError(e){
    const m = String(e && e.message || "");
    return (e && e.status===401) || ["UNAUTHORIZED","NO_TOKEN","HTTP_401","INVALID_TOKEN"].includes(m) || m.includes("HTTP_401");
  }
  function isPwChangeRequired(e){
    return (e && e.code==="PASSWORD_CHANGE_REQUIRED") || String(e && e.message || "").includes("PASSWORD_CHANGE_REQUIRED") || String(e && e.message || "").includes("비밀번호 변경");
  }

  async function loadMe(){
    try{
      const out = await CodeAI.authRequest("/api/v1/instructor/me", TOKEN_KEY, { method:"GET" });
      const me = out.me || {};
      if($("meEmail")) $("meEmail").textContent = me.email ? ("계정: " + me.email) : "";
      if($("meName")) $("meName").value = me.name || "";
      if($("mePhone")) $("mePhone").value = me.phone || "";
      if($("meRegion")) $("meRegion").value = me.region || "";
      if($("meEducation")) $("meEducation").value = me.education || "";
      if($("meMajor")) $("meMajor").value = me.major || "";
      if($("meCareer")) $("meCareer").value = me.career || "";
      if($("mePhotoUrl")) $("mePhotoUrl").value = me.photo_url || "";

      const subs = Array.isArray(me.subjects) ? me.subjects : [];
      if($("meSubjects")) $("meSubjects").value = subs.join(", ");

      const modes = new Set(Array.isArray(me.modes) ? me.modes : []);
      const setCk = (id, v)=>{ const el=$(id); if(el) el.checked = v; };
      setCk("meModeZOOM", modes.has("ZOOM"));
      setCk("meModeOFFLINE_1_1", modes.has("OFFLINE_1_1"));
      setCk("meModeOFFLINE_GROUP", modes.has("OFFLINE_GROUP"));

      if($("meMsg")) $("meMsg").textContent = "";
    }catch(e){
      if(isUnauthorizedError(e)){
        doLogout("세션이 만료되어 로그아웃 되었습니다. 다시 로그인 해주세요.");
        return;
      }
      if(isPwChangeRequired(e)){
        showChangePw("최초 로그인입니다. 비밀번호를 변경해주세요.");
        return;
      }
      if($("meMsg")) $("meMsg").textContent = "내 정보 불러오기 실패: " + (e.message || e);
    }
  }

  async function saveMe(){
    if($("meMsg")) $("meMsg").textContent = "저장 중…";
    try{
      const modes = [];
      if($("meModeZOOM")?.checked) modes.push("ZOOM");
      if($("meModeOFFLINE_1_1")?.checked) modes.push("OFFLINE_1_1");
      if($("meModeOFFLINE_GROUP")?.checked) modes.push("OFFLINE_GROUP");

      const subjects = String($("meSubjects")?.value || "").split(",").map(s=>s.trim()).filter(Boolean);

      await CodeAI.authRequest("/api/v1/instructor/me", TOKEN_KEY, {
        method:"PATCH",
        body: JSON.stringify({
          name: $("meName")?.value?.trim(),
          phone: $("mePhone")?.value?.trim(),
          region: $("meRegion")?.value?.trim(),
          subjects,
          modes,
          education: $("meEducation")?.value?.trim(),
          major: $("meMajor")?.value?.trim(),
          career: $("meCareer")?.value || "",
          photo_url: $("mePhotoUrl")?.value?.trim()
        })
      });
      if($("meMsg")) $("meMsg").textContent = "저장 완료";
      await loadMe();
    }catch(e){
      if(isUnauthorizedError(e)){
        doLogout("세션이 만료되어 로그아웃 되었습니다. 다시 로그인 해주세요.");
        return;
      }
      if(isPwChangeRequired(e)){
        showChangePw("최초 로그인입니다. 비밀번호를 변경해주세요.");
        return;
      }
      if($("meMsg")) $("meMsg").textContent = "저장 실패: " + (e.message || e);
    }
  }
  bind("btnSaveMe","click", saveMe);

function fillWeeklyFormFromCache(){
  const d = $("weekStartDate")?.value;
  if(!d) return;
  const r = WEEKLY_CACHE.get(d);
  if(!r){
    // clear form for new entry
    $("algoScore").value = "";
    $("homeworkDone").value = "";
    $("attendance").value = "";
    $("mistakes").value = "";
    $("memo").value = "";
    return;
  }
  $("algoScore").value = (r.algo_score ?? "");
  $("homeworkDone").value = (r.homework_done ?? "");
  $("attendance").value = (r.attendance ?? "");
  $("mistakes").value = (r.mistakes ?? "");
  $("memo").value = (r.memo ?? "");
}


  const esc = (s)=>String(s||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

  function showLogin(msg){
    $("app").classList.add("d-none");
    $("loginCard").classList.remove("d-none");
    $("btnLogout").classList.add("d-none");
    $("changePwCard").classList.add("d-none");
    if(msg) $("loginMsg").textContent = msg;
  }

  function showApp(){
    $("loginCard").classList.add("d-none");
    $("app").classList.remove("d-none");
    loadMe();
    $("btnLogout").classList.remove("d-none");
    $("changePwCard").classList.add("d-none");
  }

  function doLogout(msg){
    try{ localStorage.removeItem(TOKEN_KEY); }catch(_){ }
    // UI reset
    $("enrSel").innerHTML = "";
    $("dash").innerHTML = "";
    $("weeklyList").innerHTML = "";
    $("count").textContent = "";
    $("msg").textContent = "";
    showLogin(msg || "로그아웃 되었습니다.");
  }

  function showChangePw(msg){
    $("app").classList.add("d-none");
    $("loginCard").classList.add("d-none");
    $("changePwCard").classList.remove("d-none");
    $("btnLogout").classList.remove("d-none");
    if(msg) $("changePwMsg").textContent = msg;
  }


  bind("btnLogout","click", ()=> doLogout("로그아웃 되었습니다."));



  async function doChangePw(){
    $("changePwMsg").textContent = "변경 중…";
    const a = $("newPw").value;
    const b = $("newPw2").value;
    if(!a || a.length < 4) { $("changePwMsg").textContent = "비밀번호는 4자 이상 입력해주세요."; return; }
    if(a !== b){ $("changePwMsg").textContent = "비밀번호 확인이 일치하지 않습니다."; return; }
    try{
      await CodeAI.authRequest("/api/v1/instructor/auth/change-password", TOKEN_KEY, {
        method:"POST",
        body: JSON.stringify({ newPassword: a })
      });
      $("newPw").value = "";
      $("newPw2").value = "";
      $("changePwMsg").textContent = "";
      showApp();
      await loadEnrollments();
    }catch(e){
      if(isUnauthorizedError(e)){
        doLogout("세션이 만료되어 로그아웃 되었습니다. 다시 로그인 해주세요.");
        return;
      }
      $("changePwMsg").textContent = "변경 실패: " + e.message;
    }
  }
  bind("btnChangePw","click", doChangePw);
  bind("btnCancelChange","click", ()=>{ doLogout("로그아웃 되었습니다."); });
  async function doLogin(){
    $("loginMsg").textContent = "로그인 중…";
    try{
      const out = await CodeAI.request("/api/v1/instructor/auth/login", {
        method:"POST",
        body: JSON.stringify({ email: $("email").value.trim(), password: $("password").value })
      });
      localStorage.setItem(TOKEN_KEY, out.token);
      if(out && out.forceChangePassword){
        showChangePw("최초 로그인입니다. 비밀번호를 변경해주세요.");
        $("loginMsg").textContent = "";
        return;
      }
      showApp();
      $("loginMsg").textContent = "";
      await loadEnrollments();
    }catch(e){
      $("loginMsg").textContent = "로그인 실패: " + e.message;
    }
  }
  bind("btnLogin","click", doLogin);

  async function loadEnrollments(){
    $("msg").textContent = "수강 목록 불러오는 중…";
    try{
      const out = await CodeAI.authRequest("/api/v1/instructor/enrollments", TOKEN_KEY, { method:"GET" });
      const list = out.enrollments || [];
      const sel = $("enrSel");
      sel.innerHTML = list.map(e=>{
        const label = `#${e.id} / ${e.student_name || "학생"} / ${e.status}`;
        return `<option value="${e.id}">${esc(label)}</option>`;
      }).join("");
      $("msg").textContent = list.length ? "학생을 선택하세요." : "배정된 수강이 없습니다.";
      if(list.length) await loadWeekly();
    }catch(e){
      if(isUnauthorizedError(e)){
        doLogout("세션이 만료되어 로그아웃 되었습니다. 다시 로그인 해주세요.");
        return;
      }
      if(isPwChangeRequired(e)){
        showChangePw("최초 로그인입니다. 비밀번호를 변경해주세요.");
        return;
      }
      $("msg").textContent = "오류: " + e.message;
    }
  }

  function statusBadge(st){
    if(st==="APPROVED") return "success";
    if(st==="REJECTED") return "danger";
    if(st==="PENDING") return "secondary";
    return "secondary";
  }

  async function loadWeekly(){
    const eid = Number($("enrSel").value);
    if(!eid) return;
    $("msg").textContent = "주간보고서 불러오는 중…";
    try{
      const out = await CodeAI.authRequest(`/api/v1/instructor/enrollments/${eid}/weekly-reports`, TOKEN_KEY, { method:"GET" });
      const list = out.reports || [];
      $("count").textContent = `총 ${list.length}건`;
      // ----- dashboard (12주) -----
      const sorted = [...list].sort((a,b)=> String(a.week_start_date).localeCompare(String(b.week_start_date)));
      const parseMetrics = (r)=>{
        try{
          const mj = r.metrics_json ? (typeof r.metrics_json === "string" ? JSON.parse(r.metrics_json) : r.metrics_json) : {};
          return mj || {};
        }catch(_){ return {}; }
      };
      const toNum = (v)=>{
        if(v===null || v===undefined || v==="") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const series = (key)=> sorted.map(r=> toNum(parseMetrics(r)[key]));
      const avg = (arr)=>{
        const xs = arr.filter(x=>x!==null);
        if(!xs.length) return null;
        return xs.reduce((s,x)=>s+x,0)/xs.length;
      };
      const lastNonNull = (arr)=>{
        for(let i=arr.length-1;i>=0;i--) if(arr[i]!==null) return {v:arr[i], i};
        return {v:null, i:-1};
      };
      const fmt = (n, digits=0)=> (n===null ? "-" : (digits? n.toFixed(digits): String(Math.round(n))));
      const deltaStr = (curr, prev, inverse=false)=>{
        if(curr===null || prev===null) return `<span class="muted">전주 비교 -</span>`;
        const d = curr - prev;
        const up = d>0;
        const good = inverse ? !up : up;
        const cls = good ? "text-success" : (d===0 ? "muted" : "text-danger");
        const sign = d>0?"+":(d<0?"":"");
        return `<span class="${cls}">${sign}${d.toFixed(1)}</span> <span class="muted">vs 전주</span>`;
      };

      const algoS = sorted.map(r=> toNum(r.algo_score));
      const attS = series("attendance");
      const hwS  = series("homework_done");
      const focS = series("focus");
      const misS = series("mistakes");

      const lastAlgo = lastNonNull(algoS); const prevAlgo = lastAlgo.i>0 ? algoS[lastAlgo.i-1] : null;
      const lastAtt  = lastNonNull(attS);  const prevAtt  = lastAtt.i>0  ? attS[lastAtt.i-1]  : null;
      const lastHw   = lastNonNull(hwS);   const prevHw   = lastHw.i>0   ? hwS[lastHw.i-1]   : null;
      const lastFoc  = lastNonNull(focS);  const prevFoc  = lastFoc.i>0  ? focS[lastFoc.i-1]  : null;
      const lastMis  = lastNonNull(misS);  const prevMis  = lastMis.i>0  ? misS[lastMis.i-1]  : null;

      const lastWeek = sorted.length ? sorted[sorted.length-1].week_start_date : "-";

      const buildDashHtml = (viewN)=>{
        const sortedAll = sorted;
        const slice = (viewN && sortedAll.length>viewN) ? sortedAll.slice(sortedAll.length-viewN) : sortedAll.slice();
        const vN = slice.length;

        const seriesV = (key)=> slice.map(r=> toNum(parseMetrics(r)[key]));
        const algoS = slice.map(r=> toNum(r.algo_score));
        const hwS  = seriesV("homework_done");
        const focS = seriesV("focus");
        const attS = seriesV("attendance");
        const misS = seriesV("mistakes");

        const lastWeek = slice.length ? (slice[slice.length-1].week_start_date || "-") : "-";

        const lastNonNull = (arr)=>{
          for(let i=arr.length-1;i>=0;i--) if(arr[i]!==null) return {v:arr[i], i};
          return {v:null, i:-1};
        };
        const avg = (arr)=>{
          const xs = arr.filter(x=>x!==null);
          if(!xs.length) return null;
          return xs.reduce((s,x)=>s+x,0)/xs.length;
        };

        const lastAlgo = lastNonNull(algoS); const prevAlgo = lastAlgo.i>0 ? algoS[lastAlgo.i-1] : null;
        const lastHw   = lastNonNull(hwS);   const prevHw   = lastHw.i>0   ? hwS[lastHw.i-1]   : null;
        const lastFoc  = lastNonNull(focS);  const prevFoc  = lastFoc.i>0  ? focS[lastFoc.i-1]  : null;
        const lastAtt  = lastNonNull(attS);  const prevAtt  = lastAtt.i>0  ? attS[lastAtt.i-1]  : null;
        const lastMis  = lastNonNull(misS);  const prevMis  = lastMis.i>0  ? misS[lastMis.i-1]  : null;

        // comment summary (latest week)
        const last = slice.length ? slice[slice.length-1] : null;
        const lastMetrics = last ? parseMetrics(last) : {};
        const rawComment = (last && (last.instructor_comment || last.project_feedback || lastMetrics.project_feedback || lastMetrics.comment)) || "";
        const comment = String(rawComment||"").trim();

        const stop = new Set(["그리고","하지만","그래서","또한","이번","이번주","다음","주차","학생","수업","과제","숙제","진행","오늘","이번주에","합니다","했습니다","있는","없는","및","the","and","or","to","of","a","an","in","on","for","is","are"]);
        const tokens = comment.replace(/[\n\r\t]/g," ").replace(/[^\w가-힣\s]/g," ").split(/\s+/).map(w=>w.trim()).filter(w=>w.length>=2 && !stop.has(w.toLowerCase()));
        const freq = {};
        tokens.forEach(w=>{ const k=w.toLowerCase(); freq[k]=(freq[k]||0)+1; });
        const top = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,6).map(x=>x[0]);

        const hi = (txt)=>{
          let out = esc(txt);
          top.forEach(k=>{
            if(!k) return;
            const re = new RegExp(`(${k.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")})`,"gi");
            out = out.replace(re, '<mark class="px-1">$1</mark>');
          });
          return out;
        };

        const commentHtml = comment
          ? `<div class="small muted mb-2">최신 주차 코멘트에서 키워드 추출</div>
             <div class="d-flex flex-wrap gap-2 mb-2">
               ${top.length? top.map(k=>`<span class="badge text-bg-light border kw-chip" data-kw="${esc(k)}" style="cursor:pointer;user-select:none">${esc(k)}</span>`).join("") : `<span class="muted">키워드가 부족합니다.</span>`}
             </div>
             <div class="p-3 bg-white rounded-3 border" style="line-height:1.6">${hi(comment.length>260? comment.slice(0,260)+"…" : comment)}</div>`
          : `<div class="muted">이번주 코멘트가 아직 없습니다.</div>`;

        return `
          <div class="d-flex justify-content-between align-items-center mb-2">
            <div class="section-title">최근 ${vN}주 대시보드</div>
            <div class="btn-group btn-group-sm" role="group" aria-label="view toggle">
              <button class="btn btn-outline-primary" id="btnView12" ${viewN===12?'aria-pressed="true"':''}>최근 12주</button>
              <button class="btn btn-outline-primary" id="btnView4"  ${viewN===4?'aria-pressed="true"':''}>최근 4주</button>
            </div>
          </div>

          <div class="card p-3 mb-3">
            <div class="section-title mb-2">이번주 코멘트 요약</div>
            ${commentHtml}
          

<div class="card p-3 mb-3 compare-card">
  <div class="d-flex justify-content-between align-items-center mb-2">
    <div class="section-title">최근 4주 vs 이전 8주 평균</div>
    <div class="muted small">최근 12주 기준</div>
  </div>
  <div id="compareWrap">${renderComparison(sortedAll)}</div>
</div></div>

          <div class="row g-3 mb-3">
            <div class="col-md-3"><div class="kpi-card"><div class="kpi-title">이번주(최신) 주차</div><div class="kpi-value mono">${esc(lastWeek)}</div><div class="kpi-delta muted">최근 ${vN}주</div></div></div>
            <div class="col-md-3"><div class="kpi-card"><div class="kpi-title">알고 점수</div><div class="kpi-value">${fmt(lastAlgo.v,1)}</div><div class="kpi-delta">${deltaStr(lastAlgo.v, prevAlgo)}</div><div class="small muted mt-1">평균 ${fmt(avg(algoS),1)}</div></div></div>
            <div class="col-md-3"><div class="kpi-card"><div class="kpi-title">숙제 수행</div><div class="kpi-value">${fmt(lastHw.v,0)}</div><div class="kpi-delta">${deltaStr(lastHw.v, prevHw)}</div><div class="small muted mt-1">평균 ${fmt(avg(hwS),0)}</div></div></div>
            <div class="col-md-3"><div class="kpi-card"><div class="kpi-title">집중도</div><div class="kpi-value">${fmt(lastFoc.v,0)}</div><div class="kpi-delta">${deltaStr(lastFoc.v, prevFoc)}</div><div class="small muted mt-1">평균 ${fmt(avg(focS),0)}</div></div></div>
          

<div class="card p-3 mb-3 compare-card">
  <div class="d-flex justify-content-between align-items-center mb-2">
    <div class="section-title">최근 4주 vs 이전 8주 평균</div>
    <div class="muted small">최근 12주 기준</div>
  </div>
  <div id="compareWrap">${renderComparison(sortedAll)}</div>
</div></div>

          <div class="row g-3 mb-3">
            <div class="col-md-6">
              <div class="chart-card">
                <div class="d-flex justify-content-between align-items-center mb-2">
                  <div class="section-title">알고/숙제/집중 추이</div>
                  <div class="muted small">${vN}주</div>
                </div>
                <div class="canvas-wrap"><canvas id="cMix" width="900" height="220"></canvas></div>
              </div>
            </div>
            <div class="col-md-3"><div class="kpi-card"><div class="kpi-title">출석</div><div class="kpi-value">${fmt(lastAtt.v,0)}</div><div class="kpi-delta">${deltaStr(lastAtt.v, prevAtt)}</div><div class="small muted mt-1">평균 ${fmt(avg(attS),0)}</div></div></div>
            <div class="col-md-3"><div class="kpi-card"><div class="kpi-title">오답</div><div class="kpi-value">${fmt(lastMis.v,0)}</div><div class="kpi-delta">${deltaStr(lastMis.v, prevMis, true)}</div><div class="small muted mt-1">평균 ${fmt(avg(misS),0)}</div></div></div>
          

<div class="card p-3 mb-3 compare-card">
  <div class="d-flex justify-content-between align-items-center mb-2">
    <div class="section-title">최근 4주 vs 이전 8주 평균</div>
    <div class="muted small">최근 12주 기준</div>
  </div>
  <div id="compareWrap">${renderComparison(sortedAll)}</div>
</div></div>

          <div class="row g-3 mb-3">
            <div class="col-md-6">
              <div class="chart-card">
                <div class="d-flex justify-content-between align-items-center mb-2">
                  <div class="section-title">오답(막대)</div>
                  <div class="muted small">${vN}주</div>
                </div>
                <div class="canvas-wrap"><canvas id="cMis" width="600" height="220"></canvas></div>
              </div>
            </div>
            <div class="col-md-6">
              <div class="chart-card">
                <div class="d-flex justify-content-between align-items-center mb-2">
                  <div class="section-title">출석(스택)</div>
                  <div class="muted small">${vN}주</div>
                </div>
                <div class="canvas-wrap"><canvas id="cAtt" width="600" height="220"></canvas></div>
              </div>
            </div>
          </div>
        `;
      };

      window.__instViewN = window.__instViewN || 12;
      window.__kwSelected = window.__kwSelected || null;
      $("dash").innerHTML = buildDashHtml(window.__instViewN);

      setTimeout(()=>{
        const c = document.getElementById("cMix");
        if(!c) return;
        const ctx = c.getContext("2d");
        const w=c.width,h=c.height,pad=24;
        ctx.clearRect(0,0,w,h);
        const viewN = window.__instViewN || 12;
        const slice = (viewN && sorted.length>viewN) ? sorted.slice(sorted.length-viewN) : sorted.slice();
        const seriesV = (key)=> slice.map(r=> toNum(parseMetrics(r)[key]));
        const algoSV = slice.map(r=> toNum(r.algo_score));
        const hwSV  = seriesV("homework_done");
        const focSV = seriesV("focus");
        const attSV = seriesV("attendance");
        const misSV = seriesV("mistakes");

        const pickVals = (arr)=> arr.map(v=> v===null?null:Number(v));
        const a1=pickVals(algoSV), a2=pickVals(hwSV), a3=pickVals(focSV);
        const all = [...a1,...a2,...a3].filter(v=>v!==null);
        if(all.length<2){
          ctx.fillStyle="#6c757d"; ctx.font="14px system-ui";
          ctx.fillText("데이터가 부족합니다", 10, 24);
          return;
        }
        const min=Math.min(...all), max=Math.max(...all);
        const xStep=(w-pad*2)/(sorted.length-1||1);
        const y=(v)=> (max===min? h/2 : (h-pad) - ((v-min)/(max-min))*(h-pad*2));
        // grid
        ctx.strokeStyle="rgba(16,24,40,.08)"; ctx.lineWidth=1;
        for(let i=0;i<4;i++){
          const yy = pad + (i*(h-pad*2)/3);
          ctx.beginPath(); ctx.moveTo(pad,yy); ctx.lineTo(w-pad,yy); ctx.stroke();
        }
        const draw=(arr,color,label)=>{
          ctx.strokeStyle=color; ctx.lineWidth=2;
          ctx.beginPath();
          arr.forEach((v,i)=>{
            if(v===null) return;
            const xx=pad+i*xStep, yy=y(v);
            if(i===0 || arr.slice(0,i).every(z=>z===null)) ctx.moveTo(xx,yy); else ctx.lineTo(xx,yy);
          });
          ctx.stroke();
          ctx.fillStyle=color;
          // legend
          ctx.font="12px system-ui";
          ctx.fillText(label, w-pad-70, pad+14 + (label==="알고"?0: label==="숙제"?14:28));
        };
        draw(a1, "rgba(37,99,235,.95)", "알고");
        draw(a2, "rgba(16,185,129,.95)", "숙제");
        draw(a3, "rgba(245,158,11,.95)", "집중");
      
        // extra charts (오답 막대 / 출석 스택)
        const drawBars = (cid, arr)=>{
          const c2=document.getElementById(cid);
          if(!c2) return;
          const g=c2.getContext("2d");
          const w2=c2.width,h2=c2.height,p=28;
          g.clearRect(0,0,w2,h2);
          const xs=arr.map(v=>v===null?null:Number(v));
          const vals=xs.filter(v=>v!==null);
          if(!vals.length){
            g.fillStyle="#6c757d"; g.font="14px system-ui"; g.fillText("데이터가 없습니다", 10, 24); return;
          }
          const max=Math.max(...vals,1);
          const bw=(w2-p*2)/xs.length;
          g.strokeStyle="rgba(16,24,40,.08)";
          for(let i=0;i<4;i++){ const yy=p+(i*(h2-p*2)/3); g.beginPath(); g.moveTo(p,yy); g.lineTo(w2-p,yy); g.stroke(); }
          xs.forEach((v,i)=>{
            const xx=p+i*bw+4;
            const barW=Math.max(2,bw-8);
            const val=v===null?0:v;
            const bh=(h2-p*2)*(val/max);
            const yy=(h2-p)-bh;
            g.fillStyle="rgba(239,68,68,.75)";
            g.fillRect(xx,yy,barW,bh);
          });
          g.fillStyle="#6c757d"; g.font="12px system-ui";
          g.fillText(String(max.toFixed(0)), 8, p+4);
          g.fillText("0", 12, h2-p+4);
        };

        const drawStack = (cid, arr)=>{
          const c2=document.getElementById(cid);
          if(!c2) return;
          const g=c2.getContext("2d");
          const w2=c2.width,h2=c2.height,p=28;
          g.clearRect(0,0,w2,h2);
          const xs=arr.map(v=>v===null?null:Number(v));
          const vals=xs.filter(v=>v!==null);
          if(!vals.length){
            g.fillStyle="#6c757d"; g.font="14px system-ui"; g.fillText("데이터가 없습니다", 10, 24); return;
          }
          let maxV=Math.max(...vals);
          let scale=100;
          let conv=(v)=>v;
          if(maxV<=1.5){ conv=(v)=>v*100; }
          else if(maxV>100){ scale=maxV; }
          const bw=(w2-p*2)/xs.length;
          g.strokeStyle="rgba(16,24,40,.08)";
          for(let i=0;i<4;i++){ const yy=p+(i*(h2-p*2)/3); g.beginPath(); g.moveTo(p,yy); g.lineTo(w2-p,yy); g.stroke(); }
          xs.forEach((v,i)=>{
            const xx=p+i*bw+4;
            const barW=Math.max(2,bw-8);
            const pres=v===null?0:Math.max(0,Math.min(scale,conv(v)));
            const abs=scale-pres;
            const ph=(h2-p*2)*(pres/scale);
            const ah=(h2-p*2)*(abs/scale);
            const y0=h2-p;
            g.fillStyle="rgba(34,197,94,.75)";
            g.fillRect(xx,y0-ph,barW,ph);
            g.fillStyle="rgba(148,163,184,.7)";
            g.fillRect(xx,y0-ph-ah,barW,ah);
          });
          g.fillStyle="#6c757d"; g.font="12px system-ui";
          g.fillText(String(scale), 8, p+4);
          g.fillText("0", 12, h2-p+4);
        };

        drawBars("cMis", misSV);
        drawStack("cAtt", attSV);

        // toggle handlers (re-render + redraw)
        const b12=document.getElementById("btnView12");
        const b4=document.getElementById("btnView4");
        if(b12) b12.onclick=()=>{ window.__instViewN=12; $("dash").innerHTML=buildDashHtml(12); loadWeekly(); };
        if(b4)  b4.onclick =()=>{ window.__instViewN=4;  $("dash").innerHTML=buildDashHtml(4);  loadWeekly(); };


// 키워드 칩 클릭: 특정 키워드만 하이라이트 토글
const chips = document.querySelectorAll(".kw-chip");
const avail = new Set(Array.from(chips).map(el=> (el.getAttribute("data-kw")||"").toLowerCase()));
if(window.__kwSelected && !avail.has(String(window.__kwSelected).toLowerCase())) window.__kwSelected = null;

const paint = ()=>{
  chips.forEach(el=>{
    const k = (el.getAttribute("data-kw")||"");
    const on = window.__kwSelected && k.toLowerCase()===String(window.__kwSelected).toLowerCase();
    el.classList.toggle("text-bg-primary", !!on);
    el.classList.toggle("text-bg-light", !on);
  });
};
chips.forEach(el=>{
  el.addEventListener("click", ()=>{
    const k = (el.getAttribute("data-kw")||"").trim();
    if(!k) return;
    window.__kwSelected = (window.__kwSelected && k.toLowerCase()===String(window.__kwSelected).toLowerCase()) ? null : k;
    renderDash(window.__instViewN || 12);
  });
});
paint();
          },0);

      // ----- list (below) -----
      $("weeklyList").innerHTML = sorted.slice().reverse().map(r=>{
        const m = parseMetrics(r);
        const line = m ? `출석 ${m.attendance||"-"} · 숙제 ${m.homework_done||"-"} · 집중 ${m.focus||"-"} · 오답 ${m.mistakes||"-"}` : "-";
        return `
          <div class="border rounded-3 p-2 mb-2 bg-white">
            <div class="d-flex justify-content-between align-items-center">
              <div class="mono"><b>${esc(r.week_start_date)}</b></div>
              <div><span class="badge text-bg-${statusBadge(r.admin_status)}">${esc(r.admin_status)}</span></div>
            </div>
            <div class="small muted mono mt-1">${esc(line)}</div>
            <div class="small mt-1"><b>알고</b> ${esc(r.algo_score ?? "-")}</div>
            <div class="small mt-1"><b>피드백</b> ${esc(r.project_feedback||"-")}</div>
            <div class="small mt-1"><b>코멘트</b> ${esc(r.instructor_comment||"-")}</div>
          </div>
        `;
      }).join("");
      $("msg").textContent = "";
    }catch(e){
      if(isUnauthorizedError(e)){
        doLogout("세션이 만료되어 로그아웃 되었습니다. 다시 로그인 해주세요.");
        return;
      }
      $("msg").textContent = "오류: " + e.message;
    }
  }

  async function saveWeekly(){
    const eid = Number($("enrSel").value);
    if(!eid) return;
    $("saveMsg").textContent = "저장 중…";
    try{
      const payload = {
        weekStartDate: $("weekStartDate").value.trim() || null,
        metrics: {
          attendance: Number($("attendance").value || 0),
          homework_done: Number($("homework").value || 0),
          focus: Number($("focus").value || 0),
          mistakes: Number($("mistakes").value || 0)
        },
        algo_score: ($("algoScore").value==="" ? null : Number($("algoScore").value)),
        project_feedback: $("projectFeedback").value,
        instructor_comment: $("instructorComment").value
      };
      await CodeAI.authRequest(`/api/v1/instructor/enrollments/${eid}/weekly-reports`, TOKEN_KEY, {
        method:"POST",
        body: JSON.stringify(payload)
      });
      $("saveMsg").textContent = "저장 완료 (관리자 검수 대기)";
      await loadWeekly();
    }catch(e){
      if(isUnauthorizedError(e)){
        doLogout("세션이 만료되어 로그아웃 되었습니다. 다시 로그인 해주세요.");
        return;
      }
      $("saveMsg").textContent = "오류: " + e.message;
    }
  }
  bind("btnSave","click", saveWeekly);
  bind("btnRefresh","click", async ()=>{ await loadEnrollments(); });

  bind("enrSel","change", loadWeekly);
    bind("weekStartDate","change", ()=>{ if(WEEKLY_CACHE.size){ fillWeeklyFormFromCache(); } else { loadWeekly(); } });

  (async ()=>{
    if(localStorage.getItem(TOKEN_KEY)){
      showApp();
      await loadEnrollments();
    }
  })();
})();

function renderComparison(sortedAll){
  const n = sortedAll.length;
  const slice12 = n>12 ? sortedAll.slice(n-12) : sortedAll.slice();
  if(slice12.length < 6){
    return `<div class="muted">비교할 데이터가 부족합니다. (최소 6주 이상 필요)</div>`;
  }
  const last4 = slice12.slice(Math.max(0, slice12.length-4));
  const prev8 = slice12.slice(0, Math.max(0, slice12.length-4));
  const parseMetrics = (r)=>{
    try{
      const mj = r.metrics_json ? (typeof r.metrics_json === "string" ? JSON.parse(r.metrics_json) : r.metrics_json) : {};
      return mj || {};
    }catch(_){ return {}; }
  };
  const toNum = (v)=>{
    if(v===null || v===undefined || v==="") return null;
    const num = Number(v);
    return Number.isFinite(num) ? num : null;
  };
  const avg = (arr)=>{
    const xs = arr.filter(x=>x!==null);
    if(!xs.length) return null;
    return xs.reduce((s,x)=>s+x,0)/xs.length;
  };
  const series = (arr, key, direct=true)=>{
    return arr.map(r=>{
      if(key==="algo_score") return toNum(r.algo_score);
      const m = parseMetrics(r);
      return toNum(m[key]);
    });
  };
  const fmt = (n, digits=1)=> (n===null ? "-" : n.toFixed(digits));
  const deltaBadge = (d, inverse=false)=>{
    if(d===null) return `<span class="badge text-bg-light border">-</span>`;
    const up = d>0;
    const good = inverse ? !up : up;
    const cls = d===0 ? "text-bg-light border" : (good ? "text-bg-success" : "text-bg-danger");
    const sign = d>0?"+":(d<0?"":"");
    return `<span class="badge ${cls}">${sign}${d.toFixed(1)}</span>`;
  };

  const keys = [
    {label:"알고 점수", key:"algo_score", inverse:false},
    {label:"숙제 수행", key:"homework_done", inverse:false},
    {label:"집중도",   key:"focus", inverse:false},
    {label:"오답",     key:"mistakes", inverse:true},
    {label:"출석",     key:"attendance", inverse:false},
  ];

  const rows = keys.map(k=>{
    const a4 = avg(series(last4, k.key));
    const a8 = avg(series(prev8, k.key));
    let d = (a4===null || a8===null) ? null : (a4 - a8);
    // normalize attendance if 0~1
    if(k.key==="attendance"){
      const norm = (x)=> (x!==null && x<=1 ? x*100 : x);
      const na4 = a4===null? null : norm(a4);
      const na8 = a8===null? null : norm(a8);
      d = (na4===null || na8===null) ? null : (na4-na8);
      return { ...k, a4: na4, a8: na8, d };
    }
    return { ...k, a4, a8, d };
  });

  const goodCount = rows.filter(r=> r.d!==null && (r.inverse ? r.d<0 : r.d>0)).length;
  const badCount  = rows.filter(r=> r.d!==null && (r.inverse ? r.d>0 : r.d<0)).length;

  const summarize = ()=>{
    const parts = [];
    rows.forEach(r=>{
      if(r.d===null || r.d===0) return;
      const up = r.d>0;
      const verb = (r.inverse ? (up?"증가":"감소") : (up?"상승":"하락"));
      parts.push(`${r.label} ${Math.abs(r.d).toFixed(1)} ${verb}`);
    });
    if(!parts.length) return "최근 4주와 이전 기간의 평균 차이가 크지 않습니다.";
    return `최근 4주는 이전 8주 대비 ${parts.slice(0,3).join(", ")}했습니다.`;
  };

  return `
    <div class="row g-3">
      <div class="col-lg-4">
        <div class="p-3 bg-white rounded-3 border h-100">
          <div class="small muted mb-1">자동 요약</div>
          <div style="line-height:1.6">${summarize()}</div>
          <div class="small muted mt-2">개선 지표 ${goodCount}개 · 악화 지표 ${badCount}개</div>
        </div>
      </div>
      <div class="col-lg-8">
        <div class="table-responsive">
          <table class="table table-sm align-middle mb-0">
            <thead>
              <tr class="muted">
                <th>지표</th>
                <th class="text-end">최근 4주 평균</th>
                <th class="text-end">이전 8주 평균</th>
                <th class="text-end">변화</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(r=>`
                <tr>
                  <td>${r.label}</td>
                  <td class="text-end mono">${fmt(r.a4,1)}</td>
                  <td class="text-end mono">${fmt(r.a8,1)}</td>
                  <td class="text-end">${deltaBadge(r.d, r.inverse)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}


