# CodeAI 배포 가이드 (서버 세팅 완료 기준)

아래는 **이미 서버/Nginx/도메인(DNS) 세팅이 되어있는 상태**에서, 이 소스코드를 올려서 **운영 동작**시키는 순서입니다.

---

## 0) 구성
- **프론트(정적)**: `codeai/` 폴더 (Nginx 또는 GitHub Pages로 배포 가능)
  - 주요 페이지
    - `/index.html` : 메인 + 수강신청 챗 위젯
    - `/instructor-apply.html` : 강사 지원(사진 업로드 포함)
    - `/admin.html` : 관리자 페이지(강사검수/수강/리포트)
    - `/instructor.html` : 강사 페이지(상담/결제요청/리포트작성)
    - `/portal.html` : 학부모 포털(코드 로그인/리포트 확인)
- **백엔드(API)**: `backend/` (Node.js + MySQL)
  - 기본 포트: `8080`
  - 헬스체크: `GET /healthz`

---

## 1) 백엔드 배포 (서버에 올리기)

### 권장 배포 규칙(버전 폴더 + 고정 경로)
- 실제 배포본은 버전별로: `/opt/codeai-api-v1`, `/opt/codeai-api-v2` …
- **고정 경로**: `/opt/codeai-api` 는 현재 활성 버전을 가리키는 **심볼릭 링크**로 유지

예시(이번 배포를 v1로 배치한다고 가정):
```bash
# 1) 새 버전 폴더 생성
sudo mkdir -p /opt/codeai-api-v1

# 2) ZIP을 임시 경로에 풀기
mkdir -p /tmp/codeai_build
cd /tmp/codeai_build
unzip /path/to/codeai_v2_fullstack.zip

# 3) 백엔드만 새 버전 폴더로 반영
sudo rsync -av --delete ./codeai/backend/ /opt/codeai-api-v1/
sudo chown -R www-data:www-data /opt/codeai-api-v1

# 4) 고정 경로 링크 교체(원자적으로 전환)
sudo ln -sfn /opt/codeai-api-v1 /opt/codeai-api
```

백엔드 폴더로 이동:

```bash
cd /opt/codeai-api
npm i
```

---

## 2) 백엔드 환경변수(.env)
`backend/.env` 생성:

```env
PORT=8080

DB_HOST=YOUR_DB_HOST
DB_PORT=3306
DB_USER=YOUR_DB_USER
DB_PASSWORD=YOUR_DB_PASSWORD
DB_NAME=codeai

JWT_SECRET=CHANGE_ME_LONG_RANDOM

# 프론트 도메인(CORS 허용)
ALLOWED_ORIGINS=https://codeai.co.kr,https://www.codeai.co.kr

# 업로드 경로(옵션)
UPLOAD_DIR=/opt/codeai/uploads

# 업로드 파일 URL 생성용(옵션)
API_PUBLIC_BASE=https://api.codeai.co.kr
```

> 기존에 `DB_PASS`를 쓰고 있으면 `DB_PASS`로 넣어도 됩니다. (`DB_PASSWORD`도 지원)

---

## 3) DB 테이블 생성(마이그레이션)
> 이전에 “테이블이 없음” 이라고 했던 상태라면 아래가 필수입니다.

```bash
cd /opt/codeai-api
npm run migrate
npm run seed
```

Seed 기본 계정 (필요시 SEED_ADMIN_PASSWORD로 바꿀 수 있음):
- 관리자: `superadmin@codeai.co.kr` / `admin1234!`
- 강사(데모): `demo-instructor@codeai.co.kr` / `teacher1234!`

---

## 4) systemd 서비스 등록 (권장)
`/etc/systemd/system/codeai-api.service`

```ini
[Unit]
Description=CodeAI API
After=network.target

[Service]
WorkingDirectory=/opt/codeai/<압축풀린폴더>/backend
EnvironmentFile=/opt/codeai/<압축풀린폴더>/backend/.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

적용:
```bash
sudo systemctl daemon-reload
sudo systemctl enable codeai-api
sudo systemctl restart codeai-api
sudo systemctl status codeai-api --no-pager
```

헬스체크:
```bash
curl -s https://api.codeai.co.kr/healthz
```

---

## 5) Nginx 리버스프록시 (api.codeai.co.kr)
예시(핵심만):

```nginx
server {
    listen 443 ssl;
    server_name api.codeai.co.kr;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

적용:
```bash
sudo nginx -t
sudo systemctl reload nginx
```

---

## 6) 프론트 배포
### A) Nginx 정적 호스팅
`/var/www/codeai` 같은 경로로 `codeai/` 폴더 내용 복사

```bash
sudo mkdir -p /var/www/codeai
sudo cp -r /opt/codeai/<압축풀린폴더>/codeai/* /var/www/codeai/
```

### B) GitHub Pages
`codeai/` 폴더의 파일들을 GitHub Pages repo 루트에 올리면 됩니다.

---

## 7) 운영 플로우 (실제 사용 순서)
1. **학생 신청**: 메인(index) 챗 위젯 → 신청 저장 → 강사 선택
2. **강사 지원**: instructor-apply.html → 관리자(admin)에서 승인/반려
3. **강사 로그인**: instructor.html → 상담완료 → 결제요청 → 리포트 작성(검수대기)
4. **관리자 검수**: admin.html → 리포트 승인
5. **결제완료 처리**: admin.html에서 “결제완료 처리” → 포털코드 발급
6. **학부모 포털**: portal.html → 휴대폰+코드 로그인 → 승인된 리포트 확인

> 현재 알림톡/SMS는 **notification_logs 테이블에 기록만** 합니다. (Aligo/카카오 연동은 다음 단계에서 붙이면 됩니다)

---
