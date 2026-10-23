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
};

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
