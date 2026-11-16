/**
 * 포털이 **써 주는** 결재권 위임 — 받는 통로 검사.  npm run test:delegation-sync
 *
 * 🔴 DB 에 닿지 않고 사내망에도 나가지 않는다. 포털의 서명 열쇠 노릇은 이 검사가
 * 127.0.0.1 에 직접 띄운 가짜 JWKS 서버가 한다(test-approval-delegation.ts 와
 * 같은 방식).
 *
 * 🔵 **이 파일은 통로를 실제로 불러 본다.** 이웃 검사(test-portal-approvals.ts)는
 * 「라우트는 요청 맥락·DB 가 필요해 직접 불러 볼 수 없다」며 소스 글자로만 쟀는데,
 * 이 통로는 **토큰 검증과 모양 검사가 DB 앞에 있어** 그 두 단계를 요청으로
 * 돌려 볼 수 있다. 그래서 「자격증명 없이 부르면 거절」·「모양이 틀리면 400」은
 * 글자가 아니라 **실제 응답**으로 잰다. DB 가 필요한 뒷단(적기·해당 없음)만
 * 판단 함수에 가짜 DB 를 끼워 잰다.
 *
 * ── 위임이 흐르는 길 (2026-11-16 뒤집힌 뒤) ─────────────────────────────
 *   통합 승인함에서 사람이 「누구의 결재권을 누구에게」를 지정한다 (포털에 저장)
 *     → 🔴 포털이 **세 시스템에 써 준다**  POST /api/integration/delegations
 *     → 이 통로가 포털 번호를 **두 단**으로 바꿔
 *        (auth_sub → web_users.employee_id → web_employees.id)
 *     → web_portal_approval_delegations 에 적는다
 *     → 결재 판정이 **망이 아니라 그 표**를 읽는다 (2026-11-16 에 이어졌다 —
 *        읽는 쪽 검사는 scripts/test-approval-delegation.ts 에 있다)
 *
 * ── 무엇을 지키는가 ─────────────────────────────────────────────────────
 *   1. 🔴 같은 `id` 로 두 번 와도 **한 줄**이다(멱등). 번호는 포털이 정한다.
 *   2. 🔴 **명단 미연결이면 `not_applicable` 이고 200 이다** — 오류가 아니다.
 *      운영에 그런 계정이 한 명 있고, 오류로 답하면 **그 사람에게는 다른
 *      시스템에서도 위임을 못 맡기게 된다**(포털이 지정 자체를 거절한다).
 *   3. 🔴 모양이 틀리면 400 이고 **왜 틀렸는지를 글로** 돌려준다.
 *   4. 🔴 자격증명 없이·엉뚱한 쓰임새로는 못 연다.
 *   5. 🔴 저장이 실패하면 **성공한 척하지 않는다**(설계 B-13).
 *   6. 🔴 적는 열쇠가 **명단 번호**다 — 포털 번호를 그대로 적으면 오류 없이
 *      영원히 아무도 못 누른다.
 *
 * 🔴 왜 전부 main() 안에 있나: 이 저장소의 검사는 tsx 가 CJS 로 돌려
 * (package.json 에 type:module 이 없다) 최상위 await 을 쓸 수 없다.
 * 🔴 **DB 를 건드리는 모듈은 `await import` 로 불러온다** — `src/lib/db` 는
 * 모듈을 읽는 순간 DATABASE_URL 을 읽는데, 정적 import 는 아래 환경 설정보다
 * **먼저** 돌기 때문이다(esbuild 가 import 를 위로 끌어올린다).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// 🔴 .env.local 을 읽지 않는다 — 이 검사는 여기 적힌 값으로만 돈다
//    (test-approval-delegation.ts 와 같은 이유). SSO_ISSUER 는 아래에서 가짜
//    JWKS 서버로 덮어쓴다. DATABASE_URL 은 **아무 데도 붙지 않는 주소**다.
process.env.SSO_ISSUER = "http://127.0.0.1:1";
process.env.SSO_CLIENT_ID = "dss-leave";
process.env.SSO_CLIENT_SECRET = "테스트용-시크릿";
process.env.SSO_REDIRECT_URI = "http://192.168.1.10:3700/api/auth/sso/callback";
process.env.SSO_TX_SECRET = "0123456789abcdef0123456789abcdef";
process.env.DATABASE_URL = "postgres://nobody:nobody@127.0.0.1:1/none";

import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";

import { PORTAL_TOKEN_PURPOSES } from "../src/lib/auth/portal-service-token";
// 🔵 `DelegatedApproverRow` 는 2026-11-16 저녁까지 leave/approval-delegation.ts
//    에 있었다. 그 파일은 **포털에 묻던 쪽**이라 묻는 길을 걷어낼 때 통째로
//    없어졌고(설계 B-12), 이 모양을 쓰는 것은 이제 받는 쪽뿐이라 여기로 옮겨
//    왔다 — 가리키는 값도 쓰는 자리도 그대로다.
import {
  applyDelegationCommand,
  parseDelegationCommand,
  readInstant,
  type DelegatedApproverRow,
  type DelegationCommand,
  type DelegationSyncResult,
  type StoredPortalDelegation,
} from "../src/lib/leave/portal-delegation-sync";

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
/* 가짜 값 — 🔴 실제 이름·사번을 한 자도 넣지 않는다                     */
/* ------------------------------------------------------------------ */

/** 포털에 등록된 사람의 번호(포털 users.id)와 같은 모양. */
const SUB_맡긴이 = "11111111-2222-4333-8444-555555555555";
const SUB_대리인 = "66666666-7777-4888-8999-aaaaaaaaaaaa";
/** 포털에는 있지만 이 시스템에는 계정이 없는 사람. */
const SUB_남 = "99999999-1111-4222-8333-444444444444";

/** 이 시스템의 직원 명단 번호(web_employees.id). */
const EMP_맡긴이 = "aaaa1111-1111-4111-8111-111111111111";
const EMP_대리인 = "bbbb2222-2222-4222-8222-222222222222";

/** 포털이 정해 보내는 위임 번호. 🔴 이쪽이 만들지 않는다. */
const DELEGATION_ID = "cccc3333-3333-4333-8333-333333333333";

const CLIENT_ID = "dss-leave";

/** 규약대로 생긴 upsert 본문. 검사마다 한 칸씩 망가뜨려 본다. */
function upsertBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "upsert",
    id: DELEGATION_ID,
    delegatorSub: SUB_맡긴이,
    delegateSub: SUB_대리인,
    startsAt: "2027-03-01T00:00:00.000Z",
    endsAt: "2027-03-08T00:00:00.000Z",
    reason: "출장",
    ...over,
  };
}

function revokeBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "revoke",
    id: DELEGATION_ID,
    revokedAt: "2027-03-04T00:00:00.000Z",
    ...over,
  };
}

/** 모양 검사를 통과한 명령만 꺼낸다 — 통과 못 하면 거기서 멈춘다. */
function commandOf(body: Record<string, unknown>): DelegationCommand {
  const parsed = parseDelegationCommand(body);
  assert.ok(parsed.ok, `모양 검사를 통과하지 못했다: ${parsed.ok ? "" : parsed.error}`);
  return parsed.command;
}

/** 모양 검사가 **거절한** 까닭을 꺼낸다. */
function rejectionOf(body: unknown): string {
  const parsed = parseDelegationCommand(body);
  assert.ok(!parsed.ok, "거절했어야 하는 본문을 통과시켰다");
  return parsed.error;
}

/* ------------------------------------------------------------------ */
/* 가짜 DB — 판단 함수에 끼운다                                          */
/* ------------------------------------------------------------------ */

type FakeDb = {
  /** 「이 시스템에 이런 계정·명단이 있다」 */
  rows?: readonly DelegatedApproverRow[];
  /** 철회할 줄이 있었는가 */
  revokeFound?: boolean;
  lookupThrows?: boolean;
  upsertThrows?: boolean;
  revokeThrows?: boolean;
  /** 적은 줄이 쌓이는 자리. 🔵 번호로 덮어쓴다 — 표의 on conflict 와 같은 말. */
  store?: Map<string, StoredPortalDelegation>;
};

function fakeDeps(db: FakeDb) {
  const lookedUp: string[][] = [];
  const revoked: Array<{ id: string; revokedAt: Date }> = [];
  const store = db.store ?? new Map<string, StoredPortalDelegation>();
  return {
    lookedUp,
    revoked,
    store,
    deps: {
      lookup: async (subs: readonly string[]) => {
        lookedUp.push([...subs]);
        if (db.lookupThrows) throw new Error("db down");
        return (db.rows ?? []).filter((row) => subs.includes(row.authSub));
      },
      upsert: async (row: StoredPortalDelegation) => {
        if (db.upsertThrows) throw new Error("db down");
        store.set(row.id, row);
      },
      revoke: async (id: string, revokedAt: Date) => {
        if (db.revokeThrows) throw new Error("db down");
        revoked.push({ id, revokedAt });
        return db.revokeFound ?? false;
      },
    },
  };
}

/** 둘 다 명단까지 이어진, 가장 평범한 상태. */
const 둘다정상: readonly DelegatedApproverRow[] = [
  { authSub: SUB_맡긴이, employeeId: EMP_맡긴이 },
  { authSub: SUB_대리인, employeeId: EMP_대리인 },
];

async function apply(
  body: Record<string, unknown>,
  db: FakeDb,
): Promise<{ result: DelegationSyncResult; lookedUp: string[][]; store: Map<string, StoredPortalDelegation>; revoked: Array<{ id: string; revokedAt: Date }> }> {
  const fake = fakeDeps(db);
  const result = await applyDelegationCommand(commandOf(body), fake.deps);
  return { result, lookedUp: fake.lookedUp, store: fake.store, revoked: fake.revoked };
}

async function main() {
  console.log("\n포털이 써 주는 결재권 위임 (받는 통로)\n");

  /* ---------------------------------------------------------------- */
  /* 1. 모양 검사 — 규약과 다른 본문은 400                              */
  /* ---------------------------------------------------------------- */

  check("규약대로 생긴 본문은 통과한다 — 🔵 먼저 이것부터(공짜 통과 방지)", () => {
    const command = commandOf(upsertBody());
    assert.equal(command.action, "upsert");
    assert.equal(command.id, DELEGATION_ID);
    assert.ok(command.action === "upsert");
    assert.equal(command.delegatorSub, SUB_맡긴이);
    assert.equal(command.delegateSub, SUB_대리인);
    // 🔴 글자가 아니라 **시각**으로 풀린다 — 기간 비교가 글자 비교가 되면
    //    시간대가 다른 두 표기에서 조용히 틀린다.
    assert.equal(command.startsAt.toISOString(), "2027-03-01T00:00:00.000Z");
    assert.equal(command.endsAt.toISOString(), "2027-03-08T00:00:00.000Z");
    assert.equal(command.reason, "출장");
  });

  check("action 이 없거나 모르는 값이면 거절한다", () => {
    assert.match(rejectionOf(upsertBody({ action: undefined })), /action/);
    assert.match(rejectionOf(upsertBody({ action: "delete" })), /action/);
    assert.match(rejectionOf(upsertBody({ action: 1 })), /action/);
  });

  check("🔴 id 가 uuid 가 아니면 거절한다 — 드라이버가 던지기 전에 막는다", () => {
    assert.match(rejectionOf(upsertBody({ id: "not-a-uuid" })), /id/);
    assert.match(rejectionOf(upsertBody({ id: undefined })), /id/);
    assert.match(rejectionOf(upsertBody({ id: "" })), /id/);
  });

  check("포털 번호가 uuid 가 아니면 거절한다 (맡긴이 · 대리인 둘 다)", () => {
    assert.match(rejectionOf(upsertBody({ delegatorSub: "nope" })), /delegatorSub/);
    assert.match(rejectionOf(upsertBody({ delegateSub: undefined })), /delegateSub/);
  });

  check("🔴 기간이 거꾸로이거나 길이가 0 이면 거절한다", () => {
    const 거꾸로 = upsertBody({ startsAt: "2027-03-08T00:00:00.000Z", endsAt: "2027-03-01T00:00:00.000Z" });
    assert.match(rejectionOf(거꾸로), /endsAt/);
    const 같음 = upsertBody({ endsAt: "2027-03-01T00:00:00.000Z" });
    assert.match(rejectionOf(같음), /endsAt/);
  });

  check("🔴 시간대가 없는 시각은 거절한다 — 같은 글자가 아홉 시간 다른 뜻이 된다", () => {
    // 개발 PC(KST)와 NAS 컨테이너(UTC)가 같은 글자를 다르게 푼다. 오류 없이
    // 위임 기간만 아홉 시간 어긋난다.
    assert.equal(readInstant("2027-03-01T00:00:00"), null);
    assert.match(rejectionOf(upsertBody({ startsAt: "2027-03-01T00:00:00" })), /ISO 8601/);
    // 붙어 있으면 어느 모양이든 받는다.
    assert.ok(readInstant("2027-03-01T09:00:00+09:00") instanceof Date);
    assert.equal(
      readInstant("2027-03-01T09:00:00+09:00")?.toISOString(),
      "2027-03-01T00:00:00.000Z",
    );
  });

  check("🔴 날짜만 적어 보낸 값이 1월 1일 0시로 둔갑하지 않는다", () => {
    // new Date("2027") 은 유효한 날짜다 — 그래서 Date 로 풀어 보는 것만으로는
    // 못 막는다.
    assert.ok(Number.isFinite(new Date("2027").getTime()), "전제가 깨졌다");
    assert.equal(readInstant("2027"), null);
    assert.equal(readInstant("2027-03-01"), null);
    assert.equal(readInstant("어제"), null);
    assert.equal(readInstant(1788000000000), null);
  });

  check("🔴 달력에 없는 날은 다음 달로 넘어가기 전에 막는다", () => {
    // 🔵 함정이 **실제로 있다**는 것부터 — 표본이 비어 공짜로 통과하지 않게.
    assert.equal(new Date("2026-02-30T00:00:00Z").toISOString(), "2026-03-02T00:00:00.000Z");
    assert.equal(new Date("2026-02-29T00:00:00Z").toISOString(), "2026-03-01T00:00:00.000Z");
    // 🔴 오류가 한 번도 안 난다 — 위임 기간만 조용히 이틀 어긋난다.
    assert.equal(readInstant("2026-02-30T00:00:00Z"), null);
    assert.equal(readInstant("2026-02-29T00:00:00Z"), null, "평년 2월 29일을 받았다");
    assert.equal(readInstant("2027-04-31T00:00:00Z"), null);
    // 🔵 윤년은 받는다.
    assert.equal(
      readInstant("2024-02-29T00:00:00Z")?.toISOString(),
      "2024-02-29T00:00:00.000Z",
    );
    // 범위를 아예 넘는 값은 new Date 도 막지만, 여기서도 막힌다.
    assert.equal(readInstant("2026-13-01T00:00:00Z"), null);
    assert.equal(readInstant("2026-03-32T00:00:00Z"), null);
  });

  check("까닭은 없어도 된다 — 빈 글자가 된다", () => {
    for (const 빈값 of [undefined, null, ""]) {
      const command = commandOf(upsertBody({ reason: 빈값 }));
      assert.ok(command.action === "upsert");
      assert.equal(command.reason, "");
    }
    assert.match(rejectionOf(upsertBody({ reason: 7 })), /reason/);
  });

  check("🔴 자기에게 맡기는 줄은 거절한다 — 표의 CHECK 와 같은 말이다", () => {
    assert.match(rejectionOf(upsertBody({ delegateSub: SUB_맡긴이 })), /자기 자신/);
  });

  check("🔵 upsert 에 철회 시각이 없거나 null 이면 **살아 있는 줄**이다", () => {
    // 포털이 객체를 통째로 보내면 빈 자리가 null 로 실려 온다. 그것을 거절하면
    // 멀쩡한 지정이 세 시스템에서 전부 막힌다(설계 B-13).
    for (const 빈값 of [undefined, null, ""]) {
      const command = commandOf(upsertBody({ revokedAt: 빈값 }));
      assert.ok(command.action === "upsert");
      assert.equal(command.revokedAt, null);
    }
  });

  check("🔴 upsert 에 철회 시각이 **실려 오면 그대로** 받는다 — 버리지 않는다", () => {
    // 버리면 「포털은 거뒀는데 여기서는 살아 있는」 줄이 남고 그 어긋남은 아무
    // 표시도 내지 않는다. 그대로 적으면 그 순간 양쪽이 같은 상태가 된다.
    const command = commandOf(upsertBody({ revokedAt: "2027-03-04T00:00:00.000Z" }));
    assert.ok(command.action === "upsert");
    assert.equal(command.revokedAt?.toISOString(), "2027-03-04T00:00:00.000Z");
    // 🔵 그대로 적을 수 없는 모양은 여전히 거절한다.
    assert.match(rejectionOf(upsertBody({ revokedAt: "2027-03-04" })), /revokedAt/);
    assert.match(rejectionOf(upsertBody({ revokedAt: 7 })), /revokedAt/);
  });

  check("revoke 는 id 와 철회 시각만 쓴다 — 나머지 칸은 보지 않는다", () => {
    const command = commandOf(revokeBody({ delegatorSub: "쓰레기", startsAt: "어제" }));
    assert.ok(command.action === "revoke");
    assert.equal(command.id, DELEGATION_ID);
    assert.equal(command.revokedAt.toISOString(), "2027-03-04T00:00:00.000Z");
  });

  check("🔴 revoke 에 철회 시각이 없으면 거절한다 — 지금 시각으로 메우지 않는다", () => {
    assert.match(rejectionOf(revokeBody({ revokedAt: undefined })), /revokedAt/);
    assert.match(rejectionOf(revokeBody({ revokedAt: "2027-03-04" })), /revokedAt/);
  });

  check("본문이 객체가 아니면 거절한다", () => {
    for (const 아닌것 of [null, 7, "문자열", [upsertBody()]]) {
      assert.match(rejectionOf(아닌것), /JSON 객체/);
    }
  });

  /* ---------------------------------------------------------------- */
  /* 2. 두 단 변환 — 🔴 이 집에서 가장 어려운 자리                       */
  /* ---------------------------------------------------------------- */

  await checkAsync("🔴 적는 열쇠가 **명단 번호**다 — 포털 번호를 그대로 적지 않는다", async () => {
    const { result, store, lookedUp } = await apply(upsertBody(), { rows: 둘다정상 });
    assert.deepEqual(result, { outcome: "stored" });
    const 적힌줄 = store.get(DELEGATION_ID);
    assert.ok(적힌줄, "줄이 안 적혔다");
    assert.equal(적힌줄.delegatorEmployeeId, EMP_맡긴이);
    assert.equal(적힌줄.delegateEmployeeId, EMP_대리인);
    // 🔴 포털 번호가 섞여 들어가면 오류 없이 영원히 아무도 못 누른다.
    assert.ok(!JSON.stringify(적힌줄).includes(SUB_맡긴이));
    assert.ok(!JSON.stringify(적힌줄).includes(SUB_대리인));
    // 평범한 지정은 **살아 있는 줄**로 적힌다.
    assert.equal(적힌줄.revokedAt, null);
    // 두 번호를 **한 번에** 묻는다 — 두 번 물으면 그 사이에 명단이 바뀔 수 있다.
    assert.deepEqual(lookedUp, [[SUB_맡긴이, SUB_대리인]]);
  });

  await checkAsync("🔴 거둔 줄로 온 지정은 **거둔 채로** 적힌다 — 삼키지 않는다", async () => {
    // 포털이 줄을 통째로 보내면 거둔 줄도 그 모양 그대로 온다. 200 만 보고
    // 넘어가면 **삼켜도 통과한다** — 적힌 값까지 센다.
    const { result, store } = await apply(
      upsertBody({ revokedAt: "2027-03-04T00:00:00.000Z" }),
      { rows: 둘다정상 },
    );
    assert.deepEqual(result, { outcome: "stored" });
    assert.equal(
      store.get(DELEGATION_ID)?.revokedAt?.toISOString(),
      "2027-03-04T00:00:00.000Z",
      "🔴 철회 시각을 버렸다 — 포털은 거뒀는데 여기서는 살아 있는 줄이 된다",
    );
  });

  await checkAsync("🔴 명단 미연결이면 `not_applicable` 이다 — 오류가 아니다", async () => {
    // 운영 실측(2026-11-16): 로그인 계정 8명 중 1명이 이 상태다. 오류로 답하면
    // 포털이 지정 자체를 거절해 **다른 시스템에서도** 못 맡기게 된다.
    const 맡긴이가미연결 = await apply(upsertBody(), {
      rows: [
        { authSub: SUB_맡긴이, employeeId: null },
        { authSub: SUB_대리인, employeeId: EMP_대리인 },
      ],
    });
    assert.deepEqual(맡긴이가미연결.result, {
      outcome: "not_applicable",
      reason: "delegator_unlinked",
    });
    assert.equal(맡긴이가미연결.store.size, 0, "🔴 줄을 적었다");

    const 대리인이미연결 = await apply(upsertBody(), {
      rows: [
        { authSub: SUB_맡긴이, employeeId: EMP_맡긴이 },
        { authSub: SUB_대리인, employeeId: null },
      ],
    });
    assert.deepEqual(대리인이미연결.result, {
      outcome: "not_applicable",
      reason: "delegate_unlinked",
    });
    assert.equal(대리인이미연결.store.size, 0);
  });

  await checkAsync("계정이 아예 없어도 `not_applicable` 이다 — 까닭만 다르다", async () => {
    const 맡긴이없음 = await apply(upsertBody({ delegatorSub: SUB_남 }), { rows: 둘다정상 });
    assert.deepEqual(맡긴이없음.result, { outcome: "not_applicable", reason: "delegator_absent" });
    const 대리인없음 = await apply(upsertBody({ delegateSub: SUB_남 }), { rows: 둘다정상 });
    assert.deepEqual(대리인없음.result, { outcome: "not_applicable", reason: "delegate_absent" });
    assert.equal(맡긴이없음.store.size + 대리인없음.store.size, 0);
  });

  await checkAsync("🔴 둘이 같은 직원으로 이어져 있으면 적지 않는다", async () => {
    // 계정 하나에 직원 하나를 유일 색인이 지키므로 정상에서는 안 생긴다.
    // 그대로 적으면 표의 CHECK 가 던져 500 이 되므로, 까닭을 말해 주는 400 이다.
    const { result, store } = await apply(upsertBody(), {
      rows: [
        { authSub: SUB_맡긴이, employeeId: EMP_맡긴이 },
        { authSub: SUB_대리인, employeeId: EMP_맡긴이 },
      ],
    });
    assert.equal(result.outcome, "invalid");
    assert.equal(store.size, 0);
  });

  await checkAsync("🔴 저장이 실패하면 던진다 — 성공한 척하지 않는다(설계 B-13)", async () => {
    // 삼키면 포털만 「맡겼다」고 알고 이 시스템은 모르는 상태가 된다.
    await assert.rejects(() => apply(upsertBody(), { rows: 둘다정상, upsertThrows: true }));
    await assert.rejects(() => apply(upsertBody(), { lookupThrows: true }));
    await assert.rejects(() => apply(revokeBody(), { revokeThrows: true }));
  });

  /* ---------------------------------------------------------------- */
  /* 3. 철회                                                            */
  /* ---------------------------------------------------------------- */

  await checkAsync("철회는 그 줄의 철회 시각을 세운다 — 포털이 보낸 값 그대로", async () => {
    const { result, revoked, lookedUp } = await apply(revokeBody(), { revokeFound: true });
    assert.deepEqual(result, { outcome: "stored" });
    assert.equal(revoked.length, 1);
    assert.equal(revoked[0].id, DELEGATION_ID);
    assert.equal(revoked[0].revokedAt.toISOString(), "2027-03-04T00:00:00.000Z");
    // 🔵 철회에는 두 단 변환이 필요 없다 — 번호 하나로 찾는다.
    assert.deepEqual(lookedUp, []);
  });

  await checkAsync("🔵 없는 줄을 거두라고 해도 오류가 아니다", async () => {
    // 애초에 두 단 변환이 안 돼 「해당 없음」으로 안 적은 줄이거나, 포털이
    // 재시도한 것이다. 둘 다 「지금 여기 그 위임이 살아 있지 않다」로 같다.
    const { result } = await apply(revokeBody(), { revokeFound: false });
    assert.deepEqual(result, { outcome: "not_applicable", reason: "unknown_delegation" });
  });

  /* ---------------------------------------------------------------- */
  /* 4. 🔴 멱등 — 같은 번호로 두 번 와도 한 줄                           */
  /* ---------------------------------------------------------------- */

  await checkAsync("🔴 같은 id 로 두 번 보내면 한 줄이다 — 번호를 새로 만들지 않는다", async () => {
    const store = new Map<string, StoredPortalDelegation>();
    await apply(upsertBody(), { rows: 둘다정상, store });
    await apply(upsertBody(), { rows: 둘다정상, store });
    assert.equal(store.size, 1, `두 번 보냈더니 ${store.size}줄이 됐다`);
    assert.ok(store.has(DELEGATION_ID), "포털이 정한 번호로 안 적혔다");
  });

  await checkAsync("고쳐 보내면 덮어쓴다 — 기간도 까닭도 포털 값이 이긴다", async () => {
    const store = new Map<string, StoredPortalDelegation>();
    await apply(upsertBody(), { rows: 둘다정상, store });
    await apply(
      upsertBody({ endsAt: "2027-03-20T00:00:00.000Z", reason: "연장" }),
      { rows: 둘다정상, store },
    );
    assert.equal(store.size, 1);
    const 적힌줄 = store.get(DELEGATION_ID);
    assert.equal(적힌줄?.endsAt.toISOString(), "2027-03-20T00:00:00.000Z");
    assert.equal(적힌줄?.reason, "연장");
  });

  /* ---------------------------------------------------------------- */
  /* 5. 🔴 멱등을 **무엇이** 보장하는가 — 구워진 SQL 로 본다             */
  /* ---------------------------------------------------------------- */

  const store = await import("../src/lib/auth/portal-delegation-store");

  /** 적는 문장을 구워 본다. `revokedAt` 만 바꿔 두 갈래를 본다. */
  function upsertSql(revokedAt: Date | null) {
    return store
      .portalDelegationUpsertQuery({
        id: DELEGATION_ID,
        delegatorEmployeeId: EMP_맡긴이,
        delegateEmployeeId: EMP_대리인,
        startsAt: new Date("2027-03-01T00:00:00.000Z"),
        endsAt: new Date("2027-03-08T00:00:00.000Z"),
        reason: "출장",
        revokedAt,
      })
      .toSQL();
  }

  /** 덮어쓰는 부분에서 그 칸에 실린 값을 꺼낸다. */
  function overwritten(sql: string, params: readonly unknown[], column: string): unknown {
    const 덮어쓰는부분 = sql.slice(sql.indexOf("do update"));
    const 자리 = new RegExp(`"${column}" = \\$(\\d+)`).exec(덮어쓰는부분);
    assert.ok(자리, `덮어쓸 때 ${column} 을 건드리지 않는다`);
    return params[Number(자리[1]) - 1];
  }

  /** 🔴 거꾸로 — 덮어쓰는 부분에 그 칸이 **아예 없어야** 할 때. */
  function notOverwritten(sql: string, column: string): void {
    const 덮어쓰는부분 = sql.slice(sql.indexOf("do update"));
    assert.ok(
      !new RegExp(`"${column}"`).test(덮어쓰는부분),
      `덮어쓸 때 ${column} 을 건드린다: ${덮어쓰는부분}`,
    );
  }

  /** 넣는 부분(`insert … values …`)에서 그 칸에 실린 값을 꺼낸다. */
  function insertedValue(sql: string, params: readonly unknown[], column: string): unknown {
    const 짝 = /insert into "[^"]+" \(([^)]*)\) values \(([^)]*)\)/.exec(sql);
    assert.ok(짝, `넣는 문장의 모양이 바뀌었다: ${sql}`);
    const 칸들 = 짝[1].split(", ").map((c) => c.replaceAll('"', ""));
    const 값들 = 짝[2].split(", ");
    const i = 칸들.indexOf(column);
    assert.ok(i >= 0, `넣을 때 ${column} 을 안 싣는다 — 칸: ${짝[1]}`);
    const 자리 = /^\$(\d+)$/.exec(값들[i]);
    assert.ok(자리, `${column} 자리에 상수가 구워졌다: ${값들[i]}`);
    return params[Number(자리[1]) - 1];
  }

  check("🔴 적는 문장이 `on conflict (id) do update` 다", () => {
    const { sql, params } = upsertSql(null);
    assert.match(sql, /insert into "web_portal_approval_delegations"/);
    // 🔴 이 한 조각이 멱등의 전부다. 「먼저 조회해 보고 갈라 쓰기」로 바꾸면 두
    //    요청이 겹칠 때 둘 다 「없다」를 보고 둘 다 넣는다.
    assert.match(sql, /on conflict \("id"\) do update/);
    // 🔴 번호를 우리가 만들지 않는다 — 첫 칸이 default 가 아니라 받은 값이다.
    assert.match(sql, /\("id", /);
    assert.ok(!/values \(default/.test(sql), "🔴 번호를 우리가 굽고 있다");
    assert.equal(params[0], DELEGATION_ID);
  });

  check("🔴 덮어쓸 때 값이 실려 온 철회 표시는 **그대로** 간다", () => {
    // 버리면 「포털은 거뒀는데 여기서는 살아 있는」 줄이 남는다(설계 B-13 이 더
    // 위험하다고 못 박은 쪽). 🔵 「한 방향」은 **널이 안 지운다**는 뜻이지
    // 「영영 못 고친다」는 뜻이 아니다.
    const 거둠 = upsertSql(new Date("2027-03-04T00:00:00.000Z"));
    assert.equal(
      overwritten(거둠.sql, 거둠.params, "revoked_at"),
      "2027-03-04T00:00:00.000Z",
    );
    // 🔵 넣는 자리에도 같은 값이 간다(처음 받는 줄이 거둔 줄일 수 있다).
    assert.equal(
      insertedValue(거둠.sql, 거둠.params, "revoked_at"),
      "2027-03-04T00:00:00.000Z",
    );
  });

  check("🔴 덮어쓸 때 **널은 이미 적힌 철회를 지우지 않는다** — 거둔 위임이 되살아나는 길", () => {
    const 살아있음 = upsertSql(null);
    // 🔴 통로 규약에 차례를 가릴 값이 없다. 지정과 철회가 엇갈려 닿으면 나중에
    //    닿은 것이 이기는데, 여기서 널까지 덮으면 늦게 닿은 이 문장이 거둔 위임을
    //    되살리고 그 사람은 **아무 오류 없이** 남의 결재를 누를 수 있게 된다.
    notOverwritten(살아있음.sql, "revoked_at");
    // 🔵 **그 옆에서 다른 칸은 덮는지 함께 잰다** — 안 그러면 「충돌했을 때 아무것도
    //    안 덮는」 구현도 위 단언을 공짜로 통과한다.
    assert.equal(overwritten(살아있음.sql, 살아있음.params, "reason"), "출장");
    assert.equal(
      overwritten(살아있음.sql, 살아있음.params, "delegate_employee_id"),
      EMP_대리인,
    );
    assert.equal(
      overwritten(살아있음.sql, 살아있음.params, "ends_at"),
      "2027-03-08T00:00:00.000Z",
    );
    // 🔴 **넣는 자리는 그대로다** — 처음 받는 줄은 살아 있어야 하므로 널을 싣는다.
    //    여기까지 빼면 그 칸이 DB 기본값에 맡겨진다.
    assert.equal(insertedValue(살아있음.sql, 살아있음.params, "revoked_at"), null);
  });

  check("철회 문장은 번호로 찾아 고치고, 고친 줄이 있었는지 돌려준다", () => {
    const { sql, params } = store
      .portalDelegationRevokeQuery(DELEGATION_ID, new Date("2027-03-04T00:00:00.000Z"))
      .toSQL();
    assert.match(sql, /^update "web_portal_approval_delegations" set/);
    assert.match(sql, /"revoked_at" = \$\d+/);
    assert.match(sql, /where "web_portal_approval_delegations"\."id" = \$\d+/);
    // 🔵 「그런 줄이 있었나」를 세는 길이다 — 없으면 not_applicable 이다.
    assert.match(sql, /returning "id"/);
    assert.ok(params.includes(DELEGATION_ID));
    // 🔴 줄을 지우지 않는다(설계 C-5 의 「끝난 위임 기간으로 결재 보기」).
    assert.ok(!/delete from/.test(sql));
  });

  /* ---------------------------------------------------------------- */
  /* 6. 통로 — 🔵 **실제로 불러 본다**                                   */
  /* ---------------------------------------------------------------- */

  const 포털열쇠 = await generateKeyPair("RS256", { extractable: true });
  const 남의열쇠 = await generateKeyPair("RS256", { extractable: true });
  const jwk = {
    ...(await exportJWK(포털열쇠.publicKey)),
    kid: "portal-1",
    alg: "RS256",
    use: "sig",
  };
  const jwks = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
  const ISSUER = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
  process.env.SSO_ISSUER = ISSUER;

  async function token(
    over: { purpose?: string; key?: CryptoKey; audience?: string } = {},
  ): Promise<string> {
    return new SignJWT({ purpose: over.purpose ?? PORTAL_TOKEN_PURPOSES.delegationsWrite })
      .setProtectedHeader({ alg: "RS256", kid: "portal-1" })
      .setIssuer(ISSUER)
      .setAudience(over.audience ?? CLIENT_ID)
      .setSubject(SUB_맡긴이)
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(over.key ?? 포털열쇠.privateKey);
  }

  const route = await import("../src/app/api/integration/delegations/route");

  /** 통로를 실제로 부른다. 🔴 자격증명이 없으면 머리말을 아예 안 붙인다. */
  async function post(params: { token?: string; body?: string }) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (params.token) headers.authorization = `Bearer ${params.token}`;
    const request = new Request("http://192.168.1.10:3700/api/integration/delegations", {
      method: "POST",
      headers,
      body: params.body ?? JSON.stringify(upsertBody()),
    });
    // 소리 없이 — 거절 까닭은 서버 로그로 나간다(portal-service-token.ts).
    const 진짜 = console.error;
    console.error = () => {};
    try {
      const response = await route.POST(request as unknown as Parameters<typeof route.POST>[0]);
      return { response, body: (await response.json()) as Record<string, unknown> };
    } finally {
      console.error = 진짜;
    }
  }

  await checkAsync("🔴 자격증명 없이 부르면 401 이다", async () => {
    const { response, body } = await post({});
    assert.equal(response.status, 401);
    assert.equal(body.error, "invalid_token");
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    // 위임 장부가 캐시되면 거둔 위임이 살아 있는 것처럼 남는다.
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  await checkAsync("🔴 알림 읽기용 토큰으로는 안 열린다 — 쓰임새가 다르다", async () => {
    const { response } = await post({
      token: await token({ purpose: PORTAL_TOKEN_PURPOSES.notificationsRead }),
    });
    assert.equal(response.status, 401);
  });

  await checkAsync("남의 열쇠로 서명한 토큰·남에게 발급된 토큰도 거절한다", async () => {
    const 남의서명 = await post({ token: await token({ key: 남의열쇠.privateKey }) });
    assert.equal(남의서명.response.status, 401);
    const 남의수신자 = await post({ token: await token({ audience: "dss-po" }) });
    assert.equal(남의수신자.response.status, 401);
  });

  await checkAsync("🔵 올바른 토큰은 검증을 지나간다 — 400 이 그 증거다", async () => {
    // 🔵 표본이 비어 공짜로 통과하지 않게: 위 셋이 401 인 것이 뜻을 가지려면
    //    **같은 통로가 올바른 토큰에는 다른 답**을 해야 한다.
    const { response, body } = await post({ token: await token(), body: "{" });
    assert.equal(response.status, 400);
    assert.equal(body.error, "invalid_request");
    assert.match(String(body.error_description), /JSON/);
  });

  await checkAsync("🔴 모양이 틀리면 400 이고 **왜 틀렸는지**가 함께 간다", async () => {
    // 포털이 이 글을 지정 화면에 그대로 띄운다. 「올바르지 않습니다」만 보내면
    // 사람이 까닭을 모른 채 같은 단추를 다시 누른다.
    const 거꾸로 = JSON.stringify(
      upsertBody({ startsAt: "2027-03-08T00:00:00.000Z", endsAt: "2027-03-01T00:00:00.000Z" }),
    );
    const { response, body } = await post({ token: await token(), body: 거꾸로 });
    assert.equal(response.status, 400);
    assert.match(String(body.error_description), /endsAt/);
    // 🔴 사람을 가리키는 값이 답에 섞여 나가지 않는다.
    assert.ok(!JSON.stringify(body).includes(SUB_맡긴이));
  });

  await checkAsync("읽기로는 못 연다 — 이 통로에는 POST 하나뿐이다", async () => {
    const 통로 = route as Record<string, unknown>;
    for (const 메서드 of ["GET", "PUT", "PATCH", "DELETE"]) {
      assert.equal(통로[메서드], undefined, `${메서드} 가 열려 있다`);
    }
    assert.equal(typeof 통로.POST, "function");
  });

  jwks.closeAllConnections();
  await new Promise<void>((resolve) => jwks.close(() => resolve()));

  /* ---------------------------------------------------------------- */
  /* 7. 통로 배선 — 요청으로 못 재는 것만 소스 글자로                    */
  /* ---------------------------------------------------------------- */

  const routeSource = withoutComments(read("src/app/api/integration/delegations/route.ts"));

  check("🔴 토큰 검증이 먼저다 — 본문도 DB 도 그 뒤다", () => {
    const verifyAt = routeSource.indexOf("await verifyPortalServiceToken(");
    const rejectAt = routeSource.indexOf("if (!verified.ok) return invalidToken();");
    const bodyAt = routeSource.indexOf("await request.json()");
    const workAt = routeSource.indexOf("applyDelegationCommand(");
    assert.ok(verifyAt > 0, "검증하는 자리를 찾지 못했다");
    assert.ok(rejectAt > verifyAt, "검증 결과를 확인하지 않는다");
    assert.ok(bodyAt > rejectAt, "거절하기 전에 본문을 읽는다");
    assert.ok(workAt > bodyAt, "모양 검사 전에 DB 를 건드린다");
  });

  check("🔴 「해당 없음」은 200 이다 — 오류 자리가 아니다", () => {
    const at = routeSource.indexOf('result.outcome === "not_applicable"');
    assert.ok(at > 0, "해당 없음 갈래를 찾지 못했다");
    const 갈래 = routeSource.slice(at, routeSource.indexOf("return NextResponse.json({ outcome: \"stored\" }"));
    assert.match(갈래, /outcome: "not_applicable"/);
    assert.ok(!/status:/.test(갈래), "🔴 해당 없음에 상태 코드를 붙였다 — 200 이어야 한다");
  });

  check("규약의 답은 두 가지뿐이다", () => {
    const 답 = routeSource.match(/outcome: "(\w+)"/g) ?? [];
    assert.deepEqual(new Set(답), new Set(['outcome: "stored"', 'outcome: "not_applicable"']));
  });

  check("🔴 묻는 쪽과 **같은 조회**로 번호를 바꾼다", () => {
    // 거르는 조건이 두 벌이 되면 「읽을 때는 되는데 쓸 때는 안 되는」 사람이 생긴다.
    assert.match(routeSource, /lookup: findEmployeeIdsBySubjects/);
    assert.match(
      withoutComments(read("src/lib/auth/portal-delegations.ts")),
      /export async function findEmployeeIdsBySubjects/,
    );
  });

  check("🔴 포털 번호를 로그에 쌓지 않는다", () => {
    const 로그 = routeSource.match(/console\.(log|warn|error)\([\s\S]*?\);/g) ?? [];
    assert.ok(로그.length >= 2, "로그 자리를 못 찾았다");
    for (const 한줄 of 로그) {
      assert.ok(!/[Ss]ub\b/.test(한줄), `포털 번호를 남기고 있다: ${한줄}`);
      assert.ok(!/body|parsed\.command/.test(한줄), `본문을 통째로 남기고 있다: ${한줄}`);
    }
  });

  check("🔴 판정 한 쌍은 이 표를 **모른다** — 값과 SQL 이 갈리는 길을 막는다", () => {
    // 🔵 이 검사는 2026-11-16 에 뜻이 바뀌었다. 그날 저녁까지는 「읽는 쪽을 아직
    //    안 건드렸다」(다음 조각의 일이다)는 뜻이었고, 지금은 **옮기고 난 뒤에도
    //    지켜야 하는 금**이다.
    // 🔴 `isMyStep`(값)과 `myStepCondition`(SQL)은 같은 문장이어야 하는데
    //    (그 파일 머리말), 값 쪽은 순수 함수라 하위 질의를 돌릴 수가 없다. SQL
    //    쪽만 표를 직접 보게 되는 순간 둘이 다른 말을 하고, 「결재함에는 보이는데
    //    누르면 거절」이 되돌아온다. 그래서 목록은 **값으로 들고 들어온다.**
    const scope = withoutComments(read("src/lib/leave/approval-scope.ts"));
    assert.ok(scope.includes("approvableEmployeeIds"), "표본이 비었다 — 파일을 잘못 읽었다");
    assert.ok(!scope.includes("webPortalApprovalDelegations"), "판정이 표를 직접 읽는다");
    // 🔵 칸 이름(@/lib/db/schema)은 읽어도 된다 — SQL 조각을 만드는 데 필요하다.
    //    못 쓰는 것은 **접속**(@/lib/db 의 db)이다.
    assert.ok(!/from "@\/lib\/db"/.test(scope), "판정이 DB 접속을 끌어왔다");
  });

  /* ---------------------------------------------------------------- */
  /* 8. 표 — 마이그레이션에 구워진 모양으로 본다                         */
  /* ---------------------------------------------------------------- */

  const migration = read("drizzle/0003_portal_approval_delegations.sql");

  check("🔴 번호의 주인이 포털이다 — 기본값이 없는 기본키", () => {
    assert.match(migration, /"id" uuid PRIMARY KEY NOT NULL/);
    assert.ok(
      !/"id" uuid PRIMARY KEY DEFAULT/.test(migration),
      "🔴 번호를 이 집이 굽는다 — 포털이 그 줄을 가리킬 수 없게 된다",
    );
  });

  check("열쇠가 **직원 명단**을 가리킨다 (계정 표가 아니다)", () => {
    for (const 칸 of ["delegator_employee_id", "delegate_employee_id"]) {
      assert.ok(migration.includes(`"${칸}" uuid NOT NULL`), `${칸} 이 없다`);
    }
    const fks = migration.match(/REFERENCES "public"\."(\w+)"/g) ?? [];
    assert.equal(fks.length, 2);
    for (const fk of fks) assert.match(fk, /web_employees/);
    assert.ok(!migration.includes("web_users"), "🔴 계정 표를 가리키고 있다");
  });

  check("CHECK 둘과 판정이 쓸 색인 하나", () => {
    assert.match(migration, /CHECK \("web_portal_approval_delegations"\."ends_at" > "web_portal_approval_delegations"\."starts_at"\)/);
    assert.match(migration, /"delegate_employee_id" <> "web_portal_approval_delegations"\."delegator_employee_id"/);
    assert.match(
      migration,
      /CREATE INDEX "web_portal_approval_delegations_delegate_idx"[\s\S]*?\("delegate_employee_id","revoked_at","ends_at"\)/,
    );
  });

  check("🔴 CHECK 에 바인딩 자리($1)가 구워지지 않았다", () => {
    // drizzle 의 sql 템플릿에 상수를 끼우면 CHECK ("id" = $1) 이 되어 **돌릴 수
    // 없는 마이그레이션**이 나온다. 오류 없이 생성되고 적용 때 깨진다.
    assert.ok(!/\$\d/.test(migration), "마이그레이션에 바인딩 자리가 있다");
  });

  check("제약 이름이 63자를 넘지 않는다 — PostgreSQL 이 말없이 자른다", () => {
    const 이름들 = migration.match(/CONSTRAINT "([^"]+)"|CREATE INDEX "([^"]+)"/g) ?? [];
    assert.ok(이름들.length >= 4, "이름을 못 찾았다");
    for (const 이름 of 이름들) {
      const 글자 = /"([^"]+)"/.exec(이름)?.[1] ?? "";
      assert.ok(글자.length <= 63, `${글자} (${글자.length}자)`);
    }
  });

  check("🔴 소프트 삭제 4칸을 두지 않았다 — 죽음의 표시가 둘이면 안 된다", () => {
    // 살았나 죽었나는 포털이 보낸 revoked_at 하나가 정한다. is_deleted 를 옆에
    // 두면 「둘이 엇갈리면 무엇이 이기는가」를 아무도 답할 수 없다.
    assert.match(migration, /"revoked_at" timestamp with time zone/);
    assert.ok(!migration.includes("is_deleted"));
    assert.match(migration, /"synced_at" timestamp with time zone DEFAULT now\(\) NOT NULL/);
  });

  check("마이그레이션이 **더하기만** 한다", () => {
    assert.ok(!/DROP |ALTER COLUMN|TRUNCATE/i.test(migration), "지우거나 고치는 문장이 있다");
    const 등록 = read("drizzle/meta/_journal.json");
    assert.ok(등록.includes("0003_portal_approval_delegations"), "목록에 안 올라갔다");
  });

  console.log(`\n${passed}개 통과`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
