import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
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

export const LEAVE_TYPES = [
  "ANNUAL", // 연차 1일
  "AM_HALF", // 오전 반차 0.5일
  "PM_HALF", // 오후 반차 0.5일
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
 * 결재 단계 상태. 결재는 순서 없이 동시에 진행한다 (2026-09-18 변경).
 * WAITING 은 순서가 있던 초안에서 쓰던 값이라 남겨만 둔다 (새로 만들지 않는다).
 */
export const STEP_STATUSES = [
  "WAITING", // (쓰지 않음) 앞사람 결재를 기다림
  "PENDING", // 이 직급의 승인을 기다림
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
 * 🔴 `step_no` 는 **누가 결재자가 되는가**를 가르는 차례일 뿐, 「한 명씩 차례로
 * 기다린다」는 뜻이 아니다. 결재는 지금도 동시에 가고 순서 없이 모두 승인하면
 * 확정된다.
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
/* 순서 없이 동시에 대기하고, 모두 승인하면 확정. step_no 는 표시 순서다  */
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
export type Holiday = typeof webHolidays.$inferSelect;
export type LeaveRequest = typeof webLeaveRequests.$inferSelect;
export type ApprovalRouteStep = typeof webApprovalRouteSteps.$inferSelect;
export type ApprovalStep = typeof webApprovalSteps.$inferSelect;
export type LeaveAdjustment = typeof webLeaveAdjustments.$inferSelect;
