/**
 * 포털의 **어긋남 점검**이 읽어 가는 갈래 — 검사.  npm run test:delegation-list
 *
 * 🔴 DB 에 닿지 않고 사내망에도 나가지 않는다. 포털의 서명 열쇠 노릇은 이 검사가
 * 127.0.0.1 에 직접 띄운 가짜 JWKS 서버가 하고, DATABASE_URL 은 **아무 데도 붙지
 * 않는 주소**다(test-delegation-sync.ts 와 같은 방식).
 *
 * ── 무엇을 지키는가 (설계 B-14, 조각 9a) ────────────────────────────────
 *   1. 🔴 **답에 사람이 없다.** 칸은 `id`·`startsAt`·`endsAt`·`revokedAt` 넷뿐이고,
 *      질의도 사람 칸을 **애초에 안 고른다**(구워진 SQL 로 본다).
 *   2. 🔴 **모든 줄을 준다** — 살아 있는 것·끝난 것·**철회된 것**까지. 화면용
 *      조회(`loadAllUnfinishedDelegations`)는 안 끝난 줄만 보므로 쓸 수 없다.
 *      거르개가 하나라도 끼면 「포털은 거뒀는데 집에서는 살아 있는」 줄이 **양쪽에서
 *      똑같이 안 보인다** — 그것이 설계 B-13 이 더 위험하다고 못 박은 쪽이다.
 *   3. 🔴 넘치면 **`truncated: true` 로 말한다.** 조용히 자르면 점검이 잘린 줄을
 *      「집에 없다」로 읽고, 그 모양이 **찾으려는 어긋남과 글자 그대로 같다.**
 *   4. 🔴 **쓰기 토큰으로 읽을 수 없고, 읽기 토큰으로 쓸 수 없다.**
 *   5. 🔴 **쓰기 갈래가 한 글자도 안 바뀌었다**(2026-11-16 에 세 집이 맞춘 자리).
 *
 * 🔴 왜 전부 main() 안에 있나: 이 저장소의 검사는 tsx 가 CJS 로 돌려
 * (package.json 에 type:module 이 없다) 최상위 await 을 쓸 수 없다.
 * 🔴 **DB 를 건드리는 모듈은 `await import` 로 불러온다** — `src/lib/db` 는 모듈을
 * 읽는 순간 DATABASE_URL 을 읽는데, 정적 import 는 아래 환경 설정보다 **먼저**
 * 돌기 때문이다(esbuild 가 import 를 위로 끌어올린다).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// 🔴 .env.local 을 읽지 않는다 — 이 검사는 여기 적힌 값으로만 돈다.
process.env.SSO_ISSUER = "http://127.0.0.1:1";
process.env.SSO_CLIENT_ID = "dss-leave";
process.env.SSO_CLIENT_SECRET = "테스트용-시크릿";
process.env.SSO_REDIRECT_URI = "http://192.168.1.10:3700/api/auth/sso/callback";
process.env.SSO_TX_SECRET = "0123456789abcdef0123456789abcdef";
process.env.DATABASE_URL = "postgres://nobody:nobody@127.0.0.1:1/none";

import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";

import { PORTAL_TOKEN_PURPOSES } from "../src/lib/auth/portal-service-token";
import {
  DELEGATION_LIST_ACTION,
  DELEGATION_LIST_LIMIT,
  buildDelegationListReply,
  isDelegationListAction,
  readDelegationAction,
  type DelegationAuditRow,
} from "../src/lib/leave/portal-delegation-list";
import {
  DELEGATION_ACTIONS,
  parseDelegationCommand,
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

const CLIENT_ID = "dss-leave";
const SUB_부른이 = "11111111-2222-4333-8444-555555555555";
const DELEGATION_ID = "cccc3333-3333-4333-8333-333333333333";

/** 표에서 읽은 줄 한 개. 기본은 **살아 있는** 줄이다. */
function auditRow(over: Partial<DelegationAuditRow> = {}): DelegationAuditRow {
  return {
    id: DELEGATION_ID,
    startsAt: new Date("2027-03-01T00:00:00.000Z"),
    endsAt: new Date("2027-03-08T00:00:00.000Z"),
    revokedAt: null,
    ...over,
  };
}

/** 규약대로 생긴 upsert 본문 — 🔵 쓰기 갈래가 안 바뀐 것을 재는 데만 쓴다. */
function upsertBody(): Record<string, unknown> {
  return {
    action: "upsert",
    id: DELEGATION_ID,
    delegatorSub: SUB_부른이,
    delegateSub: "66666666-7777-4888-8999-aaaaaaaaaaaa",
    startsAt: "2027-03-01T00:00:00.000Z",
    endsAt: "2027-03-08T00:00:00.000Z",
    reason: "출장",
  };
}

async function main() {
  /* ---------------------------------------------------------------- */
  /* 1. 갈래 가리기 — 몸통에서 `action` 한 칸만 엿본다                   */
  /* ---------------------------------------------------------------- */

  check("🔴 글자가 세 집에서 같아야 한다 — 값으로 못 박는다", () => {
    // 🔴 A/S·재고관리 저장소는 여기서 읽을 수 없다. 그래서 **값**을 적어 둔다 —
    //    한 집이 글자를 바꾸면 그 집만 조용히 401 이 되고, 점검은 그것을 「못
    //    쟀다」로 읽어 어긋남과 섞인다.
    assert.equal(DELEGATION_LIST_ACTION, "list");
    assert.equal(PORTAL_TOKEN_PURPOSES.delegationsRead, "dss.delegations.read");
    // 🔵 쓰기 쪽이 그대로인 것도 함께 잰다 — 둘이 같은 글자가 되면 울타리가 없어진다.
    assert.equal(PORTAL_TOKEN_PURPOSES.delegationsWrite, "dss.delegations.write");
    assert.notEqual(
      PORTAL_TOKEN_PURPOSES.delegationsRead,
      PORTAL_TOKEN_PURPOSES.delegationsWrite,
    );
  });

  check("JSON 몸통에서 읽기 갈래를 가린다", () => {
    const action = readDelegationAction('{"action":"list"}', "application/json");
    assert.equal(action, "list");
    assert.ok(isDelegationListAction(action));
  });

  check("🔴 폼 인코딩 몸통도 **같은 답**이다 — 규약이 안 정한 빈칸을 안 만든다", () => {
    // 쓰기 갈래는 처음부터 JSON 이었고 이 갈래의 지시서는 폼 인코딩으로 적혀
    // 있었다. 한쪽만 받으면 **포털이 어느 모양으로 부르느냐에 따라 집 하나만 400**
    // 이 되는데, 그 400 은 점검에서 「못 쟀다」로 보여 어긋남과 섞인다.
    assert.equal(
      readDelegationAction("action=list", "application/x-www-form-urlencoded"),
      "list",
    );
    // 🔵 `charset` 이 붙어 와도 같은 말이다.
    assert.equal(
      readDelegationAction("action=list", "application/x-www-form-urlencoded; charset=utf-8"),
      "list",
    );
    // 🔵 다른 칸이 함께 와도 action 만 본다.
    assert.equal(
      readDelegationAction("sub=x&action=list", "application/x-www-form-urlencoded"),
      "list",
    );
  });

  check("🔴 쓰기 갈래의 말은 읽기로 가지 않는다", () => {
    for (const action of DELEGATION_ACTIONS) {
      const 읽은값 = readDelegationAction(JSON.stringify({ action }), "application/json");
      assert.equal(읽은값, action);
      assert.ok(!isDelegationListAction(읽은값), `${action} 이 읽기 갈래로 샜다`);
    }
    // 🔴 **`list` 가 쓰기 말 목록에 들어가 있으면 안 된다** — 들어가면 쓰기 토큰으로
    //    읽기 갈래에 발을 들일 수 있고, 모양 검사가 「id 가 uuid 가 아닙니다」라는
    //    엉뚱한 말을 돌려준다.
    assert.ok(!(DELEGATION_ACTIONS as readonly string[]).includes("list"));
    const 거절 = parseDelegationCommand({ action: "list" });
    assert.equal(거절.ok, false);
    assert.match(거절.ok ? "" : 거절.error, /upsert 또는 revoke/);
  });

  check("읽을 수 없는 몸통은 null 이다 — 🔵 거절은 쓰기 갈래의 일이다", () => {
    // 🔵 여기서 400 을 내면 **토큰을 보기 전에** 모양으로 답을 가르게 된다.
    for (const 몸통 of ["", "{", "[]", '"list"', "null", "action=list"]) {
      assert.equal(readDelegationAction(몸통, "application/json"), null, 몸통);
    }
    // action 칸이 글자가 아니면 모르는 것으로 본다.
    assert.equal(readDelegationAction('{"action":{"x":1}}', "application/json"), null);
    assert.equal(readDelegationAction('{"action":3}', "application/json"), null);
    assert.ok(!isDelegationListAction(null));
  });

  /* ---------------------------------------------------------------- */
  /* 2. 몸통 짓기 — 🔴 사람이 안 실린다                                  */
  /* ---------------------------------------------------------------- */

  check("칸은 넷뿐이고 시각은 ISO 8601 이다", () => {
    const 답 = buildDelegationListReply([auditRow()]);
    assert.equal(답.delegations.length, 1);
    assert.deepEqual(Object.keys(답.delegations[0]).sort(), [
      "endsAt",
      "id",
      "revokedAt",
      "startsAt",
    ]);
    assert.equal(답.delegations[0].startsAt, "2027-03-01T00:00:00.000Z");
    assert.equal(답.delegations[0].endsAt, "2027-03-08T00:00:00.000Z");
    assert.equal(답.delegations[0].revokedAt, null);
    assert.equal(답.truncated, false);
  });

  check("🔴 **철회된 줄도 그대로 실린다** — 맞대어 보기의 핵심", () => {
    const 거둔줄 = auditRow({ revokedAt: new Date("2027-03-04T09:30:00.000Z") });
    const 답 = buildDelegationListReply([거둔줄]);
    // 🔴 걸러 내면 「포털은 거뒀는데 집에서는 살아 있는」 줄이 양쪽에서 똑같이
    //    안 보인다(설계 B-13 이 더 위험하다고 한 쪽).
    assert.equal(답.delegations.length, 1);
    assert.equal(답.delegations[0].revokedAt, "2027-03-04T09:30:00.000Z");
  });

  check("🔴 사람 칸은 **섞어 넣어도** 몸통에 안 나간다", () => {
    // 🔵 표에 칸이 늘거나 조회가 칸을 더 고르는 날을 흉내 낸다. `...row` 로
    //    펼치는 구현이면 여기서 터진다 — 오류도 경고도 없이 새는 모양이다.
    const 사람이섞인줄 = {
      ...auditRow(),
      delegatorEmployeeId: "aaaa1111-1111-4111-8111-111111111111",
      delegateEmployeeId: "bbbb2222-2222-4222-8222-222222222222",
      reason: "출장",
    } as unknown as DelegationAuditRow;
    const 글자 = JSON.stringify(buildDelegationListReply([사람이섞인줄]));
    for (const 새는값 of ["aaaa1111", "bbbb2222", "출장", "delegator", "delegate", "reason"]) {
      assert.ok(!글자.includes(새는값), `${새는값} 가 몸통에 실렸다`);
    }
    // 🔵 표본이 비어 공짜로 통과하지 않게 — 같은 몸통에 번호는 실려 있어야 한다.
    assert.ok(글자.includes(DELEGATION_ID));
  });

  check("빈 목록도 제대로 된 답이다", () => {
    assert.deepEqual(buildDelegationListReply([]), { delegations: [], truncated: false });
  });

  check("🔴 상한을 넘치면 **말한다**(truncated) — 조용히 자르지 않는다", () => {
    const 줄 = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        auditRow({ id: `cccc3333-3333-4333-8333-${String(i).padStart(12, "0")}` }),
      );
    // 🔴 딱 상한만큼은 **안 잘린 것**이다. 여기서 참이 되면 점검이 멀쩡한 날마다
    //    「잘렸을 수 있다」를 보고한다.
    const 딱맞음 = buildDelegationListReply(줄(5), 5);
    assert.equal(딱맞음.truncated, false);
    assert.equal(딱맞음.delegations.length, 5);
    // 한 줄 더 읽었으면 넘친 것이다 — 그 한 줄은 버리고 참으로 답한다.
    const 넘침 = buildDelegationListReply(줄(6), 5);
    assert.equal(넘침.truncated, true);
    assert.equal(넘침.delegations.length, 5);
    assert.equal(넘침.delegations[4].id.endsWith("000000000004"), true);
  });

  check("상한의 기본값이 2000 이다", () => {
    assert.equal(DELEGATION_LIST_LIMIT, 2000);
  });

  /* ---------------------------------------------------------------- */
  /* 3. 질의 — 🔵 구워진 SQL 로 본다 (DB 에 닿지 않는다)                 */
  /* ---------------------------------------------------------------- */

  const delegations = await import("../src/lib/auth/portal-delegations");
  const { sql, params } = delegations.delegationsForAuditQuery().toSQL();

  check("🔴 사람 칸을 **고르지도 않는다**", () => {
    assert.match(sql, /^select /);
    assert.ok(sql.includes('"id"'), "표본이 비었다 — 질의를 잘못 읽었다");
    for (const 칸 of ["delegator", "delegate", "reason", "synced_at"]) {
      assert.ok(!sql.includes(칸), `${칸} 을 읽고 있다`);
    }
    for (const 칸 of ["starts_at", "ends_at", "revoked_at"]) {
      assert.ok(sql.includes(`"${칸}"`), `${칸} 이 빠졌다`);
    }
    assert.ok(sql.includes('from "web_portal_approval_delegations"'));
  });

  check("🔴 **거르개가 없다** — 철회된 줄까지 전부", () => {
    assert.ok(!/ where /.test(sql), `거르개가 붙었다: ${sql}`);
    // 🔵 화면용 조회가 쓰는 조건이 실수로 따라오지 않았는지 이름으로도 본다.
    assert.ok(!sql.includes("is null"));
  });

  check("🔴 차례를 못 박는다 — 잘릴 때 **같은 줄**이 잘린다", () => {
    assert.match(sql, /order by "web_portal_approval_delegations"\."id"/);
  });

  check("🔴 상한보다 **한 줄 더** 묻는다 — 넘침을 가리는 유일한 길", () => {
    assert.match(sql, /limit \$\d+/);
    assert.ok(
      params.includes(DELEGATION_LIST_LIMIT + 1),
      `상한이 ${DELEGATION_LIST_LIMIT + 1} 이 아니다: ${JSON.stringify(params)}`,
    );
    // 🔵 몸통을 짓는 쪽이 그 한 줄을 다시 버린다 — 둘이 어긋나면 2001 줄이 나간다.
    const 꽉찬목록 = Array.from({ length: DELEGATION_LIST_LIMIT + 1 }, () => auditRow());
    assert.equal(buildDelegationListReply(꽉찬목록).delegations.length, DELEGATION_LIST_LIMIT);
  });

  check("🔴 화면용 조회를 **빌려 쓰지 않는다**", () => {
    const source = withoutComments(read("src/lib/auth/portal-delegations.ts"));
    const at = source.indexOf("export function delegationsForAuditQuery");
    const end = source.indexOf("export async function loadDelegationsForAudit");
    assert.ok(at > 0 && end > at, "점검용 조회를 찾지 못했다");
    const 몸통 = source.slice(at, end);
    // 🔴 `unfinishedWhere` 는 **안 끝난 줄만** 보는 조건이다. 한 줄만 끼어도
    //    철회된 줄이 사라지고, 그것은 SQL 을 구워 보기 전에는 안 보인다.
    for (const 금지 of ["unfinishedWhere", "liveDelegationWhere", "where("]) {
      assert.ok(!몸통.includes(금지), `${금지} 가 끼어 있다`);
    }
  });

  /* ---------------------------------------------------------------- */
  /* 4. 통로 — 🔵 **실제로 불러 본다**                                   */
  /* ---------------------------------------------------------------- */

  const 포털열쇠 = await generateKeyPair("RS256", { extractable: true });
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
    return new SignJWT({ purpose: over.purpose ?? PORTAL_TOKEN_PURPOSES.delegationsRead })
      .setProtectedHeader({ alg: "RS256", kid: "portal-1" })
      .setIssuer(ISSUER)
      .setAudience(over.audience ?? CLIENT_ID)
      .setSubject(SUB_부른이)
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(over.key ?? 포털열쇠.privateKey);
  }

  const route = await import("../src/app/api/integration/delegations/route");

  /** 통로를 실제로 부른다. 🔴 자격증명이 없으면 머리말을 아예 안 붙인다. */
  async function post(params: { token?: string; body?: string; contentType?: string }) {
    const headers: Record<string, string> = {
      "content-type": params.contentType ?? "application/json",
    };
    if (params.token) headers.authorization = `Bearer ${params.token}`;
    const request = new Request("http://192.168.1.10:3700/api/integration/delegations", {
      method: "POST",
      headers,
      body: params.body ?? '{"action":"list"}',
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

  await checkAsync("🔴 자격증명 없이 읽으면 401 이다 (두 몸통 모두)", async () => {
    const json = await post({});
    assert.equal(json.response.status, 401);
    assert.equal(json.body.error, "invalid_token");
    assert.equal(json.response.headers.get("www-authenticate"), "Bearer");
    const form = await post({
      body: "action=list",
      contentType: "application/x-www-form-urlencoded",
    });
    assert.equal(form.response.status, 401);
    // 🔴 위임 장부가 캐시되면 거둔 위임이 살아 있는 것처럼 남는다.
    assert.equal(form.response.headers.get("cache-control"), "no-store");
  });

  await checkAsync("🔴 **쓰기 토큰으로 읽을 수 없다**", async () => {
    // 「남에게 결재권을 맡기러」 구운 토큰이 회사 전체의 위임 장부를 여는 열쇠가
    // 되면 안 된다. 🔵 이 울타리는 `purpose` 하나에 달려 있다.
    const { response } = await post({
      token: await token({ purpose: PORTAL_TOKEN_PURPOSES.delegationsWrite }),
    });
    assert.equal(response.status, 401);
  });

  await checkAsync("🔴 **읽기 토큰으로 쓸 수 없다**", async () => {
    const { response } = await post({
      token: await token({ purpose: PORTAL_TOKEN_PURPOSES.delegationsRead }),
      body: JSON.stringify(upsertBody()),
    });
    assert.equal(response.status, 401);
  });

  await checkAsync("알림 읽기용 토큰으로도 안 열린다", async () => {
    const { response } = await post({
      token: await token({ purpose: PORTAL_TOKEN_PURPOSES.notificationsRead }),
    });
    assert.equal(response.status, 401);
  });

  await checkAsync("남의 서명·남에게 발급된 토큰도 거절한다", async () => {
    const 남의열쇠 = await generateKeyPair("RS256", { extractable: true });
    const 남의서명 = await post({ token: await token({ key: 남의열쇠.privateKey }) });
    assert.equal(남의서명.response.status, 401);
    const 남의수신자 = await post({ token: await token({ audience: "dss-po" }) });
    assert.equal(남의수신자.response.status, 401);
  });

  await checkAsync("🔵 올바른 읽기 토큰은 울타리를 **지나간다** — 표가 그 증거다", async () => {
    // 🔵 표본이 비어 공짜로 통과하지 않게: 위 넷이 401 인 것이 뜻을 가지려면
    //    **같은 통로가 올바른 토큰에는 다른 답**을 해야 한다. 이 검사의 DB 주소는
    //    아무 데도 안 붙으므로 질의에서 터지고, 통로는 그것을 500 으로 답한다 —
    //    🔴 **그 500 이 「토큰 울타리를 지나 표까지 갔다」는 증거**다.
    const { response, body } = await post({ token: await token() });
    assert.equal(response.status, 500);
    assert.equal(body.error, "storage_failed");
    assert.equal(response.headers.get("cache-control"), "no-store");
    // 🔴 못 읽은 것을 **빈 목록으로 답하지 않는다** — 점검이 그것을 「이 집에 위임이
    //    하나도 없다」로 읽으면 DB 가 앓는 날 모든 위임이 어긋남으로 보고된다.
    assert.equal(body.delegations, undefined);
  });

  await checkAsync("🔴 쓰기 갈래는 **한 글자도 안 바뀌었다**", async () => {
    // 모양이 틀린 몸통은 여전히 400 이고, 까닭이 글로 간다.
    const 쓰기토큰 = await token({ purpose: PORTAL_TOKEN_PURPOSES.delegationsWrite });
    const 깨진몸통 = await post({ token: 쓰기토큰, body: "{" });
    assert.equal(깨진몸통.response.status, 400);
    assert.equal(깨진몸통.body.error, "invalid_request");
    assert.match(String(깨진몸통.body.error_description), /JSON/);
    // 모르는 말은 예전 그대로 거절한다 — 새 규칙을 만들지 않았다.
    const 모르는말 = await post({
      token: 쓰기토큰,
      body: JSON.stringify({ action: "listen", id: DELEGATION_ID }),
    });
    assert.equal(모르는말.response.status, 400);
    assert.match(String(모르는말.body.error_description), /upsert 또는 revoke/);
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
  /* 5. 통로 배선 — 요청으로 못 재는 것만 소스 글자로                    */
  /* ---------------------------------------------------------------- */

  const routeSource = withoutComments(read("src/app/api/integration/delegations/route.ts"));

  check("🔴 갈래를 가린 **뒤에** 그 갈래의 쓰임새를 요구한다", () => {
    const 가르는자리 = routeSource.indexOf("isDelegationListAction(");
    const 읽기 = routeSource.indexOf("PORTAL_TOKEN_PURPOSES.delegationsRead");
    const 쓰기 = routeSource.indexOf("PORTAL_TOKEN_PURPOSES.delegationsWrite");
    assert.ok(가르는자리 > 0, "갈래를 가르는 자리를 찾지 못했다");
    assert.ok(읽기 > 가르는자리, "읽기 갈래가 쓰임새를 안 요구한다");
    assert.ok(쓰기 > 읽기, "🔴 읽기 갈래가 쓰기 쓰임새를 보고 있다");
    // 🔴 엿보기는 **복제본**이어야 한다 — 원본 몸통을 읽으면 아래 쓰기 갈래의
    //    `request.json()` 이 빈 몸통을 받는다(오류 없이 전부 400 이 된다).
    assert.match(routeSource, /request\.clone\(\)\.text\(\)/);
    assert.ok(routeSource.indexOf("request.clone()") < 가르는자리);
  });

  check("🔴 읽기 갈래가 사람을 읽는 자리로 가지 않는다", () => {
    const 가르는자리 = routeSource.indexOf("if (isDelegationListAction(");
    const 쓰기 = routeSource.indexOf("PORTAL_TOKEN_PURPOSES.delegationsWrite");
    const 갈래 = routeSource.slice(가르는자리, 쓰기);
    assert.ok(갈래.includes("listDelegations()"), "표본이 비었다 — 갈래를 잘못 잘랐다");
    for (const 금지 of ["findEmployeeIdsBySubjects", "employee", "Sub", "reason"]) {
      assert.ok(!갈래.includes(금지), `읽기 갈래가 ${금지} 를 건드린다`);
    }
  });

  check("🔴 포털 번호를 로그에 쌓지 않는다", () => {
    const 로그 = routeSource.match(/console\.(log|warn|error)\([\s\S]*?\);/g) ?? [];
    assert.ok(로그.length >= 3, "로그 자리를 못 찾았다");
    for (const 한줄 of 로그) {
      assert.ok(!/[Ss]ub\b/.test(한줄), `포털 번호를 남기고 있다: ${한줄}`);
      assert.ok(!/body|rows|parsed\.command/.test(한줄), `본문을 통째로 남기고 있다: ${한줄}`);
    }
  });

  check("🔴 화면·기존 조회를 건드리지 않았다", () => {
    // 🔵 이 조각이 더한 것은 **새 조회 하나**다. 화면이 쓰는 셋은 그대로여야 한다 —
    //    `loadAllUnfinishedDelegations` 에 거르개를 푸는 식으로 고쳤다면 화면에
    //    끝난 위임이 쏟아진다.
    const source = withoutComments(read("src/lib/auth/portal-delegations.ts"));
    for (const 이름 of [
      "export async function loadDelegationsActingFor",
      "export async function loadDelegationsGivenBy",
      "export async function loadAllUnfinishedDelegations",
      "export async function loadActingForEmployeeIds",
      "export async function findEmployeeIdsBySubjects",
    ]) {
      assert.ok(source.includes(이름), `${이름} 이 없어졌다`);
    }
    // 화면용 「모두의 것」은 여전히 **안 끝난 줄만** 본다(그것이 그 조회의 뜻이다).
    const at = source.indexOf("export function allUnfinishedDelegationsQuery");
    assert.ok(at > 0 && source.slice(at, at + 200).includes("delegationViewQuery(undefined"));
    // 🔴 점검 갈래는 그 조회를 안 쓴다.
    assert.ok(!routeSource.includes("loadAllUnfinishedDelegations"));
  });

  console.log(`\n${passed}개 통과`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
