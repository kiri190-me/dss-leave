import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ */
/* 코드값 정의                                                          */
/* DB 에는 영문 코드를 저장하고, 화면 글자는 src/lib/leave/labels.ts 에서 */
/* ------------------------------------------------------------------ */

/**
 * 이 사이트 안에서의 역할.
 * 누가 결재하는지는 역할도 직급도 아닌 **결재선**(web_approval_route_steps)이
 * 정한다 (2026-09-21 변경).
 */
export const USER_ROLES = [
  "MEMBER", // 직원 — 신청·달력·내 휴가
  "LEAVE_ADMIN", // 휴가 관리자 — 직원 명단·입사일·근속 표·공휴일·일수 조정
] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * 휴가 종류. 성질이 **셋**이다 (2026-10-08 여름휴가가 들어오면서 둘에서 셋이 됐다):
 * 연차에서 깎는 것 · **여름휴가(제 잔액)** · 어디서도 깎지 않는 것.
 * 어느 잔액에서 빠지는지는 `src/lib/leave/rules.ts` 의 LEAVE_TYPE_INFO.pool 이 정한다.
 *
 * 🔴 DB 쪽은 그냥 text 다 (PG enum 이 아니다) — 종류를 더해도 마이그레이션이 없다.
 */
export const LEAVE_TYPES = [
  "ANNUAL", // 연차 1일
  "AM_HALF", // 오전 반차 0.5일
  "PM_HALF", // 오후 반차 0.5일
  "SUMMER", // 여름휴가 1일 (연차와 별개인 제 잔액. 반차 없음)
  "CONDOLENCE", // 경조사 (차감 없음)
  "HEALTH_CHECK", // 건강검진 (차감 없음)
  "RESERVE", // 예비군·민방위 (차감 없음)
  "OTHER", // 기타 (차감 없음)
] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

/**
 * 신청의 종류.
 * 결재가 끝난 휴가를 바꾸거나 취소할 때는 원래 행을 고치지 않고
 * 그 휴가를 가리키는 새 신청(CHANGE · CANCEL)을 만들어 다시 결재받는다.
 */
export const REQUEST_KINDS = ["NEW", "CHANGE", "CANCEL"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const REQUEST_STATUSES = [
  "PENDING", // 결재 중
  "APPROVED", // 승인 (CANCEL 신청이면 '취소가 승인됨')
  "REJECTED", // 반려
  "WITHDRAWN", // 결재 전에 신청자가 거둬들임
  "CANCELED", // 결재 후 취소됨 (취소 결재 승인 또는 관리자 정정)
  "SUPERSEDED", // 날짜 변경이 승인되어 새 신청으로 대체됨
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/**
 * 결재 단계 상태. 결재는 **한 명씩 차례로** 간다 (2026-09-21 변경.
 * 2026-09-18 ~ 09-21 사이에만 순서 없이 동시에 갔다).
 * 신청하면 첫 단계만 PENDING, 나머지는 WAITING 으로 잠들어 있다가
 * 앞사람이 승인·건너뜀으로 닫히면 하나씩 깨어난다 (leave/workflow.ts).
 */
export const STEP_STATUSES = [
  "WAITING", // 앞사람 결재를 기다림 (아직 이 사람 결재함에 뜨지 않는다)
  "PENDING", // 지금 이 사람 차례 — 결재함에 떠 있다
  "APPROVED",
  "REJECTED",
  "SKIPPED", // 반려·취소로 더 진행하지 않음
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** 일수 조정이 어느 쪽에 붙는가 */
export const ADJUSTMENT_BUCKETS = [
  "ANNUAL", // 그해 연차 (year 필수)
  "MONTHLY", // 입사 1년 미만 월차
] as const;
export type AdjustmentBucket = (typeof ADJUSTMENT_BUCKETS)[number];

export const HOLIDAY_KINDS = [
  "PUBLIC", // 공휴일
  "COMPANY", // 회사 휴무일 (창립기념일 등)
] as const;
export type HolidayKind = (typeof HOLIDAY_KINDS)[number];

/* ------------------------------------------------------------------ */
/* 공통 컬럼                                                            */
/* ------------------------------------------------------------------ */

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

/** 소프트 삭제 4컬럼 — 이름과 개수가 고정이다. 물리 삭제는 하지 않는다. */
const softDelete = {
  isDeleted: boolean("is_deleted").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
  deleteReason: text("delete_reason"),
};

/**
 * 날짜는 'YYYY-MM-DD' 글자로 주고받는다.
 * Date 객체로 바꾸면 서버(NAS 컨테이너)와 PC 의 시간대가 다를 때 하루씩 밀린다.
 */
const day = (name: string) => date(name, { mode: "string" });

/** 휴가 일수. 반차가 있어 소수 한 자리까지. */
const days = (name: string) =>
  numeric(name, { precision: 5, scale: 1, mode: "number" });

/* ------------------------------------------------------------------ */
/* web_ranks — 직급. 표시 순서와 '휴가 사유를 볼 수 있는 범위'            */
/* ------------------------------------------------------------------ */

export const webRanks = pgTable(
  "web_ranks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** 클수록 높은 직급. 목록을 늘어놓는 차례로 쓴다. */
    sortOrder: integer("sort_order").notNull(),
    /**
     * 🔴 2026-09-21 이후 이 칸은 **결재선을 정하지 않는다** (결재선은
     * web_approval_route_steps 의 사람 목록이다). 남아서 하는 일은 둘이다:
     * 휴가 사유를 볼 수 있는가(guards.ts 의 canSeeReason)와 머리말에
     * 「결재함」 메뉴가 보이는가.
     */
    canApprove: boolean("can_approve").notNull().default(false),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex("web_ranks_name_uq")
      .on(t.name)
      .where(sql`${t.isDeleted} = false`),
    index("web_ranks_alive_idx")
      .on(t.sortOrder)
      .where(sql`${t.isDeleted} = false`),
  ],
);

/* ------------------------------------------------------------------ */
/* web_employees — 직원 명단 (휴가 관리 대상)                           */
/* 로그인 계정(web_users)과는 따로다. 관리자가 둘을 연결한다.            */
/* ------------------------------------------------------------------ */

export const webEmployees = pgTable(
  "web_employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    rankId: uuid("rank_id")
      .notNull()
      .references(() => webRanks.id),
    /** 입사일. 연차·월차 자동 계산의 기준 */
    hireDate: day("hire_date").notNull(),
    /** 재직 중인가. 퇴사자는 false (기록은 남긴다) */
    isActive: boolean("is_active").notNull().default(true),
    note: text("note"),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index("web_employees_alive_idx")
      .on(t.rankId)
      .where(sql`${t.isDeleted} = false`),
  ],
);

/* ------------------------------------------------------------------ */
/* web_users — 이 사이트의 로그인 계정                                   */
/* dss-auth 의 users 테이블과는 별개다. auth_sub 로만 이어진다.          */
/* ------------------------------------------------------------------ */

export const webUsers = pgTable(
  "web_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** dss-auth ID 토큰의 sub (= dss-auth users.id). 사람의 영구 식별자. */
    authSub: uuid("auth_sub").notNull(),

    /** 화면 표시용. 로그인할 때마다 최신값으로 갱신한다. */
    displayName: text("display_name").notNull(),

    /** 화면 표시용. 카카오에서 이메일은 선택 동의라 없을 수 있다. */
    email: text("email"),

    role: text("role", { enum: USER_ROLES }).notNull().default("MEMBER"),

    /**
     * 명단의 어느 직원인가. 처음 로그인하면 비어 있고(확인 대기),
     * 휴가 관리자가 연결해 줘야 쓸 수 있다.
     */
    employeeId: uuid("employee_id").references(() => webEmployees.id),

    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex("web_users_auth_sub_uq").on(t.authSub),
    /** 직원 한 명에 계정 하나 */
    uniqueIndex("web_users_employee_uq")
      .on(t.employeeId)
      .where(sql`${t.isDeleted} = false and ${t.employeeId} is not null`),
    index("web_users_alive_idx")
      .on(t.role)
      .where(sql`${t.isDeleted} = false`),
  ],
);

/* ------------------------------------------------------------------ */
/* web_sessions — 이 사이트 전용 세션 (서버 저장형)                      */
/* 쿠키에는 랜덤 토큰 원문, DB 에는 그 sha256 만 둔다.                    */
/* ------------------------------------------------------------------ */

export const webSessions = pgTable(
  "web_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => webUsers.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("web_sessions_token_hash_uq").on(t.tokenHash),
    index("web_sessions_user_idx").on(t.userId),
    index("web_sessions_expires_idx").on(t.expiresAt),
  ],
);

/* ------------------------------------------------------------------ */
/* web_tenure_rules — 근속 연차별 부여 일수 (관리자가 등록)              */
/* 예: 1~2년차 10일, 3~4년차 11일. 근속은 만 12개월 = 1년                */
/* ------------------------------------------------------------------ */

export const webTenureRules = pgTable(
  "web_tenure_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromYear: integer("from_year").notNull(),
    toYear: integer("to_year").notNull(),
    days: days("days").notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    check(
      "web_tenure_rules_range_ck",
      sql`${t.fromYear} >= 1 and ${t.toYear} >= ${t.fromYear}`,
    ),
    index("web_tenure_rules_alive_idx")
      .on(t.fromYear)
      .where(sql`${t.isDeleted} = false`),
  ],
);

/* ------------------------------------------------------------------ */
/* web_leave_settings — 회사 전체 휴가 설정 (줄 하나짜리 표)             */
/* 2026-10-08 여름휴가가 들어오면서 처음 생겼다 — 그전에는 전역 설정을    */
/* 담을 자리가 없었다                                                    */
/* ------------------------------------------------------------------ */

/**
 * 🔴 이 표에는 줄이 **하나뿐**이다. 설정은 회사 전체 하나이고 사람마다·해마다
 * 다르지 않다 (사용자 결정 2026-10-08). 그래서 id 를 1 로 못 박고 check 로
 * 지킨다 — 두 번째 줄이 들어가면 「어느 줄이 진짜인가」를 아무도 답할 수 없다.
 *
 * 🔴 줄이 **아직 없어도 된다.** 읽는 쪽(data.ts 의 loadLeaveSettings)이 기본값을
 * 돌려준다 (rules.ts 의 DEFAULT_SUMMER_DAYS = 3). 운영 시작 전이라 관리자가
 * 설정 화면에 한 번도 들어가지 않았을 수 있다.
 *
 * 소프트 삭제 칸이 없다 — 지우는 줄이 아니라 **고치는 줄**이다.
 */
export const LEAVE_SETTINGS_ROW_ID = 1;

export const webLeaveSettings = pgTable(
  "web_leave_settings",
  {
    id: integer("id").primaryKey().default(LEAVE_SETTINGS_ROW_ID),
    /** 여름휴가 — 직원 한 명이 한 연차 연도에 받는 일수. 반차가 없어 정수로 쓴다 */
    summerDays: days("summer_days").notNull().default(3),
    ...timestamps,
  },
  (t) => [
    // 🔴 상수를 `${}` 로 끼우면 drizzle 이 **바인딩 자리($1)**로 굽는다 —
    //    마이그레이션 SQL 이 그대로 깨진다. 글자로 적는다 (= LEAVE_SETTINGS_ROW_ID).
    check("web_leave_settings_singleton_ck", sql`${t.id} = 1`),
    check("web_leave_settings_summer_days_ck", sql`${t.summerDays} >= 0`),
  ],
);

/* ------------------------------------------------------------------ */
/* web_holidays — 공휴일·회사 휴무일. 휴가 일수 계산에서 뺀다            */
/* ------------------------------------------------------------------ */

export const webHolidays = pgTable(
  "web_holidays",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    day: day("day").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: HOLIDAY_KINDS }).notNull().default("PUBLIC"),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex("web_holidays_day_uq")
      .on(t.day)
      .where(sql`${t.isDeleted} = false`),
  ],
);

/* ------------------------------------------------------------------ */
/* web_leave_requests — 휴가 신청 (중심 테이블)                         */
/* ------------------------------------------------------------------ */

export const webLeaveRequests = pgTable(
  "web_leave_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => webEmployees.id),

    kind: text("kind", { enum: REQUEST_KINDS }).notNull().default("NEW"),
    /** CHANGE · CANCEL 일 때 대상이 되는 원래 휴가 */
    targetRequestId: uuid("target_request_id").references(
      (): AnyPgColumn => webLeaveRequests.id,
    ),

    leaveType: text("leave_type", { enum: LEAVE_TYPES }).notNull(),
    startDate: day("start_date").notNull(),
    endDate: day("end_date").notNull(),
    /** 주말·공휴일을 뺀 일수 (반차 0.5). 차감 없는 휴가도 기간 표시용으로 센다 */
    days: days("days").notNull(),
    /** 연차에서 빠지는가 (연차·반차만 true) */
    deducts: boolean("deducts").notNull(),

    /** 사유. 본인과 결재권자에게만 보인다 */
    reason: text("reason"),

    status: text("status", { enum: REQUEST_STATUSES })
      .notNull()
      .default("PENDING"),
    /** 반려·관리자 정정 등 상태가 바뀐 사유 */
    statusNote: text("status_note"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),

    submittedByUserId: uuid("submitted_by_user_id")
      .notNull()
      .references(() => webUsers.id),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    check("web_leave_requests_range_ck", sql`${t.endDate} >= ${t.startDate}`),
    index("web_leave_requests_employee_idx")
      .on(t.employeeId, t.startDate)
      .where(sql`${t.isDeleted} = false`),
    index("web_leave_requests_period_idx")
      .on(t.startDate, t.endDate)
      .where(sql`${t.isDeleted} = false`),
    index("web_leave_requests_target_idx").on(t.targetRequestId),
  ],
);

/* ------------------------------------------------------------------ */
/* web_approval_route_steps — 결재선 (순서 있는 사람 목록 하나)          */
/* 2026-09-21: 결재권자를 직급이 아니라 **사람**으로 정한다 (사용자 결정) */
/* ------------------------------------------------------------------ */

/**
 * 회사에 **하나뿐인** 결재선이다. 신청자 직급별로 판을 나누지 않는다.
 *
 * 신청자가 이 목록 안에 있으면 **자기 뒤에 있는 사람들**에게만 결재를 받고,
 * 목록에 없으면 **전원**에게 받는다. 맨 끝 사람의 신청은 결재자가 0명이므로
 * 결재 없이 바로 확정된다 (rules.ts 의 approversAfter).
 *
 * 🔴 `step_no` 는 **누가 결재자가 되는가**와 **누구부터 결재하는가**를 둘 다
 * 정한다 (2026-09-21 순차 전환). 앞사람이 처리해야 다음 사람의 결재함에
 * 들어가고, 열린 단계가 하나도 남지 않으면 확정된다.
 *
 * 🔴 `step_no` 에 유일 색인을 걸지 않았다 — 순서를 맞바꾸는 중간 상태에서
 * 걸려 넘어진다(유일 색인은 문장마다 검사하고 미룰 수 없다). 대신 줄을 넣고
 * 빼고 옮길 때마다 한 트랜잭션 안에서 1..n 으로 다시 번호를 매긴다
 * (actions/admin.ts).
 */
export const webApprovalRouteSteps = pgTable(
  "web_approval_route_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 목록에서의 차례. 1부터 */
    stepNo: integer("step_no").notNull(),
    approverEmployeeId: uuid("approver_employee_id")
      .notNull()
      .references(() => webEmployees.id),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    /** 같은 사람이 결재선에 두 번 들어가지 않는다 */
    uniqueIndex("web_approval_route_steps_employee_uq")
      .on(t.approverEmployeeId)
      .where(sql`${t.isDeleted} = false`),
    index("web_approval_route_steps_alive_idx")
      .on(t.stepNo)
      .where(sql`${t.isDeleted} = false`),
  ],
);

/* ------------------------------------------------------------------ */
/* web_approval_steps — 결재 단계 (신청 한 건에 결재자 수만큼)          */
/* step_no 차례대로 **한 명씩** 결재한다: 첫 단계만 PENDING, 뒤는 WAITING */
/* 앞사람이 닫히면 다음이 깨어나고, 열린 단계가 0 이 되면 확정한다        */
/* 단계는 **신청하는 순간 굳혀 박는다** — 뒤에 결재선을 바꿔도 이미 박힌  */
/* 행은 건드리지 않는다 (대기 중인 신청의 결재자가 바뀌면 안 된다)       */
/* ------------------------------------------------------------------ */

export const webApprovalSteps = pgTable(
  "web_approval_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => webLeaveRequests.id),
    stepNo: integer("step_no").notNull(),
    /**
     * 신청 시점 결재자의 직급. **표시용**이다.
     * 🔴 `approver_employee_id` 가 null 인 **옛 행에서만** 권한 판정에 쓰인다
     * (직급으로 결재하던 때에 만들어져 아직 대기 중인 단계). 그 한 줄이 없으면
     * 전환 순간 대기 중이던 신청이 모든 결재함에서 사라진다
     * (lib/leave/approval-scope.ts).
     */
    rankId: uuid("rank_id")
      .notNull()
      .references(() => webRanks.id),
    /**
     * 이 단계를 결재할 **사람**. 2026-09-21 이후 만들어지는 단계에는 늘 있다.
     * null 은 그 전에 만들어진 행뿐이라 칸을 더하기만 했다 (기존 행은 그대로).
     */
    approverEmployeeId: uuid("approver_employee_id").references(
      () => webEmployees.id,
    ),
    status: text("status", { enum: STEP_STATUSES })
      .notNull()
      .default("WAITING"),
    decidedByEmployeeId: uuid("decided_by_employee_id").references(
      () => webEmployees.id,
    ),
    decidedByUserId: uuid("decided_by_user_id").references(() => webUsers.id),
    comment: text("comment"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex("web_approval_steps_request_step_uq").on(t.requestId, t.stepNo),
    /** 결재함: 사람으로 찾는 길 (지금) */
    index("web_approval_steps_pending_approver_idx")
      .on(t.approverEmployeeId)
      .where(sql`${t.isDeleted} = false and ${t.status} = 'PENDING'`),
    /** 결재함: 직급으로 찾는 길 (사람 칸이 빈 옛 행) */
    index("web_approval_steps_pending_idx")
      .on(t.rankId)
      .where(sql`${t.isDeleted} = false and ${t.status} = 'PENDING'`),
    /*
     * ── 결재 **내역**: 기간·사람으로 가로지르는 길 (2026-11-17, 설계 C-4) ──
     *
     * 🔴 위의 둘은 **「지금 차례」전용**이다 — 부분 조건이 `status = 'PENDING'`
     * 이라 결재가 끝나는 순간 그 줄은 두 색인 어디에도 남지 않는다. 그래서
     * 「내가 2월에 한 결재」를 묻는 길은 2026-11-17 까지 **하나도 없었다**
     * (`decided_at` 에도 「누가 눌렀나」에도 색인이 0 이었다 — 세 집이 똑같았다).
     *
     * 🔴 **왜 둘인가 — 「OR 두 칸」은 한 색인으로 못 탄다.** 내역 조회의 조건은
     * `decided_by_employee_id = 나 OR approver_employee_id = 나` 다. 복합 색인
     * `(decided_by, approver)` 하나로는 둘째 칸만 아는 질의를 탈 수 없고(앞
     * 칸이 비면 색인이 안 열린다), 두 칸을 한 줄에 합친 식 색인은 **등호 두 쪽을
     * 모두 그 식으로 적어야** 해서 질의가 읽기 어려워진다. 색인을 **둘로 나눠
     * 두면** 계획기가 각각을 비트맵으로 훑어 OR 로 합친다(BitmapOr) — 이쪽이
     * PostgreSQL 이 OR 를 푸는 본래 길이다.
     *
     * 🔴 **부분 조건이 조회와 글자까지 같아야 한다**(`is_deleted = false and
     * status in ('APPROVED','REJECTED')`). 계획기는 「이 질의가 이 색인 안에
     * 담기는가」를 **상수끼리** 견주어 증명하므로, 한쪽만 바꾸면 증명이 깨져
     * 색인을 안 탄다 — 🔴 **결과는 그대로라 아무도 모르고 느려지기만 한다.**
     * 조회 쪽(leave/data.ts 의 `approvalHistoryWhere`)이 이 두 조건을 바인딩
     * 자리가 아닌 **글자**로 적는 까닭도 같다. scripts/test-approval-history.ts
     * 가 둘을 맞대어 본다.
     *
     * 🔵 `decided_at` 을 **둘째 칸**에 둔 것은 사람으로 좁힌 뒤 기간으로 자르고
     * 최근 순(`decided_at desc`)으로 읽기 때문이다. btree 는 거꾸로도 훑으므로
     * 내림차순 색인을 따로 둘 이유가 없다.
     *
     * 🔵 건너뛴 단계(`SKIPPED`)는 부분 조건에서 빠진다 — 결재 내역은 승인·반려만
     * 이다(설계 B-18). 까닭은 조회 쪽 머리말에 적었다.
     */
    index("web_approval_steps_decided_by_idx")
      .on(t.decidedByEmployeeId, t.decidedAt)
      .where(sql`${t.isDeleted} = false and ${t.status} in ('APPROVED', 'REJECTED')`),
    index("web_approval_steps_decided_approver_idx")
      .on(t.approverEmployeeId, t.decidedAt)
      .where(sql`${t.isDeleted} = false and ${t.status} in ('APPROVED', 'REJECTED')`),
  ],
);

/* ------------------------------------------------------------------ */
/* web_portal_approval_delegations — 포털이 써 주는 결재권 위임          */
/* 2026-11-16: 「그때그때 묻는다」에서 「포털이 써 준다」로 (설계 B-12)   */
/* ------------------------------------------------------------------ */

/**
 * 결재권 위임 — **통합 승인함에서 지정하고 포털이 여기 써 준 줄**이다.
 *
 * ── ⓐ 이 표의 주인은 포털이다 ──────────────────────────────────────────
 * 🔴 `id` 에 **기본값이 없다.** 포털이 정한 번호를 그대로 받아 적는다. 같은 줄을
 * 양쪽이 **같은 번호**로 가리켜야 철회와 어긋남 점검이 맞는다(설계 B-12 의 5번).
 * 여기서 번호를 새로 만들면 포털이 「그 줄을 거둬라」라고 말할 길이 없어진다.
 *
 * ── ⓑ 여기서는 되돌릴 수 없다 ──────────────────────────────────────────
 * 🔴 이 시스템에는 위임을 지정·철회하는 화면이 **없고 만들지도 않는다**(설계
 * B-9). 지정도 철회도 통합 승인함에서 하고, 그 결과가 통로
 * (`/api/integration/delegations`)로 들어와 이 표에 적힌다. 그러니 이 표의 줄을
 * 손으로 고치면 **포털과 어긋난 채 아무 표시도 나지 않는다** — 다음 전파가 올
 * 때까지 영영 조용하다(그 어긋남을 찾아내는 장치가 설계 B-14 다).
 *
 * ── ⓒ 🔴 열쇠가 `web_employees.id` 인 까닭 ────────────────────────────
 * 이 집은 **로그인 계정(`web_users`)과 직원 명단(`web_employees`)이 다른 표**이고,
 * 결재 권한은 **명단 번호**가 쥔다 — 결재 단계가 가리키는 것이
 * `web_approval_steps.approver_employee_id` 다. 포털은 제 번호(`sub`)로 보내므로
 * 받는 쪽이 **두 단**으로 바꿔 적는다:
 *
 *     포털 sub → web_users.auth_sub → web_users.employee_id → web_employees.id
 *
 * 🔴 중간 단이 **NULL 일 수 있다**(포털 로그인은 됐지만 아직 명단에 안 이어진
 * 계정 — 2026-11-16 운영 실측으로 8명 중 1명). 그 사람은 여기서 결재할 수
 * 없으므로 위임도 뜻이 없다 — 통로가 **줄을 안 만들고 `not_applicable`** 로
 * 답한다(leave/portal-delegation-sync.ts). 계정 번호를 적어 두면 결재 판정 때마다
 * 두 단을 다시 밟아야 하고, 그 사이에 관리자가 계정 연결을 바꾸면 **위임이 말없이
 * 다른 사람에게 옮겨 간다.**
 *
 * ── ⓓ 2026-11-16 의 방식 전환(B-12) ───────────────────────────────────
 * 그 전에는 결재할 때마다 포털에 물었다(B-3). 뒤집은 까닭은 결재 길목에서 망
 * 호출을 없애려는 것이고, 그래서 **포털이 지정·철회할 때 전파하고 각 시스템은 제
 * 표만 읽는다.** 🟢 **읽는 쪽도 같은 날 저녁에 이어졌다** — 묻던 길은 통째로
 * 걷혔고, 이 표를 읽는 자리는 auth/portal-delegations.ts 의
 * `loadActingForEmployeeIds` 하나다(살아 있는 줄의 조건도 거기 한 곳에만 있다).
 *
 * ── ⓔ 🟢 이 집에는 자체 위임이 없다 ───────────────────────────────────
 * A/S·재고관리에는 저희 손으로 만든 위임 표가 따로 있어 **두 출처가 한 화면에
 * 섞인다**(설계 D-2). 여기에는 그런 표가 **애초에 없었다** — 설계 D-5 의
 * 2026-11-16 조사에서 이 저장소에는 「위임」이라는 낱말 자체가 한 번도 안
 * 나왔다(포털에 묻는 코드가 그날 처음 들어왔다). 그래서 섞일 것이 없고, 이름에
 * `portal_` 을 붙인 것은 출처를 적어 두라는 B-12 의 3번을 **표 이름 하나로**
 * 갚은 것이다.
 *
 * ── 칸에 대하여 ────────────────────────────────────────────────────────
 * 🔴 **소프트 삭제 4칸을 두지 않았다.** 이 집의 규칙은 「물리 삭제를 하지
 * 않는다」인데 이 표는 **아무도 줄을 지우지 않는다** — 살았나 죽었나는 포털이
 * 보내 준 `revoked_at` 하나가 정하고, 그 옆에 `is_deleted` 를 두면 「둘이
 * 엇갈리면 무엇이 이기는가」를 아무도 답할 수 없다. 같은 까닭으로 `revoked_at`
 * 을 쓰는 `web_sessions` 에도 그 네 칸이 없다.
 * 🔵 `synced_at` 하나가 `created_at`·`updated_at` 자리를 겸한다 — **언제 받아
 * 적었나**가 이 줄에서 이쪽이 아는 유일한 시각이다(만든 시각은 포털이 안다).
 */
export const webPortalApprovalDelegations = pgTable(
  "web_portal_approval_delegations",
  {
    /** 🔴 포털이 정한 번호. 기본값이 없다 — 위 ⓐ. */
    id: uuid("id").primaryKey(),
    /** 결재권을 맡긴 사람(명단 번호). 🔴 계정 번호가 아니다 — 위 ⓒ. */
    delegatorEmployeeId: uuid("delegator_employee_id").notNull(),
    /** 대신 결재할 사람(명단 번호). */
    delegateEmployeeId: uuid("delegate_employee_id").notNull(),
    /** 기간. 포털이 보낸 값 그대로 적는다 — 판정은 이 두 칸으로 한다. */
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    /** 맡긴 까닭. 없으면 빈 글자다(통로 규약) — null 과 갈라 둘 이유가 없다. */
    reason: text("reason").notNull().default(""),
    /**
     * 비어 있으면 살아 있는 줄이다. 🔴 **값을 정하는 것은 언제나 포털**이고
     * (위 ⓑ) 철회 통보뿐 아니라 **지정 통보에 실려 오기도 한다** — 포털이 줄을
     * 통째로 보내면 거둔 줄도 그 모양 그대로 온다.
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** 🔴 **언제 받아 적었나.** 어긋남 점검(설계 B-14)이 이 값을 본다. */
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 🔴 이름을 손으로 적는다. drizzle 이 자동으로 짓는 이름
    //    (`..._delegator_employee_id_web_employees_id_fk`)은 73자라 PostgreSQL 이
    //    **63자에서 말없이 잘라** 저장한다 — 스키마가 아는 이름과 DB 에 있는
    //    이름이 달라지고, 나중에 제약을 고칠 때 「없는 제약」으로 보인다.
    foreignKey({
      columns: [t.delegatorEmployeeId],
      foreignColumns: [webEmployees.id],
      name: "web_portal_approval_delegations_delegator_fk",
    }),
    foreignKey({
      columns: [t.delegateEmployeeId],
      foreignColumns: [webEmployees.id],
      name: "web_portal_approval_delegations_delegate_fk",
    }),
    // 기간은 반열린 구간이다 — 끝이 시작과 같으면 **하루도 못 쓰는 위임**이
    // 저장되고, 뒤집히면 영원히 안 열린다. 둘 다 오류 없이 조용하다.
    check(
      "web_portal_approval_delegations_period_ck",
      sql`${t.endsAt} > ${t.startsAt}`,
    ),
    // 🔴 자기에게 맡기는 줄은 아무것도 넓히지 않으면서(본인 단계는 원래 눌린다)
    //    「위임을 걸어 뒀다」는 착각만 만든다.
    check(
      "web_portal_approval_delegations_self_ck",
      sql`${t.delegateEmployeeId} <> ${t.delegatorEmployeeId}`,
    ),
    // 판정이 묻는 차례 그대로다 — 「내가(대리인) 지금 살아 있는 위임으로 누구를
    // 대신할 수 있나」. 🔴 **모든 화면이 요청마다 이 색인을 탄다**(사람을 읽을
    // 때 함께 읽는다 — auth/guards.ts 의 loadEmployee).
    index("web_portal_approval_delegations_delegate_idx").on(
      t.delegateEmployeeId,
      t.revokedAt,
      t.endsAt,
    ),
  ],
);

/* ------------------------------------------------------------------ */
/* web_leave_adjustments — 관리자의 일수 조정 (+/-)                     */
/* 자동 계산이 맞지 않는 경우(결근, 입사 첫해 비례분 등)를 사람이 메운다  */
/* ------------------------------------------------------------------ */

export const webLeaveAdjustments = pgTable(
  "web_leave_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => webEmployees.id),
    bucket: text("bucket", { enum: ADJUSTMENT_BUCKETS }).notNull(),
    /** ANNUAL 이면 몇 년도 연차인가 */
    year: integer("year"),
    days: days("days").notNull(),
    reason: text("reason").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => webUsers.id),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    check(
      "web_leave_adjustments_year_ck",
      sql`(${t.bucket} = 'ANNUAL' and ${t.year} is not null) or (${t.bucket} = 'MONTHLY')`,
    ),
    index("web_leave_adjustments_employee_idx")
      .on(t.employeeId)
      .where(sql`${t.isDeleted} = false`),
  ],
);

/* ------------------------------------------------------------------ */
/* web_audit_logs — 감사 로그 (append-only)                             */
/* ------------------------------------------------------------------ */

export const webAuditLogs = pgTable(
  "web_audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id"),
    actorName: text("actor_name").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    summary: text("summary").notNull(),
    changes: jsonb("changes"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("web_audit_logs_created_idx").on(t.createdAt),
    index("web_audit_logs_entity_idx").on(t.entityType, t.entityId),
  ],
);

/* ------------------------------------------------------------------ */
/* 타입                                                                 */
/* ------------------------------------------------------------------ */

export type Rank = typeof webRanks.$inferSelect;
export type Employee = typeof webEmployees.$inferSelect;
export type WebUser = typeof webUsers.$inferSelect;
export type TenureRule = typeof webTenureRules.$inferSelect;
export type LeaveSettings = typeof webLeaveSettings.$inferSelect;
export type Holiday = typeof webHolidays.$inferSelect;
export type LeaveRequest = typeof webLeaveRequests.$inferSelect;
export type ApprovalRouteStep = typeof webApprovalRouteSteps.$inferSelect;
export type ApprovalStep = typeof webApprovalSteps.$inferSelect;
export type LeaveAdjustment = typeof webLeaveAdjustments.$inferSelect;
export type PortalApprovalDelegation =
  typeof webPortalApprovalDelegations.$inferSelect;
