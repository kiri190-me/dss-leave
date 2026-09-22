/**
 * 포털에 내주는 알림 통로 검사.  npm run test:portal
 *
 * 🔴 DB 에 닿지 않고 바깥 망에도 나가지 않는다. 포털의 서명 열쇠 노릇은 이
 * 검사가 직접 만든 RSA 열쇠가 한다 — 그래서 「서명이 틀린 토큰」·「만료된
 * 토큰」·「남의 시스템에 발급된 토큰」을 말로가 아니라 **실제로** 돌려 본다.
 *
 * ── 알림이 흐르는 길 (test:bell 의 반대 방향이다) ──────────────────────────
 *   포털이 이 시스템에 묻는다
 *     → GET /api/integration/notifications   (Authorization: Bearer 서명 토큰)
 *     → 토큰의 sub(포털 users.id)로 web_users.auth_sub 를 되짚고
 *     → 결재함과 **같은 조건**으로 「지금 내 차례인 신청」을 세어 답한다
 *     → 포털이 A/S·계측기·개선요청·PO 의 종에 그것을 싣는다
 *
 * ── 무엇을 지키는가 ─────────────────────────────────────────────────────
 *   1. 🔴 토큰이 없거나·만료됐거나·aud 가 다르거나·용도가 다르면 **거절한다.**
 *   2. 🔴 대상 사용자는 **토큰 안에서만** 온다 (쿼리·본문을 읽지 않는다).
 *   3. 🔴 내 `PENDING` 단계만 나온다. 고르는 조건은 결재함과 **한 문장**이다.
 *   4. 개수가 목록과 같은 말을 하고, href 가 절대 주소다.
 *   5. 설정은 고정 기본값이고 역할이 전부 잠겨 있으며, 저장은 거절한다.
 *
 * 라우트는 실제로 불러 볼 수 없다(요청 맥락·DB 가 필요하다). 그 자리들만
 * **소스 글자로** 구조를 못 박는다 — 무르지만 없는 것보다 낫다
 * (test-notification-bell.ts 와 같은 방식).
 *
 * 🔴 왜 전부 main() 안에 있나: 이 저장소의 검사는 tsx 가 CJS 로 돌려
 * (package.json 에 type:module 이 없다) 최상위 await 을 쓸 수 없다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 🔴 .env.local 을 읽지 않는다. 이 검사는 여기 적힌 값으로만 돈다
//    (test-auth.ts·test-bell 과 같은 이유 — auto 로 두면 Wi-Fi 상태에 따라
//    결과가 달라진다).
process.env.SSO_ISSUER = "http://192.168.1.10:3100";
process.env.SSO_CLIENT_ID = "dss-leave";
process.env.SSO_CLIENT_SECRET = "테스트용-시크릿";
process.env.SSO_REDIRECT_URI = "http://192.168.1.10:3700/api/auth/sso/callback";
process.env.SSO_TX_SECRET = "0123456789abcdef0123456789abcdef";
process.env.DATABASE_URL = "postgres://nobody:nobody@127.0.0.1:1/none";

import { SignJWT, generateKeyPair, type CryptoKey } from "jose";
import { PgDialect } from "drizzle-orm/pg-core";

import { appBaseUrlFrom } from "../src/lib/env";
import {
  PORTAL_TOKEN_MAX_LIFETIME_SECONDS,
  PORTAL_TOKEN_PURPOSES,
  readBearerToken,
  verifyPortalTokenWithKey,
  type PortalTokenPurpose,
} from "../src/lib/auth/portal-service-token";
import {
  APPROVALS_PATH,
  LEAVE_APPROVAL_KIND,
  absoluteNotificationHref,
  buildPortalNotificationFeed,
  portalActorOf,
  portalNotificationSettings,
  readPortalNotificationSettings,
  type PendingApprovalRow,
  type PortalActor,
} from "../src/lib/leave/portal-notifications";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}
async function checkAsync(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** 주석을 걷어 낸 코드. 주석에 적힌 낱말이 검사를 통과시키지 않게. */
const withoutComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const ISSUER = "http://192.168.1.10:3100";
const CLIENT_ID = "dss-leave";
const BASE_URL = "http://192.168.1.10:3700";

/** 포털에 등록된 사람의 sub(포털 users.id)와 같은 모양. */
const SUB = "11111111-2222-4333-8444-555555555555";

/** 결재함에서 올라온 한 줄. */
function row(over: Partial<PendingApprovalRow> = {}): PendingApprovalRow {
  return {
    stepId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    applicantName: "김아무개",
    kind: "NEW",
    leaveType: "ANNUAL",
    startDate: "2027-03-02",
    endDate: "2027-03-04",
    days: 3,
    ...over,
  };
}

/** 명단에 연결된 결재자. */
const MEMBER: PortalActor = {
  role: "MEMBER",
  decider: { employeeId: "emp-1", rankId: "rank-1", isApprover: true },
};

/** 계정은 있는데 명단 연결 전인 사람(확인 대기). */
const UNLINKED: PortalActor = { role: "MEMBER", decider: null };

const dialect = new PgDialect();

async function main() {
  console.log("\n포털 알림 통로\n");

  // 🔴 data.ts 는 불러오는 것만으로 DB 접속 풀을 만든다(db/index.ts). 위의
  // import 는 tsx 가 파일 맨 위로 끌어올리므로 여기서 들여온다 — 접속하지는
  // 않지만 DATABASE_URL 이 없으면 그 자리에서 던진다.
  const { myPendingApprovalWhere } = await import("../src/lib/leave/data");

  /** 결재함·알림이 함께 쓰는 조건을 실제 SQL 로 펼쳐 본다. DB 에 닿지 않는다. */
  const renderWhere = (me: { employeeId: string; rankId: string; isApprover: boolean }) =>
    dialect.sqlToQuery(myPendingApprovalWhere(me));

  /* ---------------------------------------------------------------- */
  /* 1. 🔴 토큰 — 이 검증이 「남의 알림을 볼 수 있는 문」의 전부다        */
  /* ---------------------------------------------------------------- */

  const portal = await generateKeyPair("RS256");
  const stranger = await generateKeyPair("RS256");

  /** 포털이 굽는 것과 같은 모양의 토큰. 한 가지씩 비틀어 본다. */
  async function mint(
    over: {
      key?: CryptoKey;
      issuer?: string;
      audience?: string;
      subject?: string | null;
      purpose?: string | null;
      issuedAt?: number;
      expiresAt?: number;
      nonce?: string;
    } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {};
    if (over.purpose !== null) {
      claims.purpose = over.purpose ?? PORTAL_TOKEN_PURPOSES.notificationsRead;
    }
    if (over.nonce !== undefined) claims.nonce = over.nonce;

    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(over.issuer ?? ISSUER)
      .setAudience(over.audience ?? CLIENT_ID)
      .setIssuedAt(over.issuedAt ?? now)
      .setExpirationTime(over.expiresAt ?? now + 120);
    if (over.subject !== null) jwt = jwt.setSubject(over.subject ?? SUB);

    return jwt.sign(over.key ?? portal.privateKey);
  }

  /** 실제 통로와 같은 자리에서 검증한다 — 열쇠만 가짜 포털 것이다. */
  async function verify(
    token: string | null,
    purpose: PortalTokenPurpose = PORTAL_TOKEN_PURPOSES.notificationsRead,
  ) {
    const quiet = console.error;
    console.error = () => {};
    try {
      return await verifyPortalTokenWithKey({
        token,
        key: portal.publicKey,
        issuer: ISSUER,
        audience: CLIENT_ID,
        purpose,
      });
    } finally {
      console.error = quiet;
    }
  }

  await checkAsync("바르게 구운 토큰은 통과하고, sub 을 그대로 실어 온다", async () => {
    const result = await verify(await mint());
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.subject, SUB);
  });

  await checkAsync("🔴 토큰이 없으면 거절한다", async () => {
    assert.deepEqual(await verify(null), { ok: false, reason: "missing_token" });
    assert.deepEqual(await verify(""), { ok: false, reason: "missing_token" });
  });

  await checkAsync("🔴 만료된 토큰은 거절한다", async () => {
    const now = Math.floor(Date.now() / 1000);
    // 시계 어긋남 여유(30초)보다 한참 전에 죽은 토큰.
    const result = await verify(await mint({ issuedAt: now - 600, expiresAt: now - 300 }));
    assert.deepEqual(result, { ok: false, reason: "invalid_token" });
  });

  await checkAsync("🔴 aud 가 다른 토큰은 거절한다 — 남의 시스템 것을 들이밀 수 없다", async () => {
    // 포털은 A/S 에도 같은 사람 이름으로 토큰을 굽는다. 그것이 여기서 통하면
    // 시스템 하나가 새는 순간 전부 샌다.
    const result = await verify(await mint({ audience: "rf-service-system" }));
    assert.deepEqual(result, { ok: false, reason: "invalid_token" });
  });

  await checkAsync("🔴 iss 가 다른 토큰은 거절한다", async () => {
    const result = await verify(await mint({ issuer: "http://192.168.1.10:9999" }));
    assert.deepEqual(result, { ok: false, reason: "invalid_token" });
  });

  await checkAsync("🔴 남의 열쇠로 서명한 토큰은 거절한다", async () => {
    const result = await verify(await mint({ key: stranger.privateKey }));
    assert.deepEqual(result, { ok: false, reason: "invalid_token" });
  });

  await checkAsync("🔴 용도가 다른 토큰은 거절한다 — 통로마다 다른 열쇠다", async () => {
    // 알림을 읽으려고 구운 토큰으로 설정을 고칠 수 없어야 한다(최소 권한).
    const readToken = await mint({ purpose: PORTAL_TOKEN_PURPOSES.notificationsRead });
    assert.deepEqual(await verify(readToken, PORTAL_TOKEN_PURPOSES.notificationSettingsWrite), {
      ok: false,
      reason: "wrong_purpose",
    });
    assert.deepEqual(await verify(readToken, PORTAL_TOKEN_PURPOSES.notificationSettingsRead), {
      ok: false,
      reason: "wrong_purpose",
    });
  });

  await checkAsync("🔴 용도가 아예 없는 토큰도 거절한다", async () => {
    assert.deepEqual(await verify(await mint({ purpose: null })), {
      ok: false,
      reason: "wrong_purpose",
    });
  });

  await checkAsync("🔴 nonce 가 있으면 거절한다 — 로그인 때 받은 ID 토큰의 재사용", async () => {
    assert.deepEqual(await verify(await mint({ nonce: "n-1" })), {
      ok: false,
      reason: "id_token",
    });
  });

  await checkAsync("🔴 수명이 너무 긴 토큰은 거절한다", async () => {
    const now = Math.floor(Date.now() / 1000);
    const result = await verify(
      await mint({ issuedAt: now, expiresAt: now + PORTAL_TOKEN_MAX_LIFETIME_SECONDS + 60 }),
    );
    assert.deepEqual(result, { ok: false, reason: "lifetime_too_long" });
  });

  await checkAsync("🔴 sub 이 없으면 거절한다 — 누구의 알림인지 알 수 없다", async () => {
    assert.deepEqual(await verify(await mint({ subject: null })), {
      ok: false,
      reason: "invalid_token",
    });
  });

  check("Authorization 머리말에서만 토큰을 꺼낸다", () => {
    assert.equal(readBearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
    assert.equal(readBearerToken("bearer abc.def.ghi"), "abc.def.ghi");
    assert.equal(readBearerToken("Bearer\tabc"), "abc");
    for (const bad of [null, "", "abc.def.ghi", "Basic abc", "Bearer", "Bearer a b"]) {
      assert.equal(readBearerToken(bad), null, `${String(bad)} 를 토큰으로 읽었다`);
    }
  });

  /* ---------------------------------------------------------------- */
  /* 2. 🔴 대상 사용자는 토큰 안에서만 온다                              */
  /* ---------------------------------------------------------------- */

  const notificationsRoute = withoutComments(
    read("src/app/api/integration/notifications/route.ts"),
  );
  const settingsRoute = withoutComments(
    read("src/app/api/integration/notification-settings/route.ts"),
  );

  check("🔴 알림 통로는 사람을 토큰에서만 고른다 — 쿼리·본문을 읽지 않는다", () => {
    assert.ok(notificationsRoute.includes("subject: verified.subject"));
    for (const forbidden of ["searchParams", "nextUrl", "request.json", "request.text"]) {
      assert.equal(
        notificationsRoute.includes(forbidden),
        false,
        `🔴 알림 통로가 ${forbidden} 를 읽는다 — 토큰 하나로 남의 알림을 볼 수 있다`,
      );
    }
  });

  check("🔴 설정 통로도 사람을 토큰에서만 고른다", () => {
    assert.ok(settingsRoute.includes("subject: verified.subject"));
    for (const forbidden of ["searchParams", "nextUrl"]) {
      assert.equal(settingsRoute.includes(forbidden), false, `🔴 설정 통로가 ${forbidden} 를 읽는다`);
    }
  });

  check("통로마다 제 용도의 토큰만 받는다", () => {
    assert.ok(notificationsRoute.includes("PORTAL_TOKEN_PURPOSES.notificationsRead"));
    assert.ok(settingsRoute.includes("PORTAL_TOKEN_PURPOSES.notificationSettingsRead"));
    assert.ok(settingsRoute.includes("PORTAL_TOKEN_PURPOSES.notificationSettingsWrite"));
    // 알림 통로가 설정 용도를 함께 받아 주면 최소 권한이 무너진다.
    assert.equal(notificationsRoute.includes("notificationSettings"), false);
  });

  check("거절은 401 이고, 왜 거절했는지는 밖으로 내보내지 않는다", () => {
    for (const source of [notificationsRoute, settingsRoute]) {
      assert.ok(source.includes('{ error: "invalid_token" }'));
      assert.ok(source.includes("status: 401"));
      assert.ok(source.includes('"www-authenticate": "Bearer"'));
      // reason 을 그대로 실어 보내면 부르는 쪽이 맞혀 가며 두드릴 실마리가 된다.
      assert.equal(source.includes("verified.reason"), false);
    }
  });

  check("🔴 답을 캐시하지 않는다 — 방금 처리한 일이 남의 종에 남으면 안 된다", () => {
    for (const source of [notificationsRoute, settingsRoute]) {
      assert.ok(source.includes('"cache-control": "no-store"'));
    }
  });

  check("포털 설정이 없는 PC 에서는 통로 자체가 열리지 않는다", () => {
    for (const source of [notificationsRoute, settingsRoute]) {
      assert.ok(source.includes("env.ssoConfigured"));
      assert.ok(source.includes('{ error: "not_enabled" }') || source.includes("notEnabled()"));
    }
  });

  /* ---------------------------------------------------------------- */
  /* 3. 🔴 누구에게 알리는가 — 결재함과 한 문장을 쓴다                    */
  /* ---------------------------------------------------------------- */

  check("🔴 고르는 조건이 결재함과 **한 문장**이다 — 사본이 셋이 되지 않는다", () => {
    const data = withoutComments(read("src/lib/leave/data.ts"));
    // 「이 단계가 내 것인가」는 approval-scope.ts 한 곳이 답한다.
    assert.ok(data.includes("myStepCondition(me)"), "조건이 approval-scope 를 쓰지 않는다");
    // 세 질의가 모두 그 한 문장을 부른다: 목록·건수·알림.
    const uses = data.match(/myPendingApprovalWhere\(/g) ?? [];
    assert.ok(
      uses.length >= 4,
      `myPendingApprovalWhere 를 쓰는 곳이 ${uses.length - 1}군데뿐이다 — 셋(목록·건수·알림)이어야 한다`,
    );
    // 알림 질의가 조건을 손으로 다시 적지 않았는지.
    const notify = data.slice(data.indexOf("export async function pendingApprovalNotifications"));
    assert.ok(notify.includes("myPendingApprovalWhere(me)"));
    assert.equal(
      /eq\(webApprovalSteps\.status/.test(notify),
      false,
      "🔴 알림 질의가 조건을 다시 적었다 — 결재함과 어긋날 수 있다",
    );
  });

  check("🔴 내 PENDING 단계만 고른다 — WAITING·APPROVED·SKIPPED 는 안 나온다", () => {
    const { sql, params } = renderWhere({
      employeeId: "emp-1",
      rankId: "rank-1",
      isApprover: true,
    });
    // 단계도 신청도 PENDING 이어야 한다.
    assert.equal(
      params.filter((p) => p === "PENDING").length,
      2,
      `PENDING 을 두 번 보지 않는다: ${sql}`,
    );
    for (const other of ["WAITING", "APPROVED", "REJECTED", "SKIPPED"]) {
      assert.equal(
        params.includes(other),
        false,
        `🔴 ${other} 단계까지 알림에 실린다 — 아직 내 차례가 아니거나 이미 끝난 단계다`,
      );
    }
    assert.match(sql, /"web_approval_steps"\."status" = \$\d+/);
    assert.match(sql, /"web_leave_requests"\."status" = \$\d+/);
    // 지워진 행은 어느 쪽에서도 보지 않는다.
    assert.match(sql, /"web_approval_steps"\."is_deleted" = \$\d+/);
    assert.match(sql, /"web_leave_requests"\."is_deleted" = \$\d+/);
  });

  check("🔴 남의 단계는 안 나온다 — 조건이 언제나 내 값을 묶는다", () => {
    const { sql, params } = renderWhere({
      employeeId: "emp-1",
      rankId: "rank-1",
      isApprover: true,
    });
    assert.match(sql, /"web_approval_steps"\."approver_employee_id" = \$\d+/);
    assert.ok(params.includes("emp-1"), "내 직원 id 를 묶지 않는다");
    // 옛 단계(사람 칸이 빈 행)는 예전처럼 직급으로 — 없으면 전환 순간 대기
    // 중이던 신청이 알림에서도 사라진다.
    assert.match(sql, /"web_approval_steps"\."approver_employee_id" is null/);
    assert.ok(params.includes("rank-1"));
  });

  check("직급에 결재권이 없는 사람에게는 옛 직급 단계가 가지 않는다", () => {
    const { sql, params } = renderWhere({
      employeeId: "emp-1",
      rankId: "rank-1",
      isApprover: false,
    });
    assert.equal(params.includes("rank-1"), false, `직급으로도 걸린다: ${sql}`);
    assert.ok(params.includes("emp-1"));
  });

  check("🔴 내 신청은 내 알림에 뜨지 않는다", () => {
    const { sql, params } = renderWhere({
      employeeId: "emp-1",
      rankId: "rank-1",
      isApprover: true,
    });
    assert.match(sql, /"web_leave_requests"\."employee_id" <> \$\d+/);
    assert.equal(params.filter((p) => p === "emp-1").length, 2, "제외 조건이 내가 아닌 값을 쓴다");
  });

  check("🔴 알림 줄에 사유를 싣지 않는다 — 포털을 거쳐 남의 화면에 그려진다", () => {
    const data = withoutComments(read("src/lib/leave/data.ts"));
    const notify = data.slice(
      data.indexOf("export async function pendingApprovalNotifications"),
    );
    assert.equal(notify.includes("reason"), false, "🔴 알림 질의가 사유를 읽는다");
  });

  /* ---------------------------------------------------------------- */
  /* 4. 내주는 답                                                      */
  /* ---------------------------------------------------------------- */

  /** 실제 통로와 같은 배선. DB 자리에만 가짜를 끼운다. */
  async function feed(
    actor: PortalActor | null,
    rows: PendingApprovalRow[],
  ): Promise<{ items: { id: string; href: string; subject: string; detail: string; kind: string; kindLabel: string }[]; count: number }> {
    return buildPortalNotificationFeed({
      subject: SUB,
      baseUrl: BASE_URL,
      findActor: async () => actor,
      listPendingApprovals: async () => rows,
    });
  }

  await checkAsync("🔴 개수가 목록과 같은 말을 한다 — 포털이 이 값을 그대로 쓴다", async () => {
    const two = await feed(MEMBER, [row({ stepId: "s-1" }), row({ stepId: "s-2" })]);
    assert.equal(two.items.length, 2);
    assert.equal(two.count, 2);

    const none = await feed(MEMBER, []);
    assert.deepEqual(none, { items: [], count: 0 });
  });

  await checkAsync("🔴 href 가 절대 주소다 — 남의 사이트에서 눌러도 여기로 온다", async () => {
    const { items } = await feed(MEMBER, [row()]);
    assert.equal(items[0].href, `${BASE_URL}${APPROVALS_PATH}`);
    assert.equal(new URL(items[0].href).protocol, "http:");
    assert.equal(new URL(items[0].href).port, "3700");
  });

  check("기준 주소는 redirect_uri 에서 온다 — 새 환경변수를 두지 않는다", () => {
    assert.equal(appBaseUrlFrom("http://192.168.1.10:3700/api/auth/sso/callback"), BASE_URL);
    assert.equal(appBaseUrlFrom("http://dss.example/api/auth/sso/callback"), "http://dss.example");
    // 🔴 조용히 넘어가면 링크가 …/callback/approvals 가 된다.
    assert.throws(() => appBaseUrlFrom("http://192.168.1.10:3700/"));
  });

  check("🔴 프로토콜 상대 주소를 만들지 않는다 — 남의 사이트로 가는 링크가 된다", () => {
    assert.equal(absoluteNotificationHref("//evil.example", BASE_URL), `${BASE_URL}/evil.example`);
    assert.equal(absoluteNotificationHref("/approvals", `${BASE_URL}/`), `${BASE_URL}/approvals`);
    assert.equal(absoluteNotificationHref("http://x/y", BASE_URL), "http://x/y");
    assert.throws(() => absoluteNotificationHref("/approvals", ""));
  });

  await checkAsync("한 줄에 실리는 것 — 사람 이름과 무슨 일인가, 사유는 없다", async () => {
    const { items } = await feed(MEMBER, [
      row({ applicantName: "김아무개", kind: "CHANGE", leaveType: "AM_HALF", days: 0.5 }),
    ]);
    const item = items[0];
    assert.equal(item.subject, "김아무개");
    assert.equal(item.kind, LEAVE_APPROVAL_KIND);
    // 🔴 포털은 종류 코드표를 갖지 않는다. 사람이 읽는 이름을 함께 보낸다.
    assert.equal(item.kindLabel, "휴가 결재 대기");
    assert.ok(item.detail.includes("날짜 변경"), item.detail);
    assert.ok(item.detail.includes("오전반차"), item.detail);
    assert.ok(item.detail.includes("0.5일"), item.detail);
  });

  await checkAsync("줄의 열쇠는 결재 단계 id 다 — 시스템 안에서 유일하다", async () => {
    const { items } = await feed(MEMBER, [row({ stepId: "s-1" }), row({ stepId: "s-2" })]);
    assert.deepEqual(
      items.map((item) => item.id),
      [`${LEAVE_APPROVAL_KIND}:s-1`, `${LEAVE_APPROVAL_KIND}:s-2`],
    );
  });

  await checkAsync("🔴 이 시스템에 계정이 없는 사람은 빈 목록이다 — 오류가 아니다", async () => {
    // 포털은 여러 시스템에 같은 질문을 던진다. 오류로 답하면 그 사람의 종이
    // 이 줄에서 빨개진다(dss-auth 의 gather.ts 는 200 이 아니면 실패로 친다).
    assert.deepEqual(await feed(null, [row()]), { items: [], count: 0 });
  });

  await checkAsync("명단에 연결되지 않은 계정도 빈 목록이다 — 결재할 것이 있을 수 없다", async () => {
    assert.deepEqual(await feed(UNLINKED, [row()]), { items: [], count: 0 });
  });

  await checkAsync("🔴 계정이 없으면 DB 를 두드리지도 않는다", async () => {
    let asked = false;
    const result = await buildPortalNotificationFeed({
      subject: SUB,
      baseUrl: BASE_URL,
      findActor: async () => null,
      listPendingApprovals: async () => {
        asked = true;
        return [];
      },
    });
    assert.deepEqual(result, { items: [], count: 0 });
    assert.equal(asked, false, "계정도 없는데 결재함을 뒤졌다");
  });

  check("세션의 Viewer 를 그대로 옮긴다 — 화면과 같은 「나」다", () => {
    assert.deepEqual(
      portalActorOf({
        user: { role: "LEAVE_ADMIN" },
        employee: { id: "emp-9", rankId: "rank-9" },
        isApprover: true,
      }),
      {
        role: "LEAVE_ADMIN",
        decider: { employeeId: "emp-9", rankId: "rank-9", isApprover: true },
      },
    );
    assert.deepEqual(
      portalActorOf({ user: { role: "MEMBER" }, employee: null, isApprover: false }),
      { role: "MEMBER", decider: null },
    );
  });

  /* ---------------------------------------------------------------- */
  /* 5. 알림 설정 — 내주기만 하고 바꾸지 못한다                          */
  /* ---------------------------------------------------------------- */

  check("🔴 설정은 고정 기본값이고, 역할이 **전부 잠겨** 있다", () => {
    const settings = portalNotificationSettings();

    assert.deepEqual(
      settings.roles.map((role) => role.code),
      ["MEMBER", "LEAVE_ADMIN"],
    );
    for (const role of settings.roles) {
      assert.equal(role.editable, false, `🔴 ${role.code} 줄이 열려 있다`);
      // 🔴 포털은 이 시스템의 역할 어휘를 모른다. 코드만 보내면 화면에
      //    LEAVE_ADMIN 이 그대로 찍힌다.
      assert.ok(role.label.length > 0);
      assert.notEqual(role.label, role.code);
    }

    assert.equal(settings.kinds.length, 1);
    const kind = settings.kinds[0];
    assert.equal(kind.kind, LEAVE_APPROVAL_KIND);
    assert.equal(kind.enabled, true);
    assert.equal(kind.defaultEnabled, true);
    assert.ok(kind.description.length > 0);
    // 이 알림은 역할이 아니라 결재선이 고른다 — 두 역할 모두 받는 것이 참말이다.
    assert.deepEqual(Object.keys(kind.roles).sort(), ["LEAVE_ADMIN", "MEMBER"]);
    for (const cell of Object.values(kind.roles)) {
      assert.deepEqual(cell, { receives: true, defaultReceives: true });
    }
  });

  check("🔴 응답 모양이 포털이 읽는 모양과 같다 — 칸이 하나만 빠져도 그 줄이 통째로 버려진다", () => {
    // dss-auth 의 notifications/settings.ts (parseSettingsPayload) 가 요구하는
    // 칸들이다. 저쪽은 하나라도 어긋나면 **그 시스템 전체를** 버린다.
    const settings = JSON.parse(JSON.stringify(portalNotificationSettings()));
    assert.deepEqual(Object.keys(settings).sort(), ["kinds", "roles"]);
    assert.deepEqual(Object.keys(settings.roles[0]).sort(), ["code", "editable", "label"]);
    assert.deepEqual(Object.keys(settings.kinds[0]).sort(), [
      "defaultEnabled",
      "description",
      "enabled",
      "kind",
      "label",
      "roles",
    ]);
    assert.deepEqual(Object.keys(settings.kinds[0].roles.MEMBER).sort(), [
      "defaultReceives",
      "receives",
    ]);
  });

  await checkAsync("설정을 읽으려면 이 시스템에 쓸 수 있는 계정이 있어야 한다", async () => {
    const mine = await readPortalNotificationSettings({
      subject: SUB,
      findActor: async () => MEMBER,
    });
    assert.equal(mine.ok, true);
    assert.deepEqual(mine.ok && mine.value, portalNotificationSettings());

    const stranger = await readPortalNotificationSettings({
      subject: SUB,
      findActor: async () => null,
    });
    assert.equal(stranger.ok, false);
    assert.equal(!stranger.ok && stranger.status, 403);
  });

  check("🔴 저장은 언제나 거절한다 — 본문을 읽지도 않는다", () => {
    const put = settingsRoute.slice(settingsRoute.indexOf("export async function PUT"));
    assert.ok(put.includes("status: 403"));
    assert.ok(put.includes('error: "forbidden"'));
    assert.ok(put.includes("SETTINGS_READ_ONLY_MESSAGE"));
    // 모양을 먼저 보고 400 으로 답하면 「모양만 맞추면 저장된다」는 잘못된
    // 신호가 된다. 저장할 곳 자체가 없다.
    assert.equal(put.includes("request.json"), false, "🔴 저장 통로가 본문을 읽는다");
    assert.equal(/\bdb\b/.test(put), false, "🔴 저장 통로가 DB 를 건드린다");
  });

  check("거절에 까닭을 한 줄 싣는다 — 포털이 그 글자를 그대로 사람에게 보여 준다", () => {
    const source = read("src/lib/leave/portal-notifications.ts");
    const message = source.match(/SETTINGS_READ_ONLY_MESSAGE =\s*\n?\s*"([^"]+)"/);
    assert.ok(message, "거절 문구를 찾지 못했다");
    assert.ok(message[1].length > 10);
  });

  /* ---------------------------------------------------------------- */
  /* 6. 스키마를 건드리지 않았다                                        */
  /* ---------------------------------------------------------------- */

  check("🔴 알림을 저장하지 않는다 — 표도 마이그레이션도 늘지 않았다", () => {
    // 이 체계의 전제다(dss-auth/docs/사이트-알림-통로.md): 아무도 알림을
    // 저장하지 않고 물어볼 때마다 계산한다. 표가 생기는 순간 「처리하면
    // 사라진다」를 손으로 지켜야 한다.
    const schema = read("src/lib/db/schema.ts");
    for (const forbidden of ["webNotification", "web_notification"]) {
      assert.equal(schema.includes(forbidden), false, `🔴 스키마에 ${forbidden} 가 생겼다`);
    }
  });

  console.log(`\n${passed}개 통과`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
