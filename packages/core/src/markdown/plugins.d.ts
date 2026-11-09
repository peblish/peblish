// markdown-it plugins without bundled types (all MIT).
declare module 'markdown-it-footnote' {
  import type { MarkdownIt } from 'markdown-it';
  export default function footnote(md: MarkdownIt): void;
}
declare module 'markdown-it-sub' {
  import type { MarkdownIt } from 'markdown-it';
  export default function sub(md: MarkdownIt): void;
}
declare module 'markdown-it-sup' {
  import type { MarkdownIt } from 'markdown-it';
  export default function sup(md: MarkdownIt): void;
}
