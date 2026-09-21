/** 처리 결과 안내 (?done=코드). 코드에 없는 값이면 아무것도 보이지 않는다 */
const MESSAGES: Record<string, string> = {
  submitted:
    "신청했습니다. 결재선의 첫 사람부터 차례로 결재하고, 마지막 사람이 승인하면 확정되어 달력에 진하게 표시됩니다.",
  auto: "결재 없이 바로 등록되었습니다.",
  "change-submitted": "날짜 변경을 신청했습니다. 승인되기 전까지는 원래 휴가가 그대로 유지됩니다.",
  changed: "날짜를 바꿨습니다.",
  "cancel-submitted": "취소를 신청했습니다. 승인되기 전까지는 휴가가 그대로 유지됩니다.",
  canceled: "휴가를 취소했습니다.",
  withdrawn: "신청을 취소했습니다.",
  approved: "승인했습니다. 다음 차례의 결재자에게 넘어갔습니다.",
  finished: "승인했습니다. 마지막 결재라 확정되었습니다.",
  rejected: "반려했습니다. 신청자에게 반려 사유가 보입니다.",
  "admin-canceled": "휴가를 취소 처리했습니다.",
  "step-skipped": "그 결재 단계를 건너뛰었습니다. 다음 차례의 결재자에게 넘어갔습니다.",
  "step-skipped-finished": "그 결재 단계를 건너뛰었습니다. 남은 결재가 없어 확정되었습니다.",
};

export function DoneBanner({ code, className = "" }: { code: string | string[] | undefined; className?: string }) {
  const message = typeof code === "string" ? MESSAGES[code] : undefined;
  if (!message) return null;
  return (
    <p role="status" className={`rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800 ${className}`}>
      {message}
    </p>
  );
}
