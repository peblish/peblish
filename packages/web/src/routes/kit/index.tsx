import { Button } from '@peblish/ui/components/button';
import { Card } from '@peblish/ui/components/card';
import { Checkbox } from '@peblish/ui/components/checkbox';
import { CommentThread } from '@peblish/ui/components/comment-thread';
import { Dialog } from '@peblish/ui/components/dialog';
import { Link } from '@peblish/ui/components/link';
import { Menu } from '@peblish/ui/components/menu';
import { PostCard, type Density } from '@peblish/ui/components/post-card';
import { Prose } from '@peblish/ui/components/prose';
import { ReplyBar } from '@peblish/ui/components/reply-bar';
import { Select } from '@peblish/ui/components/select';
import { Separator } from '@peblish/ui/components/separator';
import { Text } from '@peblish/ui/components/text';
import { TextAreaField } from '@peblish/ui/components/text-area';
import { TextField } from '@peblish/ui/components/text-field';
import { ToastProvider, useToast } from '@peblish/ui/components/toast';
import { ToggleButton, ToggleButtonGroup } from '@peblish/ui/components/toggle-button-group';
import { Toolbar } from '@peblish/ui/components/toolbar';
import { Tooltip } from '@peblish/ui/components/tooltip';
import { VoteControl } from '@peblish/ui/components/vote-control';
import { DensityControl } from '@peblish/ui/density/density-control';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslate } from '../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../shell/hydration.ts';
import { useCommentThreadLabels, useDensityLabels, usePostCardLabels, useReplyBarLabels, useVoteLabels } from '../../shell/labels.ts';
import { commentPath, communityPath, postPath, userPath } from '../../shell/paths.ts';
import { usePrefs } from '../../shell/prefs.tsx';
import { kitEnabled } from './-enabled.ts';
import { SlowVotes } from './-slow-votes.tsx';
import { loadKitContent } from './-render.ts';
import { feed, now, posts, thumbnailSrc } from './-samples.ts';
import kitCss from './-kit.css?url';

// The component gallery: every @peblish/ui component in its states, for e2e (axe, density,
// keyboard, first tap) and for reading. It answers 404 unless PEBLISH_UI_KIT=1. Its own
// headings are not translated; the components' labels are.
export const Route = createFileRoute('/kit/')({
  head: () => ({ links: [{ rel: 'stylesheet', href: kitCss }] }),
  beforeLoad: async () => {
    if (!(await kitEnabled())) throw notFound();
  },
  // Bodies are rendered on the server, through the same renderer the post page uses.
  loader: () => loadKitContent(),
  component: Kit,
});

const densities: readonly Density[] = ['card', 'classic', 'compact'];

// Toasts need a provider above the page that raises them; the shell has none, because Mux
// UI's toast code costs about 50 kB gzip on every route that loads it.
function Kit() {
  return (
    <ToastProvider>
      <KitPage />
    </ToastProvider>
  );
}

function KitPage() {
  const { locale, t } = useTranslate();
  const { prefs, setPrefs } = usePrefs();
  const postLabels = usePostCardLabels();
  const threadLabels = useCommentThreadLabels();
  const replyLabels = useReplyBarLabels();
  const voteLabels = useVoteLabels();
  const densityLabels = useDensityLabels();
  const toast = useToast();
  const { thread, deepThread, markdown, remote } = Route.useLoaderData();
  const [count, setCount] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [replyTarget, setReplyTarget] = useState<{ handle: string; excerpt: string } | null>({
    handle: '@kofi@fedia.io',
    excerpt: 'Mbin already accepts both forms...',
  });
  useRouteHydrated();

  const hrefs = (post: (typeof feed)[number]) => ({
    post: postPath(post.id),
    community: communityPath(post.community),
    author: userPath(post.author),
  });

  return (
    <main className="pb-page kit">
      <Text as="h1" variant="display" size="sm">
        Component gallery
      </Text>

      <section aria-labelledby="kit-type">
        <Text as="h2" variant="heading" size="sm" id="kit-type">
          Type and locale
        </Text>
        <p>{t('shell', 'tagline')}</p>
        <p>
          <em>Italic text</em> and <code className="pb-mono">monospace text</code>.
        </p>
        <p>
          {t('shell', 'sample')}: <span data-testid="locale-sample">{new Intl.NumberFormat(locale).format(1234.5)}</span>
        </p>
        <div>
          <Button onActivate={() => setCount((value) => value + 1)}>{t('shell', 'press')}</Button>
        </div>
        <p data-testid="press-count" aria-live="polite">
          {t('shell', 'pressed', { count })}
        </p>
      </section>

      <section aria-labelledby="kit-feed">
        <Text as="h2" variant="heading" size="sm" id="kit-feed">
          Feed
        </Text>
        <div className="kit-toolbar">
          <DensityControl value={prefs.density} onChange={(density) => setPrefs({ density })} labels={densityLabels} />
        </div>
        <div data-testid="kit-feed">
          {feed.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              density={prefs.density}
              hrefs={hrefs(post)}
              labels={postLabels}
              locale={locale}
              thumbnailSrc={thumbnailSrc(post)}
              headingLevel={3}
              now={now}
              onShare={() => toast.add('Link copied')}
            />
          ))}
        </div>
      </section>

      <section aria-labelledby="kit-densities">
        <Text as="h2" variant="heading" size="sm" id="kit-densities">
          Post card densities
        </Text>
        {densities.map((density) => (
          <div key={density} data-testid={`kit-density-${density}`}>
            <Text as="h3" variant="title" size="sm">
              {density}
            </Text>
            <PostCard
              post={posts.link}
              density={density}
              hrefs={hrefs(posts.link)}
              labels={postLabels}
              locale={locale}
              thumbnailSrc={thumbnailSrc(posts.link)}
              headingLevel={4}
              now={now}
            />
            <PostCard
              post={posts.text}
              density={density}
              hrefs={hrefs(posts.text)}
              labels={postLabels}
              locale={locale}
              thumbnailSrc={thumbnailSrc(posts.text)}
              headingLevel={4}
              now={now}
            />
          </div>
        ))}
      </section>

      <section aria-labelledby="kit-withheld">
        <Text as="h2" variant="heading" size="sm" id="kit-withheld">
          Thumbnail not loaded
        </Text>
        <div data-testid="kit-withheld">
          <PostCard
            post={posts.withheld}
            density="classic"
            hrefs={hrefs(posts.withheld)}
            labels={postLabels}
            locale={locale}
            thumbnailSrc={null}
            headingLevel={3}
            now={now}
          />
        </div>
      </section>

      <section aria-labelledby="kit-vote">
        <Text as="h2" variant="heading" size="sm" id="kit-vote">
          Vote control
        </Text>
        <div className="kit-row">
          <div data-testid="kit-vote-column">
            <VoteControl score={842} myVote={0} labels={voteLabels} locale={locale} />
          </div>
          <div data-testid="kit-vote-row">
            <VoteControl score={214} myVote={1} orientation="horizontal" labels={voteLabels} locale={locale} />
          </div>
          <VoteControl score={3} myVote={0} orientation="horizontal" disabled labels={voteLabels} locale={locale} />
          <div data-testid="kit-vote-refused">
            <VoteControl
              score={7}
              myVote={0}
              orientation="horizontal"
              onVote={() => Promise.reject(new Error('refused'))}
              labels={voteLabels}
              locale={locale}
            />
          </div>
          <SlowVotes />
        </div>
      </section>

      <section aria-labelledby="kit-thread">
        <Text as="h2" variant="heading" size="sm" id="kit-thread">
          Comment thread
        </Text>
        <div data-testid="kit-thread">
          <CommentThread
            comments={thread}
            postAuthorId={posts.link.author.id}
            continueHref={(comment) => commentPath(posts.link.id, comment.id)}
            authorHref={(comment) => userPath(comment.author)}
            labels={threadLabels}
            locale={locale}
            onReply={(comment) =>
              setReplyTarget({ handle: `@${comment.author.handle}`, excerpt: comment.contentHtml?.replace(/<[^>]+>/g, '') ?? '' })
            }
            onShare={() => toast.add('Link copied')}
            now={now}
          />
        </div>
        <Text as="h3" variant="title" size="sm">
          Fifty levels deep
        </Text>
        <div data-testid="kit-deep-thread">
          <CommentThread
            comments={deepThread}
            postAuthorId={posts.link.author.id}
            continueHref={(comment) => commentPath(posts.link.id, comment.id)}
            authorHref={(comment) => userPath(comment.author)}
            labels={threadLabels}
            locale={locale}
            now={now}
          />
        </div>
      </section>

      <section aria-labelledby="kit-prose">
        <Text as="h2" variant="heading" size="sm" id="kit-prose">
          Rendered content
        </Text>
        <div data-testid="kit-prose">
          <Prose html={markdown} />
          <Prose html={remote} className="kit-remote" />
        </div>
      </section>

      <section aria-labelledby="kit-facade">
        <Text as="h2" variant="heading" size="sm" id="kit-facade">
          Facade
        </Text>
        <div className="kit-stack">
          <div className="kit-row">
            <Button variant="primary" onActivate={() => toast.add('Saved', { variant: 'success' })}>
              Toast
            </Button>
            <Link href="/auth/sign-in">Sign in (Mux link)</Link>
            <Tooltip content="Explains the button" trigger={<Button variant="neutral">Tooltip</Button>} />
            <Button onActivate={() => setDialogOpen(true)}>Dialog</Button>
          </div>
          <Dialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            title="A dialog"
            description="Dialogs trap focus until closed."
            actions={<Button onActivate={() => setDialogOpen(false)}>Close</Button>}
          >
            <p>Body text.</p>
          </Dialog>
          <TextField label="Text field" name="text" description="With a description." />
          <TextField label="Invalid field" name="invalid" invalid errorMessage="This is not valid." />
          <TextAreaField label="Text area" name="area" rows={3} description="Several lines." />
          <Select label="Select" items={['Hot', 'New', 'Top']} defaultValue="Hot" />
          <Checkbox>A checkbox</Checkbox>
          <Toolbar aria-label="Toolbar">
            <Button variant="neutral">Bold</Button>
            <Button variant="neutral">Italic</Button>
            <Button variant="neutral">Code</Button>
          </Toolbar>
          <ToggleButtonGroup aria-label="Toggle button group" selectionMode="single" defaultSelectedIds={['one']} disallowEmptySelection>
            <ToggleButton id="one">One</ToggleButton>
            <ToggleButton id="two">Two</ToggleButton>
          </ToggleButtonGroup>
          <Menu.Root>
            <Menu.Trigger>Menu</Menu.Trigger>
            <Menu.Popup>
              <Menu.List aria-label="Menu">
                <Menu.Item id="a" onAction={() => toast.add('Chose A')}>
                  First
                </Menu.Item>
                <Menu.Item id="b">Second</Menu.Item>
              </Menu.List>
            </Menu.Popup>
          </Menu.Root>
        </div>
      </section>

      <section aria-labelledby="kit-surfaces">
        <Text as="h2" variant="heading" size="sm" id="kit-surfaces">
          Surfaces and text
        </Text>
        <div className="kit-cards">
          {(['outlined', 'filled', 'elevated'] as const).map((variant) => (
            <Card.Root key={variant} variant={variant} padding="sm">
              <Card.Header>
                <Text as="h3" variant="title" size="sm">
                  {variant}
                </Text>
              </Card.Header>
              <Card.Body>
                <Text color="muted">A Mux Card, {variant}.</Text>
              </Card.Body>
            </Card.Root>
          ))}
        </div>
        <Separator />
        <div className="kit-stack">
          <Text variant="label">Label text</Text>
          <Text>Body text</Text>
          <Text size="sm" color="muted">
            Small muted text
          </Text>
          <Text variant="mono" size="sm">
            mono 12:34
          </Text>
        </div>
      </section>

      <Text as="h2" variant="heading" size="sm">
        Reply bar
      </Text>
      <ReplyBar
        docked={false}
        target={replyTarget}
        labels={replyLabels}
        onSubmit={() => {
          toast.add('Reply sent', { variant: 'success' });
        }}
        onPostInstead={() => setReplyTarget(null)}
        onCancel={() => setReplyTarget(null)}
      />
    </main>
  );
}
