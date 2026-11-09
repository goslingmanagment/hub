import { PersonAccess } from "@/screens/access/PersonAccess";

/**
 * The agreed interface of a person's access (spec §4.4 «Доступ», §4.8): pages,
 * links, devices, AI limit, disable/restore — everything of today's staff card,
 * adapted to the state (a pending invite → «Отменить приглашение»; disabled →
 * «Восстановить»).
 *
 * Built by the «Доступ» screen (src/screens/access/PersonAccess.tsx); shown by
 * the «Люди» screen in the «Доступ» tab of a person's card and by «Доступ» in
 * its side panel. The owner's only: Hub refuses everyone else, and the panel
 * says so itself for a team lead.
 *
 * Every write keeps the console's request, server checks and confirmation
 * texts (apps/dashboard/src/pages/team/people/PersonPage.tsx and api/adminUsers.ts);
 * confirmations are only added («Снять» страницу, «Завершить вход на
 * устройстве», «Сбросить пароль ссылкой», «Отозвать ссылку» get one; deleting
 * the account also asks to type the login).
 */
export interface PersonAccessPanelProps {
  /** Hub's user id (`adminUsers` / `teamChatterStats.people[].userId`). */
  userId: number;
  /** `page`: the «Доступ» tab of /people/:userId (full width). `drawer`: the side panel of «Доступ» (560 px). */
  variant: "page" | "drawer";
  /** After a write that changes what the person lists show (state, pages): the caller refreshes its own reads. */
  onChanged?: () => void;
}

export function PersonAccessPanel({ userId, variant, onChanged }: PersonAccessPanelProps) {
  return <PersonAccess userId={userId} variant={variant} {...(onChanged ? { onChanged } : {})} />;
}
