import Link from "next/link";

import type { PortalDelegationView } from "@/lib/auth/portal-delegations";
import {
  DELEGATION_EMPTY_NOTE,
  DELEGATION_PHASE_CHIP,
  DELEGATION_PHASE_LABEL,
  DELEGATION_READ_ONLY_NOTE,
  allDelegationSentence,
  delegationFinishedToggleLabel,
  delegationFinishedTruncatedNotice,
  delegationNoticeLines,
  delegationPhase,
  delegationSentence,
  type DelegationFoldView,
  type DelegationSide,
} from "@/lib/leave/delegation-view";
import { settingsTabHref } from "@/lib/leave/settings-tabs";

/**
 * ============================================================================
 * 결재권 위임을 **보여 주기만** 하는 조각들 (2026-11-17, 조각 3c)
 * ============================================================================
 * 두 화면이 이 파일을 함께 쓴다 — 결재함 맨 위의 안내와 [휴가 설정 → 결재권 위임]
 * 탭의 묶음들. 🔴 **글자는 여기 없다** — 문장은 전부 lib/leave/delegation-view.ts
 * 가 만든다. 두 화면이 **같은 말**을 하게 하려는 것이고, 그 까닭은 거기 머리말에
 * 적혀 있다.
 *
 * 🔴 **단추가 하나도 없다.** 맡기기도 거두기도 통합 승인함에서만 한다(설계
 * B-2·B-9). 여기 [되돌리기]를 그리면 눌러도 아무 일이 없고, 사람은 그것을 고장으로
 * 읽는다.
 *
 * 🔴 **서버 컴포넌트다**(`"use client"` 가 없다). 상태도 이벤트도 없으므로 클라이언트로
 * 내려보낼 까닭이 없고, 내려보내면 위임 줄이 통째로 브라우저 번들에 실린다.
 * 🔵 2026-11-17 에 여닫는 자리가 하나 생겼는데(끝난 위임 접기) `<details>` 라
 * **여전히 상태가 없다** — 그 까닭은 `FinishedFold` 머리말에 있다.
 *
 * 🔵 **다크 모드 클래스를 쓰지 않는다** — 이 집에는 `dark:` 가 한 줄도 없다(2026-11-17
 * 실측). 다른 집에서 베껴 오면 이 사이트에서만 쓰이지 않는 글자가 늘어난다.
 * ============================================================================
 */

/**
 * 「여기서는 못 거둔다 · 가야 할 곳은 통합 승인함」 한 줄.
 *
 * 🔴 **주소가 없으면 링크 없이 글자만** 나간다. `APPROVALS_BASE_URL` 은 세 집이
 * 같은 이름으로 쓰는 값인데, 안 적혀 있다고 화면이 깨지면 위임과 아무 상관없는
 * 사람까지 결재함을 잃는다(lib/env.ts 의 그 getter 머리말).
 */
export function DelegationSourceNote({
  approvalsUrl,
  className = "",
}: {
  approvalsUrl: string | null;
  className?: string;
}) {
  return (
    <p className={`text-xs text-slate-500 ${className}`}>
      {DELEGATION_READ_ONLY_NOTE}
      {approvalsUrl && (
        <>
          {" "}
          <a
            href={approvalsUrl}
            className="font-medium text-slate-700 underline underline-offset-2 hover:text-slate-900"
          >
            통합 승인함 열기
          </a>
        </>
      )}
    </p>
  );
}

/**
 * 딱지 — 🔴 **줄 하나를 통째로 받는다.** 2026-11-17 까지는 `startsAt` 하나만 받았는데,
 * 접기가 생기면서 **끝난 줄도 이 자리에 온다** — 시작 시각만 보면 만료된 위임에
 * 「진행 중」이 붙고, 그 거짓말은 아무 오류도 내지 않는다.
 */
function PhaseChip({ row, now }: { row: PortalDelegationView; now: Date }) {
  const phase = delegationPhase(row, now);
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${DELEGATION_PHASE_CHIP[phase]}`}>
      {DELEGATION_PHASE_LABEL[phase]}
    </span>
  );
}

/**
 * 묶음 안의 한 줄. 🔴 **펴 둔 쪽과 접힌 쪽이 이 조각 하나를 함께 쓴다** — 접기 안을
 * 따로 그리면 「접힌 안의 줄은 지금과 똑같이 그린다」는 약속이 조용히 갈린다.
 *
 * 🔵 뺄 칸이 없다. 다른 집들은 접기 안에서 「작업/되돌리기」 칸만 뺐는데, 이 집에는
 * 애초에 그 칸이 없다 — 맡기기도 거두기도 통합 승인함에서만 한다(파일 머리말).
 */
function DelegationRowItem({
  row,
  side,
  now,
}: {
  row: PortalDelegationView;
  side: DelegationSide | "ALL";
  now: Date;
}) {
  return (
    <li className="border-t border-slate-100 pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-start gap-2">
        <PhaseChip row={row} now={now} />
        <p className="min-w-0 flex-1 text-sm text-slate-800">
          {side === "ALL" ? allDelegationSentence(row, now) : delegationSentence(row, side, now)}
        </p>
      </div>
      {/* 맡긴 까닭. 없으면 빈 글자로 오므로(통로 규약) 줄 자체를 안 그린다. */}
      {row.reason.trim() !== "" && <p className="mt-1 text-xs text-slate-500">사유: {row.reason}</p>}
    </li>
  );
}

/**
 * 끝난 위임을 접어 두는 자리 — 🔴 **묶음마다 하나씩**(2026-11-17, 설계 C-5).
 *
 * ── 🔴 **이 집에서 접기는 감추는 일이 아니라 보이게 하는 일이다** ─────────
 * 쓰는 분의 말은 「‘내가 대신하고 있는 것’에 이미 만료된 위임건들이 쌓인다. 만료되면
 * 거기서 없어져도 될 것 같다」였다. 그런데 이 집은 **반대쪽으로 극단이었다** — 화면용
 * 조회가 끝난 줄을 아예 안 읽어서 기간이 지나면 그 위임을 **다시 볼 길이 한 군데도
 * 없었다.** 「모두의 결재권 위임」도 안 끝난 줄만 본다. 그래서 접기를 넣는 이 조각이
 * 곧 **끝난 위임을 처음으로 보여 주는** 조각이다.
 *
 * ── 🔴 **`details` 다 — 자바스크립트를 쓰지 않는다** ────────────────────
 * 이 파일은 서버 조각이고, 상태로 여닫으려면 통째로 클라이언트로 내려가 위임 줄이
 * 브라우저 번들에 실린다(파일 머리말). 🔵 **덕분에 두 묶음의 접기가 저절로 따로**
 * 기억된다 — 상태를 나눠 쓸 일이 없어서다. 🔴 `<details>` 에 `name` 을 붙이면 안
 * 된다: 이름이 같은 `details` 는 브라우저가 **서로 닫는다**(하나를 펴면 다른 쪽이
 * 접힌다). 🔵 본보기인 A/S·재고관리는 같은 자리를 단추로 여닫는데, 그 집들의 그
 * 화면은 이미 통째로 클라이언트 조각이라 대가가 없다. 통합 승인함이 같은 까닭으로
 * 같은 수를 썼다.
 *
 * 🔵 **0건이면 이 자리가 통째로 없다.** 눌러 봐야 빈 목록만 나오는 손잡이는 할 일을
 * 지어낸다. 🔴 「펴 둔 쪽이 0건」과는 다르다 — 그쪽은 묶음을 감추지 않고 말로 적는다.
 */
function FinishedFold({
  fold,
  side,
  now,
}: {
  fold: DelegationFoldView<PortalDelegationView>;
  side: DelegationSide;
  now: Date;
}) {
  if (fold.finished.length === 0) return null;
  const count = fold.finished.length;
  return (
    <details className="group mt-3">
      {/* 🔴 삼각형은 `list-none`(크롬·파이어폭스)과 `::-webkit-details-marker`(사파리)를
          **둘 다** 꺼야 사라진다.
          🔴 글자는 순수 함수가 정한다 — 네 집이 같은 말을 해야 한다. 펴면 「접기」로
          바뀌는 것을 자바스크립트 없이 하려고 두 글자를 **둘 다 그려 두고** 여닫힘에
          따라 하나씩 숨긴다(`group-open:`). 하나만 그리면 details 로는 글자를 못 바꾼다. */}
      <summary className="inline-flex cursor-pointer list-none select-none items-center rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">
          {delegationFinishedToggleLabel(false, count, fold.finishedTruncated)}
        </span>
        <span className="hidden group-open:inline">
          {delegationFinishedToggleLabel(true, count, fold.finishedTruncated)}
        </span>
      </summary>
      {/* 🔴 잘렸다는 것을 **반드시** 말해 준다. 말하지 않으면 「이게 전부」로 읽히고,
          없는 줄을 찾는 사람은 더 볼 곳이 있다는 것조차 모른다. 🔴 건수를 글자로 박지
          않는다 — 상한은 조회가 정해 함께 내려보낸다. */}
      {fold.finishedTruncated && (
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          {delegationFinishedTruncatedNotice(fold.finishedLimit)}
        </p>
      )}
      <ul className="mt-3 space-y-3">
        {fold.finished.map((row) => (
          <DelegationRowItem key={row.id} row={row} side={side} now={now} />
        ))}
      </ul>
    </details>
  );
}

/**
 * 탭 안의 묶음 하나 — 「내가 대신하고 있는 것」·「내가 맡긴 것」·「모두의 결재권 위임」.
 *
 * 🔴 **비었으면 「없습니다」를 분명히 적는다.** 빈 자리는 고장으로 읽힌다 — 사용자가
 * 2026-11-17 에 「위임되었다는 내용이 안 뜬다」고 한 것이 정확히 그 모양이었다.
 * 🔴 다만 **끝난 줄이 바로 아래 접혀 있으면 그 글은 거짓말이 된다** — 그때 뭐라고
 * 적을지는 부르는 쪽이 `delegationGroupEmptyNote` 로 고른다.
 */
export function DelegationGroup({
  title,
  side,
  rows,
  now,
  empty = DELEGATION_EMPTY_NOTE,
  fold,
}: {
  title: string;
  /** 🔴 보는 방향. "ALL" 은 관리자용이라 「내」가 들어간 문장을 쓸 수 없다. */
  side: DelegationSide | "ALL";
  rows: readonly PortalDelegationView[];
  now: Date;
  empty?: string;
  /**
   * 🔵 **접어 둘 끝난 줄.** 안 넘기면 접기를 안 그린다 — 「모두의 결재권 위임」이
   * 그렇다(그 묶음은 끝난 줄을 아예 안 읽는다. 조회 쪽 머리말).
   * 🔴 `fold.live` 가 아니라 `rows` 를 그린다. 같은 값을 두 칸으로 받는 셈인데,
   * 묶음 셋 중 **하나는 접기가 없어서** 펴 둘 줄을 받는 칸은 따로여야 한다.
   */
  fold?: DelegationFoldView<PortalDelegationView>;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-slate-400">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {rows.map((row) => (
            <DelegationRowItem key={row.id} row={row} side={side} now={now} />
          ))}
        </ul>
      )}
      {/* 🔴 "ALL" 묶음에는 접기가 없다 — 위 프롭 주석. 방향이 둘인 묶음만 접는다. */}
      {fold && side !== "ALL" && <FinishedFold fold={fold} side={side} now={now} />}
    </section>
  );
}

/**
 * 결재함 맨 위 안내.
 *
 * 🔴 **맡은 것도 맡긴 것도 없으면 `null` 이다 — 아무것도 그리지 않는다.** 늘 떠
 * 있는 글은 아무도 읽지 않게 되고, 정작 위임이 걸린 날에도 눈에 안 들어온다.
 *
 * 🔵 **「내가 맡긴 것」도 함께 말한다.** 이 집에는 위임을 볼 자리가 [휴가 설정 →
 * 결재권 위임] 탭 하나뿐이고 직원은 그 탭이 머리말에 없다 — 맡긴 쪽도 결재함에서
 * 한 번은 보여야 「승인함에서 맡긴 것이 여기까지 왔나」를 알 수 있다. 그리고 맡긴
 * 사람에게는 **내 차례 건이 내가 안 눌렀는데 사라지는** 일이 실제로 생긴다.
 */
export function DelegationNotice({
  received,
  given,
  now,
  approvalsUrl,
}: {
  received: readonly PortalDelegationView[];
  given: readonly PortalDelegationView[];
  now: Date;
  approvalsUrl: string | null;
}) {
  const lines = delegationNoticeLines(received, given, now);
  if (lines.length === 0) return null;
  return (
    <section
      aria-label="결재권 위임"
      className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3"
    >
      <ul className="space-y-1.5">
        {lines.map((line) => (
          <li key={`${line.side}-${line.id}`} className="text-sm text-indigo-900">
            {line.text}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-indigo-800">
        {DELEGATION_READ_ONLY_NOTE}{" "}
        <Link
          href={settingsTabHref("delegation")}
          className="font-medium underline underline-offset-2"
        >
          결재권 위임 자세히
        </Link>
        {approvalsUrl && (
          <>
            {" · "}
            <a href={approvalsUrl} className="font-medium underline underline-offset-2">
              통합 승인함 열기
            </a>
          </>
        )}
      </p>
    </section>
  );
}
