# Mux UI in peblish

One page for the lanes that move the app onto Mux UI. How each component is meant to be used, its weight and its gaps are in the catalogue (`/Users/admin/.agents/plans/feddit/lane-notes/mux/catalogue.md`); this page is the contract.

## The import rule

- Mux UI comes only from the vendored tarball, `vendor/muxui/muxui-react-0.1.0-rc.6.tgz`, a dependency of `packages/ui` alone.
- Only `packages/ui` imports `@muxui/react`. Routes and the shell import one module per component: `import { Card } from '@peblish/ui/components/card'` (no extension, no barrel). One module per component keeps tree-shaking working: a route that imports `separator` does not load `sidebar`.
- A wrapper re-exports the component, its parts and its prop types and nothing else. If one you need is missing, add `packages/ui/src/components/<kebab-name>.tsx` the same way and say so in your notes.
- The app's own composed components (`PostCard`, `CommentThread`, `VoteControl`, `ReplyBar`, `Prose`, `Handle`, `Time`, `Badge`, the form fields) keep their public props.
- Shared composed pieces (built from Mux components and tokens by the GW2 lane, in the same folder): `badge`, `notice`, `link-tabs`, `pager`, `fact-list`, `empty-state`. Use them rather than composing your own; their CSS is linked from `packages/web/src/styles.css`.

## Wrappers

Every component Mux UI rc.6 exports has a module in `packages/ui/src/components/`. Parts are reached through the component (`Card.Root`, `Card.Header`, `Sidebar.NavItem`).

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

Style only with Mux tokens (`var(--muxui-...)`), or the `--pb-*` aliases below, which are themselves only Mux tokens. No hex, rgb or hsl, no hand-written radius, shadow, font family or font size. Layout (grid, flex, widths, gaps) is fine. The app uses Mux UI's own light and dark schemes (`data-muxui-color-scheme` on `<html>`); there is no true black. Appearance is System, Light, Dark; a stored `scheme=black` still renders as dark (`theme/root.tsx` maps it) until the shell lane drops the choice.

| Token                                   | Role                                   | Mux token                                                           |
| --------------------------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| `--pb-fg`                               | text                                   | `--muxui-semantic-content-default`                                  |
| `--pb-bg`                               | page                                   | `--muxui-semantic-surface-background`                               |
| `--pb-muted`                            | muted text (meta lines, counts, times) | `--muxui-semantic-content-muted`                                    |
| `--pb-line`                             | separators and thread lines            | `--muxui-semantic-border-subtle`                                    |
| `--pb-hover`                            | hover fill                             | `--muxui-semantic-surface-hover`                                    |
| `--pb-accent`                           | accent, links                          | `--muxui-semantic-content-link`                                     |
| `--pb-up`                               | up vote                                | `--muxui-component-taggroup-orange-foreground`                      |
| `--pb-down`                             | down vote                              | `--muxui-component-taggroup-indigo-foreground`                      |
| `--pb-mod`                              | moderator                              | `--muxui-component-taggroup-emerald-foreground`                     |
| `--pb-admin`                            | admin                                  | `--muxui-component-taggroup-fuchsia-foreground`                     |
| `--pb-op`                               | original poster                        | `--muxui-component-taggroup-sky-foreground`                         |
| `--pb-warn`                             | warning                                | `--muxui-component-taggroup-warning-foreground`                     |
| `--pb-error`                            | danger and error                       | `--muxui-semantic-feedback-invalid`                                 |
| `--pb-ok`                               | success                                | `--muxui-component-taggroup-success-foreground`                     |
| `--pb-font`, `--pb-mono`                | body and code faces                    | `--muxui-semantic-typography-text-font-family`, `-mono-font-family` |
| `--pb-sidebar-width`, `--pb-page-width` | layout widths (248px, 940px)           | none: Mux has no width tokens                                       |

The accents use TagGroup's hue foregrounds because they are the only Mux accent colours with a dark branch (catalogue gap G7); each is 6.5:1 or better on the page in both schemes. For a tinted fill behind one, use the same hue's `-tint-weak` (`--muxui-component-taggroup-success-tint-weak`). `--muxui-semantic-status-success` and `-status-warning` fail contrast as text: use them for stripes only. Do not use `--muxui-semantic-action-danger-foreground` for text (no dark branch).

The other jobs, straight from Mux (prefix `--muxui-`): raised surface (cards, menus, the docked bar) `semantic-surface-raised`; quiet fill (notice, code, stub) `semantic-surface-subtle`; link hover `semantic-content-link-hover`; borders on controls and collections `semantic-border-default`; dense row lines `semantic-border-faint`; selected item `semantic-selection-background`; focus ring `outline: 2px solid var(--muxui-semantic-focus-ring)` (Mux's own `:focus-visible` rule already draws it, so the app no longer sets one). Anything else: the catalogue's "Which token for which job" table.

`--muxui-semantic-content-danger` does not exist in rc.6: a fallback after it is what renders, so in dark mode it shows the light value. Replace it with `--muxui-semantic-feedback-invalid` (or `--pb-error`). Known uses: `packages/web/src/routes/c/-ui/community.css` and `packages/web/src/routes/c/-ui/gate.css`.

### Base rules (changed for Mux)

rc.6 components take box sizing and font from the page (catalogue G12), so the base rules in `tokens.css` now give them what they were designed against:

- `*, *::before, *::after { box-sizing: border-box }`, in the `reset` layer (below Mux, so a Mux rule that sets its own wins). Before, the page used the browser's `content-box`. A layout of yours that added padding to a fixed width now includes it.
- `body` takes Mux's text face (`--muxui-semantic-typography-text-font-family`), size (`--muxui-semantic-typography-text-m-font-size`, fluid 14 to 16px, was a fixed 14px), line height (`--muxui-semantic-typography-text-line-height`, 1.5, was 1.45) and colour (`--muxui-semantic-content-default`).
- The app's own `:focus-visible` rule is gone; Mux's applies.
- `.pb-mono` takes `--muxui-semantic-typography-mono-s-font-size`; `.pb-page` padding takes Mux layout tokens.

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
import { Sidebar } from '@peblish/ui/components/sidebar';

<nav aria-label={labels.communities}>
  <Sidebar.NavList>
    <Sidebar.NavItem href="/" icon={HomeIcon} current={path === '/'}>
      {labels.home}
    </Sidebar.NavItem>
    <Sidebar.Section label={labels.subscribed}>
      <Sidebar.NavItem href="/c/news">news</Sidebar.NavItem>
    </Sidebar.Section>
  </Sidebar.NavList>
</nav>;
```

The three examples type-check against rc.6 (checked when this page was written).
