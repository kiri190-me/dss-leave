/**
 * ID 토큰이 실어 온 값을 「이 시스템이 아는 것」으로 바꾸는 판정.
 *
 * DB 를 읽지 않는다. sso-login.ts 에서 떼어 낸 이유는 하나뿐이다 — 이 판정은
 * 포털도 DB 도 없이 시험할 수 있어야 한다(`npm run test:auth`). 사람을 들일지
 * 말지를 정하는 자리라 시험이 늘 따라붙어야 한다.
 *
 * (A/S 시스템 src/lib/auth/sso-role.ts · 계측기 · 개선요청 · PO/내자의 같은
 *  함수와 같은 판정이다. 아는 역할 값의 목록만 시스템마다 다르다.)
 */
import { USER_ROLES, type UserRole } from "@/lib/db/schema";

/** auth_sub 는 uuid 열이다. 모양이 아닌 값이 오면 insert 가 터진다. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 포털의 sub 가 이 시스템의 auth_sub 자리에 들어갈 수 있는 모양인가.
 *
 * 🔴 계정을 만들기 **전에** 본다. uuid 가 아닌 값을 그대로 넣으면 드라이버가
 * 던지고, 그러면 화면에는 "알 수 없는 오류" 만 뜬다.
 */
export function isValidSubject(subject: unknown): subject is string {
  return typeof subject === "string" && UUID_PATTERN.test(subject);
}

export type RoleDecision =
  /** 클레임이 없다. 포털이 이 사람의 역할을 관리하지 않는다는 뜻이니 그대로 둔다. */
  | { kind: "KEEP" }
  /** 이 시스템이 아는 값이다. 그대로 적용한다. */
  | { kind: "APPLY"; role: UserRole }
  /** 모르는 값이다. 로그인을 거절한다. */
  | { kind: "REJECT" };

/**
 * 포털이 ID 토큰에 실어 보낸 role 클레임을 어떻게 다룰지.
 *
 * 🔴 **클레임이 없으면 유지(KEEP)** 다. 이 시스템은 전 직원이 휴가를 내는
 * 곳이라 부여 행이 없는 사람이 정상이고, 그런 사람에게는 role 이 실리지 않는다.
 * 없다고 거절하면 아무도 못 들어온다.
 *
 * 🔴 **모르는 값이면 거절(REJECT)** 이다. 유지하면 안전한 쪽으로 실패하지
 * 않는다 — 휴가 관리자를 일반으로 **내리려다** 역할 이름을 잘못 적었을 때,
 * 그 사람이 관리자로 남아 있는데 아무 표시도 나지 않는다. 거절하면 잘못
 * 설정된 그 계정만 못 들어오고, 즉시 드러나며, 나머지는 멀쩡히 고칠 수 있다.
 *
 * 🔴 이 시스템이 아는 값은 MEMBER · LEAVE_ADMIN 둘뿐이다(schema.ts 의
 * USER_ROLES). 다른 시스템의 ADMIN 은 여기서 **모르는 값**이라 거절된다 —
 * 포털에 역할을 등록할 때 시스템마다 값이 다르다는 것을 놓치기 쉽다.
 */
export function decideRole(claim: unknown): RoleDecision {
  if (claim === undefined || claim === null) return { kind: "KEEP" };
  if (typeof claim !== "string") return { kind: "REJECT" };
  if ((USER_ROLES as readonly string[]).includes(claim)) {
    return { kind: "APPLY", role: claim as UserRole };
  }
  return { kind: "REJECT" };
}
