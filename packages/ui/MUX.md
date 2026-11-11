# Mux UI in peblish

One page for the lanes that move the app onto Mux UI. How each component is meant to be used, its weight and its gaps are in the catalogue (`/Users/admin/.agents/plans/feddit/lane-notes/mux/catalogue.md`); this page is the contract.

## The import rule

- Mux UI comes only from the vendored tarball, `vendor/muxui/muxui-react-0.1.0-rc.7.tgz`, a dependency of `packages/ui` alone.
- Only `packages/ui` imports `@muxui/react`. Routes and the shell import one module per component: `import { Card } from '@peblish/ui/components/card'` (no extension, no barrel). One module per component keeps tree-shaking working: a route that imports `separator` does not load `sidebar`.
- A wrapper re-exports the component, its parts and its prop types and nothing else. If one you need is missing, add `packages/ui/src/components/<kebab-name>.tsx` the same way and say so in your notes.
- The app's own composed components (`PostCard`, `CommentThread`, `VoteControl`, `ReplyBar`, `Prose`, `Handle`, `Time`, `Badge`, the form fields) keep their public props.
- Icons are Lucide (`lucide-react`, the set Mux UI draws its own with, pinned to the version Mux depends on), and like `@muxui/react` only `packages/ui` imports it (`mux-only-in-ui` in `.dependency-cruiser.cjs`). Everyone else imports from `@peblish/ui/components/icons`, which wraps each glyph by name: 1em square, `currentColor`, `aria-hidden` unless named. Need another glyph? Add one line there. Every `Sidebar.NavItem` takes one through `icon`: without it Mux draws the label's first letter, which becomes part of the link's text.
- Shared composed pieces (built from Mux components and tokens by the GW2 lane, in the same folder): `badge`, `notice`, `link-tabs`, `pager`, `fact-list`, `empty-state`. Use them rather than composing your own; their CSS is linked from `packages/web/src/styles.css`.

### Pieces added since

| Import                                                             | Use it for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Quote` from `@peblish/ui/components/quote`                        | Someone else's words: a `blockquote` with the words in Mux `Text` (`edge` draws a line down its start edge, `size`, any `blockquote` attribute).                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `LinkedDisclosure` from `@peblish/ui/components/linked-disclosure` | A Mux `Disclosure` whose content must stay reachable with scripts off: the server renders it open at `openHref` (`title`, `openHref`, `defaultExpanded`, optional `link`). Never hand-build another fallback.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ButtonLink` from `@peblish/ui/components/button-link`             | A link that looks like a Mux `Button` (`href`, `variant`, `size`, optional router `link`). It stays a link and works without scripts; use `Button` for actions.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| The field messages from `@peblish/ui/components/field-problem`     | The wrappers `text-field`, `text-area`, `checkbox` and `select` already explain a value the browser refuses (required, length, email, range) in the page's language, linked to the field; pass `errorMessage` with `invalid` only for your own refusals. Put `role="alert"` on Mux's own error part (`Input.Error`, `TextArea.Error`, `CheckboxField.Error`) and give it no id: rc.7 links it whether it renders from the start or later. `FieldAlert` is the announced span for the two error parts that still drop a role (SelectNative's `errorMessage`, RadioGroup's). `__root.tsx` mounts `FieldLabelsProvider`. |
| `Time` from `@peblish/ui/components/time`                          | Every date on a page; never a raw `time`. `format="age"` (default) prints "3h", `"date"` the date alone ("Nov 3, 2026"), `"date-time"` the date and time in UTC, `"time"` the clock time alone ("23:30", UTC, for rows under a day heading); all keep the full time as `title`.                                                                                                                                                                                                                                                                                                                                       |
| `BidiText` from `@peblish/ui/components/handle`                    | A display name from another server (a person or community): isolated, with its directional controls removed. Handles use `Handle`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pb-link-quiet`, `pb-link-muted` (classes, `components/link.css`)  | A Mux `Link` that is not a text link: a post's title, its action row, a comment's author, navigation rows and controls (`pb-link-quiet`, the colour around it), or a post's author, a log entry's moderator and the sidebar's footer (`pb-link-muted`). No underline until hovered. Every other link is Mux `Link` as it comes. Mux gap: Link has no tone or underline prop.                                                                                                                                                                                                                                          |

## Wrappers

Every component Mux UI rc.6 exported has a module in `packages/ui/src/components/` (rc.7's new `ColorModePicker` and `ThemePicker` have none: the app does not use them). Parts are reached through the component (`Card.Root`, `Card.Header`, `Sidebar.NavItem`).

| Module                                                                                                            | Exports                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activity`                                                                                                        | `Activity`                                                                                                                                                           |
| `alert-dialog`                                                                                                    | `AlertDialog` (parts)                                                                                                                                                |
| `autocomplete`                                                                                                    | `Autocomplete`                                                                                                                                                       |
| `avatar`                                                                                                          | `Avatar` (`Root`, `Image`, `Fallback`)                                                                                                                               |
| `breadcrumbs`                                                                                                     | `Breadcrumbs`, `BreadcrumbItem`                                                                                                                                      |
| `button`                                                                                                          | `Button` (existing)                                                                                                                                                  |
| `button-group`                                                                                                    | `ButtonGroup`                                                                                                                                                        |
| `calendar`, `range-calendar`                                                                                      | `Calendar`, `RangeCalendar`                                                                                                                                          |
| `card`                                                                                                            | `Card` (`Root`, `Button`, `Header`, `Body`, `Footer`)                                                                                                                |
| `checkbox-field`                                                                                                  | `CheckboxField` (parts)                                                                                                                                              |
| `checkbox-group`                                                                                                  | `CheckboxGroup`                                                                                                                                                      |
| `code-block`                                                                                                      | `CodeBlock`                                                                                                                                                          |
| `color-area`, `color-field`, `color-picker`, `color-slider`, `color-swatch`, `color-swatch-picker`, `color-wheel` | the colour family                                                                                                                                                    |
| `color-mode-toggle`                                                                                               | `ColorModeToggle` (do not use for the scheme: catalogue G2)                                                                                                          |
| `combo-box`                                                                                                       | `ComboBox`                                                                                                                                                           |
| `command-palette`                                                                                                 | `CommandPalette`, `useCommandPalette`                                                                                                                                |
| `data-diff`                                                                                                       | `DataDiff`                                                                                                                                                           |
| `date-field`, `date-picker`, `date-range-picker`, `time-field`                                                    | the date family                                                                                                                                                      |
| `dialog`                                                                                                          | `Dialog` (existing)                                                                                                                                                  |
| `disclosure`, `disclosure-group`                                                                                  | `Disclosure`, `DisclosureGroup`                                                                                                                                      |
| `drop-zone`, `file-trigger`                                                                                       | `DropZone`, `FileTrigger`                                                                                                                                            |
| `form`                                                                                                            | `Form`                                                                                                                                                               |
| `grid-list`                                                                                                       | `GridList`                                                                                                                                                           |
| `group`                                                                                                           | `Group`                                                                                                                                                              |
| `header-nav`                                                                                                      | `HeaderNav` (parts)                                                                                                                                                  |
| `icon-button`                                                                                                     | `IconButton`                                                                                                                                                         |
| `image`                                                                                                           | `Image`                                                                                                                                                              |
| `input`                                                                                                           | `Input` (parts; what `text-field` composes)                                                                                                                          |
| `input-tags`                                                                                                      | `InputTags`                                                                                                                                                          |
| `lightbox`                                                                                                        | `Lightbox` and its `LightboxTrigger`, `LightboxBackdrop`, `LightboxPopup`, `LightboxContent`, `LightboxCaption`, `LightboxPrevious`, `LightboxNext`, `LightboxClose` |
| `link`                                                                                                            | `Link` (existing)                                                                                                                                                    |
| `list-box`                                                                                                        | `ListBox`                                                                                                                                                            |
| `markdown`                                                                                                        | `Markdown` and its limits (from `@muxui/react/markdown`)                                                                                                             |
| `menu`                                                                                                            | `Menu` (existing)                                                                                                                                                    |
| `message`                                                                                                         | `Message`                                                                                                                                                            |
| `meter`                                                                                                           | `Meter`                                                                                                                                                              |
| `multi-select`                                                                                                    | `MultiSelect`                                                                                                                                                        |
| `mux-checkbox`                                                                                                    | Mux `Checkbox` (React Aria; `checkbox` is the app's `CheckboxField` composition)                                                                                     |
| `mux-provider`                                                                                                    | `MuxProvider` (already mounted by `locale.tsx`; do not mount another)                                                                                                |
| `mux-select`                                                                                                      | Mux `Select`, the popup select (`select` is the app's native select)                                                                                                 |
| `mux-text-area`                                                                                                   | Mux `TextArea` parts (`text-area` is the app's `TextAreaField`)                                                                                                      |
| `mux-text-field`                                                                                                  | Mux `TextField` (`text-field` is the app's `Input` composition)                                                                                                      |
| `mux-types`                                                                                                       | types several components share: `PartProps`, `ControlSize`, `MuxUIPlacement`, `MuxUIItems`, `MuxUISelection` and the rest                                            |
| `number-field`                                                                                                    | `NumberField`                                                                                                                                                        |
| `payment-input`                                                                                                   | `PaymentInput`                                                                                                                                                       |
| `popover`                                                                                                         | `Popover`                                                                                                                                                            |
| `preview-trigger`                                                                                                 | `PreviewTrigger`                                                                                                                                                     |
| `progress-bar`                                                                                                    | `ProgressBar`                                                                                                                                                        |
| `progress-circle`                                                                                                 | `ProgressCircle` (parts)                                                                                                                                             |
| `prompt-composer`                                                                                                 | `PromptComposer`                                                                                                                                                     |
| `radio-field`                                                                                                     | `RadioField` (parts)                                                                                                                                                 |
| `radio-group`                                                                                                     | `RadioGroup`, `RadioOption`                                                                                                                                          |
| `resizable`                                                                                                       | `Resizable`, `ResizablePanel`, `ResizableHandle`                                                                                                                     |
| `search-field`                                                                                                    | `SearchField`                                                                                                                                                        |
| `select-native`                                                                                                   | `SelectNative` (what `select` composes)                                                                                                                              |
| `separator`                                                                                                       | `Separator`                                                                                                                                                          |
| `sidebar`                                                                                                         | `Sidebar` (parts)                                                                                                                                                    |
| `slider`                                                                                                          | `Slider`                                                                                                                                                             |
| `switch`, `switch-field`                                                                                          | `Switch`, `SwitchField` (parts)                                                                                                                                      |
| `table`                                                                                                           | `Table` and its row and column types                                                                                                                                 |
| `tabs`                                                                                                            | `Tabs`                                                                                                                                                               |
| `tag-group`                                                                                                       | `TagGroup`                                                                                                                                                           |
| `tag-select`                                                                                                      | `TagSelect`                                                                                                                                                          |
| `text`                                                                                                            | `Text`                                                                                                                                                               |
| `text-editor`                                                                                                     | `TextEditor` (from `@muxui/react/text-editor`)                                                                                                                       |
| `toast`                                                                                                           | `ToastProvider`, `useToast`, `Toast` (existing)                                                                                                                      |
| `toggle-button-group`                                                                                             | `ToggleButtonGroup`, `ToggleButton` (existing)                                                                                                                       |
| `token-field`                                                                                                     | `TokenField`                                                                                                                                                         |
| `toolbar`                                                                                                         | `Toolbar` (existing)                                                                                                                                                 |
| `tooltip`                                                                                                         | `Tooltip` (existing)                                                                                                                                                 |
| `tree`                                                                                                            | `Tree`                                                                                                                                                               |
| `virtualizer`                                                                                                     | `Virtualizer`                                                                                                                                                        |

Weight differs a lot (gzip, one wrapper alone, React excluded): `separator` 30 kB, `card` 15 kB, `tabs` and `table` 60 kB, `sidebar` 116 kB. Shared code is paid once per page. The payload check reports script and CSS size without failing during the restyle (`PAYLOAD.md`).

## Tokens

Style only with Mux tokens (`var(--muxui-...)`), or the few `--pb-*` aliases below (every other job uses the Mux token itself, listed under the table; role badges are `Badge`), which are themselves only Mux tokens. No hex, rgb or hsl, no hand-written radius, shadow, font family or font size. Layout (grid, flex, widths, gaps) is fine. The app uses Mux UI's own light and dark schemes (`data-muxui-color-scheme` on `<html>`); there is no true black. Appearance is System, Light, Dark; a `scheme=black` cookie stored before that choice was removed still renders as dark (`theme/root.tsx` maps it).

| Token             | Role                            | Mux token                                       |
| ----------------- | ------------------------------- | ----------------------------------------------- |
| `--pb-up`         | up vote                         | `--muxui-component-taggroup-orange-foreground`  |
| `--pb-down`       | down vote                       | `--muxui-component-taggroup-indigo-foreground`  |
| `--pb-warn`       | warning                         | `--muxui-component-taggroup-warning-foreground` |
| `--pb-error`      | danger and error                | `--muxui-semantic-feedback-invalid`             |
| `--pb-ok`         | success                         | `--muxui-component-taggroup-success-foreground` |
| `--pb-page-width` | the page column's width (940px) | none: Mux has no width tokens                   |

The accents use TagGroup's hue foregrounds because they are the only Mux accent colours with a dark branch (catalogue gap G7); each is 6.5:1 or better on the page in both schemes. For a tinted fill behind one, use the same hue's `-tint-weak` (`--muxui-component-taggroup-success-tint-weak`). `--muxui-semantic-status-success` and `-status-warning` fail contrast as text: use them for stripes only. Do not use `--muxui-semantic-action-danger-foreground` for text (no dark branch).

The other jobs, straight from Mux (prefix `--muxui-`): text `semantic-content-default`; muted text (meta lines, counts, times) `semantic-content-muted`; links `semantic-content-link`; separators and thread lines `semantic-border-subtle`; hover fill `semantic-surface-hover`; page `semantic-surface-background`; raised surface (cards, menus, the docked bar) `semantic-surface-raised`; quiet fill (notice, code, stub) `semantic-surface-subtle`; link hover `semantic-content-link-hover`; borders on controls and collections `semantic-border-default`; dense row lines `semantic-border-faint`; selected item `semantic-selection-background`; focus ring `outline: 2px solid var(--muxui-semantic-focus-ring)` (Mux's own `:focus-visible` rule already draws it, so the app no longer sets one). Anything else: the catalogue's "Which token for which job" table.

### Base rules

Mux UI rc.7 components bring their own font and box model: they no longer take font, box sizing or Separator margin from the page, and Mux's base rule gives the body its text face, size (fluid 14 to 16px), line height and colour. What `tokens.css` adds:

- `*, *::before, *::after { box-sizing: border-box }`, in the `reset` layer, for the app's own elements. Mux reverts its own elements to the browser's box model (content-box for most), so an app rule that gives a Mux part a width including its padding (`inline-size: 100%` on a `Card`) also sets `box-sizing: border-box` on it, as `auth.css` does for the auth card.
- `.muxui-avatar__fallback { box-sizing: border-box }`: a Mux UI rc.7 bug, the fallback is 100% wide plus its padding, so without this the initial sits off centre.
- `components/sidebar.css` and `components/header-nav.css`: `.muxui-sidebar__nav-link`, `.muxui-sidebar__mobile-header` and `.muxui-header-nav` size as `border-box`. Under rc.7's content-box a navigation row is 50px (its 36px minimum plus padding) and the two bars gain their 1px border; the picked layout has 36px rows, a 64px top bar and a 56px phone bar. Delete them when Mux sizes these parts as border-box itself.
- `body`: no margin, the page surface (`--muxui-semantic-surface-background`) and `overflow-wrap: anywhere`.
- The app has no `:focus-visible` rule of its own; Mux's applies.
- `.pb-page` padding takes Mux layout tokens.

New `--pb-*` tokens go in `packages/ui/src/tokens/tokens.css` (the groundwork lane's file; ask root) and are only Mux tokens. Prefer using the Mux token directly.

## Client-only components under server rendering

Andrew's rule (2026-11-11): the app is readable without JavaScript and interactive with it. A menu, drawer or switch may need scripts, and a browser test that asserts one works with scripts off may be rewritten; plain form posts must keep working.

Every page renders on the server and must hydrate without warnings (the e2e hydration marker). Mux overlays (Menu, Dialog, AlertDialog, Popover, Tooltip, Lightbox, the Sidebar and HeaderNav drawers, `Sidebar.AccountMenu`) render nothing in the server HTML and mount on open, so they are safe to render on the server, but their triggers do nothing until hydration (G1). The pattern:

1. Render the trigger on the server as usual. Never branch markup on `typeof window`: that is a hydration mismatch.
2. A form that posts keeps a real `<form method="post">` (sign out included), so it works before hydration even when its trigger sits in a menu that does not.
3. A control that only works with scripts is disabled until hydration with `useHydrated()` from `@peblish/ui/composer/use-hydrated.ts` (false on the server and during hydration, true after; no extra render), as the composer does.
4. Code that is heavy and only needed after an action is split with `React.lazy` and rendered inside `Suspense` only once the action happened (the composer sheet in `web/shell/create-post.tsx`).
5. `ColorModeToggle` writes the scheme to `<html>` and localStorage on every render: do not use it. The scheme control is built from `ToggleButtonGroup` or `Menu` plus `theme/root.tsx`.
6. Avatar shows its fallback until hydration; pending submit Buttons are disabled until hydration. Both are by design.

## State without JavaScript

Mux hides the native input of its choice controls and draws the visible box, tick, dot and thumb from `data-muxui-state-*` attributes that React sets. Since rc.7 Mux's own stylesheet also draws Checkbox, CheckboxField, CheckboxGroup, Switch, SwitchField, RadioGroup and RadioField from the native input while those attributes are stale (scripts off, or before hydration), including the keyboard focus ring and forced colours, so the app adds nothing. `e2e/ui-nojs` is the regression test: the drawing follows clicks and keys with scripts off, matches a hydrated page pixel for pixel in light, dark and forced colours, and Mux's input rules change nothing once hydrated.

## Examples

A Card with actions (a community in a list):

```tsx
import { Button } from '@peblish/ui/components/button';
import { Card } from '@peblish/ui/components/card';
import { Link } from '@peblish/ui/components/link';
import { Text } from '@peblish/ui/components/text';

<Card.Root variant="outlined" padding="sm">
  <Card.Header>
    <Text as="h2" variant="title" size="sm">
      <Link href="/c/news">news</Link>
    </Text>
  </Card.Header>
  <Card.Body>
    <Text color="muted">{members}</Text>
  </Card.Body>
  <Card.Footer>
    <Button variant="primary" onActivate={join}>
      {labels.join}
    </Button>
  </Card.Footer>
</Card.Root>;
```

Tabs with a Table (admin). Tabs are buttons, not links (G4): keep `value` in the route and navigate in `onChange`.

```tsx
import { Table } from '@peblish/ui/components/table';
import { Tabs } from '@peblish/ui/components/tabs';

const reports = (
  <Table
    aria-label={labels.reports}
    columns={[
      { id: 'post', label: labels.post, isRowHeader: true },
      { id: 'reason', label: labels.reason },
    ]}
    rows={items.map((report) => ({
      id: report.id,
      values: { post: <Link href={report.href}>{report.title}</Link>, reason: report.reason },
    }))}
  />
);

<Tabs
  aria-label={labels.admin}
  value={tab}
  onChange={go}
  keyboardActivation="manual"
  items={[
    { id: 'reports', label: labels.reports, panel: reports },
    { id: 'bans', label: labels.bans, panel: bans },
  ]}
/>;
```

A Sidebar item. Pass the same navigation to the column and the phone drawer and mark `current` in both.

```tsx
import { HouseIcon } from '@peblish/ui/components/icons';
import { Sidebar } from '@peblish/ui/components/sidebar';

<nav aria-label={labels.communities}>
  <Sidebar.NavList>
    <Sidebar.NavItem href="/" icon={HouseIcon} current={path === '/'}>
      {labels.home}
    </Sidebar.NavItem>
    <Sidebar.Section label={labels.subscribed}>
      <Sidebar.NavItem href="/c/news">news</Sidebar.NavItem>
    </Sidebar.Section>
  </Sidebar.NavList>
</nav>;
```

The three examples type-checked against rc.6; rc.7 removes no export or prop they use.
