/**
 * ============================================================================
 * 결재가 생긴 **뒤에** 포털을 한 번 쿡 찌른다 (2026-10-24)
 * ============================================================================
 * 포털(dss-auth)이 결재 메일을 보낸다. 지금은 포털이 **제가 주기적으로 물어**
 * 보내는 방식이라, 결재가 생긴 순간이 아니라 그 다음 바퀴에서 메일이 나간다.
 * 쓰는 분 요구가 「결재건이 생기자마자」여서, 이 시스템이 결재를 만든 뒤에
 * 포털을 한 번 찔러 그 바퀴를 앞당긴다.
 *
 * ── 🔴 나가는 것은 「누구에게 생겼다」 하나뿐이다 ───────────────────────────
 * 신청자 이름도·날짜도·휴가 종류도·사유도 보내지 않는다. 보내는 것은 결재할
 * 사람의 **포털 번호**(`web_users.auth_sub`)뿐이고, 포털은 그것을 받으면 그
 * 사람의 결재를 **제 통로로 다시 물어**(이 시스템의
 * `/api/integration/approvals`) 아직 안 보낸 것에만 메일을 띄운다. 그래서
 *  ① 이 시스템이 거짓을 보내도 메일 내용이 흔들리지 않고,
 *  ② 포털의 「보낸 기록」이 중복을 막는다.
 * 몸통에 내용을 실으면 그 두 성질이 동시에 무너진다.
 *
 * ── 🔴 누구에게 가는가를 **새로 판정하지 않는다** ───────────────────────────
 * 이 파일에는 「이 사람이 이 결재를 해야 하는가」가 한 줄도 없다. 후보를 넓게
 * 받아(`listCandidates`) 한 명씩 **공용 조건**에 되물을 뿐이다
 * (`isPendingFor` → data.ts 의 `myPendingApprovalWhere` → approval-scope.ts 의
 * `myStepCondition`). 결재함·건수·종·통합 승인함이 쓰는 바로 그 문장이다.
 * 여기서 한 줄이라도 다시 적으면 「결재함엔 떴는데 메일이 안 왔다」나 그보다
 * 나쁜 「결재할 게 없는 사람에게 결재 메일이 간다」가 된다.
 *
 * ── 🔴 2026-11-17: **대리인도 후보에 든다** (설계 D-8 ①) ───────────────────
 * 포털 위임을 받은 사람은 결재함·배지·종·통합 승인함에는 진작 떴는데
 * (조각 8), **「결재가 생겼다」 알림만** 못 받고 있었다 — 알릴 사람을 뽑는 질의가
 * 단계에 박힌 결재자 한 명만 보았기 때문이다. 넓힌 자리는 둘뿐이다:
 *  · 조회가 **사람을 더 긁는다**(data.ts — 거꾸로 방향 위임 조회를 함께 본다).
 *  · 그 사람의 위임 목록을 되묻는 자리에 **그대로 얹는다**(아래 `isPendingFor`).
 * 🔴 **판정은 여전히 한 줄도 없다.** 넓어진 것은 **사람**이고, 대상 단계도
 * 「네 차례인가」도 공용 조건이 그대로 정한다.
 *
 * ── 🔴 신청을 **절대 막지 않는다** ─────────────────────────────────────────
 * 부르는 쪽(workflow.ts)은 **커밋이 끝난 뒤**에 이 함수를 부른다. 트랜잭션
 * 안에서 부르면 포털이 죽은 날 휴가 신청 자체가 실패한다. 그리고 이 함수는
 * **어떤 일이 있어도 던지지 않는다** — 404(통로가 아직 없다)·500·타임아웃·
 * 연결 거부 어느 것도 사람에게 보이지 않아야 한다. 신청은 이미 저장됐다.
 *
 * 🔵 못 찔러도 메일이 안 가는 것이 아니다. 포털의 **주기 작업이 다음 바퀴에
 * 같은 건을 줍는다** — 이 통로는 빠르게 하는 것이지 유일한 길이 아니다.
 * 실패를 통째로 삼킬 수 있는 근거가 그것이다.
 *
 * ── DB 도 망도 인자로 받는다 ────────────────────────────────────────────────
 * portal-notifications.ts 와 같은 자리다. 그래서 이 판단은 DB 없이 그대로
 * 시험할 수 있고(`npm run test:nudge`), 배선은 workflow.ts 에 한 줄로 남는다.
 * ============================================================================
 */
import type { Decider } from "./approval-scope";

/**
 * 결재를 기다리는 단계에 **걸릴 수 있는 사람** 한 줄.
 *
 * 🔴 이 모양의 **원본은 여기**다. 조회하는 쪽(data.ts 의
 * `approvalNudgeCandidates`)이 이것을 `import type` 으로 빌려 쓴다 — 반대로
 * 하면 이 파일이 DB 를 끌어오게 되어 DB 없이 돌리는 성질이 깨진다(머리말).
 *
 * 🔴 「걸린다」가 아니라 **「걸릴 수 있다」**다. 저쪽 조회는 일부러 넓고,
 * 좁히는 일은 아래 `isPendingFor`(공용 조건)가 한다.
 */
export type ApprovalNudgeCandidate = {
  employeeId: string;
  rankId: string;
  isApprover: boolean;
  /** 포털 번호. 🔴 **없을 수 있다** — 아래 처리 참조. */
  authSub: string | null;
  /**
   * 🔴 **이 사람이 지금 대신 결재할 수 있는 사람들**의 명단 번호
   * (2026-11-17, 설계 D-8 ①). 결재함·배지·종이 쓰는 칸과 **같은 것**이고
   * (approval-scope.ts 의 `Decider.actingForEmployeeIds`), 아래에서 되물을 때
   * **그대로** 얹는다.
   *
   * 🔵 화면 쪽은 그 사람의 위임을 **전부** 싣고 여기는 **이 신청의 단계 주인에
   * 걸린 것만** 싣는다 — 되묻는 질의가 신청 하나로 좁혀 묻기 때문에
   * (`hasPendingApprovalFor`) 답은 어느 쪽이든 같다. 읽어 온 자리도 한
   * 곳이다(auth/portal-delegations.ts, 같은 `liveNowParts`).
   *
   * 🔴 **여기서 무엇을 판정하는 것이 아니다.** 이 칸이 있어야 공용 조건이 「맡긴
   * 사람의 단계도 이 사람 것이다」라고 답할 수 있을 뿐이다 — 얹지 않으면 포털
   * 위임을 받은 대리인은 후보에 올라와도 **공용 조건이 한 명씩 다 걸러낸다.**
   *
   * 🔵 **없는 것(undefined)은 「위임 없음」이다** — `Decider` 의 같은 칸과 같은
   * 약속이다. 위임이 하나도 없는 보통의 결재자는 이 칸 없이 그대로 지나간다.
   */
  actingForEmployeeIds?: readonly string[];
};

/**
 * 「누가 누구를 대신할 수 있다」 한 줄. 🔴 **명단 번호 둘뿐이다** — 이름도
 * 기간도 싣지 않는다.
 *
 * 🔴 **모양의 원본이 여기 있는 까닭**은 위 `ApprovalNudgeCandidate` 와 같다:
 * 읽어 오는 쪽(auth/portal-delegations.ts 의 `loadDelegatesForApprovers`)이
 * 이것을 `import type` 으로 빌려 쓴다. 반대로 하면 이 파일이 DB 를 끌어오게
 * 되어 「DB 없이 그대로 돌려 볼 수 있다」는 성질이 깨진다(머리말).
 */
export type ActingForPair = {
  /** 결재권을 맡긴 사람 — 지금 단계에 **박혀 있는** 결재자다. */
  delegatorEmployeeId: string;
  /** 대신 누를 수 있는 사람 — 알림이 함께 가야 하는 쪽이다. */
  delegateEmployeeId: string;
};

/**
 * 🔴 **대리인을 후보에 **더하는** 자리** (2026-11-17, 설계 D-8 ①).
 *
 * ── 무엇을 넓히고 무엇을 안 넓히나 ────────────────────────────────────────
 * 넓어지는 것은 **사람**뿐이다. 🔴 **대상 단계는 한 줄도 안 넓어진다** — 어느
 * 단계를 보는지는 조회 쪽(data.ts 의 `nudgeStepWhere`)이 정하고 이 함수는 그
 * 결과만 받는다. `SKIPPED`·이미 끝난 단계가 여기로 흘러들 길이 아예 없다.
 *
 * 🔴 **같은 사람이 두 번 나오지 않는다.** 세 가지 겹침이 실제로 있다:
 *  · 대리인이 **제 단계로도** 걸려 있다 (한 줄에 합치고 맡긴 사람만 보탠다).
 *  · 한 사람이 **여럿을 대신한다** (한 줄에 번호 여럿이 실린다).
 *  · 맡긴 사람과 대리인이 **같다** (포털이 자기 지정을 허용한다 — 합쳐지고
 *    공용 조건 쪽에서 중복이 한 번 더 걷힌다).
 * 두 줄로 내보내면 같은 사람에게 **메일이 두 번** 가고, 그것은 받는 사람 눈에
 * 결함으로만 보인다.
 *
 * 🔵 **판정이 아니다.** 여기서 만든 줄은 한 명씩 공용 조건에 되묻는 길
 * (`nudgeApprovalCreated` → `isPendingFor`)을 그대로 지난다 — 대리인도 예외가
 * 아니다. 넓게 고르고 좁히는 것은 저쪽이라는 이 파일의 규칙 그대로다.
 *
 * @param onSteps 열린 단계에 걸린 사람들(조회가 일부러 넓게 고른 것).
 * @param pairs   「이 결재자를 누가 대신하나」 — 살아 있는 위임만 들어 있다.
 * @param delegates 대리인들의 직급·계정. 🔴 **이미 `onSteps` 에 있는 사람은 담지
 *                  않아도 된다** — 그 줄을 그대로 쓴다.
 */
export function withDelegateCandidates(params: {
  onSteps: readonly ApprovalNudgeCandidate[];
  pairs: readonly ActingForPair[];
  delegates: readonly ApprovalNudgeCandidate[];
}): ApprovalNudgeCandidate[] {
  const byEmployee = new Map<string, { row: ApprovalNudgeCandidate; acting: Set<string> }>();
  // 🔵 차례를 Map 에 맡기지 않고 따로 적는다 — 단계에 걸린 사람이 먼저,
  //    위임으로 더해진 사람이 뒤다. 「원래 가던 사람의 차례는 그대로」가 눈으로
  //    보여야 이 조각이 무엇을 바꿨는지 읽힌다.
  const order: string[] = [];
  const remember = (row: ApprovalNudgeCandidate) => {
    const seen = byEmployee.get(row.employeeId);
    if (seen) return seen;
    const fresh = { row, acting: new Set(row.actingForEmployeeIds ?? []) };
    byEmployee.set(row.employeeId, fresh);
    order.push(row.employeeId);
    return fresh;
  };

  for (const row of params.onSteps) remember(row);

  const delegateRows = new Map(params.delegates.map((row) => [row.employeeId, row]));
  for (const pair of params.pairs) {
    const row = byEmployee.get(pair.delegateEmployeeId)?.row ?? delegateRows.get(pair.delegateEmployeeId);
    // 🔴 번호는 있는데 줄이 없으면 **넘긴다.** 명단에 없는 사람은 후보가 될 수
    //    없고, 여기서 빈 줄을 지어내면 직급도 계정도 거짓이 된다. 표의 외래키가
    //    맡긴 사람·대리인을 둘 다 명단에 묶어 두므로 실제로 생기지는 않는다.
    if (!row) continue;
    remember(row).acting.add(pair.delegatorEmployeeId);
  }

  return order.map((employeeId) => {
    const { row, acting } = byEmployee.get(employeeId)!;
    // 🔵 보탤 것이 없으면 받은 줄을 **그대로** 내보낸다 — 위임이 없는 날 이
    //    함수를 지나기 전과 지난 뒤가 값까지 같아야, 「위임 때문에 달라진 것」만
    //    눈에 남는다.
    return acting.size === 0 ? row : { ...row, actingForEmployeeIds: [...acting] };
  });
}

export type ApprovalNudgeDeps = {
  /** 이 신청의 열린 단계에 걸릴 수 있는 사람들(일부러 넓다). */
  listCandidates: (requestId: string) => Promise<readonly ApprovalNudgeCandidate[]>;
  /** 🔴 공용 조건 그대로 — 「이 신청이 지금 이 사람의 결재함에 서 있는가」. */
  isPendingFor: (me: Decider, requestId: string) => Promise<boolean>;
  /** 포털을 찌른다. 돌려주는 것은 「찔렀는가」뿐이다. */
  send: (subs: readonly string[]) => Promise<boolean>;
  /**
   * 사람에게 보여 줄 수 없는 사정을 남길 자리. 기본은 `console.warn` 이다.
   * 시험이 여기로 받아 읽는다.
   */
  warn?: (message: string) => void;
};

export type ApprovalNudgeOutcome = {
  /** 포털에 실어 보낸 번호. */
  nudged: string[];
  /**
   * 🔴 결재는 해야 하는데 **포털 번호가 없어** 못 부른 사람(직원 id).
   * 조용히 삼키면 영영 안 드러나므로 로그에도 함께 남는다.
   */
  missingPortalNumber: string[];
  /** 포털이 받았는가. 부를 일이 없었으면 false 다(실패와 구별하지 않는다). */
  delivered: boolean;
};

const NOTHING: ApprovalNudgeOutcome = {
  nudged: [],
  missingPortalNumber: [],
  delivered: false,
};

/** 오류의 **종류**만. 메시지에는 주소·식별자가 딸려 나올 수 있다. */
function kindOf(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/**
 * 결재가 생겼음을 포털에 알린다. 🔴 **던지지 않는다.**
 *
 * @param requestId 방금 결재가 생긴(또는 다음 차례로 넘어간) 휴가 신청.
 *                  🔴 **커밋이 끝난 뒤**의 id 여야 한다 — 아직 커밋되지 않은
 *                  트랜잭션 안의 행은 이 함수가 쓰는 조회(다른 접속이다)에
 *                  보이지 않아, 아무 일도 안 한 채 조용히 끝난다.
 */
export async function nudgeApprovalCreated(
  requestId: string,
  deps: ApprovalNudgeDeps,
): Promise<ApprovalNudgeOutcome> {
  const warn = deps.warn ?? ((message: string) => console.warn(message));

  const subs: string[] = [];
  const missing: string[] = [];

  try {
    const candidates = await deps.listCandidates(requestId);
    for (const candidate of candidates) {
      // 🔴 여기가 유일한 판정이고, 그 판정은 **남의 것**이다. 후보가 넓어도
      //    (옛 직급 단계는 그 직급의 직원이 전부 후보다) 공용 조건이 한 명씩
      //    걸러 준다 — 신청자 자신·직급에 결재권이 없는 사람·이미 끝난 신청이
      //    여기서 빠진다.
      const mine = await deps.isPendingFor(
        {
          employeeId: candidate.employeeId,
          rankId: candidate.rankId,
          isApprover: candidate.isApprover,
          // 🔴 **그대로 얹는다**(2026-11-17, 설계 D-8 ①). 포털 위임으로 대신
          //    누를 수 있는 사람들의 번호이고, 화면이 지나는 길에서는 같은 값을
          //    data.ts 의 `deciderOf` 가 싣는다. 🔴 여기서 빠뜨리면 대리인이
          //    후보에 올라와도 공용 조건이 **한 명도 빠짐없이 걸러내** 알림이
          //    영영 안 간다 — 오류는 하나도 안 난다.
          actingForEmployeeIds: candidate.actingForEmployeeIds,
        },
        requestId,
      );
      if (!mine) continue;

      // 🔴 이 시스템은 계정과 직원이 **두 단계**로 이어져 있다
      //    (auth_sub → employee_id → employees.id). 결재선에는 올랐는데 아직
      //    계정이 안 달렸거나 계정이 정지·삭제된 사람은 부를 번호가 없다.
      //    🔴 그 사람의 결재는 포털의 **주기 작업도 못 찾는다** — 포털이
      //    사람을 가리키는 값은 번호뿐이고, 번호로 되짚는 자리
      //    (auth/portal-actor.ts)가 같은 조건으로 걸러 빈 답을 주기 때문이다.
      //    그래서 **반드시 로그에 남긴다.** 조용히 넘기면 「저 사람만 결재
      //    메일을 못 받는다」가 영영 드러나지 않는다.
      if (!candidate.authSub) {
        missing.push(candidate.employeeId);
        warn(
          `[approval] 포털 번호가 없어 결재 알림을 찌르지 못했습니다 — ` +
            `직원 ${candidate.employeeId} · 신청 ${requestId}. ` +
            `휴가 관리자가 「직원 관리」에서 계정을 잇거나 정지를 풀어야 합니다.`,
        );
        continue;
      }
      subs.push(candidate.authSub);
    }
  } catch (error) {
    // 대상을 모으다 깨져도 신청은 이미 저장돼 있다. 까닭만 남기고 끝낸다.
    warn(`[approval] 결재 알림 대상을 모으지 못했습니다 — 신청 ${requestId} (${kindOf(error)})`);
    return NOTHING;
  }

  if (subs.length === 0) {
    // 🔵 흔한 정상이다 — 반려·확정·거둬들이기로 **열린 단계가 없어진** 자리도
    //    이 함수를 지난다(부르는 쪽이 미리 가르지 않는 까닭은 workflow.ts 에).
    return { nudged: [], missingPortalNumber: missing, delivered: false };
  }

  try {
    return { nudged: subs, missingPortalNumber: missing, delivered: await deps.send(subs) };
  } catch (error) {
    // 보내는 쪽(oidc.ts)은 이미 던지지 않지만 그 약속에 기대지 않는다 —
    // 여기서 새면 「신청은 됐는데 화면에는 실패라고 뜨는」 모양이 된다.
    warn(`[approval] 결재 알림을 찌르지 못했습니다 — 신청 ${requestId} (${kindOf(error)})`);
    return { nudged: subs, missingPortalNumber: missing, delivered: false };
  }
}
