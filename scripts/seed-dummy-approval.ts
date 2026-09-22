/**
 * ============================================================================
 * 결재 대기 더미 자료 — 알림 종을 눈으로 확인하기 위한 것
 * ============================================================================
 *
 *   npm run seed:dummy             무엇을 넣을지 **출력만** 한다 (기본값)
 *   npm run seed:dummy -- --apply  실제로 넣는다
 *
 * 왜 있는가: 개발 DB 에 결재 **대기** 단계가 0건이면 A/S 화면의 통합 알림 종에
 * 「내가 결재할 차례다」가 뜰 일이 없어, 그 배선이 도는지 눈으로 볼 수 없다.
 *
 * 🔴 `scripts/seed-dev.ts` 와 **다른 스크립트**다. 그쪽은 명단이 **비어 있을
 * 때만** 도는 데모 자료 한 벌이고(그 안전장치를 건드리지 않았다), 이 스크립트는
 * 이미 사람이 들어 있는 DB 에 **더미만 덧붙인다.**
 *
 * ── 지키는 것 ────────────────────────────────────────────────────────────
 *  · INSERT 만 한다. UPDATE·DELETE·TRUNCATE 가 한 줄도 없다.
 *  · 기존 직원·계정·결재선 설정·직급 표(web_ranks)를 읽기만 한다.
 *  · 스키마를 바꾸지 않는다.
 *  · 이름에 `[더미]` 를 붙여 사람이 골라 지울 수 있게 한다.
 *  · 두 번 돌려도 두 벌이 생기지 않는다 (이름으로 확인한다).
 *  · 🔴 계정(web_users)을 만들지 않는다. 가짜 로그인이 꺼져 있어 쓸 수 없고,
 *    포털 `auth_sub` 를 지어내면 나중에 실제 사람과 부딪힌다. 그래서 신청은
 *    **이 스크립트가 대신** 넣는다 — 더미가 로그인할 필요가 없다.
 *
 * ── 🔴 SQL 을 손으로 쓰지 않는다 ────────────────────────────────────────
 * 신청 하나에는 결재선 펼치기와 차례 세우기(첫 사람만 PENDING, 뒤는 WAITING)가
 * 얽혀 있다. INSERT 를 손으로 적으면 실제 흐름과 다른 자료가 생겨 화면이
 * 「지금 ○○○ 차례」를 거짓으로 적는다. 그래서 화면과 **같은 함수**를 부른다 —
 * `leave/workflow.ts` 의 `submitLeave`(겹침·잔여 검사 → `createWithChain` →
 * 감사 로그까지 그대로 탄다).
 *
 * ── 🔴 신청자 칸(submitted_by_user_id)의 한계 ───────────────────────────
 * 그 칸은 NOT NULL 이고 web_users 를 참조하는데, 더미에게는 계정이 없다(위 참조).
 * 그래서 **이미 있는 계정 하나**(휴가 관리자를 먼저 고른다)를 「대신 넣은 사람」
 * 으로 적는다. 감사 로그의 행위자도 그 사람이 된다. 🔴 더미 자료의 흠이라는 것을
 * 알고 남긴 값이다 — 결재 판정은 이 칸을 보지 않는다(신청자는 employee_id 로
 * 가른다). 지울 때는 아래 되돌리기 SQL 이 감사 로그까지 함께 지운다.
 *
 * ============================================================================
 * 되돌리기 — 🔴 **이 스크립트는 이것을 실행하지 않는다.** 적어 두기만 한다.
 *            사람이 직접 확인하고 돌린다 (psql: npm run db:psql).
 * ============================================================================
 *
 *   BEGIN;
 *
 *   -- 0) 무엇이 지워지는지 먼저 본다
 *   SELECT id, name FROM web_employees WHERE name LIKE '[더미]%';
 *
 *   -- 1) 더미의 신청이 남긴 감사 로그
 *   DELETE FROM web_audit_logs
 *    WHERE entity_type = 'leave_request'
 *      AND entity_id IN (
 *        SELECT id FROM web_leave_requests
 *         WHERE employee_id IN (SELECT id FROM web_employees WHERE name LIKE '[더미]%')
 *      );
 *
 *   -- 2) 결재 단계
 *   DELETE FROM web_approval_steps
 *    WHERE request_id IN (
 *      SELECT id FROM web_leave_requests
 *       WHERE employee_id IN (SELECT id FROM web_employees WHERE name LIKE '[더미]%')
 *    );
 *
 *   -- 3) 신청
 *   DELETE FROM web_leave_requests
 *    WHERE employee_id IN (SELECT id FROM web_employees WHERE name LIKE '[더미]%');
 *
 *   -- 4) 더미 직원
 *   DELETE FROM web_employees WHERE name LIKE '[더미]%';
 *
 *   COMMIT;
 *
 * 🔴 이 더미는 결재선(web_approval_route_steps)에 들어가지 않으므로 그 표는
 *    지울 것이 없다. 직급 표(web_ranks)도 건드리지 않았다.
 * ============================================================================
 */
import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

process.loadEnvFile(".env.local");

/** 이름의 앞머리. 되돌리기 SQL 의 `LIKE '[더미]%'` 와 같은 말이어야 한다. */
const DUMMY_PREFIX = "[더미]";

/**
 * 넣을 더미 직원. 🔴 결재선이 한 단계뿐이라 **직급은 결재에 영향이 없다**
 * (누가 신청하든 결재자는 결재선의 그 사람이다). 화면에 직급 뱃지가 보이게
 * 하려고 서로 다른 둘을 골랐을 뿐이다.
 *
 * 입사일은 **근속 표에 걸리는 값**으로 골랐다. 개발 DB 의 근속 표는 지금
 * 「3~4년차 10일」 한 줄뿐이라, 3~4년차가 아닌 사람은 연차가 0일이고 연차
 * 신청이 「남은 휴가가 모자랍니다」로 막힌다(rules.ts 의 findRule).
 * 근속 표가 바뀌면 이 날짜도 다시 봐야 한다 — 스크립트가 잔여를 미리 찍는다.
 */
const DUMMY_EMPLOYEES = [
  { name: `${DUMMY_PREFIX} 김대리`, rankName: "대리", hireDate: "2023-03-06" },
  { name: `${DUMMY_PREFIX} 박사원`, rankName: "사원", hireDate: "2024-05-02" },
] as const;

/**
 * 넣을 휴가 신청 하나. 🔴 결재 **대기**가 되어야 한다 — 결재선에 사람이 있으면
 * `submitLeave` 가 첫 단계를 PENDING 으로 세운다.
 *
 * 날짜는 주말·공휴일이 아닌 평일 이틀이다(개발 DB 의 공휴일 표는 0행).
 * 두 번 돌리지 않게 「이 더미의 결재 중인 신청이 이미 있는가」로 확인한다.
 */
const DUMMY_REQUEST = {
  by: `${DUMMY_PREFIX} 김대리`,
  leaveType: "ANNUAL",
  startDate: "2026-10-13",
  endDate: "2026-10-14",
  reason: `${DUMMY_PREFIX} 결재 알림 확인용 — 지워도 됩니다`,
} as const;

function line(text = "") {
  console.log(text);
}

async function main() {
  const apply = process.argv.includes("--apply");

  /* ---------------------------------------------------------------- */
  /* 안전 확인 — 어느 DB 인가                                          */
  /* ---------------------------------------------------------------- */
  const url = process.env.DATABASE_URL ?? "";
  // 🔴 주소를 찍지 않는다(비밀번호가 들어 있다). 볼 것은 호스트와 DB 이름뿐이다.
  const parsed = (() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  })();
  if (!parsed) throw new Error("DATABASE_URL 을 읽을 수 없습니다.");
  const dbName = parsed.pathname.replace(/^\//, "");
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error(
      `개발 PC 의 DB 상자(127.0.0.1)에서만 돌립니다. 지금 가리키는 곳: ${parsed.hostname}`,
    );
  }
  if (dbName === "dss_leave_test") {
    throw new Error(
      "시험 전용 DB(dss_leave_test)에는 넣지 않습니다 — test:workflow 가 그 DB 를 비우고 다시 채웁니다.",
    );
  }

  // .env.local 을 읽은 뒤에 불러와야 DB 주소가 잡힌다 (seed-dev.ts 와 같다)
  const { db } = await import("../src/lib/db");
  const s = await import("../src/lib/db/schema");
  const { loadEmployee } = await import("../src/lib/auth/guards");
  const { canOpenApprovalBox } = await import("../src/lib/leave/approval-scope");
  const {
    approvalChainFor,
    getBalance,
    loadApprovalRoute,
    pendingApprovalNotifications,
  } = await import("../src/lib/leave/data");
  const { submitLeave } = await import("../src/lib/leave/workflow");
  const { findPortalActor } = await import("../src/lib/auth/portal-actor");
  const { buildPortalNotificationFeed } = await import("../src/lib/leave/portal-notifications");

  type Member = import("../src/lib/auth/guards").Member;

  /** 전후 비교용 표별 개수. 🔴 읽기만 한다 (count) */
  const TABLES: readonly (readonly [string, PgTable])[] = [
    ["web_employees", s.webEmployees],
    ["web_users", s.webUsers],
    ["web_approval_route_steps", s.webApprovalRouteSteps],
    ["web_leave_requests", s.webLeaveRequests],
    ["web_approval_steps", s.webApprovalSteps],
    ["web_leave_adjustments", s.webLeaveAdjustments],
    ["web_audit_logs", s.webAuditLogs],
    ["web_ranks", s.webRanks],
  ];
  const counts = async (): Promise<Record<string, number>> => {
    const pairs = await Promise.all(
      TABLES.map(async ([label, table]) => {
        const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table);
        return [label, row.n] as const;
      }),
    );
    return Object.fromEntries(pairs);
  };

  const before = await counts();

  line("=".repeat(70));
  line(apply ? "결재 대기 더미 넣기 — 실제로 넣습니다 (--apply)" : "결재 대기 더미 미리보기 — 아무것도 넣지 않습니다");
  line(`DB: ${dbName} @ ${parsed.hostname}:${parsed.port || "5432"}`);
  line("=".repeat(70));

  line();
  line("[지금 표별 개수]");
  for (const [table, n] of Object.entries(before)) line(`  ${table.padEnd(26)} ${n}`);

  /* ---------------------------------------------------------------- */
  /* 읽기 — 직급 · 결재선 · 이미 있는 더미 · 대신 넣을 계정             */
  /* ---------------------------------------------------------------- */
  const ranks = await db.select().from(s.webRanks).where(eq(s.webRanks.isDeleted, false));
  const rankOf = (name: string) => ranks.find((r) => r.name === name) ?? null;

  const route = await loadApprovalRoute();
  line();
  line("[결재선 — 읽기만 한다]");
  if (route.length === 0) {
    line("  (비어 있다) 🔴 결재선이 비면 신청이 결재 없이 바로 승인되어 대기 단계가 생기지 않는다.");
  } else {
    for (const m of route) {
      line(
        `  ${m.stepNo}. ${m.name} (${m.rankName}, 직급 결재권 ${m.rankCanApprove ? "있음" : "없음"}` +
          `${m.active ? "" : ", 퇴사·삭제"})`,
      );
    }
  }

  const existing = await db
    .select({ id: s.webEmployees.id, name: s.webEmployees.name, isDeleted: s.webEmployees.isDeleted })
    .from(s.webEmployees)
    .where(like(s.webEmployees.name, `${DUMMY_PREFIX}%`));
  const existingByName = new Map(existing.map((e) => [e.name, e]));

  // 「대신 넣은 사람」으로 적을 계정. 휴가 관리자를 먼저 고른다 (머리말 참조)
  const candidateUsers = await db
    .select()
    .from(s.webUsers)
    .where(and(eq(s.webUsers.isActive, true), eq(s.webUsers.isDeleted, false)));
  const proxyUser =
    candidateUsers.find((u) => u.role === "LEAVE_ADMIN") ?? candidateUsers[0] ?? null;

  /* ---------------------------------------------------------------- */
  /* 계획 출력                                                         */
  /* ---------------------------------------------------------------- */
  line();
  line("[넣을 더미 직원]");
  const toInsert: { name: string; rankId: string; hireDate: string }[] = [];
  for (const d of DUMMY_EMPLOYEES) {
    const already = existingByName.get(d.name);
    const rank = rankOf(d.rankName);
    if (already) {
      line(`  건너뜀  ${d.name} — 이미 있다 (${already.id})`);
      continue;
    }
    if (!rank) {
      throw new Error(
        `직급 「${d.rankName}」이 없습니다. 🔴 직급 표는 이 스크립트가 만들지 않습니다 — npm run seed:ranks 로 먼저 넣으세요.`,
      );
    }
    line(`  INSERT  web_employees  ${d.name} / 직급 ${d.rankName} / 입사 ${d.hireDate}`);
    toInsert.push({ name: d.name, rankId: rank.id, hireDate: d.hireDate });
  }
  if (toInsert.length === 0) line("  (넣을 것이 없다 — 두 명 다 이미 있다)");

  line();
  line("[넣을 휴가 신청]");
  line(`  신청자   ${DUMMY_REQUEST.by}`);
  line(`  휴가     ${DUMMY_REQUEST.leaveType} ${DUMMY_REQUEST.startDate} ~ ${DUMMY_REQUEST.endDate}`);
  line(`  사유     ${DUMMY_REQUEST.reason}`);
  line(
    `  대신 넣는 계정  ${proxyUser ? `${proxyUser.displayName} (${proxyUser.role})` : "🔴 없다"}` +
      "  ← submitted_by_user_id · 감사 로그 행위자",
  );
  if (!proxyUser) {
    throw new Error(
      "쓸 수 있는 계정이 web_users 에 하나도 없습니다. 🔴 이 스크립트는 계정을 만들지 않습니다.",
    );
  }

  // 이 더미의 결재 중인 신청이 이미 있는가 (두 번 돌려도 두 벌이 되지 않게)
  const dummyIds = existing.map((e) => e.id);
  const openRequests =
    dummyIds.length === 0
      ? []
      : await db
          .select({ id: s.webLeaveRequests.id, status: s.webLeaveRequests.status })
          .from(s.webLeaveRequests)
          .where(
            and(
              inArray(s.webLeaveRequests.employeeId, dummyIds),
              eq(s.webLeaveRequests.isDeleted, false),
              eq(s.webLeaveRequests.status, "PENDING"),
            ),
          );
  const requestAlreadyThere = openRequests.length > 0;
  if (requestAlreadyThere) {
    line(`  건너뜀   더미의 결재 중인 신청이 이미 ${openRequests.length}건 있다 (${openRequests[0].id})`);
  } else {
    line("  INSERT  web_leave_requests + web_approval_steps  ← submitLeave() 가 만든다");
    if (route.length > 0) {
      line(`          결재선대로 ${route.length}단계, 첫 단계만 PENDING · 나머지 WAITING`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* 미리보기면 여기서 끝                                              */
  /* ---------------------------------------------------------------- */
  if (!apply) {
    line();
    line("─".repeat(70));
    line("미리보기였습니다. 아무것도 넣지 않았습니다.");
    line("실제로 넣으려면:  npm run seed:dummy -- --apply");
    line("─".repeat(70));
    process.exit(0);
  }

  /* ---------------------------------------------------------------- */
  /* 넣기 — 🔴 INSERT 만                                              */
  /* ---------------------------------------------------------------- */
  if (toInsert.length > 0) {
    await db.transaction(async (tx) => {
      await tx.insert(s.webEmployees).values(toInsert);
    });
    line();
    line(`직원 ${toInsert.length}명을 넣었습니다.`);
  }

  if (!requestAlreadyThere) {
    const [applicant] = await db
      .select({ id: s.webEmployees.id })
      .from(s.webEmployees)
      .where(
        and(eq(s.webEmployees.name, DUMMY_REQUEST.by), eq(s.webEmployees.isDeleted, false)),
      );
    if (!applicant) throw new Error(`${DUMMY_REQUEST.by} 를 찾을 수 없습니다.`);
    const employee = await loadEmployee(applicant.id);
    if (!employee) throw new Error(`${DUMMY_REQUEST.by} 를 읽을 수 없습니다.`);

    // 화면과 **같은 판정**으로 Member 를 만든다 (guards.ts 의 getViewer)
    const member: Member = {
      user: proxyUser,
      employee,
      isAdmin: proxyUser.role === "LEAVE_ADMIN",
      isApprover: employee.rank.canApprove,
      canOpenApprovals: canOpenApprovalBox({
        rankCanApprove: employee.rank.canApprove,
        onApprovalRoute: employee.onApprovalRoute,
      }),
    };

    const balance = await getBalance(employee);
    line(
      `${employee.name} 잔여: 연차 ${balance.annual.remaining}일 ` +
        `(부여 ${balance.annual.total}일, ${balance.annual.entitlement.status})`,
    );
    const chain = await approvalChainFor(employee);
    line(`결재선대로 결재할 사람: ${chain.length === 0 ? "(없다)" : chain.map((a) => a.name).join(" → ")}`);

    const result = await submitLeave(member, {
      leaveType: DUMMY_REQUEST.leaveType,
      startDate: DUMMY_REQUEST.startDate,
      endDate: DUMMY_REQUEST.endDate,
      reason: DUMMY_REQUEST.reason,
    });
    if (!result.ok) throw new Error(`신청이 거절됐습니다: ${result.error}`);
    line(`신청을 넣었습니다: ${result.message}`);
  }

  /* ---------------------------------------------------------------- */
  /* 넣은 뒤 확인 — 읽기만                                             */
  /* ---------------------------------------------------------------- */
  const after = await counts();
  line();
  line("[표별 개수 — 넣기 전 → 넣은 뒤]");
  for (const [table, n] of Object.entries(after)) {
    const was = before[table];
    line(`  ${table.padEnd(26)} ${String(was).padStart(4)} → ${String(n).padStart(4)}${was === n ? "" : "  ←"}`);
  }

  const steps = await db
    .select({
      requestId: s.webApprovalSteps.requestId,
      stepNo: s.webApprovalSteps.stepNo,
      status: s.webApprovalSteps.status,
      approverEmployeeId: s.webApprovalSteps.approverEmployeeId,
      approverName: s.webEmployees.name,
    })
    .from(s.webApprovalSteps)
    .leftJoin(s.webEmployees, eq(s.webEmployees.id, s.webApprovalSteps.approverEmployeeId))
    .orderBy(asc(s.webApprovalSteps.stepNo));
  line();
  line("[결재 단계 전부 (web_approval_steps)]");
  for (const st of steps) {
    line(
      `  단계 ${st.stepNo}  ${st.status.padEnd(8)}  결재자 ${st.approverName ?? "(사람 칸 빔 — 옛 단계)"}  ` +
        `approver_employee_id=${st.approverEmployeeId ?? "null"}`,
    );
  }

  /**
   * 🔴 「지금 내 차례」로 실제로 잡히는가. 알림 종이 쓰는 **그 질의**를 그대로
   * 부른다 (data.ts 의 pendingApprovalNotifications → myPendingApprovalWhere).
   * 옛 직급 단계 갈래까지 화면과 같게 보려고 isApprover 도 화면과 같이 만든다.
   */
  line();
  line("[알림 건수 — 결재함·종이 쓰는 같은 질의로]");
  const routeNow = await loadApprovalRoute();
  for (const m of routeNow.filter((x) => x.active)) {
    const emp = await loadEmployee(m.employeeId);
    if (!emp) continue;
    const rows = await pendingApprovalNotifications({
      employeeId: emp.id,
      rankId: emp.rankId,
      isApprover: emp.rank.canApprove,
    });
    line(`  ${emp.name}: ${rows.length}건`);
    for (const r of rows) {
      line(`     · ${r.applicantName} ${r.kind}/${r.leaveType} ${r.startDate}~${r.endDate} (${r.days}일)`);
    }
    line(
      `     결재함 문(canOpenApprovals): ${
        canOpenApprovalBox({
          rankCanApprove: emp.rank.canApprove,
          onApprovalRoute: emp.onApprovalRoute,
        })
          ? "열린다"
          : "닫힌다"
      }  (직급 결재권 ${emp.rank.canApprove ? "있음" : "없음"} · 결재선 ${emp.onApprovalRoute ? "올라 있음" : "없음"})`,
    );
  }

  /**
   * 🔴 포털이 물어 올 때 **실제로 답할 값**. 알림 통로(route)가 토큰에서 sub 를
   * 꺼낸 뒤 부르는 그 함수를 그대로 부른다 — 토큰 검증과 HTTP 만 빼고 같은 길이다
   * (leave/portal-notifications.ts 의 buildPortalNotificationFeed).
   * 여기 숫자가 통합 알림 종의 배지에 찍힌다.
   */
  line();
  line("[포털에 내줄 알림 — 통로가 부르는 그 함수로]");
  const accounts = await db
    .select({ authSub: s.webUsers.authSub, displayName: s.webUsers.displayName })
    .from(s.webUsers)
    .where(and(eq(s.webUsers.isActive, true), eq(s.webUsers.isDeleted, false)));
  for (const acc of accounts) {
    const feed = await buildPortalNotificationFeed({
      subject: acc.authSub,
      baseUrl: "http://127.0.0.1:3700",
      findActor: findPortalActor,
      listPendingApprovals: pendingApprovalNotifications,
    });
    line(`  ${acc.displayName}: count=${feed.count}`);
    for (const it of feed.items) line(`     · ${it.subject} — ${it.detail}`);
  }

  line();
  line("끝났습니다. 되돌리는 SQL 은 이 파일 머리말에 있습니다 (🔴 실행하지 않았습니다).");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
