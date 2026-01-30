/**
 * Naver SmartStore / Commerce API integration (MVP placeholder)
 * 실제 연동 시:
 * - OAuth 2.0 토큰 발급(애플리케이션/커머스API)
 * - 상품 등록/수정/삭제 API 호출
 * - 주문/결제 상태 조회 API 호출
 *
 * 이 프로젝트에서는 "자동상품발행"을 목표로 하지만,
 * 자격/권한/심사/상품유형(디지털/서비스) 등에 따라 API 동작이 달라집니다.
 *
 * 지금은: API 키가 없거나 구현이 미완일 때도 전체 플로우가 끊기지 않도록
 * "결제 링크가 생성되지 않았음" 상태로 진행합니다.
 */
export async function createSmartStoreProduct({ title, amount, enrollmentId }){
  // TODO: implement real API integration
  return {
    productId: null,
    productUrl: null,
    raw: { reason: "NOT_IMPLEMENTED" }
  };
}

export async function verifySmartStorePayment({ enrollmentId }){
  // TODO: implement real payment verification
  return { verified: false, raw: { reason: "NOT_IMPLEMENTED" } };
}
