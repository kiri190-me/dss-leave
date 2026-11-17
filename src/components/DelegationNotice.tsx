import Link from "next/link";

import type { PortalDelegationView } from "@/lib/auth/portal-delegations";
import {
  DELEGATION_EMPTY_NOTE,
  DELEGATION_PHASE_CHIP,
  DELEGATION_PHASE_LABEL,
  DELEGATION_READ_ONLY_NOTE,
  allDelegationSentence,
  delegationNoticeLines,
  delegationPhase,
  delegationSentence,
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

/** 「진행 중」·「시작 전」 딱지. 🔴 시작 전인 줄을 진행 중처럼 보이게 두지 않는다. */
function PhaseChip({ startsAt, now }: { startsAt: Date; now: Date }) {
  const phase = delegationPhase({ startsAt }, now);
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${DELEGATION_PHASE_CHIP[phase]}`}>
      {DELEGATION_PHASE_LABEL[phase]}
    </span>
  );
}

/**
 * 탭 안의 묶음 하나 — 「내가 대신하고 있는 것」·「내가 맡긴 것」·「모두의 결재권 위임」.
 *
 * 🔴 **비었으면 「없습니다」를 분명히 적는다.** 빈 자리는 고장으로 읽힌다 — 사용자가
 * 2026-11-17 에 「위임되었다는 내용이 안 뜬다」고 한 것이 정확히 그 모양이었다.
 */
export function DelegationGroup({
  title,
  side,
  rows,
  now,
  empty = DELEGATION_EMPTY_NOTE,
}: {
  title: string;
  /** 🔴 보는 방향. "ALL" 은 관리자용이라 「내」가 들어간 문장을 쓸 수 없다. */
  side: DelegationSide | "ALL";
  rows: readonly PortalDelegationView[];
  now: Date;
  empty?: string;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-slate-400">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {rows.map((row) => (
            <li key={row.id} className="border-t border-slate-100 pt-3 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-start gap-2">
                <PhaseChip startsAt={row.startsAt} now={now} />
                <p className="min-w-0 flex-1 text-sm text-slate-800">
                  {side === "ALL"
                    ? allDelegationSentence(row, now)
                    : delegationSentence(row, side, now)}
                </p>
              </div>
              {/* 맡긴 까닭. 없으면 빈 글자로 오므로(통로 규약) 줄 자체를 안 그린다. */}
              {row.reason.trim() !== "" && (
                <p className="mt-1 text-xs text-slate-500">사유: {row.reason}</p>
              )}
            </li>
          ))}
        </ul>
      )}
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
