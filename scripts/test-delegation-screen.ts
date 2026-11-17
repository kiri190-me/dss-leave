/**
 * 결재권 위임을 **사람에게 보여 주는 쪽** 검사.  npm run test:delegation-screen
 *
 * 🔴 DB 에 닿지 않고 사내망에도 나가지 않는다. 질의는 **만들기만** 하고
 * `.toSQL()` 로 구워 본다(scripts/test-approval-delegation.ts 와 같은 수법).
 *
 * ── 이 검사가 생긴 까닭 (2026-11-17) ────────────────────────────────────
 * 사용자가 통합 승인함에서 위임을 맡긴 뒤 각 시스템을 열고 **「위임되었다는 내용이
 * 안 뜬다」**고 했다. 실제로 이 집에는 **보여 줄 자리가 없었다** — 자체 위임이
 * 없어 화면을 안 만들었기 때문이다(설계 B-9). 그래서 위임을 받으면 **결재함에
 * 남의 건이 갑자기 나타나는데 왜 거기 있는지 알 길이 없었다.**
 *
 * 그 조각이 더한 것은 둘이다:
 *   ① [휴가 설정 → 결재권 위임] 탭 — 🔴 **문이 탭마다 다르다**(직원도 들어온다)
 *   ② 결재함 맨 위 안내 — 🔴 **맡은 것이 없으면 아무것도 그리지 않는다**
 *
 * ── 무엇을 지키는가 ─────────────────────────────────────────────────────
 *   1. 🔴 직원은 관리자 탭을 **주소로 쳐도** 못 본다. 관리자는 둘 다 본다
 *   2. 🔴 관리자 자료는 `requireAdmin()` **뒤에서만** 읽힌다
 *   3. 🔴 「모두의 것」은 권한이 없으면 **아예 안 내려온다**(DB 에 묻지도 않는다)
 *   4. 🔴 화면 조회는 **끝난 줄·거둔 줄을 안 싣고**, 시작 전 줄은 **그렇게 적는다**
 *   5. 🔴 그 넓은 창이 **판정으로 새지 않았다**
 *   6. 🔴 이름과 기간이 글자에 **반드시** 들어간다. 기간은 **한국 시간**이다
 *   7. 🔴 두 화면이 **같은 문장**을 쓴다 — 글자를 두 벌로 적지 않았다
 *   8. 🔴 환경변수가 없어도 화면이 그려진다
 *   9. 🔴 **읽기 전용**이다 — 이 집에 맡기고 거두는 길이 생기지 않았다
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
delete process.env.APPROVALS_BASE_URL;

import { formatKstDateTime } from "../src/lib/dates";
import {
  DELEGATION_EMPTY_NOTE,
  DELEGATION_PHASE_LABEL,
  DELEGATION_READ_ONLY_NOTE,
  allDelegationSentence,
  delegationNoticeLines,
  delegationPeriodLabel,
  delegationPhase,
  delegationSentence,
  type DelegationRow,
} from "../src/lib/leave/delegation-view";
import {
  SETTINGS_TABS,
  SETTINGS_TAB_LABEL,
  resolveSettingsTab,
  settingsTabHref,
  settingsTabsFor,
} from "../src/lib/leave/settings-tabs";

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
const withoutComments = (source: string) => {
  const out = source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(out.trim().length > 0, "주석을 떼고 나니 아무것도 안 남았다 — 떼는 규칙이 더는 안 맞는다");
  return out;
};

/** `src/` 아래 모든 소스를 **주석을 걷어** 읽는다. 한 파일만 보고 「없다」고 하면 틀린다. */
function allSources(): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(new URL(`../${rel}`, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${rel}${entry.name}/`);
      else if (/\.tsx?$/.test(entry.name)) out.push({ path: `${rel}${entry.name}`, code: withoutComments(read(`${rel}${entry.name}`)) });
    }
  };
  walk("src/");
  return out;
}

/* ------------------------------------------------------------------ */
/* 가짜 값 — 🔴 실제 이름·사번을 한 자도 넣지 않는다                     */
/* ------------------------------------------------------------------ */

const 나 = "emp-나";

/** 2026-11-17(화) 12:00 KST = 03:00 UTC */
const 지금 = new Date("2026-11-17T03:00:00.000Z");

function row(over: Partial<DelegationRow> = {}): DelegationRow {
  return {
    id: "del-1",
    delegatorName: "맡긴이",
    delegateName: "대리인",
    // 11월 17일 09:00 KST ~ 11월 24일 18:00 KST
    startsAt: new Date("2026-11-17T00:00:00.000Z"),
    endsAt: new Date("2026-11-24T09:00:00.000Z"),
    reason: "",
    ...over,
  };
}

const SETTINGS = "src/app/(internal)/admin/settings/page.tsx";
const APPROVALS = "src/app/(internal)/approvals/page.tsx";
const NOTICE = "src/components/DelegationNotice.tsx";
const VIEW = "src/lib/leave/delegation-view.ts";

async function main() {
  console.log("\n결재권 위임 — 보여 주는 쪽 (탭 · 결재함 안내)\n");

  /* ---------------------------------------------------------------- */
  /* 1. 🔴 탭 고르기 — 직원은 관리자 탭을 못 고른다                      */
  /* ---------------------------------------------------------------- */

  check("🔵 탭은 둘이고 이름이 붙어 있다 — 표본이 비지 않았다", () => {
    assert.deepEqual([...SETTINGS_TABS], ["settings", "delegation"]);
    assert.equal(SETTINGS_TAB_LABEL.settings, "휴가 설정");
    assert.equal(SETTINGS_TAB_LABEL.delegation, "결재권 위임");
  });

  check("🔵 관리자는 둘 다, 직원은 **결재권 위임 하나**", () => {
    assert.deepEqual(settingsTabsFor(true), ["settings", "delegation"]);
    assert.deepEqual(settingsTabsFor(false), ["delegation"]);
  });

  check("🔵 관리자의 기본 탭은 **예전 그대로** 휴가 설정이다", () => {
    // 머리말 메뉴와 공휴일 연도 넘기기가 전부 `?tab=` 없는 주소다. 기본값을
    // 바꾸면 고친 적 없는 링크들이 엉뚱한 탭으로 간다.
    assert.equal(resolveSettingsTab(undefined, true), "settings");
    assert.equal(resolveSettingsTab("settings", true), "settings");
    assert.equal(resolveSettingsTab("delegation", true), "delegation");
  });

  check("🔴 **직원은 `?tab=settings` 를 쳐도 결재권 위임이 나온다**", () => {
    assert.equal(resolveSettingsTab("settings", false), "delegation");
    assert.equal(resolveSettingsTab(undefined, false), "delegation");
    // 🔵 모르는 값·여러 번 적힌 값(배열로 온다)도 볼 수 있는 탭으로 떨어진다.
    assert.equal(resolveSettingsTab("아무거나", false), "delegation");
    assert.equal(resolveSettingsTab(["settings", "delegation"], false), "delegation");
    assert.equal(resolveSettingsTab(["delegation"], true), "settings");
  });

  check("🔵 탭 주소가 한 곳에서 나온다 — 기본 탭엔 ?tab= 이 안 붙는다", () => {
    assert.equal(settingsTabHref("settings"), "/admin/settings");
    assert.equal(settingsTabHref("delegation"), "/admin/settings?tab=delegation");
  });

  /* ---------------------------------------------------------------- */
  /* 2. 🔴 서버가 막는다 — 자료를 **읽기 전에**                          */
  /* ---------------------------------------------------------------- */

  const settings = withoutComments(read(SETTINGS));

  check("🔴 관리자 자료는 `requireAdmin()` **뒤에서만** 읽힌다", () => {
    const 문지기 = settings.indexOf("await requireAdmin();");
    assert.ok(문지기 > 0, "🔵 표본이 비었다 — 관리자 문지기를 찾지 못했다");
    // 탭 고르기 한 줄이 느슨해지는 날에도 자료가 안 나가야 한다. 서버 컴포넌트가
    // **읽은 값은 그리지 않아도 HTML 에 실려 나간다** — 「탭을 안 그린다」로는
    // 한 줄도 못 막는다.
    for (const 자료 of [
      "loadRanks()",
      "loadApprovalRoute()",
      "loadRouteCandidates()",
      "loadLeaveSettings()",
      "loadHolidays(",
      // 🔵 **쓰는 자리**로 잰다 — 이름만 보면 맨 위 import 줄에 걸려 늘 「먼저
      //    읽는다」가 된다(2026-11-17 에 실제로 그렇게 걸렸다).
      ".from(webTenureRules)",
    ]) {
      const at = settings.indexOf(자료);
      assert.ok(at > 0, `🔵 표본이 비었다 — ${자료} 를 못 찾았다`);
      assert.ok(at > 문지기, `🔴 ${자료} 를 관리자 검사보다 **먼저** 읽는다`);
    }
  });

  check("🔴 위임 탭은 관리자 자료를 **지나기 전에** 빠져나간다", () => {
    const 고르기 = settings.indexOf("resolveSettingsTab(");
    const 빠져나감 = settings.indexOf('if (tab === "delegation") return');
    const 문지기 = settings.indexOf("await requireAdmin();");
    assert.ok(고르기 > 0 && 빠져나감 > 고르기, "탭을 고르고 빠져나가는 자리가 없다");
    assert.ok(빠져나감 < 문지기, "🔴 직원이 관리자 문지기에 먼저 부딪힌다 — 홈으로 튕긴다");
    // 들어오는 문은 사내 화면 공통 문이다(로그인 + 명단/관리자).
    assert.ok(settings.includes("const viewer = await requireViewer();"));
  });

  check("🔴 「모두의 것」을 그릴지는 **자료가 있나**로 가른다 — 감추는 것이 아니다", () => {
    assert.ok(settings.includes("loadAllUnfinishedDelegations({ isAdmin: viewer.isAdmin"));
    assert.ok(settings.includes("{all && ("), "🔴 자료 없이도 묶음을 그린다");
    assert.ok(
      !/\{viewer\.isAdmin && \(\s*<DelegationGroup/.test(settings),
      "🔴 자료는 읽어 놓고 화면에서만 가린다",
    );
  });

  check("🔴 이 화면에 **맡기고 거두는 길이 없다** — 읽기 전용", () => {
    const 탭 = settings.slice(settings.indexOf("function DelegationTab"), settings.indexOf("export default async function"));
    assert.ok(탭.length > 200, "🔵 표본이 비었다 — 탭 본문을 잘못 잘랐다");
    for (const 금지 of ["ActionForm", "<form", "revoke", "되돌리기", "<button"]) {
      assert.ok(!탭.includes(금지), `🔴 위임 탭에 ${금지} 가 들어갔다`);
    }
  });

  /* ---------------------------------------------------------------- */
  /* 3. 🔴 「모두의 것」 — 권한이 없으면 DB 에 묻지도 않는다              */
  /* ---------------------------------------------------------------- */

  const delegations = await import("../src/lib/auth/portal-delegations");

  await checkAsync("🔴 관리자가 아니면 **null 이다** — 조회 함수 자신이 거절한다", async () => {
    // 🔵 이 호출은 DB 에 닿지 않는다 — 거절하고 바로 끝나기 때문이다. (닿았다면
    //    위에 적어 둔 아무 데도 없는 주소로 붙으려다 던졌을 것이다.)
    assert.equal(await delegations.loadAllUnfinishedDelegations({ isAdmin: false }), null);
  });

  /* ---------------------------------------------------------------- */
  /* 4. 🔴 화면 조회 — 구워진 SQL 로 본다                                */
  /* ---------------------------------------------------------------- */

  const 받은것 = delegations.delegationsActingForQuery(나, 지금).toSQL();
  const 맡긴것 = delegations.delegationsGivenByQuery(나, 지금).toSQL();
  const 모두 = delegations.allUnfinishedDelegationsQuery(지금).toSQL();

  check("🔴 **거둔 줄과 끝난 줄은 셋 다 안 싣는다** — 끝나면 안내도 사라진다", () => {
    for (const [이름, baked] of [["받은 것", 받은것], ["맡긴 것", 맡긴것], ["모두", 모두]] as const) {
      assert.match(baked.sql, /"revoked_at" is null/, `${이름}: 거둔 줄을 거르지 않는다`);
      assert.ok(!/"revoked_at" is not null/.test(baked.sql), `${이름}: 거꾸로 읽고 있다`);
      assert.match(baked.sql, /"ends_at" > \$\d+/, `${이름}: 끝난 줄이 남는다`);
      assert.ok(!/"ends_at" >= /.test(baked.sql), `${이름}: 끝나는 순간이 아직 열려 있다`);
      // 🔵 drizzle 은 묶을 때 시각을 ISO 글자로 바꾼다 — `Date` 로 찾으면 못 찾는다.
      assert.ok(
        baked.params.some((p) => typeof p === "string" && /^\d{4}-\d{2}-\d{2}T/.test(p)),
        `${이름}: 기준 시각을 안 묶었다`,
      );
    }
  });

  check("🔴 화면 창은 **시작 전 줄까지** 싣는다 — 「없습니다」와 「아직」을 가르려고", () => {
    // 🔴 판정과 **일부러 다른** 조건이다. 그래서 아래 5절이 「판정으로 새지
    //    않았나」를 따로 잰다.
    for (const baked of [받은것, 맡긴것, 모두]) {
      assert.ok(
        !/"starts_at" <= \$/.test(baked.sql),
        "🔴 화면이 시작 전 줄을 걸러 버린다 — 맡긴 사람이 「전파가 안 됐다」로 읽는다",
      );
    }
  });

  check("🔴 방향이 둘이다 — 받은 것은 대리인으로, 맡긴 것은 맡긴 사람으로", () => {
    assert.match(받은것.sql, /"delegate_employee_id" = \$\d+/);
    assert.ok(!/"delegator_employee_id" = \$/.test(받은것.sql), "🔴 방향이 뒤집혔다");
    assert.match(맡긴것.sql, /"delegator_employee_id" = \$\d+/);
    assert.ok(!/"delegate_employee_id" = \$/.test(맡긴것.sql), "🔴 방향이 뒤집혔다");
    assert.ok(받은것.params.includes(나) && 맡긴것.params.includes(나), "🔵 번호를 안 묶었다");
    // 모두의 것에는 사람 조건이 **없다**.
    assert.ok(!/"delegate_employee_id" = \$/.test(모두.sql));
    assert.ok(!/"delegator_employee_id" = \$/.test(모두.sql));
  });

  check("🔴 **양쪽 이름**을 읽는다 — 한 표를 두 번 조인한다", () => {
    // 별명 없이 한 번만 걸면 두 이름이 같은 값이 되어 「김○○님이 김○○님에게
    // 맡겼습니다」가 오류 없이 그려진다.
    assert.equal((받은것.sql.match(/ inner join /g) ?? []).length, 2, "조인이 둘이 아니다");
    assert.match(받은것.sql, /"delegator"\."name"/);
    assert.match(받은것.sql, /"delegate"\."name"/);
    assert.match(받은것.sql, /from "web_portal_approval_delegations"/);
  });

  check("🔴 기준 시각이 **박혀 있지 않다** — 요청마다 다시 재진다", () => {
    const 나중 = delegations.delegationsActingForQuery(나, new Date("2027-03-05T00:00:00.000Z")).toSQL();
    assert.equal(나중.sql, 받은것.sql, "문장이 시각에 따라 달라진다 — 상수를 굽고 있다");
    assert.notDeepEqual(나중.params, 받은것.params, "🔴 시각이 묶이지 않는다");
  });

  /* ---------------------------------------------------------------- */
  /* 5. 🔴 넓은 창이 **판정으로 새지 않았다**                            */
  /* ---------------------------------------------------------------- */

  check("🔴 판정 질의는 여전히 `starts_at <= 지금` 을 묻는다", () => {
    const 판정 = delegations.actingForEmployeeIdsQuery(나, 지금).toSQL();
    assert.match(판정.sql, /"starts_at" <= \$\d+/, "🔴 시작 전인 위임으로 결재가 열린다");
    assert.match(판정.sql, /"ends_at" > \$\d+/);
    assert.match(판정.sql, /"revoked_at" is null/);
  });

  check("🔴 화면 조회를 **판정 쪽에서 부르지 않는다**", () => {
    const 화면조회 = ["loadDelegationsActingFor", "loadDelegationsGivenBy", "loadAllUnfinishedDelegations"];
    const 부르는곳 = allSources().filter(
      (f) => f.path !== "src/lib/auth/portal-delegations.ts" && 화면조회.some((n) => f.code.includes(n)),
    );
    assert.deepEqual(부르는곳.map((f) => f.path).sort(), [APPROVALS, SETTINGS].sort());
    // 판정 세 자리는 이 이름을 몰라야 한다.
    for (const 판정파일 of [
      "src/lib/leave/approval-scope.ts",
      "src/lib/leave/data.ts",
      "src/lib/leave/workflow.ts",
    ]) {
      const code = withoutComments(read(판정파일));
      for (const n of 화면조회) assert.ok(!code.includes(n), `🔴 ${판정파일} 이 화면 조회를 쓴다`);
    }
  });

  check("🔴 판정이 쓰는 목록은 **여전히 guards.ts 한 곳**에서만 읽힌다", () => {
    // 조각 8 이 세운 울타리다 — 읽는 자리가 여럿이면 「메뉴는 있는데 배지가 0」처럼
    // 어긋나도 아무 오류가 안 나는 모양이 된다. 화면 조회가 생겨도 그 자리는 하나다.
    const 부르는곳 = allSources().filter(
      (f) => f.path !== "src/lib/auth/portal-delegations.ts" && f.code.includes("loadActingForEmployeeIds"),
    );
    assert.deepEqual(부르는곳.map((f) => f.path), ["src/lib/auth/guards.ts"]);
  });

  /* ---------------------------------------------------------------- */
  /* 6. 🔴 글자 — 이름과 기간이 반드시 들어간다                          */
  /* ---------------------------------------------------------------- */

  check("🔴 진행 중·시작 전을 **판정과 같은 금**으로 가른다", () => {
    const 시작 = new Date("2026-11-17T00:00:00.000Z");
    assert.equal(delegationPhase({ startsAt: 시작 }, new Date(시작.getTime() - 1)), "UPCOMING");
    // 🔴 시작하는 그 순간은 **진행 중**이다(판정의 `starts_at <= 지금`과 같은 말).
    assert.equal(delegationPhase({ startsAt: 시작 }, 시작), "ACTIVE");
    assert.equal(delegationPhase({ startsAt: 시작 }, new Date(시작.getTime() + 1)), "ACTIVE");
    assert.equal(DELEGATION_PHASE_LABEL.ACTIVE, "진행 중");
    assert.equal(DELEGATION_PHASE_LABEL.UPCOMING, "시작 전");
  });

  check("🔴 기간이 **한국 시간**으로 적힌다 — 컨테이너가 UTC 여도", () => {
    const 본래 = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      // 🔵 표본 검증: TZ 바꾸기가 실제로 먹었는가. 안 먹으면 이 검사는 아무것도
      //    재지 못한다(개발 PC 가 KST 라 어느 쪽이든 통과해 버린다).
      assert.equal(new Date("2026-11-17T00:00:00.000Z").getHours(), 0, "TZ 바꾸기가 안 먹었다");
      // 00:00 UTC 는 한국에서 **그날 오전 9시**다.
      assert.equal(formatKstDateTime(new Date("2026-11-17T00:00:00.000Z")), "11월 17일 (화) 09:00");
      // 🔴 자정이 24:00 으로 나오면 같은 날 맨 앞을 다음 날처럼 읽는다.
      assert.equal(formatKstDateTime(new Date("2026-11-16T15:00:00.000Z")), "11월 17일 (화) 00:00");
    } finally {
      if (본래 === undefined) delete process.env.TZ;
      else process.env.TZ = 본래;
    }
  });

  check("🔴 기간 글자에 **양 끝**이 다 들어간다 · 해를 넘으면 연도도", () => {
    assert.equal(
      delegationPeriodLabel(row(), 지금),
      "11월 17일 (화) 09:00 ~ 11월 24일 (화) 18:00",
    );
    // 해를 넘기면 둘 다 연도를 단다 — 안 그러면 내년 3월과 지난 3월이 같은 글자다.
    const 해넘이 = row({
      startsAt: new Date("2026-12-30T00:00:00.000Z"),
      endsAt: new Date("2027-01-05T00:00:00.000Z"),
    });
    assert.match(delegationPeriodLabel(해넘이, 지금), /^2026년 .* ~ 2027년 /);
    // 올해가 아닌 기간도 연도를 단다.
    const 내년 = row({
      startsAt: new Date("2027-03-01T00:00:00.000Z"),
      endsAt: new Date("2027-03-08T00:00:00.000Z"),
    });
    assert.match(delegationPeriodLabel(내년, 지금), /^2027년 .* ~ 2027년 /);
  });

  check("🔴 **이름과 기간**이 문장에 들어간다 — 받은 쪽·맡긴 쪽 둘 다", () => {
    const 기간 = delegationPeriodLabel(row(), 지금);
    const 받음 = delegationSentence(row(), "RECEIVED", 지금);
    assert.ok(받음.includes("맡긴이님"), `맡긴 사람 이름이 없다: ${받음}`);
    assert.ok(받음.includes(기간), `기간이 없다: ${받음}`);
    assert.ok(받음.includes("통합 승인함"), "어디서 온 위임인지 안 적혀 있다");
    const 맡김 = delegationSentence(row(), "GIVEN", 지금);
    assert.ok(맡김.includes("대리인님"), `대리인 이름이 없다: ${맡김}`);
    assert.ok(맡김.includes(기간), `기간이 없다: ${맡김}`);
    // 🔵 두 방향이 **다른 말**을 한다 — 같으면 누가 누구를 대신하는지 못 읽는다.
    assert.notEqual(받음, 맡김);
    // 관리자 묶음은 「내」가 없다 — 남의 위임이다.
    const 모두한줄 = allDelegationSentence(row(), 지금);
    assert.ok(모두한줄.includes("맡긴이님") && 모두한줄.includes("대리인님"));
    assert.ok(!모두한줄.includes("내 "), `남의 줄에 「내」가 들어갔다: ${모두한줄}`);
  });

  check("🔴 **시작 전**이면 「지금 할 수 있다」고 말하지 않는다", () => {
    const 시작전 = row({
      startsAt: new Date("2026-11-20T00:00:00.000Z"),
      endsAt: new Date("2026-11-24T09:00:00.000Z"),
    });
    const 글 = delegationSentence(시작전, "RECEIVED", 지금);
    assert.ok(글.includes("아직 시작 전입니다"), `시작 전이라고 안 적는다: ${글}`);
    assert.ok(글.includes("11월 20일 (금) 09:00 부터"), `언제부터인지 안 적는다: ${글}`);
    // 🔵 표본 검증 — 진행 중 문장에는 그 말이 없다.
    assert.ok(!delegationSentence(row(), "RECEIVED", 지금).includes("아직 시작 전"));
    assert.ok(delegationSentence(시작전, "GIVEN", 지금).includes("아직 시작 전입니다"));
  });

  /* ---------------------------------------------------------------- */
  /* 7. 🔴 결재함 안내 — 없으면 안 그린다                                */
  /* ---------------------------------------------------------------- */

  check("🔴 **아무것도 안 맡았으면 줄이 하나도 없다**", () => {
    assert.deepEqual(delegationNoticeLines([], [], 지금), []);
  });

  check("🔴 맡은 것이 있으면 그 줄에 **이름과 기간**이 있다", () => {
    const lines = delegationNoticeLines([row()], [], 지금);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].side, "RECEIVED");
    assert.equal(lines[0].phase, "ACTIVE");
    assert.ok(lines[0].text.includes("맡긴이님"));
    assert.ok(lines[0].text.includes(delegationPeriodLabel(row(), 지금)));
  });

  check("🔵 **받은 것이 먼저** 선다 — 결재함에서 급한 물음이 그쪽이다", () => {
    const lines = delegationNoticeLines([row({ id: "r1" })], [row({ id: "g1" })], 지금);
    assert.deepEqual(lines.map((l) => l.side), ["RECEIVED", "GIVEN"]);
    assert.deepEqual(lines.map((l) => l.id), ["r1", "g1"]);
  });

  check("🔵 겹치는 위임이 둘이어도 줄이 둘이다 — 줄 번호로 가른다", () => {
    const lines = delegationNoticeLines([row({ id: "a" }), row({ id: "b" })], [], 지금);
    assert.deepEqual(lines.map((l) => l.id), ["a", "b"]);
  });

  const notice = withoutComments(read(NOTICE));

  check("🔴 안내 조각이 **빈 손이면 null** 이다", () => {
    assert.ok(notice.includes("if (lines.length === 0) return null;"));
    assert.ok(notice.includes("delegationNoticeLines(received, given, now)"));
  });

  check("🔴 보여 주는 조각에 **단추도 폼도 없다** — 여기서는 못 거둔다", () => {
    for (const 금지 of ["<button", "<form", "ActionForm", "revoke", "되돌리기", "action="]) {
      assert.ok(!notice.includes(금지), `🔴 안내 조각에 ${금지} 가 들어갔다`);
    }
    // 🔴 서버 조각이다 — 클라이언트로 내려보내면 위임 줄이 브라우저 번들에 실린다.
    //    🔵 주석을 걷어낸 **첫 토큰**으로 본다(주석에 적힌 낱말에 속지 않게).
    assert.ok(!notice.trim().startsWith('"use client"'));
  });

  check("🔴 「여기서는 못 거둔다」를 **두 화면이 같은 글자**로 말한다", () => {
    assert.ok(DELEGATION_READ_ONLY_NOTE.includes("통합 승인함"));
    assert.ok(notice.includes("DELEGATION_READ_ONLY_NOTE"));
    // 결재함 안내와 탭이 그 조각을 함께 쓴다.
    assert.ok(withoutComments(read(APPROVALS)).includes("<DelegationNotice"));
    assert.ok(settings.includes("<DelegationSourceNote"));
    assert.ok(settings.includes("<DelegationGroup"));
  });

  check("🔴 문장을 **두 벌로 적지 않았다** — 만드는 곳이 하나다", () => {
    const 글자 = ["결재권을 맡았습니다", "님에게 맡겼습니다", "아직 시작 전입니다"];
    for (const 한줄 of 글자) {
      const 적힌곳 = allSources().filter((f) => f.code.includes(한줄));
      assert.deepEqual(적힌곳.map((f) => f.path), [VIEW], `🔴 ${한줄} 가 여러 곳에 적혀 있다`);
    }
    // 화면은 문장을 **만들지 않고 받아** 그린다.
    assert.ok(!withoutComments(read(APPROVALS)).includes("delegationSentence"));
  });

  check("🔴 **비었을 때 할 말**이 있다 — 빈 자리는 고장으로 읽힌다", () => {
    assert.ok(DELEGATION_EMPTY_NOTE.includes("통합 승인함"));
    assert.ok(notice.includes("DELEGATION_EMPTY_NOTE"), "묶음에 기본 빈 글자가 없다");
    // 세 묶음 모두 제 사정에 맞는 글을 넘긴다.
    assert.equal((settings.match(/empty="/g) ?? []).length, 3);
  });

  /* ---------------------------------------------------------------- */
  /* 8. 🔴 환경변수가 없어도 화면이 그려진다                             */
  /* ---------------------------------------------------------------- */

  const { env } = await import("../src/lib/env");

  check("🔴 `APPROVALS_BASE_URL` 이 없으면 **null** — 던지지 않는다", () => {
    delete process.env.APPROVALS_BASE_URL;
    assert.equal(env.approvalsBaseUrl, null);
    process.env.APPROVALS_BASE_URL = "   ";
    assert.equal(env.approvalsBaseUrl, null);
  });

  check("🔵 값이 있으면 끝 슬래시를 떼고 준다", () => {
    process.env.APPROVALS_BASE_URL = "http://192.168.0.222:3900/";
    assert.equal(env.approvalsBaseUrl, "http://192.168.0.222:3900");
    process.env.APPROVALS_BASE_URL = "https://approvals.example.com";
    assert.equal(env.approvalsBaseUrl, "https://approvals.example.com");
  });

  check("🔴 주소 모양이 아니면 **없는 것으로 본다** — 링크에 실리지 않게", () => {
    process.env.APPROVALS_BASE_URL = "javascript:alert(1)";
    assert.equal(env.approvalsBaseUrl, null);
    process.env.APPROVALS_BASE_URL = "192.168.0.222:3900";
    assert.equal(env.approvalsBaseUrl, null);
    delete process.env.APPROVALS_BASE_URL;
  });

  check("🔴 없을 때는 **링크만 빠지고 글자는 남는다**", () => {
    // 두 자리 모두 `approvalsUrl && (…)` 로 감싸 두었다 — 없으면 글만 나간다.
    assert.equal((notice.match(/approvalsUrl && \(/g) ?? []).length, 2);
    assert.ok(notice.includes("통합 승인함 열기"));
    // 🔴 주소를 코드에 박지 않았다 — 읽는 자리는 환경변수 하나다.
    const 박힌주소 = allSources().filter((f) => /https?:\/\/[^"']*39\d\d/.test(f.code));
    assert.deepEqual(박힌주소.map((f) => f.path), []);
    const envCode = withoutComments(read("src/lib/env.ts"));
    assert.ok(envCode.includes('process.env.APPROVALS_BASE_URL'), "🔴 이름이 바뀌었다 — 세 집이 같은 이름을 쓴다");
  });

  /* ---------------------------------------------------------------- */
  /* 9. 🔴 이 집에 **맡기고 거두는 길**이 생기지 않았다                   */
  /* ---------------------------------------------------------------- */

  check("🔴 표에 쓰는 자리는 **받는 통로 하나** 그대로다", () => {
    // 🔵 **이름이 보이는 곳**으로 잰다 — 통로는 그 함수를 부르지 않고 **값으로
    //    꽂는다**(`upsert: upsertPortalDelegation`). 괄호로 찾으면 0 곳이 나와
    //    「아무도 안 쓴다」로 조용히 통과한다(2026-11-17 에 실제로 그렇게 걸렸다).
    for (const 쓰는함수 of ["upsertPortalDelegation", "revokePortalDelegation"]) {
      const 쓰는곳 = allSources().filter(
        (f) =>
          f.path !== "src/lib/auth/portal-delegation-store.ts" && f.code.includes(쓰는함수),
      );
      assert.deepEqual(
        쓰는곳.map((f) => f.path),
        ["src/app/api/integration/delegations/route.ts"],
        `🔴 ${쓰는함수} 를 쓰는 곳이 늘었다 — 이 집에 맡기고 거두는 길이 생겼다`,
      );
    }
  });

  /**
   * 🔴 **허락된 것은 이 둘뿐이다** (2026-11-17, 역할 위임). 결재권 위임이 역할까지
   * 넘기면서 서버 액션 하나(`setRoleAction`)가 「지금 이 사람이 위임으로 받은 임시
   * 관리자인가」를 **묻게** 됐다.
   *
   * 🔵 **묻기만 한다** — `src/lib/auth/delegated-role.ts` 는 표를 읽지도 쓰지도
   *    않는 순수 판정이다(그 파일 머리말 · scripts/test-delegated-role.ts). 그래서
   *    이 울타리가 지키려는 것(「이 집에 맡기고 거두는 길이 생기지 않았다」)은
   *    그대로다.
   * 🔴 **이름을 못 박아 둔다.** 「위임 비슷한 글자는 다 봐준다」로 풀면 다음 사람이
   *    여기에 `loadActingForEmployeeIds` 든 표 이름이든 끌어와도 조용히 통과한다.
   *    아래에서 **어느 파일에서 몇 번 쓰이는지**까지 다시 센다.
   */
  const 역할울타리 = [
    "@/lib/auth/delegated-role",
    "SET_ROLE_DELEGATED_ADMIN_MESSAGE",
    "mayChangeUserRole",
  ];

  check("🔴 서버 액션에 위임이 하나도 없다 — 화면에서 바꿀 길이 없다", () => {
    const actions = allSources().filter((f) => f.path.startsWith("src/app/actions/"));
    assert.ok(actions.length >= 3, "🔵 표본이 비었다 — 서버 액션 파일을 못 읽었다");
    for (const f of actions) {
      const 남은 = 역할울타리.reduce((code, 이름) => code.split(이름).join(""), f.code);
      assert.ok(!/delegat/i.test(남은), `🔴 ${f.path} 에 위임을 건드리는 길이 생겼다`);
    }
  });

  check("🔴 그 하나뿐인 예외가 **번지지 않았다** — 자리도 횟수도 못 박는다", () => {
    const actions = allSources().filter((f) => f.path.startsWith("src/app/actions/"));
    for (const 이름 of 역할울타리) {
      assert.deepEqual(
        actions.filter((f) => f.code.includes(이름)).map((f) => f.path),
        ["src/app/actions/admin.ts"],
        `🔴 ${이름} 을 쓰는 서버 액션 파일이 늘었다`,
      );
    }
    const admin = actions.find((f) => f.path === "src/app/actions/admin.ts")!;
    // 🔴 묻는 자리가 하나다 — 역할 변경 말고 다른 관리자 문까지 막으면 2026-11-17
    //    결정(「역할 변경만 빼고 전부」)을 바꾼 것이다.
    assert.equal(admin.code.split("mayChangeUserRole(").length - 1, 1, "🔴 묻는 자리가 늘거나 줄었다");
  });

  console.log(`\n${passed}개 통과`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
