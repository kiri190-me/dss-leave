/**
 * 결재권 위임(포털에 맡긴 것) 검사.  npm run test:delegation
 *
 * 🔴 DB 에 닿지 않고 **사내망에도 나가지 않는다.** 포털 노릇은 이 검사가
 * 127.0.0.1 에 직접 띄운 가짜 서버가 한다(test-approval-nudge.ts 와 같은
 * 방식) — 그래서 「포털이 거절한다」·「영영 답하지 않는다」·「이상한 모양을
 * 준다」를 말로가 아니라 **실제로** 돌려 본다.
 *
 * ── 위임이 흐르는 길 ────────────────────────────────────────────────────
 *   통합 승인함에서 사람이 「누구의 결재권을 누구에게」를 지정한다 (포털에 저장)
 *     → 결재함 화면 · 결재 서버 액션이 **거래를 열기 전에** 포털에 묻고
 *     → 받은 포털 번호를 **두 단**으로 바꾼다
 *        (auth_sub → web_users.employee_id → web_employees.id)
 *     → 그 목록이 「이 단계가 내 것인가」 한 쌍에 실린다
 *        (approval-scope.ts 의 isMyStep + myStepCondition)
 *
 * ── 무엇을 지키는가 ─────────────────────────────────────────────────────
 *   1. 🔴 값 판정과 SQL 조건이 **같은 말**을 한다 (한쪽만 넓어지면 「목록엔
 *      뜨는데 누르면 거절」 또는 그 반대가 된다).
 *   2. 🔴 본인이 맨 앞 · 중복 제거 · **이어 붙지 않는다**(A→B, B→C 라도 C 는
 *      A 를 못 얻는다).
 *   3. 🔴 **자기 신청은 자기가 결재 못 한다** — 위임으로도 못 넘는다.
 *   4. 🔴 빈 목록과 **「못 물었다」**를 가른다. 못 물으면 안내가 밖으로 나간다.
 *   5. 🔴 변환에 실패한 수를 **센다** (명단 미연결 · 계정 없음).
 *   6. 🔴 포털이 **우리를** 부르는 통로에서는 묻지 않는다.
 *   7. 🔴 망 호출은 **거래 밖**이다.
 *
 * 🔴 왜 전부 main() 안에 있나: 이 저장소의 검사는 tsx 가 CJS 로 돌려
 * (package.json 에 type:module 이 없다) 최상위 await 을 쓸 수 없다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// 🔴 .env.local 을 읽지 않는다 — 이 검사는 여기 적힌 값으로만 돈다
//    (test-approval-nudge.ts 와 같은 이유). SSO_ISSUER 는 아래에서 가짜 포털로
//    덮어쓴다. DATABASE_URL 은 **아무 데도 붙지 않는 주소**다.
process.env.SSO_ISSUER = "http://127.0.0.1:1";
process.env.SSO_CLIENT_ID = "dss-leave";
process.env.SSO_CLIENT_SECRET = "테스트용-시크릿";
process.env.SSO_REDIRECT_URI = "http://192.168.1.10:3700/api/auth/sso/callback";
process.env.SSO_TX_SECRET = "0123456789abcdef0123456789abcdef";
process.env.DATABASE_URL = "postgres://nobody:nobody@127.0.0.1:1/none";

import { PgDialect } from "drizzle-orm/pg-core";

import { fetchPortalActingSubjects } from "../src/lib/auth/oidc";
import {
  NO_PORTAL_DELEGATIONS,
  resolveActingDelegations,
  type DelegatedApproverRow,
  type PortalActingAnswer,
} from "../src/lib/leave/approval-delegation";
import {
  approvableEmployeeIds,
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

const FAKE_SECRET = "테스트용-시크릿";

/** 포털에 등록된 사람의 번호(포털 users.id)와 같은 모양. 🔴 전부 가짜다. */
const SUB_나 = "11111111-2222-4333-8444-555555555555";
const SUB_맡긴이 = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const SUB_제삼자 = "99999999-1111-4222-8333-444444444444";

/** 🔴 실제 직원 이름·사번을 한 자도 넣지 않는다. */
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

/* ------------------------------------------------------------------ */
/* 가짜 포털 — 127.0.0.1 에만 뜬다                                      */
/* ------------------------------------------------------------------ */

type Heard = {
  method?: string;
  path?: string;
  authorization?: string;
  contentType?: string;
  body: string;
};

let heard: Heard | null = null;
/** 다음 요청에 무엇으로 답할지. 아무것도 하지 않으면 **영영 답하지 않는다.** */
let answer: (res: ServerResponse) => void = (res) => res.end();

const portal = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += String(chunk)));
  req.on("end", () => {
    heard = {
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization,
      contentType: req.headers["content-type"],
      body,
    };
    answer(res);
  });
});

/** 이 답으로 한 번 물어본다. 찍힌 로그도 함께 돌려준다(자격증명 검사용). */
async function ask(
  reply: (res: ServerResponse) => void,
  subject: string = SUB_나,
): Promise<{ answer: PortalActingAnswer; logs: string }> {
  heard = null;
  answer = reply;
  const lines: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    return { answer: await fetchPortalActingSubjects(subject), logs: lines.join("\n") };
  } finally {
    console.error = realError;
  }
}

const json = (code: number, payload: unknown) => (res: ServerResponse) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
};

/** 판단 쪽 배선 — 포털 자리와 DB 자리에 가짜를 끼운다. */
async function resolve(params: {
  subject?: string;
  answer?: PortalActingAnswer;
  askThrows?: boolean;
  rows?: readonly DelegatedApproverRow[];
  lookupThrows?: boolean;
}) {
  const askedWith: string[] = [];
  const lookedUp: string[][] = [];
  const warnings: string[] = [];
  const result = await resolveActingDelegations(params.subject ?? SUB_나, {
    ask: async (subject) => {
      askedWith.push(subject);
      if (params.askThrows) throw new TypeError("fetch failed");
      return params.answer ?? { asked: true, subs: [] };
    },
    lookup: async (subs) => {
      lookedUp.push([...subs]);
      if (params.lookupThrows) throw new Error("db down");
      return params.rows ?? [];
    },
    warn: (message) => warnings.push(message),
  });
  return { result, askedWith, lookedUp, warnings };
}

async function main() {
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  const portalUrl = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.SSO_ISSUER = portalUrl;

  console.log("\n결재권 위임 (포털에 맡긴 것)\n");

  /* ---------------------------------------------------------------- */
  /* 1. 목록 만들기 — 본인이 맨 앞 · 중복 제거 · 이어 붙지 않는다        */
  /* ---------------------------------------------------------------- */

  check("본인이 **언제나 맨 앞**이다 — 위임을 못 물어도 내 단계는 눌린다", () => {
    assert.deepEqual(approvableEmployeeIds(decider()), [나]);
    assert.deepEqual(approvableEmployeeIds(decider({ actingForEmployeeIds: [] })), [나]);
    assert.deepEqual(approvableEmployeeIds(decider({ actingForEmployeeIds: [맡긴이] })), [
      나,
      맡긴이,
    ]);
  });

  check("중복을 걷는다 — 포털은 답의 맨 앞에 부른 사람 자신을 넣어 준다", () => {
    assert.deepEqual(
      approvableEmployeeIds(decider({ actingForEmployeeIds: [나, 맡긴이, 맡긴이] })),
      [나, 맡긴이],
    );
  });

  check("🔴 이어 붙지 않는다 — A→B, B→C 라도 C 는 A 를 못 얻는다", () => {
    // 포털이 「C 는 B 를 대신할 수 있다」만 답했다. B 가 A 를 대신할 수 있다는
    // 사실은 여기 들어오지 않고, 이 쪽에서 만들어 내서도 안 된다.
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
    // 사람 칸이 빈 옛 단계는 예전대로 **내 직급**으로만 판정한다. 포털이 주는
    // 것은 사람뿐이라 맡긴 사람의 직급을 알 수 없고, 직급까지 빌려 오면 그
    // 직급에 걸린 **남의** 옛 단계가 통째로 열린다.
    const 대리인 = decider({ rankId: "rank-대리", isApprover: false, actingForEmployeeIds: [맡긴이] });
    assert.equal(isMyStep(step(null, "rank-과장"), 대리인), false);
    assert.equal(isMyStep(step(null, "rank-대리"), 대리인), false, "직급 결재권이 없다");
    const { sql: text, params } = sqlOf(대리인);
    assert.equal(/rank_id/.test(text), false, "🔴 결재권 없는 사람에게 옛 직급 갈래가 열렸다");
    assert.deepEqual(params, [나, 맡긴이]);
  });

  /* ---------------------------------------------------------------- */
  /* 3. 빈 목록과 「못 물었다」를 가른다                                  */
  /* ---------------------------------------------------------------- */

  await checkAsync("물어봤더니 없더라 — **안내가 뜨지 않는다**", async () => {
    const { result, askedWith, lookedUp } = await resolve({ answer: { asked: true, subs: [] } });
    assert.deepEqual(askedWith, [SUB_나], "🔵 묻지도 않았다 — 아무것도 재지 못했다");
    assert.deepEqual(lookedUp, [], "빈 답에 DB 를 두드렸다");
    assert.deepEqual(result, NO_PORTAL_DELEGATIONS);
    assert.equal(result.unavailable, false);
  });

  await checkAsync("🔴 못 물었다 — 목록은 비지만 **안내가 뜬다**", async () => {
    const { result } = await resolve({ answer: { asked: false } });
    assert.deepEqual(result.actingForEmployeeIds, []);
    assert.equal(result.unavailable, true, "🔴 「없다」와 「모른다」가 뭉개졌다");
  });

  await checkAsync("포털 번호가 없는 사람(임시 로그인)은 **묻지 않는다**", async () => {
    const { result, askedWith } = await resolve({ subject: "" });
    assert.deepEqual(askedWith, [], "번호도 없는데 포털을 두드렸다");
    // 🔴 장애가 아니다 — 안내를 띄우면 영영 오지 않을 때를 기다리게 한다.
    assert.deepEqual(result, NO_PORTAL_DELEGATIONS);
  });

  await checkAsync("🔴 묻는 쪽이 던져도 삼킨다 — 결재 화면이 500 이 되면 안 된다", async () => {
    const { result, warnings } = await resolve({ askThrows: true });
    assert.equal(result.unavailable, true);
    assert.equal(warnings.length, 1, "조용히 삼켰다");
    assert.match(warnings[0], /TypeError/);
  });

  await checkAsync("🔴 DB 를 못 읽어도 던지지 않는다 — 「못 물었다」와 같은 답이다", async () => {
    const { result, warnings } = await resolve({
      answer: { asked: true, subs: [SUB_나, SUB_맡긴이] },
      lookupThrows: true,
    });
    assert.deepEqual(result.actingForEmployeeIds, []);
    assert.equal(result.unavailable, true);
    assert.equal(warnings.length, 1);
  });

  /* ---------------------------------------------------------------- */
  /* 4. 두 단 변환 — 바꾸지 못한 수를 **센다**                           */
  /* ---------------------------------------------------------------- */

  await checkAsync("포털 번호를 **명단 번호**로 바꾼다 (두 단)", async () => {
    const { result, lookedUp, warnings } = await resolve({
      answer: { asked: true, subs: [SUB_나, SUB_맡긴이] },
      rows: [
        { authSub: SUB_나, employeeId: 나 },
        { authSub: SUB_맡긴이, employeeId: 맡긴이 },
      ],
    });
    assert.deepEqual(lookedUp, [[SUB_나, SUB_맡긴이]], "🔵 받은 번호를 그대로 묻지 않았다");
    // 🔴 본인 번호를 여기서 빼지 않는다 — 합치는 쪽이 맨 앞에 두고 중복을 걷는다.
    assert.deepEqual(result.actingForEmployeeIds, [나, 맡긴이]);
    assert.equal(result.unavailable, false);
    assert.deepEqual(warnings, [], "🔴 멀쩡한데 경고를 남겼다 — 거짓 경보는 다음 경고를 죽인다");
  });

  await checkAsync(
    "🔴 명단에 안 이어진 계정은 빠지고 **세어서 남는다** — 조용히 삼키지 않는다",
    async () => {
      const { result, warnings } = await resolve({
        answer: { asked: true, subs: [SUB_나, SUB_맡긴이] },
        rows: [
          { authSub: SUB_나, employeeId: 나 },
          // 포털 로그인은 됐는데 휴가 관리자가 아직 명단에 잇지 않았다.
          { authSub: SUB_맡긴이, employeeId: null },
        ],
      });
      assert.deepEqual(result.actingForEmployeeIds, [나]);
      assert.equal(result.unavailable, false, "🔴 변환 실패는 포털 장애가 아니다");
      assert.equal(warnings.length, 1, "🔴 세지 않으면 그 사람만 영영 조용히 막힌다");
      assert.match(warnings[0], /명단 미연결 1/);
      assert.match(warnings[0], /계정 없음 0/);
    },
  );

  await checkAsync("🔴 이 시스템에 계정이 없는 번호도 세어진다", async () => {
    const { result, warnings } = await resolve({
      answer: { asked: true, subs: [SUB_나, SUB_맡긴이, SUB_제삼자] },
      rows: [{ authSub: SUB_나, employeeId: 나 }],
    });
    assert.deepEqual(result.actingForEmployeeIds, [나]);
    assert.match(warnings[0], /3건 가운데 2건/);
    assert.match(warnings[0], /계정 없음 2/);
    // 🔴 포털 번호 자체는 로그에 찍지 않는다 — 사람을 가리키는 값이다.
    for (const sub of [SUB_나, SUB_맡긴이, SUB_제삼자]) {
      assert.ok(!warnings[0].includes(sub), "🔴 로그에 포털 번호가 딸려 나온다");
    }
  });

  /* ---------------------------------------------------------------- */
  /* 5. 포털 통로 — 실제로 한 번 왕복해 본다                             */
  /* ---------------------------------------------------------------- */

  await checkAsync("보내는 모양 — POST · Basic 머리말 · action=acting", async () => {
    const { answer: got } = await ask(json(200, { subs: [SUB_나, SUB_맡긴이], count: 2 }));
    assert.deepEqual(got, { asked: true, subs: [SUB_나, SUB_맡긴이] });
    assert.ok(heard, "🔵 포털이 아무 요청도 못 받았다 — 아무것도 재지 못했다");
    const h = heard as Heard;
    assert.equal(h.method, "POST");
    assert.equal(h.path, "/api/integration/delegations");
    assert.equal(h.contentType, "application/x-www-form-urlencoded");
    assert.match(String(h.authorization), /^Basic /);
    const sent = new URLSearchParams(h.body);
    assert.equal(sent.get("sub"), SUB_나);
    // 🔴 반대 방향(「나를 누가 대신하나」)을 꽂으면 오류 없이 아무도 못 누른다.
    assert.equal(sent.get("action"), "acting");
    // 자격증명은 **머리말로만** 간다 — 몸통에도 주소에도 실리지 않는다.
    assert.ok(!h.body.includes(FAKE_SECRET));
    assert.ok(!String(h.path).includes("client"));
  });

  await checkAsync("🔴 모르는 모양은 **빈 목록이 아니라 「못 물었다」**", async () => {
    // 포털이 통로를 고치다 칸 이름이 바뀐 날. 「위임이 하나도 없다」로 읽히면
    // 대리인이 막히고도 아무 안내가 뜨지 않는다.
    for (const payload of [{ count: 0 }, { subs: "하나" }, { subs: null }, [SUB_나], "그냥 글자"]) {
      const { answer: got } = await ask(json(200, payload));
      assert.deepEqual(got, { asked: false }, `모르는 모양을 빈 목록으로 읽었다: ${JSON.stringify(payload)}`);
    }
    // JSON 이 아예 아니면 그것도 「못 물었다」다.
    const { answer: got } = await ask((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("<html>포털이 아니다</html>");
    });
    assert.deepEqual(got, { asked: false });
  });

  await checkAsync("글자가 아닌 줄만 버린다 — 나머지는 살린다", async () => {
    const { answer: got } = await ask(json(200, { subs: [SUB_나, 42, "", null, SUB_맡긴이] }));
    assert.deepEqual(got, { asked: true, subs: [SUB_나, SUB_맡긴이] });
  });

  await checkAsync("🔴 포털이 거절해도 던지지 않는다 — 값으로 나간다", async () => {
    for (const code of [401, 403, 429, 500, 503]) {
      const { answer: got } = await ask(json(code, { error: "nope" }));
      assert.deepEqual(got, { asked: false }, `${code} 를 삼키지 못했다`);
    }
  });

  await checkAsync("🔴 포털이 **영영 답하지 않아도** 상한에서 끊고 돌아온다", async () => {
    const started = Date.now();
    // 아무 답도 하지 않는다. 상한(2초)이 없으면 이 검사가 영영 끝나지 않는다.
    const { answer: got } = await ask(() => {});
    const elapsed = Date.now() - started;
    assert.deepEqual(got, { asked: false });
    assert.ok(elapsed < 5000, `상한이 안 걸린다 (${elapsed}ms)`);
  });

  await checkAsync("🔴 자격증명도 포털 번호도 로그에 찍지 않는다", async () => {
    const collected: string[] = [];
    collected.push((await ask(json(401, { error: "nope" }))).logs);
    process.env.SSO_ISSUER = "http://127.0.0.1:1";
    collected.push((await ask(json(200, { subs: [] }))).logs);
    process.env.SSO_ISSUER = portalUrl;

    const all = collected.join("\n");
    assert.ok(all.length > 0, "🔵 로그가 비어 있다 — 아무것도 재지 못했다");
    assert.ok(!all.includes(FAKE_SECRET), "🔴 로그에 시크릿이 딸려 나온다");
    assert.ok(!all.includes("Basic "), "🔴 로그에 Authorization 머리말이 딸려 나온다");
    assert.ok(!all.includes(SUB_나), "🔴 로그에 포털 번호가 딸려 나온다");
  });

  /* ---------------------------------------------------------------- */
  /* 6. 두 단 변환의 DB 쪽 — uuid 가 아닌 번호는 묻기 전에 버린다         */
  /* ---------------------------------------------------------------- */

  await checkAsync("🔴 uuid 모양이 아닌 번호는 **DB 에 묻기 전에** 버린다", async () => {
    // auth_sub 는 uuid 열이라 모양이 아닌 값으로 조회하면 드라이버가 던진다.
    // 🔵 이 호출은 DB 에 닿지 않는다 — 걸러 내고 나면 물을 것이 없어 바로 끝난다.
    const { findEmployeeIdsBySubjects } = await import("../src/lib/auth/portal-delegations");
    assert.deepEqual(await findEmployeeIdsBySubjects(["그냥-글자", ""]), []);
  });

  await checkAsync("포털이 설정되지 않은 기계에서는 묻지 않고 **안내도 안 띄운다**", async () => {
    const { resolvePortalActingDelegations } = await import("../src/lib/auth/portal-delegations");
    const saved = process.env.SSO_ISSUER;
    delete process.env.SSO_ISSUER;
    // 🔵 포털이 요청을 **정말 못 받았는지**를 보려고 기록을 비워 둔다.
    heard = null;
    answer = json(200, { subs: [SUB_나, SUB_맡긴이] });
    try {
      const got = await resolvePortalActingDelegations(SUB_나);
      // 🔴 장애가 아니다. 세우면 그 PC 의 모든 결재 화면에 경고가 깔린다.
      assert.deepEqual(got, NO_PORTAL_DELEGATIONS);
      assert.equal(heard, null, "🔴 설정이 없는데 포털을 두드렸다");
    } finally {
      process.env.SSO_ISSUER = saved;
    }
  });

  /* ---------------------------------------------------------------- */
  /* 7. 🔴 배선 — 어디서 묻고, **어디서 안 묻는가**                      */
  /* ---------------------------------------------------------------- */

  const wiring = withoutComments(read("src/lib/auth/portal-delegations.ts"));
  const workflow = withoutComments(read("src/lib/leave/workflow.ts"));
  const action = withoutComments(read("src/app/actions/leave.ts"));
  const screen = withoutComments(read("src/app/(internal)/approvals/page.tsx"));
  const data = withoutComments(read("src/lib/leave/data.ts"));

  check("배선이 묻는 쪽과 바꾸는 쪽을 **그대로** 꽂는다", () => {
    assert.ok(wiring.includes("ask: fetchPortalActingSubjects"));
    assert.ok(wiring.includes("lookup: findEmployeeIdsBySubjects"));
    // 설정이 없는 기계에서는 아예 묻지 않는다 — 검사가 **먼저** 와야 한다.
    assert.ok(
      wiring.indexOf("if (!env.ssoConfigured) return NO_PORTAL_DELEGATIONS;") <
        wiring.indexOf("resolveActingDelegations("),
      "설정 검사가 뒤에 있다",
    );
  });

  check("🔴 결재함 화면이 묻고, 그 목록을 조회에 **넘긴다**", () => {
    assert.ok(screen.includes("await resolvePortalActingDelegations(member.user.authSub)"));
    assert.ok(
      screen.includes("pendingForApprover(member, portal.actingForEmployeeIds)"),
      "🔴 물어 놓고 안 넘기면 대신 누를 결재가 목록에 뜨지 않는다",
    );
    // 못 물었을 때의 안내를 그린다(설계 B-7).
    assert.ok(screen.includes("portal.unavailable &&"));
    assert.ok(screen.includes("PORTAL_DELEGATION_UNAVAILABLE_NOTICE"));
  });

  check("🔴 서버 액션이 **decideStep 보다 먼저** 묻는다 — 거래 밖이다", () => {
    const at = action.indexOf("export async function decideAction");
    assert.ok(at > 0, "decideAction 을 찾지 못했다");
    const body = action.slice(at);
    const asked = body.indexOf("await resolvePortalActingDelegations(");
    const decided = body.indexOf("await decideStep(");
    assert.ok(asked > 0, "🔴 서버 액션이 포털에 묻지 않는다 — 대리인이 누를 수 없다");
    assert.ok(decided > asked, "🔴 거래를 연 뒤에 묻는다");
    // 묻는 열쇠는 **검증된 세션**에서 온다 — 폼에서 온 값으로 사람을 고르지 않는다.
    assert.ok(body.includes("resolvePortalActingDelegations(member.user.authSub)"));
  });

  check("🔴 workflow.ts 는 제 손으로 묻지 않는다 — 망 호출이 거래 안에 들어간다", () => {
    for (const forbidden of ["resolvePortalActingDelegations", "fetchPortalActingSubjects", "fetch("]) {
      assert.ok(!workflow.includes(forbidden), `🔴 거래 안에서 포털을 부른다: ${forbidden}`);
    }
    // 받은 값을 판정에 그대로 싣는다.
    assert.ok(workflow.includes("actingForEmployeeIds: portal.actingForEmployeeIds,"));
    assert.ok(workflow.includes("const mine = isMyStep(step, {"));
  });

  check("🔴 **포털이 우리를 부르는 통로에서는 묻지 않는다**", () => {
    // 거기서 또 포털에 물으면 포털이 이쪽을 기다리는 동안 이쪽이 포털을
    // 기다린다. 머리말의 건수·알림 종도 모든 화면에 딸려 오는 자리라 묻지 않는다.
    for (const path of [
      "src/app/api/integration/approvals/route.ts",
      "src/lib/leave/portal-approvals.ts",
      "src/lib/leave/portal-notifications.ts",
      "src/components/PortalNotificationBell.tsx",
      "src/app/(internal)/layout.tsx",
    ]) {
      const source = withoutComments(read(path));
      for (const forbidden of [
        "resolvePortalActingDelegations",
        "fetchPortalActingSubjects",
        "actingForEmployeeIds",
      ]) {
        assert.ok(!source.includes(forbidden), `🔴 ${path} 가 포털에 되묻는다: ${forbidden}`);
      }
    }
  });

  check("🔴 조회는 **스스로 묻지 않는다** — 부르는 쪽이 정한다", () => {
    for (const forbidden of ["resolvePortalActingDelegations", "fetchPortalActingSubjects"]) {
      assert.ok(!data.includes(forbidden), `🔴 조회가 제 손으로 포털을 부른다: ${forbidden}`);
    }
    // 넘겨받은 목록을 공용 조건에 그대로 싣는다.
    assert.ok(data.includes("deciderOf(viewer.employee, viewer.isApprover, acting)"));
    // 🔴 넷이 쓰는 그 **한 문장**은 그대로다.
    assert.ok(data.includes("myStepCondition(me)"));
  });

  /* ---------------------------------------------------------------- */
  /* 8. 🔴 자기 신청은 자기가 결재 못 한다 — 위임으로도 못 넘는다         */
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
  /* 9. 🔴 「못 물었다」가 밖으로 나오는 길                               */
  /* ---------------------------------------------------------------- */

  check("결과에 싣고 · 액션이 안내를 붙이고 · 화면이 그린다", () => {
    // ① 결과에 싣는다. 🔴 boolean 이 아니라 true 뿐이라 「물었는데 멀쩡했다」와
    //    섞이지 않는다.
    assert.ok(workflow.includes("portalDelegationUnavailable?: true"));
    assert.ok(!/portalDelegationUnavailable\?: boolean/.test(workflow));
    assert.ok(workflow.includes("function notePortalOutage("));
    // 나가는 길이 넷이다(막힘 · 반려 · 승인 · 확정) — 하나만 빠져도 그 길에서
    // 안내가 조용히 사라진다.
    const 실은자리 = workflow.match(/notePortalOutage\(/g) ?? [];
    assert.equal(실은자리.length, 4, `결과에 싣는 자리가 ${실은자리.length}군데다`);
    // ② 액션이 글자를 붙인다.
    assert.ok(action.includes("result.portalDelegationUnavailable"));
    assert.ok(action.includes("PORTAL_DELEGATION_UNAVAILABLE_NOTICE"));
    // ③ 안내 글이 「없다」가 아니라 「확인하지 못했다」라고 말한다.
    const labels = withoutComments(read("src/lib/leave/labels.ts"));
    assert.match(labels, /PORTAL_DELEGATION_UNAVAILABLE_NOTICE\s*=/);
    assert.match(labels, /확인하지 못했습니다/);
  });

  check("🔴 상한이 2초다 — 설계서의 3초가 아니라 이 집의 관례다", () => {
    const oidc = withoutComments(read("src/lib/auth/oidc.ts"));
    const at = oidc.indexOf("export async function fetchPortalActingSubjects");
    assert.ok(at > 0, "묻는 함수를 찾지 못했다");
    const body = oidc.slice(at);
    assert.equal(/\bthrow\b/.test(body), false, "🔴 묻는 통로가 던진다 — 결재 화면이 깨진다");
    assert.ok(body.includes("signal: AbortSignal.timeout(NOTIFICATIONS_TIMEOUT_MS)"), "상한이 없다");
    // 🔴 이 집의 네 통로와 **같은 상수**를 쓴다. 제 값을 따로 두면 느릴 때 어느
    //    쪽이 느린지 알 수 없게 된다.
    const limit = oidc.match(/const NOTIFICATIONS_TIMEOUT_MS = (\d+);/);
    assert.ok(limit && Number(limit[1]) === 2000, "상한이 2초가 아니다");
  });

  portal.closeAllConnections();
  await new Promise<void>((resolve) => portal.close(() => resolve()));

  console.log(`\n${passed}개 통과`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
