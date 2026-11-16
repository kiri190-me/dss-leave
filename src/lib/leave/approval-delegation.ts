/**
 * ============================================================================
 * 「이 사람이 지금 누구를 대신해 결재할 수 있나」 — 포털에 맡긴 결재권 위임
 * ============================================================================
 * 2026-11-13 결정으로 결재권 위임을 **포털(dss-auth) 한 곳에** 모았다
 * (설계: dss-approvals/DELEGATION_DESIGN.md 의 B-1·B-2·B-9). 지정·되돌리기는
 * 통합 승인함이 하고, 저장은 포털이 하고, **여기는 읽기만 한다** — 이 시스템에
 * 위임 화면도 위임 표도 만들지 않는다.
 *
 * 🟢 이 저장소에는 자체 위임이 **없었다**. 그래서 A/S 처럼 「두 고지의 위임을
 * 합치는」 일이 없고, 포털이 답한 것이 곧 전부다(설계 D-5).
 *
 * ── 🔴 왜 이 결재에 위임이 필요한가 ────────────────────────────────────────
 * 휴가 결재는 **단계마다 결재자가 정확히 한 명**이다 — 역할도 직급도 아니고
 * 결재선에 이름이 오른 그 직원이다(`web_approval_steps.approver_employee_id`).
 * 그 사람이 자리를 비우면 **그 휴가 결재가 멈춘다.** 지금까지의 완화책은
 * 휴가 관리자의 [건너뛰기](workflow.ts 의 `skipStep`)뿐인데, 그것은 승인이
 * 아니라 그 관문을 `SKIPPED` 로 지우는 것이라 **「누가 대신 결재했는지」가
 * 기록에 남지 않는다.** 🔴 **둘은 공존한다** — [건너뛰기]는 퇴사·장기 부재용
 * 이고(그런 사람에게는 맡길 당사자가 없다), 위임은 자리를 비운 동안의 것이다.
 *
 * ── 🔴 열쇠가 **두 단**이다. 이 집에만 있는 사정이다 ───────────────────────
 *
 *     포털 sub → web_users.auth_sub 로 찾기 → web_users.employee_id
 *              → web_employees.id        ← 결재 권한의 실제 열쇠
 *
 * 로그인 계정(`web_users`)과 직원 명단(`web_employees`)이 **서로 다른 표**이고,
 * 결재 권한은 **명단 번호**가 쥔다. 🔴 중간 단이 **NULL 일 수 있다** — 포털
 * 로그인은 됐지만 아직 명단에 안 이어진 계정이다(2026-11-16 운영 실측: 로그인
 * 계정 8명 중 1명). 🔵 그 사람은 애초에 결재자가 될 수 없어 위험하지 않지만,
 * 🔴 **바꾸지 못한 수를 세어 남긴다** — 「오늘은 1」이지 「영원히」가 아니고,
 * 안 세면 그 사람만 **오류 없이 조용히** 위임이 안 듣는 것을 영영 모른다.
 *
 * ── 🔴 빈 목록과 「못 물었다」를 뭉개지 않는다 ─────────────────────────────
 * 포털에 못 물었을 때는 **「위임 없음」으로 보고 결재를 그대로 진행한다**
 * (설계 B-6). 포털 한 곳이 멈추면 세 시스템의 결재가 **전부** 멈추는 쪽이 더
 * 비싸다고 판단한 것이다. 🔴 그 대가는 「**대리인만 조용히 막힌다**」이고, 이
 * 저장소들에서 가장 비싼 결함 모양이 바로 그것이라, 설계 B-7 이 **눈에 보이는
 * 안내**를 띄우라고 못 박았다. 안내를 띄우려면 「물어봤더니 없더라」와 「못
 * 물었다」가 **값에서 갈려 있어야** 한다 — 둘 다 `[]` 로 뭉개면 안내할 자리에서
 * 구별할 길이 영영 없어진다. 그래서 이 타입에 칸이 둘이다.
 *
 * ── DB 도 망도 **인자로 받는다** ───────────────────────────────────────────
 * approval-nudge.ts · portal-notifications.ts 와 같은 자리다. 그래서 이 판단은
 * DB 없이·사내망에 나가지 않고 그대로 시험할 수 있고
 * (`npm run test:delegation`), 배선은 auth/portal-delegations.ts 에 남는다.
 * ============================================================================
 */

/**
 * 포털에 물어본 결과. 🔴 **두 칸을 한 칸으로 줄이지 마라**(파일 머리말).
 */
export type PortalActingDelegations = {
  /**
   * 「지금 이 사람이 대신 결재할 수 있는 결재권자들」 — **이 시스템의
   * `web_employees.id`** 로 바꿔 둔 값이다.
   *
   * 🔴 포털이 주는 것은 **포털 번호(`sub`)** 이고 결재 판정은 **명단 번호**로
   * 돈다. 바꾸는 자리는 아래 `resolveActingDelegations` 한 곳이고, 여기 들어오는
   * 값은 **이미 바뀐 뒤**다. 포털 번호를 그대로 넣으면 오류 없이 영원히 아무도
   * 못 누른다.
   *
   * 🔵 **본인이 섞여 있어도 된다** — 포털은 답의 맨 앞에 부른 사람 자신을 넣어
   * 준다. 합치는 자리(approval-scope.ts 의 `approvableEmployeeIds`)가 본인을
   * 맨 앞에 두고 중복을 걷으므로 여기서 따로 빼지 않는다.
   */
  actingForEmployeeIds: readonly string[];
  /**
   * 🔴 **포털에 못 물었다**(죽었거나·느렸거나·우리를 거절했거나·이상한 모양을
   * 주었거나). 그때 위 목록은 비지만, 그 빈 목록은 「없다」가 아니라 **「모른다」**다.
   *
   * 🔵 포털에 번호가 없는 사람(임시 로그인)과 포털이 설정되지 않은 기계는 여기
   * 해당하지 않는다 — 장애가 아니라 **사실**이다. 그 사람에게는 포털 위임이
   * 걸릴 수조차 없어서, 「잠시 후 다시 시도해 주세요」라고 말하면 영영 오지
   * 않을 때를 기다리게 한다.
   */
  unavailable: boolean;
};

/**
 * 🔴 **「이 결재에는 포털 위임을 묻지 않았다」를 글자로 적는 자리.**
 *
 * `{ actingForEmployeeIds: [], unavailable: false }` 를 그 자리에 바로 쓰면
 * 「묻고 보니 없었다」와 「아예 안 물었다」가 똑같이 생긴다. 이름을 붙여 두면
 * **왜 안 물었는지**를 부르는 쪽 주석이 설명하게 된다.
 *
 * 🔴 `unavailable` 이 **거짓**인 것에 뜻이 있다. 안 물은 것은 장애가 아니므로
 * 「포털을 확인하지 못했습니다」 안내가 뜨면 안 된다.
 *
 * 지금 이 값이 기본값으로 쓰이는 자리:
 *  · 🔴 **포털이 결재 목록을 가져가는 통로**(`/api/integration/approvals`) —
 *    거기서 또 포털에 물으면 **포털이 이쪽을 기다리는 동안 이쪽이 포털을
 *    기다린다.** 안 묻는 것이 그 통로의 규칙이다(A/S 가 먼저 밟았다).
 *  · 머리말의 대기 건수·알림 종 — 모든 화면에 딸려 오는 자리라 포털 왕복을
 *    더하지 않는다(아래 「어디서 묻는가」).
 *  · `decideStep` 을 **직접 부르는 시험·스크립트** — 사내망에 나가지 않는다.
 *
 * ── 🔵 어디서 묻는가 (2026-11-16) ─────────────────────────────────────────
 * 묻는 자리는 **둘뿐**이다: 결재함 화면(`/approvals`)과 결재를 실제로 누르는
 * 서버 액션(`decideAction`). 그 둘이 「보이는가」와 「눌러지는가」를 맡는다.
 */
export const NO_PORTAL_DELEGATIONS: PortalActingDelegations = {
  actingForEmployeeIds: [],
  unavailable: false,
};

/**
 * 포털의 답. 🔴 **`asked: true` 이면서 빈 목록**이 「물어봤더니 없더라」다 —
 * `asked: false`(못 물었다)와 다른 답이다.
 */
export type PortalActingAnswer = { asked: true; subs: readonly string[] } | { asked: false };

/**
 * 포털 번호 한 줄을 이 시스템의 계정·명단으로 되짚은 결과.
 *
 * 🔴 `employeeId` 가 **null 일 수 있다** — 계정은 있는데 명단에 안 이어진
 * 사람이다(머리말의 중간 단). 조회가 그 줄을 **버리지 않고 그대로 올려 주어야**
 * 아래에서 「계정이 아예 없는 사람」과 갈라 셀 수 있다.
 */
export type DelegatedApproverRow = {
  authSub: string;
  employeeId: string | null;
};

export type ActingDelegationDeps = {
  /** 포털에 묻는다(auth/oidc.ts). 🔴 던지지 않기로 돼 있지만 기대지 않는다. */
  ask: (subject: string) => Promise<PortalActingAnswer>;
  /** 포털 번호들 → 이 시스템의 계정·명단(auth/portal-delegations.ts). */
  lookup: (subs: readonly string[]) => Promise<readonly DelegatedApproverRow[]>;
  /**
   * 사람에게 보여 줄 수 없는 사정을 남길 자리. 기본은 `console.warn` 이다.
   * 시험이 여기로 받아 읽는다(approval-nudge.ts 와 같은 규약).
   */
  warn?: (message: string) => void;
};

/** 오류의 **종류**만. 메시지에는 주소·식별자가 딸려 나올 수 있다. */
function kindOf(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/**
 * 「지금 내가 대신 결재할 수 있는 사람들」을 **명단 번호**로.
 *
 * @param subject 이 사람의 포털 번호(= ID 토큰의 `sub`, `web_users.auth_sub`).
 *                🔴 **빈 값이면 묻지 않는다** — 포털 계정과 이어지지 않은
 *                사람이고, 그에게는 포털 위임이 걸릴 수조차 없다.
 *
 * 🔴 **던지지 않는다.** 못 물었으면 `unavailable: true` 인 빈 목록이다 —
 * 결재는 그대로 진행되고(본인 단계는 멀쩡히 눌린다) 안내만 뜬다(설계 B-6·B-7).
 *
 * 🔴 **이어 붙이지 않는다.** A→B, B→C 라도 C 는 A 를 못 얻는다. 그 판정은
 * **포털이 이미** 했고, 여기서 한 번 더 이어 붙이면 아무도 지정하지 않은
 * 결재권이 생긴다.
 */
export async function resolveActingDelegations(
  subject: string,
  deps: ActingDelegationDeps,
): Promise<PortalActingDelegations> {
  const warn = deps.warn ?? ((message: string) => console.warn(message));

  // 🔵 장애가 아니다 — 물을 것이 없다. 안내가 뜨면 안 되는 자리다(위 상수 주석).
  if (!subject) return NO_PORTAL_DELEGATIONS;

  let answer: PortalActingAnswer;
  try {
    answer = await deps.ask(subject);
  } catch (error) {
    // 묻는 쪽(oidc.ts)은 이미 던지지 않지만 그 약속에 기대지 않는다 — 여기서
    // 새면 결재 화면이 통째로 500 이 된다(approval-nudge.ts 와 같은 판단).
    warn(`[delegation] 결재권 위임을 물어보지 못했습니다 (${kindOf(error)})`);
    return { actingForEmployeeIds: [], unavailable: true };
  }
  if (!answer.asked) return { actingForEmployeeIds: [], unavailable: true };

  // 🔴 **본인 번호를 여기서 빼지 않는다**(위 타입 주석). 하지만 답이 비어 있으면
  //    바꿀 것도 없으므로 DB 를 두드리지 않고 끝낸다.
  if (answer.subs.length === 0) return NO_PORTAL_DELEGATIONS;

  let rows: readonly DelegatedApproverRow[];
  try {
    rows = await deps.lookup(answer.subs);
  } catch (error) {
    // 물어는 봤는데 **바꾸지 못했다.** 결과는 「못 물었다」와 같다 — 위임이
    // 안 걸리므로 안내도 같이 떠야 한다.
    warn(`[delegation] 포털이 준 번호를 직원 명단으로 바꾸지 못했습니다 (${kindOf(error)})`);
    return { actingForEmployeeIds: [], unavailable: true };
  }

  const actingForEmployeeIds: string[] = [];
  let unlinked = 0;
  for (const row of rows) {
    if (row.employeeId) actingForEmployeeIds.push(row.employeeId);
    // 계정은 있는데 **명단에 안 이어졌다** — 머리말의 중간 단 NULL.
    else unlinked += 1;
  }
  // 이 시스템에 계정이 아예 없거나 정지·삭제된 사람, 그리고 uuid 모양이 아닌
  // 번호. 🔵 포털은 여러 시스템에 같은 사람을 말하므로 **흔한 정상**이기도 하다.
  const unknown = answer.subs.length - rows.length;

  if (unlinked > 0 || unknown > 0) {
    // 🔴 **개수만** 남긴다. 포털 번호는 사람을 가리키는 값이라 로그에 쌓지
    //    않는 것이 이 묶음의 규약이다(oidc.ts 의 로그 규약).
    warn(
      `[delegation] 포털이 준 결재권 위임 ${answer.subs.length}건 가운데 ` +
        `${unlinked + unknown}건을 직원으로 바꾸지 못했습니다 ` +
        `(명단 미연결 ${unlinked} · 이 시스템에 계정 없음 ${unknown}). ` +
        `그 사람의 결재는 대신 누를 수 없습니다 — 휴가 관리자가 「직원 관리」에서 계정을 이어야 합니다.`,
    );
  }

  return { actingForEmployeeIds, unavailable: false };
}
