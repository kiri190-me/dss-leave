/**
 * 개발용 가짜 데이터.  npm run seed:dev
 *
 * - DEV_FAKE_LOGIN_ENABLED=true 인 개발 환경에서만 돈다.
 * - 명단이 비어 있을 때만 넣는다. 기존 데이터를 지우거나 덮어쓰지 않는다.
 * - 이름은 전부 가짜다. 조직 구조(대표·부장·과장·대리 3·사원 2, 실장 제외)만 실제와 같게 맞췄다.
 *   실제 명단은 운영 시작 때 휴가 관리자가 화면에서 입력한다.
 */
import { sql } from "drizzle-orm";

process.loadEnvFile(".env.local");

/** 결재는 순서가 없다. approved = 이미 승인한 결재권자 직급 */
type Outcome =
  | { status: "APPROVED" }
  | { status: "PENDING"; approved: string[] }
  | { status: "REJECTED"; by: string; comment: string; approved?: string[] };

async function main() {
  if (process.env.DEV_FAKE_LOGIN_ENABLED !== "true") {
    throw new Error("개발 환경(DEV_FAKE_LOGIN_ENABLED=true)에서만 가짜 데이터를 넣을 수 있습니다.");
  }

  // .env.local 을 읽은 뒤에 불러와야 DB 주소가 잡힌다
  const { db } = await import("../src/lib/db");
  const s = await import("../src/lib/db/schema");
  const { ensureRanks } = await import("../src/lib/db/base-data");
  const { fakeSubFor } = await import("../src/lib/auth/dev-login");
  const { LEAVE_TYPE_INFO, computeLeaveDays } = await import("../src/lib/leave/rules");

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(s.webEmployees);
  if (n > 0) {
    console.log(`명단에 이미 ${n}명이 있어 아무것도 넣지 않았습니다.`);
    process.exit(0);
  }

  const HOLIDAYS: [string, string][] = [
    ["2026-01-01", "신정"],
    ["2026-02-16", "설날 연휴"],
    ["2026-02-17", "설날"],
    ["2026-02-18", "설날 연휴"],
    ["2026-03-01", "삼일절"],
    ["2026-03-02", "대체공휴일(삼일절)"],
    ["2026-05-01", "근로자의 날"],
    ["2026-05-05", "어린이날"],
    ["2026-05-24", "부처님오신날"],
    ["2026-05-25", "대체공휴일(부처님오신날)"],
    ["2026-06-03", "전국동시지방선거"],
    ["2026-06-06", "현충일"],
    ["2026-08-15", "광복절"],
    ["2026-08-17", "대체공휴일(광복절)"],
    ["2026-09-24", "추석 연휴"],
    ["2026-09-25", "추석"],
    ["2026-09-26", "추석 연휴"],
    ["2026-10-03", "개천절"],
    ["2026-10-05", "대체공휴일(개천절)"],
    ["2026-10-09", "한글날"],
    ["2026-12-25", "성탄절"],
    ["2027-01-01", "신정"],
    ["2027-02-05", "설날 연휴"],
    ["2027-02-06", "설날"],
    ["2027-02-07", "설날 연휴"],
    ["2027-02-08", "대체공휴일(설날)"],
    ["2027-03-01", "삼일절"],
    ["2027-05-01", "근로자의 날"],
    ["2027-05-05", "어린이날"],
    ["2027-05-13", "부처님오신날"],
    ["2027-06-06", "현충일"],
    ["2027-08-15", "광복절"],
    ["2027-08-16", "대체공휴일(광복절)"],
    ["2027-09-14", "추석 연휴"],
    ["2027-09-15", "추석"],
    ["2027-09-16", "추석 연휴"],
    ["2027-10-03", "개천절"],
    ["2027-10-04", "대체공휴일(개천절)"],
    ["2027-10-09", "한글날"],
    ["2027-10-11", "대체공휴일(한글날)"],
    ["2027-12-25", "성탄절"],
    ["2027-12-27", "대체공휴일(성탄절)"],
  ];
  const holidaySet = new Set(HOLIDAYS.map(([d]) => d));

  await db.transaction(async (tx) => {
    // 직급은 **가짜 자료가 아니다** — 기본 자료라 src/lib/db/base-data.ts 가 갖고
    // 있고 npm run seed:ranks 로 따로 넣을 수 있다. 여기서 같은 것을 부르는
    // 이유: 직급을 먼저 넣어 둔 DB 에 이 스크립트를 돌려도 이름 유일 색인에
    // 걸려 터지지 않아야 한다(없는 것만 넣는다).
    // 실장은 결재선에서 빠지고 휴가 관리 대상도 아니라 그 목록에 없다.
    const { ranks } = await ensureRanks(tx);
    const rank = (name: string) => ranks.find((r) => r.name === name)!;

    // 근속 표 — 1~2년차 10일, 3~4년차 11일은 인터뷰 예시. 나머지는 화면을 보기 위한 임시값
    await tx.insert(s.webTenureRules).values([
      { fromYear: 1, toYear: 2, days: 10 },
      { fromYear: 3, toYear: 4, days: 11 },
      { fromYear: 5, toYear: 6, days: 12 },
      { fromYear: 7, toYear: 8, days: 13 },
      { fromYear: 9, toYear: 10, days: 14 },
      { fromYear: 11, toYear: 40, days: 15 },
    ]);

    await tx.insert(s.webHolidays).values(HOLIDAYS.map(([day, name]) => ({ day, name, kind: "PUBLIC" as const })));

    const people: [string, string, string][] = [
      ["윤성호", "대표", "2012-03-02"],
      ["최동욱", "부장", "2016-07-01"],
      ["정민재", "과장", "2019-04-15"],
      ["김서연", "대리", "2021-11-08"],
      ["이준호", "대리", "2022-06-13"],
      ["박지은", "대리", "2023-02-20"],
      ["한도윤", "사원", "2024-09-02"],
      ["송하린", "사원", "2026-03-03"],
    ];
    const employees = await tx
      .insert(s.webEmployees)
      .values(people.map(([name, r, hireDate]) => ({ name, rankId: rank(r).id, hireDate })))
      .returning();
    const emp = (name: string) => employees.find((e) => e.name === name)!;

    const users = await tx
      .insert(s.webUsers)
      .values([
        ...employees.map((e) => ({
          authSub: fakeSubFor(e.name),
          displayName: e.name,
          role: e.name === "김서연" ? ("LEAVE_ADMIN" as const) : ("MEMBER" as const),
          employeeId: e.id,
        })),
        // 명단에 아직 연결되지 않은 계정 (확인 대기 화면·연결 기능을 보기 위한 것)
        { authSub: fakeSubFor("신입 테스트"), displayName: "신입 테스트", role: "MEMBER" as const },
      ])
      .returning();
    const userOf = (name: string) => users.find((u) => u.displayName === name)!;

    /**
     * 결재선 — **순서 있는 사람 목록 하나**다 (2026-09-21: 직급 → 사람).
     * 정민재(과장) → 최동욱(부장) → 윤성호(대표) 로 두면 예전 직급 규칙과
     * 결과가 같다: 사원·대리는 셋 모두에게, 과장은 뒤의 둘에게, 부장은 대표
     * 한 명에게, 대표는 결재 없이.
     */
    const routePeople = ["정민재", "최동욱", "윤성호"].map((name) => emp(name));
    await tx.insert(s.webApprovalRouteSteps).values(
      routePeople.map((e, i) => ({ approverEmployeeId: e.id, stepNo: i + 1 })),
    );
    const rankNameOf = (rankId: string) => ranks.find((r) => r.id === rankId)!.name;

    async function leave(
      name: string,
      leaveType: (typeof s.LEAVE_TYPES)[number],
      startDate: string,
      endDate: string,
      reason: string | null,
      outcome: Outcome,
    ) {
      const e = emp(name);
      // 결재선 안에 있으면 자기 뒤 사람들, 없으면 전원 (rules.ts 의 approversAfter)
      const index = routePeople.findIndex((p) => p.id === e.id);
      const chain = index === -1 ? routePeople : routePeople.slice(index + 1);
      const computed = computeLeaveDays(leaveType, startDate, endDate, holidaySet);
      if (!computed.ok) throw new Error(`${name} ${startDate}: ${computed.error}`);

      const decidedAt = new Date(`${startDate}T00:00:00+09:00`);
      decidedAt.setDate(decidedAt.getDate() - 5);

      const status =
        outcome.status === "APPROVED" ? "APPROVED" : outcome.status === "PENDING" ? "PENDING" : "REJECTED";
      const [req] = await tx
        .insert(s.webLeaveRequests)
        .values({
          employeeId: e.id,
          kind: "NEW",
          leaveType,
          startDate,
          endDate,
          days: computed.days,
          deducts: LEAVE_TYPE_INFO[leaveType].deducts,
          reason,
          status,
          statusNote: outcome.status === "REJECTED" ? outcome.comment : null,
          decidedAt: status === "PENDING" ? null : decidedAt,
          submittedByUserId: userOf(name).id,
        })
        .returning();

      if (chain.length === 0) return;
      await tx.insert(s.webApprovalSteps).values(
        chain.map((approver, i) => {
          const stepNo = i + 1;
          // 이 가짜 데이터의 outcome 은 직급 이름으로 적혀 있다 (결재선의 세
          // 사람이 직급이 서로 달라 사람을 가리키는 것과 같다).
          const rankName = rankNameOf(approver.rankId);
          let stepStatus: (typeof s.STEP_STATUSES)[number];
          if (outcome.status === "APPROVED") stepStatus = "APPROVED";
          else if ((outcome.approved ?? []).includes(rankName)) stepStatus = "APPROVED";
          else if (outcome.status === "REJECTED")
            stepStatus = outcome.by === rankName ? "REJECTED" : "SKIPPED";
          else stepStatus = "PENDING";
          const decided = stepStatus === "APPROVED" || stepStatus === "REJECTED";
          return {
            requestId: req.id,
            stepNo,
            rankId: approver.rankId,
            approverEmployeeId: approver.id,
            status: stepStatus,
            decidedByEmployeeId: decided ? approver.id : null,
            decidedByUserId: decided ? userOf(approver.name).id : null,
            comment: stepStatus === "REJECTED" && outcome.status === "REJECTED" ? outcome.comment : null,
            decidedAt: decided ? decidedAt : null,
          };
        }),
      );
    }

    await leave("이준호", "ANNUAL", "2026-08-20", "2026-08-21", "여름 휴가", { status: "APPROVED" });
    await leave("정민재", "ANNUAL", "2026-06-22", "2026-06-22", null, { status: "APPROVED" });
    await leave("송하린", "ANNUAL", "2026-07-10", "2026-07-10", "개인 사정", { status: "APPROVED" });
    await leave("이준호", "ANNUAL", "2026-09-07", "2026-09-08", "가족 행사", { status: "APPROVED" });
    await leave("박지은", "AM_HALF", "2026-09-11", "2026-09-11", "병원 진료", { status: "APPROVED" });
    await leave("송하린", "HEALTH_CHECK", "2026-09-15", "2026-09-15", "종합건강검진", { status: "APPROVED" });
    await leave("한도윤", "ANNUAL", "2026-09-21", "2026-09-23", "추석 귀성", { status: "PENDING", approved: ["과장"] });
    await leave("정민재", "ANNUAL", "2026-09-28", "2026-09-29", "여행", { status: "PENDING", approved: [] });
    await leave("김서연", "PM_HALF", "2026-09-30", "2026-09-30", "은행 업무", { status: "PENDING", approved: [] });
    await leave("최동욱", "ANNUAL", "2026-10-06", "2026-10-08", "해외 출장 후 휴식", { status: "APPROVED" });
    await leave("윤성호", "ANNUAL", "2026-10-12", "2026-10-12", null, { status: "APPROVED" });
    await leave("박지은", "ANNUAL", "2026-10-19", "2026-10-20", "여행", {
      status: "REJECTED",
      by: "과장",
      comment: "마감 주간이라 다른 날로 부탁드립니다",
    });

    await tx.insert(s.webAuditLogs).values({
      actorName: "seed-dev",
      action: "DEV_SEED",
      summary: "개발용 가짜 데이터 넣음",
    });
  });

  console.log("개발용 가짜 데이터를 넣었습니다.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
