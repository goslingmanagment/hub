/**
 * @agency_hub_core/ui — the shared design system of Hub's web apps.
 *
 * Styles: import "@agency_hub_core/ui/styles.css" once (or the relative path from CSS).
 * Helpers without React live in their own modules, importable alone:
 *   @agency_hub_core/ui/format    money, counts, percents, durations, Moscow dates
 *   @agency_hub_core/ui/plural    Russian plural forms
 *   @agency_hub_core/ui/moscow    Moscow days: today, Monday, ranges, instants
 *   @agency_hub_core/ui/period    the period model (week · 14 · 30 · own range) and its address
 *   @agency_hub_core/ui/theme     light / dark / as the system, shared by both apps
 *   @agency_hub_core/ui/hubClient the Hub API client on the cookie session
 */
export { Badge, CountBadge, StatusDot, type Tone } from "./components/Badge.js";
export { Bar } from "./components/Bar.js";
export { Button, IconButton, LinkButton, type ButtonProps, type ButtonSize, type ButtonVariant, type IconButtonProps, type IconComponent, type LinkButtonProps } from "./components/Button.js";
export { Card, Section, type CardProps, type SectionProps } from "./components/Card.js";
export { Chip, type ChipProps } from "./components/Chip.js";
export { cx } from "./components/cx.js";
export { Delta, type DeltaProps } from "./components/Delta.js";
export { Disclosure } from "./components/Disclosure.js";
export { Drawer, type DrawerProps } from "./components/Drawer.js";
export { Duration } from "./components/Duration.js";
export { Facts, type FactItem } from "./components/Facts.js";
export { Checkbox, Field, Select, TextInput } from "./components/Field.js";
export { Kbd } from "./components/Kbd.js";
export { KeyValue } from "./components/KeyValue.js";
export { Menu, type MenuAction, type MenuEntry, type MenuProps, type TriggerProps } from "./components/Menu.js";
export { Confirm, Modal, type ConfirmFact, type ConfirmProps, type ModalProps } from "./components/Modal.js";
export { Count, Money, type MoneyProps } from "./components/Money.js";
export { Notice, type NoticeTone } from "./components/Notice.js";
export { PeriodControl } from "./components/PeriodControl.js";
export { PERSON_STATUS_WORD, Person, type PersonStatus } from "./components/Person.js";
export { SearchInput, type SearchInputProps } from "./components/SearchInput.js";
export { Segmented, type SegmentedOption } from "./components/Segmented.js";
export { Skeleton, SkeletonText, Spinner } from "./components/Skeleton.js";
export { EmptyState, ErrorState } from "./components/States.js";
export { Mark, Table, type Column, type SortDirection, type SortState, type TableProps } from "./components/Table.js";
export { Tabs, type TabItem } from "./components/Tabs.js";
export { TimeMsk, type TimeShow } from "./components/TimeMsk.js";
export { Toaster, toast } from "./components/Toast.js";
export { Tooltip } from "./components/Tooltip.js";
export { useAnchoredPosition, useDismiss } from "./components/popover.js";
export { useFocusScope } from "./components/focus.js";
