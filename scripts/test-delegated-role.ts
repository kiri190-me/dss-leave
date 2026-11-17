/**
 * 결재권 위임이 **역할까지 넘긴다** — 검사.  npm run test:delegated-role
 *
 * 🔴 DB 에 닿지 않고 사내망에도 나가지 않는다. 질의는 **만들기만** 하고
 * `.toSQL()` 로 구워 본다(drizzle 의 질의는 `await` 할 때 비로소 돈다 —
 * scripts/test-approval-delegation.ts 가 쓰는 그 수법 그대로다).
 *
 * ── 무엇을 지키는가 ─────────────────────────────────────────────────────
 *   1. 🔴 `LEAVE_ADMIN` 이 맡긴 위임의 대리인은 **기간 동안 휴가 관리자**다.
 *      `MEMBER` 가 맡긴 위임은 **역할을 안 넘긴다.**
 *   2. 🔴 **기간이 끝나거나 거둔 위임은 안 넘긴다** — 거르는 자리가 결재권과
 *      **같은 한 곳**이라 저절로 닫힌다. 새 거르개를 한 줄도 안 적었다.
 *   3. 🔴 **진짜 휴가 관리자는 한 톨도 안 좁아진다.**
 *   4. 🔴 **임시 관리자는 「역할 변경」만 못 한다** — 서버 액션이 거절하고,
 *      그 울타리를 거는 자리가 **하나뿐**이다(나머지 관리자 문은 2026-11-17 에
 *      쓰는 분이 알고 열어 둔 것이다 — 늘리는 것은 결정을 바꾸는 일이다).
 *   5. 🔴 **결재 판정은 한 글자도 안 바뀌었다** — 역할이 올라가도 결재선에
 *      없으면 못 누른다.
 *   6. 🔴 **DB 의 역할 칸을 안 쓴다** — 판정 시점 계산이다.
 *   7. 🔵 **못 하는 것은 못 한다** — 명단에 안 이어진 관리자는 위임자가 될 수
 *      없고, 이 집에 로그인한 적 없는 위임자는 역할이 없다.
 *   8. 🔵 머리말이 「임시」를 적고 **기간 보는 자리로 보낸다.**
 *
 * 🔴 왜 전부 main() 안에 있나: 이 저장소의 검사는 tsx 가 CJS 로 돌려
 * (package.json 에 type:module 이 없다) 최상위 await 을 쓸 수 없다.
 * 🔴 **DB 를 건드리는 모듈은 `await import` 로 불러온다** — `src/lib/db` 는
 * 모듈을 읽는 순간 DATABASE_URL 을 읽는데, 정적 import 는 아래 환경 설정보다
 * **먼저** 돌기 때문이다(esbuild 가 import 를 위로 끌어올린다).
 * 🔵 `delegated-role.ts` 는 정적으로 불러도 된다 — 거기서 끌어오는 것은
 *    `import type` 하나라 컴파일에서 통째로 지워진다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 🔴 .env.local 을 읽지 않는다 — 이 검사는 여기 적힌 값으로만 돈다.
//    DATABASE_URL 은 **아무 데도 붙지 않는 주소**다. 질의를 만들기만 하므로
//    끝까지 접속이 일어나지 않는다.
process.env.SSO_ISSUER = "http://127.0.0.1:1";
process.env.SSO_CLIENT_ID = "dss-leave";
process.env.SSO_CLIENT_SECRET = "테스트용-시크릿";
process.env.SSO_REDIRECT_URI = "http://192.168.1.10:3700/api/auth/sso/callback";
process.env.SSO_TX_SECRET = "0123456789abcdef0123456789abcdef";
process.env.DATABASE_URL = "postgres://nobody:nobody@127.0.0.1:1/none";

import {
  DELEGATED_ADMIN_SOURCE_ROLE,
  SET_ROLE_DELEGATED_ADMIN_MESSAGE,
  decideDelegatedAdmin,
  mayChangeUserRole,
  needsDelegatorRoles,
} from "../src/lib/auth/delegated-role";
import {
  approvableEmployeeIds,
  canOpenApprovalBox,
  isMyStep,
  type Decider,
  type StepOwner,
} from "../src/lib/leave/approval-scope";
import { applyDelegationCommand } from "../src/lib/leave/portal-delegation-sync";
import { settingsTabHref, settingsTabsFor } from "../src/lib/leave/settings-tabs";

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

/** 그 함수 하나의 몸통만. 🔴 파일 전체로 세면 옆 함수의 줄이 묻어 들어온다. */
function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `🔴 자를 자리를 못 찾았다: ${from}`);
  const rest = source.slice(start + from.length);
  const end = rest.indexOf(to);
  return end >= 0 ? rest.slice(0, end) : rest;
}

const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/* ------------------------------------------------------------------ */
/* 가짜 값 — 🔴 실제 이름·사번을 한 자도 넣지 않는다                     */
/* ------------------------------------------------------------------ */

const 나 = "emp-나";
const 맡긴관리자 = "emp-맡긴관리자";
const 맡긴직원 = "emp-맡긴직원";
const 제삼자 = "emp-제삼자";

function decider(over: Partial<Decider> = {}): Decider {
  return { employeeId: 나, rankId: "rank-사원", isApprover: false, ...over };
}
function step(approverEmployeeId: string | null, rankId = "rank-과장"): StepOwner {
  return { approverEmployeeId, rankId };
}

async function main() {
  console.log("\n결재권 위임이 역할까지 넘긴다 (임시 휴가 관리자)\n");

  const bake = (query: { toSQL: () => { sql: string; params: unknown[] } }) => query.toSQL();

  /* ---------------------------------------------------------------- */
  /* 1. 순수 판정 — 누가 임시 관리자가 되나                             */
  /* ---------------------------------------------------------------- */

  check("🔴 휴가 관리자가 맡긴 위임을 받으면 **임시 휴가 관리자**가 된다", () => {
    // 🔵 표본이 비어 공짜로 통과하지 않게 — **위임이 없을 때는 아니었다**를 먼저.
    assert.deepEqual(decideDelegatedAdmin("MEMBER", []), {
      isAdmin: false,
      delegatedAdmin: false,
    });
    assert.deepEqual(decideDelegatedAdmin("MEMBER", ["LEAVE_ADMIN"]), {
      isAdmin: true,
      delegatedAdmin: true,
    });
  });

  check("🔴 휴가 관리자가 **아닌** 사람이 맡긴 위임은 역할을 안 넘긴다", () => {
    // 넘길 것이 없다. 결재권만 넘어가고 관리자 문은 그대로 닫혀 있다.
    assert.deepEqual(decideDelegatedAdmin("MEMBER", ["MEMBER"]), {
      isAdmin: false,
      delegatedAdmin: false,
    });
    assert.deepEqual(decideDelegatedAdmin("MEMBER", ["MEMBER", "MEMBER"]), {
      isAdmin: false,
      delegatedAdmin: false,
    });
  });

  check("🔴 여럿을 대신하면 **하나라도** 휴가 관리자면 열린다", () => {
    assert.equal(decideDelegatedAdmin("MEMBER", ["MEMBER", "LEAVE_ADMIN"]).isAdmin, true);
    assert.equal(decideDelegatedAdmin("MEMBER", ["LEAVE_ADMIN", "MEMBER"]).isAdmin, true);
  });

  check("🔴 **진짜 휴가 관리자는 안 좁아진다** — 위임을 받아도 「임시」가 아니다", () => {
    // 🔴 여기가 참이 되면 그 사람은 **위임을 받았다는 이유만으로** 역할 변경을
    //    잃는다. 자격이 둘이면 높은 쪽이 이긴다.
    assert.deepEqual(decideDelegatedAdmin("LEAVE_ADMIN", []), {
      isAdmin: true,
      delegatedAdmin: false,
    });
    assert.deepEqual(decideDelegatedAdmin("LEAVE_ADMIN", ["LEAVE_ADMIN"]), {
      isAdmin: true,
      delegatedAdmin: false,
    });
    assert.deepEqual(decideDelegatedAdmin("LEAVE_ADMIN", ["MEMBER"]), {
      isAdmin: true,
      delegatedAdmin: false,
    });
  });

  check("🔴 **기간이 끝나거나 거둔 위임은 빈 목록으로 온다** — 그러면 닫힌다", () => {
    // 🔴 이것이 「저절로 닫힌다」의 값 쪽 증거다. 거르는 일은 아래 3절의 질의가
    //    하고, 그 질의가 빈 목록을 돌려주는 순간 이 판정은 관리자 문을 닫는다 —
    //    열어 둠을 적어 두는 칸이 없으므로 다음 요청부터 바로 닫힌다.
    const 끝난뒤 = decideDelegatedAdmin("MEMBER", []);
    assert.equal(끝난뒤.isAdmin, false);
    assert.equal(끝난뒤.delegatedAdmin, false);
  });

  check("🔵 기준 역할의 글자가 **한 곳**에 있다", () => {
    assert.equal(DELEGATED_ADMIN_SOURCE_ROLE, "LEAVE_ADMIN");
    const pure = withoutComments(read("src/lib/auth/delegated-role.ts"));
    // 판정 두 곳이 그 상수를 쓴다 — 글자를 흩어 적으면 한쪽만 고쳐지는 날이 온다.
    assert.equal(countOf(pure, '"LEAVE_ADMIN"'), 1, "🔴 역할 글자가 여러 번 적혀 있다");
  });

  /* ---------------------------------------------------------------- */
  /* 2. 🔴 **안 묻는 가지** — 진짜 관리자에게는 질의를 안 돌린다          */
  /* ---------------------------------------------------------------- */

  check("🔴 진짜 휴가 관리자에게는 **아예 안 묻는다** — 얻을 것이 없다", () => {
    assert.equal(needsDelegatorRoles("LEAVE_ADMIN", [맡긴관리자]), false);
  });

  check("🔴 대신하는 사람이 없으면 안 묻는다 — 이 집 사람 대부분이 그 쪽이다", () => {
    assert.equal(needsDelegatorRoles("MEMBER", []), false);
  });

  check("🔵 묻는 것은 그 둘이 아닐 때뿐이다 — 표본이 비지 않았다는 증거", () => {
    assert.equal(needsDelegatorRoles("MEMBER", [맡긴관리자]), true);
  });

  /* ---------------------------------------------------------------- */
  /* 3. 역할을 읽는 질의 — 🔴 **거르개를 새로 안 적었다**                */
  /* ---------------------------------------------------------------- */

  const delegations = await import("../src/lib/auth/portal-delegations");

  check("🔴 **거르개가 한 줄도 없다** — 기간·철회를 여기서 다시 안 잰다", () => {
    const { sql: text } = bake(delegations.delegatorRolesQuery([맡긴관리자]));
    for (const 거르개 of ["revoked_at", "starts_at", "ends_at"]) {
      assert.equal(
        text.includes(거르개),
        false,
        `🔴 ${거르개} 가 여기 또 적혔다 — 반열린 구간 규칙이 두 벌이 됐다`,
      );
    }
    // 위임 표를 아예 안 본다. 「지금 유효한가」는 앞 질의가 이미 끝낸 일이다.
    assert.equal(text.includes("web_portal_approval_delegations"), false);
  });

  check("🔴 **명단 번호로 계정을 되짚는다** — 이 집에만 있는 한 단", () => {
    const { sql: text, params } = bake(delegations.delegatorRolesQuery([맡긴관리자, 맡긴직원]));
    assert.match(text, /from "web_users"/);
    // 🔴 `auth_sub` 로 찾으면(재고관리를 베끼면) 오류 없이 영원히 빈 목록이 된다.
    assert.match(text, /"employee_id" in \(\$1, \$2\)/);
    assert.equal(text.includes("auth_sub"), false, "🔴 포털 번호로 찾고 있다");
    assert.deepEqual(params.slice(0, 2), [맡긴관리자, 맡긴직원]);
  });

  check("🔴 정지·삭제된 계정은 역할을 안 넘긴다 — 세션과 **같은 조건**", () => {
    // 한쪽만 느슨하면 그만둔 사람의 계정이 임시 관리자를 계속 찍어 낸다.
    const { sql: text } = bake(delegations.delegatorRolesQuery([맡긴관리자]));
    assert.match(text, /"is_active" = \$/);
    assert.match(text, /"is_deleted" = \$/);
    const session = withoutComments(read("src/lib/auth/session.ts"));
    assert.ok(session.includes("eq(webUsers.isActive, true)"));
    assert.ok(session.includes("eq(webUsers.isDeleted, false)"));
  });

  check("🔴 **역할 칸만** 고른다 — 이름도 번호도 안 읽는다", () => {
    const { sql: text } = bake(delegations.delegatorRolesQuery([맡긴관리자]));
    assert.match(text, /^select "role" from "web_users"/);
    for (const 칸 of ["display_name", "email", '"id"']) {
      assert.equal(text.includes(칸), false, `🔴 ${칸} 까지 읽고 있다`);
    }
  });

  await checkAsync("🔴 빈 목록이면 **DB 를 두드리지 않는다**", async () => {
    // 🔵 이 호출은 DB 에 닿지 않는다 — 위 DATABASE_URL 은 아무 데도 안 붙는
    //    주소라, 정말 물었다면 여기서 끝나지 않는다.
    assert.deepEqual(await delegations.loadDelegatorRoles([]), []);
  });

  check("🔴 거르는 자리는 결재권과 **같은 한 곳**이다 — 저절로 닫히는 까닭", () => {
    // 역할을 넘길 사람 목록은 결재함·배지·종이 쓰는 **바로 그 질의**가 만든다.
    const now = new Date("2026-11-17T09:00:00+09:00");
    const { sql: text } = bake(delegations.actingForEmployeeIdsQuery(나, now));
    assert.match(text, /"revoked_at" is null/);
    assert.match(text, /"ends_at" > \$/, "🔴 끝난 위임이 안 걸러진다");
    assert.match(text, /"starts_at" <= \$/, "🔴 시작 전 위임이 미리 열린다");
  });

  /* ---------------------------------------------------------------- */
  /* 4. 배선 — 🔴 세션이 그 둘을 **함께** 나른다                         */
  /* ---------------------------------------------------------------- */

  const guards = withoutComments(read("src/lib/auth/guards.ts"));

  check("🔴 `isAdmin` 이 판정 함수에서 나온다 — 역할 글자로 직접 재지 않는다", () => {
    assert.ok(guards.includes("isAdmin: delegated.isAdmin,"), "🔴 승격이 안 꽂혔다");
    assert.equal(
      guards.includes('isAdmin: user.role === "LEAVE_ADMIN"'),
      false,
      "🔴 옛 판정이 남아 있다 — 위임으로 받은 관리자는 영영 문이 안 열린다",
    );
  });

  check("🔴 **「임시인가」를 함께 나른다** — 없으면 울타리를 걸 자리가 없다", () => {
    assert.ok(guards.includes("delegatedAdmin: delegated.delegatedAdmin,"));
    assert.ok(guards.includes("delegatedAdmin: boolean;"), "🔴 Viewer 에 칸이 없다");
  });

  check("🔴 결재함이 **이미 읽어 온 목록**을 쓴다 — 위임 표를 다시 안 묻는다", () => {
    // 다시 물으면 같은 조건을 두 번 재게 되고, 그 둘이 다른 순간을 보는 날
    // 「결재는 되는데 역할은 안 넘어오는」 짝이 생긴다.
    assert.ok(
      guards.includes("resolveDelegatedAdmin(user.role, employee?.actingForEmployeeIds ?? [])"),
    );
    const 이은자리 = slice(guards, "async function resolveDelegatedAdmin(", "export const getViewer");
    assert.equal(
      이은자리.includes("loadActingForEmployeeIds"),
      false,
      "🔴 위임 표를 한 번 더 묻고 있다",
    );
  });

  check("🔴 안 묻는 가지도 **같은 판정 함수**를 지난다", () => {
    const 이은자리 = slice(guards, "async function resolveDelegatedAdmin(", "export const getViewer");
    assert.equal(
      countOf(이은자리, "decideDelegatedAdmin("),
      2,
      "🔴 가지 하나가 값을 손으로 지어낸다 — 「진짜 관리자」의 뜻이 두 곳에 생긴다",
    );
  });

  check("🔴 **DB 의 역할 칸을 안 쓴다** — 판정 시점 계산이다", () => {
    // 역할 칸에 적어 두는 길로 가면 여는 조건(위임 줄)과 닫는 조건(사람의 손)이
    // 다른 곳에 생기고, 화면에서 내릴 수 없는 권한이 남는다.
    const admin = withoutComments(read("src/app/actions/admin.ts"));
    assert.equal(
      countOf(admin, ".set({ role,"),
      1,
      "🔴 역할 칸을 쓰는 자리가 늘었다 — 위임이 역할 칸을 건드리고 있지 않은지 보라",
    );
    const pure = withoutComments(read("src/lib/auth/delegated-role.ts"));
    assert.equal(pure.includes("webUsers"), false, "🔴 순수 판정이 표를 안다");
    assert.equal(pure.includes("update("), false, "🔴 순수 판정이 무언가를 쓴다");
  });

  /* ---------------------------------------------------------------- */
  /* 5. 🔴 울타리 — 임시 관리자는 **역할 변경만** 못 한다                */
  /* ---------------------------------------------------------------- */

  check("🔴 **임시 관리자는 역할을 못 바꾼다. 진짜 관리자는 바꾼다.**", () => {
    assert.equal(mayChangeUserRole({ isAdmin: true, delegatedAdmin: false }), true);
    assert.equal(mayChangeUserRole({ isAdmin: true, delegatedAdmin: true }), false);
  });

  check("🔴 관리자가 아니면 애초에 못 바꾼다 — 울타리가 문을 대신하지 않는다", () => {
    assert.equal(mayChangeUserRole({ isAdmin: false, delegatedAdmin: false }), false);
    // 있을 수 없는 짝이지만, 「임시」 깃발만 보고 통과시키지 않는다는 뜻이다.
    assert.equal(mayChangeUserRole({ isAdmin: false, delegatedAdmin: true }), false);
  });

  check("🔴 판정과 울타리가 **이어 붙는다** — 손으로 지어낸 짝이 아니다", () => {
    const 임시관리자 = decideDelegatedAdmin("MEMBER", ["LEAVE_ADMIN"]);
    const 진짜관리자 = decideDelegatedAdmin("LEAVE_ADMIN", ["LEAVE_ADMIN"]);
    assert.equal(mayChangeUserRole(임시관리자), false);
    assert.equal(mayChangeUserRole(진짜관리자), true);
  });

  const adminActions = withoutComments(read("src/app/actions/admin.ts"));
  const setRole = slice(adminActions, "export async function setRoleAction(", "export async function");

  check("🔴 서버 액션이 **requireAdmin 바로 뒤에서** 거절한다 — 화면 분기가 아니다", () => {
    const 거절 = setRole.indexOf("if (!mayChangeUserRole(admin))");
    assert.ok(거절 > 0, "🔴 setRoleAction 이 울타리를 안 묻는다");
    assert.ok(거절 > setRole.indexOf("await requireAdmin()"), "🔴 문보다 먼저 왔다");
    // 🔵 인가는 검증보다 먼저 — 막힌 사람에게 「역할을 확인하세요」가 먼저 나오면
    //    무엇이 막았는지가 흐려진다.
    assert.ok(거절 < setRole.indexOf("USER_ROLES"), "🔴 모양 검사 뒤에 있다");
    assert.ok(거절 < setRole.indexOf("db.update(webUsers)"), "🔴 쓰기 뒤에 있다");
  });

  check("🔴 **문으로 튕기지 않는다** — 막힌 사람이 까닭을 본다", () => {
    // requireRole 로 막으면 홈으로 튕겨 거절 문구를 볼 자리가 없고, 화면을 열어
    // 읽는 것까지 막혀 「지금 누가 관리자인가」조차 못 본다.
    assert.ok(setRole.includes("return { error: SET_ROLE_DELEGATED_ADMIN_MESSAGE };"));
    assert.equal(setRole.includes("redirect("), false, "🔴 튕겨 낸다");
  });

  check("🔴 거절 글이 셋을 말한다 — 무엇이 막았나 · 왜 · 어떻게 하나", () => {
    assert.match(SET_ROLE_DELEGATED_ADMIN_MESSAGE, /결재권 위임으로 받은/, "무엇이 막았나");
    assert.match(SET_ROLE_DELEGATED_ADMIN_MESSAGE, /끝난 뒤에도 그대로 남/, "왜");
    assert.match(SET_ROLE_DELEGATED_ADMIN_MESSAGE, /요청하십시오/, "어떻게 하나");
    // 🔵 기간도 위임자 이름도 싣지 않는다 — 그 값을 실으려면 남의 위임 줄을
    //    읽어야 한다. 기간은 [휴가 설정 → 결재권 위임]에 줄마다 적혀 있다.
    assert.equal(/\d{4}-\d{2}-\d{2}/.test(SET_ROLE_DELEGATED_ADMIN_MESSAGE), false);
  });

  check("🔴 울타리를 거는 자리가 **하나뿐**이다 — 나머지는 알고 열어 둔 것이다", () => {
    // 🔴 2026-11-17 결정: **「역할 변경만 빼고 전부」**. 이 집의 관리자 문
    //    대부분이 기간이 끝나도 안 돌아가지만(연차 직접 조정 · 근속 표 · 공휴일 ·
    //    직원 명단 · 전사 여름휴가 일수 · **결재선 구성**) 쓰는 분이 그것을 알고
    //    골랐다. 🔴 이 수가 늘면 **결정을 바꾼 것**이다 — 먼저 물어라.
    assert.equal(countOf(adminActions, "mayChangeUserRole("), 1);
    for (const 결재선 of ["addRouteStepAction", "removeRouteStepAction", "moveRouteStepAction"]) {
      const 몸통 = slice(adminActions, `export async function ${결재선}(`, "export async function");
      assert.equal(
        몸통.includes("mayChangeUserRole"),
        false,
        `🔴 ${결재선} 에 울타리가 생겼다 — 2026-11-17 결정에 없던 일이다`,
      );
    }
  });

  /* ---------------------------------------------------------------- */
  /* 6. 🔴 결재 판정은 **한 글자도 안 바뀌었다**                         */
  /* ---------------------------------------------------------------- */

  check("🔴 결재 판정은 역할을 **모른다** — 올라가도 닿지 않는다", () => {
    const scope = withoutComments(read("src/lib/leave/approval-scope.ts"));
    assert.equal(scope.includes("LEAVE_ADMIN"), false, "🔴 결재 판정이 역할을 본다");
    assert.equal(scope.includes("isAdmin"), false, "🔴 결재 판정이 관리자를 본다");
    assert.equal(scope.includes("delegatedAdmin"), false);
  });

  check("🔴 역할이 올라가도 **결재선에 없으면 못 누른다** (값)", () => {
    // 임시 관리자는 「휴가 관리자가 맡긴 위임을 받은 사람」이므로, 그 사람의
    // 단계는 누를 수 있다 — 그것은 **결재권 위임**이 주는 것이지 역할이 주는
    // 것이 아니다. 🔴 아무 상관 없는 사람의 단계는 여전히 남의 것이다.
    const 임시관리자 = decider({ actingForEmployeeIds: [맡긴관리자] });
    assert.equal(isMyStep(step(나), 임시관리자), true, "🔵 표본이 비었다");
    assert.equal(isMyStep(step(맡긴관리자), 임시관리자), true);
    assert.equal(isMyStep(step(제삼자), 임시관리자), false, "🔴 역할이 결재권을 넓혔다");
    assert.deepEqual(approvableEmployeeIds(임시관리자), [나, 맡긴관리자]);
  });

  check("🔴 옛 직급 갈래도 안 넓어진다 — 임시 관리자에게 결재권이 생기지 않는다", () => {
    // 사람 칸이 빈 옛 단계는 **직급의 결재권**으로만 갈린다. 역할이 올라가도
    // `isApprover` 는 직급에서 오는 값이라 그대로다.
    const 임시관리자 = decider({ actingForEmployeeIds: [맡긴관리자] });
    assert.equal(isMyStep(step(null, "rank-사원"), 임시관리자), false);
    assert.equal(isMyStep(step(null, "rank-과장"), 임시관리자), false);
  });

  check("🔴 결재함 문도 역할을 안 본다 — 문을 여는 것은 위임이지 역할이 아니다", () => {
    const 위임만받은사람 = { rankCanApprove: false, onApprovalRoute: false };
    assert.equal(canOpenApprovalBox(위임만받은사람), false, "🔵 표본이 비었다");
    assert.equal(
      canOpenApprovalBox({ ...위임만받은사람, actingForEmployeeIds: [맡긴관리자] }),
      true,
    );
    assert.ok(guards.includes("isApprover: Boolean(employee?.rank.canApprove),"));
  });

  /* ---------------------------------------------------------------- */
  /* 7. 🔵 **못 하는 것은 못 한다** — 명단·계정이 없는 위임자            */
  /* ---------------------------------------------------------------- */

  const 사람없음 = async () => [];

  await checkAsync("🔴 **명단에 안 이어진 관리자는 위임자가 될 수 없다**", async () => {
    // 이 집은 명단 연결 없이도 휴가 관리자일 수 있다(guards.ts 의 requireViewer).
    // 🔴 그런 관리자는 위임 표의 위임자 칸(명단 번호)에 **적힐 자리가 없다** —
    //    받는 통로가 「해당 없음」으로 돌려보낸다. 역할도 당연히 안 넘어간다.
    const 결과 = await applyDelegationCommand(
      {
        action: "upsert",
        id: "11111111-1111-4111-8111-111111111111",
        delegatorSub: "22222222-2222-4222-8222-222222222222",
        delegateSub: "33333333-3333-4333-8333-333333333333",
        startsAt: new Date("2026-11-17T00:00:00Z"),
        endsAt: new Date("2026-11-20T00:00:00Z"),
        reason: "",
        revokedAt: null,
      },
      {
        // 계정은 있는데 명단에 안 이어진 관리자.
        lookup: async () => [
          { authSub: "22222222-2222-4222-8222-222222222222", employeeId: null },
          { authSub: "33333333-3333-4333-8333-333333333333", employeeId: 나 },
        ],
        upsert: async () => assert.fail("🔴 적으면 안 되는 줄을 적었다"),
        revoke: async () => false,
      },
    );
    assert.deepEqual(결과, { outcome: "not_applicable", reason: "delegator_unlinked" });
  });

  await checkAsync("🔵 이 집에 계정이 아예 없는 위임자도 마찬가지다", async () => {
    const 결과 = await applyDelegationCommand(
      {
        action: "upsert",
        id: "11111111-1111-4111-8111-111111111111",
        delegatorSub: "22222222-2222-4222-8222-222222222222",
        delegateSub: "33333333-3333-4333-8333-333333333333",
        startsAt: new Date("2026-11-17T00:00:00Z"),
        endsAt: new Date("2026-11-20T00:00:00Z"),
        reason: "",
        revokedAt: null,
      },
      {
        lookup: 사람없음,
        upsert: async () => assert.fail("🔴 적으면 안 되는 줄을 적었다"),
        revoke: async () => false,
      },
    );
    assert.deepEqual(결과, { outcome: "not_applicable", reason: "delegator_absent" });
  });

  check("🔵 로그인한 적 없는 위임자는 **역할이 없다** — 그래서 안 넘어간다", () => {
    // 결재선·위임은 명단에서 고르므로 web_users 에 줄이 없는 사람도 결재권자가
    // 될 수 있다. 위 질의가 그런 번호를 그냥 못 찾을 뿐이고, 못 찾은 역할은
    // 목록에 없으므로 판정은 「대신하는 사람이 없다」와 같은 답을 낸다.
    assert.equal(decideDelegatedAdmin("MEMBER", []).isAdmin, false);
  });

  check("🔴 명단에 안 이어진 **대리인**에게는 애초에 목록이 없다", () => {
    // 위임 표의 대리인 칸도 명단 번호라, 명단에 안 이어진 계정은 빈 목록이다.
    assert.ok(guards.includes("employee?.actingForEmployeeIds ?? []"));
    assert.equal(needsDelegatorRoles("MEMBER", []), false);
  });

  /* ---------------------------------------------------------------- */
  /* 8. 🔵 「임시」 표시 — 사람이 제 상태를 안다                          */
  /* ---------------------------------------------------------------- */

  const header = withoutComments(read("src/components/AppHeader.tsx"));

  check("🔵 머리말이 **임시일 때만** 「임시」를 그린다", () => {
    assert.equal(countOf(header, "{viewer.delegatedAdmin && ("), 1);
    assert.match(header, /임시\n\s*<\/Link>/, "🔴 「임시」라고 적지 않았다");
  });

  check("🔴 **진짜 휴가 관리자에게는 한 글자도 안 바뀐다**", () => {
    // 가리는 조건이 `delegatedAdmin` 하나다 — 진짜 관리자에게는 언제나 거짓이라
    // 이 칸이 아예 안 그려진다.
    const 임시칸 = slice(header, "{viewer.delegatedAdmin && (", "</span>");
    assert.equal(임시칸.includes("isAdmin"), false, "🔴 조건이 섞였다");
    assert.ok(header.includes("휴가 관리자\n"), "🔴 원래 있던 배지가 없어졌다");
  });

  check("🔵 **기간 보는 자리로 보낸다** — 주소를 머리말에 직접 안 적는다", () => {
    assert.ok(header.includes('href={settingsTabHref("delegation")}'));
    assert.equal(header.includes('href="/admin/settings?'), false, "🔴 주소를 베껴 적었다");
    assert.equal(settingsTabHref("delegation"), "/admin/settings?tab=delegation");
    // 🔵 그 탭은 직원에게도 열려 있다 — 임시 관리자가 아직 관리자가 아니어도 본다.
    assert.deepEqual(settingsTabsFor(false), ["delegation"]);
  });

  check("🔵 두 자리(넓은 화면·☰ 서랍)가 **같은 조각**을 쓴다 — 베껴 적지 않았다", () => {
    assert.equal(countOf(header, "function AccountBox("), 1);
    assert.equal(countOf(header, "<AccountBox "), 2);
  });

  console.log(`\n${passed}개 통과`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
