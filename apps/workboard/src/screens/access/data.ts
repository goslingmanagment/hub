/**
 * Доступ — the data layer (spec §4.8, and the «Доступ» tab of Человек §4.4).
 * Owned by the Доступ screen, which also fills src/shared/PersonAccessPanel.tsx.
 *
 * Reads: `adminUsers` (people, state, pages), `pages`, `adminListDeviceTokens`.
 * Writes keep the console's requests, server checks and confirmation texts —
 * find each in apps/dashboard/src/pages/team/people/ (PeoplePage, PersonPage,
 * InviteModal, PageAssignmentsEditor, LinkRevealModal) and api/adminUsers.ts:
 * invite (`adminCreateInvite`, one call with «вся модель»), page access,
 * links, devices (`adminRevokeDeviceToken(s)`), AI limit, disable/restore.
 * Confirmations are only added: removing a page, ending a device's session and
 * a password reset link get one (spec §6).
 * Query keys start with "access".
 */
export {};
