type PendingViewSessionLike = {
  sessionId?: string | null;
} | null | undefined;

const TEMPORARY_SESSION_PREFIX = 'new-session-';

/**
 * 判断会话 ID 是否仍属于前端创建中的临时会话。
 * @param sessionId 待判断的会话 ID；为空时返回 `false`。
 * @returns `true` 表示该 ID 仍是临时会话，不应被当作稳定的真实会话恢复。
 * @throws 不直接抛出异常；仅做字符串前缀判断。
 */
export function isTemporaryPendingSessionId(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId && sessionId.startsWith(TEMPORARY_SESSION_PREFIX));
}

/**
 * 解析当前视图里仍然有效的 pending 会话 ID。
 * @param pendingViewSession 视图内记录的 pending 会话引用；可能为空、未绑定或已过期。
 * @param pendingSessionId sessionStorage 中记录的 pending 会话 ID；为空表示当前没有稳定的 pending 真实会话。
 * @returns 仅当 pending 会话仍然有效时返回它的 `sessionId`，否则返回 `null`。
 * @throws 不直接抛出异常；输入无效时回退为 `null`。
 */
export function resolvePendingViewSessionId(
  pendingViewSession: PendingViewSessionLike,
  pendingSessionId: string | null | undefined,
): string | null {
  const pendingViewSessionId =
    typeof pendingViewSession?.sessionId === 'string' && pendingViewSession.sessionId.length > 0
      ? pendingViewSession.sessionId
      : null;

  if (!pendingViewSessionId) {
    return null;
  }

  if (isTemporaryPendingSessionId(pendingViewSessionId)) {
    return pendingViewSessionId;
  }

  if (pendingSessionId && pendingSessionId === pendingViewSessionId) {
    return pendingViewSessionId;
  }

  return null;
}

/**
 * 判断模板页当前是否仍处于“新建中/待绑定”的 pending 状态。
 * @param pendingViewSession 视图内记录的 pending 会话引用；为空时表示当前没有视图级 pending。
 * @param pendingSessionId sessionStorage 中记录的 pending 会话 ID；为空时表示没有稳定的待恢复会话。
 * @returns `true` 表示模板页仍应保留当前聊天表面；`false` 表示应清空并回到真正的模板页初始状态。
 * @throws 不直接抛出异常；仅做安全的空值和字符串判断。
 */
export function hasPendingTemplateSession(
  pendingViewSession: PendingViewSessionLike,
  pendingSessionId: string | null | undefined,
): boolean {
  if (pendingSessionId) {
    return true;
  }

  if (!pendingViewSession) {
    return false;
  }

  const pendingViewSessionId =
    typeof pendingViewSession.sessionId === 'string' && pendingViewSession.sessionId.length > 0
      ? pendingViewSession.sessionId
      : null;

  return !pendingViewSessionId || isTemporaryPendingSessionId(pendingViewSessionId);
}
