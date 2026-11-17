/**
 * 결재 생성 알림이 **포털 위임 대리인에게도 간다**.  npm run test:nudge-delegation
 *
 * 🔴 DB 에 닿지 않고 사내망에도 나가지 않는다. 질의는 **만들기만** 하고
 * `.toSQL()` 로 구워 보고, 합치는 셈은 DB 를 모르는 순수 함수라 그대로 부른다
 * (scripts/test-approval-delegation.ts 와 같은 수법이다).
 *
 * ── 이 조각이 메운 구멍 (2026-11-17, 설계 D-8 ①) ────────────────────────────
 * 포털 위임을 받은 대리인은 조각 8 이후로 결재함·배지·종·통합 승인함에 **모두**
 * 떴다 — 판정(approval-scope.ts 의 `myStepCondition`)이 위임 목록을 보기
 * 때문이다. 그런데 **「결재가 생겼다」 알림만** 안 갔다: 알릴 사람을 뽑는 질의가
 * 단계에 박힌 번호 하나만 보고 「그 사람을 **누가** 대신할 수 있나」는 묻지
 * 않았다. 🔴 그래서 대리인은 결재함을 **제 발로 열어 봐야** 대신 누를 건이 있는
 * 줄 알았다.
 *
 * ── 알림이 흐르는 길 (넓어진 자리를 ▶ 로 짚는다) ────────────────────────────
 *   휴가 신청이 저장된다 (커밋)
 *     → workflow.ts 가 nudgePortalApprovalCreated 를 부른다
 *     → ▶ 열린 단계에 걸린 사람 **+ 그들을 지금 대신할 수 있는 사람**
 *          (data.ts 의 approvalNudgeCandidates — 조회 셋 + 합치는 셈)
 *     → ▶ 대리인 줄에 **위임 목록을 얹어** 공용 조건에 한 명씩 되묻는다
 *     → POST {포털}/api/integration/approval-created  (approverSub=… 뿐)
 *
 * ── 무엇을 지키는가 ─────────────────────────────────────────────────────
 *   1. 🔴 포털 위임으로 생긴 **대리인이 후보에 든다** (이 조각의 전부다).
 *   2. 🔴 끝났거나 **거둔 위임**의 대리인은 안 든다.
 *   3. 🔴 **같은 사람이 두 번 나오지 않는다.**
 *   4. 🔴 **대상 단계는 한 줄도 안 넓어졌다** — 넓어진 것은 사람뿐이다.
 *   5. 🔴 **정방향과 같은 규칙**으로 살아 있음을 본다 — 한쪽만 고쳐지면 빨개진다.
 *   6. 🔴 판정을 **새로 짓지 않는다** — 대리인도 공용 조건에 되물어 걸러진다.
 *
 * 🔵 **보내는 통로·안 던지기·몸통 모양은 여기서 재지 않는다** —
 * scripts/test-approval-nudge.ts 가 잰다. 이 파일이 지키는 것은 **누가 후보가
 * 되는가**다.
 *
 * 🔴 왜 전부 main() 안에 있나: 이 저장소의 검사는 tsx 가 CJS 로 돌려
 * (package.json 에 type:module 이 없다) 최상위 await 을 쓸 수 없다.
 * 🔴 **DB 를 건드리는 모듈은 `await import` 로 불러온다** — `src/lib/db` 는 모듈을
 * 읽는 순간 DATABASE_URL 을 읽는데, 정적 import 는 아래 환경 설정보다 **먼저**
 * 돌기 때문이다(esbuild 가 import 를 위로 끌어올린다).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 🔴 .env.local 을 읽지 않는다 — 이 검사는 여기 적힌 값으로만 돈다.
//    DATABASE_URL 은 **아무 데도 붙지 않는 주소**다. 질의를 만들기만 하므로
//    끝까지 접속이 일어나지 않는다(그 성질을 아래 「빈 목록」 검사가 쓴다).
process.env.SSO_ISSUER = "http://127.0.0.1:1";
process.env.SSO_CLIENT_ID = "dss-leave";
process.env.SSO_CLIENT_SECRET = "테스트용-시크릿";
process.env.SSO_REDIRECT_URI = "http://192.168.1.10:3700/api/auth/sso/callback";
process.env.SSO_TX_SECRET = "0123456789abcdef0123456789abcdef";
process.env.DATABASE_URL = "postgres://nobody:nobody@127.0.0.1:1/none";

import {
  nudgeApprovalCreated,
  withDelegateCandidates,
  type ActingForPair,
  type ApprovalNudgeCandidate,
} from "../src/lib/leave/approval-nudge";
import { isMyStep, type Decider } from "../src/lib/leave/approval-scope";

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
const withoutComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/* ------------------------------------------------------------------ */
/* 가짜 값 — 🔴 실제 직원 이름·사번을 한 자도 넣지 않는다                */
/* ------------------------------------------------------------------ */

const 맡긴이 = "emp-맡긴이";
const 맡긴이둘째 = "emp-맡긴이둘째";
const 대리인 = "emp-대리인";
const 제삼자 = "emp-제삼자";

/** 포털에 등록된 사람의 번호(포털 users.id)와 같은 모양. 전부 가짜다. */
const SUB_맡긴이 = "11111111-2222-4333-8444-555555555555";
const SUB_대리인 = "66666666-7777-4888-8999-aaaaaaaaaaaa";

const REQUEST_ID = "cccccccc-dddd-4eee-8fff-000000000000";

function candidate(over: Partial<ApprovalNudgeCandidate> = {}): ApprovalNudgeCandidate {
  return {
    employeeId: 맡긴이,
    rankId: "rank-과장",
    isApprover: true,
    authSub: SUB_맡긴이,
    ...over,
  };
}

const 대리인줄 = () =>
  candidate({ employeeId: 대리인, rankId: "rank-대리", isApprover: false, authSub: SUB_대리인 });

const pair = (delegatorEmployeeId: string, delegateEmployeeId: string): ActingForPair => ({
  delegatorEmployeeId,
  delegateEmployeeId,
});

/* ------------------------------------------------------------------ */
/* 되묻는 자리 — 🔴 공용 판정을 **진짜로** 꽂는다                        */
/* ------------------------------------------------------------------ */

type Call = { me: Decider; requestId: string };

/**
 * 실제 배선과 같은 모양. 🔴 `isPendingFor` 자리에 **공용 판정 그 자체**
 * (approval-scope.ts 의 `isMyStep`)를 꽂는다 — 「맡긴이의 단계 하나가 열려
 * 있다」고 치고, 그 단계가 누구 것인지는 **그 함수가** 답한다. 가짜 참/거짓을
 * 넣으면 「대리인이 공용 조건을 통과한다」는 말을 이 검사가 스스로 지어내는
 * 꼴이 된다.
 */
async function run(candidates: readonly ApprovalNudgeCandidate[]) {
  const asked: Call[] = [];
  const sent: string[][] = [];
  const warnings: string[] = [];
  const outcome = await nudgeApprovalCreated(REQUEST_ID, {
    listCandidates: async () => candidates,
    isPendingFor: async (me, requestId) => {
      asked.push({ me, requestId });
      return isMyStep({ approverEmployeeId: 맡긴이, rankId: "rank-과장" }, me);
    },
    send: async (subs) => {
      sent.push([...subs]);
      return true;
    },
    warn: (message) => warnings.push(message),
  });
  return { outcome, asked, sent, warnings };
}

async function main() {
  console.log("\n결재 생성 알림 — 포털 위임 대리인에게도\n");

  /* ---------------------------------------------------------------- */
  /* 1. 합치는 셈 — 대리인이 후보에 **더해진다**                        */
  /* ---------------------------------------------------------------- */

  check("🔵 위임이 없으면 **받은 줄이 그대로** 나간다 — 이 조각 전과 값까지 같다", () => {
    const onSteps = [candidate()];
    const merged = withDelegateCandidates({ onSteps, pairs: [], delegates: [] });
    assert.deepEqual(merged, onSteps);
    // 🔵 보탤 것이 없으면 새 칸을 만들지도 않는다 — 「위임 때문에 달라진 것」만
    //    눈에 남아야 다음 사람이 읽을 수 있다.
    assert.equal(merged[0].actingForEmployeeIds, undefined);
  });

  check("🔴 **대리인이 후보에 든다** — 맡긴 사람 번호를 달고 (이 조각의 전부다)", () => {
    const onSteps = [candidate()];
    // 🔵 표본이 비어 공짜로 통과하지 않게 — **위임이 없을 때는 없었다**를 먼저.
    assert.equal(
      withDelegateCandidates({ onSteps, pairs: [], delegates: [대리인줄()] }).length,
      1,
      "🔵 위임도 없는데 대리인이 들어왔다 — 아무것도 재지 못했다",
    );
    const merged = withDelegateCandidates({
      onSteps,
      pairs: [pair(맡긴이, 대리인)],
      delegates: [대리인줄()],
    });
    assert.deepEqual(merged.map((row) => row.employeeId), [맡긴이, 대리인]);
    // 🔴 대리인 줄에는 **맡긴 사람 번호**가 실려야 한다. 이것이 없으면 후보에만
    //    올라가고 공용 조건이 그대로 걸러낸다(아래 2절이 실제로 그것을 잰다).
    assert.deepEqual(merged[1].actingForEmployeeIds, [맡긴이]);
    // 대리인의 직급·계정은 **제 것**이다 — 맡긴 사람 것을 빌려 오지 않는다.
    assert.equal(merged[1].isApprover, false);
    assert.equal(merged[1].authSub, SUB_대리인);
    // 원래 가던 사람은 한 글자도 안 바뀐다.
    assert.deepEqual(merged[0], candidate());
  });

  check("🔴 위임 줄에 없는 사람은 안 든다 — 끝났거나 **거둔** 위임이 그 자리다", () => {
    // 🔴 「살아 있는가」를 여기서 보지 않는다 — 거른 뒤의 줄만 들어온다(3절이
    //    그 거르개를 구워진 SQL 로 잰다). 여기서 재는 것은 **들어오지 않은 줄은
    //    후보도 아니다**는 것뿐이고, 그래서 위임이 끝나면 알림도 그날로 그친다.
    const merged = withDelegateCandidates({
      onSteps: [candidate()],
      pairs: [],
      delegates: [대리인줄()],
    });
    assert.deepEqual(merged.map((row) => row.employeeId), [맡긴이]);
  });

  check("🔴 대리인이 **제 단계로도** 걸려 있으면 한 줄이다 — 메일이 두 번 가지 않게", () => {
    const 대리인이면서결재자 = candidate({
      employeeId: 대리인,
      rankId: "rank-대리",
      isApprover: false,
      authSub: SUB_대리인,
    });
    const merged = withDelegateCandidates({
      onSteps: [candidate(), 대리인이면서결재자],
      pairs: [pair(맡긴이, 대리인)],
      delegates: [],
    });
    assert.deepEqual(merged.map((row) => row.employeeId), [맡긴이, 대리인]);
    assert.deepEqual(merged[1].actingForEmployeeIds, [맡긴이]);
  });

  check("🔴 한 사람이 **여럿을 대신**해도 한 줄 — 번호만 여럿 실린다", () => {
    const merged = withDelegateCandidates({
      onSteps: [candidate(), candidate({ employeeId: 맡긴이둘째 })],
      pairs: [pair(맡긴이, 대리인), pair(맡긴이둘째, 대리인)],
      delegates: [대리인줄()],
    });
    assert.deepEqual(merged.map((row) => row.employeeId), [맡긴이, 맡긴이둘째, 대리인]);
    assert.deepEqual(merged[2].actingForEmployeeIds, [맡긴이, 맡긴이둘째]);
  });

  check("🔴 같은 위임이 두 줄로 들어와도 번호는 한 번만", () => {
    const merged = withDelegateCandidates({
      onSteps: [candidate()],
      pairs: [pair(맡긴이, 대리인), pair(맡긴이, 대리인)],
      delegates: [대리인줄(), 대리인줄()],
    });
    assert.deepEqual(merged.map((row) => row.employeeId), [맡긴이, 대리인]);
    assert.deepEqual(merged[1].actingForEmployeeIds, [맡긴이]);
  });

  check("🔴 맡긴 사람과 대리인이 **같아도** 한 줄이다 (포털이 자기 지정을 허용한다)", () => {
    const merged = withDelegateCandidates({
      onSteps: [candidate()],
      pairs: [pair(맡긴이, 맡긴이)],
      delegates: [],
    });
    assert.deepEqual(merged.map((row) => row.employeeId), [맡긴이]);
    // 공용 조건 쪽에서 중복이 한 번 더 걷힌다(approvableEmployeeIds).
    assert.deepEqual(merged[0].actingForEmployeeIds, [맡긴이]);
  });

  check("🔴 명단 줄이 없는 번호는 **지어내지 않는다** — 직급도 계정도 거짓이 된다", () => {
    const merged = withDelegateCandidates({
      onSteps: [candidate()],
      pairs: [pair(맡긴이, 제삼자)],
      delegates: [],
    });
    assert.deepEqual(merged.map((row) => row.employeeId), [맡긴이]);
  });

  /* ---------------------------------------------------------------- */
  /* 2. 🔴 판정은 **남의 것**이다 — 공용 조건을 그대로 꽂아 본다         */
  /* ---------------------------------------------------------------- */

  await checkAsync(
    "🔴 **위임 목록이 없으면 공용 조건이 대리인을 걸러낸다** — 이 조각 이전의 그 모습",
    async () => {
      // 🔵 이것이 메우려던 구멍 그 자체다. 후보에 올려 놓고 위임 목록을 안
      //    얹으면, 공용 판정은 「맡긴이의 단계는 네 것이 아니다」라고 답한다.
      const { outcome, asked, sent } = await run([
        candidate(),
        대리인줄(), // actingForEmployeeIds 가 없다
      ]);
      assert.equal(asked.length, 2, "후보를 다 물어보지 않았다");
      assert.deepEqual(sent, [[SUB_맡긴이]]);
      assert.deepEqual(outcome.nudged, [SUB_맡긴이]);
    },
  );

  await checkAsync("🔴 위임 목록을 얹으면 **대리인에게도 나간다**", async () => {
    const { outcome, asked, sent } = await run([
      candidate(),
      { ...대리인줄(), actingForEmployeeIds: [맡긴이] },
    ]);
    assert.equal(asked.length, 2);
    // 🔴 되묻는 자리에 **그대로** 올라갔는가 — 여기서 빠뜨리면 위 검사와 같은
    //    모습이 되고, 오류는 하나도 안 난다.
    assert.deepEqual(asked[1].me.actingForEmployeeIds, [맡긴이]);
    assert.equal(asked[1].me.employeeId, 대리인, "누구로 되물었는지가 어긋난다");
    assert.equal(asked[1].requestId, REQUEST_ID);
    assert.deepEqual(sent, [[SUB_맡긴이, SUB_대리인]]);
    assert.deepEqual(outcome.nudged, [SUB_맡긴이, SUB_대리인]);
  });

  await checkAsync(
    "🔴 **아무도 안 맡긴 사람은 못 받는다** — 판정을 새로 짓지 않는 덕이다",
    async () => {
      // 엉뚱한 사람을 대신한다고 적힌 줄. 공용 판정이 「맡긴이의 단계가 아니다」로
      // 걸러낸다 — 이 파일에는 그 판단이 한 줄도 없다.
      const { outcome, sent } = await run([
        { ...대리인줄(), actingForEmployeeIds: [제삼자] },
      ]);
      assert.deepEqual(sent, []);
      assert.deepEqual(outcome.nudged, []);
    },
  );

  await checkAsync("🔴 포털 번호가 없는 대리인은 **로그에 남고** 묶음은 안 멈춘다", async () => {
    const { outcome, sent, warnings } = await run([
      candidate(),
      { ...대리인줄(), authSub: null, actingForEmployeeIds: [맡긴이] },
    ]);
    assert.deepEqual(sent, [[SUB_맡긴이]]);
    assert.deepEqual(outcome.missingPortalNumber, [대리인]);
    assert.equal(warnings.length, 1, "🔴 아무것도 남기지 않았다 — 영영 안 드러난다");
  });

  /* ---------------------------------------------------------------- */
  /* 3. 🔴 거꾸로 방향 조회 — 구워진 SQL 로 본다                         */
  /* ---------------------------------------------------------------- */

  const delegations = await import("../src/lib/auth/portal-delegations");
  const 어느날 = new Date("2027-03-05T00:00:00.000Z");
  const 거꾸로 = delegations.delegatesForApproversQuery([맡긴이, 맡긴이둘째], 어느날).toSQL();
  const 정방향 = delegations.actingForEmployeeIdsQuery(대리인, 어느날).toSQL();

  check("🔴 **맡긴 사람으로 찾아 대리인을 돌려준다** — 방향이 뒤집히면 아무도 못 받는다", () => {
    assert.match(거꾸로.sql, /"delegator_employee_id" in \(\$\d+, \$\d+\)/);
    assert.match(거꾸로.sql, /select distinct "delegator_employee_id", "delegate_employee_id"/);
    assert.ok(거꾸로.params.includes(맡긴이), "🔵 찾는 번호를 안 묶었다 — 아무것도 재지 못했다");
    assert.ok(거꾸로.params.includes(맡긴이둘째), "번호 하나만 묶었다");
    // 🔴 정방향을 그대로 꽂으면(대리인으로 찾기) 오류 없이 아무도 못 받는다.
    assert.ok(
      !/"delegate_employee_id" = \$/.test(거꾸로.sql),
      "🔴 정방향으로 찾고 있다 — 대리인에게 알림이 영영 안 간다",
    );
  });

  check("🔴 **정방향과 같은 규칙으로 살아 있음을 본다** — 한쪽만 고쳐지면 여기서 깨진다", () => {
    // 🔵 이름이 같은지가 아니라 **구워진 글자가 같은지**를 본다. 사람을 고르는
    //    줄만 빼고 나면 두 질의의 나머지 where 는 한 글자도 달라선 안 된다 —
    //    달라지는 날 「결재함에는 뜨는데 알림은 안 오는」 사람이 생기고, 그
    //    어긋남은 아무 오류도 내지 않아 **신고로만** 드러난다.
    const 살아있음 = (sql: string) =>
      sql.slice(sql.indexOf('"revoked_at"'), sql.indexOf(" order by")).replace(/\$\d+/g, "$N");
    assert.ok(살아있음(정방향.sql).includes("is null"), "🔵 잘라 낸 자리가 비었다");
    assert.equal(살아있음(거꾸로.sql), 살아있음(정방향.sql));
  });

  check("🔴 거둔 줄과 기간 밖은 안 본다 — 반열린 구간이다", () => {
    assert.match(거꾸로.sql, /"revoked_at" is null/);
    assert.ok(!/"revoked_at" is not null/.test(거꾸로.sql), "거꾸로 읽고 있다");
    assert.match(거꾸로.sql, /"starts_at" <= \$\d+/);
    assert.match(거꾸로.sql, /"ends_at" > \$\d+/);
    assert.ok(!/"ends_at" >= /.test(거꾸로.sql), "🔴 끝나는 순간이 아직 열려 있다");
  });

  check("🔴 살아 있음 조건을 **손으로 다시 적지 않았다** — 같은 자리를 부른다", () => {
    const source = withoutComments(read("src/lib/auth/portal-delegations.ts"));
    const 쓰는곳 = source.match(/\.\.\.liveNowParts\(now\)/g) ?? [];
    assert.equal(쓰는곳.length, 2, `공유 조각을 ${쓰는곳.length}곳에서만 쓴다 — 둘이어야 한다`);
    // 🔴 거꾸로 질의의 몸통에 기간·철회 칸 이름이 다시 적혀 있으면 두 벌이 된 것이다.
    const at = source.indexOf("export function delegatesForApproversQuery");
    assert.ok(at > 0, "거꾸로 질의를 찾지 못했다");
    const body = source.slice(at, source.indexOf("\n}", at));
    for (const 베낀흔적 of ["revokedAt", "endsAt", "startsAt"]) {
      assert.ok(!body.includes(베낀흔적), `🔴 살아 있음 조건을 베껴 적었다: ${베낀흔적}`);
    }
  });

  check("🔴 기준 시각이 **박혀 있지 않다** — 요청마다 다시 잰다", () => {
    const 나중 = delegations
      .delegatesForApproversQuery([맡긴이, 맡긴이둘째], new Date("2028-03-05T00:00:00.000Z"))
      .toSQL();
    assert.equal(나중.sql, 거꾸로.sql, "문장이 시각에 따라 달라진다 — 상수를 굽고 있다");
    assert.notDeepEqual(나중.params, 거꾸로.params, "🔴 시각이 묶이지 않는다");
  });

  check("🔴 이어 붙을 길이 SQL 에 없다 — 표 하나만 본다", () => {
    // A→B, B→C 라도 C 는 A 를 못 얻는다. 결재 판정이 같은 까닭으로 이어 붙지
    // 않으므로(approvableEmployeeIds), 여기서 이어 붙이면 **알림만 가고 눌러
    // 보면 거절되는** 사람이 생긴다.
    assert.equal((거꾸로.sql.match(/from "/g) ?? []).length, 1, "하위 질의·조인이 생겼다");
    assert.ok(!/recursive/i.test(거꾸로.sql));
    assert.ok(!/ join /i.test(거꾸로.sql));
  });

  await checkAsync("🔴 물을 번호가 없으면 **DB 를 두드리지 않는다**", async () => {
    // 🔵 이 검사가 실제로 돈다는 증거: DATABASE_URL 은 아무 데도 안 붙는
    //    주소다(파일 맨 위). 질의를 돌리면 여기서 던진다.
    assert.deepEqual(await delegations.loadDelegatesForApprovers([]), []);
  });

  /* ---------------------------------------------------------------- */
  /* 4. 🔴 넓어진 것은 **사람**뿐 — 대상 단계는 그대로다                 */
  /* ---------------------------------------------------------------- */

  const data = await import("../src/lib/leave/data");
  const 단계후보 = (
    data.approvalNudgeStepCandidatesQuery(REQUEST_ID) as unknown as {
      toSQL(): { sql: string; params: unknown[] };
    }
  ).toSQL();
  const 단계주인 = data.nudgeStepApproverIdsQuery(REQUEST_ID).toSQL();

  check("🔴 **열린 단계만** 본다 — SKIPPED·끝난 단계가 들어올 길이 없다", () => {
    for (const baked of [단계후보, 단계주인]) {
      assert.match(baked.sql, /"web_approval_steps"\."status" = \$\d+/);
      assert.deepEqual(
        baked.params.filter((p) => typeof p === "string" && p !== REQUEST_ID),
        ["PENDING"],
        `🔴 대상 단계가 넓어졌다: ${baked.sql}`,
      );
      assert.ok(baked.params.includes(REQUEST_ID), "신청을 좁히지 않는다");
      assert.match(baked.sql, /"web_approval_steps"\."is_deleted" = \$\d+/);
    }
  });

  check("🔴 보는 단계를 정하는 자리가 **한 곳**이다 — 둘이 갈리면 알림만 더 간다", () => {
    const source = withoutComments(read("src/lib/leave/data.ts"));
    const 쓰는곳 = source.match(/nudgeStepWhere\(requestId\)/g) ?? [];
    assert.equal(쓰는곳.length, 2, `${쓰는곳.length}곳에서 쓴다 — 둘이어야 한다`);
    // 🔴 두 질의 중 어느 쪽이든 상태를 제 손으로 다시 적으면 여기서 깨진다.
    // 🔵 `myPendingApprovalWhere`(결재함·배지·종·승인함이 함께 쓰는 공용 조건)에도
    //    같은 줄이 있지만 **그쪽은 다른 질문**이다 — 「지금 내 차례인가」이고,
    //    후보 조회는 일부러 그것을 안 쓴다(넓게 골라 되묻는다). 그래서 파일 전체로
    //    세지 않고 **이 두 질의의 몸통만** 본다.
    for (const fn of [
      "export function approvalNudgeStepCandidatesQuery",
      "export function nudgeStepApproverIdsQuery",
    ]) {
      const at = source.indexOf(fn);
      assert.ok(at > 0, `${fn} 를 찾지 못했다`);
      const body = source.slice(at, source.indexOf("\n}", at));
      assert.ok(body.includes("nudgeStepWhere(requestId)"), `🔵 ${fn}: 본문을 잘못 잘랐다`);
      assert.ok(
        !body.includes("webApprovalSteps.status"),
        `🔴 ${fn} 가 대상 단계를 제 손으로 다시 적었다`,
      );
    }
  });

  check("🔴 단계 주인은 **사람이 박힌 줄만** — 옛 직급 단계는 위임을 못 받는다", () => {
    // 🔴 **못 하는 것이라 적어 둔다.** 사람 칸이 빈 옛 단계는 자리 주인이 번호로
    //    적혀 있지 않아 「그 사람을 대신할 사람」을 구할 길이 없다. 직급으로
    //    꿰맞추면 결재 판정과 어긋나(아래 줄) **알림은 가는데 눌러 보면 거절되는**
    //    사람이 생긴다.
    assert.match(단계주인.sql, /"approver_employee_id" is not null/);
    assert.ok(!/rank_id/.test(단계주인.sql), "🔴 직급으로 주인을 꿰맞추고 있다");
    // 판정 쪽도 옛 단계는 안 넓힌다 — 두 말이 같아야 한다.
    const 위임받은이: Decider = {
      employeeId: 대리인,
      rankId: "rank-대리",
      isApprover: false,
      actingForEmployeeIds: [맡긴이],
    };
    assert.equal(isMyStep({ approverEmployeeId: null, rankId: "rank-과장" }, 위임받은이), false);
    // 🔵 표본이 비지 않았다 — 사람으로 박힌 단계는 열린다.
    assert.equal(isMyStep({ approverEmployeeId: 맡긴이, rankId: "rank-과장" }, 위임받은이), true);
  });

  check("🔴 단계 후보 조회는 **여전히 넓다** — 좁히는 조건을 하나도 안 적는다", () => {
    // 이 조각이 사람을 넓히면서 저쪽을 좁혀 놓으면 **원래 가던 알림**이 줄어든다.
    for (const forbidden of [
      'can_approve" =',
      "web_leave_requests",
      '"web_employees"."is_active"',
      '"web_employees"."is_deleted"',
      "web_portal_approval_delegations",
    ]) {
      assert.ok(!단계후보.sql.includes(forbidden), `🔴 후보 조회가 제 손으로 좁힌다: ${forbidden}`);
    }
  });

  /* ---------------------------------------------------------------- */
  /* 5. 🔴 배선 — 부르는 쪽이 **합친 쪽**을 쓴다                         */
  /* ---------------------------------------------------------------- */

  check("🔴 workflow 가 넘기는 것이 **합친 쪽**이다", () => {
    const workflow = withoutComments(read("src/lib/leave/workflow.ts"));
    assert.match(workflow, /listCandidates: approvalNudgeCandidates,/);
    assert.ok(
      !workflow.includes("approvalNudgeStepCandidatesQuery"),
      "🔴 단계 후보만 넘긴다 — 대리인이 통째로 빠진다",
    );
  });

  check("🔴 합친 쪽이 **거꾸로 조회와 합치는 셈**을 함께 쓴다", () => {
    const source = withoutComments(read("src/lib/leave/data.ts"));
    const at = source.indexOf("export async function approvalNudgeCandidates");
    assert.ok(at > 0, "합친 쪽을 찾지 못했다");
    const body = source.slice(at, source.indexOf("\n}", at));
    for (const 있어야할것 of [
      "approvalNudgeStepCandidatesQuery(requestId)",
      "nudgeStepApproverIdsQuery(requestId)",
      "loadDelegatesForApprovers(",
      "withDelegateCandidates(",
    ]) {
      assert.ok(body.includes(있어야할것), `🔴 ${있어야할것} 를 안 쓴다`);
    }
    // 🔴 기준 시각을 찍는 자리가 **인자의 기본값 하나**다. 몸통에서 또 찍으면
    //    조회마다 다른 「지금」으로 재게 되고, 그 어긋남은 아무 오류도 안 낸다.
    assert.match(body, /now: Date = new Date\(\),/);
    assert.equal(
      (body.match(/new Date\(\)/g) ?? []).length,
      1,
      "🔴 몸통 안에서 지금을 또 찍는다",
    );
  });

  check("🔴 합치는 셈은 **DB 도 판정도 모른다** — 그래야 위 1절을 DB 없이 잴 수 있다", () => {
    const judge = withoutComments(read("src/lib/leave/approval-nudge.ts"));
    assert.ok(judge.includes("export function withDelegateCandidates"), "합치는 함수가 없다");
    for (const forbidden of ["drizzle-orm", "db.select", "@/lib/db", "liveNowParts", "revoked"]) {
      assert.ok(!judge.includes(forbidden), `🔴 합치는 파일이 제 손으로 ${forbidden} 를 쓴다`);
    }
  });

  console.log(`\n${passed}개 통과`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
