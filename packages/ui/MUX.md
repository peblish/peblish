# Mux UI in peblish

One page for the lanes that move the app onto Mux UI. How each component is meant to be used, its weight and its gaps are in the catalogue (`/Users/admin/.agents/plans/feddit/lane-notes/mux/catalogue.md`); this page is the contract.

## The import rule

- Mux UI comes only from the vendored tarball, `vendor/muxui/muxui-react-0.1.0-rc.6.tgz`, a dependency of `packages/ui` alone.
- Only `packages/ui` imports `@muxui/react`. Routes and the shell import one module per component: `import { Card } from '@peblish/ui/components/card'` (no extension, no barrel). One module per component keeps tree-shaking working: a route that imports `separator` does not load `sidebar`.
- A wrapper re-exports the component, its parts and its prop types and nothing else. If one you need is missing, add `packages/ui/src/components/<kebab-name>.tsx` the same way and say so in your notes.
- The app's own composed components (`PostCard`, `CommentThread`, `VoteControl`, `ReplyBar`, `Prose`, `Handle`, `Time`, `Badge`, the form fields) keep their public props.
- Icons are Lucide (`lucide-react`, the set Mux UI draws its own with, pinned to the version Mux depends on), and like `@muxui/react` only `packages/ui` imports it (`mux-only-in-ui` in `.dependency-cruiser.cjs`). Everyone else imports from `@peblish/ui/components/icons`, which wraps each glyph by name: 1em square, `currentColor`, `aria-hidden` unless named. Need another glyph? Add one line there. Every `Sidebar.NavItem` takes one through `icon`: without it Mux draws the label's first letter, which becomes part of the link's text.
- Shared composed pieces (built from Mux components and tokens by the GW2 lane, in the same folder): `badge`, `notice`, `link-tabs`, `pager`, `fact-list`, `empty-state`. Use them rather than composing your own; their CSS is linked from `packages/web/src/styles.css`.

### Pieces added since

| Import                                                             | Use it for                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Quote` from `@peblish/ui/components/quote`                        | Someone else's words: a `blockquote` with the words in Mux `Text` (`edge` draws a line down its start edge, `size`, any `blockquote` attribute).                                                                                                                                                                                                                                              |
| `LinkedDisclosure` from `@peblish/ui/components/linked-disclosure` | A Mux `Disclosure` whose content must stay reachable with scripts off: the server renders it open at `openHref` (`title`, `openHref`, `defaultExpanded`, optional `link`). Never hand-build another fallback.                                                                                                                                                                                 |
| `ButtonLink` from `@peblish/ui/components/button-link`             | A link that looks like a Mux `Button` (`href`, `variant`, `size`, optional router `link`). It stays a link and works without scripts; use `Button` for actions.                                                                                                                                                                                                                               |
| The field messages from `@peblish/ui/components/field-problem`     | The wrappers `text-field`, `text-area`, `checkbox` and `select` already explain a value the browser refuses (required, length, email, range) in the page's language, linked to the field; pass `errorMessage` with `invalid` only for your own refusals. `FieldAlert` is the announced span inside a field's error part, for a field wrapper only; `__root.tsx` mounts `FieldLabelsProvider`. |
| `Time` from `@peblish/ui/components/time`                          | Every date on a page; never a raw `time`. `format="age"` (default) prints "3h", `"date"` the date alone ("Nov 3, 2026"), `"date-time"` the date and time in UTC, `"time"` the clock time alone ("23:30", UTC, for rows under a day heading); all keep the full time as `title`.                                                                                                               |
| `BidiText` from `@peblish/ui/components/handle`                    | A display name from another server (a person or community): isolated, with its directional controls removed. Handles use `Handle`.                                                                                                                                                                                                                                                            |

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

Style only with Mux tokens (`var(--muxui-...)`), or the few `--pb-*` aliases below (every other job uses the Mux token itself, listed under the table; role badges are `Badge`), which are themselves only Mux tokens. No hex, rgb or hsl, no hand-written radius, shadow, font family or font size. Layout (grid, flex, widths, gaps) is fine. The app uses Mux UI's own light and dark schemes (`data-muxui-color-scheme` on `<html>`); there is no true black. Appearance is System, Light, Dark; a stored `scheme=black` still renders as dark (`theme/root.tsx` maps it) until the shell lane drops the choice.

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

### Base rules (changed for Mux)

rc.6 components take box sizing and font from the page (catalogue G12), so the base rules in `tokens.css` now give them what they were designed against:

- `*, *::before, *::after { box-sizing: border-box }`, in the `reset` layer (below Mux, so a Mux rule that sets its own wins). Before, the page used the browser's `content-box`. A layout of yours that added padding to a fixed width now includes it.
- `body` takes Mux's text face (`--muxui-semantic-typography-text-font-family`), size (`--muxui-semantic-typography-text-m-font-size`, fluid 14 to 16px, was a fixed 14px), line height (`--muxui-semantic-typography-text-line-height`, 1.5, was 1.45) and colour (`--muxui-semantic-content-default`).
- The app's own `:focus-visible` rule is gone; Mux's applies.
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

Mux hides the native input of its choice controls and draws the visible box, tick and dot from `data-muxui-state-*` attributes that React sets. With scripts off, or before hydration, those attributes keep their server values: a click checks the input but the old option stays drawn as chosen. `components/native-state.css` (linked from `packages/web/src/styles.css`) fixes the drawing without touching Mux UI.

- Covers `CheckboxField` (and the app's `Checkbox`, built on it) and `RadioField` inside `RadioGroup` (the post type and community picker): selected and unselected in both directions (a box the server ticked and the visitor cleared draws empty), the tick, the invalid edge, and the keyboard focus ring. Disabled and invalid never go stale (the server sets both with the input); hover and pressed are not drawn without scripts; `indeterminate` cannot be set without scripts.
- Each rule matches only while an attribute and its input disagree (`.muxui-radio-field__button:not([data-muxui-state-selected]):has(input:checked)` and the reverse; `:not([data-muxui-state-focused]):has(input:focus-visible)` for focus) and repeats Mux's declaration for the input's state, with Mux tokens. After hydration they agree, so the file changes nothing: `e2e/ui-nojs` deletes its rules from a hydrated page and finds the same computed styles, and compares hydrated controls with scripts-off ones pixel for pixel, light and dark.
- The tick is a CSS mask of Mux's check icon (React renders the icon only while selected). The focus ring is two outlines in Mux's ring colours, since the guard allows no hand-written `box-shadow` and Mux has no token for the ring.
- Needs `:has()` (current evergreen browsers, the supported set).
- Not covered, because nothing renders them: `SwitchField`, `Switch`, Mux's own `Checkbox` and `CheckboxGroup` (`mux-checkbox`, `checkbox-group`), and `RadioGroup`'s `options` radios. To cover one, find the Mux rules keyed on its `[data-muxui-state-selected]` (and `-focus-visible`) in `@muxui/react/styles.css`, add the stale pair of selectors for its part with the same declarations (mind `@scope` dark-scheme rules: `RadioGroup`'s radios have them), and add a case to `e2e/ui-nojs`.

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

The three examples type-check against rc.6 (checked when this page was written).
