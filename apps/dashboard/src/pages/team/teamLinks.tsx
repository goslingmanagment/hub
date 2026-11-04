import { Link, useLocation } from "react-router";
import { useAdminUsers, useAuthMe } from "@/api/queries";
import { buildFanProfileNavigation } from "@/lib/navigation";

/**
 * The links of the team screens: a chatter's name to their work, a page's label
 * to its card, a fan's number to the fan. Quiet at rest (design-language §5.7):
 * no underline until the pointer is on them.
 */

export function ChatterLink({ userId, username, period }: { userId: number; username: string; period?: string | undefined }) {
  return <Link to={`/team/chatters/${userId}${period ? `?period=${period}` : ""}`} className="team-link font-medium">{username}</Link>;
}

export function PageLink({ label }: { label: string }) {
  return <Link to={`/pages/${encodeURIComponent(label)}`} className="team-link">{label}</Link>;
}

/** «фан 298319»: the fan's card on its page. The API has the number, not the name. */
export function FanLink({ pageLabel, platform, fanRef }: { pageLabel: string; platform: string; fanRef: string }) {
  const location = useLocation();
  const navigation = buildFanProfileNavigation(pageLabel, platform, fanRef, `${location.pathname}${location.search}`, fanRef);
  return (
    <Link to={navigation.to} state={navigation.state} className="team-link">
      фан <span className="tabular-nums team-fan-ref">{fanRef}</span>
    </Link>
  );
}

/**
 * A login the API gives without its id (the export, «Кто не подтвердил», who
 * wrote a custom): the owner gets a link through the people list; a team lead,
 * to whom that list is closed, reads plain text.
 */
export function useLoginLink(): (username: string) => number | null {
  const { data: me } = useAuthMe();
  const owner = me?.user.role === "owner";
  const users = useAdminUsersIfOwner(owner);
  return (username) => users?.find((user) => user.username === username && !user.deletedAt)?.id ?? null;
}

function useAdminUsersIfOwner(owner: boolean) {
  // The hook asks always; a team lead's answer is a refusal and nothing more.
  const users = useAdminUsers({ enabled: owner });
  return owner ? users.data : undefined;
}

export function LoginName({ username, link }: { username: string; link: (username: string) => number | null }) {
  const id = link(username);
  return id === null ? <span className="font-medium">{username}</span> : <ChatterLink userId={id} username={username} />;
}
