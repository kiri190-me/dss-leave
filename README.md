# DSS 휴가 관리

사내 휴가 신청·결재와 남은 연차 확인. 자세한 내용은 [CLAUDE.md](./CLAUDE.md).

## 실행

```
npm run db:up    # 이 시스템 전용 PostgreSQL 상자 (127.0.0.1:5448)
npm run dev      # http://localhost:3700
```

`.env.local` 이 먼저 있어야 한다 (`.env.example` 참고). `npm run db:up` 은 그 파일에서
`DSS_LEAVE_DB_PASSWORD` 를 읽는다 — docker compose 는 `.env.local` 을 스스로 읽지 않는다.

## 명령어

| 명령 | 하는 일 |
|---|---|
| `npm run dev` | 개발 서버 (포트 3700, 0.0.0.0) |
| `npm run build` / `npm start` | 운영 빌드 / 실행 (`output: "standalone"`) |
| `npm run typecheck` · `npm run lint` | 타입 검사 · 린트 |
| `npm run db:up` / `db:down` / `db:psql` | 개발용 DB 상자 띄우기 / 내리기 / psql |
| `npm run db:generate` | 스키마 변경 → 마이그레이션 SQL 생성 (생성된 SQL 은 손으로 고치지 않는다) |
| `npm run db:migrate` | 마이그레이션 적용 — **사용자 승인 후에만** |
| `npm run seed:dev` | 개발용 가짜 데이터 (명단이 비어 있을 때만, 지우지 않음) |
| `npm run test:auth` | 로그인 판정 검사 (DB·네트워크 없이) |
| `npm run test:leave` | 휴가 계산 규칙 검사 (DB 없이) |
| `npm run test:workflow` | 신청·결재 흐름 검사 — **테스트 DB(`dss_leave_test`)에서만** |

`test:workflow` 는 `DATABASE_URL` 을 테스트 DB 로 바꿔서 실행한다 (화면용 DB 면 스스로 멈춘다).

## 포트

사내 시스템이 한 PC 에서 함께 뜬다. 통합 로그인 왕복을 보려면 포털과 이 사이트가
**동시에** 떠 있어야 하므로 겹치면 안 된다.

| 포트 | 시스템 |
|---|---|
| 3000 | A/S 관리 |
| 3100 | 통합 로그인 포털 (dss-auth) |
| 3200 | 회사 홈페이지 |
| 3300 | 계측기 관리 |
| 3400 | 시너지 출석부 |
| 3500 | 개선요청 |
| 3600 | PO/내자 |
| **3700** | **휴가 관리 (이 시스템)** |

DB 상자는 `127.0.0.1:5448`.

## 환경변수

`.env.example` 을 보고 `.env.local` 을 만든다. `.env.local` 은 git 에 올리지 않는다.

## 통합 로그인 (dss-auth)

표준 OIDC Authorization Code + PKCE(S256), scope `openid profile email`.
포털과 이야기하는 코드는 `src/lib/auth/oidc.ts` 한 곳에 있다.

### 포털에 등록할 값

| 항목 | 값 |
|---|---|
| `client_id` | `dss-leave` |
| redirect URI | `http://<이 기계 주소>:3700/api/auth/sso/callback` |
| post-logout redirect URI | (등록하지 않는다 — 로그아웃은 포털에 머문다) |
| backchannel logout URI | `http://<이 기계 주소>:3700/api/auth/sso/backchannel-logout` |
| 런처 타일 주소 | `http://<이 기계 주소>:3700/` |
| 역할 값 | `MEMBER` · `LEAVE_ADMIN` |

역할 클레임을 싣지 않으면 이 시스템이 갖고 있던 역할을 **그대로 둔다**(처음 오는 사람은
`MEMBER`). 이 시스템이 모르는 역할 값을 실으면 그 사람의 로그인을 **거절**한다.

## NAS 배포 (준비만 되어 있음)

`Dockerfile` (멀티스테이지, node:24-alpine, 포트 3700, TZ=Asia/Seoul).
배포는 직접 하지 않고 절차를 따로 정리해 드린다.
