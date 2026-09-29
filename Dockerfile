# NAS(Synology DS218+, Linux) 용 이미지. 멀티스테이지: deps → build → tools → runner
# 네이티브 바이너리가 필요한 라이브러리를 쓰지 않는다.
#
#   docker build --target tools  -t dss-leave-tools:1 .
#   docker build --target runner -t dss-leave:0.1 .
#
# 🔴 굽는 것도 NAS 로 올리는 것도 사람이 한다.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 빌드에만 쓰는 가짜 DATABASE_URL — 이것이 없으면 `npm run build` 가 죽는다.
#
#   Error: Failed to collect configuration for /leave
#     [cause]: 환경변수 DATABASE_URL 이(가) 설정되지 않았습니다.
#       at get databaseUrl (src/lib/env.ts:76)
#       at module evaluation (src/lib/db/index.ts:16)
#
# 왜: `next build` 는 각 화면의 데이터를 모으려고 서버 모듈을 실제로 불러오는데,
# 이미지에는 .dockerignore 가 .env* 를 막아 두어(그게 맞다) 값이 없다.
#
# 🔴 근본 원인은 앱 코드에 있다. src/lib/env.ts 는 주석에 「getter 로 만들어
#    모듈을 읽는 시점이 아니라 실제로 쓰는 시점에 검사한다」고 적어 두었는데,
#    src/lib/db/index.ts 16번째 줄이 **모듈 최상위에서** postgres(env.databaseUrl, …)
#    를 불러 그 의도를 무너뜨린다 — 그 모듈을 import 하는 순간 던진다.
#    그쪽을 지연 연결로 고치면 이 줄은 빼도 된다. (2026-09-29 확인)
#
# 접속은 하지 않는다 — postgres.js 는 실제로 쓸 때 연결한다. 값이 "있기만" 하면
# 되므로 누가 봐도 가짜인 값을 쓴다. 이 값은 **이 스테이지에만 남고 최종 이미지로
# 넘어가지 않는다** (runner 는 별도 FROM 이라 ENV 를 물려받지 않는다 — 구운 뒤
# `docker run --rm dss-leave:0.1 printenv DATABASE_URL` 이 비는 것으로 확인한다).
# 운영에서는 컨테이너 환경변수로 진짜 값이 들어온다.
#
# 개선요청(dss-improvements)의 Dockerfile 도 builder 스테이지 같은 자리에 같은
# 줄을 둔다 — 다섯 사이트가 쓰는 방식에 맞춘 것이다.
ENV DATABASE_URL="postgres://build:build@127.0.0.1:5432/build_time_only"

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── 곁가지 : 마이그레이션을 돌리는 도구 이미지 ────────────────────────
#
# 운영 이미지(runner)에서는 db:migrate 를 부를 수 없다. 이유가 둘이다 —
# drizzle-kit 이 devDependency 고, runner 는 .next/standalone 만 담아
# node_modules 도 drizzle/*.sql 도 아예 없다. 이 스테이지가 그 자리를 맡는다.
#
#   docker build --target tools -t dss-leave-tools:1 .
#
# NAS 에서는 compose 의 `profiles: [tools]` 서비스로 두고, 부를 때만 잠깐 떴다
# 사라진다(`docker compose run --rm tools-leave npm run db:migrate`).
# 상시 서비스가 아니라 메모리 예산 밖이다.
#
# ⚠️ 이 스테이지를 runner 뒤로 옮기지 않는다. **마지막 스테이지가 `docker build`
#    의 기본 대상**이라, 뒤에 두면 `--target` 없이 구운 이미지가 앱이 아니라
#    도구가 된다 — 그 이미지는 `node server.js` 를 모른다.
FROM node:24-alpine AS tools
WORKDIR /app
ENV NODE_ENV=production
ENV TZ=Asia/Seoul

# runner 와 같은 `app` 사용자를 쓴다. node:24-alpine 에 기본 `node` 사용자가 있지만
# 이 저장소는 runner 에서 app 을 따로 만들고 있어 거기에 맞춘다.
# 소유자는 COPY 할 때 정한다 — 다 옮겨 놓고 `RUN chown -R /app` 을 하면 그 한 줄이
# /app 전체를 새 레이어에 한 벌 더 복사한다(계측기 도구 이미지에서 1.86GB → 1.07GB).
RUN addgroup -S app && adduser -S app -G app

# drizzle-kit 은 devDependency 다. deps 는 `npm ci` 를 NODE_ENV 없이 돌리므로
# 여기 node_modules 에는 devDependency 가 들어 있다 — 그래서 deps 에서 가져온다.
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json tsconfig.json drizzle.config.ts ./
# drizzle.config.ts 의 schema 가 ./src/lib/db/schema.ts 를 가리킨다.
COPY --chown=app:app src ./src
# 돌릴 마이그레이션 자체와 목록(meta/_journal.json). 목록에 없는 .sql 은 안 돈다.
COPY --chown=app:app drizzle ./drizzle

# ⚠️ vendor 도 담는다 — 지금 당장 쓰지 않는데도 담는다. 이유를 적어 둔다.
#
#    이 스테이지는 build 와 달리 `COPY . .` 가 아니라 **폴더를 골라 담는다.**
#    그래서 tsconfig.json 의 paths 가 가리키는 곳을 하나라도 빠뜨리면, 그 자리를
#    타는 순간 「Cannot find module」 로 죽는다. 2026-09-29 A/S 에서 실제로 그랬다 —
#    2026-09-21 에 스키마를 vendor/dss-core 서브모듈로 옮기면서 tools 스테이지에
#    그 줄을 안 더했고, 그 뒤 8일간 구운 도구 이미지가 전부 죽어 있었다
#    (`Cannot find module '@dss/core/schema'`). 연락서 일괄 이식 · db:migrate ·
#    db:preflight · 야간 완전삭제가 모두 멈췄는데 **태그가 같아 눈으로는 구별이
#    안 됐다.**
#
#    이 저장소의 paths 는 둘뿐이다 — `@/*` → ./src (위에서 담았다) ·
#    `@dss/ui` 계열 → ./vendor/dss-ui (이 줄). db:migrate 가 타는 길
#    (drizzle.config.ts → src/lib/db/schema.ts)은 오늘 기준 drizzle-orm 만
#    import 해서 @dss/ui 를 타지 않는다. 그런데 바로 위에서 **src 를 통째로**
#    담았고 그 안에는 @dss/ui 를 import 하는 파일이 이미 있다
#    (lib/auth/oidc.ts · lib/auth/service-menu-cookie.ts ·
#    lib/leave/portal-notifications.ts). vendor 를 빼면 src 트리가 스스로 깨진
#    채로 들어가고, 도구로 돌릴 것이 하나라도 늘면 그 순간 위와 같은 일이 난다.
#    vendor/dss-ui 는 406KB 다 — 보험값이 싸다.
#
# 🔴 스키마나 코드를 서브모듈로 더 옮기면, **옮긴 곳이 여기 담기는지 먼저 본다.**
COPY --chown=app:app vendor ./vendor

# scripts/ 는 담지 않는다. 운영에서 부르고 싶은 것이 하나 있지만(seed:ranks —
# 직급이 없으면 직원을 한 명도 못 넣는다) scripts/seed-ranks.ts 가 맨 윗줄에서
# `process.loadEnvFile(".env.local")` 을 try 없이 부른다. .dockerignore 가 .env* 를
# 막아 컨테이너에는 그 파일이 없고, 환경변수로 DATABASE_URL 을 넣어 줘도 그 줄에서
# 먼저 죽는다(drizzle.config.ts 는 같은 호출을 try/catch 로 감싸 두어 괜찮다).
# 담아 봐야 돌지 않으므로 담지 않는다 — 그 스크립트를 고치는 일은 따로 한다.

USER app

# 기본값은 **아무것도 바꾸지 않는** 쪽으로 둔다. 적용은 명령을 적어 부른다:
#   docker compose … run --rm tools-leave npm run db:migrate
CMD ["node", "-e", "console.log('db:migrate 를 명령으로 적어 부르세요.')"]

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3700
ENV TZ=Asia/Seoul
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3700
CMD ["node", "server.js"]
