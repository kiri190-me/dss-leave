/**
 * 결재 **내역 통로** 검사.  npm run test:approval-history-api
 *
 * 🔴 DB 에 닿지 않고 바깥 망에도 나가지 않는다. 포털의 서명 열쇠 노릇은 이
 * 검사가 직접 만든 RSA 열쇠가 한다(test-portal-approvals.ts 와 같은 방식).
 * 토큰 검증의 암호 기계 자체는 test-portal-notifications.ts 가 이미
 * `verifyPortalTokenWithKey` 하나로 실제로 돌려 못 박았다 — 여기서 다시 돌리지
 * 않고, 이 통로가 **그 검증을 쓰는지**와 쓰임새 글자만 본다.
 *
 * ── 조각 10b 가 새로 재는 것 ────────────────────────────────────────────
 *   1. 🔴 **기간 파싱** — 둘 다 필수 · 반열린 구간 · 시간대 없는 글자는 거절 ·
 *      🔴 **쿼리에서 읽는 열쇠가 기간 둘뿐**(사람을 쿼리로 못 고른다)
 *   2. 🔴 **이름 옮기기** — 이 집의 `BY_OTHER` 가 계약의 `BY_DELEGATE` 다.
 *      어긋나도 **오류가 안 나는** 자리라 세 값이 각각 무엇으로 나가는지 못 박는다
 *   3. 🔴 **상대 이름이 갈래마다 반대 칸**이다 — 바꿔 적어도 오류가 안 난다
 *   4. 🔴 **열쇠 두 단이 끊기면 빈 목록** — 오류를 뱉으면 포털이 모으는 다른
 *      두 집까지 못 그릴 수 있다
 *   5. 라우트 배선 — 토큰이 **먼저**, 기간이 그 다음, 기준 주소는 환경에서
 *
 * 🔴 조각 10a(조회·색인)는 scripts/test-approval-history.ts 가 따로 지킨다.
 * 🔴 왜 전부 main() 안에 있나: 이 저장소의 검사는 tsx 가 CJS 로 돌려
 * (package.json 에 type:module 이 없다) 최상위 await 을 쓸 수 없다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 🔴 .env.local 을 읽지 않는다 — auto 로 두면 Wi-Fi 상태에 따라 결과가 달라진다.
//    DATABASE_URL 은 **아무 데도 붙지 않는 주소**다(이 검사는 DB 를 안 부른다).
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
import {
  APPROVAL_HISTORY_ROLES,
  type ApprovalHistoryRole,
} from "../src/lib/leave/approval-history";
import {
  APPROVAL_HISTORY_PERIOD_ERROR,
  APPROVAL_HISTORY_PERIOD_PARAMS,
  APPROVAL_HISTORY_RELATIONS,
  APPROVAL_HISTORY_RELATION_OF_ROLE,
  approvalHistoryRelationOf,
  buildPortalApprovalHistory,
  parseApprovalHistoryPeriod,
  toApprovalHistoryEntry,
  type ApprovalHistoryEntry,
  type ApprovalHistoryRelation,
} from "../src/lib/leave/portal-approval-history";
import { LEAVE_REQUEST_APPROVAL_KIND } from "../src/lib/leave/portal-approvals";
import type { PortalActor } from "../src/lib/leave/portal-notifications";
import type { ApprovalHistoryRange, ApprovalHistoryRow } from "../src/lib/leave/data";

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

/** 주석을 걷어 낸 코드. 🔴 주석에 적힌 낱말이 검사를 통과시키지 않게. */
function withoutComments(source: string): string {
  const out = source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // 🔵 표본이 비어서 공짜로 통과하는 일이 없게.
  assert.ok(out.trim().length > 0, "주석을 떼고 나니 아무것도 안 남았다 — 떼는 규칙이 더는 안 맞는다");
  return out;
}

const ROUTE = "src/app/api/integration/approval-history/route.ts";
const JUDGE = "src/lib/leave/portal-approval-history.ts";

const ISSUER = "http://192.168.1.10:3100";
const CLIENT_ID = "dss-leave";
const BASE_URL = "http://192.168.1.10:3700";

/* ------------------------------------------------------------------ */
/* 가짜 값 — 🔴 실제 이름·사번을 한 자도 넣지 않는다                     */
/* ------------------------------------------------------------------ */

/** 포털에 등록된 사람의 sub(포털 users.id)와 같은 모양. */
const SUB = "11111111-2222-4333-8444-555555555555";

/** 🔴 보는 사람의 **명단 번호**. 계정 번호도 포털 번호도 아니다. */
const ME_EMPLOYEE_ID = "emp-나";

/** 🔴 셋이 서로 다른 글자여야 상대 이름을 바꿔 적은 것이 드러난다. */
const 내_이름 = "나아무개";
const 주인_이름 = "맡긴아무개";
const 대리_이름 = "대신아무개";
const 신청자_이름 = "신청아무개";

/** 2026-11-01 00:00 ~ 2026-12-01 00:00 (UTC). 경계를 그대로 보려고 UTC 로 적는다. */
const FROM_TEXT = "2026-11-01T00:00:00.000Z";
const TO_TEXT = "2026-12-01T00:00:00.000Z";

/** 명단에 연결된 사람. */
const MEMBER: PortalActor = {
  role: "MEMBER",
  decider: { employeeId: ME_EMPLOYEE_ID, rankId: "rank-1", isApprover: true },
};

/** 계정은 있는데 명단 연결 전인 사람(확인 대기). */
const UNLINKED: PortalActor = { role: "MEMBER", decider: null };

/** 내역 조회가 올려 주는 한 줄(가짜 값). 기본은 「내가 직접 누른 승인」. */
function row(over: Partial<ApprovalHistoryRow> = {}): ApprovalHistoryRow {
  return {
    stepId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    requestId: "11111111-1111-4111-8111-111111111111",
    stepNo: 2,
    status: "APPROVED",
    decidedAt: new Date("2026-11-10T01:02:03.000Z"),
    comment: null,
    role: "SELF",
    approverName: 내_이름,
    decidedByName: 내_이름,
    applicantName: 신청자_이름,
    kind: "NEW",
    leaveType: "ANNUAL",
    startDate: "2026-11-23",
    endDate: "2026-11-25",
    days: 3,
    requestStatus: "APPROVED",
    ...over,
  };
}

/** 「내가 남의 자리를 대신 눌렀다」 한 줄. */
const 대신한_줄 = row({ role: "ON_BEHALF", approverName: 주인_이름, decidedByName: 내_이름 });
/** 「내 자리를 남이 눌렀다」 한 줄. */
const 대신당한_줄 = row({ role: "BY_OTHER", approverName: 내_이름, decidedByName: 대리_이름 });

function query(text: string): URLSearchParams {
  return new URLSearchParams(text);
}

async function main() {
  console.log("\n결재 내역 통로 — 포털이 세 집을 모은다\n");

  const route = withoutComments(read(ROUTE));
  const judge = withoutComments(read(JUDGE));

  /* ---------------------------------------------------------------- */
  /* 1. 기간 파싱 — 🔴 **값으로 실제로 돌린다**                          */
  /* ---------------------------------------------------------------- */

  check("바르게 적은 기간은 읽힌다 — 🔵 먼저 이것부터(공짜 통과 방지)", () => {
    const parsed = parseApprovalHistoryPeriod(query(`from=${FROM_TEXT}&to=${TO_TEXT}`));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.from.toISOString(), FROM_TEXT);
    assert.equal(parsed.ok && parsed.to.toISOString(), TO_TEXT);
  });

  check("🔴 경계 값이 그대로 간다 — 통로가 날짜를 혼자 밀지 않는다", () => {
    // 🔴 자르는 일은 조회가 한다(`from <= decided_at < to`). 여기서 하루를
    //    더하거나 빼면 **조회와 통로가 서로 다른 구간**을 말하게 된다.
    const parsed = parseApprovalHistoryPeriod(query(`from=${FROM_TEXT}&to=${TO_TEXT}`));
    assert.ok(parsed.ok);
    assert.equal(parsed.from.getTime(), Date.parse(FROM_TEXT));
    assert.equal(parsed.to.getTime(), Date.parse(TO_TEXT));
  });

  check("🔴 `to` 그 순간은 **안 들어간다** — 반열린 구간이라 이어 붙여도 겹치지 않는다", () => {
    // 11월과 12월을 **이어 붙여** 물었을 때 12월 1일 0시가 양쪽에 두 번
    // 들어가면 안 된다. 그것을 지키는 것은 조회의 `<` 이고(10a), 이 검사는
    // 두 구간의 경계가 **같은 값**으로 이어진다는 것을 본다.
    const 앞 = parseApprovalHistoryPeriod(query(`from=${FROM_TEXT}&to=${TO_TEXT}`));
    const 뒤 = parseApprovalHistoryPeriod(query(`from=${TO_TEXT}&to=2027-01-01T00:00:00.000Z`));
    assert.ok(앞.ok && 뒤.ok);
    assert.equal(앞.to.getTime(), 뒤.from.getTime());
    const 조회 = withoutComments(read("src/lib/leave/data.ts"));
    assert.ok(
      조회.includes("lt(webApprovalSteps.decidedAt, range.to)"),
      "🔴 조회의 끝이 더는 열려 있지 않다 — 경계가 두 구간에 두 번 들어간다",
    );
  });

  check("🔴 하나라도 없으면 거절한다 — 기간은 **필수**다", () => {
    for (const text of ["", `from=${FROM_TEXT}`, `to=${TO_TEXT}`]) {
      const parsed = parseApprovalHistoryPeriod(query(text));
      assert.deepEqual(parsed, { ok: false, error: "invalid_period" }, text);
    }
    assert.equal(APPROVAL_HISTORY_PERIOD_ERROR, "invalid_period");
  });

  check("🔴 못 읽거나 **모양이 다른** 글자는 거절한다 — 조용히 「전체 기간」이 되지 않는다", () => {
    // 🔴 `11/01/2026` 은 `Date` 가 **읽는다**(2026-11-17 실측: 이 PC 에서
    //    2026-10-31T15:00:00.000Z). 월·일 차례가 나라마다 반대라 그대로 받으면
    //    11월 1일이 될지 1월 11일이 될지가 기계 설정에 달린다 — 모양 검사가
    //    막는 것이 그것이다. 나머지 셋은 `Date` 도 못 읽는다.
    for (const bad of ["어제", "2026-13-45T00:00:00Z", "11/01/2026", "", "   "]) {
      const parsed = parseApprovalHistoryPeriod(query(`from=${encodeURIComponent(bad)}&to=${TO_TEXT}`));
      assert.equal(parsed.ok, false, `거르지 못했다: ${bad}`);
    }
  });

  check("🔴 `0`·`2026` 이 **26년치 기간**으로 읽히지 않는다 — `Date` 혼자서는 못 거른다", () => {
    // 🔴 2026-11-17 실측: `new Date("0")` 은 NaN 이 **아니다**(한국 시간
    //    2000-01-01 = 1999-12-31T15:00:00.000Z 로 읽힌다). `"2026"` 도
    //    2026-01-01 이 된다. `Number.isNaN` 만 믿으면 `?from=0` 이 조용히
    //    통과하고 **오류도 목록 비는 것도 없다.** 그래서 모양을 먼저 본다.
    for (const bad of ["0", "2026", "2026-11", "1762000000"]) {
      // 🔵 먼저 「이 글자가 Date 에는 읽힌다」를 못 박는다 — 그래야 이 검사가
      //    무엇을 막고 있는지가 드러난다(공짜 통과 방지).
      if (bad !== "1762000000") {
        assert.ok(!Number.isNaN(new Date(bad).getTime()), `Date 가 ${bad} 를 거절한다 — 전제가 바뀌었다`);
      }
      const parsed = parseApprovalHistoryPeriod(query(`from=${encodeURIComponent(bad)}&to=${TO_TEXT}`));
      assert.equal(parsed.ok, false, `모양 검사를 뚫었다: ${bad}`);
    }
  });

  check("🔴 **시간대가 없는 글자**는 거절한다 — 개발 PC(KST)와 컨테이너(UTC)가 아홉 시간 어긋난다", () => {
    // 🔴 2026-11-17 실측(이 PC): `new Date("2026-11-01T00:00:00")` 은
    //    `2026-10-31T15:00:00.000Z` 다 — **그 기계의 지역 시간**으로 읽힌다.
    //    날짜만 적은 `2026-11-01` 은 규격상 **UTC 자정**(= 한국 오전 9시)이라
    //    첫날 아홉 시간이 조용히 빠진다. 둘 다 오류가 안 나서 「월말 하루치가
    //    안 보인다」로만 나타나는 종류다.
    // 🔴 세 집(A/S·재고관리·휴가)이 이 규칙으로 맞췄다(2026-11-17) —
    //    풀려면 세 집을 함께 푼다.
    for (const bad of ["2026-11-01T00:00:00", "2026-11-01", "2026-11-01T00:00"]) {
      // 🔵 먼저 「`Date` 는 이것을 읽는다」를 못 박는다 — 이 검사가 무엇을 막고
      //    있는지가 드러나야 한다(공짜 통과 방지).
      assert.ok(!Number.isNaN(new Date(bad).getTime()), `Date 가 ${bad} 를 거절한다 — 전제가 바뀌었다`);
      const parsed = parseApprovalHistoryPeriod(query(`from=${encodeURIComponent(bad)}&to=${TO_TEXT}`));
      assert.equal(parsed.ok, false, `시간대 없는 글자가 읽혔다: ${bad}`);
    }
    // 🔵 `Z` 말고 **오프셋**으로 적은 것은 받는다 — 가리키는 순간이 하나다.
    const 오프셋 = parseApprovalHistoryPeriod(
      query(`from=${encodeURIComponent("2026-11-01T09:00:00+09:00")}&to=${TO_TEXT}`),
    );
    assert.ok(오프셋.ok);
    assert.equal(오프셋.from.toISOString(), FROM_TEXT, "오프셋을 안 풀었다");
  });

  check("🔵 **넘치는 날짜는 안 막는다** — 알고 두는 구멍이다(세 집을 함께 좁히기 전까지)", () => {
    // 🔴 2026-11-17 실측: `new Date("2026-02-30T00:00:00Z")` 는 NaN 이 **아니라**
    //    `2026-03-02T00:00:00.000Z` 다. 모양 검사도 `\d{2}` 라 통과시킨다 —
    //    **둘 다 안 막는다.** 이 줄은 그 사실을 못 박아, 나중에 누가 「넘치는
    //    날짜는 Date 가 걸러 준다」고 적는 것을 막는다.
    const parsed = parseApprovalHistoryPeriod(
      query(`from=${encodeURIComponent("2026-02-30T00:00:00Z")}&to=${TO_TEXT}`),
    );
    assert.equal(parsed.ok, true, "넘치는 날짜를 막기 시작했다 — 세 집을 함께 고쳤나");
    assert.equal(parsed.ok && parsed.from.toISOString(), "2026-03-02T00:00:00.000Z");
    // 🔵 자릿수를 벗어난 값은 막힌다 — 위 검사가 그것을 따로 본다.
    assert.ok(Number.isNaN(new Date("2026-13-45T00:00:00Z").getTime()));
  });

  check("🔵 뒤집힌 구간은 **거절하지 않고 바꿔 끼우지도 않는다** — 세 집이 같은 답을 해야 한다", () => {
    // 계약이 400 을 주라고 적은 것은 「없거나 못 읽을 때」 하나뿐이다. 계약에 없는
    // 400 을 이 집만 내면 포털이 그것을 **이 집의 고장**으로 읽는다.
    // 🔴 뒤집으려면 세 집(A/S·재고관리·휴가)을 함께 고친다.
    const parsed = parseApprovalHistoryPeriod(query(`from=${TO_TEXT}&to=${FROM_TEXT}`));
    assert.equal(parsed.ok, true);
    // 🔴 친절하게 바꿔 끼우면 부르는 쪽의 실수가 **그럴듯한 답**으로 덮인다.
    assert.ok(parsed.ok && parsed.from.getTime() > parsed.to.getTime(), "from·to 를 바꿔 끼웠다");
  });

  check("🔴 쿼리에서 읽는 열쇠가 **기간 둘뿐**이다 — 사람을 쿼리로 고를 자리가 없다", () => {
    // 🔴 가장 중요한 울타리다. 뚫리면 토큰 하나로 **아무의 결재 내역이나** 열린다.
    const keys = [...judge.matchAll(/\.get\("([^"]+)"\)/g)].map((m) => m[1]);
    assert.deepEqual(keys, ["from", "to"], `쿼리에서 읽는 열쇠: ${keys.join(", ")}`);
    assert.deepEqual([...APPROVAL_HISTORY_PERIOD_PARAMS], keys, "적어 둔 목록과 실제가 다르다");
  });

  check("🔴 라우트도 쿼리에서 사람을 안 읽는다 — 기간은 판단 쪽 한 곳에서만 읽는다", () => {
    for (const forbidden of [
      'get("sub")',
      "params.sub",
      "employeeId",
      "employee_id",
      "request.json",
      "request.text",
      "searchParams.get",
    ]) {
      assert.ok(!route.includes(forbidden), `부르는 쪽이 대상을 고를 자리가 있다: ${forbidden}`);
    }
    assert.match(route, /subject: verified\.subject/);
    assert.match(route, /parseApprovalHistoryPeriod\(request\.nextUrl\.searchParams\)/);
  });

  /* ---------------------------------------------------------------- */
  /* 2. 이름 옮기기 — 🔴 어긋나도 **오류가 안 나는** 자리                */
  /* ---------------------------------------------------------------- */

  check("🔴 세 갈래가 각각 계약의 낱말로 나간다 — `BY_OTHER` 가 `BY_DELEGATE` 다", () => {
    // 🔵 표본이 비어 공짜로 통과하지 않게 먼저 「무엇을 재는지」를 못 박는다.
    assert.equal(APPROVAL_HISTORY_ROLES.length, 3);
    const moved = APPROVAL_HISTORY_ROLES.map((r: ApprovalHistoryRole) =>
      APPROVAL_HISTORY_RELATION_OF_ROLE[r],
    );
    assert.deepEqual(moved, ["SELF", "ON_BEHALF", "BY_DELEGATE"]);
    assert.equal(new Set(moved).size, 3, "🔴 둘 이상이 한 값으로 뭉갰다 — 가르는 뜻이 사라졌다");
  });

  check("🔴 옮기는 표가 갈래를 **빠짐없이** 덮는다 — 늘어나는 날 조용히 빠지지 않게", () => {
    for (const role of APPROVAL_HISTORY_ROLES) {
      const moved: ApprovalHistoryRelation | undefined = APPROVAL_HISTORY_RELATION_OF_ROLE[role];
      assert.ok(moved !== undefined, `${role} 가 표에 없다`);
      assert.ok(APPROVAL_HISTORY_RELATIONS.includes(moved), `계약에 없는 값이다: ${moved}`);
    }
    assert.equal(Object.keys(APPROVAL_HISTORY_RELATION_OF_ROLE).length, APPROVAL_HISTORY_ROLES.length);
  });

  check("계약의 네 낱말이 그대로다 — 포털이 이 글자로 가른다", () => {
    assert.deepEqual(
      [...APPROVAL_HISTORY_RELATIONS],
      ["SELF", "ON_BEHALF", "BY_DELEGATE", "UNKNOWN"],
    );
  });

  check("🔴 누른 사람이 **안 적힌 줄**만 `UNKNOWN` 이다 — 이름 없는 「남이 결재」를 안 만든다", () => {
    // 🔵 이 집에서는 나오지 않는다(조회가 상태를 승인·반려로 좁히고, 누른 사람
    //    칸을 비우는 길은 건너뛰기뿐이다). 그 조건이 풀리는 날 **상대 이름 없는
    //    「남이 결재」**가 나가는 것을 막는다.
    assert.equal(approvalHistoryRelationOf({ role: "BY_OTHER", decidedByName: null }), "UNKNOWN");
    assert.equal(approvalHistoryRelationOf({ role: "BY_OTHER", decidedByName: 대리_이름 }), "BY_DELEGATE");
    // 🔴 내가 누른 갈래는 이름이 비어도 `UNKNOWN` 이 아니다 — 누른 사람이 나다.
    assert.equal(approvalHistoryRelationOf({ role: "SELF", decidedByName: null }), "SELF");
    assert.equal(approvalHistoryRelationOf({ role: "ON_BEHALF", decidedByName: null }), "ON_BEHALF");
  });

  /* ---------------------------------------------------------------- */
  /* 3. 한 줄의 모양 — 🔴 상대가 갈래마다 **반대 칸**이다                */
  /* ---------------------------------------------------------------- */

  const 직접 = toApprovalHistoryEntry(row(), BASE_URL);
  const 대신 = toApprovalHistoryEntry(대신한_줄, BASE_URL);
  const 당함 = toApprovalHistoryEntry(대신당한_줄, BASE_URL);

  check("🔴 내가 **직접** 누른 줄 — 상대가 없다", () => {
    assert.equal(직접.relation, "SELF");
    assert.equal(직접.counterpartName, null);
  });

  check("🔴 내가 **대신** 누른 줄 — 상대는 **자리 주인**이다(내 이름이 아니다)", () => {
    assert.equal(대신.relation, "ON_BEHALF");
    assert.equal(대신.counterpartName, 주인_이름);
    assert.notEqual(대신.counterpartName, 내_이름, "🔴 두 칸을 바꿔 적었다 — 오류가 안 나는 자리다");
  });

  check("🔴 **내 자리를 남이** 누른 줄 — 상대는 **누른 사람**이다(내 이름이 아니다)", () => {
    assert.equal(당함.relation, "BY_DELEGATE");
    assert.equal(당함.counterpartName, 대리_이름);
    assert.notEqual(당함.counterpartName, 내_이름, "🔴 두 칸을 바꿔 적었다 — 오류가 안 나는 자리다");
  });

  check("🔴 셋이 **갈려서** 나온다 — 한 사람 눈으로 본 세 줄이 모두 다르다", () => {
    const relations = [직접, 대신, 당함].map((e) => e.relation);
    assert.equal(relations.length, 3);
    assert.equal(new Set(relations).size, 3, relations.join(", "));
    const 상대들 = [직접, 대신, 당함].map((e) => e.counterpartName);
    assert.deepEqual(상대들, [null, 주인_이름, 대리_이름]);
  });

  check("🔴 계약의 여덟 칸이 **빠짐없이, 더도 없이** 나간다", () => {
    const expected: (keyof ApprovalHistoryEntry)[] = [
      "id",
      "subject",
      "approvalName",
      "decidedAt",
      "decision",
      "relation",
      "counterpartName",
      "href",
    ];
    assert.deepEqual(Object.keys(직접).sort(), [...expected].sort());
    // 🔴 사유를 싣지 않는다 — 다른 시스템 화면에 그려지는 줄이다.
    assert.ok(!("reason" in 직접));
    assert.ok(!("comment" in 직접));
  });

  check("🔴 `decidedAt` 이 ISO 8601 이고, `decision` 이 상태 그대로다", () => {
    assert.equal(직접.decidedAt, "2026-11-10T01:02:03.000Z");
    assert.equal(직접.decision, "APPROVED");
    assert.equal(toApprovalHistoryEntry(row({ status: "REJECTED" }), BASE_URL).decision, "REJECTED");
  });

  check("🔴 승인·반려가 아닌 줄은 **던진다** — 건너뛴 줄이 「반려」로 그려지지 않게", () => {
    // 조회가 상태를 둘로 좁혀 두어 여기 올 수 없다. 그래도 눌러 끄지 않는 것은,
    // 그 조건이 풀리는 날 `SKIPPED` 가 조용히 「반려」로 나가기 때문이다.
    for (const status of ["SKIPPED", "PENDING", "WAITING"] as const) {
      assert.throws(() => toApprovalHistoryEntry(row({ status }), BASE_URL), /상태 조건/, status);
    }
  });

  check("🔴 `href` 가 절대 주소이고 그 결재 줄을 가리킨다", () => {
    const entry = toApprovalHistoryEntry(row({ stepId: "s-9" }), BASE_URL);
    assert.equal(entry.href, `${BASE_URL}/approvals#approval-s-9`);
    assert.equal(new URL(entry.href.split("#")[0]).port, "3700");
  });

  check("`id` 가 승인함 줄과 같은 모양이다 — 같은 단계면 같은 열쇠", () => {
    assert.equal(
      toApprovalHistoryEntry(row({ stepId: "s-9" }), BASE_URL).id,
      `${LEAVE_REQUEST_APPROVAL_KIND}:s-9`,
    );
  });

  check("🔴 `id` 가 **단계마다** 유일하다 — 한 신청에 내 줄이 둘일 수 있다", () => {
    // 🔴 한 사람이 **같은 신청**에 두 줄을 가질 수 있다: 1단계는 내가 직접 누르고
    //    3단계는 대리인이 내 자리를 누른 경우다. 열쇠를 **신청 번호**로 지으면
    //    둘이 같은 값이 되어 포털 화면에서 **한 줄이 조용히 사라진다**(React 의
    //    목록 열쇠가 겹친다). 그래서 단계 id 로 짓는다.
    const 같은신청 = "11111111-1111-4111-8111-111111111111";
    const 줄들 = [
      row({ requestId: 같은신청, stepId: "s-1", stepNo: 1, role: "SELF" }),
      row({ requestId: 같은신청, stepId: "s-3", stepNo: 3, role: "BY_OTHER", decidedByName: 대리_이름 }),
    ];
    // 🔵 표본이 비어 공짜로 통과하지 않게 — 두 줄이 **같은 신청**인 것을 먼저.
    assert.equal(줄들[0].requestId, 줄들[1].requestId);
    const ids = 줄들.map((r) => toApprovalHistoryEntry(r, BASE_URL).id);
    assert.equal(new Set(ids).size, 2, `열쇠가 겹친다: ${ids.join(", ")}`);
    // 🔴 그리고 둘의 `href` 도 서로 다른 줄을 가리켜야 한다.
    const hrefs = 줄들.map((r) => toApprovalHistoryEntry(r, BASE_URL).href);
    assert.equal(new Set(hrefs).size, 2, `주소가 겹친다: ${hrefs.join(", ")}`);
  });

  check("`subject` 는 누구의 무슨 휴가인가 + 기간·일수, `approvalName` 은 몇 단계인가", () => {
    const entry = toApprovalHistoryEntry(
      row({ applicantName: 신청자_이름, kind: "CHANGE", leaveType: "AM_HALF", days: 0.5, stepNo: 3 }),
      BASE_URL,
    );
    assert.ok(entry.subject.includes(신청자_이름), entry.subject);
    assert.ok(entry.subject.includes("오전반차"), entry.subject);
    assert.ok(entry.subject.includes("날짜 변경"), entry.subject);
    assert.ok(entry.subject.includes("0.5일"), entry.subject);
    assert.ok(entry.approvalName.includes("3단계"), entry.approvalName);
    assert.ok(entry.approvalName.includes("휴가"), entry.approvalName);
  });

  /* ---------------------------------------------------------------- */
  /* 4. 열쇠 두 단 — 🔴 **끊기면 빈 목록**                               */
  /* ---------------------------------------------------------------- */

  const RANGE: ApprovalHistoryRange = { from: new Date(FROM_TEXT), to: new Date(TO_TEXT) };

  await checkAsync("결재한 것이 있으면 줄이 나온다 — 🔵 먼저 이것부터(공짜 통과 방지)", async () => {
    const history = await buildPortalApprovalHistory({
      subject: SUB,
      range: RANGE,
      baseUrl: BASE_URL,
      findActor: async () => MEMBER,
      listHistory: async () => [row({ stepId: "s-1" }), 대신한_줄],
    });
    assert.equal(history.entries.length, 2);
    assert.deepEqual(
      history.entries.map((e) => e.relation),
      ["SELF", "ON_BEHALF"],
    );
  });

  await checkAsync("🔴 이 시스템에 계정이 없는 사람은 **빈 목록**이다 — 오류가 아니다", async () => {
    // 🔴 포털은 세 집에 같은 질문을 던져 한 화면에 모은다. 한 집이 오류를 뱉으면
    //    나머지 둘까지 못 그릴 수 있다(dss-auth 의 gather.ts).
    const history = await buildPortalApprovalHistory({
      subject: SUB,
      range: RANGE,
      baseUrl: BASE_URL,
      findActor: async () => null,
      listHistory: async () => [row()],
    });
    assert.deepEqual(history, { entries: [] });
  });

  await checkAsync("🔴 명단에 안 이어진 사람도 **빈 목록**이다 — 두 단 중 둘째가 끊긴 자리", async () => {
    const history = await buildPortalApprovalHistory({
      subject: SUB,
      range: RANGE,
      baseUrl: BASE_URL,
      findActor: async () => UNLINKED,
      listHistory: async () => [row()],
    });
    assert.deepEqual(history, { entries: [] });
  });

  await checkAsync("명단 미연결이면 내역 조회를 두드리지도 않는다", async () => {
    let asked = false;
    await buildPortalApprovalHistory({
      subject: SUB,
      range: RANGE,
      baseUrl: BASE_URL,
      findActor: async () => UNLINKED,
      listHistory: async () => {
        asked = true;
        return [];
      },
    });
    assert.equal(asked, false, "명단에 연결되지 않았는데 내역을 뒤졌다");
  });

  await checkAsync("🔴 조회에 넘기는 것은 **명단 번호**다 — 계정 번호를 넣으면 영원히 빈 목록이다", async () => {
    let 받은번호: string | null = null;
    let 받은기간: ApprovalHistoryRange | null = null;
    await buildPortalApprovalHistory({
      subject: SUB,
      range: RANGE,
      baseUrl: BASE_URL,
      findActor: async () => MEMBER,
      listHistory: async (employeeId, range) => {
        받은번호 = employeeId;
        받은기간 = range;
        return [];
      },
    });
    assert.equal(받은번호, ME_EMPLOYEE_ID);
    assert.notEqual(받은번호, SUB, "🔴 포털 번호를 그대로 넘겼다");
    // 🔴 기간을 중간에서 넓히거나 자르지 않는다.
    assert.deepEqual(받은기간, RANGE);
  });

  await checkAsync("결재한 것이 없는 기간은 빈 목록이다 — 자격 없음과 같은 답이다", async () => {
    const history = await buildPortalApprovalHistory({
      subject: SUB,
      range: RANGE,
      baseUrl: BASE_URL,
      findActor: async () => MEMBER,
      listHistory: async () => [],
    });
    assert.deepEqual(history, { entries: [] });
  });

  await checkAsync("🔴 뒤집힌 기간은 **빈 `entries`** 다 — 400 이 아니다(포털이 고장으로 읽는다)", async () => {
    // 계약이 400 을 주라고 적은 것은 「없거나 못 읽는 값」뿐이다. 뒤집힌 구간은
    // 읽히고, 반열린 구간(`from <= x < to`)의 정의상 **담길 줄이 없다.**
    const 뒤집힌 = parseApprovalHistoryPeriod(query(`from=${TO_TEXT}&to=${FROM_TEXT}`));
    assert.ok(뒤집힌.ok, "🔴 뒤집힌 구간이 400 이 됐다");

    let 받은기간: ApprovalHistoryRange | null = null;
    const history = await buildPortalApprovalHistory({
      subject: SUB,
      range: { from: 뒤집힌.from, to: 뒤집힌.to },
      baseUrl: BASE_URL,
      findActor: async () => MEMBER,
      listHistory: async (_employeeId, range) => {
        받은기간 = range;
        // 🔵 조회가 돌려줄 값을 그대로 흉내 낸다 — 담길 줄이 없다.
        return [];
      },
    });
    assert.deepEqual(history, { entries: [] });
    // 🔴 중간에서 바꿔 끼우지 않았다. 끼웠으면 **26일치가 그럴듯하게** 나온다.
    assert.deepEqual(받은기간, { from: new Date(TO_TEXT), to: new Date(FROM_TEXT) });
  });

  await checkAsync("🔴 대상 사람은 **토큰이 실어 온 sub** 하나로 정해진다", async () => {
    let 받은sub: string | null = null;
    await buildPortalApprovalHistory({
      subject: SUB,
      range: RANGE,
      baseUrl: BASE_URL,
      findActor: async (subject) => {
        받은sub = subject;
        return MEMBER;
      },
      listHistory: async () => [],
    });
    assert.equal(받은sub, SUB);
  });

  /* ---------------------------------------------------------------- */
  /* 5. 라우트 배선 — 소스 글자로 (요청 맥락이 필요해 직접 못 부른다)      */
  /* ---------------------------------------------------------------- */

  check("🔴 토큰 검증이 **먼저**다 — 자격 없는 호출에 「기간이 틀렸다」를 알려 주지 않는다", () => {
    const verifyAt = route.indexOf("await verifyPortalServiceToken(");
    const rejectAt = route.indexOf("if (!verified.ok) {");
    const periodAt = route.indexOf("parseApprovalHistoryPeriod(");
    const workAt = route.indexOf("buildPortalApprovalHistory({");
    assert.ok(verifyAt > 0, "검증하는 자리를 찾지 못했다");
    assert.ok(rejectAt > verifyAt, "검증 결과를 확인하지 않는다");
    assert.ok(periodAt > rejectAt, "🔴 토큰을 거절하기 전에 기간을 읽는다");
    assert.ok(workAt > periodAt, "기간을 보기 전에 내역을 뽑는다");
    assert.match(route, /status: 401/);
  });

  check("🔴 기간이 틀리면 400 `invalid_period` 다 — 계약의 글자 그대로", () => {
    assert.match(route, /status: 400/);
    assert.ok(route.includes("APPROVAL_HISTORY_PERIOD_ERROR"), route);
    // 🔴 빈 목록으로 얼버무리지 않는다 — 부르는 쪽이 「결재한 게 없구나」로 읽는다.
    const errorAt = route.indexOf("APPROVAL_HISTORY_PERIOD_ERROR");
    const workAt = route.indexOf("buildPortalApprovalHistory({");
    assert.ok(errorAt > 0 && errorAt < workAt, "기간이 틀려도 조회로 넘어간다");
  });

  check("쓰임새가 다른 토큰은 거절된다 — 알림 읽기 용도를 요구한다(옆 통로와 같은 값)", () => {
    assert.match(route, /PORTAL_TOKEN_PURPOSES\.notificationsRead/);
    for (const forbidden of ["notificationSettingsRead", "notificationSettingsWrite", "delegationsWrite"]) {
      assert.ok(!route.includes(forbidden), `다른 쓰임새의 토큰을 받는다: ${forbidden}`);
    }
  });

  check("기준 주소는 환경에서 온다 — Host 머리말을 읽지 않는다", () => {
    assert.match(route, /baseUrl: env\.appBaseUrl/);
    for (const forbidden of ['headers.get("host")', '"x-forwarded-host"', "request.url"]) {
      assert.ok(!route.includes(forbidden), `부르는 쪽이 정하는 주소를 쓴다: ${forbidden}`);
    }
  });

  check("🔴 읽기 전용이다 — 결재를 실행하는 길이 없다", () => {
    for (const method of [
      "export async function POST",
      "export async function PUT",
      "export async function PATCH",
      "export async function DELETE",
    ]) {
      assert.ok(!route.includes(method), `쓰는 메서드가 생겼다: ${method}`);
    }
    assert.match(route, /export async function GET/);
  });

  check("응답이 캐시되지 않는다 — 방금 한 결재가 한참 뒤에 뜨면 안 된다", () => {
    assert.match(route, /"cache-control": "no-store"/);
  });

  check("포털 설정이 없는 PC 에서는 통로 자체가 열리지 않는다", () => {
    assert.ok(route.includes("env.ssoConfigured"));
    assert.ok(route.includes('{ error: "not_enabled" }'));
  });

  check("🔴 고르는 조건을 새로 쓰지 않는다 — 10a 의 조회를 그대로 넘긴다", () => {
    assert.match(route, /listHistory: approvalHistoryFor/);
    assert.match(route, /findActor: findPortalActor/);
    for (const forbidden of ["db.select", "drizzle-orm", "eq(webApprovalSteps", "SKIPPED"]) {
      assert.ok(!route.includes(forbidden), `라우트가 직접 질의를 쓴다: ${forbidden}`);
    }
  });

  check("🔴 판단이 DB 를 모른다 — 그래서 자료 없이 그대로 돌려 볼 수 있다", () => {
    for (const forbidden of ["drizzle-orm", '"@/lib/db"', "db.select"]) {
      assert.ok(!judge.includes(forbidden), `판단이 DB 를 끌어왔다: ${forbidden}`);
    }
  });

  check("🔴 `SKIPPED` 거르기가 여전히 **조회 쪽**에 있다 — 거르는 곳이 둘이 되지 않게", () => {
    assert.ok(!judge.includes("SKIPPED"), "판단이 상태를 다시 거른다 — 한쪽만 고치는 날이 온다");
    const 조회 = withoutComments(read("src/lib/leave/data.ts"));
    assert.ok(조회.includes("in ('APPROVED', 'REJECTED')"), "🔴 조회의 상태 조건이 풀렸다");
  });

  /* ---------------------------------------------------------------- */
  /* 6. 토큰 — 알림 읽기 용도로 실제로 검증된다                           */
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

  await checkAsync("쓰임새가 맞는 토큰은 통과하고, sub 을 그대로 실어 온다", async () => {
    const result = await verify(await mint());
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.subject, SUB);
  });

  await checkAsync("🔴 위임 쓰기용 토큰으로는 이 통로가 열리지 않는다", async () => {
    const result = await verify(await mint(PORTAL_TOKEN_PURPOSES.delegationsWrite));
    assert.deepEqual(result, { ok: false, reason: "wrong_purpose" });
  });

  console.log(`\n${passed}개 통과`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
