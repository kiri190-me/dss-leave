/**
 * ============================================================================
 * 포털이 써 주는 결재권 위임을 **받아 적는** 판단 — 모양 검사와 두 단 변환
 * ============================================================================
 * 2026-11-16 저녁에 방식이 뒤집혔다(설계 B-12). 그 전에는 결재할 때마다 각
 * 시스템이 포털에 **물었고**(B-3), 이제는 포털이 지정·철회할 때 각 시스템에
 * **써 준다.** 그래서 이 집에 처음으로 위임을 **저장하는 자리**가 생겼다
 * (`web_portal_approval_delegations`).
 *
 * 🟢 **묻던 쪽은 2026-11-16 저녁에 걷혔다**(leave/approval-delegation.ts 가
 * 통째로 없어졌다). 이제 이 표를 적는 것이 여기이고, 그것을 읽어 결재 판정에
 * 올리는 것은 auth/portal-delegations.ts 다 — 쓰는 쪽과 읽는 쪽 둘뿐이다.
 *
 * ── 🔴 저쪽과 **반대로** 처신한다 ─────────────────────────────────────────
 * 묻는 쪽은 **던지지 않는다.** 포털이 죽어도 결재는 그대로 진행되어야 하기
 * 때문이다(B-6). 🔴 **받는 쪽은 그 반대다.** 전파가 한 곳이라도 실패하면 포털이
 * **지정 자체를 거절한다**(B-13) — 「맡겼는데 어딘가에선 안 듣는」 상태를 안
 * 만들려는 것이다. 그러니 저장에 실패하면 **조용히 성공한 척하면 안 되고**
 * 오류로 답해야 한다. 이 파일이 삼키는 것은 **「이 시스템에는 해당 없음」** 하나
 * 뿐이고, 그것은 실패가 아니다(아래).
 *
 * ── 🔴 `not_applicable` 이 이 집에서 특히 중요하다 ────────────────────────
 * 결재 권한을 쥔 것은 **직원 명단 번호**이고 포털은 **제 번호(sub)** 로 보낸다.
 * 중간에 `web_users.employee_id` 가 있고 그 칸이 **NULL 일 수 있다** — 포털
 * 로그인은 됐지만 아직 명단에 안 이어진 계정이다(2026-11-16 운영 실측: 로그인
 * 계정 8명 중 1명). 🔴 그런 사람을 **오류로 답하면** 포털이 지정을 통째로
 * 거절하므로, **그 한 명에게는 A/S·재고관리에서도 위임을 아예 못 맡기게 된다.**
 * 여기서 결재할 수 없는 사람이니 여기 위임은 뜻이 없을 뿐, 다른 시스템에서는
 * 멀쩡히 뜻이 있다. 그래서 **줄을 안 만들고 200 으로 「해당 없음」**을 돌려준다.
 *
 * ── DB 를 **인자로 받는다** ───────────────────────────────────────────────
 * leave/approval-nudge.ts · leave/portal-notifications.ts 와 같은 자리다. 그래서
 * 모양 검사와 변환 판단을 DB 없이 그대로 돌려 볼 수 있고
 * (`npm run test:delegation-sync`), 배선은 auth/portal-delegation-store.ts 와
 * 통로에 남는다.
 * ============================================================================
 */
import { isUuid } from "@/lib/ids";

/**
 * 포털 번호 한 줄을 이 시스템의 계정·명단으로 되짚은 결과.
 *
 * 🔴 `employeeId` 가 **null 일 수 있다** — 계정은 있는데 명단에 안 이어진
 * 사람이다(머리말의 중간 단). 조회가 그 줄을 **버리지 않고 그대로 올려 주어야**
 * 「계정이 아예 없는 사람」과 갈라 `not_applicable` 의 까닭을 둘로 나눌 수 있다
 * (아래 `employeeIdOf`).
 *
 * 🔵 2026-11-16 저녁까지 이 타입은 leave/approval-delegation.ts 에 있었다. 그
 * 파일은 **포털에 묻던 쪽**의 판단 그릇이었고, 묻는 길을 걷어내면서 통째로
 * 없어졌다(설계 B-12). 이제 이 모양을 쓰는 것은 **받는 쪽**뿐이라 여기로
 * 옮겼다 — 조회 자체는 여전히 auth/portal-delegations.ts 의
 * `findEmployeeIdsBySubjects` 한 곳이다.
 */
export type DelegatedApproverRow = {
  authSub: string;
  employeeId: string | null;
};

/**
 * 포털이 보내는 두 가지 말. 🔴 **글자가 세 시스템에서 같아야 한다**(A/S ·
 * 재고관리 · 휴가). 포털 한 곳이 같은 본문으로 셋을 부른다.
 */
export const DELEGATION_ACTIONS = ["upsert", "revoke"] as const;
export type DelegationAction = (typeof DELEGATION_ACTIONS)[number];

/** 지정하거나 고친다. 줄 전체를 포털이 가진 모양 그대로 덮어쓴다. */
export type DelegationUpsertCommand = {
  action: "upsert";
  id: string;
  delegatorSub: string;
  delegateSub: string;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  /**
   * 🔵 **보통은 비어 있다**(살아 있는 줄). 포털이 객체를 통째로 보내면 빈 자리가
   * `null` 로 실려 오는데, 그것은 「없음」과 **같다.**
   * 🔴 **값이 실려 오면 그대로 적는다.** 버리면 「거둔 줄 알았는데 안 거둬진」
   * 상태가 생긴다 — 설계 B-13 이 그쪽을 더 위험하다고 못 박았다.
   */
  revokedAt: Date | null;
};

/** 철회한다. 🔴 `id` 와 철회 시각만 쓴다 — 나머지 칸은 건드리지 않는다. */
export type DelegationRevokeCommand = {
  action: "revoke";
  id: string;
  revokedAt: Date;
};

export type DelegationCommand = DelegationUpsertCommand | DelegationRevokeCommand;

/**
 * 모양 검사 결과. 🔴 **왜 틀렸는지를 글로 돌려준다** — 포털이 그것을 지정 화면에
 * 그대로 띄운다. 「요청이 올바르지 않습니다」만 보내면 전파가 막힌 까닭을 아무도
 * 모른 채 사람이 같은 단추를 다시 누른다.
 */
export type DelegationParseResult =
  | { ok: true; command: DelegationCommand }
  | { ok: false; error: string };

/** 이 시스템에 **적어 둘 줄**. 두 단 변환이 끝난 뒤의 값이다. */
export type StoredPortalDelegation = {
  id: string;
  /** 🔴 `web_employees.id` 다. 포털 번호도 계정 번호도 아니다. */
  delegatorEmployeeId: string;
  delegateEmployeeId: string;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  /**
   * 비어 있으면 살아 있는 줄. 🔴 포털이 보낸 값 **그대로**다.
   * 🔴 다만 **이미 있던 줄을 덮어쓸 때** 널은 적힌 값을 지우지 않는다 — 엇갈려 닿은
   * 전파가 거둔 위임을 되살리는 길을 막는다(`auth/portal-delegation-store.ts` 의
   * `portalDelegationUpsertQuery` 머리말).
   */
  revokedAt: Date | null;
};

/**
 * 「해당 없음」의 **까닭**. 🔴 밖으로는 나가지 않는다 — 통로의 답은 규약대로
 * `{ outcome: "not_applicable" }` 한 가지이고, 까닭은 **서버 로그에만** 남는다.
 * 포털에게 이 까닭을 알려 주면 「이 사람은 저 시스템에 계정이 없다」를 밖에서
 * 떠볼 수 있게 된다.
 */
export type NotApplicableReason =
  /** 맡긴 사람이 이 시스템에 없다(계정 없음·정지·삭제·번호 모양이 아님). */
  | "delegator_absent"
  /** 맡긴 사람의 계정이 **명단에 안 이어졌다**(위 머리말의 그 한 명). */
  | "delegator_unlinked"
  | "delegate_absent"
  | "delegate_unlinked"
  /** 철회하라는 줄이 여기 없다 — 애초에 「해당 없음」으로 안 적은 줄이다. */
  | "unknown_delegation";

export type DelegationSyncResult =
  /** 적었다. 🔵 **다시 와도 한 줄**이다(아래 `upsert` 주석). */
  | { outcome: "stored" }
  /** 이 시스템에는 해당이 없다. 🔴 **성공이다**(200). */
  | { outcome: "not_applicable"; reason: NotApplicableReason }
  /** 본문이 규약과 다르다. 통로가 400 으로 바꾼다. */
  | { outcome: "invalid"; error: string };

export type DelegationSyncDeps = {
  /**
   * 포털 번호들 → 이 시스템의 계정·명단. 🔴 **묻는 쪽과 같은 함수**를 쓴다
   * (auth/portal-delegations.ts 의 `findEmployeeIdsBySubjects`). 거르는 조건이
   * 한 벌이어야 「읽을 때는 되는데 쓸 때는 안 되는」 사람이 안 생긴다.
   */
  lookup: (subs: readonly string[]) => Promise<readonly DelegatedApproverRow[]>;
  /**
   * 있으면 덮어쓰고 없으면 넣는다. 🔴 **번호(`id`)로** 그래야 한다 — 포털이
   * 같은 지정을 두 번 보내도(재시도) 한 줄이어야 한다.
   */
  upsert: (row: StoredPortalDelegation) => Promise<void>;
  /** 철회 시각을 세운다. 🔵 **그런 줄이 없으면 `false`** — 오류가 아니다. */
  revoke: (id: string, revokedAt: Date) => Promise<boolean>;
};

/* ------------------------------------------------------------------ */
/* 모양 검사                                                            */
/* ------------------------------------------------------------------ */

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function isAction(value: string): value is DelegationAction {
  return (DELEGATION_ACTIONS as readonly string[]).includes(value);
}

/**
 * ISO 8601 시각 한 칸.
 *
 * 🔴 **시간대가 반드시 붙어 있어야 한다**(`Z` 또는 `+09:00`). 없으면 자바스크립트가
 * **읽는 쪽의 지역 시간**으로 푸는데, 이 시스템은 개발 PC(KST)와 NAS 컨테이너
 * (UTC)에서 함께 돌아 **같은 글자가 아홉 시간 다른 뜻**이 된다. 위임 기간이 아홉
 * 시간 어긋나는 것은 오류를 내지 않고 조용히 틀린다. 🔴 휴가는 **날짜가 곧 업무**라
 * 이 함정이 특히 비싸다.
 *
 * 🔴 `new Date(...)` 만으로는 모자라다 — 세 가지가 **오류 없이 조용히 틀린다**:
 *  · `new Date("2026")` 도 유효한 날짜다. 날짜만 적어 보낸 값이 **1월 1일 0시**로
 *    둔갑한다.
 *  · 🔴 `2026-02-30` 은 **3월 2일**이 되고 평년의 `2026-02-29` 는 **3월 1일**이
 *    된다(2026-11-16 실측). 달·일이 범위를 넘으면(13월·32일) 거절되는데, **달력에
 *    없는 날만 조용히 넘어간다.**
 *  · `99:99` 는 거절된다 — 시·분·초는 `new Date` 가 막아 준다.
 * 그래서 **연·월·일을 글자에서 떼어 내 달력으로 한 번 더 본다.**
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?([Zz]|[+-]\d{2}:?\d{2})$/;

/** 달력에 실제로 있는 날인가. 🔵 윤년까지 본다(2024-02-29 는 있고 2026-02-29 는 없다). */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1];
}

export function readInstant(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parts = ISO_INSTANT.exec(value);
  if (parts === null) return null;
  // 🔴 시간대가 붙어 있어 이 연·월·일은 **글자 그대로의 달력 날짜**다(UTC 로
  //    옮긴 뒤의 날짜가 아니다). 그러니 옮기기 **전에** 본다.
  if (!isRealDate(Number(parts[1]), Number(parts[2]), Number(parts[3]))) return null;
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at : null;
}

/** 빈 값으로 볼 것들. 포털이 칸을 늘 싣고 빈 자리를 `null`·`""` 로 둘 수 있다. */
function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/**
 * 포털이 보낸 본문을 명령으로. 🔴 **모르는 값은 통과시키지 않는다** — 받는 쪽이
 * 너그러우면 포털의 오타가 「저장은 됐는데 아무 일도 안 일어나는 줄」이 된다.
 */
export function parseDelegationCommand(body: unknown): DelegationParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "본문이 JSON 객체가 아닙니다." };
  }
  const source = body as Record<string, unknown>;

  const action = readString(source, "action");
  if (action === null || !isAction(action)) {
    return { ok: false, error: "action 은 upsert 또는 revoke 여야 합니다." };
  }

  // 🔴 번호가 이 집에서도 uuid 열이다. 모양이 아닌 값을 그대로 넘기면 드라이버가
  //    던지고, 통로는 그것을 500(저장 실패)으로 답한다 — 모양 문제는 400 이다.
  const id = readString(source, "id");
  if (id === null || !isUuid(id)) {
    return { ok: false, error: "id 가 uuid 가 아닙니다." };
  }

  if (action === "revoke") {
    const revokedAt = readInstant(source.revokedAt);
    if (revokedAt === null) {
      // 🔴 **없다고 지금 시각으로 메우지 않는다.** 메우면 포털과 이쪽의 철회
      //    시각이 말없이 달라지고, 어긋남 점검(B-14)이 그 차이를 결함으로 읽는다.
      return { ok: false, error: "revoke 에는 revokedAt(ISO 8601, 시간대 포함)이 필요합니다." };
    }
    return { ok: true, command: { action, id, revokedAt } };
  }

  // ── 🔴 upsert 의 철회 시각 — **받아서 그대로 적는다** ────────────────────
  // 🔵 **없음과 `null`(과 빈 글자)은 같다** — 살아 있는 줄이다. 포털이 객체를
  //    통째로 보내면 빈 자리가 `null` 로 실려 오는데, 그것을 거절하면 포털이
  //    전파 실패로 보고 **멀쩡한 지정이 세 시스템에서 전부 막힌다**(설계 B-13).
  // 🔴 **값이 실려 오면 버리지 않는다.** 버리면 「포털은 거뒀는데 여기서는 살아
  //    있는」 줄이 남고 그 어긋남은 아무 표시도 내지 않는다. 그대로 적으면 그
  //    순간 양쪽이 같은 상태가 된다. 거절해도 같은 값을 치른다 — 포털이 지정
  //    자체를 거절하므로 **멀쩡한 지정까지 막힌다.**
  // 🔵 모양이 틀린 값은 그대로 적을 수 없으므로 여전히 400 이다.
  let revokedAt: Date | null = null;
  if (!isBlank(source.revokedAt)) {
    revokedAt = readInstant(source.revokedAt);
    if (revokedAt === null) {
      return { ok: false, error: "revokedAt 은 ISO 8601(시간대 포함)이어야 합니다." };
    }
  }

  const delegatorSub = readString(source, "delegatorSub");
  const delegateSub = readString(source, "delegateSub");
  if (delegatorSub === null || !isUuid(delegatorSub)) {
    return { ok: false, error: "delegatorSub 가 uuid 가 아닙니다." };
  }
  if (delegateSub === null || !isUuid(delegateSub)) {
    return { ok: false, error: "delegateSub 가 uuid 가 아닙니다." };
  }
  // 자기에게 맡기는 줄은 아무것도 넓히지 않으면서(본인 단계는 원래 눌린다)
  // 「맡겨 뒀다」는 착각만 만든다. 표의 CHECK 와 같은 말이다.
  if (delegatorSub === delegateSub) {
    return { ok: false, error: "자기 자신에게는 결재권을 맡길 수 없습니다." };
  }

  const startsAt = readInstant(source.startsAt);
  const endsAt = readInstant(source.endsAt);
  if (startsAt === null || endsAt === null) {
    return { ok: false, error: "startsAt·endsAt 은 ISO 8601(시간대 포함)이어야 합니다." };
  }
  if (endsAt.getTime() <= startsAt.getTime()) {
    return { ok: false, error: "endsAt 은 startsAt 보다 뒤여야 합니다." };
  }

  // 까닭은 **없어도 된다**(규약: 없으면 빈 문자열). 글자가 아닌 값은 거절한다 —
  // 숫자나 객체가 들어오면 저장은 되는데 화면에서 "[object Object]" 가 된다.
  const reasonValue = source.reason;
  if (!isBlank(reasonValue) && typeof reasonValue !== "string") {
    return { ok: false, error: "reason 은 글자여야 합니다." };
  }
  const reason = typeof reasonValue === "string" ? reasonValue : "";

  return {
    ok: true,
    command: { action, id, delegatorSub, delegateSub, startsAt, endsAt, reason, revokedAt },
  };
}

/* ------------------------------------------------------------------ */
/* 두 단 변환 + 적기                                                    */
/* ------------------------------------------------------------------ */

/**
 * 포털 번호 하나를 **명단 번호**로. 🔴 못 바꾼 까닭을 둘로 갈라 돌려준다 —
 * 「이 시스템에 없는 사람」과 「계정은 있는데 명단에 안 이어진 사람」은 휴가
 * 관리자가 할 일이 다르다(뒤쪽은 「직원 관리」에서 이어 주면 풀린다).
 */
function employeeIdOf(
  rows: readonly DelegatedApproverRow[],
  sub: string,
): { ok: true; employeeId: string } | { ok: false; unlinked: boolean } {
  const row = rows.find((candidate) => candidate.authSub === sub);
  if (row === undefined) return { ok: false, unlinked: false };
  if (row.employeeId === null) return { ok: false, unlinked: true };
  return { ok: true, employeeId: row.employeeId };
}

/**
 * 🔴 **이 조각의 입구.** 포털이 보낸 명령을 이 시스템의 표에 적는다.
 *
 * 🔴 **던진다.** DB 가 거절하면 그대로 올려 보내고 통로가 500 으로 답한다 —
 * 포털은 그것을 전파 실패로 보고 **지정 자체를 거절한다**(B-13). 여기서 삼키면
 * 포털만 「맡겼다」고 알고 이 시스템은 모르는 상태가 되고, 대리인이 결재함을
 * 열어 보기 전까지 아무도 모른다.
 *
 * 🔵 **거래로 묶지 않는다.** 쓰는 줄이 하나뿐이고 다른 표를 건드리지 않는다 —
 * 묶을 것이 없다.
 */
export async function applyDelegationCommand(
  command: DelegationCommand,
  deps: DelegationSyncDeps,
): Promise<DelegationSyncResult> {
  if (command.action === "revoke") {
    const found = await deps.revoke(command.id, command.revokedAt);
    // 🔵 **없는 줄을 거두라는 것은 오류가 아니다.** 애초에 두 단 변환이 안 돼
    //    「해당 없음」으로 안 적은 줄이거나, 포털이 재시도한 것이다. 둘 다
    //    「지금 이 시스템에 그 위임이 살아 있지 않다」는 같은 결과다.
    return found ? { outcome: "stored" } : { outcome: "not_applicable", reason: "unknown_delegation" };
  }

  // 🔴 **한 번에 묻는다.** 두 번 물으면 그 사이에 명단이 바뀔 수 있고, 무엇보다
  //    DB 왕복이 둘이 된다. 돌려주는 줄은 **찾은 것만**이라 수가 적을 수 있다.
  const rows = await deps.lookup([command.delegatorSub, command.delegateSub]);

  const delegator = employeeIdOf(rows, command.delegatorSub);
  if (!delegator.ok) {
    return {
      outcome: "not_applicable",
      reason: delegator.unlinked ? "delegator_unlinked" : "delegator_absent",
    };
  }
  const delegate = employeeIdOf(rows, command.delegateSub);
  if (!delegate.ok) {
    return {
      outcome: "not_applicable",
      reason: delegate.unlinked ? "delegate_unlinked" : "delegate_absent",
    };
  }

  // 🔴 포털 번호는 둘인데 **명단 번호가 하나로 겹쳤다.** 계정 하나에 직원 하나를
  //    유일 색인이 지키고 있어(web_users_employee_uq) 정상에서는 안 생긴다 —
  //    생겼다면 이 집의 자료가 어긋난 것이다. 그대로 적으면 표의 CHECK 가 던져
  //    500 이 되므로, **무엇이 잘못됐는지 말해 주는** 400 으로 답한다.
  if (delegator.employeeId === delegate.employeeId) {
    return {
      outcome: "invalid",
      error: "두 사람이 이 시스템에서 같은 직원으로 이어져 있습니다.",
    };
  }

  await deps.upsert({
    id: command.id,
    delegatorEmployeeId: delegator.employeeId,
    delegateEmployeeId: delegate.employeeId,
    startsAt: command.startsAt,
    endsAt: command.endsAt,
    reason: command.reason,
    // 🔴 **포털이 보낸 그대로**다. 거의 늘 비어 있지만(살아 있는 줄), 값이 오면
    //    그것까지 적어야 양쪽이 같은 상태가 된다(위 모양 검사의 주석).
    revokedAt: command.revokedAt,
  });
  return { outcome: "stored" };
}
