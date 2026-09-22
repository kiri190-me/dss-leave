/**
 * 신청·결재 흐름 검증.  npm run test:workflow
 *
 * 반드시 테스트 전용 DB(dss_leave_test)에서만 돈다. 화면용 개발 DB 를 건드리지 않는다.
 * 테스트 DB 는 새로 만들어 `npm run seed:dev` 로 가짜 데이터를 넣은 상태여야 한다.
 *
 * 🔴 결재는 **한 명씩 차례로** 간다 (2026-09-21): 첫 사람만 PENDING, 뒤는 WAITING 으로 잠들어 있고,
 * 앞사람이 승인·건너뜀으로 닫히면 다음이 깨어난다. 열린 단계(PENDING+WAITING)가 0 이면 확정,
 * 한 명이라도 반려하면 그 자리에서 끝(뒷사람에게 가지 않는다).
 *
 * 🔴 이 파일의 `approveAll` 은 **차례대로** 불러야 한다 — 차례가 아닌 단계는 승인되지 않는다.
 */
import assert from "node:assert/strict";

process.loadEnvFile(".env.local");
if (!process.env.DATABASE_URL?.endsWith("/dss_leave_test")) {
  throw new Error("테스트 전용 DB(…/dss_leave_test)를 DATABASE_URL 로 지정해서 실행하세요.");
}

async function main() {
  const { db } = await import("../src/lib/db");
  const s = await import("../src/lib/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const { loadEmployee } = await import("../src/lib/auth/guards");
  const { canOpenApprovalBox } = await import("../src/lib/leave/approval-scope");
  const wf = await import("../src/lib/leave/workflow");
  const { getBalance, pendingCountFor, pendingForApprover } = await import("../src/lib/leave/data");

  type Member = import("../src/lib/auth/guards").Member;

  async function member(name: string): Promise<Member> {
    const [e] = await db.select().from(s.webEmployees).where(eq(s.webEmployees.name, name));
    const [user] = await db.select().from(s.webUsers).where(eq(s.webUsers.employeeId, e.id));
    const employee = (await loadEmployee(e.id))!;
    // 🔴 화면과 **같은 판정**으로 만든다 (guards.ts 의 getViewer). isApprover 는
    // 직급의 결재권, canOpenApprovals 는 결재함 문 — 둘은 다른 값이다.
    return {
      user,
      employee,
      isAdmin: user.role === "LEAVE_ADMIN",
      isApprover: employee.rank.canApprove,
      canOpenApprovals: canOpenApprovalBox({
        rankCanApprove: employee.rank.canApprove,
        onApprovalRoute: employee.onApprovalRoute,
      }),
    };
  }

  async function reqOf(id: string) {
    const [r] = await db.select().from(s.webLeaveRequests).where(eq(s.webLeaveRequests.id, id));
    return r;
  }
  async function stepsOf(requestId: string) {
    return db.select().from(s.webApprovalSteps).where(eq(s.webApprovalSteps.requestId, requestId));
  }
  /** 이 사람에게 걸린 결재 단계 (상태 무관). 결재선이 사람이 된 뒤로는 사람으로 찾는다 */
  async function stepFor(requestId: string, who: Member) {
    const [st] = await db
      .select()
      .from(s.webApprovalSteps)
      .where(
        and(
          eq(s.webApprovalSteps.requestId, requestId),
          eq(s.webApprovalSteps.approverEmployeeId, who.employee.id),
        ),
      );
    return st ?? null;
  }
  /** 🔴 결재선 차례대로 넘겨야 한다. 순차라 차례가 아닌 단계는 아직 PENDING 이 아니다 */
  async function approveAll(requestId: string, order: Member[]) {
    for (const who of order) {
      const st = await stepFor(requestId, who);
      ok(await wf.decideStep(who, st!.id, true, ""));
    }
  }
  /** 단계를 차례(step_no)대로 늘어놓은 상태 배열 — 「지금 어디까지 왔나」를 한눈에 본다 */
  async function statusesOf(requestId: string): Promise<string[]> {
    const steps = await stepsOf(requestId);
    return steps.sort((a, b) => a.stepNo - b.stepNo).map((x) => x.status);
  }
  function ok<T extends { ok: boolean }>(r: T): asserts r is T & { ok: true } {
    if (!r.ok) throw new Error(`실패: ${JSON.stringify(r)}`);
  }

  const 사원 = await member("한도윤");
  const 대리 = await member("이준호");
  const 관리자 = await member("김서연");
  const 과장 = await member("정민재");
  const 부장 = await member("최동욱");
  const 대표 = await member("윤성호");

  let passed = 0;
  const step = async (name: string, fn: () => Promise<void>) => {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  };

  let newId = "";
  await step("🔴 사원 신청 → 단계 셋을 만들되 첫 사람(정민재)만 지금 차례, 뒤는 WAITING", async () => {
    const r = await wf.submitLeave(사원, { leaveType: "ANNUAL", startDate: "2026-11-02", endDate: "2026-11-03", reason: "테스트" });
    ok(r);
    newId = r.requestId!;
    assert.deepEqual(await statusesOf(newId), ["PENDING", "WAITING", "WAITING"]);
    assert.match(r.message, /먼저 정민재 님이 결재합니다/);
    assert.match(r.message, /정민재 → 최동욱 → 윤성호/);
    assert.equal((await reqOf(newId)).days, 2);
  });

  await step("🔴 차례인 사람의 결재함에만 뜬다 (정민재 ○ · 최동욱·윤성호 ×)", async () => {
    assert.ok((await pendingForApprover(과장)).some((x) => x.id === newId));
    assert.equal((await pendingForApprover(부장)).some((x) => x.id === newId), false);
    assert.equal((await pendingForApprover(대표)).some((x) => x.id === newId), false);
  });

  await step("대리는 결재할 수 없다", async () => {
    const st = await stepFor(newId, 과장);
    assert.equal((await wf.decideStep(대리, st!.id, true, "")).ok, false);
  });

  await step("남의 단계는 결재할 수 없다 (최동욱이 정민재 단계를)", async () => {
    const st = await stepFor(newId, 과장);
    assert.equal((await wf.decideStep(부장, st!.id, true, "")).ok, false);
  });

  // 🔴 뜻이 뒤집힌 옛 시험(「순서 없음: 대표가 먼저 승인해도 된다」)을 지우지 않고
  // 순차용으로 고쳐 쓴다 — 같은 상황을 **반대 결과로** 확인한다.
  await step("🔴 차례가 아니면 승인할 수 없다 (대표가 먼저 눌러도 막힌다)", async () => {
    const st = await stepFor(newId, 대표);
    assert.equal(st!.status, "WAITING");
    assert.equal((await wf.decideStep(대표, st!.id, true, "")).ok, false);
    assert.deepEqual(await statusesOf(newId), ["PENDING", "WAITING", "WAITING"]);
    assert.equal((await reqOf(newId)).status, "PENDING");
  });

  await step("반려는 사유가 있어야 한다", async () => {
    const st = await stepFor(newId, 과장);
    assert.equal((await wf.decideStep(과장, st!.id, false, "  ")).ok, false);
  });

  await step("🔴 앞사람이 승인하면 다음 사람이 깨어난다 (한 명 승인으로는 확정 아님)", async () => {
    const st = await stepFor(newId, 과장);
    const r = await wf.decideStep(과장, st!.id, true, "");
    ok(r);
    assert.equal(r.code, "approved");
    assert.match(r.message, /다음은 최동욱 님 차례입니다/);
    assert.deepEqual(await statusesOf(newId), ["APPROVED", "PENDING", "WAITING"]);
    assert.equal((await reqOf(newId)).status, "PENDING");
    // 결재함도 한 칸 옮겨 간다
    assert.ok((await pendingForApprover(부장)).some((x) => x.id === newId));
    assert.equal((await pendingForApprover(대표)).some((x) => x.id === newId), false);
  });

  await step("🔴 마지막 사람이 승인하면 확정 — 같은 단계를 동시에 두 번 눌러도 한 번만", async () => {
    await approveAll(newId, [부장]);
    assert.deepEqual(await statusesOf(newId), ["APPROVED", "APPROVED", "PENDING"]);

    // 마지막 단계를 두 번 동시에: 단계 행과 신청 행을 잠그므로 하나만 통과한다
    const last = await stepFor(newId, 대표);
    const [a, b] = await Promise.all([
      wf.decideStep(대표, last!.id, true, ""),
      wf.decideStep(대표, last!.id, true, ""),
    ]);
    assert.equal([a, b].filter((x) => x.ok).length, 1);
    assert.equal([a, b].filter((x) => x.ok && x.code === "finished").length, 1);
    assert.deepEqual(await statusesOf(newId), ["APPROVED", "APPROVED", "APPROVED"]);
    assert.equal((await reqOf(newId)).status, "APPROVED");
  });

  await step("같은 결재를 두 번 처리할 수 없다", async () => {
    const st = await stepFor(newId, 대표);
    assert.equal((await wf.decideStep(대표, st!.id, true, "")).ok, false);
  });

  await step("겹치는 날짜는 신청할 수 없다", async () => {
    const r = await wf.submitLeave(사원, { leaveType: "AM_HALF", startDate: "2026-11-03", endDate: "2026-11-03", reason: "" });
    assert.equal(r.ok, false);
  });

  await step("남은 일수보다 많이 신청할 수 없다", async () => {
    const r = await wf.submitLeave(사원, { leaveType: "ANNUAL", startDate: "2026-11-09", endDate: "2026-12-04", reason: "" });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /모자랍니다/);
  });

  let changeId = "";
  await step("결재 후 날짜 변경 → 차례로 다시 결재, 그동안 원래 휴가 유지", async () => {
    const r = await wf.submitLeave(사원, { leaveType: "ANNUAL", startDate: "2026-11-05", endDate: "2026-11-06", reason: "변경" }, newId);
    ok(r);
    changeId = r.requestId!;
    assert.equal((await reqOf(newId)).status, "APPROVED");
    assert.equal((await reqOf(changeId)).status, "PENDING");
    assert.deepEqual(await statusesOf(changeId), ["PENDING", "WAITING", "WAITING"]);
  });

  await step("누구든 한 명이 반려하면 끝, 뒷사람에게 가지 않고 원래 휴가 그대로", async () => {
    await approveAll(changeId, [과장]);
    const st = await stepFor(changeId, 부장);
    ok(await wf.decideStep(부장, st!.id, false, "그 주는 곤란"));
    assert.equal((await reqOf(changeId)).status, "REJECTED");
    // 🔴 반려 뒤에는 열린 단계가 하나도 없어야 한다 — 아직 차례가 오지 않은
    // WAITING(윤성호)까지 정리되지 않으면 그 신청은 끝나고도 결재함에 남는다
    assert.deepEqual(await statusesOf(changeId), ["APPROVED", "REJECTED", "SKIPPED"]);
    assert.equal((await reqOf(newId)).status, "APPROVED");
  });

  await step("변경이 차례로 모두 승인되면 원래 휴가는 '변경됨'", async () => {
    const r = await wf.submitLeave(사원, { leaveType: "ANNUAL", startDate: "2026-11-05", endDate: "2026-11-06", reason: "변경2" }, newId);
    ok(r);
    changeId = r.requestId!;
    await approveAll(changeId, [과장, 부장, 대표]); // 🔴 차례대로만 승인된다
    assert.equal((await reqOf(newId)).status, "SUPERSEDED");
    assert.equal((await reqOf(changeId)).status, "APPROVED");
  });

  await step("결재 후 취소 → 차례로 다시 승인 → 취소됨, 일수 돌려받음", async () => {
    const before = await getBalance(사원.employee);
    const r = await wf.submitCancel(사원, changeId, "일정 취소");
    ok(r);
    assert.equal((await reqOf(changeId)).status, "APPROVED"); // 승인 전까지 유지
    await approveAll(r.requestId!, [과장, 부장, 대표]);
    assert.equal((await reqOf(changeId)).status, "CANCELED");
    const after = await getBalance(사원.employee);
    assert.equal(after.annual.remaining, before.annual.remaining + 2);
  });

  await step("결재 전 신청은 거둬들일 수 있다 (일부 승인된 뒤라도)", async () => {
    const r = await wf.submitLeave(사원, { leaveType: "PM_HALF", startDate: "2026-11-10", endDate: "2026-11-10", reason: "" });
    ok(r);
    await approveAll(r.requestId!, [과장]);
    ok(await wf.withdrawRequest(사원, r.requestId!));
    assert.equal((await reqOf(r.requestId!)).status, "WITHDRAWN");
    // 지금 차례(PENDING)와 뒤에서 기다리던 것(WAITING)이 함께 정리된다
    assert.deepEqual(await statusesOf(r.requestId!), ["APPROVED", "SKIPPED", "SKIPPED"]);
  });

  await step("남의 신청은 거둬들일 수 없다", async () => {
    const r = await wf.submitLeave(사원, { leaveType: "PM_HALF", startDate: "2026-11-11", endDate: "2026-11-11", reason: "" });
    ok(r);
    assert.equal((await wf.withdrawRequest(대리, r.requestId!)).ok, false);
    ok(await wf.withdrawRequest(사원, r.requestId!));
  });

  await step("결재선 안의 사람이 신청하면 자기 뒤만 결재 (정민재 → 최동욱·윤성호)", async () => {
    const r = await wf.submitLeave(과장, { leaveType: "ANNUAL", startDate: "2026-11-16", endDate: "2026-11-16", reason: "" });
    ok(r);
    // 🔴 「자기 뒤만 결재한다」는 규칙(approversAfter)은 순차로 바뀌어도 그대로다
    assert.match(r.message, /먼저 최동욱 님이 결재합니다/);
    assert.match(r.message, /최동욱 → 윤성호/);
    assert.deepEqual(await statusesOf(r.requestId!), ["PENDING", "WAITING"]);
    const st = await stepFor(r.requestId!, 부장);
    assert.equal((await wf.decideStep(과장, st!.id, true, "")).ok, false);
    ok(await wf.withdrawRequest(과장, r.requestId!));
  });

  await step("결재선 맨 끝 사람(윤성호)의 신청은 결재 없이 바로 승인", async () => {
    const r = await wf.submitLeave(대표, { leaveType: "ANNUAL", startDate: "2026-11-20", endDate: "2026-11-20", reason: "" });
    ok(r);
    assert.equal((await reqOf(r.requestId!)).status, "APPROVED");
    assert.equal((await stepsOf(r.requestId!)).length, 0);
  });

  await step("관리자 정정: 휴가를 바로 취소 처리 (사유 필수)", async () => {
    const r = await wf.submitLeave(대리, { leaveType: "ANNUAL", startDate: "2026-11-23", endDate: "2026-11-23", reason: "" });
    ok(r);
    assert.equal((await wf.adminCancel(관리자, r.requestId!, "")).ok, false);
    assert.equal((await wf.adminCancel(대리, r.requestId!, "권한 없음")).ok, false);
    ok(await wf.adminCancel(관리자, r.requestId!, "잘못 신청"));
    assert.equal((await reqOf(r.requestId!)).status, "CANCELED");
  });

  await step("주말만 고르면 신청할 수 없다", async () => {
    const r = await wf.submitLeave(대리, { leaveType: "ANNUAL", startDate: "2026-11-21", endDate: "2026-11-22", reason: "" });
    assert.equal(r.ok, false);
  });

  await step("모양이 틀린 ID 는 DB 오류 대신 '찾을 수 없음'", async () => {
    assert.equal((await wf.withdrawRequest(사원, "not-a-uuid")).ok, false);
    assert.equal((await wf.decideStep(과장, "'; drop table x; --", true, "")).ok, false);
  });

  /* ---------------------------------------------------------------- */
  /* 직급 → 사람 전환에서 지켜야 할 것들 (2026-09-21)                    */
  /* ---------------------------------------------------------------- */

  await step("🔴 전환: 사람 칸이 빈 옛 단계도 결재함에서 사라지지 않는다", async () => {
    const r = await wf.submitLeave(사원, {
      leaveType: "OTHER",
      startDate: "2026-12-07",
      endDate: "2026-12-07",
      reason: "옛 단계",
    });
    ok(r);
    // 사람 기반으로 바뀌기 전에 만들어진 단계처럼 되돌린다 (rank_id 만 있는 행)
    await db
      .update(s.webApprovalSteps)
      .set({ approverEmployeeId: null })
      .where(eq(s.webApprovalSteps.requestId, r.requestId!));

    assert.ok((await pendingForApprover(과장)).some((x) => x.id === r.requestId));
    assert.ok((await pendingCountFor(과장)) > 0);
    // 결재선에 없는 대리(결재권 없는 직급)에게는 여전히 보이지 않는다
    assert.equal((await pendingForApprover(대리)).some((x) => x.id === r.requestId), false);

    // 옛 규칙대로 직급으로 결재된다
    const [st] = await db
      .select()
      .from(s.webApprovalSteps)
      .where(
        and(
          eq(s.webApprovalSteps.requestId, r.requestId!),
          eq(s.webApprovalSteps.rankId, 과장.employee.rankId),
        ),
      );
    assert.equal((await wf.decideStep(부장, st.id, true, "")).ok, false); // 남의 직급 단계
    ok(await wf.decideStep(과장, st.id, true, ""));
    ok(await wf.withdrawRequest(사원, r.requestId!));
  });

  await step("🔴 결재선을 바꿔도 이미 대기 중인 신청의 결재자는 그대로다", async () => {
    const r = await wf.submitLeave(사원, {
      leaveType: "OTHER",
      startDate: "2026-12-08",
      endDate: "2026-12-08",
      reason: "굳힌 결재선",
    });
    ok(r);
    const before = (await stepsOf(r.requestId!)).map((x) => x.approverEmployeeId).sort();

    // 결재선에서 과장을 뺀다
    await db
      .update(s.webApprovalRouteSteps)
      .set({ isDeleted: true, deletedAt: new Date() })
      .where(eq(s.webApprovalRouteSteps.approverEmployeeId, 과장.employee.id));

    assert.deepEqual(
      (await stepsOf(r.requestId!)).map((x) => x.approverEmployeeId).sort(),
      before,
    );
    assert.ok((await pendingForApprover(과장)).some((x) => x.id === r.requestId));

    // 새 신청부터는 두 명이다
    const r2 = await wf.submitLeave(대리, {
      leaveType: "OTHER",
      startDate: "2026-12-09",
      endDate: "2026-12-09",
      reason: "바뀐 뒤",
    });
    ok(r2);
    assert.equal((await stepsOf(r2.requestId!)).length, 2);

    await db
      .update(s.webApprovalRouteSteps)
      .set({ isDeleted: false, deletedAt: null })
      .where(eq(s.webApprovalRouteSteps.approverEmployeeId, 과장.employee.id));
    ok(await wf.withdrawRequest(사원, r.requestId!));
    ok(await wf.withdrawRequest(대리, r2.requestId!));
  });

  await step("🔴 결재선이 비면 결재 없이 바로 등록된다", async () => {
    await db
      .update(s.webApprovalRouteSteps)
      .set({ isDeleted: true, deletedAt: new Date() })
      .where(eq(s.webApprovalRouteSteps.isDeleted, false));

    const r = await wf.submitLeave(사원, {
      leaveType: "OTHER",
      startDate: "2026-12-10",
      endDate: "2026-12-10",
      reason: "결재선 없음",
    });
    ok(r);
    assert.equal(r.code, "auto");
    assert.equal((await reqOf(r.requestId!)).status, "APPROVED");
    assert.equal((await stepsOf(r.requestId!)).length, 0);

    await db
      .update(s.webApprovalRouteSteps)
      .set({ isDeleted: false, deletedAt: null })
      .where(eq(s.webApprovalRouteSteps.isDeleted, true));
  });

  await step("🔴 관리자가 막힌 단계를 건너뛴다 (승인이 아니라 건너뜀으로 남는다)", async () => {
    const r = await wf.submitLeave(사원, {
      leaveType: "OTHER",
      startDate: "2026-12-11",
      endDate: "2026-12-11",
      reason: "결재자 퇴사",
    });
    ok(r);
    const st = await stepFor(r.requestId!, 과장);
    assert.equal((await wf.skipStep(사원, st!.id, "퇴사")).ok, false); // 관리자만
    assert.equal((await wf.skipStep(관리자, st!.id, "  ")).ok, false); // 사유 필수
    // 🔴 아직 차례가 오지 않은 단계는 미리 건너뛸 수 없다 (지금 차례인 것만)
    const 뒷단계 = await stepFor(r.requestId!, 대표);
    assert.equal(뒷단계!.status, "WAITING");
    assert.equal((await wf.skipStep(관리자, 뒷단계!.id, "미리")).ok, false);
    ok(await wf.skipStep(관리자, st!.id, "퇴사"));

    const skipped = (await stepsOf(r.requestId!)).find((x) => x.id === st!.id)!;
    assert.equal(skipped.status, "SKIPPED");
    assert.match(skipped.comment!, /퇴사/);
    assert.equal((await reqOf(r.requestId!)).status, "PENDING"); // 아직 둘 남았다

    // 🔴 건너뛴 뒤에도 **다음 사람이 깨어나야** 한다. 순차에서는 앞사람이 막히면
    // 뒤가 시작조차 못 하므로, 여기서 깨우지 않으면 그 신청은 영영 멈춘다.
    assert.deepEqual(await statusesOf(r.requestId!), ["SKIPPED", "PENDING", "WAITING"]);
    assert.ok((await pendingForApprover(부장)).some((x) => x.id === r.requestId));

    await approveAll(r.requestId!, [부장]);
    const last = await stepFor(r.requestId!, 대표);
    const fin = await wf.decideStep(대표, last!.id, true, "");
    ok(fin);
    assert.equal(fin.code, "finished");
    assert.equal((await reqOf(r.requestId!)).status, "APPROVED");
  });

  await step("🔴 마지막 한 명을 건너뛰면 그 자리에서 확정된다", async () => {
    const r = await wf.submitLeave(부장, {
      leaveType: "OTHER",
      startDate: "2026-12-14",
      endDate: "2026-12-14",
      reason: "마지막 한 명",
    });
    ok(r);
    assert.equal((await stepsOf(r.requestId!)).length, 1); // 부장 뒤에는 대표뿐
    const st = await stepFor(r.requestId!, 대표);
    const done = await wf.skipStep(관리자, st!.id, "장기 부재");
    ok(done);
    assert.equal(done.code, "step-skipped-finished");
    assert.equal((await reqOf(r.requestId!)).status, "APPROVED");
  });

  await step("🔴 직급을 바꿔도 이미 박힌 결재 단계의 주인은 그대로다", async () => {
    // 직원 관리 목록에서 직급을 바로 바꿀 수 있게 한 뒤(2026-09-22) 지키는 것:
    // 직급은 사유 열람 범위만 바꾸고, 결재 단계는 **사람**으로 박혀 있어 흔들리지 않는다.
    const r = await wf.submitLeave(사원, {
      leaveType: "OTHER",
      startDate: "2026-12-15",
      endDate: "2026-12-15",
      reason: "직급 변경",
    });
    ok(r);
    const snapshot = async () =>
      (await stepsOf(r.requestId!))
        .sort((a, b) => a.stepNo - b.stepNo)
        .map((x) => `${x.approverEmployeeId}/${x.rankId}/${x.status}`);
    const before = await snapshot();

    // 지금 차례인 결재자(정민재)를 **결재권 없는 직급**으로 내린다
    await db
      .update(s.webEmployees)
      .set({ rankId: 사원.employee.rankId })
      .where(eq(s.webEmployees.id, 과장.employee.id));
    const 내려간과장 = await member("정민재");
    assert.equal(내려간과장.isApprover, false); // 사유 열람 범위는 실제로 좁아졌다

    // 단계의 사람·직급·차례는 하나도 바뀌지 않고, 결재함에도 그대로 남아 결재된다
    assert.deepEqual(await snapshot(), before);
    assert.ok((await pendingForApprover(내려간과장)).some((x) => x.id === r.requestId));
    const st = await stepFor(r.requestId!, 과장);
    ok(await wf.decideStep(내려간과장, st!.id, true, ""));
    assert.deepEqual(await statusesOf(r.requestId!), ["APPROVED", "PENDING", "WAITING"]);

    // 직급을 되돌리고 신청도 거둬들인다
    await db
      .update(s.webEmployees)
      .set({ rankId: 과장.employee.rankId })
      .where(eq(s.webEmployees.id, 과장.employee.id));
    ok(await wf.withdrawRequest(사원, r.requestId!));
  });

  console.log(`\n${passed}개 통과`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
