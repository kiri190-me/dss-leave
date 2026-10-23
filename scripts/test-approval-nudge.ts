/**
 * 결재 생성 알림(포털 쿡 찌르기) 검사.  npm run test:nudge
 *
 * 🔴 DB 에 닿지 않고 **사내망에도 나가지 않는다.** 포털 노릇은 이 검사가
 * 127.0.0.1 에 직접 띄운 가짜 서버가 한다(test-notification-bell.ts 와 같은
 * 방식) — 그래서 「통로가 아직 없어 404 가 온다」·「포털이 영영 답하지
 * 않는다」·「연결이 거절된다」를 말로가 아니라 **실제로** 돌려 본다.
 *
 * ── 찌르기가 흐르는 길 (종·승인함과 **반대 방향**이다) ──────────────────────
 *   휴가 신청이 저장된다 (커밋)
 *     → 그 뒤에 workflow.ts 가 nudgePortalApprovalCreated 를 부른다
 *     → 열린 단계에 걸릴 수 있는 사람을 넓게 모으고(approvalNudgeCandidates)
 *     → **공용 조건**(myPendingApprovalWhere)으로 한 명씩 되물어 거른 뒤
 *     → POST {포털}/api/integration/approval-created  (approverSub=… 뿐)
 *     → 포털이 그 사람의 결재를 **제 통로로 다시 물어** 메일을 띄운다
 *
 * ── 무엇을 지키는가 ─────────────────────────────────────────────────────
 *   1. 🔴 포털이 죽어도(404·500·타임아웃·연결 거부) **던지지 않는다.**
 *      — 신청은 이미 저장됐다. 여기서 새면 「신청은 됐는데 실패라고 뜬다」가 된다.
 *   2. 🔴 트랜잭션 **밖**에서 부른다 (소스 글자로).
 *   3. 🔴 보내는 몸통에 결재 **내용이 없다** — `approverSub` 뿐이다.
 *   4. 🔴 포털 번호가 없는 사람은 **부르지 않고 로그에 남는다.**
 *   5. 🔴 결재가 생기는 자리 **넷 모두**에서 불린다
 *      (신청·변경 · 취소 신청 · 승인으로 다음 차례 · 건너뛰기로 다음 차례).
 *   6. 🔴 누구에게 갈지를 **새로 판정하지 않는다** — 공용 조건에 되묻는다.
 *
 * 🔴 왜 전부 main() 안에 있나: 이 저장소의 검사는 tsx 가 CJS 로 돌려
 * (package.json 에 type:module 이 없다) 최상위 await 을 쓸 수 없다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// 🔴 .env.local 을 읽지 않는다 — 이 검사는 여기 적힌 값으로만 돈다
//    (test-portal-notifications.ts 와 같은 이유: auto 로 두면 Wi-Fi 상태에
//    따라 결과가 달라진다). SSO_ISSUER 는 아래에서 가짜 포털로 덮어쓴다.
process.env.SSO_ISSUER = "http://127.0.0.1:1";
process.env.SSO_CLIENT_ID = "dss-leave";
process.env.SSO_CLIENT_SECRET = "테스트용-시크릿";
process.env.SSO_REDIRECT_URI = "http://192.168.1.10:3700/api/auth/sso/callback";
process.env.SSO_TX_SECRET = "0123456789abcdef0123456789abcdef";
process.env.DATABASE_URL = "postgres://nobody:nobody@127.0.0.1:1/none";

import { notifyPortalApprovalCreated } from "../src/lib/auth/oidc";
import {
  nudgeApprovalCreated,
  type ApprovalNudgeCandidate,
} from "../src/lib/leave/approval-nudge";
import type { Decider } from "../src/lib/leave/approval-scope";

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

/** 주석을 걷어 낸 코드. 주석에 적힌 낱말이 검사를 통과시키지 않게. */
const withoutComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const FAKE_SECRET = "테스트용-시크릿";

/** 포털에 등록된 사람의 번호(포털 users.id)와 같은 모양. 전부 가짜다. */
const SUB_A = "11111111-2222-4333-8444-555555555555";
const SUB_B = "66666666-7777-4888-8999-aaaaaaaaaaaa";

const REQUEST_ID = "cccccccc-dddd-4eee-8fff-000000000000";

/** 결재할 수 있는 후보 한 줄. 🔴 실제 직원 이름은 한 자도 넣지 않는다. */
function candidate(over: Partial<ApprovalNudgeCandidate> = {}): ApprovalNudgeCandidate {
  return {
    employeeId: "emp-1",
    rankId: "rank-1",
    isApprover: true,
    authSub: SUB_A,
    ...over,
  };
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

/** 이 답으로 한 번 찔러 본다. 찍힌 로그도 함께 돌려준다(자격증명 검사용). */
async function poke(
  reply: (res: ServerResponse) => void,
  subs: readonly string[] = [SUB_A],
): Promise<{ ok: boolean; logs: string }> {
  heard = null;
  answer = reply;
  const lines: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const ok = await notifyPortalApprovalCreated(subs);
    return { ok, logs: lines.join("\n") };
  } finally {
    console.error = realError;
  }
}

const status = (code: number) => (res: ServerResponse) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "nope" }));
};

/* ------------------------------------------------------------------ */
/* 판단 쪽 배선 — DB 자리에 가짜를 끼운다                                */
/* ------------------------------------------------------------------ */

type Call = { me: Decider; requestId: string };

/** 실제 배선과 같은 모양. 센 값(무엇을 물었나)을 함께 돌려준다. */
async function run(params: {
  candidates: readonly ApprovalNudgeCandidate[];
  pending?: (me: Decider) => boolean;
  send?: (subs: readonly string[]) => Promise<boolean>;
}) {
  const asked: Call[] = [];
  const sent: string[][] = [];
  const warnings: string[] = [];
  const outcome = await nudgeApprovalCreated(REQUEST_ID, {
    listCandidates: async () => params.candidates,
    isPendingFor: async (me, requestId) => {
      asked.push({ me, requestId });
      return params.pending ? params.pending(me) : true;
    },
    send:
      params.send ??
      (async (subs) => {
        sent.push([...subs]);
        return true;
      }),
    warn: (message) => warnings.push(message),
  });
  return { outcome, asked, sent, warnings };
}

async function main() {
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  const portalUrl = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;

  console.log("\n결재 생성 알림 (포털 쿡 찌르기)\n");

  /* ---------------------------------------------------------------- */
  /* 1. 누구에게 가는가 — 판정은 **남의 것**이다                        */
  /* ---------------------------------------------------------------- */

  await checkAsync("차례인 사람의 포털 번호만 나간다", async () => {
    const { outcome, sent, asked } = await run({
      candidates: [candidate(), candidate({ employeeId: "emp-2", authSub: SUB_B })],
    });
    // 🔵 표본이 비어서 공짜로 통과하지 않게 — 둘을 실제로 물어봤는가.
    assert.equal(asked.length, 2, "후보를 다 물어보지 않았다");
    assert.deepEqual(asked.map((c) => c.requestId), [REQUEST_ID, REQUEST_ID]);
    assert.deepEqual(sent, [[SUB_A, SUB_B]]);
    assert.deepEqual(outcome.nudged, [SUB_A, SUB_B]);
    assert.equal(outcome.delivered, true);
  });

  await checkAsync(
    "🔴 공용 조건이 「네 차례가 아니다」라고 하면 그 사람은 빠진다 — 판정을 새로 짓지 않는다",
    async () => {
      const { outcome, sent, asked } = await run({
        candidates: [candidate(), candidate({ employeeId: "emp-2", authSub: SUB_B })],
        // 옛 직급 단계에서는 같은 직급의 직원이 **전부** 후보로 올라온다.
        // 좁히는 일은 myPendingApprovalWhere 가 한다 — 여기서는 그 답을
        // 따르는지만 본다.
        pending: (me) => me.employeeId === "emp-2",
      });
      assert.equal(asked.length, 2, "후보를 다 물어보지 않았다");
      assert.deepEqual(sent, [[SUB_B]], "공용 조건이 아니라고 한 사람에게도 보냈다");
      assert.deepEqual(outcome.nudged, [SUB_B]);
    },
  );

  await checkAsync("아무도 차례가 아니면 포털을 **아예 부르지 않는다**", async () => {
    // 반려·확정·거둬들이기 뒤에 이 길을 지나는 자리다(workflow.ts 머리말).
    const { outcome, sent } = await run({
      candidates: [candidate()],
      pending: () => false,
    });
    assert.deepEqual(sent, [], "🔴 보낼 것이 없는데 포털을 두드렸다");
    assert.deepEqual(outcome, { nudged: [], missingPortalNumber: [], delivered: false });
  });

  await checkAsync("후보가 하나도 없어도 조용히 끝난다", async () => {
    const { outcome, sent, asked } = await run({ candidates: [] });
    assert.deepEqual(asked, []);
    assert.deepEqual(sent, []);
    assert.deepEqual(outcome, { nudged: [], missingPortalNumber: [], delivered: false });
  });

  await checkAsync(
    "🔴 포털 번호가 없는 사람은 부르지 않고 **로그에 남는다** — 조용히 삼키지 않는다",
    async () => {
      const { outcome, sent, warnings } = await run({
        candidates: [
          candidate({ employeeId: "emp-없는번호", authSub: null }),
          candidate({ employeeId: "emp-2", authSub: SUB_B }),
        ],
      });
      // 번호가 있는 사람은 그대로 나간다 — 한 사람 때문에 묶음이 멈추지 않는다.
      assert.deepEqual(sent, [[SUB_B]]);
      assert.deepEqual(outcome.missingPortalNumber, ["emp-없는번호"]);
      assert.equal(warnings.length, 1, "🔴 아무것도 남기지 않았다 — 영영 안 드러난다");
      assert.ok(warnings[0].includes("emp-없는번호"), warnings[0]);
      assert.ok(warnings[0].includes(REQUEST_ID), "어느 신청인지 남지 않는다");
    },
  );

  await checkAsync("번호 없는 사람 **하나뿐**이면 포털을 부르지 않는다", async () => {
    const { outcome, sent, warnings } = await run({
      candidates: [candidate({ authSub: null })],
    });
    assert.deepEqual(sent, []);
    assert.deepEqual(outcome.missingPortalNumber, ["emp-1"]);
    assert.equal(warnings.length, 1);
  });

  /* ---------------------------------------------------------------- */
  /* 2. 🔴 무슨 일이 있어도 던지지 않는다 — 신청은 이미 저장됐다          */
  /* ---------------------------------------------------------------- */

  await checkAsync("🔴 후보 조회가 던져도 던지지 않는다", async () => {
    const warnings: string[] = [];
    const outcome = await nudgeApprovalCreated(REQUEST_ID, {
      listCandidates: async () => {
        throw new Error("DB 가 끊겼다");
      },
      isPendingFor: async () => true,
      send: async () => true,
      warn: (message) => warnings.push(message),
    });
    assert.deepEqual(outcome, { nudged: [], missingPortalNumber: [], delivered: false });
    assert.equal(warnings.length, 1, "까닭을 남기지 않았다");
    assert.ok(!warnings[0].includes("DB 가 끊겼다"), "오류 메시지를 통째로 찍는다");
  });

  await checkAsync("🔴 공용 조건 조회가 던져도 던지지 않는다", async () => {
    const outcome = await nudgeApprovalCreated(REQUEST_ID, {
      listCandidates: async () => [candidate()],
      isPendingFor: async () => {
        throw new Error("끊겼다");
      },
      send: async () => true,
      warn: () => {},
    });
    assert.deepEqual(outcome, { nudged: [], missingPortalNumber: [], delivered: false });
  });

  await checkAsync("🔴 보내는 쪽이 던져도 던지지 않는다 — 고른 사람은 그대로 남는다", async () => {
    const { outcome, warnings } = await run({
      candidates: [candidate()],
      send: async () => {
        throw new Error("포털이 죽었다");
      },
    });
    assert.deepEqual(outcome.nudged, [SUB_A]);
    assert.equal(outcome.delivered, false);
    assert.equal(warnings.length, 1, "까닭을 남기지 않았다");
    assert.ok(!warnings[0].includes("포털이 죽었다"), "오류 메시지를 통째로 찍는다");
  });

  /* ---------------------------------------------------------------- */
  /* 3. 🔴 보내는 몸통 — 「누구에게 생겼다」 하나뿐이다                   */
  /* ---------------------------------------------------------------- */

  process.env.SSO_ISSUER = portalUrl;

  await checkAsync("🔴 몸통에 결재 **내용이 없다** — approverSub 하나뿐이다", async () => {
    const { ok } = await poke((res) => res.writeHead(204).end());
    assert.equal(ok, true);
    assert.ok(heard, "포털에 닿지 않았다");
    const asked = heard as Heard;

    assert.equal(asked.method, "POST");
    assert.equal(asked.path, "/api/integration/approval-created");
    assert.equal(asked.contentType, "application/x-www-form-urlencoded");
    assert.equal(asked.body, `approverSub=${SUB_A}`);

    // 🔴 결재의 내용은 한 조각도 실리지 않는다. 포털은 받은 번호로 **제 통로로
    //    다시 물어** 보낸다 — 그래야 이 시스템이 거짓을 보내도 메일이 흔들리지
    //    않고, 포털의 「보낸 기록」이 중복을 막는다.
    const fields = [...new URLSearchParams(asked.body).keys()];
    assert.deepEqual([...new Set(fields)], ["approverSub"], `몸통에 다른 칸이 실린다: ${asked.body}`);
    for (const forbidden of ["name", "applicant", "startDate", "endDate", "leaveType", "reason", "days"]) {
      assert.ok(!asked.body.includes(forbidden), `🔴 결재 내용이 실린다: ${forbidden}`);
    }
  });

  await checkAsync("결재자가 여럿이면 approverSub 를 여러 개 싣는다 — 왕복은 한 번", async () => {
    await poke((res) => res.writeHead(204).end(), [SUB_A, SUB_B]);
    const asked = heard as Heard;
    const values = new URLSearchParams(asked.body).getAll("approverSub");
    assert.deepEqual(values, [SUB_A, SUB_B], "🔴 마지막 한 사람만 나갔다(append 가 아니라 set?)");
  });

  await checkAsync("같은 번호가 두 번 실려 와도 한 번만 나간다", async () => {
    await poke((res) => res.writeHead(204).end(), [SUB_A, SUB_A, "", SUB_B]);
    const asked = heard as Heard;
    assert.deepEqual(new URLSearchParams(asked.body).getAll("approverSub"), [SUB_A, SUB_B]);
  });

  await checkAsync("🔴 보낼 번호가 없으면 포털을 두드리지도 않는다", async () => {
    const { ok } = await poke((res) => res.writeHead(204).end(), []);
    assert.equal(ok, false);
    assert.equal(heard, null, "🔴 빈 몸통으로 포털을 두드렸다");
  });

  await checkAsync(
    "🔴 자격증명은 Authorization: Basic 으로만 나간다 — 주소·몸통에 싣지 않는다",
    async () => {
      await poke((res) => res.writeHead(204).end());
      const asked = heard as Heard;
      const authorization = asked.authorization ?? "";
      assert.ok(authorization.startsWith("Basic "), "Basic 머리말이 없다");
      assert.equal(
        Buffer.from(authorization.slice(6), "base64").toString("utf8"),
        `dss-leave:${encodeURIComponent(FAKE_SECRET)}`,
        "자격증명이 client_id:client_secret 이 아니다",
      );
      assert.ok(!asked.path?.includes("?"), "🔴 주소에 질의 문자열이 붙었다");
      assert.ok(!asked.body.includes("client_secret"), "🔴 자격증명이 몸통에 실린다");
    },
  );

  /* ---------------------------------------------------------------- */
  /* 4. 🔴 포털이 죽어도 신청은 저장된다 — 진짜로 두드려 본다             */
  /* ---------------------------------------------------------------- */

  await checkAsync(
    "🔴 통로가 아직 없어 404 가 와도 던지지 않는다 — 다른 조각이 만드는 중이다",
    async () => {
      const { ok, logs } = await poke(status(404));
      assert.equal(ok, false);
      assert.ok(logs.includes("404"), "상태를 남기지 않는다");
      assert.ok(!logs.includes("nope"), "거절 본문을 통째로 찍는다");
    },
  );

  for (const code of [401, 403, 429, 500, 503]) {
    await checkAsync(`🔴 포털이 ${code} 로 거절해도 던지지 않는다`, async () => {
      const { ok, logs } = await poke(status(code));
      assert.equal(ok, false);
      assert.ok(logs.includes(String(code)));
    });
  }

  await checkAsync("🔴 포털에 아예 닿지 못해도 던지지 않는다 (연결 거절)", async () => {
    process.env.SSO_ISSUER = "http://127.0.0.1:1";
    try {
      const { ok, logs } = await poke((res) => res.writeHead(204).end());
      assert.equal(ok, false);
      assert.equal(heard, null, "닿지 못해야 하는데 닿았다");
      assert.ok(logs.length > 0, "까닭을 남기지 않았다");
    } finally {
      process.env.SSO_ISSUER = portalUrl;
    }
  });

  await checkAsync(
    "🔴 포털이 **영영 답하지 않아도** 신청 화면이 멈추지 않는다 — 2초 상한에 걸린다",
    async () => {
      const started = Date.now();
      // 아무 말도 하지 않는다. 상한이 없으면 이 검사가 여기서 멈춘다.
      const { ok } = await poke(() => {});
      const waited = Date.now() - started;
      assert.equal(ok, false);
      assert.ok(waited >= 1500, `상한 전에 돌아왔다(${waited}ms) — 정말 기다렸는지 의심스럽다`);
      assert.ok(waited < 5000, `🔴 ${waited}ms 나 기다렸다 — 상한이 없거나 너무 길다`);
    },
  );

  await checkAsync("🔴 설정이 빠져도 던지지 않는다 — env 의 getter 가 던지는 자리까지 삼킨다", async () => {
    const before = { ...process.env };
    delete process.env.SSO_CLIENT_ID;
    delete process.env.SSO_CLIENT_SECRET;
    try {
      const { ok } = await poke((res) => res.writeHead(204).end());
      assert.equal(ok, false);
    } finally {
      process.env = before;
      process.env.SSO_ISSUER = portalUrl;
    }
  });

  await checkAsync("🔴 자격증명을 로그에 찍지 않는다 — 남는 것은 오류의 종류와 상태뿐이다", async () => {
    const collected: string[] = [];
    collected.push((await poke(status(401))).logs);
    process.env.SSO_ISSUER = "http://127.0.0.1:1";
    collected.push((await poke((res) => res.end())).logs);
    process.env.SSO_ISSUER = portalUrl;

    const all = collected.join("\n");
    assert.ok(all.length > 0, "🔵 로그가 비어 있다 — 아무것도 재지 못했다");
    assert.ok(!all.includes(FAKE_SECRET), "🔴 로그에 시크릿이 딸려 나온다");
    assert.ok(!all.includes("Basic "), "🔴 로그에 Authorization 머리말이 딸려 나온다");
    // 🔴 포털 번호는 사람을 가리키는 값이라 찍지 않는다.
    assert.ok(!all.includes(SUB_A), "🔴 로그에 포털 번호가 딸려 나온다");
  });

  /* ---------------------------------------------------------------- */
  /* 5. 🔴 배선 — 트랜잭션 밖이고, 결재가 생기는 자리 넷 모두에서 부른다   */
  /* ---------------------------------------------------------------- */

  const workflow = withoutComments(read("src/lib/leave/workflow.ts"));

  check("🔴 결재가 생기는 자리 **넷 모두**에서 부른다", () => {
    // 신청·변경(submitLeave) · 취소 신청(submitCancel) · 승인으로 다음 차례가
    // 깨어날 때(decideStep) · 건너뛰기로 다음 차례가 깨어날 때(skipStep).
    // 🔴 반려 뒤 재신청은 **새 신청**이라 submitLeave 로 다시 들어온다.
    const places = [
      "export async function submitLeave",
      "export async function submitCancel",
      "export async function decideStep",
      "export async function skipStep",
    ];
    for (const place of places) {
      const at = workflow.indexOf(place);
      assert.ok(at > 0, `${place} 를 찾지 못했다`);
      const rest = workflow.slice(at);
      const end = rest.indexOf("\nexport ", 1);
      const body = end === -1 ? rest : rest.slice(0, end);
      assert.ok(
        body.includes("await nudgePortalApprovalCreated("),
        `🔴 ${place} 에서 포털을 찌르지 않는다 — 그 길로 생긴 결재만 메일이 늦는다`,
      );
    }
    // 부르는 자리가 정확히 넷이다(함수 정의 한 줄은 `await` 가 없어 안 센다).
    const calls = workflow.match(/await nudgePortalApprovalCreated\(/g) ?? [];
    assert.equal(calls.length, 4, `부르는 자리가 ${calls.length}군데다 — 넷이어야 한다`);
  });

  check("🔴 **트랜잭션 밖**에서 부른다 — 포털이 죽어도 신청은 저장된다", () => {
    // 이 파일의 트랜잭션 몸통은 `db.transaction(async (tx) => {` 안이라 어느
    // 줄이든 **네 칸 이상** 들여쓰여 있다. 함수의 맨 바깥 줄은 두 칸이다.
    // 그래서 「부르는 줄이 전부 두 칸인가」가 곧 「트랜잭션 밖인가」다.
    const lines = workflow.split("\n").filter((line) => line.includes("await nudgePortalApprovalCreated("));
    assert.equal(lines.length, 4, "부르는 줄을 찾지 못했다");
    for (const line of lines) {
      assert.match(
        line,
        /^ {2}await nudgePortalApprovalCreated\([a-zA-Z.]+\);$/,
        `🔴 트랜잭션 안(또는 더 깊은 블록)에서 부른다: ${JSON.stringify(line)}`,
      );
      assert.ok(!line.includes("tx"), "🔴 트랜잭션 손잡이를 넘긴다 — 그것이 곧 안에서 부르는 일이다");
    }
    // 커밋 결과를 확인한 **뒤**여야 한다 — 롤백된 신청을 알리면 안 된다.
    for (const [fn, guard] of [
      ["export async function submitLeave", "if (!result) return fail("],
      ["export async function submitCancel", "if (!result) return fail("],
      ["export async function decideStep", 'if ("error" in outcome)'],
      ["export async function skipStep", 'if ("error" in outcome)'],
    ] as const) {
      const body = workflow.slice(workflow.indexOf(fn));
      assert.ok(
        body.indexOf("await nudgePortalApprovalCreated(") > body.indexOf(guard),
        `🔴 ${fn}: 트랜잭션 결과를 보기 전에 찌른다`,
      );
    }
  });

  check("🔴 포털이 없는 기계에서는 DB 조차 두드리지 않는다", () => {
    const wiring = workflow.slice(workflow.indexOf("async function nudgePortalApprovalCreated"));
    assert.ok(wiring.includes("if (!env.ssoConfigured) return;"));
    assert.ok(
      wiring.indexOf("if (!env.ssoConfigured) return;") < wiring.indexOf("nudgeApprovalCreated("),
      "설정 검사가 뒤에 있다",
    );
  });

  check("🔴 배선이 공용 조회를 **그대로** 넘긴다 — 조건을 다시 적지 않는다", () => {
    assert.ok(workflow.includes("listCandidates: approvalNudgeCandidates"));
    assert.ok(workflow.includes("isPendingFor: hasPendingApprovalFor"));
    assert.ok(workflow.includes("send: notifyPortalApprovalCreated"));

    const data = withoutComments(read("src/lib/leave/data.ts"));
    const at = data.indexOf("export async function hasPendingApprovalFor");
    assert.ok(at > 0, "hasPendingApprovalFor 를 찾지 못했다");
    const rest = data.slice(at);
    const end = rest.indexOf("\nexport ", 1);
    const body = end === -1 ? rest : rest.slice(0, end);
    assert.ok(body.includes("myPendingApprovalWhere(me)"), "공용 조건을 쓰지 않는다");
    assert.equal(
      /eq\(webApprovalSteps\.status/.test(body),
      false,
      "🔴 되묻는 조회가 조건을 손으로 다시 적었다 — 결재함과 어긋날 수 있다",
    );
  });

  await checkAsync(
    "🔴 후보 조회가 **넓다** — 사람으로 박힌 단계와 옛 직급 단계 둘 다 긁고, 좁히지 않는다",
    async () => {
      // 🔴 data.ts 는 불러오는 것만으로 접속 풀을 만든다(db/index.ts) — 맨 위
      //    import 는 tsx 가 끌어올리므로 여기서 들여온다. **붙지는 않는다.**
      const { approvalNudgeCandidates } = await import("../src/lib/leave/data");
      // 🔴 부르기만 하고 **기다리지 않는다.** drizzle 의 질의 만들개는 await
      //    하는 순간에야 DB 에 붙으므로, 여기서는 만들어진 SQL 만 읽는다.
      const built = approvalNudgeCandidates(REQUEST_ID) as unknown as {
        toSQL(): { sql: string; params: unknown[] };
      };
      const { sql, params } = built.toSQL();

      // ① 사람으로 박힌 단계 — 지금 만들어지는 모든 단계가 이것이다.
      assert.ok(
        sql.includes('"web_approval_steps"."approver_employee_id" = "web_employees"."id"'),
        sql,
      );
      // ② 사람 칸이 빈 **옛 단계** — 그 직급의 직원을 전부 긁는다. 🔴 이 갈래가
      //    빠지면 전환 전에 만들어져 아직 대기 중인 단계의 결재자에게 메일을
      //    앞당겨 줄 수 없다(approval-scope.ts 의 그 두 번째 줄과 한 짝이다).
      assert.ok(
        sql.includes(
          '"web_approval_steps"."approver_employee_id" is null and "web_approval_steps"."rank_id" = "web_employees"."rank_id"',
        ),
        sql,
      );
      // ③ 🔴 좁히는 조건은 **하나도** 적지 않는다 — 그것은 공용 조건의 일이다.
      //    여기에 한 줄이라도 적으면 판정이 두 벌이 되고, 좁게 적힌 쪽이
      //    메일이라면 「결재함엔 떴는데 메일이 안 온다」가 된다.
      for (const forbidden of [
        'can_approve" =', // 직급의 결재권으로 거르지 않는다
        "web_leave_requests", // 신청자 제외·신청 상태를 보지 않는다
        '"web_employees"."is_active"', // 직원의 생사를 보지 않는다
        '"web_employees"."is_deleted"',
      ]) {
        assert.ok(!sql.includes(forbidden), `🔴 후보 조회가 제 손으로 좁힌다: ${forbidden}`);
      }
      // ④ 계정 쪽은 거른다 — findPortalActor 와 같은 조건이라야 한다.
      assert.ok(sql.includes('"web_users"."is_active"'), sql);
      assert.ok(sql.includes('"web_users"."is_deleted"'), sql);
      // ⑤ 고르는 것은 이 신청의 **지금 열린 단계**뿐이다.
      assert.ok(params.includes(REQUEST_ID), "신청을 좁히지 않는다");
      assert.ok(params.includes("PENDING"), "열린 단계만 보지 않는다");
    },
  );

  check("🔴 판단 파일에 결재 판정도 망도 없다 — 둘 다 인자로 받는다", () => {
    const judge = withoutComments(read("src/lib/leave/approval-nudge.ts"));
    for (const forbidden of ["drizzle-orm", "db.select", "PENDING", "fetch(", "@/lib/db"]) {
      assert.ok(!judge.includes(forbidden), `판단 파일이 제 손으로 ${forbidden} 를 쓴다`);
    }
    assert.equal(/\bthrow\b/.test(judge), false, "🔴 판단 파일이 던진다 — 신청이 막힌다");
  });

  check("🔴 보내는 통로가 던지지 않고, 상한이 있다", () => {
    const oidc = withoutComments(read("src/lib/auth/oidc.ts"));
    const at = oidc.indexOf("export async function notifyPortalApprovalCreated");
    assert.ok(at > 0, "보내는 함수를 찾지 못했다");
    const body = oidc.slice(at);
    assert.equal(/\bthrow\b/.test(body), false, "🔴 보내는 통로가 던진다");
    assert.ok(body.includes("signal: AbortSignal.timeout(NOTIFICATIONS_TIMEOUT_MS)"), "상한이 없다");
    assert.ok(body.includes('error instanceof Error ? error.name : "unknown"'));
    const limit = oidc.match(/const NOTIFICATIONS_TIMEOUT_MS = (\d+);/);
    assert.ok(limit && Number(limit[1]) > 0 && Number(limit[1]) <= 2000, "상한이 없거나 2초를 넘는다");
  });

  check("🔴 결재 판정·결재선 로직은 그대로다 — 더하기만 했다", () => {
    // 순차의 뼈대가 이 조각에 쓸려 가지 않았는지. 이 넷이 바뀌면 결재가
    // 누구에게 가는지가 달라진다.
    assert.ok(workflow.includes('status: i === 0 ? ("PENDING" as const) : ("WAITING" as const)'));
    assert.ok(workflow.includes("const next = findNextStepToApprove(steps);"));
    assert.ok(workflow.includes("const chain = await approvalChainFor(member.employee, tx);"));
    assert.ok(workflow.includes("const mine = isMyStep(step, {"));
  });

  portal.closeAllConnections();
  await new Promise<void>((resolve) => portal.close(() => resolve()));

  console.log(`\n${passed}개 통과`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
