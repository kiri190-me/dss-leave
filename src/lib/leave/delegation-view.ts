/**
 * ============================================================================
 * 결재권 위임을 **사람에게 어떻게 말할 것인가** — 글자 한 벌 (2026-11-17, 조각 3c)
 * ============================================================================
 * 위임을 읽는 길은 이미 다 서 있다(auth/portal-delegations.ts). 이 파일은 그
 * 줄들을 **사람이 읽는 문장**으로 바꾸기만 한다 — DB 도 React 도 모르는 순수
 * 함수들이다.
 *
 * ── 🔴 왜 글자를 화면에 바로 적지 않고 여기 모았나 ────────────────────────
 * 같은 사실을 **두 화면**이 말한다:
 *   · 결재함(`(internal)/approvals`)        — 「왜 남의 건이 내 목록에 있나」
 *   · [휴가 설정 → 결재권 위임] 탭           — 「무엇이 걸려 있나」
 * 두 곳에 각각 적으면 한쪽만 고치는 날이 오고, **두 화면이 같은 위임을 두고 서로
 * 다른 말을 한다.** 사람은 그중 하나를 믿는데 어느 쪽이 맞는지 알 길이 없다.
 *
 * ── 🔴 이 집에는 「맡기기」가 없다 ────────────────────────────────────────
 * 지정도 철회도 **통합 승인함에서만** 한다(설계 B-2·B-9). 그래서 여기의 모든
 * 문장은 **읽기 전용**이고, 아래 `DELEGATION_READ_ONLY_NOTE` 가 그 사실을 늘
 * 함께 말한다. 🔴 [되돌리기] 단추를 그리지 마라 — 눌러도 거절되는 단추를 사람은
 * **고장으로 읽는다**(A/S 가 같은 까닭으로 대리인 쪽 단추를 안 그린다).
 *
 * ── 🔴 「시작 전」을 함께 말한다 ──────────────────────────────────────────
 * 화면에 오는 줄에는 **아직 시작 전인 위임**이 섞여 있다
 * (auth/portal-delegations.ts 의 `unfinishedWhere` — 거기 까닭이 적혀 있다).
 * 결재 권한은 **시작 시각부터**이므로, 시작 전 줄에 「지금 대신 누를 수 있다」고
 * 적으면 거짓이 된다. `delegationPhase` 가 그 둘을 가르고 문장이 갈라진다.
 * ============================================================================
 */
import { formatKstDateTime, todayKst } from "@/lib/dates";

/** 어느 방향에서 보는 줄인가. 🔴 같은 줄도 보는 사람에 따라 문장이 다르다. */
export type DelegationSide = "RECEIVED" | "GIVEN";

/**
 * 지금 그 위임이 어디쯤인가.
 *
 * 🔴 **끝난 것과 거둔 것은 이 갈래에 없다** — 화면까지 오지 않기 때문이다.
 * 조회가 `revoked_at is null and ends_at > 지금` 으로 이미 걸러 낸다.
 */
export type DelegationPhase = "ACTIVE" | "UPCOMING";

export const DELEGATION_PHASE_LABEL: Record<DelegationPhase, string> = {
  ACTIVE: "진행 중",
  UPCOMING: "시작 전",
};

/** 「진행 중」·「시작 전」 딱지의 색. Tailwind 가 찾을 수 있게 글자 그대로 적는다. */
export const DELEGATION_PHASE_CHIP: Record<DelegationPhase, string> = {
  ACTIVE: "bg-emerald-100 text-emerald-800",
  UPCOMING: "bg-slate-100 text-slate-600",
};

/** 화면에 그릴 한 줄. auth/portal-delegations.ts 의 `PortalDelegationView` 와 같은 모양이다. */
export type DelegationRow = {
  id: string;
  delegatorName: string;
  delegateName: string;
  startsAt: Date;
  endsAt: Date;
  reason: string;
};

/**
 * 🔴 **판정과 같은 금을 쓴다** — `starts_at <= 지금` 이면 진행 중이다
 * (auth/portal-delegations.ts 의 `liveDelegationWhere` 가 쓰는 바로 그 비교).
 * 여기만 `<` 로 적으면 **시작하는 그 순간**에 결재함에는 건이 뜨는데 안내는
 * 「시작 전」이라고 말한다 — 1초짜리 거짓이지만 사람이 보는 것은 그 1초다.
 */
export function delegationPhase(row: Pick<DelegationRow, "startsAt">, now: Date): DelegationPhase {
  return row.startsAt.getTime() <= now.getTime() ? "ACTIVE" : "UPCOMING";
}

/**
 * "11월 17일 (월) 09:00 ~ 11월 24일 (월) 18:00"
 *
 * 🔴 **연도를 붙일 때가 있다.** 기간이 해를 넘거나 올해가 아니면 붙인다 —
 * 안 붙이면 내년 3월의 위임과 지난 3월의 위임이 **글자로 구별되지 않는다.**
 * 🔵 날짜·시각을 한국 시간으로 적는 일은 lib/dates.ts 한 곳이 한다(컨테이너가
 * UTC 라 거기서 틀리면 아홉 시간이 밀린다).
 */
export function delegationPeriodLabel(
  row: Pick<DelegationRow, "startsAt" | "endsAt">,
  now: Date,
): string {
  const yearOfInstant = (at: Date) => todayKst(at).slice(0, 4);
  const withYear =
    yearOfInstant(row.startsAt) !== yearOfInstant(row.endsAt) ||
    yearOfInstant(row.startsAt) !== yearOfInstant(now);
  return `${formatKstDateTime(row.startsAt, withYear)} ~ ${formatKstDateTime(row.endsAt, withYear)}`;
}

/**
 * 한 줄을 사람에게 말해 주는 문장. 🔴 **이름과 기간이 반드시 들어간다** —
 * 「위임받았습니다」만으로는 **누구 것인지·언제까지인지**를 모른다.
 *
 * 🔴 「시작 전」 갈래에서는 **지금 할 수 있다고 말하지 않는다**(위 머리말).
 */
export function delegationSentence(row: DelegationRow, side: DelegationSide, now: Date): string {
  const period = delegationPeriodLabel(row, now);
  const phase = delegationPhase(row, now);
  const from = `${delegationPeriodStart(row, now)} 부터`;
  if (side === "RECEIVED") {
    const head = `통합 승인함에서 ${row.delegatorName}님의 결재권을 맡았습니다 (${period}).`;
    return phase === "ACTIVE"
      ? `${head} 그분 차례의 휴가 결재가 내 결재함에 함께 뜹니다.`
      : `${head} 아직 시작 전입니다 — ${from} 그분 차례의 휴가 결재가 내 결재함에 함께 뜹니다.`;
  }
  const head = `통합 승인함에서 내 결재권을 ${row.delegateName}님에게 맡겼습니다 (${period}).`;
  return phase === "ACTIVE"
    ? `${head} 내 차례의 휴가 결재를 그분도 대신 누를 수 있습니다.`
    : `${head} 아직 시작 전입니다 — ${from} 그분이 대신 누를 수 있습니다.`;
}

/** 시작 시각 하나만. 「… 부터」를 적을 때 쓴다. */
function delegationPeriodStart(row: Pick<DelegationRow, "startsAt" | "endsAt">, now: Date): string {
  const yearOfInstant = (at: Date) => todayKst(at).slice(0, 4);
  return formatKstDateTime(row.startsAt, yearOfInstant(row.startsAt) !== yearOfInstant(now));
}

/**
 * 관리자가 보는 「모두의 결재권 위임」 한 줄 — 🔴 **양쪽 이름을 다 적는다.**
 * 내 것이 아니라서 「내」가 들어간 문장을 쓸 수 없다.
 */
export function allDelegationSentence(row: DelegationRow, now: Date): string {
  return `${row.delegatorName}님 → ${row.delegateName}님 (${delegationPeriodLabel(row, now)})`;
}

/**
 * 🔴 **이 집에서는 볼 수만 있다**는 사실. 두 화면이 같은 글자를 쓴다.
 *
 * 설계 B-2·B-9 가 못 박았다 — 지정도 철회도 통합 승인함에서만. 이 글이 없으면
 * 사람은 **거둘 단추를 찾다가 못 찾고**, 그것을 「고장」으로 읽는다.
 */
export const DELEGATION_READ_ONLY_NOTE =
  "맡기거나 거두는 것은 통합 승인함에서만 합니다 — 여기서는 볼 수만 있습니다.";

/** 아무것도 걸려 있지 않을 때 **분명히** 적는 글. 🔴 빈 화면은 고장으로 읽힌다. */
export const DELEGATION_EMPTY_NOTE =
  "지금 걸려 있는 결재권 위임이 없습니다. 통합 승인함에서 맡기면 여기에 함께 뜹니다.";

/** 결재함 안내에 그릴 한 줄. */
export type DelegationNoticeLine = {
  /** 🔴 같은 사람에게 기간이 겹치는 위임이 둘일 수 있어 **줄 번호**로 가른다. */
  id: string;
  side: DelegationSide;
  phase: DelegationPhase;
  text: string;
};

/**
 * 결재함 맨 위에 그릴 줄들.
 *
 * 🔴 **비면 빈 배열이고, 그때 화면은 아무것도 그리지 않는다.** 늘 떠 있는 안내는
 * 아무도 읽지 않게 되고, 정작 위임이 걸린 날에도 눈에 안 들어온다.
 *
 * 🔵 **받은 것이 먼저다.** 결재함에서 급한 물음은 「왜 남의 건이 여기 있나」이고,
 * 「내가 맡겨 뒀다」는 그다음이다.
 */
export function delegationNoticeLines(
  received: readonly DelegationRow[],
  given: readonly DelegationRow[],
  now: Date,
): DelegationNoticeLine[] {
  const line = (row: DelegationRow, side: DelegationSide): DelegationNoticeLine => ({
    id: row.id,
    side,
    phase: delegationPhase(row, now),
    text: delegationSentence(row, side, now),
  });
  return [
    ...received.map((row) => line(row, "RECEIVED")),
    ...given.map((row) => line(row, "GIVEN")),
  ];
}
