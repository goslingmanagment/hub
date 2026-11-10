/**
 * @agency_hub_core/ui — the shared design system of Hub's web apps.
 *
 * Styles: import "@agency_hub_core/ui/styles.css" once (or the relative path from CSS).
 * Helpers without React live in their own modules, importable alone:
 *   @agency_hub_core/ui/format    money, counts, percents, durations, Moscow dates
 *   @agency_hub_core/ui/plural    Russian plural forms
 *   @agency_hub_core/ui/moscow    Moscow days: today, Monday, ranges, instants
 *   @agency_hub_core/ui/ribbon    the shift ribbon's clock: where its rows start, which row an instant is in
 *   @agency_hub_core/ui/period    the period model (week · 14 · 30 · own range) and its address
 *   @agency_hub_core/ui/theme     light / dark / as the system, shared by both apps
 *   @agency_hub_core/ui/hubClient the Hub API client on the cookie session
 *   @agency_hub_core/ui/shiftReview the rules of «Разбор смены» and a shift's three quality numbers
 *   @agency_hub_core/ui/teamAccess  people's access: states, the join link, words of links and devices
 *   @agency_hub_core/ui/heldSends   a held send and its resolve, in words, for the send's platform
 *   @agency_hub_core/ui/shiftReports shift reports and the posts in «Отчётность» in words, and what of them waits for the owner
 *   @agency_hub_core/ui/sites       the production names of the console and the chatters' site
 */
export { Badge, CountBadge, StatusDot, type Tone } from "./components/Badge.js";
export { Bar } from "./components/Bar.js";
export { Button, IconButton, LinkButton, type ButtonProps, type ButtonSize, type ButtonVariant, type IconButtonProps, type IconComponent, type LinkButtonProps } from "./components/Button.js";
export { Card, Section, type CardProps, type SectionProps } from "./components/Card.js";
export { Chip, type ChipProps } from "./components/Chip.js";
export { cx } from "./components/cx.js";
export { DELTA_SMALL_BASE_COUNT, DELTA_SMALL_BASE_MILLS, Delta, deltaText, readDelta, type DeltaProps, type DeltaReading, type DeltaRule } from "./components/Delta.js";
export { Disclosure } from "./components/Disclosure.js";
export { Drawer, SidePanel, type DrawerProps, type PanelSize, type SidePanelProps } from "./components/Drawer.js";
export { Duration } from "./components/Duration.js";
export { Facts, type FactItem } from "./components/Facts.js";
export { Checkbox, Field, Select, Switch, Textarea, TextInput } from "./components/Field.js";
export { Fan, collidingFanNames, fanFallback, fanNameCollides, fanText, type FanLike, type FanProps } from "./components/Fan.js";
export { HeatGrid, type HeatGridProps, type HeatGridRow, type HeatStep } from "./components/HeatGrid.js";
export { Kbd } from "./components/Kbd.js";
export { KeyValue } from "./components/KeyValue.js";
export { Menu, type MenuAction, type MenuEntry, type MenuProps, type TriggerProps } from "./components/Menu.js";
export { Confirm, Modal, type ConfirmFact, type ConfirmProps, type ModalProps } from "./components/Modal.js";
export { Count, Money, type MoneyProps } from "./components/Money.js";
export { Notice, type NoticeTone } from "./components/Notice.js";
export { PageLabel, PageLabels, platformWord, type PageLabelProps } from "./components/PageLabel.js";
export { PeriodControl } from "./components/PeriodControl.js";
export { RateBar, type RateBarProps } from "./components/RateBar.js";
export { Person, type PersonStatus } from "./components/Person.js";
export { SearchInput, type SearchInputProps } from "./components/SearchInput.js";
export { Segmented, type SegmentedOption } from "./components/Segmented.js";
export { Skeleton, SkeletonText, Spinner } from "./components/Skeleton.js";
export { EmptyState, ErrorState } from "./components/States.js";
export { Mark, Table, type Column, type MarkProps, type SortDirection, type SortState, type TableProps } from "./components/Table.js";
export { Tabs, type TabItem } from "./components/Tabs.js";
export { TimeMsk, type TimeShow } from "./components/TimeMsk.js";
export { Toaster, toast } from "./components/Toast.js";
export { Hint, Tooltip, type ScreenRect, type TooltipProps } from "./components/Tooltip.js";
export { rectAnchor, useAnchoredPosition, useDismiss, type AnchorLike } from "./components/popover.js";
export { useFocusScope, type InitialFocus } from "./components/focus.js";
export { useFullWindow } from "./components/fullWindow.js";
