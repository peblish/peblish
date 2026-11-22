import type { ReactNode } from 'react';
import { Text } from '../components/text.tsx';
import type { Density } from '../components/post-row.tsx';
import { SkelBlock, SkelCircle, SkelLine, SkelPill, type Width } from './shape.tsx';

/**
 * The loading layouts each screen reserves, drawn in the real components' own layout classes
 * (PostRow's, RailPanel's) so content replaces them without a shift. The shapes are hidden from
 * assistive technology; `label` ("Loading posts") is the one thing announced, as a status.
 */
function Group({ label, className, children }: { label?: string; className?: string; children: ReactNode }) {
  return (
    <div className={['pb-skeleton', className].filter(Boolean).join(' ')} data-skeleton="">
      {label && (
        <Text role="status" className="pb-sr">
          {label}
        </Text>
      )}
      <div aria-hidden="true" className="pb-skeleton__shapes">
        {children}
      </div>
    </div>
  );
}

function Actions() {
  return (
    <div className="pb-post__actions">
      <SkelPill size="lg" />
      <SkelPill />
    </div>
  );
}

function Meta() {
  return (
    <div className="pb-post__meta">
      <SkelLine kind="meta" width={40} />
    </div>
  );
}

type Row = 'text' | 'link' | 'image';
const cardRows: readonly Row[] = ['image', 'link', 'text', 'image'];
const classicRows: readonly boolean[] = [true, false, true, true, false, true];
const compactWidths: readonly Width[] = [90, 60, 80, 70, 90, 50, 80, 60];

/** A feed's rows in the viewer's density: Card (pictures, link lines, excerpts), Classic (thumbnails), Compact (title lines). */
export function FeedSkeleton({ density, label }: { density: Density; label?: string }) {
  return (
    <Group label={label}>
      {density === 'card' &&
        cardRows.map((row, index) => (
          <div key={index} className="pb-post" data-density="card">
            <Meta />
            <div className="pb-post__body">
              <div className="pb-skel__lines">
                <SkelLine kind="title" />
                {row !== 'text' && <SkelLine kind="title" width={60} />}
              </div>
              {row === 'text' && (
                <div className="pb-skel__lines">
                  <SkelLine />
                  <SkelLine />
                  <SkelLine width={70} />
                </div>
              )}
              {row === 'link' && <SkelLine kind="meta" width={30} />}
              {row === 'link' && (
                <div className="pb-post__aside">
                  <SkelBlock ratio="wide" />
                </div>
              )}
              {row === 'image' && (
                <div className="pb-post__media">
                  <SkelBlock ratio="wide" />
                </div>
              )}
            </div>
            <Actions />
          </div>
        ))}
      {density === 'classic' &&
        classicRows.map((thumb, index) => (
          <div key={index} className="pb-post" data-density="classic">
            <Meta />
            <div className="pb-post__body">
              <div className="pb-skel__lines">
                <SkelLine kind="title" />
                <SkelLine kind="title" width={50} />
              </div>
              {thumb && (
                <div className="pb-post__aside">
                  <SkelBlock ratio="thumb" />
                </div>
              )}
            </div>
            <Actions />
          </div>
        ))}
      {density === 'compact' &&
        compactWidths.map((width, index) => (
          <div key={index} className="pb-post" data-density="compact">
            <Meta />
            <SkelLine kind="label" width={width} />
            <Actions />
          </div>
        ))}
    </Group>
  );
}

/** The rail's blocks: what the place is (a heading, two lines, a fact), then a list of communities. */
export function RailSkeleton({ label }: { label?: string }) {
  return (
    <Group label={label} className="pb-skeleton--rail">
      <div className="pb-panel">
        <SkelLine kind="label" width={40} />
        <div className="pb-skel__lines">
          <SkelLine kind="meta" />
          <SkelLine kind="meta" width={60} />
        </div>
        <SkelLine kind="meta" width={50} />
      </div>
      <div className="pb-panel">
        <SkelLine kind="label" width={50} />
        {([50, 60, 40, 50] as const).map((width, index) => (
          <div key={index} className="pb-skel__row">
            <SkelCircle />
            <div className="pb-skel__lines">
              <SkelLine kind="label" width={width} />
              <SkelLine kind="meta" width={70} />
            </div>
            <SkelPill size="sm" />
          </div>
        ))}
      </div>
    </Group>
  );
}

/** A post page: the post (meta, title, body, actions), then the first comments. */
export function ThreadSkeleton({ label }: { label?: string }) {
  return (
    <Group label={label} className="pb-skeleton--thread">
      <div className="pb-skel__post">
        <Meta />
        <div className="pb-skel__lines">
          <SkelLine kind="title" />
          <SkelLine kind="title" width={40} />
        </div>
        <div className="pb-skel__lines">
          <SkelLine />
          <SkelLine />
          <SkelLine />
          <SkelLine width={60} />
        </div>
        <Actions />
      </div>
      {([3, 2, 2] as const).map((lines, index) => (
        <div key={index} className="pb-skel__row pb-skel__comment">
          <SkelCircle size="sm" />
          <div className="pb-skel__lines">
            <SkelLine kind="meta" width={30} />
            {Array.from({ length: lines }, (_, line) => (
              <SkelLine key={line} width={line === lines - 1 ? 60 : 100} />
            ))}
          </div>
        </div>
      ))}
    </Group>
  );
}

/** The inbox's first group: its day heading and notice rows. */
export function InboxSkeleton({ label }: { label?: string }) {
  return (
    <Group label={label} className="pb-skeleton--inbox">
      <SkelLine kind="label" width={20} />
      {([70, 50, 80, 60] as const).map((width, index) => (
        <div key={index} className="pb-skel__row">
          <SkelCircle />
          <div className="pb-skel__lines">
            <SkelLine kind="label" width={width} />
            <SkelLine kind="meta" width={90} />
          </div>
        </div>
      ))}
    </Group>
  );
}
