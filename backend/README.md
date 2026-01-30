# CodeAI 신청 API (NCP 서버용)

> 권장 배포: `/opt/codeai-api-v1` 처럼 버전 폴더에 배치 후  
> `/opt/codeai-api` 를 활성 버전을 가리키는 심볼릭 링크로 유지합니다.  
> systemd/nginx는 항상 `/opt/codeai-api` 를 바라보게 하면 무중단 교체가 쉽습니다.

GitHub Pages(프론트)에서 **수강신청/강사신청 채팅**을 전송하면, NCP 서버(110.165.16.40)에서 이 API가 받아서 **NCP MySQL(VPC, Private Domain)** 에 저장합니다.

## 1) DB 생성/테이블 생성

서버에서 MySQL 접속 후 아래 스키마를 실행하세요.

```bash
mysql -h db-3or502.vpc-cdb.ntruss.com -P 3306 -u FLOWNCO -p
```

```sql
SOURCE ./db/schema.sql;
```

> DB 이름이 `codeai-student` 처럼 하이픈(-)이 포함되어 있어, SQL에서는 반드시 **백틱(`)** 으로 감쌉니다.

## 2) 서버 실행

### (A) Node 설치 (Ubuntu 기준)

가장 안전한 방법은 `nvm` 입니다.

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
```

### (B) 환경변수 설정

```bash
cd /opt/codeai-api
cp .env.example .env
vi .env
```

### (C) 의존성 설치/실행

```bash
npm ci
npm run start
```

정상 동작 확인:

```bash
curl http://127.0.0.1:8080/healthz
```

## 3) Nginx 리버스 프록시(권장)

- `deploy/nginx-codeai-api.conf` 파일을 참고해 `api.codeai.co.kr` 같은 서브도메인으로 붙이는 구성을 권장합니다.
- GitHub Pages(https://www.codeai.co.kr)에서 호출하므로, API도 **HTTPS** 로 제공해야 브라우저에서 막히지 않습니다(혼합 콘텐츠).

## 4) 프론트 연결

프론트(HTML)에서 다음 값만 맞추면 됩니다.

- `window.CODEAI_API_BASE = "https://api.codeai.co.kr"` (또는 공인 IP 기반 HTTPS URL)

## 5) 운영(권장) : systemd 등록

```bash
sudo mkdir -p /opt/codeai-api
sudo rsync -av --delete ./ /opt/codeai-api/
sudo chown -R www-data:www-data /opt/codeai-api

sudo cp deploy/codeai-api.service /etc/systemd/system/codeai-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now codeai-api
sudo systemctl status codeai-api
```

