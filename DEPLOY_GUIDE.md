# CodeAI (GitHub Pages + NCP) 배포 가이드

## 전체 구조

- **프론트(정적)**: GitHub Pages → `https://www.codeai.co.kr`
- **백엔드(API)**: NCP 서버 `110.165.16.40` (Node/Express)
- **DB**: NCP MySQL (VPC Private) → `db-3or502.vpc-cdb.ntruss.com:3306` / DB: `codeai-student`

## 1) DNS

1) `api.codeai.co.kr` A 레코드를 `110.165.16.40` 으로 설정

## 2) DB 스키마 적용

NCP 서버에서 다음 실행:

```bash
cd /opt/codeai-api
mysql -h db-3or502.vpc-cdb.ntruss.com -P 3306 -u FLOWNCO -p
```

```sql
SOURCE ./db/schema.sql;
```

## 3) 백엔드(API) 배포

```bash
sudo apt update
sudo apt install -y git

# (권장) 버전 폴더에 배치 후 /opt/codeai-api 심볼릭 링크로 운영
# 예: /opt/codeai-api-v1 에 배치 → /opt/codeai-api -> /opt/codeai-api-v1
sudo mkdir -p /opt/codeai-api-v1
sudo rsync -av --delete ./backend/ /opt/codeai-api-v1/

# 고정 경로 링크 교체
sudo ln -sfn /opt/codeai-api-v1 /opt/codeai-api
sudo chown -R www-data:www-data /opt/codeai-api

# Node 설치 (nvm 권장)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20

cd /opt/codeai-api
sudo -u www-data bash -lc 'cp .env.example .env'
sudo -u www-data bash -lc 'vi .env'   # DB_PASS 등 수정
sudo -u www-data bash -lc 'npm ci'
```

systemd 등록(권장):

```bash
sudo cp /opt/codeai-api/deploy/codeai-api.service /etc/systemd/system/codeai-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now codeai-api
sudo systemctl status codeai-api

curl http://127.0.0.1:8080/health
```

## 4) Nginx + HTTPS

> GitHub Pages에서 호출하므로 API도 **HTTPS** 가 필수입니다.

```bash
sudo apt install -y nginx
sudo cp /opt/codeai-api/deploy/nginx-codeai-api.conf /etc/nginx/sites-available/codeai-api.conf
sudo ln -sf /etc/nginx/sites-available/codeai-api.conf /etc/nginx/sites-enabled/codeai-api.conf
sudo nginx -t
sudo systemctl restart nginx

# 인증서 발급
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.codeai.co.kr
```

## 5) 프론트(깃헙) 설정

프론트는 아래 기본값을 사용합니다.

- `window.CODEAI_API_BASE` 미설정 시 → `https://api.codeai.co.kr`

만약 다른 도메인을 쓰면 `index.html`, `instructor-apply.html` 상단의 `window.CODEAI_API_BASE` 를 선언해 덮어써도 됩니다.
