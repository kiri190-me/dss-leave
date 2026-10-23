/**
 * 통합 승인함 통로 검사.  npm run test:approvals
 *
 * 🔴 DB 에 닿지 않고 바깥 망에도 나가지 않는다. 포털의 서명 열쇠 노릇은 이
 * 검사가 직접 만든 RSA 열쇠가 한다(test-portal-notifications.ts 와 같은 방식).
 * 토큰 검증의 암호 기계 자체(서명·만료·수명·purpose·nonce)는 그 파일이 이미
 * `verifyPortalTokenWithKey` 하나로 실제로 돌려 못 박았다 — 여기서 다시 돌리지
 * 않는다(바뀌지 않은 공용 로직을 또 재는 것은 이 저장소 CLAUDE.md 의 작업 효율
 * 규칙과도 어긋난다). 이 파일이 새로 재는 것은:
 *   1. 이 라우트가 그 검증을 **먼저** 부르고, 쓰임새는 알림 읽기 그대로인가
 *      (소스 글자로 — 라우트는 요청 맥락·DB 가 필요해 직접 불러 볼 수 없다,
 *      test-portal-notifications.ts 와 같은 한계).
 *   2. 승인함만의 새 판단 — leave/portal-approvals.ts 의 buildPortalApprovalInbox —
 *      은 **DB 없이 실제로 돌려** 잰다.
 *
 * ── 승인함이 흐르는 길 ──────────────────────────────────────────────────
 *   통합 승인함이 이 시스템에 묻는다
 *     → GET /api/integration/approvals   (Authorization: Bearer 서명 토큰)
 *     → 토큰의 sub(포털 users.id)로 web_users.auth_sub 를 되짚고
 *     → 결재함과 **같은 조건**으로 「지금 내 차례인 신청」을 건별로 내준다
 *     → 통합 승인함이 [승인하기] 단추마다 href 로 이 시스템의 그 줄로 보낸다
 *
 * 🔴 왜 전부 main() 안에 있나: 이 저장소의 검사는 tsx 가 CJS 로 돌려
 * (package.json 에 type:module 이 없다) 최상위 await 을 쓸 수 없다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 🔴 .env.local 을 읽지 않는다 — test-portal-notifications.ts 와 같은 이유로,
// auto 로 두면 Wi-Fi 상태에 따라 결과가 달라진다.
process.env.SSO_ISSUER = "http://192.168.1.10:3100";
process.env.SSO_CLIENT_ID = "dss-leave";
process.env.SSO_CLIENT_SECRET = "테스트용-시크릿";
process.env.SSO_REDIRECT_URI = "http://192.168.1.10:3700/api/auth/sso/callback";
process.env.SSO_TX_SECRET = "0123456789abcdef0123456789abcdef";
process.env.DATABASE_URL = "postgres://nobody:nobody@127.0.0.1:1/none";

import { SignJWT, generateKeyPair, type CryptoKey } from "jose";

import {
  PORTAL_TOKEN_PURPOSES,
  verifyPortalTokenWithKey,
  type PortalTokenPurpose,
} from "../src/lib/auth/portal-service-token";
import { APPROVALS_PATH, type PortalActor } from "../src/lib/leave/portal-notifications";
import {
  LEAVE_REQUEST_APPROVAL_KIND,
  LEAVE_REQUEST_APPROVAL_KIND_LABEL,
  buildPortalApprovalInbox,
} from "../src/lib/leave/portal-approvals";
import type { PendingApprovalForPortal } from "../src/lib/leave/data";

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

/** 결재함에서 올라온 한 줄(가짜 값 — 실명·고객사 없음). */
function row(over: Partial<PendingApprovalForPortal> = {}): PendingApprovalForPortal {
  return {
    stepId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    applicantName: "김아무개",
    kind: "NEW",
    leaveType: "ANNUAL",
    startDate: "2027-03-02",
    endDate: "2027-03-04",
    days: 3,
    requestedAt: new Date("2027-02-01T00:00:00.000Z"),
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

async function main() {
  console.log("\n통합 승인함 통로\n");

  const approvalsRoute = withoutComments(read("src/app/api/integration/approvals/route.ts"));

  /* ---------------------------------------------------------------- */
  /* 1. 라우트 배선 — 소스 글자로 못 박는다 (실제로 불러 볼 수 없다)        */
  /* ---------------------------------------------------------------- */

  check("🔴 토큰 검증이 먼저다 — 실패하면 401 로 끝나고 조회에 닿지 않는다", () => {
    const verifyAt = approvalsRoute.indexOf("await verifyPortalServiceToken(");
    const rejectAt = approvalsRoute.indexOf("if (!verified.ok) {");
    const workAt = approvalsRoute.indexOf("buildPortalApprovalInbox({");
    assert.ok(verifyAt > 0, "검증하는 자리를 찾지 못했다");
    assert.ok(rejectAt > verifyAt, "검증 결과를 확인하지 않는다");
    assert.ok(workAt > rejectAt, "거절하기 전에 결재 목록을 뽑는다");
    assert.match(approvalsRoute, /status: 401/);
  });

  check("🔴 대상 사용자는 토큰에서만 온다 — ?sub= 를 붙여도 읽을 자리가 없다", () => {
    // 가장 중요한 울타리다. 뚫리면 토큰 하나로 아무의 결재함이나 열린다.
    for (const forbidden of [
      "searchParams",
      "nextUrl",
      "?sub=",
      'get("sub")',
      "params.sub",
      "request.json",
      "request.text",
    ]) {
      assert.ok(!approvalsRoute.includes(forbidden), `부르는 쪽이 대상을 고를 자리가 있다: ${forbidden}`);
    }
    assert.match(approvalsRoute, /subject: verified\.subject/);
  });

  check("쓰임새가 다른 토큰은 거절된다 — 알림 읽기 용도를 요구한다", () => {
    assert.match(approvalsRoute, /PORTAL_TOKEN_PURPOSES\.notificationsRead/);
    for (const forbidden of ["notificationSettingsRead", "notificationSettingsWrite"]) {
      assert.ok(!approvalsRoute.includes(forbidden), `설정용 토큰을 받는다: ${forbidden}`);
    }
  });

  check("기준 주소는 환경에서 온다 — Host 머리말을 읽지 않는다", () => {
    assert.match(approvalsRoute, /baseUrl: env\.appBaseUrl/);
    for (const forbidden of ['headers.get("host")', '"x-forwarded-host"', "request.url"]) {
      assert.ok(!approvalsRoute.includes(forbidden), `부르는 쪽이 정하는 주소를 쓴다: ${forbidden}`);
    }
  });

  check("🔴 읽기 전용이다 — 승인·반려를 실행하는 길이 없다", () => {
    for (const method of [
      "export async function POST",
      "export async function PUT",
      "export async function PATCH",
      "export async function DELETE",
    ]) {
      assert.ok(!approvalsRoute.includes(method), `쓰는 메서드가 생겼다: ${method}`);
    }
    assert.match(approvalsRoute, /export async function GET/);
  });

  check("응답이 캐시되지 않는다", () => {
    assert.match(approvalsRoute, /"cache-control": "no-store"/);
  });

  check("포털 설정이 없는 PC 에서는 통로 자체가 열리지 않는다", () => {
    assert.ok(approvalsRoute.includes("env.ssoConfigured"));
    assert.ok(approvalsRoute.includes('{ error: "not_enabled" }'));
  });

  check("🔴 자격 판정을 새로 쓰지 않는다 — 결재함과 같은 조건의 조회를 그대로 넘긴다", () => {
    assert.match(approvalsRoute, /listPendingApprovals: pendingApprovalsForPortal/);
    for (const forbidden of ["db.select", "drizzle-orm", "eq(webApprovalSteps"]) {
      assert.ok(!approvalsRoute.includes(forbidden), `라우트가 직접 질의를 쓴다: ${forbidden}`);
    }

    const data = withoutComments(read("src/lib/leave/data.ts"));
    const portal = data.slice(data.indexOf("export async function pendingApprovalsForPortal"));
    assert.ok(portal.includes("myPendingApprovalWhere(me)"), "승인함 조회가 공용 조건을 안 쓴다");
    assert.equal(
      /eq\(webApprovalSteps\.status/.test(portal),
      false,
      "🔴 승인함 조회가 조건을 손으로 다시 적었다 — 결재함·알림과 어긋날 수 있다",
    );
  });

  /* ---------------------------------------------------------------- */
  /* 2. 알림 읽기 용도의 토큰으로 실제로 검증된다 (암호 기계 자체는        */
  /*    test-portal-notifications.ts 가 이미 못 박았으니 한 번만 더 본다)  */
  /* ---------------------------------------------------------------- */

  const portal = await generateKeyPair("RS256");

  async function mint(purpose: string | null = PORTAL_TOKEN_PURPOSES.notificationsRead) {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {};
    if (purpose !== null) claims.purpose = purpose;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setSubject(SUB)
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .sign(portal.privateKey as CryptoKey);
  }

  async function verify(token: string) {
    const quiet = console.error;
    console.error = () => {};
    try {
      return await verifyPortalTokenWithKey({
        token,
        key: portal.publicKey,
        issuer: ISSUER,
        audience: CLIENT_ID,
        purpose: PORTAL_TOKEN_PURPOSES.notificationsRead as PortalTokenPurpose,
      });
    } finally {
      console.error = quiet;
    }
  }

  await checkAsync("🔴 토큰 없이는(검증 실패로) 통로가 열리지 않는다", async () => {
    const result = await verify(await mint(PORTAL_TOKEN_PURPOSES.notificationSettingsWrite));
    assert.deepEqual(result, { ok: false, reason: "wrong_purpose" });
  });

  await checkAsync("쓰임새가 맞는 토큰은 통과하고, sub 을 그대로 실어 온다", async () => {
    const result = await verify(await mint());
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.subject, SUB);
  });

  /* ---------------------------------------------------------------- */
  /* 3. buildPortalApprovalInbox — DB 없이 실제로 돌려 본다               */
  /* ---------------------------------------------------------------- */

  await checkAsync("🔴 이 시스템에 계정이 없는 사람은 빈 목록이다 — 오류가 아니다", async () => {
    const inbox = await buildPortalApprovalInbox({
      subject: SUB,
      baseUrl: BASE_URL,
      findActor: async () => null,
      listPendingApprovals: async () => [row()],
    });
    assert.deepEqual(inbox, { items: [], count: 0 });
  });

  await checkAsync(
    "🔴 계정은 있는데 명단에 연결되지 않은 사람은 빈 목록과 구별되는 답을 받는다",
    async () => {
      const inbox = await buildPortalApprovalInbox({
        subject: SUB,
        baseUrl: BASE_URL,
        findActor: async () => UNLINKED,
        listPendingApprovals: async () => [row()],
      });
      assert.deepEqual(inbox, { items: [], count: 0, unavailable: "employee_not_linked" });
    },
  );

  await checkAsync("명단 미연결이면 결재함 질의를 두드리지도 않는다", async () => {
    let asked = false;
    await buildPortalApprovalInbox({
      subject: SUB,
      baseUrl: BASE_URL,
      findActor: async () => UNLINKED,
      listPendingApprovals: async () => {
        asked = true;
        return [];
      },
    });
    assert.equal(asked, false, "명단에 연결되지 않았는데 결재함을 뒤졌다");
  });

  await checkAsync("결재할 차례가 아닌 사람에게는 빈 목록이다", async () => {
    // myPendingApprovalWhere 가 SQL 에서 이미 걸러 준다(test-portal-notifications.ts
    // 가 그 조건을 렌더해 못 박는다). 여기서는 그 조회가 빈 배열을 돌려줄 때
    // 이 통로가 올바르게 빈 답을 내는지만 본다 — 조건은 한 곳이지 둘이 아니다.
    const inbox = await buildPortalApprovalInbox({
      subject: SUB,
      baseUrl: BASE_URL,
      findActor: async () => MEMBER,
      listPendingApprovals: async () => [],
    });
    assert.deepEqual(inbox, { items: [], count: 0 });
  });

  await checkAsync("결재할 차례인 사람에게는 줄이 나오고, 개수가 줄 수와 같다", async () => {
    const inbox = await buildPortalApprovalInbox({
      subject: SUB,
      baseUrl: BASE_URL,
      findActor: async () => MEMBER,
      listPendingApprovals: async () => [row({ stepId: "s-1" }), row({ stepId: "s-2" })],
    });
    assert.equal(inbox.count, 2);
    assert.equal(inbox.items.length, 2);
    assert.equal(inbox.unavailable, undefined);
    assert.deepEqual(
      inbox.items.map((item) => item.id),
      [`${LEAVE_REQUEST_APPROVAL_KIND}:s-1`, `${LEAVE_REQUEST_APPROVAL_KIND}:s-2`],
    );
  });

  await checkAsync("🔴 href 가 절대 주소다 — 그 신청 하나가 선 줄로 바로 간다", async () => {
    const inbox = await buildPortalApprovalInbox({
      subject: SUB,
      baseUrl: BASE_URL,
      findActor: async () => MEMBER,
      listPendingApprovals: async () => [row({ stepId: "s-9" })],
    });
    const href = inbox.items[0].href;
    assert.equal(href, `${BASE_URL}${APPROVALS_PATH}#approval-s-9`);
    assert.equal(new URL(href.split("#")[0]).protocol, "http:");
    assert.equal(new URL(href.split("#")[0]).port, "3700");
  });

  await checkAsync("🔴 requestedAt 이 ISO 8601 이다", async () => {
    const inbox = await buildPortalApprovalInbox({
      subject: SUB,
      baseUrl: BASE_URL,
      findActor: async () => MEMBER,
      listPendingApprovals: async () => [row({ requestedAt: new Date("2027-01-02T03:04:05.000Z") })],
    });
    assert.equal(inbox.items[0].requestedAt, "2027-01-02T03:04:05.000Z");
  });

  await checkAsync("subject 는 누구의 무슨 휴가인가, detail 은 기간·일수다", async () => {
    const inbox = await buildPortalApprovalInbox({
      subject: SUB,
      baseUrl: BASE_URL,
      findActor: async () => MEMBER,
      listPendingApprovals: async () => [
        row({ applicantName: "김아무개", kind: "CHANGE", leaveType: "AM_HALF", days: 0.5 }),
      ],
    });
    const item = inbox.items[0];
    assert.ok(item.subject.includes("김아무개"), item.subject);
    assert.ok(item.subject.includes("오전반차"), item.subject);
    assert.ok(item.subject.includes("날짜 변경"), item.subject);
    assert.equal(item.kind, "LEAVE_REQUEST");
    assert.equal(item.kindLabel, LEAVE_REQUEST_APPROVAL_KIND_LABEL);
    assert.ok(item.detail.includes("0.5일"), item.detail);
    // 🔴 사유를 싣지 않는다 — 다른 시스템 화면에 그려지는 줄이다.
    assert.ok(!("reason" in item));
  });

  console.log(`\n${passed}개 통과`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
