/**
 * 결재 **내역** 검사.  npm run test:approval-history
 *
 * 🔴 DB 에 닿지 않고 사내망에도 나가지 않는다. 질의는 **만들기만** 하고
 * `.toSQL()` 로 구워 본다(scripts/test-approval-delegation.ts ·
 * test-delegation-screen.ts 와 같은 수법). 🔴 **이 집에서는 다른 수가 없다** —
 * 개발 DB 에 결재 기록이 사실상 없고(단계 1행, 그것도 미결) 시험 DB 는
 * `test:workflow` 전용이라, 값으로 재려면 이 검사가 신청·결재를 처음부터 만들어야
 * 한다. 그것은 이미 `test:workflow` 가 하는 일이다.
 *
 * ── 이 검사가 생긴 까닭 (2026-11-17, 설계 C-4) ──────────────────────────
 * 사용자 요청: 「내가 했던 결재나 **나를 대신해서** 어떤 결재를 했는지도 특정
 * 날짜 혹은 기간을 선택해서 확인」. 조각 10a 는 **조회와 색인까지**이고 화면은
 * 통합 승인함 한 곳에 둔다(2026-11-17 사용자).
 *
 * ── 무엇을 지키는가 ─────────────────────────────────────────────────────
 *   1. 🔴 셋이 **갈린다** — 내가 직접 / 내가 대신 / 내 자리를 남이
 *   2. 🔴 **`SKIPPED` 가 안 나온다.** 이 집의 핵심이다 — 건너뛴 단계는 「누른
 *      사람」이 비어 있어, 안 거르면 **모든 건너뛰기가 「대신 결재」로 오판된다**
 *   3. 🔴 `WAITING`·`PENDING` 도 안 나온다
 *   4. 🔴 기간이 **반열린 구간**이고 경계가 그대로 간다
 *   5. 🔴 남의 결재가 안 샌다 — OR 가 괄호에 갇혀 있다
 *   6. 🔴 **색인의 부분 조건과 조회의 조건이 같은 글자**다 — 어긋나면 결과는
 *      그대로인 채 **조용히 느려지기만 한다**
 *   7. 🔴 **안 건드린 것들** — `decidedBy`·결재함 화면·`isMyStep`·`skipStep`
 *
 * 🔴 왜 전부 main() 안에 있나: 이 저장소의 검사는 tsx 가 CJS 로 돌려
 * (package.json 에 type:module 이 없다) 최상위 await 을 쓸 수 없다.
 * 🔴 **DB 를 건드리는 모듈은 `await import` 로** 불러온다 — `src/lib/db` 는 모듈을
 * 읽는 순간 DATABASE_URL 을 읽는데, 정적 import 는 아래 환경 설정보다 **먼저**
 * 돈다(esbuild 가 import 를 위로 끌어올린다).
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

import {
  APPROVAL_HISTORY_ROLES,
  APPROVAL_HISTORY_ROLE_LABEL,
  approvalHistoryHref,
  approvalHistoryRole,
  type ApprovalHistoryRole,
  type StepDecisionOwners,
} from "../src/lib/leave/approval-history";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** 주석을 걷어 낸 코드. 🔴 주석에 적힌 낱말이 검사를 통과시키지 않게. */
const withoutComments = (source: string) => {
  const out = source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(out.trim().length > 0, "주석을 떼고 나니 아무것도 안 남았다 — 떼는 규칙이 더는 안 맞는다");
  return out;
};

/**
 * 함수 **하나의 몸통만** 잘라 낸다 — 그 다음 `export` 가 나오는 데서 끊는다.
 * 파일 끝까지 자르면 뒤에 더해지는 함수의 글자를 재게 된다
 * (test-portal-approvals.ts 의 같은 함수와 같은 까닭).
 */
function bodyOf(source: string, head: string): string {
  const at = source.indexOf(head);
  assert.ok(at >= 0, `${head} 를 찾지 못했다 — 이름이 바뀌었나`);
  const rest = source.slice(at);
  const end = rest.indexOf("\nexport ", 1);
  const body = end === -1 ? rest : rest.slice(0, end);
  // 🔵 표본이 비어서 공짜로 통과하는 일이 없게.
  assert.ok(body.length > 60, `${head} 의 몸통을 잘라 내지 못했다`);
  return body;
}

/** `src/app` 아래 모든 소스를 **주석을 걷어** 읽는다. */
function appSources(): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(new URL(`../${rel}`, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${rel}${entry.name}/`);
      else if (/\.tsx?$/.test(entry.name)) {
        out.push({ path: `${rel}${entry.name}`, code: withoutComments(read(`${rel}${entry.name}`)) });
      }
    }
  };
  walk("src/app/");
  assert.ok(out.length > 10, "화면 소스를 하나도 못 읽었다 — 걷는 규칙이 더는 안 맞는다");
  return out;
}

/* ------------------------------------------------------------------ */
/* 가짜 값 — 🔴 실제 이름·사번을 한 자도 넣지 않는다                     */
/* ------------------------------------------------------------------ */

const 나 = "emp-나";
const 남 = "emp-남";

/** 2026-11-01 00:00 ~ 2026-12-01 00:00 (UTC 로 적는다 — 경계를 그대로 보려고) */
const FROM = new Date("2026-11-01T00:00:00.000Z");
const TO = new Date("2026-12-01T00:00:00.000Z");

const MIGRATION = "drizzle/0004_approval_history_indexes.sql";
const SCHEMA = "src/lib/db/schema.ts";
const DATA = "src/lib/leave/data.ts";
const SCOPE = "src/lib/leave/approval-scope.ts";
const WORKFLOW = "src/lib/leave/workflow.ts";
const APPROVALS_PAGE = "src/app/(internal)/approvals/page.tsx";

function step(over: Partial<StepDecisionOwners> = {}): StepDecisionOwners {
  return { approverEmployeeId: 나, decidedByEmployeeId: 나, ...over };
}

/** 마이그레이션의 `CREATE INDEX … WHERE <조건>;` 에서 조건만 뽑는다. */
function indexPredicates(sqlText: string): string[] {
  const lines = sqlText.split("\n").filter((line) => line.startsWith("CREATE INDEX"));
  assert.ok(lines.length > 0, "CREATE INDEX 줄을 하나도 못 찾았다");
  return lines.map((line) => {
    const at = line.indexOf(" WHERE ");
    assert.ok(at > 0, `부분 색인이 아니다 — 조건이 없으면 끝난 결재까지 다 담긴다: ${line}`);
    return line.slice(at + " WHERE ".length).replace(/;.*$/, "").trim();
  });
}

async function main() {
  console.log("\n결재 내역 — 기간·사람으로 가로지르기\n");

  /* ---------------------------------------------------------------- */
  /* 1. 가르기 — 🔴 DB 없이 **값으로 그대로** 돌린다                    */
  /* ---------------------------------------------------------------- */

  check("🔴 내가 **직접** 누른 결재는 「직접 결재」다", () => {
    const role = approvalHistoryRole(step({ approverEmployeeId: 나, decidedByEmployeeId: 나 }), 나);
    assert.equal(role, "SELF");
    assert.equal(APPROVAL_HISTORY_ROLE_LABEL[role], "직접 결재");
  });

  check("🔴 내가 **대신** 누른 결재는 「내가 대신 결재」다 — 남의 자리를 내가 닫았다", () => {
    const role = approvalHistoryRole(step({ approverEmployeeId: 남, decidedByEmployeeId: 나 }), 나);
    assert.equal(role, "ON_BEHALF");
    assert.equal(APPROVAL_HISTORY_ROLE_LABEL[role], "내가 대신 결재");
  });

  check("🔴 **내 자리를 남이** 누른 결재는 「내 자리를 남이 결재」다", () => {
    const role = approvalHistoryRole(step({ approverEmployeeId: 나, decidedByEmployeeId: 남 }), 나);
    assert.equal(role, "BY_OTHER");
    assert.equal(APPROVAL_HISTORY_ROLE_LABEL[role], "내 자리를 남이 결재");
  });

  check("🔴 셋이 **갈려서** 나온다 — 한 사람 눈으로 본 세 줄의 값이 모두 다르다", () => {
    const 줄들 = [
      step({ approverEmployeeId: 나, decidedByEmployeeId: 나 }),
      step({ approverEmployeeId: 남, decidedByEmployeeId: 나 }),
      step({ approverEmployeeId: 나, decidedByEmployeeId: 남 }),
    ];
    // 🔵 표본이 비어서 공짜로 통과하지 않게 — 무엇을 재는지 먼저 못 박는다.
    assert.equal(줄들.length, 3);
    const roles = 줄들.map((s) => approvalHistoryRole(s, 나));
    assert.deepEqual(roles, ["SELF", "ON_BEHALF", "BY_OTHER"]);
    assert.equal(new Set(roles).size, 3, "🔴 둘 이상이 같은 값으로 뭉갰다 — 가르는 뜻이 사라졌다");
  });

  check("🔴 같은 줄도 **보는 사람에 따라** 갈린다 — 대리인에게는 「대신」, 주인에게는 「남이」", () => {
    const 줄 = step({ approverEmployeeId: 남, decidedByEmployeeId: 나 });
    assert.equal(approvalHistoryRole(줄, 나), "ON_BEHALF");
    assert.equal(approvalHistoryRole(줄, 남), "BY_OTHER");
  });

  check("🔴 옛 직급 단계(주인 칸이 빈 행)를 내가 누른 것은 「직접」이다 — 없던 위임으로 둔갑하지 않는다", () => {
    // 2026-09-21 전에는 결재자를 **직급**으로 판정했고 위임이라는 것이 아예
    // 없었다(approval-scope.ts). 주인 칸이 비었다는 이유로 「대신」이라 적으면
    // 그때의 결재가 전부 있지도 않았던 대리 결재가 된다.
    const role = approvalHistoryRole(step({ approverEmployeeId: null, decidedByEmployeeId: 나 }), 나);
    assert.equal(role, "SELF");
  });

  check("🔴 누른 사람이 비어 있으면 「직접」이 아니다 — 건너뛴 줄이 새어도 내 결재가 되지 않는다", () => {
    // 건너뛴 단계는 `decided_by_employee_id` 가 비어 있다. 조회가 상태로 먼저
    // 거르지만, 가르개 혼자서도 그것을 내 결재로 적지는 않는다.
    assert.equal(approvalHistoryRole(step({ decidedByEmployeeId: null }), 나), "BY_OTHER");
    assert.equal(
      approvalHistoryRole({ approverEmployeeId: null, decidedByEmployeeId: null }, 나),
      "BY_OTHER",
    );
  });

  check("갈래 셋에 이름표가 하나씩 있고, 셋이 서로 다르다", () => {
    assert.equal(APPROVAL_HISTORY_ROLES.length, 3);
    const labels = APPROVAL_HISTORY_ROLES.map((r: ApprovalHistoryRole) => APPROVAL_HISTORY_ROLE_LABEL[r]);
    for (const label of labels) assert.ok(label.length > 0, "이름표가 비어 있다");
    assert.equal(new Set(labels).size, 3, "이름표가 겹친다 — 사람이 갈라 읽을 수 없다");
  });

  check("🔴 가르개가 DB 를 모른다 — 그래서 자료 없이 그대로 돌려 볼 수 있다", () => {
    const code = withoutComments(read("src/lib/leave/approval-history.ts"));
    for (const forbidden of ["drizzle-orm", "@/lib/db", "db.select"]) {
      assert.ok(!code.includes(forbidden), `가르개가 DB 를 끌어왔다: ${forbidden}`);
    }
  });

  /* ---------------------------------------------------------------- */
  /* 2. 건너갈 주소 — 🔴 **이미 있는 통로와 같은 모양**                  */
  /* ---------------------------------------------------------------- */

  check("🔴 주소가 절대 주소이고 그 결재 줄을 가리킨다 — 기존 통로와 같은 모양", () => {
    const href = approvalHistoryHref("s-9", "http://192.168.1.10:3700");
    assert.equal(href, "http://192.168.1.10:3700/approvals#approval-s-9");
    assert.equal(new URL(href.split("#")[0]).port, "3700");
  });

  check("기준 주소가 비면 던진다 — 상대 주소가 남의 화면에 실리지 않게", () => {
    assert.throws(() => approvalHistoryHref("s-9", ""));
  });

  /* ---------------------------------------------------------------- */
  /* 3. 조회 — 🔴 **구워진 SQL** 로 본다 (글자가 아니라)                 */
  /* ---------------------------------------------------------------- */

  const data = await import("../src/lib/leave/data");
  const baked = data.approvalHistoryQuery(나, { from: FROM, to: TO }).toSQL();
  const whereAt = baked.sql.indexOf(" where ");
  assert.ok(whereAt > 0, "구워진 SQL 에 where 가 없다 — 고르는 조건이 통째로 빠졌다");
  const where = baked.sql.slice(whereAt);
  const OR_GROUP =
    '("web_approval_steps"."decided_by_employee_id" = $1 or "web_approval_steps"."approver_employee_id" = $2)';

  check("🔴 주인과 누른 사람을 **OR 로 묶는다** — 둘 다 같은 사람 번호로 묻는다", () => {
    assert.ok(where.includes('"web_approval_steps"."decided_by_employee_id" = $1'), where);
    assert.ok(where.includes('"web_approval_steps"."approver_employee_id" = $2'), where);
    assert.equal(baked.params[0], 나);
    assert.equal(baked.params[1], 나);
  });

  check("🔴 그 OR 가 **괄호에 갇혀 있다** — 새면 기간·상태를 건너뛴 남의 결재가 쏟아진다", () => {
    // `a or b and c` 로 구워지면 `b` 갈래가 기간·상태 조건을 통째로 벗어난다.
    // 괄호가 **두 비교 바로 뒤에서 닫히는 것**이 그것을 못 박는다.
    assert.ok(baked.sql.includes(OR_GROUP), baked.sql);
  });

  check("🔴 **`SKIPPED` 가 안 나온다** — 상태를 승인·반려 둘로 좁힌다", () => {
    // 🔵 표본이 비어 공짜로 통과하지 않게 먼저 「무엇을 재는지」를 못 박는다.
    assert.ok(where.includes("in ('APPROVED', 'REJECTED')"), where);
    assert.ok(!where.includes("SKIPPED"), "🔴 건너뛴 단계가 내역에 섞인다 — 전부 「대신 결재」로 오판된다");
  });

  check("🔴 `WAITING`·`PENDING` 도 안 나온다 — 아직 안 끝난 단계는 내역이 아니다", () => {
    assert.ok(!where.includes("WAITING"), where);
    assert.ok(!where.includes("PENDING"), where);
  });

  check("🔴 상태 조건이 **OR 밖**에 있다 — 한쪽 갈래에만 붙으면 반쪽만 걸러진다", () => {
    const orAt = baked.sql.indexOf(OR_GROUP);
    const statusAt = baked.sql.indexOf("in ('APPROVED', 'REJECTED')");
    const deletedAt = baked.sql.indexOf('"web_approval_steps"."is_deleted" = false');
    assert.ok(orAt > 0 && statusAt > orAt + OR_GROUP.length, "상태 조건이 OR 안에 있다");
    assert.ok(deletedAt > orAt + OR_GROUP.length, "삭제 조건이 OR 안에 있다");
  });

  check("🔴 기간이 **반열린 구간**이다 — 끝을 `<=` 로 적지 않았다", () => {
    assert.ok(where.includes('"web_approval_steps"."decided_at" >= $3'), where);
    assert.ok(where.includes('"web_approval_steps"."decided_at" < $4'), where);
    assert.ok(!where.includes("<="), "🔴 끝이 닫혀 있다 — 구간을 이어 붙이면 경계가 두 번 들어간다");
  });

  check("🔴 경계 값이 그대로 간다 — 조회가 날짜를 혼자 밀지 않는다", () => {
    assert.equal(baked.params[2], FROM.toISOString());
    assert.equal(baked.params[3], TO.toISOString());
  });

  check("🔴 상태와 `is_deleted` 가 **글자**다 — 바인딩 자리로 나가면 색인 증명이 깨진다", () => {
    for (const param of baked.params) {
      assert.notEqual(param, "APPROVED", "상태가 바인딩 자리로 나갔다");
      assert.notEqual(param, "REJECTED", "상태가 바인딩 자리로 나갔다");
      assert.notEqual(param, false, "삭제 여부가 바인딩 자리로 나갔다");
    }
    assert.ok(where.includes('"web_approval_steps"."is_deleted" = false'), where);
  });

  check("🔴 **색인의 부분 조건과 조회의 조건이 같은 글자**다 — 어긋나면 조용히 느려지기만 한다", () => {
    const predicates = indexPredicates(read(MIGRATION));
    assert.equal(predicates.length, 2, "결재 내역용 부분 색인이 둘이 아니다");
    // 🔴 둘이 **같은 조건**이어야 한다 — OR 두 갈래가 담기는 범위가 다르면
    //    한쪽만 색인을 타고 다른 쪽은 통째로 훑는다.
    assert.equal(predicates[0], predicates[1], predicates.join("\n"));
    assert.ok(
      baked.sql.includes(predicates[0]),
      `🔴 색인 조건과 조회 조건이 갈라졌다\n색인: ${predicates[0]}\n조회: ${where}`,
    );
  });

  check("🔴 색인 둘이 **선두 칸을 나눠 선다** — 「OR 두 칸」은 한 색인으로 못 탄다", () => {
    const sqlText = read(MIGRATION);
    assert.ok(sqlText.includes('("decided_by_employee_id","decided_at")'), sqlText);
    assert.ok(sqlText.includes('("approver_employee_id","decided_at")'), sqlText);
  });

  check("울타리가 걸린다 — 기본은 한 번에 500줄, 주면 그 값", () => {
    assert.equal(data.APPROVAL_HISTORY_MAX_ROWS, 500);
    assert.equal(baked.params[4], 500);
    const 좁게 = data.approvalHistoryQuery(나, { from: FROM, to: TO, limit: 7 }).toSQL();
    assert.equal(좁게.params[4], 7);
  });

  check("🔴 이름을 **세 별명**으로 따로 조인한다 — 한 번만 걸면 세 이름이 같아진다", () => {
    for (const alias of ["applicant", "approver", "decider"]) {
      const hits = baked.sql.split(`"web_employees" "${alias}"`).length - 1;
      assert.equal(hits, 1, `${alias} 별명이 ${hits}번이다`);
    }
    assert.ok(baked.sql.includes('"approver"."name"'), baked.sql);
    assert.ok(baked.sql.includes('"decider"."name"'), baked.sql);
    assert.ok(baked.sql.includes('"applicant"."name"'), baked.sql);
  });

  check("🔵 지워진 직원도 이름이 풀린다 — 이름 조인에 `is_deleted` 가 없다(stepsFor 그대로)", () => {
    const hits = baked.sql.split("is_deleted").length - 1;
    assert.equal(hits, 1, `is_deleted 가 ${hits}번이다 — 이름 조인까지 거르면 그만둔 사람 칸이 빈다`);
  });

  check("🔴 사유를 읽지 않는다 — 이 줄은 다른 시스템 화면에 그려진다", () => {
    assert.ok(!baked.sql.includes("reason"), baked.sql);
  });

  check("최근 순이고 차례가 못 박혀 있다 — 상한에 걸릴 때 보이는 줄이 흔들리지 않게", () => {
    assert.ok(
      baked.sql.includes(
        'order by "web_approval_steps"."decided_at" desc, "web_approval_steps"."id" asc',
      ),
      baked.sql,
    );
  });

  /* ---------------------------------------------------------------- */
  /* 4. 🔴 **안 건드린 것들** — 이 조각이 깨뜨리면 안 되는 자리           */
  /* ---------------------------------------------------------------- */

  const dataCode = withoutComments(read(DATA));

  check("🔴 기존 `decidedBy` 가 그대로다 — 한 칸으로만 고르고 OR 가 끼지 않았다", () => {
    const body = bodyOf(dataCode, "export async function decidedBy");
    assert.ok(body.includes("eq(webApprovalSteps.decidedByEmployeeId, employeeId)"), body);
    assert.ok(
      !body.includes("approverEmployeeId"),
      "🔴 결재함의 「내가 처리한 결재」 표에 남이 누른 줄이 섞인다 — 제목이 거짓이 된다",
    );
    assert.ok(!body.includes("or("), body);
  });

  check("🔴 결재함 화면이 여전히 `decidedBy` 를 부른다 — 기존 표가 살아 있다", () => {
    const page = withoutComments(read(APPROVALS_PAGE));
    assert.ok(page.includes("decidedBy(member.employee.id)"), "결재함이 처리 기록 표를 잃었다");
    assert.ok(page.includes("내가 처리한 결재"), "표 제목이 사라졌다");
  });

  check("🔴 결재 판정을 안 건드렸다 — `isMyStep` 과 `myStepCondition` 이 여전히 같은 함수를 부른다", () => {
    const scope = withoutComments(read(SCOPE));
    assert.ok(bodyOf(scope, "export function isMyStep").includes("approvableEmployeeIds(me)"), scope);
    assert.ok(
      bodyOf(scope, "export function myStepCondition").includes("approvableEmployeeIds(me)"),
      scope,
    );
    assert.ok(!scope.includes("approvalHistory"), "판정 파일이 내역 조회를 끌어왔다");
  });

  check("🔴 `skipStep` 이 여전히 명단 번호를 안 적는다 — 이것이 SKIPPED 거르기의 **둘째** 보장이다", () => {
    // 적기 시작하면 ① 기존 결재함 표(`decidedBy`)에 건너뛴 줄이 조용히 들어와
    // **「반려」로 그려지고**, ② 이 조회는 상태로 막으므로 둘이 갈라진다.
    const body = bodyOf(withoutComments(read(WORKFLOW)), "export async function skipStep");
    assert.ok(body.includes('status: "SKIPPED"'), body);
    assert.ok(body.includes("decidedByUserId: admin.user.id"), body);
    assert.ok(
      !body.includes("decidedByEmployeeId"),
      "🔴 건너뛰기가 명단 번호를 적기 시작했다 — 결재함 표가 건너뛴 줄을 「반려」로 그린다",
    );
  });

  check("🔴 반려로 인한 **연쇄 건너뜀**은 여전히 아무것도 안 남긴다 — 알고 두는 사실이다", () => {
    // 🔵 지금은 둘 다 내역에서 빠지므로 문제가 안 된다. 나중에 「건너뛰기도
    //    보여 주자」가 나오면 **이 갈래는 통째로 빈칸**이 된다는 것을 못 박아 둔다.
    const code = withoutComments(read(WORKFLOW));
    const at = code.indexOf("async function skipOpenSteps");
    assert.ok(at > 0, "skipOpenSteps 를 찾지 못했다");
    const body = code.slice(at, at + 400);
    assert.ok(body.includes('status: "SKIPPED"'), body);
    assert.ok(!body.includes("decidedAt"), "연쇄 건너뜀이 시각을 적기 시작했다 — 두 갈래가 같아졌나");
    assert.ok(!body.includes("decidedBy"), body);
  });

  check("🔵 **화면은 여전히 안 만들었다** — 이 조회를 쓰는 곳은 포털 통로 하나뿐이다", () => {
    // ── 이 줄의 내력 ──────────────────────────────────────────────────
    // 10a 때는 「화면도 **통로도** 안 만들었다」였고, 다음 조각이 통로를 내면
    // 지우라고 적혀 있었다. 🔴 **지우지 않고 뒤집었다** — 지우면 「화면을 함께
    // 손대지 않았다」까지 같이 사라진다. 화면은 통합 승인함 한 곳에 둔다는
    // 결정(2026-11-17 사용자)이 그대로 살아 있고, 이 집에 결재 내역 화면이
    // 생기는 날 그 결정이 뒤집힌 것이다.
    //
    // 🔴 **세는 것이 「없다」에서 「정확히 하나」로 바뀌었다.** 「없다」 쪽은
    //    통로가 사라져도 통과하므로, 통로가 생긴 지금은 그쪽이 더 약하다.
    const 쓰는곳 = appSources()
      .filter(({ code }) => code.includes("approvalHistory"))
      .map(({ path }) => path);
    assert.deepEqual(
      쓰는곳,
      ["src/app/api/integration/approval-history/route.ts"],
      `결재 내역 조회를 쓰는 곳: ${쓰는곳.join(", ") || "(없다)"}`,
    );
  });

  /* ---------------------------------------------------------------- */
  /* 5. 마이그레이션 — 🔴 **더하기만** 한다                              */
  /* ---------------------------------------------------------------- */

  check("마이그레이션이 **더하기만** 한다 — 지우거나 바꾸는 문장이 없다", () => {
    const sqlText = read(MIGRATION);
    // 🔴 **낱말 경계로 센다.** 그냥 `includes("DELETE")` 로 세면 부분 조건의
    //    `is_deleted` 가 걸려, 표를 하나도 안 건드리는 판이 「지우는 문장이 있다」로
    //    떨어진다(배포 검사에서 실제로 났던 모양 그대로다).
    for (const forbidden of ["DROP", "ALTER", "DELETE", "TRUNCATE", "UPDATE"]) {
      assert.ok(
        !new RegExp(`\\b${forbidden}\\b`).test(sqlText.toUpperCase()),
        `지우거나 바꾸는 문장이 있다: ${forbidden}`,
      );
    }
    assert.equal(sqlText.split("CREATE INDEX").length - 1, 2, "CREATE INDEX 가 둘이 아니다");
  });

  check("색인 이름이 63자를 넘지 않는다 — PostgreSQL 이 말없이 자른다", () => {
    const names = [...read(MIGRATION).matchAll(/CREATE INDEX "([^"]+)"/g)].map((m) => m[1]);
    assert.equal(names.length, 2);
    for (const name of names) assert.ok(name.length <= 63, `${name} (${name.length}자)`);
  });

  check("🔴 「지금 차례」용 색인 둘은 그대로다 — 결재함이 쓰는 길을 건드리지 않았다", () => {
    const schema = read(SCHEMA);
    for (const name of [
      "web_approval_steps_pending_approver_idx",
      "web_approval_steps_pending_idx",
    ]) {
      assert.ok(schema.includes(name), `${name} 가 사라졌다`);
      assert.ok(!read(MIGRATION).includes(name), `${name} 를 이 판이 건드린다`);
    }
    assert.ok(schema.includes("= 'PENDING'"), "「지금 차례」 부분 조건이 사라졌다");
  });

  console.log(`\n${passed}개 통과`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
