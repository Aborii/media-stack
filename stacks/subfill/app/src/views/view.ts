// What a page is built from: the store, the library copy, the nodes' status,
// and one `now` so every time on a page is measured from the same moment.
import type { LibraryStore } from '../library.ts';
import type { NodeStatus } from '../nodes.ts';
import type { Store } from '../store.ts';

export type Status = {
  bazarrError: string | null;
  lastSync: number | null;
  nodes: NodeStatus[];
  model: string;
};

export type View = { store: Store; library: LibraryStore; status: Status; now: number };
