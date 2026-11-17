/**
 * 끝난 결재권 위임을 **접어 두는 쪽** 검사.  npm run test:delegation-fold
 *
 * 🔴 DB 에 닿지 않고 사내망에도 나가지 않는다. 질의는 **만들기만** 하고
 * `.toSQL()` 로 구워 본다(scripts/test-delegation-screen.ts 와 같은 수법).
 *
 * ── 이 검사가 생긴 까닭 (2026-11-17) ────────────────────────────────────
 * 사용자가 「‘내가 대신하고 있는 것’에 이미 만료된 위임건들이 쌓인다. 만료되면
 * 거기서 없어져도 될 것 같다」고 했다. **지우지 않고 접었다** — 지난 위임은
 * 「그때 왜 저 사람이 눌렀나」의 근거라 사라지면 안 된다.
 *
 * 🔴 **이 집은 거꾸로였다.** 화면용 조회가 끝난 줄을 **아예 안 읽어서** 기간이
 * 지나면 그 위임을 다시 볼 길이 **한 군데도 없었다**(관리자용 「모두의 결재권
 * 위임」조차 안 끝난 줄만 본다). 그래서 여기서 접기는 **감추는 일이 아니라
 * 보이게 하는 일**이다 — 아래 2절이 그 줄이 실제로 내려오는지를 본다.
 *
 * ── 무엇을 지키는가 ─────────────────────────────────────────────────────
 *   1. 🔴 가르는 금이 **한 벌**이다 — 접는 조건은 펴는 조건의 **여집합**이고,
 *      화면 딱지도 같은 금으로 갈린다(일곱 경우로 맞대어 본다)
 *   2. 🔴 **만료·철회된 줄이 내려온다** — 이 조각의 핵심
 *   3. 🔴 상한이 **방향마다 따로** 걸리고, 넘치면 **말해 준다**
 *   4. 🔴 접힌 안의 줄은 **펴 둔 쪽과 똑같이** 그린다 — 조각도 고르는 칸도 같다
 *   5. 🔴 **두 묶음의 접기가 서로 따로** 기억된다(`details` 에 `name` 이 없다)
 *   6. 🔴 끝난 것이 **0건이면 접기를 안 그린다**
 *   7. 🔴 화면 글이 더는 「이 목록에서 사라집니다」라고 말하지 않는다
 *   8. 🔴 **결재 판정·역할 위임·알림**이 쓰는 조회는 한 글자도 안 바뀌었다
 *
 * 🔴 왜 전부 main() 안에 있나 · 🔴 DB 를 건드리는 모듈을 `await import` 로 부르는
 * 까닭은 scripts/test-delegation-screen.ts 머리말과 같다.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// 🔴 .env.local 을 읽지 않는다 — DATABASE_URL 은 **아무 데도 붙지 않는 주소**다.
//    질의를 만들기만 하므로 끝까지 접속이 일어나지 않는다.
process.env.SSO_ISSUER = "http://127.0.0.1:1";
process.env.SSO_CLIENT_ID = "dss-leave";
process.env.SSO_CLIENT_SECRET = "테스트용-시크릿";
process.env.SSO_REDIRECT_URI = "http://192.168.1.10:3700/api/auth/sso/callback";
process.env.SSO_TX_SECRET = "0123456789abcdef0123456789abcdef";
process.env.DATABASE_URL = "postgres://nobody:nobody@127.0.0.1:1/none";

import {
  DELEGATION_FINISHED_LIMIT,
  DELEGATION_PHASE_CHIP,
  DELEGATION_PHASE_LABEL,
  delegationFinishedToggleLabel,
  delegationFinishedTruncatedNotice,
  delegationGroupEmptyNote,
  delegationPhase,
  delegationSentence,
  emptyDelegationFold,
  foldFinishedDelegations,
  isFinishedPhase,
  type DelegationPhase,
  type DelegationRow,
} from "../src/lib/leave/delegation-view";

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
const 하루 = 24 * 60 * 60 * 1000;
const 때 = (일: number) => new Date(지금.getTime() + 일 * 하루);

function row(over: Partial<DelegationRow> = {}): DelegationRow {
  return {
    id: "del-1",
    delegatorName: "맡긴이",
    delegateName: "대리인",
    startsAt: 때(-1),
    endsAt: 때(7),
    revokedAt: null,
    reason: "",
    ...over,
  };
}

const SETTINGS = "src/app/(internal)/admin/settings/page.tsx";
const APPROVALS = "src/app/(internal)/approvals/page.tsx";
const NOTICE = "src/components/DelegationNotice.tsx";
const QUERIES = "src/lib/auth/portal-delegations.ts";

/** 구운 SQL 에서 `from` 앞까지 — **고르는 칸 목록**이다. */
const 고르는칸 = (sql: string) => sql.slice(0, sql.indexOf(' from "web_portal_approval_delegations"'));

type Baked = { sql: string; params: unknown[] };

/**
 * 질의를 굽되 **표 이름 접두사를 걷어** 읽는다. drizzle 은 칸마다
 * `"web_portal_approval_delegations"."revoked_at"` 로 적어서, 걷지 않으면 조건 하나를
 * 재는 정규식이 100자를 넘고 **무엇을 재는지 사람이 못 읽는다.**
 * 🔴 걷어내는 것은 **접두사뿐**이다 — `from`·조인 쪽 표 이름은 그대로 남는다.
 */
function bake(query: { toSQL: () => Baked }): Baked {
  const baked = query.toSQL();
  return { sql: baked.sql.split('"web_portal_approval_delegations".').join(""), params: baked.params };
}

async function main() {
  console.log("\n결재권 위임 — 끝난 것을 접어 두는 쪽\n");

  const delegations = await import("../src/lib/auth/portal-delegations");

  const 펴는것 = bake(delegations.delegationsActingForQuery(나, 지금));
  const 접는것 = bake(delegations.finishedDelegationsActingForQuery(나, 지금));
  const 펴는것_맡김 = bake(delegations.delegationsGivenByQuery(나, 지금));
  const 접는것_맡김 = bake(delegations.finishedDelegationsGivenByQuery(나, 지금));

  /* ---------------------------------------------------------------- */
  /* 1. 🔴 가르는 금이 **한 벌**이다 — 접는 쪽은 펴는 쪽의 여집합        */
  /* ---------------------------------------------------------------- */

  check("🔵 표본이 비지 않았다 — 네 질의가 모두 구워진다", () => {
    for (const [이름, baked] of [
      ["펴는 것(받은)", 펴는것],
      ["접는 것(받은)", 접는것],
      ["펴는 것(맡긴)", 펴는것_맡김],
      ["접는 것(맡긴)", 접는것_맡김],
    ] as const) {
      assert.match(baked.sql, /from "web_portal_approval_delegations"/, `${이름}: 위임 표를 안 읽는다`);
    }
    // 🔴 넷이 서로 다른 문장이어야 한다. 같으면 아래 검사들이 **같은 것을 네 번**
    //    재면서 전부 통과한다.
    assert.equal(new Set([펴는것.sql, 접는것.sql, 펴는것_맡김.sql, 접는것_맡김.sql]).size, 4);
  });

  check("🔴 접는 조건이 펴는 조건의 **여집합**이다 — 새로 적은 규칙이 아니다", () => {
    // 안 끝남: revoked_at is null  AND  ends_at >  지금
    // 끝남:    revoked_at is not null OR ends_at <= 지금
    for (const baked of [펴는것, 펴는것_맡김]) {
      assert.match(baked.sql, /"revoked_at" is null and "ends_at" > \$\d+/);
      assert.ok(!/"revoked_at" is not null/.test(baked.sql), "펴는 쪽에 끝난 줄이 섞인다");
      assert.ok(!/"ends_at" <= \$/.test(baked.sql), "펴는 쪽에 만료된 줄이 섞인다");
    }
    for (const baked of [접는것, 접는것_맡김]) {
      assert.match(baked.sql, /"revoked_at" is not null or "ends_at" <= \$\d+/);
      // 🔴 `and` 로 적으면 **거뒀고 또 기간도 지난 줄만** 접히고, 그냥 만료된 줄은
      //    양쪽 어디에도 안 뜬 채 영영 사라진다.
      assert.ok(!/"revoked_at" is not null and/.test(baked.sql), "or 가 and 로 뒤집혔다");
      assert.ok(!/"revoked_at" is null/.test(baked.sql), "접는 쪽이 살아 있는 줄을 긁는다");
      assert.ok(!/"ends_at" > \$/.test(baked.sql), "부등호가 뒤집혔다");
      // 🔴 끝나는 **그 순간**은 끝난 쪽이다(반열린 구간). `<` 로 적으면 그 한 순간
      //    위임이 양쪽에서 모두 빠진다.
      assert.ok(!/"ends_at" < \$\d+\)/.test(접는것.sql), "끝나는 순간이 양쪽에서 빠진다");
    }
  });

  check("🔴 딱지도 **같은 금**으로 갈린다 — 일곱 경우를 맞대어 본다", () => {
    // 🔴 아래 「SQL 이라면」은 바로 위에서 **구운 글자로 확인한** 두 조건을 그대로
    //    옮긴 것이다(`revoked_at is not null or ends_at <= 지금`). 여기가 딱지와
    //    갈리면 화면에 「진행 중」이라고 적힌 줄이 접혀 있는, 설명할 수 없는 모양이
    //    된다 — 아무 오류도 안 난다.
    const SQL이끝났다고한다 = (r: DelegationRow) =>
      r.revokedAt !== null || r.endsAt.getTime() <= 지금.getTime();

    const 경우: [string, DelegationRow, DelegationPhase][] = [
      ["진행 중", row(), "ACTIVE"],
      ["시작 전", row({ startsAt: 때(1), endsAt: 때(8) }), "UPCOMING"],
      ["시작하는 그 순간", row({ startsAt: 지금, endsAt: 때(8) }), "ACTIVE"],
      ["만료", row({ startsAt: 때(-10), endsAt: 때(-1) }), "EXPIRED"],
      ["끝나는 그 순간", row({ startsAt: 때(-10), endsAt: 지금 }), "EXPIRED"],
      ["거둠(기간 안)", row({ revokedAt: 때(-0.5) }), "REVOKED"],
      ["거둠 + 기간도 지남", row({ startsAt: 때(-10), endsAt: 때(-1), revokedAt: 때(-2) }), "REVOKED"],
    ];
    assert.equal(경우.length, 7, "🔵 표본이 줄었다");

    for (const [이름, r, 기대] of 경우) {
      const phase = delegationPhase(r, 지금);
      assert.equal(phase, 기대, `${이름}: 딱지가 ${phase} 로 나온다`);
      assert.equal(
        isFinishedPhase(phase),
        SQL이끝났다고한다(r),
        `🔴 ${이름}: 조회가 고르는 쪽과 딱지가 갈린다`,
      );
    }
    // 🔴 겹치지도 비지도 않는다 — 한 줄은 **반드시 한쪽에만** 선다.
    for (const [이름, r] of 경우) {
      const 접힘 = isFinishedPhase(delegationPhase(r, 지금));
      assert.notEqual(접힘, !SQL이끝났다고한다(r), `${이름}: 양쪽에 다 뜨거나 어디에도 안 뜬다`);
    }
  });

  check("🔴 **거둔 줄은 「철회됨」이다** — 기간까지 지났어도", () => {
    // 사람이 묻는 것은 「왜 없어졌나」이고, 그 답은 「거뒀기 때문」이다.
    const 둘다 = row({ startsAt: 때(-10), endsAt: 때(-1), revokedAt: 때(-2) });
    assert.equal(delegationPhase(둘다, 지금), "REVOKED");
    assert.equal(DELEGATION_PHASE_LABEL.REVOKED, "철회됨");
    assert.equal(DELEGATION_PHASE_LABEL.EXPIRED, "만료");
    // 🔵 딱지 넷의 색이 서로 다르다 — 같으면 접기를 펴 둔 채 훑을 때 구별이 안 된다.
    assert.equal(new Set(Object.values(DELEGATION_PHASE_CHIP)).size, 4);
    assert.equal(new Set(Object.values(DELEGATION_PHASE_LABEL)).size, 4);
  });

  /* ---------------------------------------------------------------- */
  /* 2. 🔴 **끝난 줄이 내려온다** — 이 조각의 핵심                       */
  /* ---------------------------------------------------------------- */

  check("🔴 끝난 줄을 **실제로 가져오는 질의가 생겼다** — 그전에는 한 줄도 없었다", () => {
    // 🔵 이 검사가 이 조각 전체의 표본 검증이다. 2026-11-17 아침까지 이 집의 화면용
    //    조회는 넷 다 `revoked_at is null and ends_at > 지금` 뿐이었다.
    const code = withoutComments(read(QUERIES));
    assert.ok(code.includes("function finishedWhere("), "끝난 쪽 조건이 없다");
    for (const 이름 of [
      "export function finishedDelegationsActingForQuery",
      "export function finishedDelegationsGivenByQuery",
      "export async function loadDelegationFoldActingFor",
      "export async function loadDelegationFoldGivenBy",
    ]) {
      assert.ok(code.includes(이름), `${이름} 이 없다`);
    }
  });

  check("🔴 방향이 둘이고 **섞이지 않는다**", () => {
    assert.match(접는것.sql, /"delegate_employee_id" = \$\d+/);
    assert.ok(!/"delegator_employee_id" = \$/.test(접는것.sql), "🔴 방향이 뒤집혔다");
    assert.match(접는것_맡김.sql, /"delegator_employee_id" = \$\d+/);
    assert.ok(!/"delegate_employee_id" = \$/.test(접는것_맡김.sql), "🔴 방향이 뒤집혔다");
    assert.ok(접는것.params.includes(나) && 접는것_맡김.params.includes(나), "🔵 번호를 안 묶었다");
    // 🔴 사람 조건 **없이** 끝난 줄을 긁는 길이 생기지 않았다 — 「모두의 끝난 위임」은
    //    이 조각의 범위 밖이고, 그 화면은 상한의 뜻이 다르다(조회 쪽 머리말).
    assert.ok(!("finishedDelegationsQuery" in delegations));
  });

  check("🔴 **고르는 칸이 펴 둔 쪽과 글자 그대로 같다** — 접힌 줄도 똑같이 그린다", () => {
    assert.equal(고르는칸(접는것.sql), 고르는칸(펴는것.sql));
    // 🔵 표본 검증 — 그 칸 목록이 비어 있지 않고 **거둔 때**를 싣는다(딱지가 「만료」와
    //    「철회됨」을 가르려면 그 칸이 있어야 한다).
    assert.match(고르는칸(접는것.sql), /"revoked_at"/);
    assert.match(고르는칸(접는것.sql), /"delegator"\."name"/);
    assert.match(고르는칸(접는것.sql), /"delegate"\."name"/);
    assert.equal((접는것.sql.match(/ inner join /g) ?? []).length, 2, "한 표를 두 번 안 걸었다");
  });

  check("🔴 끝난 쪽은 **최근 것부터**다 — 펴 둔 쪽과 차례가 반대", () => {
    assert.match(펴는것.sql, /order by "starts_at" asc/);
    // 🔵 끝이 같은 줄들의 차례도 못 박는다 — 흔들리면 상한에 걸려 **잘리는 줄이
    //    새로고침마다 달라진다.**
    assert.match(접는것.sql, /order by "ends_at" desc, "starts_at" desc/);
  });

  check("🔴 기준 시각이 **박혀 있지 않다** — 요청마다 다시 재진다", () => {
    const 나중 = bake(delegations.finishedDelegationsActingForQuery(나, new Date("2027-03-05T00:00:00.000Z")));
    assert.equal(나중.sql, 접는것.sql, "문장이 시각에 따라 달라진다 — 상수를 굽고 있다");
    assert.notDeepEqual(나중.params, 접는것.params, "🔴 시각이 묶이지 않는다");
  });

  /* ---------------------------------------------------------------- */
  /* 3. 🔴 상한 — 방향마다 따로, 넘치면 말해 준다                        */
  /* ---------------------------------------------------------------- */

  check("🔴 상한보다 **한 줄 더** 읽는다 — 그것이 「넘쳤다」를 아는 유일한 길", () => {
    assert.equal(DELEGATION_FINISHED_LIMIT, 50);
    for (const baked of [접는것, 접는것_맡김]) {
      assert.match(baked.sql, /limit \$\d+/);
      assert.ok(
        baked.params.includes(DELEGATION_FINISHED_LIMIT + 1),
        "🔴 딱 상한만큼만 읽는다 — 「정확히 50건인 날」과 「넘친 날」이 같은 답이 된다",
      );
    }
    // 🔴 펴 둔 쪽에는 상한이 **없다.** 걸면 끝난 줄이 쌓인 사람에게 **지금 걸려 있는
    //    위임**이 화면에서 밀려 사라진다.
    for (const baked of [펴는것, 펴는것_맡김]) {
      assert.ok(!/limit \$/.test(baked.sql), "🔴 펴 둔 쪽에 상한이 걸렸다");
    }
  });

  check("🔴 상한이 **방향마다 따로** 걸린다 — 한쪽이 다른 쪽을 밀어내지 않는다", () => {
    // 🔵 두 질의가 **각자** `limit`을 들고 있다는 것이 곧 「따로 걸린다」다. 하나로
    //    묶여 있으면 맡긴 끝난 줄이 50건인 사람에게 대신하던 끝난 줄이 한 줄도 안
    //    보이면서 **잘렸다는 말조차 안 나온다.**
    assert.equal((접는것.sql.match(/limit \$/g) ?? []).length, 1);
    assert.equal((접는것_맡김.sql.match(/limit \$/g) ?? []).length, 1);
    const code = withoutComments(read(QUERIES));
    for (const 함수 of ["loadDelegationFoldActingFor", "loadDelegationFoldGivenBy"]) {
      const at = code.indexOf(`export async function ${함수}`);
      assert.ok(at > 0, `🔵 표본이 비었다 — ${함수} 를 못 찾았다`);
      const 본문 = code.slice(at, at + 600);
      assert.ok(본문.includes("finishedDelegations"), `${함수} 가 끝난 줄을 안 읽는다`);
      assert.ok(본문.includes("foldFinishedDelegations("), `${함수} 가 접는 셈을 안 쓴다`);
    }
  });

  check("🔴 넘치면 **잘라 내고 잘렸다고 말한다** — 앞에서부터 자른다", () => {
    const 줄 = (n: number) => Array.from({ length: n }, (_, i) => `줄-${i}`);
    // 딱 상한이면 자르지 않는다.
    const 딱 = foldFinishedDelegations([], 줄(50), 50);
    assert.equal(딱.finished.length, 50);
    assert.equal(딱.finishedTruncated, false);
    // 한 줄 더 읽어 왔으면 **그 한 줄은 버리고** 넘쳤다고 말한다.
    const 넘침 = foldFinishedDelegations([], 줄(51), 50);
    assert.equal(넘침.finished.length, 50);
    assert.equal(넘침.finishedTruncated, true);
    // 🔴 **앞에서부터** 자른다 — 조회가 최근 것부터 주므로 뒤에서 자르면 **가장
    //    오래된 50건**이 남는다(사람이 찾는 것은 방금 끝난 줄이다).
    assert.equal(넘침.finished[0], "줄-0");
    assert.equal(넘침.finished[49], "줄-49");
    assert.ok(!넘침.finished.includes("줄-50"));
    // 🔵 N 을 화면이 글자로 박지 않게 함께 내려온다.
    assert.equal(넘침.finishedLimit, 50);
  });

  check("🔵 펴 둔 쪽은 **한 줄도 안 자른다**", () => {
    const 많음 = foldFinishedDelegations(Array.from({ length: 60 }, (_, i) => i), [], 50);
    assert.equal(많음.live.length, 60);
    assert.equal(많음.finishedTruncated, false);
  });

  check("🔵 빈 묶음도 **네 칸이 다 찬다** — 명단에 안 이어진 계정이 받는 값", () => {
    const 빈것 = emptyDelegationFold<string>();
    assert.deepEqual(빈것, { live: [], finished: [], finishedTruncated: false, finishedLimit: 50 });
  });

  /* ---------------------------------------------------------------- */
  /* 4. 🔴 글자 — 네 집이 같은 말을 한다                                 */
  /* ---------------------------------------------------------------- */

  check("🔴 접기 손잡이 글자가 **네 집과 같다**", () => {
    assert.equal(delegationFinishedToggleLabel(false, 3, false), "끝난 위임 보기 (3건)");
    assert.equal(delegationFinishedToggleLabel(true, 3, false), "끝난 위임 접기");
    // 🔴 잘렸으면 `+` 를 붙인다 — 그 수가 전부가 아니다.
    assert.equal(delegationFinishedToggleLabel(false, 50, true), "끝난 위임 보기 (50건+)");
    assert.equal(delegationFinishedToggleLabel(true, 50, true), "끝난 위임 접기");
  });

  check("🔴 잘림 안내가 **통합 승인함**을 가리킨다 — 이 집 변경 이력이 아니다", () => {
    const 안내 = delegationFinishedTruncatedNotice(50);
    assert.ok(안내.includes("최근 50건"), `상한을 안 적는다: ${안내}`);
    assert.ok(안내.includes("통합 승인함"), `갈 곳을 안 적는다: ${안내}`);
    // 🔴 이 집 변경 이력(web_audit_logs)에는 위임 줄이 **한 줄도 없다** — 포털이
    //    써 준 사본이라서다. 베껴서 「변경 이력」이라고 적으면 없는 곳으로 보낸다.
    assert.ok(!안내.includes("변경 이력"), "없는 곳으로 사람을 보낸다");
    assert.ok(!안내.includes("감사 로그"), "이 집에는 그 이름의 자리가 없다");
    // 🔵 수를 글자로 안 박았다 — 상한을 고치면 글자도 따라온다.
    assert.ok(delegationFinishedTruncatedNotice(7).includes("최근 7건"));
  });

  check("🔴 빈 묶음의 말이 **접혀 있는 줄의 수로 갈린다**", () => {
    for (const side of ["RECEIVED", "GIVEN"] as const) {
      const 접힌게있다 = delegationGroupEmptyNote(side, 3);
      assert.ok(접힌게있다.includes("없습니다"), `${side}: 지금 없다는 말은 해야 한다`);
      assert.ok(접힌게있다.includes("끝난 위임"), `${side}: 접기를 열어 보라고 알려 줘야 한다`);
      // 🔴 0건이면 접기 자체가 안 그려진다 — 「아래에서 펼쳐」가 **없는 손잡이**를
      //    가리키면 안 된다.
      const 접힌게없다 = delegationGroupEmptyNote(side, 0);
      assert.ok(!접힌게없다.includes("아래에서 펼쳐"), `${side}: 없는 접기를 가리킨다`);
      assert.ok(접힌게없다.includes("통합 승인함"), `${side}: 어디서 맡기는지 안 적는다`);
      assert.notEqual(접힌게있다, 접힌게없다);
    }
    // 🔵 방향마다 다른 말이다 — 같으면 어느 묶음인지 못 읽는다.
    assert.notEqual(delegationGroupEmptyNote("RECEIVED", 3), delegationGroupEmptyNote("GIVEN", 3));
    assert.notEqual(delegationGroupEmptyNote("RECEIVED", 0), delegationGroupEmptyNote("GIVEN", 0));
  });

  check("🔴 끝난 줄의 **문장이 거짓말을 하지 않는다**", () => {
    const 만료 = row({ startsAt: 때(-10), endsAt: 때(-1) });
    const 거둠 = row({ revokedAt: 때(-0.5) });
    for (const side of ["RECEIVED", "GIVEN"] as const) {
      for (const [이름, r] of [["만료", 만료], ["거둠", 거둠]] as const) {
        const 글 = delegationSentence(r, side, 지금);
        // 🔴 접기가 생기기 전에는 이 함수에 끝난 줄이 올 일이 없어 「ACTIVE 가
        //    아니면 시작 전」이었다 — 그대로 뒀다면 만료된 위임이 「아직 시작
        //    전입니다」라고 말한다.
        assert.ok(!글.includes("아직 시작 전"), `${side}/${이름}: 끝난 줄을 시작 전이라 한다: ${글}`);
        assert.ok(!글.includes("함께 뜹니다"), `${side}/${이름}: 지금 뜬다고 말한다: ${글}`);
        assert.ok(!글.includes("대신 누를 수 있습니다"), `${side}/${이름}: 지금 누를 수 있다고 말한다: ${글}`);
        // 이름과 기간은 그대로 들어간다(끝난 줄도 「누구 것이었나」를 알아야 한다).
        assert.ok(글.includes(side === "RECEIVED" ? "맡긴이님" : "대리인님"), `${side}/${이름}: 이름이 없다`);
        assert.ok(글.includes("통합 승인함"), `${side}/${이름}: 어디서 온 위임인지 없다`);
      }
      // 🔴 **왜 끝났는지가 갈려 적힌다** — 접기를 여는 까닭이 대개 그 물음이다.
      assert.ok(delegationSentence(만료, side, 지금).includes("기간이 끝나"));
      assert.ok(delegationSentence(거둠, side, 지금).includes("거둬들여"));
      assert.notEqual(delegationSentence(만료, side, 지금), delegationSentence(거둠, side, 지금));
    }
    // 🔵 표본 검증 — 살아 있는 줄의 문장은 **그대로**다.
    assert.ok(delegationSentence(row(), "RECEIVED", 지금).includes("함께 뜹니다"));
  });

  /* ---------------------------------------------------------------- */
  /* 5. 🔴 화면 — 접기 둘, 서로 따로, 0건이면 없음                       */
  /* ---------------------------------------------------------------- */

  const notice = withoutComments(read(NOTICE));
  const settings = withoutComments(read(SETTINGS));

  check("🔴 **묶음마다 제 접기**를 받는다 — 「모두의」에는 안 준다", () => {
    assert.equal((settings.match(/fold=\{/g) ?? []).length, 2, "접기가 둘이 아니다");
    assert.ok(settings.includes("fold={received}") && settings.includes("fold={given}"));
    // 🔴 「모두의 결재권 위임」 묶음은 끝난 줄을 아예 안 읽는다 — 접기를 꽂으면
    //    빈 접기만 생긴다.
    const 모두 = settings.slice(settings.indexOf('title="모두의 결재권 위임"'));
    assert.ok(모두.length > 50, "🔵 표본이 비었다 — 「모두의」 묶음을 못 찾았다");
    assert.ok(!모두.includes("fold={"), "🔴 「모두의」에 접기가 붙었다");
  });

  check("🔴 접기가 **서로 따로** 기억된다 — `details` 에 `name` 이 없다", () => {
    assert.ok(notice.includes("<details"), "🔵 표본이 비었다 — 접기를 못 찾았다");
    // 🔴 이름이 같은 `details` 는 브라우저가 **서로 닫는다**(하나를 펴면 다른 쪽이
    //    접힌다). 이 집의 접기는 같은 조각이 두 번 그려지므로 이름을 붙이면 둘 다
    //    같은 이름이 된다.
    assert.ok(!/<details[^>]*\sname=/.test(notice), "🔴 details 에 name 이 붙었다");
    // 🔵 상태를 안 쓴다 — 이 파일은 서버 조각이다(아래 울타리와 한 쌍).
    assert.ok(!notice.includes("useState"), "🔴 상태를 쓰면 화면이 클라이언트로 내려간다");
    assert.ok(!notice.trim().startsWith('"use client"'));
  });

  check("🔴 **0건이면 접기를 안 그린다**", () => {
    assert.ok(
      notice.includes("if (fold.finished.length === 0) return null;"),
      "🔴 끝난 줄이 없어도 손잡이가 남는다 — 눌러도 빈 목록만 나온다",
    );
  });

  check("🔴 접힌 안을 **같은 조각**으로 그린다 — 칸도 차례도 그대로", () => {
    // 🔴 접기 안에서 줄을 따로 그리면 「펴 둔 쪽과 똑같이」가 조용히 갈린다 — 사유
    //    줄이나 딱지가 한쪽에만 남는 식이다.
    assert.equal((notice.match(/<DelegationRowItem/g) ?? []).length, 2, "두 자리가 같은 조각을 안 쓴다");
    assert.equal((notice.match(/function DelegationRowItem/g) ?? []).length, 1);
  });

  check("🔴 손잡이 글자와 잘림 안내를 **화면에 박지 않았다**", () => {
    // 🔵 네 집이 같은 말을 하려면 글자를 짓는 자리가 하나여야 한다.
    assert.ok(!notice.includes("끝난 위임 보기"), "🔴 손잡이 글자를 화면에 적었다");
    assert.ok(!notice.includes("최근"), "🔴 잘림 안내를 화면에 적었다");
    assert.ok(notice.includes("delegationFinishedToggleLabel("));
    assert.ok(notice.includes("delegationFinishedTruncatedNotice(fold.finishedLimit)"));
    // 🔴 잘렸을 때만 안내를 그린다 — 늘 뜨면 50건 아래인 사람이 「잘렸나」로 읽는다.
    assert.ok(notice.includes("fold.finishedTruncated &&"));
    // 🔴 자바스크립트 없이 글자가 바뀌어야 하므로 **두 글자를 다 그려 두고** 여닫힘에
    //    따라 하나씩 숨긴다. 한쪽만 있으면 펴도 「보기」라고 적혀 있다.
    assert.ok(notice.includes("group-open:hidden") && notice.includes("group-open:inline"));
    assert.ok(/<details className="group/.test(notice), "group 이 없으면 group-open 이 안 듣는다");
  });

  check("🔴 보여 주는 조각에 **단추도 폼도 없다** — 접기가 생겨도 그대로", () => {
    for (const 금지 of ["<button", "<form", "ActionForm", "revoke", "되돌리기"]) {
      assert.ok(!notice.includes(금지), `🔴 안내 조각에 ${금지} 가 들어갔다`);
    }
  });

  /* ---------------------------------------------------------------- */
  /* 6. 🔴 화면 글 — 더는 「사라집니다」라고 말하지 않는다                */
  /* ---------------------------------------------------------------- */

  check("🔴 「이 목록에서 사라집니다」가 **없어졌다**", () => {
    // 2026-11-17 아침까지 적혀 있던 글이다. 접기가 생긴 날 거짓말이 됐다.
    assert.ok(!settings.includes("이 목록에서 사라집니다"), "🔴 옛 글이 그대로 남아 있다");
    const 탭 = settings.slice(settings.indexOf("function DelegationTab"), settings.indexOf("export default async function"));
    assert.ok(탭.length > 200, "🔵 표본이 비었다 — 탭 본문을 잘못 잘랐다");
    // 🔴 **접혀 있다는 사실을 말해 준다.** 아무 말도 없으면 끝난 위임을 볼 수 있게
    //    된 것을 아무도 모른다(이 집에서는 그 줄이 처음 보이는 것이다).
    assert.ok(탭.includes("끝난 위임 보기"), "🔴 접기가 있다는 말이 없다");
    // 🔵 결재함 안내에서는 **여전히 사라진다** — 그 사실까지 적혀야 두 화면의 말이
    //    어긋나 보이지 않는다.
    assert.ok(탭.includes("결재함 안내에서는 사라지고"));
  });

  /* ---------------------------------------------------------------- */
  /* 7. 🔴 판정·역할 위임·알림은 **한 글자도 안 바뀌었다**                */
  /* ---------------------------------------------------------------- */

  check("🔴 결재 판정 질의에 끝난 줄이 **안 섞였다**", () => {
    const 판정 = bake(delegations.actingForEmployeeIdsQuery(나, 지금));
    assert.match(판정.sql, /"revoked_at" is null/);
    assert.match(판정.sql, /"ends_at" > \$\d+/);
    assert.match(판정.sql, /"starts_at" <= \$\d+/, "🔴 시작 전인 위임으로 결재가 열린다");
    assert.ok(!/"revoked_at" is not null/.test(판정.sql), "🔴 거둔 위임으로 결재가 열린다");
    assert.ok(!/"ends_at" <= \$/.test(판정.sql), "🔴 끝난 위임으로 결재가 열린다");
    assert.ok(!/limit \$/.test(판정.sql), "🔴 판정에 상한이 끼어들었다");
  });

  check("🔴 알리는 쪽(거꾸로 방향)도 그대로다", () => {
    const 알림 = bake(delegations.delegatesForApproversQuery([나], 지금));
    assert.match(알림.sql, /"revoked_at" is null/);
    assert.match(알림.sql, /"starts_at" <= \$\d+/);
    assert.ok(!/"revoked_at" is not null/.test(알림.sql), "🔴 거둔 위임에도 알림이 간다");
    assert.ok(!/"ends_at" <= \$/.test(알림.sql), "🔴 끝난 위임에도 알림이 간다");
  });

  check("🔴 역할 위임 질의는 **여전히 거르개가 한 줄도 없다**", () => {
    // 「지금 유효한가」는 앞 질의가 이미 끝낸 일이다. 여기 기간 조건이 생기면 규칙이
    // 두 벌이 되고, 「결재는 대신 누를 수 있는데 역할은 안 넘어오는」 짝이 생긴다.
    const 역할 = delegations.delegatorRolesQuery([나]).toSQL();
    assert.ok(!/revoked_at|starts_at|ends_at/.test(역할.sql), "🔴 역할 질의에 기간 규칙이 생겼다");
    assert.match(역할.sql, /from "web_users"/);
  });

  check("🔴 접는 조회를 부르는 곳이 **[휴가 설정] 탭 하나**다", () => {
    const 접기조회 = ["loadDelegationFoldActingFor", "loadDelegationFoldGivenBy"];
    const 부르는곳 = allSources().filter(
      (f) => f.path !== QUERIES && 접기조회.some((n) => f.code.includes(n)),
    );
    assert.deepEqual(부르는곳.map((f) => f.path), [SETTINGS]);
    // 판정·알림이 도는 자리는 이 이름을 몰라야 한다.
    for (const 판정파일 of [
      "src/lib/leave/approval-scope.ts",
      "src/lib/leave/data.ts",
      "src/lib/leave/workflow.ts",
      "src/lib/auth/guards.ts",
    ]) {
      const code = withoutComments(read(판정파일));
      for (const n of 접기조회) assert.ok(!code.includes(n), `🔴 ${판정파일} 이 접는 조회를 쓴다`);
    }
  });

  check("🔴 결재함 안내는 **안 끝난 줄만** 그대로 받는다", () => {
    // 🔴 끝난 위임까지 늘 떠 있으면 그 안내를 아무도 안 읽게 되고, 정작 위임이
    //    걸린 날에도 눈에 안 들어온다.
    const approvals = withoutComments(read(APPROVALS));
    assert.ok(approvals.includes("loadDelegationsActingFor(member.employee.id, now)"));
    assert.ok(approvals.includes("loadDelegationsGivenBy(member.employee.id, now)"));
    assert.ok(!approvals.includes("Fold"), "🔴 결재함 안내가 끝난 줄을 받는다");
  });

  check("🔴 읽기 갈래와 받는 통로는 접기를 **모른다**", () => {
    const route = withoutComments(read("src/app/api/integration/delegations/route.ts"));
    for (const n of ["Fold", "finishedDelegations", "DELEGATION_FINISHED_LIMIT"]) {
      assert.ok(!route.includes(n), `🔴 통로가 ${n} 을 건드린다`);
    }
    // 🔵 점검 갈래의 상한은 **다른 수**다(2000) — 섞이면 점검이 조용히 잘린다.
    assert.notEqual(DELEGATION_FINISHED_LIMIT, 2000);
  });

  console.log(`\n${passed}개 통과`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
