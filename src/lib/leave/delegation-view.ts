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
 *
 * ── 🔴 2026-11-17: **끝난 줄이 처음으로 화면에 온다**(아래 ⑩절) ───────────
 * [휴가 설정 → 결재권 위임] 탭의 두 묶음이 끝난 위임을 **접어서** 보여 주게 됐다.
 * 그 전까지 이 파일의 글자는 전부 「아직 안 끝난 줄」만 보고 쓰였고, 그래서
 * `delegationPhase` 는 갈래가 둘(진행 중·시작 전)뿐이었다. 🔴 **그대로 두었다면
 * 만료된 줄에 「진행 중」 딱지가 붙고 「내 결재함에 함께 뜹니다」라고 적혔을
 * 것이다** — 조회가 걸러 준다는 전제 위에 쓰인 글자는 그 전제가 바뀌는 날
 * 아무 오류 없이 거짓말이 된다.
 * ============================================================================
 */
import { formatKstDateTime, todayKst } from "@/lib/dates";

/** 어느 방향에서 보는 줄인가. 🔴 같은 줄도 보는 사람에 따라 문장이 다르다. */
export type DelegationSide = "RECEIVED" | "GIVEN";

/**
 * 지금 그 위임이 어디쯤인가.
 *
 * 🔴 **2026-11-17 에 둘에서 넷이 됐다.** 그전에는 끝난 것과 거둔 것이 화면까지
 * 오지 않아(조회가 `revoked_at is null and ends_at > 지금` 으로 걸러 냈다) 적을
 * 갈래가 없었는데, 「끝난 위임 보기」 접기가 그 줄들을 **처음으로** 데려왔다
 * (아래 ⑩절). 🔴 **갈래를 안 늘렸다면 만료된 줄에 「진행 중」 딱지가 붙는다** —
 * `starts_at` 만 보던 판정이라 아무 오류 없이 거짓말을 한다.
 *
 * 🔵 뒤의 둘은 **다른 집들과 같은 낱말**이다(A/S 의
 * `APPROVAL_ROUTE_DELEGATION_STATUS_LABELS`, 통합 승인함의
 * `DELEGATION_STATUS_LABELS` — 「만료」·「철회됨」). 같은 것을 집마다 다른 말로
 * 부르면 오가는 사람이 다른 기능으로 읽는다. 앞의 둘은 이 집이 먼저 쓰던 말
 * 그대로 둔다 — 이미 결재함 안내에 그 글자로 떠 있다.
 */
export type DelegationPhase = "ACTIVE" | "UPCOMING" | "EXPIRED" | "REVOKED";

export const DELEGATION_PHASE_LABEL: Record<DelegationPhase, string> = {
  ACTIVE: "진행 중",
  UPCOMING: "시작 전",
  EXPIRED: "만료",
  REVOKED: "철회됨",
};

/** 딱지의 색. Tailwind 가 찾을 수 있게 글자 그대로 적는다. 🔵 이 집에는 `dark:` 가 한 줄도 없다. */
export const DELEGATION_PHASE_CHIP: Record<DelegationPhase, string> = {
  ACTIVE: "bg-emerald-100 text-emerald-800",
  UPCOMING: "bg-slate-100 text-slate-600",
  // 🔵 「시작 전」과 **다른 색**이어야 한다. 둘은 접기 안팎으로 갈려 한 목록에
  //    같이 서지 않지만, 같은 회색이면 접기를 펴 둔 채로 훑을 때 구별되지 않는다.
  EXPIRED: "bg-slate-200 text-slate-700",
  REVOKED: "bg-red-50 text-red-700",
};

/** 화면에 그릴 한 줄. auth/portal-delegations.ts 의 `PortalDelegationView` 와 같은 모양이다. */
export type DelegationRow = {
  id: string;
  delegatorName: string;
  delegateName: string;
  startsAt: Date;
  endsAt: Date;
  /**
   * 🔴 **거둬들인 때. 비어 있으면 안 거둔 줄이다**(2026-11-17 에 더했다). 이 칸이
   * 없으면 접기 안의 줄에 「만료」와 「철회됨」을 가려 적을 수 없고, 사람이 묻는
   * 것은 바로 그 둘의 차이다 — 「기간이 끝난 건가, 누가 거둔 건가」.
   */
  revokedAt: Date | null;
  reason: string;
};

/** 판정이 보는 칸들만. 🔵 줄 전체를 받지 않아 시험이 가짜 줄을 짧게 적는다. */
export type DelegationPeriod = Pick<DelegationRow, "startsAt" | "endsAt" | "revokedAt">;

/**
 * 🔴 **조회가 가르는 금과 같은 순서로 묻는다.**
 *
 *   ① `revoked_at is not null` → 철회됨  ─┐ 조회의 `finishedWhere` (①과 ②의 **or**)
 *   ② `ends_at <= 지금`        → 만료    ─┘ = 접기 **안**으로 가는 집합
 *   ③ `starts_at <= 지금`      → 진행 중  ─┐ 조회의 `unfinishedWhere`
 *   ④ 나머지                   → 시작 전  ─┘ = 펴 두는 집합
 *
 * 🔴 **여기와 조회가 갈리면** 화면에 「진행 중」이라고 적힌 줄이 접혀 있는, 설명할 수
 * 없는 모양이 된다. 반열린 구간의 경계가 그 한 순간이고, 아무 오류도 나지 않는다
 * (scripts/test-delegation-fold.ts 가 두 벌을 일곱 경우로 맞대어 본다).
 *
 * 🔴 **①이 ②보다 먼저다.** 거둔 뒤에 기간까지 지난 줄은 **철회됨**이라고 적는다 —
 * 사람이 묻는 것은 「왜 없어졌나」이고 그 답은 「거뒀기 때문」이다. 조회의 `or` 도
 * 거둔 줄을 먼저 본다.
 *
 * 🔵 ③은 **판정과 같은 금**이다 — `starts_at <= 지금` 이면 진행 중
 * (auth/portal-delegations.ts 의 `liveDelegationWhere` 가 쓰는 바로 그 비교).
 * 여기만 `<` 로 적으면 **시작하는 그 순간**에 결재함에는 건이 뜨는데 안내는
 * 「시작 전」이라고 말한다 — 1초짜리 거짓이지만 사람이 보는 것은 그 1초다.
 */
export function delegationPhase(row: DelegationPeriod, now: Date): DelegationPhase {
  if (row.revokedAt !== null) return "REVOKED";
  if (row.endsAt.getTime() <= now.getTime()) return "EXPIRED";
  return row.startsAt.getTime() <= now.getTime() ? "ACTIVE" : "UPCOMING";
}

/** 접기 **안**으로 가는 갈래인가. 🔴 위 네 갈래를 둘로 나누는 자리가 여기 하나다. */
export function isFinishedPhase(phase: DelegationPhase): boolean {
  return phase === "EXPIRED" || phase === "REVOKED";
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
 *
 * 🔴 **끝난 줄도 여기로 온다**(2026-11-17, 접기). 그전에는 조회가 걸러서 ACTIVE 와
 * UPCOMING 둘뿐이었고, 그래서 「ACTIVE 가 아니면 시작 전」으로 적어도 맞았다. 지금
 * 그대로 두면 **만료된 위임이 「아직 시작 전입니다」라고 말한다** — 갈래를 넷으로
 * 늘리면서 가장 쉽게 생기는 거짓말이 그 자리다.
 */
export function delegationSentence(row: DelegationRow, side: DelegationSide, now: Date): string {
  const period = delegationPeriodLabel(row, now);
  const phase = delegationPhase(row, now);
  const from = `${delegationPeriodStart(row, now)} 부터`;
  // 🔴 **끝난 줄은 「지금」을 현재형으로 말하지 않는다.** 까닭은 둘로 갈라 적는다 —
  //    기간이 다한 것과 사람이 거둔 것은 사람에게 **다른 사건**이고, 접기를 열어
  //    보는 이유가 대개 「왜 없어졌나」라서다.
  if (isFinishedPhase(phase)) {
    const why = phase === "REVOKED" ? "통합 승인함에서 거둬들여" : "기간이 끝나";
    if (side === "RECEIVED") {
      return `통합 승인함에서 ${row.delegatorName}님의 결재권을 맡았습니다 (${period}). ${why} 지금은 그분 차례의 휴가 결재가 내 결재함에 뜨지 않습니다.`;
    }
    return `통합 승인함에서 내 결재권을 ${row.delegateName}님에게 맡겼습니다 (${period}). ${why} 지금은 그분이 대신 누를 수 없습니다.`;
  }
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

/* ------------------------------------------------------------------ */
/* ⑩ 끝난 위임을 **접어 둔다** — 네 집이 같은 모양 (2026-11-17)           */
/* ------------------------------------------------------------------ */

/**
 * 끝난 줄을 몇 건까지 접기 안에 담을까.
 *
 * 🔴 **네 집이 같은 수를 쓴다**(A/S·재고관리·통합 승인함의 `FINISHED_DELEGATION_LIMIT`
 * — 지금 50). 한 사람이 같은 날 두 집을 열어 보는데 「최근 N건만」의 N 이 다르면 그것을
 * 결함으로 읽는다. 🔴 **저장소가 넷이라 `tsc` 가 맞대어 보지 못한다** — 한 집이 바꾸는
 * 날 나머지 셋도 함께 봐야 한다.
 *
 * 🔵 50 에 깊은 뜻은 없다. 「한 화면에서 훑을 수 있는 양」이고, 더 뒤까지 찾아야 하면
 * **통합 승인함**이 영구 기록이다 — 🔴 이 집의 변경 이력(`web_audit_logs`)에는 위임
 * 줄이 **한 줄도 없다**. 지정도 철회도 여기서 일어나지 않고 포털이 써 준 사본만
 * 있기 때문이다(schema.ts 의 그 표 ⓑ). 그래서 잘렸을 때 가리키는 곳이 다른 집들과
 * 다르다(아래 `delegationFinishedTruncatedNotice`).
 *
 * 🔴 **순수 모듈에 둔 까닭**: 이 값을 읽는 자리가 셋이다 — 조회(한 줄 더 읽어 넘침을
 * 가린다) · 접는 셈 · 「최근 N건만」 글자. 조회 쪽에 두면 글자를 짓는 이 파일이 DB 를
 * 아는 모듈을 물게 되고, 그 순간 이 파일을 그냥 불러 보던 시험들이 DATABASE_URL 을
 * 읽기 시작한다.
 */
export const DELEGATION_FINISHED_LIMIT = 50;

/**
 * 한 묶음이 화면에 서는 모양 — **펴 둘 줄**과 **접어 둘 줄**, 그리고 접힌 쪽이 잘렸는지.
 *
 * ── 🔴 왜 빼지 않고 접나 ───────────────────────────────────────────────
 * 쓰는 분의 말은 「‘내가 대신하고 있는 것’에 이미 만료된 위임건들이 쌓인다. 만료되면
 * 거기서 없어져도 될 것 같다」였다(2026-11-17). 🔴 **이 집에서 접기는 감추는 일이
 * 아니라 보이게 하는 일이다** — 그전에는 화면용 조회가 끝난 줄을 **아예 안 읽어서**
 * 기간이 지나면 그 줄을 다시 볼 길이 **한 군데도 없었다.** 관리자용 「모두의 결재권
 * 위임」조차 안 끝난 줄만 본다. 재고관리가 똑같은 처지였다.
 *
 * 🔵 칸 이름은 네 집이 같다(`live`·`finished`·`finishedTruncated`·`finishedLimit`) —
 * 화면이 집마다 다른 말을 배우지 않게.
 */
export type DelegationFoldView<Row> = {
  /**
   * 펴 둔 채로 보여 줄 줄(진행 중 · 시작 전). 🔴 **상한이 없다.** 이 집합은 「지금
   * 걸려 있는 위임」이라 본질적으로 작고, 상한에 밀려 **지금 누가 내 결재를 대신하고
   * 있는지**가 안 보이는 것이 이 기능에서 가장 나쁜 일이다.
   */
  live: Row[];
  /** 끝났거나 거둬들인 줄 — 최근 것부터 `finishedLimit` 건까지. 🔵 0건이면 화면이 접기를 **안 그린다**. */
  finished: Row[];
  /** 끝난 줄이 상한보다 많았다. 🔴 화면이 「최근 N건만」을 말해 줘야 한다. */
  finishedTruncated: boolean;
  /** 🔵 화면이 N 을 글자로 박지 않게 함께 내려온다. */
  finishedLimit: number;
};

/**
 * 두 목록을 화면이 받는 모양으로. 🔴 **「상한보다 한 줄 더 읽어 넘침을 가리고, 그 한
 * 줄은 버린다」를 적는 자리가 여기 하나다** — 방향마다 적으면 한쪽에서 `slice` 를
 * 빠뜨리는 날 **51번째 줄이 조용히 화면에 뜬다**(오류는 안 난다).
 *
 * 🔴 **순수 함수라 시험이 그대로 돌려 본다.** 조회 쪽에 두면 「넘쳤다고 말하는가」를
 * 재려면 DB 에 51줄을 넣어야 하는데, 이 집 시험은 DB 에 닿지 않는다.
 *
 * @param finishedPage 🔴 **상한보다 한 줄 더 읽어 온 것**이어야 한다. 딱 상한만큼
 *   읽으면 「정확히 상한만큼 있는 날」과 「넘친 날」이 **같은 답**이 된다.
 * @param limit 🔵 부르는 쪽이 넘긴다 — 조회가 `limit + 1` 로 읽을 때 쓴 바로 그 값이
 *   아니면 셈이 어긋난다.
 */
export function foldFinishedDelegations<Row>(
  live: readonly Row[],
  finishedPage: readonly Row[],
  limit: number = DELEGATION_FINISHED_LIMIT,
): DelegationFoldView<Row> {
  const finishedTruncated = finishedPage.length > limit;
  return {
    live: [...live],
    finished: finishedTruncated ? finishedPage.slice(0, limit) : [...finishedPage],
    finishedTruncated,
    finishedLimit: limit,
  };
}

/**
 * 아무것도 못 읽은 자리에 넘길 빈 묶음 — 🔴 **계정이 명단에 안 이어진 사람**이 그렇다.
 * 그 사람에게는 위임이 걸릴 수조차 없어(화면 머리말) 조회를 아예 안 부른다.
 * 🔵 `{ live: [], finished: [] }` 를 화면에서 손으로 적으면 칸이 하나 늘어나는 날
 * 그 자리만 조용히 안 고쳐진다.
 */
export function emptyDelegationFold<Row>(): DelegationFoldView<Row> {
  return foldFinishedDelegations<Row>([], []);
}

/**
 * 접기 손잡이의 글자. 🔴 **네 집이 같은 말을 해야 한다** — 손으로 베껴 적으면 한쪽만
 * 고치는 날 같은 기능이 집마다 다른 말을 하고, 사람은 그것을 결함으로 읽는다.
 *
 * 🔵 `+` 는 「더 있다」다 — 상한에 걸려 잘렸을 때만 붙는다. 정확한 수를 적지 않는
 * 까닭은 애초에 세지 않기 때문이고(한 줄 더 읽어 넘침만 가린다), 세어 본 적 없는
 * 수를 적는 것보다 낫다.
 */
export function delegationFinishedToggleLabel(
  open: boolean,
  count: number,
  truncated: boolean,
): string {
  return open ? "끝난 위임 접기" : `끝난 위임 보기 (${count}건${truncated ? "+" : ""})`;
}

/**
 * 🔴 **잘렸다는 것을 반드시 말해 준다.** 말하지 않으면 「이게 전부」로 읽히고, 없는
 * 줄을 찾는 사람은 더 볼 곳이 있다는 것조차 모른다.
 *
 * 🔴 **가리키는 곳이 다른 집들과 다르다 — 「통합 승인함」이다.** 다른 집들은 제
 * 변경 이력·감사 로그를 가리키는데, 이 집에는 위임이 거기 **한 줄도 안 남는다**
 * (위 `DELEGATION_FINISHED_LIMIT` 의 그 까닭). 베껴서 「변경 이력」이라고 적으면
 * **없는 곳으로 사람을 보낸다.**
 */
export function delegationFinishedTruncatedNotice(limit: number): string {
  return `끝난 위임은 최근 ${limit}건만 보여 줍니다. 그보다 앞의 기록은 통합 승인함에 남아 있습니다.`;
}

/**
 * 펴 둔 목록이 **비었을 때** 할 말. 🔴 **바로 아래 접혀 있는 줄의 수로 갈린다.**
 *
 * 끝난 줄이 3건 접혀 있는 사람에게 「내가 맡긴 결재권이 없습니다」라고 적으면
 * **거짓말**이고 — 맡긴 적이 있고 그 줄이 접혀 있을 뿐이다 — 그 글을 믿은 사람은
 * **바로 아래 접기를 열어 볼 생각을 못 한다.** 🔵 통합 승인함·A/S 가 같은 날 같은
 * 까닭으로 같은 모양을 넣었다.
 *
 * 🔴 **접힌 줄이 0건이면 옛 글자 그대로**다. 그때는 접기 자체가 안 그려지므로
 * 「아래에서 펼쳐 볼 수 있습니다」가 **없는 손잡이를 가리키게** 된다.
 *
 * @param side 「내가 맡긴 것」인가 「내가 대신하고 있는 것」인가. 🔵 「모두의 결재권
 *   위임」 묶음은 접기가 없어 이 함수를 쓰지 않는다(그쪽은 끝난 줄을 아예 안 읽는다).
 */
export function delegationGroupEmptyNote(side: DelegationSide, finishedCount: number): string {
  if (finishedCount > 0) {
    return side === "RECEIVED"
      ? "지금 대신하고 있는 결재권이 없습니다. 끝난 위임은 아래에서 펼쳐 볼 수 있습니다."
      : "지금 맡기고 있는 결재권이 없습니다. 끝난 위임은 아래에서 펼쳐 볼 수 있습니다.";
  }
  return side === "RECEIVED"
    ? "지금 대신하고 있는 결재권이 없습니다. 통합 승인함에서 누군가 나에게 맡기면 여기에 뜹니다."
    : "내가 맡긴 결재권이 없습니다. 통합 승인함에서 맡기면 여기에 뜹니다.";
}
