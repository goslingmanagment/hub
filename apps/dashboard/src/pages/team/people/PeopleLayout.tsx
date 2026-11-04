import { useState } from "react";
import { Outlet, useNavigate, useOutletContext } from "react-router";
import { useCreateAccountLink, useCreateInvite } from "@/api/queries";
import { InviteModal } from "./InviteModal.js";
import { LinkRevealModal, type RevealedLink } from "./LinkRevealModal.js";

/**
 * The frame of Команда → Сотрудники and a person's card. Both link-minting
 * mutations live HERE, above the list and the card: their result carries the
 * only copy of a fresh link, and TanStack drops a per-call callback when the
 * observer that issued it unmounts. Holding them here also means the raw link
 * would sit in the mutation cache after the reveal closed, so closing it resets
 * both.
 */

export interface PeopleContext {
  openInvite: () => void;
  createLink: ReturnType<typeof useCreateAccountLink>;
  onLinkCreated: (link: RevealedLink) => void;
}

export function usePeople(): PeopleContext {
  return useOutletContext<PeopleContext>();
}

export function PeopleLayout() {
  const navigate = useNavigate();
  const createInvite = useCreateInvite();
  const createLink = useCreateAccountLink();
  const [inviting, setInviting] = useState(false);
  const [revealed, setRevealed] = useState<RevealedLink | null>(null);

  const context: PeopleContext = {
    openInvite: () => setInviting(true),
    createLink,
    onLinkCreated: (link) => setRevealed(link),
  };

  return (
    <>
      <Outlet context={context} />
      {inviting && (
        <InviteModal
          create={createInvite}
          onClose={() => setInviting(false)}
          onCreated={(link) => {
            setInviting(false);
            setRevealed(link);
          }}
          onOpenExisting={(userId) => {
            setInviting(false);
            navigate(`/team/people/${userId}`);
          }}
        />
      )}
      {revealed && (
        <LinkRevealModal
          link={revealed}
          onClose={() => {
            // Release the observed results: the issuance mutations (gcTime: 0)
            // are collected now, and the secret leaves memory with the window.
            createInvite.reset();
            createLink.reset();
            setRevealed(null);
          }}
        />
      )}
    </>
  );
}
