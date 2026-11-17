/**
 * 결재권 위임 — **읽는 쪽** 검사.  npm run test:delegation
 *
 * 🔴 DB 에 닿지 않고 사내망에도 나가지 않는다. 질의는 **만들기만** 하고
 * `.toSQL()` 로 구워 본다(drizzle 의 질의는 `await` 할 때 비로소 돈다 —
 * scripts/test-delegation-sync.ts 가 쓰는 그 수법 그대로다).
 *
 * ── 위임이 흐르는 길 (2026-11-16 저녁에 뒤집힌 뒤) ───────────────────────
 *   통합 승인함에서 사람이 「누구의 결재권을 누구에게」를 지정한다 (포털에 저장)
 *     → 포털이 **세 시스템에 써 준다**  POST /api/integration/delegations
 *     → 받는 통로가 포털 번호를 **두 단**으로 바꿔 적는다
 *        (auth_sub → web_users.employee_id → web_employees.id)
 *     → 🔴 **여기부터가 이 검사다.** 사람을 읽을 때 그 표에서 「지금 내가 대신할
 *        수 있는 사람들」을 함께 읽고(auth/guards.ts 의 loadEmployee →
 *        auth/portal-delegations.ts), 그 목록이 「이 단계가 내 것인가」 한 쌍에
 *        실린다(approval-scope.ts 의 isMyStep + myStepCondition).
 *
 * 🔵 **이 파일은 2026-11-16 저녁에 뜻이 통째로 바뀌었다.** 그 전에는 결재할
 * 때마다 포털에 **묻는** 쪽을 쟀고(가짜 포털 서버를 127.0.0.1 에 띄워 「거절
 * 한다」·「영영 답하지 않는다」까지 돌려 봤다), 그 묻는 코드가 설계 B-12 로
 * 통째로 없어졌다. 🔴 **파일을 지우지 않고 다시 썼다** — 1·2·6 절이 재는
 * 「값 판정과 SQL 이 같은 말을 한다」·「자기 신청은 자기가 결재 못 한다」는
 * 자료 출처와 **무관하게 살아남는 울타리**이고, 그 울타리가 이 집에서 가장
 * 비싼 결함 둘을 막고 있기 때문이다.
 *
 * ── 무엇을 지키는가 ─────────────────────────────────────────────────────
 *   1. 🔴 값 판정과 SQL 조건이 **같은 말**을 한다 (한쪽만 넓어지면 「목록엔
 *      뜨는데 누르면 거절」 또는 그 반대가 된다).
 *   2. 🔴 본인이 맨 앞 · 중복 제거 · **이어 붙지 않는다**(A→B, B→C 라도 C 는
 *      A 를 못 얻는다).
 *   3. 🔴 **살아 있는 줄만** 읽는다 — 거둔 줄과 기간 밖은 안 본다. 기준 시각이
 *      인자라 **요청마다 다시 재진다**(끝나면 저절로 닫힌다).
 *   4. 🔴 **메뉴·배지·종이 같은 판정**을 쓴다 — 읽는 자리가 하나다.
 *   5. 🔴 **자기 신청은 자기가 결재 못 한다** — 위임으로도 못 넘는다.
 *   6. 🔴 묻던 길이 **빠짐없이** 걷혔고, 🔴 **받는 쪽이 쓰는 것은 남아 있다.**
 *
 * 🔵 **보여 주는 쪽은 여기서 재지 않는다** — [휴가 설정 → 결재권 위임] 탭과 결재함
 * 안내(2026-11-17, 조각 3c)는 scripts/test-delegation-screen.ts 가 잰다. 이 파일이
 * 지키는 것은 **판정**이다.
 *
 * 🔴 왜 전부 main() 안에 있나: 이 저장소의 검사는 tsx 가 CJS 로 돌려
 * (package.json 에 type:module 이 없다) 최상위 await 을 쓸 수 없다.
 * 🔴 **DB 를 건드리는 모듈은 `await import` 로 불러온다** — `src/lib/db` 는
 * 모듈을 읽는 순간 DATABASE_URL 을 읽는데, 정적 import 는 아래 환경 설정보다
 * **먼저** 돌기 때문이다(esbuild 가 import 를 위로 끌어올린다).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// 🔴 .env.local 을 읽지 않는다 — 이 검사는 여기 적힌 값으로만 돈다.
//    DATABASE_URL 은 **아무 데도 붙지 않는 주소**다. 질의를 만들기만 하므로
//    끝까지 접속이 일어나지 않는다.
process.env.SSO_ISSUER = "http://127.0.0.1:1";
process.env.SSO_CLIENT_ID = "dss-leave";
process.env.SSO_CLIENT_SECRET = "테스트용-시크릿";
process.env.SSO_REDIRECT_URI = "http://192.168.1.10:3700/api/auth/sso/callback";
process.env.SSO_TX_SECRET = "0123456789abcdef0123456789abcdef";
process.env.DATABASE_URL = "postgres://nobody:nobody@127.0.0.1:1/none";

import { PgDialect } from "drizzle-orm/pg-core";

import {
  approvableEmployeeIds,
  canOpenApprovalBox,
  isMyStep,
  myStepCondition,
  type Decider,
  type StepOwner,
} from "../src/lib/leave/approval-scope";

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

/**
 * `src/` 아래 모든 소스를 **주석을 걷어** 읽는다. 걷어낸 이름이 어디에도 남지
 * 않았음을 보이는 자리다 — 🔴 한 파일만 보고 「없다」고 하면 빠뜨린 자리가
 * 그대로 돈다.
 */
function allSources(): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(new URL(`../${rel}`, import.meta.url), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) walk(`${rel}${entry.name}/`);
      else if (/\.tsx?$/.test(entry.name)) {
        const path = `${rel}${entry.name}`;
        out.push({ path, code: withoutComments(read(path)) });
      }
    }
  };
  walk("src/");
  return out;
}

/* ------------------------------------------------------------------ */
/* 가짜 값 — 🔴 실제 이름·사번을 한 자도 넣지 않는다                     */
/* ------------------------------------------------------------------ */

const 나 = "emp-나";
const 맡긴이 = "emp-맡긴이";
const 제삼자 = "emp-제삼자";

function decider(over: Partial<Decider> = {}): Decider {
  return { employeeId: 나, rankId: "rank-과장", isApprover: true, ...over };
}
function step(approverEmployeeId: string | null, rankId = "rank-과장"): StepOwner {
  return { approverEmployeeId, rankId };
}

/** SQL 조건을 펼쳐 본다 — 값 판정과 맞대어 보려는 것이다. */
function sqlOf(me: Decider) {
  return new PgDialect().sqlToQuery(myStepCondition(me));
}

async function main() {
  console.log("\n결재권 위임 (포털이 써 준 것을 제 표에서 읽는다)\n");

  /* ---------------------------------------------------------------- */
  /* 1. 목록 만들기 — 본인이 맨 앞 · 중복 제거 · 이어 붙지 않는다        */
  /* ---------------------------------------------------------------- */

  check("본인이 **언제나 맨 앞**이다 — 위임이 하나도 없어도 내 단계는 눌린다", () => {
    assert.deepEqual(approvableEmployeeIds(decider()), [나]);
    assert.deepEqual(approvableEmployeeIds(decider({ actingForEmployeeIds: [] })), [나]);
    assert.deepEqual(approvableEmployeeIds(decider({ actingForEmployeeIds: [맡긴이] })), [
      나,
      맡긴이,
    ]);
  });

  check("중복을 걷는다 — 겹치는 위임이 둘이거나 본인이 섞여 들어와도", () => {
    assert.deepEqual(
      approvableEmployeeIds(decider({ actingForEmployeeIds: [나, 맡긴이, 맡긴이] })),
      [나, 맡긴이],
    );
  });

  check("🔴 이어 붙지 않는다 — A→B, B→C 라도 C 는 A 를 못 얻는다", () => {
    // 읽는 질의가 `delegate_employee_id = 나` 한 줄만 보고 재귀하지 않는다.
    // 여기서 한 번 더 이어 붙이면 아무도 지정하지 않은 결재권이 생긴다.
    const 대리인C = decider({ employeeId: 제삼자, actingForEmployeeIds: [맡긴이] });
    assert.deepEqual(approvableEmployeeIds(대리인C), [제삼자, 맡긴이]);
    assert.equal(isMyStep(step(나), 대리인C), false, "🔴 이어 붙어 남의 결재권이 생겼다");
  });

  /* ---------------------------------------------------------------- */
  /* 2. 🔴 값 판정과 SQL 이 **같은 말**을 한다                           */
  /* ---------------------------------------------------------------- */

  check("위임을 받으면 맡긴 사람의 단계가 내 것이 된다 (값)", () => {
    const 대리인 = decider({ actingForEmployeeIds: [맡긴이] });
    // 🔵 표본이 비어 공짜로 통과하지 않게 — **위임 없을 때는 아니었다**를 먼저.
    assert.equal(isMyStep(step(맡긴이), decider()), false);
    assert.equal(isMyStep(step(맡긴이), 대리인), true);
    // 아무 상관없는 사람의 단계는 여전히 남의 것이다.
    assert.equal(isMyStep(step(제삼자), 대리인), false);
  });

  check("🔴 SQL 조건이 값 판정과 **같은 목록**을 싣는다", () => {
    const 대리인 = decider({ actingForEmployeeIds: [맡긴이] });
    const { sql: text, params } = sqlOf(대리인);
    assert.match(text, /"approver_employee_id" in \(\$1, \$2\)/);
    // 🔴 맞대어 본다 — 값이 참이라고 한 사람만, 그 차례대로 실려 있어야 한다.
    const 값이참인사람 = [나, 맡긴이, 제삼자].filter((who) => isMyStep(step(who), 대리인));
    assert.deepEqual(값이참인사람, [나, 맡긴이]);
    assert.deepEqual(params.slice(0, 2), 값이참인사람);
  });

  check("🔴 둘이 함께 넓어진다 — 한쪽만 고치면 여기서 깨진다", () => {
    // 위임자가 둘·셋으로 늘어도 값과 SQL 이 같은 수를 싣는가.
    for (const acting of [[], [맡긴이], [맡긴이, 제삼자]]) {
      const me = decider({ actingForEmployeeIds: acting });
      const { params } = sqlOf(me);
      const 주인들 = [나, 맡긴이, 제삼자].filter((who) => isMyStep(step(who), me));
      assert.deepEqual(주인들, approvableEmployeeIds(me), `값이 어긋난다: ${acting}`);
      // params 뒤에는 옛 직급 갈래의 rank_id 가 하나 더 붙는다.
      assert.deepEqual(params.slice(0, 주인들.length), 주인들, `SQL 이 어긋난다: ${acting}`);
      assert.equal(params.length, 주인들.length + 1);
    }
  });

  check("🔴 위임은 **옛 직급 단계**를 넓히지 않는다 (값·SQL 둘 다)", () => {
    // 사람 칸이 빈 옛 단계는 예전대로 **내 직급**으로만 판정한다. 위임이
    // 가리키는 것은 사람뿐이라 맡긴 사람의 직급을 알 수 없고, 직급까지 빌려
    // 오면 그 직급에 걸린 **남의** 옛 단계가 통째로 열린다.
    const 대리인 = decider({ rankId: "rank-대리", isApprover: false, actingForEmployeeIds: [맡긴이] });
    assert.equal(isMyStep(step(null, "rank-과장"), 대리인), false);
    assert.equal(isMyStep(step(null, "rank-대리"), 대리인), false, "직급 결재권이 없다");
    const { sql: text, params } = sqlOf(대리인);
    assert.equal(/rank_id/.test(text), false, "🔴 결재권 없는 사람에게 옛 직급 갈래가 열렸다");
    assert.deepEqual(params, [나, 맡긴이]);
  });

  check("🔴 판정 한 쌍은 **DB 를 모른다** — 그래야 값과 SQL 이 갈리지 않는다", () => {
    // 위임이 같은 DB 의 표에 있으니 SQL 쪽만 `in (select …)` 로 바꿀 수도 있다.
    // 그러면 값 쪽(isMyStep)은 순수 함수라 따라갈 수가 없어 둘이 다른 말을 한다.
    const scope = withoutComments(read("src/lib/leave/approval-scope.ts"));
    assert.ok(scope.includes("approvableEmployeeIds"), "표본이 비었다 — 파일을 잘못 읽었다");
    // 🔵 칸 이름(@/lib/db/schema)은 읽어도 된다 — SQL 조각을 만드는 데 필요하다.
    //    못 쓰는 것은 **접속**(@/lib/db 의 db)이다.
    assert.ok(!/from "@\/lib\/db"/.test(scope), "판정이 DB 접속을 끌어왔다");
    assert.ok(!scope.includes("webPortalApprovalDelegations"), "판정이 표를 직접 읽는다");
  });

  /* ---------------------------------------------------------------- */
  /* 3. 🔴 살아 있는 줄만 — 구워진 SQL 로 본다                           */
  /* ---------------------------------------------------------------- */

  const delegations = await import("../src/lib/auth/portal-delegations");
  const 어느날 = new Date("2027-03-05T00:00:00.000Z");
  // 🔵 「나」가 **대신 누르는 사람**이다 — 질의가 찾는 것은 그 사람에게 걸린
  //    위임이고, 돌려주는 것은 **맡긴 사람들**이다.
  const baked = delegations.actingForEmployeeIdsQuery(나, 어느날).toSQL();

  check("🔴 **거둔 줄은 안 본다** — revoked_at 이 비어 있어야 살아 있다", () => {
    assert.match(baked.sql, /"revoked_at" is null/);
    assert.ok(!/"revoked_at" is not null/.test(baked.sql), "거꾸로 읽고 있다");
  });

  check("🔴 기간이 **반열린 구간**이다 — 끝나는 순간이 한 번 더 열리지 않게", () => {
    // starts_at <= 지금 < ends_at. 끝을 `<=` 로 적으면 끝난 그 순간이 한 번 더
    // 열리고, 그 한 번은 아무 오류도 내지 않는다.
    assert.match(baked.sql, /"starts_at" <= \$\d+/);
    assert.match(baked.sql, /"ends_at" > \$\d+/);
    assert.ok(!/"ends_at" >= /.test(baked.sql), "🔴 끝나는 순간이 아직 열려 있다");
    assert.ok(!/"starts_at" < \$/.test(baked.sql), "🔴 시작하는 순간이 안 열린다");
  });

  check("🔴 **대리인으로 찾아 맡긴 사람을 돌려준다** — 방향이 뒤집히면 아무도 못 누른다", () => {
    assert.match(baked.sql, /"delegate_employee_id" = \$\d+/);
    assert.match(baked.sql, /select distinct "delegator_employee_id"/);
    assert.ok(baked.params.includes(나), "🔵 찾는 번호를 안 묶었다 — 아무것도 재지 못했다");
    // 🔴 「나를 누가 대신하나」(거꾸로 방향)를 꽂으면 오류 없이 아무도 못 누른다.
    assert.ok(
      !/"delegator_employee_id" = \$/.test(baked.sql),
      "🔴 거꾸로 방향으로 찾고 있다",
    );
  });

  check("🔴 이어 붙을 길이 SQL 에 없다 — 표 하나만 본다", () => {
    assert.equal((baked.sql.match(/from "/g) ?? []).length, 1, "하위 질의·조인이 생겼다");
    assert.ok(!/recursive/i.test(baked.sql));
    assert.ok(!/ join /i.test(baked.sql));
  });

  check("🔵 같은 번호를 두 번 싣지 않고 차례가 못 박혀 있다", () => {
    // 한 사람에게 기간이 겹치는 위임이 둘 걸릴 수 있다. 합치는 쪽이 중복을 다시
    // 걷지만, 여기서 줄여 두면 결재함 SQL 의 `in (…)` 이 깔끔하다.
    assert.match(baked.sql, /select distinct /);
    assert.match(baked.sql, /order by "web_portal_approval_delegations"\."delegator_employee_id"/);
  });

  check("🔴 기준 시각이 **박혀 있지 않다** — 요청마다 다시 재진다", () => {
    // 이것이 「위임이 끝나면 메뉴도 닫힌다」의 밑바탕이다. 시각을 어딘가에 굽거나
    // 캐 두면 「끝났는데 아직 열려 있는」 위임이 생기고, 그것은 아무 오류도 내지
    // 않는다.
    const 나중 = delegations
      .actingForEmployeeIdsQuery(나, new Date("2028-03-05T00:00:00.000Z"))
      .toSQL();
    assert.equal(나중.sql, baked.sql, "문장이 시각에 따라 달라진다 — 상수를 굽고 있다");
    assert.notDeepEqual(나중.params, baked.params, "🔴 시각이 묶이지 않는다");
    // 기본값이 **지금**이다 — 부르는 쪽이 깜빡해도 과거에 멈추지 않는다.
    const source = withoutComments(read("src/lib/auth/portal-delegations.ts"));
    assert.match(source, /now: Date = new Date\(\)/);
    // 🔴 조건을 만드는 자리에는 시각을 만들지 않는다(인자로만 받는다).
    const where = source.slice(source.indexOf("export function liveDelegationWhere"));
    assert.ok(
      !where.slice(0, where.indexOf("\n}")).includes("new Date()"),
      "🔴 조건이 제 손으로 지금을 찍는다",
    );
  });

  check("🔴 살아 있는 줄의 조건은 **한 곳에만** 있다", () => {
    const 적힌곳 = allSources().filter((f) => f.code.includes("webPortalApprovalDelegations"));
    assert.ok(적힌곳.length > 0, "🔵 표를 쓰는 파일이 하나도 없다 — 잘못 읽었다");
    // 읽는 조건(revoked_at is null + 기간)은 portal-delegations.ts 하나뿐이고,
    // 나머지 둘은 **쓰는 쪽**(받는 통로의 upsert·revoke)과 스키마다.
    const 조건을적은곳 = 적힌곳.filter((f) => f.code.includes("isNull(webPortalApprovalDelegations.revokedAt)"));
    assert.deepEqual(
      조건을적은곳.map((f) => f.path),
      ["src/lib/auth/portal-delegations.ts"],
    );
  });

  /* ---------------------------------------------------------------- */
  /* 4. 🔴 메뉴 · 배지 · 종 — **같은 판정**을 쓴다                       */
  /* ---------------------------------------------------------------- */

  const guards = withoutComments(read("src/lib/auth/guards.ts"));
  const data = withoutComments(read("src/lib/leave/data.ts"));
  const actor = withoutComments(read("src/lib/auth/portal-actor.ts"));
  const notif = withoutComments(read("src/lib/leave/portal-notifications.ts"));
  const header = withoutComments(read("src/components/AppHeader.tsx"));

  check("🔴 결재함 문이 위임에도 열린다 — 직급도 결재선도 없는 사람", () => {
    // 조각 5 에서 드러난 결함 그 자체다: 위임만 받은 사람은 대신 누를 결재가
    // 생겨도 머리말에 「결재함」 메뉴가 아예 안 그려져 주소를 쳐야 보였다.
    const 위임만받은사람 = { rankCanApprove: false, onApprovalRoute: false };
    assert.equal(canOpenApprovalBox(위임만받은사람), false, "🔵 표본이 비었다 — 원래 열려 있었다");
    assert.equal(
      canOpenApprovalBox({ ...위임만받은사람, actingForEmployeeIds: [맡긴이] }),
      true,
    );
  });

  check("🔴 **위임이 끝나면 문이 닫힌다** — 열어 둠을 적어 두는 칸이 없다", () => {
    // 여는 조건과 닫는 조건이 같은 값 하나다. 기간이 지나면 위 질의가 빈 목록을
    // 돌려주고(ends_at > 지금), 빈 목록이면 이 문은 닫힌다.
    const 끝난뒤 = { rankCanApprove: false, onApprovalRoute: false, actingForEmployeeIds: [] };
    assert.equal(canOpenApprovalBox(끝난뒤), false);
    // 🔴 결재 권한도 함께 닫힌다 — 문만 닫히고 판정이 남으면 더 나쁘다.
    assert.equal(isMyStep(step(맡긴이), decider({ actingForEmployeeIds: [] })), false);
  });

  check("🔴 직급·결재선으로 열리던 문은 **그대로** 열린다", () => {
    assert.equal(canOpenApprovalBox({ rankCanApprove: true, onApprovalRoute: false }), true);
    assert.equal(canOpenApprovalBox({ rankCanApprove: false, onApprovalRoute: true }), true);
  });

  await checkAsync(
    "🔴 위임만 받은 사람의 **결재함 조회**에 맡긴 사람 단계가 들고 제 신청은 빠진다",
    async () => {
      // 문(canOpenApprovalBox)과 **목록**은 다른 판정이다. 문만 열리고 목록이
      // 비면 들어가 봤자 빈 화면이라 결함이 그대로 남는다.
      const { myPendingApprovalWhere } = await import("../src/lib/leave/data");
      const 위임만받은사람 = decider({
        rankId: "rank-대리",
        isApprover: false,
        actingForEmployeeIds: [맡긴이],
      });
      const { sql: text, params } = new PgDialect().sqlToQuery(
        myPendingApprovalWhere(위임만받은사람),
      );
      // 맡긴 사람의 단계가 「내 것」으로 들어온다.
      assert.match(text, /"approver_employee_id" in \(\$\d+, \$\d+\)/);
      assert.equal(params.filter((p) => p === 맡긴이).length, 1, "맡긴 사람 단계가 안 든다");
      // 🔴 **자기 신청을 빼는 울타리는 「누른 사람」으로 남아 있다.** 맡긴 사람의
      //    번호로 빼면 **맡긴 사람의 휴가가 대리인에게 안 보이게 된다** —
      //    대신 결재하라고 맡긴 바로 그 건이다.
      const 뺀자리 = /"employee_id" <> \$(\d+)/.exec(text);
      assert.ok(뺀자리, "자기 신청을 빼는 울타리가 사라졌다");
      assert.equal(params[Number(뺀자리[1]) - 1], 나);
    },
  );

  check("🔴 문을 넓혔다고 **사유 열람**까지 넓어지지 않았다", () => {
    // 달력에서 남의 휴가 사유를 보는 것은 **직급의 결재권**만 연다(canSeeReason).
    // 위임으로 그것까지 열면 「며칠 대신 눌러 달라」가 **그 기간 전 직원의 휴가
    // 사유를 읽는 권한**이 된다 — 아무도 그렇게 맡긴 적이 없다.
    const at = guards.indexOf("export function canSeeReason");
    assert.ok(at > 0, "사유 열람 판정을 찾지 못했다");
    const body = guards.slice(at, guards.indexOf("\n}", at));
    assert.ok(body.includes("viewer.isApprover"), "🔵 표본이 비었다 — 본문을 잘못 잘랐다");
    assert.ok(!body.includes("acting"), "🔴 위임이 사유 열람까지 열었다");
    assert.ok(!body.includes("canOpenApprovals"), "🔴 넓어진 문을 사유 열람이 따라갔다");
  });

  check("🔴 **읽는 자리가 하나다** — 사람을 읽을 때 함께 읽는다", () => {
    // 🔵 여기서 말하는 「읽는 자리」는 **판정이 쓰는 번호 목록**이다. 2026-11-17 에
    //    화면이 쓰는 조회(이름·기간)가 같은 파일에 따로 생겼는데, 그쪽은 아직
    //    **시작 전인 줄까지** 싣기 때문에 판정에 쓰면 안 된다 — 그 금은
    //    scripts/test-delegation-screen.ts 가 잰다. 이 검사는 번호 목록만 본다.
    assert.ok(guards.includes("loadActingForEmployeeIds(employeeId)"), "사람을 읽을 때 안 읽는다");
    // 🔴 부르는 곳이 여럿이면 「메뉴는 있는데 배지가 0」처럼 어긋나도 아무 오류가
    //    안 나는 모양이 된다. 정의한 파일 말고는 **guards.ts 한 곳**이어야 한다.
    const 부르는곳 = allSources().filter(
      (f) =>
        f.path !== "src/lib/auth/portal-delegations.ts" &&
        f.code.includes("loadActingForEmployeeIds"),
    );
    assert.deepEqual(부르는곳.map((f) => f.path), ["src/lib/auth/guards.ts"]);
  });

  check("🔴 그 한 값이 **메뉴·배지·종 셋**으로 갈라져 나간다", () => {
    // ① 메뉴 — 결재함 문(canOpenApprovals)이 그 값을 본다.
    assert.ok(guards.includes("actingForEmployeeIds: employee.actingForEmployeeIds,"));
    assert.ok(header.includes("viewer.canOpenApprovals &&"), "메뉴가 다른 값을 본다");
    // ② 배지 — 건수 질의가 쓰는 「나」에 그 값이 실린다.
    assert.ok(data.includes("actingForEmployeeIds: employee.actingForEmployeeIds,"));
    assert.ok(data.includes("deciderOf(viewer.employee, viewer.isApprover)"));
    // ③ 종 — 포털 쪽 사람도 같은 길로 읽혀 같은 값을 싣는다.
    assert.ok(actor.includes("loadEmployee(user.employeeId)"));
    assert.ok(notif.includes("actingForEmployeeIds: viewer.employee.actingForEmployeeIds,"));
  });

  check("🔴 조회가 **스스로 읽지 않는다** — 싣는 자리는 deciderOf 한 곳", () => {
    assert.ok(!data.includes("loadActingForEmployeeIds"), "조회가 제 손으로 읽는다");
    // 🔴 넘겨받는 꼴이면 빠뜨린 자리에서 「대신 누를 결재가 목록에만 안 뜬다」가
    //    된다. 그래서 건수·목록 둘 다 인자 없이 같은 함수를 부른다.
    assert.equal((data.match(/deciderOf\(viewer\.employee, viewer\.isApprover\)/g) ?? []).length, 2);
    // 🔴 넷이 쓰는 그 **한 문장**은 그대로다.
    assert.ok(data.includes("myStepCondition(me)"));
  });

  /* ---------------------------------------------------------------- */
  /* 5. 🔴 결재 실행 — 거래를 열기 **전에** 읽은 값을 들고 들어간다       */
  /* ---------------------------------------------------------------- */

  const workflow = withoutComments(read("src/lib/leave/workflow.ts"));
  const action = withoutComments(read("src/app/actions/leave.ts"));
  const screen = withoutComments(read("src/app/(internal)/approvals/page.tsx"));

  check("🔴 서버 액션이 위임 목록을 decideStep 에 **넘긴다**", () => {
    const at = action.indexOf("export async function decideAction");
    assert.ok(at > 0, "decideAction 을 찾지 못했다");
    const body = action.slice(at);
    assert.ok(
      body.includes("member.employee.actingForEmployeeIds,"),
      "🔴 안 넘기면 목록엔 뜨는데 눌러도 거절된다",
    );
    // 열쇠는 **검증된 세션**에서 온 사람이다 — 폼에서 온 값으로 사람을 고르지 않는다.
    assert.ok(body.includes("const member = await requireMember();"));
    assert.ok(!/formData[^)]*acting/i.test(body), "🔴 폼에서 온 값으로 결재권을 정한다");
  });

  check("🔴 workflow.ts 는 **거래 안에서 읽지 않는다**", () => {
    for (const forbidden of ["loadActingForEmployeeIds", "@/lib/auth/portal-delegations", "fetch("]) {
      assert.ok(!workflow.includes(forbidden), `🔴 거래 안에서 밖을 부른다: ${forbidden}`);
    }
    // 받은 값을 판정에 그대로 싣는다.
    assert.ok(workflow.includes("actingForEmployeeIds,"));
    assert.ok(workflow.includes("const mine = isMyStep(step, {"));
  });

  check("🔴 결재함 화면이 **목록에는** 아무것도 더 하지 않는다 — 조회가 제 손으로 싣는다", () => {
    // 🔵 **2026-11-17 에 뜻이 좁아졌다.** 그 전에는 「이 화면은 위임에 대해 아무
    //    것도 안 한다」였는데, 그날 조각 3c 가 **읽기 전용 안내**를 맨 위에 더했다
    //    (위임을 받으면 남의 건이 목록에 갑자기 나타나는데 까닭을 알 길이 없었다).
    // 🔴 **그래도 금은 그대로다**: 화면은 「누가 결재할 수 있나」에 한 글자도
    //    보태지 않는다. 목록은 인자 하나로 부르고, 위임 목록을 제 손으로 나르지
    //    않는다 — 나르기 시작하면 「목록엔 뜨는데 눌러도 거절」이 되돌아온다.
    assert.ok(screen.includes("pendingForApprover(member)"));
    assert.ok(!screen.includes("actingForEmployeeIds"), "화면이 판정 목록을 따로 나른다");
    // 🔴 안내가 읽는 것은 **화면 전용 조회**(이름과 기간)이고, 그 값이 목록 조회로
    //    흘러들지 않는다. 섞이면 판정이 화면에서 갈라져 나온다.
    assert.ok(screen.includes("<DelegationNotice"), "안내가 사라졌다 — 조각 3c 가 되돌려졌나");
    assert.ok(
      !/pendingForApprover\(member,/.test(screen),
      "🔴 목록 조회에 무언가를 더 넘긴다",
    );
    assert.ok(!screen.includes("isMyStep"), "🔴 화면이 제 손으로 판정한다");
  });

  /* ---------------------------------------------------------------- */
  /* 6. 🔴 자기 신청은 자기가 결재 못 한다 — 위임으로도 못 넘는다         */
  /* ---------------------------------------------------------------- */

  check("🔴 결재함 조회가 **누른 사람**으로 자기 신청을 뺀다 (맡긴 사람이 아니다)", () => {
    const at = data.indexOf("export function myPendingApprovalWhere");
    assert.ok(at > 0, "공용 조건을 찾지 못했다");
    const body = data.slice(at, data.indexOf("\nexport ", at + 1));
    assert.ok(
      body.includes("ne(webLeaveRequests.employeeId, me.employeeId)"),
      "🔴 울타리가 사라졌다 — 남의 결재권을 빌려 제 휴가를 제가 승인하게 된다",
    );
    // 🔴 위임 목록으로 빼면 **맡긴 사람의 휴가**가 대리인에게 안 보이게 된다.
    assert.ok(!body.includes("actingForEmployeeIds"));
  });

  check("🔴 결재 실행도 **누른 사람**으로 막는다", () => {
    const at = workflow.indexOf("export async function decideStep");
    assert.ok(at > 0, "decideStep 을 찾지 못했다");
    const body = workflow.slice(at);
    assert.ok(
      body.includes("if (!mine || req.employeeId === member.employee.id) {"),
      "🔴 자기 신청 울타리가 바뀌었다",
    );
  });

  /* ---------------------------------------------------------------- */
  /* 7. 🔴 묻던 길이 걷혔고, 🔴 받는 쪽은 남아 있다                      */
  /* ---------------------------------------------------------------- */

  const sources = allSources();

  check("🔵 표본이 비지 않았다 — src 를 실제로 읽었다", () => {
    assert.ok(sources.length > 50, `읽은 파일이 ${sources.length}개뿐이다`);
    assert.ok(sources.some((f) => f.path === "src/lib/leave/workflow.ts"));
  });

  check("🔴 포털에 **묻던** 이름이 src 어디에도 없다", () => {
    for (const 걷어낸이름 of [
      "fetchPortalActingSubjects",
      "resolvePortalActingDelegations",
      "resolveActingDelegations",
      "NO_PORTAL_DELEGATIONS",
      "PortalActingDelegations",
      "approval-delegation",
    ]) {
      const 남은곳 = sources.filter((f) => f.code.includes(걷어낸이름));
      assert.deepEqual(남은곳.map((f) => f.path), [], `🔴 ${걷어낸이름} 가 남아 있다`);
    }
  });

  check("🔴 「못 물었다」라는 **상태 자체**가 없다", () => {
    // 🔴 **`unavailable` 이라는 낱말 자체는 금지하지 않는다.** 통합 승인함에
    //    내주는 답에도 같은 칸이 있는데(portal-approvals.ts 의
    //    `unavailable: "employee_not_linked"`) 그것은 **다른 뜻**이다 — 「이
    //    시스템에 명단이 안 이어졌다」이고 위임과 아무 상관이 없다. 넓게 금지하면
    //    멀쩡한 쓰임을 지우게 된다.
    for (const 걷어낸이름 of [
      "portalDelegationUnavailable",
      "notePortalOutage",
      "PORTAL_DELEGATION_UNAVAILABLE_NOTICE",
      "portal.unavailable",
    ]) {
      const 남은곳 = sources.filter((f) => f.code.includes(걷어낸이름));
      assert.deepEqual(남은곳.map((f) => f.path), [], `🔴 ${걷어낸이름} 가 남아 있다`);
    }
    // 사람에게 보이던 안내 글도 함께 걷혔다.
    assert.ok(!sources.some((f) => f.code.includes("결재권 위임을 확인하지 못했습니다")));
  });

  check("🔴 **받는 통로가 쓰는 것은 남아 있다** — 같이 쓸려 나가기 쉬운 자리", () => {
    // 없어지면 포털의 전파가 500 으로 거절되고 **세 시스템의 위임 지정이 통째로
    // 막힌다**(설계 B-13). 두 단 변환의 첫 단이라 이름이 「묻기」처럼 보인다.
    const wiring = withoutComments(read("src/lib/auth/portal-delegations.ts"));
    assert.match(wiring, /export async function findEmployeeIdsBySubjects/);
    const route = withoutComments(read("src/app/api/integration/delegations/route.ts"));
    assert.ok(route.includes("lookup: findEmployeeIdsBySubjects"), "🔴 통로가 그것을 안 꽂는다");
    // 거르는 줄이 읽는 쪽·화면과 한 벌이어야 「읽을 때는 되는데 쓸 때는 안 되는」
    // 사람이 안 생긴다.
    assert.ok(wiring.includes("eq(webUsers.isActive, true)"));
    assert.ok(wiring.includes("eq(webUsers.isDeleted, false)"));
  });

  await checkAsync("🔴 uuid 모양이 아닌 번호는 **DB 에 묻기 전에** 버린다", async () => {
    // auth_sub 는 uuid 열이라 모양이 아닌 값으로 조회하면 드라이버가 던진다.
    // 🔵 이 호출은 DB 에 닿지 않는다 — 걸러 내고 나면 물을 것이 없어 바로 끝난다.
    assert.deepEqual(await delegations.findEmployeeIdsBySubjects(["그냥-글자", ""]), []);
  });

  console.log(`\n${passed}개 통과`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
