import { randomUUID } from 'node:crypto'

import {
  createLayoutQuerySession,
  type LayoutQueryCommand,
  type LayoutQuerySession,
  type LayoutQuerySessionInput,
  type LayoutQuerySessionResult,
} from '../planner/layoutQuery'

const layoutQuerySessions = new Map<string, LayoutQuerySession>()

export function registerLayoutQuerySession(input: LayoutQuerySessionInput) {
  const id = `layout-query:${randomUUID()}`
  const session = createLayoutQuerySession(id, input)

  layoutQuerySessions.set(id, session)

  return session
}

export function getLayoutQuerySession(sessionId: string) {
  return layoutQuerySessions.get(sessionId) ?? null
}

export function disposeLayoutQuerySession(sessionId: string) {
  layoutQuerySessions.delete(sessionId)
}

export async function executeLayoutQuerySessionCommand(
  sessionId: string,
  command: LayoutQueryCommand,
): Promise<LayoutQuerySessionResult> {
  const session = getLayoutQuerySession(sessionId)

  if (!session) {
    return {
      ok: false,
      warning: 'Layout query session was not found or has expired.',
    }
  }

  return session.execute(command)
}
