/**
 * The chat team of a model (products plan §4.2, package W): of the people working its pages in the registry, the ones
 * whose role is a chat team's — chatters and team leads. A content manager, a contractor or an agent works pages too and
 * is not the chat team: «График», «Команда» (people and newcomers), «Сегодня»'s schedule (who is due, the gaps) and the
 * team's numbers list the chat team, plus whoever actually has shifts on its pages (a shift is a shift whoever works it).
 */
export const CHAT_TEAM_ROLES: readonly string[] = ["chatter", "team_lead"];

export function isChatTeamRole(role: string): boolean {
  return CHAT_TEAM_ROLES.includes(role);
}
