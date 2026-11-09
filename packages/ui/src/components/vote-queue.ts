export type Vote = -1 | 0 | 1;

export interface VoteQueue {
  /**
   * The viewer pressed an arrow: 1 or -1, or 0 when the arrow they already hold is pressed again.
   * `save` stores a vote; the queue uses the one from the latest press for every request it sends from then on.
   */
  press(arrow: 1 | -1, save: (value: Vote) => void | Promise<void>): void;
  /** The server's own value arrived (a refreshed page); it replaces the optimistic one once nothing is being saved. */
  sync(value: Vote): void;
}

/**
 * Saves a viewer's votes one request at a time. The arrows show the viewer's latest choice at
 * once; a choice made while a save is pending waits, and when the pending save settles only the
 * newest choice is sent. A refused save goes back to the last vote the server is known to hold
 * (never to a value captured earlier), so a late failure cannot undo a newer success and the
 * server sees the votes in the order they were made.
 */
export function createVoteQueue({ initial, onChange }: { initial: Vote; onChange: (value: Vote) => void }): VoteQueue {
  let confirmed = initial;
  let wanted = initial;
  let saving = false;
  let save: (value: Vote) => void | Promise<void> = () => {};

  async function flush() {
    if (saving) return;
    saving = true;
    while (wanted !== confirmed) {
      const sent = wanted;
      try {
        await save(sent);
        confirmed = sent;
      } catch {
        // Refused: go back to what the server holds, unless the viewer has chosen again meanwhile.
        if (wanted === sent) wanted = confirmed;
      }
    }
    saving = false;
    onChange(wanted);
  }

  return {
    press(arrow, saver) {
      save = saver;
      wanted = wanted === arrow ? 0 : arrow;
      onChange(wanted);
      void flush();
    },
    sync(value) {
      confirmed = value;
      if (saving) return;
      wanted = value;
      onChange(value);
    },
  };
}
